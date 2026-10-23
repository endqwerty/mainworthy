import { expect, test } from "bun:test";
import { join } from "node:path";
import { browserAvailable, eventually, openPage, startServer } from "./support.ts";

for (const entry of ["reload", "navigation", "switch"] as const)
	test.skipIf(!browserAvailable)(
		`a selected case explains loading and an early edit key after ${entry}`,
		async () => {
			const device = entry === "navigation" ? "phone" : "desktop";
			const server = await startServer();
			if (entry === "switch") await server.api("propose", { edits: [{ op: "create", body: { title: "First case" } }] });
			await server.api("propose", { edits: [{ op: "create", outline: "Waiting case\n  Read its steps" }] });
			const h = await openPage(server, { path: "/p/scratch/suite/c/1", device });
			let release = () => {};
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			try {
				const { page } = h;
				await page.locator("#detail .read-body .ctitle").waitFor();
				let requested = false;
				await page.route("**/api/p/scratch/get", async (route) => {
					requested = true;
					await held;
					await route.continue();
				});
				if (entry === "switch") await page.keyboard.press("j");
				else if (entry === "reload") await page.reload();
				else {
					await page.goto(`${server.url}/p/scratch/queue`);
					await page.goto(`${server.url}/p/scratch/suite/c/1`);
				}
				await eventually(async () => requested, Boolean);
				await page
					.locator('.row[aria-selected="true"]')
					.filter({ hasText: entry === "switch" ? "C-2" : "C-1" })
					.waitFor({ state: "attached" });
				await page.keyboard.press("e");
				const screenshots = process.env.MAINWORTHY_LOADING_SCREENSHOT_DIR;
				if (screenshots) await page.screenshot({ path: join(screenshots, `${entry}-loading.png`) });
				expect({
					pane: await page.locator("#detail").textContent(),
					loading: await page.locator('#detail [role="status"]').allTextContents(),
					feedback: await page.locator("#stat").textContent(),
					editors: await page.getByRole("textbox", { name: "Case title", exact: true }).count(),
				}).toEqual({
					pane: "Reading case…",
					loading: ["Reading case…"],
					feedback: "The case is not loaded yet. Press e when it appears.",
					editors: 0,
				});
				release();
				await page.locator("#detail .read-body .ctitle").waitFor();
				await eventually(
					() => page.locator("#stat").textContent(),
					(text) => text !== "The case is not loaded yet. Press e when it appears.",
				);
				expect(await page.locator('#detail [role="status"]').count()).toBe(0);
				expect(await page.getByRole("textbox", { name: "Case title", exact: true }).count()).toBe(0);
				await page.keyboard.press("e");
				const title = page.getByRole("textbox", { name: "Case title", exact: true });
				await title.waitFor();
				expect(await title.inputValue()).toBe("Waiting case");
			} finally {
				release();
				await h.close();
				await server.stop();
			}
		},
		30_000,
	);

for (const result of ["failed", "missing"] as const)
	test.skipIf(!browserAvailable)(
		`a ${result} case read explains why editing cannot open`,
		async () => {
			const server = await startServer();
			let replies = 0;
			const h = await openPage(server, {
				path: "/p/scratch/suite/c/99",
				setup: async (page) => {
					await page.route("**/api/p/scratch/get", async (route) => {
						if (result === "failed")
							await route.fulfill({
								status: 500,
								json: { ok: false, error: { code: "internal", message: "Case read failed" } },
							});
						else await route.continue();
						replies++;
					});
				},
			});
			try {
				const { page } = h;
				await eventually(
					async () => replies,
					(count) => count >= (result === "failed" ? 2 : 1),
				);
				await page.waitForFunction(() => !document.querySelector("#detail")?.textContent?.includes("Reading case…"));
				await page.keyboard.press("e");
				const message = result === "failed" ? "Could not read this case. Reload to try again." : "Case not found.";
				expect(await page.locator("#stat").textContent()).toBe(message);
				expect(await page.locator("#detail").textContent()).toBe(message);
				expect(await page.getByRole("textbox", { name: "Case title", exact: true }).count()).toBe(0);
				if (result === "failed") {
					await page.unroute("**/api/p/scratch/get");
					await page.reload();
					await page.locator("#detail").filter({ hasText: "Case not found." }).waitFor();
				}
			} finally {
				await h.close();
				await server.stop();
			}
		},
		30_000,
	);
