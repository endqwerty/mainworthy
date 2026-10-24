import { expect, test } from "bun:test";
import type { Workload } from "../bench/measure.ts";
import { budget } from "../scripts/budget.ts";
import { resetDemoSteps } from "../src/cli/demo.ts";
import { withInstance } from "../src/cli/test-support.ts";
import type { GateStatus, InboxReply, ReportReceipt } from "../src/core/ops.ts";
import { withDiskWorkloads, withLandingWorkload, withLinkProposal, withQuarantineWorkload } from "./budgets-fixture.ts";
import { removalFixture } from "./demo-removal-fixture.ts";
import { ciReport, harness } from "./helpers.ts";

async function checkWorkload(workload: Workload): Promise<void> {
	const result = await workload.prepare(0)();
	await workload.check(result, 0);
}

test("a large link proposal does not multiply its edits by the case's tags", async () => {
	await withLinkProposal((apply) => apply());
}, 30_000);

test("on-disk hot paths preserve their results", async () => {
	await withDiskWorkloads(async (workloads) => {
		for (const workload of workloads) await checkWorkload(workload);
	});
}, 20_000);

test("quarantined reports remain correct after 3000 earlier trunk commits", async () => {
	await withQuarantineWorkload(checkWorkload);
}, 60_000);

test("a report that makes many failures go away recomputes each run once, not once per question", async () => {
	const h = await harness();
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
		const counts = async () => (await h.call<InboxReply>("inbox", { kind: "failure", state: "open", limit: 1 })).counts;
		await h.call(
			"report",
			{ target: { commit: "a".repeat(40), branch: "main" }, job: "unit", results: results("fail") },
			ci,
		);
		expect((await counts()).failure).toBe(causes);

		let tallies = 0;
		const db = h.app.db;
		const all = db.all.bind(db);
		db.all = ((statement: { text: string }, ...args: unknown[]) => {
			if (
				statement.text ===
				"SELECT test, result, target, outcome, signature, flipped FROM run_tests WHERE run = $run ORDER BY result"
			)
				tallies++;
			return (all as (...rest: unknown[]) => unknown[])(statement, ...args);
		}) as typeof db.all;
		try {
			await h.call(
				"report",
				{ target: { commit: "b".repeat(40), branch: "main" }, job: "unit", results: results("pass") },
				ci,
			);
		} finally {
			db.all = all;
		}
		expect((await counts()).failure ?? 0).toBe(0);
		// Two commits' runs, each read a few times in one report: nowhere near once per question.
		budget("run reads in one report", tallies, 11, "reads");
	} finally {
		h.close();
	}
});

/** A report reuses its tally and reads each target's scope once per discovery pass, however many tests fail. */
test("a report with existing failures bounds repeated scans and targets reads", async () => {
	const work = async (failures: number) => {
		const h = await harness({ unlinked: "track" });
		try {
			const ci = h.actor("pipeline", "ci", ["read", "record"]);
			await h.call(
				"report",
				ciReport({
					commit: "reuse001",
					n: failures,
					fail: Object.fromEntries(Array.from({ length: failures }, (_, i) => [i, "same cause"])),
				}),
				ci,
			);
			const reads = { scans: 0, targets: 0 };
			const db = h.app.db;
			const all = db.all.bind(db);
			const get = db.get.bind(db);
			db.all = (statement, ...params) => {
				if (
					statement.text ===
					"SELECT test, result, target, outcome, signature, flipped FROM run_tests WHERE run = $run ORDER BY result"
				)
					reads.scans++;
				return all(statement, ...params);
			};
			db.get = (statement, ...params) => {
				if (statement.text === "SELECT * FROM targets WHERE id = $id") reads.targets++;
				return get(statement, ...params);
			};
			let receipt: ReportReceipt;
			try {
				receipt = await h.call<ReportReceipt>(
					"report",
					{
						target: { commit: "reuse001", repo: "acme/web", branch: "main" },
						job: "e2e",
						results: [{ test: { key: "new-pass" }, outcome: "pass" }],
					},
					ci,
				);
			} finally {
				db.all = all;
				db.get = get;
			}
			expect(receipt).toMatchObject({ fresh: true, counts: { total: 1, pass: 1 }, rejected: [] });
			expect(await h.call<GateStatus>("gate", { commit: "reuse001", repo: "acme/web" })).toMatchObject({
				verdict: "blocked",
				tally: { pass: 1, unexplained: failures },
			});
			expect((await h.call<InboxReply>("inbox", { kind: "failure" })).items.map((q) => q.state)).toEqual(["open"]);
			return reads;
		} finally {
			h.close();
		}
	};
	const small = await work(3);
	const large = await work(30);
	// One tally and one question-discovery pass. Stale handling already has the tally's failing set.
	budget("tally scans of a 3-failure report", small.scans, 2, "scans");
	budget("tally scans of a 30-failure report", large.scans, 2, "scans");
	budget("target reads of a 30-failure report", large.targets, small.targets, "reads");
});

test("a 500-result trunk page batches landing reads beside 8000 changes", async () => {
	await withLandingWorkload(checkWorkload);
});

test("the reset preserves unrelated results and their constraints", async () => {
	await withInstance(async ({ instance }) => {
		const { app, owner } = instance;
		removalFixture(app.db, 5_000, 20_000);
		const steps = resetDemoSteps(app, owner, "removing", null, () => {});
		for (const _ of steps) {
		}
		expect(app.db.raw.query("SELECT project, count(*) AS n FROM results GROUP BY project").all()).toEqual([
			{ project: 901, n: 20_000 },
		]);
		expect(app.db.raw.query("SELECT count(*) AS n FROM result_excuses").get()).toEqual({ n: 20_000 });
		expect(app.db.raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
	});
});
