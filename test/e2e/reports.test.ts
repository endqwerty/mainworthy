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
			await page.getByLabel("Whose results").selectOption("auto");
			await page.getByLabel("Days to read").selectOption("7");
			expect(await page.getByLabel("Whose results").inputValue()).toBe("auto");
			await page.getByLabel("Days to read").selectOption("30");

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

(browserAvailable ? test : test.skip)(
	"every limited report says how many rows it shows and reaches the rest",
	async () => {
		const server = await startServer({ preset: "loose", unlinked: "track" });
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			const fail = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [i, "intermittent failure"]));
			await server.api("report", ciReport({ commit: "aaaa0001", n: 25, fail }));
			await server.api("report", ciReport({ commit: "aaaa0001", n: 25, attempt: 2 }));
			await server.api("propose", {
				edits: Array.from({ length: 25 }, (_, i) => ({ op: "create", outline: `Manual ${i}\n  Try > Done` })),
			});
			view = await openPage(server, { path: "/p/scratch/reports/flaky" });
			const page = view.page;
			const detail = page.locator("#detail");
			await detail.getByText("of 25 automated tests passed and failed on the same code", { exact: true }).waitFor();
			if (process.env.MAINWORTHY_REPORT_SCREENSHOT)
				await page.screenshot({ path: process.env.MAINWORTHY_REPORT_SCREENSHOT });
			await detail.getByText("Showing 20 of 25", { exact: true }).waitFor();
			expect(await detail.locator("tbody tr").count()).toBe(20);
			await page.route("**/api/p/scratch/stats", async (route) => {
				const input = route.request().postDataJSON();
				if (input.of === "flaky" && input.cursor === 20)
					await route.fulfill({
						status: 503,
						json: { ok: false, error: { code: "internal", message: "Report page unavailable" } },
					});
				else await route.continue();
			});
			await detail.getByRole("button", { name: "Next page", exact: true }).click();
			await detail.getByText("Report page unavailable", { exact: true }).waitFor();
			if (process.env.MAINWORTHY_REPORT_ERROR_SCREENSHOT)
				await page.screenshot({ path: process.env.MAINWORTHY_REPORT_ERROR_SCREENSHOT });
			await detail.getByRole("button", { name: "Previous page", exact: true }).click();
			await detail.getByText("Showing 20 of 25", { exact: true }).waitFor();
			await page.unroute("**/api/p/scratch/stats");

			await detail.getByRole("button", { name: "Next page", exact: true }).click();
			await detail.getByRole("link", { name: "T-25", exact: true }).waitFor();
			await detail.getByText("Showing 5 of 25", { exact: true }).waitFor();
			expect(await detail.locator("tbody tr").count()).toBe(5);
			await page.keyboard.press("p");
			await detail.getByText("Showing 20 of 25", { exact: true }).waitFor();
			await page.keyboard.press("n");
			await detail.getByText("Showing 5 of 25", { exact: true }).waitFor();
			await page.getByLabel("Days to read").selectOption("7");
			await detail.getByText("Showing 20 of 25", { exact: true }).waitFor();
			await page.getByRole("option", { name: /Time lost to reruns/ }).click();
			await detail.getByText("Showing 20 of 25", { exact: true }).waitFor();
			await detail.getByRole("button", { name: "Next page", exact: true }).click();
			await detail.getByRole("link", { name: "T-1", exact: true }).waitFor();
			await detail.getByText("Showing 5 of 25", { exact: true }).waitFor();
			await page.getByRole("option", { name: /^Automation/ }).click();
			await detail.getByText("Showing 20 of 25", { exact: true }).waitFor();
			await detail.getByRole("button", { name: "Next page", exact: true }).click();
			await detail.getByRole("link", { name: "C-25", exact: true }).waitFor();
			await detail.getByText("Showing 5 of 25", { exact: true }).waitFor();
			await server.api("propose", {
				edits: [{ op: "state", cases: ["C-21", "C-22", "C-23", "C-24", "C-25"], to: "archived" }],
			});
			await detail.getByText("Showing 20 of 20", { exact: true }).waitFor();
			expect(await detail.locator("tbody tr").count()).toBe(20);

			await server.api("propose", {
				edits: Array.from({ length: 101 }, (_, i) => ({
					op: "create",
					outline: `Requirement ${i} @REQ-${String(i).padStart(3, "0")}\n  Try > Done`,
				})),
			});
			await page.getByRole("option", { name: /Coverage by requirement/ }).click();
			await detail.getByText("Showing 100 of 101", { exact: true }).waitFor();
			await detail.getByRole("button", { name: "Next page", exact: true }).click();
			await detail.getByText("REQ-100", { exact: true }).waitFor();
			await detail.getByText("Showing 1 of 101", { exact: true }).waitFor();
			expect(await detail.locator("tbody tr").count()).toBe(1);
			await view.close();
			view = await openPage(server, { device: "phone", path: "/p/scratch/reports/flaky" });
			const phone = view.page;
			const phoneDetail = phone.locator("#detail");
			await phoneDetail.getByText("Showing 20 of 25", { exact: true }).waitFor();
			expect(await phoneDetail.getByRole("button", { name: "Next page", exact: true }).isVisible()).toBe(false);
			await phone.getByRole("button", { name: "Actions", exact: true }).tap();
			await phone
				.locator("[data-overlay=palette]")
				.getByRole("option", { name: /Next report page/ })
				.tap();
			await phoneDetail.getByRole("link", { name: "T-25", exact: true }).waitFor();
			await phoneDetail.getByText("Showing 5 of 25", { exact: true }).waitFor();
			await phone.getByRole("button", { name: "Actions", exact: true }).tap();
			await phone
				.locator("[data-overlay=palette]")
				.getByRole("option", { name: /Previous report page/ })
				.tap();
			await phoneDetail.getByText("Showing 20 of 25", { exact: true }).waitFor();
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	60_000,
);

// The browser owns the partial/unknown labels and automation marker; numbers are covered in stats.test.ts.
(browserAvailable ? test : test.skip)(
	"manual effort shows timing completeness and automation in the selected period",
	async () => {
		const server = await startServer({ preset: "loose", unlinked: "create" });
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			await server.api("report", ciReport({ commit: "aaaa0001", n: 1 }));
			await server.api("propose", { edits: [{ op: "create", outline: "Untimed task" }] });
			for (const durationMs of [60000, undefined])
				await server.api("report", {
					target: { session: "manual" },
					results: [{ test: { case: "C-1" }, outcome: "pass", ...(durationMs === undefined ? {} : { durationMs }) }],
				});
			await server.api("report", {
				target: { session: "manual" },
				results: [{ test: { case: "C-2" }, outcome: "pass" }],
			});
			view = await openPage(server, { path: "/p/scratch/reports/manual-effort" });
			const page = view.page;
			await page.locator("#detail tbody tr").first().waitFor();
			expect(await page.locator("#detail tbody tr").first().innerText()).toContain("has automation");
			expect(await page.locator("#detail tbody tr").first().locator("td").allTextContents()).toEqual([
				"2",
				"1",
				"1",
				"1 min (partial)",
				"1 min",
			]);
			expect(await page.locator("#detail tbody tr").last().locator("td").allTextContents()).toEqual([
				"1",
				"0",
				"1",
				"Unknown",
				"Unknown",
			]);
			await page.getByLabel("Days to read").selectOption("7");
			await page.locator("#detail .phead").getByText("last 7 days").waitFor();
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	60000,
);
