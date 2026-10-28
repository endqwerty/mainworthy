// The page an invitation link opens, where the link does not simply work: a link that accepts nothing, a
// browser that is signed in as somebody else, and a link that replaces the identities a person signs in with.
// Accepting sends the browser to the identity provider and back.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Page } from "playwright-core";
import {
	acceptInvitation,
	advanceClock,
	browserAvailable,
	openPage,
	type PageHarness,
	type Server,
	startServer,
	subjectOf,
} from "./support.ts";

let server: Server;
beforeAll(async () => {
	if (browserAvailable) server = await startServer({ mode: "server", provider: true });
});
afterAll(async () => {
	await server?.stop();
});

const NOT_FOUND = "Failed to load resource: the server responded with a status of 404 (Not Found)";
const GONE = "This invitation does not work any more. Ask whoever sent it for a new one.";

async function invite(name: string, expires?: string): Promise<string> {
	const made = await server.api("invitation", { do: "create", name, ...(expires ? { expires } : {}) });
	if (!("code" in made)) throw new Error("no invitation was made");
	return made.code;
}
/** The body of the next acceptance the page begins with the provider. */
const nextAcceptance = (page: Page): Promise<unknown> =>
	page
		.waitForRequest((request) => request.url().endsWith("/api/login/oidc") && request.method() === "POST")
		.then((request) => request.postDataJSON());
/** Accepts an invitation as a script would, with no page, signing in at the provider as `name`. */
const accept = (code: string, name: string): Promise<string> =>
	acceptInvitation(server, code, { subject: subjectOf(name) });
/** The provider signs in `name` at the next request: what the next press of "Accept with Example ID" brings. */
const atProvider = (name: string): void => server.idp?.next({ subject: subjectOf(name) });
/** Signs in at the provider as `subject` with no page: the status of the answer's reply. */
async function signInByScript(subject: string): Promise<number> {
	const begun = await fetch(`${server.url}/api/login/oidc`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "{}",
	});
	const ceremony = begun.headers.getSetCookie()[0]?.split(";")[0] ?? "";
	server.idp?.next({ subject });
	const answered = await fetch(((await begun.json()) as { result: { url: string } }).result.url, {
		redirect: "manual",
	});
	const reply = await fetch(`${server.url}/api/login`, {
		method: "POST",
		headers: { "content-type": "application/json", cookie: ceremony },
		body: JSON.stringify({ oidc: new URL(answered.headers.get("location") ?? "").search }),
	});
	return reply.status;
}
const ACCEPT = "Accept with Example ID";

test.skipIf(!browserAvailable)(
	"a wrong, a used and an expired link each say the invitation no longer works, and no code stays in the address bar",
	async () => {
		const used = await invite("uma");
		await accept(used, "uma");
		const expired = await invite("eve", "1h");
		let browser: PageHarness | null = null;
		try {
			browser = await openPage(server, { signedIn: false, path: "/invite#not-a-code-anybody-made", ready: "h1" });
			const { page } = browser;
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
				page.waitForResponse((reply) => reply.url().endsWith("/api/login/invitation") && reply.status() === 404);
			let refused = refusedAgain();
			await page.goto(`${server.url}/invite#${used}`);
			await refused;
			await gone.waitFor();
			expect(await page.getByRole("heading", { name: "You are invited as ora" }).count()).toBe(0);

			// One that has run out: it worked, the instance's clock is moved two hours on, and it works no more.
			// Nobody waits an hour.
			const shows = await fetch(`${server.url}/api/login/invitation`, {
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
			await page.getByRole("heading", { name: "You are invited as kai" }).waitFor();
			await page.getByText("You are signed in as robin. This invitation is for kai.", { exact: false }).waitFor();
			// Nothing is accepted before the answer: the button waits.
			expect(await page.getByRole("button", { name: ACCEPT }).isDisabled()).toBe(true);
			expect(await server.api("session", { do: "list" })).toHaveLength(1);

			await page.getByRole("button", { name: "Continue as kai" }).click();
			await page.waitForFunction((name) => document.activeElement?.textContent === name, ACCEPT);
			atProvider("kai");
			const sent = nextAcceptance(page);
			await page.keyboard.press("Enter");
			// What is sent names the person the question was about, and nobody else.
			expect(await sent).toEqual({ invitation: code, replace: "robin" });
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
	"somebody who signs in elsewhere while the page is open is asked when they accept, and nothing is accepted before",
	async () => {
		const code = await invite("lou");
		let browser: PageHarness | null = null;
		try {
			browser = await openPage(server, { signedIn: false, path: `/invite#${code}`, ready: "h1" });
			const { page } = browser;
			await page.getByRole("heading", { name: "You are invited as lou" }).waitFor();
			await page.waitForFunction((name) => document.activeElement?.textContent === name, ACCEPT);
			// Another tab of this browser signs the owner in meanwhile.
			await browser.context.request.post(`${server.url}/api/login`, { data: { token: server.token } });
			const first = nextAcceptance(page);
			await page.keyboard.press("Enter");
			// The page knew of nobody signed in, so it named nobody to sign out.
			expect(await first).toEqual({ invitation: code });
			await page.getByText("You are signed in as robin. This invitation is for lou.", { exact: false }).waitFor();
			// Nothing was accepted, and the browser never left for the provider.
			expect(page.url()).toBe(`${server.url}/invite`);
			expect(await server.api("session", { do: "list" })).toHaveLength(1);

			// "Stay" would leave lou's invitation as it is. "Continue" begins again, naming the person the
			// question was about.
			atProvider("lou");
			const second = nextAcceptance(page);
			await page.getByRole("button", { name: "Continue as lou" }).click();
			expect(await second).toEqual({ invitation: code, replace: "robin" });
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
	"a recovery link says what accepting replaces, and the identity before it stops working",
	async () => {
		await accept(await invite("pat"), "pat");
		const code = await invite("pat");
		let browser: PageHarness | null = null;
		try {
			browser = await openPage(server, { signedIn: false, path: `/invite#${code}`, ready: "h1" });
			const { page } = browser;
			await page.getByRole("heading", { name: "You are invited as pat" }).waitFor();
			await page
				.getByText(
					"Accepting replaces the identities you sign in with, revokes all your tokens, and signs you out everywhere else.",
					{ exact: true },
				)
				.waitFor();
			// pat lost the identity they had, and accepts with another one.
			server.idp?.next({ subject: "sub-pat-new" });
			await page.getByRole("button", { name: ACCEPT }).click();
			await page.locator("#app").waitFor();
			expect(await page.locator(".sfoot .me").textContent()).toContain("pat");
			expect(await signInByScript(subjectOf("pat"))).toBe(401);
			expect(await signInByScript("sub-pat-new")).toBe(200);
			expect(browser.errors).toEqual([]);
		} finally {
			await browser?.close();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"the invitation page says how long to wait when too many attempts failed, and keeps the keys on its button",
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
					error: { code: "limited", message: `too many attempts; try again in ${seconds} seconds` },
				},
			});
			browser = await openPage(server, { signedIn: false, path: "/invite", ready: "h1" });
			const { page } = browser;
			// Looking at the invitation is refused: the page says the wait and offers to ask again, with the code
			// still in its memory though it has left the address.
			await page.route("**/api/login/invitation", (route) => route.fulfill(wait(3)));
			await page.goto(`${server.url}/invite#${code}`);
			await page.getByRole("status").filter({ hasText: "Too many attempts. Try again in 3 seconds." }).waitFor();
			expect(page.url()).toBe(`${server.url}/invite`);
			await page.unroute("**/api/login/invitation");
			await page.getByRole("button", { name: "Try again" }).click();
			await page.getByRole("heading", { name: "You are invited as quin" }).waitFor();

			// Beginning is refused: the wait is under the button. Sent from the button, by the keyboard. The keys
			// stay on the button through the request and after the refusal, so the next Enter is the next attempt.
			await page.route("**/api/login/oidc", (route) => route.fulfill(wait(1)));
			await page.waitForFunction((name) => document.activeElement?.textContent === name, ACCEPT);
			await page.keyboard.press("Enter");
			await page.getByRole("status").filter({ hasText: "Too many attempts. Try again in 1 second." }).waitFor();
			expect(await page.evaluate(() => document.activeElement?.textContent)).toBe(ACCEPT);
			expect(page.url()).toBe(`${server.url}/invite`);
			await page.unroute("**/api/login/oidc");
			atProvider("quin");
			await page.keyboard.press("Enter");
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

test.skipIf(!browserAvailable)(
	"an answer about one person signs nobody else out: whoever signed in from another tab meanwhile is asked about by name",
	async () => {
		await accept(await invite("tom"), "tom");
		const code = await invite("vera");
		const signedInAs = async (context: PageHarness["context"]): Promise<unknown> => {
			const reply = await context.request.get(`${server.url}/api/session`);
			return reply.ok() ? (await reply.json()).result.actor : null;
		};
		let browser: PageHarness | null = null;
		try {
			// The owner is signed in, opens a link that is for vera, and says that robin may be signed out.
			browser = await openPage(server, { path: `/invite#${code}`, ready: "h1" });
			const { page, context } = browser;
			await page.getByText("You are signed in as robin. This invitation is for vera.", { exact: false }).waitFor();
			await page.getByRole("button", { name: "Continue as vera" }).click();

			// In another tab of the same browser robin signs out and tom signs in, through the pages.
			const tab = await context.newPage();
			await tab.goto(`${server.url}/p/scratch/suite`);
			await tab.getByRole("button", { name: "Sign out" }).click();
			await tab.getByRole("button", { name: "Sign out and keep drafts", exact: true }).click();
			atProvider("tom");
			await tab.getByRole("button", { name: "Sign in with Example ID", exact: true }).click();
			await tab.locator("#app").waitFor();
			expect(await signedInAs(context)).toBe("tom");

			// Back in the first tab the invitation is accepted. The answer given was about robin, and that is the
			// name that goes with it.
			await page.bringToFront();
			const first = nextAcceptance(page);
			await page.getByRole("button", { name: ACCEPT }).click();
			expect(await first).toEqual({ invitation: code, replace: "robin" });

			// The browser is tom's now. Nobody said tom may be signed out, so nothing was begun: the page asks
			// again, about tom, and tom is still signed in.
			await page.getByText("You are signed in as tom. This invitation is for vera.", { exact: false }).waitFor();
			expect(await page.getByText("You are signed in as robin", { exact: false }).count()).toBe(0);
			expect(await page.getByRole("button", { name: ACCEPT }).isDisabled()).toBe(true);
			expect(await signedInAs(context)).toBe("tom");
			// (tom has two sessions: this browser's, and the script's that accepted tom's own invitation.)
			expect(await server.api("session", { do: "list", actor: "tom" })).toHaveLength(2);
			await tab.reload();
			await tab.locator("#app").waitFor();
			expect(await tab.locator(".sfoot .me").textContent()).toContain("tom");

			// The answer about tom goes with tom's name, and then the invitation is accepted.
			atProvider("vera");
			const second = nextAcceptance(page);
			await page.getByRole("button", { name: "Continue as vera" }).click();
			expect(await second).toEqual({ invitation: code, replace: "tom" });
			await page.locator("#app").waitFor();
			expect(await page.locator(".sfoot .me").textContent()).toContain("vera");
			expect(await signedInAs(context)).toBe("vera");
			// Only now is tom's session in this browser ended.
			expect(await server.api("session", { do: "list", actor: "tom" })).toHaveLength(1);
			expect(browser.errors).toEqual(["Failed to load resource: the server responded with a status of 409 (Conflict)"]);
		} finally {
			await browser?.close();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"the button of an invitation waits until the page knows who is signed in, and then for the answer about them",
	async () => {
		const code = await invite("wren");
		let browser: PageHarness | null = null;
		try {
			// The owner is signed in. The page is opened afresh with the answer to "who is signed in" held back.
			browser = await openPage(server, { path: "/invite", ready: "h1" });
			const { page } = browser;
			await page.goto("about:blank");
			let release = (): void => {};
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			await page.route("**/api/session", async (route) => {
				await held;
				await route.continue();
			});
			await page.goto(`${server.url}/invite#${code}`);
			// The invitation is shown, and nothing in it can be typed into or sent yet: the page does not know
			// whether somebody would be signed out.
			await page.getByRole("heading", { name: "You are invited as wren" }).waitFor();
			await page.getByText("Checking who is signed in to this browser", { exact: false }).waitFor();
			expect(await page.getByRole("button", { name: ACCEPT }).isDisabled()).toBe(true);
			expect(await page.getByRole("button", { name: /^Continue as / }).count()).toBe(0);

			// Told that it is robin, the page asks, and the button goes on waiting for the answer.
			release();
			await page.getByText("You are signed in as robin. This invitation is for wren.", { exact: false }).waitFor();
			expect(await page.getByRole("button", { name: ACCEPT }).isDisabled()).toBe(true);
			expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Continue as wren");
			await page.keyboard.press("Enter");
			await page.waitForFunction((name) => document.activeElement?.textContent === name, ACCEPT);
			expect(browser.errors).toEqual([]);
		} finally {
			await browser?.close();
		}
	},
	30_000,
);

for (const failure of ["is refused by the network", "never arrives"] as const)
	test.skipIf(!browserAvailable)(
		`when the answer to who is signed in ${failure}, the page says it could not find out, keeps the button closed and offers to ask again`,
		async () => {
			const code = await invite(failure === "never arrives" ? "xan" : "yul");
			let browser: PageHarness | null = null;
			try {
				// The owner is signed in. The page is opened afresh, and its first question about who is signed in
				// gets no answer; the second one is let through.
				browser = await openPage(server, { path: "/invite", ready: "h1" });
				const { page } = browser;
				await page.goto("about:blank");
				if (failure === "never arrives") await page.clock.install();
				let asked = 0;
				await page.route("**/api/session", (route) => {
					asked++;
					if (asked > 1) return route.continue();
					// Aborted: the browser reports a failed request. Never answered: the route is left hanging.
					return failure === "never arrives" ? undefined : route.abort();
				});
				await page.goto(`${server.url}/invite#${code}`);
				const name = failure === "never arrives" ? "xan" : "yul";
				await page.getByRole("heading", { name: `You are invited as ${name}` }).waitFor();
				if (failure === "never arrives") {
					// A slow answer is waited for. Past twenty seconds the page stops waiting and says so.
					await page.getByText("Checking who is signed in to this browser", { exact: false }).waitFor();
					await page.clock.runFor(19_000);
					expect(await page.getByRole("button", { name: "Try again" }).count()).toBe(0);
					await page.clock.runFor(2_000);
				}
				await page
					.getByRole("status")
					.filter({ hasText: "The page could not find out whether somebody is signed in to this browser" })
					.waitFor();
				// Nothing can be typed or sent: accepting might sign somebody out who was never asked about.
				expect(await page.getByRole("button", { name: ACCEPT }).isDisabled()).toBe(true);
				expect(await page.getByRole("button", { name: /^Continue as / }).count()).toBe(0);
				expect(asked).toBe(1);

				// "Try again" asks once more, with the invitation as it was: the code is still in the page's memory.
				await page.getByRole("button", { name: "Try again" }).click();
				await page.getByText(`You are signed in as robin. This invitation is for ${name}.`, { exact: false }).waitFor();
				expect(asked).toBe(2);
				expect(page.url()).toBe(`${server.url}/invite`);
				await page.getByRole("button", { name: `Continue as ${name}` }).click();
				atProvider(name);
				await page.getByRole("button", { name: ACCEPT }).click();
				await page.locator("#app").waitFor();
				expect(await page.locator(".sfoot .me").textContent()).toContain(name);
				expect(browser.errors).toEqual(failure === "never arrives" ? [] : ["Failed to load resource: net::ERR_FAILED"]);
			} finally {
				await browser?.close();
			}
		},
		30_000,
	);
