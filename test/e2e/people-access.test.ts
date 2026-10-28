import { afterAll, beforeAll, expect, test } from "bun:test";
import {
	advanceClock,
	browserAvailable,
	confirmWithProvider,
	eventually,
	joinPerson,
	linkIdentity,
	openPage,
	type PageHarness,
	proveIdentity,
	type Server,
	startServer,
} from "./support.ts";

let server: Server;
beforeAll(async () => {
	if (!browserAvailable) return;
	server = await startServer({ mode: "server", provider: true });
});
afterAll(async () => {
	await server?.stop();
});

const person = (name: string, admin = false): Promise<void> => joinPerson(server, name, admin ? {} : { can: ["read"] });

/**
 * The person signed in on `browser` links a second identity, `<name>-key` at the provider, after confirming with
 * the one they joined with: "Example ID (<name>-key@example.com)".
 */
async function secondIdentity(browser: PageHarness, name: string): Promise<string> {
	await proveIdentity(browser.context, server, name);
	await linkIdentity(browser.context, server, name, { subject: `sub-${name}-key`, email: `${name}-key@example.com` });
	return `Example ID (${name}-key@example.com)`;
}

test.skipIf(!browserAvailable)(
	"People lets a human admin inspect each person's sign-in, end sessions, remove identities and audit token use",
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
		const used = await fetch(`${server.url.replace("localhost", "127.0.0.1")}/api/session`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${token.token}` },
			body: JSON.stringify({ do: "list" }),
		});
		expect(used.status).toBe(200);
		const sam = await openPage(server, { as: { name: "sam" }, path: "/p/scratch/settings" });
		const admin = await openPage(server, { as: { name: "ada" }, path: "/p/scratch/settings" });
		try {
			const label = await secondIdentity(sam, "sam");
			// ada confirmed it is her at the provider a moment ago, so removing somebody's identity asks no more.
			await proveIdentity(admin.context, server, "ada");
			const { page } = admin;
			await page.getByRole("option", { name: "People", exact: true }).click();
			await page.getByRole("button", { name: "Sign-in details for sam", exact: true }).click();
			const details = page.getByRole("region", { name: "Sign-in details for sam", exact: true });
			const key = details.locator(".settings-row").filter({ hasText: label });
			await key.waitFor();
			expect(await key.innerText()).toContain("never used");
			const first = details
				.locator(".settings-row")
				.filter({ has: page.getByRole("button", { name: "Remove Example ID (sam@example.com)", exact: true }) });
			expect(await first.innerText()).toContain("last used");
			const sessions = details.getByRole("region", { name: "Sessions for sam", exact: true });
			await sessions.getByRole("button", { name: /^End the session/ }).waitFor();
			expect(await sessions.innerText()).toContain("opened with Example ID (sam@example.com) from");
			expect(await sessions.innerText()).toContain("last used");
			expect(await sessions.innerText()).not.toContain("this browser");

			await page.getByRole("button", { name: "Sign-in details for ada", exact: true }).click();
			const ada = page.getByRole("region", { name: "Sign-in details for ada", exact: true });
			await ada.getByText("this browser", { exact: true }).waitFor();
			expect(await ada.innerText()).not.toContain(label);
			expect(
				await ada.getByRole("button", { name: "Remove Example ID (ada@example.com)", exact: true }).isDisabled(),
			).toBe(true);
			await sessions.getByRole("button", { name: /^End the session/ }).click();
			await sessions.getByText("sam must sign in again in that browser.", { exact: true }).waitFor();
			expect(await server.api("session", { do: "list", actor: "sam" })).toHaveLength(1);
			await sessions.getByRole("button", { name: "Cancel", exact: true }).click();
			expect(await server.api("session", { do: "list", actor: "sam" })).toHaveLength(1);
			await sessions.getByRole("button", { name: /^End the session/ }).click();
			await sessions.getByRole("button", { name: "End this session", exact: true }).click();
			await sessions.getByText("No browser is signed in.", { exact: true }).waitFor();
			await sam.page.reload();
			await sam.page.locator("#token").waitFor();

			await page.route("**/api/credential", async (route) => {
				if (route.request().postDataJSON().do !== "remove") return route.continue();
				await route.fetch();
				await route.abort();
			});
			await key.getByRole("button", { name: `Remove ${label}`, exact: true }).click();
			await key
				.getByText("sam cannot sign in with this identity again. Sessions opened with it end.", { exact: true })
				.waitFor();
			expect(await server.api("credential", { do: "list", actor: "sam" })).toHaveLength(2);
			await key.getByRole("button", { name: "Cancel", exact: true }).click();
			expect(await server.api("credential", { do: "list", actor: "sam" })).toHaveLength(2);
			await key.getByRole("button", { name: `Remove ${label}`, exact: true }).click();
			await key.getByRole("button", { name: "Remove this identity", exact: true }).click();
			await details.getByRole("status").filter({ hasText: "cannot tell whether the identity was removed" }).waitFor();
			await key.waitFor({ state: "detached" });
			await page.unroute("**/api/credential");
			// The identity sam joined with is the last one, and stays.
			expect(
				await details.getByRole("button", { name: "Remove Example ID (sam@example.com)", exact: true }).isDisabled(),
			).toBe(true);
			expect(await server.api("credential", { do: "list", actor: "sam" })).toMatchObject([
				{ kind: "oidc", label: "Example ID (sam@example.com)" },
			]);

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
	"People on a phone removes the identity another person signed in with after confirming, keeps their last and fits the screen",
	async () => {
		await person("phone-person");
		await server.api("admin", {
			do: "token.create",
			actor: "unused-device",
			kind: "agent",
			label: "unused-device-".repeat(8),
		});
		const other = await openPage(server, { as: { name: "phone-person" }, path: "/p/scratch/settings" });
		// The owner, by token, with an identity to confirm with once the token's sign-in proof has run out.
		const admin = await openPage(server, {
			path: "/p/scratch/settings",
			device: "phone",
			setup: (_, context) => linkIdentity(context, server, "robin"),
		});
		try {
			const kept = await secondIdentity(other, "phone-person");
			await advanceClock(server, 10 * 60_000 + 1);
			const { page } = admin;
			const details = page.getByRole("region", { name: "Sign-in details for phone-person", exact: true });
			const remove = details.getByRole("button", { name: "Remove Example ID (phone-person@example.com)", exact: true });
			const open = async () => {
				await page.getByRole("option", { name: "People", exact: true }).tap();
				await page.getByRole("button", { name: "Sign-in details for phone-person", exact: true }).tap();
				await remove.waitFor();
				expect((await remove.boundingBox())?.height).toBeGreaterThanOrEqual(44);
				await remove.tap();
				await details
					.getByText("phone-person cannot sign in with this identity again. Sessions opened with it end.", {
						exact: true,
					})
					.waitFor();
				expect(await server.api("credential", { do: "list", actor: "phone-person" })).toHaveLength(2);
				await details.getByRole("button", { name: "Remove this identity", exact: true }).tap();
			};
			await open();
			await confirmWithProvider(page, server, "robin");
			// The page came back from the provider; the removal is made again.
			await open();
			await remove.waitFor({ state: "detached" });
			// The session phone-person opened with that identity ended with it.
			await eventually(
				() => server.api("session", { do: "list", actor: "phone-person" }),
				(rows) => Array.isArray(rows) && rows.length === 0,
			);
			expect(await details.getByRole("button", { name: `Remove ${kept}`, exact: true }).isDisabled()).toBe(true);
			await page
				.locator(".settings-token")
				.filter({ hasText: "unused-device-" })
				.getByText(/never used/)
				.waitFor();
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
			await other.page.reload();
			await other.page.locator("#token").waitFor();
			expect(admin.errors).toEqual(["Failed to load resource: the server responded with a status of 403 (Forbidden)"]);
			expect(other.errors).toEqual([]);
		} finally {
			await other.close();
			await admin.close();
		}
	},
	25_000,
);

for (const device of ["desktop", "phone"] as const) {
	test.skipIf(!browserAvailable)(
		`People inline confirmations keep focus and cancel without writes on ${device}`,
		async () => {
			const actor = `confirmation-${device}`;
			await person(actor);
			const other = await openPage(server, { as: { name: actor }, path: "/p/scratch/settings" });
			const admin = await openPage(server, { path: "/p/scratch/settings", device });
			try {
				const label = await secondIdentity(other, actor);
				const { page } = admin;
				await page.getByRole("option", { name: "People", exact: true }).click();
				await page.getByRole("button", { name: `Sign-in details for ${actor}`, exact: true }).click();
				const details = page.getByRole("region", { name: `Sign-in details for ${actor}`, exact: true });
				const sessions = details.getByRole("region", { name: `Sessions for ${actor}`, exact: true });
				const mutations: string[] = [];
				page.on("request", (request) => {
					if (!/\/api\/(credential|session)$/.test(request.url()) || request.method() !== "POST") return;
					const input = request.postDataJSON();
					if (input.do === "remove" || input.do === "end") mutations.push(input.do);
				});
				for (const action of [
					{
						trigger: details.getByRole("button", { name: `Remove Example ID (${actor}@example.com)`, exact: true }),
						confirm: "Remove this identity",
					},
					{
						trigger: details.getByRole("button", { name: `Remove ${label}`, exact: true }),
						confirm: "Remove this identity",
					},
					{ trigger: sessions.getByRole("button", { name: /^End the session/ }), confirm: "End this session" },
				]) {
					const confirm = details.getByRole("button", { name: action.confirm, exact: true });
					const cancel = details.getByRole("button", { name: "Cancel", exact: true });
					for (const dismiss of ["Cancel", "Escape on confirm", "Escape on Cancel"]) {
						if (device === "phone") await action.trigger.tap();
						else {
							await action.trigger.focus();
							await action.trigger.press("Enter");
						}
						await confirm.waitFor();
						if (device === "phone") {
							const target = await cancel.boundingBox();
							if (!target) throw new Error("Cancel is not visible");
							expect(target.width).toBeGreaterThanOrEqual(44);
							expect(target.height).toBeGreaterThanOrEqual(44);
							expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
						}
						expect(await confirm.evaluate((button) => button === document.activeElement)).toBe(true);
						if (dismiss === "Cancel") {
							if (device === "phone") await cancel.tap();
							else await cancel.click();
						} else await (dismiss === "Escape on confirm" ? confirm : cancel).press("Escape");
						await action.trigger.waitFor();
						expect(await action.trigger.evaluate((button) => button === document.activeElement)).toBe(true);
						expect(await confirm.count()).toBe(0);
					}
				}
				expect(mutations).toEqual([]);
				expect(await server.api("credential", { do: "list", actor })).toHaveLength(2);
				expect(await server.api("session", { do: "list", actor })).toHaveLength(1);
				expect(admin.errors).toEqual([]);
				expect(other.errors).toEqual([]);
			} finally {
				await other.close();
				await admin.close();
			}
		},
		30_000,
	);
}
