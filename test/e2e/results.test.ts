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

// A test that failed and then passed on a retry is flaky, and says so where it would otherwise read as broken: on
// the run of that commit, on the next commit it fails, and on the test's own page.
(browserAvailable ? test : test.skip)(
	"a test that flipped on a retry reads as flaky on the change, the runs and its own page",
	async () => {
		const server = await startServer({ preset: "loose" });
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			const first = "f1a1000000000000000000000000000000000001";
			const next = "f1a2000000000000000000000000000000000002";
			const report = (commit: string, fail: Record<number, string>, attempt = 1) =>
				server.api("report", ciReport({ commit, branch: "coupon", pr: 12, n: 2, fail, attempt }));
			await report(first, { 0: "fill: Timeout 10000ms exceeded." });
			await report(first, {}, 2);
			await report(next, { 0: "fill: Timeout 10000ms exceeded." });

			view = await openPage(server, { path: "/p/scratch/changes/pr%3A12" });
			const page = view.page;
			const note = page.getByRole("note");
			await note.getByText("1 failing test flipped between passing and failing in the last 14 days").waitFor();
			const failing = page.getByRole("list", { name: "Results the gate counted" }).getByRole("listitem").first();
			await expect(failing.textContent()).resolves.toContain("unexplained");
			await expect(failing.locator(".result-flaky").textContent()).resolves.toBe("flaky");
			await expect(failing.textContent()).resolves.toContain("flipped 1 time in the last 14 days");

			// The commit the retry passed: it passed, and the list of runs and the run say a test flaked on it.
			await page.goto(`${server.url}/p/scratch/runs`);
			const runs = page.getByRole("listbox", { name: "Runs" });
			const passed = runs.getByRole("option").filter({ hasText: first.slice(0, 12) });
			await expect(passed.textContent()).resolves.toContain("1 flaky");
			await passed.click();
			await page.getByRole("note").getByText("1 test both passed and failed on this commit, so it is flaky.").waitFor();
			const retried = page.getByRole("list", { name: "Results the gate counted" }).getByRole("listitem").filter({
				hasText: "passed and failed on this commit",
			});
			await expect(retried.locator(".result-flaky").textContent()).resolves.toBe("flaky");

			// The test's page names the failure the retry passed flaky, not failed.
			await retried.getByRole("link", { name: "test 0" }).click();
			const latest = page.getByRole("list", { name: "Latest results" });
			const flake = latest.getByRole("listitem").filter({ hasText: "passed on attempt 2" });
			await expect(flake.locator(".result-outcome").textContent()).resolves.toBe("flaky");
			await expect(flake.textContent()).resolves.toContain(first.slice(0, 12));
			// The failure on the next commit has no retry yet: it reads as what it is.
			const open = latest.getByRole("listitem").filter({ hasText: next.slice(0, 12) });
			await expect(open.locator(".result-outcome").textContent()).resolves.toBe("fail");
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	60_000,
);
