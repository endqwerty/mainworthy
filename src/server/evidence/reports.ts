import { type Db, sql } from "../kernel/db.ts";

const window = `r.project = $project
 AND cast(r.at / 86400000 AS INTEGER) >= cast($from / 86400000 AS INTEGER)
 AND cast(r.at / 86400000 AS INTEGER) <= cast(($to - 1) / 86400000 AS INTEGER)
 AND r.at >= $from AND r.at < $to
 AND ($corrections = 0 OR NOT EXISTS (SELECT 1 FROM results c WHERE c.corrects = r.id))`;
type Window = { project: number; from: number; to: number };
type Stats =
	| { kind: "reruns"; count: number; durationMs: number; missingDuration: number }
	| { kind: "flaky"; no: number; key: string; name: string; lanes: number };
// Corrections replace an execution, including its position among retries.
const position = (alias: string) => `CASE WHEN $corrections = 0 OR ${alias}.corrects IS NULL
 THEN printf('%016x%016x', ${alias}.seq, ${alias}.ord) ELSE (
 WITH RECURSIVE origin(id, corrects, seq, ord) AS (
 SELECT id, corrects, seq, ord FROM results WHERE id = ${alias}.corrects
 UNION ALL SELECT r.id, r.corrects, r.seq, r.ord FROM results r JOIN origin o ON r.id = o.corrects
 ) SELECT printf('%016x%016x', seq, ord) FROM origin WHERE corrects IS NULL
 ) END`;
// SQLite's bare duration belongs to the execution selected by min(position).
const statsQuery = (singleJob: boolean, bounded = false) =>
	sql<Window & { outside: number; corrections: number }, Stats>(
		`WITH ${
			bounded
				? `period AS MATERIALIZED (
 SELECT r.test, r.target, r.actor, r.batch, r.seq, r.ord, r.duration_ms, r.outcome,
 ${position("r")} AS first FROM results r INDEXED BY results_report_days WHERE ${window}
 AND r.method = 'auto'
 ), `
				: ""
		}stats AS MATERIALIZED (
 SELECT t.id, (
 WITH lanes AS (
 SELECT r.target, r.actor, ${singleJob ? "''" : "b.job"} AS job, r.seq, r.ord, r.duration_ms,
 min(${bounded ? "r.first" : position("r")}) AS first,
 count(*) AS total, sum(r.outcome = 'pass') AS pass, sum(r.outcome = 'fail') AS fail,
 coalesce(sum(r.duration_ms), 0) AS durationMs, sum(r.duration_ms IS NULL) AS missingDuration
 FROM ${bounded ? "period r" : "results r INDEXED BY results_report_lanes"} ${singleJob ? "" : "JOIN batches b ON b.id = r.batch"}
 WHERE r.test = t.id ${
		bounded
			? ""
			: `AND r.project = $project AND r.method = 'auto' AND r.at >= $from AND r.at < $to
 AND ($corrections = 0 OR NOT EXISTS (SELECT 1 FROM results c WHERE c.corrects = r.id))`
 }
 GROUP BY r.target, r.actor${singleJob ? "" : ", b.job"}
 ), counted AS ${bounded ? "MATERIALIZED " : ""}(
 SELECT *, CASE WHEN $outside AND EXISTS (
 SELECT 1 FROM results p INDEXED BY results_report_lanes ${singleJob ? "" : "JOIN batches b ON b.id = p.batch"}
 WHERE p.project = $project AND p.method = 'auto' AND p.test = t.id AND p.target = lanes.target
 AND p.actor = lanes.actor ${singleJob ? "" : "AND b.job = lanes.job"} AND ${position("p")} < lanes.first
 AND ($corrections = 0 OR NOT EXISTS (SELECT 1 FROM results c WHERE c.corrects = p.id))) THEN 0 ELSE 1 END AS initial FROM lanes
 ) SELECT json_array(coalesce(sum(pass > 0 AND fail > 0), 0), coalesce(sum(total - initial), 0),
 coalesce(sum(durationMs - initial * coalesce(duration_ms, 0)), 0),
 coalesce(sum(missingDuration - initial * (duration_ms IS NULL)), 0)) FROM counted
 ) AS metrics FROM tests t WHERE t.project = $project
 ), flaky AS (
 SELECT s.id, metrics ->> '$[0]' AS lanes, t.no, t.key, t.name FROM stats s JOIN tests t ON t.id = s.id
 WHERE metrics ->> '$[0]' > 0 ORDER BY lanes DESC, t.no LIMIT 50
 ) SELECT 'reruns' AS kind, NULL AS no, NULL AS key, NULL AS name, NULL AS lanes,
 coalesce(sum(metrics ->> '$[1]'), 0) AS count, coalesce(sum(metrics ->> '$[2]'), 0) AS durationMs,
 coalesce(sum(metrics ->> '$[3]'), 0) AS missingDuration FROM stats
 UNION ALL SELECT 'flaky', no, key, name, lanes, NULL, NULL, NULL FROM flaky`,
	);
const Q = {
	scope: sql<{ project: number }, { jobs: number; corrections: number }>(`SELECT
 (SELECT count(*) FROM (SELECT job FROM batches WHERE project = $project AND method = 'auto' GROUP BY job LIMIT 2)) AS jobs,
 EXISTS (SELECT 1 FROM results INDEXED BY results_corrects WHERE corrects IS NOT NULL AND project = $project) AS corrections`),
	days: sql<Window & { corrections: number }, { day: number; pass: number; total: number }>(
		`SELECT cast(r.at / 86400000 AS INTEGER) AS day, count(*) AS total,
 sum(r.outcome = 'pass') AS pass FROM results r INDEXED BY results_report_days
 WHERE ${window} GROUP BY day ORDER BY day`,
	),
	outside: sql<Window, { present: number }>(
		`SELECT EXISTS (SELECT 1 FROM results INDEXED BY results_report_days WHERE project = $project
 AND cast(at / 86400000 AS INTEGER) <= cast($from / 86400000 AS INTEGER) AND at < $from)
 OR EXISTS (SELECT 1 FROM results INDEXED BY results_report_days WHERE project = $project
 AND cast(at / 86400000 AS INTEGER) >= cast($to / 86400000 AS INTEGER) AND at >= $to) AS present`,
	),
	stats: statsQuery(false),
	oneJob: statsQuery(true),
	period: statsQuery(false, true),
	automated: sql<{ project: number }, { case_id: number }>(
		"SELECT DISTINCT case_id FROM tests WHERE project = $project AND kind = 'auto' AND case_id IS NOT NULL",
	),
};

export function evidenceReports(db: Db, input: Window) {
	const scope = db.get(Q.scope, { project: input.project });
	const outside = db.get(Q.outside, input)?.present ?? 0;
	const query = outside ? Q.period : scope?.jobs === 1 ? Q.oneJob : Q.stats;
	const stats = db.all(query, {
		...input,
		outside,
		corrections: scope?.corrections ?? 0,
	});
	const flaky: { ref: string; key: string; name: string; lanes: number }[] = [];
	let reruns = { count: 0, durationMs: 0, missingDuration: 0 };
	for (const row of stats) {
		if (row.kind === "reruns") {
			reruns = { count: row.count, durationMs: row.durationMs, missingDuration: row.missingDuration };
		} else {
			flaky.push({ ref: `T-${row.no}`, key: row.key, name: row.name, lanes: row.lanes });
		}
	}
	return {
		days: db.all(Q.days, { ...input, corrections: scope?.corrections ?? 0 }).map(({ day, pass, total }) => ({
			day: new Date(day * 86_400_000).toISOString().slice(0, 10),
			pass,
			total,
			passRate: pass / total,
		})),
		flaky,
		reruns,
	};
}
export const automatedCaseIds = (db: Db, project: number): Set<number> =>
	new Set(db.all(Q.automated, { project }).map((row) => row.case_id));
