import type { FlakyDetectionSettings, SameCodeEvidence } from "../../core/flaky.ts";
import { type Db, sql } from "../kernel/db.ts";
import { uncorrectedResults } from "./evidence.ts";

type Flip = {
	signature: number;
	text: string;
	class: "assertion" | "timeout" | "infra";
	total: number;
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
};

const Q = {
	evidence: sql<{ project: number; test: number; since: number }, Flip>(`
		SELECT * FROM (
			SELECT s.id AS signature, s.text, s.class, t.commit_sha, t.env, b.job, r.actor, f.first_result, f.second_result,
			       a.outcome AS first_outcome, r.outcome AS second_outcome,
			       a.attempt AS first_attempt, r.attempt AS second_attempt,
			       count(*) OVER (PARTITION BY s.id) AS total,
			       row_number() OVER (PARTITION BY s.id ORDER BY f.seq DESC, f.id DESC) AS sample
			FROM flips f
			JOIN results a ON a.id = f.first_result
			JOIN results r ON r.id = f.second_result
			JOIN targets t ON t.id = f.target
			JOIN batches b ON b.id = r.batch
			JOIN batches earlier ON earlier.id = a.batch
			JOIN signatures s ON s.id = CASE WHEN a.outcome = 'pass' THEN r.signature ELSE a.signature END
			WHERE f.project = $project AND f.test = $test AND t.commit_sha IS NOT NULL
			  AND a.target = r.target AND a.test = r.test AND a.actor = r.actor AND earlier.job = b.job
			  AND a.method = 'auto' AND r.method = 'auto' AND a.attempt < r.attempt
			  AND a.at >= $since AND r.at >= $since
			  AND ((a.outcome = 'pass' AND r.outcome IN ('fail', 'error'))
			    OR (r.outcome = 'pass' AND a.outcome IN ('fail', 'error')))
			  AND ${uncorrectedResults("a.id", "r.id")}
			  AND NOT EXISTS (
			    SELECT 1 FROM results worse JOIN batches wb ON wb.id = worse.batch
			    WHERE worse.target = r.target AND worse.test = r.test AND worse.actor = r.actor
			      AND worse.method = 'auto' AND wb.job = b.job AND worse.outcome IN ('fail', 'error')
			      AND worse.attempt = CASE WHEN a.outcome = 'pass' THEN a.attempt ELSE r.attempt END
			      AND ${uncorrectedResults("worse.id")}
			  )
		) WHERE sample <= 3 ORDER BY CASE class WHEN 'assertion' THEN 0 WHEN 'timeout' THEN 1 ELSE 2 END, signature, sample
	`),
};

/** Suggestions from the incrementally recorded flips. This reads facts and never changes an excuse or a gate. */
export function sameCodeEvidence(
	db: Db,
	input: { project: number; test: number; now: number; settings: FlakyDetectionSettings },
): SameCodeEvidence {
	const evidence: SameCodeEvidence = { ...input.settings, signals: [] };
	if (!input.settings.enabled) return evidence;
	const rows = db.all(Q.evidence, {
		project: input.project,
		test: input.test,
		since: input.now - input.settings.windowDays * 86_400_000,
	});
	for (const row of rows) {
		let signal = evidence.signals.find((entry) => entry.signature.id === row.signature);
		if (!signal) {
			signal = {
				signature: { id: row.signature, text: row.text },
				class: row.class,
				flips: row.total,
				suggested: row.total >= input.settings.minFlips,
				samples: [],
			};
			evidence.signals.push(signal);
		}
		signal.samples.push({
			commit: row.commit_sha,
			env: row.env,
			job: row.job,
			actor: row.actor,
			first: { id: row.first_result, outcome: row.first_outcome, attempt: row.first_attempt },
			second: { id: row.second_result, outcome: row.second_outcome, attempt: row.second_attempt },
		});
	}
	return evidence;
}
