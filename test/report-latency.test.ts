import { expect, test } from "bun:test";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import { budget } from "../scripts/budget.ts";
import { withInstance } from "../src/cli/test-support.ts";
import { ciReport } from "./helpers.ts";

async function reportWhilePolling(files: number): Promise<number> {
	const cases = files === 1 ? 500 : 2000;
	return await withInstance(async ({ instance, client }) => {
		await client.call("admin", { do: "project.create", key: "creating", preset: "loose", unlinked: "create" });
		const producer = client.with({ project: "creating" });
		const worker = new Worker(new URL("./archive-poll.ts", import.meta.url), {
			workerData: { url: instance.url },
		});
		try {
			await new Promise<void>((resolve, reject) => {
				worker.once("message", () => resolve());
				worker.once("error", reject);
			});
			const polled = new Promise<unknown>((resolve, reject) => {
				worker.once("message", resolve);
				worker.once("error", reject);
			});
			const input = ciReport({ commit: "creating-cases", n: cases });
			input.results = input.results.map((result, index) => ({
				...result,
				test: { ...result.test, file: `tests/file-${index % files}.ts` },
			}));
			try {
				expect(await producer.call("report", input)).toMatchObject({ fresh: true, counts: { total: cases } });
			} finally {
				worker.postMessage("stop");
			}
			const samples = z.object({ longest: z.number(), samples: z.number(), errors: z.number() }).parse(await polled);
			expect(samples.errors).toBe(0);
			expect(samples.samples).toBeGreaterThan(1);
			expect(await producer.call("find", { limit: 1 })).toMatchObject({ count: cases });
			expect(await producer.call("find", { in: "tests", unlinked: true })).toMatchObject({ items: [] });
			return samples.longest;
		} finally {
			await worker.terminate();
		}
	});
}

for (const files of [1, 200]) {
	const label = files === 1 ? "one file" : `${files} files`;
	test(`HTTP reports creating cases across ${label} leave health requests answering`, async () => {
		const longest = await reportWhilePolling(files);
		console.log(`Report-created cases in ${label}: longest /healthz wait ${longest.toFixed(1)} ms`);
		budget(
			`report creating ${files === 1 ? 500 : 2000} cases across ${label}: longest /healthz wait`,
			longest,
			50,
			"ms",
		);
	}, 15_000);
}
