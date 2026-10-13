// A person signs in as themselves, in a browser: Chromium accepts an invitation with a passkey it makes on a
// virtual authenticator, signs out, signs in again with the passkey, lists its session and ends it. The page
// is the server's own origin and nothing of the web UI is used: every step is a `fetch` the page makes, so
// the cookie, the origin and the passkey are the browser's own. `test/passkeys.test.ts` holds the rules with an
// authenticator written from the specification; this file is the proof that a real browser gets through them.
import { expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { browserAvailable, openPage, type PageHarness, startServer } from "./support.ts";

type Reply = { status: number; body: { ok: boolean; result?: unknown; error?: { code: string; message: string } } };

/** `fetch` in the page, to its own origin: the browser attaches the cookie and says where the request is from. */
const send = (page: Page, path: string, body?: unknown): Promise<Reply> =>
	page.evaluate(
		async ([path, json]) => {
			const response = await fetch(path, {
				method: json === null ? "GET" : "POST",
				...(json === null ? {} : { headers: { "content-type": "application/json" }, body: json }),
			});
			return { status: response.status, body: await response.json() };
		},
		[path, body === undefined ? null : JSON.stringify(body)] as const,
	);

/** `navigator.credentials.create` with the options the server answered, and what a page sends back of it. */
const register = (page: Page, options: unknown): Promise<unknown> =>
	page.evaluate(async (json) => {
		const credential = await navigator.credentials.create({
			publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(JSON.parse(json)),
		});
		if (!(credential instanceof PublicKeyCredential)) throw new Error("no public key credential");
		// The browser's own JSON form: the contract for the web UI says a page may send these members of it.
		const { id, response } = credential.toJSON();
		if (!("publicKey" in response)) throw new Error("not a registration");
		return {
			id,
			clientDataJSON: response.clientDataJSON,
			authenticatorData: response.authenticatorData,
			publicKey: response.publicKey,
			publicKeyAlgorithm: response.publicKeyAlgorithm,
			transports: response.transports,
		};
	}, JSON.stringify(options));

/** `navigator.credentials.get` with the options the server answered. */
const assert = (page: Page, options: unknown): Promise<unknown> =>
	page.evaluate(async (json) => {
		const credential = await navigator.credentials.get({
			publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(JSON.parse(json)),
		});
		if (!(credential instanceof PublicKeyCredential)) throw new Error("no public key credential");
		const { id, response } = credential.toJSON();
		if (!("signature" in response)) throw new Error("not a sign-in");
		return {
			id,
			clientDataJSON: response.clientDataJSON,
			authenticatorData: response.authenticatorData,
			signature: response.signature,
			userHandle: response.userHandle ?? null,
		};
	}, JSON.stringify(options));

const resultOf = <T = unknown>(reply: Reply): T => {
	if (!reply.body.ok) throw new Error(`refused: ${reply.status} ${JSON.stringify(reply.body)}`);
	return reply.body.result as T;
};

test.skipIf(!browserAvailable)(
	"a person accepts an invitation with a passkey, signs out, signs in with the passkey, lists the session and ends it",
	async () => {
		const started = await startServer({ mode: "server", passkeys: true });
		// The same server under the name it was told people open it at.
		const server = { ...started, url: started.url.replace("127.0.0.1", "localhost") };
		let browser: PageHarness | null = null;
		try {
			const invited = await fetch(`${started.url}/api/invitation`, {
				method: "POST",
				headers: { authorization: `Bearer ${started.token}`, "content-type": "application/json" },
				body: JSON.stringify({ do: "create", name: "sam", can: ["read"], project: "scratch" }),
			});
			const { code, link } = ((await invited.json()) as { result: { code: string; link: string } }).result;
			expect(link).toBe(`${server.url}/invite#${code}`);

			browser = await openPage(server, { signedIn: false });
			const { page } = browser;
			const cdp = await browser.context.newCDPSession(page);
			await cdp.send("WebAuthn.enable");
			await cdp.send("WebAuthn.addVirtualAuthenticator", {
				options: {
					protocol: "ctap2",
					transport: "internal",
					hasResidentKey: true,
					hasUserVerification: true,
					isUserVerified: true,
					automaticPresenceSimulation: true,
				},
			});

			// The sign-in page is told what this instance offers, and nobody is signed in.
			expect(resultOf<unknown>(await send(page, "/api/login/methods"))).toEqual({ password: true, passkey: true });
			expect((await send(page, "/api/session")).status).toBe(401);

			// The invitation: who it is for, and the options for a passkey. Chromium makes one and the page accepts.
			const shown = resultOf<{ invitation: { name: string; purpose: string }; passkey: unknown }>(
				await send(page, "/api/login/challenge", { invitation: code }),
			);
			expect(shown.invitation).toMatchObject({ name: "sam", purpose: "join" });
			const made = await register(page, shown.passkey);
			const accepted = await send(page, "/api/login", { invitation: code, passkey: made, label: "this browser" });
			expect(`${accepted.status} ${JSON.stringify(accepted.body)}`).toBe('200 {"ok":true,"result":{"signedIn":true}}');
			// The cookie is the browser's: the page cannot read it, and the next request carries it.
			expect(await page.evaluate(() => document.cookie)).not.toContain("mainworthy_sid");
			const first = resultOf<{ actor: string; via: string; session: number; credentials: unknown }>(
				await send(page, "/api/session"),
			);
			expect(first).toMatchObject({ actor: "sam", via: "cookie", credentials: { password: false, passkeys: 1 } });
			expect(resultOf(await send(page, "/api/credential", { do: "list" }))).toMatchObject([
				{ kind: "passkey", label: "this browser" },
			]);
			// The invitation is spent.
			expect((await send(page, "/api/login/challenge", { invitation: code })).status).toBe(404);

			// Sign out, and in again with the passkey: no name is typed, the browser finds the key by the site.
			expect((await send(page, "/api/logout", {})).status).toBe(200);
			expect((await send(page, "/api/session")).status).toBe(401);
			const offered = resultOf<{ passkey: { challenge: string } }>(await send(page, "/api/login/challenge", {}));
			const answer = await assert(page, offered.passkey);
			expect((await send(page, "/api/login", { passkey: answer })).status).toBe(200);
			const second = resultOf<{ actor: string; session: number }>(await send(page, "/api/session"));
			expect(second.actor).toBe("sam");
			expect(second.session).not.toBe(first.session);
			// The same answer signs nobody in a second time.
			expect((await send(page, "/api/login", { passkey: answer })).status).toBe(401);

			// The list holds this one session, opened with the passkey, and marks it as the page's own.
			const sessions = resultOf<{ id: number; openedWith: string; current: boolean; userAgent: string }[]>(
				await send(page, "/api/session", { do: "list" }),
			);
			expect(sessions).toMatchObject([{ id: second.session, openedWith: "passkey", current: true }]);
			expect(sessions[0]?.userAgent).toContain("Chrome");
			// Ending it signs the page out.
			expect(resultOf<unknown>(await send(page, "/api/session", { do: "end", id: second.session }))).toEqual({
				ended: true,
				current: true,
			});
			expect((await send(page, "/api/session")).status).toBe(401);
			// The one refusal this journey asked for on purpose: the spent invitation.
			expect(browser.errors).toEqual([
				"Failed to load resource: the server responded with a status of 404 (Not Found)",
			]);
		} finally {
			await browser?.close();
			await started.stop();
		}
	},
	30_000,
);
