// A browser's session on a real listener: what the cookie is, how long it lives, what ends it and what is written
// of its use. Time is the test's own clock, so nothing here sleeps to let a lifetime pass.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Instance, start } from "../src/app/start.ts";
import type { Envelope, SessionInfo } from "../src/core/api.ts";
import { API_VERSION, API_VERSION_HEADER } from "../src/core/version.ts";
import { flushUses, removeGrant, revokeToken, sweepSessions } from "../src/server/identity/identity.ts";
import { openSession } from "../src/server/identity/sessions.ts";
import { type Config, defaultConfig } from "../src/server/kernel/app.ts";
import type { WriteDb } from "../src/server/kernel/db.ts";
import { ARCHIVE_VERSION } from "../src/server/kernel/migrate.ts";
import { exportArchive, removeProject } from "../src/server/transfer/transfer.ts";
import { archiveRoutes } from "../src/surfaces/archive.ts";
import {
	closeIdentityDatabases,
	holdWriter,
	identityDatabaseUrl,
	pauseRead,
	pgRow,
	pgRows,
	pgRun,
	withWrite,
} from "./identity-db.ts";

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
async function cleanUp(): Promise<void> {
	for (const instance of running.splice(0)) await instance.stop();
	await closeIdentityDatabases();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}
afterEach(cleanUp);

test("identity fixtures survive a reopen within a test and retire at its cleanup boundary", async () => {
	const key = scratch();
	const first = await identityDatabaseUrl(key);
	expect(await identityDatabaseUrl(key)).toBe(first);
	await cleanUp();
	expect(await identityDatabaseUrl(key)).not.toBe(first);
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
async function boot(options: Boot = {}): Promise<Instance> {
	const mode = options.mode ?? "server";
	const instance = await start(
		{
			databaseUrl: await identityDatabaseUrl(options.dataDir ?? scratch()),
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
		{ ...(options.clock ? { now: options.clock.now } : {}) },
	);
	running.push(instance);
	return instance;
}

type Sent = Record<string, string>;
const bearer = (token: string): Sent => ({ authorization: `Bearer ${token}` });
/** What a browser on the https page sends through a proxy that ends TLS. */
const overHttps = (instance: Instance): Sent => ({
	[API_VERSION_HEADER]: String(API_VERSION),
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
const stored = async (instance: Instance): Promise<SessionRow[]> =>
	await pgRows<SessionRow>(
		instance.app,
		"SELECT id, token, hash, last_seen_at, expires_at, ended_at, ended_why FROM sessions ORDER BY id",
		[],
	);
const lastUsed = async (instance: Instance, id: number): Promise<number | null | undefined> =>
	(await pgRow<{ last_used_at: number | null }>(instance.app, "SELECT last_used_at FROM tokens WHERE id = ?", [id]))
		?.last_used_at;

/** Holds the write gate, as a long report does, until `release`. */
function holdGate(instance: Instance): { release: () => Promise<void> } {
	return holdWriter(instance.app);
}

/**
 * Counts the callers that have joined the queue at the write gate, so that a test can put requests there in an
 * order it chose: it sends one, waits until that one is in the queue, and sends the next.
 */
function gateQueue(instance: Instance): { reaches: (count: number) => Promise<void>; restore: () => void } {
	const gate = instance.app.database;
	const run = gate.write.bind(gate);
	const waiting: (() => void)[] = [];
	let joined = 0;
	gate.write = <T>(fn: (db: WriteDb) => T | Promise<T>): Promise<T> => {
		joined++;
		for (const wake of waiting.splice(0)) wake();
		return run(fn);
	};
	return {
		reaches: async (count) => {
			while (joined < count) await new Promise<void>((resolve) => waiting.push(resolve));
		},
		restore: () => {
			gate.write = run;
		},
	};
}

/** In local mode: a new token for the owner, asked for by the owner of the machine. Its reply holds the secret. */
async function ownToken(instance: Instance): Promise<string> {
	const made = await admin<{ token: string }>(instance, { do: "token.create", actor: "robin", kind: "human" }, {});
	if (!made.body.ok) throw new Error("no token");
	return made.body.result.token;
}
/** A current snapshot made through the registry on PostgreSQL. */
async function currentFixtureArchive(): Promise<string> {
	const instance = await boot();
	await person(instance, "sam");
	await create(instance, "Coupon applies");
	await post(instance, "/api/p/scratch/plan", { name: "Fixture", select: { cases: ["C-1"] } }, bearer(TOKEN));
	const chunks: string[] = [];
	await instance.app.database.read(
		async (db) =>
			await exportArchive(
				db,
				(chunk) => {
					chunks.push(chunk);
				},
				{ blobs: instance.app.blobs },
			),
	);
	return chunks.join("");
}
/** Replays a current-format snapshot, which removes tokens and sessions while retaining actor ids. */
const importCurrent = async (instance: Instance): Promise<Response> => {
	const chunks: string[] = [];
	await instance.app.database.read(
		async (db) =>
			await exportArchive(
				db,
				(chunk) => {
					chunks.push(chunk);
				},
				{ blobs: instance.app.blobs },
			),
	);
	return fetch(`${instance.url}/api/import`, {
		method: "POST",
		body: chunks.join(""),
	});
};
/** A header a proxy adds: the request is then not the local owner's, and a caller that is refused stays refused. */
const ELSEWHERE: Sent = { "x-real-ip": "192.0.2.1" };

describe("what a browser holds", () => {
	test("after sign-in the cookie is not the token, and no reply or header carries the token", async () => {
		const instance = await boot();
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
		expect((await stored(instance)).map((row) => row.hash)).toEqual([sha256(login.value)]);
	});

	test("the cookie signs in; the token as a cookie value does not; the old cookie name does not", async () => {
		const instance = await boot();
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
		const instance = await boot();
		const { cookie } = await signIn(instance);
		const me = (await (
			await fetch(`${instance.url}/api/session`, { headers: { cookie } })
		).json()) as Envelope<SessionInfo>;
		expect(me.ok && me.result).toMatchObject({ actor: "robin", via: "cookie", mode: "server" });
		expect(await stored(instance)).toMatchObject([
			{ id: 1, token: 1, last_seen_at: expect.any(Number), ended_at: null, ended_why: null },
		]);
	});

	test("https gives __Host-mainworthy_sid with Secure, and plain http gives mainworthy_sid without", async () => {
		const instance = await boot();
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
		const instance = await boot();
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
		const instance = await boot();
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
		const instance = await boot({ clock });
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
		expect(await stored(instance)).toMatchObject([{ ended_at: T0 + HOUR, ended_why: "signed-out" }]);
		// The token that opened it still works, and opens another.
		expect((await signIn(instance)).status).toBe(200);
	});

	test("sign-out needs no session and is the same every time: nothing, an unknown cookie and an ended one all answer 200 and clear", async () => {
		const instance = await boot();
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
		expect(await stored(instance)).toMatchObject([{ ended_why: "signed-out" }]);
		// Another site still cannot sign a browser out.
		const again = await signIn(instance);
		const foreign = await signOut(instance, { cookie: again.cookie, origin: "http://evil.example" });
		expect(`${foreign.status} ${foreign.setCookies.length}`).toBe("401 0");
		expect(await statusOf(instance, { cookie: again.cookie })).toBe(200);
	});

	test("sign-out ends the session of the cookie it was sent, whatever token the request also carries", async () => {
		const instance = await boot();
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
		expect((await stored(instance)).map((row) => row.ended_why)).toEqual(["signed-out", null]);
	});

	test("two sessions of one actor are independent: ending one leaves the other", async () => {
		const instance = await boot();
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
		const instance = await boot({ clock });
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
		const instance = await boot({ clock });
		const { cookie } = await signIn(instance);
		expect(await stored(instance)).toMatchObject([{ expires_at: T0 + MAX }]);
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

	for (const project of ["scratch", "private-other", "no-such-project"]) {
		test(`an event request for ${project} whose session expires after admission returns 401`, async () => {
			const clock = clockAt();
			const instance = await boot({ clock });
			await admin(instance, { do: "project.create", key: "private-other" });
			const sam = await person(instance, "sam");
			const { cookie } = await signIn(instance, sam.token);
			const pause = pauseRead(instance.app, "after", 2);
			const opening = fetch(`${instance.url}/api/p/${project}/events`, { headers: { cookie } });
			try {
				await pause.reached;
				clock.advance(MAX);
				pause.release();
				const response = await opening;
				expect(response.status).toBe(401);
				expect(response.headers.get("content-type")).toStartWith("application/json");
				const text = await response.text();
				expect(JSON.parse(text)).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
				expect(text).not.toContain(project);
				expect(text).not.toContain("retry:");
				expect(text).not.toContain("data:");
			} finally {
				pause.restore();
				const response = await opening;
				if (!response.bodyUsed) await response.body?.cancel();
			}
		});
	}

	for (const boundary of ["first project snapshot", "project recheck", "after project recheck"] as const) {
		test(`an account request whose session expires at the ${boundary} returns 401`, async () => {
			const clock = clockAt();
			const instance = await boot({ clock });
			const { cookie } = await signIn(instance);
			// Admission, actor, session id, credentials, project snapshot, project recheck.
			const pause = pauseRead(
				instance.app,
				boundary === "after project recheck" ? "after" : "before",
				boundary === "first project snapshot" ? 5 : 6,
			);
			const reading = fetch(`${instance.url}/api/session`, { headers: { cookie } });
			try {
				await pause.reached;
				clock.advance(MAX);
				pause.release();
				const response = await reading;
				expect(response.status).toBe(401);
				const body = await response.json();
				expect(body).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
				expect(body).not.toHaveProperty("result");
			} finally {
				pause.restore();
				const response = await reading;
				if (!response.bodyUsed) await response.body?.cancel();
			}
		});
	}

	test("an event request with a live session retains project privacy and capability errors", async () => {
		const instance = await boot();
		await admin(instance, { do: "project.create", key: "private-other" });
		const sam = await person(instance, "sam");
		const { cookie } = await signIn(instance, sam.token);
		const missing = [];
		for (const project of ["private-other", "no-such-project"]) {
			const response = await fetch(`${instance.url}/api/p/${project}/events`, { headers: { cookie } });
			expect(response.status).toBe(404);
			const text = await response.text();
			expect(JSON.parse(text)).toMatchObject({ ok: false, error: { code: "not_found" } });
			missing.push(text.replaceAll(project, "<project>"));
		}
		expect(missing[0]).toBe(missing[1]);
		await admin(instance, { do: "grant.set", actor: "sam", project: "scratch", can: ["produce"] });
		const forbidden = await fetch(`${instance.url}/api/p/scratch/events`, { headers: { cookie } });
		expect(forbidden.status).toBe(403);
		expect(await forbidden.json()).toMatchObject({ ok: false, error: { code: "forbidden" } });
		await admin(instance, { do: "grant.remove", actor: "sam", project: "scratch" });
		const account = await fetch(`${instance.url}/api/session`, { headers: { cookie } });
		expect(account.status).toBe(200);
		expect(await account.json()).toMatchObject({ ok: true, result: { projects: [] } });
	});

	test("an established change stream closes without sending data after its session expires", async () => {
		const clock = clockAt();
		const instance = await boot({ clock });
		const { cookie } = await signIn(instance);
		const stream = await fetch(`${instance.url}/api/p/scratch/events`, { headers: { cookie } });
		expect(stream.status).toBe(200);
		const reader = stream.body?.getReader();
		if (!reader) throw new Error("no stream");
		try {
			const decoder = new TextDecoder();
			expect(decoder.decode((await reader.read()).value)).toBe("retry: 2000\n\n");
			clock.advance(MAX);
			await create(instance, "Not for an expired session");
			expect(await reader.read()).toEqual({ value: undefined, done: true });
		} finally {
			await reader.cancel();
		}
	});

	test("revoking the token that opened a session ends it, forgetting the actor ends it, and its change stream stops", async () => {
		const clock = clockAt();
		const instance = await boot({ clock });
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
		expect(await stored(instance)).toMatchObject([{ ended_at: T0 + HOUR, ended_why: "ended" }]);
		// A new token for the same person does not bring the old session back.
		const again = await person(instance, "sam");
		expect(await statusOf(instance, bearer(again.token))).toBe(200);
		expect(await statusOf(instance, { cookie })).toBe(401);

		const pat = await person(instance, "pat");
		const second = await signIn(instance, pat.token);
		expect(await statusOf(instance, { cookie: second.cookie })).toBe(200);
		await admin(instance, { do: "actor.forget", name: "pat" });
		expect(await statusOf(instance, { cookie: second.cookie })).toBe(401);
		expect((await stored(instance))[1]).toMatchObject({ ended_at: expect.any(Number), ended_why: "forgotten" });
	});

	test.each(["read", "write"] as const)("the caller is resolved inside the %s snapshot", async (effect) => {
		const instance = await boot();
		const sam = await person(instance, "sam");
		await admin(instance, { do: "grant.set", actor: "sam", project: "scratch", can: ["read", "produce"] });
		const read = instance.app.database.read.bind(instance.app.database);
		const write = instance.app.database.write.bind(instance.app.database);
		const dropped = async () =>
			await write(
				async (db) =>
					await db.transaction(async () => await removeGrant(instance.app, db, { actor: "sam", project: 1 })),
			);
		const hook =
			effect === "read"
				? spyOn(instance.app.database, "read").mockImplementation(async (fn) => {
						hook.mockRestore();
						await dropped();
						return await read(fn);
					})
				: spyOn(instance.app.database, "write").mockImplementation(async (fn) => {
						hook.mockRestore();
						await dropped();
						return await write(fn);
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
		"a reader uses stored activity and still enforces the %s end",
		async (end) => {
			const clock = clockAt();
			const instance = await boot({ clock });

			const { cookie } = await signIn(instance);
			clock.advance(IDLE - HOUR);
			expect(await statusOf(instance, { cookie })).toBe(200);
			clock.advance(2 * HOUR);
			expect((await stored(instance))[0]?.last_seen_at).toBe(T0 + IDLE - HOUR);
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
			const reply = await post(instance, "/api/p/scratch/find", {}, { cookie });
			expect(reply.body).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
		},
	);

	test("an accepted report finishes under its actor after its token is revoked", async () => {
		const instance = await boot();
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
		let revoking: Promise<unknown> | undefined;
		const unsubscribe = instance.app.subscribe((event) => {
			if (event.op === "report" && ++commits === 1) {
				revoking = withWrite(instance.app, async (db) => await revokeToken(instance.app, db, id));
			}
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
			await revoking;
			expect(await statusOf(instance, bearer(token))).toBe(401);
			const actor = await pgRow<{ name: string }>(
				instance.app,
				"SELECT a.name FROM batches b JOIN actors a ON a.id = b.actor",
				[],
			);
			expect(actor?.name).toBe("pipeline");
		} finally {
			unsubscribe();
		}
	});

	test("a queued read rechecks a session, token and project grant before returning data", async () => {
		const instance = await boot();
		await create(instance, "Only for whoever is signed in");
		const { cookie } = await signIn(instance);
		const cases: { headers: Sent; change: () => Promise<void>; status: number }[] = [
			{
				headers: { cookie },
				change: async () => {
					await signOut(instance, { cookie });
				},
				status: 401,
			},
		];
		const sam = await person(instance, "sam");
		cases.push({
			headers: bearer(sam.token),
			change: async () => {
				await admin(instance, { do: "token.revoke", id: sam.id });
			},
			status: 401,
		});
		const pat = await person(instance, "pat");
		cases.push({
			headers: bearer(pat.token),
			change: async () => {
				await admin(instance, { do: "grant.remove", actor: "pat", project: "scratch" });
			},
			status: 404,
		});
		for (const c of cases) {
			const pause = pauseRead(instance.app, "before", c.headers.cookie ? 2 : 1);
			const reading = post(instance, "/api/p/scratch/find", {}, c.headers);
			try {
				await pause.reached;
				await c.change();
				pause.release();
				const reply = await reading;
				expect(reply.status).toBe(c.status);
				expect(reply.text).not.toContain("Only for whoever is signed in");
			} finally {
				pause.restore();
				await reading;
			}
		}
		await admin(instance, { do: "grant.set", actor: "pat", project: "scratch", can: ["read", "produce"] });
		const pause = pauseRead(instance.app, "before", 1);
		const reading = post(instance, "/api/p/scratch/find", {}, bearer(pat.token));
		try {
			await pause.reached;
			await admin(instance, { do: "grant.set", actor: "pat", project: "scratch", can: ["produce"] });
			pause.release();
			expect((await reading).status).toBe(403);
		} finally {
			pause.restore();
			await reading;
		}
	});

	test("a read whose worker answered before its project grant was removed carries no data", async () => {
		const instance = await boot({});
		await create(instance, "Removed grant payload");
		const sam = await person(instance, "sam");
		const pause = pauseRead(instance.app, "after", 1);
		const reading = post(instance, "/api/p/scratch/find", {}, bearer(sam.token));
		try {
			await pause.reached;
			expect((await admin(instance, { do: "grant.remove", actor: "sam", project: "scratch" })).status).toBe(200);
			pause.release();
			const refused = await reading;
			expect(refused.status).toBe(404);
			expect(refused.text).not.toContain("Removed grant payload");
		} finally {
			pause.release();
			await reading;
			pause.restore();
		}
	});

	for (const replacement of [false, true]) {
		test(`a completed read carries no data after its project is ${replacement ? "replaced" : "removed"}`, async () => {
			const instance = await boot({});
			await create(instance, "Deleted project secret");
			const pause = pauseRead(instance.app, "after", 1);
			const reading = post(instance, "/api/p/scratch/find", {}, bearer(TOKEN));
			try {
				await pause.reached;
				await withWrite(instance.app, async (db) => await removeProject(db, "scratch"));
				if (replacement) expect((await admin(instance, { do: "project.create", key: "scratch" })).status).toBe(200);
				pause.release();
				const response = await reading;
				expect(response.status).toBe(replacement ? 200 : 404);
				expect(response.text).not.toContain("Deleted project secret");
				const current = await post(instance, "/api/p/scratch/find", {}, bearer(TOKEN));
				expect(response.body).toEqual(current.body);
				expect(current.text).not.toContain("Deleted project secret");
			} finally {
				pause.release();
				await reading;
				pause.restore();
			}
		});
	}
});

describe("what is written of a use", () => {
	test("a token read writes its last use before returning", async () => {
		const clock = clockAt();
		const instance = await boot({ clock });
		clock.advance(HOUR);
		expect((await post(instance, "/api/p/scratch/find", {}, bearer(TOKEN))).status).toBe(200);
		expect(await lastUsed(instance, 1)).toBe(T0 + HOUR);
		clock.advance(30_000);
		expect(await statusOf(instance, bearer(TOKEN))).toBe(200);
		expect(await lastUsed(instance, 1)).toBe(T0 + HOUR);
	});

	test("a failed use write refuses the request and a retry persists it", async () => {
		const clock = clockAt();
		const instance = await boot({ clock });
		const { cookie } = await signIn(instance);
		clock.advance(HOUR);
		const failing = spyOn(instance.app.database, "write").mockImplementationOnce(async () => {
			throw new Error("deliberate use-write failure");
		});
		const logged = spyOn(console, "error").mockImplementation(() => {});
		try {
			expect(await statusOf(instance, { cookie })).toBe(500);
		} finally {
			failing.mockRestore();
			logged.mockRestore();
		}
		expect(await stored(instance)).toMatchObject([{ last_seen_at: T0 }]);
		expect(await statusOf(instance, { cookie })).toBe(200);
		expect(await stored(instance)).toMatchObject([{ last_seen_at: T0 + HOUR }]);
	});

	test("sign-out preserves the stored last use and a later use cannot reopen it", async () => {
		const clock = clockAt();
		const instance = await boot({ clock });
		const { cookie } = await signIn(instance);
		clock.advance(HOUR);
		expect(await statusOf(instance, { cookie })).toBe(200);
		await signOut(instance, { cookie });
		clock.advance(HOUR);
		expect(await statusOf(instance, { cookie })).toBe(401);
		expect(await stored(instance)).toMatchObject([
			{ last_seen_at: T0 + HOUR, ended_at: T0 + HOUR, ended_why: "signed-out" },
		]);
	});

	test("a session past its idle time is refused though it keeps sending requests: a stale cookie does not renew itself", async () => {
		const clock = clockAt();
		const instance = await boot({ clock });
		const { cookie } = await signIn(instance);
		clock.advance(IDLE);
		const seen: number[] = [];
		for (let i = 0; i < 3; i++) seen.push(await statusOf(instance, { cookie }));
		await flushUses(instance.app);
		seen.push(await statusOf(instance, { cookie }));
		expect(seen).toEqual([401, 401, 401, 401]);
		expect(await stored(instance)).toMatchObject([{ last_seen_at: T0, ended_at: null }]);
	});

	test("a session that expired stays refused after the clock is set back, once the minute job has run", async () => {
		const clock = clockAt();
		const instance = await boot({ clock });
		const used = await signIn(instance);
		const unused = await signIn(instance);
		clock.set(T0 + 10 * DAY);
		expect(await statusOf(instance, { cookie: used.cookie })).toBe(200);
		clock.set(T0 + 20 * DAY);
		expect(await statusOf(instance, { cookie: used.cookie })).toBe(200);
		await instance.minute();
		// The one nobody used is past its idle time and is ended for good; the other was written, not ended.
		expect(await stored(instance)).toMatchObject([
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
		expect((await stored(instance))[0]).toMatchObject({ ended_at: T0 + MAX, ended_why: "expired" });
		// A clock set back to when both were alive revives neither.
		clock.set(T0 + DAY);
		expect([
			await statusOf(instance, { cookie: used.cookie }),
			await statusOf(instance, { cookie: unused.cookie }),
		]).toEqual([401, 401]);
		// Thirty days after a session ended, its row is deleted.
		clock.set(T0 + 50 * DAY);
		await instance.minute();
		expect((await stored(instance)).map((row) => row.id)).toEqual([1]);
		clock.set(T0 + MAX + 30 * DAY);
		await instance.minute();
		expect(await stored(instance)).toEqual([]);
	});

	test("the minute job reads the latest durable use", async () => {
		const clock = clockAt();
		const instance = await boot({ clock });
		const { cookie } = await signIn(instance);
		clock.advance(13 * DAY);
		expect(await statusOf(instance, { cookie })).toBe(200);
		clock.advance(13 * DAY);
		// The earlier request persisted the use; another process can run the sweep.
		await sweepSessions(instance.app);
		expect(await stored(instance)).toMatchObject([{ last_seen_at: T0 + 13 * DAY, ended_at: null }]);
		expect(await statusOf(instance, { cookie })).toBe(200);
	});

	test("a graceful stop writes what was noted, so the next start does not find a used session idle", async () => {
		const clock = clockAt();
		const dataDir = scratch();
		const first = await boot({ dataDir, clock });
		const { cookie } = await signIn(first);
		clock.advance(13 * DAY);
		expect(await statusOf(first, { cookie })).toBe(200);
		await first.stop();
		clock.advance(13 * DAY);
		const second = await boot({ dataDir, clock });
		expect(await stored(second)).toMatchObject([{ last_seen_at: T0 + 13 * DAY }]);
		expect(await statusOf(second, { cookie })).toBe(200);
	});
});

describe("an upgrade and an archive", () => {
	test("an export carries no session, and an import into an instance with live sessions succeeds and ends them", async () => {
		const source = await boot();
		const signedIn = await signIn(source);
		await create(source, "Travels in the archive");
		const exported = await fetch(`${source.url}/api/export`, { headers: { cookie: signedIn.cookie } });
		expect(exported.status).toBe(200);
		const archive = await exported.text();
		const header = JSON.parse(archive.split("\n")[0] ?? "{}") as { tables: Record<string, number> };
		expect(Object.keys(header.tables).filter((name) => name === "sessions" || name === "tokens")).toEqual([]);
		expect(archive).not.toContain('"t":"sessions"');
		expect(archive).not.toContain(sha256(signedIn.value));

		const target = await boot();
		const { cookie } = await signIn(target);
		const upload = (body: string) =>
			fetch(`${target.url}/api/import`, { method: "POST", headers: bearer(TOKEN), body });
		// An import that fails changes nothing: whoever was signed in still is.
		expect((await upload("not an archive\n")).status).toBe(400);
		expect(await statusOf(target, { cookie })).toBe(200);
		const imported = await upload(archive);
		expect(`${imported.status} ${await imported.text()}`).toContain("200 ");
		expect(await statusOf(target, { cookie })).toBe(401);
		expect(await stored(target)).toEqual([]);
	});

	test("a successful import forgets the uses that were noted: a token made afterwards under an old id was never used", async () => {
		const instance = await boot({ mode: "local" });
		expect(await statusOf(instance, bearer(await ownToken(instance)))).toBe(200);
		expect((await importCurrent(instance)).status).toBe(200);
		// The import deleted every token, so the next one takes the first id again.
		await ownToken(instance);
		const listed = await admin<{ id: number; lastUsedAt: number | null }[]>(instance, { do: "token.list" }, {});
		expect(listed.body.ok && listed.body.result).toEqual([expect.objectContaining({ id: 1, lastUsedAt: null })]);
	});

	test("a sign-in that waits at the gate across an import is refused, though a new token has taken the old one's id", async () => {
		const instance = await boot({ mode: "local" });
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
			const rows = await pgRows<{ id: number; actor: number }>(instance.app, "SELECT id, actor FROM tokens");
			expect(rows).toEqual([{ id: 1, actor: 2 }]);
			const refused = await signing;
			expect(`${refused.status} ${refused.setCookies.length}`).toBe("401 0");
			expect(await stored(instance)).toEqual([]);
			// As a bearer the old token is refused too, and the new one is a token.
			expect(await statusOf(instance, { ...bearer(old), ...ELSEWHERE })).toBe(401);
			expect(await statusOf(instance, bearer(replaced.body.ok ? replaced.body.result.token : ""))).toBe(200);
		} finally {
			queue.restore();
		}
	});

	test("a local write queued behind an import resolves the configured owner after the gate", async () => {
		const source = await boot({ mode: "local", owner: "alice" });
		const archive = await (await fetch(`${source.url}/api/export`)).text();
		const instance = await boot({ mode: "local" });
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
			expect((await pgRow<{ name: string }>(instance.app, "SELECT name FROM actors WHERE id = ?", [oldId]))?.name).toBe(
				"alice",
			);
			expect(instance.owner.id).not.toBe(oldId);
			expect(
				await pgRows<{ name: string }>(
					instance.app,
					"SELECT a.name FROM cases c JOIN actors a ON a.id = c.created_by",
					[],
				),
			).toEqual([{ name: "robin" }]);
		} finally {
			queue.restore();
			await gate.release();
		}
	});

	test("a local read dispatched before an import resolves the configured owner in its snapshot", async () => {
		const source = await boot({ mode: "local", owner: "alice" });
		await post(source, "/api/p/scratch/propose", {
			edits: [{ op: "create", outline: "# Read after import\nAn action > Expected" }],
		});
		const archive = await (await fetch(`${source.url}/api/export`)).text();
		const instance = await boot({ mode: "local" });

		const pause = pauseRead(instance.app, "before");
		const reading = post(instance, "/api/p/scratch/find", {});
		try {
			await pause.reached;
			expect((await fetch(`${instance.url}/api/import`, { method: "POST", body: archive })).status).toBe(200);
			// Only the configured owner may read now. The actor holding its old id has no grant.
			expect((await admin(instance, { do: "grant.remove", actor: "alice" }, {})).status).toBe(200);
			pause.release();
			const answered = await reading;
			expect(answered.status).toBe(200);
			expect(answered.body).toMatchObject({ ok: true, result: { count: 1, items: [{ title: "Read after import" }] } });
		} finally {
			pause.release();
			await reading;
			pause.restore();
		}
	});

	test("a delayed use after an import cannot touch a replacement token", async () => {
		const instance = await boot({ mode: "local" });
		const old = await ownToken(instance);
		expect((await importCurrent(instance)).status).toBe(200);
		await ownToken(instance);
		const { noteUse } = await import("../src/server/identity/uses.ts");
		await noteUse(instance.app, "token", 1, instance.app.now(), "192.0.2.10", sha256(old));
		expect(await lastUsed(instance, 1)).toBeNull();
		const listed = await admin<{ id: number; lastUsedAt: number | null }[]>(instance, { do: "token.list" }, {});
		expect(listed.body.ok && listed.body.result).toEqual([expect.objectContaining({ id: 1, lastUsedAt: null })]);
	});

	test("an old archive is refused, and re-exporting its migrated database restores its cases and runs", async () => {
		const archive = readFileSync(join(FIXTURES, "archive-v1.ndjson"), "utf8");
		expect(archive.split("\n")[0]).toContain('"schema":1');
		const dataDir = scratch();
		const first = await boot({ dataDir });
		const refused = await fetch(`${first.url}/api/import`, { method: "POST", headers: bearer(TOKEN), body: archive });
		expect(refused.status).toBe(400);
		expect(await refused.text()).toContain("older than this build");
		const unchanged = await post<{ count: number }>(first, "/api/p/scratch/find", {}, bearer(TOKEN));
		expect(unchanged.body.ok && unchanged.body.result).toMatchObject({ count: 0 });
		const imported = await fetch(`${first.url}/api/import`, {
			method: "POST",
			headers: bearer(TOKEN),
			body: await currentFixtureArchive(),
		});
		expect(imported.status).toBe(200);
		// An import leaves no token behind; the next start takes the owner's from the configuration again.
		await first.stop();
		const second = await boot({ dataDir });
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
});

describe("the rules a session is made under", () => {
	test("a session is opened by the hash of a token that works, and by nothing else: not by the id a token holds", async () => {
		const instance = await boot();
		const sam = await person(instance, "sam");
		const pat = await person(instance, "pat");
		const kim = await person(instance, "kim");
		const idOf = async (name: string): Promise<number> =>
			(await pgRow<{ id: number }>(instance.app, "SELECT id FROM actors WHERE name = ?", [name]))?.id ?? 0;
		const write = (text: string, ...values: (string | number)[]): Promise<unknown> =>
			withWrite(instance.app, async (db) => await pgRun(instance.app, text, [...values], db));
		// `openSession` takes the token's hash and no id: there is nothing else to open a session with.
		const open = (tokenHash: string) =>
			withWrite(
				instance.app,
				async (db) =>
					await openSession(instance.app, db, {
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
		await write("UPDATE actors SET disabled_at = ? WHERE id = ?", Date.now(), await idOf("kim"));
		expect(await open(sha256(kim.token))).toBeNull();
		// What an import and a new token leave behind: Pat's token is gone, and another token holds the id it
		// had, for the same actor. The hash of the old one opens nothing; the hash of the new one does.
		const next = "pat-next-token-0123456789";
		await write("DELETE FROM tokens WHERE id = ?", pat.id);
		await write(
			"INSERT INTO tokens (id, actor, hash, label, created_at) VALUES (?, ?, ?, 'next', ?)",
			pat.id,
			await idOf("pat"),
			sha256(next),
			Date.now(),
		);
		expect(await statusOf(instance, bearer(next))).toBe(200);
		expect(await open(sha256(pat.token))).toBeNull();
		expect(await stored(instance)).toEqual([]);
		expect(await open(sha256(next))).toMatchObject({ id: 1 });
		expect(await stored(instance)).toMatchObject([{ id: 1, token: pat.id }]);
		pat.token = next;
		// A revoked token signs nobody in over HTTP either.
		expect((await signIn(instance, sam.token)).status).toBe(401);
		await signIn(instance);
		await signIn(instance, pat.token);
		expect((await stored(instance)).map((row) => row.token)).toEqual([pat.id, 1, pat.id]);
		// A row with no token, were one ever written, is nobody's session: being alive needs the token's own row.
		const value = "A".repeat(43);
		await withWrite(
			instance.app,
			async (db) =>
				await pgRun(
					instance.app,
					"INSERT INTO sessions (actor, hash, token, created_at, last_seen_at, expires_at) VALUES (?, ?, NULL, ?, ?, ?)",
					[await idOf("robin"), sha256(value), Date.now(), Date.now(), Date.now() + MAX],
					db,
				),
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
