// The running instance: its database, its clock and its change channel. Created once per process (or per test).
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Envelope } from "../../core/api.ts";
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
};

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

export function openApp(config: Config, options: { memory?: boolean; now?: () => number; reader?: boolean } = {}): App {
	const path = options.memory ? ":memory:" : join(config.dataDir, "casebook.db");
	if (options.reader && !existsSync(path)) throw new Error("a reader needs an existing database");
	const db = new Db(path, options.reader ? { reader: true } : {});
	if (!options.reader) migrate(db, path);
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

export function defaultConfig(env: Record<string, string | undefined>): Config {
	const host = env.CASEBOOK_HOST ?? "127.0.0.1";
	const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
	const home = env.HOME ?? ".";
	return {
		dataDir: env.CASEBOOK_DATA ?? join(home, ".casebook"),
		host,
		port: Number(env.CASEBOOK_PORT ?? env.PORT ?? 7357),
		mode: env.CASEBOOK_MODE === "server" || !loopback ? "server" : "local",
		owner: env.CASEBOOK_OWNER ?? env.USER ?? "owner",
		ownerToken: env.CASEBOOK_OWNER_TOKEN ?? null,
	};
}
