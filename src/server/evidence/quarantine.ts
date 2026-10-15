import type { QuarantineExit } from "../../core/flaky.ts";
import { QuarantineExit as ExitSchema } from "../../core/flaky.ts";
import type { Edit } from "../../core/ops.ts";
import { replacesInLane } from "../../core/runs.ts";
import type { Ctx } from "../kernel/ctx.ts";
import { type Db, json, sql } from "../kernel/db.ts";
import { conflict, invalid, notFound } from "../kernel/errors.ts";
import { decisionOf, type Witness } from "../kernel/witness.ts";
import { findTest, resultById, testById } from "./evidence.ts";

type Entry = {
	project: number;
	test: number;
	decision: number;
	actor: number;
	reason: string;
	exit_rule: string | null;
	at: number;
	seq: number;
};
const Q = {
	cases: sql<{ project: number; test: number }, { caseId: number }>(
		"SELECT DISTINCT basis_case AS caseId FROM results WHERE project=$project AND test=$test AND basis_case IS NOT NULL",
	),
	entry: sql<{ project: number; test: number }, Entry>(
		"SELECT * FROM quarantines WHERE project = $project AND test = $test",
	),
	entries: sql<{ project: number }, Entry>("SELECT * FROM quarantines WHERE project = $project ORDER BY test DESC"),
	write: sql<Entry>(`INSERT INTO quarantines (project, test, decision, actor, reason, exit_rule, at, seq)
 VALUES ($project,$test,$decision,$actor,$reason,$exit_rule,$at,$seq)
 ON CONFLICT (project,test) DO UPDATE SET decision=excluded.decision, actor=excluded.actor,
 reason=excluded.reason, exit_rule=excluded.exit_rule, at=excluded.at, seq=excluded.seq`),
	trunk: sql<
		{ project: number; test: number; since: number },
		{ commit_sha: string; lane: string; attempt: number; outcome: string; seq: number; ord: number }
	>(
		`SELECT t.commit_sha, printf('%d:%s:%d:%s',r.target,b.job,r.actor,r.method) AS lane,
 r.attempt,r.outcome,r.seq,r.ord FROM results r JOIN targets t ON t.id=r.target JOIN batches b ON b.id=r.batch
 WHERE r.project=$project AND r.test=$test AND r.seq>$since AND t.line='trunk' AND t.commit_sha IS NOT NULL
 AND r.method='auto' AND NOT EXISTS (SELECT 1 FROM results c WHERE c.corrects=r.id)
 ORDER BY r.seq,r.ord`,
	),
};
export const quarantineEntries = (db: Db, project: number) => db.all(Q.entries, { project });
export const quarantineCaseIds = (db: Db, project: number, test: number) =>
	db.all(Q.cases, { project, test }).map((row) => row.caseId);
export const quarantineEntry = (db: Db, project: number, test: number) => db.get(Q.entry, { project, test });

export function validateQuarantineEdit(ctx: Ctx, edit: Extract<Edit, { op: "quarantine" }>) {
	const test = findTest(ctx.db, ctx.project.id, edit.test);
	if (!test) throw notFound(`test ${edit.test}`);
	if (test.kind !== "auto") throw invalid("only an automated test can be quarantined");
	const prior = quarantineEntry(ctx.db, ctx.project.id, test.id);
	if ((prior?.decision ?? null) !== edit.base)
		throw conflict("quarantine changed; read the test and propose on its current decision");
	if (edit.exit?.kind === "expiry" && edit.exit.at <= ctx.now) throw invalid("quarantine expiry must be in the future");
	return test;
}
export function setQuarantine(
	ctx: Ctx,
	witness: Witness,
	input: { test: number; exit: QuarantineExit | null; reason: string },
): void {
	const decision = decisionOf(witness, "adopt");
	ctx.db.run(Q.write, {
		project: ctx.project.id,
		test: input.test,
		decision,
		actor: ctx.actor.id,
		reason: input.reason,
		exit_rule: input.exit === null ? null : JSON.stringify(input.exit),
		at: ctx.now,
		seq: ctx.seq,
	});
	const test = testById(ctx.db, input.test);
	if (test) ctx.touched.add(`T-${test.no}`);
}

export function effectiveQuarantine(db: Db, entry: Entry, now: number): boolean {
	if (entry.exit_rule === null) return false;
	const exit = ExitSchema.parse(json<unknown>(entry.exit_rule));
	if (exit.kind === "person") return true;
	if (exit.kind === "expiry") return now < exit.at;
	const commits = new Map<string, Map<string, { attempt: number; outcome: string }>>();
	let streak = 0;

	for (const row of db.all(Q.trunk, { project: entry.project, test: entry.test, since: entry.seq })) {
		let lanes = commits.get(row.commit_sha);
		if (!lanes) {
			lanes = new Map();
			commits.set(row.commit_sha, lanes);
		}
		const prior = lanes.get(row.lane);
		if (!prior || replacesInLane(prior, row)) lanes.set(row.lane, { attempt: row.attempt, outcome: row.outcome });
	}
	for (const lanes of commits.values()) {
		streak = [...lanes.values()].every((row) => row.outcome === "pass") ? streak + 1 : 0;
		if (streak >= exit.count) return false;
	}
	return true;
}
export function quarantineLookup(db: Db, project: number, now: number) {
	const entries = new Map(quarantineEntries(db, project).map((entry) => [entry.test, entry]));
	const active = new Map<number, boolean>();
	return (id: number) => {
		if (entries.size === 0) return null;
		const result = resultById(db, id);
		if (result?.method !== "auto") return null;
		const entry = entries.get(result.test);
		if (!entry) return null;
		let stands = active.get(entry.test);
		if (stands === undefined) {
			stands = effectiveQuarantine(db, entry, now);
			active.set(entry.test, stands);
		}
		if (!stands) return null;
		const exit = entry.exit_rule === null ? null : ExitSchema.parse(json<unknown>(entry.exit_rule));
		return {
			decision: entry.decision,
			class: "excused" as const,
			expires_at: exit?.kind === "expiry" ? exit.at : null,
			quarantined: true,
		};
	};
}
