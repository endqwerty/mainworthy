import { expect, test } from "bun:test";
import { ciReport } from "../helpers.ts";
import { browserAvailable, openPage, startServer } from "./support.ts";

// Issue #343: the results behind a change's gate are on its page, and each test has a page of its own.
(browserAvailable ? test : test.skip)(
	"a change lists what each test did, and a test opens its own results",
	async () => {
		const server = await startServer({ preset: "loose" });
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			const commit = "abc1230000000000000000000000000000000001";
			await server.api("report", {
				...ciReport({ commit, branch: "coupon", pr: 12, n: 3, fail: { 0: "expected $90, got $100" } }),
				buildUrl: "javascript:alert(1)",
			});
			view = await openPage(server, { path: "/p/scratch/changes/pr%3A12" });
			const page = view.page;
			page.setDefaultTimeout(8000);
			const list = page.getByRole("list", { name: "Results the gate counted" });
			await list.getByRole("listitem").first().waitFor();
			expect(await list.getByRole("listitem").count()).toBe(3);
			// Problems first, with what the test said.
			await expect(list.getByRole("listitem").first().textContent()).resolves.toContain("expected $90, got $100");
			await expect(list.getByRole("listitem").first().textContent()).resolves.toContain("unexplained");
			// A build address that is not a web address is not offered as a link.
			expect(await list.getByRole("link", { name: "build" }).count()).toBe(0);

			// The tally above chooses what the list shows.
			await page.locator(".change-tally").getByRole("button", { name: "2 passed" }).click();
			await page.getByRole("button", { name: "2 passed", pressed: true }).waitFor();
			await page.waitForFunction(() => document.querySelectorAll(".change-result").length === 2);
			await page.getByLabel("Filter results by test name or file").fill("test 2");
			await page.waitForFunction(() => document.querySelectorAll(".change-result").length === 1);

			await list.getByRole("link", { name: "test 2" }).click();
			await page.waitForURL(/\/p\/scratch\/tests\/\d+$/);
			await page.locator("#detail .test-title").getByText("test 2", { exact: true }).waitFor();
			const latest = page.getByRole("list", { name: "Latest results" });
			await latest.getByText(commit.slice(0, 12)).waitFor();
			await latest.getByRole("link", { name: "pr:12" }).waitFor();
			await page.getByText("None: the test is tracked without a case.").waitFor();

			// The Tests screen lists every test, and narrows to those with no case.
			const tests = page.getByRole("listbox", { name: "Tests" });
			expect(await tests.getByRole("option").count()).toBe(3);
			await page.getByLabel("Filter tests by name or file").fill("test 0");
			await page.waitForFunction(() => document.querySelectorAll("#list .row").length === 1);
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	60_000,
);
