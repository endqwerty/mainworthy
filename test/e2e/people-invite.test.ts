// The page an invitation link opens, where the link does not simply work: a link that accepts nothing, a
// browser that is signed in as somebody else, and a link that replaces what a person signs in with.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { advanceClock, browserAvailable, openPage, type PageHarness, type Server, startServer } from "./support.ts";

let server: Server;
beforeAll(async () => {
	if (browserAvailable) server = await startServer({ mode: "server" });
});
afterAll(async () => {
	await server?.stop();
});

const NOT_FOUND = "Failed to load resource: the server responded with a status of 404 (Not Found)";
const GONE = "This invitation does not work any more. Ask whoever sent it for a new one.";
const PASSWORD = "a long enough password";

async function invite(name: string, expires?: string): Promise<string> {
	const made = await server.api("invitation", { do: "create", name, ...(expires ? { expires } : {}) });
	if (!("code" in made)) throw new Error("no invitation was made");
	return made.code;
}
/** Accepts an invitation as a script would, with no page. */
async function accept(code: string, password = PASSWORD): Promise<void> {
	const reply = await fetch(`${server.url}/api/login`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ invitation: code, password }),
	});
	if (!reply.ok) throw new Error(`the invitation was not accepted: ${reply.status}`);
}

test.skipIf(!browserAvailable)(
	"a wrong, a used and an expired link each say the invitation no longer works, and no code stays in the address bar",
	async () => {
		const used = await invite("uma");
		await accept(used);
		const expired = await invite("eve", "1h");
		let browser: PageHarness | null = null;
		try {
			browser = await openPage(server, { signedIn: false, path: "/invite#not-a-code-anybody-made", ready: "h1" });
			const { page } = browser;
			page.setDefaultTimeout(8000);
			const gone = page.getByRole("status").filter({ hasText: GONE });
			await gone.waitFor();
			// The code is read and taken out of the address at once, whatever comes of it.
			expect(page.url()).toBe(`${server.url}/invite`);
			expect(await page.locator("input").count()).toBe(0);

			// A link that works shows who it is for; the same link, once used, does not. A second link opened
			// in the same tab is read too, though the page does not load again for it.
			const open = await invite("ora");
			await page.goto(`${server.url}/invite#${open}`);
			await page.getByRole("heading", { name: "You are invited as ora" }).waitFor();
			expect(page.url()).toBe(`${server.url}/invite`);
			const refusedAgain = () =>
				page.waitForResponse((reply) => reply.url().endsWith("/api/login/challenge") && reply.status() === 404);
			let refused = refusedAgain();
			await page.goto(`${server.url}/invite#${used}`);
			await refused;
			await gone.waitFor();
			expect(await page.getByRole("heading", { name: "You are invited as ora" }).count()).toBe(0);

			// One that has run out: it worked, the instance's clock is moved two hours on, and it works no more.
			// Nobody waits an hour.
			const shows = await fetch(`${server.url}/api/login/challenge`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ invitation: expired }),
			});
			expect(shows.status).toBe(200);
			await advanceClock(server, 2 * 3_600_000);
			refused = refusedAgain();
			await page.goto(`${server.url}/invite#${expired}`);
			await refused;
			await gone.waitFor();
			expect(page.url()).toBe(`${server.url}/invite`);

			// The address with no code at all: nothing was asked of the server, and the page says what to do.
			await page.reload();
			await page.getByRole("status").filter({ hasText: "Open the link you were given again." }).waitFor();
			// The three refusals this journey asked for, and nothing else.
			expect(browser.errors).toEqual([NOT_FOUND, NOT_FOUND, NOT_FOUND]);
		} finally {
			await browser?.close();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"a browser signed in as somebody else is told who, and asked before that session is replaced",
	async () => {
		const code = await invite("kai");
		let browser: PageHarness | null = null;
		try {
			// The owner is signed in here, and opens a link that is for kai.
			browser = await openPage(server, { path: `/invite#${code}`, ready: "h1" });
			const { page } = browser;
			page.setDefaultTimeout(8000);
			await page.getByRole("heading", { name: "You are invited as kai" }).waitFor();
			await page.getByText("You are signed in as robin. This invitation is for kai.", { exact: false }).waitFor();
			// Nothing is accepted before the answer: the fields wait.
			expect(await page.locator("#invite-password").isDisabled()).toBe(true);
			expect(await server.api("session", { do: "list" })).toHaveLength(1);

			await page.getByRole("button", { name: "Continue as kai" }).click();
			expect(await page.evaluate(() => document.activeElement?.id)).toBe("invite-password");
			await page.keyboard.type(PASSWORD);
			await page.keyboard.press("Tab");
			await page.keyboard.type(PASSWORD);
			await page.keyboard.press("Enter");
			await page.locator("#app").waitFor();
			expect(await page.locator(".sfoot .me").textContent()).toContain("kai");
			// The owner's session in this browser ended with it.
			expect(await server.api("session", { do: "list" })).toHaveLength(0);
			expect(browser.errors).toEqual([]);
		} finally {
			await browser?.close();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"somebody who signs in elsewhere while the page is open is asked when they accept, and what they typed stays",
	async () => {
		const code = await invite("lou");
		let browser: PageHarness | null = null;
		try {
			browser = await openPage(server, { signedIn: false, path: `/invite#${code}`, ready: "h1" });
			const { page } = browser;
			page.setDefaultTimeout(8000);
			await page.getByRole("heading", { name: "You are invited as lou" }).waitFor();
			await page.locator("#invite-password").fill(PASSWORD);
			await page.locator("#invite-password-again").fill(PASSWORD);
			// Another tab of this browser signs the owner in meanwhile.
			await browser.context.request.post(`${server.url}/api/login`, { data: { token: server.token } });
			await page.keyboard.press("Enter");
			await page.getByText("You are signed in as robin. This invitation is for lou.", { exact: false }).waitFor();
			// Nothing was accepted, and nothing typed is gone.
			expect(await page.locator("#invite-password").inputValue()).toBe(PASSWORD);
			expect(await page.locator("#invite-password-again").inputValue()).toBe(PASSWORD);
			expect(await server.api("session", { do: "list" })).toHaveLength(1);

			// "Stay" would leave lou's invitation as it is. "Continue" sends what was typed, this time to replace.
			await page.getByRole("button", { name: "Continue as lou" }).click();
			await page.locator("#app").waitFor();
			expect(await page.locator(".sfoot .me").textContent()).toContain("lou");
			expect(browser.errors).toEqual(["Failed to load resource: the server responded with a status of 409 (Conflict)"]);
		} finally {
			await browser?.close();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"a recovery link says what accepting replaces, and the password before it stops working",
	async () => {
		await accept(await invite("pat"), "the password pat had");
		const code = await invite("pat");
		let browser: PageHarness | null = null;
		try {
			browser = await openPage(server, { signedIn: false, path: `/invite#${code}`, ready: "h1" });
			const { page } = browser;
			page.setDefaultTimeout(8000);
			await page.getByRole("heading", { name: "You are invited as pat" }).waitFor();
			await page
				.getByText("Accepting replaces every way you sign in and signs you out everywhere else.", { exact: true })
				.waitFor();
			await page.locator("#invite-password").fill(PASSWORD);
			await page.locator("#invite-password-again").fill(PASSWORD);
			await page.getByRole("button", { name: "Accept and sign in" }).click();
			await page.locator("#app").waitFor();
			const signIn = (password: string) =>
				fetch(`${server.url}/api/login`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ name: "pat", password }),
				}).then((reply) => reply.status);
			expect(await signIn("the password pat had")).toBe(401);
			expect(await signIn(PASSWORD)).toBe(200);
			expect(browser.errors).toEqual([]);
		} finally {
			await browser?.close();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"the invitation page says how long to wait when too many attempts failed, and keeps what was typed",
	async () => {
		const code = await invite("quin");
		let browser: PageHarness | null = null;
		try {
			// A test answers in the server's place: this browser is on the loopback address, which is not counted.
			const wait = (seconds: number) => ({
				status: 429,
				headers: { "retry-after": String(seconds) },
				json: {
					ok: false,
					error: { code: "limited", message: `too many failed attempts; try again in ${seconds} seconds` },
				},
			});
			browser = await openPage(server, { signedIn: false, path: "/invite", ready: "h1" });
			const { page } = browser;
			page.setDefaultTimeout(8000);
			// Looking at the invitation is refused: the page says the wait and offers to ask again, with the code
			// still in its memory though it has left the address.
			await page.route("**/api/login/challenge", (route) => route.fulfill(wait(3)));
			await page.goto(`${server.url}/invite#${code}`);
			await page.getByRole("status").filter({ hasText: "Too many attempts. Try again in 3 seconds." }).waitFor();
			expect(page.url()).toBe(`${server.url}/invite`);
			await page.unroute("**/api/login/challenge");
			await page.getByRole("button", { name: "Try again" }).click();
			await page.getByRole("heading", { name: "You are invited as quin" }).waitFor();

			// Accepting is refused: the wait is under the form and the passwords are still in it.
			await page.route("**/api/login", (route) => route.fulfill(wait(1)));
			await page.locator("#invite-password").fill(PASSWORD);
			await page.locator("#invite-password-again").fill(PASSWORD);
			await page.keyboard.press("Enter");
			await page.getByRole("status").filter({ hasText: "Too many attempts. Try again in 1 second." }).waitFor();
			expect(await page.locator("#invite-password").inputValue()).toBe(PASSWORD);
			expect(await page.locator("#invite-password-again").inputValue()).toBe(PASSWORD);
			await page.unroute("**/api/login");
			await page.getByRole("button", { name: "Accept and sign in" }).click();
			await page.locator("#app").waitFor();
			expect(await page.locator(".sfoot .me").textContent()).toContain("quin");
			const refused = "Failed to load resource: the server responded with a status of 429 (Too Many Requests)";
			expect(browser.errors).toEqual([refused, refused]);
		} finally {
			await browser?.close();
		}
	},
	30_000,
);
