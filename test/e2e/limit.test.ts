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
			/** Types one wrong token and waits for the server's answer to it. Returns the status of that answer. */
			const attempt = async (n: number): Promise<number> => {
				const answered = page.waitForResponse((response) => response.url().endsWith("/api/login"));
				// The browser reaches this server from the loopback address, which is not counted. What blocks is the
				// first 8 characters the wrong tokens share.
				await field.fill(`wrong-token-${n}-0123456789`);
				await page.keyboard.press("Enter");
				return (await answered).status();
			};
			// Four wrong tokens cost nothing, and the fifth is still answered as a wrong token: it is the one that
			// blocks.
			for (let n = 1; n <= 5; n++) {
				expect(await attempt(n)).toBe(401);
				// The page writes the sentence a moment after the answer arrives; a person reads it when it is there.
				await message.filter({ hasText: /^That token was not accepted\. Try again\.$/ }).waitFor({ timeout: 4000 });
			}
			// The sixth is refused unread while the block lasts, which is one second at first. The server's clock is
			// the real one here: on a machine too busy to type inside that second, the sixth is one more failure,
			// which doubles the block for the seventh, and so on. Six is what a quiet machine needs.
			let status = 0;
			for (let n = 6; n <= 12 && status !== 429; n++) status = await attempt(n);
			expect(status).toBe(429);
			await page.getByText(/^Too many attempts\. Try again in \d+ seconds?\.$/).waitFor({ timeout: 4000 });
			// Nothing else changed: the form is still there, with what was typed in it.
			expect(await page.locator("#app").count()).toBe(0);
			expect(await field.inputValue()).toMatch(/^wrong-token-\d+-0123456789$/);
		} finally {
			await browser.close();
			await server.stop();
		}
	},
	30_000,
);
