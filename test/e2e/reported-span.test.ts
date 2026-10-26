import { expect, test } from "bun:test";
import type { ResultIn } from "../../src/core/ops.ts";
import { browserAvailable, openPage, startServer } from "./support.ts";

// A change run shows its reported test span beside its test time once every shard has reported (issue #722).
(browserAvailable ? test : test.skip)(
	"a change run shows its reported test span once every report it counts named one",
	async () => {
		const server = await startServer({ preset: "loose" });
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			const target = { repo: "acme/shop", commit: "5ba9e2e000000000000000000000000000000001", branch: "main" };
			const result = (name: string, durationMs: number): ResultIn => ({
				test: { key: `tests/checkout.spec.ts::${name}`, name },
				outcome: "pass",
				durationMs,
			});
			const startedAt = 1_790_000_000_000;
			const first = await server.api("report", {
				target,
				job: "e2e",
				shard: { index: 1, of: 2 },
				span: { startedAt, endedAt: startedAt + 70_000 },
				results: [result("pays by card", 40_000), result("pays by invoice", 25_000)],
			});
			view = await openPage(server, { path: `/p/scratch/runs/${first.gate?.run?.slice(2)}` });
			const page = view.page;
			// One shard of two has reported: the test time shows, the span does not.
			await page.getByText("of test time", { exact: false }).first().waitFor();
			expect(await page.getByText("Reported test span", { exact: false }).count()).toBe(0);
			await server.api("report", {
				target,
				job: "e2e",
				shard: { index: 2, of: 2 },
				span: { startedAt: startedAt + 5_000, endedAt: startedAt + 130_000 },
				results: [result("ships abroad", 60_000)],
			});
			await page.reload();
			await page
				.getByText("Reported test span: 2 min, from the earliest start to the latest end its reports named.", {
					exact: true,
				})
				.waitFor();
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	60_000,
);
