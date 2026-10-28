// Signing in through an identity provider (OpenID Connect) on a real listener, against the provider of
// `test/oidc-support.ts`. What has to hold: the provider's word is taken only for a ceremony this server began,
// in the browser that began it, once; the ID token is checked (signature, issuer, audience, nonce, time); an
// identity reaches a person only by an invitation or by the person linking it, never by a claim; and a person
// keeps at least one identity to sign in with.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { clearChallenges } from "../src/server/identity/identity.ts";
import { defaultConfig } from "../src/server/kernel/app.ts";
import type { Next } from "./oidc-support.ts";
import {
	authorize,
	bearer,
	begin,
	cleanUp,
	clockAt,
	finish,
	invite,
	jar,
	joined,
	must,
	PUBLIC,
	prove,
	sessionOf,
	signIn,
	subjectOf,
	TOKEN,
	viaProvider,
	type World,
	world,
} from "./people-support.ts";

afterEach(async () => {
	await cleanUp();
});

const REFUSED = '{"ok":false,"error":{"code":"unauthenticated","message":"that did not sign you in"}}';
const CALLBACK = `${PUBLIC}/signin/oidc`;

/** What the server logged with `console.warn` while `work` ran. */
async function logged(work: () => Promise<void>): Promise<string[]> {
	const spy = spyOn(console, "warn").mockImplementation(() => {});
	try {
		await work();
		return spy.mock.calls.map((call) => call.map(String).join(" "));
	} finally {
		spy.mockRestore();
	}
}

/** The person signed in with `cookie` proves it is them, then links `who` from their settings. */
async function link(w: World, cookie: string, name: string, who: Next) {
	expect(must(await prove(w, cookie, name))).toEqual({ proven: true });
	return viaProvider(w, who, { link: true }, cookie);
}

type Row = { id: number; actor: number; kind: string; handle: string | null; label: string; revoked_at: number | null };
const oidcRows = async (w: World) =>
	await w.rows<Row>(
		"SELECT id, actor, kind, handle, label, revoked_at FROM credentials WHERE kind = 'oidc' ORDER BY id",
	);

describe("the configuration", () => {
	const env = {
		MAINWORTHY_PUBLIC_URL: PUBLIC,
		MAINWORTHY_OIDC_ISSUER: "https://id.example.com",
		MAINWORTHY_OIDC_CLIENT_ID: "mainworthy",
		MAINWORTHY_OIDC_CLIENT_SECRET: "s3cret",
		MAINWORTHY_OIDC_NAME: "Example ID",
	};
	test("the four variables are set together, with a public address", () => {
		expect(defaultConfig(env).oidc).toEqual({
			issuer: "https://id.example.com",
			clientId: "mainworthy",
			clientSecret: "s3cret",
			name: "Example ID",
		});
		expect(defaultConfig({}).oidc).toBeUndefined();
		expect(() => defaultConfig({ ...env, MAINWORTHY_OIDC_CLIENT_SECRET: "" })).toThrow(/together/);
		expect(() => defaultConfig({ ...env, MAINWORTHY_PUBLIC_URL: "" })).toThrow(/MAINWORTHY_PUBLIC_URL/);
	});

	test("the issuer is https, or plain http on the loopback address only, and has no query or fragment", () => {
		const issuer = (value: string) => () => defaultConfig({ ...env, MAINWORTHY_OIDC_ISSUER: value });
		expect(issuer("http://id.example.com")).toThrow(/https/);
		expect(issuer("https://id.example.com/?tenant=1")).toThrow(/MAINWORTHY_OIDC_ISSUER/);
		expect(issuer("not a url")).toThrow(/MAINWORTHY_OIDC_ISSUER/);
		expect(issuer("http://127.0.0.1:9000")()).toMatchObject({ oidc: { issuer: "http://127.0.0.1:9000" } });
		expect(issuer("https://login.example.com/tenant/v2.0")()).toMatchObject({
			oidc: { issuer: "https://login.example.com/tenant/v2.0" },
		});
	});

	test("the sign-in page is told the token and the provider's name, and no provider on an instance without one", async () => {
		expect(must(await (await world()).get<unknown>("/api/login/methods"))).toEqual({
			token: true,
			oidc: { name: "Example ID" },
		});
		const none = await world({ idp: null });
		expect(must(await none.get<unknown>("/api/login/methods"))).toEqual({ token: true, oidc: null });
		expect((await none.post("/api/login/oidc", {})).status).toBe(400);
	});
});

describe("joining and signing in", () => {
	test("a person joins through the provider, then signs in with that identity; the sessions rest on it", async () => {
		const w = await world();
		await joined(w, "robin");
		const [asked] = w.idp?.asked ?? [];
		expect(asked?.get("redirect_uri")).toBe(CALLBACK);
		expect(asked?.get("response_type")).toBe("code");
		expect(asked?.get("scope")).toBe("openid email profile");
		expect(asked?.get("code_challenge_method")).toBe("S256");
		expect(asked?.get("state")?.length).toBeGreaterThanOrEqual(43);
		expect(asked?.get("nonce")?.length).toBeGreaterThanOrEqual(43);
		// Only a ceremony of proof asks the provider to sign the person in again.
		expect(asked?.get("max_age")).toBeNull();
		const rows = await oidcRows(w);
		expect(rows).toEqual([
			{
				id: expect.any(Number),
				actor: expect.any(Number),
				kind: "oidc",
				handle: `${w.idp?.issuer}#sub-robin`,
				label: "Example ID (robin@example.com)",
				revoked_at: null,
			},
		]);

		const signedIn = await signIn(w, "robin");
		expect(must(signedIn)).toEqual({ signedIn: true });
		const cookie = sessionOf(signedIn);
		expect(must(await w.get<{ actor: string }>("/api/session", jar(cookie))).actor).toBe("robin");
		const [latest] = await w.rows<{ credential: number }>("SELECT credential FROM sessions ORDER BY id DESC LIMIT 1");
		expect(latest?.credential).toBe(rows[0]?.id ?? -1);
		// The person's list of sessions says what opened each.
		const sessions = must(await w.op<{ openedWith: string; label: string }[]>("session", { do: "list" }, jar(cookie)));
		expect(sessions.map((row) => `${row.openedWith} ${row.label}`)).toEqual([
			"oidc Example ID (robin@example.com)",
			"oidc Example ID (robin@example.com)",
		]);
		// The ceremony ends with the sign-in: its cookie is cleared with the reply.
		expect(signedIn.setCookies.some((set) => /^mainworthy_ceremony=;.*Max-Age=0/.test(set))).toBe(true);
	});

	test("an identity nobody linked signs nobody in, and is not given a person by its email", async () => {
		const w = await world();
		await joined(w, "robin");
		const lines = await logged(async () => {
			const reply = await viaProvider(w, { subject: "sub-x", email: "robin@example.com", name: "robin" });
			expect(reply.text).toBe(REFUSED);
		});
		expect(lines).toEqual(["[mainworthy] sign-in refused: unknown-identity"]);
		expect((await oidcRows(w)).map((row) => row.handle)).toEqual([`${w.idp?.issuer}#sub-robin`]);
	});

	test("the provider's answer is taken once, in the browser that began, inside the ceremony's time", async () => {
		const clock = clockAt();
		const w = await world({ clock });
		await joined(w, "robin");
		const robin = { subject: subjectOf("robin") };
		const lines = await logged(async () => {
			// Without the ceremony cookie, or with another browser's.
			let begun = await begin(w);
			let query = await authorize(w, begun, robin);
			const elsewhere = await begin(w);
			expect((await finish(w, query, {})).text).toBe(REFUSED);
			expect((await finish(w, query, jar(elsewhere.ceremony))).text).toBe(REFUSED);
			// Twice: the second finds the ceremony spent.
			begun = await begin(w);
			query = await authorize(w, begun, robin);
			expect((await finish(w, query, jar(begun.ceremony))).status).toBe(200);
			expect((await finish(w, query, jar(begun.ceremony))).text).toBe(REFUSED);
			// Late.
			begun = await begin(w);
			query = await authorize(w, begun, robin);
			clock.advance(5 * 60_000);
			expect((await finish(w, query, jar(begun.ceremony))).text).toBe(REFUSED);
			// A state this server never made, and a query with no state.
			expect((await finish(w, "?code=x&state=made-up-state-made-up-state-made-up-sta", jar(begun.ceremony))).text).toBe(
				REFUSED,
			);
			expect((await finish(w, "?code=x", jar(begun.ceremony))).text).toBe(REFUSED);
		});
		expect(lines).toEqual([
			"[mainworthy] sign-in refused: context",
			"[mainworthy] sign-in refused: context",
			"[mainworthy] sign-in refused: challenge",
			"[mainworthy] sign-in refused: challenge",
			"[mainworthy] sign-in refused: challenge",
			"[mainworthy] sign-in refused: challenge",
		]);
	});

	test("an ID token with another key, issuer, audience or nonce, or one that ran out, is refused; so is the provider's error", async () => {
		const w = await world();
		await joined(w, "robin");
		const sessions = () => w.rows<{ n: number }>("SELECT count(*)::integer AS n FROM sessions");
		const before = await sessions();
		const twists: NonNullable<Next["twist"]>[] = [
			{ key: "other" },
			{ issuer: "https://elsewhere.example" },
			{ audience: "another-client" },
			{ nonce: "not-the-nonce-that-was-sent" },
			{ expiresIn: -120 },
			{ error: "access_denied" },
		];
		const lines = await logged(async () => {
			for (const twist of twists)
				expect((await viaProvider(w, { subject: subjectOf("robin"), twist })).text).toBe(REFUSED);
		});
		const why = [
			"invalid response encountered",
			"unexpected JWT claim value encountered",
			"unexpected JWT claim value encountered",
			"unexpected JWT claim value encountered",
			"JWT timestamp claim value failed validation",
			"authorization response from the server is an error",
		];
		expect(lines).toEqual(
			why.flatMap((reason) => [
				`[mainworthy] the identity provider's answer was not taken: ${reason}`,
				"[mainworthy] sign-in refused: provider",
			]),
		);
		expect(await sessions()).toEqual(before);
	});

	test("a ceremony begun for one purpose finishes as that purpose: a sign-in's answer links nothing", async () => {
		const w = await world();
		const cookie = await joined(w, "robin");
		expect(must(await prove(w, cookie, "robin"))).toEqual({ proven: true });
		// Begun without a session (a sign-in), finished by a browser that holds one: still a sign-in, refused.
		const begun = await begin(w);
		const query = await authorize(w, begun, { subject: "alt-robin" });
		await logged(async () => {
			expect((await finish(w, query, jar(cookie, begun.ceremony))).text).toBe(REFUSED);
		});
		expect(await oidcRows(w)).toHaveLength(1);
	});
});

describe("linking", () => {
	test("only a browser signed in as a person links an identity, and only to that person's own session", async () => {
		const w = await world();
		expect((await w.post("/api/login/oidc", { link: true })).status).toBe(401);
		expect((await w.post("/api/login/oidc", { link: true }, bearer(TOKEN))).status).toBe(403);
		const robin = await joined(w, "robin");
		const sam = await joined(w, "sam");
		expect(must(await prove(w, robin, "robin"))).toEqual({ proven: true });
		const begun = await begin(w, { link: true }, jar(robin));
		const query = await authorize(w, begun, { subject: "alt-robin" });
		// Finished in a browser signed in as somebody else: refused, nothing linked.
		await logged(async () => {
			expect((await finish(w, query, jar(sam, begun.ceremony))).text).toBe(REFUSED);
		});
		expect(await oidcRows(w)).toHaveLength(2);
	});

	test("an identity belongs to one person: linking it again, or to another person, is refused", async () => {
		const w = await world();
		const robin = await joined(w, "robin");
		const sam = await joined(w, "sam");
		for (const [cookie, name] of [
			[robin, "robin"],
			[sam, "sam"],
		] as const)
			expect((await link(w, cookie, name, { subject: subjectOf("robin") })).status).toBe(409);
		expect(await oidcRows(w)).toHaveLength(2);
	});

	test("an identity removed, or of a person who was forgotten, keeps no subject and can be linked again", async () => {
		const w = await world();
		const robin = await joined(w, "robin");
		expect(must(await link(w, robin, "robin", { subject: "alt-robin" }))).toEqual({ linked: true });
		const [first] = await oidcRows(w);
		expect(must(await w.op("credential", { do: "remove", id: first?.id }, jar(robin)))).toMatchObject({
			removed: true,
		});
		expect((await oidcRows(w))[0]).toEqual(expect.objectContaining({ handle: null, revoked_at: expect.any(Number) }));
		const sam = await joined(w, "sam");
		expect(must(await link(w, sam, "sam", { subject: subjectOf("robin") }))).toEqual({ linked: true });
		await w.ok("admin", { do: "actor.forget", name: "sam" });
		expect((await oidcRows(w)).map((held) => held.handle)).toEqual([null, `${w.idp?.issuer}#alt-robin`, null, null]);
		expect(
			await w.rows(
				"SELECT id FROM credentials WHERE handle LIKE '%sub-robin%' OR data LIKE '%sub-robin%' OR label LIKE '%sam@%'",
			),
		).toEqual([]);
	});
});

describe("invitations", () => {
	test("an invitation is accepted through the provider: the identity is the person's, and the invitation is spent", async () => {
		const w = await world();
		const { code } = await invite(w, { name: "robin", can: ["read"], project: "scratch" });
		const accepted = await viaProvider(
			w,
			{ subject: subjectOf("robin"), email: "robin@example.com" },
			{ invitation: code },
		);
		expect(must(accepted)).toEqual({ signedIn: true });
		expect(must(await w.get<{ actor: string }>("/api/session", jar(sessionOf(accepted)))).actor).toBe("robin");
		expect((await oidcRows(w)).map((row) => row.handle)).toEqual([`${w.idp?.issuer}#sub-robin`]);
		// Spent: the code begins nothing more.
		expect((await w.post("/api/login/oidc", { invitation: code })).status).toBe(404);
		expect(must(await signIn(w, "robin"))).toEqual({ signedIn: true });
	});

	test("a browser signed in as somebody else is asked first", async () => {
		const w = await world();
		const sam = await joined(w, "sam");
		const { code } = await invite(w, { name: "robin", can: ["read"], project: "scratch" });
		const asked = await w.post("/api/login/oidc", { invitation: code }, jar(sam));
		expect(asked.status).toBe(409);
		expect(asked.body).toMatchObject({ ok: false, error: { details: { signedInAs: "sam" } } });
		const begun = await begin(w, { invitation: code, replace: "sam" }, jar(sam));
		expect(
			(await w.rows<{ payload: string }>("SELECT payload FROM identity_ceremonies WHERE kind = 'oidc'"))
				.map((row) => row.payload)
				.join("\n"),
		).not.toContain('"sam"');
		const query = await authorize(w, begun, { subject: subjectOf("robin") });
		const accepted = await finish(w, query, jar(sam, begun.ceremony));
		expect(must(await w.get<{ actor: string }>("/api/session", jar(sessionOf(accepted)))).actor).toBe("robin");
		expect((await w.get("/api/session", jar(sam))).status).toBe(401);
	});

	test("a recovery invitation accepted through the provider replaces every other way in", async () => {
		const w = await world();
		const old = await joined(w, "robin");
		const { code, purpose } = await invite(w, { name: "robin" });
		expect(purpose).toBe("recover");
		expect(must(await viaProvider(w, { subject: "new-robin" }, { invitation: code }))).toEqual({ signedIn: true });
		expect((await w.get("/api/session", jar(old))).status).toBe(401);
		await logged(async () => {
			expect((await signIn(w, "robin")).text).toBe(REFUSED);
		});
		expect(
			await w.rows<{ kind: string; handle: string }>("SELECT kind, handle FROM credentials WHERE revoked_at IS NULL"),
		).toEqual([{ kind: "oidc", handle: `${w.idp?.issuer}#new-robin` }]);
	});
});

describe("the rules about ways in", () => {
	test("linking a second identity needs recent proof, checked at both ends of the ceremony", async () => {
		const w = await world();
		const robin = await joined(w, "robin");
		expect((await w.post("/api/login/oidc", { link: true }, jar(robin))).body).toMatchObject({
			error: { code: "recent_proof_required" },
		});
		expect(must(await prove(w, robin, "robin"))).toEqual({ proven: true });
		w.clock.advance(9 * 60_000 + 59_000);
		const linking = await begin(w, { link: true }, jar(robin));
		const query = await authorize(w, linking, { subject: "alt-robin" });
		w.clock.advance(1_001);
		expect((await finish(w, query, jar(robin, linking.ceremony))).body).toMatchObject({
			error: { code: "recent_proof_required" },
		});
		expect(await oidcRows(w)).toHaveLength(1);
		expect(must(await link(w, robin, "robin", { subject: "alt-robin" }))).toEqual({ linked: true });
		expect(await oidcRows(w)).toHaveLength(2);
	});

	test("unlinking an identity needs proof and ends the sessions resting on it; the last one stays", async () => {
		const w = await world();
		const robin = await joined(w, "robin");
		expect(must(await link(w, robin, "robin", { subject: "alt-robin" }))).toEqual({ linked: true });
		const viaAlt = sessionOf(await viaProvider(w, { subject: "alt-robin" }));
		const listed = must(await w.op<{ id: number; kind: string }[]>("credential", { do: "list" }, jar(viaAlt)));
		expect(listed.map((row) => row.kind)).toEqual(["oidc", "oidc"]);
		const [first, second] = listed;
		expect((await w.op("credential", { do: "remove", id: first?.id }, jar(viaAlt))).body).toMatchObject({
			error: { code: "recent_proof_required" },
		});
		expect(must(await prove(w, viaAlt, "robin"))).toEqual({ proven: true });
		expect((await w.op("credential", { do: "remove", id: first?.id }, jar(viaAlt))).status).toBe(200);
		// The session of the join rested on the identity that was unlinked.
		expect(await w.status(jar(robin))).toBe(401);
		expect(await w.status(jar(viaAlt))).toBe(200);
		// Now the other identity is the last way in, and stays.
		expect((await w.op("credential", { do: "remove", id: second?.id }, jar(viaAlt))).status).toBe(400);
	});
});

describe("a slow provider", () => {
	test("an import while the code is being exchanged ends that ceremony too", async () => {
		const w = await world();
		await joined(w, "robin");
		let arrived = (): void => {};
		const reached = new Promise<void>((resolve) => {
			arrived = resolve;
		});
		let release = (): void => {};
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		const begun = await begin(w);
		const query = await authorize(w, begun, {
			subject: subjectOf("robin"),
			twist: {
				held: () => {
					arrived();
					return released;
				},
			},
		});
		const lines = await logged(async () => {
			const finishing = finish(w, query, jar(begun.ceremony));
			await reached;
			const peer = await world({ dataDir: w.dataDir, clock: w.clock, idp: w.idp });
			await clearChallenges(peer.instance.app);
			release();
			expect((await finishing).text).toBe(REFUSED);
		});
		expect(lines).toEqual(["[mainworthy] sign-in refused: challenge"]);
	});
});

describe("an import", () => {
	test("ends every ceremony that was under way", async () => {
		const w = await world();
		const archive = await (await fetch(`${w.instance.url}/api/export`, { headers: bearer(TOKEN) })).text();
		const begun = await begin(w);
		const query = await authorize(w, begun, { subject: subjectOf("robin") });
		const imported = await fetch(`${w.instance.url}/api/import`, {
			method: "POST",
			headers: bearer(TOKEN),
			body: archive,
		});
		expect(imported.status).toBe(200);
		const lines = await logged(async () => {
			expect((await finish(w, query, jar(begun.ceremony))).text).toBe(REFUSED);
		});
		expect(lines).toEqual(["[mainworthy] sign-in refused: challenge"]);
	});
});

test("an OIDC ceremony can finish on another App, with one resulting session", async () => {
	const first = await world();
	await joined(first, "robin");
	const second = await world({ dataDir: first.dataDir, clock: first.clock, idp: first.idp });
	const begun = await begin(first);
	const query = await authorize(first, begun, { subject: subjectOf("robin") });
	const answers = await Promise.all([first, second].map((w) => finish(w, query, jar(begun.ceremony))));
	expect(answers.map((answer) => answer.status).sort()).toEqual([200, 401]);
});
