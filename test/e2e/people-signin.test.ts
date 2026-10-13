// A person gets in and out through the pages: an invitation accepted with a password, sign-out from the shell,
// and the sign-in page with a name and a password. The owner's token still signs a browser in from the same page.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { browserAvailable, openPage, type PageHarness, type Server, startServer } from "./support.ts";

let server: Server;
beforeAll(async () => {
	if (browserAvailable) server = await startServer({ mode: "server" });
});
afterAll(async () => {
	await server?.stop();
});

test.skipIf(!browserAvailable)(
	"an invited person accepts with a password, signs out from the shell and signs in with name and password",
	async () => {
		const made = await server.api("invitation", { do: "create", name: "sam", can: ["read", "answer"] });
		if (!("code" in made)) throw new Error("no invitation was made");
		let browser: PageHarness | null = null;
		try {
			browser = await openPage(server, { signedIn: false, path: `/invite#${made.code}`, ready: "h1" });
			const { page } = browser;
			page.setDefaultTimeout(8000);
			await page.getByRole("heading", { name: "You are invited as sam" }).waitFor();
			await page.getByText("This link works once, until", { exact: false }).waitFor();

			// The password is typed twice and counted as it is typed. Focus starts in the first field.
			expect(await page.evaluate(() => document.activeElement?.id)).toBe("invite-password");
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
			await page.getByRole("button", { name: "Sign out" }).click();
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
			page.setDefaultTimeout(8000);
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
	"five wrong passwords for a name, and the form says how long to wait, with the name and the password kept",
	async () => {
		let browser: PageHarness | null = null;
		try {
			browser = await openPage(server, { signedIn: false });
			const { page } = browser;
			page.setDefaultTimeout(8000);
			const refusal = page
				.locator("form")
				.filter({ has: page.locator("#signin-password") })
				.getByRole("status");
			/** Types one wrong password and waits for the server's answer to it. Returns the status of that answer. */
			const attempt = async (n: number): Promise<number> => {
				const answered = page.waitForResponse((response) => response.url().endsWith("/api/login"));
				await page.locator("#signin-password").fill(`wrong password number ${n}`);
				await page.keyboard.press("Enter");
				return (await answered).status();
			};
			// The browser reaches this server from the loopback address, which is not counted. What is counted is
			// the name, whether or not anybody has it.
			await page.locator("#signin-name").fill("nobody-of-that-name");
			// Four wrong passwords cost nothing, and the fifth is still answered as a wrong password: it is the one
			// that blocks.
			for (let n = 1; n <= 5; n++) {
				expect(await attempt(n)).toBe(401);
				await refusal.filter({ hasText: "That name and password did not sign you in." }).waitFor();
			}
			// The sixth is refused unread while the block lasts, which is one second at first. On a machine too
			// busy to type inside that second, the sixth is one more failure, which doubles the block for the
			// seventh, and so on (`limit.test.ts` says the same of a token).
			let status = 0;
			let last = 5;
			while (status !== 429 && last < 12) status = await attempt(++last);
			expect(status).toBe(429);
			await refusal.filter({ hasText: /^Too many attempts\. Try again in \d+ seconds?\.$/ }).waitFor();
			// Nothing else changed: what was typed is there for when the wait is over, and nothing was sent again.
			expect(await page.locator("#app").count()).toBe(0);
			expect(await page.locator("#signin-name").inputValue()).toBe("nobody-of-that-name");
			expect(await page.locator("#signin-password").inputValue()).toBe(`wrong password number ${last}`);
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
			page.setDefaultTimeout(8000);
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
			page.setDefaultTimeout(8000);
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
				page.setDefaultTimeout(8000);
				let posts = 0;
				page.on("request", (request) => {
					if (request.url().endsWith("/api/logout") && request.method() === "POST") posts++;
				});
				await page.locator("#list").waitFor();
				await page.getByRole("button", { name: "Sign out" }).focus();
				await page.keyboard.press(key);
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
	"a sign-out whose reply is lost is looked up, not guessed: the session ended, so the page shows the sign-in page",
	async () => {
		let browser: PageHarness | null = null;
		try {
			browser = await openPage(server, { path: "/p/scratch/settings" });
			const { page } = browser;
			page.setDefaultTimeout(8000);
			// The server signs the browser out, and the reply is dropped on its way back.
			await page.route("**/api/logout", async (route) => {
				await route.fetch();
				await route.abort();
			});
			await page.getByRole("button", { name: "Sign out" }).click();
			await page.locator("#signin-name").waitFor();
			expect(await page.locator("#app").count()).toBe(0);
			expect(browser.errors).toEqual(["Failed to load resource: net::ERR_FAILED"]);
		} finally {
			await browser?.close();
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
			page.setDefaultTimeout(8000);
			await page.route("**/api/logout", (route) => route.abort());
			await page.getByRole("button", { name: "Sign out" }).click();
			await page.getByText("this browser is still signed in", { exact: false }).waitFor();
			expect(await page.locator("#app").count()).toBe(1);
			await page.unroute("**/api/logout");
			await page.getByRole("button", { name: "Sign out" }).click();
			await page.locator("#signin-name").waitFor();
			expect(browser.errors).toEqual(["Failed to load resource: net::ERR_FAILED"]);
		} finally {
			await browser?.close();
		}
	},
	30_000,
);
