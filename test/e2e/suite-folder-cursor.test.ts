import { expect, test } from "bun:test";
import { z } from "zod";
import { browserAvailable, eventually, openPage, startServer } from "./support.ts";

for (const next of [true, false]) {
	test.skipIf(!browserAvailable)(
		`${next ? "next" : "previous"} folder selects its first case after the list arrives`,
		async () => {
			const server = await startServer();
			await server.api("propose", {
				edits: [
					{ op: "create", outline: "Alpha first", folder: "Alpha" },
					{ op: "create", outline: "Alpha last", folder: "Alpha" },
					{ op: "create", outline: "Beta first", folder: "Beta" },
					{ op: "create", outline: "Beta last", folder: "Beta" },
					{ op: "folder", name: "Empty" },
				],
			});
			const from = next ? "Alpha" : "Beta";
			const to = next ? "Beta" : "Alpha";
			const h = await openPage(server, { path: `/p/scratch/suite/c/${next ? 2 : 4}?folder=${from}` });
			let release = () => {};
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			try {
				const { page } = h;
				await page.getByRole("button", { name: `${from} last`, exact: true }).waitFor();
				await page.keyboard.press("x");
				let requested = false;
				await page.context().route("**/api/p/scratch/find", async (route) => {
					const input = z
						.object({ in: z.string(), folder: z.string().optional() })
						.parse(route.request().postDataJSON());
					if (input.in === "cases" && input.folder === to) {
						requested = true;
						await held;
					}
					await route.continue();
				});
				await page.keyboard.press(next ? "]" : "Alt+[");
				await eventually(async () => requested, Boolean);
				release();
				await page
					.getByRole("option")
					.filter({ hasText: `${to} first` })
					.waitFor();
				if (next && process.env.MAINWORTHY_CURSOR_SCREENSHOT)
					await page.screenshot({ path: process.env.MAINWORTHY_CURSOR_SCREENSHOT });
				expect(
					await eventually(
						() => page.locator('.row[aria-selected="true"] .id').allTextContents(),
						(refs) => refs.join() === (next ? "C-3" : "C-1"),
					),
				).toEqual([next ? "C-3" : "C-1"]);
				await page.keyboard.press("x");
				expect(await page.locator(".bulk-indicator").textContent()).toBe("2 selected");
				if (next) {
					await page.keyboard.press("]");
					await page.locator("#ltitle").filter({ hasText: "Empty" }).waitFor();
					await page.locator("#lcount").filter({ hasText: "0 cases" }).waitFor();
					await page.keyboard.press("x");
					expect(await page.locator(".bulk-indicator").textContent()).toBe("2 selected");
					await page.keyboard.press("Alt+[");
					await page.getByRole("option").filter({ hasText: "Beta first" }).waitFor();
					expect(
						await eventually(
							() => page.locator('.row[aria-selected="true"] .id').allTextContents(),
							(refs) => refs.join() === "C-3",
						),
					).toEqual(["C-3"]);
				}
				expect(h.errors).toEqual([]);
			} finally {
				release();
				await h.close();
				await server.stop();
			}
		},
		30_000,
	);
}

for (const next of [true, false]) {
	test.skipIf(!browserAvailable)(
		`${next ? "next" : "previous"} folder shortcuts keep archived, tag and text filters`,
		async () => {
			const server = await startServer();
			await server.api("propose", {
				edits: [
					{ op: "create", outline: "Match Alpha", folder: "Alpha", tags: ["keep", "smoke"] },
					{ op: "create", outline: "Match Beta", folder: "Beta", tags: ["keep", "smoke"] },
					{ op: "create", outline: "Match wrong tag", folder: "Beta", tags: ["keep"] },
					{ op: "create", outline: "Other title", folder: "Beta", tags: ["keep", "smoke"] },
					{ op: "create", outline: "Match active", folder: "Beta", tags: ["keep", "smoke"] },
				],
			});
			await server.api("propose", { edits: [{ op: "state", cases: ["C-1", "C-2", "C-3", "C-4"], to: "archived" }] });
			const from = next ? "Alpha" : "Beta";
			const to = next ? "Beta" : "Alpha";
			const h = await openPage(server, {
				path: `/p/scratch/suite/c/${next ? 1 : 2}?folder=${from}&state=archived&tag=keep&tag=smoke&text=Match`,
			});
			try {
				const { page } = h;
				await page.getByRole("button", { name: `Match ${from}`, exact: true }).waitFor();
				await page.keyboard.press(next ? "]" : "Alt+[");
				await page.waitForURL((url) => url.searchParams.get("folder") === to);
				const params = new URL(page.url()).searchParams;
				expect(params.get("state")).toBe("archived");
				expect(params.getAll("tag")).toEqual(["keep", "smoke"]);
				expect(params.get("text")).toBe("Match");
				await page.locator("#ltitle").filter({ hasText: "Archived" }).waitFor();
				expect(
					await eventually(
						() => page.locator("#list .row .id").allTextContents(),
						(refs) => refs.join() === (next ? "C-2" : "C-1"),
					),
				).toEqual([next ? "C-2" : "C-1"]);
				await page.getByRole("button", { name: `Match ${to}`, exact: true }).waitFor();
				expect(h.errors).toEqual([]);
			} finally {
				await h.close();
				await server.stop();
			}
		},
		20_000,
	);
}
