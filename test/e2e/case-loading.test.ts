import { expect, test } from "bun:test";
import { join } from "node:path";
import { browserAvailable, eventually, openPage, startServer } from "./support.ts";

for (const device of ["desktop", "phone"] as const)
	test.skipIf(!browserAvailable)(
		`a selected case explains loading and an early edit key after ${device === "desktop" ? "reload" : "navigation"} (${device})`,
		async () => {
			const server = await startServer();
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
				if (device === "desktop") await page.reload();
				else {
					await page.goto(`${server.url}/p/scratch/queue`);
					await page.goto(`${server.url}/p/scratch/suite/c/1`);
				}
				await eventually(async () => requested, Boolean);
				await page.locator('.row[aria-selected="true"]').waitFor({ state: "attached" });
				await page.keyboard.press("e");
				const screenshots = process.env.MAINWORTHY_LOADING_SCREENSHOT_DIR;
				if (screenshots) await page.screenshot({ path: join(screenshots, `${device}-loading.png`) });
				expect({
					pane: await page.locator("#detail").textContent(),
					loading: await page
						.locator('#detail [role="status"]')
						.textContent({ timeout: 1_000 })
						.catch(() => null),
					feedback: await page.locator("#stat").textContent(),
					editors: await page.getByRole("textbox", { name: "Case title", exact: true }).count(),
				}).toEqual({
					pane: "Reading case…",
					loading: "Reading case…",
					feedback: "The case is not loaded yet. Press e when it appears.",
					editors: 0,
				});
				release();
				await page.locator("#detail .read-body .ctitle").waitFor();
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
