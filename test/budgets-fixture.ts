import { expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { BUDGETS } from "../bench/contracts.ts";
import { buildDataset, type DatasetInstance, openDataset, Parameters } from "../bench/dataset.ts";
import type { Workload } from "../bench/measure.ts";
import { observeDatabase } from "../bench/profile.ts";
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
		await h.close();
	}
}

export async function withDiskWorkloads(run: (workloads: Workload[]) => Promise<void>, snapshot = true): Promise<void> {
	const root = resolve(".mainworthy", "bench");
	mkdirSync(root, { recursive: true });
	// The system temporary directory can be tmpfs. A private temporary directory beside the benchmark is disk.
	const dir = mkdtempSync(join(root, "check-"));
	try {
		const check = async (instance: DatasetInstance) => {
			await prepareRecentChanges(instance);
			const workloads = (await readWorkloads(instance, 15)).filter((workload) => workload.budget !== null);
			workloads.push(
				saveWorkload(instance, 15),
				ingestWorkload(instance, { size: 5_000, budget: BUDGETS.smallIngest, iterations: 5, prefix: "check" }).workload,
			);
			await run(workloads);
		};
		const dataset = await buildDataset(
			{
				dir: join(dir, "baseline"),
				parameters: Parameters.parse({
					cases: 2_000,
					tests: 500,
					results: 20_000,
					openQuestions: 200,
					queueTimeMs: 3_000,
				}),
				log: () => {},
			},
			snapshot ? undefined : check,
		);
		if (snapshot) {
			const instance = await openDataset(dataset, join(dir, "measurement"));
			try {
				await check(instance);
			} finally {
				await instance.close();
			}
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

export async function withQuarantineWorkload(run: (workload: Workload) => Promise<void>): Promise<void> {
	const h = await harness({ unlinked: "track" });
	try {
		const commit = (i: number) => i.toString(16).padStart(40, "0");
		for (let i = 1; i <= 4; i++)
			await h.call(
				"report",
				ciReport({ commit: commit(i), n: 1, ...(i % 3 === 0 ? { fail: { 0: "expected green" } } : {}) }),
			);
		// Keep one real dissolved failure, then reserve runs through R2999 before the real final report.
		const historyRuns = await h.app.database.write((db) =>
			db.transaction(async () => {
				await db.exec(`INSERT INTO counters (project,name,value)
 SELECT id,'run',2999 FROM projects WHERE key='scratch'
 ON CONFLICT (project,name) DO UPDATE SET value=excluded.value`);
				return await db.allDynamic<{ id: number }>(
					"SELECT nextval(pg_get_serial_sequence('runs','id')) AS id FROM generate_series(1,2995)",
				);
			}),
		);
		await h.app.database.write((db) =>
			db.transaction(async () => {
				// Bulk history follows the prelude; the real final report follows it in sequence order.
				await db.runDynamic(
					`WITH template AS MATERIALIZED (
 SELECT r.id AS result,r.batch,r.target,rt.run FROM results r
 JOIN targets t ON t.id=r.target JOIN run_tests rt ON rt.result=r.id WHERE t.commit_sha=$2
), history AS MATERIALIZED (
 SELECT id AS run,i+4 AS no,lpad(to_hex(i+4),40,'0') AS sha,(i+4)%3=0 AS failed
 FROM unnest($1::bigint[]) WITH ORDINALITY AS h(id,i)
), failures AS MATERIALIZED (
 SELECT h.*,nextval(pg_get_serial_sequence('questions','id')) AS question FROM history h WHERE failed ORDER BY no
), dissolved AS MATERIALIZED (
 SELECT * FROM questions WHERE kind='failure' AND state='dissolved'
), new_targets AS (
 INSERT INTO targets (project,what,env,repo,commit_sha,branch,line,change,first_seq)
 SELECT t.project,'code:'||t.repo||'@'||h.sha,t.env,t.repo,h.sha,t.branch,t.line,NULL,t.first_seq
 FROM template s JOIN targets t ON t.id=s.target CROSS JOIN history h
 RETURNING id,what,commit_sha,repo,branch,line
), new_runs AS (
 INSERT INTO runs (id,project,no,name,origin,accepts,accepts_what,scope,require,change,state,signoff,
 accepted_seq,applied_seq,outstanding,next_expiry,tally,blocking,verdict,created_by,created_at,rev,quarantined)
 SELECT h.run,r.project,h.no,left(h.sha,7)||' on '||coalesce(t.branch,t.line),r.origin,
 jsonb_set(r.accepts::jsonb,'{commit}',to_jsonb(h.sha))::text,t.what,r.scope,r.require,NULL,r.state,r.signoff,
 r.accepted_seq,r.applied_seq,r.outstanding,r.next_expiry,
 (r.tally::jsonb||jsonb_build_object('pass',(NOT h.failed)::integer,'unexplained',h.failed::integer))::text,
 '[]',CASE WHEN h.failed THEN 'blocked' ELSE 'passed' END,r.created_by,r.created_at,r.rev,0
 FROM history h JOIN new_targets t ON t.commit_sha=h.sha CROSS JOIN template s JOIN runs r ON r.id=s.run
 RETURNING id,accepts_what
), new_batches AS (
 INSERT INTO batches (project,key,target,job,attempt,method,actor,run,build_url,state,counts,staged,receipt,
 at,seq,nothing_required,shard,shards,model)
 SELECT b.project,'quarantine-history:'||h.sha,t.id,b.job,b.attempt,b.method,b.actor,
 CASE WHEN b.run IS NULL THEN NULL ELSE u.id END,b.build_url,b.state,
 (b.counts::jsonb||jsonb_build_object('pass',(NOT h.failed)::integer,'fail',h.failed::integer))::text,NULL,NULL,
 b.at,b.seq,b.nothing_required,b.shard,b.shards,b.model
 FROM history h JOIN new_targets t ON t.commit_sha=h.sha JOIN new_runs u ON u.accepts_what=t.what
 CROSS JOIN template s JOIN batches b ON b.id=s.batch
 RETURNING id,target
), new_results AS (
 INSERT INTO results (project,test,seq,ord,batch,target,method,actor,basis,basis_case,basis_version,basis_claim,
 outcome,attempt,duration_ms,signature,message,detail,at_step,trail,note,run,corrects,at,quarantine_decision,quarantine_exit,model)
 SELECT r.project,r.test,(SELECT max(seq) FROM results),h.no,b.id,t.id,r.method,r.actor,r.basis,r.basis_case,r.basis_version,r.basis_claim,
 CASE WHEN h.failed THEN 'fail' ELSE 'pass' END,r.attempt,r.duration_ms,
 CASE WHEN h.failed THEN r.signature END,CASE WHEN h.failed THEN r.message END,CASE WHEN h.failed THEN r.detail END,
 CASE WHEN h.failed THEN r.at_step END,r.trail,r.note,CASE WHEN r.run IS NULL THEN NULL ELSE u.id END,NULL,r.at,NULL,NULL,r.model
 FROM history h JOIN new_targets t ON t.commit_sha=h.sha JOIN new_runs u ON u.accepts_what=t.what
 JOIN new_batches b ON b.target=t.id CROSS JOIN template s JOIN results r ON r.id=s.result
 RETURNING id,target,test,outcome,signature,attempt
), new_projections AS (
 INSERT INTO run_tests (run,test,result,outcome,signature,attempt,flipped,lane,target)
 SELECT u.id,r.test,r.id,r.outcome,r.signature,r.attempt,0,format('%s:%s:%s',r.target,b.job,b.actor),r.target
 FROM new_results r JOIN new_targets t ON t.id=r.target JOIN new_runs u ON u.accepts_what=t.what
 CROSS JOIN template s JOIN batches b ON b.id=s.batch
 RETURNING run
), new_questions AS (
 INSERT INTO questions (id,project,no,kind,subject,fingerprint,epoch,prior,title,producer,evidence,
 evidence_hash,basis,seen_count,seen_first,seen_last,carried,ask,blocks,owner,rank,state,decision,opened_at,rev)
 SELECT h.question,q.project,h.no/3+1,q.kind,q.subject,q.fingerprint,h.no/3-1,
 coalesce(lag(h.question) OVER (ORDER BY h.no),q.id),q.title,q.producer,
 (q.evidence::jsonb||jsonb_build_object('target',left(h.sha,12),'targets',jsonb_build_array(t.id),
 'targetId',t.id,'sample',r.id))::text,
 left(encode(sha256(convert_to(format('{"basis":"%s","target":%s}',q.basis,t.id),'UTF8')),'hex'),12),
 q.basis,q.seen_count,q.seen_first,q.seen_last,q.carried,q.ask,q.blocks,q.owner,q.rank,q.state,q.decision,q.opened_at,q.rev
 FROM failures h JOIN new_targets t ON t.commit_sha=h.sha JOIN new_results r ON r.target=t.id CROSS JOIN dissolved q
 RETURNING id,no
), new_assertions AS (
 INSERT INTO assertion_seen (project,scope,root,test,file)
 SELECT a.project,'commit:'||t.what,a.root,a.test,a.file FROM new_results r JOIN new_targets t ON t.id=r.target
 CROSS JOIN template s JOIN targets original ON original.id=s.target
 JOIN assertion_seen a ON a.scope='commit:'||original.what AND a.project=original.project AND a.test=r.test
 WHERE r.outcome='fail' RETURNING test
)
 INSERT INTO question_refs (project,ref,question)
 SELECT qr.project,CASE WHEN qr.ref='R-3' THEN format('R-%s',q.no*3-3) ELSE qr.ref END,q.id
 FROM new_questions q CROSS JOIN dissolved original JOIN question_refs qr ON qr.question=original.id`,
					[historyRuns.map(({ id }) => id), commit(3)],
				);
				await db.exec("UPDATE counters SET value=1000 WHERE name='question'");
			}),
		);
		await h.call("report", ciReport({ commit: commit(3000), n: 1, fail: { 0: "expected green" } }));
		await h.app.database.read(async (db) => {
			expect(
				await db.allDynamic(`SELECT count(DISTINCT t.commit_sha) AS commits,count(DISTINCT r.id) AS results,
 count(DISTINCT b.id) AS batches,count(DISTINCT rt.run) AS runs,count(rt.result) AS projections,
 count(*) FILTER (WHERE r.outcome='fail') AS failures FROM results r JOIN targets t ON t.id=r.target
 JOIN batches b ON b.id=r.batch AND b.target=t.id LEFT JOIN run_tests rt ON rt.result=r.id AND rt.target=t.id`),
			).toEqual([{ commits: 3000, results: 3000, batches: 3000, runs: 3000, projections: 3000, failures: 1000 }]);
		});
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
		expect(
			await h.app.database.read((db) =>
				db.allDynamic(`SELECT
 (SELECT count(*) FROM questions WHERE kind='failure' AND state='dissolved') AS dissolved,
 (SELECT count(*) FROM questions) AS questions,(SELECT count(*) FROM question_refs) AS refs,
 (SELECT count(*) FROM assertion_seen) AS seen`),
			),
		).toEqual([{ dissolved: 999, questions: 1002, refs: 3002, seen: 1000 }]);
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
		await h.close();
	}
}

export async function withLandingWorkload(run: (workload: Workload) => Promise<void>): Promise<void> {
	const h = await harness({ unlinked: "track" });
	try {
		const ci = await h.actor("pipeline", "ci", ["read", "record"]);
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
		await h.app.database.write((db) =>
			db.transaction(() =>
				db.exec(
					"INSERT INTO changes (project, key, repo, head_sha, branch, title, rev) SELECT project, 'old:' || i, repo, 'old-commit-' || i, 'feature', 'Old change', 1 FROM changes CROSS JOIN generate_series(1, 8000) i WHERE key = 'pr:8'",
				),
			),
		);
		let landingReads = 0;
		const restore = observeDatabase(h.app.database, (text) => {
			if (/JOIN change_ends/.test(text)) landingReads++;
		});
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
			restore();
		}
	} finally {
		await h.close();
	}
}
