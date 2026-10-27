import { expect, test } from "bun:test";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import { budget } from "../scripts/budget.ts";
import { drainRetiredDemos } from "../src/cli/demo.ts";
import { seed } from "../src/cli/seed.ts";
import { withInstance } from "../src/cli/test-support.ts";
import { lockNamedProject, retireDemo, retiredDemos } from "../src/server/kernel/ctx.ts";
import { removeProject } from "../src/server/transfer/transfer.ts";
import { removalFixture } from "./demo-removal-fixture.ts";
import { writerDatabase } from "./pg-scopes.ts";

test("deferred demo removal does not scan another project's excuses for every result", async () => {
	await using db = await writerDatabase();
	await removalFixture(db, 5_000);
	const start = performance.now();
	const removed = await db.transaction(() =>
		db.checkedBulk(() => removeProject(db, "removing", undefined, "deferred")),
	);
	const ms = performance.now() - start;
	console.log(`removeProject: ${ms.toFixed(1)} ms, ${removed.tables.results} results removed`);
	expect(removed.tables.results).toBe(5_000);
	expect(await db.allDynamic("SELECT count(*) AS n FROM result_excuses")).toEqual([{ n: 5_000 }]);
	budget("deferred removal of 5000 results: transaction and commit elapsed", ms, 250, "ms");
});

// On the instance one cleanup slice held the server for hours (#914). The drain runs at startup beside the
// instance's other projects, so it must finish while health checks and another project's reads keep answering.
test("draining a retired demo beside a larger project keeps health checks and reads answering", async () => {
	const measured = await withInstance(async ({ instance, client }) => {
		await seed(client, { project: "kept", cases: 200, days: 7 });
		await seed(client, { project: "demo", cases: 60, days: 2 });
		await instance.app.database.write((db) =>
			db.transaction(async () => {
				const demo = await lockNamedProject(db, "demo");
				if (!demo) throw new Error("the seeded demo is missing");
				await retireDemo(db, demo);
			}),
		);
		const kept = client.with({ project: "kept" });
		const before = await kept.call("find", { limit: 50 });
		const worker = new Worker(new URL("./archive-poll.ts", import.meta.url), { workerData: { url: instance.url } });
		try {
			await new Promise<void>((resolve, reject) => {
				worker.once("message", () => resolve());
				worker.once("error", reject);
			});
			const polled = new Promise<unknown>((resolve, reject) => {
				worker.once("message", resolve);
				worker.once("error", reject);
			});
			let draining = true;
			let longestRead = 0;
			let reads = 0;
			const reading = (async () => {
				while (draining) {
					const began = performance.now();
					expect(await kept.call("find", { limit: 50 })).toEqual(before);
					longestRead = Math.max(longestRead, performance.now() - began);
					reads++;
				}
			})();
			const slices: number[] = [];
			try {
				await drainRetiredDemos(instance, { onSlice: (slice) => void slices.push(slice.ms) });
			} finally {
				draining = false;
				await reading;
				worker.postMessage("stop");
			}
			const health = z.object({ longest: z.number(), samples: z.number(), errors: z.number() }).parse(await polled);
			expect(await instance.app.database.read(retiredDemos)).toEqual([]);
			expect(health.errors).toBe(0);
			expect(health.samples).toBeGreaterThan(1);
			expect(reads).toBeGreaterThan(1);
			expect(slices.length).toBeGreaterThan(50);
			return { slices, longestHealth: health.longest, longestRead };
		} finally {
			await worker.terminate();
		}
	});
	const longestSlice = Math.max(...measured.slices);
	console.log(
		`retired demo drain: ${measured.slices.length} slices, longest ${longestSlice.toFixed(1)} ms; longest /health wait ${measured.longestHealth.toFixed(1)} ms; longest read of another project ${measured.longestRead.toFixed(1)} ms`,
	);
	budget("retired demo drain beside a larger project: longest slice", longestSlice, 100, "ms");
	budget("retired demo drain beside a larger project: longest /health wait", measured.longestHealth, 250, "ms");
	budget(
		"retired demo drain beside a larger project: longest read of another project",
		measured.longestRead,
		500,
		"ms",
	);
}, 180_000);
