// People sign in as themselves, on a real listener: an invitation, a password, what a signed-in person may see
// and end, and what is kept of all that. Time is the test's own clock. Passkeys are in `test/passkeys.test.ts`.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionInfo } from "../src/core/api.ts";
import { databasePath } from "../src/server/kernel/app.ts";
import { SCHEMA_VERSION } from "../src/server/kernel/migrate.ts";
import {
	bearer,
	cleanUp,
	clockAt,
	DAY,
	from,
	HOUR,
	holdGate,
	invite,
	joined,
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
			expect(await status(bearer(fixture.samToken))).toBe(200);
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
		expect((await w.post("/api/login", { invitation: recovery.code, password: FIRST })).status).toBe(200);
		const before = { actor: credentials(w)[0]?.actor, credential: credentials(w)[0]?.id };
		const logged = spyOn(console, "warn").mockImplementation(() => {});
		const gate = holdGate(w.instance);
		try {
			let waiting = waitingAtGate(w.instance, 1);
			const importing = fetch(`${w.instance.url}/api/import`, {
				method: "POST",
				headers: bearer(TOKEN),
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
