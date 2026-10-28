// A person gets in and out through the pages: an invitation accepted through the identity provider, sign-out
// from the shell, and the sign-in page's provider button. The owner's token still signs a browser in from the same
// page, and a person links and confirms identities at the provider from Settings.

import { afterAll, beforeAll, expect, test } from "bun:test";
import {
	advanceClock,
	browserAvailable,
	confirmWithProvider,
	devicePrefix,
	joinPerson,
	openPage,
	type PageHarness,
	type Server,
	startServer,
	subjectOf,
} from "./support.ts";

let server: Server;
beforeAll(async () => {
	if (browserAvailable) {
		server = await startServer({ mode: "server", provider: true });
		// The tests below name the owner's storage keys by id: a new instance's owner has id 2.
		expect(await devicePrefix(server, server.token)).toBe("mainworthy:#2:");
	}
});
afterAll(async () => {
	await server?.stop();
});

/** The provider signs in `subject` at the next request; the page leaves for it with `press` and comes back. */
async function throughProvider(page: PageHarness["page"], subject: string, press: () => Promise<void>) {
	server.idp?.next({ subject });
	const back = page.waitForEvent("load");
	await press();
	await back;
}

for (const device of ["phone", "desktop"] as const)
	test.skipIf(!browserAvailable)(
		`a token-only owner links a first identity without confirming, and a second after confirming with the first, on ${device}`,
		async () => {
			const started = await startServer({ mode: "server", provider: true });
			let browser: PageHarness | null = null;
			try {
				browser = await openPage(started, { path: "/p/scratch/settings", device });
				const { page } = browser;
				// A phone comes back from the provider to the list of sections, with this one chosen but not open
				// (reported to the web UI's author); the person opens it again.
				const back = async () => {
					if (device === "phone") await page.getByRole("option", { name: "Your sign-in", exact: true }).click();
					await page.getByRole("heading", { name: "Your sign-in", exact: true }).waitFor();
				};
				await page.getByRole("option", { name: "Your sign-in", exact: true }).click();
				await page.getByText("No identity is linked yet. You sign in with a token.", { exact: true }).waitFor();
				// Long after the token's sign-in proof ran out, the first identity is still linked without a question:
				// there is nothing else to confirm with.
				await advanceClock(started, 10 * 60_000 + 1);
				started.idp?.next({ subject: subjectOf("robin"), email: "robin@example.com" });
				const linked = page.waitForEvent("load");
				await page.getByRole("button", { name: "Link Example ID", exact: true }).click();
				await linked;
				await back();
				await page.getByText("Example ID (robin@example.com)", { exact: false }).waitFor();
				expect(await page.getByRole("button", { name: /^Remove / }).isDisabled()).toBe(true);
				await page.getByText("Your only identity stays.", { exact: false }).waitFor();
				// A second one asks first; the session was opened with the token, which the prompt says confirms too.
				await page.getByRole("button", { name: "Link another Example ID identity", exact: true }).click();
				const prompt = page.getByRole("region", { name: "Confirm it is you", exact: true });
				await prompt
					.getByText("You opened this session with a token: signing in with it again confirms too.", { exact: true })
					.waitFor();
				expect(
					await prompt
						.getByRole("button", { name: "Confirm with Example ID", exact: true })
						.evaluate((button) => button === document.activeElement),
				).toBe(true);
				await confirmWithProvider(page, started, "robin");
				await back();
				started.idp?.next({ subject: "sub-robin-laptop" });
				const again = page.waitForEvent("load");
				await page.getByRole("button", { name: "Link another Example ID identity", exact: true }).click();
				await again;
				await back();
				expect(await started.api("credential", { do: "list" })).toMatchObject([{ kind: "oidc" }, { kind: "oidc" }]);
				expect(browser.errors).toEqual([
					"Failed to load resource: the server responded with a status of 403 (Forbidden)",
				]);
			} finally {
				await browser?.close();
				await started.stop();
			}
		},
		30_000,
	);

test.skipIf(!browserAvailable)(
	"Settings asks a person to confirm with the provider, refuses another person's identity, and takes their own",
	async () => {
		await joinPerson(server, "proof-browser", { can: ["read"] });
		const browser = await openPage(server, { path: "/p/scratch/settings", as: { name: "proof-browser" } });
		try {
			const { page } = browser;
			await page.getByRole("option", { name: "Your sign-in", exact: true }).click();
			await advanceClock(server, 10 * 60_000 + 1);
			const link = page.getByRole("button", { name: "Link another Example ID identity", exact: true });
			await link.click();
			const prompt = page.getByRole("region", { name: "Confirm it is you", exact: true });
			const confirm = prompt.getByRole("button", { name: "Confirm with Example ID", exact: true });
			await confirm.waitFor();
			await prompt.getByText("Sign in with Example ID again to confirm it is you.", { exact: false }).waitFor();
			// This session was opened through the provider: a token is not offered.
			expect(await prompt.getByText("You opened this session with a token", { exact: false }).count()).toBe(0);
			expect(await confirm.evaluate((button) => button === document.activeElement)).toBe(true);
			// Cancelling refuses the change and changes nothing.
			await prompt.getByRole("button", { name: "Cancel confirmation", exact: true }).click();
			await prompt.waitFor({ state: "detached" });
			await page.getByText("Confirmation cancelled. Nothing was changed.", { exact: true }).waitFor();
			// Somebody else signing in at the provider confirms nothing.
			await link.click();
			await throughProvider(page, subjectOf("robin"), () => confirm.click());
			await page
				.getByRole("alert")
				.filter({ hasText: "the identity provider signed in somebody other than you" })
				.waitFor();
			await page.getByRole("link", { name: "Back to Mainworthy", exact: true }).click();
			await page.locator("#app").waitFor();
			await page.goto(`${server.url}/p/scratch/settings`);
			await page.getByRole("option", { name: "Your sign-in", exact: true }).click();
			await link.click();
			await confirmWithProvider(page, server, "proof-browser");
			await throughProvider(page, "sub-proof-browser-laptop", () => link.click());
			await page.getByRole("heading", { name: "Your sign-in", exact: true }).waitFor();
			const removable = page.getByRole("button", { name: /^Remove / });
			await removable.nth(1).waitFor();
			// The laptop's identity, which the provider gave no email for; the session rests on the other one.
			await page.getByRole("button", { name: "Remove Example ID", exact: true }).click();
			await page.getByText("Example ID was removed.", { exact: true }).waitFor();
			await removable.nth(1).waitFor({ state: "detached" });
			expect(await removable.isDisabled()).toBe(true);
		} finally {
			await browser.close();
		}
	},
	30_000,
);

for (const device of ["desktop", "phone"] as const)
	test.skipIf(!browserAvailable)(
		`the sign-out dialog on ${device} keeps the session until a choice, with safe focus and Escape`,
		async () => {
			let browser: PageHarness | null = null;
			try {
				browser = await openPage(server, { path: "/p/scratch/settings", device });
				const { page } = browser;
				let posts = 0;
				page.on("request", (request) => {
					if (request.url().endsWith("/api/logout") && request.method() === "POST") posts++;
				});
				await page.evaluate(() =>
					localStorage.setItem("mainworthy:#2:queue-input:scratch:pending", "Keep this answer"),
				);
				for (const source of ["sidebar", "sessions", "keys"] as const) {
					if (source === "sidebar") {
						if (device === "phone") await page.getByRole("button", { name: "Menu", exact: true }).click();
						await page.getByRole("button", { name: "Sign out", exact: true }).click();
					} else if (source === "sessions") {
						await page.getByRole("option", { name: "Your sessions", exact: true }).click();
						await page.getByRole("button", { name: /End the session of .*this browser/ }).click();
					} else {
						await page.keyboard.press("g");
						await page.keyboard.press("x");
					}
					const dialog = page.getByRole("dialog", { name: "Sign out" });
					await dialog.waitFor();
					expect(await dialog.textContent()).toContain("every open tab");
					expect(await dialog.textContent()).toContain("unsaved");
					expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Sign out and keep drafts");
					expect(await page.locator("#app").getAttribute("inert")).not.toBeNull();
					const path = new URL(page.url()).pathname;
					await page.keyboard.press("g");
					await page.keyboard.press("s");
					await page.keyboard.press("ControlOrMeta+k");
					expect(new URL(page.url()).pathname).toBe(path);
					expect(await page.locator('[data-overlay="palette"]').count()).toBe(0);
					await page.keyboard.press("Shift+Tab");
					expect(await page.evaluate(() => document.activeElement?.textContent)).toContain("Stay signed in");
					await page.keyboard.press("Tab");
					expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Sign out and keep drafts");
					if (device === "phone") {
						const bounds = await dialog.boundingBox();
						expect(bounds).not.toBeNull();
						expect(bounds?.x).toBeGreaterThanOrEqual(0);
						expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(390);
					}
					await dialog.locator("p").click();
					await page.keyboard.press("g");
					await page.keyboard.press("s");
					await page.keyboard.press("ControlOrMeta+k");
					expect(new URL(page.url()).pathname).toBe(path);
					expect(await page.locator('[data-overlay="palette"]').count()).toBe(0);
					if (source === "sessions") await dialog.getByRole("button", { name: "Stay signed in" }).click();
					else await page.keyboard.press("Escape");
					await dialog.waitFor({ state: "detached" });
					expect(posts).toBe(0);
					expect((await page.request.get(`${server.url}/api/session`)).ok()).toBe(true);
					expect(await page.evaluate(() => localStorage.getItem("mainworthy:#2:queue-input:scratch:pending"))).toBe(
						"Keep this answer",
					);
				}
				await page.keyboard.press("g");
				await page.keyboard.press("x");
				await page.getByRole("dialog", { name: "Sign out" }).waitFor();
				await page.keyboard.press("Enter");
				await page.locator("#token").waitFor();
				expect(posts).toBe(1);
				expect(await page.evaluate(() => localStorage.getItem("mainworthy:#2:queue-input:scratch:pending"))).toBe(
					"Keep this answer",
				);
				expect(browser.dialogs).toEqual([]);
				expect(browser.errors).toEqual([]);
			} finally {
				await browser?.close();
			}
		},
		30_000,
	);

test.skipIf(!browserAvailable)(
	"an invited person accepts through the provider, signs out from the shell and signs in through the provider",
	async () => {
		const made = await server.api("invitation", { do: "create", name: "sam", can: ["read", "answer"] });
		if (!("code" in made)) throw new Error("no invitation was made");
		let browser: PageHarness | null = null;
		try {
			browser = await openPage(server, { signedIn: false, path: `/invite#${made.code}`, ready: "h1" });
			const { page } = browser;
			await page.getByRole("heading", { name: "You are invited as sam" }).waitFor();
			await page.getByText("This link works once, until", { exact: false }).waitFor();
			// The button is where the person starts.
			const accept = page.getByRole("button", { name: "Accept with Example ID", exact: true });
			await accept.waitFor();
			await page.waitForFunction(() => document.activeElement?.textContent === "Accept with Example ID");
			await throughProvider(page, subjectOf("sam"), () => page.keyboard.press("Enter"));

			// Signed in, and in the app.
			await page.locator("#app").waitFor();
			expect(await page.locator(".sfoot .me").textContent()).toContain("sam");

			// Out through the shell, by the key the keys sheet names.
			await page.keyboard.press("g");
			await page.keyboard.press("x");
			await page.getByRole("dialog", { name: "Sign out" }).waitFor();
			await page.keyboard.press("Enter");
			await page.locator("#token").waitFor();
			expect(await page.locator("#app").count()).toBe(0);
			// The session ended on the server, not only in the page: a reload is still the sign-in page.
			await page.reload();
			await page.locator("#token").waitFor();
			// Nobody is told where a lost identity goes but to an admin.
			await page.getByText("an admin can send you a new link", { exact: false }).waitFor();

			// An identity nobody linked signs nobody in: one sentence, and a way back to the sign-in page.
			const signIn = page.getByRole("button", { name: "Sign in with Example ID", exact: true });
			await throughProvider(page, "sub-somebody-unknown", () => signIn.click());
			await page.getByRole("alert").filter({ hasText: "that did not sign you in" }).waitFor();
			expect(await page.locator("#app").count()).toBe(0);
			await page.getByRole("link", { name: "Back to Mainworthy", exact: true }).click();
			await page.locator("#token").waitFor();

			// sam's own identity, from the focused button by the keyboard.
			await page.waitForFunction(() => document.activeElement?.textContent === "Sign in with Example ID");
			await throughProvider(page, subjectOf("sam"), () => page.keyboard.press("Enter"));
			await page.locator("#app").waitFor();
			expect(await page.locator(".sfoot .me").textContent()).toContain("sam");

			// The button in the shell does what the key does.
			await page.getByRole("button", { name: "Sign out", exact: true }).click();
			await page.getByRole("button", { name: "Sign out and keep drafts", exact: true }).click();
			await page.locator("#token").waitFor();
			expect(browser.errors).toEqual([]);
		} finally {
			await browser?.close();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"the token form still signs the owner in, and Tab reaches the two ways in the order they are shown",
	async () => {
		let browser: PageHarness | null = null;
		try {
			browser = await openPage(server, { signedIn: false });
			const { page } = browser;
			const focused = () => page.evaluate(() => document.activeElement?.id || document.activeElement?.textContent);
			await page.waitForFunction(() => document.activeElement?.textContent === "Sign in with Example ID");
			const order: unknown[] = [];
			for (let i = 0; i < 2; i++) {
				await page.keyboard.press("Tab");
				order.push(await focused());
			}
			expect(order).toEqual(["token", "Sign in with the token"]);

			// A password manager is told to leave the token alone: it is not the person's password.
			expect(await page.locator("#token").getAttribute("data-1p-ignore")).not.toBeNull();
			await page.locator("#token").fill("not-a-valid-owner-token");
			await page.keyboard.press("Enter");
			await page.getByRole("status").filter({ hasText: "That token was not accepted." }).waitFor();
			expect(await page.locator("#token").inputValue()).toBe("not-a-valid-owner-token");
			await page.locator("#token").fill(server.token);
			await page.keyboard.press("Enter");
			await page.locator("#app").waitFor();
			expect(await page.locator(".sfoot .me").textContent()).toContain("robin");
			expect(browser.errors).toEqual([]);
		} finally {
			await browser?.close();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"an instance with no provider offers the token alone, which takes the focus",
	async () => {
		const plain = await startServer({ mode: "server" });
		let browser: PageHarness | null = null;
		try {
			browser = await openPage(plain, { signedIn: false });
			const { page } = browser;
			await page.waitForFunction(() => document.activeElement?.id === "token");
			expect(await page.getByRole("button", { name: /^Sign in with (?!the token)/ }).count()).toBe(0);
			expect(browser.errors).toEqual([]);
		} finally {
			await browser?.close();
			await plain.stop();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"a limited token sign-in says how long to wait, with the token kept",
	async () => {
		let browser: PageHarness | null = null;
		try {
			browser = await openPage(server, { signedIn: false });
			const { page } = browser;
			const refusal = page
				.locator("form")
				.filter({ has: page.locator("#token") })
				.getByRole("status");
			await page.route("**/api/login", (route) =>
				route.fulfill({
					status: 429,
					headers: { "Retry-After": "23" },
					json: { ok: false, error: { code: "limited", message: "Too many attempts" } },
				}),
			);
			await page.locator("#token").fill("some token or other");
			await page.keyboard.press("Enter");
			await refusal.filter({ hasText: /^Too many attempts\. Try again in 23 seconds\.$/ }).waitFor();
			expect(await page.locator("#app").count()).toBe(0);
			expect(await page.locator("#token").inputValue()).toBe("some token or other");
			expect(await page.getByRole("button", { name: "Sign in with the token", exact: true }).isEnabled()).toBe(true);
			expect(browser.errors).toEqual([
				"Failed to load resource: the server responded with a status of 429 (Too Many Requests)",
			]);
		} finally {
			await browser?.close();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"a refusal that is neither a wrong proof nor a wait is shown as the server wrote it, under the way that was tried",
	async () => {
		let browser: PageHarness | null = null;
		try {
			browser = await openPage(server, { signedIn: false });
			const { page } = browser;
			// What the server answers a request whose body took too long to arrive. A test answers in its place: no
			// browser sends a body that slowly.
			const slow = "the sign-in request took too long to arrive";
			await page.route("**/api/login/oidc", (route) =>
				route.fulfill({ status: 408, json: { ok: false, error: { code: "invalid", message: slow } } }),
			);
			await page.route("**/api/login", (route) =>
				route.fulfill({
					status: 429,
					json: { ok: false, error: { code: "limited", message: "too many attempts; try again in 30 seconds" } },
				}),
			);
			const provider = page.getByRole("button", { name: "Sign in with Example ID", exact: true });
			await provider.click();
			const providerStatus = page.locator(".signin-card > .signin-problem");
			await providerStatus.filter({ hasText: slow }).waitFor();
			expect(await providerStatus.innerText()).toBe(slow);
			// The button is back for the next attempt.
			expect(await provider.getAttribute("aria-disabled")).toBe("false");

			// A wait whose length a proxy dropped on the way: the sentence has no number, and is not the page's
			// sentence for a wrong token.
			await page.locator("#token").fill("some token or other");
			await page.keyboard.press("Enter");
			const token = page.locator("form").filter({ has: page.locator("#token") });
			await token.getByRole("status").filter({ hasText: "Too many attempts. Try again later." }).waitFor();
			// One refusal is on the page at a time, under what caused it.
			expect(await providerStatus.innerText()).toBe("");
			expect(browser.errors).toEqual([
				"Failed to load resource: the server responded with a status of 408 (Request Timeout)",
				"Failed to load resource: the server responded with a status of 429 (Too Many Requests)",
			]);
		} finally {
			await browser?.close();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"local mode has no sign-in page and nothing to sign out of",
	async () => {
		const local = await startServer();
		let browser: PageHarness | null = null;
		try {
			// No cookie: the owner of the machine is let in as they are.
			browser = await openPage(local, { signedIn: false, ready: "#app" });
			const { page } = browser;
			expect(await page.locator(".sfoot .me").textContent()).toContain("robin");
			expect(await page.getByRole("button", { name: "Sign out" }).count()).toBe(0);
			// The key does nothing either: the app is still there.
			await page.keyboard.press("g");
			await page.keyboard.press("x");
			await page.keyboard.press("?");
			await page.getByRole("heading", { name: "Keys" }).waitFor();
			expect(await page.locator(".hk", { hasText: "Sign out" }).count()).toBe(0);
			expect(await page.locator("#app").count()).toBe(1);
			expect(browser.errors).toEqual([]);
		} finally {
			await browser?.close();
			await local.stop();
		}
	},
	30_000,
);

for (const key of ["Enter", "Space"] as const)
	test.skipIf(!browserAvailable)(
		`on the Suite screen, ${key} on the focused Sign out button signs out, with one request`,
		async () => {
			let browser: PageHarness | null = null;
			try {
				// The Suite has keys of its own on Enter and Space. A button that has the focus takes its own.
				browser = await openPage(server, { path: "/p/scratch/suite" });
				const { page } = browser;
				let posts = 0;
				page.on("request", (request) => {
					if (request.url().endsWith("/api/logout") && request.method() === "POST") posts++;
				});
				await page.locator("#list").waitFor();
				await page.getByRole("button", { name: "Sign out" }).focus();
				await page.keyboard.press(key);
				await page.getByRole("dialog", { name: "Sign out" }).waitFor();
				await page.keyboard.press("Enter");
				await page.locator("#token").waitFor();
				expect(posts).toBe(1);
				expect(browser.errors).toEqual([]);
			} finally {
				await browser?.close();
			}
		},
		30_000,
	);

test.skipIf(!browserAvailable)(
	"on the Suite screen, Enter after a button was clicked is still the screen's key: it does not press the button again",
	async () => {
		let browser: PageHarness | null = null;
		try {
			browser = await openPage(server, { path: "/p/scratch/suite" });
			const { page } = browser;
			await page.locator("#list").waitFor();
			const shown = () => page.evaluate(() => document.documentElement.dataset.theme);
			const before = await shown();
			await page.getByRole("button", { name: "Toggle theme" }).click();
			const clicked = await shown();
			expect(clicked).not.toBe(before);
			// The pointer gave the button the focus. Enter is the Suite's key, as it was before the click.
			await page.keyboard.press("Enter");
			expect(await shown()).toBe(clicked);
			// Reached with Tab, the same button takes its own Enter.
			await page.keyboard.press("Shift+Tab");
			await page.keyboard.press("Tab");
			expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Toggle theme");
			await page.keyboard.press("Enter");
			expect(await shown()).toBe(before);
		} finally {
			await browser?.close();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"a sign-out whose reply is lost is looked up, not guessed: the session ended, so the page shows the sign-in page",
	async () => {
		let browser: PageHarness | null = null;
		try {
			browser = await openPage(server, { path: "/p/scratch/settings" });
			const { page } = browser;
			await page.evaluate(() => localStorage.setItem("mainworthy:#2:queue-input:scratch:pending", "Private answer"));
			// The server signs the browser out, and the reply is dropped on its way back.
			await page.route("**/api/logout", async (route) => {
				await route.fetch();
				await route.abort();
			});
			await page.getByRole("button", { name: "Sign out", exact: true }).click();
			await page.getByRole("button", { name: "Sign out and clear browser data", exact: true }).click();
			await page.locator("#token").waitFor();
			expect(await page.locator("#app").count()).toBe(0);
			expect(await page.evaluate(() => localStorage.getItem("mainworthy:#2:queue-input:scratch:pending"))).toBeNull();
			expect(browser.errors).toEqual(["Failed to load resource: net::ERR_FAILED"]);
		} finally {
			await browser?.close();
		}
	},
	30_000,
);

for (const storage of ["available", "unavailable"] as const)
	test.skipIf(!browserAvailable)(
		`a clear choice survives a lost logout reply and first session check when storage is ${storage}`,
		async () => {
			let browser: PageHarness | null = null;
			try {
				browser = await openPage(server, { path: "/p/scratch/settings" });
				const { page, context } = browser;
				const other = await context.newPage();
				await other.goto(`${server.url}/p/scratch/settings`);
				await other.locator("#app").waitFor();
				await page.evaluate((refuseRemoval) => {
					localStorage.setItem("mainworthy:#2:queue-input:scratch:pending", "Private answer");
					localStorage.setItem("mainworthy:#2:draft-copy:scratch:C-1", "Private copy");
					localStorage.setItem("mainworthy:#99:draft:scratch:C-2", "Their draft");
					localStorage.setItem("mainworthy:#99:draft-copy:scratch:C-2", "Their copy");
					if (refuseRemoval)
						Storage.prototype.removeItem = () => {
							throw new DOMException("Storage unavailable", "SecurityError");
						};
				}, storage === "unavailable");
				await page.route("**/api/logout", async (route) => {
					await route.fetch();
					await route.abort();
				});
				let checks = 0;
				await page.route("**/api/session", (route) => (++checks === 1 ? route.abort() : route.continue()));
				await page.getByRole("button", { name: "Sign out", exact: true }).click();
				await page.getByRole("button", { name: "Sign out and clear browser data", exact: true }).click();
				await page.locator("#token").waitFor();
				expect(checks).toBe(2);
				expect(await page.locator("#app").count()).toBe(0);
				if (storage === "available") {
					expect(
						await page.evaluate(() =>
							Object.keys(localStorage).filter(
								(key) => key.startsWith("mainworthy:#2:") || key === "mainworthy:session-person",
							),
						),
					).toEqual([]);
					for (const tab of [page, other]) {
						await tab.locator("#token").waitFor();
						await tab.reload();
						await tab.locator("#token").waitFor();
						expect(
							await tab.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("mainworthy:#2:"))),
						).toEqual([]);
					}
					expect(browser.dialogs).toEqual([]);
				} else {
					expect(browser.dialogs).toEqual([
						"You are signed out, but this browser could not clear all your data. Clear this site's data in your browser settings before leaving a shared computer.",
					]);
					expect(await page.evaluate(() => localStorage.getItem("mainworthy:#2:queue-input:scratch:pending"))).toBe(
						"Private answer",
					);
				}
				expect(await page.evaluate(() => localStorage.getItem("mainworthy:#99:draft:scratch:C-2"))).toBe("Their draft");
				expect(await page.evaluate(() => localStorage.getItem("mainworthy:#99:draft-copy:scratch:C-2"))).toBe(
					"Their copy",
				);
				expect(browser.errors).toEqual([
					"Failed to load resource: net::ERR_FAILED",
					"Failed to load resource: net::ERR_FAILED",
				]);
			} finally {
				await browser?.close();
			}
		},
		30_000,
	);

for (const recovery of ["first check", "fallback check", "no answer"] as const)
	test.skipIf(!browserAvailable)(
		`a failed clear with ${recovery} keeps a draft typed afterwards when the session expires (Q1)`,
		async () => {
			const local = await startServer({ mode: "server" });
			let browser: PageHarness | null = null;
			try {
				await local.api("propose", { edits: [{ op: "create", outline: "Kept case\n  Original step" }] });
				browser = await openPage(local, { path: "/p/scratch/suite/c/1" });
				const { page } = browser;
				await page.getByRole("button", { name: "Kept case", exact: true }).waitFor();
				await page.route("**/api/logout", (route) => route.abort());
				let checks = 0;
				await page.route("**/api/session", (route) => {
					checks++;
					return recovery === "no answer" || (recovery === "fallback check" && checks === 1)
						? route.abort()
						: route.continue();
				});
				await page.getByRole("button", { name: "Sign out", exact: true }).click();
				await page.getByRole("button", { name: "Sign out and clear browser data", exact: true }).click();
				await page
					.getByText(recovery === "no answer" ? "the page cannot tell" : "this browser is still signed in", {
						exact: false,
					})
					.waitFor();
				expect(checks).toBe(recovery === "first check" ? 1 : 2);
				if (recovery === "no answer") {
					expect(await page.getByRole("status").filter({ hasText: "the page cannot tell" }).textContent()).toContain(
						"Your browser data was kept. Press Sign out again",
					);
				}
				await page.unroute("**/api/session");
				await page.keyboard.press("e");
				const step = page.getByRole("textbox", { name: "Step 1", exact: true });
				await step.fill("Draft after failed clear");
				const stored = () => page.evaluate(() => localStorage.getItem("mainworthy:#2:draft:scratch:C-1") ?? "");
				expect(await stored()).toContain("Draft after failed clear");
				await advanceClock(local, 366 * 24 * 60 * 60 * 1000);
				// Leave the editor without saving, so the draft on the device is all that holds the text.
				await step.evaluate((node) => (node as HTMLElement).blur());
				await page.keyboard.press("g");
				await page.keyboard.press("q");
				await page.locator("#token").waitFor();
				expect(await stored()).toContain("Draft after failed clear");
				expect((await local.api("get", { refs: ["C-1"] }))[0]?.version).toBe(1);
				expect(browser.dialogs).toEqual([]);
				await page.locator("#token").fill(local.token);
				await page.keyboard.press("Enter");
				await page.locator("#app").waitFor();
				await page.getByRole("link", { name: "Suite", exact: true }).click();
				await page.getByRole("option").filter({ hasText: "C-1" }).click();
				await page.getByRole("button", { name: "Kept case", exact: true }).waitFor();
				await page.keyboard.press("e");
				expect(await step.inputValue()).toBe("Draft after failed clear");
			} finally {
				await browser?.close();
				await local.stop();
			}
		},
		30_000,
	);

for (const tab of ["same tab (Q2)", "another tab (Q4)"] as const)
	test.skipIf(!browserAvailable)(
		`a failed clear cannot override a later keep in ${tab}`,
		async () => {
			const local = await startServer({ mode: "server" });
			let browser: PageHarness | null = null;
			try {
				browser = await openPage(local, { path: "/p/scratch/settings" });
				const { page, context } = browser;
				await page.evaluate(() =>
					localStorage.setItem("mainworthy:#2:queue-input:scratch:pending", "Kept after failed clear"),
				);
				await page.route("**/api/logout", (route) => route.abort());
				await page.getByRole("button", { name: "Sign out", exact: true }).click();
				await page.getByRole("button", { name: "Sign out and clear browser data", exact: true }).click();
				await page.getByText("this browser is still signed in", { exact: false }).waitFor();
				await page.unroute("**/api/logout");
				const keeping = tab === "same tab (Q2)" ? page : await context.newPage();
				if (keeping !== page) {
					await keeping.goto(`${local.url}/p/scratch/settings`);
					await keeping.locator("#app").waitFor();
				}
				await keeping.getByRole("button", { name: "Sign out", exact: true }).click();
				await keeping.getByRole("button", { name: "Sign out and keep drafts", exact: true }).click();
				await keeping.locator("#token").waitFor();
				if (keeping !== page) {
					await page.keyboard.press("g");
					await page.keyboard.press("q");
					await page.locator("#token").waitFor();
				}
				await page.reload();
				await page.locator("#token").waitFor();
				expect(await page.evaluate(() => localStorage.getItem("mainworthy:#2:queue-input:scratch:pending"))).toBe(
					"Kept after failed clear",
				);
				expect(await page.evaluate(() => localStorage.getItem("mainworthy:session-person"))).toBe("2");
				await page.locator("#token").fill(local.token);
				await page.keyboard.press("Enter");
				await page.locator("#app").waitFor();
				await advanceClock(local, 366 * 24 * 60 * 60 * 1000);
				await page.reload();
				await page.locator("#token").waitFor();
				expect(await page.evaluate(() => localStorage.getItem("mainworthy:#2:queue-input:scratch:pending"))).toBe(
					"Kept after failed clear",
				);
				expect(browser.dialogs).toEqual([]);
			} finally {
				await browser?.close();
				await local.stop();
			}
		},
		30_000,
	);

test.skipIf(!browserAvailable)(
	"a sign-out that never reached the server leaves the browser signed in, and the page says so and takes another press",
	async () => {
		let browser: PageHarness | null = null;
		try {
			browser = await openPage(server, { path: "/p/scratch/settings" });
			const { page } = browser;
			await page.evaluate(() => localStorage.setItem("mainworthy:#2:queue-input:scratch:pending", "Private answer"));
			await page.route("**/api/logout", (route) => route.abort());
			await page.getByRole("button", { name: "Sign out", exact: true }).click();
			await page.getByRole("button", { name: "Sign out and clear browser data", exact: true }).click();
			await page.getByText("this browser is still signed in", { exact: false }).waitFor();
			expect(await page.evaluate(() => localStorage.getItem("mainworthy:#2:queue-input:scratch:pending"))).toBe(
				"Private answer",
			);
			expect(await page.locator("#app").count()).toBe(1);
			await page.unroute("**/api/logout");
			await page.getByRole("button", { name: "Sign out", exact: true }).click();
			await page.getByRole("button", { name: "Sign out and clear browser data", exact: true }).click();
			await page.locator("#token").waitFor();
			expect(browser.errors).toEqual(["Failed to load resource: net::ERR_FAILED"]);
		} finally {
			await browser?.close();
		}
	},
	30_000,
);

for (const source of ["sidebar", "sessions"] as const)
	test.skipIf(!browserAvailable)(
		`signing out from ${source} can clear this person's browser data, including drafts in other open tabs`,
		async () => {
			const local = await startServer({ mode: "server" });
			let browser: PageHarness | null = null;
			try {
				await local.api("propose", { edits: [{ op: "create", outline: "Private case\n  Original step" }] });
				const run = await local.api("plan", { name: "Private run", select: {} });
				browser = await openPage(local, { path: "/p/scratch/suite/c/1" });
				const { page, context } = browser;
				await page.getByRole("button", { name: "Private case", exact: true }).waitFor();
				await page.keyboard.press("e");
				await page.getByRole("textbox", { name: "Step 1", exact: true }).fill("Private unsaved case text");
				const other = await context.newPage();
				await other.goto(`${local.url}/p/scratch/runs/${run.run.slice(2)}`);
				await other.locator('[data-active="true"][data-ready="true"]').waitFor();
				await other.getByRole("textbox", { name: "Result note" }).fill("Private unsaved run note");
				await page.evaluate(() => {
					localStorage.setItem("mainworthy:#2:queue-input:scratch:Q-1:excuse:reason", "Private queue answer");
					localStorage.setItem("mainworthy:#99:draft:scratch:C-2", "Their draft");
					localStorage.setItem("mainworthy:theme", "dark");
				});
				if (source === "sessions") {
					await other.goto(`${local.url}/p/scratch/settings`);
					await other.getByRole("option", { name: "Your sessions", exact: true }).click();
				}
				const signingOut = source === "sidebar" ? page : other;
				if (source === "sidebar") await page.getByRole("button", { name: "Sign out", exact: true }).click();
				else await other.getByRole("button", { name: /End the session of .*this browser/ }).click();
				const warning = await signingOut.getByRole("dialog", { name: "Sign out" }).textContent();
				await signingOut.getByRole("button", { name: "Sign out and clear browser data", exact: true }).click();
				await signingOut.locator("#token").waitFor();
				expect(
					await signingOut.evaluate(() =>
						Object.keys(localStorage).filter(
							(key) => key.startsWith("mainworthy:#2:") || key === "mainworthy:session-person",
						),
					),
				).toEqual([]);
				expect(warning).toContain("unsaved");
				expect(warning).toContain("robin");
				await page.locator("#token").waitFor();
				await other.locator("#token").waitFor();
				// A new session in this same document must work after clearing, with none of the discarded draft.
				await signingOut.locator("#token").fill(local.token);
				await signingOut.keyboard.press("Enter");
				await signingOut.locator("#app").waitFor();
				await signingOut.getByRole("link", { name: "Suite", exact: true }).click();
				await signingOut.getByRole("option").filter({ hasText: "C-1" }).click();
				await signingOut.getByRole("button", { name: "Private case", exact: true }).waitFor();
				await signingOut.keyboard.press("e");
				expect(await signingOut.getByRole("textbox", { name: "Step 1", exact: true }).inputValue()).toBe(
					"Original step",
				);
				await signingOut.getByRole("button", { name: "Sign out", exact: true }).click();
				await signingOut.getByRole("button", { name: "Sign out and clear browser data", exact: true }).click();
				for (const tab of [page, other]) {
					await tab.locator("#token").waitFor();
					await tab.reload();
					await tab.locator("#token").waitFor();
					expect(
						await tab.evaluate(() =>
							Object.entries(localStorage).filter(
								([key]) => key.startsWith("mainworthy:#2:") || key === "mainworthy:session-person",
							),
						),
					).toEqual([]);
				}
				expect(await page.evaluate(() => localStorage.getItem("mainworthy:#99:draft:scratch:C-2"))).toBe("Their draft");
				expect(await page.evaluate(() => localStorage.getItem("mainworthy:theme"))).toBe("dark");
				expect((await local.api("get", { refs: ["C-1"] }))[0]?.version).toBe(1);
				expect(browser.errors).toEqual([]);
			} finally {
				await browser?.close();
				await local.stop();
			}
		},
		30_000,
	);

test.skipIf(!browserAvailable)(
	"keeping browser data at sign-out and signing in after expiry both preserve the same person's draft",
	async () => {
		const local = await startServer({ mode: "server" });
		let browser: PageHarness | null = null;
		const missing: string[] = [];
		try {
			await local.api("propose", { edits: [{ op: "create", outline: "Kept case\n  Original step" }] });
			browser = await openPage(local, {
				path: "/p/scratch/suite/c/1",
				setup: async (page) => {
					page.on("response", (response) => {
						if (response.status() === 404) missing.push(new URL(response.url()).pathname);
					});
				},
			});
			const { page } = browser;
			await page.getByRole("button", { name: "Kept case", exact: true }).waitFor();
			await page.keyboard.press("e");
			const step = page.getByRole("textbox", { name: "Step 1", exact: true });
			await step.fill("Keep my unsaved text");
			await page.getByRole("button", { name: "Sign out", exact: true }).click();
			await page.getByRole("button", { name: "Sign out and keep drafts", exact: true }).click();
			await page.locator("#token").waitFor();
			expect(browser.dialogs).toEqual([]);
			const stored = () => page.evaluate(() => localStorage.getItem("mainworthy:#2:draft:scratch:C-1"));
			expect(await stored()).toContain("Keep my unsaved text");
			for (const expired of [false, true]) {
				if (expired) {
					await advanceClock(local, 366 * 24 * 60 * 60 * 1000);
					await page.reload();
					await page.locator("#token").waitFor();
					expect(await stored()).toContain("Keep my unsaved text");
				}
				await page.locator("#token").fill(local.token);
				await page.keyboard.press("Enter");
				await page.locator("#app").waitFor();
				await step.waitFor();
				expect(await step.inputValue()).toBe("Keep my unsaved text");
			}
			expect(browser.dialogs).toEqual([]);
			expect(browser.errors, JSON.stringify(missing)).toEqual([]);
		} finally {
			await browser?.close();
			await local.stop();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"a tab with delayed storage events cannot rewrite cleared notes after the same person signs in again",
	async () => {
		const local = await startServer({ mode: "server" });
		let browser: PageHarness | null = null;
		try {
			await local.api("propose", { edits: [{ op: "create", outline: "Delayed tab case\n  Original step" }] });
			const run = await local.api("plan", { name: "Delayed tab run", select: {} });
			browser = await openPage(local, { path: `/p/scratch/runs/${run.run.slice(2)}` });
			const { page, context } = browser;
			await page.locator('[data-active="true"][data-ready="true"]').waitFor();
			// A suspended tab may not process its storage notifications until after another tab signed in again.
			await page.addInitScript(() =>
				window.addEventListener("storage", (event) => event.stopImmediatePropagation(), true),
			);
			await page.reload();
			await page.locator('[data-active="true"][data-ready="true"]').waitFor();
			const note = page.getByRole("textbox", { name: "Result note" });
			await note.fill("Private note before clearing");
			const other = await context.newPage();
			await other.goto(`${local.url}/p/scratch/suite`);
			await other.locator("#app").waitFor();
			await other.getByRole("button", { name: "Sign out", exact: true }).click();
			await other.getByRole("button", { name: "Sign out and clear browser data", exact: true }).click();
			await other.locator("#token").waitFor();
			await other.locator("#token").fill(local.token);
			await other.keyboard.press("Enter");
			await other.locator("#app").waitFor();
			expect(await page.locator("#app").count()).toBe(1);
			await note.fill("Old tab tried to restore private text");
			expect(
				await other.evaluate(() =>
					Object.keys(localStorage).filter((key) => key.startsWith("mainworthy:#2:run-note:")),
				),
			).toEqual([]);
			await page.reload();
			await page.locator('[data-active="true"][data-ready="true"]').waitFor();
			expect(await note.inputValue()).toBe("");
			expect(browser.errors).toEqual([]);
		} finally {
			await browser?.close();
			await local.stop();
		}
	},
	30_000,
);
