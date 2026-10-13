// A passkey through the pages, made and used by Chromium on an authenticator it keeps in memory: an invitation
// accepted with one, sign-in with it, a second one added in settings, one removed, and the last one kept.
// `people.test.ts` proves the routes with `fetch`; this file proves the pages reach them.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { addAuthenticator, browserAvailable, openPage, type PageHarness, type Server, startServer } from "./support.ts";

let started: Server;
let server: Server;
beforeAll(async () => {
	if (!browserAvailable) return;
	started = await startServer({ mode: "server", passkeys: true });
	// The same server under the name it was told people open it at: a passkey belongs to that name.
	server = { ...started, url: started.url.replace("127.0.0.1", "localhost") };
});
afterAll(async () => {
	await started?.stop();
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
			expect(await page.locator("#invite-passkey-name").inputValue()).toBe("Chrome on Linux");
			await page.keyboard.press("Enter");
			await page.locator("#app").waitFor();
			expect(await page.locator(".sfoot .me").textContent()).toContain("sam");
			expect(await credentials()).toMatchObject([{ kind: "passkey", label: "Chrome on Linux" }]);

			// Out, and in again with the passkey: no name is typed.
			await page.getByRole("button", { name: "Sign out" }).click();
			await page.getByRole("button", { name: "Sign in with a passkey" }).click();
			await page.locator("#app").waitFor();
			expect(await page.locator(".sfoot .me").textContent()).toContain("sam");

			// Settings: the one passkey is listed, and as the only way in it is not removable, with the reason.
			await page.keyboard.type("g,");
			await page.getByRole("option", { name: "Your sign-in", exact: true }).click();
			const rows = page.locator(".settings-row");
			await rows.filter({ hasText: "Chrome on Linux" }).waitFor();
			expect(await rows.count()).toBe(1);
			expect(await rows.first().innerText()).toContain("last used");
			expect(await page.getByRole("button", { name: "Remove Chrome on Linux" }).isDisabled()).toBe(true);
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
			await page.locator("#passkey-label").fill("Security key");
			await page.keyboard.press("Enter");
			await rows.filter({ hasText: "Security key" }).waitFor();
			expect(await rows.count()).toBe(2);
			expect(await credentials()).toMatchObject([{ label: "Chrome on Linux" }, { label: "Security key" }]);
			// With two, either may go.
			expect(await page.getByRole("button", { name: "Remove Chrome on Linux" }).isDisabled()).toBe(false);

			await page.getByRole("button", { name: "Remove Security key" }).click();
			await rows.filter({ hasText: "Security key" }).waitFor({ state: "detached" });
			expect(await credentials()).toMatchObject([{ label: "Chrome on Linux" }]);
			expect(await page.getByRole("button", { name: "Remove Chrome on Linux" }).isDisabled()).toBe(true);
			// This browser signed in with the passkey that stayed, so it is still signed in.
			expect(await page.locator("#app").count()).toBe(1);

			// The session says how it was opened and by what.
			await page.getByRole("option", { name: "Your sessions", exact: true }).click();
			const session = rows.filter({ hasText: "this browser" });
			await session.waitFor();
			expect(await session.innerText()).toContain("Chrome on Linux");
			expect(await session.innerText()).toContain("passkey");

			// A person with a passkey and no password sets one, and is not asked for a current one.
			await page.getByRole("option", { name: "Your sign-in", exact: true }).click();
			await page.getByRole("button", { name: "Set password" }).waitFor();
			expect(await page.locator("#password-current").count()).toBe(0);
			await page.locator("#password-next").fill("a password set later");
			await page.locator("#password-again").fill("a password set later");
			await page.keyboard.press("Enter");
			await page.getByRole("status").filter({ hasText: "Password set." }).waitFor();
			await rows.filter({ hasText: "Password" }).waitFor();
			expect(await credentials()).toMatchObject([{ kind: "passkey" }, { kind: "password" }]);
			// From now on it is changed, with the current one asked for.
			await page.getByRole("button", { name: "Change password" }).waitFor();
			expect(await page.locator("#password-current").count()).toBe(1);

			// Now the passkey may go. This browser signed in with it, so removing it signs this browser out, and
			// the password signs it in again.
			await page.getByRole("button", { name: "Remove Chrome on Linux" }).click();
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
