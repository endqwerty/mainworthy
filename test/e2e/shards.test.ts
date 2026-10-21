// A commit whose job reports in shards draws the shards it waits for: a cell a shard, the missing ones hollow, and
// the words spelled out on hover, or under the strip on a phone, which cannot hover.
import { expect, test } from "bun:test";
import { ciReport } from "../helpers.ts";
import { browserAvailable, openPage, startServer } from "./support.ts";

const said = "Job tests: 3 of 6 shards reported (1, 2 and 3). Waiting for shards 4, 5 and 6.";

(browserAvailable ? test : test.skip)(
	"a gate waiting for shards draws them on the change, its runs and a phone",
	async () => {
		const server = await startServer({ preset: "loose" });
		const views: Awaited<ReturnType<typeof openPage>>[] = [];
		try {
			const commit = "5ba4d0000000000000000000000000000000000a";
			for (const index of [1, 2, 3]) {
				await server.api(
					"report",
					ciReport({ commit, branch: "coupon", pr: 12, n: 6, job: "tests", shard: { index, of: 6 }, only: [index] }),
				);
			}
			const desktop = await openPage(server, { path: "/p/scratch/changes/pr%3A12" });
			views.push(desktop);
			const gate = desktop.page.locator(".change-gate");
			await gate.getByText("pending: waiting for 3 shards", { exact: true }).waitFor();
			const strip = gate.getByRole("img", { name: said });
			expect(await strip.getAttribute("title")).toBe(said);
			expect(await strip.locator(".shard-reported").allTextContents()).toEqual(["1", "2", "3"]);
			expect(await strip.locator(".shard-missing").allTextContents()).toEqual(["4", "5", "6"]);
			expect(await strip.locator(".shard-said").isVisible()).toBe(false);
			// The reason no longer lists the shards: the strip does.
			expect(await gate.textContent()).not.toContain("4, 5 and 6 of 6");

			// The change's row in the list, and its run in the list of runs, draw the cells alone.
			const row = desktop.page.getByRole("listbox", { name: "Changes" }).getByRole("img", { name: said });
			expect(await row.locator(".shard-missing").count()).toBe(3);
			expect(await row.locator(".shard-job").count()).toBe(0);
			await desktop.page.getByRole("list", { name: "Runs of this change" }).getByRole("img", { name: said }).waitFor();
			await desktop.page.getByRole("list", { name: "Runs of this change" }).getByRole("link").first().click();
			await desktop.page.waitForURL(/\/runs\//);
			await desktop.page.getByRole("listbox", { name: "Runs" }).getByRole("img", { name: said }).waitFor();
			await desktop.page.locator("#detail .run-verdict").getByRole("img", { name: said }).waitFor();

			const phone = await openPage(server, { path: "/p/scratch/changes/pr%3A12", device: "phone" });
			views.push(phone);
			const written = phone.page.locator(".change-gate .shard-said");
			await written.waitFor();
			expect(await written.textContent()).toBe(said);
			expect(await written.isVisible()).toBe(true);
		} finally {
			for (const view of views) await view.close();
			await server.stop();
		}
	},
	60_000,
);
