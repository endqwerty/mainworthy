import { expect, test } from "bun:test";
import { browserAvailable, openPage, startServer } from "./support.ts";

test.skipIf(!browserAvailable)(
	"shell routes, palette, help and theme work against the real server",
	async () => {
		const server = await startServer({ cases: 1 });
		const browser = await openPage(server);
		try {
			const { page } = browser;
			for (const [keys, route] of [
				["gs", "suite"],
				["gq", "queue"],
				["gr", "runs"],
				["gc", "changes"],
				["g,", "settings"],
			]) {
				if (!keys || !route) continue;
				await page.keyboard.press("Escape");
				await page.keyboard.type(keys);
				await page.waitForURL(`**/p/scratch/${route}`);
				expect(await page.locator("#list").count()).toBe(1);
			}
			await page.keyboard.press("Control+k");
			await page.getByRole("textbox", { name: "Jump to or run" }).fill("C-1");
			await page.keyboard.press("Enter");
			await page.waitForURL("**/suite/c/1");
			await page.keyboard.press("?");
			expect(await page.getByRole("region", { name: "Keyboard shortcuts" }).count()).toBe(1);
			await page.keyboard.press("Escape");
			await page.getByRole("button", { name: "Toggle theme" }).click();
			expect(await page.locator("html").getAttribute("data-theme")).toBe("dark");
			expect(browser.loads()).toBe(1);
			expect(browser.dialogs).toEqual([]);
			expect(browser.errors).toEqual([]);
		} finally {
			await browser.close();
			await server.stop();
		}
	},
	30_000,
);
