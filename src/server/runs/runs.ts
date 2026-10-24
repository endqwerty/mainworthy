// Runs: requests for evidence. Owns runs, run_tests, slots, slot_results and depends_on.
//
// A run does not own results. It says which targets count and what it needs; results from any producer fill it
// when the acceptance rule admits them (core/runs.ts). This module keeps each run's projections (slot states, tally,
// verdict) in step with the facts, in the transaction that changes them.
import type { ActorKind, Policy } from "../../core/kinds.ts";
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
	type ShardWait,
	type SlotState,
	slotState,
	type Tally,
	type TargetMatch,
	type Verdict,
	verdict,
	workHeldByOther,
} from "../../core/runs.ts";
import {
	type Applied,
	acceptedBatches,
	type BatchRow,
	batchById,
	changeById,
	changeByKey,
	changesBasedOn,
	codeWhat,
	excuseForDisputedSlot,
	excuseForResult,
	firstCountedReport,
	flippedLanes,
	isWithdrawn,
	laneHistory,
	mustTarget,
	nothingRequiredOn,
	processedJobs,
	type ResultRow,
	resolveCommit,
	resultById,
	resultFailedStep,
	resultsOfCaseOnTargets,
	resultTrail,
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
	waitingShardPages,
	waitingShards,
} from "../evidence/evidence.ts";
import { quarantineLookup } from "../evidence/quarantine.ts";
import { buildWhat } from "../evidence/releases.ts";
import { type Ctx, ref } from "../kernel/ctx.ts";
import { json, type ReadDb, sql, type WriteDb } from "../kernel/db.ts";
import { forbidden, invalid, notFound } from "../kernel/errors.ts";
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
	quarantined: number;
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

export type SlotLease = { slot: number; actor: number; since: number; until: number };

export type RunTestWrite = {
	run: number;
	test: number;
	result: number;
	outcome: string;
	signature: number | null;
	attempt: number;
	flipped: number;
	lane: string;
	target: number;
};

const Q = {
	passesAny: sql<{ run: number; tests: readonly number[] }, { n: number }>(
		"SELECT 1 AS n FROM run_tests WHERE run = $run AND outcome = 'pass' AND test = ANY($tests::bigint[]) LIMIT 1",
	),
	passingIn: sql<{ run: number; tests: readonly number[] }, { test: number; target: number }>(
		"SELECT test, target FROM run_tests WHERE run = $run AND outcome = 'pass' AND test = ANY($tests::bigint[])",
	),
	receiptBuckets: sql<{ run: number; after: number }, { bucket: number }>(
		"SELECT result/32 AS bucket FROM run_tests WHERE run=$run AND result/32>$after GROUP BY result/32 ORDER BY result/32 LIMIT 50",
	),
	receiptBucket: sql<
		{ run: number; bucket: number },
		{ test: number; result: number; target: number; outcome: string; signature: number | null; flipped: number }
	>(
		"SELECT test,result,target,outcome,signature,flipped FROM run_tests WHERE run=$run AND result/32=$bucket ORDER BY result",
	),
	receiptBlockingCount: sql<{ id: number }, { n: number }>(
		"SELECT jsonb_array_length(blocking::jsonb) AS n FROM runs WHERE id=$id",
	),
	lease: sql<{ slot: number; now: number }, SlotLease>(
		"SELECT l.* FROM slot_leases l JOIN slots s ON s.id = l.slot JOIN runs r ON r.id = s.run WHERE l.slot = $slot AND l.until > $now AND r.state = 'open'",
	),
	liveWork: sql<{ run: number; now: number }, { n: number; until: number | null }>(
		"SELECT count(*) AS n, min(l.until) AS until FROM slot_leases l JOIN slots s ON s.id = l.slot JOIN runs r ON r.id = s.run WHERE s.run = $run AND r.state = 'open' AND l.until > $now",
	),
	take: sql<SlotLease>(
		"INSERT INTO slot_leases (slot, actor, since, until) VALUES ($slot, $actor, $since, $until) ON CONFLICT (slot) DO UPDATE SET actor = excluded.actor, since = excluded.since, until = excluded.until",
	),
	release: sql<{ slot: number }>("DELETE FROM slot_leases WHERE slot = $slot"),
	releaseRun: sql<{ run: number }>("DELETE FROM slot_leases WHERE slot IN (SELECT id FROM slots WHERE run = $run)"),
	nextWork: sql<{ run: number; now: number }, SlotRow>(
		"SELECT s.* FROM slots s LEFT JOIN slot_leases l ON l.slot = s.id AND l.until > $now WHERE s.run = $run AND s.state IN ('missing', 'skipped') AND l.slot IS NULL ORDER BY s.rank",
	),
	emptyChangeRuns: sql<{ project: number }, { id: number }>(
		`SELECT id FROM runs WHERE project = $project AND origin = 'change'
		 AND ((tally::jsonb)->>'pass')::bigint + ((tally::jsonb)->>'excused')::bigint = 0`,
	),
	inheritanceRuns: sql<{ project: number }, { id: number }>(
		"SELECT id FROM runs WHERE project = $project AND origin = 'change' AND scope LIKE 'change:%'",
	),
	changeRuns: sql<{ change: number }, { id: number }>(
		"SELECT id FROM runs WHERE change = $change AND origin = 'change'",
	),
	allRunTests: sql<
		{ run: number },
		{ test: number; result: number; target: number; outcome: string; signature: number | null; flipped: number }
	>("SELECT test, result, target, outcome, signature, flipped FROM run_tests WHERE run = $run ORDER BY result"),
	failsWith: sql<{ run: number; signature: number }, { n: number }>(
		"SELECT 1 AS n FROM run_tests WHERE run = $run AND outcome IN ('fail', 'error') AND signature = $signature LIMIT 1",
	),
	byNo: sql<{ project: number; no: number }, RunRow>("SELECT * FROM runs WHERE project = $project AND no = $no"),
	byId: sql<{ id: number }, RunRow>("SELECT * FROM runs WHERE id = $id"),
	changeRun: sql<{ project: number; what: string }, RunRow>(
		"SELECT * FROM runs WHERE project = $project AND origin = 'change' AND accepts_what = $what",
	),
	receivingPlanned: sql<{ project: number; commit: string | null }, RunRow>(
		`SELECT * FROM runs WHERE project = $project AND origin = 'planned'
		 AND (state = 'open' OR (state = 'closed' AND (accepts::jsonb)->>'commit' = $commit))
		 ORDER BY state, id DESC`,
	),
	plannedForCommit: sql<{ project: number; commit: string }, { id: number }>(
		`SELECT id FROM runs WHERE project = $project AND origin = 'planned'
		 AND (accepts::jsonb)->>'commit' = $commit
		 ORDER BY state, id DESC`,
	),
	recent: sql<
		{
			project: number;
			origin: string | null;
			state: string | null;
			change: number | null;
			before: number;
			limit: number;
		},
		RunRow
	>(
		`SELECT * FROM runs WHERE project = $project AND id < $before
		 AND ($origin::text IS NULL OR origin = $origin) AND ($state::text IS NULL OR state = $state)
		 AND ($change::bigint IS NULL OR change = $change)
		 ORDER BY id DESC LIMIT $limit`,
	),
	insert: sql<
		{
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
		},
		{ id: number }
	>(
		`INSERT INTO runs (project, no, name, origin, accepts, accepts_what, scope, require, change, tally, verdict, created_by, created_at, rev)
		 VALUES ($project, $no, $name, $origin, $accepts, $what, $scope, $require, $change, $tally, $verdict, $actor, $at, $rev) RETURNING id`,
	),
	accepted: sql<{ id: number; seq: number }>(
		"UPDATE runs SET outstanding = outstanding + 1, accepted_seq = $seq, rev = $seq WHERE id = $id",
	),
	applied: sql<{ id: number; seq: number; rev: number }>(
		"UPDATE runs SET outstanding = greatest(outstanding - 1, 0), applied_seq = greatest(applied_seq, $seq), rev = $rev WHERE id = $id",
	),
	project: sql<{
		id: number;
		tally: string;
		quarantined: number;
		blocking: string;
		verdict: string;
		expiry: number | null;
		rev: number;
	}>(
		"UPDATE runs SET tally = $tally, quarantined = $quarantined, blocking = $blocking, verdict = $verdict, next_expiry = $expiry, rev = $rev WHERE id = $id",
	),
	setState: sql<{ id: number; state: string; signoff: number | null; rev: number }>(
		"UPDATE runs SET state = $state, signoff = $signoff, rev = $rev WHERE id = $id",
	),
	upsertRunTest: sql<RunTestWrite>(
		`INSERT INTO run_tests (run, test, result, outcome, signature, attempt, flipped, lane, target)
		 VALUES ($run, $test, $result, $outcome, $signature, $attempt, $flipped, $lane, $target)
		 ON CONFLICT (run, test, lane) DO UPDATE SET result = excluded.result, outcome = excluded.outcome, signature = excluded.signature,
		   attempt = excluded.attempt, flipped = greatest(run_tests.flipped, excluded.flipped)
		 WHERE (excluded.attempt > run_tests.attempt
		        AND NOT (excluded.outcome IN ('skip', 'blocked') AND run_tests.outcome IN ('pass', 'fail', 'error')))
		    OR (excluded.attempt = run_tests.attempt
		        AND (CASE excluded.outcome WHEN 'fail' THEN 3 WHEN 'error' THEN 3 WHEN 'pass' THEN 2 WHEN 'blocked' THEN 1 ELSE 0 END)
		         >= (CASE run_tests.outcome WHEN 'fail' THEN 3 WHEN 'error' THEN 3 WHEN 'pass' THEN 2 WHEN 'blocked' THEN 1 ELSE 0 END))`,
	),
	upsertRunTests: sql<{ [K in keyof RunTestWrite]: readonly RunTestWrite[K][] }>(
		`INSERT INTO run_tests (run, test, result, outcome, signature, attempt, flipped, lane, target)
   SELECT * FROM unnest($run::bigint[], $test::bigint[], $result::bigint[], $outcome::text[], $signature::bigint[], $attempt::bigint[], $flipped::bigint[], $lane::text[], $target::bigint[])
		 ON CONFLICT (run, test, lane) DO UPDATE SET result = excluded.result, outcome = excluded.outcome, signature = excluded.signature,
		   attempt = excluded.attempt, flipped = greatest(run_tests.flipped, excluded.flipped)
		 WHERE (excluded.attempt > run_tests.attempt
		        AND NOT (excluded.outcome IN ('skip', 'blocked') AND run_tests.outcome IN ('pass', 'fail', 'error')))
		    OR (excluded.attempt = run_tests.attempt
		        AND (CASE excluded.outcome WHEN 'fail' THEN 3 WHEN 'error' THEN 3 WHEN 'pass' THEN 2 WHEN 'blocked' THEN 1 ELSE 0 END)
		         >= (CASE run_tests.outcome WHEN 'fail' THEN 3 WHEN 'error' THEN 3 WHEN 'pass' THEN 2 WHEN 'blocked' THEN 1 ELSE 0 END))`,
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
	failingTestIds: sql<{ run: number }, { test: number }>(
		"SELECT DISTINCT test FROM run_tests WHERE run = $run AND outcome IN ('fail', 'error')",
	),
	commitsShowing: sql<{ project: number; signature: number }, { run: number }>(
		`SELECT DISTINCT rt.run AS run FROM run_tests rt JOIN runs r ON r.id = rt.run
		 WHERE rt.signature = $signature AND rt.outcome IN ('fail', 'error') AND r.project = $project`,
	),
	plannedShowing: sql<{ project: number; signature: number }, { run: number }>(
		`SELECT DISTINCT s.run AS run FROM runs r JOIN slots s ON s.run = r.id AND s.state IN ('failing', 'disputed')
		 WHERE r.project = $project AND r.origin = 'planned'
		   AND EXISTS (SELECT 1 FROM jsonb_array_elements(s.causes::jsonb) WHERE ((value::jsonb)->>0)::bigint = $signature)`,
	),
	failingOfCause: sql<{ run: number; signature: number; target: number }, { test: number; result: number }>(
		`SELECT test, result FROM run_tests
		 WHERE run = $run AND signature = $signature AND target = $target AND outcome IN ('fail', 'error') LIMIT 200`,
	),
	flippedRows: sql<{ run: number }, { result: number }>(
		"SELECT result FROM run_tests WHERE run = $run AND flipped = 1",
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
	effectiveOfTest: sql<{ run: number; test: number }, { result: number; outcome: string; signature: number | null }>(
		"SELECT result, outcome, signature FROM run_tests WHERE run = $run AND test = $test ORDER BY result",
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
		"INSERT INTO slot_results (slot, result, run, admitted) VALUES ($slot, $result, $run, $admitted) ON CONFLICT DO NOTHING",
	),
	correctInSlot: sql<{ slot: number; result: number }>(
		"UPDATE slot_results SET corrected = 1 WHERE slot = $slot AND result = $result AND corrected = 0",
	),
	discount: sql<{ slot: number; result: number; decision: number }>(
		"UPDATE slot_results SET discounted_by = $decision WHERE slot = $slot AND result = $result",
	),
	undiscount: sql<{ slot: number; result: number; decision: number }>(
		"UPDATE slot_results SET discounted_by = NULL WHERE slot = $slot AND result = $result AND discounted_by = $decision",
	),
	slotsOfResult: sql<{ result: number }, { slot: number }>("SELECT slot FROM slot_results WHERE result = $result"),
	heldBy: sql<{ slot: number }, { result: number; corrected: number; discounted_by: number | null }>(
		"SELECT result, corrected, discounted_by FROM slot_results WHERE slot = $slot",
	),
	admittedTo: sql<{ slot: number }, { result: number; admitted: string }>(
		"SELECT result, admitted FROM slot_results WHERE slot = $slot AND corrected = 0 AND discounted_by IS NULL",
	),
	newestChangeRun: sql<{ project: number; scope: string }, { id: number | null }>(
		"SELECT max(id) AS id FROM runs WHERE project = $project AND scope = $scope",
	),
	placeChangeRun: sql<{ id: number; scope: string; change: number | null; name: string; rev: number }>(
		"UPDATE runs SET scope = $scope, change = $change, name = $name, rev = $rev WHERE id = $id",
	),
	failingSlotRows: sql<{ run: number }, SlotRow>(
		"SELECT * FROM slots WHERE run = $run AND state IN ('failing', 'disputed') ORDER BY rank",
	),
	disputedRuns: sql<{ project: number }, { id: number }>(
		`SELECT DISTINCT r.id FROM slots s JOIN runs r ON r.id = s.run
		 WHERE s.state = 'disputed' AND r.project = $project`,
	),
	slotsBySignature: sql<{ run: number; signature: number }, SlotRow>(
		`SELECT * FROM slots WHERE run = $run AND state IN ('failing', 'disputed')
		 AND EXISTS (SELECT 1 FROM jsonb_array_elements(slots.causes::jsonb) WHERE ((value::jsonb)->>0)::bigint = $signature)`,
	),
	clearDepends: sql<{ run: number }>("DELETE FROM depends_on WHERE run = $run"),
	depend: sql<{ run: number; decision: number; expires: number | null }>(
		"INSERT INTO depends_on (run, decision, expires_at) VALUES ($run, $decision, $expires) ON CONFLICT DO NOTHING",
	),
	dependents: sql<{ decision: number }, { run: number }>("SELECT run FROM depends_on WHERE decision = $decision"),
};

export const runRef = (row: { no: number }): string => ref("run", row.no);
export const runById = async (db: ReadDb, id: number): Promise<RunRow | null> => await db.get(Q.byId, { id });
export const disputedRuns = async (db: ReadDb, project: number): Promise<number[]> =>
	(await db.all(Q.disputedRuns, { project })).map((run) => run.id);
export async function findRun(db: ReadDb, project: number, text: string): Promise<RunRow | null> {
	const match = /^(?:R-)?(\d+)$/i.exec(text.trim());
	return match ? await db.get(Q.byNo, { project, no: Number(match[1]) }) : null;
}
export async function mustRun(db: ReadDb, project: number, text: string): Promise<RunRow> {
	const row = await findRun(db, project, text);
	if (!row) throw notFound(`run ${text}`);
	return row;
}
/** A project's runs, newest first, of one origin, state or change when given. */
export const recentRuns = async (
	db: ReadDb,
	project: number,
	filter: { origin: RunRow["origin"] | null; state: RunRow["state"] | null; change: number | null },
	before: number,
	limit: number,
): Promise<RunRow[]> => await db.all(Q.recent, { project, ...filter, before, limit });
export const slotById = async (db: ReadDb, id: number): Promise<SlotRow | null> => await db.get(Q.slotById, { id });
export const slotsPage = async (db: ReadDb, run: number, after: number, limit: number): Promise<SlotRow[]> =>
	await db.all(Q.slotsOfRun, { run, after, limit });
export const leaseOf = async (ctx: Ctx<ReadDb>, slot: number): Promise<SlotLease | null> =>
	await ctx.db.get(Q.lease, { slot, now: ctx.app.now() });
export const workIn = async (ctx: Ctx<ReadDb>, run: number) =>
	(await ctx.db.get(Q.liveWork, { run, now: ctx.app.now() })) ?? { n: 0, until: null };

export async function workSlot(ctx: Ctx<ReadDb>, run: RunRow, id: number): Promise<SlotRow> {
	const slot = await slotById(ctx.db, id);
	if (!slot || slot.run !== run.id) throw notFound(`slot ${id} in ${runRef(run)}`);
	return slot;
}
async function canWork(ctx: Ctx<ReadDb>, run: RunRow, slot: SlotRow): Promise<boolean> {
	const method = ctx.actor.kind === "ci" ? "auto" : ctx.actor.kind;
	if (method === "rule") return false;
	const obligation = obligationsOf(run).find((o) => o.id === slot.obligation);
	const version = await versionOf(ctx.db, slot.case_id, slot.version);
	return (
		obligation?.kind === "exercise" &&
		obligation.methods.includes(method) &&
		version !== null &&
		json<CaseBody>(version.body).methods.includes(method)
	);
}

export async function takeWork(
	ctx: Ctx,
	run: RunRow,
	input: { slot?: number | undefined; seconds: number },
): Promise<
	{ kind: "empty" } | { kind: "busy"; lease: SlotLease } | { kind: "taken"; slot: SlotRow; lease: SlotLease }
> {
	if (run.origin !== "planned" || run.state !== "open") throw invalid("only an open planned run has slots to take");
	const slot =
		input.slot === undefined
			? await findAsync(
					await ctx.db.all(Q.nextWork, { run: run.id, now: ctx.app.now() }),
					async (s) =>
						(await canWork(ctx, run, s)) &&
						!(await effectiveFillsOf(ctx.db, s.id)).some((f) => f.actor === ctx.actor.id),
				)
			: await workSlot(ctx, run, input.slot);
	if (!slot) return { kind: "empty" };
	if (!(await canWork(ctx, run, slot)))
		throw forbidden("your method is not admitted by this slot's run and pinned case");
	const held = await leaseOf(ctx, slot.id);
	if (held && workHeldByOther(held, ctx.actor.id, ctx.app.now())) return { kind: "busy", lease: held };
	const now = ctx.app.now();
	const lease = { slot: slot.id, actor: ctx.actor.id, since: held?.since ?? now, until: now + input.seconds * 1000 };
	await ctx.db.run(Q.take, lease);
	ctx.touched.add(runRef(run));
	return { kind: "taken", slot, lease };
}
export async function releaseWork(ctx: Ctx, run: RunRow, slot: SlotRow): Promise<void> {
	await ctx.db.run(Q.release, { slot: slot.id });
	ctx.touched.add(runRef(run));
}

export const slotCount = async (db: ReadDb, run: number): Promise<number> =>
	(await db.get(Q.slotCount, { run }))?.n ?? 0;
export type Fill = {
	model: string | null;
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
	atStep: string | null;
	steps: Awaited<ReturnType<typeof resultTrail>>;
};

/** The uncorrected results admitted to a slot, oldest first. Results are read through their owner, evidence. */
export async function fillsOf(db: ReadDb, slot: number): Promise<Fill[]> {
	const fills: Fill[] = [];
	const jobs = new Map<number, string>();
	const jobOf = async (batch: number): Promise<string> => {
		let job = jobs.get(batch);
		if (job === undefined) {
			job = (await batchById(db, batch))?.job ?? "";
			jobs.set(batch, job);
		}
		return job;
	};
	for (const row of await db.all(Q.admittedTo, { slot })) {
		const result = await resultById(db, row.result);
		if (!result) continue;
		fills.push({
			id: result.id,
			actor: result.actor,
			model: result.model,
			test: result.test,
			attempt: result.attempt,
			outcome: result.outcome,
			seq: result.seq,
			ord: result.ord,
			signature: result.signature,
			target: result.target,
			job: await jobOf(result.batch),
			method: result.method,
			admitted: row.admitted,
			at: result.at,
			note: result.note,
			message: result.message,
			atStep: resultFailedStep(result),
			steps: resultTrail(result),
		});
	}
	return fills.sort((a, b) => a.seq - b.seq || a.ord - b.ord);
}
export const failingTestsOf = async (db: ReadDb, run: number, limit: number) =>
	await db.all(Q.failingRunTests, { run, limit });
export const failingTestIds = async (db: ReadDb, run: number): Promise<number[]> =>
	(await db.all(Q.failingTestIds, { run })).map((row) => row.test);
export const runTestsWith = async (db: ReadDb, run: number, outcome: string, limit: number) =>
	await db.all(Q.runTests, { run, outcome, limit });
/** How many of a run's tests both passed and failed on its commit, leaving out a flip a correction withdrew (#630). */
export const flippedIn = async (db: ReadDb, run: number): Promise<number> =>
	(
		await flippedLanes(
			db,
			(await db.all(Q.flippedRows, { run })).map((row) => row.result),
		)
	).size;
/** Whether a change run holds a passing result for any of these tests: the evidence that a failure stopped. */
export async function passesAny(db: ReadDb, run: number, tests: readonly number[]): Promise<boolean> {
	if (tests.length === 0) return false;
	const rows = await db.all(Q.passesAny, { run, tests });
	return rows.length > 0;
}
export const runsDependingOn = async (db: ReadDb, decision: number): Promise<number[]> =>
	(await db.all(Q.dependents, { decision })).map((r) => r.run);

/** The version each case is pinned to in a run. A result typed into the run is exact at that version. */
export async function pinnedVersions(db: ReadDb, run: number): Promise<Map<number, number>> {
	return new Map((await db.all(Q.pinned, { run })).map((row) => [row.case_id, row.version]));
}

const obligationsOf = (run: RunRow): Obligation[] => json<Obligation[]>(run.require);
const acceptsOf = (run: RunRow): TargetMatch => json<TargetMatch>(run.accepts);

// ── Which runs a target matters to ─────────────────────────────────────────────────────────────────────────

/** The run that gates a commit, created the first time anything is reported for it. */
export async function ensureChangeRun(ctx: Ctx, target: TargetRow, create = true): Promise<RunRow | null> {
	if (target.line === "session" || target.commit_sha === null) return null;
	const found = await ctx.db.get(Q.changeRun, { project: ctx.project.id, what: target.what });
	if (found) {
		const scope = scopeOf(target, null);
		if (found.scope === scope && found.change === target.change) return found;
		const change = target.change !== null ? await changeById(ctx.db, target.change) : null;
		const name = `${target.commit_sha.slice(0, 7)} on ${change?.key ?? target.branch ?? target.line}`;
		await ctx.db.run(Q.placeChangeRun, { id: found.id, scope, change: target.change, name, rev: ctx.seq });
		ctx.recompute.add(found.id);
		ctx.touched.add(runRef(found));
		return { ...found, scope, change: target.change, name, rev: ctx.seq };
	}
	if (!create) return null;
	const change = target.change !== null ? await changeById(ctx.db, target.change) : null;
	const where = change ? change.key : (target.branch ?? target.line);
	const no = await ctx.nextNo("run");
	const { id: insertedId } = await ctx.db.one(Q.insert, {
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
	return await runById(ctx.db, insertedId);
}

/**
 * Does this run count results on this target? A run that accepts a commit counts that commit (and repository and
 * environment, where it names them) and nothing else, whether or not the result was typed into it: naming a run
 * does not make evidence about another build count for it. A `self` run counts only what is typed into it.
 */
async function matches(db: ReadDb, run: RunRow, target: TargetRow, typedInto: number | null): Promise<boolean> {
	const accepts = acceptsOf(run);
	if ("self" in accepts) return typedInto === run.id;
	if ("build" in accepts)
		return (
			target.what === (await buildWhat(db, run.project, accepts.build)) &&
			(accepts.env === undefined || accepts.env === target.env)
		);
	if (target.commit_sha === null) return false;
	// One commit, by its whole hash: an abbreviation was settled when the run was planned (`resolveCommit`).
	return (
		target.commit_sha === accepts.commit &&
		(accepts.repo === undefined || accepts.repo === target.repo) &&
		(accepts.env === undefined || accepts.env === target.env)
	);
}

/**
 * Every run a batch on this target counts toward: the commit's change run, and each planned run that accepts it.
 * A commit gets its run from the first report a gate counts. An agent's report does not make one: a commit only
 * an agent has reported has no gate to read, and is not the newest commit of its line or change.
 */
export async function runsFor(
	ctx: Ctx,
	target: TargetRow,
	typedInto: number | null,
	producer: ActorKind,
): Promise<RunRow[]> {
	const out: RunRow[] = [];
	const change = await ensureChangeRun(ctx, target, producer !== "agent");
	if (change) out.push(change);
	for (const run of await ctx.db.all(Q.receivingPlanned, { project: ctx.project.id, commit: target.commit_sha })) {
		if (await matches(ctx.db, run, target, typedInto)) out.push(run);
	}
	return out;
}

/** Whether a result typed into this run on this target would count for it. The report is refused when not. */
export const runAccepts = async (db: ReadDb, run: RunRow, target: TargetRow): Promise<boolean> =>
	run.origin === "change" ? run.accepts_what === target.what : await matches(db, run, target, run.id);

/** What a run counts, in words, for the refusal. */
export function describeAccepts(run: RunRow): string {
	const accepts = acceptsOf(run);
	if ("self" in accepts) return "only results recorded in it";
	if ("build" in accepts) return `build ${accepts.build}${accepts.env ? ` (${accepts.env})` : ""}`;
	const more = [accepts.repo, accepts.env].filter((part) => part !== undefined);
	return `commit ${accepts.commit}${more.length > 0 ? ` (${more.join(", ")})` : ""}`;
}

/**
 * The targets counted by a run's commit or artifact, narrowed to its selected environment and repository.
 */
async function targetsOfRun(db: ReadDb, run: RunRow): Promise<TargetRow[]> {
	const accepts = acceptsOf(run);
	if ("build" in accepts)
		return await filterAsync(
			await targetsOfCommit(db, run.project, await buildWhat(db, run.project, accepts.build)),
			async (target) => await matches(db, run, target, null),
		);
	if (!("commit" in accepts)) return [];
	if (run.origin === "change") return run.accepts_what ? await targetsOfCommit(db, run.project, run.accepts_what) : [];
	return await filterAsync(
		await targetsWithCommit(db, run.project, accepts.commit),
		async (target) => await matches(db, run, target, null),
	);
}

/**
 * Every planned run that counts a commit, open or closed, whatever environment or repository it narrows to: the
 * runs to recompute when the commit's failures come to be answered somewhere else.
 */
export const plannedCounting = async (db: ReadDb, project: number, commit: string): Promise<number[]> =>
	(await db.all(Q.plannedForCommit, { project, commit })).map((row) => row.id);

/**
 * Marks a report applied for runs it did not fold into: the runs that waited for it only because it says where
 * their commit is (see `noteAccepted`). The other half of the horizon for them.
 * A closed run keeps its approved evidence sequence.
 */
export async function noteApplied(ctx: Ctx, runs: readonly RunRow[], batchSeq: number): Promise<void> {
	for (const run of runs)
		await ctx.db.run(Q.applied, { id: run.id, seq: run.state === "closed" ? run.applied_seq : batchSeq, rev: ctx.seq });
}

/** Acceptance: the report is durable but not applied, so each run it matters to reads `pending` until it is. */
export async function noteAccepted(
	ctx: Ctx,
	runs: readonly Pick<RunRow, "id" | "no">[],
	batchSeq: number,
): Promise<void> {
	for (const run of runs) {
		await ctx.db.run(Q.accepted, { id: run.id, seq: batchSeq });
		ctx.touched.add(runRef(run));
	}
}

// ── Applying a batch ───────────────────────────────────────────────────────────────────────────────────────

/** Preserve lane replacement order, including repeated tests, while writing distinct lane keys together. */
export async function upsertRunTests(db: WriteDb, rows: readonly RunTestWrite[]): Promise<void> {
	let pending: RunTestWrite[] = [];
	const keys = new Set<string>();
	const flush = async () => {
		if (!pending.length) return;
		await db.run(Q.upsertRunTests, {
			run: pending.map((row) => row.run),
			test: pending.map((row) => row.test),
			result: pending.map((row) => row.result),
			outcome: pending.map((row) => row.outcome),
			signature: pending.map((row) => row.signature),
			attempt: pending.map((row) => row.attempt),
			flipped: pending.map((row) => row.flipped),
			lane: pending.map((row) => row.lane),
			target: pending.map((row) => row.target),
		});
		pending = [];
		keys.clear();
	};
	for (const row of rows) {
		const key = JSON.stringify([row.run, row.test, row.lane]);
		if (keys.has(key)) await flush();
		pending.push(row);
		keys.add(key);
	}
	await flush();
}

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
	/**
	 * The tests whose failure with this cause a commit's gate counts. Only for these does a later pass in a
	 * commit's gate say the failure stopped: a pipeline's pass says nothing about a failure only an agent showed.
	 */
	gateTests: number[];
	runs: RunRow[];
};

/**
 * Folds an applied batch into every run it counts toward: the effective result per test of a change run, and the
 * slots of planned runs. Returns the failures grouped by cause, for the caller to raise as questions.
 */
export async function* applyBatchSteps(
	ctx: Ctx,
	input: { batch: BatchRow; target: TargetRow; applied: readonly Applied[]; runs: readonly RunRow[] },
): AsyncGenerator<undefined, FailingGroup[], void> {
	const { batch, target, applied, runs } = input;
	const scope = scopeOf(target, batch.run);
	const groups = new Map<number, FailingGroup>();
	const group = (signature: SignatureRow): FailingGroup => {
		let found = groups.get(signature.id);
		if (!found) {
			found = {
				signature,
				scope,
				tests: [],
				results: [],
				message: null,
				disputed: false,
				counted: false,
				gateTests: [],
				runs: [],
			};
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
	const pending: RunTestWrite[] = [];
	const flush = async () => {
		await upsertRunTests(ctx.db, pending);
		pending.length = 0;
	};
	let folded = 0;
	for (const result of applied) {
		if (folded++ > 0 && folded % SLICE === 0) yield;
		// A commit's gate counts what pipelines and people report. An agent's result is recorded and shown, and
		// counts only in a planned run that asked for agents (decision 0009): never in a change run.
		const counted = result.method !== "agent";
		if (changeRun && counted) {
			// A correction withdraws the result it names: the lane it was in is folded again without it, so the
			// attempt before it stands again if the correction does not take its place.
			if (result.corrects !== null) {
				await flush();
				await refoldLaneOf(ctx, changeRun, result.corrects);
			}
			pending.push({
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
			// A correction reaches every receiving run this batch counts toward.
			for (const { slot } of await ctx.db.all(Q.slotsOfResult, { result: result.corrects })) {
				const row = await slotById(ctx.db, slot);
				if (!row || !plannedIds.has(row.run)) continue;
				if ((await ctx.db.run(Q.correctInSlot, { slot, result: result.corrects })).changes > 0)
					touchedSlots.set(slot, row);
			}
		}
		if (result.basisCase !== null && planned.length > 0) {
			for (const slot of await ctx.db.all(Q.slotsOfCase, { caseId: result.basisCase })) {
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
					caseMethods: await methodsOf(ctx.db, slot, result, declared),
				});
				if (!admitted) continue;
				if ((await ctx.db.run(Q.admit, { slot: slot.id, result: result.id, run: run.id, admitted })).changes > 0) {
					await releaseWork(ctx, run, slot);
					touchedSlots.set(slot.id, slot);
				}
			}
		}
		if (result.signature && (result.outcome === "fail" || result.outcome === "error")) {
			const g = group(result.signature);
			if (!g.tests.some((t) => t.id === result.test.id)) g.tests.push(result.test);
			g.results.push(result.id);
			g.message ??= result.message;
			g.counted ||= counted;
			if (counted && !g.gateTests.includes(result.test.id)) g.gateTests.push(result.test.id);
		}
	}

	await flush();

	// Rebuild every slot the batch touched from its complete admitted set, and note the ones now in dispute.
	for (const slot of touchedSlots.values()) {
		const run = planned.find((r) => r.id === slot.run) ?? (await runById(ctx.db, slot.run));
		if (!run) continue;
		const obligation = obligationsOf(run).find((o) => o.id === slot.obligation);
		const next = await refreshSlot(ctx, slot, obligation?.kind === "exercise" ? obligation : null);
		if (next.state !== "disputed" && next.state !== "failing") continue;
		// Every cause failing in the slot is its own question: answering one does not answer the others. Only the
		// causes seen in this batch's scope are this batch's to ask about; one seen in another repository has its
		// own question there.
		const here = await filterAsync(
			next.causes,
			async ([, seenOn]) => scopeOf(await mustTarget(ctx.db, seenOn), batch.run) === scope,
		);
		for (const id of new Set(here.map(([cause]) => cause))) {
			const signature = await signatureById(ctx.db, id);
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
	const contributed = new Set([...touchedSlots.values()].map((slot) => slot.run));
	for (const run of runs) {
		const seq = run.state === "closed" && !contributed.has(run.id) ? run.applied_seq : batch.seq;
		await ctx.db.run(Q.applied, { id: run.id, seq, rev: ctx.seq });
		ctx.touched.add(runRef(run));
	}
	return [...groups.values()].filter((g) => g.runs.length > 0 || g.results.length > 0);
}

/**
 * The failures a run's slots show right now, grouped by cause, with the target and producer of the latest one.
 * For a run planned over evidence that already fails: its failures are put to the queue through the same door
 * as a report's, so an existing question takes the run on and a decision about the cause reaches it.
 */
export async function failuresShown(
	ctx: Ctx,
	run: RunRow,
): Promise<{ group: FailingGroup; target: number; by: number }[]> {
	const out = new Map<string, { group: FailingGroup; target: number; by: number }>();
	for (const slot of await ctx.db.all(Q.failingSlotRows, { run: run.id })) {
		const fills = await fillsOf(ctx.db, slot.id);
		for (const [cause, seenOn] of json<Cause[]>(slot.causes)) {
			const signature = await signatureById(ctx.db, cause);
			if (!signature) continue;
			// Each cause is asked about in the scope of the target it was seen on.
			const scope = await scopeIn(ctx.db, run, seenOn);
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
						gateTests: [],
						runs: [run],
					},
					target: fill.target,
					by: fill.actor,
				};
				const test = await testById(ctx.db, fill.test);
				if (test && !entry.group.tests.some((t) => t.id === test.id)) entry.group.tests.push(test);
				if (fill.method !== "agent" && !entry.group.gateTests.includes(fill.test))
					entry.group.gateTests.push(fill.test);
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

/**
 * Every run that shows a cause: the runs of the commits that fail with it, the newest and the older ones, and
 * the planned runs with a slot that shows it. (Not narrowed to a scope: a planned run can hold results of two.)
 * A decision about the cause changes how each of them counts it, so each is recomputed when the decision is made:
 * the gate of any commit is exact, not only the newest's.
 */
export async function runsShowing(db: ReadDb, project: number, signature: number): Promise<number[]> {
	return [
		...(await db.all(Q.commitsShowing, { project, signature })),
		...(await db.all(Q.plannedShowing, { project, signature })),
	].map((row) => row.run);
}

/**
 * The result that counts in a lane (one producer's results for one test from one job on one target): its
 * uncorrected history, less what a decision has judged a mistake, folded by `replacesInLane`.
 */
async function heldInLane(
	db: ReadDb,
	lane: { target: number; test: number; actor: number; job: string },
	counts: (result: NonNullable<Awaited<ReturnType<typeof resultById>>>) => boolean,
): Promise<Awaited<ReturnType<typeof resultById>>> {
	let held: Awaited<ReturnType<typeof resultById>> = null;
	for (const next of await laneHistory(db, lane)) {
		if (!counts(next) || (await db.get(Q.judgedBy, { result: next.id }))) continue;
		if (!held || replacesInLane(held, next)) held = next;
	}
	return held;
}

/** A failure a run shows with no excuse in force: the cause, the target it was seen on, the scope it is answered in. */
export type Unexplained = { signature: number; target: number; scope: string };

/**
 * The failures a run shows that no decision explains, one per cause and target. Read when a run is recomputed, to
 * make sure each of them has a question somebody can answer.
 */
export async function unexplainedShown(db: ReadDb, run: RunRow): Promise<Unexplained[]> {
	const { quarantineFor, scopeFor } = await counting(db, run);
	const shown = new Map<string, Unexplained>();
	const note = async (result: { id: number; signature: number | null; target: number }): Promise<void> => {
		if (result.signature === null) return;
		const scope = await scopeFor(result.target);
		if (!(await quarantineFor(result.id)) && !(await excuseForResult(db, { ...result, project: run.project }, scope)))
			shown.set(`${result.signature}:${result.target}`, { signature: result.signature, target: result.target, scope });
	};
	if (run.origin === "change") {
		for (const row of await countedTestsOf(db, run.id))
			if (row.outcome === "fail" || row.outcome === "error") await note({ ...row, id: row.result });
	} else {
		for (const slot of await db.all(Q.failingSlots, { run: run.id }))
			for (const fill of await failingFillsOf(db, slot.id))
				if (slot.state !== "disputed" || !(await excuseForDisputedSlot(db, slot.id, fill.id, run.id))) await note(fill);
	}
	return [...shown.values()];
}

/**
 * One cause on one target as a run shows it now, in the shape a question is raised from: its tests, its results
 * and who reported the latest of them. Null when the run no longer shows it.
 */
export async function shownFailure(
	ctx: Ctx,
	run: RunRow,
	cause: Unexplained,
): Promise<{ group: FailingGroup; by: number } | null> {
	const signature = await signatureById(ctx.db, cause.signature);
	if (!signature) return null;
	const group: FailingGroup = {
		signature,
		scope: cause.scope,
		tests: [],
		results: [],
		message: null,
		disputed: false,
		counted: true,
		gateTests: [],
		runs: [run],
	};
	let by: number | null = null;
	const add = async (
		test: number,
		result: number,
		actor: number,
		message: string | null,
		counted: boolean,
	): Promise<void> => {
		const row = await testById(ctx.db, test);
		if (row && !group.tests.some((t) => t.id === row.id)) group.tests.push(row);
		if (counted && !group.gateTests.includes(test)) group.gateTests.push(test);
		group.results.push(result);
		group.message ??= message;
		by = actor;
	};
	if (run.origin === "change") {
		for (const row of await ctx.db.all(Q.failingOfCause, {
			run: run.id,
			signature: cause.signature,
			target: cause.target,
		})) {
			const result = await resultById(ctx.db, row.result);
			if (result) await add(row.test, result.id, result.actor, result.message, true);
		}
	} else {
		for (const slot of await ctx.db.all(Q.slotsBySignature, { run: run.id, signature: cause.signature })) {
			for (const fill of await fillsOf(ctx.db, slot.id)) {
				if (fill.signature !== cause.signature || fill.target !== cause.target) continue;
				if (fill.outcome !== "fail" && fill.outcome !== "error") continue;
				await add(fill.test, fill.id, fill.actor, fill.message, fill.method !== "agent");
				group.disputed ||= slot.state === "disputed";
			}
		}
	}
	return by === null ? null : { group, by };
}

/** `applyBatchSteps` run to the end without pausing. */
export async function applyBatch(
	ctx: Ctx,
	input: { batch: BatchRow; target: TargetRow; applied: readonly Applied[]; runs: readonly RunRow[] },
): Promise<FailingGroup[]> {
	const steps = applyBatchSteps(ctx, input);
	for (let step = await steps.next(); ; step = await steps.next()) if (step.done) return step.value;
}

/**
 * The methods a slot's case admits for this result, read from the version the slot pinned: a later edit that
 * admits agents does not let one fill a run that pinned the version before it. A person's and an agent's
 * eligibility are declared on the case. A linked or annotated test is eligible because a decision or the test
 * itself tied it to the case; whether a test may fill a given slot is then the obligation's choice (it lists
 * `auto` or it does not).
 */
async function methodsOf(
	db: ReadDb,
	slot: Pick<SlotRow, "case_id" | "version">,
	result: { method: MethodKind },
	cache: Map<string, MethodKind[]> = new Map(),
): Promise<MethodKind[]> {
	const key = `${slot.case_id}@${slot.version}`;
	let declared = cache.get(key);
	if (!declared) {
		const pinned = await versionOf(db, slot.case_id, slot.version);
		declared = pinned ? json<CaseBody>(pinned.body).methods : [];
		cache.set(key, declared);
	}
	return result.method === "auto" ? [...declared, "auto"] : declared;
}

/** Recomputes a slot from every uncorrected result admitted to it (see `aggregateSlot` for the rule). */
async function refreshSlot(
	ctx: Ctx,
	slot: SlotRow,
	obligation: ExerciseObligation | null,
): Promise<{ state: SlotState; causes: Cause[] }> {
	const fills = await fillsOf(ctx.db, slot.id);
	const byResult = new Map(fills.map((fill) => [fill.id, fill]));
	const { agg, failing } = aggregateFills(fills);
	// A cause is a failure signature on a target.
	const seen = new Set<string>();
	const causes: Cause[] = [];
	for (const id of failing) {
		const fill = byResult.get(id);
		if (!fill || fill.signature === null || seen.has(`${fill.signature}:${fill.target}`)) continue;
		seen.add(`${fill.signature}:${fill.target}`);
		causes.push([fill.signature, fill.target]);
	}
	const state = slotState(agg, obligation?.minActors ?? 1);
	await ctx.db.run(Q.updateSlot, {
		id: slot.id,
		agg: JSON.stringify(agg),
		state,
		signature: causes[0]?.[0] ?? null,
		causes: JSON.stringify(causes),
		rev: ctx.seq,
	});
	return { state, causes };
}

function aggregateFills(fills: Fill[]) {
	return aggregateSlot(
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
}

export async function failingFillsOf(db: ReadDb, slot: number): Promise<Fill[]> {
	const fills = await fillsOf(db, slot);
	const failing = new Set(aggregateFills(fills).failing);
	return fills.filter((fill) => failing.has(fill.id));
}

export async function effectiveFillsOf(db: ReadDb, slot: number): Promise<Fill[]> {
	const fills = await fillsOf(db, slot);
	const effective = new Set(aggregateFills(fills).effective);
	return fills.filter((fill) => effective.has(fill.id));
}

export type SlotDispute = {
	slot: SlotRow;
	signature: number;
	scope: string;
	effective: Fill[];
	failures: Fill[];
};

/** Each conflicting cause is settled only in the slot that counts it, using its complete effective evidence. */
export async function disputesOf(db: ReadDb, run: RunRow): Promise<SlotDispute[]> {
	if (run.origin !== "planned") return [];
	const disputes: SlotDispute[] = [];
	for (const slot of await db.all(Q.failingSlotRows, { run: run.id })) {
		if (slot.state !== "disputed") continue;
		const fills = await fillsOf(db, slot.id);
		const folded = aggregateFills(fills);
		const effectiveIds = new Set(folded.effective);
		const failingIds = new Set(folded.failing);
		const effective = fills.filter((fill) => effectiveIds.has(fill.id));
		const groups = new Map<string, SlotDispute>();
		for (const fill of effective) {
			if (!failingIds.has(fill.id) || fill.signature === null) continue;
			const scope = await scopeIn(db, run, fill.target);
			const key = causeKey(fill.signature, scope);
			let dispute = groups.get(key);
			if (!dispute) {
				dispute = { slot, signature: fill.signature, scope, effective, failures: [] };
				groups.set(key, dispute);
			}
			dispute.failures.push(fill);
		}
		disputes.push(...groups.values());
	}
	return disputes;
}

/** A failure signature and the target it was seen on. */
type Cause = [signature: number, target: number];

// ── Tally and verdict ──────────────────────────────────────────────────────────────────────────────────────

/** The run that speaks for a scope: its change's observed head in that scope, or the newest commit on a line. */
export async function newestInScope(db: ReadDb, project: number, scope: string): Promise<RunRow | null> {
	if (scope.startsWith("change:")) {
		const change = await changeById(db, Number(scope.slice("change:".length)));
		const head = change?.head_sha
			? await db.get(Q.changeRun, { project, what: codeWhat(change.repo, change.head_sha) })
			: null;
		return head?.scope === scope ? head : null;
	}
	const newest = (await db.get(Q.newestChangeRun, { project, scope }))?.id;
	return newest ? await runById(db, newest) : null;
}

/**
 * The scope in which a failure seen on this target is answered, for this run: the target's own (its pull request,
 * its line, or the run it was typed into). Every environment of a commit shares its current scope;
 * a planned run that counts one commit in two repositories has one scope for each.
 */
const scopeIn = async (db: ReadDb, run: RunRow, target: number): Promise<string> =>
	scopeOf(await mustTarget(db, target), run.id);

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
	slot?: number | undefined;
	blocks: readonly number[];
};

/** A cause in the scope it is answered in: the identity of a failure question. */
export const causeKey = (signature: number, scope: string, slot?: number): string =>
	`${slot === undefined ? "" : `slot:${slot}|`}${signature}|${scope}`;

async function comparisonLane(db: ReadDb, result: ResultRow): Promise<string> {
	return JSON.stringify([
		result.test,
		result.signature,
		(await mustTarget(db, result.target)).env,
		result.method,
		(await batchById(db, result.batch))?.job,
	]);
}

/**
 * Does this test already fail, with this cause, where the change started? That is the base commit the change
 * names, and only that: where the change names none, or Mainworthy has no result of this test on it, the answer
 * is no. It supplies the comparison hint and the inherited rule's evidence. It reads the base's effective
 * result per lane, after
 * attempts and corrections, never an agent's result and never another repository's.
 */
export async function failsOnBase(db: ReadDb, id: number): Promise<boolean> {
	const result = await resultById(db, id);
	if (!result || result.signature === null || (await signatureById(db, result.signature))?.class === "unknown")
		return false;
	const base = await baseRunOf(db, await mustTarget(db, result.target));
	if (!base) return false;
	const lane = await comparisonLane(db, result);
	return await someAsync(await db.all(Q.effectiveOfTest, { run: base.id, test: result.test }), async (row) => {
		if ((row.outcome !== "fail" && row.outcome !== "error") || row.signature !== result.signature) return false;
		const support = await resultById(db, row.result);
		return support !== null && (await comparisonLane(db, support)) === lane;
	});
}
/** Every change-scope commit, including those whose inherited questions were retired or never raised. */
export const inheritanceRuns = async (db: ReadDb, project: number): Promise<number[]> =>
	(await db.all(Q.inheritanceRuns, { project })).map((row) => row.id);
export const changeRunsOf = async (db: ReadDb, change: number): Promise<number[]> =>
	(await db.all(Q.changeRuns, { change })).map((row) => row.id);
export const countedTestsOf = async (db: ReadDb, run: number) => await db.all(Q.allRunTests, { run });

/** Whether a run counts a test failing with this cause, whether an answer explains it or not. */
export const failsWith = async (db: ReadDb, run: number, signature: number): Promise<boolean> =>
	(await db.get(Q.failsWith, { run, signature })) !== null;

/** Where a run counts these tests passing: each test with each environment it passed in. */
export async function passingIn(
	db: ReadDb,
	run: number,
	tests: readonly number[],
): Promise<{ test: number; env: string }[]> {
	if (tests.length === 0) return [];
	return await mapAsync(await db.all(Q.passingIn, { run, tests }), async (row) => ({
		test: row.test,
		env: (await mustTarget(db, row.target)).env,
	}));
}

/** Failures counted by this commit or pinned in a planned run, including a run already closed on them. */
export async function inheritedResultsOf(db: ReadDb, run: RunRow) {
	const results = new Map((await countedTestsOf(db, run.id)).map((row) => [row.result, row]));
	const accepts = acceptsOf(run);
	if (!("commit" in accepts)) return [...results.values()];
	for (const id of await plannedCounting(db, run.project, accepts.commit)) {
		for (const slot of await db.all(Q.failingSlots, { run: id })) {
			for (const fill of await failingFillsOf(db, slot.id)) {
				if (fill.method === "agent" || (await mustTarget(db, fill.target)).what !== run.accepts_what) continue;
				results.set(fill.id, {
					result: fill.id,
					test: fill.test,
					target: fill.target,
					signature: fill.signature,
					outcome: fill.outcome,
					flipped: 0,
				});
			}
		}
	}
	return [...results.values()].sort((a, b) => a.result - b.result);
}

/** Read each base run once, indexed by the test, cause and matching environment, method and job. */
export async function inheritedEvidenceOf(db: ReadDb, run: RunRow) {
	const bases = new Map<number, Map<string, number[]>>();
	const targets = new Map<number, RunRow | null>();
	return await flatMapAsync(await inheritedResultsOf(db, run), async (row) => {
		if (row.signature === null || (row.outcome !== "fail" && row.outcome !== "error")) return [];
		if ((await signatureById(db, row.signature))?.class === "unknown") return [];
		const result = await resultById(db, row.result);
		if (!result || result.method === "agent") return [];
		if (!targets.has(row.target)) targets.set(row.target, await baseRunOf(db, await mustTarget(db, row.target)));
		const baseRun = targets.get(row.target);
		if (!baseRun) return [];
		let lanes = bases.get(baseRun.id);
		if (!lanes) {
			lanes = new Map();
			bases.set(baseRun.id, lanes);
			for (const base of await countedTestsOf(db, baseRun.id)) {
				if (base.outcome !== "fail" && base.outcome !== "error") continue;
				const support = await resultById(db, base.result);
				if (!support || support.method === "agent") continue;
				const key = await comparisonLane(db, support);
				const ids = lanes.get(key) ?? [];
				ids.push(base.result);
				lanes.set(key, ids);
			}
		}
		const base = lanes.get(await comparisonLane(db, result)) ?? [];
		return base.length > 0 ? [{ ...row, base }] : [];
	});
}

/** Runs affected by this commit's base, or by this commit being a base for another change. */
export async function inheritanceAffected(db: ReadDb, run: RunRow): Promise<number[]> {
	if (run.origin !== "change" || !run.accepts_what) return [];
	const targets = await targetsOfCommit(db, run.project, run.accepts_what);
	const changes = new Set(
		await flatMapAsync(targets, async (target) =>
			target.commit_sha === null ? [] : await changesBasedOn(db, run.project, target.commit_sha, target.repo),
		),
	);
	if (run.change !== null) changes.add(run.change);
	const runs = new Set<number>([run.id]);
	for (const change of changes) for (const row of await db.all(Q.changeRuns, { change })) runs.add(row.id);
	for (const id of [...runs]) {
		const row = await runById(db, id);
		if (!row) continue;
		const accepts = acceptsOf(row);
		if ("commit" in accepts)
			for (const planned of await plannedCounting(db, row.project, accepts.commit)) runs.add(planned);
	}
	return [...runs];
}

/** The run of the commit a change started from, when the change names one and it is not this commit itself. */
async function baseRunOf(db: ReadDb, target: TargetRow): Promise<RunRow | null> {
	if (target.line !== "change" || target.change === null) return null;
	const change = await changeById(db, target.change);
	if (!change?.base_sha) return null;
	const what = codeWhat(change.repo, change.base_sha);
	return what === target.what ? null : await db.get(Q.changeRun, { project: target.project, what });
}

/** How a commit's gate counts one of its tests: the tally key it adds to, and what a failure's key rests on. */
export type CountedTest = {
	test: number;
	result: number;
	target: number;
	outcome: string;
	signature: number | null;
	/** Whether the test both passed and failed in this lane: a retry that changed its outcome on the same code. */
	flipped: boolean;
	standing: Exclude<keyof Tally, "disputed">;
	/** The decision that excuses or attributes a failure: an answer about its cause or this result, or a quarantine. */
	excuse: { decision: number; expires: number | null; quarantined: boolean } | null;
	/** The scope a failure is answered in: the run's own for a change run. */
	scope: string;
};

type Counting = {
	quarantineFor: Awaited<ReturnType<typeof quarantineLookup>>;
	scopeFor: (target: number) => Promise<string>;
};

async function counting(db: ReadDb, run: RunRow): Promise<Counting> {
	// A failure is answered in the scope of the target it was seen on. For a change run that is the run's own
	// scope. A planned run that names no repository can count the same commit in two of them: each of its causes
	// is then classified in its own repository's scope, so one repository's answer never covers the other's failure.
	const scopes = new Map<number, string>();
	return {
		quarantineFor: await quarantineLookup(db, run.project),
		scopeFor: async (target) => {
			let found = scopes.get(target);
			if (found === undefined) {
				found = scopeOf(await mustTarget(db, target), run.id);
				scopes.set(target, found);
			}
			return found;
		},
	};
}

async function standingOf(
	db: ReadDb,
	run: RunRow,
	{ quarantineFor, scopeFor }: Counting,
	row: Awaited<ReturnType<typeof countedTestsOf>>[number],
): Promise<CountedTest> {
	const scope = await scopeFor(row.target);
	const counted = (standing: CountedTest["standing"], excuse: CountedTest["excuse"] = null): CountedTest => ({
		...row,
		flipped: row.flipped === 1,
		standing,
		excuse,
		scope,
	});
	if (row.outcome === "pass") return counted("pass");
	if (row.outcome === "skip") return counted("skipped");
	if (row.outcome === "blocked") return counted("missing");
	const quarantine = await quarantineFor(row.result);
	if (quarantine)
		return counted("excused", { decision: quarantine.decision, expires: quarantine.expires_at, quarantined: true });
	if (row.signature === null) return counted("unexplained");
	const excuse = await excuseForResult(
		db,
		{ id: row.result, project: run.project, signature: row.signature, target: row.target },
		scope,
	);
	if (!excuse) return counted("unexplained");
	return counted(excuse.class === "attributed" ? "attributed" : "excused", {
		decision: excuse.decision,
		expires: excuse.expires_at,
		quarantined: false,
	});
}

/** Every test a commit's gate counts, one row per test and lane, as `count` counts it. A planned run has none. */
export async function countedTests(db: ReadDb, run: RunRow): Promise<CountedTest[]> {
	if (run.origin !== "change") return [];
	const context = await counting(db, run);
	const rows = await countedTestsOf(db, run.id);
	// `run_tests.flipped` stays set once a lane flipped; a correction can withdraw the flip (#630).
	const flipped = await flippedLanes(
		db,
		rows.filter((row) => row.flipped === 1).map((row) => row.result),
	);
	return await mapAsync(
		rows,
		async (row) => await standingOf(db, run, context, { ...row, flipped: flipped.has(row.result) ? 1 : 0 }),
	);
}

export async function* receiptResultBuckets(db: ReadDb, run: RunRow): AsyncGenerator<number> {
	let after = -1;
	for (;;) {
		const page = await db.all(Q.receiptBuckets, { run: run.id, after });
		if (!page.length) return;
		for (const row of page) {
			yield row.bucket;
			after = row.bucket;
		}
	}
}
export async function countedReceiptBucket(db: ReadDb, run: RunRow, bucket: number): Promise<CountedTest[]> {
	const rows = await db.all(Q.receiptBucket, { run: run.id, bucket });
	const context = await counting(db, run);
	const flipped = await flippedLanes(
		db,
		rows.filter((row) => row.flipped === 1).map((row) => row.result),
	);
	return await mapAsync(
		rows,
		async (row) => await standingOf(db, run, context, { ...row, flipped: flipped.has(row.result) ? 1 : 0 }),
	);
}

/**
 * What a run shows right now: its tally, the causes it shows with no excuse in force, and the decisions its
 * excused failures rest on. Read from the results and the excuses; nothing is stored.
 */
async function count(
	db: ReadDb,
	run: RunRow,
): Promise<{ tally: Tally; failing: Set<string>; depends: Map<number, number | null>; quarantined: number }> {
	let quarantined = 0;
	const context = await counting(db, run);
	const { quarantineFor, scopeFor } = context;
	const tally: Tally = emptyTally();
	const failing = new Set<string>();
	const depends = new Map<number, number | null>();

	if (run.origin === "change") {
		for (const row of await countedTestsOf(db, run.id)) {
			const counted = await standingOf(db, run, context, row);
			tally[counted.standing] += 1;
			if (counted.excuse) {
				depends.set(counted.excuse.decision, counted.excuse.expires);
				if (counted.excuse.quarantined) quarantined += 1;
			} else if (counted.standing === "unexplained" && row.signature !== null)
				failing.add(causeKey(row.signature, counted.scope));
		}
	} else {
		for (const row of await db.all(Q.slotGroups, { run: run.id })) {
			if (row.state === "satisfied" || row.state === "waived") tally.pass += row.n;
			else if (row.state === "missing") tally.missing += row.n;
			else if (row.state === "skipped") {
				tally.skipped += row.n;
				tally.missing += row.n;
			}
		}
		// A failing or disputed slot counts once, by all of its causes: it is excused only when every one is.
		for (const slot of await db.all(Q.failingSlots, { run: run.id })) {
			const disputed = slot.state === "disputed";
			const causes = await failingFillsOf(db, slot.id);
			const excuses = await mapAsync(
				causes,
				async (fill) =>
					(await quarantineFor(fill.id)) ??
					(disputed
						? await excuseForDisputedSlot(db, slot.id, fill.id, run.id)
						: await excuseForResult(db, { ...fill, project: run.project }, await scopeFor(fill.target))),
			);
			const quarantinedCauses = excuses.filter((excuse) => excuse && "quarantined" in excuse).length;
			quarantined += quarantinedCauses;
			const open = causes.filter((_, i) => !excuses[i]);
			for (const fill of open) {
				if (fill.signature === null) continue;
				failing.add(causeKey(fill.signature, await scopeFor(fill.target), disputed ? slot.id : undefined));
				if (disputed && !(await excuseForResult(db, { ...fill, project: run.project }, await scopeFor(fill.target))))
					failing.add(causeKey(fill.signature, await scopeFor(fill.target)));
			}
			for (const excuse of excuses) if (excuse) depends.set(excuse.decision, excuse.expires_at);
			if (disputed && (open.length > 0 || causes.length === 0)) tally.disputed += 1;
			else if (excuses.some((excuse) => excuse?.class === "attributed")) tally.attributed += 1;
			else if (open.length > 0 || causes.length === 0) {
				if (disputed) tally.disputed += 1;
				else tally.unexplained += 1;
			} else if (disputed && quarantinedCauses === 0) tally.pass += 1;
			else tally.excused += 1;
		}
	}

	// A run also rests on the decisions that judged results in its slots a mistake: it is recomputed with them.
	if (run.origin === "planned") {
		for (const row of await db.all(Q.discountsOfRun, { run: run.id })) {
			if (!depends.has(row.decision)) depends.set(row.decision, null);
		}
	}

	const jobs = obligationsOf(run).flatMap((o) => (o.kind === "jobs" ? o.jobs : []));
	if (jobs.length > 0) {
		const reported = new Set<string>();
		for (const target of await targetsOfRun(db, run)) {
			for (const job of await processedJobs(db, target.id)) reported.add(job);
		}
		tally.missing += jobs.filter((job) => !reported.has(job)).length;
	}
	return { tally, failing, depends, quarantined };
}

/** The causes a run shows with no excuse in force, by `causeKey`: what an open failure question is about. */
export const unexplainedIn = async (db: ReadDb, run: RunRow): Promise<Set<string>> => (await count(db, run)).failing;

/**
 * Recomputes a run's tally, the questions blocking it and its verdict from the facts, and stores them. Called in
 * the transaction of every event that can change them: an applied batch, a decision, a withdrawn decision.
 * `blockers` are the open questions about this run.
 */
export async function retally(
	ctx: Ctx,
	runId: number,
	blockers: readonly Blocker[],
	emptyReports: Policy["settings"]["emptyReports"] = "pending",
): Promise<Retallied> {
	const run = await runById(ctx.db, runId);
	if (!run) throw new Error(`run ${runId} is missing`);
	const { tally, failing, depends, quarantined } = await count(ctx.db, run);

	// The questions whose answers this run is waiting for. A failure question is one of them exactly when this run
	// shows its cause unexplained: the run is blocked by that failure whatever the policy says a question may hold,
	// so the gate must name the question that would unblock it. One about a cause the run no longer shows is not.
	const blocking = blockers
		.filter((q) =>
			q.kind === "failure"
				? q.signature !== null && q.scope !== null && failing.has(causeKey(q.signature, q.scope, q.slot))
				: q.blocks.includes(run.id),
		)
		.map((q) => q.ref);

	await ctx.db.run(Q.clearDepends, { run: run.id });
	let expiry: number | null = null;
	for (const [decision, expires] of depends) {
		await ctx.db.run(Q.depend, { run: run.id, decision, expires });
		if (expires !== null && (expiry === null || expires < expiry)) expiry = expires;
	}
	const next = verdict({
		tally,
		blocking: blocking.length,
		outstanding: run.outstanding,
		expired: false,
		nothingRequired: await permitsEmpty(ctx, run, tally, emptyReports),
		waiting: await waitingFor(ctx.db, run),
	});
	await ctx.db.run(Q.project, {
		id: run.id,
		tally: JSON.stringify(tally),
		quarantined,
		blocking: JSON.stringify(blocking),
		verdict: next,
		expiry,
		rev: ctx.seq,
	});
	ctx.touched.add(runRef(run));
	const updated = (await runById(ctx.db, run.id)) ?? run;
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
export async function plan(
	ctx: Ctx,
	input: {
		name: string;
		cases: readonly CaseRow[];
		accepts: TargetMatch;
		require: Obligation[];
		assignees: readonly number[];
	},
): Promise<{ run: RunRow; slots: number; already: number }> {
	if (input.cases.length === 0) throw invalid("the selection matches no active case");
	const ids = new Set(input.require.map((o) => o.id));
	if (ids.size !== input.require.length) throw invalid("obligation ids must be unique within a run");
	const exercises = input.require.filter((o): o is ExerciseObligation => o.kind === "exercise");
	if (exercises.length === 0) throw invalid("a planned run needs at least one exercise obligation");

	// A run stands for one commit: an abbreviated hash is settled now, and one that fits two commits is refused.
	const accepts: TargetMatch =
		"commit" in input.accepts
			? { ...input.accepts, commit: await resolveCommit(ctx.db, ctx.project.id, input.accepts.commit) }
			: input.accepts;
	// A commit that exists in two repositories is refused here unless the run says which: the run would otherwise
	// count evidence about either.
	if ("commit" in accepts) await targetByCommit(ctx.db, ctx.project.id, accepts.commit, accepts.repo);
	else if ("build" in accepts) await buildWhat(ctx.db, ctx.project.id, accepts.build, accepts.env);
	else if (input.require.some((o) => o.kind === "jobs")) {
		throw invalid("a run that counts only what is typed into it cannot wait for a job: plan it for a commit");
	}
	const no = await ctx.nextNo("run");
	const what = null;
	const { id: insertedId } = await ctx.db.one(Q.insert, {
		project: ctx.project.id,
		no,
		name: input.name,
		origin: "planned",
		accepts: JSON.stringify(accepts),
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
			await ctx.db.run(Q.insertSlot, {
				run: insertedId,
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
	const run = await runById(ctx.db, insertedId);
	if (!run) throw new Error("run was not stored");
	ctx.touched.add(ref("run", no));

	const targets = await targetsOfRun(ctx.db, run);
	const already =
		targets.length > 0
			? await fillFromPrior(
					ctx,
					run,
					exercises,
					targets.map((t) => t.id),
				)
			: 0;
	await inheritAccepted(ctx, run);
	return { run: (await retally(ctx, run.id, [])).run, slots: rank, already };
}

/**
 * A run planned while a report it will count is accepted and not yet applied waits for that report from the
 * start, exactly as a run that existed when the report arrived: it reads `pending` until the report is applied,
 * and is not signed off on what it showed before. The reports are the ones applying them will mark applied for
 * this run: those on a target the run counts, and the first report of its commit that a gate counts.
 */
async function inheritAccepted(ctx: Ctx, run: RunRow): Promise<void> {
	const accepts = acceptsOf(run);
	if ("self" in accepts) return;
	for (const batch of await acceptedBatches(ctx.db)) {
		if (batch.project !== run.project) continue;
		const target = await mustTarget(ctx.db, batch.target);
		if ("commit" in accepts && target.commit_sha !== accepts.commit) continue;
		if (
			(await matches(ctx.db, run, target, batch.run)) ||
			("commit" in accepts && (await firstCountedReport(ctx.db, batch, target)))
		)
			await ctx.db.run(Q.accepted, { id: run.id, seq: batch.seq });
	}
}

async function fillFromPrior(
	ctx: Ctx,
	run: RunRow,
	exercises: readonly ExerciseObligation[],
	targets: readonly number[],
): Promise<number> {
	let satisfied = 0;
	for (const slot of await ctx.db.all(Q.slotsOfRun, { run: run.id, after: -1, limit: 1_000_000 })) {
		const obligation = exercises.find((o) => o.id === slot.obligation);
		if (!obligation) continue;
		const prior = await resultsOfCaseOnTargets(ctx.db, slot.case_id, targets);
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
				caseMethods: await methodsOf(ctx.db, slot, result),
			});
			if (!admitted) continue;
			// A result a decision has judged a mistake is admitted as that: it counts here no more than it does in
			// the run it was judged in or in its commit's gate, and it returns here too if the decision is withdrawn.
			const judged = await ctx.db.get(Q.judgedBy, { result: result.id });
			await ctx.db.run(Q.admit, { slot: slot.id, result: result.id, run: run.id, admitted });
			if (judged) await ctx.db.run(Q.discount, { slot: slot.id, result: result.id, decision: judged.decision });
			any = true;
		}
		if (any && (await refreshSlot(ctx, slot, obligation)).state === "satisfied") satisfied++;
	}
	return satisfied;
}

// ── Standing ───────────────────────────────────────────────────────────────────────────────────────────────

/** Closes a run. Standing: only by a `signoff` decision, which a rule may make. */
export async function closeRun(ctx: Ctx, witness: Witness, run: RunRow): Promise<void> {
	await ctx.db.run(Q.setState, { id: run.id, state: "closed", signoff: decisionOf(witness, "signoff"), rev: ctx.seq });
	await ctx.db.run(Q.releaseRun, { run: run.id });
	ctx.touched.add(runRef(run));
}

/**
 * Reopens a run when the sign-off `decision` is withdrawn or stops holding. It does nothing when the run was
 * closed by another decision: withdrawing an old sign-off must not undo a newer one.
 */
export async function reopenRun(ctx: Ctx, run: RunRow, decision: number): Promise<void> {
	if (run.signoff !== decision) return;
	await ctx.db.run(Q.setState, { id: run.id, state: "open", signoff: null, rev: ctx.seq });
	ctx.touched.add(runRef(run));
	await catchUp(ctx, run);
}

/**
 * A reopened run reconciles its slots with the current evidence. A result its producer corrected is withdrawn
 * here too, one a decision called a mistake is discounted here too, any qualifying results not yet admitted
 * are admitted, and every slot is rebuilt. This also catches up runs closed before late reports were accepted.
 * The caller recomputes the run, which asks about each failure it now shows.
 */
async function catchUp(ctx: Ctx, run: RunRow): Promise<void> {
	const exercises = obligationsOf(run).filter((o): o is ExerciseObligation => o.kind === "exercise");
	const slots = await ctx.db.all(Q.slotsOfRun, { run: run.id, after: -1, limit: 1_000_000 });
	// Every row, whatever else is recorded on it: a result a decision set aside can have been corrected too, and
	// if that decision is withdrawn later the correction must already be known here.
	for (const slot of slots) {
		for (const held of await ctx.db.all(Q.heldBy, { slot: slot.id })) {
			if (held.corrected === 0 && (await isWithdrawn(ctx.db, held.result)))
				await ctx.db.run(Q.correctInSlot, { slot: slot.id, result: held.result });
		}
	}
	const targets = (await targetsOfRun(ctx.db, run)).map((target) => target.id);
	if (targets.length > 0) await fillFromPrior(ctx, run, exercises, targets);
	for (const slot of slots) {
		for (const held of await ctx.db.all(Q.heldBy, { slot: slot.id })) {
			if (held.discounted_by !== null) continue;
			const judged = await ctx.db.get(Q.judgedBy, { result: held.result });
			if (judged) await ctx.db.run(Q.discount, { slot: slot.id, result: held.result, decision: judged.decision });
		}
		await refreshSlot(ctx, slot, exercises.find((o) => o.id === slot.obligation) ?? null);
	}
	ctx.recompute.add(run.id);
}

/** Judging a result mistaken retains its global meaning, while the caller names the exact evidence judged. */
export async function discountResults(
	ctx: Ctx,
	witness: Witness,
	results: readonly number[],
): Promise<[number, number][]> {
	const decision = decisionOf(witness, "failure");
	const corrected: [number, number][] = [];
	const touched = new Set<number>();
	for (const id of new Set(results)) {
		const result = await resultById(ctx.db, id);
		if (!result) continue;
		for (const held of await ctx.db.all(Q.slotsOfResult, { result: id })) {
			const where = await slotById(ctx.db, held.slot);
			const of = where ? await runById(ctx.db, where.run) : null;
			// A closed run keeps what it was closed on.
			if (!where || of?.state !== "open") continue;
			await ctx.db.run(Q.discount, { slot: where.id, result: id, decision });
			corrected.push([where.id, id]);
			touched.add(where.id);
		}
		const commit = await commitRunOf(ctx.db, result.project, result.target);
		if (commit) await refoldLaneOf(ctx, commit, id);
	}
	for (const id of touched) await refreshSlotById(ctx, id);
	return corrected;
}

/**
 * Puts back everything the `mistaken` decision `decision` discounted, in every slot that holds it, and only
 * that: a result its producer has since corrected stays corrected, and one another decision discounted stays
 * discounted.
 */
export async function restoreFailures(ctx: Ctx, decision: number): Promise<void> {
	const rows = await ctx.db.all(Q.discountedBy, { decision });
	for (const row of rows) await ctx.db.run(Q.undiscount, { slot: row.slot, result: row.result, decision });
	for (const result of new Set(rows.map((row) => row.result))) await recount(ctx, result);
	for (const slot of new Set(rows.map((row) => row.slot))) await refreshSlotById(ctx, slot);
}

async function refreshSlotById(ctx: Ctx, id: number): Promise<void> {
	const slot = await slotById(ctx.db, id);
	const run = slot ? await runById(ctx.db, slot.run) : null;
	if (!slot || !run) return;
	const obligation = obligationsOf(run).find((o) => o.id === slot.obligation);
	await refreshSlot(ctx, slot, obligation?.kind === "exercise" ? obligation : null);
	// The run this slot belongs to is recomputed before the command ends, whether or not the question that
	// caused this named it: a slot never changes under a run whose stored gate stays as it was.
	ctx.recompute.add(run.id);
	ctx.touched.add(runRef(run));
}

const commitRunOf = async (db: ReadDb, project: number, target: number): Promise<RunRow | null> =>
	await db.get(Q.changeRun, { project, what: (await mustTarget(db, target)).what });

/** Counts a result in its commit's gate again, after the decision that called it a mistake is withdrawn. */
async function recount(ctx: Ctx, id: number): Promise<void> {
	const result = await resultById(ctx.db, id);
	const commit = result ? await commitRunOf(ctx.db, result.project, result.target) : null;
	if (commit) await refoldLaneOf(ctx, commit, id);
}

/**
 * Recomputes what a commit's gate counts for the lane a result is in, from that lane's whole history: every
 * result its producer has not corrected and no decision has called a mistake, folded by the rule a report is
 * folded by (`replacesInLane`). Called when a result leaves or returns for a reason other than a newer report: a
 * correction, a `mistaken` decision, that decision withdrawn. The attempt before it then stands again, exactly
 * as it does in a slot, which keeps every admitted result and folds them the same way.
 */
async function refoldLaneOf(ctx: Ctx, commit: RunRow, id: number): Promise<void> {
	const result = await resultById(ctx.db, id);
	if (!result || result.method === "agent") return;
	const job = (await batchById(ctx.db, result.batch))?.job ?? "";
	const lane = `${result.target}:${job}:${result.actor}`;
	const before = await ctx.db.get(Q.laneRow, { run: commit.id, test: result.test, lane });
	const held = await heldInLane(
		ctx.db,
		{ target: result.target, test: result.test, actor: result.actor, job },
		(next) => next.method !== "agent",
	);
	await ctx.db.run(Q.dropLane, { run: commit.id, test: result.test, lane });
	if (held) {
		await ctx.db.run(Q.upsertRunTest, {
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
	ctx.recompute.add(commit.id);
	ctx.touched.add(runRef(commit));
}

// ── The gate ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The gate of a commit, a run or a change. One row read and two comparisons: an unapplied upload or an expired
 * hold makes the answer `pending` whatever the stored verdict says, so a stale green is never served.
 */
export async function gate(ctx: Ctx<ReadDb>, input: GateTarget): Promise<GateStatus> {
	const run = await gateRun(ctx, input);
	return run ? await gateOf(ctx, run) : nothingCounted();
}

type GateTarget = {
	commit?: string | undefined;
	run?: string | undefined;
	change?: string | undefined;
	repo?: string | undefined;
};

/**
 * The gate of one commit in one repository, `null` being the commit reported with none. Unlike `gate` by commit, it
 * never weighs other repositories that reported the same hash: the caller already knows which one it means.
 */
export async function gateOfCommitIn(ctx: Ctx<ReadDb>, repo: string | null, commit: string): Promise<GateStatus> {
	const run = await ctx.db.get(Q.changeRun, { project: ctx.project.id, what: codeWhat(repo, commit) });
	return run ? await gateOf(ctx, run) : nothingCounted();
}

/** The run whose gate a commit, a run or a change has. Null for a commit nothing a gate counts was reported for. */
export async function gateRun(ctx: Ctx<ReadDb>, input: GateTarget): Promise<RunRow | null> {
	if (input.run) return await mustRun(ctx.db, ctx.project.id, input.run);
	let what: string | null = null;
	if (input.commit) what = (await targetByCommit(ctx.db, ctx.project.id, input.commit, input.repo))?.what ?? null;
	else if (input.change) {
		// The head of this change in its own repository, never a commit of the same name in another.
		const change = await changeByKey(ctx.db, ctx.project.id, input.change);
		if (change?.head_sha) what = codeWhat(change.repo, change.head_sha);
	} else throw invalid("gate needs a commit, a run or a change");
	return what ? await ctx.db.get(Q.changeRun, { project: ctx.project.id, what }) : null;
}

/** The gate of a commit no pipeline or person has reported: nothing is proven. An agent's report does not change that. */
export const nothingCounted = (): GateStatus => ({
	run: null,
	verdict: "pending",
	reason: "pending: nothing a gate counts has been reported for this commit",
	tally: { ...emptyTally() },
	open: [],
	url: null,
	stale: false,
});

/**
 * The shards a commit's run waits for (decision 0092). A planned run says which jobs it requires, and a run of
 * what is typed into it has no jobs, so only a commit's own run waits for shards.
 */
export const waitingFor = async (db: ReadDb, run: RunRow): Promise<ShardWait[]> =>
	run.origin === "change" ? await waitingShards(db, await targetsOfRun(db, run)) : [];

/**
 * Whether more of a commit's results are on their way: a report accepted and not yet applied, or a shard of a job
 * that has not reported. What has been applied so far cannot say the commit's failures are gone.
 */
export const stillArriving = async (db: ReadDb, run: RunRow): Promise<boolean> =>
	run.outstanding > 0 || (await waitingFor(db, run)).length > 0;

/** The same verdict with scalar explanations, used by receipt manifests. Collections remain separately paged. */
export async function receiptGateOf(ctx: Ctx<ReadDb>, run: RunRow) {
	const tally = json<Tally>(run.tally);
	const openCount = (await ctx.db.get(Q.receiptBlockingCount, { id: run.id }))?.n ?? 0;
	let waitingCount = 0;
	let missing = 0;
	let first: ShardWait | undefined;
	if (run.accepts_what)
		for await (const page of waitingShardPages(ctx.db, run.project, run.accepts_what))
			for (const wait of page) {
				first ??= wait;
				waitingCount++;
				missing += wait.missing.length;
			}
	const expired = run.next_expiry !== null && run.next_expiry <= ctx.now;
	const facts = {
		tally,
		blocking: openCount,
		outstanding: run.outstanding,
		expired,
		nothingRequired: run.verdict === "passed",
		waiting: first ? [first] : [],
	};
	const now = verdict(facts);
	let reason = explainVerdict({ ...facts, waiting: [] });
	if (waitingCount && !expired && !run.outstanding)
		reason =
			now === "pending" ? `pending: waiting for ${missing} shards` : `${reason}; still waiting for ${missing} shards`;
	if (run.quarantined)
		reason += `; ${run.quarantined} quarantined ${run.quarantined === 1 ? "failure" : "failures"} recorded, not blocking`;
	return {
		gate: {
			run: runRef(run),
			verdict: now,
			reason,
			tally,
			url: null,
			stale: now !== run.verdict,
			...(run.quarantined ? { quarantined: run.quarantined } : {}),
		},
		openCount,
		waitingCount,
	};
}

/** Raw blocking refs are chunked without parsing a potentially large array; waits have at most 1,000 indices. */
export async function* receiptGateEvidence(db: ReadDb, run: RunRow): AsyncGenerator<string> {
	for (let at = 0; at < run.blocking.length; at += 4096)
		yield JSON.stringify({ collection: "open", part: at / 4096, text: run.blocking.slice(at, at + 4096) });
	if (run.accepts_what)
		for await (const page of waitingShardPages(db, run.project, run.accepts_what))
			for (const wait of page) yield JSON.stringify({ collection: "waiting", item: wait });
}

export async function gateOf(ctx: Ctx<ReadDb>, run: RunRow): Promise<GateStatus> {
	const tally = json<Tally>(run.tally);
	const open = json<string[]>(run.blocking);
	const expired = run.next_expiry !== null && run.next_expiry <= ctx.now;
	const waiting = await waitingFor(ctx.db, run);
	const facts = {
		tally,
		blocking: open.length,
		outstanding: run.outstanding,
		expired,
		nothingRequired: run.origin === "change" && run.verdict === "passed",
		waiting,
	};
	const now = verdict(facts);
	return {
		run: runRef(run),
		verdict: now,
		reason:
			explainVerdict(facts) +
			(run.quarantined
				? `; ${run.quarantined} quarantined ${run.quarantined === 1 ? "failure" : "failures"} recorded, not blocking`
				: ""),
		...(run.quarantined ? { quarantined: run.quarantined } : {}),
		tally: { ...tally },
		open,
		url: null,
		stale: now !== run.verdict,
		...(waiting.length > 0 ? { waiting } : {}),
	};
}

/** The exception applies only to a commit with a declaration and no ordinary reports, never a planned run. */
async function permitsEmpty(
	ctx: Ctx,
	run: RunRow,
	tally: Tally,
	emptyReports: Policy["settings"]["emptyReports"],
): Promise<boolean> {
	return (
		run.origin === "change" &&
		Object.values(tally).every((n) => n === 0) &&
		emptyReports === "nothing-required" &&
		(await nothingRequiredOn(ctx.db, await targetsOfRun(ctx.db, run)))
	);
}

/** A policy choice changes existing empty commit gates as well as future reports. */
export async function reconsiderEmptyReports(ctx: Ctx): Promise<void> {
	for (const run of await ctx.db.all(Q.emptyChangeRuns, { project: ctx.project.id })) ctx.recompute.add(run.id);
}

async function findAsync<T>(rows: readonly T[], callback: (value: T) => Promise<unknown>) {
	for (const row of rows) if (await callback(row)) return row;
	return undefined;
}

async function filterAsync<T>(rows: readonly T[], callback: (value: T) => Promise<unknown>) {
	const out: T[] = [];
	for (const row of rows) if (await callback(row)) out.push(row);
	return out;
}

async function someAsync<T>(rows: readonly T[], callback: (value: T) => Promise<unknown>) {
	for (const row of rows) if (await callback(row)) return true;
	return false;
}

async function mapAsync<T, R>(rows: readonly T[], callback: (value: T) => Promise<R>) {
	const out: R[] = [];
	for (const row of rows) out.push(await callback(row));
	return out;
}

async function flatMapAsync<T, R>(rows: readonly T[], callback: (value: T) => Promise<R | R[]>) {
	const out: R[] = [];
	for (const row of rows) {
		const found = await callback(row);
		out.push(...(Array.isArray(found) ? found : [found]));
	}
	return out;
}
