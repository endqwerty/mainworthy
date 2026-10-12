// Runs: requests for evidence. Owns runs, run_tests, slots, slot_results and depends_on.
//
// A run does not own results. It says which targets count and what it needs; results from any producer fill it
// when the acceptance rule admits them (core/runs.ts). This module keeps each run's projections (slot states, tally,
// verdict) in step with the facts, in the transaction that changes them.
import type { Policy } from "../../core/kinds.ts";
import type { CaseBody, MethodKind } from "../../core/model.ts";
import type { GateStatus } from "../../core/ops.ts";
import {
	aggregateSlot,
	type ExerciseObligation,
	emptyTally,
	explainVerdict,
	type Obligation,
	qualifies,
	replacesInLane,
	type SlotState,
	slotState,
	type Tally,
	type TargetMatch,
	type Verdict,
	verdict,
} from "../../core/runs.ts";
import {
	type Applied,
	type BatchRow,
	batchById,
	changeById,
	changeByKey,
	codeWhat,
	excuseFor,
	laneHistory,
	mustTarget,
	processedJobs,
	resultById,
	resultsOfCaseOnTargets,
	type SignatureRow,
	SLICE,
	scopeOf,
	signatureById,
	type TargetRow,
	type TestRow,
	targetByCommit,
	targetsOfCommit,
	targetsWithCommit,
	testById,
} from "../evidence/evidence.ts";
import { type Ctx, ref } from "../kernel/ctx.ts";
import { type Db, json, sql } from "../kernel/db.ts";
import { invalid, notFound } from "../kernel/errors.ts";
import { decisionOf, type Witness } from "../kernel/witness.ts";
import { type CaseRow, versionOf } from "../suite/suite.ts";

export type RunRow = {
	id: number;
	project: number;
	no: number;
	name: string;
	origin: "change" | "planned";
	accepts: string;
	accepts_what: string | null;
	/** For a change run: the scope its failures are answered in. Null for a planned run, whose scope is derived. */
	scope: string | null;
	require: string;
	change: number | null;
	state: "open" | "closed";
	signoff: number | null;
	accepted_seq: number;
	applied_seq: number;
	outstanding: number;
	next_expiry: number | null;
	tally: string;
	blocking: string;
	verdict: Verdict;
	created_by: number;
	created_at: number;
	rev: number;
};
export type SlotRow = {
	id: number;
	run: number;
	case_id: number;
	version: number;
	claim: string;
	obligation: string;
	assignee: number | null;
	rank: number;
	agg: string;
	state: SlotState;
	/** The first cause's signature, kept as a column for display. */
	signature: number | null;
	/** Every cause currently failing in the slot, as a JSON list of [signature id, target id] pairs. */
	causes: string;
	waiver: number | null;
	rev: number;
};

const Q = {
	byNo: sql<{ project: number; no: number }, RunRow>("SELECT * FROM runs WHERE project = $project AND no = $no"),
	byId: sql<{ id: number }, RunRow>("SELECT * FROM runs WHERE id = $id"),
	changeRun: sql<{ project: number; what: string }, RunRow>(
		"SELECT * FROM runs WHERE project = $project AND origin = 'change' AND accepts_what = $what",
	),
	openPlanned: sql<{ project: number }, RunRow>(
		"SELECT * FROM runs WHERE project = $project AND state = 'open' AND origin = 'planned'",
	),
	recent: sql<{ project: number; origin: string; before: number; limit: number }, RunRow>(
		"SELECT * FROM runs WHERE project = $project AND origin = $origin AND id < $before ORDER BY id DESC LIMIT $limit",
	),
	insert: sql<{
		project: number;
		no: number;
		name: string;
		origin: string;
		accepts: string;
		what: string | null;
		scope: string | null;
		require: string;
		change: number | null;
		tally: string;
		verdict: string;
		actor: number;
		at: number;
		rev: number;
	}>(
		`INSERT INTO runs (project, no, name, origin, accepts, accepts_what, scope, require, change, tally, verdict, created_by, created_at, rev)
		 VALUES ($project, $no, $name, $origin, $accepts, $what, $scope, $require, $change, $tally, $verdict, $actor, $at, $rev)`,
	),
	accepted: sql<{ id: number; seq: number }>(
		"UPDATE runs SET outstanding = outstanding + 1, accepted_seq = $seq, rev = $seq WHERE id = $id",
	),
	applied: sql<{ id: number; seq: number; rev: number }>(
		"UPDATE runs SET outstanding = max(outstanding - 1, 0), applied_seq = max(applied_seq, $seq), rev = $rev WHERE id = $id",
	),
	project: sql<{ id: number; tally: string; blocking: string; verdict: string; expiry: number | null; rev: number }>(
		"UPDATE runs SET tally = $tally, blocking = $blocking, verdict = $verdict, next_expiry = $expiry, rev = $rev WHERE id = $id",
	),
	setState: sql<{ id: number; state: string; signoff: number | null; rev: number }>(
		"UPDATE runs SET state = $state, signoff = $signoff, rev = $rev WHERE id = $id",
	),
	upsertRunTest: sql<{
		run: number;
		test: number;
		result: number;
		outcome: string;
		signature: number | null;
		attempt: number;
		flipped: number;
		lane: string;
		target: number;
	}>(
		`INSERT INTO run_tests (run, test, result, outcome, signature, attempt, flipped, lane, target)
		 VALUES ($run, $test, $result, $outcome, $signature, $attempt, $flipped, $lane, $target)
		 ON CONFLICT (run, test, lane) DO UPDATE SET result = excluded.result, outcome = excluded.outcome, signature = excluded.signature,
		   attempt = excluded.attempt, flipped = max(run_tests.flipped, excluded.flipped)
		 WHERE (excluded.attempt > run_tests.attempt
		        AND NOT (excluded.outcome IN ('skip', 'blocked') AND run_tests.outcome IN ('pass', 'fail', 'error')))
		    OR (excluded.attempt = run_tests.attempt
		        AND (CASE excluded.outcome WHEN 'fail' THEN 3 WHEN 'error' THEN 3 WHEN 'pass' THEN 2 WHEN 'blocked' THEN 1 ELSE 0 END)
		         >= (CASE run_tests.outcome WHEN 'fail' THEN 3 WHEN 'error' THEN 3 WHEN 'pass' THEN 2 WHEN 'blocked' THEN 1 ELSE 0 END))`,
	),
	runTestGroups: sql<{ run: number }, { outcome: string; signature: number | null; target: number; n: number }>(
		"SELECT outcome, signature, target, count(*) AS n FROM run_tests WHERE run = $run GROUP BY outcome, signature, target",
	),
	runTests: sql<
		{ run: number; outcome: string; limit: number },
		{ test: number; result: number; outcome: string; signature: number | null; flipped: number }
	>(
		"SELECT test, result, outcome, signature, flipped FROM run_tests WHERE run = $run AND outcome = $outcome LIMIT $limit",
	),
	failingRunTests: sql<
		{ run: number; limit: number },
		{ test: number; result: number; outcome: string; signature: number | null; flipped: number }
	>(
		"SELECT test, result, outcome, signature, flipped FROM run_tests WHERE run = $run AND outcome IN ('fail', 'error') LIMIT $limit",
	),
	failingCauses: sql<{ run: number }, { signature: number; target: number }>(
		`SELECT DISTINCT signature, target FROM run_tests
		 WHERE run = $run AND outcome IN ('fail', 'error') AND signature IS NOT NULL`,
	),
	failingWithCause: sql<{ run: number; signature: number }, { test: number }>(
		`SELECT DISTINCT test FROM run_tests
		 WHERE run = $run AND signature = $signature AND outcome IN ('fail', 'error')`,
	),
	failingOfCause: sql<{ run: number; signature: number; target: number }, { test: number; result: number }>(
		`SELECT test, result FROM run_tests
		 WHERE run = $run AND signature = $signature AND target = $target AND outcome IN ('fail', 'error') LIMIT 200`,
	),
	flippedCount: sql<{ run: number }, { n: number }>(
		"SELECT count(*) AS n FROM run_tests WHERE run = $run AND flipped = 1",
	),
	laneRow: sql<{ run: number; test: number; lane: string }, { result: number; flipped: number }>(
		"SELECT result, flipped FROM run_tests WHERE run = $run AND test = $test AND lane = $lane",
	),
	dropLane: sql<{ run: number; test: number; lane: string }>(
		"DELETE FROM run_tests WHERE run = $run AND test = $test AND lane = $lane",
	),
	// A result judged a mistake is discounted in every slot it is admitted to, by the decision that judged it.
	judgedBy: sql<{ result: number }, { decision: number }>(
		"SELECT discounted_by AS decision FROM slot_results WHERE result = $result AND discounted_by IS NOT NULL LIMIT 1",
	),
	discountedBy: sql<{ decision: number }, { slot: number; result: number }>(
		"SELECT slot, result FROM slot_results WHERE discounted_by = $decision",
	),
	discountsOfRun: sql<{ run: number }, { decision: number }>(
		"SELECT DISTINCT discounted_by AS decision FROM slot_results WHERE run = $run AND discounted_by IS NOT NULL",
	),
	effectiveOfTest: sql<{ run: number; test: number }, { outcome: string; signature: number | null }>(
		"SELECT outcome, signature FROM run_tests WHERE run = $run AND test = $test",
	),
	newestRunWithTest: sql<{ project: number; scope: string; test: number }, { run: number | null }>(
		`SELECT max(rt.run) AS run FROM run_tests rt JOIN runs r ON r.id = rt.run
		 WHERE rt.test = $test AND r.project = $project AND r.scope = $scope`,
	),
	insertSlot: sql<{
		run: number;
		caseId: number;
		version: number;
		claim: string;
		obligation: string;
		assignee: number | null;
		rank: number;
		rev: number;
	}>(
		`INSERT INTO slots (run, case_id, version, claim, obligation, assignee, rank, rev)
		 VALUES ($run, $caseId, $version, $claim, $obligation, $assignee, $rank, $rev)`,
	),
	slotsOfCase: sql<{ caseId: number }, SlotRow>("SELECT * FROM slots WHERE case_id = $caseId"),
	slotsOfRun: sql<{ run: number; after: number; limit: number }, SlotRow>(
		"SELECT * FROM slots WHERE run = $run AND rank > $after ORDER BY rank LIMIT $limit",
	),
	slotById: sql<{ id: number }, SlotRow>("SELECT * FROM slots WHERE id = $id"),
	slotGroups: sql<{ run: number }, { state: SlotState; n: number }>(
		"SELECT state, count(*) AS n FROM slots WHERE run = $run AND state NOT IN ('failing', 'disputed') GROUP BY state",
	),
	failingSlots: sql<{ run: number }, { id: number; state: SlotState; causes: string }>(
		"SELECT id, state, causes FROM slots WHERE run = $run AND state IN ('failing', 'disputed')",
	),
	slotCount: sql<{ run: number }, { n: number }>("SELECT count(*) AS n FROM slots WHERE run = $run"),
	pinned: sql<{ run: number }, { case_id: number; version: number }>(
		"SELECT case_id, version FROM slots WHERE run = $run",
	),
	updateSlot: sql<{
		id: number;
		agg: string;
		state: string;
		signature: number | null;
		causes: string;
		rev: number;
	}>(
		"UPDATE slots SET agg = $agg, state = $state, signature = $signature, causes = $causes, rev = $rev WHERE id = $id",
	),
	admit: sql<{ slot: number; result: number; run: number; admitted: string }>(
		"INSERT OR IGNORE INTO slot_results (slot, result, run, admitted) VALUES ($slot, $result, $run, $admitted)",
	),
	correctInSlot: sql<{ slot: number; result: number }>(
		"UPDATE slot_results SET corrected = 1 WHERE slot = $slot AND result = $result",
	),
	discount: sql<{ slot: number; result: number; decision: number }>(
		"UPDATE slot_results SET discounted_by = $decision WHERE slot = $slot AND result = $result",
	),
	undiscount: sql<{ slot: number; result: number; decision: number }>(
		"UPDATE slot_results SET discounted_by = NULL WHERE slot = $slot AND result = $result AND discounted_by = $decision",
	),
	slotsOfResult: sql<{ result: number }, { slot: number }>("SELECT slot FROM slot_results WHERE result = $result"),
	admittedTo: sql<{ slot: number }, { result: number; admitted: string }>(
		"SELECT result, admitted FROM slot_results WHERE slot = $slot AND corrected = 0 AND discounted_by IS NULL",
	),
	newestChangeRun: sql<{ project: number; scope: string }, { id: number | null }>(
		"SELECT max(id) AS id FROM runs WHERE project = $project AND scope = $scope",
	),
	failingSlotRows: sql<{ run: number }, SlotRow>(
		"SELECT * FROM slots WHERE run = $run AND state IN ('failing', 'disputed') ORDER BY rank",
	),
	slotsBySignature: sql<{ run: number; signature: number }, SlotRow>(
		`SELECT * FROM slots WHERE run = $run AND state IN ('failing', 'disputed')
		 AND EXISTS (SELECT 1 FROM json_each(slots.causes) WHERE json_extract(value, '$[0]') = $signature)`,
	),
	clearDepends: sql<{ run: number }>("DELETE FROM depends_on WHERE run = $run"),
	depend: sql<{ run: number; decision: number; expires: number | null }>(
		"INSERT OR IGNORE INTO depends_on (run, decision, expires_at) VALUES ($run, $decision, $expires)",
	),
	dependents: sql<{ decision: number }, { run: number }>("SELECT run FROM depends_on WHERE decision = $decision"),
};

export const runRef = (row: { no: number }): string => ref("run", row.no);
export const runById = (db: Db, id: number): RunRow | null => db.get(Q.byId, { id });
export function findRun(db: Db, project: number, text: string): RunRow | null {
	const match = /^(?:R-)?(\d+)$/i.exec(text.trim());
	return match ? db.get(Q.byNo, { project, no: Number(match[1]) }) : null;
}
export function mustRun(db: Db, project: number, text: string): RunRow {
	const row = findRun(db, project, text);
	if (!row) throw notFound(`run ${text}`);
	return row;
}
export const recentRuns = (
	db: Db,
	project: number,
	origin: "change" | "planned",
	before: number,
	limit: number,
): RunRow[] => db.all(Q.recent, { project, origin, before, limit });
export const slotById = (db: Db, id: number): SlotRow | null => db.get(Q.slotById, { id });
export const slotsPage = (db: Db, run: number, after: number, limit: number): SlotRow[] =>
	db.all(Q.slotsOfRun, { run, after, limit });
export const slotCount = (db: Db, run: number): number => db.get(Q.slotCount, { run })?.n ?? 0;
export type Fill = {
	id: number;
	actor: number;
	test: number;
	attempt: number;
	outcome: string;
	seq: number;
	ord: number;
	signature: number | null;
	target: number;
	/** The job that reported it. With the target it is the lane a result belongs to. */
	job: string;
	method: MethodKind;
	admitted: string;
	at: number;
	note: string | null;
	message: string | null;
};

/** The uncorrected results admitted to a slot, oldest first. Results are read through their owner, evidence. */
export function fillsOf(db: Db, slot: number): Fill[] {
	const fills: Fill[] = [];
	const jobs = new Map<number, string>();
	const jobOf = (batch: number): string => {
		let job = jobs.get(batch);
		if (job === undefined) {
			job = batchById(db, batch)?.job ?? "";
			jobs.set(batch, job);
		}
		return job;
	};
	for (const row of db.all(Q.admittedTo, { slot })) {
		const result = resultById(db, row.result);
		if (!result) continue;
		fills.push({
			id: result.id,
			actor: result.actor,
			test: result.test,
			attempt: result.attempt,
			outcome: result.outcome,
			seq: result.seq,
			ord: result.ord,
			signature: result.signature,
			target: result.target,
			job: jobOf(result.batch),
			method: result.method,
			admitted: row.admitted,
			at: result.at,
			note: result.note,
			message: result.message,
		});
	}
	return fills.sort((a, b) => a.seq - b.seq || a.ord - b.ord);
}
export const failingTestsOf = (db: Db, run: number, limit: number) => db.all(Q.failingRunTests, { run, limit });
export const runTestsWith = (db: Db, run: number, outcome: string, limit: number) =>
	db.all(Q.runTests, { run, outcome, limit });
export const flippedIn = (db: Db, run: number): number => db.get(Q.flippedCount, { run })?.n ?? 0;
/** Whether a change run holds a passing result for any of these tests: the evidence that a failure stopped. */
export function passesAny(db: Db, run: number, tests: readonly number[]): boolean {
	if (tests.length === 0) return false;
	const rows = db.allDynamic<{ n: number }>(
		`SELECT 1 AS n FROM run_tests WHERE run = ? AND outcome = 'pass' AND test IN (${tests.map(() => "?").join(", ")}) LIMIT 1`,
		[run, ...tests],
	);
	return rows.length > 0;
}
export const runsDependingOn = (db: Db, decision: number): number[] =>
	db.all(Q.dependents, { decision }).map((r) => r.run);

/** The version each case is pinned to in a run. A result typed into the run is exact at that version. */
export function pinnedVersions(db: Db, run: number): Map<number, number> {
	return new Map(db.all(Q.pinned, { run }).map((row) => [row.case_id, row.version]));
}

const obligationsOf = (run: RunRow): Obligation[] => json<Obligation[]>(run.require);
const acceptsOf = (run: RunRow): TargetMatch => json<TargetMatch>(run.accepts);

// ── Which runs a target matters to ─────────────────────────────────────────────────────────────────────────

/** The run that gates a commit, created the first time anything is reported for it. */
export function ensureChangeRun(ctx: Ctx, target: TargetRow): RunRow | null {
	if (target.line === "session" || target.commit_sha === null) return null;
	const found = ctx.db.get(Q.changeRun, { project: ctx.project.id, what: target.what });
	if (found) return found;
	const change = target.change !== null ? changeById(ctx.db, target.change) : null;
	const where = change ? change.key : (target.branch ?? target.line);
	const no = ctx.nextNo("run");
	const { lastId } = ctx.db.run(Q.insert, {
		project: ctx.project.id,
		no,
		name: `${target.commit_sha.slice(0, 7)} on ${where}`,
		origin: "change",
		accepts: JSON.stringify({ commit: target.commit_sha, ...(target.repo ? { repo: target.repo } : {}) }),
		what: target.what,
		scope: scopeOf(target, null),
		require: "[]",
		change: target.change,
		tally: JSON.stringify(emptyTally()),
		verdict: "pending",
		actor: ctx.actor.id,
		at: ctx.now,
		rev: ctx.seq,
	});
	ctx.touched.add(ref("run", no));
	return runById(ctx.db, lastId);
}

/**
 * Does this run count results on this target? A run that accepts a commit counts that commit (and repository and
 * environment, where it names them) and nothing else, whether or not the result was typed into it: naming a run
 * does not make evidence about another build count for it. A `self` run counts only what is typed into it.
 */
function matches(run: RunRow, target: TargetRow, typedInto: number | null): boolean {
	const accepts = acceptsOf(run);
	if ("self" in accepts) return typedInto === run.id;
	if (target.commit_sha === null) return false;
	const sameCommit = target.commit_sha === accepts.commit || target.commit_sha.startsWith(accepts.commit);
	return (
		sameCommit &&
		(accepts.repo === undefined || accepts.repo === target.repo) &&
		(accepts.env === undefined || accepts.env === target.env)
	);
}

/** Every run a batch on this target counts toward: the commit's change run, and each planned run that accepts it. */
export function runsFor(ctx: Ctx, target: TargetRow, typedInto: number | null): RunRow[] {
	const out: RunRow[] = [];
	const change = ensureChangeRun(ctx, target);
	if (change) out.push(change);
	for (const run of ctx.db.all(Q.openPlanned, { project: ctx.project.id })) {
		if (matches(run, target, typedInto)) out.push(run);
	}
	return out;
}

/** Whether a result typed into this run on this target would count for it. The report is refused when not. */
export const runAccepts = (run: RunRow, target: TargetRow): boolean =>
	run.origin === "change" ? run.accepts_what === target.what : matches(run, target, run.id);

/** What a run counts, in words, for the refusal. */
export function describeAccepts(run: RunRow): string {
	const accepts = acceptsOf(run);
	if ("self" in accepts) return "only results recorded in it";
	const more = [accepts.repo, accepts.env].filter((part) => part !== undefined);
	return `commit ${accepts.commit}${more.length > 0 ? ` (${more.join(", ")})` : ""}`;
}

/**
 * The targets a run that accepts a commit counts: one per environment reported for it, and for a planned run that
 * names no repository, one per repository that has that commit.
 */
function targetsOfRun(db: Db, run: RunRow): TargetRow[] {
	const accepts = acceptsOf(run);
	if (!("commit" in accepts)) return [];
	if (run.origin === "change") return run.accepts_what ? targetsOfCommit(db, run.project, run.accepts_what) : [];
	return targetsWithCommit(db, run.project, accepts.commit).filter((target) => matches(run, target, null));
}

/** Acceptance: the report is durable but not applied, so each run it matters to reads `pending` until it is. */
export function noteAccepted(ctx: Ctx, runs: readonly RunRow[], batchSeq: number): void {
	for (const run of runs) {
		ctx.db.run(Q.accepted, { id: run.id, seq: batchSeq });
		ctx.touched.add(runRef(run));
	}
}

// ── Applying a batch ───────────────────────────────────────────────────────────────────────────────────────

/** Failures with one cause in one scope: what a `failure` question is about. */
export type FailingGroup = {
	signature: SignatureRow;
	scope: string;
	tests: TestRow[];
	results: number[];
	message: string | null;
	disputed: boolean;
	/** True when a result that counts in a commit's gate (a pipeline's or a person's) shows this cause. */
	counted: boolean;
	runs: RunRow[];
};

/**
 * Folds an applied batch into every run it counts toward: the effective result per test of a change run, and the
 * slots of planned runs. Returns the failures grouped by cause, for the caller to raise as questions.
 */
export function* applyBatchSteps(
	ctx: Ctx,
	input: { batch: BatchRow; target: TargetRow; applied: readonly Applied[]; runs: readonly RunRow[] },
): Generator<undefined, FailingGroup[], void> {
	const { batch, target, applied, runs } = input;
	const scope = scopeOf(target, batch.run);
	const groups = new Map<number, FailingGroup>();
	const group = (signature: SignatureRow): FailingGroup => {
		let found = groups.get(signature.id);
		if (!found) {
			found = { signature, scope, tests: [], results: [], message: null, disputed: false, counted: false, runs: [] };
			groups.set(signature.id, found);
		}
		return found;
	};

	const changeRun = runs.find((run) => run.origin === "change") ?? null;
	const planned = runs.filter((run) => run.origin === "planned");
	const plannedIds = new Set(planned.map((run) => run.id));
	const touchedSlots = new Map<number, SlotRow>();
	const declared = new Map<string, MethodKind[]>();
	// One lane per target, job and producer: a newer attempt in a lane replaces the one before it, and nothing
	// from another lane (another job, another environment, another producer) can.
	const lane = `${batch.target}:${batch.job}:${batch.actor}`;
	let folded = 0;
	for (const result of applied) {
		if (folded++ > 0 && folded % SLICE === 0) yield;
		// A commit's gate counts what pipelines and people report. An agent's result is recorded and shown, and
		// counts only in a planned run that asked for agents (decision 0009): never in a change run.
		const counted = result.method !== "agent";
		if (changeRun && counted) {
			// A correction withdraws the result it names: the lane it was in is folded again without it, so the
			// attempt before it stands again if the correction does not take its place.
			if (result.corrects !== null) refoldLaneOf(ctx, changeRun, result.corrects);
			ctx.db.run(Q.upsertRunTest, {
				run: changeRun.id,
				test: result.test.id,
				result: result.id,
				outcome: result.outcome,
				signature: result.signature?.id ?? null,
				attempt: result.attempt,
				flipped: result.flipped ? 1 : 0,
				lane,
				target: batch.target,
			});
		}
		if (result.corrects !== null) {
			// A correction reaches the open runs this batch counts toward. A closed run keeps what it was closed on.
			for (const { slot } of ctx.db.all(Q.slotsOfResult, { result: result.corrects })) {
				const row = slotById(ctx.db, slot);
				if (!row || !plannedIds.has(row.run)) continue;
				ctx.db.run(Q.correctInSlot, { slot, result: result.corrects });
				touchedSlots.set(slot, row);
			}
		}
		if (result.basisCase !== null && planned.length > 0) {
			for (const slot of ctx.db.all(Q.slotsOfCase, { caseId: result.basisCase })) {
				if (!plannedIds.has(slot.run)) continue;
				const run = planned.find((r) => r.id === slot.run);
				const obligation = run ? obligationsOf(run).find((o) => o.id === slot.obligation) : undefined;
				if (!run || obligation?.kind !== "exercise") continue;
				const admitted = qualifies({
					result: {
						method: result.method,
						basis: result.basis,
						basisCase: result.basisCase,
						basisVersion: result.basisVersion,
						basisClaim: result.basisClaim,
					},
					slot: { caseId: slot.case_id, version: slot.version, claim: slot.claim },
					obligation,
					caseMethods: methodsOf(ctx.db, slot, result, declared),
				});
				if (!admitted) continue;
				ctx.db.run(Q.admit, { slot: slot.id, result: result.id, run: run.id, admitted });
				touchedSlots.set(slot.id, slot);
			}
		}
		if (result.signature && (result.outcome === "fail" || result.outcome === "error")) {
			const g = group(result.signature);
			if (!g.tests.some((t) => t.id === result.test.id)) g.tests.push(result.test);
			g.results.push(result.id);
			g.message ??= result.message;
			g.counted ||= counted;
		}
	}

	// Rebuild every slot the batch touched from its complete admitted set, and note the ones now in dispute.
	for (const slot of touchedSlots.values()) {
		const run = planned.find((r) => r.id === slot.run) ?? runById(ctx.db, slot.run);
		if (!run) continue;
		const obligation = obligationsOf(run).find((o) => o.id === slot.obligation);
		const next = refreshSlot(ctx, slot, obligation?.kind === "exercise" ? obligation : null);
		if (next.state !== "disputed" && next.state !== "failing") continue;
		// Every cause failing in the slot is its own question: answering one does not answer the others. Only the
		// causes seen in this batch's scope are this batch's to ask about; one seen in another repository has its
		// own question there.
		const here = next.causes.filter(([, seenOn]) => scopeOf(mustTarget(ctx.db, seenOn), batch.run) === scope);
		for (const id of new Set(here.map(([cause]) => cause))) {
			const signature = signatureById(ctx.db, id);
			if (!signature) continue;
			const g = group(signature);
			g.disputed ||= next.state === "disputed";
			if (!g.runs.some((r) => r.id === run.id)) g.runs.push(run);
		}
	}

	if (changeRun) {
		for (const g of groups.values()) {
			// Only a failure the gate counts holds the commit's run. An agent's failure is asked about and holds nothing.
			if (g.counted && !g.runs.some((r) => r.id === changeRun.id)) g.runs.push(changeRun);
		}
	}
	for (const run of runs) {
		ctx.db.run(Q.applied, { id: run.id, seq: batch.seq, rev: ctx.seq });
		ctx.touched.add(runRef(run));
	}
	return [...groups.values()].filter((g) => g.runs.length > 0 || g.results.length > 0);
}

/**
 * The failures a run's slots show right now, grouped by cause, with the target and producer of the latest one.
 * For a run planned over evidence that already fails: its failures are put to the queue through the same door
 * as a report's, so an existing question takes the run on and a decision about the cause reaches it.
 */
export function failuresShown(ctx: Ctx, run: RunRow): { group: FailingGroup; target: number; by: number }[] {
	const out = new Map<string, { group: FailingGroup; target: number; by: number }>();
	for (const slot of ctx.db.all(Q.failingSlotRows, { run: run.id })) {
		const fills = fillsOf(ctx.db, slot.id);
		for (const [cause, seenOn] of json<Cause[]>(slot.causes)) {
			const signature = signatureById(ctx.db, cause);
			if (!signature) continue;
			// Each cause is asked about in the scope of the target it was seen on.
			const scope = scopeIn(ctx.db, run, seenOn);
			const key = causeKey(cause, scope);
			let entry = out.get(key);
			for (const fill of fills) {
				if (fill.signature !== cause || fill.target !== seenOn) continue;
				if (fill.outcome !== "fail" && fill.outcome !== "error") continue;
				entry ??= {
					group: {
						signature,
						scope,
						tests: [],
						results: [],
						message: null,
						disputed: false,
						counted: true,
						runs: [run],
					},
					target: fill.target,
					by: fill.actor,
				};
				const test = testById(ctx.db, fill.test);
				if (test && !entry.group.tests.some((t) => t.id === test.id)) entry.group.tests.push(test);
				entry.group.results.push(fill.id);
				entry.group.message ??= fill.message;
				entry.group.disputed ||= slot.state === "disputed";
				entry.target = fill.target;
				entry.by = fill.actor;
			}
			if (entry) out.set(key, entry);
		}
	}
	return [...out.values()];
}

/** The tests that fail with this cause in the gate of this target's commit, as it counts them now. */
export function failingWithCause(db: Db, target: TargetRow, signature: number): number[] {
	const commit = db.get(Q.changeRun, { project: target.project, what: target.what });
	return commit ? db.all(Q.failingWithCause, { run: commit.id, signature }).map((row) => row.test) : [];
}

/** A failure a run shows with no excuse in force: the cause, the target it was seen on, the scope it is answered in. */
export type Unexplained = { signature: number; target: number; scope: string };

/**
 * The failures a run shows that no decision explains, one per cause and target. Read when a run is recomputed, to
 * make sure each of them has a question somebody can answer.
 */
export function unexplainedShown(db: Db, run: RunRow): Unexplained[] {
	const shown = new Map<string, Unexplained>();
	const note = (signature: number, target: number): void => {
		const scope = scopeIn(db, run, target);
		if (!excuseFor(db, run.project, signature, scope, target))
			shown.set(`${signature}:${target}`, { signature, target, scope });
	};
	if (run.origin === "change") {
		for (const row of db.all(Q.failingCauses, { run: run.id })) note(row.signature, row.target);
	} else {
		for (const slot of db.all(Q.failingSlots, { run: run.id })) {
			for (const [signature, target] of json<Cause[]>(slot.causes)) note(signature, target);
		}
	}
	return [...shown.values()];
}

/**
 * One cause on one target as a run shows it now, in the shape a question is raised from: its tests, its results
 * and who reported the latest of them. Null when the run no longer shows it.
 */
export function shownFailure(ctx: Ctx, run: RunRow, cause: Unexplained): { group: FailingGroup; by: number } | null {
	const signature = signatureById(ctx.db, cause.signature);
	if (!signature) return null;
	const group: FailingGroup = {
		signature,
		scope: cause.scope,
		tests: [],
		results: [],
		message: null,
		disputed: false,
		counted: true,
		runs: [run],
	};
	let by: number | null = null;
	const add = (test: number, result: number, actor: number, message: string | null): void => {
		const row = testById(ctx.db, test);
		if (row && !group.tests.some((t) => t.id === row.id)) group.tests.push(row);
		group.results.push(result);
		group.message ??= message;
		by = actor;
	};
	if (run.origin === "change") {
		for (const row of ctx.db.all(Q.failingOfCause, { run: run.id, signature: cause.signature, target: cause.target })) {
			const result = resultById(ctx.db, row.result);
			if (result) add(row.test, result.id, result.actor, result.message);
		}
	} else {
		for (const slot of ctx.db.all(Q.slotsBySignature, { run: run.id, signature: cause.signature })) {
			for (const fill of fillsOf(ctx.db, slot.id)) {
				if (fill.signature !== cause.signature || fill.target !== cause.target) continue;
				if (fill.outcome !== "fail" && fill.outcome !== "error") continue;
				add(fill.test, fill.id, fill.actor, fill.message);
				group.disputed ||= slot.state === "disputed";
			}
		}
	}
	return by === null ? null : { group, by };
}

/** `applyBatchSteps` run to the end without pausing. */
export function applyBatch(
	ctx: Ctx,
	input: { batch: BatchRow; target: TargetRow; applied: readonly Applied[]; runs: readonly RunRow[] },
): FailingGroup[] {
	const steps = applyBatchSteps(ctx, input);
	for (let step = steps.next(); ; step = steps.next()) if (step.done) return step.value;
}

/**
 * The methods a slot's case admits for this result, read from the version the slot pinned: a later edit that
 * admits agents does not let one fill a run that pinned the version before it. A person's and an agent's
 * eligibility are declared on the case. A linked or annotated test is eligible because a decision or the test
 * itself tied it to the case; whether a test may fill a given slot is then the obligation's choice (it lists
 * `auto` or it does not).
 */
function methodsOf(
	db: Db,
	slot: Pick<SlotRow, "case_id" | "version">,
	result: { method: MethodKind },
	cache: Map<string, MethodKind[]> = new Map(),
): MethodKind[] {
	const key = `${slot.case_id}@${slot.version}`;
	let declared = cache.get(key);
	if (!declared) {
		const pinned = versionOf(db, slot.case_id, slot.version);
		declared = pinned ? json<CaseBody>(pinned.body).methods : [];
		cache.set(key, declared);
	}
	return result.method === "auto" ? [...declared, "auto"] : declared;
}

/** Recomputes a slot from every uncorrected result admitted to it (see `aggregateSlot` for the rule). */
function refreshSlot(
	ctx: Ctx,
	slot: SlotRow,
	obligation: ExerciseObligation | null,
): { state: SlotState; causes: Cause[] } {
	const fills = fillsOf(ctx.db, slot.id);
	const byResult = new Map(fills.map((fill) => [fill.id, fill]));
	const { agg, failing } = aggregateSlot(
		fills.map((fill) => ({
			id: fill.id,
			actor: fill.actor,
			method: fill.method,
			test: fill.test,
			lane: `${fill.target}:${fill.job}`,
			attempt: fill.attempt,
			seq: fill.seq,
			ord: fill.ord,
			outcome:
				fill.outcome === "pass"
					? "pass"
					: fill.outcome === "fail" || fill.outcome === "error"
						? "fail"
						: fill.outcome === "skip"
							? "skip"
							: "blocked",
		})),
	);
	// A cause is a failure signature on a target: the same signature in two environments is two things to answer
	// for, because an answer may hold for one of them only.
	const seen = new Set<string>();
	const causes: Cause[] = [];
	for (const id of failing) {
		const fill = byResult.get(id);
		if (!fill || fill.signature === null || seen.has(`${fill.signature}:${fill.target}`)) continue;
		seen.add(`${fill.signature}:${fill.target}`);
		causes.push([fill.signature, fill.target]);
	}
	const state = slotState(agg, obligation?.minActors ?? 1);
	ctx.db.run(Q.updateSlot, {
		id: slot.id,
		agg: JSON.stringify(agg),
		state,
		signature: causes[0]?.[0] ?? null,
		causes: JSON.stringify(causes),
		rev: ctx.seq,
	});
	return { state, causes };
}

/** A failure signature and the target it was seen on. */
type Cause = [signature: number, target: number];

// ── Tally and verdict ──────────────────────────────────────────────────────────────────────────────────────

/** The scope in which this run's failures are answered. */
export function scopeOfRun(db: Db, run: RunRow): string {
	if (run.scope !== null) return run.scope;
	const [target] = targetsOfRun(db, run);
	return target ? scopeOf(target, run.id) : `run:${run.id}`;
}

/** The run of the newest commit in a change's or a line's scope: the one that speaks for the scope. */
export function newestInScope(db: Db, project: number, scope: string): RunRow | null {
	const newest = db.get(Q.newestChangeRun, { project, scope })?.id;
	return newest ? runById(db, newest) : null;
}

/** The scope in which a failure seen on this target is answered, for this run. */
const scopeIn = (db: Db, run: RunRow, target: number): string => run.scope ?? scopeOf(mustTarget(db, target), run.id);

/**
 * Everyone with a result in a slot of this run that shows the cause in this scope: whoever reported the failure
 * and whoever reported otherwise. They are the parties to a dispute about it.
 */
export function partiesTo(db: Db, run: RunRow, signature: number, scope: string): Set<number> {
	const parties = new Set<number>();
	for (const slot of db.all(Q.slotsBySignature, { run: run.id, signature })) {
		const fills = fillsOf(db, slot.id);
		if (!fills.some((fill) => fill.signature === signature && scopeIn(db, run, fill.target) === scope)) continue;
		for (const fill of fills) parties.add(fill.actor);
	}
	return parties;
}

export type Retallied = {
	run: RunRow;
	/** A planned run that just reached `passed` and is still open: the caller raises its sign-off. */
	wantsSignoff: boolean;
	/** The causes this run shows unexplained, by `causeKey`. Open failure questions about others do not block it. */
	failing: Set<string>;
};

/**
 * An open question that may hold a run back. Questions belong to the decision machinery, which passes them in;
 * this module does not read them.
 */
export type Blocker = {
	ref: string;
	kind: string;
	signature: number | null;
	/** For a failure question: the scope it is answered in. */
	scope: string | null;
	blocks: readonly number[];
};

/** A cause in the scope it is answered in: the identity of a failure question. */
export const causeKey = (signature: number, scope: string): string => `${signature}|${scope}`;

/**
 * Does this test already fail, with this cause, where the change started? The base commit if Casebook has results
 * for it, otherwise the newest commit on the trunk of the change's own repository that ran the test. A hint for
 * the person or the rule that answers; it never excuses anything by itself. Because a rule may act on it, it reads
 * what the base's gate counts: the effective result per lane, after attempts and corrections, never an agent's
 * result and never another repository's.
 */
export function failsOnBase(db: Db, target: TargetRow, test: number, signature: number): boolean {
	if (target.line !== "change" || target.change === null) return false;
	const change = changeById(db, target.change);
	if (!change) return false;
	const failsIn = (run: number | null | undefined): boolean | null => {
		if (run === null || run === undefined) return null;
		const rows = db.all(Q.effectiveOfTest, { run, test });
		if (rows.length === 0) return null;
		return rows.some((row) => (row.outcome === "fail" || row.outcome === "error") && row.signature === signature);
	};
	const onBase = change.base_sha
		? failsIn(db.get(Q.changeRun, { project: target.project, what: codeWhat(change.repo, change.base_sha) })?.id)
		: null;
	if (onBase !== null) return onBase;
	const trunk = change.repo ? `line:trunk@${change.repo}` : "line:trunk";
	return failsIn(db.get(Q.newestRunWithTest, { project: target.project, scope: trunk, test })?.run) ?? false;
}

/**
 * What a run shows right now: its tally, the causes it shows with no excuse in force, and the decisions its
 * excused failures rest on. Read from the results and the excuses; nothing is stored.
 */
function count(db: Db, run: RunRow): { tally: Tally; failing: Set<string>; depends: Map<number, number | null> } {
	const tally: Tally = emptyTally();
	const failing = new Set<string>();
	const depends = new Map<number, number | null>();
	// A failure is answered in the scope of the target it was seen on. For a change run that is the run's own
	// scope. A planned run that names no repository can count the same commit in two of them: each of its causes
	// is then classified in its own repository's scope, so one repository's answer never covers the other's failure.
	const scopes = new Map<number, string>();
	const scopeFor = (target: number): string => {
		if (run.scope !== null) return run.scope;
		let found = scopes.get(target);
		if (found === undefined) {
			found = scopeOf(mustTarget(db, target), run.id);
			scopes.set(target, found);
		}
		return found;
	};
	/**
	 * The excuse for a cause seen on a target, if one applies. An excuse held for certain targets (an
	 * infrastructure failure) covers failures on those only: the same cause on another commit, or in another
	 * environment of the same commit, stays unexplained until it is answered there.
	 */
	const excuseOf = (signature: number, target: number) => {
		return excuseFor(db, run.project, signature, scopeFor(target), target);
	};

	const classify = (signature: number | null, target: number, n: number): void => {
		if (signature === null) {
			tally.unexplained += n;
			return;
		}
		const excuse = excuseOf(signature, target);
		if (!excuse) {
			failing.add(causeKey(signature, scopeFor(target)));
			tally.unexplained += n;
			return;
		}
		depends.set(excuse.decision, excuse.expires_at);
		if (excuse.class === "attributed") tally.attributed += n;
		else tally.excused += n;
	};

	if (run.origin === "change") {
		for (const row of db.all(Q.runTestGroups, { run: run.id })) {
			if (row.outcome === "pass") tally.pass += row.n;
			else if (row.outcome === "skip") tally.skipped += row.n;
			else if (row.outcome === "blocked") tally.missing += row.n;
			else classify(row.signature, row.target, row.n);
		}
	} else {
		for (const row of db.all(Q.slotGroups, { run: run.id })) {
			if (row.state === "satisfied" || row.state === "waived") tally.pass += row.n;
			else if (row.state === "missing") tally.missing += row.n;
			else if (row.state === "skipped") {
				tally.skipped += row.n;
				tally.missing += row.n;
			}
		}
		// A failing or disputed slot counts once, by all of its causes: it is excused only when every one is.
		for (const slot of db.all(Q.failingSlots, { run: run.id })) {
			const disputed = slot.state === "disputed";
			const causes = json<Cause[]>(slot.causes);
			const excuses = causes.map(([signature, target]) => excuseOf(signature, target));
			const open = causes.filter((_, i) => !excuses[i]);
			for (const [signature, target] of open) failing.add(causeKey(signature, scopeFor(target)));
			for (const excuse of excuses) if (excuse) depends.set(excuse.decision, excuse.expires_at);
			if (excuses.some((excuse) => excuse?.class === "attributed")) tally.attributed += 1;
			else if (open.length > 0 || causes.length === 0) {
				if (disputed) tally.disputed += 1;
				else tally.unexplained += 1;
			} else if (disputed) tally.pass += 1;
			else tally.excused += 1;
		}
	}

	// A run also rests on the decisions that judged results in its slots a mistake: it is recomputed with them.
	if (run.origin === "planned") {
		for (const row of db.all(Q.discountsOfRun, { run: run.id })) {
			if (!depends.has(row.decision)) depends.set(row.decision, null);
		}
	}

	const jobs = obligationsOf(run).flatMap((o) => (o.kind === "jobs" ? o.jobs : []));
	if (jobs.length > 0) {
		const reported = new Set<string>();
		for (const target of targetsOfRun(db, run)) {
			for (const job of processedJobs(db, target.id)) reported.add(job);
		}
		tally.missing += jobs.filter((job) => !reported.has(job)).length;
	}
	return { tally, failing, depends };
}

/** The causes a run shows with no excuse in force, by `causeKey`: what an open failure question is about. */
export const unexplainedIn = (db: Db, run: RunRow): Set<string> => count(db, run).failing;

/**
 * Recomputes a run's tally, the questions blocking it and its verdict from the facts, and stores them. Called in
 * the transaction of every event that can change them: an applied batch, a decision, a withdrawn decision.
 * `blockers` are the open questions about this run.
 */
export function retally(ctx: Ctx, runId: number, blockers: readonly Blocker[]): Retallied {
	const run = runById(ctx.db, runId);
	if (!run) throw new Error(`run ${runId} is missing`);
	const { tally, failing, depends } = count(ctx.db, run);

	// The questions whose answers this run is waiting for. A failure question is one of them exactly when this run
	// shows its cause unexplained: the run is blocked by that failure whatever the policy says a question may hold,
	// so the gate must name the question that would unblock it. One about a cause the run no longer shows is not.
	const blocking = blockers
		.filter((q) =>
			q.kind === "failure"
				? q.signature !== null && q.scope !== null && failing.has(causeKey(q.signature, q.scope))
				: q.blocks.includes(run.id),
		)
		.map((q) => q.ref);

	ctx.db.run(Q.clearDepends, { run: run.id });
	let expiry: number | null = null;
	for (const [decision, expires] of depends) {
		ctx.db.run(Q.depend, { run: run.id, decision, expires });
		if (expires !== null && (expiry === null || expires < expiry)) expiry = expires;
	}
	const next = verdict({ tally, blocking: blocking.length, outstanding: run.outstanding, expired: false });
	ctx.db.run(Q.project, {
		id: run.id,
		tally: JSON.stringify(tally),
		blocking: JSON.stringify(blocking),
		verdict: next,
		expiry,
		rev: ctx.seq,
	});
	ctx.touched.add(runRef(run));
	const updated = runById(ctx.db, run.id) ?? run;
	return { run: updated, wantsSignoff: run.origin === "planned" && run.state === "open" && next === "passed", failing };
}

// ── Planning ───────────────────────────────────────────────────────────────────────────────────────────────

/** What a planned run requires when the plan does not say: a person or a pipeline, on a basis the policy accepts. */
export function defaultObligations(policy: Policy): Obligation[] {
	return [{ id: "exercise", kind: "exercise", methods: ["human", "auto"], minActors: 1, basis: policy.settings.basis }];
}

/**
 * Creates a planned run with one slot per selected case and exercise obligation, pinned to the case's current
 * version. Evidence already recorded on a target the run accepts fills its slots at once, so nobody repeats by hand
 * what a pipeline has shown.
 */
export function plan(
	ctx: Ctx,
	input: {
		name: string;
		cases: readonly CaseRow[];
		accepts: TargetMatch;
		require: Obligation[];
		assignees: readonly number[];
	},
): { run: RunRow; slots: number; already: number } {
	if (input.cases.length === 0) throw invalid("the selection matches no active case");
	const ids = new Set(input.require.map((o) => o.id));
	if (ids.size !== input.require.length) throw invalid("obligation ids must be unique within a run");
	const exercises = input.require.filter((o): o is ExerciseObligation => o.kind === "exercise");
	if (exercises.length === 0) throw invalid("a planned run needs at least one exercise obligation");

	const no = ctx.nextNo("run");
	// A commit that exists in two repositories is refused here unless the run says which: the run would otherwise
	// count evidence about either.
	if ("commit" in input.accepts) targetByCommit(ctx.db, ctx.project.id, input.accepts.commit, input.accepts.repo);
	const what = null;
	const { lastId } = ctx.db.run(Q.insert, {
		project: ctx.project.id,
		no,
		name: input.name,
		origin: "planned",
		accepts: JSON.stringify(input.accepts),
		what,
		scope: null,
		require: JSON.stringify(input.require),
		change: null,
		tally: JSON.stringify(emptyTally()),
		verdict: "pending",
		actor: ctx.actor.id,
		at: ctx.now,
		rev: ctx.seq,
	});
	let rank = 0;
	for (const row of input.cases) {
		for (const obligation of exercises) {
			ctx.db.run(Q.insertSlot, {
				run: lastId,
				caseId: row.id,
				version: row.head,
				claim: row.claim_hash,
				obligation: obligation.id,
				assignee: input.assignees.length > 0 ? (input.assignees[rank % input.assignees.length] ?? null) : null,
				rank: rank++,
				rev: ctx.seq,
			});
		}
	}
	const run = runById(ctx.db, lastId);
	if (!run) throw new Error("run was not stored");
	ctx.touched.add(ref("run", no));

	const targets = targetsOfRun(ctx.db, run);
	const already =
		targets.length > 0
			? fillFromPrior(
					ctx,
					run,
					exercises,
					targets.map((t) => t.id),
				)
			: 0;
	return { run: retally(ctx, run.id, []).run, slots: rank, already };
}

function fillFromPrior(
	ctx: Ctx,
	run: RunRow,
	exercises: readonly ExerciseObligation[],
	targets: readonly number[],
): number {
	let satisfied = 0;
	for (const slot of ctx.db.all(Q.slotsOfRun, { run: run.id, after: -1, limit: 1_000_000 })) {
		const obligation = exercises.find((o) => o.id === slot.obligation);
		if (!obligation) continue;
		const prior = resultsOfCaseOnTargets(ctx.db, slot.case_id, targets);
		let any = false;
		for (const result of prior) {
			const admitted = qualifies({
				result: {
					method: result.method,
					basis: result.basis,
					basisCase: result.basis_case,
					basisVersion: result.basis_version,
					basisClaim: result.basis_claim,
				},
				slot: { caseId: slot.case_id, version: slot.version, claim: slot.claim },
				obligation,
				caseMethods: methodsOf(ctx.db, slot, result),
			});
			if (!admitted) continue;
			// A result a decision has judged a mistake is admitted as that: it counts here no more than it does in
			// the run it was judged in or in its commit's gate, and it returns here too if the decision is withdrawn.
			const judged = ctx.db.get(Q.judgedBy, { result: result.id });
			ctx.db.run(Q.admit, { slot: slot.id, result: result.id, run: run.id, admitted });
			if (judged) ctx.db.run(Q.discount, { slot: slot.id, result: result.id, decision: judged.decision });
			any = true;
		}
		if (any && refreshSlot(ctx, slot, obligation).state === "satisfied") satisfied++;
	}
	return satisfied;
}

// ── Standing ───────────────────────────────────────────────────────────────────────────────────────────────

/** Closes a run. Standing: only by a `signoff` decision, which a rule may make. */
export function closeRun(ctx: Ctx, witness: Witness, run: RunRow): void {
	ctx.db.run(Q.setState, { id: run.id, state: "closed", signoff: decisionOf(witness, "signoff"), rev: ctx.seq });
	ctx.touched.add(runRef(run));
}

/**
 * Reopens a run when the sign-off `decision` is withdrawn or stops holding. It does nothing when the run was
 * closed by another decision: withdrawing an old sign-off must not undo a newer one.
 */
export function reopenRun(ctx: Ctx, run: RunRow, decision: number): void {
	if (run.signoff !== decision) return;
	ctx.db.run(Q.setState, { id: run.id, state: "open", signoff: null, rev: ctx.seq });
	ctx.touched.add(runRef(run));
}

/**
 * A `mistaken` answer on a disputed slot: the failing results it names stop counting. Not only in that slot: a
 * result judged a mistake is discounted in every open run that admitted it and leaves its commit's gate, so the
 * same evidence never counts in one place and not in another. Standing: only by a decision, which each
 * discounted result records. Returns the slot and result pairs.
 */
export function discountFailures(
	ctx: Ctx,
	witness: Witness,
	run: RunRow,
	signature: number,
	scope: string,
): [number, number][] {
	const decision = decisionOf(witness, "failure");
	const corrected: [number, number][] = [];
	const touched = new Set<number>();
	for (const slot of ctx.db.all(Q.slotsBySignature, { run: run.id, signature })) {
		for (const fill of fillsOf(ctx.db, slot.id)) {
			// Only the failures the question is about: the same cause seen in another repository is another question.
			if (fill.signature !== signature || scopeIn(ctx.db, run, fill.target) !== scope) continue;
			for (const held of ctx.db.all(Q.slotsOfResult, { result: fill.id })) {
				const where = slotById(ctx.db, held.slot);
				const of = where ? runById(ctx.db, where.run) : null;
				// A closed run keeps what it was closed on.
				if (!where || of?.state !== "open") continue;
				ctx.db.run(Q.discount, { slot: where.id, result: fill.id, decision });
				corrected.push([where.id, fill.id]);
				touched.add(where.id);
			}
			const commit = commitRunOf(ctx.db, run.project, fill.target);
			if (commit) refoldLaneOf(ctx, commit, fill.id);
		}
	}
	for (const id of touched) refreshSlotById(ctx, id);
	return corrected;
}

/**
 * Puts back everything the `mistaken` decision `decision` discounted, in every slot that holds it, and only
 * that: a result its producer has since corrected stays corrected, and one another decision discounted stays
 * discounted.
 */
export function restoreFailures(ctx: Ctx, decision: number): void {
	const rows = ctx.db.all(Q.discountedBy, { decision });
	for (const row of rows) ctx.db.run(Q.undiscount, { slot: row.slot, result: row.result, decision });
	for (const result of new Set(rows.map((row) => row.result))) recount(ctx, result);
	for (const slot of new Set(rows.map((row) => row.slot))) refreshSlotById(ctx, slot);
}

function refreshSlotById(ctx: Ctx, id: number): void {
	const slot = slotById(ctx.db, id);
	const run = slot ? runById(ctx.db, slot.run) : null;
	if (!slot || !run) return;
	const obligation = obligationsOf(run).find((o) => o.id === slot.obligation);
	refreshSlot(ctx, slot, obligation?.kind === "exercise" ? obligation : null);
	ctx.touched.add(runRef(run));
}

const commitRunOf = (db: Db, project: number, target: number): RunRow | null =>
	db.get(Q.changeRun, { project, what: mustTarget(db, target).what });

/** Counts a result in its commit's gate again, after the decision that called it a mistake is withdrawn. */
function recount(ctx: Ctx, id: number): void {
	const result = resultById(ctx.db, id);
	const commit = result ? commitRunOf(ctx.db, result.project, result.target) : null;
	if (commit) refoldLaneOf(ctx, commit, id);
}

/**
 * Recomputes what a commit's gate counts for the lane a result is in, from that lane's whole history: every
 * result its producer has not corrected and no decision has called a mistake, folded by the rule a report is
 * folded by (`replacesInLane`). Called when a result leaves or returns for a reason other than a newer report: a
 * correction, a `mistaken` decision, that decision withdrawn. The attempt before it then stands again, exactly
 * as it does in a slot, which keeps every admitted result and folds them the same way.
 */
function refoldLaneOf(ctx: Ctx, commit: RunRow, id: number): void {
	const result = resultById(ctx.db, id);
	if (!result || result.method === "agent") return;
	const job = batchById(ctx.db, result.batch)?.job ?? "";
	const lane = `${result.target}:${job}:${result.actor}`;
	const before = ctx.db.get(Q.laneRow, { run: commit.id, test: result.test, lane });
	let held: ReturnType<typeof resultById> = null;
	for (const next of laneHistory(ctx.db, { target: result.target, test: result.test, actor: result.actor, job })) {
		if (next.method === "agent" || ctx.db.get(Q.judgedBy, { result: next.id })) continue;
		if (!held || replacesInLane(held, next)) held = next;
	}
	ctx.db.run(Q.dropLane, { run: commit.id, test: result.test, lane });
	if (held) {
		ctx.db.run(Q.upsertRunTest, {
			run: commit.id,
			test: held.test,
			result: held.id,
			outcome: held.outcome,
			signature: held.signature,
			attempt: held.attempt,
			flipped: before?.flipped ?? 0,
			lane,
			target: held.target,
		});
	}
	ctx.touched.add(runRef(commit));
}

// ── The gate ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The gate of a commit, a run or a change. One row read and two comparisons: an unapplied upload or an expired
 * hold makes the answer `pending` whatever the stored verdict says, so a stale green is never served.
 */
export function gate(
	ctx: Ctx,
	input: {
		commit?: string | undefined;
		run?: string | undefined;
		change?: string | undefined;
		repo?: string | undefined;
	},
): GateStatus {
	let run: RunRow | null = null;
	if (input.run) run = mustRun(ctx.db, ctx.project.id, input.run);
	else {
		let what: string | null = null;
		if (input.commit) what = targetByCommit(ctx.db, ctx.project.id, input.commit, input.repo)?.what ?? null;
		else if (input.change) {
			// The head of this change in its own repository, never a commit of the same name in another.
			const change = changeByKey(ctx.db, ctx.project.id, input.change);
			if (change?.head_sha) what = codeWhat(change.repo, change.head_sha);
		} else throw invalid("gate needs a commit, a run or a change");
		run = what ? ctx.db.get(Q.changeRun, { project: ctx.project.id, what }) : null;
	}
	if (!run) {
		return {
			run: null,
			verdict: "pending",
			reason: "pending: nothing has been reported for this commit",
			tally: { ...emptyTally() },
			open: [],
			url: null,
			stale: false,
		};
	}
	return gateOf(ctx, run);
}

export function gateOf(ctx: Ctx, run: RunRow): GateStatus {
	const tally = json<Tally>(run.tally);
	const open = json<string[]>(run.blocking);
	const expired = run.next_expiry !== null && run.next_expiry <= ctx.now;
	const facts = { tally, blocking: open.length, outstanding: run.outstanding, expired };
	const now = verdict(facts);
	return {
		run: runRef(run),
		verdict: now,
		reason: explainVerdict(facts),
		tally: { ...tally },
		open,
		url: null,
		stale: now !== run.verdict,
	};
}
