// People sign in as themselves through the instance's identity provider, on a real listener: an invitation, what a
// signed-in person may see and end, and what is kept of all that. Time is the test's own clock. The provider's
// protocol is in `test/oidc.test.ts`, and recent proof in `test/recent-proof.test.ts`.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { CLI_ENTRY } from "../src/cli/test-support.ts";
import type { SessionInfo } from "../src/core/api.ts";
import type { InboxReply, ProposeReply } from "../src/core/ops.ts";
import { PersonalTokenCreated, PersonalTokenRow } from "../src/core/people.ts";
import { bootstrap } from "../src/server/identity/identity.ts";
import { runArchive } from "../src/server/ops/archives.ts";
import { pgRun, withWrite } from "./identity-db.ts";
import type { Next } from "./oidc-support.ts";
import {
	authorize,
	bearer,
	begin,
	cleanUp,
	clockAt,
	DAY,
	finish,
	from,
	HOUR,
	holdGate,
	invite,
	jar,
	joined,
	must,
	OWNER,
	PUBLIC,
	prove,
	type Sent,
	said,
	scratch,
	sessionOf,
	sha256,
	signIn,
	subjectOf,
	T0,
	TOKEN,
	viaProvider,
	type World,
	waitingAtGate,
	world,
} from "./people-support.ts";

afterEach(cleanUp);

/** What every refused sign-in is answered, whatever was wrong with it. */
const REFUSED = '{"ok":false,"error":{"code":"unauthenticated","message":"that did not sign you in"}}';

type SessionRow = {
	id: number;
	actor: number;
	token: number | null;
	credential: number | null;
	ended_at: number | null;
	ended_why: string | null;
};
const sessions = async (w: World): Promise<SessionRow[]> =>
	await w.rows("SELECT id, actor, token, credential, ended_at, ended_why FROM sessions ORDER BY id");
type CredentialRow = { id: number; actor: number; kind: string; data: string; revoked_at: number | null };
const credentials = async (w: World): Promise<CredentialRow[]> =>
	await w.rows("SELECT id, actor, kind, data, revoked_at FROM credentials ORDER BY id");
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

/** Accepts an invitation through the provider as `who`, from a browser holding `cookie`, naming `replace`. */
const accept = (w: World, code: string, who: Next | string, cookie: string | null = null, replace?: string) =>
	viaProvider(
		w,
		typeof who === "string" ? { subject: who } : who,
		{ invitation: code, ...(replace === undefined ? {} : { replace }) },
		cookie,
	);
/** Begins accepting an invitation and goes no further: the reply of a begin, which may refuse. */
const beginAccept = (w: World, body: Record<string, unknown>, headers: Sent = {}) =>
	w.post("/api/login/oidc", body, headers);
/** Signs in through the provider as `who`, every request carrying `headers` (an address, a user agent, cookies). */
async function signInWith(w: World, who: Next | string, headers: Sent) {
	const begun = await begin(w, {}, headers);
	const query = await authorize(w, begun, typeof who === "string" ? { subject: who } : who);
	const cookie = [headers.cookie, begun.ceremony].filter(Boolean).join("; ");
	return finish(w, query, { ...headers, cookie });
}

describe("an invitation", () => {
	test("the minute job deletes invitations 30 days after use, revocation or expiry, keeping open ones", async () => {
		const w = await world();
		const used = await invite(w, { name: "robin", expires: "30d" });
		const revoked = await invite(w, { name: "sam", expires: "30d" });
		const expired = await invite(w, { name: "pat", expires: "1d" });
		w.clock.advance(DAY);
		expect((await accept(w, used.code, subjectOf("robin"))).status).toBe(200);
		await w.ok("invitation", { do: "revoke", id: revoked.id });
		w.clock.advance(30 * DAY - 1);
		const open = await invite(w, { name: "lee" });
		await w.instance.minute();
		expect(await w.rows<{ id: number }>("SELECT id FROM invitations ORDER BY id")).toEqual([
			{ id: used.id },
			{ id: revoked.id },
			{ id: expired.id },
			{ id: open.id },
		]);
		w.clock.advance(1);
		await w.instance.minute();
		expect(await w.ok("invitation", { do: "list" })).toMatchObject([{ id: open.id, state: "open" }]);
		expect(await w.rows("SELECT id FROM invitations ORDER BY id")).toEqual([{ id: open.id }]);
		for (const ended of [used, revoked, expired])
			expect((await beginAccept(w, { invitation: ended.code })).status).toBe(404);
		expect((await accept(w, open.code, subjectOf("lee"))).status).toBe(200);
	});

	test("an admin invites a person: the code is in the reply once and nowhere in the database, the log or the stored command", async () => {
		const w = await world();
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
			expect((await w.rows<{ hash: string }>("SELECT hash FROM invitations")).map((row) => row.hash)).toEqual([
				sha256(code),
			]);
			await withWrite(w.instance.app, async (_db) => undefined);
			expect((await w.disk()).includes(code)).toBe(false);
			expect(await w.rows("SELECT outcome FROM commands WHERE id = 'invite-robin-1'")).toEqual([
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

	test("an instance with no identity provider makes no invitation, since nobody could accept it", async () => {
		const w = await world({ idp: null });
		const refused = await w.op("invitation", { do: "create", name: "robin" });
		expect(said(refused)).toBe("400 invalid");
		expect(refused.text).toContain("this instance has no identity provider");
		expect(await w.rows("SELECT id FROM invitations")).toEqual([]);
		// The owner's token still makes a token for a person.
		expect((await w.op("admin", { do: "token.create", actor: "robin", kind: "human" })).status).toBe(200);
	});

	test("accepting through the provider signs the person in: the session rests on the identity, and the person holds the grant the invitation named and nothing else", async () => {
		const w = await world();
		const { code } = await invite(w, { name: "robin", can: ["read", "answer"], project: "scratch" });
		const accepted = await accept(w, code, { subject: subjectOf("robin"), email: "robin@example.com" });
		expect(accepted.status).toBe(200);
		expect(accepted.setCookies[0]).toMatch(
			/^mainworthy_sid=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=7776000$/,
		);
		const cookie = sessionOf(accepted);
		const info = await me(w, jar(cookie));
		expect(info).toMatchObject({
			actor: "robin",
			kind: "human",
			via: "cookie",
			can: [],
			session: 1,
			credentials: { identities: 1 },
		});
		expect(info.projects.map((project) => `${project.key}: ${project.can?.join(",")}`)).toEqual([
			"scratch: read,answer",
		]);
		// The session has the identity under it and no token.
		expect(await credentials(w)).toMatchObject([{ id: 1, kind: "oidc", revoked_at: null }]);
		expect(await sessions(w)).toMatchObject([{ id: 1, token: null, credential: 1, ended_at: null }]);
		// What the grant does not name is refused, on the project and on the instance.
		expect((await w.post("/api/p/scratch/find", {}, jar(cookie))).status).toBe(200);
		const proposed = await w.post(
			"/api/p/scratch/propose",
			{ edits: [{ op: "create", outline: "Mine" }] },
			jar(cookie),
		);
		expect(proposed.status).toBe(403);
		expect((await w.op("admin", { do: "actor.list" }, jar(cookie))).status).toBe(403);
		// The invitation is spent and says so in the list.
		const listed = await w.ok<{ state: string }[]>("invitation", { do: "list" });
		expect(listed.map((row) => row.state)).toEqual(["used"]);
	});

	test("an invitation is used once: a used, an expired, a revoked and a wrong code are refused with the same reply, at its page and at the provider", async () => {
		const clock = clockAt();
		const w = await world({ clock });
		const used = await invite(w, { name: "robin" });
		expect((await accept(w, used.code, subjectOf("robin"))).status).toBe(200);
		const expired = await invite(w, { name: "sam", expires: "1d" });
		const revoked = await invite(w, { name: "pat" });
		expect(await w.ok<unknown>("invitation", { do: "revoke", id: revoked.id })).toEqual({ revoked: true });
		clock.advance(DAY);
		const replies: string[] = [];
		for (const code of [used.code, expired.code, revoked.code, "A".repeat(43)]) {
			const begun = await beginAccept(w, { invitation: code });
			replies.push(`${begun.status} ${begun.setCookies.length} ${begun.text}`);
			// The page that shows an invitation is told the same of all four, too.
			const shown = await w.post("/api/login/invitation", { invitation: code });
			replies.push(`${shown.status} ${shown.setCookies.length} ${shown.text}`);
		}
		expect(new Set(replies).size).toBe(1);
		expect(replies[0]).toStartWith('404 0 {"ok":false,"error":{"code":"not_found"');
		// One withdrawn while its person was at the provider is refused there as any sign-in is.
		const late = await invite(w, { name: "lee", expires: "1d" });
		const begun = await begin(w, { invitation: late.code });
		const query = await authorize(w, begun, { subject: subjectOf("lee") });
		await w.ok("invitation", { do: "revoke", id: late.id });
		const logged = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const refused = await finish(w, query, jar(begun.ceremony));
			expect(`${refused.status} ${sessionOf(refused)} ${refused.text}`).toBe(`401  ${REFUSED}`);
		} finally {
			logged.mockRestore();
		}
		// Nothing of the refused people was made: no credential, no session.
		expect(await credentials(w)).toHaveLength(1);
		expect(await sessions(w)).toHaveLength(1);
		// One millisecond before its end an invitation still works.
		const last = await invite(w, { name: "mo", expires: "1d" });
		clock.advance(DAY - 1);
		expect((await accept(w, last.code, subjectOf("mo"))).status).toBe(200);
	});

	test("two acceptances of one invitation at the same moment: one signs in, the other is refused, and one identity is stored", async () => {
		const w = await world();
		const { code } = await invite(w, { name: "robin" });
		const ceremonies = [];
		for (const subject of ["sub-one", "sub-two"]) {
			const begun = await begin(w, { invitation: code });
			ceremonies.push({ begun, query: await authorize(w, begun, { subject }) });
		}
		const logged = spyOn(console, "warn").mockImplementation(() => {});
		const gate = holdGate(w.instance);
		try {
			// Both have found the invitation good and the provider's answer sound when either may write.
			const waiting = waitingAtGate(w.instance, 2);
			const [one, two] = ceremonies.map(({ begun, query }) => finish(w, query, jar(begun.ceremony)));
			await waiting;
			await gate.release();
			const replies = [await one, await two];
			expect(replies.map((reply) => reply?.status).sort()).toEqual([200, 401]);
			expect(await credentials(w)).toHaveLength(1);
			expect(await sessions(w)).toHaveLength(1);
			expect(logged.mock.calls.map((call) => String(call[0]))).toEqual(["[mainworthy] sign-in refused: invitation"]);
			// The identity that is stored is the one whose acceptance signed in.
			const winner = replies[0]?.status === 200 ? "sub-one" : "sub-two";
			expect((await viaProvider(w, { subject: winner })).status).toBe(200);
			expect((await viaProvider(w, { subject: winner === "sub-one" ? "sub-two" : "sub-one" })).status).toBe(401);
		} finally {
			logged.mockRestore();
		}
	});

	test("the page of an invitation learns who it is for and when it ends, and asking changes nothing", async () => {
		const w = await world();
		const { code, link } = await invite(w, { name: "robin" });
		expect(link).toBe(`${PUBLIC}/invite#${code}`);
		await withWrite(w.instance.app, async (_db) => undefined);
		const before = await w.written();
		for (let i = 0; i < 2; i++) {
			const shown = await w.post("/api/login/invitation", { invitation: code });
			expect(shown.body).toEqual({
				ok: true,
				result: { invitation: { name: "robin", purpose: "join", expiresAt: T0 + 3 * DAY } },
			});
		}
		await withWrite(w.instance.app, async (_db) => undefined);
		expect((await w.written()).equals(before)).toBe(true);
		expect((await accept(w, code, subjectOf("robin"))).status).toBe(200);
	});

	/** A refusal in one line, with what it carries for a page: `409 conflict {"signedInAs":"pat"}`. */
	const refusal = (reply: { status: number; text: string }): string => {
		const error = (JSON.parse(reply.text) as { error?: { code?: string; details?: unknown } }).error;
		return `${reply.status} ${error?.code} ${JSON.stringify(error?.details)}`;
	};

	test("a browser signed in as somebody else is refused until it names who it asked about, and only the session it held ends then", async () => {
		const w = await world();
		const robin = await joined(w, "robin");
		const elsewhere = sessionOf(await signIn(w, "robin"));
		const pat = await joined(w, "pat");
		const { code } = await invite(w, { name: "sam" });
		const refused = await beginAccept(w, { invitation: code }, jar(robin));
		expect(`${refused.status} ${refused.text}`).toBe(
			'409 {"ok":false,"error":{"code":"conflict","message":"this browser is signed in as robin, and the invitation is for somebody else. Send replace: \\"robin\\" to sign robin out of this browser and accept it","details":{"signedInAs":"robin"}}}',
		);
		expect(refused.setCookies).toEqual([]);
		// Refusing changed nothing: the invitation still works and Robin is still signed in.
		expect(await w.status(jar(robin))).toBe(200);
		const replaced = await accept(w, code, subjectOf("sam"), robin, "robin");
		expect(replaced.status).toBe(200);
		expect((await me(w, jar(sessionOf(replaced)))).actor).toBe("sam");
		expect(await w.status(jar(robin))).toBe(401);
		// Robin's other browser and Pat's are nobody's to end here.
		expect(await w.status(jar(elsewhere))).toBe(200);
		expect(await w.status(jar(pat))).toBe(200);
		expect(await sessions(w)).toMatchObject([
			{ ended_why: "signed-out" },
			{ ended_at: null },
			{ ended_at: null },
			{ ended_at: null },
		]);
	});

	test("saying yes to one person signs no other person out: the browser is asked again, about who it holds now", async () => {
		// The page asked "you are signed in as robin, go on as sam?". Before the answer was sent another tab signed
		// Pat in, so the request carries Pat's cookie and a yes that was about Robin.
		const w = await world();
		const robin = await joined(w, "robin");
		const pat = await joined(w, "pat");
		const { code } = await invite(w, { name: "sam" });
		const refused = await beginAccept(w, { invitation: code, replace: "robin" }, jar(pat));
		expect(refusal(refused)).toBe('409 conflict {"signedInAs":"pat"}');
		expect(refused.setCookies).toEqual([]);
		// The same when Pat's tab signed in while the person was at the provider: the answer comes back with Pat's
		// cookie and a yes about Robin.
		const begun = await begin(w, { invitation: code, replace: "robin" }, jar(robin));
		const query = await authorize(w, begun, { subject: subjectOf("sam") });
		const back = await finish(w, query, jar(pat, begun.ceremony));
		expect(refusal(back)).toBe('409 conflict {"signedInAs":"pat"}');
		expect(sessionOf(back)).toBe("");
		expect(await w.status(jar(pat))).toBe(200);
		expect(await w.status(jar(robin))).toBe(200);
		expect((await sessions(w)).filter((row) => row.ended_at !== null)).toEqual([]);
		// A name in other letters is another name.
		expect((await beginAccept(w, { invitation: code, replace: "PAT" }, jar(pat))).status).toBe(409);
		// Asked about Pat, the page says so and goes on.
		expect((await accept(w, code, subjectOf("sam"), pat, "pat")).status).toBe(200);
		expect(await w.status(jar(pat))).toBe(401);
		expect(await w.status(jar(robin))).toBe(200);
	});

	test("replace is a name: a bare yes is refused as wrong input, before the invitation is looked at", async () => {
		const w = await world();
		const robin = await joined(w, "robin");
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
			const reply = await beginAccept(w, { invitation, replace }, jar(robin));
			replies.push(said(reply));
		}
		// Nor is a code that cannot be one, or a body with more in it.
		replies.push(said(await beginAccept(w, { invitation: "" }, jar(robin))));
		replies.push(said(await beginAccept(w, { invitation: "x".repeat(129) }, jar(robin))));
		replies.push(said(await beginAccept(w, { invitation: code, password: "x" }, jar(robin))));
		expect(replies).toEqual(Array.from({ length: 9 }, () => "400 invalid"));
		expect(await w.status(jar(robin))).toBe(200);
		expect((await sessions(w)).filter((row) => row.ended_at !== null)).toEqual([]);
	});

	test("a name given where nobody else is signed in ends nothing: no session, or the invited person's own", async () => {
		// The page may have asked a moment before a sign-out.
		const w = await world();
		const robin = await joined(w, "robin");
		const forSam = await invite(w, { name: "sam" });
		const joinedNow = await accept(w, forSam.code, subjectOf("sam"), null, "robin");
		expect(joinedNow.status).toBe(200);
		expect(await w.status(jar(robin))).toBe(200);
		// Signed in as Sam, Sam's own recovery link is accepted whatever name comes with it. A recovery ends Sam's
		// sessions, as it always does, and Robin's stays.
		const recovery = await invite(w, { name: "sam" });
		const recovered = await accept(w, recovery.code, "sub-sam-again", sessionOf(joinedNow), "robin");
		expect(recovered.status).toBe(200);
		expect((await me(w, jar(sessionOf(recovered)))).actor).toBe("sam");
		expect(await w.status(jar(robin))).toBe(200);
	});

	test("who the browser holds is asked again in the commit: a session that became another person's while the acceptance waited is not ended", async () => {
		// No request moves a session to another person today: a cookie names one session, and a session keeps its
		// person. The commit is not allowed to rest on that. So the test moves the row itself while it holds the
		// gate, behind which the acceptance waits with a yes that was about Robin.
		const w = await world();
		const robin = await joined(w, "robin");
		await joined(w, "pat");
		const { code } = await invite(w, { name: "sam" });
		const [robins, pats] = await sessions(w);
		const begun = await begin(w, { invitation: code, replace: "robin" }, jar(robin));
		const query = await authorize(w, begun, { subject: subjectOf("sam") });
		const gate = holdGate(w.instance);
		const waiting = waitingAtGate(w.instance, 1);
		const accepting = finish(w, query, jar(robin, begun.ceremony));
		await waiting;
		await gate.run(
			async (db) =>
				await pgRun(
					w.instance.app,
					"UPDATE sessions SET actor = ?, credential = ? WHERE id = ?",
					[pats?.actor ?? 0, pats?.credential ?? 0, robins?.id ?? 0],
					db,
				),
		);
		await gate.release();
		const busy = await accepting;
		expect(refusal(busy)).toBe("503 busy undefined");
		expect(sessionOf(busy)).toBe("");
		const refused = await beginAccept(w, { invitation: code, replace: "robin" }, jar(robin));
		expect(refusal(refused)).toBe('409 conflict {"signedInAs":"pat"}');
		expect(refused.setCookies).toEqual([]);
		// The session is Pat's now and still works, and the invitation is still good.
		expect((await me(w, jar(robin))).actor).toBe("pat");
		expect((await sessions(w)).filter((row) => row.ended_at !== null)).toEqual([]);
		expect((await accept(w, code, subjectOf("sam"))).status).toBe(200);
	});

	test.each(["end", "idle"] as const)(
		"a concurrent sign-in whose cookie an invitation response replaces stays listed until %s",
		async (until) => {
			const w = await world();
			const robin = await joined(w, "robin");
			const pat = await joined(w, "pat");
			const { code } = await invite(w, { name: "sam" });
			let release = () => {};
			let arrived = () => {};
			const started = new Promise<void>((resolve) => {
				arrived = resolve;
			});
			const resume = new Promise<void>((resolve) => {
				release = resolve;
			});
			try {
				// Sam's provider is slow to answer; meanwhile another tab of the same browser signs Pat in.
				const begun = await begin(w, { invitation: code, replace: "robin" }, jar(robin));
				const query = await authorize(w, begun, {
					subject: subjectOf("sam"),
					twist: {
						held: () => {
							arrived();
							return resume;
						},
					},
				});
				const accepting = finish(w, query, jar(robin, begun.ceremony));
				await started;
				const concurrent = await signInWith(w, subjectOf("pat"), { ...jar(robin), "user-agent": "concurrent tab" });
				expect(concurrent.status).toBe(200);
				const tab = sessionOf(concurrent);
				expect((await me(w, jar(tab))).actor).toBe("pat");
				release();
				const accepted = await accepting;
				expect(accepted.status).toBe(200);
				expect(sessionOf(accepted)).not.toBe(tab);
				expect((await me(w, jar(sessionOf(accepted)))).actor).toBe("sam");
				expect(await w.status(jar(robin))).toBe(401);
				expect(await w.status(jar(tab))).toBe(200);
				const listed = await w.ok<Listed[]>("session", { do: "list" }, jar(pat));
				const lingering = listed.find((row) => row.userAgent === "concurrent tab");
				expect(lingering).toMatchObject({ openedWith: "oidc", current: false });
				if (!lingering) throw new Error("the concurrent session was not listed");
				if (until === "end") {
					await w.ok("session", { do: "end", id: lingering.id }, jar(pat));
					expect(await w.status(jar(pat))).toBe(200);
				} else w.clock.advance(14 * DAY);
				expect(await w.status(jar(tab))).toBe(401);
			} finally {
				release();
			}
		},
	);

	test("who may invite whom: a new person is any admin's to invite, a person who exists is the owner's or their own", async () => {
		const w = await world();
		const robin = await joined(w, "robin", { can: ["read", "admin"] });
		const sam = await joined(w, "sam");
		expect(must(await prove(w, robin, "robin"))).toEqual({ proven: true });
		// Robin administers and is not the owner.
		expect((await invite(w, { name: "pat" }, jar(robin))).purpose).toBe("join");
		const forSam = await w.op("invitation", { do: "create", name: "sam" }, jar(robin));
		expect(forSam.status).toBe(403);
		expect((await w.op("invitation", { do: "create", name: OWNER }, jar(robin))).status).toBe(403);
		expect((await invite(w, { name: "robin" }, jar(robin))).purpose).toBe("recover");
		expect((await invite(w, { name: "sam" })).purpose).toBe("recover");
		// Sam administers nothing, and an agent that administers is not a person.
		expect((await w.op("invitation", { do: "list" }, jar(sam))).status).toBe(403);
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
		expect((await beginAccept(w, { invitation: first.code })).status).toBe(404);
		expect((await accept(w, second.code, subjectOf("mo"))).status).toBe(200);
	});
});

describe("recovery", () => {
	test("a recovery invitation revokes every identity and ends every session of the person when it is accepted, and not before", async () => {
		const w = await world();
		const first = await joined(w, "robin");
		const byToken = sessionOf(
			await w.post("/api/login", { token: await tokenFor(w, { actor: "robin", kind: "human" }) }),
		);
		const bystander = await joined(w, "sam");
		const recovery = await invite(w, { name: "robin" });
		expect(recovery.purpose).toBe("recover");
		// Made, and not yet accepted: nothing of Robin's has changed.
		expect([await w.status(jar(first)), await w.status(jar(byToken))]).toEqual([200, 200]);
		expect((await signIn(w, "robin")).status).toBe(200);
		expect((await credentials(w)).map((row) => row.revoked_at)).toEqual([null, null]);
		const shown = await w.post("/api/login/invitation", { invitation: recovery.code });
		expect(shown.body).toMatchObject({ ok: true, result: { invitation: { name: "robin", purpose: "recover" } } });

		const accepted = await accept(w, recovery.code, "new-robin");
		expect(accepted.status).toBe(200);
		expect([
			await w.status(jar(first)),
			await w.status(jar(byToken)),
			await w.status(jar(sessionOf(accepted))),
			await w.status(jar(bystander)),
		]).toEqual([401, 401, 200, 200]);
		const logged = spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect((await signIn(w, "robin")).status).toBe(401);
		} finally {
			logged.mockRestore();
		}
		expect((await viaProvider(w, { subject: "new-robin" })).status).toBe(200);
		expect((await signIn(w, "sam")).status).toBe(200);
		// Robin's old identity is revoked, the new one stands, and Sam's was not touched.
		expect((await credentials(w)).map((row) => `${row.actor} ${row.revoked_at === null ? "live" : "revoked"}`)).toEqual(
			["3 revoked", "4 live", "3 live"],
		);
		// What Robin may do was not changed by recovering.
		expect((await me(w, jar(sessionOf(accepted)))).projects.map((project) => project.can)).toEqual([["read"]]);
	});

	test("accepted recovery revokes the person's personal CLI and admin-issued tokens, leaving other actors alone", async () => {
		const w = await world();
		const cookie = await joined(w, "robin");
		expect(must(await prove(w, cookie, "robin"))).toEqual({ proven: true });
		const personal = PersonalTokenCreated.parse(
			await w.ok("credential", { do: "token.create", label: "my CLI" }, jar(cookie)),
		);
		const issued = await tokenFor(w, { actor: "robin", kind: "human" });
		const byToken = sessionOf(await w.post("/api/login", { token: personal.token }));
		const bystander = await tokenFor(w, { actor: "sam", kind: "human", can: ["read"] });
		const otherSession = sessionOf(await w.post("/api/login", { token: bystander }));
		const recovery = await invite(w, { name: "robin" });
		expect([await w.status(bearer(personal.token)), await w.status(bearer(issued))]).toEqual([200, 200]);
		// Going to the provider to accept it, and not coming back, changes nothing either.
		await authorize(w, await begin(w, { invitation: recovery.code }), { subject: "new-robin" });
		expect([await w.status(bearer(personal.token)), await w.status(bearer(issued))]).toEqual([200, 200]);
		const accepted = await accept(w, recovery.code, "new-robin");
		expect(accepted.status).toBe(200);
		expect([
			await w.status(bearer(personal.token)),
			await w.status(bearer(issued)),
			await w.status(jar(byToken)),
			await w.status(jar(cookie)),
			await w.status(jar(sessionOf(accepted))),
			await w.status(bearer(bystander)),
			await w.status(jar(otherSession)),
			await w.status(bearer(TOKEN)),
		]).toEqual([401, 401, 401, 401, 200, 200, 200, 200]);
	});

	test("a personal token revoked by recovery cannot write a proposal queued behind recovery", async () => {
		const w = await world();
		const cookie = await joined(w, "robin", { can: ["read", "produce"], project: "scratch" });
		expect(must(await prove(w, cookie, "robin"))).toEqual({ proven: true });
		const personal = PersonalTokenCreated.parse(
			await w.ok("credential", { do: "token.create", label: "queued CLI" }, jar(cookie)),
		);
		const recovery = await invite(w, { name: "robin" });
		const begun = await begin(w, { invitation: recovery.code });
		const query = await authorize(w, begun, { subject: "new-robin" });
		const gate = holdGate(w.instance);
		try {
			const recoveryQueued = waitingAtGate(w.instance, 1);
			const accepting = finish(w, query, jar(begun.ceremony));
			await recoveryQueued;
			const proposalQueued = waitingAtGate(w.instance, 1);
			const proposal = w.post(
				"/api/p/scratch/propose",
				{ edits: [{ op: "create", outline: "Must not be written" }], cmd: "recovery-queued-proposal" },
				bearer(personal.token),
			);
			await proposalQueued;
			const statusQueued = waitingAtGate(w.instance, 1);
			const status = w.status(bearer(personal.token));
			await statusQueued;
			await gate.release();
			expect(await status).toBe(401);
			expect((await accepting).status).toBe(200);
			expect(said(await proposal)).toBe("401 unauthenticated");
			expect(await w.rows("SELECT id FROM cases")).toEqual([]);
			expect(await w.rows("SELECT id FROM commands WHERE id = 'recovery-queued-proposal'")).toEqual([]);
		} finally {
			await gate.release();
		}
	});

	test("owner recovery also revokes the configured owner token, even when it is the last one", async () => {
		const w = await world();
		const before = sessionOf(await w.post("/api/login", { token: TOKEN }));
		const recovery = await invite(w, { name: OWNER });
		expect(await w.status(bearer(TOKEN))).toBe(200);
		const accepted = await accept(w, recovery.code, subjectOf(OWNER));
		expect(accepted.status).toBe(200);
		const cookie = sessionOf(accepted);
		expect([await w.status(bearer(TOKEN)), await w.status(jar(before)), await w.status(jar(cookie))]).toEqual([
			401, 401, 200,
		]);
		const restarted = await bootstrap(w.instance.app);
		expect(restarted.warnings.join("\n")).toContain("was revoked");
		expect(await w.status(bearer(TOKEN))).toBe(401);
		expect((await signIn(w, OWNER)).status).toBe(200);
		const replacement = "replacement-owner-secret-0123456789";
		w.instance.app.config.ownerToken = replacement;
		await bootstrap(w.instance.app);
		expect([await w.status(bearer(TOKEN)), await w.status(bearer(replacement)), await w.status(jar(cookie))]).toEqual([
			401, 200, 200,
		]);
	});
});

describe("what a signed-in caller sees and ends", () => {
	test("session list shows the caller's sessions and marks the current one; session end ends one's own and not somebody else's", async () => {
		const w = await world();
		const laptop = await joined(w, "robin");
		const phone = sessionOf(await signInWith(w, subjectOf("robin"), { "user-agent": "Phone/1.0" }));
		const sam = await joined(w, "sam");
		const listed = await w.ok<Listed[]>("session", { do: "list" }, jar(phone));
		expect(listed).toMatchObject([
			{ id: 1, openedWith: "oidc", current: false },
			{ id: 2, openedWith: "oidc", current: true, userAgent: "Phone/1.0" },
		]);
		expect(JSON.stringify(listed)).not.toContain("hash");
		// A token is no browser's session: the list is the same, and none of it is the current one.
		const viaToken = await tokenFor(w, { actor: "robin", kind: "human" });
		expect((await w.ok<Listed[]>("session", { do: "list" }, bearer(viaToken))).map((row) => row.current)).toEqual([
			false,
			false,
		]);
		// Somebody else's: not listed, and not ended, whether the id is theirs or nobody's.
		expect((await w.op("session", { do: "list", actor: "sam" }, jar(phone))).status).toBe(403);
		expect((await w.op("session", { do: "list", actor: "nobody" }, jar(phone))).status).toBe(403);
		const notMine = await w.op("session", { do: "end", id: 3 }, jar(phone));
		const noSuch = await w.op("session", { do: "end", id: 99 }, jar(phone));
		expect([notMine.status, noSuch.status]).toEqual([404, 404]);
		expect(notMine.text.replace("3", "99")).toBe(noSuch.text);
		expect(await w.status(jar(sam))).toBe(200);
		// One's own, from another device.
		expect(await w.ok<unknown>("session", { do: "end", id: 1 }, jar(phone))).toEqual({
			ended: true,
			current: false,
		});
		expect([await w.status(jar(laptop)), await w.status(jar(phone))]).toEqual([401, 200]);
		expect((await w.op("session", { do: "end", id: 1 }, jar(phone))).status).toBe(404);
		// And the one the request itself came by.
		expect(await w.ok<unknown>("session", { do: "end", id: 2 }, jar(phone))).toEqual({
			ended: true,
			current: true,
		});
		expect(await w.status(jar(phone))).toBe(401);
		expect((await sessions(w)).map((row) => row.ended_why)).toEqual(["ended", "ended", null]);
	});

	test("an admin who is a person lists and ends anyone's sessions, and an agent with admin does not", async () => {
		const w = await world();
		const robin = await joined(w, "robin");
		const admin = await joined(w, "sam", { can: ["read", "admin"] });
		const agent = await tokenFor(w, { actor: "helper", kind: "agent", can: ["read", "admin"] });
		expect((await w.op("session", { do: "list", actor: "robin" }, bearer(agent))).status).toBe(403);
		expect((await w.op("session", { do: "end", id: 1 }, bearer(agent))).status).toBe(404);
		expect(await w.status(jar(robin))).toBe(200);
		// The agent's own are its own to see: it has none.
		expect(await w.ok<unknown>("session", { do: "list" }, bearer(agent))).toEqual([]);

		const seen = await w.ok<Listed[]>("session", { do: "list", actor: "robin" }, jar(admin));
		expect(seen).toMatchObject([{ id: 1, openedWith: "oidc", current: false }]);
		expect((await w.op("session", { do: "list", actor: "nobody" }, jar(admin))).status).toBe(404);
		expect(await w.ok<unknown>("session", { do: "end", id: 1 }, jar(admin))).toEqual({
			ended: true,
			current: false,
		});
		expect(await w.status(jar(robin))).toBe(401);
		// The owner's token does the same, and a session opened with a token says so.
		const again = sessionOf(await signIn(w, "robin"));
		await w.post("/api/login", { token: TOKEN });
		expect(await w.ok<Listed[]>("session", { do: "list" })).toMatchObject([{ openedWith: "token" }]);
		expect(await w.ok<unknown>("session", { do: "end", id: 3 })).toEqual({ ended: true, current: false });
		expect(await w.status(jar(again))).toBe(401);
	});

	test("a session that is no longer alive is not in the list: ended, past a lifetime, or its token revoked", async () => {
		const clock = clockAt();
		const w = await world({ clock });
		const token = await tokenFor(w, { actor: "robin", kind: "human", can: ["read"] });
		const robin = sessionOf(await w.post("/api/login", { token }));
		const cookie = await joined(w, "sam");
		const idle = sessionOf(await signIn(w, "sam"));
		clock.advance(13 * DAY);
		expect([await w.status(jar(cookie)), await w.status(jar(robin))]).toEqual([200, 200]);
		clock.advance(2 * DAY);
		// The use a moment ago is known though it is not written yet.
		const listed = await w.ok<(Listed & { lastUsedAt: number })[]>("session", { do: "list" }, jar(cookie));
		expect(listed).toMatchObject([{ id: 2, current: true, lastUsedAt: T0 + 15 * DAY }]);
		expect(await w.status(jar(idle))).toBe(401);
		expect(await w.ok<Listed[]>("session", { do: "list", actor: "robin" })).toHaveLength(1);
		await w.ok("admin", { do: "token.revoke", id: 2 });
		expect(await w.ok<Listed[]>("session", { do: "list", actor: "robin" })).toEqual([]);
	});

	test("a caller with a token and no grant at all runs a self operation and no other, and a pipeline runs none", async () => {
		const w = await world();
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
			if (op.effect === "service") {
				expect(reply.status).toBe(401);
				continue;
			}
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

	test("forgetting a person ends their sessions and revokes their identities and their invitations", async () => {
		const w = await world();
		const cookie = await joined(w, "robin");
		const pending = await invite(w, { name: "robin" });
		expect(await w.status(jar(cookie))).toBe(200);
		await w.ok("admin", { do: "actor.forget", name: "robin" });
		expect(await w.status(jar(cookie))).toBe(401);
		expect(await sessions(w)).toMatchObject([{ ended_why: "forgotten" }]);
		// Revoked, and what they held is erased: no subject of a forgotten person stays behind.
		expect(await credentials(w)).toEqual([{ id: 1, actor: 3, kind: "oidc", data: "", revoked_at: expect.any(Number) }]);
		expect(await w.rows("SELECT handle, label FROM credentials")).toEqual([{ handle: null, label: "" }]);
		expect(await w.rows("SELECT used_at, revoked_at FROM invitations ORDER BY id")).toMatchObject([
			{ used_at: expect.any(Number), revoked_at: null },
			{ used_at: null, revoked_at: expect.any(Number) },
		]);
		const logged = spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect((await signIn(w, "robin")).status).toBe(401);
			expect((await beginAccept(w, { invitation: pending.code })).status).toBe(404);
		} finally {
			logged.mockRestore();
		}
		// The name is free again, and whoever takes it is a new person with none of what the first one had, though
		// the identity at the provider is the same.
		const next = await joined(w, "robin");
		expect((await me(w, jar(next))).actor).toBe("robin");
		expect(await w.status(jar(cookie))).toBe(401);
	});

	test.each([false, true])(
		"forgetting erases stored attribution and access labels without losing replay protection, legacy evidence: %s",
		async (legacy) => {
			const w = await world();
			const name = "erasure-person";
			const cookie = await joined(w, name);
			await tokenFor(w, { actor: name, kind: "human", label: `${name}'s script`, cmd: "create-secret-01" });
			await w.ok("admin", { do: "token.revoke", id: 2 });
			await tokenFor(w, { actor: name, kind: "human", label: `${name}'s active script` });
			expect(must(await prove(w, cookie, name))).toEqual({ proven: true });
			for (const where of ["work", "home"])
				expect(
					must(
						await viaProvider(
							w,
							{ subject: `${name}-${where}`, email: `${name}@${where}.example` },
							{ link: true },
							cookie,
						),
					),
				).toEqual({ linked: true });
			await w.ok("credential", { do: "remove", id: 2 }, jar(cookie));
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
				roles: [],
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
			const storedEvidence = await w.rows<{ evidence: string }>("SELECT evidence FROM questions ORDER BY id");
			expect(storedEvidence.map((row) => JSON.parse(row.evidence))).toMatchObject([{ authorId: 3 }, { finderId: 3 }]);
			expect(JSON.stringify(storedEvidence)).not.toContain(name);
			if (legacy) {
				await withWrite(w.instance.app, async (db) => {
					await pgRun(
						w.instance.app,
						"UPDATE questions SET evidence = jsonb_set(evidence::jsonb - 'authorId', '{author}', to_jsonb(?::text))::text WHERE kind = 'adopt'",
						[name],
						db,
					);
					await pgRun(
						w.instance.app,
						"UPDATE questions SET evidence = jsonb_set(evidence::jsonb, '{finder}', to_jsonb(?::text))::text WHERE kind = 'finding'",
						[name],
						db,
					);
				});
			}
			const questionBindings = async () =>
				await w.rows("SELECT id, evidence_hash, basis, rev FROM questions ORDER BY id");
			const bindings = await questionBindings();
			const ledger = async () =>
				await w.rows<{ id: string; actor: number; op: string; request: string }>(
					"SELECT id, actor, op, request FROM commands ORDER BY id",
				);
			const before = await ledger();
			w.clock.advance(HOUR);
			const forgotten = await w.ok<{ forgotten: string; tokensRevoked: number }>("admin", {
				do: "actor.forget",
				name,
				cmd: "forget-person-01",
			});
			expect(forgotten).toEqual({ forgotten: "forgotten-3", tokensRevoked: 1 });
			expect((await ledger()).filter((row) => row.id !== "forget-person-01")).toEqual(before);
			const tables = await w.rows<{ name: string }>(
				"SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
			);
			for (const table of tables) {
				const rows = await w.rows(`SELECT * FROM "${table.name.replaceAll('"', '""')}"`);
				expect(JSON.stringify(rows), table.name).not.toContain(name);
			}
			expect(await questionBindings()).toEqual(bindings);
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
			expect(await w.rows("SELECT label, revoked_at FROM tokens WHERE actor = 3 ORDER BY id")).toEqual([
				{ label: "", revoked_at: T0 },
				{ label: "", revoked_at: T0 + HOUR },
			]);
			expect(
				await w.rows("SELECT handle, data, label, revoked_at FROM credentials WHERE actor = 3 ORDER BY id"),
			).toEqual([
				{ handle: null, data: "", label: "", revoked_at: T0 + HOUR },
				{ handle: null, data: "", label: "", revoked_at: T0 },
				{ handle: null, data: "", label: "", revoked_at: T0 + HOUR },
			]);
			expect(await w.ok<unknown>("admin", grant)).toEqual({
				actor: "forgotten-3",
				project: "scratch",
				can: ["read", "produce"],
				roles: [],
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
		const w = await world();
		await tokenFor(w, { actor: "dana", kind: "agent" });
		const app = w.instance.app;
		// An archive made before such names were refused: two actors hold the pseudonyms dana would be given.
		for (const name of ["forgotten-3", "forgotten-3-2"])
			await withWrite(
				app,
				async (db) =>
					await pgRun(app, "INSERT INTO actors (org, kind, name, created_at) VALUES (1, 'human', ?, 0)", [name], db),
			);
		const names = async (): Promise<string[]> =>
			(await w.rows<{ name: string }>("SELECT name FROM actors ORDER BY id")).map((row) => row.name);
		expect(await w.ok("admin", { do: "actor.forget", name: "dana" })).toMatchObject({ forgotten: "forgotten-3-3" });
		expect(await names()).toEqual(["policy", "kim", "forgotten-3-3", "forgotten-3", "forgotten-3-2"]);
		// Forgetting the one named forgotten-3 (id 4) gives it forgotten-4, and forgetting dana again, by the name
		// history calls her, keeps hers, though forgotten-3 is free by now.
		expect(await w.ok("admin", { do: "actor.forget", name: "forgotten-3" })).toMatchObject({
			forgotten: "forgotten-4",
		});
		w.clock.advance(HOUR);
		expect(await w.ok("admin", { do: "actor.forget", name: "forgotten-3-3" })).toMatchObject({
			forgotten: "forgotten-3-3",
		});
		expect(await names()).toEqual(["policy", "kim", "forgotten-3-3", "forgotten-4", "forgotten-3-2"]);
		// The second time is not a second forgetting: she was forgotten at the first.
		expect(await w.rows<{ disabled_at: number }>("SELECT disabled_at FROM actors WHERE id = 3")).toEqual([
			{ disabled_at: T0 },
		]);
	});
});

describe("an upgrade and an import", () => {
	test("a sign-in that waits at the gate across an import does not sign in whoever took the ids afterwards", async () => {
		const w = await world();
		const archive = await (await fetch(`${w.instance.url}/api/export`, { headers: bearer(TOKEN) })).text();
		// An import is taken only by an instance that holds its owner and nothing else, so the owner is the
		// person whose ids an import gives away. The owner has an identity, by a recovery link of their own.
		const recovery = await invite(w, { name: OWNER });
		expect((await accept(w, recovery.code, subjectOf(OWNER))).status).toBe(200);
		const before = { actor: (await credentials(w))[0]?.actor, credential: (await credentials(w))[0]?.id };
		const begun = await begin(w);
		const query = await authorize(w, begun, { subject: subjectOf(OWNER) });
		const logged = spyOn(console, "warn").mockImplementation(() => {});
		const path = `${scratch()}/instance.jsonl`;
		await Bun.write(path, archive);
		const gate = holdGate(w.instance);
		try {
			let waiting = waitingAtGate(w.instance, 1);
			const importing = runArchive(w.instance.app, {
				op: "import",
				path,
				now: w.clock.now(),
				mode: w.instance.app.config.mode,
				owner: w.instance.app.config.owner,
				ownerToken: w.instance.app.config.ownerToken,
			});
			await waiting;
			// Behind the import: the owner the archive brings has the actor id the owner had, and is given an
			// identity under the credential id the old one had. It is another identity.
			const taken = withWrite(w.instance.app, async (db) => {
				await pgRun(
					w.instance.app,
					"INSERT INTO credentials (id, actor, kind, handle, data, label, created_at) VALUES (?, ?, 'oidc', ?, '{}', 'Example ID', ?)",
					[before.credential ?? 0, before.actor ?? 0, `${w.idp?.issuer}#somebody-else`, T0],
					db,
				);
			});
			// Behind both: the sign-in, whose answer the provider gave for the identity as it was.
			waiting = waitingAtGate(w.instance, 1);
			const signingIn = finish(w, query, jar(begun.ceremony));
			await waiting;
			await gate.release();
			expect((await importing).ok).toBe(true);
			await taken;
			const refused = await signingIn;
			expect(`${refused.status} ${sessionOf(refused)} ${refused.text}`).toBe(`401  ${REFUSED}`);
			expect(await sessions(w)).toEqual([]);
			expect(await credentials(w)).toMatchObject([{ id: before.credential, actor: before.actor, revoked_at: null }]);
			// The import ended every ceremony under way, this one among them.
			expect(logged.mock.calls.map((call) => String(call[0]))).toEqual(["[mainworthy] sign-in refused: challenge"]);
		} finally {
			await gate.release();
			logged.mockRestore();
		}
	});
});

describe("the limit on failed attempts", () => {
	// Every request of a `proxied` world comes from the address it names, as a visitor behind a proxy does.
	const address = (n: number): Sent => from(`203.0.113.${n}`);
	/** Runs with the log silenced: a refused sign-in writes a line. */
	async function quietly<T>(run: () => Promise<T>): Promise<T> {
		const logged = spyOn(console, "warn").mockImplementation(() => {});
		try {
			return await run();
		} finally {
			logged.mockRestore();
		}
	}

	test("five refused answers from one address block the address for a token, and the provider's right answer is not a guess", async () => {
		const clock = clockAt();
		const w = await world({ clock, proxied: true });
		await joined(w, "robin");
		await quietly(async () => {
			for (let n = 1; n <= 5; n++)
				expect(said(await signInWith(w, `stranger-${n}`, address(1)))).toBe("401 unauthenticated");
			expect(said(await signInWith(w, "stranger-6", address(1)))).toBe("429 limited, retry after 1");
			// The count is the instance's one: the address is blocked for the owner's token, which a person chose.
			const token = await w.get("/api/session", { ...address(1), ...bearer(TOKEN) });
			expect(said(token)).toBe("429 limited, retry after 1");
			// The provider vouching for Robin is no guess, blocked address or not; another address is not blocked.
			expect(said(await signInWith(w, subjectOf("robin"), address(1)))).toBe("200");
			expect(said(await signInWith(w, "stranger-7", address(2)))).toBe("401 unauthenticated");
			clock.advance(1000);
			// That success did not clear the address: its next failure doubles the block.
			expect(said(await signInWith(w, "stranger-8", address(1)))).toBe("401 unauthenticated");
			expect(said(await w.get("/api/session", { ...address(1), ...bearer(TOKEN) }))).toBe("429 limited, retry after 2");
		});
	});

	test("a wrong invitation code is counted under the address, where the page looks at it and where the provider is asked; a right one passes a blocked address", async () => {
		const w = await world({ proxied: true });
		const { code } = await invite(w, { name: "robin" });
		const wrong = (n: number): string => `${String(n).padStart(2, "0")}${"x".repeat(41)}`;
		await quietly(async () => {
			const replies: string[] = [];
			for (let n = 1; n <= 3; n++) replies.push(said(await beginAccept(w, { invitation: wrong(n) }, address(1))));
			for (let n = 4; n <= 5; n++)
				replies.push(said(await w.post("/api/login/invitation", { invitation: wrong(n) }, address(1))));
			expect(replies).toEqual(Array.from({ length: 5 }, () => "404 not_found"));
			// Blocked: a wrong code is answered 429 on both routes, and another address is not affected.
			expect(said(await beginAccept(w, { invitation: wrong(6) }, address(1)))).toBe("429 limited, retry after 1");
			expect(said(await w.post("/api/login/invitation", { invitation: wrong(7) }, address(1)))).toBe(
				"429 limited, retry after 1",
			);
			expect(said(await w.post("/api/login/invitation", { invitation: wrong(8) }, address(2)))).toBe("404 not_found");
			// The right code is 256 random bits the server made: it is looked at during the block, and it is good.
			expect(said(await w.post("/api/login/invitation", { invitation: code }, address(1)))).toBe("200");
			const begun = await begin(w, { invitation: code }, address(1));
			const query = await authorize(w, begun, { subject: subjectOf("robin") });
			expect(said(await finish(w, query, { ...address(1), ...jar(begun.ceremony) }))).toBe("200");
		});
	});

	test("a request from the loopback address, which behind a proxy is everybody's, is not counted by its address", async () => {
		const w = await world();
		await joined(w, "robin");
		await quietly(async () => {
			for (let n = 1; n <= 12; n++)
				expect(said(await viaProvider(w, { subject: `stranger-${n}` }))).toBe("401 unauthenticated");
			expect(said(await signIn(w, "robin"))).toBe("200");
			expect(await w.status(bearer(TOKEN))).toBe(200);
		});
	});

	test("a session opened through the provider says where it was opened and last used from, and one whose token has reached its end is not listed", async () => {
		const clock = clockAt();
		const w = await world({ clock, proxied: true });
		const { code } = await invite(w, { name: "robin", can: ["read"], project: "scratch" });
		const begun = await begin(w, { invitation: code }, address(1));
		const query = await authorize(w, begun, { subject: subjectOf("robin") });
		const accepted = sessionOf(await finish(w, query, { ...address(1), ...jar(begun.ceremony) }));
		const again = sessionOf(await signInWith(w, subjectOf("robin"), address(2)));
		expect(await w.rows("SELECT id, created_addr, last_seen_addr FROM sessions ORDER BY id")).toEqual([
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
		const listed = await w.ok<Row[]>("session", { do: "list" }, { ...jar(accepted), ...address(4) });
		expect(listed.map((row) => `${row.id} ${row.openedWith} ${row.createdFrom} ${row.lastUsedFrom}`)).toEqual([
			// The request that asked is this session's latest use, known before it is written.
			"1 oidc 203.0.113.1 203.0.113.4",
			"2 oidc 203.0.113.2 203.0.113.2",
			"3 token 203.0.113.3 203.0.113.3",
		]);
		// The token reaches its end: its session is refused, and the list says so too. The others live on.
		clock.advance(DAY);
		expect([await w.status(jar(sessionOf(byToken))), await w.status(jar(again))]).toEqual([401, 200]);
		const after = await w.ok<Row[]>("session", { do: "list" }, jar(accepted));
		expect(after.map((row) => row.id)).toEqual([1, 2]);
	});
});

describe("what the pages of the web UI asked of the server", () => {
	test("the session says whether the caller owns the instance, which decides who may make a recovery link for somebody else", async () => {
		const w = await world();
		const robin = await joined(w, "robin", { can: ["read", "admin"] });
		const agent = await tokenFor(w, { actor: "helper", kind: "agent", can: ["read", "admin"] });
		const owner = sessionOf(await w.post("/api/login", { token: TOKEN }));
		expect([
			(await me(w, bearer(TOKEN))).owner,
			(await me(w, jar(owner))).owner,
			(await me(w, jar(robin))).owner,
			(await me(w, bearer(agent))).owner,
		]).toEqual([true, true, false, false]);
		// It is the same rule the server refuses by: an admin who is not the owner makes no recovery for another.
		await joined(w, "sam");
		expect(must(await prove(w, robin, "robin"))).toEqual({ proven: true });
		expect((await w.op("invitation", { do: "create", name: "sam" }, jar(robin))).status).toBe(403);
		expect((await w.op("invitation", { do: "create", name: "sam" }, jar(owner))).status).toBe(200);
	});

	test("the list of invitations says what each person may do and where, as the list of actors does", async () => {
		const w = await world();
		await w.ok("admin", { do: "project.create", key: "checkout" });
		await invite(w, { name: "robin", can: ["read", "produce"], project: "checkout" });
		await invite(w, { name: "sam" });
		await invite(w, { name: OWNER });
		type Row = { name: string; purpose: string; grants: { project: string; can: string[]; roles: string[] }[] };
		const listed = await w.ok<Row[]>("invitation", { do: "list" });
		expect(listed.map((row) => ({ name: row.name, purpose: row.purpose, grants: row.grants }))).toEqual([
			// `produce` includes `record`, and the list says what the person holds, as the registry will see it.
			{
				name: "robin",
				purpose: "join",
				grants: [{ project: "checkout", can: ["read", "record", "produce"], roles: [] }],
			},
			{
				name: "sam",
				purpose: "join",
				grants: [{ project: "*", can: ["read", "record", "produce", "answer", "plan", "admin"], roles: [] }],
			},
			{
				name: OWNER,
				purpose: "recover",
				grants: [{ project: "*", can: ["read", "record", "produce", "answer", "plan", "admin"], roles: [] }],
			},
		]);
		// A grant that changes after the invitation was made is what the list shows: it is the person's, not the link's.
		await w.ok("admin", { do: "grant.set", actor: "robin", project: "checkout", can: ["read"] });
		const after = await w.ok<Row[]>("invitation", { do: "list" });
		expect(after[0]?.grants).toEqual([{ project: "checkout", can: ["read"], roles: [] }]);
	});

	test("an identity an invitation was accepted with says when it was last used: the moment it signed its person in", async () => {
		const clock = clockAt();
		const w = await world({ clock });
		const { code } = await invite(w, { name: "robin" });
		clock.advance(HOUR);
		const accepted = await accept(w, code, subjectOf("robin"));
		expect(await w.ok("credential", { do: "list" }, jar(sessionOf(accepted)))).toMatchObject([
			{ id: 1, kind: "oidc", lastUsedAt: T0 + HOUR },
		]);
	});

	test("an operation of the instance is called at /api/<operation> and nowhere else: under a project's path it is refused", async () => {
		const w = await world();
		const cookie = await joined(w, "robin");
		const { OP_LIST } = await import("../src/server/ops/index.ts");
		const instance = OP_LIST.filter((op) => op.scope === "instance" && op.effect !== "service").map((op) => op.name);
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
		expect(await w.rows("SELECT id FROM invitations")).toHaveLength(1);
		// And an operation of a project has no path without one.
		expect(said(await w.post("/api/find", {}, bearer(TOKEN)))).toBe("400 invalid");
	});
});

describe("a sign-in body the server cannot read", () => {
	test("one that is too large, or is not JSON, is answered as any body that is no way of signing in: not with a sentence about tokens", async () => {
		const w = await world();
		await joined(w, "robin");
		const logged = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const send = (body: string) =>
				fetch(`${w.instance.url}/api/login`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body,
				}).then(async (reply) => `${reply.status} ${reply.headers.getSetCookie().length} ${await reply.text()}`);
			// The provider's query is the longest body there is, and sixteen kibibytes is past any of them.
			const large = JSON.stringify({ oidc: `?code=${"x".repeat(17 * 1024)}` });
			expect([await send(large), await send("{not json"), await send('"a string"')]).toEqual(
				Array.from({ length: 3 }, () => `401 0 ${REFUSED}`),
			);
			expect(logged.mock.calls.map((call) => String(call[0]))).toEqual(
				Array.from({ length: 3 }, () => "[mainworthy] sign-in refused: input"),
			);
			// Inside the limit it is read, and refused for what it is: a way of signing in that is gone.
			const fits = JSON.stringify({ name: "robin", password: "x".repeat(400), pad: "y".repeat(7 * 1024) });
			expect(await send(fits)).toBe(`401 0 ${REFUSED}`);
		} finally {
			logged.mockRestore();
		}
	});
});

describe("a person's own command-line token", () => {
	test("the local owner creates an expiring token without a browser sign-in", async () => {
		const w = await world({ mode: "local" });
		const made = PersonalTokenCreated.parse(await w.ok("credential", { do: "token.create", label: "Local CLI" }, {}));
		expect(made).toMatchObject({ actor: OWNER, expiresAt: T0 + 30 * DAY });
		expect(await w.status(bearer(made.token))).toBe(200);
		expect(await w.ok("credential", { do: "token.revoke", id: made.id }, {})).toMatchObject({ revoked: true });
		expect(await w.status(bearer(made.token))).toBe(401);
	});

	test("a non-admin creates once, uses current grants, lists only their tokens and revokes them", async () => {
		const w = await world();
		const cookie = await joined(w, "personal", { can: ["read", "produce"], project: "scratch" });
		expect(must(await prove(w, cookie, "personal"))).toEqual({ proven: true });
		const headers = { ...jar(cookie), origin: w.instance.url };
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

		expect((await w.disk()).includes(Buffer.from(token.token))).toBe(false);
		expect(said(await w.op("credential", input, headers))).toBe("409 conflict");
		const listed = await w.ok<{ id: number; label: string; revoked: boolean }[]>(
			"credential",
			{ do: "token.list" },
			headers,
		);
		expect(listed).toMatchObject([{ id: token.id, label: "Laptop CLI", revoked: false }]);
		expect(listed).toHaveLength(1);
		expect(listed).toMatchObject([{ lastUsedAt: T0 }]);
		expect(await w.rows("SELECT outcome FROM commands WHERE id = 'personal-token-once'")).toEqual([
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
		const w = await world();
		const cookie = await joined(w, "team-cli", { can: ["read"], project: "scratch" });
		expect(must(await prove(w, cookie, "team-cli"))).toEqual({ proven: true });
		const made = PersonalTokenCreated.parse(
			await w.ok("credential", { do: "token.create", label: "Team CLI" }, { ...jar(cookie), origin: w.instance.url }),
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
			expect.objectContaining({
				name: "team-cli",
				grants: [{ project: "scratch", can: ["read"], roles: [] }],
				teams: [],
			}),
		);
	});

	test("expiry is bounded, caller identity cannot be supplied, and token sign-ins cannot renew themselves", async () => {
		const w = await world();
		const cookie = await joined(w, "expiry-person");
		expect(must(await prove(w, cookie, "expiry-person"))).toEqual({ proven: true });
		const headers = { ...jar(cookie), origin: w.instance.url };
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
		const signed = sessionOf(await w.post("/api/login", { token: token.token }));
		expect(said(await w.op("credential", { do: "token.create", label: "Renew" }, jar(signed)))).toBe("403 forbidden");
		w.clock.advance(HOUR);
		expect(await w.status(bearer(token.token))).toBe(401);
		expect(await w.ok("credential", { do: "token.list" }, headers)).toMatchObject([{ id: token.id, expired: true }]);
		expect(must(await prove(w, cookie, "expiry-person"))).toEqual({ proven: true });
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

	test("a session opened through the provider creates one once proven, and the owner's last token stays", async () => {
		const w = await world();
		const invitation = await invite(w, { name: "provider-cli", can: ["read"], project: "scratch" });
		const cookie = sessionOf(await accept(w, invitation.code, subjectOf("provider-cli")));
		expect(said(await w.op("credential", { do: "token.create", label: "Provider CLI" }, jar(cookie)))).toBe(
			"403 recent_proof_required",
		);
		expect(must(await prove(w, cookie, "provider-cli"))).toEqual({ proven: true });
		expect(said(await w.op("credential", { do: "token.create", label: "Provider CLI" }, jar(cookie)))).toBe("200");
		expect(said(await w.op("credential", { do: "token.revoke", id: 1 }))).toBe("400 invalid");
	});
});
