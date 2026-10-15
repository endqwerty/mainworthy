import { afterAll, beforeAll, expect, test } from "bun:test";
import { z } from "zod";
import { addAuthenticator, browserAvailable, openPage, type PageHarness, type Server, startServer } from "./support.ts";

let started: Server;
let server: Server;
const PASSWORD = "a password for this test";
const Credentials = z.array(z.object({ id: z.number(), kind: z.string(), label: z.string() }));
const CreatedToken = z.object({ token: z.string() });
const Sessions = z.array(z.object({ id: z.number(), openedWith: z.string() }));

beforeAll(async () => {
	if (!browserAvailable) return;
	started = await startServer({ mode: "server", passkeys: true });
	server = { ...started, url: started.url.replace("127.0.0.1", "localhost") };
});
afterAll(async () => {
	await started?.stop();
});

async function person(name: string): Promise<void> {
	const invitation = await server.api("invitation", { do: "create", name });
	if (!("code" in invitation)) throw new Error("no invitation was made");
	const accepted = await fetch(`${server.url}/api/login`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ invitation: invitation.code, password: PASSWORD }),
	});
	expect(accepted.status).toBe(200);
	const cookie = accepted.headers.getSetCookie().find((value) => value.startsWith("mainworthy_sid="));
	await fetch(`${server.url}/api/logout`, {
		method: "POST",
		headers: { cookie: cookie?.split(";")[0] ?? "" },
	});
}

test.skipIf(!browserAvailable)(
	"a non-owner admin inspects another person's sign-in and token use, ends their session and removes a passkey",
	async () => {
		await person("sam");
		await person("admin-person");
		const token = CreatedToken.parse(
			await server.api("admin", { do: "token.create", actor: "sam", kind: "human", label: "sam CLI" }),
		);
		await server.api("find", { in: "cases" }, { token: token.token });
		const unused = CreatedToken.parse(
			await server.api("admin", {
				do: "token.create",
				actor: "nightly",
				kind: "ci",
				label: "nightly report",
			}),
		);
		let sam: PageHarness | null = null;
		let admin: PageHarness | null = null;
		try {
			sam = await openPage(server, { as: { name: "sam", password: PASSWORD }, path: "/p/scratch/settings" });
			await addAuthenticator(sam);
			await sam.page.getByRole("option", { name: "Your sign-in", exact: true }).click();
			await sam.page.getByLabel("Passkey name").fill("Sam security key");
			await sam.page.getByRole("button", { name: "Add a passkey", exact: true }).click();
			await sam.page.getByRole("status").filter({ hasText: "Sam security key was added." }).waitFor();

			admin = await openPage(server, { as: { name: "admin-person", password: PASSWORD }, path: "/p/scratch/settings" });
			const { page } = admin;
			page.setDefaultTimeout(4000);
			await page.getByRole("option", { name: "People", exact: true }).click();
			const inspect = page.getByRole("button", { name: "Sessions and sign-in for sam", exact: true });
			await inspect.focus();
			await page.keyboard.press("Enter");
			const details = page.getByRole("region", { name: "Sessions and sign-in for sam", exact: true });
			await details.getByText("Password is set.", { exact: true }).waitFor();
			await details.getByText("Sam security key", { exact: true }).waitFor();
			const sessionRow = details.locator(".settings-row").filter({ hasText: "opened with the password" });
			await sessionRow.waitFor();
			expect(await sessionRow.innerText()).toMatch(
				/opened with the password from 127\.0\.0\.1 · .*last used .* from 127\.0\.0\.1/,
			);
			expect(await sessionRow.innerText()).not.toContain("this browser");
			expect(await details.getByRole("button", { name: "Remove the password", exact: true }).isDisabled()).toBe(false);
			expect(await page.getByRole("button", { name: "Recovery link for sam", exact: true }).count()).toBe(0);

			const tokenUse = page.getByRole("region", { name: "Token use", exact: true });
			const usedRow = tokenUse.locator(".settings-row").filter({ hasText: "sam CLI" });
			await usedRow.waitFor();
			expect(await usedRow.innerText()).toMatch(/sam.*sam CLI/s);
			expect(await usedRow.innerText()).toContain("Active");
			expect(await usedRow.innerText()).toMatch(/last used .* from 127\.0\.0\.1/);
			expect(await tokenUse.locator(".settings-row").filter({ hasText: "nightly report" }).innerText()).toContain(
				"never used",
			);
			expect(await tokenUse.innerText()).not.toContain(token.token);
			expect(await tokenUse.innerText()).not.toContain(unused.token);

			await sessionRow.getByRole("button", { name: /^End the session/ }).click();
			await details.getByText("No browser is signed in.", { exact: true }).waitFor();
			expect(Sessions.parse(await server.api("session", { do: "list", actor: "sam" }))).toEqual([]);
			const signedIn = await sam.context.request.get(`${server.url}/api/session`);
			expect(signedIn.status()).toBe(401);
			expect((await admin.context.request.get(`${server.url}/api/session`)).status()).toBe(200);

			// A passkey session ends too when the credential it rests on is removed.
			await sam.page.reload();
			await sam.page.getByRole("button", { name: "Sign in with a passkey", exact: true }).click();
			await sam.page.locator("#app").waitFor();
			expect(Sessions.parse(await server.api("session", { do: "list", actor: "sam" }))).toMatchObject([
				{ openedWith: "passkey" },
			]);
			await details.getByRole("button", { name: "Remove Sam security key", exact: true }).click();
			await details.getByText("Sam security key", { exact: true }).waitFor({ state: "detached" });
			expect(Credentials.parse(await server.api("credential", { do: "list", actor: "sam" }))).toMatchObject([
				{ kind: "password" },
			]);
			expect((await sam.context.request.get(`${server.url}/api/session`)).status()).toBe(401);
			expect(await details.getByRole("button", { name: "Remove the password", exact: true }).isDisabled()).toBe(true);
			await details.getByText("The only way sam signs in stays.", { exact: false }).waitFor();
			const held = Promise.withResolvers<void>();
			await page.route("**/api/credential", async (route) => {
				if (route.request().postData()?.includes('"admin-person"')) await held.promise;
				await route.continue();
			});
			await page.getByRole("button", { name: "Sessions and sign-in for admin-person", exact: true }).click();
			const ownDetails = page.getByRole("region", { name: "Sessions and sign-in for admin-person", exact: true });
			try {
				await ownDetails.getByText("Reading ways of signing in…", { exact: true }).waitFor();
				expect(await ownDetails.getByRole("button", { name: /^Remove / }).count()).toBe(0);
			} finally {
				held.resolve();
			}
			await ownDetails.getByText("Password is set.", { exact: true }).waitFor();
			expect(await details.count()).toBe(0);
			await page
				.getByRole("region", { name: "Sessions and sign-in for admin-person", exact: true })
				.getByText("this browser", { exact: true })
				.waitFor();
			expect(admin.errors).toEqual([]);
			await page
				.getByRole("region", { name: "Sessions and sign-in for admin-person", exact: true })
				.getByRole("button", { name: /End the session.*this browser/ })
				.click();
			await page.locator("#signin-name").waitFor();
			expect((await admin.context.request.get(`${server.url}/api/session`)).status()).toBe(401);
		} finally {
			await admin?.close();
			await sam?.close();
		}
	},
	40_000,
);

test.skipIf(!browserAvailable)(
	"People details fit a phone and a refused read never looks like an empty credential list",
	async () => {
		await person("phone-person");
		const phone = await openPage(server, { device: "phone", path: "/p/scratch/settings" });
		try {
			const { page } = phone;
			page.setDefaultTimeout(4000);
			await page.getByRole("option", { name: "People", exact: true }).tap();
			await page.route("**/api/credential", (route) =>
				route.fulfill({
					status: 403,
					json: { ok: false, error: { code: "forbidden", message: "The credential list is unavailable." } },
				}),
			);
			await page.getByRole("button", { name: "Sessions and sign-in for phone-person", exact: true }).tap();
			const details = page.getByRole("region", { name: "Sessions and sign-in for phone-person", exact: true });
			await details.getByText("The credential list is unavailable.", { exact: true }).waitFor();
			expect(await details.getByText("No password is set.", { exact: true }).count()).toBe(0);
			expect(await details.getByRole("button", { name: /^Remove / }).count()).toBe(0);
			expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
			expect(await details.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
			expect(
				await page
					.locator(".settings-person")
					.evaluateAll((elements) => elements.every((element) => element.scrollWidth <= element.clientWidth)),
			).toBe(true);
		} finally {
			await phone.close();
		}
	},
	20_000,
);
