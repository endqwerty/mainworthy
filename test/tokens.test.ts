// What a token is allowed to be, on a real listener: when it ends, who made it, where it was last used from, and
// what the start does with the owner's. Time is the test's own clock, so nothing here waits for a token to expire.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { type Instance, start } from "../src/app/start.ts";
import { COMMIT, outputWith, RED_XML, withInstance } from "../src/cli/test-support.ts";
import type { Envelope } from "../src/core/api.ts";
import {
	admit,
	authenticate,
	flushUses,
	hasAdminGrant,
	hashToken,
	listActors,
} from "../src/server/identity/identity.ts";
import type { Config, WriteGate } from "../src/server/kernel/app.ts";
import { databasePath } from "../src/server/kernel/db.ts";
import { SCHEMA_VERSION } from "../src/server/kernel/migrate.ts";
import { archiveRoutes } from "../src/surfaces/archive.ts";
import { sessionOf } from "../src/surfaces/http.ts";

/** 36 characters: long enough that the start has nothing to say about it. */
const OWNER = "owner-secret-0123456789abcdef-012345";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = 1_800_000_000_000;
const LOOPBACK = "127.0.0.1";

/**
 * Made by the build before tokens had an end (commit c608261, schema version 2), with its clock at `T0` and three
 * hours on: a server-mode instance of the owner `robin`. Its first start had no token configured and generated
 * `GENERATED`; its second took `ENV` from `MAINWORTHY_OWNER_TOKEN`. `SAM` is a token the owner then made for a
 * second person, and the two cookies are the sessions that `SAM` and `ENV` opened. `instance-v2.db.gz` is that
 * instance's database (`VACUUM INTO`, then gzip). This build cannot make it again, which is the point of it.
 */
const FIXTURE = {
	file: join(import.meta.dir, "fixtures", "tokens", "instance-v2.db.gz"),
	env: "fixture-owner-token-0123456789abcdef",
	generated: "cb_zfMyTDtIiDlaUWPY633P7fTSxonVe2kS",
	sam: "cb_ntmN9agJC2FILxECSRrPaVD0iKycOfsV",
	samCookie: "mainworthy_sid=_ENihccmAR_Ow6AiOlldPxQipr_SKe6tjnfyDoz61m4",
	ownerCookie: "mainworthy_sid=wDc3mkFWeh14U5VbWYBqnJw_m1nio8yKdJffbuI3p3U",
	stoppedAt: T0 + 3 * HOUR,
};

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
	const dir = mkdtempSync(join(tmpdir(), "mainworthy-tokens-"));
	dirs.push(dir);
	return dir;
}

/**
 * What a start said about tokens. A server that names no proxy also says so on every start (the limit on failed
 * sign-ins, `test/limit.test.ts`); that line is not this file's subject.
 */
const said = (instance: { warnings: string[] }): string[] =>
	instance.warnings.filter((line) => !line.startsWith("MAINWORTHY_TRUSTED_PROXY"));

type Boot = { mode?: Config["mode"]; dataDir?: string; clock?: Clock; owner?: string; ownerToken?: string | null };
/** An instance with the archive routes. In server mode its owner `robin` signs in with `OWNER` unless told otherwise. */
async function boot(options: Boot = {}): Promise<Instance> {
	const mode = options.mode ?? "server";
	const instance = await start(
		{
			dataDir: options.dataDir ?? scratch(),
			host: LOOPBACK,
			port: 0,
			mode,
			owner: options.owner ?? "robin",
			ownerToken: options.ownerToken === undefined ? (mode === "server" ? OWNER : null) : options.ownerToken,
			commit: null,
			proxy: null,
			sessionIdleMs: 14 * DAY,
			sessionMaxMs: 90 * DAY,
		},
		(app, owner) => ({ ui: null, routes: archiveRoutes(app, owner) }),
		{ readers: 0, ...(options.clock ? { now: options.clock.now } : {}) },
	);
	running.push(instance);
	return instance;
}

type Sent = Record<string, string>;
const bearer = (token: string): Sent => ({ authorization: `Bearer ${token}` });

type Answer<T> = { status: number; body: Envelope<T>; text: string; setCookies: string[] };
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
		setCookies: response.headers.getSetCookie(),
	};
}

/** Signs in with a token. `cookie` is the session cookie as a browser sends it back: `name=value`. */
async function signIn(instance: Instance, token: string) {
	const reply = await post(instance, "/api/login", { token });
	return { status: reply.status, cookie: (reply.setCookies[0] ?? "").split(";")[0] ?? "" };
}
const statusOf = async (instance: Instance, headers: Sent): Promise<number> =>
	(await fetch(`${instance.url}/api/session`, { headers })).status;
const admin = <T>(instance: Instance, input: Record<string, unknown>, headers: Sent = bearer(OWNER)) =>
	post<T>(instance, "/api/admin", input, headers);
const create = (instance: Instance, outline: string, headers: Sent = bearer(OWNER)) =>
	post(instance, "/api/p/scratch/propose", { edits: [{ op: "create", outline }] }, headers);

type Listed = {
	id: number;
	actor: string;
	kind: string;
	label: string;
	createdAt: number;
	revoked: boolean;
	expired: boolean;
	expiresAt: number | null;
	createdBy: string | null;
	lastUsedAt: number | null;
	lastUsedFrom: string | null;
};
async function listed(instance: Instance, headers: Sent = bearer(OWNER)): Promise<Listed[]> {
	const reply = await admin<Listed[]>(instance, { do: "token.list" }, headers);
	if (!reply.body.ok) throw new Error(reply.text);
	return reply.body.result;
}

type Made = { token: string; id: number; expiresAt: number | null };
/** A token for the owner. An actor that exists keeps the grants it has, so the request names none. */
const FOR_OWNER = { actor: "robin", can: [], project: undefined };
/** Makes a token, by default for a person who may read `scratch`, and says which row it is. */
async function token(instance: Instance, input: Record<string, unknown>, headers: Sent = bearer(OWNER)): Promise<Made> {
	const made = await admin<{ token: string; expiresAt: number | null }>(
		instance,
		{ do: "token.create", kind: "human", can: ["read"], project: "scratch", ...input },
		headers,
	);
	if (!made.body.ok) throw new Error(made.text);
	const id = (await listed(instance, headers)).findLast((row) => row.actor === input.actor)?.id;
	if (id === undefined) throw new Error(`no token for ${String(input.actor)}`);
	return { token: made.body.result.token, id, expiresAt: made.body.result.expiresAt };
}

type TokenRow = {
	id: number;
	label: string;
	source: string | null;
	created_by: number | null;
	expires_at: number | null;
	revoked_at: number | null;
	last_used_at: number | null;
	last_used_addr: string | null;
};
/** The stored tokens, as committed. */
const tokens = (instance: Instance): TokenRow[] =>
	instance.app.reader.raw
		.query<TokenRow, []>(
			"SELECT id, label, source, created_by, expires_at, revoked_at, last_used_at, last_used_addr FROM tokens ORDER BY id",
		)
		.all();

type SessionRow = {
	id: number;
	ended_at: number | null;
	last_seen_at: number;
	created_addr: string | null;
	last_seen_addr: string | null;
};
const sessions = (instance: Instance): SessionRow[] =>
	instance.app.reader.raw
		.query<SessionRow, []>("SELECT id, ended_at, last_seen_at, created_addr, last_seen_addr FROM sessions ORDER BY id")
		.all();

test("a token made in one project carries its actor's grants in other projects, as the guide says", async () => {
	const instance = await boot();
	await token(instance, { actor: "reviewer", kind: "agent", can: ["read", "produce"] });
	expect((await admin(instance, { do: "project.create", key: "other" })).status).toBe(200);
	expect((await admin(instance, { do: "project.create", key: "private" })).status).toBe(200);
	expect(
		(await admin(instance, { do: "grant.set", actor: "reviewer", project: "other", can: ["read"], roles: ["auditor"] }))
			.status,
	).toBe(200);
	const made = await token(instance, { actor: "reviewer", kind: "agent", can: ["read", "produce"] });
	for (const project of ["scratch", "other"]) {
		expect(
			(
				await post(
					instance,
					`/api/p/${project}/propose`,
					{ edits: [{ op: "create", outline: `Case in ${project}` }] },
					bearer(OWNER),
				)
			).status,
		).toBe(200);
		const read = await post(instance, `/api/p/${project}/find`, { in: "cases" }, bearer(made.token));
		expect([project, read.status, read.body.ok]).toEqual([project, 200, true]);
		expect(read.body).toMatchObject({ ok: true, result: { items: [{ title: `Case in ${project}` }] } });
	}
	expect((await post(instance, "/api/p/private/find", { in: "cases" }, bearer(made.token))).status).toBe(404);
	// Hold the guide's scope claim to the HTTP behaviour above, rather than assuming project means token scope.
	const guide = readFileSync(join(import.meta.dir, "../docs/guide/access.md"), "utf8");
	expect(
		guide.slice(
			guide.indexOf("## Make a token"),
			guide.indexOf("From the command line:", guide.indexOf("## Make a token")),
		),
	).toContain("A token carries its actor's current grants on every project.");
});

test("project-scoped actor resolution reads only global and requested direct grants", async () => {
	const instance = await boot();
	const sam = await token(instance, { actor: "sam", project: undefined });
	expect((await admin(instance, { do: "project.create", key: "other" })).status).toBe(200);
	expect((await admin(instance, { do: "grant.set", actor: "sam", can: ["read"], roles: ["auditor"] })).status).toBe(
		200,
	);
	expect(
		(
			await admin(instance, {
				do: "grant.set",
				actor: "sam",
				project: "scratch",
				can: ["produce"],
				roles: ["approver"],
			})
		).status,
	).toBe(200);
	expect(
		(await admin(instance, { do: "grant.set", actor: "sam", project: "other", can: ["admin"], roles: ["lead"] }))
			.status,
	).toBe(200);
	const projects = instance.app.reader.raw
		.query<{ id: number; key: string }, []>("SELECT id, key FROM projects ORDER BY id")
		.all();
	const scratch = projects.find((project) => project.key === "scratch")?.id;
	const other = projects.find((project) => project.key === "other")?.id;
	if (scratch === undefined || other === undefined) throw new Error("missing project");
	const reads = spyOn(instance.app.reader, "all");
	try {
		expect(await authenticate(instance.app, sam.token, scratch)).toMatchObject({
			name: "sam",
			can: ["read", "record", "produce"],
			roles: ["auditor", "approver"],
		});
		const grantReads = reads.mock.calls.flatMap(([statement], index) =>
			/\bFROM grants\b/.test(statement.text) ? [reads.mock.results[index]] : [],
		);
		expect(grantReads).toEqual([
			{
				type: "return",
				value: [
					{ project: 0, can: '["read"]', roles: '["auditor"]' },
					{ project: scratch, can: '["produce"]', roles: '["approver"]' },
				],
			},
		]);
		expect(await authenticate(instance.app, sam.token, other)).toMatchObject({
			name: "sam",
			can: ["read", "admin"],
			roles: ["auditor", "lead"],
		});
		expect(await authenticate(instance.app, sam.token, 0)).toMatchObject({
			name: "sam",
			can: ["read"],
			roles: ["auditor"],
		});
	} finally {
		reads.mockRestore();
	}
});

test("all-project admin checks and actor listings retain grants on other projects", async () => {
	const instance = await boot();
	const sam = await token(instance, { actor: "sam" });
	expect((await admin(instance, { do: "project.create", key: "other" })).status).toBe(200);
	expect(
		(await admin(instance, { do: "grant.set", actor: "sam", project: "other", can: ["admin"], roles: ["lead"] }))
			.status,
	).toBe(200);
	const actor = await authenticate(instance.app, sam.token, 0);
	if (!actor) throw new Error("token did not authenticate");
	expect(actor.can).toEqual([]);
	expect(await hasAdminGrant(instance.app.reader, actor.id)).toBe(true);
	expect((await listActors(instance.app.reader)).find((listed) => listed.name === "sam")?.grants).toEqual([
		{ project: 1, can: ["read"], roles: [] },
		{ project: 2, can: ["admin"], roles: ["lead"] },
	]);
	expect((await admin(instance, { do: "grant.remove", actor: "sam", project: "other" })).status).toBe(200);
	expect(await hasAdminGrant(instance.app.reader, actor.id)).toBe(false);
	expect((await authenticate(instance.app, sam.token, 1))?.can).toEqual(["read"]);
});

test("grant and token revocation are visible to the next request and an admitted caller", async () => {
	const instance = await boot();
	const sam = await token(instance, { actor: "sam", can: ["read", "produce"] });
	const admission = await admit(instance.app, {
		bearer: sam.token,
		cookie: null,
		sameOrigin: false,
		localOwner: null,
		address: null,
	});
	if (admission.kind !== "admitted") throw new Error("token was not admitted");
	expect((await admission.session.actor(1))?.can).toEqual(["read", "record", "produce"]);
	expect((await create(instance, "Before revocation", bearer(sam.token))).status).toBe(200);
	expect((await admin(instance, { do: "grant.set", actor: "sam", project: "scratch", can: ["read"] })).status).toBe(
		200,
	);
	expect((await admission.session.actor(1))?.can).toEqual(["read"]);
	expect((await create(instance, "After grant revocation", bearer(sam.token))).status).toBe(403);
	expect((await admin(instance, { do: "token.revoke", id: sam.id })).status).toBe(200);
	expect(await admission.session.actor(1)).toBeNull();
	expect(await statusOf(instance, bearer(sam.token))).toBe(401);
});

describe("sign-in record retention", () => {
	test("revocation records the end of its sessions immediately, without changing an earlier end", async () => {
		const clock = clockAt();
		const instance = await boot({ clock });
		const sam = await token(instance, { actor: "sam" });
		const first = await signIn(instance, sam.token);
		const second = await signIn(instance, sam.token);
		await post(instance, "/api/logout", {}, { cookie: first.cookie });
		clock.advance(HOUR);
		expect((await admin(instance, { do: "token.revoke", id: sam.id })).status).toBe(200);
		expect(sessions(instance)).toMatchObject([{ ended_at: T0 }, { ended_at: T0 + HOUR }]);
		expect(await statusOf(instance, { cookie: second.cookie })).toBe(401);
		clock.advance(30 * DAY - 1);
		await instance.minute();
		expect(sessions(instance)).toMatchObject([{ ended_at: T0 + HOUR }]);
		clock.advance(1);
		await instance.minute();
		expect(sessions(instance)).toEqual([]);
	});

	test("the minute job erases token addresses 30 days after the earlier of revocation and expiry", async () => {
		const clock = clockAt();
		const instance = await boot({ clock });
		const revoked = await token(instance, { actor: "sam", expires: "60d" });
		const expired = await token(instance, { actor: "pat", expires: "1d" });
		const active = await token(instance, { actor: "lee" });
		for (const made of [revoked, expired, active]) expect(await statusOf(instance, bearer(made.token))).toBe(200);
		clock.advance(DAY);
		await admin(instance, { do: "token.revoke", id: revoked.id });
		clock.advance(DAY);
		// Revoking an already expired token must not restart its retention period.
		await admin(instance, { do: "token.revoke", id: expired.id });
		clock.set(T0 + 31 * DAY - 1);
		await instance.minute();
		expect(
			tokens(instance)
				.filter((row) => row.id !== 1)
				.map((row) => row.last_used_addr),
		).toEqual([LOOPBACK, LOOPBACK, LOOPBACK]);
		clock.advance(1);
		await instance.minute();
		expect(
			tokens(instance)
				.filter((row) => row.id !== 1)
				.map((row) => row.last_used_addr),
		).toEqual([null, null, LOOPBACK]);
		await flushUses(instance.app);
		expect((await listed(instance)).filter((row) => row.id !== 1).map((row) => row.lastUsedFrom)).toEqual([
			null,
			null,
			LOOPBACK,
		]);
		expect(await statusOf(instance, bearer(revoked.token))).toBe(401);
		expect(await statusOf(instance, bearer(expired.token))).toBe(401);
	});

	test("a delayed minute job uses the token's end rather than the time of the sweep", async () => {
		const clock = clockAt();
		const instance = await boot({ clock });
		const sam = await token(instance, { actor: "sam", expires: "1d" });
		const { cookie } = await signIn(instance, sam.token);
		clock.set(T0 + 31 * DAY - 1);
		await instance.minute();
		expect(sessions(instance)).toMatchObject([{ ended_at: T0 + DAY }]);
		clock.advance(1);
		await instance.minute();
		expect(sessions(instance)).toEqual([]);
		expect(await statusOf(instance, { cookie })).toBe(401);
	});

	test("revoking an expired token keeps its sessions' earlier expiry as their end", async () => {
		const clock = clockAt();
		const instance = await boot({ clock });
		const sam = await token(instance, { actor: "sam", expires: "1d" });
		await signIn(instance, sam.token);
		clock.advance(2 * DAY);
		await admin(instance, { do: "token.revoke", id: sam.id });
		expect(sessions(instance)).toMatchObject([{ ended_at: T0 + DAY }]);
		clock.set(T0 + 31 * DAY);
		await instance.minute();
		expect(sessions(instance)).toEqual([]);
	});

	test("sessions left unended by an earlier build are deleted 30 days after their token's revocation", async () => {
		const clock = clockAt();
		const instance = await boot({ clock });
		const sam = await token(instance, { actor: "sam" });
		await signIn(instance, sam.token);
		clock.advance(DAY);
		await admin(instance, { do: "token.revoke", id: sam.id });
		await instance.app.gate.run(() =>
			instance.app.db.raw.query("UPDATE sessions SET ended_at = NULL, ended_why = NULL").run(),
		);
		clock.set(T0 + 31 * DAY - 1);
		await instance.minute();
		expect(sessions(instance)).toMatchObject([{ ended_at: T0 + DAY }]);
		clock.advance(1);
		await instance.minute();
		expect(sessions(instance)).toEqual([]);
	});
});

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

/** A change stream that has been opened, and what is read from it. */
async function stream(instance: Instance, headers: Sent) {
	const response = await fetch(`${instance.url}/api/p/scratch/events`, { headers });
	const reader = response.body?.getReader();
	if (response.status !== 200 || !reader) throw new Error(`no stream: ${response.status}`);
	const decoder = new TextDecoder();
	return {
		/** Reads until an event has arrived. */
		async event(): Promise<void> {
			let text = "";
			while (!text.includes("data:")) text += decoder.decode((await reader.read()).value);
		},
		/** Reads until the server closes the stream, and answers with everything that came before it did. */
		async rest(): Promise<string> {
			let text = "";
			for (;;) {
				const { value, done } = await reader.read();
				if (done) return text;
				text += decoder.decode(value);
			}
		},
	};
}

describe("a token with an end", () => {
	test("it works before its end, and after it is refused with the reply a revoked token gets, on every route", async () => {
		const clock = clockAt();
		const instance = await boot({ clock });
		const sam = await token(instance, { actor: "sam", expires: "12h" });
		expect(sam.expiresAt).toBe(T0 + 12 * HOUR);
		const pat = await token(instance, { actor: "pat" });
		expect(pat.expiresAt).toBeNull();
		await admin(instance, { do: "token.revoke", id: pat.id });

		/** What each route that takes a token answers this one: the status and the whole body. */
		const replies = async (secret: string): Promise<string[]> => {
			const session = await fetch(`${instance.url}/api/session`, { headers: bearer(secret) });
			const events = await fetch(`${instance.url}/api/p/scratch/events`, { headers: bearer(secret) });
			const found = await post(instance, "/api/p/scratch/find", {}, bearer(secret));
			const written = await post(instance, "/api/p/scratch/propose", { edits: [] }, bearer(secret));
			const login = await post(instance, "/api/login", { token: secret });
			const seen = [
				`session ${session.status} ${await session.text()}`,
				`find ${found.status} ${found.text}`,
				`propose ${written.status} ${written.text}`,
				`login ${login.status} ${login.text} ${login.setCookies.length}`,
				`events ${events.status} ${events.headers.get("content-type")}`,
			];
			// A stream that was opened is closed here, not left for the server's stop.
			await events.body?.cancel();
			return seen;
		};
		clock.set(T0 + 12 * HOUR - 1);
		expect((await replies(sam.token)).map((line) => line.split(" ").slice(0, 2).join(" "))).toEqual([
			"session 200",
			"find 200",
			"propose 403",
			"login 200",
			"events 200",
		]);
		clock.set(T0 + 12 * HOUR);
		const expired = await replies(sam.token);
		expect(expired.map((line) => line.split(" ").slice(0, 2).join(" "))).toEqual([
			"session 401",
			"find 401",
			"propose 401",
			"login 401",
			"events 401",
		]);
		expect(expired).toEqual(await replies(pat.token));
		// It ended by the clock: nothing was written to its row, and the list says which of the two it is.
		expect(tokens(instance).find((row) => row.id === sam.id)).toMatchObject({ revoked_at: null });
		expect((await listed(instance)).filter((row) => row.id === sam.id || row.id === pat.id)).toMatchObject([
			{ actor: "sam", expired: true, revoked: false },
			{ actor: "pat", expired: false, revoked: true },
		]);
	});

	test("a session opened with it ends when it does, and the change streams of the token and of the session stop", async () => {
		const clock = clockAt();
		const instance = await boot({ clock });
		const sam = await token(instance, { actor: "sam", expires: "12h" });
		const { cookie } = await signIn(instance, sam.token);
		const bySession = await stream(instance, { cookie });
		const byToken = await stream(instance, bearer(sam.token));
		await create(instance, "Seen");
		await bySession.event();
		await byToken.event();
		clock.set(T0 + 12 * HOUR - 1);
		expect(await statusOf(instance, { cookie })).toBe(200);
		clock.set(T0 + 12 * HOUR);
		expect(await statusOf(instance, { cookie })).toBe(401);
		expect((await post(instance, "/api/p/scratch/find", {}, { cookie })).status).toBe(401);
		await create(instance, "Not for a token that has ended");
		expect([await bySession.rest(), await byToken.rest()].map((text) => text.includes("data:"))).toEqual([
			false,
			false,
		]);
		// The session was not given an end of its own: it is read with its token, as with a revoked one.
		expect(sessions(instance)).toMatchObject([{ ended_at: null }]);
		// A token past its end opens no new session.
		expect((await signIn(instance, sam.token)).status).toBe(401);
		expect(sessions(instance)).toHaveLength(1);
	});

	test("a token that reaches its end while its sign-in waits at the gate opens no session", async () => {
		const clock = clockAt();
		const instance = await boot({ clock });
		const sam = await token(instance, { actor: "sam", expires: "12h" });
		clock.set(T0 + 12 * HOUR - 1);
		const gate = holdGate(instance);
		// The sign-in is let in while the token works, and queues its write behind whoever holds the gate.
		const run = instance.app.gate.run;
		const queued = new Promise<void>((resolve) => {
			const watched: WriteGate["run"] = (fn) => {
				instance.app.gate.run = run;
				resolve();
				return run(fn);
			};
			instance.app.gate.run = watched;
		});
		const waiting = signIn(instance, sam.token);
		try {
			await queued;
			clock.set(T0 + 12 * HOUR);
		} finally {
			await gate.release();
		}
		expect((await waiting).status).toBe(401);
		expect(sessions(instance)).toEqual([]);
	});

	test("what is not a duration is refused, and nothing is made", async () => {
		const instance = await boot();
		for (const expires of ["90m", "0d", "14", "1y", "", 30]) {
			const refused = await admin(instance, {
				do: "token.create",
				actor: "sam",
				kind: "human",
				project: "scratch",
				expires,
			});
			expect(`${String(expires)}: ${refused.status}`).toBe(`${String(expires)}: 400`);
			expect(refused.body).toMatchObject({ ok: false, error: { code: "invalid" } });
		}
		const said = await admin(instance, { do: "token.create", actor: "sam", kind: "human", expires: "90m" });
		expect(said.text).toContain("12h, 14d or 2w");
		expect((await listed(instance)).map((row) => row.actor)).toEqual(["robin"]);
	});

	test("the owner's last token that works is kept, and one that has ended is not another", async () => {
		const clock = clockAt();
		const dataDir = scratch();
		const first = await boot({ clock, dataDir, ownerToken: null });
		const generated = first.generatedToken ?? "";
		const second = await token(first, { ...FOR_OWNER, expires: "12h" }, bearer(generated));
		clock.set(T0 + 12 * HOUR);
		// The second has ended, so the first is the last way in and stays.
		const kept = await admin(first, { do: "token.revoke", id: 1 }, bearer(generated));
		expect(kept.body).toMatchObject({ ok: false, error: { code: "invalid" } });
		expect(kept.text).toContain("is the last one robin can sign in with");
		// While the second works, the first may go.
		clock.set(T0 + HOUR);
		expect((await admin(first, { do: "token.revoke", id: 1 }, bearer(second.token))).body).toMatchObject({
			ok: true,
			result: { revoked: true },
		});
		await first.stop();
		// A start that finds the owner with a token that works makes no other; one that finds none does.
		const before = await boot({ clock, dataDir, ownerToken: null });
		expect(before.generatedToken).toBeNull();
		await before.stop();
		clock.set(T0 + 12 * HOUR);
		const after = await boot({ clock, dataDir, ownerToken: null });
		expect(after.generatedToken).toMatch(/^cb_[0-9A-Za-z]{32}$/);
		expect(await statusOf(after, bearer(after.generatedToken ?? ""))).toBe(200);
		expect(tokens(after).at(-1)).toMatchObject({ source: "generated", expires_at: null, created_by: null });
	});
});

describe("what a token's row says", () => {
	test("token.list shows when a token ends, who made it and where it was last used from", async () => {
		const clock = clockAt();
		const instance = await boot({ clock });
		const dana = await token(instance, { actor: "dana", can: ["read", "admin"], project: undefined });
		// Made by an admin who is not the owner: the maker is whoever called, not whoever owns the instance.
		const helper = await token(
			instance,
			{ actor: "helper", kind: "agent", expires: "2w", label: "nightly triage" },
			bearer(dana.token),
		);
		clock.advance(HOUR);
		expect((await post(instance, "/api/p/scratch/find", {}, bearer(helper.token))).status).toBe(200);
		expect(await listed(instance)).toEqual([
			{
				id: 1,
				actor: "robin",
				kind: "human",
				label: "owner (from MAINWORTHY_OWNER_TOKEN)",
				createdAt: T0,
				lastUsedAt: T0 + HOUR,
				lastUsedFrom: LOOPBACK,
				expiresAt: null,
				expired: false,
				createdBy: null,
				revoked: false,
			},
			{
				id: 2,
				actor: "dana",
				kind: "human",
				label: "human token",
				createdAt: T0,
				lastUsedAt: T0,
				lastUsedFrom: LOOPBACK,
				expiresAt: null,
				expired: false,
				createdBy: "robin",
				revoked: false,
			},
			{
				id: 3,
				actor: "helper",
				kind: "agent",
				label: "nightly triage",
				createdAt: T0,
				lastUsedAt: T0 + HOUR,
				lastUsedFrom: LOOPBACK,
				expiresAt: T0 + 14 * DAY,
				expired: false,
				createdBy: "dana",
				revoked: false,
			},
		]);
		expect(tokens(instance)).toMatchObject([
			{ source: "env", created_by: null },
			{ source: null, created_by: 2 },
			{ source: null, created_by: 3, expires_at: T0 + 14 * DAY },
		]);
		// A maker who is forgotten is named as history names them.
		await admin(instance, { do: "actor.forget", name: "dana" });
		expect((await listed(instance)).at(-1)).toMatchObject({ actor: "helper", createdBy: "forgotten-3" });
		// A token that was never used was used from nowhere.
		const unused = await token(instance, { actor: "pat" });
		expect((await listed(instance)).find((row) => row.id === unused.id)).toMatchObject({
			lastUsedAt: null,
			lastUsedFrom: null,
		});
	});

	test("a read by a token writes where it came from after a flush, and the read did not wait for the writer", async () => {
		const clock = clockAt();
		const instance = await boot({ clock });
		const gate = holdGate(instance);
		try {
			clock.advance(HOUR);
			// Answered while a writer holds the gate: the read notes its use and its address, and writes nothing.
			expect((await post(instance, "/api/p/scratch/find", {}, bearer(OWNER))).status).toBe(200);
			expect(tokens(instance)).toMatchObject([{ last_used_at: null, last_used_addr: null }]);
		} finally {
			// Released whatever happened, or the instance could not stop and the test's failure would be a timeout.
			await gate.release();
		}
		await flushUses(instance.app);
		expect(tokens(instance)).toMatchObject([{ last_used_at: T0 + HOUR, last_used_addr: LOOPBACK }]);
	});

	test("a session's row says where it was opened from and where it was last seen from", async () => {
		const clock = clockAt();
		const instance = await boot({ clock });
		const { cookie } = await signIn(instance, OWNER);
		expect(sessions(instance)).toMatchObject([{ created_addr: LOOPBACK, last_seen_at: T0 }]);
		// Seen from elsewhere, as far as the row knows, until a use from here is written over it.
		await instance.app.gate.run(() =>
			instance.app.db.raw.query("UPDATE sessions SET last_seen_addr = '192.0.2.7'").run(),
		);
		clock.advance(HOUR);
		expect(await statusOf(instance, { cookie })).toBe(200);
		expect(sessions(instance)).toMatchObject([{ last_seen_at: T0, last_seen_addr: "192.0.2.7" }]);
		await flushUses(instance.app);
		expect(sessions(instance)).toMatchObject([
			{ created_addr: LOOPBACK, last_seen_at: T0 + HOUR, last_seen_addr: LOOPBACK },
		]);
	});

	test("a use with no address writes none and erases none, and an older use does not replace a newer address", async () => {
		const clock = clockAt();
		const instance = await boot({ clock });
		const app = instance.app;
		const rewrite = (at: number, address: string) =>
			app.gate.run(() => app.db.raw.query("UPDATE tokens SET last_used_at = ?, last_used_addr = ?").run(at, address));
		clock.advance(HOUR);
		expect(await statusOf(instance, bearer(OWNER))).toBe(200);
		await flushUses(app);
		expect(tokens(instance)).toMatchObject([{ last_used_at: T0 + HOUR, last_used_addr: LOOPBACK }]);
		// A request that never was on a connection has no address to note. The time is written, the address stays.
		const offline = new Request("http://mainworthy.test/api/session", { headers: bearer(OWNER) });
		clock.advance(HOUR);
		expect((await sessionOf(app, offline, instance.owner))?.via).toBe("token");
		await flushUses(app);
		expect(tokens(instance)).toMatchObject([{ last_used_at: T0 + 2 * HOUR, last_used_addr: LOOPBACK }]);
		// The same between two flushes: the address noted first is still the last one known.
		await rewrite(T0 + 2 * HOUR, "192.0.2.7");
		clock.advance(HOUR);
		expect(await statusOf(instance, bearer(OWNER))).toBe(200);
		clock.advance(HOUR);
		expect((await sessionOf(app, offline, instance.owner))?.via).toBe("token");
		await flushUses(app);
		expect(tokens(instance)).toMatchObject([{ last_used_at: T0 + 4 * HOUR, last_used_addr: LOOPBACK }]);
		// The row was since used from elsewhere and later than what is noted now (the clock was set back).
		await rewrite(T0 + DAY, "198.51.100.9");
		expect(await statusOf(instance, bearer(OWNER))).toBe(200);
		expect((await listed(instance))[0]).toMatchObject({ lastUsedAt: T0 + DAY, lastUsedFrom: "198.51.100.9" });
		await flushUses(app);
		expect(tokens(instance)).toMatchObject([{ last_used_at: T0 + DAY, last_used_addr: "198.51.100.9" }]);
	});
});

describe("forgetting a person", () => {
	test("it erases where their tokens were last used from, written or only noted, and keeps when", async () => {
		const clock = clockAt();
		const instance = await boot({ clock });
		const sam = await token(instance, { actor: "sam" });
		clock.advance(HOUR);
		expect(await statusOf(instance, bearer(sam.token))).toBe(200);
		await flushUses(instance.app);
		// One use is in the row and a later one is only noted when the person is forgotten.
		clock.advance(HOUR);
		expect(await statusOf(instance, bearer(sam.token))).toBe(200);
		const row = () => tokens(instance).find((found) => found.id === sam.id);
		expect(row()).toMatchObject({ last_used_at: T0 + HOUR, last_used_addr: LOOPBACK });
		await admin(instance, { do: "actor.forget", name: "sam" });
		expect(row()).toMatchObject({ last_used_at: T0 + HOUR, last_used_addr: null, revoked_at: T0 + 2 * HOUR });
		expect((await listed(instance)).find((found) => found.id === sam.id)).toMatchObject({
			lastUsedAt: T0 + 2 * HOUR,
			lastUsedFrom: null,
		});
		// The flush that follows writes when the token was last used and no address.
		await flushUses(instance.app);
		expect(row()).toMatchObject({ last_used_at: T0 + 2 * HOUR, last_used_addr: null });
		// Nobody else's address went with it.
		expect(tokens(instance)[0]).toMatchObject({ last_used_addr: LOOPBACK });
	});
});

describe("the owner's token from the environment", () => {
	const SECOND = "another-owner-secret-0123456789abcdef";
	/** How every refusal of a start ends: what it left alone, and what had already happened to the database. */
	const UNCHANGED =
		"; no actor and no token was changed (the database may have been brought to this build's schema first, with a copy of it as it was beside it)";

	test("a changed value retires the token it replaces and says so, and the old value is refused", async () => {
		const clock = clockAt();
		const dataDir = scratch();
		const first = await boot({ clock, dataDir });
		expect(said(first)).toEqual([]);
		// Two more tokens of the owner, which no variable holds: one the owner made, one a start generated.
		const own = await token(first, { ...FOR_OWNER, label: "robin's laptop" });
		await first.app.gate.run(() =>
			first.app.db.raw
				.query(
					"INSERT INTO tokens (actor, hash, label, created_at, source) VALUES (2, 'x', 'owner (generated)', ?, 'generated')",
				)
				.run(T0),
		);
		const { cookie } = await signIn(first, OWNER);
		expect(await statusOf(first, { cookie })).toBe(200);
		await first.stop();

		clock.advance(DAY);
		const second = await boot({ clock, dataDir, ownerToken: SECOND });
		expect(said(second)).toEqual([
			"MAINWORTHY_OWNER_TOKEN has a new value: the token it held before (token 1 of robin) was revoked, and every session opened with it has ended. Sign in with the new value.",
		]);
		expect(said(second).join("")).not.toContain(OWNER);
		expect(said(second).join("")).not.toContain(SECOND);
		expect([
			await statusOf(second, bearer(OWNER)),
			(await signIn(second, OWNER)).status,
			await statusOf(second, { cookie }),
			await statusOf(second, bearer(SECOND)),
			await statusOf(second, bearer(own.token)),
		]).toEqual([401, 401, 401, 200, 200]);
		expect(tokens(second)).toMatchObject([
			{ id: 1, source: "env", revoked_at: T0 + DAY },
			{ id: 2, source: null, revoked_at: null },
			{ id: 3, source: "generated", revoked_at: null },
			{ id: 4, source: "env", revoked_at: null, created_by: null, expires_at: null },
		]);
		expect(sessions(second)).toMatchObject([{ ended_at: T0 + DAY }]);
		await second.stop();

		// The same value again changes nothing and says nothing.
		const third = await boot({ clock, dataDir, ownerToken: SECOND });
		expect(said(third)).toEqual([]);
		expect(tokens(third).map((row) => row.revoked_at)).toEqual([T0 + DAY, null, null, null]);
		clock.advance(31 * DAY);
		await third.minute();
		expect(tokens(third)[0]?.last_used_addr).toBeNull();
		await third.stop();

		// The first value again is a token that was revoked: it is not revived, and it retires nothing.
		const fourth = await boot({ clock, dataDir, ownerToken: OWNER });
		expect(said(fourth)).toEqual([
			expect.stringMatching(/^MAINWORTHY_OWNER_TOKEN was revoked: .* Set MAINWORTHY_OWNER_TOKEN to a new value/),
		]);
		expect([await statusOf(fourth, bearer(OWNER)), await statusOf(fourth, bearer(SECOND))]).toEqual([401, 200]);
	});

	test("one of 19 characters stops the start, one of 20 warns, one of 32 does neither", async () => {
		const dataDir = scratch();
		const nineteen = "a1b2c3d4e5f6g7h8i9j";
		expect(nineteen).toHaveLength(19);
		let refusal = "";
		try {
			await boot({ dataDir, ownerToken: nineteen });
		} catch (error) {
			refusal = error instanceof Error ? error.message : String(error);
		}
		expect(refusal).toBe(
			`MAINWORTHY_OWNER_TOKEN is shorter than 20 characters, and it opens everything on this instance. Make one with \`openssl rand -hex 32\`, set MAINWORTHY_OWNER_TOKEN to it and start again${UNCHANGED}`,
		);
		// No actor and no token was made, and the database was left closed: the next start is the instance's first.
		const twenty = `${nineteen}k`;
		const warned = await boot({ dataDir, ownerToken: twenty });
		expect(said(warned)).toEqual([
			"MAINWORTHY_OWNER_TOKEN is shorter than 32 characters. It signs robin in as it is; a longer one is harder to guess. Make one with `openssl rand -hex 32`.",
		]);
		expect(tokens(warned)).toMatchObject([{ id: 1, source: "env" }]);
		expect(await statusOf(warned, bearer(twenty))).toBe(200);
		await warned.stop();
		// It warns on every start, not only on the one that stored it.
		const again = await boot({ dataDir, ownerToken: twenty });
		expect(said(again)).toHaveLength(1);
		await again.stop();

		const quiet = await boot({ ownerToken: "a".repeat(32) });
		expect(said(quiet)).toEqual([]);
		await quiet.stop();
		// A variable a compose file passes on empty is one that was not set: the start generates the token.
		const unset = await boot({ ownerToken: "" });
		expect([said(unset), unset.generatedToken]).toEqual([[], expect.stringMatching(/^cb_/)]);
		// The same rule where the machine's owner needs no token: the value is a token there too.
		expect(async () => await boot({ mode: "local", ownerToken: nineteen })).toThrow("shorter than 20 characters");
	});

	test("one longer than 512 characters stops the start, and one of 512 starts and signs a browser in", async () => {
		// What a sign-in reads is what a start accepts: a longer value would work as a bearer and never in a browser.
		const longest = "k1".repeat(256);
		expect(longest).toHaveLength(512);
		let refusal = "";
		try {
			await boot({ ownerToken: `${longest}k` });
		} catch (error) {
			refusal = error instanceof Error ? error.message : String(error);
		}
		expect(refusal).toBe(
			`MAINWORTHY_OWNER_TOKEN is longer than 512 characters, and a sign-in reads no token longer than that. Make one with \`openssl rand -hex 32\`, set MAINWORTHY_OWNER_TOKEN to it and start again${UNCHANGED}`,
		);
		const instance = await boot({ ownerToken: longest });
		expect([
			said(instance),
			await statusOf(instance, bearer(longest)),
			(await signIn(instance, longest)).status,
			(await signIn(instance, `${longest}k`)).status,
		]).toEqual([[], 200, 200, 401]);
		expect(async () => await boot({ mode: "local", ownerToken: `${longest}k` })).toThrow("longer than 512 characters");
	});

	test("a token longer than 512 characters, kept from an earlier build, works nowhere: not as a bearer and not at sign-in", async () => {
		// An earlier build took an owner token of any length. Its row survives the upgrade, and nothing can tell its
		// length from its hash, so no start can warn about it. What must not happen is that it works one way and
		// not the other: a sign-in reads at most 512 characters, so a bearer does too.
		const instance = await boot();
		const kept = "k1".repeat(300);
		await instance.app.gate.run(() =>
			instance.app.db.raw
				.query(
					"INSERT INTO tokens (actor, hash, label, created_at, source) VALUES (2, ?, 'owner (from MAINWORTHY_OWNER_TOKEN)', ?, 'env')",
				)
				.run(hashToken(kept), 1),
		);
		expect([await statusOf(instance, bearer(kept)), (await signIn(instance, kept)).status]).toEqual([401, 401]);
		// The row is a working token in every other respect: one of 512 characters with the same shape works.
		const fits = "k2".repeat(256);
		await instance.app.gate.run(() =>
			instance.app.db.raw
				.query("INSERT INTO tokens (actor, hash, label, created_at) VALUES (2, ?, 'by hand', ?)")
				.run(hashToken(fits), 1),
		);
		expect([await statusOf(instance, bearer(fits)), (await signIn(instance, fits)).status]).toEqual([200, 200]);
	});

	test("a new value retires the token the variable held before, whoever the owner was then", async () => {
		const THIRD = "a-third-owner-secret-0123456789abcdef";
		const clock = clockAt();
		const dataDir = scratch();
		const first = await boot({ clock, dataDir });
		await first.stop();
		const second = await boot({ clock, dataDir, ownerToken: SECOND });
		expect(said(second)).toEqual([expect.stringContaining("(token 1 of robin) was revoked")]);
		const { cookie } = await signIn(second, SECOND);
		// Another person's token that the upgrade marked as from the environment, because of its label.
		const sam = await token(second, { actor: "sam" }, bearer(SECOND));
		await second.app.gate.run(() =>
			second.app.db.raw
				.query(
					"INSERT INTO tokens (actor, hash, label, created_at, source) VALUES (3, 'y', 'owner (from a hand)', ?, 'env')",
				)
				.run(T0),
		);
		await second.stop();

		// The owner's name and the configured value change in one start.
		clock.advance(DAY);
		const third = await boot({ clock, dataDir, owner: "alex", ownerToken: THIRD });
		expect(said(third)).toEqual([
			"MAINWORTHY_OWNER_TOKEN has a new value: the tokens it held before (token 2 of robin, token 4 of sam) were revoked, and every session opened with them has ended. Sign in with the new value.",
		]);
		const listing = await admin(third, { do: "token.list" }, bearer(SECOND));
		expect([
			await statusOf(third, bearer(SECOND)),
			listing.status,
			(await signIn(third, SECOND)).status,
			await statusOf(third, { cookie }),
			await statusOf(third, bearer(sam.token)),
		]).toEqual([401, 401, 401, 401, 200]);
		expect(await statusOf(third, bearer(THIRD))).toBe(200);
		expect(tokens(third)).toMatchObject([
			{ id: 1, source: "env", revoked_at: T0 },
			{ id: 2, source: "env", revoked_at: T0 + DAY },
			{ id: 3, source: null, revoked_at: null },
			{ id: 4, source: "env", revoked_at: T0 + DAY },
			{ id: 5, source: "env", revoked_at: null },
		]);
		expect((await listed(third, bearer(THIRD))).at(-1)).toMatchObject({ id: 5, actor: "alex" });
	});

	test("a configured value that is a token past its end is said at the start, with when it ended, and is not revived", async () => {
		const clock = clockAt();
		const dataDir = scratch();
		const first = await boot({ clock, dataDir });
		const brief = await token(first, { ...FOR_OWNER, expires: "1h" });
		// The owner's other token goes while this one works, so its end leaves the owner with none.
		expect((await admin(first, { do: "token.revoke", id: 1 }, bearer(brief.token))).status).toBe(200);
		await first.stop();

		clock.set(T0 + HOUR);
		const second = await boot({ clock, dataDir, ownerToken: brief.token });
		expect(said(second)).toEqual([
			`MAINWORTHY_OWNER_TOKEN reached its end at ${new Date(T0 + HOUR).toISOString()}: it does not sign robin in, and it was left as it is. Set MAINWORTHY_OWNER_TOKEN to a new value and start again.`,
		]);
		expect(said(second).join("")).not.toContain(brief.token);
		expect([await statusOf(second, bearer(brief.token)), second.generatedToken]).toEqual([401, null]);
		expect(tokens(second)).toMatchObject([
			{ id: 1, revoked_at: T0 },
			{ id: 2, revoked_at: null, expires_at: T0 + HOUR, source: null },
		]);
		await second.stop();
		// A new value is the way back in, as the line says.
		const third = await boot({ clock, dataDir, ownerToken: SECOND });
		expect([said(third), await statusOf(third, bearer(SECOND))]).toEqual([[], 200]);
	});

	test("a start that is refused says what it left alone: no actor and no token, though the schema was brought up to date", async () => {
		const dataDir = scratch();
		const path = databasePath(dataDir);
		writeFileSync(path, Bun.gunzipSync(readFileSync(FIXTURE.file)));
		expect(async () => await boot({ dataDir, ownerToken: "a1b2c3d4e5f6g7h8i9j" })).toThrow(UNCHANGED);
		expect(async () => await boot({ dataDir, ownerToken: "k".repeat(513) })).toThrow(UNCHANGED);
		expect(async () => await boot({ dataDir, owner: "policy", ownerToken: FIXTURE.env })).toThrow(
			`MAINWORTHY_OWNER names policy, which is the policy's own actor on this instance and not a person. Set MAINWORTHY_OWNER to the owner's name and start again${UNCHANGED}`,
		);
		expect(async () => await boot({ dataDir, owner: "forgotten-9", ownerToken: FIXTURE.env })).toThrow(
			`MAINWORTHY_OWNER names forgotten-9, and a name that starts with forgotten- is what a forgotten actor is called. Set MAINWORTHY_OWNER to the owner's name and start again${UNCHANGED}`,
		);
		// A person who was forgotten (a disabled row, as an archive can hold one) is not made the owner, and the
		// start gives the row no grant.
		const grantsOfSam =
			"SELECT count(*) AS n FROM grants WHERE project = 0 AND actor = (SELECT id FROM actors WHERE name = 'sam')";
		const forgetting = new Database(path);
		let grantsBefore: number | undefined;
		try {
			forgetting.query("UPDATE actors SET disabled_at = ? WHERE name = 'sam'").run(T0);
			grantsBefore = forgetting.query<{ n: number }, []>(grantsOfSam).get()?.n;
		} finally {
			forgetting.close();
		}
		expect(async () => await boot({ dataDir, owner: "sam", ownerToken: FIXTURE.env })).toThrow(
			`MAINWORTHY_OWNER names sam, who was forgotten. Set MAINWORTHY_OWNER to the owner's name and start again${UNCHANGED}`,
		);
		// What the sentence says, read from the file: the schema is this build's, the copy from before is beside
		// it, and the actors and the tokens are the ones the earlier build left.
		const raw = new Database(path, { readonly: true });
		try {
			const column = <T>(text: string): T[] =>
				raw
					.query<{ value: T }, []>(text)
					.all()
					.map((row) => row.value);
			expect(column<string>("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual([String(SCHEMA_VERSION)]);
			expect(column<string>("SELECT name AS value FROM actors ORDER BY id")).toEqual(["policy", "robin", "sam"]);
			expect(column<number>("SELECT count(*) AS value FROM tokens WHERE revoked_at IS NULL")).toEqual([3]);
			expect(raw.query<{ n: number }, []>(grantsOfSam).get()?.n).toBe(grantsBefore);
		} finally {
			raw.close();
		}
		expect(existsSync(`${path}.v2.bak`)).toBe(true);
	});

	test("a token that ends within 14 days is named at the start, and one further out is not", async () => {
		const clock = clockAt();
		const dataDir = scratch();
		const first = await boot({ clock, dataDir });
		const soon = await token(first, {
			actor: "pipeline",
			kind: "ci",
			can: ["record"],
			expires: "2w",
			label: "CI\non main",
		});
		const later = await token(first, { actor: "helper", kind: "agent", expires: "30d" });
		const gone = await token(first, { actor: "sam", expires: "12h" });
		const revoked = await token(first, { actor: "pat", expires: "5d" });
		await admin(first, { do: "token.revoke", id: revoked.id });
		await first.stop();

		clock.advance(DAY);
		const second = await boot({ clock, dataDir });
		expect(said(second)).toEqual([
			`token ${soon.id} of pipeline ("CI\\non main") expires in 13 days, and what uses it is refused from then on. Make its replacement with \`mainworthy token new\`, and revoke this one once the replacement is in use.`,
		]);
		for (const made of [soon, later, gone, revoked]) expect(said(second).join("")).not.toContain(made.token);
		await second.stop();

		// Sixteen days on, the first has ended and is not named again; the second now ends within 14 days.
		clock.advance(16 * DAY);
		const third = await boot({ clock, dataDir });
		expect(said(third)).toEqual([
			expect.stringMatching(new RegExp(`^token ${later.id} of helper \\("agent token"\\) expires in 13 days,`)),
		]);
	});
});

describe("an upgrade", () => {
	test("an instance made by the build before token limits starts on this one: backed up, its tokens and its sessions still working, its start-up tokens marked", async () => {
		const dataDir = scratch();
		const path = databasePath(dataDir);
		writeFileSync(path, Bun.gunzipSync(readFileSync(FIXTURE.file)));
		writeFileSync(`${path}.v1.bak`, "an older upgrade copy");
		const clock = clockAt(FIXTURE.stoppedAt + HOUR);
		const instance = await boot({ dataDir, clock, ownerToken: FIXTURE.env });
		expect(said(instance)).toEqual([]);
		expect(existsSync(`${path}.v1.bak`)).toBe(false);
		expect(existsSync(`${path}.v2.bak`)).toBe(true);
		const versionOf = (file: string): string | undefined => {
			const raw = new Database(file, { readonly: true });
			try {
				return raw.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value;
			} finally {
				raw.close();
			}
		};
		// The copy beside it is the database as the previous build left it; the one in use is at this build's schema.
		expect([versionOf(`${path}.v2.bak`), versionOf(path)]).toEqual(["2", String(SCHEMA_VERSION)]);
		expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(3);
		// The three tokens are tokens as before, and the two sessions are sessions as before.
		expect([
			await statusOf(instance, bearer(FIXTURE.env)),
			await statusOf(instance, bearer(FIXTURE.generated)),
			await statusOf(instance, bearer(FIXTURE.sam)),
			await statusOf(instance, { cookie: FIXTURE.samCookie }),
			await statusOf(instance, { cookie: FIXTURE.ownerCookie }),
		]).toEqual([200, 200, 200, 200, 200]);
		const found = await post<{ count: number; items: { title: string }[] }>(
			instance,
			"/api/p/scratch/find",
			{},
			{ cookie: FIXTURE.samCookie },
		);
		expect(found.body.ok && found.body.result).toMatchObject({ count: 1, items: [{ title: "Coupon applies" }] });
		// The two tokens a start made say which start made them; the one a person made says nothing.
		expect(tokens(instance)).toMatchObject([
			{ id: 1, label: "owner (generated)", source: "generated", created_by: null, expires_at: null },
			{ id: 2, label: "owner (from MAINWORTHY_OWNER_TOKEN)", source: "env", created_by: null, expires_at: null },
			{ id: 3, label: "sam's laptop", source: null, created_by: null, expires_at: null, last_used_addr: null },
		]);
		expect(await listed(instance, bearer(FIXTURE.env))).toMatchObject([
			{ id: 1, expiresAt: null, createdBy: null },
			{ id: 2, expiresAt: null, createdBy: null },
			{ id: 3, expiresAt: null, createdBy: null },
		]);
		// What the new columns are for works on the old rows: a use is written with its address.
		await flushUses(instance.app);
		expect(tokens(instance)[2]).toMatchObject({ last_used_at: FIXTURE.stoppedAt + HOUR, last_used_addr: LOOPBACK });
		expect(sessions(instance)).toMatchObject([
			{ id: 1, created_addr: null, last_seen_at: FIXTURE.stoppedAt + HOUR, last_seen_addr: LOOPBACK },
			{ id: 2, created_addr: null, last_seen_at: FIXTURE.stoppedAt + HOUR, last_seen_addr: LOOPBACK },
		]);
		await instance.stop();

		// The mark is what a changed variable goes by: the old build's token from the environment is retired, and
		// the one that build generated is not.
		const changed = await boot({ dataDir, clock, ownerToken: OWNER });
		expect(said(changed)).toEqual([expect.stringContaining("(token 2 of robin) was revoked")]);
		expect([
			await statusOf(changed, bearer(FIXTURE.env)),
			await statusOf(changed, { cookie: FIXTURE.ownerCookie }),
			await statusOf(changed, bearer(FIXTURE.generated)),
			await statusOf(changed, { cookie: FIXTURE.samCookie }),
			await statusOf(changed, bearer(OWNER)),
		]).toEqual([401, 401, 200, 200, 200]);
	});

	test("a token an earlier build labelled after another variable is marked as from the environment too", async () => {
		const dataDir = scratch();
		const path = databasePath(dataDir);
		writeFileSync(path, Bun.gunzipSync(readFileSync(FIXTURE.file)));
		// The label names the variable the value came from, and that variable had another name once. An instance
		// that has run since then holds its owner's token under the earlier label.
		const raw = new Database(path);
		raw.query("UPDATE tokens SET label = 'owner (from EARLIER_OWNER_TOKEN)' WHERE id = 2").run();
		raw.close();
		const at = FIXTURE.stoppedAt + HOUR;
		const kept = await boot({ dataDir, clock: clockAt(at), ownerToken: FIXTURE.env });
		expect(tokens(kept)).toMatchObject([
			{ id: 1, source: "generated" },
			{ id: 2, label: "owner (from EARLIER_OWNER_TOKEN)", source: "env", revoked_at: null },
			{ id: 3, source: null },
		]);
		expect([said(kept), await statusOf(kept, bearer(FIXTURE.env))]).toEqual([[], 200]);
		await kept.stop();
		// So a new value in the variable retires it, as it retires one this build labelled.
		const changed = await boot({ dataDir, clock: clockAt(at), ownerToken: OWNER });
		expect(said(changed)).toEqual([expect.stringContaining("(token 2 of robin) was revoked")]);
		expect(tokens(changed)).toMatchObject([{ id: 1 }, { id: 2, revoked_at: at }, { id: 3 }, { id: 4, source: "env" }]);
		expect(await statusOf(changed, bearer(FIXTURE.env))).toBe(401);
	});
});

describe("the command line", () => {
	const Row = z.object({
		id: z.number(),
		actor: z.string(),
		expiresAt: z.number().nullable(),
		expired: z.boolean(),
		createdBy: z.string().nullable(),
		lastUsedFrom: z.string().nullable(),
	});

	test("token new --expires gives a token an end, and token list shows it with who made the token", async () => {
		await withInstance(async ({ cli, run, instance }) => {
			const before = Date.now();
			const made = await run(["token", "new", "--ci", "pipeline", "--expires", "90d"]);
			expect([made.code, made.stderr]).toEqual([0, ""]);
			const [heading, secret, ...rest] = made.stdout.trim().split("\n");
			expect(heading).toBe('token for ci "pipeline" (record), expires in 90 days');
			expect(secret).toMatch(/^cb_[0-9A-Za-z]{32}$/);
			expect(rest).toEqual(["Shown once. It will not be shown again."]);
			const forever = await run(["token", "new", "--agent", "helper"]);
			expect(forever.stdout.split("\n")[0]).toBe('token for agent "helper" (read, record, produce)');

			const rows = outputWith(z.array(Row), await run(["token", "list", "--json"]));
			expect(rows).toMatchObject([
				{ actor: "pipeline", expired: false, createdBy: "robin", lastUsedFrom: null },
				{ actor: "helper", expiresAt: null, expired: false, createdBy: "robin", lastUsedFrom: null },
			]);
			const ends = rows[0]?.expiresAt ?? 0;
			expect(ends).toBeGreaterThanOrEqual(before + 90 * DAY);
			expect(ends).toBeLessThanOrEqual(Date.now() + 90 * DAY);

			// Used once, by the executable with the token in its environment, so the list knows where from.
			const used = await cli(["report", RED_XML, "--commit", COMMIT], {
				env: { MAINWORTHY_TOKEN: secret ?? "" },
			});
			expect(used.code).toBe(0);
			const list = await run(["token", "list"]);
			expect(list.stdout.trim().split("\n")).toEqual([
				"1  ci pipeline  ci token  active, expires in 90 days  made by robin  last used from 127.0.0.1",
				"2  agent helper  agent token  active  made by robin",
			]);
			expect(list.stdout).not.toContain(secret ?? "no secret");

			// Past its end, however that came about, the list says so in place of how long is left.
			await instance.app.gate.run(() =>
				instance.app.db.raw.query("UPDATE tokens SET expires_at = ? WHERE id = 1").run(Date.now() - 1),
			);
			const after = await run(["token", "list"]);
			expect(after.stdout.split("\n")[0]).toBe(
				"1  ci pipeline  ci token  expired  made by robin  last used from 127.0.0.1",
			);
			const refused = await run(["report", RED_XML, "--commit", COMMIT], {
				env: { MAINWORTHY_TOKEN: secret ?? "" },
			});
			expect([refused.code, refused.stderr]).toEqual([4, expect.stringContaining("unauthenticated:")]);
		});
	});

	test("a token is replaced with no gap: the second works beside the first, and the first is then revoked", async () => {
		// The steps of "Replacing a token" in docs/deploy.md.
		await withInstance(async ({ run }) => {
			const secretOf = (made: { stdout: string }): string => made.stdout.split("\n")[1] ?? "";
			const reports = async (secret: string): Promise<number> =>
				(await run(["report", RED_XML, "--commit", COMMIT], { env: { MAINWORTHY_TOKEN: secret } })).code;
			const first = secretOf(await run(["token", "new", "--ci", "pipeline"]));
			// The actor exists, so the second token carries the grant the actor already holds.
			const made = await run(["token", "new", "--ci", "pipeline", "--expires", "90d"]);
			expect(made.stdout.split("\n")[0]).toBe('token for ci "pipeline" (record), expires in 90 days');
			const second = secretOf(made);
			expect([await reports(first), await reports(second)]).toEqual([0, 0]);
			expect((await run(["token", "list"])).stdout.trim().split("\n")).toEqual([
				"1  ci pipeline  ci token  active  made by robin  last used from 127.0.0.1",
				"2  ci pipeline  ci token  active, expires in 90 days  made by robin  last used from 127.0.0.1",
			]);
			expect((await run(["token", "revoke", "1"])).stdout).toBe("token 1 revoked\n");
			expect([await reports(first), await reports(second)]).toEqual([4, 0]);
		});
	});

	test("token new refuses an --expires that is not a duration, and says what one is", async () => {
		await withInstance(async ({ run }) => {
			for (const expires of ["90m", "1y", "0d", "90"]) {
				const refused = await run(["token", "new", "--agent", "helper", "--expires", expires]);
				expect([refused.code, refused.stdout]).toEqual([4, ""]);
				expect(refused.stderr).toContain("12h, 14d or 2w");
			}
			expect((await run(["token", "list"])).stdout).toBe("No tokens.\n");
			expect((await run(["token", "--help"])).stdout).toContain("--expires");
		});
	});
});
