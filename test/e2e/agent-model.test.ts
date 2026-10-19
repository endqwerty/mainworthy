import { expect, test } from "bun:test";
import { browserAvailable, openPage, startServer } from "./support.ts";

(browserAvailable ? test : test.skip)(
	"the demo shows the reported model beside agent results",
	async () => {
		const server = await startServer({ source: true, cases: 12, days: 0 });
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			const runs = await server.api("find", { in: "runs" });
			const run = runs.items.find((row) => row.name === "Agent checkout check");
			if (!run || typeof run.ref !== "string") throw new Error("agent demo run missing");
			const tests = await server.api("find", { in: "tests" });
			// The seed also reports an automated test under the agent's token.
			const details = await server.api("get", {
				refs: tests.items.flatMap((row) => (typeof row.ref === "string" ? [row.ref] : [])),
			});
			const detail = details.find(
				(row) => "last" in row && Array.isArray(row.last) && row.last.some((result) => result.by === "reviewer"),
			);
			if (!detail || typeof detail.ref !== "string") throw new Error("agent demo test missing");
			view = await openPage(server, { path: `/p/${server.project}/runs/${run.ref.slice(2)}` });
			const { page } = view;
			await page.locator(".fill-by").getByText("reviewer", { exact: false }).first().waitFor();
			expect(await page.locator(".fill-by").allTextContents()).toContain("reviewer · claude-opus-5-5");
			await page.goto(`${server.url}/p/${server.project}/tests/${detail.ref.slice(2)}`);
			const latest = page.getByRole("list", { name: "Latest results" });
			await latest.getByText("reviewer", { exact: false }).waitFor();
			expect(await latest.textContent()).toContain("reviewer · claude-opus-5-5");
			await page.goto(`${server.url}/p/${server.project}/suite/c/2`);
			await page.getByText("Timeline", { exact: true }).waitFor();
			await page.getByText("reviewer", { exact: false }).first().waitFor();
			expect(await page.locator("#detail").textContent()).toContain("reviewer · claude-opus-5-5");
			await page.goto(`${server.url}/p/${server.project}/changes/pr%3A482`);
			await page.getByRole("list", { name: "Results the gate counted" }).getByRole("listitem").first().waitFor();
			expect(await page.getByRole("list", { name: "Results the gate counted" }).textContent()).toContain("pipeline");
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	60_000,
);
