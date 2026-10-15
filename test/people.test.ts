// People sign in as themselves, on a real listener: an invitation, a password, what a signed-in person may see
// and end, and what is kept of all that. Time is the test's own clock. Passkeys are in `test/passkeys.test.ts`.

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLI_ENTRY } from "../src/cli/test-support.ts";
import type { SessionInfo } from "../src/core/api.ts";
import type { InboxReply, ProposeReply } from "../src/core/ops.ts";
import { PersonalTokenCreated, PersonalTokenRow } from "../src/core/people.ts";
import { bootstrap } from "../src/server/identity/identity.ts";
import type { AssertionOptions, RegistrationOptions } from "../src/server/identity/webauthn.ts";
import { databasePath, defaultConfig } from "../src/server/kernel/app.ts";
import { SCHEMA_VERSION } from "../src/server/kernel/migrate.ts";
import {
	authenticator,
	bearer,
	cleanUp,
	clockAt,
	DAY,
	from,
	HOUR,
	holdGate,
	invite,
	joined,
	must,
	OWNER,
	PUBLIC,
	type Sent,
	said,
	scratch,
	sha256,
	signIn,
	T0,
	TOKEN,
	type World,
	waitingAtGate,
	world,
} from "./people-support.ts";

afterEach(cleanUp);

/** What every refused sign-in is answered, whatever was wrong with it. */
const REFUSED = '{"ok":false,"error":{"code":"unauthenticated","message":"that did not sign you in"}}';
const FIRST = "correct horse battery staple";
const SECOND = "a second quite long passphrase";

test("TOTP enrolment begins only in a signed-in context and waits for a code", async () => {
	const w = world();
	const cookie = await joined(w, "totp-robin", FIRST);
	expect((await w.op("credential", { do: "totp.begin" })).status).toBe(403);
	const begun = await w.op("credential", { do: "totp.begin" }, { cookie });
	expect(begun.status).toBe(200);
	expect(begun.body).toMatchObject({
		ok: true,
		result: { secret: expect.any(String), qr: expect.objectContaining({ path: expect.any(String) }) },
	});
	expect(w.rows("SELECT id FROM credentials WHERE kind = 'totp'")).toEqual([]);
});

type Enrolment = {
	challenge: string;
	expiresAt: number;
	secret: string;
	uri: string;
	qr: { size: number; path: string };
};
type ConfirmedTotp = { id: number; recoveryCodes: string[]; sessionsEnded: number };
type SecondStep = { signedIn: false; secondFactor: { challenge: string; expiresAt: number } };
function appCode(secret: string, now: number): string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
	const binary = [...secret].map((char) => alphabet.indexOf(char).toString(2).padStart(5, "0")).join("");
	const key = Buffer.from(binary.match(/.{8}/g)?.map((byte) => Number.parseInt(byte, 2)) ?? []);
	const counter = Buffer.alloc(8);
	counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
	const digest = createHmac("sha1", key).update(counter).digest();
	return String((digest.readUInt32BE((digest.at(-1) ?? 0) & 15) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}
async function enrol(w: World, cookie: string): Promise<Enrolment & ConfirmedTotp> {
	const begun = await w.ok<Enrolment>("credential", { do: "totp.begin" }, { cookie });
	const confirmed = await w.ok<ConfirmedTotp>(
		"credential",
		{ do: "totp.confirm", challenge: begun.challenge, code: appCode(begun.secret, w.clock.now()) },
		{ cookie },
	);
	w.clock.advance(30_000);
	return { ...begun, ...confirmed };
}
async function secondStep(w: World, name: string, headers: Sent = {}) {
	const password = await w.post<SecondStep>("/api/login", { name, password: FIRST }, headers);
	expect(password.status).toBe(200);
	const result = must(password);
	expect(result.signedIn).toBe(false);
	expect(password.setCookies.some((cookie) => /^mainworthy_sid=/.test(cookie))).toBe(false);
	return { challenge: result.secondFactor.challenge, cookie: password.cookie };
}

test("TOTP password sign-in has a bound second step, single-use codes and single-use recovery", async () => {
	const w = world();
	const cookie = await joined(w, "totp-login", FIRST);
	const older = await signIn(w, "totp-login", FIRST);
	const enrolled = await enrol(w, cookie);
	expect(enrolled.qr.path).toStartWith("M");
	expect(enrolled.uri).toStartWith("otpauth://totp/");
	expect(enrolled.recoveryCodes).toHaveLength(10);
	expect(await w.status({ cookie: older.cookie })).toBe(401);
	expect(await w.status({ cookie })).toBe(200);
	const listed = await w.ok<{ kind: string }[]>("credential", { do: "list" }, { cookie });
	expect(listed.map((row) => row.kind)).toEqual(["password", "totp"]);
	const stored = w.rows<{ data: string }>("SELECT data FROM credentials WHERE kind = 'totp'")[0]?.data ?? "";
	for (const recovery of enrolled.recoveryCodes) expect(stored.includes(recovery)).toBe(false);
	const step = await secondStep(w, "totp-login");
	const proof = { challenge: step.challenge, code: appCode(enrolled.secret, w.clock.now()) };
	expect((await w.post("/api/login", proof)).status).toBe(401);
	const otherBrowser = await secondStep(w, "totp-login");
	expect((await w.post("/api/login", proof, { cookie: otherBrowser.cookie })).status).toBe(401);
	const [one, two] = await Promise.all([
		w.post("/api/login", proof, { cookie: step.cookie }),
		w.post("/api/login", proof, { cookie: step.cookie }),
	]);
	expect([one.status, two.status].sort()).toEqual([200, 401]);
	const usedStep = await secondStep(w, "totp-login");
	expect(
		(await w.post("/api/login", { ...proof, challenge: usedStep.challenge }, { cookie: usedStep.cookie })).status,
	).toBe(401);
	const recovery = enrolled.recoveryCodes[0];
	expect(
		(await w.post("/api/login", { challenge: usedStep.challenge, code: recovery }, { cookie: usedStep.cookie })).status,
	).toBe(200);
	const reused = await secondStep(w, "totp-login");
	expect(
		(await w.post("/api/login", { challenge: reused.challenge, code: recovery }, { cookie: reused.cookie })).status,
	).toBe(401);
	// Provisioning and confirmation are the two permitted replies; ordinary reads and logins never return them.
	const safeReplies = w.replies.slice(w.replies.findIndex((reply) => reply.includes('"recoveryCodes"')) + 1).join("\n");
	expect(safeReplies.includes(enrolled.secret)).toBe(false);
	for (const code of enrolled.recoveryCodes) expect(safeReplies.includes(code)).toBe(false);
});

test("TOTP failed codes remain limited across fresh correct passwords and across concurrent attempts", async () => {
	const w = world({ proxied: true });
	const cookie = await joined(w, "totp-limit", FIRST);
	const enrolled = await enrol(w, cookie);
	const visitor = from("203.0.113.27");
	for (let i = 0; i < 5; i++) {
		const step = await secondStep(w, "totp-limit", visitor);
		expect(
			(await w.post("/api/login", { challenge: step.challenge, code: "bad-code" }, { ...visitor, cookie: step.cookie }))
				.status,
		).toBe(401);
	}
	expect((await signIn(w, "totp-limit", FIRST, visitor)).status).toBe(429);
	const step = await secondStep(w, "totp-limit");
	const blocked = await w.post(
		"/api/login",
		{ challenge: step.challenge, code: appCode(enrolled.secret, w.clock.now()) },
		{ cookie: step.cookie },
	);
	expect(blocked.status).toBe(429);
	expect(Number(blocked.retryAfter)).toBeGreaterThan(0);
	w.clock.advance(60_000);
	expect(
		(
			await w.post(
				"/api/login",
				{ challenge: step.challenge, code: appCode(enrolled.secret, w.clock.now()) },
				{ cookie: step.cookie },
			)
		).status,
	).toBe(200);
	w.clock.advance(30_000);
	const concurrent = await secondStep(w, "totp-limit");
	const answers = await Promise.all(
		Array.from({ length: 8 }, () =>
			w.post("/api/login", { challenge: concurrent.challenge, code: "bad-code" }, { cookie: concurrent.cookie }),
		),
	);
	expect(answers.map((reply) => reply.status).sort()).toEqual([401, 401, 401, 401, 401, 429, 429, 429]);
});

test("TOTP pending proofs expire and cannot finish after password replacement or credential removal", async () => {
	const w = world();
	const cookie = await joined(w, "totp-stale", FIRST);
	const setup = await w.ok<Enrolment>("credential", { do: "totp.begin" }, { cookie });
	const other = await signIn(w, "totp-stale", FIRST);
	expect(
		(
			await w.op(
				"credential",
				{ do: "totp.confirm", challenge: setup.challenge, code: appCode(setup.secret, w.clock.now()) },
				{ cookie: other.cookie },
			)
		).status,
	).toBe(400);
	w.clock.advance(5 * 60_000);
	expect(
		(
			await w.op(
				"credential",
				{ do: "totp.confirm", challenge: setup.challenge, code: appCode(setup.secret, w.clock.now()) },
				{ cookie },
			)
		).status,
	).toBe(400);
	const enrolled = await enrol(w, cookie);
	const step = await secondStep(w, "totp-stale");
	w.clock.advance(5 * 60_000);
	expect(
		(
			await w.post(
				"/api/login",
				{ challenge: step.challenge, code: appCode(enrolled.secret, w.clock.now()) },
				{ cookie: step.cookie },
			)
		).status,
	).toBe(401);
	const beforeChange = await secondStep(w, "totp-stale");
	expect((await w.post("/api/account/password", { current: FIRST, next: SECOND }, { cookie })).status).toBe(200);
	expect(
		(
			await w.post(
				"/api/login",
				{ challenge: beforeChange.challenge, code: appCode(enrolled.secret, w.clock.now()) },
				{ cookie: beforeChange.cookie },
			)
		).status,
	).toBe(401);
	const beforeRemoval = await w.post<SecondStep>("/api/login", { name: "totp-stale", password: SECOND });
	expect((await w.op("credential", { do: "remove", id: enrolled.id }, { cookie })).status).toBe(200);
	expect(
		(
			await w.post(
				"/api/login",
				{ challenge: must(beforeRemoval).secondFactor.challenge, code: appCode(enrolled.secret, w.clock.now()) },
				{ cookie: beforeRemoval.cookie },
			)
		).status,
	).toBe(401);
	expect(await w.status({ cookie })).toBe(401);
});

test("TOTP is never a primary credential, and admin-required instances refuse password-only entry", async () => {
	const w = world();
	const cookie = await joined(w, "totp-admin", FIRST, { can: ["read", "admin"] });
	const enrolled = await enrol(w, cookie);
	const password = w.rows<{ id: number }>("SELECT id FROM credentials WHERE kind = 'password'")[0];
	expect((await w.op("credential", { do: "remove", id: password?.id }, { cookie })).status).toBe(400);
	w.instance.app.config.requireAdminMfa = true;
	expect((await w.op("credential", { do: "remove", id: enrolled.id }, { cookie })).status).toBe(403);
	const inviteOnly = await invite(w, { name: "totp-unenrolled", can: ["admin"] });
	expect((await w.post("/api/login", { invitation: inviteOnly.code, password: FIRST })).status).toBe(403);
	w.instance.app.config.requireAdminMfa = false;
	await w.post("/api/login", { invitation: inviteOnly.code, password: FIRST });
	w.instance.app.config.requireAdminMfa = true;
	expect((await signIn(w, "totp-unenrolled", FIRST)).status).toBe(403);
	const regular = await joined(w, "totp-normal", FIRST);
	expect(await w.status({ cookie: regular })).toBe(200);
});

test("TOTP admin policy ends existing password sessions on startup and promotion while verified passkeys work", async () => {
	const w = world();
	const cookie = await joined(w, "totp-promoted", FIRST);
	w.instance.app.config.requireAdminMfa =
		defaultConfig({ MAINWORTHY_REQUIRE_ADMIN_MFA: "true" }).requireAdminMfa === true;
	expect(() => defaultConfig({ MAINWORTHY_REQUIRE_ADMIN_MFA: "typo" })).toThrow(
		"MAINWORTHY_REQUIRE_ADMIN_MFA must be true or false",
	);
	await w.ok("admin", { do: "grant.set", actor: "totp-promoted", can: ["read", "admin"] });
	expect(await w.status({ cookie })).toBe(401);
	expect((await signIn(w, "totp-promoted", FIRST)).status).toBe(403);
	w.instance.app.config.requireAdminMfa = false;
	const old = await joined(w, "totp-startup", FIRST, { can: ["read", "admin"] });
	w.instance.app.config.requireAdminMfa = true;
	await w.instance.app.gate.run(() => bootstrap(w.instance.app));
	expect(await w.status({ cookie: old })).toBe(401);
	const invitation = await invite(w, { name: "totp-passkey", can: ["read", "admin"] });
	const shown = must(
		await w.post<{ passkey: RegistrationOptions }>("/api/login/challenge", { invitation: invitation.code }),
	);
	const device = authenticator();
	const accepted = await w.post("/api/login", {
		invitation: invitation.code,
		password: FIRST,
		passkey: device.register(shown.passkey),
	});
	expect(accepted.status).toBe(200);
	await enrol(w, accepted.cookie);
	const challenge = await w.post<{ passkey: AssertionOptions }>("/api/login/challenge", {});
	const verified = await w.post<{ signedIn: boolean }>(
		"/api/login",
		{ passkey: device.assert(must(challenge).passkey) },
		{ cookie: challenge.cookie },
	);
	expect(must(verified)).toEqual({ signedIn: true });
	expect(await w.status({ cookie: verified.cookie })).toBe(200);
});

test("TOTP secret replies are not recorded, archives exclude them, and import clears pending proofs", async () => {
	const w = world();
	const archive = await (await fetch(`${w.instance.url}/api/export`, { headers: bearer(TOKEN) })).text();
	const recovery = await invite(w, { name: OWNER });
	const accepted = await w.post("/api/login", { invitation: recovery.code, password: FIRST });
	const cookie = accepted.cookie;
	expect((await w.op("credential", { do: "totp.begin", cmd: "totp-secret-replay" }, { cookie })).status).toBe(400);
	const enrolled = await enrol(w, cookie);
	expect(w.rows("SELECT id FROM commands WHERE op = 'credential'")).toEqual([]);
	const exported = await (await fetch(`${w.instance.url}/api/export`, { headers: { cookie } })).text();
	expect(exported.includes(enrolled.secret)).toBe(false);
	for (const code of enrolled.recoveryCodes) expect(exported.includes(code)).toBe(false);
	const stored = w.rows<{ data: string }>("SELECT data FROM credentials WHERE kind = 'totp'")[0]?.data ?? "";
	const parsed: unknown = JSON.parse(stored);
	for (const code of enrolled.recoveryCodes) expect(JSON.stringify(parsed).includes(sha256(code))).toBe(true);
	const step = await secondStep(w, OWNER);
	const imported = await fetch(`${w.instance.url}/api/import`, { method: "POST", headers: { cookie }, body: archive });
	expect(imported.status).toBe(200);
	expect(
		(
			await w.post(
				"/api/login",
				{ challenge: step.challenge, code: appCode(enrolled.secret, w.clock.now()) },
				{ cookie: step.cookie },
			)
		).status,
	).toBe(401);
	expect(w.rows("SELECT id FROM credentials")).toEqual([]);
});

test("TOTP delays legacy password NFC rehash until the second step succeeds", async () => {
	const w = world();
	const typed = "cafe\u0301 password for TOTP";
	const cookie = await joined(w, "totp-nfc", typed);
	const enrolled = await enrol(w, cookie);
	const oldHash = await Bun.password.hash(typed, { algorithm: "argon2id", memoryCost: 8, timeCost: 1 });
	await w.instance.app.gate.run(() =>
		w.instance.app.db.raw.query("UPDATE credentials SET data = ? WHERE kind = 'password'").run(oldHash),
	);
	const entered = await w.post<SecondStep>("/api/login", { name: "totp-nfc", password: typed });
	expect(must(entered).signedIn).toBe(false);
	expect(w.rows<{ data: string }>("SELECT data FROM credentials WHERE kind = 'password'")[0]?.data === oldHash).toBe(
		true,
	);
	const signed = await w.post(
		"/api/login",
		{ challenge: must(entered).secondFactor.challenge, code: appCode(enrolled.secret, w.clock.now()) },
		{ cookie: entered.cookie },
	);
	expect(signed.status).toBe(200);
	const data = w.rows<{ data: string }>("SELECT data FROM credentials WHERE kind = 'password'")[0]?.data ?? "";
	expect(await Bun.password.verify(typed.normalize("NFC"), data)).toBe(true);
	expect(await Bun.password.verify(typed, data)).toBe(false);
	expect(await w.status({ cookie: signed.cookie })).toBe(200);
});

type SessionRow = {
	id: number;
	actor: number;
	token: number | null;
	credential: number | null;
	ended_at: number | null;
	ended_why: string | null;
};
const sessions = (w: World): SessionRow[] =>
	w.rows("SELECT id, actor, token, credential, ended_at, ended_why FROM sessions ORDER BY id");
type CredentialRow = { id: number; actor: number; kind: string; data: string; revoked_at: number | null };
const credentials = (w: World): CredentialRow[] =>
	w.rows("SELECT id, actor, kind, data, revoked_at FROM credentials ORDER BY id");
const me = async (w: World, headers: Sent): Promise<SessionInfo> => {
	const reply = await w.get<SessionInfo>("/api/session", headers);
	if (!reply.body.ok) throw new Error(`no session: ${reply.text}`);
	return reply.body.result;
};
/** A token for a person or an agent, made by the owner. */
async function tokenFor(w: World, input: Record<string, unknown>): Promise<string> {
	return (await w.ok<{ token: string }>("admin", { do: "token.create", ...input })).token;
}
type Listed = { id: number; openedWith: string; current: boolean; userAgent: string | null };

describe("an invitation", () => {
	test("the minute job deletes invitations 30 days after use, revocation or expiry, keeping open ones", async () => {
		const w = world();
		const used = await invite(w, { name: "robin", expires: "30d" });
		const revoked = await invite(w, { name: "sam", expires: "30d" });
		const expired = await invite(w, { name: "pat", expires: "1d" });
		w.clock.advance(DAY);
		expect((await w.post("/api/login", { invitation: used.code, password: FIRST })).status).toBe(200);
		await w.ok("invitation", { do: "revoke", id: revoked.id });
		w.clock.advance(30 * DAY - 1);
		const open = await invite(w, { name: "lee" });
		await w.instance.minute();
		expect(w.rows<{ id: number }>("SELECT id FROM invitations ORDER BY id")).toEqual([
			{ id: used.id },
			{ id: revoked.id },
			{ id: expired.id },
			{ id: open.id },
		]);
		w.clock.advance(1);
		await w.instance.minute();
		expect(await w.ok("invitation", { do: "list" })).toMatchObject([{ id: open.id, state: "open" }]);
		expect(w.rows("SELECT id FROM invitations ORDER BY id")).toEqual([{ id: open.id }]);
		for (const ended of [used, revoked, expired])
			expect((await w.post("/api/login", { invitation: ended.code, password: FIRST })).status).toBe(401);
		expect((await w.post("/api/login", { invitation: open.code, password: FIRST })).status).toBe(200);
	});

	test("an admin invites a person: the code is in the reply once and nowhere in the database, the log or the stored command", async () => {
		const w = world();
		const logged = [spyOn(console, "warn"), spyOn(console, "error"), spyOn(console, "info"), spyOn(console, "log")];
		try {
			const input = { do: "create", name: "robin", can: ["read", "answer"], project: "scratch", cmd: "invite-robin-1" };
			const made = await w.op<Record<string, unknown>>("invitation", input);
			expect(made.status).toBe(200);
			const result = made.body.ok ? made.body.result : {};
			const code = String(result.code);
			expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
			expect(result).toMatchObject({
				name: "robin",
				purpose: "join",
				link: `${PUBLIC}/invite#${code}`,
				expiresAt: T0 + 3 * DAY,
			});
			// What is stored is the SHA-256 of the code, so a copy of the database invites nobody.
			expect(w.rows<{ hash: string }>("SELECT hash FROM invitations").map((row) => row.hash)).toEqual([sha256(code)]);
			await w.instance.app.gate.run(() => undefined);
			expect(w.disk().includes(code)).toBe(false);
			expect(w.rows("SELECT outcome FROM commands WHERE id = 'invite-robin-1'")).toEqual([
				{ outcome: '"(reply not kept: it held a secret)"' },
			]);
			// The same command again is not answered with the code a second time, and makes no second invitation.
			const again = await w.op("invitation", input);
			expect(`${again.status} ${again.text}`).not.toContain(code);
			expect(again.status).toBe(409);
			const listed = await w.op<Record<string, unknown>[]>("invitation", { do: "list" });
			expect(listed.text).not.toContain(code);
			expect(listed.body.ok && listed.body.result).toMatchObject([
				{ id: 1, name: "robin", purpose: "join", createdBy: OWNER, state: "open", expiresAt: T0 + 3 * DAY },
			]);
			expect(listed.text).not.toContain(sha256(code));
			expect(JSON.stringify(logged.flatMap((spy) => spy.mock.calls))).not.toContain(code);
		} finally {
			for (const spy of logged) spy.mockRestore();
		}
	});

	test("accepting with a password signs the person in: the session rests on the password, and the person holds the grant the invitation named and nothing else", async () => {
		const w = world();
		const { code } = await invite(w, { name: "robin", can: ["read", "answer"], project: "scratch" });
		const accepted = await w.post<{ signedIn: boolean }>("/api/login", { invitation: code, password: FIRST });
		expect(accepted.status).toBe(200);
		expect(accepted.setCookies[0]).toMatch(
			/^mainworthy_sid=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=7776000$/,
		);
		const info = await me(w, { cookie: accepted.cookie });
		expect(info).toMatchObject({
			actor: "robin",
			kind: "human",
			via: "cookie",
			can: [],
			session: 1,
			credentials: { password: true, passkeys: 0 },
		});
		expect(info.projects.map((project) => `${project.key}: ${project.can?.join(",")}`)).toEqual([
			"scratch: read,answer",
		]);
		// The session has the password under it and no token.
		expect(credentials(w)).toMatchObject([{ id: 1, kind: "password", revoked_at: null }]);
		expect(credentials(w)[0]?.data).toMatch(/^\$argon2id\$/);
		expect(sessions(w)).toMatchObject([{ id: 1, token: null, credential: 1, ended_at: null }]);
		// What the grant does not name is refused, on the project and on the instance.
		expect((await w.post("/api/p/scratch/find", {}, { cookie: accepted.cookie })).status).toBe(200);
		const proposed = await w.post(
			"/api/p/scratch/propose",
			{ edits: [{ op: "create", outline: "Mine" }] },
			{ cookie: accepted.cookie },
		);
		expect(proposed.status).toBe(403);
		expect((await w.op("admin", { do: "actor.list" }, { cookie: accepted.cookie })).status).toBe(403);
		// The invitation is spent and says so in the list.
		const listed = await w.ok<{ state: string }[]>("invitation", { do: "list" });
		expect(listed.map((row) => row.state)).toEqual(["used"]);
	});

	test("an invitation is used once: a second acceptance, an expired one, a revoked one and a wrong code are refused with the same reply", async () => {
		const clock = clockAt();
		const w = world({ clock });
		const used = await invite(w, { name: "robin" });
		expect((await w.post("/api/login", { invitation: used.code, password: FIRST })).status).toBe(200);
		const expired = await invite(w, { name: "sam", expires: "1d" });
		const revoked = await invite(w, { name: "pat" });
		expect(await w.ok<unknown>("invitation", { do: "revoke", id: revoked.id })).toEqual({ revoked: true });
		clock.advance(DAY);
		const refusals: string[] = [];
		const asked: string[] = [];
		for (const code of [used.code, expired.code, revoked.code, "A".repeat(43)]) {
			const reply = await w.post("/api/login", { invitation: code, password: SECOND });
			refusals.push(`${reply.status} ${reply.setCookies.length} ${reply.text}`);
			// The page that shows an invitation is told the same of all four, too.
			const shown = await w.post("/api/login/challenge", { invitation: code });
			asked.push(`${shown.status} ${shown.text}`);
		}
		expect(refusals).toEqual(Array.from({ length: 4 }, () => `401 0 ${REFUSED}`));
		expect(new Set(asked).size).toBe(1);
		expect(asked[0]).toStartWith('404 {"ok":false,"error":{"code":"not_found"');
		// Nothing of the three refused people was made: no credential, no session.
		expect(credentials(w)).toHaveLength(1);
		expect(sessions(w)).toHaveLength(1);
		// One millisecond before its end an invitation still works.
		const late = await invite(w, { name: "lee", expires: "1d" });
		clock.advance(DAY - 1);
		expect((await w.post("/api/login", { invitation: late.code, password: SECOND })).status).toBe(200);
	});

	test("two acceptances of one invitation at the same moment: one signs in, the other is refused, and one password is stored", async () => {
		const w = world();
		const { code } = await invite(w, { name: "robin" });
		const logged = spyOn(console, "warn").mockImplementation(() => {});
		const gate = holdGate(w.instance);
		try {
			// Both have found the invitation good and hashed their password when either may write.
			const waiting = waitingAtGate(w.instance, 2);
			const one = w.post("/api/login", { invitation: code, password: FIRST });
			const two = w.post("/api/login", { invitation: code, password: SECOND });
			await waiting;
			await gate.release();
			const replies = [await one, await two];
			expect(replies.map((reply) => reply.status).sort()).toEqual([200, 401]);
			expect(credentials(w)).toHaveLength(1);
			expect(sessions(w)).toHaveLength(1);
			expect(logged.mock.calls.map((call) => String(call[0]))).toEqual(["[mainworthy] sign-in refused: invitation"]);
			// The password that is stored is the one whose acceptance signed in.
			const winner = replies[0]?.status === 200 ? FIRST : SECOND;
			expect((await signIn(w, "robin", winner)).status).toBe(200);
			expect((await signIn(w, "robin", winner === FIRST ? SECOND : FIRST)).status).toBe(401);
		} finally {
			logged.mockRestore();
		}
	});

	test("the page of an invitation learns who it is for and when it ends, and asking changes nothing", async () => {
		const w = world({ publicUrl: null });
		const { code, link } = await invite(w, { name: "robin" });
		// With no public address the link is relative, and the reply says so.
		expect(link).toBe(`/invite#${code}`);
		await w.instance.app.gate.run(() => undefined);
		const before = w.written();
		for (let i = 0; i < 2; i++) {
			const shown = await w.post("/api/login/challenge", { invitation: code });
			expect(shown.body).toEqual({
				ok: true,
				result: { invitation: { name: "robin", purpose: "join", expiresAt: T0 + 3 * DAY }, passkey: null },
			});
		}
		await w.instance.app.gate.run(() => undefined);
		expect(w.written().equals(before)).toBe(true);
		expect((await w.post("/api/login", { invitation: code, password: FIRST })).status).toBe(200);
	});

	test("an acceptance says what is wrong with a password before it looks at the invitation, and needs a password or a passkey", async () => {
		const w = world();
		const { code } = await invite(w, { name: "robin" });
		const replies: string[] = [];
		for (const body of [
			{ invitation: code, password: "short" },
			{ invitation: "A".repeat(43), password: "short" },
			{ invitation: code, password: "x".repeat(257) },
			{ invitation: code },
		])
			replies.push(`${(await w.post("/api/login", body)).status}`);
		expect(replies).toEqual(["400", "400", "400", "400"]);
		expect((await w.post("/api/login", { invitation: code, password: "x".repeat(256) })).status).toBe(200);
	});

	/** A refusal in one line, with what it carries for a page: `409 conflict {"signedInAs":"pat"}`. */
	const refusal = (reply: { status: number; text: string }): string => {
		const error = (JSON.parse(reply.text) as { error?: { code?: string; details?: unknown } }).error;
		return `${reply.status} ${error?.code} ${JSON.stringify(error?.details)}`;
	};

	test("a browser signed in as somebody else is refused until it names who it asked about, and only the session it held ends then", async () => {
		const w = world();
		const robin = await joined(w, "robin", FIRST);
		const elsewhere = (await signIn(w, "robin", FIRST)).cookie;
		const pat = await joined(w, "pat", FIRST);
		const { code } = await invite(w, { name: "sam" });
		const refused = await w.post("/api/login", { invitation: code, password: SECOND }, { cookie: robin });
		expect(`${refused.status} ${refused.text}`).toBe(
			'409 {"ok":false,"error":{"code":"conflict","message":"this browser is signed in as robin, and the invitation is for somebody else. Send replace: \\"robin\\" to sign robin out of this browser and accept it","details":{"signedInAs":"robin"}}}',
		);
		expect(refused.setCookies).toEqual([]);
		// Refusing changed nothing: the invitation still works and Robin is still signed in.
		expect(await w.status({ cookie: robin })).toBe(200);
		const replaced = await w.post(
			"/api/login",
			{ invitation: code, password: SECOND, replace: "robin" },
			{ cookie: robin },
		);
		expect(replaced.status).toBe(200);
		expect((await me(w, { cookie: replaced.cookie })).actor).toBe("sam");
		expect(await w.status({ cookie: robin })).toBe(401);
		// Robin's other browser and Pat's are nobody's to end here.
		expect(await w.status({ cookie: elsewhere })).toBe(200);
		expect(await w.status({ cookie: pat })).toBe(200);
		expect(sessions(w)).toMatchObject([
			{ ended_why: "signed-out" },
			{ ended_at: null },
			{ ended_at: null },
			{ ended_at: null },
		]);
	});

	test("saying yes to one person signs no other person out: the browser is asked again, about who it holds now", async () => {
		// The page asked "you are signed in as robin, go on as sam?". Before the answer was sent another tab signed
		// Pat in, so the request carries Pat's cookie and a yes that was about Robin.
		const w = world();
		const robin = await joined(w, "robin", FIRST);
		const pat = await joined(w, "pat", FIRST);
		const { code } = await invite(w, { name: "sam" });
		const refused = await w.post(
			"/api/login",
			{ invitation: code, password: SECOND, replace: "robin" },
			{ cookie: pat },
		);
		expect(refusal(refused)).toBe('409 conflict {"signedInAs":"pat"}');
		expect(refused.setCookies).toEqual([]);
		expect(await w.status({ cookie: pat })).toBe(200);
		expect(await w.status({ cookie: robin })).toBe(200);
		expect(sessions(w).filter((row) => row.ended_at !== null)).toEqual([]);
		// A name in other letters is another name.
		const shouted = await w.post("/api/login", { invitation: code, password: SECOND, replace: "PAT" }, { cookie: pat });
		expect(shouted.status).toBe(409);
		// Asked about Pat, the page says so and goes on.
		const replaced = await w.post(
			"/api/login",
			{ invitation: code, password: SECOND, replace: "pat" },
			{ cookie: pat },
		);
		expect(replaced.status).toBe(200);
		expect(await w.status({ cookie: pat })).toBe(401);
		expect(await w.status({ cookie: robin })).toBe(200);
	});

	test("replace is a name: a bare yes is refused as wrong input, before the invitation is looked at", async () => {
		const w = world();
		const robin = await joined(w, "robin", FIRST);
		const { code } = await invite(w, { name: "sam" });
		const replies: string[] = [];
		for (const [invitation, replace] of [
			[code, true],
			[code, false],
			[code, ""],
			[code, "x".repeat(65)],
			[code, null],
			["A".repeat(43), true],
		] as const) {
			const reply = await w.post("/api/login", { invitation, password: SECOND, replace }, { cookie: robin });
			replies.push(said(reply));
		}
		expect(replies).toEqual(Array.from({ length: 6 }, () => "400 invalid"));
		expect(await w.status({ cookie: robin })).toBe(200);
		expect(sessions(w).filter((row) => row.ended_at !== null)).toEqual([]);
	});

	test("a name given where nobody else is signed in ends nothing: no session, or the invited person's own", async () => {
		// The page may have asked a moment before a sign-out.
		const w = world();
		const robin = await joined(w, "robin", FIRST);
		const forSam = await invite(w, { name: "sam" });
		const joinedNow = await w.post("/api/login", { invitation: forSam.code, password: SECOND, replace: "robin" });
		expect(joinedNow.status).toBe(200);
		expect(await w.status({ cookie: robin })).toBe(200);
		// Signed in as Sam, Sam's own recovery link is accepted whatever name comes with it. A recovery ends Sam's
		// sessions, as it always does, and Robin's stays.
		const recovery = await invite(w, { name: "sam" });
		const recovered = await w.post(
			"/api/login",
			{ invitation: recovery.code, password: FIRST, replace: "robin" },
			{ cookie: joinedNow.cookie },
		);
		expect(recovered.status).toBe(200);
		expect((await me(w, { cookie: recovered.cookie })).actor).toBe("sam");
		expect(await w.status({ cookie: robin })).toBe(200);
	});

	test("who the browser holds is asked again in the commit: a session that became another person's while the acceptance waited is not ended", async () => {
		// No request moves a session to another person today: a cookie names one session, and a session keeps its
		// person. The commit is not allowed to rest on that. So the test moves the row itself while it holds the
		// gate, behind which the acceptance waits with a yes that was about Robin.
		const w = world();
		const robin = await joined(w, "robin", FIRST);
		await joined(w, "pat", FIRST);
		const { code } = await invite(w, { name: "sam" });
		const [robins, pats] = sessions(w);
		const gate = holdGate(w.instance);
		const waiting = waitingAtGate(w.instance, 1);
		const accepting = w.post("/api/login", { invitation: code, password: SECOND, replace: "robin" }, { cookie: robin });
		await waiting;
		w.instance.app.db.raw
			.query("UPDATE sessions SET actor = ?, credential = ? WHERE id = ?")
			.run(pats?.actor ?? 0, pats?.credential ?? 0, robins?.id ?? 0);
		await gate.release();
		const refused = await accepting;
		expect(refusal(refused)).toBe('409 conflict {"signedInAs":"pat"}');
		expect(refused.setCookies).toEqual([]);
		// The session is Pat's now and still works, and the invitation is still good.
		expect((await me(w, { cookie: robin })).actor).toBe("pat");
		expect(sessions(w).filter((row) => row.ended_at !== null)).toEqual([]);
		expect((await w.post("/api/login", { invitation: code, password: SECOND })).status).toBe(200);
	});

	test.each(["end", "idle"] as const)(
		"a concurrent sign-in whose cookie an invitation response replaces stays listed until %s",
		async (until) => {
			const w = world();
			const robin = await joined(w, "robin", FIRST);
			const pat = await joined(w, "pat", FIRST);
			const { code } = await invite(w, { name: "sam" });
			let release = () => {};
			let hashed = () => {};
			const started = new Promise<void>((resolve) => {
				hashed = resolve;
			});
			const resume = new Promise<void>((resolve) => {
				release = resolve;
			});
			const hash = Bun.password.hash.bind(Bun.password);
			const held = spyOn(Bun.password, "hash").mockImplementation(async (password, options) => {
				const made = await hash(password, options);
				if (password === SECOND) {
					hashed();
					await resume;
				}
				return made;
			});
			try {
				const accepting = w.post(
					"/api/login",
					{ invitation: code, password: SECOND, replace: "robin" },
					{ cookie: robin },
				);
				await started;
				const concurrent = await signIn(w, "pat", FIRST, { cookie: robin, "user-agent": "concurrent tab" });
				expect(concurrent.status).toBe(200);
				expect((await me(w, { cookie: concurrent.cookie })).actor).toBe("pat");
				release();
				const accepted = await accepting;
				expect(accepted.status).toBe(200);
				expect(accepted.cookie).not.toBe(concurrent.cookie);
				expect((await me(w, { cookie: accepted.cookie })).actor).toBe("sam");
				expect(await w.status({ cookie: robin })).toBe(401);
				expect(await w.status({ cookie: concurrent.cookie })).toBe(200);
				const listed = await w.ok<Listed[]>("session", { do: "list" }, { cookie: pat });
				const lingering = listed.find((row) => row.userAgent === "concurrent tab");
				expect(lingering).toMatchObject({ openedWith: "password", current: false });
				if (!lingering) throw new Error("the concurrent session was not listed");
				if (until === "end") {
					await w.ok("session", { do: "end", id: lingering.id }, { cookie: pat });
					expect(await w.status({ cookie: pat })).toBe(200);
				} else w.clock.advance(14 * DAY);
				expect(await w.status({ cookie: concurrent.cookie })).toBe(401);
			} finally {
				release();
				held.mockRestore();
			}
		},
	);

	test("who may invite whom: a new person is any admin's to invite, a person who exists is the owner's or their own", async () => {
		const w = world();
		const robin = await joined(w, "robin", FIRST, { can: ["read", "admin"] });
		const sam = await joined(w, "sam", SECOND);
		// Robin administers and is not the owner.
		expect((await invite(w, { name: "pat" }, { cookie: robin })).purpose).toBe("join");
		const forSam = await w.op("invitation", { do: "create", name: "sam" }, { cookie: robin });
		expect(forSam.status).toBe(403);
		expect((await w.op("invitation", { do: "create", name: OWNER }, { cookie: robin })).status).toBe(403);
		expect((await invite(w, { name: "robin" }, { cookie: robin })).purpose).toBe("recover");
		expect((await invite(w, { name: "sam" })).purpose).toBe("recover");
		// Sam administers nothing, and an agent that administers is not a person.
		expect((await w.op("invitation", { do: "list" }, { cookie: sam })).status).toBe(403);
		const agent = await tokenFor(w, { actor: "helper", kind: "agent", can: ["read", "admin"] });
		for (const input of [{ do: "create", name: "lee" }, { do: "list" }, { do: "revoke", id: 1 }])
			expect((await w.op("invitation", input, bearer(agent))).status).toBe(403);
		// An invitation is for a person: not for an agent's name, a forgotten name, or a name no actor may have.
		for (const name of ["helper", "policy", "forgotten-9", "has space"])
			expect((await w.op("invitation", { do: "create", name })).status).not.toBe(200);
		// How long it lasts is a duration of at most thirty days.
		expect((await invite(w, { name: "lee", expires: "30d" })).expiresAt).toBe(T0 + 30 * DAY);
		for (const expires of ["31d", "5w", "0d", "soon"])
			expect((await w.op("invitation", { do: "create", name: "mo", expires })).status).toBe(400);
		// A new invitation for a person replaces the one before it.
		const first = await invite(w, { name: "mo" });
		const second = await invite(w, { name: "mo" });
		expect((await w.post("/api/login", { invitation: first.code, password: FIRST })).status).toBe(401);
		expect((await w.post("/api/login", { invitation: second.code, password: FIRST })).status).toBe(200);
	});
});

describe("a name and a password", () => {
	test("canonical password spellings sign in after joining, changing a password and recovering", async () => {
		const w = world();
		const first = "cafe\u0301 password for robin";
		const second = "the next cafe\u0301 password";
		const recovered = "recovered cafe\u0301 password";
		const cookie = await joined(w, "robin", first);
		expect((await signIn(w, "robin", "café password for robin")).status).toBe(200);
		expect(
			(await w.post("/api/account/password", { current: "café password for robin", next: second }, { cookie })).status,
		).toBe(200);
		expect((await signIn(w, "robin", "the next café password")).status).toBe(200);
		const recovery = await invite(w, { name: "robin" });
		expect((await w.post("/api/login", { invitation: recovery.code, password: recovered })).status).toBe(200);
		expect((await signIn(w, "robin", "recovered café password")).status).toBe(200);
	});

	test("an old password keeps working and is rehashed to NFC without ending its existing sessions", async () => {
		const w = world();
		const typed = "cafe\u0301 password for robin";
		const cookie = await joined(w, "robin", typed);
		const oldHash = await Bun.password.hash(typed, { algorithm: "argon2id", memoryCost: 8, timeCost: 1 });
		await w.instance.app.gate.run(() =>
			w.instance.app.db.raw.query("UPDATE credentials SET data = ? WHERE kind = 'password'").run(oldHash),
		);
		expect((await signIn(w, "robin", "the wrong password")).status).toBe(401);
		expect(credentials(w).map((row) => row.data)).toEqual([oldHash]);
		const signedIn = await signIn(w, "robin", typed);
		expect(signedIn.status).toBe(200);
		const stored = credentials(w)[0]?.data ?? "";
		expect(await Bun.password.verify("café password for robin", stored)).toBe(true);
		expect(await Bun.password.verify(typed, stored)).toBe(false);
		expect((await signIn(w, "robin", "café password for robin")).status).toBe(200);
		expect((await signIn(w, "robin", typed)).status).toBe(200);
		expect([await w.status({ cookie }), await w.status({ cookie: signedIn.cookie })]).toEqual([200, 200]);
		expect(credentials(w).map((row) => ({ id: row.id, revokedAt: row.revoked_at }))).toEqual([
			{ id: 1, revokedAt: null },
		]);
	});

	test("a password change accepts an old password's original spelling without a preceding sign-in", async () => {
		const w = world();
		const typed = "cafe\u0301 password for robin";
		const cookie = await joined(w, "robin", typed);
		const oldHash = await Bun.password.hash(typed, { algorithm: "argon2id", memoryCost: 8, timeCost: 1 });
		await w.instance.app.gate.run(() =>
			w.instance.app.db.raw.query("UPDATE credentials SET data = ? WHERE kind = 'password'").run(oldHash),
		);
		expect(
			(await w.post("/api/account/password", { current: typed, next: "the next cafe\u0301 password" }, { cookie }))
				.status,
		).toBe(200);
		expect((await signIn(w, "robin", "the next café password")).status).toBe(200);
		expect((await signIn(w, "robin", typed)).status).toBe(401);
		expect(await w.status({ cookie })).toBe(200);
	});

	test("a legacy password check queued behind a change cannot rehash over the new password", async () => {
		const w = world();
		const typed = "cafe\u0301 password for robin";
		await joined(w, "robin", typed);
		const oldHash = await Bun.password.hash(typed, { algorithm: "argon2id", memoryCost: 8, timeCost: 1 });
		const newHash = await Bun.password.hash(SECOND, { algorithm: "argon2id", memoryCost: 8, timeCost: 1 });
		await w.instance.app.gate.run(() =>
			w.instance.app.db.raw.query("UPDATE credentials SET data = ? WHERE kind = 'password'").run(oldHash),
		);
		const gate = holdGate(w.instance);
		try {
			const waiting = waitingAtGate(w.instance, 1);
			const signingIn = signIn(w, "robin", typed);
			await waiting;
			w.instance.app.db.raw.query("UPDATE credentials SET data = ? WHERE kind = 'password'").run(newHash);
			await gate.release();
			expect((await signingIn).status).toBe(401);
			expect(credentials(w).map((row) => row.data)).toEqual([newHash]);
			expect((await signIn(w, "robin", SECOND)).status).toBe(200);
		} finally {
			await gate.release();
		}
	});

	test("sign in; a wrong password, an unknown name, a forgotten person and a person with no password are the same reply, and each costs a verification", async () => {
		const w = world();
		await joined(w, "robin", FIRST);
		await joined(w, "sam", SECOND);
		await w.ok("admin", { do: "actor.forget", name: "sam" });
		// A person who exists and has a token and no password.
		await tokenFor(w, { actor: "pat", kind: "human", can: ["read"] });
		const logged = spyOn(console, "warn").mockImplementation(() => {});
		const verified = spyOn(Bun.password, "verify");
		try {
			const good = await signIn(w, "robin", FIRST);
			expect(good.status).toBe(200);
			expect((await me(w, { cookie: good.cookie })).actor).toBe("robin");
			expect(verified).toHaveBeenCalledTimes(1);
			const seen: string[] = [];
			for (const [name, password] of [
				["robin", SECOND],
				["nobody", FIRST],
				["sam", SECOND],
				["forgotten-4", SECOND],
				["pat", FIRST],
				["policy", FIRST],
				[OWNER, TOKEN],
				["robin", `${FIRST} `],
			] as const) {
				const before = verified.mock.calls.length;
				const reply = await signIn(w, name, password);
				seen.push(`${reply.status} ${reply.setCookies.length} ${verified.mock.calls.length - before} ${reply.text}`);
			}
			expect(seen).toEqual(Array.from({ length: 8 }, () => `401 0 1 ${REFUSED}`));
			// Why each was refused is in the log as a code, and neither the name that was tried nor the password is.
			const lines = logged.mock.calls.map((call) => String(call[0]));
			expect(lines).toEqual([
				"[mainworthy] sign-in refused: wrong-password",
				"[mainworthy] sign-in refused: unknown-name",
				"[mainworthy] sign-in refused: unknown-name",
				"[mainworthy] sign-in refused: unknown-name",
				"[mainworthy] sign-in refused: no-password",
				"[mainworthy] sign-in refused: unknown-name",
				"[mainworthy] sign-in refused: no-password",
				"[mainworthy] sign-in refused: wrong-password",
			]);
		} finally {
			verified.mockRestore();
			logged.mockRestore();
		}
	});

	test("a body that is not one way of signing in is refused like a wrong password", async () => {
		const w = world();
		await joined(w, "robin", FIRST);
		const logged = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const seen: string[] = [];
			for (const body of [
				{ name: "robin" },
				{ password: FIRST },
				{ name: "robin", password: FIRST, token: TOKEN },
				{ name: "robin", password: FIRST, invitation: "A".repeat(43) },
				{ name: "robin", password: "x".repeat(300) },
				{ name: 7, password: FIRST },
				{},
				[],
			]) {
				const reply = await w.post("/api/login", body);
				seen.push(`${reply.status} ${reply.setCookies.length}`);
			}
			expect(seen).toEqual(Array.from({ length: 8 }, () => "401 0"));
			// Another site's page cannot sign a browser in, whatever it sends.
			const foreign = await signIn(w, "robin", FIRST, { origin: "http://evil.example" });
			expect(`${foreign.status} ${foreign.setCookies.length}`).toBe("401 0");
		} finally {
			logged.mockRestore();
		}
	});

	test("a password is stored as argon2id at the cost the build ships with, when nothing says otherwise", async () => {
		// The other tests hash at a cost a test can afford. This one is the proof of what an instance does.
		const { hashPassword } = await import("../src/server/identity/passwords.ts");
		expect(await hashPassword(FIRST, undefined)).toMatch(/^\$argon2id\$v=19\$m=65536,t=2,p=1\$/);
	});

	test("changing a password needs the current one, ends the other sessions that rested on it, and keeps the one that made the change", async () => {
		const w = world();
		const first = await joined(w, "robin", FIRST);
		const second = (await signIn(w, "robin", FIRST)).cookie;
		const byToken = (await w.post("/api/login", { token: await tokenFor(w, { actor: "robin", kind: "human" }) }))
			.cookie;
		const logged = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const change = (body: unknown, headers: Sent = { cookie: first }) =>
				w.post("/api/account/password", body, headers);
			expect((await change({ next: SECOND })).status).toBe(400);
			const wrong = await change({ current: "not the password at all", next: SECOND });
			expect(wrong.status).toBe(403);
			expect((await change({ current: FIRST, next: "too short" })).status).toBe(400);
			expect((await change({ current: FIRST, next: "x".repeat(257) })).status).toBe(400);
			// Nobody's password is changed without a browser's session: not with a token, not from another site.
			expect((await change({ current: FIRST, next: SECOND }, {})).status).toBe(401);
			expect((await change({ current: FIRST, next: SECOND }, bearer(TOKEN))).status).toBe(403);
			expect(
				(await change({ current: FIRST, next: SECOND }, { cookie: first, origin: "http://evil.example" })).status,
			).toBe(401);
			expect(credentials(w)).toMatchObject([{ id: 1, revoked_at: null }]);
			expect(await w.status({ cookie: second })).toBe(200);

			const changed = await change({ current: FIRST, next: SECOND });
			expect(changed.body).toEqual({ ok: true, result: { changed: true, sessionsEnded: 1 } });
			expect([
				await w.status({ cookie: first }),
				await w.status({ cookie: second }),
				await w.status({ cookie: byToken }),
			]).toEqual([200, 401, 200]);
			expect((await signIn(w, "robin", FIRST)).status).toBe(401);
			expect((await signIn(w, "robin", SECOND)).status).toBe(200);
			// The old password's row is kept, revoked and without its hash; the session that made the change rests
			// on the new one.
			expect(credentials(w)).toMatchObject([
				{ id: 1, revoked_at: expect.any(Number), data: "" },
				{ id: 2, revoked_at: null },
			]);
			expect(sessions(w).slice(0, 3)).toMatchObject([
				{ id: 1, credential: 2, ended_at: null },
				{ id: 2, credential: 1, ended_why: "ended" },
				{ id: 3, credential: null, ended_at: null },
			]);
		} finally {
			logged.mockRestore();
		}
	});

	test("two changes of one password at the same moment: one wins, the other is refused, and the stored password is the winner's", async () => {
		const w = world();
		const cookie = await joined(w, "robin", FIRST);
		const other = (await signIn(w, "robin", FIRST)).cookie;
		let gate = holdGate(w.instance);
		// Two tabs of one browser. Both have checked the current password and hashed their new one when either
		// may write.
		let waiting = waitingAtGate(w.instance, 2);
		const one = w.post("/api/account/password", { current: FIRST, next: "the first of two new ones" }, { cookie });
		const two = w.post("/api/account/password", { current: FIRST, next: "the second of two new ones" }, { cookie });
		await waiting;
		await gate.release();
		const replies = [await one, await two];
		expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409]);
		// The change ended the other browser's session, which rested on the old password.
		expect([await w.status({ cookie }), await w.status({ cookie: other })]).toEqual([200, 401]);
		const winner = replies[0]?.status === 200 ? "the first of two new ones" : "the second of two new ones";
		const loser = replies[0]?.status === 200 ? "the second of two new ones" : "the first of two new ones";
		expect(credentials(w).filter((row) => row.revoked_at === null)).toHaveLength(1);
		const again = await signIn(w, "robin", winner);
		expect(again.status).toBe(200);
		// Two browsers: whichever writes second finds its own session ended by the first, and changes nothing.
		gate = holdGate(w.instance);
		waiting = waitingAtGate(w.instance, 2);
		const here = w.post("/api/account/password", { current: winner, next: "a third password, from here" }, { cookie });
		const there = w.post(
			"/api/account/password",
			{ current: winner, next: "a third password, from there" },
			{ cookie: again.cookie },
		);
		await waiting;
		await gate.release();
		expect([(await here).status, (await there).status].sort()).toEqual([200, 401]);
		expect(credentials(w).filter((row) => row.revoked_at === null)).toHaveLength(1);
		const logged = spyOn(console, "warn").mockImplementation(() => {});
		try {
			for (const old of [loser, winner, FIRST]) expect((await signIn(w, "robin", old)).status).toBe(401);
		} finally {
			logged.mockRestore();
		}
	});

	test("a password never appears in the database, in a log line or in a reply", async () => {
		const w = world();
		const logged = [spyOn(console, "warn"), spyOn(console, "error"), spyOn(console, "info"), spyOn(console, "log")];
		for (const spy of logged) spy.mockImplementation(() => {});
		const typed = [
			"Zebra-Quilt-Harbour-91",
			"Lantern-Orbit-Meadow-27",
			"Wrong-Guess-Entirely-55",
			"Velvet-Anchor-Thistle-64",
		];
		const [joinedWith, changedTo, guessed, recoveredWith] = typed as [string, string, string, string];
		try {
			const cookie = await joined(w, "robin", joinedWith);
			await signIn(w, "robin", joinedWith);
			await signIn(w, "robin", guessed);
			await signIn(w, guessed, joinedWith);
			await w.post("/api/account/password", { current: guessed, next: changedTo }, { cookie });
			await w.post("/api/account/password", { current: joinedWith, next: changedTo }, { cookie });
			await w.post("/api/account/password", { current: changedTo, next: "short" }, { cookie });
			const recovery = await invite(w, { name: "robin" });
			await w.post("/api/login", { invitation: recovery.code, password: recoveredWith });
			// A password sent to the registry by mistake is refused there, and is not kept as a command either.
			await w.op("credential", { do: "list", password: joinedWith, cmd: "mistaken-cmd-1" }, { cookie });
			await w.instance.app.gate.run(() => undefined);
			const disk = w.disk();
			const log = JSON.stringify(logged.flatMap((spy) => spy.mock.calls));
			const said = w.replies.join("\n");
			for (const password of typed) {
				expect(disk.includes(password)).toBe(false);
				expect(log).not.toContain(password);
				expect(said).not.toContain(password);
			}
			// The same search finds what is there, so it would find a password too.
			expect(disk.includes("robin")).toBe(true);
			expect(log).toContain("wrong-password");
			expect(w.rows("SELECT id FROM commands")).toEqual([]);
			// A recovery code is not in them either.
			expect(disk.includes(recovery.code)).toBe(false);
			expect(log).not.toContain(recovery.code);
		} finally {
			for (const spy of logged) spy.mockRestore();
		}
	});

	test("a recovery invitation revokes every credential and ends every session of the person when it is accepted, and not before", async () => {
		const w = world();
		const first = await joined(w, "robin", FIRST);
		const byToken = (await w.post("/api/login", { token: await tokenFor(w, { actor: "robin", kind: "human" }) }))
			.cookie;
		const bystander = await joined(w, "sam", FIRST);
		const recovery = await invite(w, { name: "robin" });
		expect(recovery.purpose).toBe("recover");
		// Made, and not yet accepted: nothing of Robin's has changed.
		expect([await w.status({ cookie: first }), await w.status({ cookie: byToken })]).toEqual([200, 200]);
		expect((await signIn(w, "robin", FIRST)).status).toBe(200);
		expect(credentials(w).map((row) => row.revoked_at)).toEqual([null, null]);
		const shown = await w.post("/api/login/challenge", { invitation: recovery.code });
		expect(shown.body).toMatchObject({ ok: true, result: { invitation: { name: "robin", purpose: "recover" } } });

		const accepted = await w.post("/api/login", { invitation: recovery.code, password: SECOND });
		expect(accepted.status).toBe(200);
		expect([
			await w.status({ cookie: first }),
			await w.status({ cookie: byToken }),
			await w.status({ cookie: accepted.cookie }),
			await w.status({ cookie: bystander }),
		]).toEqual([401, 401, 200, 200]);
		const logged = spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect((await signIn(w, "robin", FIRST)).status).toBe(401);
		} finally {
			logged.mockRestore();
		}
		expect((await signIn(w, "robin", SECOND)).status).toBe(200);
		expect((await signIn(w, "sam", FIRST)).status).toBe(200);
		// Robin's old password is revoked, the new one stands, and Sam's was not touched.
		expect(credentials(w).map((row) => `${row.actor} ${row.revoked_at === null ? "live" : "revoked"}`)).toEqual([
			"3 revoked",
			"4 live",
			"3 live",
		]);
		// What Robin may do was not changed by recovering.
		expect((await me(w, { cookie: accepted.cookie })).projects.map((project) => project.can)).toEqual([["read"]]);
	});

	test("accepted recovery revokes the person's personal CLI and admin-issued tokens, leaving other actors alone", async () => {
		const w = world();
		const cookie = await joined(w, "robin", FIRST);
		const personal = PersonalTokenCreated.parse(
			await w.ok("credential", { do: "token.create", label: "my CLI" }, { cookie }),
		);
		const issued = await tokenFor(w, { actor: "robin", kind: "human" });
		const byToken = await w.post("/api/login", { token: personal.token });
		const bystander = await tokenFor(w, { actor: "sam", kind: "human", can: ["read"] });
		const otherSession = await w.post("/api/login", { token: bystander });
		const recovery = await invite(w, { name: "robin" });
		expect([await w.status(bearer(personal.token)), await w.status(bearer(issued))]).toEqual([200, 200]);
		expect((await w.post("/api/login", { invitation: recovery.code })).status).toBe(400);
		expect([await w.status(bearer(personal.token)), await w.status(bearer(issued))]).toEqual([200, 200]);
		const accepted = await w.post("/api/login", { invitation: recovery.code, password: SECOND });
		expect(accepted.status).toBe(200);
		expect([
			await w.status(bearer(personal.token)),
			await w.status(bearer(issued)),
			await w.status({ cookie: byToken.cookie }),
			await w.status({ cookie }),
			await w.status({ cookie: accepted.cookie }),
			await w.status(bearer(bystander)),
			await w.status({ cookie: otherSession.cookie }),
			await w.status(bearer(TOKEN)),
		]).toEqual([401, 401, 401, 401, 200, 200, 200, 200]);
	});

	test("a personal token revoked by recovery cannot write a proposal queued behind recovery", async () => {
		const w = world();
		const cookie = await joined(w, "robin", FIRST, { can: ["read", "produce"], project: "scratch" });
		const personal = PersonalTokenCreated.parse(
			await w.ok("credential", { do: "token.create", label: "queued CLI" }, { cookie }),
		);
		const recovery = await invite(w, { name: "robin" });
		const gate = holdGate(w.instance);
		try {
			const recoveryQueued = waitingAtGate(w.instance, 1);
			const accepting = w.post("/api/login", { invitation: recovery.code, password: SECOND });
			await recoveryQueued;
			const proposalQueued = waitingAtGate(w.instance, 1);
			const proposal = w.post(
				"/api/p/scratch/propose",
				{ edits: [{ op: "create", outline: "Must not be written" }], cmd: "recovery-queued-proposal" },
				bearer(personal.token),
			);
			await proposalQueued;
			expect(await w.status(bearer(personal.token))).toBe(200);
			await gate.release();
			expect((await accepting).status).toBe(200);
			expect(said(await proposal)).toBe("401 unauthenticated");
			expect(w.rows("SELECT id FROM cases")).toEqual([]);
			expect(w.rows("SELECT id FROM commands WHERE id = 'recovery-queued-proposal'")).toEqual([]);
		} finally {
			await gate.release();
		}
	});

	test("owner recovery also revokes the configured owner token, even when it is the last one", async () => {
		const w = world();
		const before = await w.post("/api/login", { token: TOKEN });
		const recovery = await invite(w, { name: OWNER });
		expect(await w.status(bearer(TOKEN))).toBe(200);
		const accepted = await w.post("/api/login", { invitation: recovery.code, password: SECOND });
		expect(accepted.status).toBe(200);
		expect([
			await w.status(bearer(TOKEN)),
			await w.status({ cookie: before.cookie }),
			await w.status({ cookie: accepted.cookie }),
		]).toEqual([401, 401, 200]);
		const restarted = await w.instance.app.gate.run(() => bootstrap(w.instance.app));
		expect(restarted.warnings.join("\n")).toContain("was revoked");
		expect(await w.status(bearer(TOKEN))).toBe(401);
		expect((await signIn(w, OWNER, SECOND)).status).toBe(200);
		const replacement = "replacement-owner-secret-0123456789";
		w.instance.app.config.ownerToken = replacement;
		await w.instance.app.gate.run(() => bootstrap(w.instance.app));
		expect([
			await w.status(bearer(TOKEN)),
			await w.status(bearer(replacement)),
			await w.status({ cookie: accepted.cookie }),
		]).toEqual([401, 200, 200]);
	});
});

describe("what a signed-in caller sees and ends", () => {
	test("session list shows the caller's sessions and marks the current one; session end ends one's own and not somebody else's", async () => {
		const w = world();
		const laptop = await joined(w, "robin", FIRST);
		const phone = (await signIn(w, "robin", FIRST, { "user-agent": "Phone/1.0" })).cookie;
		const sam = await joined(w, "sam", SECOND);
		const listed = await w.ok<Listed[]>("session", { do: "list" }, { cookie: phone });
		expect(listed).toMatchObject([
			{ id: 1, openedWith: "password", current: false },
			{ id: 2, openedWith: "password", current: true, userAgent: "Phone/1.0" },
		]);
		expect(JSON.stringify(listed)).not.toContain("hash");
		// A token is no browser's session: the list is the same, and none of it is the current one.
		const viaToken = await tokenFor(w, { actor: "robin", kind: "human" });
		expect((await w.ok<Listed[]>("session", { do: "list" }, bearer(viaToken))).map((row) => row.current)).toEqual([
			false,
			false,
		]);
		// Somebody else's: not listed, and not ended, whether the id is theirs or nobody's.
		expect((await w.op("session", { do: "list", actor: "sam" }, { cookie: phone })).status).toBe(403);
		expect((await w.op("session", { do: "list", actor: "nobody" }, { cookie: phone })).status).toBe(403);
		const notMine = await w.op("session", { do: "end", id: 3 }, { cookie: phone });
		const noSuch = await w.op("session", { do: "end", id: 99 }, { cookie: phone });
		expect([notMine.status, noSuch.status]).toEqual([404, 404]);
		expect(notMine.text.replace("3", "99")).toBe(noSuch.text);
		expect(await w.status({ cookie: sam })).toBe(200);
		// One's own, from another device.
		expect(await w.ok<unknown>("session", { do: "end", id: 1 }, { cookie: phone })).toEqual({
			ended: true,
			current: false,
		});
		expect([await w.status({ cookie: laptop }), await w.status({ cookie: phone })]).toEqual([401, 200]);
		expect((await w.op("session", { do: "end", id: 1 }, { cookie: phone })).status).toBe(404);
		// And the one the request itself came by.
		expect(await w.ok<unknown>("session", { do: "end", id: 2 }, { cookie: phone })).toEqual({
			ended: true,
			current: true,
		});
		expect(await w.status({ cookie: phone })).toBe(401);
		expect(sessions(w).map((row) => row.ended_why)).toEqual(["ended", "ended", null]);
	});

	test("an admin who is a person lists and ends anyone's sessions, and an agent with admin does not", async () => {
		const w = world();
		const robin = await joined(w, "robin", FIRST);
		const admin = await joined(w, "sam", SECOND, { can: ["read", "admin"] });
		const agent = await tokenFor(w, { actor: "helper", kind: "agent", can: ["read", "admin"] });
		expect((await w.op("session", { do: "list", actor: "robin" }, bearer(agent))).status).toBe(403);
		expect((await w.op("session", { do: "end", id: 1 }, bearer(agent))).status).toBe(404);
		expect(await w.status({ cookie: robin })).toBe(200);
		// The agent's own are its own to see: it has none.
		expect(await w.ok<unknown>("session", { do: "list" }, bearer(agent))).toEqual([]);

		const seen = await w.ok<Listed[]>("session", { do: "list", actor: "robin" }, { cookie: admin });
		expect(seen).toMatchObject([{ id: 1, openedWith: "password", current: false }]);
		expect((await w.op("session", { do: "list", actor: "nobody" }, { cookie: admin })).status).toBe(404);
		expect(await w.ok<unknown>("session", { do: "end", id: 1 }, { cookie: admin })).toEqual({
			ended: true,
			current: false,
		});
		expect(await w.status({ cookie: robin })).toBe(401);
		// The owner's token does the same, and a session opened with a token says so.
		const again = (await signIn(w, "robin", FIRST)).cookie;
		await w.post("/api/login", { token: TOKEN });
		expect(await w.ok<Listed[]>("session", { do: "list" })).toMatchObject([{ openedWith: "token" }]);
		expect(await w.ok<unknown>("session", { do: "end", id: 3 })).toEqual({ ended: true, current: false });
		expect(await w.status({ cookie: again })).toBe(401);
	});

	test("a session that is no longer alive is not in the list: ended, past a lifetime, or its token revoked", async () => {
		const clock = clockAt();
		const w = world({ clock });
		const token = await tokenFor(w, { actor: "robin", kind: "human", can: ["read"] });
		const robin = (await w.post("/api/login", { token })).cookie;
		const cookie = await joined(w, "sam", FIRST);
		const idle = (await signIn(w, "sam", FIRST)).cookie;
		clock.advance(13 * DAY);
		expect([await w.status({ cookie }), await w.status({ cookie: robin })]).toEqual([200, 200]);
		clock.advance(2 * DAY);
		// The use a moment ago is known though it is not written yet.
		const listed = await w.ok<(Listed & { lastUsedAt: number })[]>("session", { do: "list" }, { cookie });
		expect(listed).toMatchObject([{ id: 2, current: true, lastUsedAt: T0 + 15 * DAY }]);
		expect(await w.status({ cookie: idle })).toBe(401);
		expect(await w.ok<Listed[]>("session", { do: "list", actor: "robin" })).toHaveLength(1);
		await w.ok("admin", { do: "token.revoke", id: 2 });
		expect(await w.ok<Listed[]>("session", { do: "list", actor: "robin" })).toEqual([]);
	});

	test("a caller with a token and no grant at all runs a self operation and no other, and a pipeline runs none", async () => {
		const w = world();
		const token = await tokenFor(w, { actor: "robin", kind: "human", can: ["read"], project: "scratch" });
		await w.ok("admin", { do: "grant.remove", actor: "robin", project: "scratch" });
		const info = await me(w, bearer(token));
		expect([info.can, info.projects]).toEqual([[], []]);
		expect(await w.ok<unknown>("session", { do: "list" }, bearer(token))).toEqual([]);
		expect(await w.ok<unknown>("credential", { do: "list" }, bearer(token))).toEqual([]);
		const { OP_LIST } = await import("../src/server/ops/index.ts");
		const reached: string[] = [];
		for (const op of OP_LIST) {
			const path = op.scope === "project" ? `/api/p/scratch/${op.name}` : `/api/${op.name}`;
			const reply = await w.post(path, { do: "list" }, bearer(token));
			if (reply.status !== 403 && reply.status !== 404) reached.push(op.name);
		}
		expect(reached).toEqual(["session", "credential"]);
		// A pipeline's token reaches `report` and `gate` and nothing else (decision 0014): no self operation either.
		const pipeline = await tokenFor(w, { actor: "ci", kind: "ci", project: "scratch" });
		for (const name of ["session", "credential"]) {
			const reply = await w.op(name, { do: "list" }, bearer(pipeline));
			expect(`${name} ${reply.status}`).toBe(`${name} 403`);
		}
		// Only a person has credentials.
		const agent = await tokenFor(w, { actor: "helper", kind: "agent" });
		expect((await w.op("credential", { do: "list" }, bearer(agent))).status).toBe(403);
		expect(await w.ok<unknown>("session", { do: "list" }, bearer(agent))).toEqual([]);
	});

	test("forgetting a person ends their sessions and revokes their credentials and their invitations", async () => {
		const w = world();
		const cookie = await joined(w, "robin", FIRST);
		const pending = await invite(w, { name: "robin" });
		expect(await w.status({ cookie })).toBe(200);
		await w.ok("admin", { do: "actor.forget", name: "robin" });
		expect(await w.status({ cookie })).toBe(401);
		expect(sessions(w)).toMatchObject([{ ended_why: "forgotten" }]);
		// Revoked, and what they held is erased: no hash of a forgotten person's password stays behind.
		expect(credentials(w)).toEqual([{ id: 1, actor: 3, kind: "password", data: "", revoked_at: expect.any(Number) }]);
		expect(w.rows("SELECT used_at, revoked_at FROM invitations ORDER BY id")).toMatchObject([
			{ used_at: expect.any(Number), revoked_at: null },
			{ used_at: null, revoked_at: expect.any(Number) },
		]);
		expect(w.rows("SELECT actor FROM passkey_users")).toEqual([]);
		const logged = spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect((await signIn(w, "robin", FIRST)).status).toBe(401);
			expect((await w.post("/api/login", { invitation: pending.code, password: SECOND })).status).toBe(401);
		} finally {
			logged.mockRestore();
		}
		// The name is free again, and whoever takes it is a new person with none of what the first one had.
		const next = await joined(w, "robin", SECOND);
		expect((await me(w, { cookie: next })).actor).toBe("robin");
		expect(await w.status({ cookie })).toBe(401);
	});

	test.each([false, true])(
		"forgetting erases stored attribution and access labels without losing replay protection, legacy evidence: %s",
		async (legacy) => {
			const w = world();
			const name = "erasure-person";
			const cookie = await joined(w, name, FIRST);
			await tokenFor(w, { actor: name, kind: "human", label: `${name}'s script`, cmd: "create-secret-01" });
			await w.ok("admin", { do: "token.revoke", id: 2 });
			await tokenFor(w, { actor: name, kind: "human", label: `${name}'s active script` });
			const devices = [authenticator(), authenticator()];
			for (const device of devices) {
				const options = await w.ok<RegistrationOptions>("credential", { do: "passkey.begin" }, { cookie });
				await w.ok(
					"credential",
					{ do: "passkey.add", passkey: device.register(options), label: `${name}'s key` },
					{ cookie },
				);
			}
			await w.ok("credential", { do: "remove", id: 2 }, { cookie });
			const grant = {
				do: "grant.set",
				actor: name,
				project: "scratch",
				can: ["read", "produce"],
				cmd: "grant-person-01",
			};
			expect(await w.ok<unknown>("admin", grant)).toEqual({
				actor: name,
				project: "scratch",
				can: ["read", "produce"],
			});
			await w.ok("admin", { do: "project.create", key: "review", preset: "strict" });
			await w.ok("admin", { do: "grant.set", actor: name, project: "review", can: ["read", "produce"] });
			const proposed = await w.post<ProposeReply>(
				"/api/p/review/propose",
				{ edits: [{ op: "create", outline: "Check total" }], cmd: "person-proposal-01" },
				{ cookie },
			);
			expect(proposed.body).toMatchObject({ ok: true, result: { status: "open", question: "Q-1" } });
			const finding = await w.post(
				"/api/p/review/claim",
				{
					lens: "review",
					findings: [{ on: "pr:17", category: "ambiguous", note: "Say which total" }],
					cmd: "person-claim-01",
				},
				{ cookie },
			);
			expect(finding.body).toMatchObject({ ok: true, result: { opened: ["Q-2"] } });
			const inbox = async () => {
				const reply = await w.post<InboxReply>("/api/p/review/inbox", {}, bearer(TOKEN));
				if (!reply.body.ok) throw new Error(reply.text);
				return reply.body.result.items.sort((a, b) => a.q.localeCompare(b.q));
			};
			const questions = await inbox();
			expect(questions.map((q) => [q.kind, q.evidence.author ?? q.evidence.finder])).toEqual([
				["adopt", name],
				["finding", name],
			]);
			const storedEvidence = w.rows<{ evidence: string }>("SELECT evidence FROM questions ORDER BY id");
			expect(storedEvidence.map((row) => JSON.parse(row.evidence))).toMatchObject([{ authorId: 3 }, { finderId: 3 }]);
			expect(JSON.stringify(storedEvidence)).not.toContain(name);
			if (legacy) {
				await w.instance.app.gate.run(() => {
					w.instance.app.db.raw
						.query(
							"UPDATE questions SET evidence = json_set(json_remove(evidence, '$.authorId'), '$.author', ?) WHERE kind = 'adopt'",
						)
						.run(name);
					w.instance.app.db.raw
						.query("UPDATE questions SET evidence = json_set(evidence, '$.finder', ?) WHERE kind = 'finding'")
						.run(name);
				});
			}
			const questionBindings = () => w.rows("SELECT id, evidence_hash, basis, rev FROM questions ORDER BY id");
			const bindings = questionBindings();
			const ledger = () =>
				w.rows<{ id: string; actor: number; op: string; request: string }>(
					"SELECT id, actor, op, request FROM commands ORDER BY id",
				);
			const before = ledger();
			w.clock.advance(HOUR);
			const forgotten = await w.ok<{ forgotten: string; tokensRevoked: number }>("admin", {
				do: "actor.forget",
				name,
				cmd: "forget-person-01",
			});
			expect(forgotten).toEqual({ forgotten: "forgotten-3", tokensRevoked: 1 });
			expect(ledger().filter((row) => row.id !== "forget-person-01")).toEqual(before);
			const tables = w.rows<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
			);
			for (const table of tables) {
				const rows = w.rows(`SELECT * FROM "${table.name.replaceAll('"', '""')}"`);
				expect(JSON.stringify(rows), table.name).not.toContain(name);
			}
			expect(questionBindings()).toEqual(bindings);
			expect((await inbox()).map((q) => [q.kind, q.evidence.author ?? q.evidence.finder])).toEqual([
				["adopt", "forgotten-3"],
				["finding", "forgotten-3"],
			]);
			const archive = await fetch(`${w.instance.url}/api/export`, { headers: bearer(TOKEN) });
			expect(archive.status).toBe(200);
			expect(await archive.text()).not.toContain(name);
			for (const q of questions) {
				const answered = await w.post(
					"/api/p/review/decide",
					{ q: q.q, onEvidence: q.evidenceHash, answer: { is: "reject" }, reason: "Keep the original" },
					bearer(TOKEN),
				);
				expect(answered.body).toMatchObject({ ok: true, result: [{ status: "decided" }] });
			}
			expect(w.rows("SELECT label, revoked_at FROM tokens WHERE actor = 3 ORDER BY id")).toEqual([
				{ label: "", revoked_at: T0 },
				{ label: "", revoked_at: T0 + HOUR },
			]);
			expect(w.rows("SELECT handle, data, label, revoked_at FROM credentials WHERE actor = 3 ORDER BY id")).toEqual([
				{ handle: null, data: "", label: "", revoked_at: T0 + HOUR },
				{ handle: devices[0]?.id, data: "", label: "", revoked_at: T0 },
				{ handle: devices[1]?.id, data: "", label: "", revoked_at: T0 + HOUR },
			]);
			expect(await w.ok<unknown>("admin", grant)).toEqual({
				actor: "forgotten-3",
				project: "scratch",
				can: ["read", "produce"],
			});
			expect((await w.op("admin", { ...grant, can: ["read"] })).status).toBe(409);
			expect(await w.ok<unknown>("admin", { do: "actor.forget", name, cmd: "forget-person-01" })).toEqual(forgotten);
			expect(
				(
					await w.op("admin", {
						do: "token.create",
						actor: name,
						kind: "human",
						label: `${name}'s script`,
						cmd: "create-secret-01",
					})
				).status,
			).toBe(409);
		},
	);

	test("a name that starts with forgotten- from an older build does not stop the actor with that id being forgotten", async () => {
		const w = world();
		await tokenFor(w, { actor: "dana", kind: "agent" });
		const app = w.instance.app;
		// An archive made before such names were refused: two actors hold the pseudonyms dana would be given.
		for (const name of ["forgotten-3", "forgotten-3-2"])
			await app.gate.run(() =>
				app.db.raw.query("INSERT INTO actors (org, kind, name, created_at) VALUES (1, 'human', ?, 0)").run(name),
			);
		const names = (): string[] =>
			w.rows<{ name: string }>("SELECT name FROM actors ORDER BY id").map((row) => row.name);
		expect(await w.ok("admin", { do: "actor.forget", name: "dana" })).toMatchObject({ forgotten: "forgotten-3-3" });
		expect(names()).toEqual(["policy", "kim", "forgotten-3-3", "forgotten-3", "forgotten-3-2"]);
		// Forgetting the one named forgotten-3 (id 4) gives it forgotten-4, and forgetting dana again, by the name
		// history calls her, keeps hers, though forgotten-3 is free by now.
		expect(await w.ok("admin", { do: "actor.forget", name: "forgotten-3" })).toMatchObject({
			forgotten: "forgotten-4",
		});
		w.clock.advance(HOUR);
		expect(await w.ok("admin", { do: "actor.forget", name: "forgotten-3-3" })).toMatchObject({
			forgotten: "forgotten-3-3",
		});
		expect(names()).toEqual(["policy", "kim", "forgotten-3-3", "forgotten-4", "forgotten-3-2"]);
		// The second time is not a second forgetting: she was forgotten at the first.
		expect(w.rows<{ disabled_at: number }>("SELECT disabled_at FROM actors WHERE id = 3")).toEqual([
			{ disabled_at: T0 },
		]);
	});
});

describe("an upgrade and an import", () => {
	test("a database made by the build before people starts on this one, with its token and its session still working", async () => {
		// Made by the build at c608261 (schema version 2): a server-mode instance at `T0` whose owner `robin`
		// signs in with the token below and holds the session of the first cookie, with a person `sam` who holds
		// a token and the second cookie, and one case. `VACUUM INTO`, then gzip, as `fixtures/sessions` was made.
		const fixture = {
			token: "owner-secret-0123456789",
			cookie: "mainworthy_sid=FwU6M5rkZFSpHz_l7fUwV-Hy6LOUymriT_FzHABQlbc",
			samToken: "cb_71gp9xmZ0fP19gB7kr6HioSeI1SJAAsB",
			samCookie: "mainworthy_sid=vcOncTPabNK38ZkRMlL8y4MZ8s71hCSfkcbuppgf2G0",
		};
		const dataDir = scratch();
		const path = databasePath(dataDir);
		writeFileSync(path, Bun.gunzipSync(readFileSync(join(import.meta.dir, "fixtures", "people", "instance-v2.db.gz"))));
		const { start } = await import("../src/server/start.ts");
		const clock = clockAt(T0 + HOUR);
		const instance = start(
			{
				dataDir,
				host: "127.0.0.1",
				port: 0,
				mode: "server",
				owner: "robin",
				ownerToken: fixture.token,
				commit: null,
				sessionIdleMs: 14 * DAY,
				sessionMaxMs: 90 * DAY,
				proxy: null,
				passwordCost: { memoryCost: 8, timeCost: 1 },
			},
			() => ({ ui: null }),
			{ readers: 0, now: clock.now },
		);
		try {
			const copy = new Database(`${path}.v2.bak`, { readonly: true });
			expect(copy.query("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "2" });
			copy.close();
			expect(instance.app.reader.raw.query("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
				value: String(SCHEMA_VERSION),
			});
			const status = async (headers: Sent): Promise<number> =>
				(await fetch(`${instance.url}/api/session`, { headers })).status;
			expect([
				await status(bearer(fixture.token)),
				await status({ cookie: fixture.cookie }),
				await status(bearer(fixture.samToken)),
				await status({ cookie: fixture.samCookie }),
			]).toEqual([200, 200, 200, 200]);
			const found = await fetch(`${instance.url}/api/p/scratch/find`, {
				method: "POST",
				headers: { cookie: fixture.cookie, "content-type": "application/json" },
				body: "{}",
			});
			expect(await found.json()).toMatchObject({
				ok: true,
				result: { count: 1, items: [{ title: "Coupon applies" }] },
			});
			// The session the old build opened is in its owner's list, opened with a token.
			const listed = await fetch(`${instance.url}/api/session`, {
				method: "POST",
				headers: { cookie: fixture.cookie, "content-type": "application/json" },
				body: JSON.stringify({ do: "list" }),
			});
			expect(await listed.json()).toMatchObject({ ok: true, result: [{ id: 1, openedWith: "token", current: true }] });
			// And the person who was there before can be given a password on the upgraded database.
			const post = async (route: string, body: unknown, headers: Sent = {}) =>
				fetch(`${instance.url}${route}`, {
					method: "POST",
					headers: { "content-type": "application/json", ...headers },
					body: JSON.stringify(body),
				});
			const invited = (await (
				await post("/api/invitation", { do: "create", name: "sam" }, bearer(fixture.token))
			).json()) as { result: { code: string; purpose: string } };
			expect(invited.result.purpose).toBe("recover");
			expect((await post("/api/login", { invitation: invited.result.code, password: FIRST })).status).toBe(200);
			expect((await post("/api/login", { name: "sam", password: FIRST })).status).toBe(200);
			expect(await status({ cookie: fixture.samCookie })).toBe(401);
			expect(await status(bearer(fixture.samToken))).toBe(401);
		} finally {
			await instance.stop();
		}
	});

	test("a sign-in that waits at the gate across an import does not sign in whoever took the ids afterwards", async () => {
		const w = world();
		const archive = await (await fetch(`${w.instance.url}/api/export`, { headers: bearer(TOKEN) })).text();
		// An import is taken only by an instance that holds its owner and nothing else, so the owner is the
		// person whose ids an import gives away. The owner has a password, by a recovery link of their own.
		const recovery = await invite(w, { name: OWNER });
		const recovered = await w.post("/api/login", { invitation: recovery.code, password: FIRST });
		expect(recovered.status).toBe(200);
		const before = { actor: credentials(w)[0]?.actor, credential: credentials(w)[0]?.id };
		const logged = spyOn(console, "warn").mockImplementation(() => {});
		const gate = holdGate(w.instance);
		try {
			let waiting = waitingAtGate(w.instance, 1);
			const importing = fetch(`${w.instance.url}/api/import`, {
				method: "POST",
				headers: { cookie: recovered.cookie },
				body: archive,
			});
			await waiting;
			// Behind the import: the owner the archive brings has the actor id the owner had, and is given a
			// password under the credential id the old one had. It is another password.
			const { hashPassword } = await import("../src/server/identity/passwords.ts");
			const others = await hashPassword(SECOND, { memoryCost: 8, timeCost: 1 });
			const taken = w.instance.app.gate.run(() => {
				const raw = w.instance.app.db.raw;
				raw
					.query(
						"INSERT INTO credentials (id, actor, kind, data, label, created_at) VALUES (?, ?, 'password', ?, 'password', ?)",
					)
					.run(before.credential ?? 0, before.actor ?? 0, others, T0);
			});
			// Behind both: the sign-in, which has verified the old password against the row as it was.
			waiting = waitingAtGate(w.instance, 1);
			const signingIn = signIn(w, OWNER, FIRST);
			await waiting;
			await gate.release();
			expect((await importing).status).toBe(200);
			await taken;
			const refused = await signingIn;
			expect(`${refused.status} ${refused.setCookies.length} ${refused.text}`).toBe(`401 0 ${REFUSED}`);
			expect(sessions(w)).toEqual([]);
			expect(credentials(w)).toMatchObject([{ id: before.credential, actor: before.actor, revoked_at: null }]);
			expect(logged.mock.calls.map((call) => String(call[0]))).toEqual([
				"[mainworthy] sign-in refused: changed-meanwhile",
			]);
		} finally {
			await gate.release();
			logged.mockRestore();
		}
	});
});

describe("the limit on failed attempts", () => {
	// Every request of a `proxied` world comes from the address it names, as a visitor behind a proxy does.
	const address = (n: number): Sent => from(`203.0.113.${n}`);
	const LIMITED = '{"ok":false,"error":{"code":"limited","message":"too many failed attempts; try again in 1 second"}}';
	/** Runs with the log silenced: a refused sign-in writes a line. */
	async function quietly<T>(run: () => Promise<T>): Promise<T> {
		const logged = spyOn(console, "warn").mockImplementation(() => {});
		try {
			return await run();
		} finally {
			logged.mockRestore();
		}
	}

	test("the fifth wrong password for a name blocks the name from every address: the right password is 429 then and is not looked at, and a success clears the name", async () => {
		const clock = clockAt();
		const w = world({ clock, proxied: true });
		await joined(w, "robin", FIRST);
		const verified = spyOn(Bun.password, "verify");
		try {
			await quietly(async () => {
				// Five guesses, each from another address, so no address is near its own limit. The name is one
				// target however it is capitalised, and a capitalised one is nobody's name here.
				const guesses: string[] = [];
				for (let n = 1; n <= 5; n++)
					guesses.push(said(await signIn(w, n > 3 ? "ROBIN" : "robin", `a wrong guess number ${n}`, address(n))));
				expect(guesses).toEqual(Array.from({ length: 5 }, () => "401 unauthenticated"));
				// From an address that never failed, with the right password.
				const before = verified.mock.calls.length;
				const blocked = await signIn(w, "robin", FIRST, address(6));
				expect(`${said(blocked)} ${blocked.setCookies.length} ${blocked.text}`).toBe(
					`429 limited, retry after 1 0 ${LIMITED}`,
				);
				expect(verified.mock.calls.length).toBe(before);
				// Asking again during the block is not counted: it stays one second.
				expect(said(await signIn(w, "robin", SECOND, address(7)))).toBe("429 limited, retry after 1");
				// Another name is not blocked, and neither is the owner's token.
				expect(said(await signIn(w, "sam", SECOND, address(6)))).toBe("401 unauthenticated");
				expect(await w.status({ ...address(6), ...bearer(TOKEN) })).toBe(200);
				clock.advance(1000);
				expect(said(await signIn(w, "robin", FIRST, address(6)))).toBe("200");
				// The success cleared the name: four wrong guesses are free again, where one more would have doubled
				// the block.
				for (let n = 11; n <= 14; n++)
					expect(said(await signIn(w, "robin", "wrong once more", address(n)))).toBe("401 unauthenticated");
				expect(said(await signIn(w, "robin", FIRST, address(15)))).toBe("200");
			});
		} finally {
			verified.mockRestore();
		}
	});

	test("a name nobody has is counted exactly as a wrong password is, so the count does not say which names exist", async () => {
		const w = world({ proxied: true });
		await joined(w, "robin", FIRST);
		await quietly(async () => {
			const replies: Record<string, string[]> = { robin: [], nobody: [] };
			for (const name of ["robin", "nobody"])
				for (let n = 1; n <= 7; n++) {
					const reply = await signIn(w, name, "not the password", address(name === "robin" ? n : 20 + n));
					replies[name]?.push(`${said(reply)} ${reply.text}`);
				}
			expect(replies.nobody).toEqual(replies.robin ?? []);
			expect(replies.robin?.map((line) => line.slice(0, 3))).toEqual(["401", "401", "401", "401", "401", "429", "429"]);
		});
	});

	test("five wrong passwords from one address block the address for every name and for a token, and a success clears the name and never the address", async () => {
		const clock = clockAt();
		const w = world({ clock, proxied: true });
		await joined(w, "robin", FIRST);
		await quietly(async () => {
			// Five names, one guess each: no name is near its limit, the address is at its own.
			for (let n = 1; n <= 5; n++)
				expect(said(await signIn(w, `person-${n}`, "not the password", address(1)))).toBe("401 unauthenticated");
			expect(said(await signIn(w, "robin", FIRST, address(1)))).toBe("429 limited, retry after 1");
			// The count is the instance's one: the address is blocked for the owner's token, which a person chose.
			const token = await w.get("/api/session", { ...address(1), ...bearer(TOKEN) });
			expect(said(token)).toBe("429 limited, retry after 1");
			// From another address the same password signs in.
			expect(said(await signIn(w, "robin", FIRST, address(2)))).toBe("200");
			clock.advance(1000);
			expect(said(await signIn(w, "robin", FIRST, address(1)))).toBe("200");
			// That success did not clear the address: its next failure doubles the block, where a cleared address
			// would have four free ones.
			expect(said(await signIn(w, "person-6", "not the password", address(1)))).toBe("401 unauthenticated");
			expect(said(await signIn(w, "robin", FIRST, address(1)))).toBe("429 limited, retry after 2");
		});
	});

	test("the current password of a password change is counted under the address and the name, as a sign-in is", async () => {
		const clock = clockAt();
		const w = world({ clock, proxied: true });
		const cookie = await joined(w, "robin", FIRST);
		const change = (current: string, n: number) =>
			w.post("/api/account/password", { current, next: SECOND }, { cookie, ...address(n) });
		await quietly(async () => {
			for (let n = 1; n <= 5; n++) expect(said(await change(`a wrong guess number ${n}`, n))).toBe("403 forbidden");
			// The right current password, from an address that never failed: the name is blocked.
			const blocked = await change(FIRST, 6);
			expect(`${said(blocked)} ${blocked.text}`).toBe(`429 limited, retry after 1 ${LIMITED}`);
			// The sign-in for that name is blocked by the same count, and the session itself is not: a cookie is
			// never counted.
			expect(said(await signIn(w, "robin", FIRST, address(7)))).toBe("429 limited, retry after 1");
			expect(await w.status({ cookie, ...address(6) })).toBe(200);
			expect(credentials(w)).toMatchObject([{ id: 1, revoked_at: null }]);
			clock.advance(1000);
			expect(said(await change(FIRST, 6))).toBe("200");
			// Five wrong ones from one address block the address, whoever's session sends them.
			for (let n = 1; n <= 5; n++) expect(said(await change(`wrong again ${n}`, 9))).toBe("403 forbidden");
			expect(said(await signIn(w, "sam", SECOND, address(9)))).toBe("429 limited, retry after 1");
		});
	});

	test("a wrong invitation code is counted under the address, at acceptance and where the page looks at it; a right one passes a blocked address", async () => {
		const w = world({ proxied: true });
		const { code } = await invite(w, { name: "robin" });
		const wrong = (n: number): string => `${String(n).padStart(2, "0")}${"x".repeat(41)}`;
		await quietly(async () => {
			const replies: string[] = [];
			for (let n = 1; n <= 3; n++)
				replies.push(said(await w.post("/api/login", { invitation: wrong(n), password: FIRST }, address(1))));
			for (let n = 4; n <= 5; n++)
				replies.push(said(await w.post("/api/login/challenge", { invitation: wrong(n) }, address(1))));
			expect(replies).toEqual([
				"401 unauthenticated",
				"401 unauthenticated",
				"401 unauthenticated",
				"404 not_found",
				"404 not_found",
			]);
			// Blocked: a wrong code is answered 429 on both routes, and another address is not affected.
			expect(said(await w.post("/api/login", { invitation: wrong(6), password: FIRST }, address(1)))).toBe(
				"429 limited, retry after 1",
			);
			expect(said(await w.post("/api/login/challenge", { invitation: wrong(7) }, address(1)))).toBe(
				"429 limited, retry after 1",
			);
			expect(said(await w.post("/api/login/challenge", { invitation: wrong(8) }, address(2)))).toBe("404 not_found");
			// The right code is 256 random bits the server made: it is looked at during the block, and it is good.
			expect(said(await w.post("/api/login/challenge", { invitation: code }, address(1)))).toBe("200");
			expect(said(await w.post("/api/login", { invitation: code, password: FIRST }, address(1)))).toBe("200");
		});
	});

	test("a request from the loopback address, which behind a proxy is everybody's, is counted by the name and not by the address", async () => {
		const w = world();
		await joined(w, "robin", FIRST);
		await quietly(async () => {
			for (let n = 1; n <= 12; n++)
				expect(said(await signIn(w, `person-${n}`, "not the password"))).toBe("401 unauthenticated");
			expect(said(await signIn(w, "robin", FIRST))).toBe("200");
			for (let n = 1; n <= 5; n++) await signIn(w, "robin", "not the password");
			expect(said(await signIn(w, "robin", FIRST))).toBe("429 limited, retry after 1");
		});
	});

	test("a session opened with a password says where it was opened and last used from, and one whose token has reached its end is not listed", async () => {
		const clock = clockAt();
		const w = world({ clock, proxied: true });
		const { code } = await invite(w, { name: "robin", can: ["read"], project: "scratch" });
		const accepted = await w.post("/api/login", { invitation: code, password: FIRST }, address(1));
		const byPassword = await signIn(w, "robin", FIRST, address(2));
		expect(w.rows("SELECT id, created_addr, last_seen_addr FROM sessions ORDER BY id")).toEqual([
			{ id: 1, created_addr: "203.0.113.1", last_seen_addr: "203.0.113.1" },
			{ id: 2, created_addr: "203.0.113.2", last_seen_addr: "203.0.113.2" },
		]);
		// A token for the same person, with an end, and a browser signed in with it.
		const made = await w.ok<{ token: string }>("admin", {
			do: "token.create",
			actor: "robin",
			kind: "human",
			expires: "1d",
		});
		const byToken = await w.post("/api/login", { token: made.token }, address(3));
		expect(byToken.status).toBe(200);
		clock.advance(HOUR);
		type Row = { id: number; openedWith: string; createdFrom: string | null; lastUsedFrom: string | null };
		const listed = await w.ok<Row[]>("session", { do: "list" }, { cookie: accepted.cookie, ...address(4) });
		expect(listed.map((row) => `${row.id} ${row.openedWith} ${row.createdFrom} ${row.lastUsedFrom}`)).toEqual([
			// The request that asked is this session's latest use, known before it is written.
			"1 password 203.0.113.1 203.0.113.4",
			"2 password 203.0.113.2 203.0.113.2",
			"3 token 203.0.113.3 203.0.113.3",
		]);
		// The token reaches its end: its session is refused, and the list says so too. The others live on.
		clock.advance(DAY);
		expect([await w.status({ cookie: byToken.cookie }), await w.status({ cookie: byPassword.cookie })]).toEqual([
			401, 200,
		]);
		const after = await w.ok<Row[]>("session", { do: "list" }, { cookie: accepted.cookie });
		expect(after.map((row) => row.id)).toEqual([1, 2]);
	});
});

describe("what the pages of the web UI asked of the server", () => {
	test("the session says whether the caller owns the instance, which decides who may make a recovery link for somebody else", async () => {
		const w = world();
		const robin = await joined(w, "robin", FIRST, { can: ["read", "admin"] });
		const agent = await tokenFor(w, { actor: "helper", kind: "agent", can: ["read", "admin"] });
		const owner = (await w.post("/api/login", { token: TOKEN })).cookie;
		expect([
			(await me(w, bearer(TOKEN))).owner,
			(await me(w, { cookie: owner })).owner,
			(await me(w, { cookie: robin })).owner,
			(await me(w, bearer(agent))).owner,
		]).toEqual([true, true, false, false]);
		// It is the same rule the server refuses by: an admin who is not the owner makes no recovery for another.
		await joined(w, "sam", SECOND);
		expect((await w.op("invitation", { do: "create", name: "sam" }, { cookie: robin })).status).toBe(403);
		expect((await w.op("invitation", { do: "create", name: "sam" }, { cookie: owner })).status).toBe(200);
	});

	test("the list of invitations says what each person may do and where, as the list of actors does", async () => {
		const w = world();
		await w.ok("admin", { do: "project.create", key: "checkout" });
		await invite(w, { name: "robin", can: ["read", "produce"], project: "checkout" });
		await invite(w, { name: "sam" });
		await invite(w, { name: OWNER });
		type Row = { name: string; purpose: string; grants: { project: string; can: string[] }[] };
		const listed = await w.ok<Row[]>("invitation", { do: "list" });
		expect(listed.map((row) => ({ name: row.name, purpose: row.purpose, grants: row.grants }))).toEqual([
			// `produce` includes `record`, and the list says what the person holds, as the registry will see it.
			{ name: "robin", purpose: "join", grants: [{ project: "checkout", can: ["read", "record", "produce"] }] },
			{
				name: "sam",
				purpose: "join",
				grants: [{ project: "*", can: ["read", "record", "produce", "answer", "plan", "admin"] }],
			},
			{
				name: OWNER,
				purpose: "recover",
				grants: [{ project: "*", can: ["read", "record", "produce", "answer", "plan", "admin"] }],
			},
		]);
		// A grant that changes after the invitation was made is what the list shows: it is the person's, not the link's.
		await w.ok("admin", { do: "grant.set", actor: "robin", project: "checkout", can: ["read"] });
		const after = await w.ok<Row[]>("invitation", { do: "list" });
		expect(after[0]?.grants).toEqual([{ project: "checkout", can: ["read"] }]);
	});

	test("a password an invitation was accepted with says when it was last used: the moment it signed its person in", async () => {
		const clock = clockAt();
		const w = world({ clock });
		const { code } = await invite(w, { name: "robin" });
		clock.advance(HOUR);
		const accepted = await w.post("/api/login", { invitation: code, password: FIRST });
		expect(await w.ok("credential", { do: "list" }, { cookie: accepted.cookie })).toMatchObject([
			{ id: 1, kind: "password", lastUsedAt: T0 + HOUR },
		]);
	});

	test("an operation of the instance is called at /api/<operation> and nowhere else: under a project's path it is refused", async () => {
		const w = world();
		const cookie = await joined(w, "robin", FIRST);
		const { OP_LIST } = await import("../src/server/ops/index.ts");
		const instance = OP_LIST.filter((op) => op.scope === "instance").map((op) => op.name);
		expect(instance).toEqual(["admin", "session", "credential", "invitation"]);
		for (const name of instance) {
			const input = name === "admin" ? { do: "project.list" } : { do: "list" };
			const under = await w.post(`/api/p/scratch/${name}`, input, bearer(TOKEN));
			expect(`${name}: ${said(under)}`).toBe(`${name}: 404 not_found`);
			expect(under.body.ok ? "" : under.body.error.message).toBe(
				`${name} is an operation of the instance and of no project: POST /api/${name}`,
			);
			// A project that does not exist is no different, and neither is a caller with no grant there.
			expect(said(await w.post(`/api/p/nowhere/${name}`, input, bearer(TOKEN)))).toBe("404 not_found");
			expect(said(await w.post(`/api/${name}`, input, bearer(TOKEN)))).toBe("200");
		}
		expect(said(await w.post("/api/p/scratch/session", { do: "list" }, { cookie }))).toBe("404 not_found");
		// Nothing was made under the wrong path.
		const made = await w.post("/api/p/scratch/invitation", { do: "create", name: "sam" }, bearer(TOKEN));
		expect(said(made)).toBe("404 not_found");
		expect(w.rows("SELECT id FROM invitations")).toHaveLength(1);
		// And an operation of a project has no path without one.
		expect(said(await w.post("/api/find", {}, bearer(TOKEN)))).toBe("400 invalid");
	});
});

describe("a sign-in body the server cannot read", () => {
	test("one that is too large, or is not JSON, is answered as any body that is no way of signing in: not with a sentence about tokens", async () => {
		const w = world();
		await joined(w, "robin", FIRST);
		const logged = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const send = (body: string) =>
				fetch(`${w.instance.url}/api/login`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body,
				}).then(async (reply) => `${reply.status} ${reply.headers.getSetCookie().length} ${await reply.text()}`);
			// A passkey's answer is the longest body there is, and sixteen kibibytes is past any of them.
			const large = JSON.stringify({ passkey: { id: "x".repeat(17 * 1024) } });
			expect([await send(large), await send("{not json"), await send('"a string"')]).toEqual(
				Array.from({ length: 3 }, () => `401 0 ${REFUSED}`),
			);
			expect(logged.mock.calls.map((call) => String(call[0]))).toEqual(
				Array.from({ length: 3 }, () => "[mainworthy] sign-in refused: input"),
			);
			// One byte inside the limit is read, and refused for what it is.
			const fits = JSON.stringify({ name: "robin", password: "x".repeat(400), pad: "y".repeat(8 * 1024) });
			expect(await send(fits)).toBe(`401 0 ${REFUSED}`);
		} finally {
			logged.mockRestore();
		}
	});
});

describe("a person's own command-line token", () => {
	test("the local owner creates an expiring token without a browser sign-in", async () => {
		const w = world({ mode: "local" });
		const made = PersonalTokenCreated.parse(await w.ok("credential", { do: "token.create", label: "Local CLI" }, {}));
		expect(made).toMatchObject({ actor: OWNER, expiresAt: T0 + 30 * DAY });
		expect(await w.status(bearer(made.token))).toBe(200);
		expect(await w.ok("credential", { do: "token.revoke", id: made.id }, {})).toMatchObject({ revoked: true });
		expect(await w.status(bearer(made.token))).toBe(401);
	});

	test("a non-admin creates once, uses current grants, lists only their tokens and revokes them", async () => {
		const w = world();
		const cookie = await joined(w, "personal", FIRST, { can: ["read", "produce"], project: "scratch" });
		const headers = { cookie, origin: w.instance.url };
		const input = { do: "token.create", label: "Laptop CLI", cmd: "personal-token-once" };
		const made = await w.op<{ id: number; actor: string; token: string; expiresAt: number }>(
			"credential",
			input,
			headers,
		);
		expect(made.status).toBe(200);
		const token = PersonalTokenCreated.parse(must(made));
		expect(token).toMatchObject({ actor: "personal", expiresAt: T0 + 30 * DAY });
		expect(token.token).toMatch(/^cb_[0-9A-Za-z]{32}$/);
		const cli = Bun.spawn([process.execPath, CLI_ENTRY, "credential", "--json", '{"do":"token.list"}'], {
			env: { ...process.env, MAINWORTHY_URL: w.instance.url, MAINWORTHY_TOKEN: token.token },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(cli.stdout).text(),
			new Response(cli.stderr).text(),
			cli.exited,
		]);
		expect([code, stderr]).toEqual([0, ""]);
		expect(PersonalTokenRow.array().parse(JSON.parse(stdout))).toMatchObject([{ id: token.id, label: "Laptop CLI" }]);
		await w.ok("admin", { do: "project.create", key: "other", name: "Other" });
		expect(said(await w.post("/api/p/other/find", {}, bearer(token.token)))).toBe("404 not_found");

		expect(w.disk().includes(Buffer.from(token.token))).toBe(false);
		expect(said(await w.op("credential", input, headers))).toBe("409 conflict");
		const listed = await w.ok<{ id: number; label: string; revoked: boolean }[]>(
			"credential",
			{ do: "token.list" },
			headers,
		);
		expect(listed).toMatchObject([{ id: token.id, label: "Laptop CLI", revoked: false }]);
		expect(listed).toHaveLength(1);
		expect(listed).toMatchObject([{ lastUsedAt: T0 }]);
		expect(w.rows("SELECT outcome FROM commands WHERE id = 'personal-token-once'")).toEqual([
			{ outcome: '"(reply not kept: it held a secret)"' },
		]);
		expect(JSON.stringify(listed)).not.toContain(token.token);
		expect(said(await w.op("credential", { do: "token.revoke", id: 1 }, headers))).toBe("404 not_found");
		const use = () =>
			w.post("/api/p/scratch/propose", { edits: [{ op: "create", outline: "CLI case" }] }, bearer(token.token));
		expect((await use()).status).toBe(200);
		await w.ok("admin", { do: "grant.set", actor: "personal", project: "scratch", can: ["read"] });
		expect(said(await use())).toBe("403 forbidden");
		await w.ok("admin", { do: "grant.remove", actor: "personal", project: "scratch" });
		expect(said(await w.post("/api/p/scratch/find", { cases: {} }, bearer(token.token)))).toBe("404 not_found");
		expect(await w.ok<{ revoked: boolean }>("credential", { do: "token.revoke", id: token.id }, headers)).toEqual({
			revoked: true,
		});
		expect(await w.status(bearer(token.token))).toBe(401);
		expect(await w.status(headers)).toBe(200);
		expect(await w.ok("credential", { do: "token.list" }, headers)).toMatchObject([{ id: token.id, revoked: true }]);
	});

	test("a personal token follows team grants and membership without changing personal grants", async () => {
		const w = world();
		const cookie = await joined(w, "team-cli", FIRST, { can: ["read"], project: "scratch" });
		const made = PersonalTokenCreated.parse(
			await w.ok("credential", { do: "token.create", label: "Team CLI" }, { cookie, origin: w.instance.url }),
		);
		const use = () =>
			w.post("/api/p/scratch/propose", { edits: [{ op: "create", outline: "From a team token" }] }, bearer(made.token));
		expect(said(await use())).toBe("403 forbidden");
		await w.ok("admin", { do: "team.create", name: "Quality" });
		await w.ok("admin", { do: "team.grant.set", team: "Quality", project: "scratch", can: ["produce"] });
		await w.ok("admin", { do: "team.member.add", team: "Quality", person: "team-cli" });
		expect((await use()).status).toBe(200);
		await w.ok("admin", { do: "team.grant.remove", team: "Quality", project: "scratch" });
		expect(said(await use())).toBe("403 forbidden");
		await w.ok("admin", { do: "team.grant.set", team: "Quality", project: "scratch", can: ["produce"] });
		expect((await use()).status).toBe(200);
		await w.ok("admin", { do: "team.member.remove", team: "Quality", person: "team-cli" });
		expect(said(await use())).toBe("403 forbidden");
		expect((await w.post("/api/p/scratch/find", {}, bearer(made.token))).status).toBe(200);
		expect(await w.ok("admin", { do: "actor.list" })).toContainEqual(
			expect.objectContaining({ name: "team-cli", grants: [{ project: "scratch", can: ["read"] }], teams: [] }),
		);
	});

	test("expiry is bounded, caller identity cannot be supplied, and token sign-ins cannot renew themselves", async () => {
		const w = world();
		const cookie = await joined(w, "expiry-person", FIRST);
		const headers = { cookie, origin: w.instance.url };
		for (const expires of ["0d", "never", "366d", "9999w"])
			expect(said(await w.op("credential", { do: "token.create", label: "No", expires }, headers))).toBe("400 invalid");
		for (const extra of [{ actor: OWNER }, { can: ["admin"] }, { project: "other" }])
			expect(said(await w.op("credential", { do: "token.create", label: "No", ...extra }, headers))).toBe(
				"400 invalid",
			);
		const token = await w.ok<{ id: number; token: string; expiresAt: number }>(
			"credential",
			{ do: "token.create", label: "Short", expires: "1h" },
			headers,
		);
		expect(token.expiresAt).toBe(T0 + HOUR);
		expect(said(await w.op("credential", { do: "token.create", label: "Renew" }, bearer(token.token)))).toBe(
			"403 forbidden",
		);
		const signed = await w.post("/api/login", { token: token.token });
		expect(said(await w.op("credential", { do: "token.create", label: "Renew" }, { cookie: signed.cookie }))).toBe(
			"403 forbidden",
		);
		w.clock.advance(HOUR);
		expect(await w.status(bearer(token.token))).toBe(401);
		expect(await w.ok("credential", { do: "token.list" }, headers)).toMatchObject([{ id: token.id, expired: true }]);
		const longest = await w.ok<{ expiresAt: number }>(
			"credential",
			{ do: "token.create", label: "Longest", expires: "365d" },
			headers,
		);
		expect(longest.expiresAt).toBe(T0 + HOUR + 365 * DAY);
		const another = await w.ok<{ token: string }>("credential", { do: "token.create", label: "Forget" }, headers);
		await w.ok("admin", { do: "actor.forget", name: "expiry-person" });
		expect(await w.status(bearer(another.token))).toBe(401);
	});

	test("a passkey session can create, and the owner's last token stays", async () => {
		const w = world();
		const invitation = await invite(w, { name: "passkey-cli", can: ["read"], project: "scratch" });
		const options = await w.post<{ passkey: RegistrationOptions }>("/api/login/challenge", {
			invitation: invitation.code,
		});
		if (!options.body.ok) throw new Error(options.text);
		const accepted = await w.post("/api/login", {
			invitation: invitation.code,
			passkey: authenticator().register(options.body.result.passkey),
		});
		expect(accepted.status).toBe(200);
		expect(
			said(await w.op("credential", { do: "token.create", label: "Passkey CLI" }, { cookie: accepted.cookie })),
		).toBe("200");
		expect(said(await w.op("credential", { do: "token.revoke", id: 1 }))).toBe("400 invalid");
	});
});
