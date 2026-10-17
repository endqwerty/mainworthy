import { expect, test } from "bun:test";
import { ciReport } from "../helpers.ts";
import { browserAvailable, openPage, startServer } from "./support.ts";

// Issue #56: the reports read the stream of results, and each has its own page beside the list.
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
			page.setDefaultTimeout(8000);
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
