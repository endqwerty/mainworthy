// A passkey through the pages, made and used by Chromium on an authenticator it keeps in memory: an invitation
// accepted with one, sign-in with it, a second one added in settings, one removed, and the last one kept. Then
// the identity provider of `test/oidc-support.ts`, whose redirects the browser follows as it would a real one's:
// an invitation accepted through it, a sign-in with its button, and a person linking it from their settings. One
// server holds both, since each needs the address people open the pages at.
// `people.test.ts` and `oidc.test.ts` prove the routes with `fetch`; this file proves the pages reach them.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { z } from "zod";
import { type Provider, provider, stopProviders } from "../oidc-support.ts";
import { addAuthenticator, browserAvailable, openPage, type PageHarness, type Server, startServer } from "./support.ts";

// What the browser of this test calls itself, as `browserName` reads it: the system is the one the test runs on.
// "Chrome on Linux" alone failed on macOS (issue #103).
const THIS_BROWSER = `Chrome on ${process.platform === "darwin" ? "macOS" : "Linux"}`;

let idp: Provider;
let started: Server;
let server: Server;
beforeAll(async () => {
	if (!browserAvailable) return;
	idp = await provider();
	const { issuer, clientId, clientSecret, name } = idp.config();
	started = await startServer({ mode: "server", passkeys: true, oidc: { issuer, clientId, clientSecret, name } });
	// The same server under the name it was told people open it at: a passkey belongs to that name.
	server = { ...started, url: started.url.replace("127.0.0.1", "localhost") };
});
afterAll(async () => {
	await started?.stop();
	stopProviders();
});

test.skipIf(!browserAvailable)(
	"a person accepts an invitation with a passkey, signs in with it, adds a second in settings and removes it; the last one stays",
	async () => {
		const made = await server.api("invitation", { do: "create", name: "sam", can: ["read", "answer"] });
		if (!("code" in made)) throw new Error("no invitation was made");
		const credentials = () => server.api("credential", { do: "list", actor: "sam" });
		let browser: PageHarness | null = null;
		try {
			browser = await openPage(server, { signedIn: false, path: `/invite#${made.code}`, ready: "h1" });
			const { page } = browser;
			page.setDefaultTimeout(8000);
			const laptop = await addAuthenticator(browser);
			await page.getByRole("heading", { name: "You are invited as sam" }).waitFor();

			// By keys: past the two password fields, which stay empty, to the passkey and its name.
			await page.keyboard.press("Tab");
			await page.keyboard.press("Tab");
			await page.keyboard.press("Space");
			expect(await page.getByRole("checkbox", { name: "Make a passkey on this device" }).isChecked()).toBe(true);
			await page.keyboard.press("Tab");
			// The name starts as what this browser calls itself.
			expect(await page.evaluate(() => document.activeElement?.id)).toBe("invite-passkey-name");
			expect(await page.locator("#invite-passkey-name").inputValue()).toBe(THIS_BROWSER);
			await page.keyboard.press("Enter");
			await page.locator("#app").waitFor();
			expect(await page.locator(".sfoot .me").textContent()).toContain("sam");
			expect(await credentials()).toMatchObject([{ kind: "passkey", label: THIS_BROWSER }]);

			// Out, and in again with the passkey: no name is typed.
			await page.getByRole("button", { name: "Sign out" }).click();
			await page.getByRole("button", { name: "Sign out and keep drafts", exact: true }).click();
			await page.getByRole("button", { name: "Sign in with a passkey" }).click();
			await page.locator("#app").waitFor();
			expect(await page.locator(".sfoot .me").textContent()).toContain("sam");

			// Settings: the one passkey is listed, and as the only way in it is not removable, with the reason.
			await page.keyboard.type("g,");
			await page.getByRole("option", { name: "Your sign-in", exact: true }).click();
			const rows = page.locator(".settings-row");
			await rows.filter({ hasText: THIS_BROWSER }).waitFor();
			expect(await rows.count()).toBe(1);
			expect(await rows.first().innerText()).toContain("last used");
			expect(await page.getByRole("button", { name: `Remove ${THIS_BROWSER}` }).isDisabled()).toBe(true);
			await page.getByText("The only way you sign in stays.", { exact: false }).waitFor();

			// The authenticator that holds the passkey is not registered twice.
			await page.locator("#passkey-label").fill("The same laptop");
			await page.getByRole("button", { name: "Add a passkey" }).click();
			await page.getByRole("status").filter({ hasText: "This passkey is already registered." }).waitFor();
			expect(await page.locator("#passkey-label").inputValue()).toBe("The same laptop");
			expect(await credentials()).toHaveLength(1);

			// A second device.
			await laptop.remove();
			await addAuthenticator(browser);
			await page.route("**/api/credential", async (route) => {
				if (route.request().postDataJSON().do !== "passkey.add") return route.continue();
				const response = await route.fetch();
				await route.fulfill({ response, json: { ok: true, result: null } });
			});
			await page.locator("#passkey-label").fill("Security key");
			await page.keyboard.press("Enter");
			await page
				.getByRole("status")
				.filter({ hasText: "The server answered something this page cannot read; reload." })
				.waitFor();
			await rows.filter({ hasText: "Security key" }).waitFor();
			await page.unroute("**/api/credential");
			expect(await rows.count()).toBe(2);
			expect(await credentials()).toMatchObject([{ label: THIS_BROWSER }, { label: "Security key" }]);
			// With two, either may go.
			expect(await page.getByRole("button", { name: `Remove ${THIS_BROWSER}` }).isDisabled()).toBe(false);

			await page.getByRole("button", { name: "Remove Security key" }).click();
			await rows.filter({ hasText: "Security key" }).waitFor({ state: "detached" });
			expect(await credentials()).toMatchObject([{ label: THIS_BROWSER }]);
			expect(await page.getByRole("button", { name: `Remove ${THIS_BROWSER}` }).isDisabled()).toBe(true);
			// This browser signed in with the passkey that stayed, so it is still signed in.
			expect(await page.locator("#app").count()).toBe(1);

			// The session says how it was opened and by what.
			await page.getByRole("option", { name: "Your sessions", exact: true }).click();
			const session = rows.filter({ hasText: "this browser" });
			await session.waitFor();
			expect(await session.innerText()).toContain(THIS_BROWSER);
			expect(await session.innerText()).toContain("passkey");

			// A person with a passkey and no password sets one, and is not asked for a current one.
			await page.getByRole("option", { name: "Your sign-in", exact: true }).click();
			await page.getByRole("button", { name: "Set password" }).waitFor();
			const {
				result: { actorId },
			} = z
				.object({
					result: z.object({ actorId: z.number().int() }),
				})
				.parse(await (await browser.context.request.get(`${server.url}/api/session`)).json());
			const passwordRequest = page.waitForRequest((request) => request.url().endsWith("/api/account/password"));
			expect(await page.locator("#password-current").count()).toBe(0);
			await page.locator("#password-next").fill("a password set later");
			await page.locator("#password-again").fill("a password set later");
			for (const id of ["#password-next", "#password-again"])
				expect(await page.locator(id).getAttribute("passwordrules")).toBe("minlength: 12; maxlength: 256;");
			// A password manager that filled the two fields marks them, and paints them by the mark. 1Password
			// sets this attribute and takes it away only when the person types in the field.
			const marked = page.locator("[data-com-onepassword-filled]");
			await page.evaluate(() => {
				for (const id of ["password-next", "password-again"])
					document.getElementById(id)?.setAttribute("data-com-onepassword-filled", "dark");
			});
			expect(await marked.count()).toBe(2);
			await page.keyboard.press("Enter");
			await page.getByRole("status").filter({ hasText: "Password set." }).waitFor();
			expect((await passwordRequest).headers()["x-mainworthy-as"]).toBe(String(actorId));
			// The page emptied the fields itself, so nothing typed took the marks away: the fields are new ones.
			// The caret was in one of them, and is on the button now, not in a field a manager would offer to fill.
			expect(await marked.count()).toBe(0);
			expect([
				await page.locator("#password-next").inputValue(),
				await page.locator("#password-again").inputValue(),
				await page.evaluate(() => document.activeElement?.textContent),
			]).toEqual(["", "", "Change password"]);
			await rows.filter({ hasText: "Password" }).waitFor();
			expect(await credentials()).toMatchObject([{ kind: "passkey" }, { kind: "password" }]);
			// From now on it is changed, with the current one asked for.
			await page.getByRole("button", { name: "Change password" }).waitFor();
			expect(await page.locator("#password-current").count()).toBe(1);

			// Now the passkey may go. This browser signed in with it, so removing it signs this browser out, and
			// the password signs it in again.
			await page.getByRole("button", { name: `Remove ${THIS_BROWSER}` }).click();
			await page.locator("#signin-name").waitFor();
			expect(await credentials()).toMatchObject([{ kind: "password" }]);
			await page.locator("#signin-name").fill("sam");
			await page.locator("#signin-password").fill("a password set later");
			await page.keyboard.press("Enter");
			await page.locator("#app").waitFor();
			expect(browser.errors).toEqual([]);
		} finally {
			await browser?.close();
		}
	},
	40_000,
);

test.skipIf(!browserAvailable)(
	"a page opened at another name of the instance says the browser could not use a passkey there",
	async () => {
		let browser: PageHarness | null = null;
		try {
			// 127.0.0.1 is the same server, and not the name its passkeys belong to.
			browser = await openPage(started, { signedIn: false });
			const { page } = browser;
			page.setDefaultTimeout(8000);
			await addAuthenticator(browser);
			await page.getByRole("button", { name: "Sign in with a passkey" }).click();
			await page.getByRole("status").filter({ hasText: "This browser could not use a passkey here." }).waitFor();
			expect(await page.locator("#app").count()).toBe(0);
			// The other ways are still there to use.
			expect(await page.getByRole("button", { name: "Sign in with a passkey" }).isEnabled()).toBe(true);
			expect(browser.errors).toEqual([]);
		} finally {
			await browser?.close();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"a passkey made before the question about somebody else is kept, and sent again once the question is answered",
	async () => {
		const made = await server.api("invitation", { do: "create", name: "nia", can: ["read"] });
		if (!("code" in made)) throw new Error("no invitation was made");
		const acceptances: Record<string, unknown>[] = [];
		let browser: PageHarness | null = null;
		try {
			browser = await openPage(server, { signedIn: false, path: `/invite#${made.code}`, ready: "h1" });
			const { page } = browser;
			page.setDefaultTimeout(8000);
			await addAuthenticator(browser);
			page.on("request", (request) => {
				if (request.url().endsWith("/api/login") && request.method() === "POST")
					acceptances.push(request.postDataJSON());
			});
			await page.getByRole("heading", { name: "You are invited as nia" }).waitFor();
			await page.getByRole("checkbox", { name: "Make a passkey on this device" }).check();
			// The owner signs in to this browser from another tab before the invitation is accepted.
			await browser.context.request.post(`${server.url}/api/login`, { data: { token: server.token } });
			await page.getByRole("button", { name: "Accept and sign in" }).click();
			// The passkey is made, the acceptance is refused, and the page asks about the owner.
			await page.getByText("You are signed in as robin. This invitation is for nia.", { exact: false }).waitFor();
			expect(await server.api("credential", { do: "list", actor: "nia" })).toHaveLength(0);
			await page.getByRole("button", { name: "Continue as nia" }).click();
			await page.locator("#app").waitFor();
			expect(await page.locator(".sfoot .me").textContent()).toContain("nia");
			// One passkey was made and it is the one that was stored: the second sending carried the first's
			// answer, with the name the question was about, and the authenticator was not asked twice.
			expect(acceptances).toHaveLength(2);
			expect(acceptances[0]?.replace).toBeUndefined();
			expect(acceptances[1]).toEqual({ ...acceptances[0], replace: "robin" });
			expect(await server.api("credential", { do: "list", actor: "nia" })).toMatchObject([{ kind: "passkey" }]);
			expect(browser.errors).toEqual(["Failed to load resource: the server responded with a status of 409 (Conflict)"]);
		} finally {
			await browser?.close();
		}
	},
	30_000,
);

/**
 * A slow server on the way back from the provider: the sign-in reaches it a moment after the page's first look at
 * the session, and the refusal that look drew is delivered once the sign-in has been answered. A busy machine does
 * this by chance; here it is every time.
 */
async function slowReturn(page: Page): Promise<void> {
	let answered: Promise<void> | null = null;
	await page.route("**/api/login", async (route) => {
		if (!route.request().postData()?.includes('"oidc"')) return route.fallback();
		let done = (): void => {};
		answered = new Promise((resolve) => {
			done = resolve;
		});
		await new Promise((resolve) => setTimeout(resolve, 300));
		const response = await route.fetch();
		await route.fulfill({ response });
		done();
	});
	await page.route("**/api/session", async (route) => {
		const response = await route.fetch();
		if (response.status() === 401) await answered;
		await route.fulfill({ response });
	});
}

test.skipIf(!browserAvailable)(
	"a person accepts an invitation through the provider, signs out, and signs in again with its button",
	async () => {
		const made = await server.api("invitation", { do: "create", name: "noor", can: ["read", "answer"] });
		if (!("code" in made)) throw new Error("no invitation was made");
		let browser: PageHarness | null = null;
		try {
			browser = await openPage(server, { signedIn: false, path: `/invite#${made.code}`, ready: "h1" });
			const { page } = browser;
			page.setDefaultTimeout(8000);
			await slowReturn(page);
			await page.getByRole("heading", { name: "You are invited as noor" }).waitFor();
			idp.next({ subject: "sub-noor", email: "noor@example.com" });
			await page.getByRole("button", { name: "Accept with Example ID" }).click();
			await page.locator("#app").waitFor();
			expect(await page.locator(".sfoot .me").textContent()).toContain("noor");
			// The provider's code and state are not left in the address bar.
			expect(new URL(page.url()).search).toBe("");
			expect(await server.api("credential", { do: "list", actor: "noor" })).toMatchObject([
				{ kind: "oidc", label: "Example ID (noor@example.com)" },
			]);

			await page.getByRole("button", { name: "Sign out" }).click();
			await page.getByRole("button", { name: "Sign out and keep drafts", exact: true }).click();
			idp.next({ subject: "sub-noor" });
			await page.getByRole("button", { name: "Sign in with Example ID" }).click();
			await page.locator("#app").waitFor();
			expect(await page.locator(".sfoot .me").textContent()).toContain("noor");
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
