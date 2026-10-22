import { expect, test } from "bun:test";
import { ciReport } from "../helpers.ts";
import { browserAvailable, openPage, startServer } from "./support.ts";

// Issue #56: the reports read the stream of results, and each has its own page beside the list.
(browserAvailable ? test : test.skip)(
	"runner retries appear in the reruns headline and table without a pipeline rerun",
	async () => {
		const server = await startServer({ preset: "loose", unlinked: "track" });
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			await server.api("report", {
				target: { commit: "aaaa0001", branch: "main" },
				job: "e2e",
				results: [
					{
						test: { key: "cart.spec.ts::adds", name: "Checkout adds an item", file: "cart.spec.ts" },
						outcome: "pass",
						durationMs: 3600,
						tries: [{ outcome: "fail", durationMs: 1100, failure: { message: "socket hang up" } }, { outcome: "skip" }],
					},
				],
			});
			view = await openPage(server, { path: "/p/scratch/reports/reruns" });
			const page = view.page;
			await page.getByRole("option", { name: /Time lost to reruns\s*1.1 s in 2 reruns$/ }).waitFor();
			expect(await page.locator("#detail .report-hero").innerText()).toBe("1.1 s in 2 reruns; 1 has unreported time");
			const row = page.locator("#detail tbody tr");
			expect(await row.locator("th").innerText()).toBe("T-1 Checkout adds an item");
			expect(await row.locator("td").allTextContents()).toEqual(["2", "1.1 s"]);
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	60_000,
);

(browserAvailable ? test : test.skip)(
	"the reports list their headlines, and each opens with its numbers",
	async () => {
		const server = await startServer({ preset: "loose", unlinked: "track" });
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			const commit = "abc1230000000000000000000000000000000001";
			await server.api("report", ciReport({ commit, n: 4, fail: { 1: "socket hang up" } }));
			await server.api("report", ciReport({ commit, n: 4, attempt: 2, only: [1] }));
			view = await openPage(server, { path: "/p/scratch/suite" });
			const page = view.page;
			await page.keyboard.type("go");
			await page.waitForURL("**/p/scratch/reports");
			const list = page.getByRole("listbox", { name: "Reports" });
			// The failure was run again and passed: every test ended passing, one of them flipped, and 11 ms was lost.
			await list.getByRole("option", { name: /Pass rate\s*100% of 4 passed/ }).waitFor();
			await list.getByRole("option", { name: /Flaky tests\s*1 of 4 tests flipped/ }).waitFor();
			await list.getByRole("option", { name: /Time lost to reruns\s*11 ms in 1 rerun$/ }).waitFor();
			// A report that arrives while the screen is open is in it without a reload: a third attempt that passes
			// makes the second one a rerun too (the second verification of #461).
			await server.api("report", ciReport({ commit, n: 4, attempt: 3, only: [1] }));
			await list.getByRole("option", { name: /Time lost to reruns\s*\d+ ms in 2 reruns$/ }).waitFor();
			// Thirty days in the table, newest first; only today had results, so the chart has one point.
			expect(await page.locator("#detail tbody tr").count()).toBe(30);
			expect(await page.locator(".rate-dot").count()).toBe(1);

			await page.keyboard.press("j");
			await page.waitForURL("**/p/scratch/reports/flaky");
			const flaky = page.locator("#detail .report-table");
			await flaky.getByRole("link", { name: "T-2" }).waitFor();
			await page.getByLabel("Days to read").selectOption("7");
			await page.locator("#detail .phead").getByText("last 7 days").waitFor();

			await flaky.getByRole("link", { name: "T-2" }).click();
			await page.waitForURL(/\/p\/scratch\/tests\/2$/);
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	60_000,
);
