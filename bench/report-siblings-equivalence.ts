import type { GateStatus, InboxReply, ReportReceipt } from "../src/core/ops.ts";
import { sql } from "../src/server/kernel/db.ts";
import type { Harness } from "../test/helpers.ts";
import { ciReport, harness } from "../test/helpers.ts";

/** Full public gates and questions at each step, for comparison across revisions. */
export async function snapshots(finalStorageOnly = false) {
	const out: { preset: string; stages: unknown[] }[] = [];
	for (const preset of ["loose", "standard"]) {
		const h = await harness({ preset });
		const ci = await h.actor("pipeline", "ci", ["read", "record"]);
		const stages: unknown[] = [];
		const targets = ["base0001", "otherbase", "change01", "change02", "change03"];
		const runs: string[] = [];
		const capture = async (step: string) => {
			const questions: InboxReply["items"] = [];
			for (const state of ["open", "decided"] as const) {
				let cursor: string | undefined;
				do {
					const page = await h.call<InboxReply>("inbox", { state, limit: 200, ...(cursor ? { cursor } : {}) });
					questions.push(...page.items);
					cursor = page.cursor ?? undefined;
				} while (cursor);
			}
			if (finalStorageOnly) {
				// Harness calls advance its clock; keep the fixture's write times without discarded gate projections.
				h.advance(targets.length + 1 + runs.length);
				return;
			}

			stages.push({
				step,
				evidence: await storedEvidence(h),
				gates: await Promise.all(
					targets.map(async (commit) => await h.call<GateStatus>("gate", { commit, repo: "acme/web" })),
				),
				otherRepo: await h.call<GateStatus>("gate", { commit: "change03", repo: "acme/other" }),
				planned: await Promise.all(runs.map(async (run) => await h.call<GateStatus>("gate", { run }))),
				questions,
			});
		};
		try {
			await h.call("propose", {
				edits: [
					{ op: "create", body: { title: "Checkout", steps: [{ id: "buy", action: "Buy", expected: "Receipt" }] } },
				],
			});
			const adoption = (await h.call<InboxReply>("inbox", { kind: "adopt" })).items[0];
			if (adoption)
				await h.call("decide", { q: adoption.q, onEvidence: adoption.evidenceHash, answer: { is: "accept" } });
			const report = async (
				commit: string,
				pr?: number,
				attempt = 1,
				fail: Record<number, string> = { 0: "shared cause" },
				extra = {},
			) => {
				const input = ciReport({ commit, ...(pr ? { pr, base: "base0001" } : {}), n: 2, fail, attempt });
				return h.call<ReportReceipt>(
					"report",
					{
						...input,
						results: input.results.map((result, index) => ({
							...result,
							annotation: { case: "C-1", version: 1 },
							note: `Result ${index} for ${commit}`,
							...(result.failure
								? { failure: { ...result.failure, detail: "Expected receipt at checkout", at: "buy" } }
								: {}),
							steps: [
								{
									step: "buy",
									outcome: result.outcome,
									durationMs: 31 + index,
									actions: [{ text: "Click buy", outcome: result.outcome, durationMs: 7 }],
									attachment: 0,
								},
							],
							tries: [
								{
									outcome: "fail",
									durationMs: 123 + index,
									failure: { message: "retry assertion", detail: "first try" },
								},
								{ outcome: "pass", durationMs: 0 },
							],
							attachments: [
								{
									name: "receipt.png",
									data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5RkAAAAASUVORK5CYII=",
									at: "buy",
								},
							],
						})),
						...extra,
					},
					ci,
				);
			};
			const agent = await h.actor("explorer", "agent", ["read", "produce"]);
			await h.call(
				"report",
				{
					target: { session: "agent-checkout" },
					model: "gpt-6.1-sol",
					results: [
						{
							test: { case: "C-1" },
							outcome: "fail",
							durationMs: 456,
							failure: { message: "Agent receipt missing", detail: "No receipt after buy", at: "buy" },
							note: "Agent observed no receipt",
							steps: [{ step: "buy", outcome: "fail", durationMs: 456 }],
							tries: [{ outcome: "error", durationMs: 81, failure: { message: "agent retry", detail: "network" } }],
							attachments: [{ name: "agent.txt", data: btoa("Agent evidence"), at: "buy" }],
						},
					],
				},
				agent,
			);
			await h.call(
				"claim",
				{
					lens: "review",
					findings: [
						{
							on: "C-1",
							category: "ambiguous",
							note: "Receipt wording",
							repro: "Buy once",
							suggest: { expected: "Receipt" },
						},
					],
				},
				agent,
			);
			const initial = await report("base0001");
			await report("otherbase", undefined, 1, {});
			await report("change01", 1);
			await report("change02", 2, 1, { 0: "shared cause", 1: "new cause" });
			await report("change03", 3, 1, { 0: "shared cause" }, { job: "unit" });
			const other = ciReport({ commit: "change03", pr: 3, base: "base0001", n: 2, fail: { 0: "shared cause" } });
			await h.call("report", { ...other, target: { ...other.target, repo: "acme/other", env: "linux" } }, ci);
			runs.push(
				(
					await h.call<{ run: string }>("plan", {
						name: "Pinned",
						select: { cases: ["C-1"] },
						accepts: { commit: "change01", repo: "acme/web" },
					})
				).run,
			);
			await capture("mixed reports and planned run");
			await report("change01", 1, 2);
			await capture("one change retry");
			const fail = (await h.call<InboxReply>("inbox", { on: "pr:2", kind: "failure" })).items.find(
				(q) => q.title === "new cause",
			);
			if (!fail) throw new Error("missing new failure");
			await h.call("decide", {
				q: fail.q,
				onEvidence: fail.evidenceHash,
				answer: { is: "flaky" },
				reason: "Intermittent runner failure",
			});
			await capture("manual answer");
			const corrected = ciReport({ commit: "base0001", n: 2 });
			await h.call(
				"report",
				{ ...corrected, results: [{ ...corrected.results[0], corrects: initial.results[0] }] },
				ci,
			);
			await capture("corrected base");
			await report("base0001", undefined, 3);
			await capture("base fails again");
			const moved = ciReport({
				commit: "change01",
				pr: 1,
				base: "otherbase",
				n: 2,
				fail: { 0: "shared cause" },
				attempt: 3,
			});
			await h.call("report", moved, ci);
			await capture("retargeted change");
			for (const next of ["standard", "loose"] as const) {
				await h.call("propose", { edits: [{ op: "policy", preset: next }] });
				const q = (await h.call<InboxReply>("inbox", { kind: "adopt" })).items[0];
				if (!q) throw new Error("missing policy adoption");
				await h.call("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "accept" } });
				await capture(`adopted ${next}`);
			}
			// Activate assertion spreading across batches, including retry-only causes.
			for (const [start, count] of [
				[0, 26],
				[26, 25],
			]) {
				await h.call(
					"report",
					{
						target: { commit: "spread01", repo: "acme/web", branch: "main" },
						job: `spread-${start}`,
						results: Array.from({ length: count ?? 0 }, (_, offset) => {
							const index = (start ?? 0) + offset;
							return {
								test: { key: `file-${index % 6}.test.ts::spread ${index}`, file: `file-${index % 6}.test.ts` },
								outcome: "pass",
								durationMs: index,
								tries: [
									{
										outcome: "fail",
										durationMs: 200 + index,
										failure: { message: "assertion failed", detail: "spread retry" },
									},
								],
								note: `Spread ${index}`,
							};
						}),
					},
					ci,
				);
			}
			out.push({ preset, stages: finalStorageOnly ? [await storedEvidence(h)] : stages });
		} finally {
			await h.close();
		}
	}
	return out;
}

const STORED = {
	tests: sql<readonly [], Record<string, unknown>>("SELECT * FROM tests ORDER BY id"),
	signatures: sql<readonly [], Record<string, unknown>>("SELECT * FROM signatures ORDER BY id"),
	results: sql<readonly [], Record<string, unknown>>("SELECT * FROM results ORDER BY id"),
	result_tries: sql<readonly [], Record<string, unknown>>("SELECT * FROM result_tries ORDER BY id"),
	flips: sql<readonly [], Record<string, unknown>>("SELECT * FROM flips ORDER BY id"),
	findings: sql<readonly [], Record<string, unknown>>("SELECT * FROM findings ORDER BY id"),
	reviews: sql<readonly [], Record<string, unknown>>("SELECT * FROM reviews ORDER BY id"),
	excuses: sql<readonly [], Record<string, unknown>>("SELECT * FROM excuses ORDER BY project,signature,scope,target"),
	result_excuses: sql<readonly [], Record<string, unknown>>("SELECT * FROM result_excuses ORDER BY id"),
	attachments: sql<readonly [], Record<string, unknown>>("SELECT * FROM attachments ORDER BY id"),
	batches: sql<readonly [], Record<string, unknown>>("SELECT * FROM batches ORDER BY id"),
	assertion_seen: sql<readonly [], Record<string, unknown>>(
		"SELECT * FROM assertion_seen ORDER BY project,scope,root,test",
	),
	assertion_spreads: sql<readonly [], Record<string, unknown>>(
		"SELECT * FROM assertion_spreads ORDER BY project,scope,root",
	),
	assertion_roots: sql<readonly [], Record<string, unknown>>("SELECT * FROM assertion_roots ORDER BY signature"),
	assertion_index: sql<readonly [], Record<string, unknown>>("SELECT * FROM assertion_index ORDER BY project"),
};

/** Includes ids and receipt fields, so a batching comparison cannot hide changed stored evidence. */
export async function storedEvidence(h: Harness) {
	return await h.app.database.read(async (db) => {
		const out: Record<string, Record<string, unknown>[]> = {};
		for (const [table, statement] of Object.entries(STORED)) {
			const rows = await db.all(statement);
			if (table === "batches")
				for (const row of rows) if (typeof row.receipt === "string") row.receipt = JSON.parse(row.receipt);
			// PostgreSQL consumes identity values on a conflicting insert; SQLite does not.
			// This surrogate has no references. Preserve row order and every other stored value.
			if (table === "result_excuses")
				rows.forEach((row, index) => {
					row.id = index + 1;
				});
			out[table] = rows;
		}
		return out;
	});
}

if (import.meta.main) console.log(JSON.stringify(await snapshots(), null, 2));
