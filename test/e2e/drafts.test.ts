import { expect, test } from "bun:test";
import { browserAvailable, openPage, startServer } from "./support.ts";

test.skipIf(!browserAvailable)(
	"L2 reload restores an unsealed sentence and its caret",
	async () => {
		const server = await startServer();
		const browser = await openPage(server);
		try {
			const { page } = browser;
			await page.keyboard.press("c");
			await page.keyboard.type("Coupon capture");
			await page.keyboard.press("Enter");
			await page.keyboard.type("The coupon should preserve the");
			await page.reload();
			await page.waitForSelector("#app");
			const step = page.getByRole("textbox", { name: "Step 1", exact: true });
			await step.waitFor();
			expect(await step.inputValue()).toBe("The coupon should preserve the");
			const selection = await step.evaluate((node) =>
				node instanceof HTMLTextAreaElement
					? { start: node.selectionStart, end: node.selectionEnd, focused: document.activeElement === node }
					: null,
			);
			expect(selection).toEqual({ start: 30, end: 30, focused: true });
			const stored = await server.api("find", { in: "cases" });
			if (stored.items.length) {
				const ref = stored.items[0]?.ref;
				if (typeof ref !== "string") throw new Error("Case ref missing");
				expect((await server.api("get", { refs: [ref] }))[0]?.steps).toMatchObject([
					{ action: "The coupon should preserve the" },
				]);
			}
			expect(browser.errors).toEqual([]);
		} finally {
			await browser.close();
			await server.stop();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"a failed seal keeps the typed text and retry uses the same command",
	async () => {
		const server = await startServer();
		const browser = await openPage(server);
		try {
			const { page } = browser;
			await page.keyboard.press("c");
			await page.keyboard.type("Network recovery");
			await page.keyboard.press("Enter");
			await page.keyboard.type("The draft is kept");
			await page.route("**/api/p/scratch/propose", (route) =>
				route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({ ok: false, error: { code: "internal", message: "Temporarily unavailable" } }),
				}),
			);
			await page.keyboard.press("Escape");
			await page.waitForFunction(() => document.getElementById("stat")?.textContent?.includes("kept on this device"));
			expect(await page.getByRole("textbox", { name: "Step 1", exact: true }).inputValue()).toBe("The draft is kept");
			await page.unroute("**/api/p/scratch/propose");
			await page.keyboard.press("Control+Enter");
			await page.waitForURL("**/suite/c/1");
			expect((await server.api("get", { refs: ["C-1"] }))[0]?.version).toBe(1);
		} finally {
			await browser.close();
			await server.stop();
		}
	},
	30_000,
);
