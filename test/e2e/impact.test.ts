import { expect, test } from "bun:test";
import { join } from "node:path";
import { browserAvailable, openPage, startServer } from "./support.ts";

(browserAvailable ? test : test.skip)(
	"Changes reaches all impact pages and keeps the merge receipt visible",
	async () => {
		const server = await startServer();
		let view: Awaited<ReturnType<typeof openPage>> | undefined;
		try {
			await server.api("propose", {
				edits: Array.from({ length: 450 }, (_, i) => ({
					op: "create",
					outline: `Impact case ${i + 1}\n  Check > Works`,
					covers: ["REQ-396"],
				})),
			});
			await server.api("report", {
				target: { commit: "webimpact396", pr: 396, title: "REQ-396: review affected cases" },
				results: [{ test: { key: "impact" }, outcome: "pass" }],
			});
			await server.api("change", { change: "pr:396", state: "merged" });
			view = await openPage(server, { path: "/p/scratch/changes/pr%3A396" });
			const cases = view.page.locator(".change-impact");
			await cases.nth(199).waitFor();
			await view.page.locator(".change-merge-receipt").waitFor();
			if (process.env.MAINWORTHY_IMPACT_SCREENSHOT) {
				await cases.last().scrollIntoViewIfNeeded();
				await view.page.screenshot({ path: join(process.env.MAINWORTHY_IMPACT_SCREENSHOT, "impact.png") });
			}
			expect(await cases.count()).toBe(200);
			const more = view.page.getByRole("button", { name: "More affected cases" });
			await more.click();
			await cases.nth(399).waitFor();
			expect(await cases.count()).toBe(400);
			await more.click();
			await cases.nth(449).waitFor();
			expect(await cases.count()).toBe(450);
			expect(await more.count()).toBe(0);
			expect(await cases.locator(".ref").allTextContents()).toEqual(
				Array.from({ length: 450 }, (_, i) => `C-${i + 1}`),
			);
			await server.api("propose", {
				edits: [{ op: "create", outline: "Another affected case\n  Check > Works", covers: ["REQ-396"] }],
			});
			await cases.nth(450).waitFor();
			expect(await cases.count()).toBe(451);
			expect(await view.page.locator(".change-merge-receipt").count()).toBe(1);
			expect(view.errors).toEqual([]);
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	30000,
);
