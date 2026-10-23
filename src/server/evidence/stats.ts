// What the reports read of the results (decision 0095). Facts only: nothing here changes a gate or an excuse.

import type { LocalDay } from "../../core/days.ts";
import type { MethodKind } from "../../core/model.ts";
import type { OutcomeCounts } from "../../core/stats.ts";
import { type ReadDb, sql } from "../kernel/db.ts";
import { uncorrectedResults } from "./evidence.ts";

type Window = { project: number; from: number; to: number };
type Tally = { slot: number; outcome: string; quarantined: number; n: number };
/**
 * The results are counted in quarters of an hour, and each quarter falls in one of the reader's days: every time
 * zone's midnight is a whole quarter of an hour in UTC. Joining each result to its day in SQL cost ten times more.
 */
const SLOT = 900_000;

const Q = {
	// Each lane (a target, test, producer, method and job) counts the result it ended with: ranked by the rule a
	// gate counts with (`replacesInLane`), for results that arrived in the order of their attempts. A decisive
	// result (pass, fail, error) before one that decided nothing, a higher attempt before a lower, the worse of one
	// attempt, then the later. A corrected result is not ranked: its correction stands in its place.
	effective: sql<Window & { method: string | null }, Tally>(`
		WITH ranked AS (
		  SELECT r.at, r.outcome, r.quarantine_decision IS NOT NULL AS quarantined,
		         row_number() OVER (
		           PARTITION BY r.target, r.test, r.actor, r.method, b.job
		           ORDER BY r.outcome IN ('pass', 'fail', 'error') DESC, r.attempt DESC,
		                    CASE r.outcome WHEN 'fail' THEN 3 WHEN 'error' THEN 3 WHEN 'pass' THEN 2 WHEN 'blocked' THEN 1 ELSE 0 END DESC,
		                    r.seq DESC, r.ord DESC
		         ) AS rank
		  FROM results r JOIN batches b ON b.id = r.batch
		  WHERE r.project = $project AND r.at >= $from AND r.at < $to AND ($method IS NULL OR r.method = $method)
		    AND ${uncorrectedResults("r.id")}
		)
		SELECT k.at / ${SLOT} AS slot, k.outcome, k.quarantined, count(*) AS n
		FROM ranked k WHERE k.rank = 1
		GROUP BY slot, k.outcome, k.quarantined
	`),
	// A flip of an automated test, unless its producer corrected either side of it: then the pass and the failure
	// were not both what happened.
	flaky: sql<{ project: number; since: number }, { test: number; flips: number; last_at: number }>(`
		SELECT f.test, count(*) AS flips, max(r.at) AS last_at
		FROM flips f JOIN results r ON r.id = f.second_result JOIN tests t ON t.id = f.test
		WHERE f.project = $project AND r.at >= $since AND t.kind = 'auto'
		  AND ${uncorrectedResults("f.first_result", "f.second_result")}
		GROUP BY f.test ORDER BY flips DESC, last_at DESC, f.test
	`),
	// The same flips, for the tests asked about: what a gate's list says of each row.
	flipsOf: sql<{ project: number; since: number; tests: string }, { test: number; flips: number }>(`
		SELECT f.test, count(*) AS flips
		FROM json_each($tests) asked CROSS JOIN flips f ON f.project = $project AND f.test = asked.value
		JOIN results r ON r.id = f.second_result JOIN tests t ON t.id = f.test
		WHERE r.at >= $since AND t.kind = 'auto' AND ${uncorrectedResults("f.first_result", "f.second_result")}
		GROUP BY f.test
	`),
	// Automated is what the test is, whoever reported it: an agent can report an automated test too.
	reporting: sql<{ project: number; since: number }, { n: number }>(`
		SELECT count(DISTINCT r.test) AS n FROM results r JOIN tests t ON t.id = r.test
		WHERE r.project = $project AND r.at >= $since AND t.kind = 'auto'
	`),
	// An attempt that a higher attempt of the same lane repeated, once per attempt. What ran is an execution (a result
	// that corrects nothing) at its own attempt; its corrections say what its outcome and time were, whatever attempt
	// they were sent with (a correction is stored at an attempt no older than the one it corrects, so by its own attempt
	// it could hide the attempt it repeats). What stands of an execution is every result in its tree of corrections that
	// nothing corrects in turn, as the gate counts it; of what stands for one attempt, the worse, then the later, gives
	// its time. Runner tries count with that result. Don't add known try durations to a repeated attempt's duration:
	// Playwright already sums its executions. Untimed tries remain unknown: Surefire times only one execution.
	// Legacy/imported durations can exceed today's input limit: total() avoids integer overflow, and returned time
	// stays between zero and the wire format's largest safe integer.
	// A try on a correction makes its original lane eligible; every duplicate execution of that lane must still compete.
	reruns: sql<{ project: number; since: number }, { test: number; reruns: number; lost: number; unknown: number }>(`
		WITH RECURSIVE tried(result) AS (
		  SELECT r.id FROM results r
		  WHERE r.project = $project AND r.at >= $since
		    AND EXISTS (SELECT 1 FROM result_tries t WHERE t.result = r.id)
		  UNION
		  SELECT r.corrects FROM tried t JOIN results r ON r.id = t.result WHERE r.corrects IS NOT NULL
		),
		tried_lanes AS MATERIALIZED (
		  SELECT DISTINCT r.target, r.test, r.actor, r.method, b.job, r.attempt
		  FROM tried t JOIN results r ON r.id = t.result JOIN batches b ON b.id = r.batch
		  WHERE r.corrects IS NULL
		),
		executions AS (
		  SELECT r.id, r.test, r.target, r.actor, r.method, b.job, r.attempt, r.outcome, r.duration_ms, r.seq, r.ord,
		    EXISTS (
		      SELECT 1 FROM results n JOIN batches nb ON nb.id = n.batch
		      WHERE n.target = r.target AND n.test = r.test AND n.actor = r.actor AND n.method = r.method
		        AND nb.job = b.job AND n.attempt > r.attempt AND n.corrects IS NULL
		    ) AS repeated
		  FROM results r JOIN batches b ON b.id = r.batch
		  WHERE r.project = $project AND r.at >= $since AND r.corrects IS NULL
		    AND (repeated OR EXISTS (
		      SELECT 1 FROM tried_lanes t
		      WHERE t.target = r.target AND t.test = r.test AND t.actor = r.actor AND t.method = r.method
		        AND t.job = b.job AND t.attempt = r.attempt
		    ))
		),
		chain(root, id, outcome, duration_ms, seq, ord) AS (
		  SELECT e.id, e.id, e.outcome, e.duration_ms, e.seq, e.ord FROM executions e
		  UNION ALL
		  SELECT k.root, c.id, c.outcome, c.duration_ms, c.seq, c.ord FROM chain k JOIN results c ON c.corrects = k.id
		),
		attempts AS (
		  SELECT e.test, k.id, k.duration_ms, e.repeated,
		         row_number() OVER (
		           PARTITION BY e.target, e.test, e.actor, e.method, e.job, e.attempt
		           ORDER BY CASE k.outcome WHEN 'fail' THEN 3 WHEN 'error' THEN 3 WHEN 'pass' THEN 2 WHEN 'blocked' THEN 1 ELSE 0 END DESC,
		                    k.seq DESC, k.ord DESC
		         ) AS rank
		  FROM executions e JOIN chain k ON k.root = e.id
		  WHERE ${uncorrectedResults("k.id")}
		),
		costs AS (
		  SELECT a.test, a.repeated, a.duration_ms, count(t.id) AS tries,
		         total(t.duration_ms) AS tried_ms,
		         count(t.id) - count(t.duration_ms) AS untimed_tries
		  FROM attempts a LEFT JOIN result_tries t ON t.result = a.id
		  WHERE a.rank = 1
		  GROUP BY a.id
		)
		SELECT a.test, sum(a.repeated + a.tries) AS reruns,
		       CAST(max(0, min(total(CASE WHEN a.repeated AND a.duration_ms IS NOT NULL THEN a.duration_ms ELSE a.tried_ms END),
		                            ${Number.MAX_SAFE_INTEGER})) AS INTEGER) AS lost,
		       sum(a.untimed_tries + (a.repeated AND a.duration_ms IS NULL)) AS unknown
		FROM costs a WHERE a.repeated OR a.tries > 0
		GROUP BY a.test
	`),
	automated: sql<{ project: number }, { case_id: number }>(
		"SELECT DISTINCT case_id FROM tests WHERE project = $project AND kind = 'auto' AND case_id IS NOT NULL",
	),
	byHand: sql<{ project: number; since: number }, { case_id: number; runs: number; time: number | null }>(`
		SELECT t.case_id, count(*) AS runs,
		       CASE WHEN count(r.duration_ms) = 0 THEN NULL
		            ELSE CAST(max(0, min(total(r.duration_ms), ${Number.MAX_SAFE_INTEGER})) AS INTEGER) END AS time
		FROM results r JOIN tests t ON t.id = r.test
		WHERE r.project = $project AND r.at >= $since AND r.method = 'human' AND t.case_id IS NOT NULL
		  AND ${uncorrectedResults("r.id")}
		GROUP BY t.case_id
	`),
	// `+r.at` keeps each test's read on `results_test`, newest first, which stops at its first match; on
	// `results_at` it would read the whole window once for every test.
	latest: sql<{ project: number; since: number; cases: string }, { case_id: number; outcome: string | null }>(`
		SELECT t.case_id, (
		  SELECT r.outcome FROM results r
		  WHERE r.project = t.project AND r.test = t.id AND +r.at >= $since
		    AND ${uncorrectedResults("r.id")}
		  ORDER BY r.seq DESC, r.ord DESC LIMIT 1
		) AS outcome
		FROM tests t WHERE t.project = $project AND t.case_id IN (SELECT value FROM json_each($cases))
	`),
};

const empty = (): OutcomeCounts => ({ pass: 0, fail: 0, skip: 0, blocked: 0, quarantined: 0, rate: null });
function add(counts: OutcomeCounts, outcome: string, quarantined: boolean, n: number): void {
	if (outcome === "pass") counts.pass += n;
	else if (outcome === "skip") counts.skip += n;
	else if (outcome === "blocked") counts.blocked += n;
	else if (quarantined) counts.quarantined += n;
	else counts.fail += n;
}
const rated = (counts: OutcomeCounts): OutcomeCounts => {
	const decided = counts.pass + counts.fail;
	return { ...counts, rate: decided === 0 ? null : counts.pass / decided };
};

/**
 * Each day's results, one per lane: the result each lane (a target, test, producer, method and job) ended with in
 * the window. An attempt that was run again, and a result its producer corrected, are not counted. A failure that a
 * quarantine covered is counted as `quarantined`, apart from `fail`.
 */
export async function outcomesByDay(
	db: ReadDb,
	input: { project: number; days: readonly LocalDay[]; method: MethodKind | null },
): Promise<OutcomeCounts[]> {
	const counts = input.days.map(empty);
	const from = input.days[0]?.from ?? 0;
	const to = input.days.at(-1)?.to ?? 0;
	for (const row of await db.all(Q.effective, { project: input.project, from, to, method: input.method })) {
		const at = row.slot * SLOT;
		const day = counts[input.days.findIndex((d) => at >= d.from && at < d.to)];
		if (day) add(day, row.outcome, row.quarantined === 1, row.n);
	}
	return counts.map(rated);
}

/** The sum of several days' counts, with its own rate. */
export function totalOf(days: readonly OutcomeCounts[]): OutcomeCounts {
	const total = empty();
	for (const day of days) {
		total.pass += day.pass;
		total.fail += day.fail;
		total.skip += day.skip;
		total.blocked += day.blocked;
		total.quarantined += day.quarantined;
	}
	return rated(total);
}

/** Tests with a flip (a pass and a failure on the same code) since a moment, the most flips first. */
export const flakyTests = async (db: ReadDb, project: number, since: number) =>
	await db.all(Q.flaky, { project, since });
/** How often each of these tests flipped since a moment, counted as the flaky report counts; a test with none is absent. */
export async function flipsOf(
	db: ReadDb,
	project: number,
	tests: readonly number[],
	since: number,
): Promise<Map<number, number>> {
	if (tests.length === 0) return new Map();
	const rows = await db.all(Q.flipsOf, { project, since, tests: JSON.stringify([...new Set(tests)]) });
	return new Map(rows.map((row) => [row.test, row.flips]));
}
/** How many automated tests reported a result since a moment. */
export const testsReporting = async (db: ReadDb, project: number, since: number): Promise<number> =>
	db.get(Q.reporting, { project, since })?.n ?? 0;
/** Per test, repeated pipeline attempts and earlier runner tries since a moment, with their time counted once. */
export const rerunsByTest = async (db: ReadDb, project: number, since: number) =>
	await db.all(Q.reruns, { project, since });
/** The cases with at least one automated test. */
export const automatedCases = async (db: ReadDb, project: number): Promise<Set<number>> =>
	new Set((await db.all(Q.automated, { project })).map((row) => row.case_id));
/** Per case, the results a person recorded since a moment, and the time of those that said it. */
export const runsByHand = async (db: ReadDb, project: number, since: number) =>
	await db.all(Q.byHand, { project, since });

export type CaseOutcome = "passed" | "failed" | "other" | "notRun";
/**
 * Each case by the latest result of each of its tests since a moment: failed when one of them failed, passed when
 * none failed and one passed, other when they were only skipped or blocked, not run when none has a result.
 */
export async function caseOutcomes(
	db: ReadDb,
	project: number,
	cases: readonly number[],
	since: number,
): Promise<Map<number, CaseOutcome>> {
	const latest = new Map<number, string[]>();
	for (const row of await db.all(Q.latest, { project, since, cases: JSON.stringify(cases) }))
		if (row.outcome !== null) latest.set(row.case_id, [...(latest.get(row.case_id) ?? []), row.outcome]);
	const out = new Map<number, CaseOutcome>();
	for (const id of cases) {
		const outcomes = latest.get(id) ?? [];
		out.set(
			id,
			outcomes.some((o) => o === "fail" || o === "error")
				? "failed"
				: outcomes.includes("pass")
					? "passed"
					: outcomes.length > 0
						? "other"
						: "notRun",
		);
	}
	return out;
}
