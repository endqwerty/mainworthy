// Signing in through an identity provider (OpenID Connect) on a real listener, against the provider of
// `test/oidc-support.ts`. What has to hold: the provider's word is taken only for a ceremony this server began,
// in the browser that began it, once; the ID token is checked (signature, issuer, audience, nonce, time); an
// identity reaches a person only by an invitation or by the person linking it, never by a claim; and an `oidc`
// credential is a way in like a password, for the rules about removing one and about admins.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { bootstrap, clearChallenges } from "../src/server/identity/identity.ts";
import { defaultConfig } from "../src/server/kernel/app.ts";
import { type Provider, provider, stopProviders } from "./oidc-support.ts";
import {
	type Answer,
	bearer,
	cleanUp,
	clockAt,
	from,
	invite,
	joined,
	must,
	PUBLIC,
	type Sent,
	said,
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

describe("admins and a second factor", () => {
	for (const mfa of [false, true])
		for (const path of ["a personal grant", "a team grant", "a start"])
			test(`an admin by ${path} keeps a session through the provider only when it enforces a second factor (${mfa})`, async () => {
				const idp = await provider();
				const w = world({ oidc: idp.config({ mfa }) });
				const { code } = await invite(w, { name: "robin", can: ["read"], project: "scratch" });
				const begun = await begin(w, { invitation: code });
				const query = await authorize(idp, begun, { subject: "sub-robin" });
				const cookie = sessionOf(await finish(w, query, jar(begun.ceremony)));
				const password = await joined(w, "sam", PASSWORD);
				if (path === "a start") {
					await w.ok("admin", { do: "grant.set", actor: "robin", project: "scratch", can: ["read", "admin"] });
					await w.ok("admin", { do: "grant.set", actor: "sam", project: "scratch", can: ["read", "admin"] });
					w.instance.app.config.requireAdminMfa = true;
					await w.instance.app.gate.run(() => bootstrap(w.instance.app));
				} else {
					w.instance.app.config.requireAdminMfa = true;
					for (const name of ["robin", "sam"])
						if (path === "a personal grant")
							await w.ok("admin", { do: "grant.set", actor: name, project: "scratch", can: ["read", "admin"] });
					if (path === "a team grant") {
						await w.ok("admin", { do: "team.create", name: "Admins" });
						await w.ok("admin", { do: "team.member.add", team: "Admins", person: "robin" });
						await w.ok("admin", { do: "team.member.add", team: "Admins", person: "sam" });
						await w.ok("admin", { do: "team.grant.set", team: "Admins", project: "scratch", can: ["admin"] });
					}
				}
				expect(await w.status(jar(cookie))).toBe(mfa ? 200 : 401);
				// A password session ends either way: the provider's word says nothing of a password.
				expect(await w.status(jar(password))).toBe(401);
			});
});

describe("a provider that is gone or replaced", () => {
	test("an identity of no configured provider is no way in: the last password stays", async () => {
		for (const now of ["gone", "replaced"] as const) {
			const idp = await provider();
			const w = world({ oidc: idp.config() });
			const robin = await linked(w, idp, "robin", "sub-robin");
			// As a start without the provider, or with another one, would have it.
			if (now === "gone") delete w.instance.app.config.oidc;
			else w.instance.app.config.oidc = idp.config({ issuer: "https://login.example.com" });
			const listed = must(await w.op<{ id: number; kind: string }[]>("credential", { do: "list" }, jar(robin)));
			const password = listed.find((row) => row.kind === "password");
			expect((await w.op("credential", { do: "remove", id: password?.id }, jar(robin))).status).toBe(400);
			expect((await signIn(w, "robin", PASSWORD)).status).toBe(200);
		}
	});
});

describe("a slow provider", () => {
	test("an import while the code is being exchanged ends that ceremony too", async () => {
		const idp = await provider();
		const w = world({ oidc: idp.config() });
		await linked(w, idp, "robin", "sub-robin");
		let arrived = (): void => {};
		const reached = new Promise<void>((resolve) => {
			arrived = resolve;
		});
		let release = (): void => {};
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		const begun = await begin(w);
		const query = await authorize(idp, begun, {
			subject: "sub-robin",
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
			clearChallenges(w.instance.app);
			release();
			expect((await finishing).text).toBe(REFUSED);
		});
		expect(lines).toEqual(["[mainworthy] sign-in refused: challenge"]);
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

describe("native provider sign-in", () => {
	const callback = "com.mainworthy.app://signin/oidc";
	const verifier = "a".repeat(43);
	const state = "s".repeat(43);
	const challenge = () => new Bun.CryptoHasher("sha256").update(verifier).digest("base64url");
	async function handoff(w: World, idp: Provider, headers: Sent = {}) {
		const begun = must(
			await w.post<{ url: string }>("/api/login/oidc/native", {
				challenge: challenge(),
				state,
				callback,
				instance: PUBLIC,
			}),
		);
		idp.next({ subject: "native-robin" });
		const authorized = await fetch(begun.url, { redirect: "manual" });
		const back = new URL(authorized.headers.get("location") ?? "");
		expect(back.origin + back.pathname).toBe(`${PUBLIC}/api/login/oidc/native/callback`);
		const done = await fetch(`${w.instance.url}${back.pathname}${back.search}`, { headers, redirect: "manual" });
		expect(done.status).toBe(302);
		expect(done.headers.has("set-cookie")).toBe(false);
		const native = new URL(done.headers.get("location") ?? "");
		expect(native.origin + native.pathname).toBe("null/oidc");
		expect(native.searchParams.get("state")).toBe(state);
		return native.searchParams.get("code") ?? "";
	}
	const exchange = (w: World, code: string, more = {}) =>
		w.post("/api/login", {
			nativeOidc: { code, verifier, callback, instance: PUBLIC, ...more },
		});
	test("exchanges a code once for an ordinary credential-backed session, with no browser cookie", async () => {
		const idp = await provider();
		const w = world({ oidc: idp.config() });
		const robin = await linked(w, idp, "robin", "native-robin");
		const code = await handoff(w, idp);
		const reply = await exchange(w, code);
		expect(must(reply)).toEqual({ signedIn: true });
		expect(must(await w.get("/api/session", jar(sessionOf(reply))))).toMatchObject({ actor: "robin", via: "cookie" });
		expect((await exchange(w, code)).text).toBe(REFUSED);
		const credentials = must(await w.op<{ id: number; kind: string }[]>("credential", { do: "list" }, jar(robin)));
		const identity = credentials.find((c) => c.kind === "oidc");
		expect((await w.op("credential", { do: "remove", id: identity?.id }, jar(robin))).status).toBe(200);
		expect((await w.get("/api/session", jar(sessionOf(reply)))).status).toBe(401);
	});

	test("rejects interception, another request's verifier, wrong instance and callback without spending the code", async () => {
		const idp = await provider();
		const w = world({ oidc: idp.config() });
		await linked(w, idp, "robin", "native-robin");
		const code = await handoff(w, idp);
		for (const more of [
			{ verifier: "b".repeat(43) },
			{ instance: "https://elsewhere.example" },
			{ callback: "other://signin/oidc" },
		]) {
			expect((await exchange(w, code, more)).status).toBeOneOf([400, 401]);
		}
		const other = world({ oidc: idp.config() });
		expect((await exchange(other, code)).text).toBe(REFUSED);
		expect(must(await exchange(w, code))).toEqual({ signedIn: true });
	});

	test("expires at one minute and is cancelled by an import", async () => {
		const idp = await provider();
		const clock = clockAt();
		const w = world({ clock, oidc: idp.config() });
		await linked(w, idp, "robin", "native-robin");
		const expired = await handoff(w, idp);
		clock.advance(60_000);
		expect((await exchange(w, expired)).text).toBe(REFUSED);
		const cleared = await handoff(w, idp);
		clearChallenges(w.instance.app);
		expect((await exchange(w, cleared)).text).toBe(REFUSED);
	});

	test("refuses an arbitrary redirect and an instance other than the public origin at begin", async () => {
		const idp = await provider();
		const w = world({ oidc: idp.config() });
		for (const more of [{ callback: "https://elsewhere.example" }, { instance: "https://elsewhere.example" }]) {
			expect(
				(await w.post("/api/login/oidc/native", { challenge: challenge(), state, callback, instance: PUBLIC, ...more }))
					.status,
			).toBe(400);
		}
	});
	test("concurrent exchanges open exactly one session and an unrelated browser cookie cannot change its person", async () => {
		const idp = await provider();
		const w = world({ oidc: idp.config() });
		await linked(w, idp, "robin", "native-robin");
		const sam = await joined(w, "sam", PASSWORD);
		const code = await handoff(w, idp);
		const answers = await Promise.all([
			w.post("/api/login", { nativeOidc: { code, verifier, callback, instance: PUBLIC } }, jar(sam)),
			exchange(w, code),
		]);
		expect(answers.map((a) => a.status).sort()).toEqual([200, 401]);
		const accepted = answers.find((a) => a.status === 200);
		if (!accepted) throw new Error("no session opened");
		expect(must(await w.get("/api/session", jar(sessionOf(accepted))))).toMatchObject({ actor: "robin" });
		expect(must(await w.get("/api/session", jar(sam)))).toMatchObject({ actor: "sam" });
	});

	test("a revoked credential or changed provider cannot open a session from a pending code", async () => {
		const idp = await provider();
		const w = world({ oidc: idp.config() });
		const robin = await linked(w, idp, "robin", "native-robin");
		const code = await handoff(w, idp);
		const credentials = must(await w.op<{ id: number; kind: string }[]>("credential", { do: "list" }, jar(robin)));
		const credential = credentials.find((c) => c.kind === "oidc");
		expect((await w.op("credential", { do: "remove", id: credential?.id }, jar(robin))).status).toBe(200);
		expect((await exchange(w, code)).text).toBe(REFUSED);
		const relink = await begin(w, { link: true }, jar(robin));
		const query = await authorize(idp, relink, { subject: "native-robin" });
		expect(must(await finish(w, query, jar(robin, relink.ceremony)))).toEqual({ linked: true });
		const changed = await handoff(w, idp);
		delete w.instance.app.config.oidc;
		expect((await exchange(w, changed)).text).toBe(REFUSED);
	});

	test("admin MFA is checked again when the native session is opened", async () => {
		const idp = await provider();
		const w = world({ oidc: idp.config() });
		await linked(w, idp, "robin", "native-robin");
		const code = await handoff(w, idp);
		await w.ok("admin", { do: "grant.set", actor: "robin", project: "scratch", can: ["read", "admin"] });
		w.instance.app.config.requireAdminMfa = true;
		expect((await exchange(w, code)).status).toBe(403);
		w.instance.app.config.oidc = idp.config({ mfa: true });
		expect(must(await exchange(w, await handoff(w, idp)))).toEqual({ signedIn: true });
	});

	test.each(["unknown-identity", "refused", "unknown-ceremony"])(
		"refused native callbacks count toward the shared address limit: %s",
		async (subject) => {
			const idp = await provider();
			const w = world({ oidc: idp.config(), proxied: true });
			await linked(w, idp, "robin", "native-robin");
			const address = from("203.0.113.10");
			const finishNative = async () => {
				let query = "?state=unknown";
				if (subject !== "unknown-ceremony") {
					const begun = must(
						await w.post<{ url: string }>("/api/login/oidc/native", {
							challenge: challenge(),
							state,
							callback,
							instance: PUBLIC,
						}),
					);
					idp.next({ subject, ...(subject === "refused" ? { twist: { error: "access_denied" } } : {}) });
					const authorized = await fetch(begun.url, { redirect: "manual" });
					query = new URL(authorized.headers.get("location") ?? "").search;
				}
				return fetch(`${w.instance.url}/api/login/oidc/native/callback${query}`, {
					headers: address,
					redirect: "manual",
				});
			};
			for (let count = 0; count < 5; count++) {
				const reply = await finishNative();
				expect(reply.status).toBe(subject === "unknown-ceremony" ? 401 : 302);
				await reply.text();
			}
			const limited = await finishNative();
			if (subject === "unknown-ceremony") {
				expect(limited.status).toBe(429);
				expect(limited.headers.get("retry-after")).toBe("1");
				expect(await limited.json()).toMatchObject({ ok: false, error: { code: "limited" } });
			} else {
				expect(limited.status).toBe(302);
				expect(limited.headers.has("set-cookie")).toBe(false);
				expect(limited.headers.get("location")).toBe(`${callback}?state=${state}&error=limited&retryAfter=1`);
				await limited.text();
			}
			expect(said(await finish(w, "?state=unknown", address))).toBe("429 limited, retry after 1");
			expect(said(await finish(w, "?state=unknown", from("203.0.113.11")))).toBe("401 unauthenticated");
			expect(must(await exchange(w, await handoff(w, idp, address)))).toEqual({ signedIn: true });
		},
	);

	test("the native callback cannot complete a browser ceremony, and provider refusal returns no code", async () => {
		const idp = await provider();
		const w = world({ oidc: idp.config() });
		await linked(w, idp, "robin", "native-robin");
		const browser = await begin(w);
		const query = await authorize(idp, browser, { subject: "native-robin" });
		const wrong = await fetch(`${w.instance.url}/api/login/oidc/native/callback${query}`, { redirect: "manual" });
		expect(wrong.status).toBe(401);
		expect(must(await finish(w, query, jar(browser.ceremony)))).toEqual({ signedIn: true });
		for (const subject of ["unknown-identity", "refused"]) {
			const begun = must(
				await w.post<{ url: string }>("/api/login/oidc/native", {
					challenge: challenge(),
					state,
					callback,
					instance: PUBLIC,
				}),
			);
			idp.next({ subject, ...(subject === "refused" ? { twist: { error: "access_denied" } } : {}) });
			const authorized = await fetch(begun.url, { redirect: "manual" });
			const back = new URL(authorized.headers.get("location") ?? "");
			const done = await fetch(`${w.instance.url}${back.pathname}${back.search}`, { redirect: "manual" });
			expect(done.status).toBe(302);
			const native = new URL(done.headers.get("location") ?? "");
			expect(native.searchParams.get("code")).toBe(null);
			expect(native.searchParams.get("state")).toBe(state);
			expect(native.searchParams.get("error")).toBe("unauthenticated");
		}
	});
});
