// What the tests of people share: an instance on a real listener with the test's own clock, its identity provider
// (`test/oidc-support.ts`), and the requests a browser and a script make, a sign-in through the provider among
// them. Everything said to the server and everything it answered is kept, so a test can search it.
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Instance, start } from "../src/app/start.ts";
import { API_VERSION, API_VERSION_HEADER } from "../src/core/version.ts";
import { type Config, defaultConfig } from "../src/server/kernel/app.ts";
import { archiveRoutes } from "../src/surfaces/archive.ts";
import { closeIdentityDatabases, databaseContents, holdWriter, identityDatabaseUrl, pgRows } from "./identity-db.ts";
import { type Next, type Provider, provider, stopProviders } from "./oidc-support.ts";

/** The owner of every instance here, and the token the owner signs in with. */
export const OWNER = "kim";
export const TOKEN = "owner-secret-0123456789";
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const T0 = 1_800_000_000_000;
/** Where people open the instance, and where the provider sends them back to. No request in a test is sent there. */
export const PUBLIC = "https://mainworthy.example";

export type Clock = { now: () => number; advance: (ms: number) => void };
export function clockAt(start = T0): Clock {
	let at = start;
	return {
		now: () => at,
		advance: (ms) => {
			at += ms;
		},
	};
}

export type Sent = Record<string, string>;
export const bearer = (token: string): Sent => ({ authorization: `Bearer ${token}` });
/** The header the proxy of a `proxied` world writes: this request came from `address`. */
export const from = (address: string): Sent => ({ "x-client-address": address });
export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** What the server answers: an operation's envelope, or a route's, which carries no sequence number. */
export type Body<T> =
	| { ok: true; result: T; seq?: number | null }
	| { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } };
export type Answer<T> = {
	status: number;
	body: Body<T>;
	text: string;
	setCookies: string[];
	cookie: string;
	/** The `Retry-After` header, or null. */
	retryAfter: string | null;
};
/** A reply in one line: `200`, `401 unauthenticated`, `429 limited, retry after 1`. */
export const said = (reply: Answer<unknown>): string =>
	`${reply.status}${reply.body.ok ? "" : ` ${reply.body.error.code}`}${reply.retryAfter === null ? "" : `, retry after ${reply.retryAfter}`}`;
/** The result of an answer that must be a success. */
export function must<T>(reply: Answer<T>): T {
	if (!reply.body.ok) throw new Error(`refused: ${reply.status} ${reply.text}`);
	return reply.body.result;
}

export type World = {
	instance: Instance;
	/** The instance's identity provider, or null for an instance that has none. */
	idp: Provider | null;
	clock: Clock;
	dataDir: string;
	/** Every reply the server gave in this test, headers and body, as text. */
	replies: string[];
	post: <T = unknown>(path: string, body: unknown, headers?: Sent) => Promise<Answer<T>>;
	get: <T = unknown>(path: string, headers?: Sent) => Promise<Answer<T>>;
	/** One operation of the registry, as the owner unless `headers` says who. */
	op: <T = unknown>(name: string, input: Record<string, unknown>, headers?: Sent) => Promise<Answer<T>>;
	/** The same, for a call that must succeed: its result. */
	ok: <T = unknown>(name: string, input: Record<string, unknown>, headers?: Sent) => Promise<T>;
	/** The status of `GET /api/session` for whoever the headers say. */
	status: (headers: Sent) => Promise<number>;
	/** Every byte the instance has on disk: the database, its write-ahead log and the log's index. */
	disk: () => Promise<Buffer>;
	/** What was written: the database and its log, without the log's index, which a reader marks too. */
	written: () => Promise<Buffer>;
	rows: <T>(query: string) => Promise<T[]>;
};

const worlds: World[] = [];
const dirs: string[] = [];
/** Stops every instance a test started and removes its directory. Each test file calls it after each test. */
export async function cleanUp(): Promise<void> {
	for (const world of worlds.splice(0)) await world.instance.stop();
	stopProviders();
	await closeIdentityDatabases();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "mainworthy-people-"));
	dirs.push(dir);
	return dir;
}

export type Boot = {
	clock?: Clock;
	dataDir?: string;
	/** `null` is an instance that was told no public address; it has no provider either. */
	publicUrl?: string | null;
	mode?: Config["mode"];
	/**
	 * The instance is behind a proxy on the loopback address that writes the visitor's address in
	 * `x-client-address`, so a test's request comes from the address it names (`from`). Without it every request
	 * comes from loopback, which is never counted by its address.
	 */
	proxied?: boolean;
	/**
	 * The identity provider people sign in through: by default a new one (`test/oidc-support.ts`), and null for an
	 * instance with none. `oidc` changes what the instance is told of it.
	 */
	idp?: Provider | null;
	oidc?: Partial<NonNullable<Config["oidc"]>>;
	/** Run background jobs on their timers. Off by default: a job's write would count in `waitingAtGate` (#971). */
	jobRunner?: boolean;
};
/** A server-mode instance whose owner signs in with `TOKEN`, and whose people sign in through `idp`. */
export async function world(options: Boot = {}): Promise<World> {
	const clock = options.clock ?? clockAt();
	const dataDir = options.dataDir ?? scratch();
	const mode = options.mode ?? "server";
	const publicUrl = options.publicUrl === undefined ? PUBLIC : options.publicUrl;
	const idp =
		publicUrl === null || options.idp === null ? null : (options.idp ?? (await provider({ subject: "nobody" })));
	const instance = await start(
		{
			databaseUrl: await identityDatabaseUrl(dataDir),
			dataDir,
			host: "127.0.0.1",
			port: 0,
			mode,
			owner: OWNER,
			ownerToken: mode === "server" ? TOKEN : null,
			commit: null,
			sessionIdleMs: 14 * DAY,
			sessionMaxMs: 90 * DAY,
			proxy: options.proxied
				? defaultConfig({ MAINWORTHY_TRUSTED_PROXY: "127.0.0.1", MAINWORTHY_CLIENT_ADDRESS_HEADER: "X-Client-Address" })
						.proxy
				: null,
			jobRunner: options.jobRunner ?? false,
			...(publicUrl === null ? {} : { publicUrl }),
			...(idp ? { oidc: idp.config(options.oidc) } : {}),
		},
		(app, owner) => ({ ui: null, routes: archiveRoutes(app, owner) }),
		{ now: clock.now },
	);
	const replies: string[] = [];
	const send = async <T>(method: string, path: string, body: unknown, headers: Sent): Promise<Answer<T>> => {
		const response = await fetch(`${instance.url}${path}`, {
			method,
			headers: {
				[API_VERSION_HEADER]: String(API_VERSION),
				...(method === "POST" ? { "content-type": "application/json" } : {}),
				...headers,
			},
			...(method === "POST" ? { body: JSON.stringify(body) } : {}),
		});
		const text = await response.text();
		replies.push(`${[...response.headers].map(([name, value]) => `${name}: ${value}`).join("\n")}\n${text}`);
		const setCookies = response.headers.getSetCookie();
		return {
			status: response.status,
			body: JSON.parse(text) as Body<T>,
			text,
			setCookies,
			// The first cookie of the reply as a browser sends it back: `name=value`.
			cookie: (setCookies[0] ?? "").split(";")[0] ?? "",
			retryAfter: response.headers.get("retry-after"),
		};
	};
	const post = <T>(path: string, body: unknown, headers: Sent = {}) => send<T>("POST", path, body, headers);
	const op = <T>(name: string, input: Record<string, unknown>, headers: Sent = bearer(TOKEN)) =>
		post<T>(`/api/${name}`, input, headers);
	const made: World = {
		instance,
		idp,
		clock,
		dataDir,
		replies,
		post,
		get: (path, headers = {}) => send("GET", path, undefined, headers),
		op,
		async ok<T>(name: string, input: Record<string, unknown>, headers?: Sent): Promise<T> {
			const reply = await op<T>(name, input, headers);
			if (!reply.body.ok) throw new Error(`${name} ${JSON.stringify(input)}: ${reply.status} ${reply.text}`);
			return reply.body.result;
		},
		status: async (headers) => (await fetch(`${instance.url}/api/session`, { headers })).status,
		disk: async () => await databaseContents(instance.app),
		written: async () => await databaseContents(instance.app),
		rows: async <T>(query: string) => await pgRows<T>(instance.app, query),
	};
	worlds.push(made);
	return made;
}

export type Invited = { id: number; name: string; purpose: string; code: string; link: string; expiresAt: number };
/** Invites a person as the owner does. */
export const invite = (w: World, input: Record<string, unknown>, headers?: Sent): Promise<Invited> =>
	w.ok<Invited>("invitation", { do: "create", ...input }, headers);

/** The cookies of a reply as a browser sends them back, joined with any it already holds. */
export const jar = (...cookies: (string | null | undefined)[]): Sent => ({
	cookie: cookies.filter((cookie): cookie is string => !!cookie).join("; "),
});
export const cookiesOf = (reply: Answer<unknown>): string[] =>
	reply.setCookies.map((cookie) => cookie.split(";")[0] ?? "");
export const ceremonyOf = (reply: Answer<unknown>): string =>
	cookiesOf(reply).find((cookie) => cookie.startsWith("mainworthy_ceremony=")) ?? "";
export const sessionOf = (reply: Answer<unknown>): string =>
	cookiesOf(reply).find((cookie) => cookie.startsWith("mainworthy_sid=")) ?? "";

/** The subject a person of this name has at the test's provider. */
export const subjectOf = (name: string): string => `sub-${name}`;

/** A ceremony begun in a browser: where the page sends the person, and the ceremony cookie it was handed. */
export type Begun = { url: URL; ceremony: string };
export async function begin(w: World, body: Record<string, unknown> = {}, headers: Sent = {}): Promise<Begun> {
	const reply = await w.post<{ url: string }>("/api/login/oidc", body, headers);
	return { url: new URL(must(reply).url), ceremony: ceremonyOf(reply) };
}

/** The provider's answer to a ceremony: the query the provider sent the browser back to the page with. */
export async function authorize(w: World, begun: Begun, who: Next): Promise<string> {
	if (!w.idp) throw new Error("this instance has no identity provider");
	w.idp.next(who);
	const answer = await fetch(begun.url, { redirect: "manual" });
	const location = new URL(answer.headers.get("location") ?? "");
	if (location.origin + location.pathname !== `${PUBLIC}/signin/oidc`)
		throw new Error(`the provider sent the browser to ${location.href}`);
	return location.search;
}

/** The page at `/signin/oidc` hands the query to the server, with the cookies the browser holds. */
export const finish = (w: World, query: string, headers: Sent) =>
	w.post<{ signedIn?: true; linked?: true; proven?: true }>("/api/login", { oidc: query }, headers);

/** The whole round: begin with `body`, sign in at the provider as `who`, and hand the answer back. */
export async function viaProvider(
	w: World,
	who: Next,
	body: Record<string, unknown> = {},
	cookie: string | null = null,
): Promise<Answer<{ signedIn?: true; linked?: true; proven?: true }>> {
	const begun = await begin(w, body, jar(cookie));
	const query = await authorize(w, begun, who);
	return finish(w, query, jar(cookie, begun.ceremony));
}

/**
 * Invites a person as the owner does and accepts through the provider as `subjectOf(name)`: the cookie of the
 * session that opens, as `name=value`.
 */
export async function joined(
	w: World,
	name: string,
	grant: Record<string, unknown> = { can: ["read"], project: "scratch" },
): Promise<string> {
	const { code } = await invite(w, { name, ...grant });
	const accepted = await viaProvider(
		w,
		{ subject: subjectOf(name), email: `${name}@example.com` },
		{ invitation: code },
	);
	if (accepted.status !== 200) throw new Error(`${name} did not join: ${accepted.status} ${accepted.text}`);
	return sessionOf(accepted);
}

/** Signs in through the provider as the person `name` joined as. */
export const signIn = (w: World, name: string) => viaProvider(w, { subject: subjectOf(name) });

/** The person signed in with `cookie` signs in at the provider again, before a sign-in change. */
export const prove = (w: World, cookie: string, name: string, authTime?: number) =>
	viaProvider(
		w,
		{ subject: subjectOf(name), ...(authTime === undefined ? {} : { authTime }) },
		{ proof: true },
		cookie,
	);

/** Holds the existing actors for a deterministic authority wait, until `release`. */
export function holdGate(instance: Instance) {
	return holdWriter(instance.app);
}

/**
 * Resolves once `count` more callers have asked for the write gate. A request does its reading first and asks
 * for a write lease afterwards, so this is how a test knows that a request it sent is waiting there and not still
 * on its way.
 */
export function waitingAtGate(instance: Instance, count: number): Promise<void> {
	const gate = instance.app.database;
	const run = gate.write.bind(gate);
	return new Promise((resolve) => {
		let seen = 0;
		gate.write = (fn) => {
			seen++;
			if (seen === count) {
				gate.write = run;
				// After the caller's own turn of the loop, so that it is in the queue when the test goes on.
				setImmediate(resolve);
			}
			return run(fn);
		};
	});
}
