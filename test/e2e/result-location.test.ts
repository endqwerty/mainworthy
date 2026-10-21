import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import type { ResultIn } from "../../src/core/ops.ts";
import { browserAvailable, openPage, startServer } from "./support.ts";

(browserAvailable ? test : test.skip)(
	"trunk failure and test history link the pull request that landed the commit",
	async () => {
		const server = await startServer({ preset: "loose" });
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			const commit = "1234567890abcdef1234567890abcdef12345678";
			const results: ResultIn[] = [
				{
					test: { key: "landed-coupon", name: "Landed coupon" },
					outcome: "fail",
					durationMs: 1400,
					failure: { message: "Coupon lost after merge" },
				},
			];
			await server.api("report", {
				target: { repo: "acme/shop", commit: "feature0001", branch: "coupon", pr: 653, title: "Keep coupons" },
				results,
			});
			view = await openPage(server, { path: "/p/scratch/queue" });
			const page = view.page;
			const shot = async (name: string) => {
				const directory = process.env.MAINWORTHY_IDENTIFIER_SHOTS;
				if (directory) {
					await mkdir(directory, { recursive: true });
					await page.screenshot({ path: `${directory}/web-${name}.png` });
				}
			};
			await page.locator(".queue-log").first().waitFor();
			await shot("pr-failure");
			await server.api("change", { change: "pr:653", state: "merged", landing: { commit, branch: "main" } });
			const trunk = await server.api("report", { target: { repo: "acme/shop", commit, branch: "main" }, results });
			await page.reload();
			await page
				.getByText(/1234567890ab/)
				.first()
				.waitFor();
			await shot("trunk-failure");
			await page.goto(`${server.url}/p/scratch/tests/1`);
			await page.getByRole("list", { name: "Latest results" }).waitFor();
			await shot("test-history");
			await page.goto(`${server.url}/p/scratch/changes/pr%3A653`);
			await page.getByText("Keep coupons", { exact: true }).first().waitFor();
			await shot("change");
			await page.goto(`${server.url}/p/scratch/runs/${trunk.gate?.run?.slice(2)}`);
			await page.locator(".run-verdict").first().waitFor();
			// The run's header sums what its results reported: one result, 1.4 s.
			await page.getByText("1 unexplained failure · 1.4 s of test time", { exact: true }).waitFor();
			await shot("trunk-run");
			await page.goto(`${server.url}/p/scratch/tests/1`);
			const latest = page.getByRole("list", { name: "Latest results" });
			await latest.getByRole("link", { name: "main · pr:653 Keep coupons", exact: true }).click();
			await page.waitForURL(/changes\/pr%3A653/);
			await page.getByText("Keep coupons", { exact: true }).first().waitFor();
			await page.goto(`${server.url}/p/scratch/queue`);
			const link = page.getByRole("link", { name: "main · pr:653 Keep coupons", exact: true });
			await link.first().waitFor();
			expect(await link.first().getAttribute("href")).toContain("pr%3A653");
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	60_000,
);
