import { expect, test } from "bun:test";
import type { Workload } from "../bench/measure.ts";
import { observeDatabase } from "../bench/profile.ts";
import { budget } from "../scripts/budget.ts";
import { withInstance } from "../src/cli/test-support.ts";
import type { GateStatus, InboxReply, ReportReceipt } from "../src/core/ops.ts";
import { removeProject } from "../src/server/transfer/transfer.ts";
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
	}, false);
	// The limit bounds building the 2,000-case dataset: 9 s on a quiet Mac, over 20 s beside other full checks.
}, 60_000);

test("quarantined reports remain correct after 3000 earlier trunk commits", async () => {
	await withQuarantineWorkload(checkWorkload);
}, 60_000);

test("a report that makes many failures go away recomputes each run once, not once per question", async () => {
	const h = await harness();
	try {
		const ci = await h.actor("pipeline", "ci", ["read", "record"]);
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
		const restore = observeDatabase(h.app.database, (text) => {
			if (
				/SELECT test, result, target, outcome, signature, flipped FROM run_tests WHERE run = \$\d+ ORDER BY result/.test(
					text,
				)
			)
				tallies++;
		});
		try {
			await h.call(
				"report",
				{ target: { commit: "b".repeat(40), branch: "main" }, job: "unit", results: results("pass") },
				ci,
			);
		} finally {
			restore();
		}
		expect((await counts()).failure ?? 0).toBe(0);
		// Two commits' runs, each read a few times in one report: nowhere near once per question.
		budget("run reads in one report", tallies, 11, "reads");
	} finally {
		await h.close();
	}
});

/** A report reuses its tally and reads each target's scope once per discovery pass, however many tests fail. */
test("a report with existing failures bounds repeated scans and targets reads", async () => {
	const work = async (failures: number) => {
		const h = await harness({ unlinked: "track" });
		try {
			const ci = await h.actor("pipeline", "ci", ["read", "record"]);
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
			const restore = observeDatabase(h.app.database, (text) => {
				if (
					/SELECT test, result, target, outcome, signature, flipped FROM run_tests WHERE run = \$\d+ ORDER BY result/.test(
						text,
					)
				)
					reads.scans++;
				if (/^SELECT \* FROM targets WHERE id = \$\d+$/.test(text)) reads.targets++;
			});
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
				restore();
			}
			expect(receipt).toMatchObject({ fresh: true, counts: { total: 1, pass: 1 }, rejected: [] });
			expect(await h.call<GateStatus>("gate", { commit: "reuse001", repo: "acme/web" })).toMatchObject({
				verdict: "blocked",
				tally: { pass: 1, unexplained: failures },
			});
			expect((await h.call<InboxReply>("inbox", { kind: "failure" })).items.map((q) => q.state)).toEqual(["open"]);
			return reads;
		} finally {
			await h.close();
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

test("project removal preserves unrelated results and their constraints", async () => {
	await withInstance(async ({ instance }) => {
		const { app } = instance;
		await app.database.write((db) => removalFixture(db, 5_000, 20_000));
		await app.database.write((db) =>
			db.transaction(() => db.checkedBulk(() => removeProject(db, "removing", undefined, "deferred"))),
		);
		await app.database.read(async (db) => {
			expect(await db.allDynamic("SELECT project, count(*) AS n FROM results GROUP BY project")).toEqual([
				{ project: 901, n: 20_000 },
			]);
			expect(await db.allDynamic("SELECT count(*) AS n FROM result_excuses")).toEqual([{ n: 20_000 }]);
		});
	});
});
