// Signing in through an identity provider (OpenID Connect) on a real listener, against the provider of
// `test/oidc-support.ts`. What has to hold: the provider's word is taken only for a ceremony this server began,
// in the browser that began it, once; the ID token is checked (signature, issuer, audience, nonce, time); an
// identity reaches a person only by an invitation or by the person linking it, never by a claim; and an `oidc`
// credential is a way in like a password, for the rules about removing one and about admins.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { defaultConfig } from "../src/server/kernel/app.ts";
import { type Provider, provider, stopProviders } from "./oidc-support.ts";
import {
	type Answer,
	bearer,
	cleanUp,
	clockAt,
	invite,
	joined,
	must,
	PUBLIC,
	type Sent,
	signIn,
	TOKEN,
	type World,
	world,
} from "./people-support.ts";

afterEach(async () => {
	stopProviders();
	await cleanUp();
});

const REFUSED = '{"ok":false,"error":{"code":"unauthenticated","message":"that did not sign you in"}}';
const PASSWORD = "correct horse battery staple";
const CALLBACK = `${PUBLIC}/signin/oidc`;

/** The cookies of a reply as a browser sends them back, joined with any it already holds. */
const jar = (...cookies: (string | null | undefined)[]): Sent => ({
	cookie: cookies.filter((cookie): cookie is string => !!cookie).join("; "),
});
const cookiesOf = (reply: Answer<unknown>): string[] => reply.setCookies.map((cookie) => cookie.split(";")[0] ?? "");
const ceremonyOf = (reply: Answer<unknown>): string =>
	cookiesOf(reply).find((cookie) => cookie.startsWith("mainworthy_ceremony=")) ?? "";
const sessionOf = (reply: Answer<unknown>): string =>
	cookiesOf(reply).find((cookie) => cookie.startsWith("mainworthy_sid=")) ?? "";

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

/** A ceremony begun in a browser: where the page sends the person, and the ceremony cookie it was handed. */
type Begun = { url: URL; ceremony: string };
async function begin(w: World, body: Record<string, unknown> = {}, headers: Sent = {}): Promise<Begun> {
	const reply = await w.post<{ url: string }>("/api/login/oidc", body, headers);
	return { url: new URL(must(reply).url), ceremony: ceremonyOf(reply) };
}

/** The provider's answer to a ceremony: the query the provider sent the browser back to the page with. */
async function authorize(idp: Provider, begun: Begun, who: Parameters<Provider["next"]>[0]): Promise<string> {
	idp.next(who);
	const answer = await fetch(begun.url, { redirect: "manual" });
	const location = new URL(answer.headers.get("location") ?? "");
	expect(location.origin + location.pathname).toBe(CALLBACK);
	return location.search;
}

/** The page at `/signin/oidc` hands the query to the server, with the cookies the browser holds. */
const finish = (w: World, query: string, headers: Sent) =>
	w.post<{ signedIn?: true; linked?: true }>("/api/login", { oidc: query }, headers);

/** Signs in through the provider as `subject`, from a browser that holds nothing yet. */
async function viaProvider(w: World, idp: Provider, subject: string, twist?: Parameters<Provider["next"]>[0]["twist"]) {
	const begun = await begin(w);
	const query = await authorize(idp, begun, { subject, ...(twist ? { twist } : {}) });
	return finish(w, query, jar(begun.ceremony));
}

/** A person who joined with a password and linked `subject` at the provider from their settings. */
async function linked(w: World, idp: Provider, name: string, subject: string): Promise<string> {
	const cookie = await joined(w, name, PASSWORD);
	const begun = await begin(w, { link: true }, jar(cookie));
	const query = await authorize(idp, begun, { subject, email: `${name}@example.com` });
	expect(must(await finish(w, query, jar(cookie, begun.ceremony)))).toEqual({ linked: true });
	return cookie;
}

type Row = { id: number; actor: number; kind: string; handle: string | null; label: string; revoked_at: number | null };
const oidcRows = (w: World) =>
	w.rows<Row>("SELECT id, actor, kind, handle, label, revoked_at FROM credentials WHERE kind = 'oidc' ORDER BY id");

describe("the configuration", () => {
	const env = {
		MAINWORTHY_PUBLIC_URL: PUBLIC,
		MAINWORTHY_OIDC_ISSUER: "https://id.example.com",
		MAINWORTHY_OIDC_CLIENT_ID: "mainworthy",
		MAINWORTHY_OIDC_CLIENT_SECRET: "s3cret",
		MAINWORTHY_OIDC_NAME: "Example ID",
	};
	test("the four variables are set together, with a public address; the provider enforcing a second factor is the operator's word", () => {
		expect(defaultConfig(env).oidc).toEqual({
			issuer: "https://id.example.com",
			clientId: "mainworthy",
			clientSecret: "s3cret",
			name: "Example ID",
			mfa: false,
		});
		expect(defaultConfig({ ...env, MAINWORTHY_OIDC_MFA: "true" }).oidc?.mfa).toBe(true);
		expect(defaultConfig({}).oidc).toBeUndefined();
		expect(() => defaultConfig({ ...env, MAINWORTHY_OIDC_CLIENT_SECRET: "" })).toThrow(/together/);
		expect(() => defaultConfig({ ...env, MAINWORTHY_PUBLIC_URL: "" })).toThrow(/MAINWORTHY_PUBLIC_URL/);
		expect(() => defaultConfig({ ...env, MAINWORTHY_OIDC_MFA: "yes" })).toThrow(/MAINWORTHY_OIDC_MFA/);
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

	test("the sign-in page is told the provider's name, and nothing on an instance without one", async () => {
		const idp = await provider();
		expect(must(await world({ oidc: idp.config() }).get("/api/login/methods"))).toMatchObject({
			oidc: { name: "Example ID" },
		});
		expect(must(await world().get("/api/login/methods"))).toMatchObject({ oidc: null });
		expect((await world().post("/api/login/oidc", {})).status).toBe(400);
	});
});

describe("linking and signing in", () => {
	test("a person links an identity from their settings, then signs in with it; the session rests on that credential", async () => {
		const idp = await provider();
		const w = world({ oidc: idp.config() });
		await linked(w, idp, "robin", "sub-robin");
		const [asked] = idp.asked;
		expect(asked?.get("redirect_uri")).toBe(CALLBACK);
		expect(asked?.get("response_type")).toBe("code");
		expect(asked?.get("scope")).toBe("openid email profile");
		expect(asked?.get("code_challenge_method")).toBe("S256");
		expect(asked?.get("state")?.length).toBeGreaterThanOrEqual(43);
		expect(asked?.get("nonce")?.length).toBeGreaterThanOrEqual(43);
		expect(oidcRows(w)).toEqual([
			{
				id: 2,
				actor: expect.any(Number),
				kind: "oidc",
				handle: `${idp.issuer}#sub-robin`,
				label: "Example ID (robin@example.com)",
				revoked_at: null,
			},
		]);

		const signedIn = await viaProvider(w, idp, "sub-robin");
		expect(must(signedIn)).toEqual({ signedIn: true });
		const cookie = sessionOf(signedIn);
		expect(must(await w.get<{ actor: string }>("/api/session", jar(cookie))).actor).toBe("robin");
		expect(w.rows<{ credential: number }>("SELECT credential FROM sessions ORDER BY id DESC LIMIT 1")).toEqual([
			{ credential: 2 },
		]);
		// The person's list of sessions says what opened this one.
		const sessions = must(await w.op<{ openedWith: string; label: string }[]>("session", { do: "list" }, jar(cookie)));
		expect(sessions.map((row) => `${row.openedWith} ${row.label}`)).toEqual([
			"password password",
			"oidc Example ID (robin@example.com)",
		]);
		// The ceremony ends with the sign-in: its cookie is cleared with the reply.
		expect(signedIn.setCookies.some((set) => /^mainworthy_ceremony=;.*Max-Age=0/.test(set))).toBe(true);
	});

	test("an identity nobody linked signs nobody in, and is not given a person by its email", async () => {
		const idp = await provider();
		const w = world({ oidc: idp.config() });
		await joined(w, "robin", PASSWORD);
		const lines = await logged(async () => {
			const begun = await begin(w);
			const query = await authorize(idp, begun, { subject: "sub-x", email: "robin@example.com", name: "robin" });
			expect((await finish(w, query, jar(begun.ceremony))).text).toBe(REFUSED);
		});
		expect(lines).toEqual(["[mainworthy] sign-in refused: unknown-identity"]);
		expect(oidcRows(w)).toEqual([]);
	});

	test("the provider's answer is taken once, in the browser that began, inside the ceremony's time", async () => {
		const clock = clockAt();
		const idp = await provider();
		const w = world({ clock, oidc: idp.config() });
		await linked(w, idp, "robin", "sub-robin");
		const lines = await logged(async () => {
			// Without the ceremony cookie, or with another browser's.
			let begun = await begin(w);
			let query = await authorize(idp, begun, { subject: "sub-robin" });
			const elsewhere = await begin(w);
			expect((await finish(w, query, {})).text).toBe(REFUSED);
			expect((await finish(w, query, jar(elsewhere.ceremony))).text).toBe(REFUSED);
			// Twice: the second finds the ceremony spent.
			begun = await begin(w);
			query = await authorize(idp, begun, { subject: "sub-robin" });
			expect((await finish(w, query, jar(begun.ceremony))).status).toBe(200);
			expect((await finish(w, query, jar(begun.ceremony))).text).toBe(REFUSED);
			// Late.
			begun = await begin(w);
			query = await authorize(idp, begun, { subject: "sub-robin" });
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
		const idp = await provider();
		const w = world({ oidc: idp.config() });
		await linked(w, idp, "robin", "sub-robin");
		const twists = [
			{ key: "other" as const },
			{ issuer: "https://elsewhere.example" },
			{ audience: "another-client" },
			{ nonce: "not-the-nonce-that-was-sent" },
			{ expiresIn: -120 },
			{ error: "access_denied" },
		];
		const lines = await logged(async () => {
			for (const twist of twists) expect((await viaProvider(w, idp, "sub-robin", twist)).text).toBe(REFUSED);
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
		expect(w.rows<{ n: number }>("SELECT count(*) AS n FROM sessions WHERE credential = 2")).toEqual([{ n: 0 }]);
	});

	test("a ceremony begun for one purpose finishes as that purpose: a sign-in's answer links nothing", async () => {
		const idp = await provider();
		const w = world({ oidc: idp.config() });
		const cookie = await joined(w, "robin", PASSWORD);
		// Begun without a session (a sign-in), finished by a browser that holds one: still a sign-in, refused.
		const begun = await begin(w);
		const query = await authorize(idp, begun, { subject: "sub-robin" });
		await logged(async () => {
			expect((await finish(w, query, jar(cookie, begun.ceremony))).text).toBe(REFUSED);
		});
		expect(oidcRows(w)).toEqual([]);
	});
});

describe("linking", () => {
	test("only a browser signed in as a person links an identity, and only to that person's own session", async () => {
		const idp = await provider();
		const w = world({ oidc: idp.config() });
		expect((await w.post("/api/login/oidc", { link: true })).status).toBe(401);
		expect((await w.post("/api/login/oidc", { link: true }, bearer(TOKEN))).status).toBe(403);
		const robin = await joined(w, "robin", PASSWORD);
		const sam = await joined(w, "sam", PASSWORD);
		const begun = await begin(w, { link: true }, jar(robin));
		const query = await authorize(idp, begun, { subject: "sub-robin" });
		// Finished in a browser signed in as somebody else: refused, nothing linked.
		await logged(async () => {
			expect((await finish(w, query, jar(sam, begun.ceremony))).text).toBe(REFUSED);
		});
		expect(oidcRows(w)).toEqual([]);
	});

	test("an identity belongs to one person: linking it again, or to another person, is refused", async () => {
		const idp = await provider();
		const w = world({ oidc: idp.config() });
		const robin = await linked(w, idp, "robin", "sub-robin");
		const sam = await joined(w, "sam", PASSWORD);
		for (const cookie of [robin, sam]) {
			const begun = await begin(w, { link: true }, jar(cookie));
			const query = await authorize(idp, begun, { subject: "sub-robin" });
			const reply = await finish(w, query, jar(cookie, begun.ceremony));
			expect(reply.status).toBe(409);
		}
		expect(oidcRows(w).length).toBe(1);
	});

	test("an identity removed, or of a person who was forgotten, keeps no subject and can be linked again", async () => {
		const idp = await provider();
		const w = world({ oidc: idp.config() });
		const robin = await linked(w, idp, "robin", "sub-robin");
		const [row] = oidcRows(w);
		expect(must(await w.op("credential", { do: "remove", id: row?.id }, jar(robin)))).toMatchObject({ removed: true });
		expect(oidcRows(w)).toEqual([expect.objectContaining({ handle: null, revoked_at: expect.any(Number) })]);
		const sam = await linked(w, idp, "sam", "sub-robin");
		expect(sam).not.toBe("");
		await w.ok("admin", { do: "actor.forget", name: "sam" });
		expect(oidcRows(w).map((held) => held.handle)).toEqual([null, null]);
		expect(
			w.rows(
				"SELECT id FROM credentials WHERE handle LIKE '%sub-robin%' OR data LIKE '%sub-robin%' OR label LIKE '%sam@%'",
			),
		).toEqual([]);
	});
});

describe("invitations", () => {
	test("an invitation is accepted through the provider: the identity is the person's, and the invitation is spent", async () => {
		const idp = await provider();
		const w = world({ oidc: idp.config() });
		const { code } = await invite(w, { name: "robin", can: ["read"], project: "scratch" });
		const begun = await begin(w, { invitation: code });
		const query = await authorize(idp, begun, { subject: "sub-robin", email: "robin@example.com" });
		const accepted = await finish(w, query, jar(begun.ceremony));
		expect(must(accepted)).toEqual({ signedIn: true });
		expect(must(await w.get<{ actor: string }>("/api/session", jar(sessionOf(accepted)))).actor).toBe("robin");
		expect(oidcRows(w).map((row) => row.handle)).toEqual([`${idp.issuer}#sub-robin`]);
		// Spent: the code begins nothing more.
		expect((await w.post("/api/login/oidc", { invitation: code })).status).toBe(404);
		expect(must(await viaProvider(w, idp, "sub-robin"))).toEqual({ signedIn: true });
	});

	test("a browser signed in as somebody else is asked first, as with a password", async () => {
		const idp = await provider();
		const w = world({ oidc: idp.config() });
		const sam = await joined(w, "sam", PASSWORD);
		const { code } = await invite(w, { name: "robin", can: ["read"], project: "scratch" });
		const asked = await w.post("/api/login/oidc", { invitation: code }, jar(sam));
		expect(asked.status).toBe(409);
		expect(asked.body).toMatchObject({ ok: false, error: { details: { signedInAs: "sam" } } });
		const begun = await begin(w, { invitation: code, replace: "sam" }, jar(sam));
		const query = await authorize(idp, begun, { subject: "sub-robin" });
		const accepted = await finish(w, query, jar(sam, begun.ceremony));
		expect(must(await w.get<{ actor: string }>("/api/session", jar(sessionOf(accepted)))).actor).toBe("robin");
		expect((await w.get("/api/session", jar(sam))).status).toBe(401);
	});

	test("a recovery invitation accepted through the provider replaces every other way in", async () => {
		const idp = await provider();
		const w = world({ oidc: idp.config() });
		const old = await joined(w, "robin", PASSWORD);
		const { code, purpose } = await invite(w, { name: "robin" });
		expect(purpose).toBe("recover");
		const begun = await begin(w, { invitation: code });
		const query = await authorize(idp, begun, { subject: "sub-robin" });
		expect(must(await finish(w, query, jar(begun.ceremony)))).toEqual({ signedIn: true });
		expect((await w.get("/api/session", jar(old))).status).toBe(401);
		expect((await signIn(w, "robin", PASSWORD)).status).toBe(401);
		expect(w.rows<{ kind: string }>("SELECT kind FROM credentials WHERE revoked_at IS NULL")).toEqual([
			{ kind: "oidc" },
		]);
	});
});

describe("the rules about ways in", () => {
	test("an identity is a way in: with it the password can be removed, and removing it ends the sessions resting on it", async () => {
		const idp = await provider();
		const w = world({ oidc: idp.config() });
		const robin = await linked(w, idp, "robin", "sub-robin");
		const viaIdp = sessionOf(await viaProvider(w, idp, "sub-robin"));
		const listed = must(await w.op<{ id: number; kind: string }[]>("credential", { do: "list" }, jar(robin)));
		expect(listed.map((row) => row.kind)).toEqual(["password", "oidc"]);
		const password = listed.find((row) => row.kind === "password");
		const identity = listed.find((row) => row.kind === "oidc");
		expect((await w.op("credential", { do: "remove", id: password?.id }, jar(viaIdp))).status).toBe(200);
		// Now the identity is the last way in, and stays.
		expect((await w.op("credential", { do: "remove", id: identity?.id }, jar(viaIdp))).status).toBe(400);
	});

	test("with a second factor required for admins, an admin signs in through the provider only when the operator says it enforces one", async () => {
		for (const mfa of [false, true]) {
			const idp = await provider();
			const w = world({ oidc: idp.config({ mfa }), requireAdminMfa: true });
			const { code } = await invite(w, { name: "robin", can: ["read", "admin"], project: "scratch" });
			const begun = await begin(w, { invitation: code });
			const query = await authorize(idp, begun, { subject: "sub-robin" });
			const accepted = await finish(w, query, jar(begun.ceremony));
			if (mfa) {
				expect(must(accepted)).toEqual({ signedIn: true });
				expect(must(await viaProvider(w, idp, "sub-robin"))).toEqual({ signedIn: true });
			} else expect(accepted.status).toBe(403);
		}
	});
});

describe("an import", () => {
	test("ends every ceremony that was under way", async () => {
		const idp = await provider();
		const w = world({ oidc: idp.config() });
		const archive = await (await fetch(`${w.instance.url}/api/export`, { headers: bearer(TOKEN) })).text();
		const begun = await begin(w);
		const query = await authorize(idp, begun, { subject: "sub-robin" });
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
