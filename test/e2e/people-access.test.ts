import { afterAll, beforeAll, expect, test } from "bun:test";
import {
	addAuthenticator,
	browserAvailable,
	eventually,
	openPage,
	type PageHarness,
	type Server,
	startServer,
} from "./support.ts";

let started: Server;
let server: Server;
const PASSWORD = "a password for this test";
beforeAll(async () => {
	if (!browserAvailable) return;
	started = await startServer({ mode: "server", passkeys: true });
	server = { ...started, url: started.url.replace("127.0.0.1", "localhost") };
});
afterAll(async () => {
	await started?.stop();
});

async function person(name: string, admin = false): Promise<void> {
	const made = await server.api("invitation", { do: "create", name, ...(admin ? {} : { can: ["read"] }) });
	if (!("code" in made)) throw new Error("no invitation was made");
	const accepted = await fetch(`${server.url}/api/login`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ invitation: made.code, password: PASSWORD }),
	});
	expect(accepted.status).toBe(200);
	const cookie = accepted.headers.getSetCookie()[0]?.split(";")[0] ?? "";
	await fetch(`${server.url}/api/logout`, {
		method: "POST",
		headers: { "content-type": "application/json", cookie },
		body: "{}",
	});
}

async function passkey(browser: PageHarness, label: string): Promise<void> {
	await addAuthenticator(browser);
	await browser.page.getByRole("option", { name: "Your sign-in", exact: true }).click();
	await browser.page.locator("#passkey-label").fill(label);
	await browser.page.getByRole("button", { name: "Add a passkey", exact: true }).click();
	await browser.page
		.getByRole("status")
		.filter({ hasText: `${label} was added.` })
		.waitFor();
}

test.skipIf(!browserAvailable)(
	"People lets a human admin inspect each person's sign-in, end sessions, remove passkeys and audit token use",
	async () => {
		await person("sam");
		await person("ada", true);
		const token = await server.api("admin", {
			do: "token.create",
			actor: "sam",
			kind: "human",
			label: "sam laptop token",
		});
		if (!("token" in token)) throw new Error("no token was made");
		const used = await fetch(`${started.url}/api/session`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${token.token}` },
			body: JSON.stringify({ do: "list" }),
		});
		expect(used.status).toBe(200);
		const sam = await openPage(server, { as: { name: "sam", password: PASSWORD }, path: "/p/scratch/settings" });
		const admin = await openPage(server, { as: { name: "ada", password: PASSWORD }, path: "/p/scratch/settings" });
		try {
			await passkey(sam, "Sam security key");
			const { page } = admin;
			page.setDefaultTimeout(3000);
			await page.getByRole("option", { name: "People", exact: true }).click();
			await page.getByRole("button", { name: "Sign-in details for sam", exact: true }).click();
			const details = page.getByRole("region", { name: "Sign-in details for sam", exact: true });
			await details.getByText("Password set", { exact: true }).waitFor();
			const key = details.locator(".settings-row").filter({ hasText: "Sam security key" });
			await key.waitFor();
			expect(await key.innerText()).toContain("never used");
			const sessions = details.getByRole("region", { name: "Sessions for sam", exact: true });
			await sessions.getByRole("button", { name: /^End the session/ }).waitFor();
			expect(await sessions.innerText()).toContain("opened with the password from");
			expect(await sessions.innerText()).toContain("last used");
			expect(await sessions.innerText()).not.toContain("this browser");

			await page.getByRole("button", { name: "Sign-in details for ada", exact: true }).click();
			const ada = page.getByRole("region", { name: "Sign-in details for ada", exact: true });
			await ada.getByText("this browser", { exact: true }).waitFor();
			expect(await ada.innerText()).not.toContain("Sam security key");
			expect(await ada.getByRole("button", { name: "Remove the password", exact: true }).isDisabled()).toBe(true);
			await sessions.getByRole("button", { name: /^End the session/ }).click();
			await sessions.getByText("No browser is signed in.", { exact: true }).waitFor();
			await sam.page.reload();
			await sam.page.locator("#signin-name").waitFor();

			await page.route("**/api/credential", async (route) => {
				if (route.request().postDataJSON().do !== "remove") return route.continue();
				await route.fetch();
				await route.abort();
			});
			await key.getByRole("button", { name: "Remove Sam security key", exact: true }).click();
			await details.getByRole("status").filter({ hasText: "cannot tell whether the credential was removed" }).waitFor();
			await key.waitFor({ state: "detached" });
			await page.unroute("**/api/credential");
			expect(await details.getByRole("button", { name: "Remove the password", exact: true }).isDisabled()).toBe(true);
			expect(await server.api("credential", { do: "list", actor: "sam" })).toMatchObject([{ kind: "password" }]);

			const issued = page.locator(".settings-token").filter({ hasText: "sam laptop token" });
			await issued.waitFor();
			expect(await issued.innerText()).toContain("sam");
			expect(await issued.innerText()).toMatch(/token \d+ · sam laptop token/);
			expect(await issued.innerText()).toContain("last used");
			expect(await issued.innerText()).toContain("from 127.0.0.1");
			expect(await page.content()).not.toContain(token.token);
			await issued.getByRole("button", { name: "Revoke sam", exact: true }).click();
			await issued.getByText("Revoked", { exact: true }).waitFor();
			await ada.getByRole("button", { name: /^End the session/ }).click();
			await page.getByRole("dialog").waitFor();
			await page.getByRole("button", { name: "Stay signed in" }).click();
			expect(await page.locator("#app").count()).toBe(1);
			expect(sam.errors).toEqual([]);
			expect(admin.errors).toEqual(["Failed to load resource: net::ERR_FAILED"]);
		} finally {
			await sam.close();
			await admin.close();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"People on a phone removes another person's password, keeps their last passkey and fits the screen",
	async () => {
		await person("phone-person");
		await server.api("admin", {
			do: "token.create",
			actor: "unused-device",
			kind: "agent",
			label: "unused-device-".repeat(8),
		});
		const other = await openPage(server, {
			as: { name: "phone-person", password: PASSWORD },
			path: "/p/scratch/settings",
		});
		const admin = await openPage(server, { path: "/p/scratch/settings", device: "phone" });
		try {
			await passkey(other, "Phone security key");
			const { page } = admin;
			page.setDefaultTimeout(3000);
			await page.getByRole("option", { name: "People", exact: true }).tap();
			await page.getByRole("button", { name: "Sign-in details for phone-person", exact: true }).tap();
			const details = page.getByRole("region", { name: "Sign-in details for phone-person", exact: true });
			await details.getByText("Password set", { exact: true }).waitFor();
			expect(
				(await details.getByRole("button", { name: "Remove the password", exact: true }).boundingBox())?.height,
			).toBeGreaterThanOrEqual(44);
			await details.getByRole("button", { name: "Remove the password", exact: true }).tap();
			await details.getByText("No password set", { exact: true }).waitFor();
			await eventually(
				() => server.api("session", { do: "list", actor: "phone-person" }),
				(rows) => Array.isArray(rows) && rows.length === 0,
			);
			expect(await details.getByRole("button", { name: "Remove Phone security key", exact: true }).isDisabled()).toBe(
				true,
			);
			await page
				.locator(".settings-token")
				.filter({ hasText: "unused-device-" })
				.getByText(/never used/)
				.waitFor();
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
			await other.page.reload();
			await other.page.locator("#signin-name").waitFor();
			expect(admin.errors).toEqual([]);
			expect(other.errors).toEqual([]);
		} finally {
			await other.close();
			await admin.close();
		}
	},
	25_000,
);
