import { expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { BUDGETS } from "../bench/contracts.ts";
import { buildDataset, openDataset, Parameters } from "../bench/dataset.ts";
import type { Workload } from "../bench/measure.ts";
import { ingestWorkload, prepareRecentChanges, readWorkloads, saveWorkload } from "../bench/workloads.ts";
import { budget } from "../scripts/budget.ts";
import type { Quarantine } from "../src/core/flaky.ts";
import type { Edit, GateStatus, InboxReply, ProposeReply, ReportReceipt } from "../src/core/ops.ts";
import { TimelineReply } from "../src/core/replies.ts";
import { ciReport, harness } from "./helpers.ts";

export async function withLinkProposal(
	run: (apply: () => Promise<ProposeReply>) => Promise<ProposeReply>,
): Promise<void> {
	const h = await harness();
	try {
		const tags = Array.from({ length: 2_000 }, (_, i) => `tag-${i}`);
		const covers = Array.from({ length: 1_999 }, (_, i) => `REQ-${i}`);
		await h.call("propose", { edits: [{ op: "create", body: { title: "Before links" }, tags }] });
		const edits: Edit[] = [
			{ op: "edit", case: "C-1", base: 1, body: { title: "With links" } },
			...covers.map((requirement) => ({ op: "cover" as const, case: "C-1", requirement, on: true })),
		];
		const reply = await run(() => h.call<ProposeReply>("propose", { edits }));
		expect(reply).toMatchObject({ status: "adopted", conflicts: [], cases: [{ ref: "C-1", version: 2 }] });
		const [saved] = await h.call<{ title: string; version: number; tags: string[]; covers: string[] }[]>("get", {
			refs: ["C-1"],
		});
		expect(saved).toMatchObject({ title: "With links", version: 2 });
		expect(saved?.tags.toSorted()).toEqual(tags.toSorted());
		expect(saved?.covers.toSorted()).toEqual(covers.toSorted());
		const timeline = TimelineReply.parse(await h.call("timeline", { ref: "C-1" }));
		expect(timeline.entries.filter((entry) => entry.t === "version").map((entry) => entry.version)).toEqual([2, 1]);
		expect(timeline.entries.filter((entry) => entry.t === "placement")).toEqual([]);
	} finally {
		h.close();
	}
}

export async function withDiskWorkloads(run: (workloads: Workload[]) => Promise<void>): Promise<void> {
	const root = resolve(".mainworthy", "bench");
	mkdirSync(root, { recursive: true });
	// The system temporary directory can be tmpfs. A private temporary directory beside the benchmark is disk.
	const dir = mkdtempSync(join(root, "check-"));
	try {
		const dataset = await buildDataset({
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
			await prepareRecentChanges(instance);
			const workloads = (await readWorkloads(instance, 15)).filter((workload) => workload.budget !== null);
			workloads.push(
				saveWorkload(instance, 15),
				ingestWorkload(instance, { size: 5_000, budget: BUDGETS.smallIngest, iterations: 5, prefix: "check" }).workload,
			);
			await run(workloads);
		} finally {
			instance.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

export async function withQuarantineWorkload(run: (workload: Workload) => Promise<void>): Promise<void> {
	const h = await harness({ unlinked: "track" });
	try {
		const commit = (i: number) => i.toString(16).padStart(40, "0");
		for (let i = 1; i <= 3000; i++)
			await h.call(
				"report",
				ciReport({ commit: commit(i), n: 1, ...(i % 3 === 0 ? { fail: { 0: "expected green" } } : {}) }),
			);
		const proposal = await h.call<ProposeReply>("propose", {
			edits: [{ op: "quarantine", test: "T-1", base: null, exit: { kind: "passes", count: 100 } }],
			reason: "Repair an unreliable test",
		});
		const question = (await h.call<InboxReply>("inbox", { kind: "adopt" })).items.find(
			(q) => q.q === proposal.question,
		);
		if (!question) throw new Error("missing quarantine proposal");
		await h.call("decide", {
			q: question.q,
			onEvidence: question.evidenceHash,
			answer: { is: "accept" },
			reason: "Require 100 clean commits before exit",
		});
		await run({
			name: "quarantined report after 3000 trunk commits",
			budget: 100,
			iterations: 20,
			warmup: 0,
			correctness: "one fresh result recorded, its gate passes, and quarantine remains active",
			prepare: (i) => {
				const input = ciReport({ commit: commit(3001 + i), n: 1 });
				return async () => await h.call<ReportReceipt>("report", input);
			},
			check: async (result, i) => {
				expect(result).toMatchObject({ fresh: true, counts: { total: 1, pass: 1 }, rejected: [] });
				expect(await h.call<GateStatus>("gate", { commit: commit(3001 + i) })).toMatchObject({
					verdict: "passed",
					tally: { pass: 1, unexplained: 0 },
				});
				expect((await h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] }))[0]?.quarantine.active).toBe(true);
			},
		});
	} finally {
		h.close();
	}
}

export async function withLandingWorkload(run: (workload: Workload) => Promise<void>): Promise<void> {
	const h = await harness({ unlinked: "track" });
	try {
		const ci = h.actor("pipeline", "ci", ["read", "record"]);
		const commit = "1234567890abcdef1234567890abcdef12345678";
		await h.call(
			"report",
			{
				target: { repo: "acme/shop", commit: "feature0001", pr: 8, branch: "feature", title: "Keep coupons" },
				results: [{ test: { key: "setup" }, outcome: "pass" }],
			},
			ci,
		);
		await h.call("change", { change: "pr:8", state: "merged", landing: { commit, branch: "main" } });
		const receipt = await h.call<ReportReceipt>(
			"report",
			{
				target: { repo: "acme/shop", commit, branch: "main" },
				results: Array.from({ length: 500 }, (_, i) => ({ test: { key: `page-${i}` }, outcome: "pass" })),
			},
			ci,
		);
		h.app.db.exec(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i + 1 FROM n WHERE i < 8000)
			INSERT INTO changes (project, key, repo, head_sha, branch, title, rev)
			SELECT project, 'old:' || i, repo, 'old-commit-' || i, 'feature', 'Old change', 1 FROM changes, n WHERE key = 'pr:8'`);
		const db = h.app.db;
		const all = db.all.bind(db);
		let landingReads = 0;
		db.all = (statement, ...params) => {
			if (/JOIN change_ends/.test(statement.text)) landingReads++;
			return all(statement, ...params);
		};
		try {
			await run({
				name: "500 trunk results beside 8000 changes",
				budget: BUDGETS.search,
				iterations: 10,
				correctness: "all 500 results name only the recorded landing, using one landing query per page",
				prepare: () => async () => {
					landingReads = 0;
					return h.call("find", { in: "results", run: receipt.gate?.run, limit: 500 });
				},
				check: (reply) => {
					const pageReply = z
						.object({
							count: z.number(),
							cursor: z.string().nullable(),
							items: z.array(z.object({ location: z.unknown() })),
						})
						.parse(reply);
					expect(pageReply.count).toBe(500);
					expect(pageReply.cursor).toBeNull();
					const page = pageReply.items;
					expect(page).toHaveLength(500);
					for (const item of page)
						expect(item.location).toEqual({ label: "main · pr:8 Keep coupons", commit, change: "pr:8" });
					budget("landing reads of a 500-result trunk page", landingReads, 1, "reads");
				},
			});
		} finally {
			db.all = all;
		}
	} finally {
		h.close();
	}
}
