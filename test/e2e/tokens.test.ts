// A token's end, its maker and its last address, as the settings page shows them in a real browser.
import { expect, test } from "bun:test";
import { z } from "zod";
import { answer, browserAvailable, fetched, openPage, startServer } from "./support.ts";

const DAY = 86_400_000;
const Listed = z.array(
	z.object({
		actor: z.string(),
		expiresAt: z.number().nullable(),
		createdBy: z.string().nullable(),
		lastUsedFrom: z.string().nullable(),
	}),
);

test.skipIf(!browserAvailable)(
	"settings gives a new token an end, and lists it with when it ends, who made it and where it was used from",
	async () => {
		const server = await startServer({ mode: "server" });
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			view = await openPage(server, { path: "/p/scratch/settings" });
			const { page } = view;
			await page.getByRole("option", { name: "Tokens", exact: true }).click();
			await page.route("**/api/admin", async (route) => {
				if (route.request().postDataJSON().do !== "token.list") return route.continue();
				await route.fulfill({ json: { ok: true, result: [] } });
			});
			await page.getByRole("option", { name: "Policy", exact: true }).click();
			await page.getByRole("option", { name: "Tokens", exact: true }).click();
			await page.getByText("No tokens yet. Press n to create one.", { exact: true }).waitFor();
			await page.keyboard.press("n");
			expect(await page.getByLabel("Token actor").evaluate((input) => input === document.activeElement)).toBe(true);
			await page.unroute("**/api/admin");
			// The form offers four lifetimes and starts from none.
			const expires = page.getByLabel("Expires", { exact: true });
			expect(await expires.locator("option").allInnerTexts()).toEqual(["Never", "30 days", "90 days", "1 year"]);
			expect(await expires.inputValue()).toBe("");
			await page.getByLabel("Token actor").fill("nightly");
			await expires.selectOption({ label: "90 days" });
			const before = Date.now();
			await page.getByRole("button", { name: "Create token", exact: true }).click();
			await page.getByLabel("New token").waitFor();
			const secret = await page.getByLabel("New token").inputValue();

			// Listed with its end and its maker: the owner, who is signed in to this browser.
			const row = page.locator(".settings-token", { hasText: "nightly" });
			await row.getByText("expires in 90 days", { exact: false }).waitFor();
			const facts = await row.locator("small").innerText();
			expect(facts).toMatch(/^token \d+ · agent for scratch · created now by robin · expires in 90 days · never used$/);
			expect(await row.locator("span.dim").innerText()).toBe("Active");
			expect(facts).not.toContain(secret);
			// What the page says is what the server holds.
			const held = Listed.parse(await server.api("admin", { do: "token.list" })).find(
				(token) => token.actor === "nightly",
			);
			expect(held).toMatchObject({ createdBy: "robin", lastUsedFrom: null });
			expect(held?.expiresAt ?? 0).toBeGreaterThanOrEqual(before + 90 * DAY);
			expect(held?.expiresAt ?? 0).toBeLessThanOrEqual(Date.now() + 90 * DAY);

			// Used once, and the list says where from when it is read again.
			expect((await server.api("find", { in: "cases" }, { token: secret })).items).toEqual([]);
			await page.getByRole("button", { name: "Dismiss secret" }).click();
			await page.getByLabel("Token actor").fill("forever");
			await expires.selectOption({ label: "Never" });
			await page.getByRole("button", { name: "Create token", exact: true }).click();
			await row.getByText("last used", { exact: false }).waitFor();
			expect(await row.locator("small").innerText()).toMatch(
				/^token \d+ · agent for scratch · created (now|1m) by robin · expires in 90 days · last used (now|1m) from 127\.0\.0\.1$/,
			);
			// A token with no end says nothing of one.
			const endless = page.locator(".settings-token", { hasText: "forever" });
			expect(await endless.locator("small").innerText()).toMatch(
				/^token \d+ · agent for scratch · created now by robin · never used$/,
			);

			// Past its end it reads "Expired", and there is nothing left to revoke. This server's clock cannot be
			// moved, so the list the page is given next says of one token what the server says once the end has
			// come (`expired`, by the server's clock: test/tokens.test.ts). The page must not count for itself.
			expect(await page.getByRole("button", { name: "Revoke nightly", exact: true }).count()).toBe(1);
			await page.route("**/api/admin", async (route) => {
				if (!route.request().postData()?.includes('"token.list"')) return route.continue();
				// The page lists the tokens again by itself. One such request can be here when the test closes it.
				const listed = await fetched(route);
				if (!listed) return;
				const reply = z.object({ ok: z.literal(true), result: z.array(z.looseObject({ actor: z.string() })) });
				const body = reply.parse(listed.json);
				await answer(route, {
					response: listed.response,
					json: {
						...body,
						result: body.result.map((token) => (token.actor === "nightly" ? { ...token, expired: true } : token)),
					},
				});
			});
			await page.getByRole("button", { name: "Dismiss secret" }).click();
			await page.getByLabel("Token actor").fill("third");
			await page.getByRole("button", { name: "Create token", exact: true }).click();
			await page.locator(".settings-token", { hasText: "third" }).waitFor();
			await row.getByText("Expired", { exact: true }).waitFor();
			expect(await row.locator("small").innerText()).not.toContain("expires");
			expect(await page.getByRole("button", { name: "Revoke nightly", exact: true }).count()).toBe(0);
			expect(await page.getByRole("button", { name: "Revoke forever", exact: true }).count()).toBe(1);
			expect(view.errors).toEqual([]);
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	30_000,
);
