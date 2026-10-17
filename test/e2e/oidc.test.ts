// Signing in through an identity provider by the pages: an invitation accepted through the provider, a sign-in
// with its button, and a person who has a password linking the provider from their settings. The provider is the
// one `oidc.test.ts` uses, and the browser follows its redirects as it would a real one's.
// `oidc.test.ts` proves the routes with `fetch`; this file proves the pages reach them.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { type Provider, provider, stopProviders } from "../oidc-support.ts";
import { browserAvailable, openPage, type PageHarness, type Server, startServer } from "./support.ts";

let idp: Provider;
let started: Server;
let server: Server;
beforeAll(async () => {
	if (!browserAvailable) return;
	idp = await provider();
	const { issuer, clientId, clientSecret, name } = idp.config();
	started = await startServer({ mode: "server", oidc: { issuer, clientId, clientSecret, name } });
	// The same server under the name it was told people open it at: the provider sends the browser back there.
	server = { ...started, url: started.url.replace("127.0.0.1", "localhost") };
});
afterAll(async () => {
	await started?.stop();
	stopProviders();
});

test.skipIf(!browserAvailable)(
	"a person accepts an invitation through the provider, signs out, and signs in again with its button",
	async () => {
		const made = await server.api("invitation", { do: "create", name: "sam", can: ["read", "answer"] });
		if (!("code" in made)) throw new Error("no invitation was made");
		let browser: PageHarness | null = null;
		try {
			browser = await openPage(server, { signedIn: false, path: `/invite#${made.code}`, ready: "h1" });
			const { page } = browser;
			page.setDefaultTimeout(8000);
			await page.getByRole("heading", { name: "You are invited as sam" }).waitFor();
			idp.next({ subject: "sub-sam", email: "sam@example.com" });
			await page.getByRole("button", { name: "Accept with Example ID" }).click();
			await page.locator("#app").waitFor();
			expect(await page.locator(".sfoot .me").textContent()).toContain("sam");
			// The provider's code and state are not left in the address bar.
			expect(new URL(page.url()).search).toBe("");
			expect(await server.api("credential", { do: "list", actor: "sam" })).toMatchObject([
				{ kind: "oidc", label: "Example ID (sam@example.com)" },
			]);

			await page.getByRole("button", { name: "Sign out" }).click();
			await page.getByRole("button", { name: "Sign out and keep drafts", exact: true }).click();
			idp.next({ subject: "sub-sam" });
			await page.getByRole("button", { name: "Sign in with Example ID" }).click();
			await page.locator("#app").waitFor();
			expect(await page.locator(".sfoot .me").textContent()).toContain("sam");
			expect(browser.errors).toEqual([]);
		} finally {
			await browser?.close();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"a person with a password links the provider from Your sign-in and comes back to it; an identity nobody linked is told it did not sign in",
	async () => {
		const made = await server.api("invitation", { do: "create", name: "lee", can: ["read"] });
		if (!("code" in made)) throw new Error("no invitation was made");
		const password = "correct horse battery staple";
		const accepted = await fetch(`${started.url}/api/login`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ invitation: made.code, password }),
		});
		expect(accepted.status).toBe(200);
		let browser: PageHarness | null = null;
		try {
			browser = await openPage(server, { as: { name: "lee", password } });
			const { page } = browser;
			page.setDefaultTimeout(8000);
			await page.keyboard.type("g,");
			await page.getByRole("option", { name: "Your sign-in", exact: true }).click();
			idp.next({ subject: "sub-lee", email: "lee@example.com" });
			await page.getByRole("button", { name: "Link Example ID" }).click();
			await page.getByText("You can sign in through Example ID.", { exact: false }).waitFor();
			expect(new URL(page.url()).pathname).toContain("/settings");
			await page.locator(".settings-row").filter({ hasText: "Example ID (lee@example.com)" }).waitFor();

			// Signed out, an identity the provider vouches for that nobody here linked signs nobody in.
			await page.getByRole("button", { name: "Sign out" }).click();
			await page.getByRole("button", { name: "Sign out and keep drafts", exact: true }).click();
			idp.next({ subject: "sub-stranger", email: "lee@example.com" });
			await page.getByRole("button", { name: "Sign in with Example ID" }).click();
			await page.getByRole("alert").filter({ hasText: "That did not sign you in." }).waitFor();
			await page.getByRole("link", { name: "Back to Mainworthy" }).click();
			await page.getByRole("button", { name: "Sign in with Example ID" }).waitFor();
		} finally {
			await browser?.close();
		}
	},
	30_000,
);
