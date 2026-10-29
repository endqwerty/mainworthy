import { expect, test } from "bun:test";
import { join } from "node:path";
import { call } from "../../src/web/lib/api.ts";
import type { Server } from "./support.ts";
import { browserAvailable, eventually, openPage, startServer } from "./support.ts";

test.skipIf(!browserAvailable)(
	"a selected case explains loading and early editing after every entry path",
	async () => {
		const host = await startServer();
		try {
			for (const [index, entry] of (["reload", "navigation", "switch"] as const).entries()) {
				const project = `variant-${index}`;
				await host.api("admin", { do: "project.create", key: project, preset: "loose" });
				const server: Server = {
					...host,
					project,
					api: (op, input, options) => call(op, input, { url: host.url, project, token: options?.token ?? host.token }),
				};
				const variantExpect = <T>(value: T) => expect(value, String(entry));
				const device = entry === "navigation" ? "phone" : "desktop";
				if (entry === "switch")
					await server.api("propose", { edits: [{ op: "create", body: { title: "First case" } }] });
				await server.api("propose", { edits: [{ op: "create", outline: "Waiting case\n  Read its steps" }] });
				const h = await openPage(server, { path: `/p/${server.project}/suite/c/1`, device });
				let release = () => {};
				const held = new Promise<void>((resolve) => {
					release = resolve;
				});
				try {
					const { page } = h;
					await page.locator("#detail .read-body .ctitle").waitFor();
					let requested = false;
					await page.route(`**/api/p/${server.project}/get`, async (route) => {
						requested = true;
						await held;
						await route.continue();
					});
					if (entry === "switch") await page.keyboard.press("j");
					else if (entry === "reload") await page.reload();
					else {
						await page.goto(`${server.url}/p/${server.project}/queue`);
						await page.goto(`${server.url}/p/${server.project}/suite/c/1`);
					}
					await eventually(async () => requested, Boolean);
					await page
						.locator('.row[aria-selected="true"]')
						.filter({ hasText: entry === "switch" ? "C-2" : "C-1" })
						.waitFor({ state: "attached" });
					await page.keyboard.press("e");
					const screenshots = process.env.MAINWORTHY_LOADING_SCREENSHOT_DIR;
					if (screenshots) await page.screenshot({ path: join(screenshots, `${entry}-loading.png`) });
					variantExpect({
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
					variantExpect(await page.locator('#detail [role="status"]').count()).toBe(0);
					variantExpect(await page.getByRole("textbox", { name: "Case title", exact: true }).count()).toBe(0);
					await page.keyboard.press("e");
					const title = page.getByRole("textbox", { name: "Case title", exact: true });
					await title.waitFor();
					variantExpect(await title.inputValue()).toBe("Waiting case");
				} finally {
					release();
					await h.close();
				}
			}
		} finally {
			await host.stop();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"failed and missing case reads explain why editing cannot open",
	async () => {
		const host = await startServer();
		try {
			for (const [index, result] of (["failed", "missing"] as const).entries()) {
				const project = `variant-${index}`;
				await host.api("admin", { do: "project.create", key: project, preset: "loose" });
				const server: Server = {
					...host,
					project,
					api: (op, input, options) => call(op, input, { url: host.url, project, token: options?.token ?? host.token }),
				};
				const variantExpect = <T>(value: T) => expect(value, String(result));
				let replies = 0;
				const h = await openPage(server, {
					path: `/p/${server.project}/suite/c/99`,
					setup: async (page) => {
						await page.route(`**/api/p/${server.project}/get`, async (route) => {
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
					const message = result === "failed" ? "Could not read this case. Reload to try again." : "Case not found.";
					// Before the read starts, "Reading case…" is not shown yet either: wait for the answer itself (#890).
					await page.locator("#detail").filter({ hasText: message }).waitFor();
					await page.keyboard.press("e");
					variantExpect(
						await eventually(
							() => page.locator("#stat").textContent(),
							(text) => text === message,
						),
					).toBe(message);
					variantExpect(await page.locator("#detail").textContent()).toBe(message);
					variantExpect(await page.getByRole("textbox", { name: "Case title", exact: true }).count()).toBe(0);
					if (result === "failed") {
						await page.unroute(`**/api/p/${server.project}/get`);
						await page.reload();
						await page.locator("#detail").filter({ hasText: "Case not found." }).waitFor();
					}
				} finally {
					await h.close();
				}
			}
		} finally {
			await host.stop();
		}
	},
	30_000,
);
