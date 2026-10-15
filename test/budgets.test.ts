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
import { ingestWorkload, prepareRecentChanges, readWorkloads, saveWorkload } from "../bench/workloads.ts";
import type { InboxReply } from "../src/core/ops.ts";
import { harness } from "./helpers.ts";

test("on-disk hot paths stay inside the design budgets", async () => {
	const root = resolve(".mainworthy", "bench");
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
			prepareRecentChanges(instance);
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

/**
 * Counted, not timed: the work one report does must not grow with the number of questions it settles times the
 * size of the runs that waited for them. At product scale this was fourteen seconds for a report that should
 * take one (a pipeline going green after a bad day closes thousands of questions at once).
 */
test("a report that makes many failures go away recomputes each run once, not once per question", () => {
	const h = harness();
	try {
		const ci = h.actor("pipeline", "ci", ["read", "record"]);
		const causes = 300;
		// Letters the signature keeps apart: digits and anything that reads as an identifier are normalised away.
		const word = (i: number) => [...String(i).padStart(3, "0")].map((digit) => "ghijklmnop"[Number(digit)]).join("");
		const results = (outcome: "pass" | "fail") =>
			Array.from({ length: causes }, (_, i) => ({
				test: { key: `suite/t${i}` },
				outcome,
				...(outcome === "fail" ? { failure: { message: `the ${word(i)} widget did not answer` } } : {}),
			}));
		const counts = () => h.call<InboxReply>("inbox", { kind: "failure", state: "open", limit: 1 }).counts;
		h.call("report", { target: { commit: "a".repeat(40), branch: "main" }, job: "unit", results: results("fail") }, ci);
		expect(counts().failure).toBe(causes);

		let tallies = 0;
		const db = h.app.db;
		const all = db.all.bind(db);
		db.all = ((statement: { text: string }, ...args: unknown[]) => {
			if (
				statement.text ===
				"SELECT test, result, target, outcome, signature FROM run_tests WHERE run = $run ORDER BY result"
			)
				tallies++;
			return (all as (...rest: unknown[]) => unknown[])(statement, ...args);
		}) as typeof db.all;
		try {
			h.call(
				"report",
				{ target: { commit: "b".repeat(40), branch: "main" }, job: "unit", results: results("pass") },
				ci,
			);
		} finally {
			db.all = all;
		}
		expect(counts().failure ?? 0).toBe(0);
		// Two commits' runs, each read a few times in one report: nowhere near once per question.
		expect(tallies).toBeLessThan(12);
	} finally {
		h.close();
	}
});
