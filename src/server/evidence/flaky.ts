import type { FlakyDetectionSettings, SameCodeEvidence } from "../../core/flaky.ts";
import { type ReadDb, sql } from "../kernel/db.ts";
import { resultLocations, targetsByIds, uncorrectedResults } from "./evidence.ts";

type Flip = {
	test: number;
	signature: number;
	text: string;
	class: "assertion" | "timeout" | "infra";
	total: number;
	target: number;
	commit_sha: string;
	env: string;
	job: string;
	actor: number;
	first_result: number;
	second_result: number;
	first_outcome: "pass" | "fail" | "error";
	second_outcome: "pass" | "fail" | "error";
	first_attempt: number;
	second_attempt: number;
	first_try: number | null;
	second_try: number | null;
};

const Q = {
	// Each end of a flip is a result, or a runner's try of one (decision 0129): its outcome and cause are the try's
	// then, and a flip inside one run has the same result at both ends, its tries in order.
	evidence: sql<{ project: number; tests: readonly number[]; since: number }, Flip>(`
		SELECT * FROM (
			SELECT f.test, s.id AS signature, s.text, s.class, t.id AS target, t.commit_sha, t.env, b.job, r.actor, f.first_result, f.second_result,
			       coalesce(ft.outcome, a.outcome) AS first_outcome, coalesce(st.outcome, r.outcome) AS second_outcome,
			       a.attempt AS first_attempt, r.attempt AS second_attempt, ft.try AS first_try, st.try AS second_try,
			       count(*) OVER (PARTITION BY f.test, s.id) AS total,
			       row_number() OVER (PARTITION BY f.test, s.id ORDER BY f.seq DESC, f.id DESC) AS sample
			FROM flips f
			JOIN results a ON a.id = f.first_result
			JOIN results r ON r.id = f.second_result
			LEFT JOIN result_tries ft ON ft.id = f.first_try
			LEFT JOIN result_tries st ON st.id = f.second_try
			JOIN targets t ON t.id = f.target
			JOIN batches b ON b.id = r.batch
			JOIN batches earlier ON earlier.id = a.batch
			JOIN signatures s ON s.id = CASE WHEN coalesce(ft.outcome, a.outcome) = 'pass'
			                                 THEN CASE WHEN st.id IS NULL THEN r.signature ELSE st.signature END
			                                 ELSE CASE WHEN ft.id IS NULL THEN a.signature ELSE ft.signature END END
			WHERE f.project = $project AND f.test = ANY($tests::bigint[]) AND t.commit_sha IS NOT NULL
			  AND s.class != 'unknown'
			  AND a.target = r.target AND a.test = r.test AND a.actor = r.actor AND earlier.job = b.job
			  AND a.method = 'auto' AND r.method = 'auto'
			  AND (a.attempt < r.attempt OR (a.id = r.id AND ft.try < coalesce(st.try, ft.try + 1)))
			  AND a.at >= $since AND r.at >= $since
			  AND ((coalesce(ft.outcome, a.outcome) = 'pass' AND coalesce(st.outcome, r.outcome) IN ('fail', 'error'))
			    OR (coalesce(st.outcome, r.outcome) = 'pass' AND coalesce(ft.outcome, a.outcome) IN ('fail', 'error')))
			  AND ${uncorrectedResults("f.project", "a.id", "r.id")}
			  AND (a.id = r.id OR NOT EXISTS (
			    SELECT 1 FROM results worse JOIN batches wb ON wb.id = worse.batch
			    WHERE worse.target = r.target AND worse.test = r.test AND worse.actor = r.actor
			      AND worse.method = 'auto' AND wb.job = b.job AND worse.outcome IN ('fail', 'error')
			      AND worse.attempt = CASE WHEN coalesce(ft.outcome, a.outcome) = 'pass' THEN a.attempt ELSE r.attempt END
			      AND ${uncorrectedResults("f.project", "worse.id")}
			  ))
		) WHERE sample <= 3 ORDER BY test, CASE class WHEN 'assertion' THEN 0 WHEN 'timeout' THEN 1 ELSE 2 END, signature, sample
	`),
};

/** Suggestions from the incrementally recorded flips. This reads facts and never changes an excuse or a gate. */
export async function sameCodeEvidence(
	db: ReadDb,
	input: { project: number; test: number; now: number; settings: FlakyDetectionSettings },
): Promise<SameCodeEvidence> {
	const evidence = (await sameCodeEvidenceByTests(db, { ...input, tests: [input.test] })).get(input.test);
	if (!evidence) throw new Error(`flaky evidence test ${input.test} was not requested`);
	return evidence;
}

/** One read phase for sibling tests. Call again after any writes that can change their evidence. */
export async function sameCodeEvidenceByTests(
	db: ReadDb,
	input: { project: number; tests: readonly number[]; now: number; settings: FlakyDetectionSettings },
): Promise<ReadonlyMap<number, SameCodeEvidence>> {
	const evidence = new Map<number, SameCodeEvidence>(
		input.tests.map((test) => [test, { ...input.settings, signals: [] }]),
	);
	if (!input.settings.enabled || evidence.size === 0) return evidence;
	const rows = await db.all(Q.evidence, {
		project: input.project,
		tests: [...evidence.keys()],
		since: input.now - input.settings.windowDays * 86_400_000,
	});
	const targets = await targetsByIds(db, [...new Set(rows.map((row) => row.target))]);
	const byId = new Map(targets.map((target) => [target.id, target]));
	const location = await resultLocations(db, targets);
	for (const row of rows) {
		const target = byId.get(row.target);
		if (!target) throw new Error(`flaky evidence target ${row.target} was not preloaded`);
		const test = evidence.get(row.test);
		if (!test) throw new Error(`flaky evidence test ${row.test} was not requested`);
		let signal = test.signals.find((entry) => entry.signature.id === row.signature);
		if (!signal) {
			signal = {
				signature: { id: row.signature, text: row.text },
				class: row.class,
				flips: row.total,
				suggested: row.total >= input.settings.minFlips,
				samples: [],
			};
			test.signals.push(signal);
		}
		signal.samples.push({
			commit: row.commit_sha,
			location: location(target),
			env: row.env,
			job: row.job,
			actor: row.actor,
			first: {
				id: row.first_result,
				outcome: row.first_outcome,
				attempt: row.first_attempt,
				...(row.first_try === null ? {} : { try: row.first_try }),
			},
			second: {
				id: row.second_result,
				outcome: row.second_outcome,
				attempt: row.second_attempt,
				...(row.second_try === null ? {} : { try: row.second_try }),
			},
		});
	}
	return evidence;
}
