import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import axe from "axe-core";
import { browserAvailable, openPage, startServer } from "./support.ts";

test.skipIf(!browserAvailable)(
	"result trails show actions, relative timing and step screenshots on every web result view",
	async () => {
		const server = await startServer({ source: true, cases: 12, days: 0 });
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			const runs = await server.api("find", { in: "runs" });
			const run = runs.items.find((row) => row.name === "Agent checkout check");
			if (!run || typeof run.ref !== "string") throw new Error("demo agent run missing");
			view = await openPage(server, { path: `/p/${server.project}/runs/${run.ref.slice(2)}` });
			const { page } = view;
			const screens = [
				["run", `/p/${server.project}/runs/${run.ref.slice(2)}`],
				["test", `/p/${server.project}/tests/2`],
				["change", `/p/${server.project}/changes/pr%3A482`],
			] as const;
			const capture = process.env.MAINWORTHY_TRAIL_CAPTURE;
			if (capture) await mkdir(capture, { recursive: true });
			for (const [screen, path] of screens) {
				await page.goto(server.url + path);
				const trail = page.getByRole("list", { name: "Step trail", exact: true }).first();
				await trail.waitFor();
				expect(await trail.textContent()).toContain("pass");
				expect(await trail.textContent()).toContain("700 ms");
				expect(await trail.getByRole("list", { name: "Actions for step b2", exact: true }).textContent()).toContain(
					"700 ms",
				);
				const backgrounds = await trail
					.locator(":scope > li")
					.evaluateAll((rows) => rows.map((row) => getComputedStyle(row).backgroundColor));
				expect(new Set(backgrounds).size).toBe(3);
				if (capture) await page.screenshot({ path: `${capture}/web-after-${screen}.png`, fullPage: true });
				await page.evaluate(axe.source);
				for (const theme of ["light", "dark"]) {
					await page.evaluate((value) => {
						document.documentElement.dataset.theme = value;
					}, theme);
					const violations = await page.evaluate(
						async () =>
							(
								await window.axe.run(".result-trail", {
									runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] },
								})
							).violations,
					);
					expect(
						violations.map(
							(rule) => `${screen}/${theme}: ${rule.id}: ${rule.nodes.map((node) => node.failureSummary).join("; ")}`,
						),
					).toEqual([]);
				}
				await page.evaluate(() => {
					document.documentElement.dataset.theme = "light";
				});
				if (screen === "change") {
					await page.getByText("Screenshot for step c3", { exact: true }).first().click();
					const screenshot = page
						.locator(".trail-screenshot[open]")
						.getByRole("img", { name: "cart.png", exact: true });
					await screenshot.waitFor({ state: "visible" });
					expect(await screenshot.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(
						true,
					);
					if (capture) await page.screenshot({ path: `${capture}/web-after-screenshot.png`, fullPage: true });
				}
			}
			expect(view.errors).toEqual([]);
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	60_000,
);
