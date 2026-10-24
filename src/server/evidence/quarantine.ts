import type { QuarantineExit } from "../../core/flaky.ts";
import { QuarantineExit as ExitSchema } from "../../core/flaky.ts";
import type { Edit } from "../../core/ops.ts";
import { replacesInLane } from "../../core/runs.ts";
import type { Ctx } from "../kernel/ctx.ts";
import { json, type ReadDb, sql } from "../kernel/db.ts";
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
	exists: sql<{ project: number }, { n: number }>("SELECT 1 AS n FROM quarantines WHERE project=$project LIMIT 1"),
	entries: sql<{ project: number }, Entry>("SELECT * FROM quarantines WHERE project = $project ORDER BY test DESC"),
	write: sql<Entry>(`INSERT INTO quarantines (project, test, decision, actor, reason, exit_rule, at, seq)
 VALUES ($project,$test,$decision,$actor,$reason,$exit_rule,$at,$seq)
 ON CONFLICT (project,test) DO UPDATE SET decision=excluded.decision, actor=excluded.actor,
 reason=excluded.reason, exit_rule=excluded.exit_rule, at=excluded.at, seq=excluded.seq`),
	trunk: sql<{ project: number; test: number; since: number }, TrunkResult>(
		`SELECT t.commit_sha, format('%s:%s:%s:%s',r.target,b.job,r.actor,r.method) AS lane,
 r.id,r.corrects,r.attempt,r.outcome,r.seq,r.ord FROM results r JOIN targets t ON t.id=r.target JOIN batches b ON b.id=r.batch
 WHERE r.project=$project AND r.test=$test AND r.seq>$since AND t.line='trunk' AND t.commit_sha IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM targets initial JOIN results first ON first.target=initial.id
 WHERE initial.project=r.project AND initial.commit_sha=t.commit_sha AND first.test=r.test AND first.seq<=$since)
 AND r.method='auto'
 ORDER BY r.seq,r.ord`,
	),
	exit: sql<{ decision: number }, Position>("SELECT id,seq,ord FROM results WHERE quarantine_exit=$decision LIMIT 1"),
	results: sql<{ ids: readonly number[] }, ResultRow>("SELECT * FROM results WHERE id=ANY($ids::bigint[])"),
	cover: sql<{ results: readonly number[]; decisions: readonly number[] }>(
		"UPDATE results r SET quarantine_decision=u.decision FROM unnest($results::bigint[],$decisions::bigint[]) AS u(result,decision) WHERE r.id=u.result",
	),
	end: sql<{ result: number; decision: number }>(
		"UPDATE results SET quarantine_exit=$decision WHERE id=$result AND quarantine_exit IS NULL",
	),
};
type Position = Pick<ResultRow, "id" | "seq" | "ord">;
type TrunkResult = Position &
	Pick<ResultRow, "attempt" | "outcome" | "corrects"> & { commit_sha: string; lane: string };
export const quarantineEntries = async (db: ReadDb, project: number) => await db.all(Q.entries, { project });
export const quarantineEntry = async (db: ReadDb, project: number, test: number) =>
	await db.get(Q.entry, { project, test });

export async function validateQuarantineEdit(ctx: Ctx, edit: Extract<Edit, { op: "quarantine" }>) {
	const test = await findTest(ctx.db, ctx.project.id, edit.test);
	if (!test) throw notFound(`test ${edit.test}`);
	if (test.kind !== "auto") throw invalid("only an automated test can be quarantined");
	const prior = await quarantineEntry(ctx.db, ctx.project.id, test.id);
	if ((prior?.decision ?? null) !== edit.base)
		throw conflict("quarantine changed; read the test and propose on its current decision");
	if (edit.exit?.kind === "expiry" && edit.exit.at <= ctx.now) throw invalid("quarantine expiry must be in the future");
	return test;
}
export async function setQuarantine(
	ctx: Ctx,
	witness: Witness,
	input: { test: number; exit: QuarantineExit | null; reason: string },
): Promise<void> {
	const decision = decisionOf(witness, "adopt");
	await ctx.db.run(Q.write, {
		project: ctx.project.id,
		test: input.test,
		decision,
		actor: ctx.actor.id,
		reason: input.reason,
		exit_rule: input.exit === null ? null : JSON.stringify(input.exit),
		at: ctx.now,
		seq: ctx.seq,
	});
	const test = await testById(ctx.db, input.test);
	if (test) ctx.touched.add(`T-${test.no}`);
}

export async function effectiveQuarantine(db: ReadDb, entry: Entry, now: number): Promise<boolean> {
	if (entry.exit_rule === null) return false;
	const exit = ExitSchema.parse(json<unknown>(entry.exit_rule));
	if (exit.kind === "person") return true;
	if (exit.kind === "expiry") return now < exit.at;
	return (await passExit(db, entry, exit.count)) === null;
}

async function passExit(db: ReadDb, entry: Entry, count: number): Promise<Position | null> {
	const ended = await db.get(Q.exit, { decision: entry.decision });
	if (ended) return ended;
	const commits = new Map<string, { index: number; lanes: Set<string> }>();
	const lanes = new Map<string, Map<number, TrunkResult>>();
	const observations = new Map<number, TrunkResult>();
	const held = new Map<string, TrunkResult>();
	const clean: boolean[] = [];
	for (const row of await db.all(Q.trunk, { project: entry.project, test: entry.test, since: entry.seq })) {
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

export async function recordQuarantines(ctx: Ctx, results: readonly { id: number }[]): Promise<void> {
	const entries = new Map((await quarantineEntries(ctx.db, ctx.project.id)).map((entry) => [entry.test, entry]));
	if (entries.size === 0) return;
	const exits = new Map<number, Position | null>();
	const covered: number[] = [],
		decisions: number[] = [];
	for (let start = 0; start < results.length; start += 200) {
		const rows = new Map(
			(await ctx.db.all(Q.results, { ids: results.slice(start, start + 200).map((result) => result.id) })).map(
				(result) => [result.id, result],
			),
		);
		for (const { id } of results.slice(start, start + 200)) {
			const result = rows.get(id);
			if (result?.method !== "auto") continue;
			const entry = entries.get(result.test);
			if (!entry?.exit_rule || result.seq <= entry.seq) continue;
			const exit = ExitSchema.parse(json<unknown>(entry.exit_rule));
			if (exit.kind === "expiry" && result.at >= exit.at) continue;
			if (exit.kind === "passes") {
				if (!exits.has(entry.test)) {
					const ended = await passExit(ctx.db, entry, exit.count);
					exits.set(entry.test, ended);
					if (ended) await ctx.db.run(Q.end, { result: ended.id, decision: entry.decision });
				}
				const ended = exits.get(entry.test);
				if (ended && (result.seq > ended.seq || (result.seq === ended.seq && result.ord > ended.ord))) continue;
			}
			covered.push(id);
			decisions.push(entry.decision);
		}
	}
	if (covered.length) await ctx.db.run(Q.cover, { results: covered, decisions });
}

export async function quarantineLookup(db: ReadDb, project: number) {
	const present = (await db.get(Q.exists, { project })) !== null;
	return async (id: number) => {
		if (!present) return null;
		const result = await resultById(db, id);
		if (result?.project !== project || result.quarantine_decision === null) return null;
		return {
			decision: result.quarantine_decision,
			class: "excused" as const,
			expires_at: null,
			quarantined: true,
		};
	};
}
