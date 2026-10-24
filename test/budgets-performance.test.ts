import { expect, test } from "bun:test";
import { BUDGETS } from "../bench/contracts.ts";
import { measure, table } from "../bench/measure.ts";
import { budget } from "../scripts/budget.ts";
import { withInstance } from "../src/cli/test-support.ts";
import { removeProject } from "../src/server/transfer/transfer.ts";
import { withDiskWorkloads, withLandingWorkload, withLinkProposal, withQuarantineWorkload } from "./budgets-fixture.ts";
import { removalFixture } from "./demo-removal-fixture.ts";

test("records the 1000 ms baseline for a large link proposal", async () => {
	let ms = 0;
	await withLinkProposal(async (apply) => {
		const start = performance.now();
		const reply = await apply();
		ms = performance.now() - start;
		return reply;
	});
	console.log(`2000-tag / 2000-edit proposal: ${ms.toFixed(1)} ms`);
	budget("2000-tag / 2000-edit proposal apply elapsed", ms, 1_000, "ms");
}, 30_000);

test("records the design baselines for on-disk hot paths", async () => {
	await withDiskWorkloads(async (workloads) => {
		const measured = [];
		for (const workload of workloads) {
			measured.push(await measure(workload));
		}
		console.log(
			`\nHot-path baseline measurements, milliseconds (2k cases / 500 tests / 20k results):\n${table(measured)}`,
		);
		for (const row of measured) {
			expect(row.errors, `${row.name}: ${row.errorMessages.join("; ")}`).toBe(0);
			expect(row.warmupErrors, `${row.name}: warmup must exercise real work`).toEqual([]);
			expect(row.checked, `${row.name}: every completed operation must pass its correctness check`).toBe(row.n);
			if (row.budget !== null) budget(`${row.name}: ${row.criterion}`, row[row.criterion], row.budget, "ms");
		}
	});
	// The limit bounds building the PostgreSQL dataset (9 s here, 16 to 20 s on a CI runner), not the paths it measures.
}, 60_000);

test("records the quarantined-report baseline after 3000 earlier trunk commits", async () => {
	await withQuarantineWorkload(async (workload) => {
		const row = await measure(workload);
		console.log(`\nQuarantine history baseline measurement, milliseconds:\n${table([row])}`);
		expect(row.errors, row.errorMessages.join("; ")).toBe(0);
		expect(row.warmupErrors).toEqual([]);
		expect(row.checked).toBe(20);
		budget("one-result report after quarantine entry and 3000 trunk commits: p95", row.p95, 100, "ms");
	});
}, 60_000);

test("records the 500-result trunk-page baseline beside 8000 changes", async () => {
	await withLandingWorkload(async (workload) => {
		const measured = await measure(workload);
		console.log(`\nTrunk result-page baseline measurement, milliseconds:\n${table([measured])}`);
		expect(measured.errors, measured.errorMessages.join("; ")).toBe(0);
		expect(measured.warmupErrors).toEqual([]);
		expect(measured.checked).toBe(10);
		budget("500-result trunk page beside 8000 changes: p95", measured.p95, BUDGETS.search, "ms");
	});
});

test("records project removal's indexed constraint-work baseline", async () => {
	await withInstance(async ({ instance }) => {
		const { app } = instance;
		await app.database.write((db) => removalFixture(db, 5_000, 20_000));
		const began = performance.now();
		await app.database.write((db) =>
			db.transaction(() => db.checkedBulk(() => removeProject(db, "removing", undefined, "deferred"))),
		);
		const lockedMs = performance.now() - began;
		await app.database.read(async (db) => {
			expect(await db.allDynamic("SELECT project, count(*) AS n FROM results GROUP BY project")).toEqual([
				{ project: 901, n: 20_000 },
			]);
			expect(await db.allDynamic("SELECT count(*) AS n FROM result_excuses")).toEqual([{ n: 20_000 }]);
		});
		budget("reset 5000 results retaining 20000 unrelated results: constraints and writes elapsed", lockedMs, 250, "ms");
		console.log(
			`reset constraints and writes: ${lockedMs.toFixed(1)} ms; 5000 removed, 20000 unrelated results retained`,
		);
	});
});
