import type { QuarantineExit } from "../../core/flaky.ts";
import { QuarantineExit as ExitSchema } from "../../core/flaky.ts";
import type { Edit } from "../../core/ops.ts";
import { replacesInLane } from "../../core/runs.ts";
import type { Ctx } from "../kernel/ctx.ts";
import { type Db, json, sql } from "../kernel/db.ts";
import { conflict, invalid, notFound } from "../kernel/errors.ts";
import { decisionOf, type Witness } from "../kernel/witness.ts";
import { findTest, type ResultRow, resultById, testById } from "./evidence.ts";

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
	entry: sql<{ project: number; test: number }, Entry>(
		"SELECT * FROM quarantines WHERE project = $project AND test = $test",
	),
	entries: sql<{ project: number }, Entry>("SELECT * FROM quarantines WHERE project = $project ORDER BY test DESC"),
	write: sql<Entry>(`INSERT INTO quarantines (project, test, decision, actor, reason, exit_rule, at, seq)
 VALUES ($project,$test,$decision,$actor,$reason,$exit_rule,$at,$seq)
 ON CONFLICT (project,test) DO UPDATE SET decision=excluded.decision, actor=excluded.actor,
 reason=excluded.reason, exit_rule=excluded.exit_rule, at=excluded.at, seq=excluded.seq`),
	trunk: sql<{ project: number; test: number; since: number }, TrunkResult>(
		`SELECT t.commit_sha, printf('%d:%s:%d:%s',r.target,b.job,r.actor,r.method) AS lane,
 r.id,r.corrects,r.attempt,r.outcome,r.seq,r.ord FROM results r JOIN targets t ON t.id=r.target JOIN batches b ON b.id=r.batch
 WHERE r.project=$project AND r.test=$test AND r.seq>$since AND t.line='trunk' AND t.commit_sha IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM targets initial CROSS JOIN results first ON first.target=initial.id
 WHERE initial.project=r.project AND initial.commit_sha=t.commit_sha AND first.test=r.test AND first.seq<=$since)
 AND r.method='auto'
 ORDER BY r.seq,r.ord`,
	),
	exit: sql<{ decision: number }, Position>("SELECT id,seq,ord FROM results WHERE quarantine_exit=$decision LIMIT 1"),
	cover: sql<{ result: number; decision: number }>("UPDATE results SET quarantine_decision=$decision WHERE id=$result"),
	end: sql<{ result: number; decision: number }>(
		"UPDATE results SET quarantine_exit=$decision WHERE id=$result AND quarantine_exit IS NULL",
	),
};
type Position = Pick<ResultRow, "id" | "seq" | "ord">;
type TrunkResult = Position &
	Pick<ResultRow, "attempt" | "outcome" | "corrects"> & { commit_sha: string; lane: string };
export const quarantineEntries = (db: Db, project: number) => db.all(Q.entries, { project });
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
	return passExit(db, entry, exit.count) === null;
}

function passExit(db: Db, entry: Entry, count: number): Position | null {
	const ended = db.get(Q.exit, { decision: entry.decision });
	if (ended) return ended;
	const commits = new Map<string, { index: number; lanes: Set<string> }>();
	const lanes = new Map<string, Map<number, TrunkResult>>();
	const observations = new Map<number, TrunkResult>();
	const held = new Map<string, TrunkResult>();
	const clean: boolean[] = [];
	for (const row of db.all(Q.trunk, { project: entry.project, test: entry.test, since: entry.seq })) {
		let commit = commits.get(row.commit_sha);
		if (!commit) {
			commit = { index: commits.size, lanes: new Set() };
			commits.set(row.commit_sha, commit);
			clean.push(false);
		}
		commit.lanes.add(row.lane);
		const corrected = row.corrects === null ? null : observations.get(row.corrects);
		if (corrected) {
			const history = lanes.get(corrected.lane);
			history?.delete(corrected.id);
			held.delete(corrected.lane);
			for (const prior of history?.values() ?? []) {
				const current = held.get(prior.lane);
				if (!current || replacesInLane(current, prior)) held.set(prior.lane, prior);
			}
		}
		let history = lanes.get(row.lane);
		if (!history) {
			history = new Map();
			lanes.set(row.lane, history);
		}
		history.set(row.id, row);
		observations.set(row.id, row);
		const prior = held.get(row.lane);
		if (!prior || replacesInLane(prior, row)) held.set(row.lane, row);
		const { index } = commit;
		clean[index] = [...commit.lanes].every((lane) => {
			const result = held.get(lane);
			return !result || result.outcome === "pass";
		});
		if (!clean[index]) continue;
		let streak = 1;
		for (let i = index - 1; i >= 0 && clean[i] && streak < count; i--) streak++;
		for (let i = index + 1; i < clean.length && clean[i] && streak < count; i++) streak++;
		if (streak >= count) return row;
	}
	return null;
}

export function recordQuarantines(ctx: Ctx, results: readonly { id: number }[]): void {
	const entries = new Map(quarantineEntries(ctx.db, ctx.project.id).map((entry) => [entry.test, entry]));
	if (entries.size === 0) return;
	const exits = new Map<number, Position | null>();
	for (const { id } of results) {
		const result = resultById(ctx.db, id);
		if (result?.method !== "auto") continue;
		const entry = entries.get(result.test);
		if (!entry?.exit_rule || result.seq <= entry.seq) continue;
		const exit = ExitSchema.parse(json<unknown>(entry.exit_rule));
		if (exit.kind === "expiry" && result.at >= exit.at) continue;
		if (exit.kind === "passes") {
			if (!exits.has(entry.test)) {
				const ended = passExit(ctx.db, entry, exit.count);
				exits.set(entry.test, ended);
				if (ended) ctx.db.run(Q.end, { result: ended.id, decision: entry.decision });
			}
			const ended = exits.get(entry.test);
			if (ended && (result.seq > ended.seq || (result.seq === ended.seq && result.ord > ended.ord))) continue;
		}
		ctx.db.run(Q.cover, { result: id, decision: entry.decision });
	}
}

export function quarantineLookup(db: Db, project: number) {
	const present = quarantineEntries(db, project).length > 0;
	return (id: number) => {
		if (!present) return null;
		const result = resultById(db, id);
		if (result?.project !== project || result.quarantine_decision === null) return null;
		return {
			decision: result.quarantine_decision,
			class: "excused" as const,
			expires_at: null,
			quarantined: true,
		};
	};
}
