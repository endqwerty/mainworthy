import { expect, test } from "bun:test";
import { browserAvailable, openPage, startServer } from "./support.ts";

test.skipIf(!browserAvailable)(
	"the sign-in form says how long to wait once too many wrong tokens were typed",
	async () => {
		const server = await startServer({ mode: "server" });
		const browser = await openPage(server, { signedIn: false });
		try {
			const { page } = browser;
			const field = page.getByRole("textbox", { name: "Sign in with your token" });
			const message = page.locator(".signin .error");
			await page.route("**/api/login", (route) =>
				route.fulfill({
					status: 429,
					headers: { "Retry-After": "17" },
					json: { ok: false, error: { code: "limited", message: "Too many attempts" } },
				}),
			);
			await field.fill("wrong-token-0123456789");
			await page.keyboard.press("Enter");
			await message.filter({ hasText: /^Too many attempts\. Try again in 17 seconds\.$/ }).waitFor();
			expect(await page.locator("#app").count()).toBe(0);
			expect(await field.inputValue()).toBe("wrong-token-0123456789");
		} finally {
			await browser.close();
			await server.stop();
		}
	},
	30_000,
);
