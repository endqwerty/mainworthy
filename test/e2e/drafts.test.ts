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

test.skipIf(!browserAvailable)(
	"30 seconds idle records one version, preserves the caret and updates current proof",
	async () => {
		const server = await startServer();
		await server.api("propose", {
			edits: [
				{ op: "create", body: { title: "Idle case", steps: [{ id: "a1", action: "Open cart", expected: null }] } },
			],
		});
		const planned = await server.api("plan", { name: "Evidence", select: { cases: ["C-1"] } });
		await server.api("report", { run: planned.run, results: [{ test: { case: "C-1" }, outcome: "pass" }] });
		const browser = await openPage(server, { path: "/p/scratch/suite/c/1" });
		try {
			const { page } = browser;
			await page.getByRole("button", { name: "Idle case", exact: true }).waitFor();
			await page.keyboard.press("e");
			const title = page.getByRole("textbox", { name: "Case title", exact: true });
			await title.fill("Idle case revised");
			await page.waitForFunction(() => document.querySelector(".cstate")?.textContent?.includes("v2"), null, {
				timeout: 35_000,
			});
			expect(await title.inputValue()).toBe("Idle case revised");
			expect(
				await title.evaluate((node) =>
					node instanceof HTMLTextAreaElement
						? { focused: document.activeElement === node, caret: node.selectionStart }
						: null,
				),
			).toEqual({ focused: true, caret: 17 });
			expect(await page.getByRole("option").filter({ hasText: "C-1" }).locator(".pf").first().textContent()).toContain(
				"~",
			);
			await page.keyboard.press("Control+Enter");
			expect((await server.api("get", { refs: ["C-1"] }))[0]?.version).toBe(2);
			expect(browser.errors).toEqual([]);
		} finally {
			await browser.close();
			await server.stop();
		}
	},
	45_000,
);
