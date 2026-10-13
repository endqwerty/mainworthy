// Passkeys on a real listener: a person registers one, signs in with it, and everything the code around the
// verifier has to hold (the list above `verifyRegistration` in `src/server/identity/webauthn.ts`): a challenge is
// kept on the server and spent once, a credential id belongs to one person for good, the person is the one the
// stored row names, the counter is compared again in the commit, and the relying party comes from the
// configuration. The authenticator is written from the specification (`test/people-support.ts`).
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { type AssertionOptions, CEREMONY_MS, type RegistrationOptions } from "../src/server/identity/webauthn.ts";
import {
	type Authenticator,
	authenticator,
	bearer,
	cleanUp,
	clockAt,
	from,
	holdGate,
	invite,
	joined,
	must,
	OWNER,
	type Sent,
	said,
	scratch,
	signIn,
	TOKEN,
	type World,
	waitingAtGate,
	world,
} from "./people-support.ts";

afterEach(cleanUp);

const REFUSED = '{"ok":false,"error":{"code":"unauthenticated","message":"that did not sign you in"}}';
const PASSWORD = "correct horse battery staple";

type Stored = { key: string; algorithm: number; counter: number; transports: string[] };
type CredentialRow = {
	id: number;
	actor: number;
	kind: string;
	handle: string | null;
	data: string;
	label: string;
	last_used_at: number | null;
	revoked_at: number | null;
};
const credentials = (w: World): CredentialRow[] =>
	w.rows("SELECT id, actor, kind, handle, data, label, last_used_at, revoked_at FROM credentials ORDER BY id");
const passkeyRow = (w: World, device: Authenticator): CredentialRow & { stored: Stored } => {
	const row = credentials(w).find((candidate) => candidate.handle === device.id);
	if (!row) throw new Error("no such passkey is stored");
	return { ...row, stored: JSON.parse(row.data) as Stored };
};
const sessionCount = (w: World): number => w.rows("SELECT id FROM sessions").length;

/** A signed-in person registers a passkey: begin, the authenticator, add. */
async function addPasskey(w: World, cookie: string, device: Authenticator, label = "laptop") {
	const options = await w.ok<RegistrationOptions>("credential", { do: "passkey.begin" }, { cookie });
	const added = await w.op<{ id: number; label: string }>(
		"credential",
		{ do: "passkey.add", passkey: device.register(options), label },
		{ cookie },
	);
	return { options, added };
}
const challenge = async (w: World): Promise<AssertionOptions> => {
	const reply = await w.post<{ passkey: AssertionOptions }>("/api/login/challenge", {});
	if (!reply.body.ok) throw new Error(`no challenge: ${reply.text}`);
	return reply.body.result.passkey;
};
const withPasskey = (w: World, passkey: unknown, headers: Sent = {}) => w.post("/api/login", { passkey }, headers);
/** A person with a password and one passkey. */
async function person(w: World, name: string): Promise<{ cookie: string; device: Authenticator }> {
	const cookie = await joined(w, name, PASSWORD);
	const device = authenticator();
	const { added } = await addPasskey(w, cookie, device);
	if (added.status !== 200) throw new Error(`no passkey for ${name}: ${added.text}`);
	return { cookie, device };
}
/** Runs with the log silenced and returns the lines the server wrote. */
async function logged(run: () => Promise<void>): Promise<string[]> {
	const spy = spyOn(console, "warn").mockImplementation(() => {});
	try {
		await run();
		return spy.mock.calls.map((call) => String(call[0]));
	} finally {
		spy.mockRestore();
	}
}

describe("registering a passkey", () => {
	test("a signed-in person registers a passkey and signs in with it; the session rests on the passkey", async () => {
		const w = world();
		const cookie = await joined(w, "robin", PASSWORD);
		const device = authenticator();
		const { options, added } = await addPasskey(w, cookie, device, "  Robin's laptop ");
		// The options ask for what the verifier will hold the answer to, for this instance's public name.
		expect(options).toMatchObject({
			rp: { id: "mainworthy.example", name: "Mainworthy" },
			user: { name: "robin", displayName: "robin" },
			attestation: "none",
			authenticatorSelection: { residentKey: "required", userVerification: "required" },
			excludeCredentials: [],
			timeout: CEREMONY_MS,
		});
		// The handle the authenticator files the key under is random bytes, not the person's name or number.
		expect(Buffer.from(options.user.id, "base64url")).toHaveLength(16);
		expect(added.body).toEqual({ ok: true, result: { id: 2, label: "Robin's laptop" }, seq: null });
		const row = passkeyRow(w, device);
		expect(row).toMatchObject({ id: 2, kind: "passkey", label: "Robin's laptop", revoked_at: null });
		expect(row.stored).toMatchObject({ algorithm: -7, counter: 0, transports: ["internal"] });
		// What a list says of a credential is never its key or its hash.
		const listed = await w.op<Record<string, unknown>[]>("credential", { do: "list" }, { cookie });
		expect(listed.body.ok && listed.body.result).toMatchObject([
			{ id: 1, kind: "password", label: "password" },
			{ id: 2, kind: "passkey", label: "Robin's laptop", lastUsedAt: null },
		]);
		expect(listed.text).not.toContain(row.stored.key);
		expect(listed.text).not.toContain("argon2");
		expect(listed.text).not.toContain(device.id);
		expect((await w.get<{ credentials: unknown }>("/api/session", { cookie })).body).toMatchObject({
			ok: true,
			result: { credentials: { password: true, passkeys: 1 } },
		});

		const offered = await challenge(w);
		expect(offered).toMatchObject({ rpId: "mainworthy.example", userVerification: "required", allowCredentials: [] });
		const signedIn = await withPasskey(w, device.assert(offered));
		expect(signedIn.status).toBe(200);
		expect(signedIn.setCookies[0]).toMatch(/^mainworthy_sid=[A-Za-z0-9_-]{43}; /);
		expect((await w.get("/api/session", { cookie: signedIn.cookie })).body).toMatchObject({
			ok: true,
			result: { actor: "robin", via: "cookie", session: 2 },
		});
		expect(w.rows("SELECT credential, token FROM sessions WHERE id = 2")).toEqual([{ credential: 2, token: null }]);
		expect(passkeyRow(w, device)).toMatchObject({ stored: { counter: 1 }, last_used_at: expect.any(Number) });
		const sessions = await w.ok<{ id: number; openedWith: string }[]>("session", { do: "list" }, { cookie });
		expect(sessions.map((row) => `${row.id} ${row.openedWith}`)).toEqual(["1 password", "2 passkey"]);
		// The next registration is told which authenticators the person already has.
		const next = await w.ok<RegistrationOptions>("credential", { do: "passkey.begin" }, { cookie });
		expect(next.excludeCredentials).toEqual([{ type: "public-key", id: device.id, transports: ["internal"] }]);
		expect(next.user.id).toBe(options.user.id);
		expect(next.challenge).not.toBe(options.challenge);
	});

	test("a registration is for the person who asked for the challenge, once, inside its time, and for that purpose", async () => {
		const clock = clockAt();
		const w = world({ clock });
		const robin = await joined(w, "robin", PASSWORD);
		const sam = await joined(w, "sam", PASSWORD);
		const begin = (cookie: string) => w.ok<RegistrationOptions>("credential", { do: "passkey.begin" }, { cookie });
		const add = (cookie: string, passkey: unknown) =>
			w.op("credential", { do: "passkey.add", passkey, label: "key" }, { cookie });
		/** The status of an attempt and, when it was refused, the verifier's word for why, from the sentence. */
		const tried = async (cookie: string, passkey: unknown): Promise<string> => {
			const reply = await add(cookie, passkey);
			return `${reply.status} ${reply.body.ok ? "accepted" : /\(([a-z-]+)\)/.exec(reply.body.error.message)?.[1]}`;
		};
		const refusals: Record<string, string> = {};
		// Another person answers Robin's challenge.
		refusals["another person"] = await tried(sam, authenticator().register(await begin(robin)));
		// The answer arrives when the ceremony's time has run out.
		const late = authenticator().register(await begin(robin));
		clock.advance(CEREMONY_MS);
		refusals.late = await tried(robin, late);
		// A sign-in challenge is not a registration challenge, and neither is one the server never issued.
		const forSignIn = await challenge(w);
		const options = await begin(robin);
		refusals["wrong purpose"] = await tried(
			robin,
			authenticator().register({ ...options, challenge: forSignIn.challenge }),
		);
		refusals["made up"] = await tried(
			robin,
			authenticator().register({ ...options, challenge: forSignIn.challenge.replace(/.$/, "A") as never }),
		);
		// An answer made on another site's page, and one for another relying party.
		refusals.origin = await tried(robin, authenticator("https://evil.example").register(await begin(robin)));
		const elsewhere = await begin(robin);
		refusals["relying party"] = await tried(
			robin,
			authenticator().register({ ...elsewhere, rp: { ...elsewhere.rp, id: "evil.example" } }),
		);
		// An authenticator that did not check who the person is.
		refusals["not verified"] = await tried(robin, authenticator().register(await begin(robin), { unverified: true }));
		expect(refusals).toEqual({
			"another person": "400 challenge",
			late: "400 challenge",
			"wrong purpose": "400 challenge",
			"made up": "400 challenge",
			origin: "400 origin",
			"relying party": "400 rp-id",
			"not verified": "400 user-not-verified",
		});
		expect(credentials(w).filter((row) => row.kind === "passkey")).toEqual([]);
		// One millisecond inside its time it is taken, and the same answer is not taken twice.
		const device = authenticator();
		const answer = device.register(await begin(robin));
		clock.advance(CEREMONY_MS - 1);
		expect((await add(robin, answer)).status).toBe(200);
		const again = await add(robin, answer);
		expect(again.status).toBe(400);
		expect(credentials(w).filter((row) => row.kind === "passkey")).toHaveLength(1);
	});

	test("a credential id is registered once on the instance: not twice by one person, not by another, not after it was removed", async () => {
		const w = world();
		const { cookie: robin, device } = await person(w, "robin");
		const sam = await joined(w, "sam", PASSWORD);
		const again = async (cookie: string): Promise<string> => {
			const options = await w.ok<RegistrationOptions>("credential", { do: "passkey.begin" }, { cookie });
			const reply = await w.op(
				"credential",
				{ do: "passkey.add", passkey: device.register(options), label: "again" },
				{ cookie },
			);
			return `${reply.status} ${reply.body.ok ? "" : reply.body.error.code}`;
		};
		expect([await again(robin), await again(sam)]).toEqual(["409 conflict", "409 conflict"]);
		// Removed, the row stays and the id stays taken: a credential id is never reused or moved.
		expect(await w.ok<unknown>("credential", { do: "remove", id: 2 }, { cookie: robin })).toEqual({
			removed: true,
			sessionsEnded: 0,
		});
		expect([await again(robin), await again(sam)]).toEqual(["409 conflict", "409 conflict"]);
		expect(credentials(w).filter((row) => row.kind === "passkey")).toMatchObject([
			{ id: 2, handle: device.id, data: "", revoked_at: expect.any(Number) },
		]);
		// The database holds the rule too, whatever the code above it does.
		expect(() =>
			w.instance.app.db.raw
				.query(
					"INSERT INTO credentials (actor, kind, handle, data, label, created_at) VALUES (4, 'passkey', ?, '{}', 'x', 0)",
				)
				.run(device.id),
		).toThrow(/UNIQUE/);
	});

	test("an invitation is accepted with a passkey, or with a passkey and a password, and the session rests on the passkey", async () => {
		const w = world();
		const first = await invite(w, { name: "robin" });
		const shown = await w.post<{ invitation: unknown; passkey: RegistrationOptions }>("/api/login/challenge", {
			invitation: first.code,
		});
		if (!shown.body.ok) throw new Error(shown.text);
		expect(shown.body.result).toMatchObject({
			invitation: { name: "robin", purpose: "join" },
			passkey: { rp: { id: "mainworthy.example" }, user: { name: "robin" }, excludeCredentials: [] },
		});
		const device = authenticator();
		const accepted = await w.post("/api/login", {
			invitation: first.code,
			passkey: device.register(shown.body.result.passkey),
			label: "phone",
		});
		expect(accepted.status).toBe(200);
		expect(credentials(w)).toMatchObject([{ id: 1, kind: "passkey", label: "phone", handle: device.id }]);
		expect(w.rows("SELECT credential FROM sessions")).toEqual([{ credential: 1 }]);
		expect((await withPasskey(w, device.assert(await challenge(w)))).status).toBe(200);

		// Both at once.
		const second = await invite(w, { name: "sam" });
		const offered = await w.post<{ passkey: RegistrationOptions }>("/api/login/challenge", { invitation: second.code });
		if (!offered.body.ok) throw new Error(offered.text);
		const other = authenticator();
		const both = await w.post("/api/login", {
			invitation: second.code,
			password: PASSWORD,
			passkey: other.register(offered.body.result.passkey),
		});
		expect(both.status).toBe(200);
		expect(credentials(w).slice(1)).toMatchObject([
			{ id: 2, kind: "password", actor: 4 },
			{ id: 3, kind: "passkey", actor: 4, label: "passkey" },
		]);
		expect(w.rows("SELECT credential FROM sessions WHERE actor = 4")).toEqual([{ credential: 3 }]);
		expect((await signIn(w, "sam", PASSWORD)).status).toBe(200);

		// A passkey that does not answer the invitation's own challenge accepts nothing, and spends nothing.
		const third = await invite(w, { name: "pat" });
		const forPat = await w.post<{ passkey: RegistrationOptions }>("/api/login/challenge", { invitation: third.code });
		const patsOptions = must(forPat).passkey;
		const lines = await logged(async () => {
			// The challenge of somebody else's invitation, and one made for a sign-in.
			const fourth = await invite(w, { name: "lee" });
			const forLee = await w.post<{ passkey: RegistrationOptions }>("/api/login/challenge", {
				invitation: fourth.code,
			});
			const borrowed = await w.post("/api/login", {
				invitation: third.code,
				passkey: authenticator().register(must(forLee).passkey),
			});
			const forSignIn = await w.post("/api/login", {
				invitation: third.code,
				passkey: authenticator().register({ ...patsOptions, challenge: (await challenge(w)).challenge }),
			});
			// A key that is somebody's already.
			const taken = await w.post("/api/login", { invitation: third.code, passkey: device.register(patsOptions) });
			expect([borrowed, forSignIn, taken].map((reply) => `${reply.status} ${reply.text}`)).toEqual(
				Array.from({ length: 3 }, () => `401 ${REFUSED}`),
			);
		});
		expect(lines).toEqual([
			"[mainworthy] sign-in refused: challenge",
			"[mainworthy] sign-in refused: challenge",
			"[mainworthy] sign-in refused: credential-exists",
		]);
		expect(
			w.rows(
				"SELECT id FROM actors a WHERE name = 'pat' AND EXISTS (SELECT 1 FROM credentials c WHERE c.actor = a.id)",
			),
		).toEqual([]);
		// The challenge that was the invitation's own is still good, because nothing was accepted.
		expect(
			(await w.post("/api/login", { invitation: third.code, passkey: authenticator().register(patsOptions) })).status,
		).toBe(200);
	});
});

describe("signing in with a passkey", () => {
	test("a challenge signs in once: the same answer again, an answer to a registration challenge and a late answer are refused", async () => {
		const clock = clockAt();
		const w = world({ clock });
		const { cookie, device } = await person(w, "robin");
		const before = sessionCount(w);
		const answer = device.assert(await challenge(w));
		expect((await withPasskey(w, answer)).status).toBe(200);
		const lines = await logged(async () => {
			const replies = [await withPasskey(w, answer)];
			// A challenge issued for a registration, by the person themselves.
			const registering = await w.ok<RegistrationOptions>("credential", { do: "passkey.begin" }, { cookie });
			const offered = await challenge(w);
			replies.push(await withPasskey(w, device.assert({ ...offered, challenge: registering.challenge })));
			// A challenge past its time, and one that was never issued.
			const late = device.assert(await challenge(w));
			clock.advance(CEREMONY_MS);
			replies.push(await withPasskey(w, late));
			replies.push(
				await withPasskey(w, device.assert({ ...offered, challenge: offered.challenge.replace(/.$/, "A") as never })),
			);
			// An answer that is not for this site.
			replies.push(await withPasskey(w, device.assert(await challenge(w), { origin: "https://evil.example" })));
			replies.push(await withPasskey(w, device.assert({ ...(await challenge(w)), rpId: "evil.example" })));
			// A passkey nobody registered here.
			replies.push(
				await withPasskey(w, authenticator().assert(await challenge(w), { userHandle: "AAAAAAAAAAAAAAAAAAAAAA" })),
			);
			replies.push(await withPasskey(w, { id: device.id }));
			// The person was not verified: somebody touched the key, and nothing says it was its owner.
			replies.push(await withPasskey(w, device.assert(await challenge(w), { unverified: true })));
			expect(replies.map((reply) => `${reply.status} ${reply.setCookies.length} ${reply.text}`)).toEqual(
				Array.from({ length: 9 }, () => `401 0 ${REFUSED}`),
			);
		});
		expect(lines).toEqual([
			"[mainworthy] sign-in refused: challenge",
			"[mainworthy] sign-in refused: challenge",
			"[mainworthy] sign-in refused: challenge",
			"[mainworthy] sign-in refused: challenge",
			"[mainworthy] sign-in refused: origin",
			"[mainworthy] sign-in refused: rp-id",
			"[mainworthy] sign-in refused: unknown-passkey",
			"[mainworthy] sign-in refused: input",
			"[mainworthy] sign-in refused: user-not-verified",
		]);
		expect(sessionCount(w)).toBe(before + 1);
		// One millisecond inside its time a challenge still signs in.
		const inTime = device.assert(await challenge(w));
		clock.advance(CEREMONY_MS - 1);
		expect((await withPasskey(w, inTime)).status).toBe(200);
	});

	test("the person is the one the stored passkey names: a user handle that is somebody else's, or none, is refused", async () => {
		const w = world();
		const { device } = await person(w, "robin");
		const { device: sams } = await person(w, "sam");
		const handles = w.rows<{ actor: number; handle: string }>("SELECT actor, handle FROM passkey_users ORDER BY actor");
		expect(handles.map((row) => row.actor)).toEqual([3, 4]);
		const samsHandle = handles[1]?.handle ?? "";
		const before = sessionCount(w);
		const lines = await logged(async () => {
			const replies = [
				await withPasskey(w, device.assert(await challenge(w), { userHandle: samsHandle })),
				await withPasskey(w, device.assert(await challenge(w), { userHandle: null })),
				await withPasskey(w, device.assert(await challenge(w), { userHandle: "AAAAAAAAAAAAAAAAAAAAAA" })),
			];
			expect(replies.map((reply) => `${reply.status} ${reply.text}`)).toEqual(
				Array.from({ length: 3 }, () => `401 ${REFUSED}`),
			);
		});
		expect(lines).toEqual(Array.from({ length: 3 }, () => "[mainworthy] sign-in refused: user-handle"));
		expect(sessionCount(w)).toBe(before);
		// Each passkey signs in the person it was registered for, whatever else the request says.
		const robin = await withPasskey(w, device.assert(await challenge(w)));
		const sam = await w.post("/api/login", { passkey: sams.assert(await challenge(w)), name: "robin" });
		expect((await w.get("/api/session", { cookie: robin.cookie })).body).toMatchObject({ result: { actor: "robin" } });
		// A body that names a person beside the passkey is not one way of signing in.
		expect(sam.status).toBe(401);
		const samAlone = await withPasskey(w, sams.assert(await challenge(w)));
		expect((await w.get("/api/session", { cookie: samAlone.cookie })).body).toMatchObject({ result: { actor: "sam" } });
	});

	test("a counter that does not grow is refused, logged with the credential's row, and the stored counter stays", async () => {
		const w = world();
		const { device } = await person(w, "robin");
		expect((await withPasskey(w, device.assert(await challenge(w), { signCount: 5 }))).status).toBe(200);
		expect(passkeyRow(w, device).stored.counter).toBe(5);
		const before = sessionCount(w);
		const lines = await logged(async () => {
			for (const signCount of [5, 4, 0]) {
				const reply = await withPasskey(w, device.assert(await challenge(w), { signCount }));
				expect(`${reply.status} ${reply.text}`).toBe(`401 ${REFUSED}`);
			}
		});
		expect(lines).toEqual(
			Array.from({ length: 3 }, () => "[mainworthy] sign-in refused: possibly-cloned (credential 2)"),
		);
		expect(passkeyRow(w, device).stored.counter).toBe(5);
		expect(sessionCount(w)).toBe(before);
		expect((await withPasskey(w, device.assert(await challenge(w), { signCount: 6 }))).status).toBe(200);
		expect(passkeyRow(w, device).stored.counter).toBe(6);
		// An authenticator that does not count sends zero each time, and that is accepted while zero is stored.
		const { device: uncounted } = await person(w, "sam");
		for (let i = 0; i < 2; i++)
			expect((await withPasskey(w, uncounted.assert(await challenge(w), { signCount: 0 }))).status).toBe(200);
	});

	test("two sign-ins racing on one passkey with one counter open at most one session, and so do two answers to one challenge", async () => {
		const w = world();
		const { device } = await person(w, "robin");
		const before = sessionCount(w);
		const lines = await logged(async () => {
			// Two answers with the same counter, as a copied key would give, each to a challenge of its own. Both
			// are checked against the stored counter before either may write.
			const one = device.assert(await challenge(w), { signCount: 7 });
			const two = device.assert(await challenge(w), { signCount: 7 });
			let gate = holdGate(w.instance);
			let waiting = waitingAtGate(w.instance, 2);
			let racing = [withPasskey(w, one), withPasskey(w, two)];
			await waiting;
			await gate.release();
			expect((await Promise.all(racing)).map((reply) => reply.status).sort()).toEqual([200, 401]);
			expect(sessionCount(w)).toBe(before + 1);
			expect(passkeyRow(w, device).stored.counter).toBe(7);

			// One answer, sent twice at the same moment.
			const answer = device.assert(await challenge(w), { signCount: 8 });
			gate = holdGate(w.instance);
			waiting = waitingAtGate(w.instance, 2);
			racing = [withPasskey(w, answer), withPasskey(w, answer)];
			await waiting;
			await gate.release();
			expect((await Promise.all(racing)).map((reply) => reply.status).sort()).toEqual([200, 401]);
			expect(sessionCount(w)).toBe(before + 2);
		});
		expect(lines).toEqual([
			"[mainworthy] sign-in refused: possibly-cloned (credential 2)",
			"[mainworthy] sign-in refused: challenge",
		]);
	});

	test("a passkey that was removed, and one whose person was forgotten, sign nobody in", async () => {
		const w = world();
		const { cookie, device } = await person(w, "robin");
		const { device: sams } = await person(w, "sam");
		const viaPasskey = await withPasskey(w, device.assert(await challenge(w)));
		expect(await w.status({ cookie: viaPasskey.cookie })).toBe(200);
		// Removing the passkey ends the session that rests on it, and not the one that rests on the password.
		expect(await w.ok<unknown>("credential", { do: "remove", id: 2 }, { cookie })).toEqual({
			removed: true,
			sessionsEnded: 1,
		});
		expect([await w.status({ cookie: viaPasskey.cookie }), await w.status({ cookie })]).toEqual([401, 200]);
		await w.ok("admin", { do: "actor.forget", name: "sam" });
		const lines = await logged(async () => {
			expect((await withPasskey(w, device.assert(await challenge(w)))).text).toBe(REFUSED);
			expect((await withPasskey(w, sams.assert(await challenge(w)))).text).toBe(REFUSED);
		});
		expect(lines).toEqual([
			"[mainworthy] sign-in refused: revoked-passkey",
			"[mainworthy] sign-in refused: revoked-passkey",
		]);
	});
});

describe("removing a credential", () => {
	test("removing a credential ends the sessions that rest on it, and the last one a person has is not removed", async () => {
		const w = world();
		const { cookie, device } = await person(w, "robin");
		const second = (await signIn(w, "robin", PASSWORD)).cookie;
		const viaPasskey = (await withPasskey(w, device.assert(await challenge(w)))).cookie;
		// The password goes: both sessions that rest on it end, the request's own among them.
		expect(await w.ok<unknown>("credential", { do: "remove", id: 1 }, { cookie: viaPasskey })).toEqual({
			removed: true,
			sessionsEnded: 2,
		});
		expect([
			await w.status({ cookie }),
			await w.status({ cookie: second }),
			await w.status({ cookie: viaPasskey }),
		]).toEqual([401, 401, 200]);
		expect(w.rows("SELECT id, ended_why FROM sessions ORDER BY id")).toEqual([
			{ id: 1, ended_why: "ended" },
			{ id: 2, ended_why: "ended" },
			{ id: 3, ended_why: null },
		]);
		const lines = await logged(async () => {
			expect((await signIn(w, "robin", PASSWORD)).status).toBe(401);
		});
		expect(lines).toEqual(["[mainworthy] sign-in refused: no-password"]);
		// The passkey is the last way in. It stays, and the refusal says what to do instead.
		const last = await w.op("credential", { do: "remove", id: 2 }, { cookie: viaPasskey });
		expect(last.status).toBe(400);
		expect(last.body.ok ? "" : last.body.error.message).toContain("recovery link");
		expect(await w.status({ cookie: viaPasskey })).toBe(200);
		// Removing twice, and removing what is not there.
		expect((await w.op("credential", { do: "remove", id: 1 }, { cookie: viaPasskey })).status).toBe(404);
		expect((await w.op("credential", { do: "remove", id: 99 }, { cookie: viaPasskey })).status).toBe(404);
		// A person with no password sets one without a current one, and then the passkey can go.
		const set = await w.post("/api/account/password", { next: "a new password of my own" }, { cookie: viaPasskey });
		expect(set.body).toMatchObject({ ok: true, result: { changed: true, sessionsEnded: 0 } });
		expect(await w.ok<unknown>("credential", { do: "remove", id: 2 }, { cookie: viaPasskey })).toEqual({
			removed: true,
			sessionsEnded: 1,
		});
		expect(await w.status({ cookie: viaPasskey })).toBe(401);
		expect((await signIn(w, "robin", "a new password of my own")).status).toBe(200);
	});

	test("a credential is its person's to remove, or an admin's who is a person; nobody else learns that it exists", async () => {
		const w = world();
		const { cookie: robin } = await person(w, "robin");
		const { cookie: sam } = await person(w, "sam");
		const agent = (
			await w.ok<{ token: string }>("admin", { do: "token.create", actor: "helper", kind: "agent", can: ["admin"] })
		).token;
		for (const headers of [{ cookie: sam }, bearer(agent)]) {
			const reply = await w.op("credential", { do: "remove", id: 2 }, headers);
			expect([403, 404]).toContain(reply.status);
		}
		expect((await w.op("credential", { do: "list", actor: "robin" }, { cookie: sam })).status).toBe(403);
		expect(credentials(w).map((row) => row.revoked_at)).toEqual([null, null, null, null]);
		// The owner, with a token, sees Robin's and removes one. Nobody registers a passkey for somebody else.
		const seen = await w.ok<{ id: number }[]>("credential", { do: "list", actor: "robin" });
		expect(seen.map((row) => row.id)).toEqual([1, 2]);
		expect(await w.ok<unknown>("credential", { do: "remove", id: 2 })).toEqual({ removed: true, sessionsEnded: 0 });
		expect((await w.op("credential", { do: "remove", id: 1 })).status).toBe(400);
		expect(await w.status({ cookie: robin })).toBe(200);
	});
});

describe("the relying party", () => {
	test("the RP ID and the origin come from MAINWORTHY_PUBLIC_URL: a request with another Host header changes nothing", async () => {
		const w = world();
		const { cookie, device } = await person(w, "robin");
		const elsewhere: Sent = { host: "evil.example", "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" };
		const viaHost = await w.post<{ passkey: AssertionOptions }>("/api/login/challenge", {}, elsewhere);
		expect(viaHost.body).toMatchObject({ ok: true, result: { passkey: { rpId: "mainworthy.example" } } });
		const options = await w.op<RegistrationOptions>(
			"credential",
			{ do: "passkey.begin" },
			{ cookie, host: "evil.example" },
		);
		expect(options.body).toMatchObject({ ok: true, result: { rp: { id: "mainworthy.example" } } });
		// An answer made at the name the request claimed is not accepted, whichever Host carries it back.
		const offered = must(viaHost).passkey;
		const registering = must(options);
		const lines = await logged(async () => {
			const there = device.assert({ ...offered, rpId: "evil.example" }, { origin: "https://evil.example" });
			expect((await withPasskey(w, there, elsewhere)).status).toBe(401);
			const registered = await w.op(
				"credential",
				{
					do: "passkey.add",
					passkey: authenticator("https://evil.example").register({
						...registering,
						rp: { id: "evil.example", name: "x" },
					}),
					label: "elsewhere",
				},
				{ cookie, host: "evil.example" },
			);
			expect(registered.status).toBe(400);
		});
		expect(lines).toEqual(["[mainworthy] sign-in refused: origin"]);
		// And one made at the public name is, though the request carrying it says another Host.
		expect((await withPasskey(w, device.assert(await challenge(w)), { host: "evil.example" })).status).toBe(200);
		expect(await w.get("/api/login/methods")).toMatchObject({
			body: { ok: true, result: { password: true, passkey: true } },
		});
	});

	test("without the variable passkeys are off: methods says so and the passkey routes refuse plainly", async () => {
		const w = world({ publicUrl: null });
		const cookie = await joined(w, "robin", PASSWORD);
		expect((await w.get("/api/login/methods")).body).toEqual({ ok: true, result: { password: true, passkey: false } });
		const replies = [
			await w.post("/api/login/challenge", {}),
			await w.post("/api/login/challenge", {}, { host: "localhost" }),
			await withPasskey(
				w,
				authenticator().assert({ rpId: "localhost", challenge: "x".repeat(43) } as AssertionOptions),
			),
			await w.op("credential", { do: "passkey.begin" }, { cookie }),
			await w.op("credential", { do: "passkey.add", passkey: {}, label: "x" }, { cookie }),
		];
		expect(replies.map((reply) => reply.status)).toEqual([400, 400, 400, 400, 400]);
		for (const reply of replies)
			expect(reply.body.ok ? "" : reply.body.error.message).toContain("MAINWORTHY_PUBLIC_URL");
		// An invitation with a passkey is refused the same way, and the invitation is not spent.
		const { code } = await invite(w, { name: "sam" });
		expect((await w.post("/api/login", { invitation: code, passkey: {} })).status).toBe(400);
		expect((await w.post("/api/login", { invitation: code, password: PASSWORD })).status).toBe(200);
	});

	test("a public address no browser takes for passkeys stops the start, with a line that says why", async () => {
		const { start } = await import("../src/server/start.ts");
		const { defaultConfig } = await import("../src/server/kernel/app.ts");
		const boot = (publicUrl: string) =>
			start(
				{
					...defaultConfig({ MAINWORTHY_DATA: scratch(), MAINWORTHY_PORT: "0", MAINWORTHY_PUBLIC_URL: publicUrl }),
					owner: OWNER,
				},
				() => ({ ui: null }),
				{ readers: 0 },
			);
		for (const bad of [
			"http://192.168.1.20:7357",
			"http://mainworthy.example",
			"https://[::1]",
			"mainworthy.example",
			"https://mainworthy.example/app",
			"https://mainworthy.example/?x=1",
		])
			expect(() => boot(bad)).toThrow(/MAINWORTHY_PUBLIC_URL/);
		// A variable a compose file passes on empty is one that was not set.
		expect(defaultConfig({ MAINWORTHY_PUBLIC_URL: "" }).publicUrl).toBeUndefined();
		for (const good of ["https://mainworthy.example", "https://mainworthy.example/", "http://localhost:7357"]) {
			const instance = boot(good);
			try {
				const methods = await (await fetch(`${instance.url}/api/login/methods`)).json();
				expect(methods).toMatchObject({ result: { passkey: true } });
			} finally {
				await instance.stop();
			}
		}
	});

	test("an import ends every ceremony that was under way: its challenge named a person by a number the import gave away", async () => {
		const w = world();
		const archive = await (await fetch(`${w.instance.url}/api/export`, { headers: bearer(TOKEN) })).text();
		// An import is taken only by an instance that holds its owner and nothing else, so the passkey is the owner's.
		const recovery = await invite(w, { name: OWNER });
		const shown = must(
			await w.post<{ passkey: RegistrationOptions }>("/api/login/challenge", { invitation: recovery.code }),
		);
		const device = authenticator();
		const accepted = await w.post("/api/login", { invitation: recovery.code, passkey: device.register(shown.passkey) });
		expect(accepted.status).toBe(200);
		const offered = await challenge(w);
		expect(
			(await fetch(`${w.instance.url}/api/import`, { method: "POST", headers: bearer(TOKEN), body: archive })).status,
		).toBe(200);
		const lines = await logged(async () => {
			expect((await withPasskey(w, device.assert(offered))).text).toBe(REFUSED);
		});
		expect(lines).toEqual(["[mainworthy] sign-in refused: challenge"]);
		expect(w.rows("SELECT id FROM credentials")).toEqual([]);
		expect(w.rows("SELECT actor FROM passkey_users")).toEqual([]);
	});
});

describe("the limit on failed attempts", () => {
	test("a passkey answer that fails is counted under the address; a right one passes a blocked address, and a wrong one there is 429", async () => {
		const clock = clockAt();
		const w = world({ clock, proxied: true });
		const { device } = await person(w, "robin");
		const at = (n: number): Sent => from(`203.0.113.${n}`);
		const before = sessionCount(w);
		const lines = await logged(async () => {
			// Five answers nobody could accept, each for a challenge of its own: a key nobody registered, another
			// site's origin, a person who was not verified, a challenge never issued, and a body that is no answer.
			const stranger = authenticator();
			const failures = [
				await withPasskey(w, stranger.assert(await challenge(w), { userHandle: "AAAAAAAAAAAAAAAAAAAAAA" }), at(1)),
				await withPasskey(w, device.assert(await challenge(w), { origin: "https://evil.example" }), at(1)),
				await withPasskey(w, device.assert(await challenge(w), { unverified: true }), at(1)),
				await withPasskey(w, device.assert({ ...(await challenge(w)), challenge: "x".repeat(43) as never }), at(1)),
				await withPasskey(w, { id: device.id }, at(1)),
			];
			expect(failures.map(said)).toEqual(Array.from({ length: 5 }, () => "401 unauthenticated"));
			// The address is blocked: a wrong answer is told to wait, and is not counted or logged again.
			const blocked = await withPasskey(w, stranger.assert(await challenge(w)), at(1));
			expect(`${said(blocked)} ${blocked.setCookies.length}`).toBe("429 limited, retry after 1 0");
			// A right answer is a signature nobody guesses: it signs in from the blocked address.
			expect(said(await withPasskey(w, device.assert(await challenge(w), { signCount: 5 }), at(1)))).toBe("200");
			// Another address was never affected.
			expect(said(await withPasskey(w, stranger.assert(await challenge(w)), at(2)))).toBe("401 unauthenticated");
			// The block is the address's, so a wrong password from it is told to wait too.
			expect(said(await signIn(w, "robin", "not the password", at(1)))).toBe("429 limited, retry after 1");
			clock.advance(1000);
			expect(said(await signIn(w, "robin", PASSWORD, at(1)))).toBe("200");
		});
		expect(lines).toEqual([
			"[mainworthy] sign-in refused: unknown-passkey",
			"[mainworthy] sign-in refused: origin",
			"[mainworthy] sign-in refused: user-not-verified",
			"[mainworthy] sign-in refused: challenge",
			"[mainworthy] sign-in refused: input",
			"[mainworthy] sign-in refused: unknown-passkey",
		]);
		expect(sessionCount(w)).toBe(before + 2);
		// The session a passkey opened says where it was opened from.
		expect(w.rows("SELECT created_addr FROM sessions WHERE credential = 2")).toEqual([{ created_addr: "203.0.113.1" }]);
	});
});
