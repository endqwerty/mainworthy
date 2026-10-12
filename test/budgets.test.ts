/**
 * These are regression tripwires, not a benchmark. The small real on-disk workload catches a lost index or a
 * query in a loop that makes a hot path many times slower. bench/run.ts measures the promises at product scale.
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { BUDGETS } from "../bench/contracts.ts";
import { buildDataset, openDataset, Parameters } from "../bench/dataset.ts";
import { measure, table } from "../bench/measure.ts";
import { ingestWorkload, readWorkloads, saveWorkload } from "../bench/workloads.ts";

test("on-disk hot paths stay inside the design budgets", async () => {
	const root = resolve(".casebook", "bench");
	mkdirSync(root, { recursive: true });
	// The system temporary directory can be tmpfs. A private temporary directory beside the benchmark is disk.
	const dir = mkdtempSync(join(root, "check-"));
	try {
		const dataset = buildDataset({
			dir: join(dir, "baseline"),
			parameters: Parameters.parse({
				cases: 2_000,
				tests: 500,
				results: 20_000,
				openQuestions: 200,
				queueTimeMs: 3_000,
			}),
			log: () => {},
		});
		const instance = openDataset(dataset, join(dir, "measurement"));
		try {
			const workloads = readWorkloads(instance, 15).filter((workload) => workload.budget !== null);
			workloads.push(
				saveWorkload(instance, 15),
				ingestWorkload(instance, { size: 5_000, budget: BUDGETS.smallIngest, iterations: 5, prefix: "check" }).workload,
			);
			const measured = [];
			for (const workload of workloads) measured.push(await measure(workload));
			console.log(
				`\nHot-path regression tripwires, milliseconds (2k cases / 500 tests / 20k results):\n${table(measured)}`,
			);
			for (const row of measured) {
				expect(row.errors, `${row.name}: ${row.errorMessages.join("; ")}`).toBe(0);
				expect(row.warmupErrors, `${row.name}: warmup must exercise real work`).toEqual([]);
				expect(row.checked, `${row.name}: every completed operation must pass its correctness check`).toBe(row.n);
				expect(
					row.pass,
					`${row.name}: ${row.criterion} ${row[row.criterion].toFixed(2)} ms must be < ${row.budget} ms`,
				).toBe(true);
			}
		} finally {
			instance.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 20_000);
