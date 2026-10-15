// A browser's session on a real listener: what the cookie is, how long it lives, what ends it and what is written
// of its use. Time is the test's own clock, so nothing here sleeps to let a lifetime pass.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Envelope, SessionInfo } from "../src/core/api.ts";
import { flushUses, removeGrant, revokeToken, sweepSessions } from "../src/server/identity/identity.ts";
import { openSession } from "../src/server/identity/sessions.ts";
import {
	type Config,
	databasePath,
	defaultConfig,
	openApp,
	type ReadCall,
	type ReadPool,
} from "../src/server/kernel/app.ts";
import { ARCHIVE_VERSION, SCHEMA_VERSION } from "../src/server/kernel/migrate.ts";
import { Readers } from "../src/server/readers.ts";
import { type Instance, start } from "../src/server/start.ts";
import { exportArchive } from "../src/server/transfer/transfer.ts";
import { archiveRoutes } from "../src/surfaces/archive.ts";

const TOKEN = "owner-secret-0123456789";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const IDLE = 14 * DAY;
const MAX = 90 * DAY;
const T0 = 1_800_000_000_000;
/**
 * Made by the build before sessions existed (commit 4a69918, schema version 1): a server-mode instance whose
 * owner `robin` signs in with `TOKEN`, with a second person `sam`, one case and one run. `instance-v1.db.gz` is
 * that instance's database (`VACUUM INTO`, then gzip) and `archive-v1.ndjson` is what that build's
 * `GET /api/export` answered for it. Neither can be made again by this build, which is the point of them.
 */
const FIXTURES = join(import.meta.dir, "fixtures", "sessions");

const dirs: string[] = [];
const running: Instance[] = [];
afterEach(async () => {
	for (const instance of running.splice(0)) await instance.stop();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Clock = { now: () => number; advance: (ms: number) => void; set: (at: number) => void };
function clockAt(start = T0): Clock {
	let at = start;
	return {
		now: () => at,
		advance: (ms) => {
			at += ms;
		},
		set: (to) => {
			at = to;
		},
	};
}

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "mainworthy-sessions-"));
	dirs.push(dir);
	return dir;
}

type Boot = {
	mode?: Config["mode"];
	owner?: string;
	dataDir?: string;
	clock?: Clock;
	readers?: number;
	ownerToken?: string | null;
};
/** An instance with the archive routes. In server mode its owner signs in with `TOKEN`. */
function boot(options: Boot = {}): Instance {
	const mode = options.mode ?? "server";
	const instance = start(
		{
			dataDir: options.dataDir ?? scratch(),
			host: "127.0.0.1",
			port: 0,
			mode,
			owner: options.owner ?? "robin",
			ownerToken: options.ownerToken === undefined ? (mode === "server" ? TOKEN : null) : options.ownerToken,
			commit: null,
			sessionIdleMs: IDLE,
			sessionMaxMs: MAX,
			proxy: null,
		},
		(app, owner) => ({ ui: null, routes: archiveRoutes(app, owner) }),
		{ readers: options.readers ?? 0, ...(options.clock ? { now: options.clock.now } : {}) },
	);
	running.push(instance);
	return instance;
}

type Sent = Record<string, string>;
const bearer = (token: string): Sent => ({ authorization: `Bearer ${token}` });
/** What a browser on the https page sends through a proxy that ends TLS. */
const overHttps = (instance: Instance): Sent => ({
	origin: `https://${new URL(instance.url).host}`,
	"x-forwarded-proto": "https",
});
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

type Answer<T> = { status: number; body: Envelope<T>; text: string; setCookies: string[]; headers: string };
async function post<T>(instance: Instance, path: string, body: unknown, headers: Sent = {}): Promise<Answer<T>> {
	const response = await fetch(`${instance.url}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
	const text = await response.text();
	return {
		status: response.status,
		body: JSON.parse(text) as Envelope<T>,
		text,
		// One entry for each `Set-Cookie` header, as a browser reads them.
		setCookies: response.headers.getSetCookie(),
		headers: [...response.headers].map(([name, value]) => `${name}: ${value}`).join("\n"),
	};
}

/** Signs in. `cookie` is the first cookie of the reply as a browser sends it back: `name=value`. */
async function signIn(instance: Instance, token = TOKEN, headers: Sent = {}) {
	const reply = await post(instance, "/api/login", { token }, headers);
	const cookie = (reply.setCookies[0] ?? "").split(";")[0] ?? "";
	const at = cookie.indexOf("=");
	return { ...reply, cookie, name: cookie.slice(0, at), value: cookie.slice(at + 1) };
}
const signOut = (instance: Instance, headers: Sent = {}) => post(instance, "/api/logout", {}, headers);
const statusOf = async (instance: Instance, headers: Sent): Promise<number> =>
	(await fetch(`${instance.url}/api/session`, { headers })).status;
const admin = <T>(instance: Instance, input: Record<string, unknown>, headers: Sent = bearer(TOKEN)) =>
	post<T>(instance, "/api/admin", input, headers);
const create = (instance: Instance, outline: string, headers: Sent = bearer(TOKEN)) =>
	post(instance, "/api/p/scratch/propose", { edits: [{ op: "create", outline }] }, headers);

/** A person with a token of their own, and the token's id. */
async function person(instance: Instance, actor: string): Promise<{ token: string; id: number }> {
	const made = await admin<{ token: string }>(instance, {
		do: "token.create",
		actor,
		kind: "human",
		can: ["read"],
		project: "scratch",
	});
	const listed = await admin<{ id: number; actor: string }[]>(instance, { do: "token.list" });
	const id = listed.body.ok ? listed.body.result.findLast((row) => row.actor === actor)?.id : undefined;
	if (!made.body.ok || id === undefined) throw new Error(`no token for ${actor}`);
	return { token: made.body.result.token, id };
}

type SessionRow = {
	id: number;
	token: number | null;
	hash: string;
	last_seen_at: number;
	expires_at: number;
	ended_at: number | null;
	ended_why: string | null;
};
/** The stored sessions, as committed. */
const stored = (instance: Instance): SessionRow[] =>
	instance.app.reader.raw
		.query<SessionRow, []>(
			"SELECT id, token, hash, last_seen_at, expires_at, ended_at, ended_why FROM sessions ORDER BY id",
		)
		.all();
const lastUsed = (instance: Instance, id: number): number | null | undefined =>
	instance.app.reader.raw
		.query<{ last_used_at: number | null }, [number]>("SELECT last_used_at FROM tokens WHERE id = ?")
		.get(id)?.last_used_at;

/** A database file read from outside the server: its schema version, its cases, and whether it has `sessions`. */
function peek(path: string): { version: string | undefined; cases: number | undefined; tables: string[] } {
	const raw = new Database(path, { readonly: true });
	try {
		return {
			version: raw.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value,
			cases: raw.query<{ n: number }, []>("SELECT count(*) AS n FROM cases").get()?.n,
			tables: raw
				.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'")
				.all()
				.map((row) => row.name),
		};
	} finally {
		raw.close();
	}
}

/** Holds the write gate, as a long report does, until `release`. */
function holdGate(instance: Instance): { release: () => Promise<void> } {
	let open = (): void => {};
	const held = instance.app.gate.run(
		() =>
			new Promise<void>((resolve) => {
				open = resolve;
			}),
	);
	return {
		release: () => {
			open();
			return held;
		},
	};
}

/**
 * Counts the callers that have joined the queue at the write gate, so that a test can put requests there in an
 * order it chose: it sends one, waits until that one is in the queue, and sends the next.
 */
function gateQueue(instance: Instance): { reaches: (count: number) => Promise<void>; restore: () => void } {
	const gate = instance.app.gate;
	const run = gate.run;
	const waiting: (() => void)[] = [];
	let joined = 0;
	gate.run = <T>(fn: () => T | Promise<T>): Promise<T> => {
		joined++;
		for (const wake of waiting.splice(0)) wake();
		return run(fn);
	};
	return {
		reaches: async (count) => {
			while (joined < count) await new Promise<void>((resolve) => waiting.push(resolve));
		},
		restore: () => {
			gate.run = run;
		},
	};
}

/** In local mode: a new token for the owner, asked for by the owner of the machine. Its reply holds the secret. */
async function ownToken(instance: Instance): Promise<string> {
	const made = await admin<{ token: string }>(instance, { do: "token.create", actor: "robin", kind: "human" }, {});
	if (!made.body.ok) throw new Error("no token");
	return made.body.result.token;
}
/** Current-format evidence with the old fixture's identities, after applying the real database migrations. */
function currentFixtureArchive(): string {
	const dataDir = scratch();
	writeFileSync(databasePath(dataDir), Bun.gunzipSync(readFileSync(join(FIXTURES, "instance-v1.db.gz"))));
	const app = openApp(defaultConfig({ MAINWORTHY_DATA: dataDir }));
	try {
		const chunks: string[] = [];
		exportArchive(app.db, (chunk) => chunks.push(chunk), { blobs: app.blobs });
		return chunks.join("");
	} finally {
		app.close();
	}
}
/** Replays a current-format snapshot, which removes tokens and sessions while retaining actor ids. */
const importCurrent = (instance: Instance): Promise<Response> => {
	const chunks: string[] = [];
	exportArchive(instance.app.db, (chunk) => chunks.push(chunk), { blobs: instance.app.blobs });
	return fetch(`${instance.url}/api/import`, {
		method: "POST",
		body: chunks.join(""),
	});
};
/** A header a proxy adds: the request is then not the local owner's, and a caller that is refused stays refused. */
const ELSEWHERE: Sent = { "x-real-ip": "192.0.2.1" };

describe("what a browser holds", () => {
	test("after sign-in the cookie is not the token, and no reply or header carries the token", async () => {
		const instance = boot();
		const login = await signIn(instance);
		expect(login.status).toBe(200);
		expect(login.headers).not.toContain(TOKEN);
		expect(login.text).not.toContain(TOKEN);
		expect(login.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(login.value).not.toBe(TOKEN);
		// Nor does anything the session is told afterwards.
		const me = await fetch(`${instance.url}/api/session`, { headers: { cookie: login.cookie } });
		expect(me.status).toBe(200);
		expect(`${[...me.headers].join("\n")}\n${await me.text()}`).not.toContain(TOKEN);
		// What is stored is the SHA-256 of the cookie, so a copy of the database signs nobody in.
		expect(stored(instance).map((row) => row.hash)).toEqual([sha256(login.value)]);
	});

	test("the cookie signs in; the token as a cookie value does not; the old cookie name does not", async () => {
		const instance = boot();
		const login = await signIn(instance);
		const me = await fetch(`${instance.url}/api/session`, { headers: { cookie: login.cookie } });
		expect(((await me.json()) as Envelope<SessionInfo>).ok && me.status).toBe(200);
		const seen: string[] = [];
		for (const cookie of [
			`mainworthy_sid=${TOKEN}`,
			`mainworthy_session=${TOKEN}`,
			`mainworthy_session=${login.value}`,
			`__Host-mainworthy_sid=${login.value}`,
		])
			seen.push(`${cookie.split("=")[0]}: ${await statusOf(instance, { cookie })}`);
		expect(seen).toEqual([
			"mainworthy_sid: 401",
			"mainworthy_session: 401",
			"mainworthy_session: 401",
			"__Host-mainworthy_sid: 401",
		]);
		expect(login.name).toBe("mainworthy_sid");
	});

	test("the session says who it is and that it came by a cookie", async () => {
		const instance = boot();
		const { cookie } = await signIn(instance);
		const me = (await (
			await fetch(`${instance.url}/api/session`, { headers: { cookie } })
		).json()) as Envelope<SessionInfo>;
		expect(me.ok && me.result).toMatchObject({ actor: "robin", via: "cookie", mode: "server" });
		expect(stored(instance)).toMatchObject([
			{ id: 1, token: 1, last_seen_at: expect.any(Number), ended_at: null, ended_why: null },
		]);
	});

	test("https gives __Host-mainworthy_sid with Secure, and plain http gives mainworthy_sid without", async () => {
		const instance = boot();
		const secure = await signIn(instance, TOKEN, overHttps(instance));
		expect(secure.name).toBe("__Host-mainworthy_sid");
		expect(secure.setCookies[0]).toContain("; Secure");
		const plain = await signIn(instance);
		expect(plain.name).toBe("mainworthy_sid");
		expect(plain.setCookies[0]).not.toContain("Secure");
		// Each is the session's name on its own scheme and no session at all on the other.
		const seen = [
			await statusOf(instance, { ...overHttps(instance), cookie: secure.cookie }),
			await statusOf(instance, { cookie: secure.cookie }),
			await statusOf(instance, { cookie: plain.cookie }),
			await statusOf(instance, { ...overHttps(instance), cookie: plain.cookie }),
		];
		expect(seen).toEqual([200, 401, 200, 401]);
	});

	test("cookies are separate headers with the attributes their names need, and every name is expired where it can be", async () => {
		const instance = boot();
		const age = MAX / 1000;
		const secure = await signIn(instance, TOKEN, overHttps(instance));
		expect(secure.setCookies).toEqual([
			`__Host-mainworthy_sid=${secure.value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}; Secure`,
			"mainworthy_sid=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure",
			"mainworthy_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure",
		]);
		// A browser refuses `Secure`, and with it the `__Host-` name, from a page it reached over plain http.
		const plain = await signIn(instance);
		expect(plain.setCookies).toEqual([
			`mainworthy_sid=${plain.value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}`,
			"mainworthy_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
		]);
		expect((await signOut(instance, { ...overHttps(instance), cookie: secure.cookie })).setCookies).toEqual([
			"__Host-mainworthy_sid=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure",
			"mainworthy_sid=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure",
			"mainworthy_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure",
		]);
		expect((await signOut(instance, { cookie: plain.cookie })).setCookies).toEqual([
			"mainworthy_sid=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
			"mainworthy_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
		]);
		for (const cookie of [...secure.setCookies, ...plain.setCookies]) expect(cookie).not.toContain("Domain");
	});

	test("two cookies of the session's name are no session, and neither is a value that is not a cookie of ours", async () => {
		const instance = boot();
		const logged = spyOn(console, "error").mockImplementation(() => {});
		try {
			const first = await signIn(instance);
			const second = await signIn(instance);
			const seen: string[] = [];
			for (const cookie of [
				`${first.cookie}; ${second.cookie}`,
				`${first.cookie}; ${first.cookie}`,
				`${first.cookie}; mainworthy_sid=`,
				"mainworthy_sid=%",
				"mainworthy_sid=",
				`mainworthy_sid="${first.value}"`,
				`mainworthy_sid=${first.value}=`,
				`mainworthy_sid=${first.value.slice(1)}`,
				`mainworthy_sid=${encodeURIComponent(`${first.value} `)}`,
			])
				seen.push(
					`${await statusOf(instance, { cookie })} ${(await post(instance, "/api/p/scratch/find", {}, { cookie })).status}`,
				);
			expect(seen).toEqual(Array.from({ length: 9 }, () => "401 401"));
			// Another cookie beside it, of any other name, changes nothing.
			expect(await statusOf(instance, { cookie: `theme=dark; ${first.cookie}; mainworthy_session=x` })).toBe(200);
			expect(logged.mock.calls).toEqual([]);
		} finally {
			logged.mockRestore();
		}
	});
});

describe("what ends a session", () => {
	test("sign-out ends the session: a copy of the cookie taken before it is refused after it", async () => {
		const clock = clockAt();
		const instance = boot({ clock });
		const { cookie } = await signIn(instance);
		const copy = cookie;
		expect(await statusOf(instance, { cookie })).toBe(200);
		clock.advance(HOUR);
		const out = await signOut(instance, { cookie });
		expect(out.status).toBe(200);
		expect(out.setCookies[0]).toBe("mainworthy_sid=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
		expect(await statusOf(instance, { cookie: copy })).toBe(401);
		expect((await post(instance, "/api/p/scratch/find", {}, { cookie: copy })).status).toBe(401);
		// The end is in the database when the reply leaves, not only in the browser's jar.
		expect(stored(instance)).toMatchObject([{ ended_at: T0 + HOUR, ended_why: "signed-out" }]);
		// The token that opened it still works, and opens another.
		expect((await signIn(instance)).status).toBe(200);
	});

	test("sign-out needs no session and is the same every time: nothing, an unknown cookie and an ended one all answer 200 and clear", async () => {
		const instance = boot();
		const { cookie } = await signIn(instance);
		const cleared = ["mainworthy_sid=", "mainworthy_session="].map(
			(name) => `${name}; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
		);
		const seen: string[] = [];
		for (const sent of [
			{},
			{ cookie: `mainworthy_sid=${"A".repeat(43)}` },
			{ cookie: "mainworthy_sid=%" },
			{ cookie },
			{ cookie },
		] satisfies Sent[]) {
			const out = await signOut(instance, sent);
			expect(out.setCookies).toEqual(cleared);
			seen.push(`${out.status} ${out.body.ok}`);
		}
		expect(seen).toEqual(Array.from({ length: 5 }, () => "200 true"));
		expect(stored(instance)).toMatchObject([{ ended_why: "signed-out" }]);
		// Another site still cannot sign a browser out.
		const again = await signIn(instance);
		const foreign = await signOut(instance, { cookie: again.cookie, origin: "http://evil.example" });
		expect(`${foreign.status} ${foreign.setCookies.length}`).toBe("401 0");
		expect(await statusOf(instance, { cookie: again.cookie })).toBe(200);
	});

	test("sign-out ends the session of the cookie it was sent, whatever token the request also carries", async () => {
		const instance = boot();
		const sam = await person(instance, "sam");
		const owner = await signIn(instance);
		const other = await signIn(instance, sam.token);
		// The owner's browser signs out, and the request also names Sam's token.
		expect((await signOut(instance, { cookie: owner.cookie, ...bearer(sam.token) })).status).toBe(200);
		expect(await statusOf(instance, { cookie: owner.cookie })).toBe(401);
		expect(await statusOf(instance, { cookie: other.cookie })).toBe(200);
		expect(await statusOf(instance, bearer(sam.token))).toBe(200);
		// A token alone signs nothing out: it is not a browser's session.
		expect((await signOut(instance, bearer(sam.token))).status).toBe(200);
		expect(await statusOf(instance, { cookie: other.cookie })).toBe(200);
		expect(await statusOf(instance, bearer(sam.token))).toBe(200);
		expect(stored(instance).map((row) => row.ended_why)).toEqual(["signed-out", null]);
	});

	test("two sessions of one actor are independent: ending one leaves the other", async () => {
		const instance = boot();
		const laptop = await signIn(instance);
		const phone = await signIn(instance);
		expect(laptop.value).not.toBe(phone.value);
		await signOut(instance, { cookie: laptop.cookie });
		expect([
			await statusOf(instance, { cookie: laptop.cookie }),
			await statusOf(instance, { cookie: phone.cookie }),
		]).toEqual([401, 200]);
	});

	test("idle: a session unused for the idle lifetime is refused, and one used inside it lives on", async () => {
		const clock = clockAt();
		const instance = boot({ clock });
		const used = await signIn(instance);
		const unused = await signIn(instance);
		// Thirteen days at a time, each step inside the idle lifetime of the one that is used.
		for (let step = 1; step <= 3; step++) {
			clock.advance(13 * DAY);
			expect(await statusOf(instance, { cookie: used.cookie })).toBe(200);
		}
		expect(await statusOf(instance, { cookie: unused.cookie })).toBe(401);
		// The boundary: one millisecond short of the lifetime is alive, the lifetime itself is not.
		clock.advance(IDLE - 1);
		expect(await statusOf(instance, { cookie: used.cookie })).toBe(200);
		clock.advance(IDLE);
		expect(await statusOf(instance, { cookie: used.cookie })).toBe(401);
	});

	test("absolute: a session is refused after the absolute lifetime however often it was used", async () => {
		const clock = clockAt();
		const instance = boot({ clock });
		const { cookie } = await signIn(instance);
		expect(stored(instance)).toMatchObject([{ expires_at: T0 + MAX }]);
		for (let day = 7; day < 90; day += 7) {
			clock.set(T0 + day * DAY);
			expect(await statusOf(instance, { cookie })).toBe(200);
		}
		clock.set(T0 + MAX - 1);
		expect(await statusOf(instance, { cookie })).toBe(200);
		clock.set(T0 + MAX);
		expect(await statusOf(instance, { cookie })).toBe(401);
		expect((await post(instance, "/api/p/scratch/find", {}, { cookie })).status).toBe(401);
	});

	test("revoking the token that opened a session ends it, forgetting the actor ends it, and its change stream stops", async () => {
		const clock = clockAt();
		const instance = boot({ clock });
		const sam = await person(instance, "sam");
		const { cookie } = await signIn(instance, sam.token);
		const stream = await fetch(`${instance.url}/api/p/scratch/events`, { headers: { cookie } });
		expect(stream.status).toBe(200);
		const reader = stream.body?.getReader();
		if (!reader) throw new Error("no stream");
		const decoder = new TextDecoder();
		await create(instance, "Seen");
		let text = "";
		while (!text.includes("data:")) text += decoder.decode((await reader.read()).value);
		clock.advance(HOUR);
		await admin(instance, { do: "token.revoke", id: sam.id });
		expect(await statusOf(instance, { cookie })).toBe(401);
		await create(instance, "Not for a session whose token is gone");
		let after = "";
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			after += decoder.decode(value);
		}
		expect(after).not.toContain("data:");
		expect(stored(instance)).toMatchObject([{ ended_at: T0 + HOUR, ended_why: "ended" }]);
		// A new token for the same person does not bring the old session back.
		const again = await person(instance, "sam");
		expect(await statusOf(instance, bearer(again.token))).toBe(200);
		expect(await statusOf(instance, { cookie })).toBe(401);

		const pat = await person(instance, "pat");
		const second = await signIn(instance, pat.token);
		expect(await statusOf(instance, { cookie: second.cookie })).toBe(200);
		await admin(instance, { do: "actor.forget", name: "pat" });
		expect(await statusOf(instance, { cookie: second.cookie })).toBe(401);
		expect(stored(instance)[1]).toMatchObject({ ended_at: expect.any(Number), ended_why: "forgotten" });
	});

	test.each(["read", "write"] as const)("the caller is resolved inside the %s snapshot", async (effect) => {
		const instance = boot();
		const sam = await person(instance, "sam");
		await admin(instance, { do: "grant.set", actor: "sam", project: "scratch", can: ["read", "produce"] });
		const drop = () => instance.app.db.transaction(() => removeGrant(instance.app, { actor: "sam", project: 1 }));
		const snapshot = instance.app.reader.snapshot.bind(instance.app.reader);
		const begin = instance.app.db.begin.bind(instance.app.db);
		const hook =
			effect === "read"
				? spyOn(instance.app.reader, "snapshot").mockImplementationOnce((run) => {
						drop();
						return snapshot(run);
					})
				: spyOn(instance.app.db, "begin").mockImplementationOnce(() => {
						drop();
						begin();
					});
		try {
			const reply =
				effect === "read"
					? await post(instance, "/api/p/scratch/find", {}, bearer(sam.token))
					: await create(instance, "Must not be written", bearer(sam.token));
			expect(reply.status).toBe(404);
			expect(reply.body).toMatchObject({ ok: false, error: { code: "not_found" } });
		} finally {
			hook.mockRestore();
		}
		expect((await post(instance, "/api/p/scratch/find", {}, bearer(TOKEN))).body).toMatchObject({
			ok: true,
			result: { count: 0 },
		});
	});

	test.each(["idle", "absolute"] as const)(
		"a reader uses unflushed activity and still enforces the %s end",
		async (end) => {
			const clock = clockAt();
			const instance = boot({ clock, readers: 1 });
			const pool = instance.app.readers;
			if (!(pool instanceof Readers)) throw new Error("the reader pool did not start");
			await pool.ready();
			let dispatched: ReadCall | undefined;
			instance.app.readers = {
				run: (call, fallback) => {
					dispatched = call;
					return pool.run(call, fallback);
				},
				refresh: () => pool.refresh(),
				stop: () => pool.stop(),
			};
			const { cookie } = await signIn(instance);
			clock.advance(IDLE - HOUR);
			expect(await statusOf(instance, { cookie })).toBe(200);
			clock.advance(2 * HOUR);
			expect(stored(instance)[0]?.last_seen_at).toBe(T0);
			expect((await post(instance, "/api/p/scratch/find", {}, { cookie })).body).toMatchObject({
				ok: true,
				result: { count: 0 },
			});
			if (end === "absolute") {
				for (let at = clock.now() + IDLE / 2; at < T0 + MAX; at += IDLE / 2) {
					clock.set(at);
					expect(await statusOf(instance, { cookie })).toBe(200);
				}
				clock.set(T0 + MAX - HOUR);
				expect((await post(instance, "/api/p/scratch/find", {}, { cookie })).status).toBe(200);
				clock.set(T0 + MAX);
			} else clock.advance(IDLE);
			if (!dispatched) throw new Error("the read did not reach the pool");
			const reply = await pool.run({ ...dispatched, clockOffset: clock.now() - Date.now() }, () => {
				throw new Error("the real reader must answer");
			});
			expect(reply).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
		},
	);

	test("an accepted report finishes under its actor after its token is revoked", async () => {
		const instance = boot();
		const made = await admin<{ token: string }>(instance, {
			do: "token.create",
			actor: "pipeline",
			kind: "ci",
			can: ["read", "record"],
			project: "scratch",
		});
		const listed = await admin<{ id: number; actor: string }[]>(instance, { do: "token.list" });
		const id = listed.body.ok ? listed.body.result.find((token) => token.actor === "pipeline")?.id : undefined;
		if (!made.body.ok || id === undefined) throw new Error("the pipeline token was not made");
		const token = made.body.result.token;
		let commits = 0;
		const unsubscribe = instance.app.subscribe((event) => {
			if (event.op === "report" && ++commits === 1) revokeToken(instance.app, id);
		});
		try {
			const report = await post(
				instance,
				"/api/p/scratch/report",
				{
					target: { commit: "accepted113", branch: "main" },
					results: [{ test: { key: "accepted113", name: "accepted report" }, outcome: "pass" }],
				},
				bearer(token),
			);
			expect(report.status).toBe(200);
			expect(report.body).toMatchObject({ ok: true, result: { counts: { total: 1, pass: 1 } } });
			expect(commits).toBe(2);
			expect(await statusOf(instance, bearer(token))).toBe(401);
			const actor = instance.app.reader.raw
				.query<{ name: string }, []>("SELECT a.name FROM batches b JOIN actors a ON a.id = b.actor")
				.get();
			expect(actor?.name).toBe("pipeline");
		} finally {
			unsubscribe();
		}
	});

	test("a read that a busy reader starts after its session ended is answered 401 and carries no data", async () => {
		const instance = boot({ readers: 1 });
		const pool = instance.app.readers;
		if (!(pool instanceof Readers)) throw new Error("the reader pool did not start");
		await pool.ready();
		await create(instance, "Only for whoever is signed in");
		// The one reader is busy: a call handed to the pool reaches it only after `release`. Nothing else is
		// changed, and the call then resolves its credential in the real reader thread.
		const hold = (fallbackOnly = false) => {
			let release = (): void => {};
			const busy = new Promise<void>((resolve) => {
				release = resolve;
			});
			let handed = (): void => {};
			const dispatched = new Promise<void>((resolve) => {
				handed = resolve;
			});
			const replies: Envelope<unknown>[] = [];
			const state = { ran: 0, replies, release: () => release(), dispatched };
			const held: ReadPool = {
				run: (call, fallback) => {
					handed();
					return busy.then(() => {
						state.ran++;
						return (fallbackOnly ? Promise.resolve(fallback()) : pool.run(call, fallback)).then((reply) => {
							state.replies.push(reply);
							return reply;
						});
					});
				},
				refresh: () => pool.refresh(),
				stop: () => pool.stop(),
			};
			instance.app.readers = held;
			return state;
		};
		const { cookie } = await signIn(instance);
		const signedOut = hold();
		const read = post(instance, "/api/p/scratch/find", {}, { cookie });
		await signedOut.dispatched;
		expect((await signOut(instance, { cookie })).status).toBe(200);
		signedOut.release();
		const refused = await read;
		expect(signedOut.ran).toBe(1);
		expect(refused.status).toBe(401);
		expect(signedOut.replies).toMatchObject([{ ok: false, error: { code: "unauthenticated" } }]);
		expect(refused.body).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
		expect(refused.text).not.toContain("Only for whoever is signed in");

		// The same for a token that is revoked while its read waits.
		const sam = await person(instance, "sam");
		const revoked = hold();
		const second = post(instance, "/api/p/scratch/find", {}, bearer(sam.token));
		await revoked.dispatched;
		await admin(instance, { do: "token.revoke", id: sam.id });
		revoked.release();
		const gone = await second;
		expect(`${revoked.ran} ${gone.status}`).toBe("1 401");
		expect(revoked.replies).toMatchObject([{ ok: false, error: { code: "unauthenticated" } }]);
		expect(gone.text).not.toContain("Only for whoever is signed in");

		// The token still works after its project grant is removed, but the queued read must see no project.
		const pat = await person(instance, "pat");
		const ungranted = hold();
		const fourth = post(instance, "/api/p/scratch/find", {}, bearer(pat.token));
		await ungranted.dispatched;
		expect((await admin(instance, { do: "grant.remove", actor: "pat", project: "scratch" })).status).toBe(200);
		ungranted.release();
		const hidden = await fourth;
		expect(hidden.status).toBe(404);
		expect(ungranted.replies).toMatchObject([{ ok: false, error: { code: "not_found" } }]);
		expect(hidden.text).not.toContain("Only for whoever is signed in");

		// A smaller grant hides no project, but still removes permission to read it.
		await admin(instance, { do: "grant.set", actor: "pat", project: "scratch", can: ["read", "produce"] });
		const narrowed = hold();
		const smaller = post(instance, "/api/p/scratch/find", {}, bearer(pat.token));
		await narrowed.dispatched;
		await admin(instance, { do: "grant.set", actor: "pat", project: "scratch", can: ["produce"] });
		narrowed.release();
		expect((await smaller).status).toBe(403);
		expect(narrowed.replies).toMatchObject([{ ok: false, error: { code: "forbidden" } }]);

		// A failed worker replays inline against current grants, too.
		await admin(instance, { do: "grant.set", actor: "pat", project: "scratch", can: ["read"] });
		const replayed = hold(true);
		const fifth = post(instance, "/api/p/scratch/find", {}, bearer(pat.token));
		await replayed.dispatched;
		await admin(instance, { do: "grant.remove", actor: "pat", project: "scratch" });
		replayed.release();
		expect((await fifth).status).toBe(404);
		expect(replayed.replies).toMatchObject([{ ok: false, error: { code: "not_found" } }]);

		// And a read whose caller still stands is answered as before.
		const standing = hold();
		const third = post<{ count: number }>(instance, "/api/p/scratch/find", {}, bearer(TOKEN));
		await standing.dispatched;
		standing.release();
		const answered = await third;
		expect(answered.body.ok && answered.body.result.count).toBe(1);
		instance.app.readers = pool;
	});
});

describe("what is written of a use", () => {
	test("a token that only reads gets a last use after a flush, and the read did not wait for the writer", async () => {
		const clock = clockAt();
		const instance = boot({ clock });
		const gate = holdGate(instance);
		clock.advance(HOUR);
		// Answered while a writer holds the gate: the read notes its use and writes nothing.
		expect((await post(instance, "/api/p/scratch/find", {}, bearer(TOKEN))).status).toBe(200);
		expect(lastUsed(instance, 1)).toBeNull();
		await gate.release();
		// The list shows the use before it is written: it reads the newer of the row and what is noted.
		clock.advance(HOUR);
		const listed = await admin<{ id: number; lastUsedAt: number | null }[]>(instance, { do: "token.list" });
		expect(listed.body.ok && listed.body.result).toMatchObject([{ id: 1, lastUsedAt: T0 + 2 * HOUR }]);
		expect(lastUsed(instance, 1)).toBeNull();
		await flushUses(instance.app);
		expect(lastUsed(instance, 1)).toBe(T0 + 2 * HOUR);
	});

	test("a use that arrives while a flush waits for the gate is not lost", async () => {
		const clock = clockAt();
		const instance = boot({ clock });
		const { cookie } = await signIn(instance);
		clock.advance(HOUR);
		expect(await statusOf(instance, { cookie })).toBe(200);
		const gate = holdGate(instance);
		const flushing = flushUses(instance.app);
		clock.advance(HOUR);
		expect(await statusOf(instance, { cookie })).toBe(200);
		await gate.release();
		await flushing;
		// Whichever of the two uses that flush wrote, the later one is what the session is idle from.
		expect([T0 + HOUR, T0 + 2 * HOUR]).toContain(stored(instance)[0]?.last_seen_at ?? 0);
		clock.advance(IDLE - 1);
		expect(await statusOf(instance, { cookie })).toBe(200);
		await flushUses(instance.app);
		expect(stored(instance)).toMatchObject([{ last_seen_at: T0 + 2 * HOUR + IDLE - 1 }]);
	});

	test("a failed flush loses nothing: what was noted is written by the next one", async () => {
		const clock = clockAt();
		const instance = boot({ clock });
		const { cookie } = await signIn(instance);
		clock.advance(HOUR);
		expect(await statusOf(instance, { cookie })).toBe(200);
		const failing = spyOn(instance.app.db, "run").mockImplementationOnce(() => {
			throw new Error("the disk is full");
		});
		try {
			await expect(flushUses(instance.app)).rejects.toThrow("the disk is full");
		} finally {
			failing.mockRestore();
		}
		expect(stored(instance)).toMatchObject([{ last_seen_at: T0 }]);
		// Still known while it is unwritten: thirteen days on from the use, not from the sign-in.
		clock.advance(IDLE - 1);
		await flushUses(instance.app);
		expect(stored(instance)).toMatchObject([{ last_seen_at: T0 + HOUR }]);
		expect(lastUsed(instance, 1)).toBe(T0);
		expect(await statusOf(instance, { cookie })).toBe(200);
	});

	test("a flush after sign-out does not reopen the session, in either order at the gate", async () => {
		const clock = clockAt();
		const instance = boot({ clock });
		const first = await signIn(instance);
		clock.advance(HOUR);
		expect(await statusOf(instance, { cookie: first.cookie })).toBe(200);
		await signOut(instance, { cookie: first.cookie });
		clock.advance(HOUR);
		await flushUses(instance.app);
		expect(stored(instance)).toMatchObject([{ last_seen_at: T0, ended_at: T0 + HOUR, ended_why: "signed-out" }]);
		expect(await statusOf(instance, { cookie: first.cookie })).toBe(401);

		// The other order: the flush is already waiting at the gate when the sign-out arrives behind it.
		const second = await signIn(instance);
		clock.advance(HOUR);
		expect(await statusOf(instance, { cookie: second.cookie })).toBe(200);
		const gate = holdGate(instance);
		const flushing = flushUses(instance.app);
		const leaving = signOut(instance, { cookie: second.cookie });
		await Bun.sleep(20);
		await gate.release();
		await flushing;
		expect((await leaving).status).toBe(200);
		await flushUses(instance.app);
		expect(stored(instance)[1]).toMatchObject({ ended_at: T0 + 3 * HOUR, ended_why: "signed-out" });
		expect(await statusOf(instance, { cookie: second.cookie })).toBe(401);
	});

	test("a session past its idle time is refused though it keeps sending requests: a stale cookie does not renew itself", async () => {
		const clock = clockAt();
		const instance = boot({ clock });
		const { cookie } = await signIn(instance);
		clock.advance(IDLE);
		const seen: number[] = [];
		for (let i = 0; i < 3; i++) seen.push(await statusOf(instance, { cookie }));
		await flushUses(instance.app);
		seen.push(await statusOf(instance, { cookie }));
		expect(seen).toEqual([401, 401, 401, 401]);
		expect(stored(instance)).toMatchObject([{ last_seen_at: T0, ended_at: null }]);
	});

	test("a session that expired stays refused after the clock is set back, once the minute job has run", async () => {
		const clock = clockAt();
		const instance = boot({ clock });
		const used = await signIn(instance);
		const unused = await signIn(instance);
		clock.set(T0 + 10 * DAY);
		expect(await statusOf(instance, { cookie: used.cookie })).toBe(200);
		clock.set(T0 + 20 * DAY);
		expect(await statusOf(instance, { cookie: used.cookie })).toBe(200);
		await instance.minute();
		// The one nobody used is past its idle time and is ended for good; the other was written, not ended.
		expect(stored(instance)).toMatchObject([
			{ last_seen_at: T0 + 20 * DAY, ended_at: null },
			{ last_seen_at: T0, ended_at: T0 + 20 * DAY, ended_why: "expired" },
		]);
		for (let day = 30; day < 90; day += 10) {
			clock.set(T0 + day * DAY);
			expect(await statusOf(instance, { cookie: used.cookie })).toBe(200);
		}
		clock.set(T0 + MAX);
		expect(await statusOf(instance, { cookie: used.cookie })).toBe(401);
		await instance.minute();
		expect(stored(instance)[0]).toMatchObject({ ended_at: T0 + MAX, ended_why: "expired" });
		// A clock set back to when both were alive revives neither.
		clock.set(T0 + DAY);
		expect([
			await statusOf(instance, { cookie: used.cookie }),
			await statusOf(instance, { cookie: unused.cookie }),
		]).toEqual([401, 401]);
		// Thirty days after a session ended, its row is deleted.
		clock.set(T0 + 50 * DAY);
		await instance.minute();
		expect(stored(instance).map((row) => row.id)).toEqual([1]);
		clock.set(T0 + MAX + 30 * DAY);
		await instance.minute();
		expect(stored(instance)).toEqual([]);
	});

	test("the minute job does not end a session whose latest use is still only noted", async () => {
		const clock = clockAt();
		const instance = boot({ clock });
		const { cookie } = await signIn(instance);
		clock.advance(13 * DAY);
		expect(await statusOf(instance, { cookie })).toBe(200);
		clock.advance(13 * DAY);
		// The row still says the session was last seen at sign-in, twenty-six days ago.
		await instance.app.gate.run(() => sweepSessions(instance.app));
		expect(stored(instance)).toMatchObject([{ last_seen_at: T0, ended_at: null }]);
		expect(await statusOf(instance, { cookie })).toBe(200);
	});

	test("a graceful stop writes what was noted, so the next start does not find a used session idle", async () => {
		const clock = clockAt();
		const dataDir = scratch();
		const first = boot({ dataDir, clock });
		const { cookie } = await signIn(first);
		clock.advance(13 * DAY);
		expect(await statusOf(first, { cookie })).toBe(200);
		await first.stop();
		clock.advance(13 * DAY);
		const second = boot({ dataDir, clock });
		expect(stored(second)).toMatchObject([{ last_seen_at: T0 + 13 * DAY }]);
		expect(await statusOf(second, { cookie })).toBe(200);
	});
});

describe("an upgrade and an archive", () => {
	test("an instance made by the build before sessions starts on this one: migrated, backed up, its token still a token, its old cookie refused", async () => {
		const dataDir = scratch();
		const path = databasePath(dataDir);
		writeFileSync(path, Bun.gunzipSync(readFileSync(join(FIXTURES, "instance-v1.db.gz"))));
		const instance = boot({ dataDir });
		expect(existsSync(`${path}.v1.bak`)).toBe(true);
		const version = instance.app.reader.raw
			.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'")
			.get();
		// Every migration since has run on it too, each on a database that holds data.
		expect(version).toEqual({ value: String(SCHEMA_VERSION) });
		// The copy beside it is the way back: the database as the previous build left it.
		expect(peek(`${path}.v1.bak`)).toEqual({ version: "1", cases: 1, tables: [] });
		// What the instance held is there, and the token is a token as before.
		const found = await post<{ count: number; items: { title: string }[] }>(
			instance,
			"/api/p/scratch/find",
			{},
			bearer(TOKEN),
		);
		expect(found.body.ok && found.body.result).toMatchObject({ count: 1, items: [{ title: "Coupon applies" }] });
		const run = await post<{ ref: string }[]>(instance, "/api/p/scratch/get", { refs: ["R-1"] }, bearer(TOKEN));
		expect(run.body.ok && run.body.result).toMatchObject([{ ref: "R-1" }]);
		// The cookie the old build gave a browser for a year held the token itself. It signs nobody in now.
		expect(await statusOf(instance, { cookie: `mainworthy_session=${TOKEN}` })).toBe(401);
		// Signing in again gives a session.
		const login = await signIn(instance);
		expect(login.name).toBe("mainworthy_sid");
		expect(await statusOf(instance, { cookie: login.cookie })).toBe(200);
		expect(login.setCookies).toContain("mainworthy_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
	});

	test("a migration that fails changes nothing: the instance keeps its version and its data, and starts once the cause is gone", async () => {
		const dataDir = scratch();
		const path = databasePath(dataDir);
		writeFileSync(path, Bun.gunzipSync(readFileSync(join(FIXTURES, "instance-v1.db.gz"))));
		const change = (text: string): void => {
			const raw = new Database(path);
			raw.exec(text);
			raw.close();
		};
		// Something the migration cannot get past: a table of the name it creates.
		change("CREATE TABLE sessions (stray INTEGER)");
		expect(() => boot({ dataDir })).toThrow(/sessions/);
		expect(peek(path)).toEqual({ version: "1", cases: 1, tables: ["sessions"] });
		// The copy was written before the attempt. A second attempt keeps it and does not write another over it.
		const copy = readFileSync(`${path}.v1.bak`);
		expect(() => boot({ dataDir })).toThrow(/sessions/);
		change("DROP TABLE sessions");
		const instance = boot({ dataDir });
		expect(readFileSync(`${path}.v1.bak`).equals(copy)).toBe(true);
		expect((await post(instance, "/api/p/scratch/find", {}, bearer(TOKEN))).status).toBe(200);
		expect((await signIn(instance)).status).toBe(200);
	});

	test("an export carries no session, and an import into an instance with live sessions succeeds and ends them", async () => {
		const source = boot();
		const signedIn = await signIn(source);
		await create(source, "Travels in the archive");
		const exported = await fetch(`${source.url}/api/export`, { headers: { cookie: signedIn.cookie } });
		expect(exported.status).toBe(200);
		const archive = await exported.text();
		const header = JSON.parse(archive.split("\n")[0] ?? "{}") as { tables: Record<string, number> };
		expect(Object.keys(header.tables).filter((name) => name === "sessions" || name === "tokens")).toEqual([]);
		expect(archive).not.toContain('"t":"sessions"');
		expect(archive).not.toContain(sha256(signedIn.value));

		const target = boot();
		const { cookie } = await signIn(target);
		const upload = (body: string) => fetch(`${target.url}/api/import`, { method: "POST", headers: { cookie }, body });
		// An import that fails changes nothing: whoever was signed in still is.
		expect((await upload("not an archive\n")).status).toBe(400);
		expect(await statusOf(target, { cookie })).toBe(200);
		const imported = await upload(archive);
		expect(`${imported.status} ${await imported.text()}`).toContain("200 ");
		expect(await statusOf(target, { cookie })).toBe(401);
		expect(stored(target)).toEqual([]);
	});

	test("a successful import forgets the uses that were noted: a token made afterwards under an old id was never used", async () => {
		const instance = boot({ mode: "local" });
		expect(await statusOf(instance, bearer(await ownToken(instance)))).toBe(200);
		expect((await importCurrent(instance)).status).toBe(200);
		// The import deleted every token, so the next one takes the first id again.
		await ownToken(instance);
		const listed = await admin<{ id: number; lastUsedAt: number | null }[]>(instance, { do: "token.list" }, {});
		expect(listed.body.ok && listed.body.result).toEqual([expect.objectContaining({ id: 1, lastUsedAt: null })]);
	});

	test("a sign-in that waits at the gate across an import is refused, though a new token has taken the old one's id", async () => {
		const instance = boot({ mode: "local" });
		const old = await ownToken(instance);
		const gate = holdGate(instance);
		const queue = gateQueue(instance);
		try {
			// Three callers wait at the gate in this order: the import, a new token for the same actor, the sign-in.
			const importing = importCurrent(instance);
			await queue.reaches(1);
			const replacing = admin<{ token: string }>(instance, { do: "token.create", actor: "robin", kind: "human" }, {});
			await queue.reaches(2);
			// The old token is still a token when the sign-in is read: the import has not run yet.
			const signing = signIn(instance, old, ELSEWHERE);
			await queue.reaches(3);
			await gate.release();
			const replaced = await replacing;
			expect([(await importing).status, replaced.status]).toEqual([200, 200]);
			// The token made after the import holds the id and the actor the old one had. It is another token.
			const rows = instance.app.reader.raw.query<{ id: number; actor: number }, []>("SELECT id, actor FROM tokens");
			expect(rows.all()).toEqual([{ id: 1, actor: 2 }]);
			const refused = await signing;
			expect(`${refused.status} ${refused.setCookies.length}`).toBe("401 0");
			expect(stored(instance)).toEqual([]);
			// As a bearer the old token is refused too, and the new one is a token.
			expect(await statusOf(instance, { ...bearer(old), ...ELSEWHERE })).toBe(401);
			expect(await statusOf(instance, bearer(replaced.body.ok ? replaced.body.result.token : ""))).toBe(200);
		} finally {
			queue.restore();
		}
	});

	test("a local write queued behind an import resolves the configured owner after the gate", async () => {
		const source = boot({ mode: "local", owner: "alice" });
		const archive = await (await fetch(`${source.url}/api/export`)).text();
		const instance = boot({ mode: "local" });
		const oldId = instance.owner.id;
		const gate = holdGate(instance);
		const queue = gateQueue(instance);
		try {
			const importing = fetch(`${instance.url}/api/import`, { method: "POST", body: archive });
			await queue.reaches(1);
			const writing = post(instance, "/api/p/scratch/propose", {
				edits: [{ op: "create", outline: "After the queued import\nAn action > Expected" }],
			});
			await queue.reaches(2);
			await gate.release();
			expect((await importing).status).toBe(200);
			expect((await writing).status).toBe(200);
			expect(
				instance.app.reader.raw.query<{ name: string }, [number]>("SELECT name FROM actors WHERE id = ?").get(oldId)
					?.name,
			).toBe("alice");
			expect(instance.owner.id).not.toBe(oldId);
			expect(
				instance.app.reader.raw
					.query<{ name: string }, []>("SELECT a.name FROM cases c JOIN actors a ON a.id = c.created_by")
					.all(),
			).toEqual([{ name: "robin" }]);
		} finally {
			queue.restore();
			await gate.release();
		}
	});

	test("a local read dispatched before an import resolves the configured owner on its reader thread", async () => {
		const source = boot({ mode: "local", owner: "alice" });
		await post(source, "/api/p/scratch/propose", {
			edits: [{ op: "create", outline: "# Read after import\nAn action > Expected" }],
		});
		const archive = await (await fetch(`${source.url}/api/export`)).text();
		const instance = boot({ mode: "local", readers: 1 });
		const pool = instance.app.readers;
		if (!(pool instanceof Readers)) throw new Error("the reader pool did not start");
		await pool.ready();
		let release = (): void => {};
		const busy = new Promise<void>((resolve) => {
			release = resolve;
		});
		let handed = (): void => {};
		const dispatched = new Promise<void>((resolve) => {
			handed = resolve;
		});
		const replies: Envelope<unknown>[] = [];
		instance.app.readers = {
			run: (call) => {
				handed();
				return busy
					.then(() =>
						pool.run(call, () => {
							throw new Error("the real reader must answer");
						}),
					)
					.then((reply) => {
						replies.push(reply);
						return reply;
					});
			},
			refresh: () => pool.refresh(),
			stop: () => pool.stop(),
		};
		const reading = post(instance, "/api/p/scratch/find", {});
		try {
			await dispatched;
			expect((await fetch(`${instance.url}/api/import`, { method: "POST", body: archive })).status).toBe(200);
			// Only the configured owner may read now. The actor holding its old id has no grant.
			expect((await admin(instance, { do: "grant.remove", actor: "alice" }, {})).status).toBe(200);
			release();
			const answered = await reading;
			expect(answered.status).toBe(200);
			expect(answered.body).toMatchObject({ ok: true, result: { count: 1, items: [{ title: "Read after import" }] } });
			expect(replies).toMatchObject([{ ok: true, result: { count: 1 } }]);
		} finally {
			release();
			await reading;
			instance.app.readers = pool;
		}
	});

	test("a use noted while an import waits is not written to the token that takes the old one's id", async () => {
		const instance = boot({ mode: "local" });
		const old = await ownToken(instance);
		const gate = holdGate(instance);
		const queue = gateQueue(instance);
		try {
			const importing = importCurrent(instance);
			await queue.reaches(1);
			const replacing = ownToken(instance);
			await queue.reaches(2);
			// Still a token until the import commits, so this use is noted under the id the new token will take.
			expect(await statusOf(instance, bearer(old))).toBe(200);
			// A flush that joins the queue now runs after both. It holds nothing of its own: it writes what is
			// noted when its turn comes, and the import has cleared that.
			const flushing = flushUses(instance.app);
			await queue.reaches(3);
			await gate.release();
			expect((await importing).status).toBe(200);
			await replacing;
			await flushing;
			expect(lastUsed(instance, 1)).toBeNull();
			const listed = await admin<{ id: number; lastUsedAt: number | null }[]>(instance, { do: "token.list" }, {});
			expect(listed.body.ok && listed.body.result).toEqual([expect.objectContaining({ id: 1, lastUsedAt: null })]);
		} finally {
			queue.restore();
		}
	});

	test("an old archive is refused, and re-exporting its migrated database restores its cases and runs", async () => {
		const archive = readFileSync(join(FIXTURES, "archive-v1.ndjson"), "utf8");
		expect(archive.split("\n")[0]).toContain('"schema":1');
		const dataDir = scratch();
		const first = boot({ dataDir });
		const refused = await fetch(`${first.url}/api/import`, { method: "POST", headers: bearer(TOKEN), body: archive });
		expect(refused.status).toBe(400);
		expect(await refused.text()).toContain("older than this build");
		const imported = await fetch(`${first.url}/api/import`, {
			method: "POST",
			headers: bearer(TOKEN),
			body: currentFixtureArchive(),
		});
		expect(`${imported.status} ${await imported.text()}`).toContain('200 {"ok":true,"result":{"rows":21,');
		// An import leaves no token behind; the next start takes the owner's from the configuration again.
		await first.stop();
		const second = boot({ dataDir });
		const found = await post<{ count: number; items: { title: string }[] }>(
			second,
			"/api/p/scratch/find",
			{},
			bearer(TOKEN),
		);
		expect(found.body.ok && found.body.result).toMatchObject({ count: 1, items: [{ title: "Coupon applies" }] });
		const run = await post<{ ref: string }[]>(second, "/api/p/scratch/get", { refs: ["R-1"] }, bearer(TOKEN));
		expect(run.body.ok && run.body.result).toMatchObject([{ ref: "R-1" }]);
		const actors = await admin<{ name: string }[]>(second, { do: "actor.list" });
		expect(actors.body.ok && actors.body.result.map((actor) => actor.name)).toEqual(["policy", "robin", "sam"]);
		// A fresh export includes the attachment table, so it names the current archive version.
		const again = await (await fetch(`${second.url}/api/export`, { headers: bearer(TOKEN) })).text();
		expect(again.split("\n")[0]).toContain(`"schema":${ARCHIVE_VERSION}`);
	});

	test("an archive from before explicit empty reports is refused without changing the instance", async () => {
		const archive = readFileSync(join(FIXTURES, "archive-v1.ndjson"), "utf8");
		expect(archive.split("\n")[0]).toContain('"schema":1');
		const instance = boot();
		const imported = await fetch(`${instance.url}/api/import`, {
			method: "POST",
			headers: bearer(TOKEN),
			body: archive,
		});
		expect(imported.status).toBe(400);
		expect(await imported.text()).toContain("older");
		const found = await post<{ count: number }>(instance, "/api/p/scratch/find", {}, bearer(TOKEN));
		expect(found.body.ok && found.body.result).toMatchObject({ count: 0 });
		const again = await (await fetch(`${instance.url}/api/export`, { headers: bearer(TOKEN) })).text();
		expect(again.split("\n")[0]).toContain(`"schema":${ARCHIVE_VERSION}`);
	});
});

describe("the rules a session is made under", () => {
	test("a session is opened by the hash of a token that works, and by nothing else: not by the id a token holds", async () => {
		const instance = boot();
		const sam = await person(instance, "sam");
		const pat = await person(instance, "pat");
		const kim = await person(instance, "kim");
		const idOf = (name: string): number =>
			instance.app.reader.raw.query<{ id: number }, [string]>("SELECT id FROM actors WHERE name = ?").get(name)?.id ??
			0;
		const write = (text: string, ...values: (string | number)[]): Promise<unknown> =>
			instance.app.gate.run(() => instance.app.db.raw.query(text).run(...values));
		// `openSession` takes the token's hash and no id: there is nothing else to open a session with.
		const open = (tokenHash: string) =>
			instance.app.gate.run(() =>
				openSession(instance.app, {
					tokenHash,
					sessionHash: sha256(`a session of ${tokenHash}`),
					userAgent: null,
					address: null,
				}),
			);
		// A token that was revoked, a secret that is no token's, and a token whose actor no longer stands.
		await admin(instance, { do: "token.revoke", id: sam.id });
		expect(await open(sha256(sam.token))).toBeNull();
		expect(await open(sha256("not-a-token-0123456789"))).toBeNull();
		await write("UPDATE actors SET disabled_at = ? WHERE id = ?", Date.now(), idOf("kim"));
		expect(await open(sha256(kim.token))).toBeNull();
		// What an import and a new token leave behind: Pat's token is gone, and another token holds the id it
		// had, for the same actor. The hash of the old one opens nothing; the hash of the new one does.
		const next = "pat-next-token-0123456789";
		await write("DELETE FROM tokens WHERE id = ?", pat.id);
		await write(
			"INSERT INTO tokens (id, actor, hash, label, created_at) VALUES (?, ?, ?, 'next', ?)",
			pat.id,
			idOf("pat"),
			sha256(next),
			Date.now(),
		);
		expect(await statusOf(instance, bearer(next))).toBe(200);
		expect(await open(sha256(pat.token))).toBeNull();
		expect(stored(instance)).toEqual([]);
		expect(await open(sha256(next))).toMatchObject({ id: 1 });
		expect(stored(instance)).toMatchObject([{ id: 1, token: pat.id }]);
		pat.token = next;
		// A revoked token signs nobody in over HTTP either.
		expect((await signIn(instance, sam.token)).status).toBe(401);
		await signIn(instance);
		await signIn(instance, pat.token);
		expect(stored(instance).map((row) => row.token)).toEqual([pat.id, 1, pat.id]);
		// A row with no token, were one ever written, is nobody's session: being alive needs the token's own row.
		const value = "A".repeat(43);
		await instance.app.gate.run(() =>
			instance.app.db.raw
				.query(
					"INSERT INTO sessions (actor, hash, token, created_at, last_seen_at, expires_at) VALUES (?, ?, NULL, ?, ?, ?)",
				)
				.run(idOf("robin"), sha256(value), Date.now(), Date.now(), Date.now() + MAX),
		);
		expect(await statusOf(instance, { cookie: `mainworthy_sid=${value}` })).toBe(401);
	});

	test("the two lifetimes come from the environment, and a value that is not a duration stops the start", () => {
		expect(defaultConfig({})).toMatchObject({ sessionIdleMs: 14 * DAY, sessionMaxMs: 90 * DAY });
		expect(defaultConfig({ MAINWORTHY_SESSION_IDLE: "12h", MAINWORTHY_SESSION_MAX: "2w" })).toMatchObject({
			sessionIdleMs: 12 * HOUR,
			sessionMaxMs: 14 * DAY,
		});
		// A variable a compose file passes on empty is one that was not set.
		expect(defaultConfig({ MAINWORTHY_SESSION_IDLE: "", MAINWORTHY_SESSION_MAX: "" })).toMatchObject({
			sessionIdleMs: 14 * DAY,
			sessionMaxMs: 90 * DAY,
		});
		for (const bad of ["14", "0d", "14 days", "1.5d", "-1d", "14D", "90m"]) {
			expect(() => defaultConfig({ MAINWORTHY_SESSION_IDLE: bad })).toThrow("MAINWORTHY_SESSION_IDLE");
			expect(() => defaultConfig({ MAINWORTHY_SESSION_MAX: bad })).toThrow("MAINWORTHY_SESSION_MAX");
		}
	});
});
