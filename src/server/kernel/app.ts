// The running instance: its database, its clock and its change channel. Created once per process (or per test).
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Envelope } from "../../core/api.ts";
import { DURATION_FORMAT, durationMs } from "../../core/duration.ts";
import { type AddressRanges, parseAddressRanges } from "./address.ts";
import type { Actor } from "./ctx.ts";
import { Db } from "./db.ts";
import { migrate } from "./migrate.ts";

export type Config = {
	/** Where the database and attachments live. */
	dataDir: string;
	host: string;
	port: number;
	/**
	 * `local`: bound to loopback, the browser on this machine is signed in as the owner with no step.
	 * `server`: reachable from a network, so every request needs a token.
	 */
	mode: "local" | "server";
	/** The name of the owner created on first start. */
	owner: string;
	/** In `server` mode: the owner's token, if the operator wants to choose it. Otherwise one is generated and logged once. */
	ownerToken: string | null;
	/**
	 * The commit this build was made from, if the process was told: 40 lower-case hexadecimal characters, else
	 * `null`. `/healthz` shows it without a sign-in, so it holds nothing else (see `commitOf`).
	 */
	commit: string | null;
	/** Milliseconds a browser's session may go unused before it ends. `MAINWORTHY_SESSION_IDLE`, by default `14d`. */
	sessionIdleMs: number;
	/** Milliseconds a browser's session lasts however much it is used. `MAINWORTHY_SESSION_MAX`, by default `90d`. */
	sessionMaxMs: number;
	/**
	 * The proxy in front of the server, when the operator named one, else null. It is what says where a request
	 * came from: without one a request's address is the address of the connection it arrived on.
	 */
	proxy: TrustedProxy | null;
	/**
	 * The address people open the instance at, as they type it: `MAINWORTHY_PUBLIC_URL`, for example
	 * `https://mainworthy.com`. A passkey belongs to the host name in it, and an invitation link starts with it.
	 * It is the one source of both: a request's `Host` never is. Absent, the instance has no passkeys and an
	 * invitation link is printed without a host. The start refuses a value a browser would not take
	 * (`publicAddress` in the identity module, which knows what a browser takes).
	 */
	publicUrl?: string;
	/**
	 * What hashing a password costs, where it is not what the build ships with. A test sets it, because a
	 * test hashes hundreds of passwords; nothing reads it from the environment.
	 */
	passwordCost?: { memoryCost: number; timeCost: number };
};

/**
 * A proxy whose word for the client's address is believed. The two halves come from two variables that are set
 * together or not at all: a header with no peer to believe it from would be believed from anybody, and a peer
 * with no header says nothing.
 */
export type TrustedProxy = {
	/** The addresses a connection from the proxy comes from. `MAINWORTHY_TRUSTED_PROXY`: addresses and ranges. */
	peers: AddressRanges;
	/**
	 * The header in which the proxy writes the address of the client it serves, in lower case.
	 * `MAINWORTHY_CLIENT_ADDRESS_HEADER`. It must be one the proxy sets itself, replacing what the client sent.
	 */
	header: string;
};

/** The two lifetimes of a session when the environment names none. */
export const SESSION_LIFETIMES = { sessionIdleMs: 14 * 86_400_000, sessionMaxMs: 90 * 86_400_000 } as const;

/** What changed, pushed to clients after a command commits. Losing one is repaired by a refetch. */
export type ChangeEvent = { project: string; seq: number; op: string; actor: string; touched: string[] };

/**
 * Lets one writer in at a time. SQLite has one writer anyway; this makes the others wait in a queue instead of
 * blocking the thread, so a long write (a ten-thousand-result report, applied in slices) never stalls a read.
 */
export type WriteGate = { run: <T>(fn: () => T | Promise<T>) => Promise<T> };

export type ReadCall = { op: string; project: string | null; input: unknown; actor: Actor | null };
export type ReadPool = {
	run: (call: ReadCall, fallback: () => Envelope<unknown>) => Promise<Envelope<unknown>>;
	refresh: () => void;
	stop: () => Promise<void>;
};

function writeGate(): WriteGate {
	let tail: Promise<unknown> = Promise.resolve();
	return {
		run<T>(fn: () => T | Promise<T>): Promise<T> {
			const next = tail.then(fn, fn);
			tail = next.catch(() => undefined);
			return next;
		},
	};
}

export type App = {
	/** The one connection that writes. Use it only inside a command (see `invoke`) or under `gate`. */
	db: Db;
	/**
	 * A second connection for reads. It sees only what is committed, so a read during a long write gets a
	 * consistent answer at once. With an in-memory database (tests) it is the same connection as `db`.
	 */
	reader: Db;
	readers: ReadPool | null;
	gate: WriteGate;
	config: Config;
	now: () => number;
	/** Subscribes to change events. Returns the unsubscribe function. */
	subscribe: (listener: (event: ChangeEvent) => void) => () => void;
	publish: (event: ChangeEvent) => void;
	close: () => void;
};

/** The one database file of an instance. */
export const databasePath = (dataDir: string): string => join(dataDir, "mainworthy.db");

/** The data directory of an instance that names none. */
export const defaultDataDir = (env: Record<string, string | undefined>): string => join(env.HOME ?? ".", ".mainworthy");

export function openApp(config: Config, options: { memory?: boolean; now?: () => number; reader?: boolean } = {}): App {
	const path = options.memory ? ":memory:" : databasePath(config.dataDir);
	if (options.reader && !existsSync(path)) throw new Error("a reader needs an existing database");
	const db = new Db(path, options.reader ? { reader: true } : {});
	try {
		if (!options.reader) migrate(db, path);
	} catch (error) {
		// A migration that fails leaves the database at the version it had. It is left closed too, not held.
		db.close();
		throw error;
	}
	const reader = options.memory || options.reader ? db : new Db(path, { reader: true });
	const listeners = new Set<(event: ChangeEvent) => void>();
	return {
		db,
		reader,
		readers: null,
		gate: writeGate(),
		config,
		now: options.now ?? Date.now,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		publish(event) {
			for (const listener of listeners) listener(event);
		},
		close() {
			listeners.clear();
			if (reader !== db) reader.close();
			db.close();
		},
	};
}

const FULL_COMMIT = /^[0-9a-f]{40}$/;

/**
 * The commit this process runs, read once where the configuration is read. `MAINWORTHY_COMMIT` comes first (the
 * image bakes it in when it is built with the argument, and an operator can set it), then `SOURCE_COMMIT`, which
 * Coolify gives the running container. A value counts only when it is exactly 40 lower-case hexadecimal
 * characters: the answer is public, so it must never echo free text from the environment, and Coolify's `HEAD`
 * or `unknown` and an image built without the argument (an empty value) must read as "not known", with the next
 * source tried.
 */
export function commitOf(env: Record<string, string | undefined>): string | null {
	for (const value of [env.MAINWORTHY_COMMIT, env.SOURCE_COMMIT]) {
		if (value !== undefined && FULL_COMMIT.test(value)) return value;
	}
	return null;
}

/**
 * A lifetime from the environment, in milliseconds. A variable that is unset or empty (a compose file passes one
 * on empty) takes the default. One that is set and is not a duration stops the start: a lifetime nobody meant,
 * guessed from a typing error, would decide how long a stolen cookie works.
 */
function lifetime(env: Record<string, string | undefined>, name: string, fallback: number): number {
	const text = env[name];
	if (!text) return fallback;
	const ms = durationMs(text);
	if (ms === null) throw new Error(`${name} is "${text}", which is not a duration: write ${DURATION_FORMAT}`);
	return ms;
}

/** A header's name: the characters RFC 9110 allows in one. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9a-z-]+$/i;

/**
 * The proxy the environment names, or null when it names none. A variable that is unset or empty (a compose file
 * passes one on empty) is not set. Anything that is set and cannot be read stops the start, with the variable
 * and the entry at fault: a proxy left out by a typing error is a peer like any other, and then every visitor
 * behind it is one address, or none.
 */
function proxyOf(env: Record<string, string | undefined>): TrustedProxy | null {
	const list = env.MAINWORTHY_TRUSTED_PROXY?.trim() ?? "";
	const header = env.MAINWORTHY_CLIENT_ADDRESS_HEADER?.trim() ?? "";
	if (list === "" && header === "") return null;
	if (header === "") {
		throw new Error(
			"MAINWORTHY_TRUSTED_PROXY is set and MAINWORTHY_CLIENT_ADDRESS_HEADER is not: name the header in which that proxy writes the client's address, or unset both",
		);
	}
	if (list === "") {
		throw new Error(
			"MAINWORTHY_CLIENT_ADDRESS_HEADER is set and MAINWORTHY_TRUSTED_PROXY is not: name the addresses of the proxy whose header is to be believed, or unset both",
		);
	}
	if (!HEADER_NAME.test(header)) {
		throw new Error(`MAINWORTHY_CLIENT_ADDRESS_HEADER is "${header}", which is not the name of a header`);
	}
	const peers = parseAddressRanges(list);
	if (peers.kind === "malformed") throw new Error(`MAINWORTHY_TRUSTED_PROXY: "${peers.entry}" ${peers.why}`);
	// Commas and spaces alone are a list that was meant to name somebody.
	if (list.split(",").every((entry) => entry.trim() === "")) {
		throw new Error(`MAINWORTHY_TRUSTED_PROXY names no address: it is "${list}"`);
	}
	return { peers, header: header.toLowerCase() };
}

export function defaultConfig(env: Record<string, string | undefined>): Config {
	const host = env.MAINWORTHY_HOST ?? "127.0.0.1";
	const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
	return {
		dataDir: env.MAINWORTHY_DATA ?? defaultDataDir(env),
		host,
		port: Number(env.MAINWORTHY_PORT ?? env.PORT ?? 7357),
		mode: env.MAINWORTHY_MODE === "server" || !loopback ? "server" : "local",
		owner: env.MAINWORTHY_OWNER ?? env.USER ?? "owner",
		ownerToken: env.MAINWORTHY_OWNER_TOKEN ?? null,
		commit: commitOf(env),
		sessionIdleMs: lifetime(env, "MAINWORTHY_SESSION_IDLE", SESSION_LIFETIMES.sessionIdleMs),
		sessionMaxMs: lifetime(env, "MAINWORTHY_SESSION_MAX", SESSION_LIFETIMES.sessionMaxMs),
		proxy: proxyOf(env),
		// A variable that is set and empty (a compose file passes one on empty) is one that was not set.
		...(env.MAINWORTHY_PUBLIC_URL ? { publicUrl: env.MAINWORTHY_PUBLIC_URL } : {}),
	};
}
