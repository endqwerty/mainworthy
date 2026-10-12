import { expect, test } from "bun:test";
import { browserAvailable, openPage, startServer } from "./support.ts";

test.skipIf(!browserAvailable)(
	"server sign-in rejects a wrong token and accepts the owner token",
	async () => {
		const server = await startServer({ mode: "server" });
		const browser = await openPage(server, { signedIn: false });
		try {
			const { page } = browser;
			const token = page.getByRole("textbox", { name: "Sign in with your token" });
			await token.fill("not-a-valid-owner-token");
			await page.keyboard.press("Enter");
			await page.getByRole("status").filter({ hasText: "not accepted" }).waitFor();
			expect(await page.locator("#app").count()).toBe(0);
			await token.fill(server.token);
			await page.keyboard.press("Enter");
			await page.locator("#app").waitFor();
			expect(await page.locator(".sfoot .me").textContent()).toContain("daniel");
			expect(browser.errors).toEqual([]);
		} finally {
			await browser.close();
			await server.stop();
		}
	},
	30_000,
);
