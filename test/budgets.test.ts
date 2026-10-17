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
import type { Quarantine } from "../src/core/flaky.ts";
import type { GateStatus, InboxReply, ProposeReply, ReportReceipt } from "../src/core/ops.ts";
import { ReportsReply } from "../src/core/replies.ts";
import { SESSION_LIFETIMES } from "../src/server/kernel/app.ts";
import { OPS } from "../src/server/ops/index.ts";
import { invoke } from "../src/server/ops/registry.ts";
import { open } from "../src/server/start.ts";
import { ciReport, harness } from "./helpers.ts";

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

test("quarantined reports stay within budget after 3000 earlier trunk commits", async () => {
	const h = harness({ unlinked: "track" });
	try {
		const commit = (i: number) => i.toString(16).padStart(40, "0");
		for (let i = 1; i <= 3000; i++)
			h.call(
				"report",
				ciReport({ commit: commit(i), n: 1, ...(i % 3 === 0 ? { fail: { 0: "expected green" } } : {}) }),
			);
		const proposal = h.call<ProposeReply>("propose", {
			edits: [{ op: "quarantine", test: "T-1", base: null, exit: { kind: "passes", count: 100 } }],
			reason: "Repair an unreliable test",
		});
		const question = h.call<InboxReply>("inbox", { kind: "adopt" }).items.find((q) => q.q === proposal.question);
		if (!question) throw new Error("missing quarantine proposal");
		h.call("decide", {
			q: question.q,
			onEvidence: question.evidenceHash,
			answer: { is: "accept" },
			reason: "Require 100 clean commits before exit",
		});
		const row = await measure({
			name: "quarantined report after 3000 trunk commits",
			budget: 100,
			iterations: 20,
			warmup: 0,
			correctness: "one fresh result recorded, its gate passes, and quarantine remains active",
			prepare: (i) => {
				const input = ciReport({ commit: commit(3001 + i), n: 1 });
				return () => h.call<ReportReceipt>("report", input);
			},
			check: (result, i) => {
				expect(result).toMatchObject({ fresh: true, counts: { total: 1, pass: 1 }, rejected: [] });
				expect(h.call<GateStatus>("gate", { commit: commit(3001 + i) })).toMatchObject({
					verdict: "passed",
					tally: { pass: 1, unexplained: 0 },
				});
				expect(h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] })[0]?.quarantine.active).toBe(true);
			},
		});
		console.log(`\nQuarantine history regression tripwire, milliseconds:\n${table([row])}`);
		expect(row.errors, row.errorMessages.join("; ")).toBe(0);
		expect(row.checked).toBe(20);
		expect(row.p95, "a one-result report after quarantine entry must stay below 100 ms at p95").toBeLessThan(100);
	} finally {
		h.close();
	}
}, 60_000);

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

test("reports stay inside the read budget at 10k cases and 100k results without statistics", async () => {
	const root = resolve(".mainworthy", "bench");
	mkdirSync(root, { recursive: true });
	const dir = mkdtempSync(join(root, "reports-"));
	const now = 1_800_000_000_000;
	const day = 86_400_000;
	const { app, owner } = open(
		{
			dataDir: dir,
			host: "127.0.0.1",
			port: 0,
			mode: "local",
			owner: "robin",
			ownerToken: null,
			commit: null,
			proxy: null,
			...SESSION_LIFETIMES,
		},
		{ now: () => now },
	);
	const call = (op: string, input: unknown) => {
		const reply = invoke(app, OPS, { op, project: "scratch", input, actor: () => owner });
		if (!reply.ok) throw new Error(reply.error.message);
		return reply.result;
	};
	try {
		expect(app.db.raw.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
		call("propose", { edits: [{ op: "create", body: { title: "Budget case" } }] });
		call("report", {
			target: { commit: "a".repeat(40) },
			job: "unit",
			results: Array.from({ length: 2_000 }, (_, i) => ({
				test: { key: `budget-${i}` },
				outcome: "pass",
				durationMs: 3,
			})),
		});
		// This is a read fixture, not an ingestion benchmark. Expand one valid case and fifty result batches in SQL.
		app.db.exec(`
   WITH RECURSIVE n(i) AS (VALUES(2) UNION ALL SELECT i+1 FROM n WHERE i<10000)
   INSERT INTO cases(project,no,head,head_hash,claim_hash,methods,automate,title,step_count,folder,rank,tags,state,aliases,created_by,created_at,updated_by,updated_at,rev)
   SELECT c.project,n.i,c.head,c.head_hash,c.claim_hash,c.methods,c.automate,c.title,c.step_count,c.folder,printf('%08d',n.i),c.tags,c.state,c.aliases,c.created_by,c.created_at,c.updated_by,c.updated_at,c.rev
   FROM cases c CROSS JOIN n WHERE c.no=1;
   INSERT INTO versions(case_id,no,parent,body,hash,claim_hash,proposal,decision,author,reason,at,seq)
   SELECT c.id,v.no,v.parent,v.body,v.hash,v.claim_hash,v.proposal,v.decision,v.author,v.reason,v.at,v.seq
   FROM cases c JOIN versions v ON v.case_id=1 WHERE c.id>1;
   WITH RECURSIVE n(i) AS (VALUES(2) UNION ALL SELECT i+1 FROM n WHERE i<=49)
   INSERT INTO batches(project,key,target,job,attempt,method,actor,state,counts,at,seq)
   SELECT b.project,'budget-'||i,b.target,b.job,i,b.method,b.actor,b.state,b.counts,b.at,b.seq+i
   FROM batches b CROSS JOIN n WHERE b.id=1;
   INSERT INTO results(project,test,seq,ord,batch,target,method,actor,basis,outcome,attempt,duration_ms,at)
   SELECT r.project,r.test,b.seq,r.ord,b.id,r.target,r.method,r.actor,r.basis,
    CASE WHEN b.id % 2 = 0 THEN 'fail' ELSE 'pass' END,b.attempt,3,r.at
   FROM results r CROSS JOIN batches b WHERE r.batch=1 AND b.id>1;
  `);
		expect(app.db.raw.query("SELECT count(*) AS n FROM results").get()).toEqual({ n: 100_000 });
		expect(app.db.raw.query("SELECT name FROM sqlite_master WHERE name = 'sqlite_stat1'").get()).toBeNull();
		app.db.exec(`WITH RECURSIVE n(i) AS (VALUES(2) UNION ALL SELECT i+1 FROM n WHERE i<16)
   INSERT INTO targets(project,what,env,commit_sha,line,first_seq)
   SELECT project,'code:budget-'||i,env,'budget-'||i,line,first_seq FROM targets CROSS JOIN n WHERE id=1;
   UPDATE batches SET target = 1+(id-1)%16;
   UPDATE results SET target = (SELECT target FROM batches WHERE id=results.batch);`);
		const measured = [];
		const shapes = [
			{ jobs: 1, older: false, corrected: false },
			{ jobs: 1, older: true, corrected: false },
			{ jobs: 4, older: false, corrected: false },
			{ jobs: 4, older: true, corrected: false },
			{ jobs: 4, older: true, corrected: true },
		];
		for (const { jobs, older, corrected } of shapes) {
			app.db.raw
				.query(
					"UPDATE results SET corrects = CASE WHEN ? THEN (SELECT id FROM results WHERE batch = 1 AND ord = 0) END WHERE batch = 17 AND ord = 0",
				)
				.run(Number(corrected));
			app.db.exec(`UPDATE batches SET job = 'job-' || ((id - 1) % ${jobs});
    UPDATE results SET outcome = CASE WHEN batch%7=0 THEN 'fail' ELSE 'pass' END`);
			app.db.raw
				.query("UPDATE results SET at = ? - CASE WHEN ? AND batch <= 5 THEN 40 ELSE (50-batch)/2 END * ?")
				.run(now, Number(older), day);
			const row = await measure({
				name: `reports 100k / 16 targets / ${jobs} jobs / ${older ? "10% older" : "all in window"}${corrected ? " / correction" : ""}`,
				budget: BUDGETS.reports,
				iterations: 15,
				correctness: "Exact observed totals, active cases, flaky tests and rerun count/duration over 30 UTC days",
				prepare: () => () => call("reports", { days: 30 }),
				check(value) {
					const read = ReportsReply.parse(value);
					expect(read.days.reduce((n, d) => n + d.total, 0)).toBe(older ? 90_000 : 100_000);
					expect(read.days.reduce((n, d) => n + d.pass, 0)).toBe(older ? 76_000 : 86_000);
					expect(read.automation.total).toBe(10_000);
					expect(read.flaky.length).toBe(50);
					expect(read.reruns).toEqual({
						count: corrected ? 67_999 : 68_000,
						durationMs: (corrected ? 67_999 : 68_000) * 3,
						missingDuration: 0,
					});
				},
			});
			measured.push(row);
		}
		console.log(`\nReports at product scale, production WAL, milliseconds:\n${table(measured)}`);
		for (const row of measured) {
			expect(row.errors, row.errorMessages.join("; ")).toBe(0);
			expect(row.warmupErrors).toEqual([]);
			expect(row.checked).toBe(row.n);
			expect(row.pass, `${row.name}: p95 ${row.p95.toFixed(2)} ms must be < ${BUDGETS.reports} ms`).toBe(true);
		}
	} finally {
		app.close();
		rmSync(dir, { recursive: true, force: true });
	}
}, 30_000);
