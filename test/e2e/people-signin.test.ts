// A person gets in and out through the pages: an invitation accepted with a password, sign-out from the shell,
// and the sign-in page with a name and a password. The owner's token still signs a browser in from the same page.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { z } from "zod";
import { totpCode } from "../../src/server/identity/totp.ts";
import {
	advanceClock,
	browserAvailable,
	devicePrefix,
	openPage,
	type PageHarness,
	type Server,
	startServer,
} from "./support.ts";

let server: Server;
beforeAll(async () => {
	if (browserAvailable) {
		server = await startServer({ mode: "server" });
		// The tests below name the owner's storage keys by id: a new instance's owner has id 2.
		expect(await devicePrefix(server, server.token)).toBe("mainworthy:#2:");
	}
});
afterAll(async () => {
	await server?.stop();
});

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
				await page.locator("#signin-name").waitFor();
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
	"an invited person accepts with a password, signs out from the shell and signs in with name and password",
	async () => {
		const made = await server.api("invitation", { do: "create", name: "sam", can: ["read", "answer"] });
		if (!("code" in made)) throw new Error("no invitation was made");
		let browser: PageHarness | null = null;
		try {
			browser = await openPage(server, { signedIn: false, path: `/invite#${made.code}`, ready: "h1" });
			const { page } = browser;
			await page.getByRole("heading", { name: "You are invited as sam" }).waitFor();
			await page.getByText("This link works once, until", { exact: false }).waitFor();

			// The password is typed twice and counted as it is typed. Focus starts in the first field.
			expect(await page.evaluate(() => document.activeElement?.id)).toBe("invite-password");
			// What a password manager is told about a password it makes up: the lengths the server takes.
			for (const id of ["#invite-password", "#invite-password-again"])
				expect(await page.locator(id).getAttribute("passwordrules")).toBe("minlength: 12; maxlength: 256;");
			await page.keyboard.type("short");
			await page.getByText("5 of 12 characters", { exact: true }).waitFor();
			// A password that is too short is refused in the page, beside the field, and what was typed stays.
			await page.keyboard.press("Enter");
			await page.getByRole("status").filter({ hasText: "a password is 12 to 256 characters" }).waitFor();
			expect(await page.locator("#invite-password").inputValue()).toBe("short");
			await page.locator("#invite-password").fill("correct horse battery");
			await page.getByText("21 characters", { exact: true }).waitFor();
			await page.keyboard.press("Tab");
			await page.keyboard.type("correct horse batter");
			await page.keyboard.press("Enter");
			await page.getByRole("status").filter({ hasText: "The two passwords differ." }).waitFor();
			await page.keyboard.type("y");
			await page.keyboard.press("Enter");

			// Signed in, and in the app.
			await page.locator("#app").waitFor();
			expect(await page.locator(".sfoot .me").textContent()).toContain("sam");
			await page.waitForURL("**/p/scratch/suite");

			// Out through the shell, by the key the keys sheet names.
			await page.keyboard.press("g");
			await page.keyboard.press("x");
			await page.getByRole("dialog", { name: "Sign out" }).waitFor();
			await page.keyboard.press("Enter");
			await page.locator("#signin-name").waitFor();
			expect(await page.locator("#app").count()).toBe(0);
			// The session ended on the server, not only in the page: a reload is still the sign-in page.
			await page.reload();
			await page.locator("#signin-name").waitFor();

			// A wrong password: one sentence, and the name stays. Focus started in the name field.
			expect(await page.evaluate(() => document.activeElement?.id)).toBe("signin-name");
			await page.keyboard.type("sam");
			await page.keyboard.press("Tab");
			await page.keyboard.type("not the password");
			// Sent from the button, by the keyboard. The button keeps the keys while the request runs and after
			// the refusal, so somebody who works without a mouse is not left on nothing.
			await page.keyboard.press("Tab");
			expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Sign in");
			await page.keyboard.press("Enter");
			await page.getByRole("status").filter({ hasText: "That name and password did not sign you in." }).waitFor();
			expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Sign in");
			expect(await page.locator("#signin-name").inputValue()).toBe("sam");
			expect(await page.locator("#app").count()).toBe(0);
			// Nobody is told where a lost password goes but to an admin.
			await page.getByText("an admin can send you a new link", { exact: false }).waitFor();

			await page.locator("#signin-password").fill("correct horse battery");
			await page.keyboard.press("Enter");
			await page.locator("#app").waitFor();
			expect(await page.locator(".sfoot .me").textContent()).toContain("sam");

			// The button in the shell does what the key does.
			await page.getByRole("button", { name: "Sign out", exact: true }).click();
			await page.getByRole("button", { name: "Sign out and keep drafts", exact: true }).click();
			await page.locator("#signin-name").waitFor();
			expect(browser.errors).toEqual([]);
		} finally {
			await browser?.close();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"the token form still signs the owner in, and Tab reaches the three ways in the order they are shown",
	async () => {
		let browser: PageHarness | null = null;
		try {
			browser = await openPage(server, { signedIn: false });
			const { page } = browser;
			const focused = () => page.evaluate(() => document.activeElement?.id || document.activeElement?.textContent);
			expect(await focused()).toBe("signin-name");
			const order: unknown[] = [];
			for (let i = 0; i < 4; i++) {
				await page.keyboard.press("Tab");
				order.push(await focused());
			}
			// This instance was given no public address, so no passkey is offered.
			expect(order).toEqual(["signin-password", "Sign in", "token", "Sign in with the token"]);
			expect(await page.getByRole("button", { name: "Sign in with a passkey" }).count()).toBe(0);

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
	"a limited password sign-in says how long to wait, with the name and the password kept",
	async () => {
		let browser: PageHarness | null = null;
		try {
			browser = await openPage(server, { signedIn: false });
			const { page } = browser;
			const refusal = page
				.locator("form")
				.filter({ has: page.locator("#signin-password") })
				.getByRole("status");
			await page.route("**/api/login", (route) =>
				route.fulfill({
					status: 429,
					headers: { "Retry-After": "23" },
					json: { ok: false, error: { code: "limited", message: "Too many attempts" } },
				}),
			);
			await page.locator("#signin-name").fill("nobody-of-that-name");
			await page.locator("#signin-password").fill("wrong password");
			await page.keyboard.press("Enter");
			await refusal.filter({ hasText: /^Too many attempts\. Try again in 23 seconds\.$/ }).waitFor();
			expect(await page.locator("#app").count()).toBe(0);
			expect(await page.locator("#signin-name").inputValue()).toBe("nobody-of-that-name");
			expect(await page.locator("#signin-password").inputValue()).toBe("wrong password");
			expect(await page.getByRole("button", { name: "Sign in", exact: true }).isEnabled()).toBe(true);
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
			// What the server answers a sign-in whose body took too long to arrive. A test answers in its place:
			// no browser sends a body that slowly.
			const slow = "the sign-in request took too long to arrive";
			let reply: { status: number; code: string; message: string } = { status: 408, code: "invalid", message: slow };
			await page.route("**/api/login", (route) =>
				route.fulfill({
					status: reply.status,
					json: { ok: false, error: { code: reply.code, message: reply.message } },
				}),
			);
			await page.locator("#signin-name").fill("sam");
			await page.locator("#signin-password").fill("some password or other");
			await page.keyboard.press("Enter");
			const password = page.locator("form").filter({ has: page.locator("#signin-password") });
			await password.getByRole("status").filter({ hasText: slow }).waitFor();
			expect(await password.getByRole("status").innerText()).toBe(slow);
			expect(await page.locator("#signin-name").inputValue()).toBe("sam");
			expect(await page.locator("#signin-password").inputValue()).toBe("some password or other");
			// The button is back for the next attempt.
			expect(await page.getByRole("button", { name: "Sign in", exact: true }).isEnabled()).toBe(true);

			// A wait whose length a proxy dropped on the way: the sentence has no number, and is not the page's
			// sentence for a wrong token.
			reply = { status: 429, code: "limited", message: "too many failed attempts; try again in 30 seconds" };
			await page.locator("#token").fill("some token or other");
			await page.keyboard.press("Enter");
			const token = page.locator("form").filter({ has: page.locator("#token") });
			await token.getByRole("status").filter({ hasText: "Too many attempts. Try again later." }).waitFor();
			// One refusal is on the page at a time, under what caused it.
			expect(await password.getByRole("status").innerText()).toBe("");
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
				await page.locator("#signin-name").waitFor();
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
			await page.locator("#signin-name").waitFor();
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
				await page.locator("#signin-name").waitFor();
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
						await tab.locator("#signin-name").waitFor();
						await tab.reload();
						await tab.locator("#signin-name").waitFor();
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
				await page.locator("#signin-name").waitFor();
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
				await keeping.locator("#signin-name").waitFor();
				if (keeping !== page) {
					await page.keyboard.press("g");
					await page.keyboard.press("q");
					await page.locator("#signin-name").waitFor();
				}
				await page.reload();
				await page.locator("#signin-name").waitFor();
				expect(await page.evaluate(() => localStorage.getItem("mainworthy:#2:queue-input:scratch:pending"))).toBe(
					"Kept after failed clear",
				);
				expect(await page.evaluate(() => localStorage.getItem("mainworthy:session-person"))).toBe("2");
				await page.locator("#token").fill(local.token);
				await page.keyboard.press("Enter");
				await page.locator("#app").waitFor();
				await advanceClock(local, 366 * 24 * 60 * 60 * 1000);
				await page.reload();
				await page.locator("#signin-name").waitFor();
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
			await page.locator("#signin-name").waitFor();
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
				await signingOut.locator("#signin-name").waitFor();
				expect(
					await signingOut.evaluate(() =>
						Object.keys(localStorage).filter(
							(key) => key.startsWith("mainworthy:#2:") || key === "mainworthy:session-person",
						),
					),
				).toEqual([]);
				expect(warning).toContain("unsaved");
				expect(warning).toContain("robin");
				await page.locator("#signin-name").waitFor();
				await other.locator("#signin-name").waitFor();
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
					await tab.locator("#signin-name").waitFor();
					await tab.reload();
					await tab.locator("#signin-name").waitFor();
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
		try {
			await local.api("propose", { edits: [{ op: "create", outline: "Kept case\n  Original step" }] });
			browser = await openPage(local, { path: "/p/scratch/suite/c/1" });
			const { page } = browser;
			await page.getByRole("button", { name: "Kept case", exact: true }).waitFor();
			await page.keyboard.press("e");
			const step = page.getByRole("textbox", { name: "Step 1", exact: true });
			await step.fill("Keep my unsaved text");
			await page.getByRole("button", { name: "Sign out", exact: true }).click();
			await page.getByRole("button", { name: "Sign out and keep drafts", exact: true }).click();
			await page.locator("#signin-name").waitFor();
			expect(browser.dialogs).toEqual([]);
			const stored = () => page.evaluate(() => localStorage.getItem("mainworthy:#2:draft:scratch:C-1"));
			expect(await stored()).toContain("Keep my unsaved text");
			for (const expired of [false, true]) {
				if (expired) {
					await advanceClock(local, 366 * 24 * 60 * 60 * 1000);
					await page.reload();
					await page.locator("#signin-name").waitFor();
					expect(await stored()).toContain("Keep my unsaved text");
				}
				await page.locator("#token").fill(local.token);
				await page.keyboard.press("Enter");
				await page.locator("#app").waitFor();
				await step.waitFor();
				expect(await step.inputValue()).toBe("Keep my unsaved text");
			}
			expect(browser.dialogs).toEqual([]);
			expect(browser.errors).toEqual([]);
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
			await other.locator("#signin-name").waitFor();
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

test.skipIf(!browserAvailable)(
	"Settings enrols TOTP and password sign-in waits for an authenticator or recovery code",
	async () => {
		const password = "the browser TOTP password";
		const made = await server.api("invitation", { do: "create", name: "totp-browser", can: ["read"] });
		if (!("code" in made)) throw new Error("no invitation");
		await fetch(`${server.url}/api/login`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ invitation: made.code, password }),
		});
		const browser = await openPage(server, { path: "/p/scratch/settings", as: { name: "totp-browser", password } });
		try {
			const { page, context } = browser;
			await page.getByRole("option", { name: "Your sign-in", exact: true }).click();
			await page.getByRole("button", { name: "Add an authenticator", exact: true }).click();
			await page.getByRole("img", { name: "Authenticator QR code", exact: true }).waitFor();
			const secret = await page.getByTestId("totp-setup-key").innerText();
			const clockReply = await fetch(`${server.url}/test/clock`, {
				method: "POST",
				headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
				body: JSON.stringify({ advanceMs: 0 }),
			});
			const ahead = z.object({ result: z.object({ ahead: z.number() }) }).parse(await clockReply.json()).result.ahead;
			await page
				.getByLabel("Authenticator code", { exact: true })
				.fill(totpCode(secret, Math.floor((Date.now() + ahead) / 30_000)));
			await page.getByRole("button", { name: "Confirm authenticator", exact: true }).click();
			const recoveryCodes = page.getByRole("list", { name: "Recovery codes", exact: true });
			await recoveryCodes.waitFor();
			const recovery = await recoveryCodes.locator("li").first().innerText();
			expect(await recoveryCodes.locator("li").count()).toBe(10);
			await page.getByRole("button", { name: "I saved the recovery codes", exact: true }).click();
			await recoveryCodes.waitFor({ state: "detached" });
			expect(await page.getByRole("button", { name: "Remove the password", exact: true }).isDisabled()).toBe(true);
			await page.getByRole("button", { name: "Sign out", exact: true }).click();
			await page.getByRole("button", { name: "Sign out and keep drafts", exact: true }).click();
			await page.locator("#signin-name").fill("totp-browser");
			await page.locator("#signin-password").fill(password);
			await page.getByRole("button", { name: "Sign in", exact: true }).click();
			await page.getByRole("heading", { name: "One more step", exact: true }).waitFor();
			expect((await context.cookies()).some((cookie) => cookie.name === "mainworthy_sid")).toBe(false);
			await page.getByLabel("Authenticator or recovery code", { exact: true }).fill("bad-code");
			await page.getByRole("button", { name: "Verify code", exact: true }).click();
			await page.getByRole("status").filter({ hasText: "That code did not sign you in." }).waitFor();
			expect(await page.getByLabel("Authenticator or recovery code", { exact: true }).inputValue()).toBe("bad-code");
			await page.getByLabel("Authenticator or recovery code", { exact: true }).fill(recovery);
			await page.getByRole("button", { name: "Verify code", exact: true }).click();
			await page.locator("#app").waitFor();
			expect(browser.errors).toEqual([]);
		} finally {
			await browser.close();
		}
	},
	30_000,
);
