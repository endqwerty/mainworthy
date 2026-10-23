// Evidence: what was observed. Owns tests, targets, changes, batches, signatures, results, flips and excuses.
//
// A report is taken in two steps. `accept` stores the normalised results durably under the batch key, so the same
// report twice is a no-op and a crash loses nothing. `apply` turns the staged results into result rows, each with an
// explicit basis. Between the two, every run the report matters to reads `pending` (see runs.ts).
import { createHash } from "node:crypto";
import { caseNameAnnotation } from "../../core/case-annotation.ts";
import type { ActorKind } from "../../core/kinds.ts";
import type { MethodKind } from "../../core/model.ts";
import type { ChangeInput, Outcome, ReportInput, ResultIn, ResultLocation, TargetIn } from "../../core/ops.ts";
import { failedStep, type ResultStep } from "../../core/results.ts";
import type { ShardWait } from "../../core/runs.ts";
import { attachmentType } from "../kernel/blobs.ts";
import type { Ctx } from "../kernel/ctx.ts";
import { json, type ReadDb, type SqlValue, sql, type WriteDb } from "../kernel/db.ts";
import { conflict, invalid } from "../kernel/errors.ts";
import { decisionOf, type Witness } from "../kernel/witness.ts";
import { type CaseRow, caseById, caseRef, findCase, versionOf } from "../suite/suite.ts";
import { assertionScope, ensureAssertionIndex, finishAssertionScope, observeAssertion } from "./assertions.ts";
import { recordAttachments } from "./attachments.ts";
import { buildWhat } from "./releases.ts";
import { ensureSignature, fileSignature, type SignatureRow, signatureByHash, signatureById } from "./signatures.ts";

export { type SignatureRow, signatureById } from "./signatures.ts";

/** SQL predicate for result id expressions: a correction withdraws what it names, whatever its own outcome. */
export const uncorrectedResults = (id: string, ...others: string[]): string =>
	`NOT EXISTS (SELECT 1 FROM results correction WHERE correction.corrects ${others.length === 0 ? `= ${id}` : `IN (${[id, ...others].join(", ")})`})`;

export type TestRow = {
	id: number;
	project: number;
	no: number;
	kind: "manual" | "auto";
	key: string;
	name: string;
	file: string | null;
	case_id: number | null;
	/** The `map` decision that made the link. Null for an unlinked test and for the manual test of a case. */
	linked_by: number | null;
	first_seq: number;
	last_seq: number;
};
export type TargetRow = {
	id: number;
	project: number;
	what: string;
	env: string;
	repo: string | null;
	commit_sha: string | null;
	branch: string | null;
	line: "trunk" | "change" | "release" | "session";
	change: number | null;
	first_seq: number;
};
export type ChangeRow = {
	id: number;
	project: number;
	key: string;
	repo: string | null;
	base_sha: string | null;
	head_sha: string | null;
	head_observed_seq: number | null;
	branch: string | null;
	title: string | null;
	url: string | null;
	files: string;
	rev: number;
	/** How the change ended, or null while it is open: read from `change_ends`. An ended change is not asked about. */
	ended: "merged" | "closed" | null;
	ended_at: number | null;
	receipt: number | null;
	/** The commit a merged change landed as on trunk, and that branch (decision 0123): its own commit, with its own gate. */
	landing_commit: string | null;
	landing_branch: string | null;
};
export type BatchRow = {
	id: number;
	project: number;
	key: string;
	target: number;
	job: string;
	nothing_required: number;
	attempt: number;
	/** Which shard of its job this report is, of how many; null for a report of a whole job. */
	shard: number | null;
	shards: number | null;
	method: MethodKind;
	actor: number;
	model: string | null;
	run: number | null;
	build_url: string | null;
	state: "accepted" | "processed";
	counts: string;
	staged: string | null;
	receipt: string | null;
	at: number;
	seq: number;
};
export type ResultRow = {
	id: number;
	project: number;
	test: number;
	seq: number;
	ord: number;
	batch: number;
	target: number;
	method: MethodKind;
	actor: number;
	model: string | null;
	basis: "exact" | "assumed" | "unresolved";
	basis_case: number | null;
	basis_version: number | null;
	basis_claim: string | null;
	outcome: Outcome;
	attempt: number;
	duration_ms: number | null;
	signature: number | null;
	message: string | null;
	detail: string | null;
	at_step: string | null;
	trail: string | null;
	note: string | null;
	run: number | null;
	corrects: number | null;
	at: number;
	quarantine_decision: number | null;
	quarantine_exit: number | null;
};

export const resultTrail = (row: ResultRow): ResultStep[] | null =>
	row.trail === null ? null : json<ResultStep[]>(row.trail);
export function resultFailedStep(row: ResultRow): string | null {
	const steps = resultTrail(row);
	return steps === null ? row.at_step : failedStep(steps);
}

/** What `Q.updateChange` writes. */
type ChangeWrite = {
	id: number;
	base: string | null;
	head: string | null;
	observed: number | null;
	title: string | null;
	url: string | null;
	files: string;
	rev: number;
};

const TRUNK_BRANCHES = new Set(["main", "master", "trunk"]);

const Q = {
	resultExcuse: sql<
		{ result: number },
		{ decision: number; class: "attributed" | "excused"; expires_at: number | null }
	>("SELECT decision, class, expires_at FROM result_excuses WHERE result = $result AND slot IS NULL"),
	slotExcuse: sql<
		{ result: number; slot: number },
		{ decision: number; class: "attributed" | "excused"; expires_at: number | null }
	>("SELECT decision, class, expires_at FROM result_excuses WHERE result = $result AND slot = $slot"),
	slotCauseExcuses: sql<
		{ slot: number; signature: number },
		{ decision: number; class: "attributed" | "excused"; expires_at: number | null; target: number }
	>(
		`SELECT e.decision, e.class, e.expires_at, r.target FROM result_excuses e
		 JOIN results r ON r.id = e.result WHERE e.slot = $slot AND r.signature = $signature
		 ORDER BY e.decision DESC`,
	),
	setResultExcuse: sql<{
		result: number;
		slot: number | null;
		decision: number;
		class: string;
		expires: number | null;
	}>(
		`INSERT INTO result_excuses (result, slot, decision, class, expires_at) VALUES ($result, $slot, $decision, $class, $expires)
   ON CONFLICT DO UPDATE SET decision = excluded.decision, class = excluded.class, expires_at = excluded.expires_at`,
	),
	dropResultExcuses: sql<{ decision: number }>("DELETE FROM result_excuses WHERE decision = $decision"),
	changesBasedOn: sql<{ project: number; base: string; repo: string | null }, { id: number }>(
		"SELECT id FROM changes WHERE project = $project AND base_sha = $base AND repo IS $repo",
	),
	target: sql<{ project: number; what: string; env: string }, TargetRow>(
		"SELECT * FROM targets WHERE project = $project AND what = $what AND env = $env",
	),
	targetById: sql<{ id: number }, TargetRow>("SELECT * FROM targets WHERE id = $id"),
	targetsOfCommit: sql<{ project: number; what: string }, TargetRow>(
		"SELECT * FROM targets WHERE project = $project AND what = $what",
	),
	placeCommit: sql<{ project: number; what: string; line: string; branch: string | null; change: number | null }>(
		"UPDATE targets SET line = $line, branch = $branch, change = $change WHERE project = $project AND what = $what",
	),
	scopeMove: sql<{
		project: number;
		what: string;
		before: string;
		after: string;
		actor: number;
		at: number;
		seq: number;
	}>(
		`INSERT INTO scope_moves (project, what, before_scope, after_scope, actor, at, seq)
		 VALUES ($project, $what, $before, $after, $actor, $at, $seq)`,
	),
	insertTarget: sql<{
		project: number;
		what: string;
		env: string;
		repo: string | null;
		commit: string | null;
		branch: string | null;
		line: string;
		change: number | null;
		seq: number;
	}>(
		`INSERT INTO targets (project, what, env, repo, commit_sha, branch, line, change, first_seq)
		 VALUES ($project, $what, $env, $repo, $commit, $branch, $line, $change, $seq)`,
	),
	// A change is read with how it ended, which is a row of `change_ends` or none.
	change: sql<{ project: number; key: string }, ChangeRow>(
		`SELECT c.*, e.ended, e.at AS ended_at, e.receipt, e.landing_commit, e.landing_branch FROM changes c LEFT JOIN change_ends e ON e.change = c.id
		 WHERE c.project = $project AND c.key = $key`,
	),
	locationChanges: sql<{ targets: string }, { target: number; key: string | null; title: string | null }>(
		`SELECT t.id AS target, c.key, c.title FROM json_each($targets) requested
		 JOIN targets t ON t.id = requested.value
		 LEFT JOIN change_ends e ON t.change IS NULL AND t.line = 'trunk' AND e.ended = 'merged'
		   AND e.landing_commit = t.commit_sha AND e.landing_repo IS t.repo AND e.landing_branch = t.branch
		 JOIN changes c ON c.id = coalesce(t.change, e.change) AND c.project = t.project`,
	),
	changeById: sql<{ id: number }, ChangeRow>(
		"SELECT c.*, e.ended, e.at AS ended_at, e.receipt, e.landing_commit, e.landing_branch FROM changes c LEFT JOIN change_ends e ON e.change = c.id WHERE c.id = $id",
	),
	changes: sql<{ project: number; limit: number }, ChangeRow>(
		`SELECT c.*, e.ended, e.at AS ended_at, e.receipt, e.landing_commit, e.landing_branch FROM changes c LEFT JOIN change_ends e ON e.change = c.id
		 WHERE c.project = $project ORDER BY c.rev DESC LIMIT $limit`,
	),
	insertChange: sql<{
		project: number;
		key: string;
		repo: string | null;
		base: string | null;
		head: string | null;
		observed: number | null;
		branch: string | null;
		title: string | null;
		url: string | null;
		files: string;
		rev: number;
	}>(
		`INSERT INTO changes (project, key, repo, base_sha, head_sha, head_observed_seq, branch, title, url, files, rev)
		 VALUES ($project, $key, $repo, $base, $head, $observed, $branch, $title, $url, $files, $rev)`,
	),
	updateChange: sql<ChangeWrite>(
		"UPDATE changes SET base_sha = $base, head_sha = $head, head_observed_seq = $observed, title = $title, url = $url, files = $files, rev = $rev WHERE id = $id",
	),
	endChange: sql<{ id: number; ended: string; at: number }>(
		`INSERT INTO change_ends (change, ended, at) VALUES ($id, $ended, $at)
		 ON CONFLICT (change) DO UPDATE SET ended = excluded.ended, at = excluded.at,
		 landing_commit = NULL, landing_repo = NULL, landing_branch = NULL, receipt = NULL`,
	),
	landChange: sql<{ id: number; commit: string; repo: string | null; branch: string }>(
		`UPDATE change_ends SET landing_commit = $commit, landing_repo = $repo, landing_branch = $branch
		 WHERE change = $id AND ended = 'merged'
		 AND (landing_commit IS NOT $commit OR landing_repo IS NOT $repo OR landing_branch IS NOT $branch)`,
	),
	setMergeReceipt: sql<{ id: number; receipt: number }>(
		"UPDATE change_ends SET receipt = $receipt WHERE change = $id AND ended = 'merged'",
	),
	reopenChange: sql<{ id: number }>("DELETE FROM change_ends WHERE change = $id"),
	touchChange: sql<{ id: number; rev: number }>("UPDATE changes SET rev = $rev WHERE id = $id"),
	batchByKey: sql<{ project: number; key: string }, BatchRow>(
		"SELECT * FROM batches WHERE project = $project AND key = $key",
	),
	batchById: sql<{ id: number }, BatchRow>("SELECT * FROM batches WHERE id = $id"),
	insertBatch: sql<{
		project: number;
		key: string;
		target: number;
		job: string;
		nothingRequired: number;
		attempt: number;
		shard: number | null;
		shards: number | null;
		method: string;
		actor: number;
		model: string | null;
		run: number | null;
		url: string | null;
		counts: string;
		staged: string;
		at: number;
		seq: number;
	}>(
		`INSERT INTO batches (project, key, target, job, nothing_required, attempt, shard, shards, method, actor, model, run, build_url, state, counts, staged, at, seq)
		 VALUES ($project, $key, $target, $job, $nothingRequired, $attempt, $shard, $shards, $method, $actor, $model, $run, $url, 'accepted', $counts, $staged, $at, $seq)`,
	),
	// The shards a job of a target has reported, by the number of shards they said the job has. An agent's report
	// under the job's name is not the job.
	receiptShards: sql<
		{ project: number; what: string; target: number; job: string; shards: number },
		{ target: number; job: string; env: string; shards: number; reported: string }
	>(
		`SELECT t.id AS target,b.job,t.env,b.shards,group_concat(DISTINCT b.shard) AS reported
 FROM targets t JOIN batches b ON b.target=t.id
 WHERE t.project=$project AND t.what=$what AND b.shards IS NOT NULL AND b.method!='agent'
 AND (t.id,b.job,b.shards)>($target,$job,$shards)
 GROUP BY t.id,b.job,b.shards ORDER BY t.id,b.job,b.shards LIMIT 50`,
	),
	shardsOf: sql<{ target: number }, { job: string; shards: number; reported: string }>(
		`SELECT job, shards, group_concat(DISTINCT shard) AS reported FROM batches
		 WHERE target = $target AND shards IS NOT NULL AND method != 'agent' GROUP BY job, shards ORDER BY job`,
	),
	emptyReports: sql<{ target: number }, { declared: number; ordinary: number }>(
		`SELECT coalesce(max(nothing_required = 1 AND method = 'auto'), 0) AS declared,
		 coalesce(max(nothing_required = 0), 0) AS ordinary FROM batches WHERE target = $target AND state = 'processed'`,
	),
	markProcessed: sql<{ id: number; counts: string }>(
		"UPDATE batches SET state = 'processed', counts = $counts, staged = NULL WHERE id = $id",
	),
	setReceipt: sql<{ id: number; receipt: string }>("UPDATE batches SET receipt = $receipt WHERE id = $id"),
	receipts: sql<readonly [], { id: number; receipt: string }>(
		"SELECT id, receipt FROM batches WHERE receipt IS NOT NULL",
	),
	accepted: sql<readonly [], BatchRow>("SELECT * FROM batches WHERE state = 'accepted' ORDER BY id"),
	processedJobs: sql<{ target: number }, { job: string }>(
		`SELECT DISTINCT job FROM batches WHERE target = $target AND state = 'processed'
		 AND EXISTS (SELECT 1 FROM results r WHERE r.batch = batches.id AND r.method = 'auto'
		             AND r.outcome IN ('pass', 'fail', 'error') AND ${uncorrectedResults("r.id")})`,
	),
	correctionOf: sql<{ result: number }, { id: number }>("SELECT id FROM results WHERE corrects = $result LIMIT 1"),
	pendingCorrections: sql<{ project: number; actor: number }, { result: number }>(
		`SELECT json_extract(staged.value, '$.corrects') AS result FROM batches, json_each(batches.staged) staged
		 WHERE batches.project = $project AND batches.actor = $actor AND batches.state = 'accepted'
		 AND json_extract(staged.value, '$.corrects') IS NOT NULL`,
	),
	testByKey: sql<{ project: number; key: string }, TestRow>(
		"SELECT * FROM tests WHERE project = $project AND key = $key",
	),
	testById: sql<{ id: number }, TestRow>("SELECT * FROM tests WHERE id = $id"),
	testByNo: sql<{ project: number; no: number }, TestRow>("SELECT * FROM tests WHERE project = $project AND no = $no"),
	testsOfCase: sql<{ project: number; id: number }, TestRow>(
		"SELECT * FROM tests WHERE project = $project AND case_id = $id ORDER BY id",
	),
	insertTest: sql<{
		project: number;
		no: number;
		kind: string;
		key: string;
		name: string;
		file: string | null;
		caseId: number | null;
		seq: number;
	}>(
		`INSERT INTO tests (project, no, kind, key, name, file, case_id, first_seq, last_seq)
		 VALUES ($project, $no, $kind, $key, $name, $file, $caseId, $seq, $seq)`,
	),
	touchTest: sql<{ id: number; seq: number }>("UPDATE tests SET last_seq = $seq WHERE id = $id"),
	linkTest: sql<{ id: number; caseId: number | null; by: number | null }>(
		"UPDATE tests SET case_id = $caseId, linked_by = $by WHERE id = $id",
	),
	unlinkedInFile: sql<{ project: number; file: string }, TestRow>(
		"SELECT * FROM tests WHERE project = $project AND file = $file AND case_id IS NULL AND kind = 'auto' ORDER BY id LIMIT 500",
	),
	unlinkedWithoutFile: sql<{ project: number; file: string }, TestRow>(
		"SELECT * FROM tests WHERE project = $project AND (file IS NULL OR file = $file) AND case_id IS NULL AND kind = 'auto' ORDER BY id LIMIT 500",
	),
	unlinkedCount: sql<{ project: number }, { n: number }>(
		"SELECT count(*) AS n FROM tests WHERE project = $project AND case_id IS NULL AND kind = 'auto'",
	),
	splitResult: sql<{ id: number; signature: number }>("UPDATE results SET signature = $signature WHERE id = $id"),
	splitTry: sql<{ id: number; signature: number }>("UPDATE result_tries SET signature = $signature WHERE id = $id"),
	assertionTries: sql<{ result: number }, { id: number; signature: number }>(
		"SELECT tr.id, tr.signature FROM result_tries tr JOIN signatures s ON s.id = tr.signature WHERE tr.result = $result AND s.class = 'assertion' ORDER BY tr.try LIMIT 100",
	),
	insertResult: sql<{
		project: number;
		test: number;
		seq: number;
		ord: number;
		batch: number;
		target: number;
		method: string;
		actor: number;
		model: string | null;
		basis: string;
		basisCase: number | null;
		basisVersion: number | null;
		basisClaim: string | null;
		outcome: string;
		attempt: number;
		duration: number | null;
		signature: number | null;
		message: string | null;
		detail: string | null;
		atStep: string | null;
		trail: string | null;
		note: string | null;
		run: number | null;
		corrects: number | null;
		at: number;
	}>(
		`INSERT INTO results (project, test, seq, ord, batch, target, method, actor, model, basis, basis_case, basis_version, basis_claim,
		                      outcome, attempt, duration_ms, signature, message, detail, at_step, trail, note, run, corrects, at)
		 VALUES ($project, $test, $seq, $ord, $batch, $target, $method, $actor, $model, $basis, $basisCase, $basisVersion, $basisClaim,
		         $outcome, $attempt, $duration, $signature, $message, $detail, $atStep, $trail, $note, $run, $corrects, $at)`,
	),
	laneHistory: sql<{ target: number; test: number; actor: number; job: string }, ResultRow>(
		`SELECT r.* FROM results r JOIN batches b ON b.id = r.batch
		 WHERE r.target = $target AND r.test = $test AND r.actor = $actor AND b.job = $job
		   AND ${uncorrectedResults("r.id")}
		 ORDER BY r.seq, r.ord`,
	),
	producedOn: sql<{ project: number; signature: number; actor: number }, { target: number; run: number | null }>(
		"SELECT DISTINCT target, run FROM results WHERE project = $project AND signature = $signature AND actor = $actor",
	),
	resultById: sql<{ id: number }, ResultRow>("SELECT * FROM results WHERE id = $id"),
	testTime: sql<{ results: string }, { ms: number; timed: number }>(
		`SELECT CAST(max(0, min(total(r.duration_ms), ${Number.MAX_SAFE_INTEGER})) AS INTEGER) AS ms,
		        count(r.duration_ms) AS timed
		 FROM json_each($results) requested JOIN results r ON r.id = requested.value`,
	),
	previousOnTarget: sql<
		{ target: number; test: number; actor: number; job: string; method: string },
		{ id: number; outcome: Outcome; attempt: number }
	>(
		`SELECT r.id, r.outcome, r.attempt FROM results r JOIN batches b ON b.id = r.batch
		 WHERE r.target = $target AND r.test = $test AND r.actor = $actor AND b.job = $job
		   AND r.method = $method AND r.outcome IN ('pass', 'fail', 'error')
		   AND ${uncorrectedResults("r.id")}
		 ORDER BY r.attempt DESC, CASE WHEN r.outcome = 'pass' THEN 0 ELSE 1 END DESC, r.id DESC LIMIT 1`,
	),
	insertFlip: sql<{
		project: number;
		test: number;
		target: number;
		first: number;
		second: number;
		firstTry: number | null;
		secondTry: number | null;
		seq: number;
	}>(
		`INSERT INTO flips (project, test, target, first_result, second_result, first_try, second_try, seq)
		 VALUES ($project, $test, $target, $first, $second, $firstTry, $secondTry, $seq)`,
	),
	insertTry: sql<{
		project: number;
		result: number;
		try: number;
		outcome: Outcome;
		duration: number | null;
		signature: number | null;
		message: string | null;
		detail: string | null;
	}>(
		`INSERT INTO result_tries (project, result, try, outcome, duration_ms, signature, message, detail)
		 VALUES ($project, $result, $try, $outcome, $duration, $signature, $message, $detail)`,
	),
	triesOf: sql<
		{ results: string },
		{ result: number; outcome: Outcome; duration_ms: number | null; message: string | null }
	>(
		`SELECT t.result, t.outcome, t.duration_ms, t.message
		 FROM json_each($results) asked CROSS JOIN result_tries t ON t.result = asked.value ORDER BY t.result, t.try`,
	),
	// A flip one of whose results its producer corrected is not counted: the pass and the failure were not both what
	// happened (issue #630).
	flipCount: sql<{ project: number; test: number }, { n: number }>(
		`SELECT count(*) AS n FROM flips f WHERE f.project = $project AND f.test = $test
		   AND ${uncorrectedResults("f.first_result", "f.second_result")}`,
	),
	// Of these results, those in a lane with a flip on their target that no correction withdrew. The flips are read
	// test by test (`flips_test`), however many the project has.
	flippedLanes: sql<{ results: string }, { result: number }>(`
		SELECT DISTINCT c.id AS result
		FROM json_each($results) asked
		CROSS JOIN results c ON c.id = asked.value
		JOIN batches cb ON cb.id = c.batch
		JOIN flips f ON f.project = c.project AND f.test = c.test
		JOIN results s ON s.id = f.second_result
		JOIN batches sb ON sb.id = s.batch
		WHERE f.target = c.target AND s.actor = c.actor AND s.method = c.method AND sb.job = cb.job
		  AND ${uncorrectedResults("f.first_result", "f.second_result")}
	`),
	// Of these results, each failure a later attempt of its lane passed: the first attempt that passed. A flip is
	// recorded between the last failure and the pass, so a failure before it is matched by its lane and attempt, not
	// by being the flip's first result. Its failing end may be a runner's try (decision 0129): a later attempt that
	// failed and then passed inside the runner recovered this failure too. Its passing end may be a try, but the
	// attempt it belongs to must have ended passing: one that passed on a try and ended failing recovered nothing.
	// Nothing of it corrected.
	passedOnRetry: sql<{ results: string }, { result: number; attempt: number }>(`
		SELECT a.id AS result, min(s.attempt) AS attempt
		FROM json_each($results) asked
		CROSS JOIN results a ON a.id = asked.value
		JOIN batches ab ON ab.id = a.batch
		JOIN flips f ON f.project = a.project AND f.test = a.test
		JOIN results p ON p.id = f.first_result
		JOIN results s ON s.id = f.second_result
		LEFT JOIN result_tries pt ON pt.id = f.first_try
		JOIN batches sb ON sb.id = s.batch
		WHERE f.target = a.target AND s.actor = a.actor AND s.method = a.method AND sb.job = ab.job
		  AND a.outcome IN ('fail', 'error') AND coalesce(pt.outcome, p.outcome) IN ('fail', 'error')
		  AND s.outcome = 'pass'
		  AND p.attempt >= a.attempt AND s.attempt > a.attempt
		  AND ${uncorrectedResults("a.id", "f.first_result", "f.second_result")}
		GROUP BY a.id
	`),
	lastOfTest: sql<{ project: number; test: number; limit: number }, ResultRow>(
		"SELECT * FROM results WHERE project = $project AND test = $test ORDER BY seq DESC, ord DESC LIMIT $limit",
	),
	lastOfCaseByMethod: sql<{ id: number; method: string; limit: number }, ResultRow>(
		`SELECT * FROM results WHERE basis_case = $id AND method = $method
		 ORDER BY seq DESC, ord DESC LIMIT $limit`,
	),
	latestOfCaseByMethod: sql<{ id: number; method: string }, ResultRow>(
		`SELECT * FROM results WHERE basis_case = $id AND method = $method
		 ORDER BY seq DESC, ord DESC LIMIT 1`,
	),
	ofBatch: sql<{ batch: number; limit: number }, ResultRow>(
		"SELECT * FROM results WHERE batch = $batch ORDER BY ord LIMIT $limit",
	),
	excuse: sql<
		{ project: number; signature: number; scope: string; target: number },
		{ decision: number; class: "attributed" | "excused"; expires_at: number | null }
	>(
		`SELECT decision, class, expires_at FROM excuses
		 WHERE project = $project AND signature = $signature AND scope = $scope AND target = $target`,
	),
	setExcuse: sql<{
		project: number;
		signature: number;
		scope: string;
		decision: number;
		class: string;
		expires: number | null;
		target: number;
	}>(
		`INSERT INTO excuses (project, signature, scope, target, decision, class, expires_at)
		 VALUES ($project, $signature, $scope, $target, $decision, $class, $expires)
		 ON CONFLICT (project, signature, scope, target)
		 DO UPDATE SET decision = excluded.decision, class = excluded.class, expires_at = excluded.expires_at`,
	),
	firstCounted: sql<{ project: number; what: string }, { seq: number | null }>(
		`SELECT min(b.seq) AS seq FROM batches b JOIN targets t ON t.id = b.target
		 WHERE t.project = $project AND t.what = $what AND b.method != 'agent'`,
	),
	humanReported: sql<{ project: number; what: string }, { reported: number }>(
		`SELECT 1 AS reported FROM batches b JOIN targets t ON t.id = b.target
		 WHERE t.project = $project AND t.what = $what AND
		 (b.method = 'human' OR EXISTS (SELECT 1 FROM results r WHERE r.batch = b.id AND r.method = 'human')) LIMIT 1`,
	),
	// Every target of a commit, with no cap: which results a run counts and which repository a commit belongs
	// to are decided from this list, and a list cut short would decide them wrongly without saying so.
	targetsByCommit: sql<{ project: number; commit: string }, TargetRow>(
		"SELECT * FROM targets WHERE project = $project AND commit_sha = $commit ORDER BY id",
	),
	targetsByCommitPrefix: sql<{ project: number; low: string; high: string }, TargetRow>(
		"SELECT * FROM targets WHERE project = $project AND commit_sha >= $low AND commit_sha < $high ORDER BY id",
	),
	caseSelectionOfFiles: sql<{ project: number; files: string }, { ids: string; files: string }>(
		`SELECT json_group_array(DISTINCT t.case_id) AS ids, json_group_array(DISTINCT t.file) AS files
		 FROM json_each($files) asked
		 CROSS JOIN tests t ON t.project = $project AND t.file = asked.value
		 WHERE t.case_id IS NOT NULL`,
	),
	caseLinksOfFiles: sql<{ project: number; files: string; cases: string }, { case_id: number; file: string }>(
		`SELECT DISTINCT t.case_id, t.file FROM json_each($cases) asked
		 CROSS JOIN tests t ON t.case_id = asked.value AND t.project = $project
		 WHERE t.file IN (SELECT value FROM json_each($files))`,
	),
	caseIdsOfTests: sql<{ project: number; tests: string }, { case_id: number }>(
		`SELECT DISTINCT t.case_id FROM json_each($tests) asked CROSS JOIN tests t ON t.id = asked.value
		 WHERE t.project = $project AND t.case_id IS NOT NULL`,
	),
	lastOfCases: sql<{ cases: string }, { case_id: number; outcome: string; basis_version: number | null }>(
		`WITH candidates AS MATERIALIZED (
			SELECT (SELECT id FROM results WHERE basis_case = asked.value AND method = kind.value
				ORDER BY seq DESC, ord DESC LIMIT 1) AS id
			FROM json_each($cases) asked CROSS JOIN json_each('["human","auto","agent"]') kind
		), ranked AS (
			SELECT r.basis_case AS case_id, r.outcome, r.basis_version,
				row_number() OVER (PARTITION BY r.basis_case ORDER BY r.seq DESC, r.ord DESC) AS position
			FROM candidates c JOIN results r ON r.id = c.id
		)
		SELECT case_id, outcome, basis_version FROM ranked WHERE position = 1`,
	),
	failedWith: sql<{ project: number; signature: number }, { test: number; target: number }>(
		`SELECT DISTINCT test, target FROM results
		 WHERE project = $project AND signature = $signature
		   AND outcome IN ('fail', 'error') AND method != 'agent'`,
	),
	dropExcuse: sql<{ project: number; signature: number; scope: string; decision: number }>(
		"DELETE FROM excuses WHERE project = $project AND signature = $signature AND scope = $scope AND decision = $decision",
	),
};

// ── Targets and changes ────────────────────────────────────────────────────────────────────────────────────

export const codeWhat = (repo: string | undefined | null, commit: string): string => `code:${repo ?? ""}@${commit}`;

/**
 * Finds or records what was tested. A commit on `main`, `master` or `trunk` with no pull request is the trunk
 * line; anything else with a commit is a change, keyed by its pull request, else its branch, else the commit, so
 * a decision made on one push of a pull request still stands on the next.
 *
 * A change belongs to one repository. The first repository to report `pr:12` in a project has that key; the same
 * number from another repository is another change, keyed `<repo>#pr:12`, with its own decisions and gate.
 */
export async function ensureTarget(ctx: Ctx, input: TargetIn, updateExistingChange = true): Promise<TargetRow> {
	const project = ctx.project.id;
	if ("build" in input) {
		const what = await buildWhat(ctx.db, project, input.build, input.env);
		const env = input.env ?? "";
		const found = await ctx.db.get(Q.target, { project, what, env });
		if (found) return found;
		const { lastId } = await ctx.db.run(Q.insertTarget, {
			project,
			what,
			env,
			repo: null,
			commit: null,
			branch: null,
			line: "release",
			change: null,
			seq: ctx.seq,
		});
		return await mustTarget(ctx.db, lastId);
	}
	if ("session" in input) {
		const what = `session:${input.session}`;
		const found = await ctx.db.get(Q.target, { project, what, env: "" });
		if (found) return found;
		const { lastId } = await ctx.db.run(Q.insertTarget, {
			project,
			what,
			env: "",
			repo: null,
			commit: null,
			branch: null,
			line: "session",
			change: null,
			seq: ctx.seq,
		});
		return await mustTarget(ctx.db, lastId);
	}
	const what = codeWhat(input.repo, input.commit);
	const env = input.env ?? "";
	const found = await ctx.db.get(Q.target, { project, what, env });
	const first = (await ctx.db.all(Q.targetsOfCommit, { project, what }))[0];
	// A pipeline or person names a commit's scope. An agent's report settles nothing, and a hash-only report
	// leaves the place provisional until a pipeline or person names a branch or pull request, unless somebody
	// has a human batch or result there, even if uncounted: their question and answer keep that scope.
	const advisory = ctx.actor.kind === "agent";
	const placed = first !== undefined && firstSeen(ctx.db, project, input.repo ?? null, input.commit) !== null;
	const own = first?.change !== null && first?.change !== undefined ? await changeById(ctx.db, first.change) : null;
	const named = input.pr !== undefined || input.branch !== undefined;
	const gainsPlace =
		!advisory &&
		named &&
		own !== null &&
		own.key === changeKey(ctx.db, project, ownKey(input.commit), input.repo ?? null) &&
		!ctx.db.get(Q.humanReported, { project, what });
	const settled = first !== undefined && (placed || advisory || first.line === "trunk") && !gainsPlace;
	const trunk = !advisory && input.pr === undefined && input.branch !== undefined && TRUNK_BRANCHES.has(input.branch);
	if (input.head !== undefined && (trunk || (input.pr === undefined && !input.branch)))
		throw invalid("head needs a pull request or a non-trunk branch");
	let change: ChangeRow | null = null;
	if (advisory) {
		// An agent's word about a branch or a pull request is not taken, and no change is made because an agent
		// named one (the name stays free for whoever really reports it). A commit only an agent has reported is on
		// its own, like a commit reported by its hash alone; one that is placed already is where it is.
		if (first === undefined) {
			const key = await changeKey(ctx.db, project, ownKey(input.commit), input.repo ?? null);
			change = await upsertChange(ctx, key, input, updateExistingChange);
		}
	} else if (!trunk) {
		const key =
			input.pr !== undefined ? `pr:${input.pr}` : input.branch ? `branch:${input.branch}` : ownKey(input.commit);
		// A report that names neither a branch nor a pull request says nothing about where the commit is: for a
		// commit whose place is known, no change of its own is made up for it.
		const known = input.pr === undefined && input.branch === undefined && settled;
		if (!known)
			change = await upsertChange(
				ctx,
				await changeKey(ctx.db, project, key, input.repo ?? null),
				input,
				updateExistingChange,
			);
	}
	// One commit, one scope across every environment. Automated hash-only reports leave the place open until
	// a branch or pull request is named. Typed results keep their scope; a named scope moves on landing.
	const place: Pick<TargetRow, "line" | "branch" | "change"> = settled
		? { line: first.line, branch: first.branch, change: first.change }
		: advisory
			? { line: "change", branch: null, change: change?.id ?? null }
			: { line: trunk ? "trunk" : "change", branch: input.branch ?? null, change: change?.id ?? null };
	// A scope is shared by every environment, including environments reported before its place was named.
	if (first !== undefined && !settled) await moveCommit(ctx, first, place);
	if (found) return settled ? found : await mustTarget(ctx.db, found.id);
	const { lastId } = await ctx.db.run(Q.insertTarget, {
		project,
		what,
		env,
		repo: input.repo ?? null,
		commit: input.commit,
		branch: place.branch,
		line: place.line,
		change: place.change,
		seq: ctx.seq,
	});
	return await mustTarget(ctx.db, lastId);
}

/**
 * The provisional change given to a commit reported only by hash (`commit:<hash>`), or null. Its questions
 * belong there until a pipeline or person names a scope for it.
 */
export async function ownChangeOf(
	db: ReadDb,
	project: number,
	repo: string | null,
	commit: string,
): Promise<ChangeRow | null> {
	return await db.get(Q.change, { project, key: await changeKey(db, project, ownKey(commit), repo) });
}

/**
 * The key of the change a commit is given for itself. The whole hash: two commits that begin alike are two
 * commits, each on its own, and a key cut short would put them in one place.
 */
const ownKey = (commit: string): string => `commit:${commit}`;

/** The key of a change in a repository: the plain key, unless another repository holds it in this project. */
async function changeKey(db: ReadDb, project: number, key: string, repo: string | null): Promise<string> {
	const holder = await db.get(Q.change, { project, key });
	return !holder || holder.repo === repo ? key : `${repo ?? "(no repository)"}#${key}`;
}

/**
 * When a pipeline or a person first reported a commit in this project, or null when none has. An agent's report
 * of a commit does not count: the order of a change's commits is the order in which the gates heard of them.
 */
const firstSeen = async (db: ReadDb, project: number, repo: string | null, commit: string): Promise<number | null> =>
	db.get(Q.firstCounted, { project, what: codeWhat(repo, commit) })?.seq ?? null;

/**
 * Whether this batch is the first report of its commit that a gate counts. That report is the one that says
 * where the commit is, so the caller recomputes every run that counts the commit: a run that already held an
 * agent's results on it has its failures answered there from now on. Read from the batches, so it is the same
 * answer when the report is applied after a restart.
 */
export async function firstCountedReport(db: ReadDb, batch: BatchRow, target: TargetRow): Promise<boolean> {
	if (target.commit_sha === null || batch.method === "agent") return false;
	return db.get(Q.firstCounted, { project: batch.project, what: target.what })?.seq === batch.seq;
}

/**
 * A code host can say where a change's head is, in either direction. Without that observation, first-reported
 * order still decides. A known late job cannot undo a newer head observation, even after a reset.
 * A merged change keeps its recorded head and metadata until explicitly reopened.
 */
async function upsertChange(
	ctx: Ctx,
	key: string,
	input: Extract<TargetIn, { commit: string }>,
	updateExisting: boolean,
): Promise<ChangeRow> {
	const existing = await ctx.db.get(Q.change, { project: ctx.project.id, key });
	// What an agent says about a change is not what the change is: no gate counts its results, so its report
	// neither moves the head nor rewrites the base, the title or the files. It can name a change nobody has
	// reported yet, and then the change has no head: the first pipeline or person to report it says where its
	// head is, and what its base, title and files are.
	const advisory = ctx.actor.kind === "agent";
	if (existing && (advisory || !updateExisting || existing.ended === "merged")) return existing;
	if (!existing) {
		const { lastId } = await ctx.db.run(Q.insertChange, {
			project: ctx.project.id,
			key,
			repo: input.repo ?? null,
			base: advisory ? null : (input.base ?? null),
			head: advisory ? null : (input.head ?? input.commit),
			observed: !advisory && input.head !== undefined ? ctx.seq : null,
			branch: input.branch ?? null,
			title: advisory ? null : (input.title ?? null),
			url: advisory ? null : (input.url ?? null),
			files: JSON.stringify(advisory ? [] : (input.files ?? [])),
			rev: ctx.seq,
		});
		ctx.touched.add(key);
		const row = await ctx.db.get(Q.changeById, { id: lastId });
		if (!row) throw new Error("change was not stored");
		return row;
	}
	if (input.head === undefined && input.commit !== existing.head_sha && existing.head_sha !== null) {
		const head = await firstSeen(ctx.db, ctx.project.id, existing.repo, existing.head_sha);
		const mine = await firstSeen(ctx.db, ctx.project.id, existing.repo, input.commit);
		if (mine !== null && mine <= Math.max(head ?? 0, existing.head_observed_seq ?? 0)) return existing;
	}
	const files = input.files ?? json<string[]>(existing.files);
	const next: ChangeWrite = {
		id: existing.id,
		base: input.base ?? existing.base_sha,
		head: input.head ?? input.commit,
		observed: input.head !== undefined ? ctx.seq : existing.head_observed_seq,
		title: input.title ?? existing.title,
		url: input.url ?? existing.url,
		files: JSON.stringify(files),
		rev: ctx.seq,
	};
	// The stored row in the shape the update writes, so a field added to `ChangeWrite` must be filled in here
	// and is compared below. `rev` is the write's own stamp, so it never decides.
	const stored: ChangeWrite = {
		id: existing.id,
		base: existing.base_sha,
		head: existing.head_sha,
		observed: existing.head_observed_seq,
		title: existing.title,
		url: existing.url,
		files: existing.files,
		rev: ctx.seq,
	};
	if ((Object.keys(next) as (keyof ChangeWrite)[]).some((field) => next[field] !== stored[field])) {
		if (next.base !== existing.base_sha) ctx.changedBases.add(existing.id);
		await ctx.db.run(Q.updateChange, next);
		ctx.touched.add(key);
	}
	return ctx.db.get(Q.changeById, { id: existing.id }) ?? existing;
}

export async function mustTarget(db: ReadDb, id: number): Promise<TargetRow> {
	const row = await db.get(Q.targetById, { id });
	if (!row) throw new Error(`target ${id} is missing`);
	return row;
}
export const targetsOfCommit = async (db: ReadDb, project: number, what: string): Promise<TargetRow[]> =>
	await db.all(Q.targetsOfCommit, { project, what });
/** Presentation only: a landing does not put trunk evidence back in a change's decision scope. */
export async function resultLocation(db: ReadDb, target: TargetRow): Promise<ResultLocation> {
	return (await resultLocations(db, [target]))(target);
}

/** One indexed lookup for all targets on a result page, including direct change names. */
export async function resultLocations(
	db: ReadDb,
	targets: TargetRow[],
): Promise<(target: TargetRow) => ResultLocation> {
	const names = new Map<number, { key: string | null; title: string | null } | null>();
	if (targets.length > 0)
		for (const row of await db.all(Q.locationChanges, {
			targets: JSON.stringify([...new Set(targets.map((t) => t.id))]),
		}))
			names.set(row.target, names.has(row.target) ? null : row);
	return (target) => {
		const change = names.get(target.id);
		const named = change?.key && !change.key.startsWith("commit:") ? change : null;
		const name = named ? [named.key, named.title].filter(Boolean).join(" ") : null;
		return {
			label:
				[target.line === "trunk" ? (target.branch ?? "trunk") : null, name].filter(Boolean).join(" · ") ||
				target.branch ||
				(target.commit_sha ? "Commit" : target.what),
			commit: target.commit_sha,
			change: named?.key ?? null,
		};
	};
}

/** The commit a merged change landed as on trunk, when one was reported. */
export const landingOf = (change: ChangeRow): { commit: string; branch: string } | null =>
	change.landing_commit !== null && change.landing_branch !== null
		? { commit: change.landing_commit, branch: change.landing_branch }
		: null;

export const changeByKey = async (db: ReadDb, project: number, key: string): Promise<ChangeRow | null> =>
	await db.get(Q.change, { project, key });
export const changeById = async (db: ReadDb, id: number): Promise<ChangeRow | null> =>
	await db.get(Q.changeById, { id });

/**
 * Records that a change ended, or with null that it is open again. A fact about the change, like where its head
 * is: said by whoever reports for it, and not a decision. What follows for its questions is the caller's.
 */
export async function setChangeEnded(ctx: Ctx, change: ChangeRow, ended: ChangeRow["ended"]): Promise<ChangeRow> {
	if (ended === null) await ctx.db.run(Q.reopenChange, { id: change.id });
	else await ctx.db.run(Q.endChange, { id: change.id, ended, at: ctx.now });
	await ctx.db.run(Q.touchChange, { id: change.id, rev: ctx.seq });
	ctx.touched.add(change.key);
	// A new end, or none, has no landing yet: `endChange` and `reopenChange` clear it.
	return {
		...change,
		ended,
		ended_at: ended === null ? null : ctx.now,
		receipt: null,
		landing_commit: null,
		landing_branch: null,
		rev: ctx.seq,
	};
}

/** Only the receipt decision machinery can select a frozen gate for this merge. */
export async function setMergeReceipt(ctx: Ctx, witness: Witness, change: ChangeRow): Promise<void> {
	const receipt = decisionOf(witness, "merge-receipt");
	await ctx.db.run(Q.setMergeReceipt, { id: change.id, receipt });
	await ctx.db.run(Q.touchChange, { id: change.id, rev: ctx.seq });
	ctx.touched.add(change.key);
}

/**
 * Where a change's head is, as the code host said when it reported how the change ended. It is taken even from a
 * merged change, whose head reports cannot move: the merge is what says which head merged.
 */
export async function observeEndingHead(ctx: Ctx, change: ChangeRow, head: string): Promise<ChangeRow> {
	if (change.head_sha === head) return change;
	await ctx.db.run(Q.updateChange, {
		id: change.id,
		base: change.base_sha,
		head,
		observed: ctx.seq,
		title: change.title,
		url: change.url,
		files: change.files,
		rev: ctx.seq,
	});
	ctx.touched.add(change.key);
	return { ...change, head_sha: head, head_observed_seq: ctx.seq, rev: ctx.seq };
}

/**
 * A landing records the commit that reached trunk and places it there, even before evidence arrives. It is not the
 * change's head: a rebase or a squash writes a commit the pull request never had, with a gate of its own.
 */
export async function landChange(
	ctx: Ctx,
	change: ChangeRow,
	landing: NonNullable<ChangeInput["landing"]>,
): Promise<TargetRow | null> {
	const landingChanged =
		ctx.db.run(Q.landChange, {
			id: change.id,
			commit: landing.commit,
			repo: change.repo,
			branch: landing.branch,
		}).changes > 0;
	if (landingChanged) {
		await ctx.db.run(Q.touchChange, { id: change.id, rev: ctx.seq });
		ctx.touched.add(change.key);
	}
	const what = codeWhat(change.repo, landing.commit);
	const existing = (await targetsOfCommit(ctx.db, ctx.project.id, what))[0];
	if (existing && existing.line === "trunk" && existing.branch === landing.branch && existing.change === null) {
		if (!landingChanged) return null;
		ctx.touched.add(change.key);
		return existing;
	}
	const target =
		existing ??
		ensureTarget(ctx, {
			commit: landing.commit,
			...(change.repo === null ? {} : { repo: change.repo }),
			branch: landing.branch,
		});
	await moveCommit(ctx, target, { line: "trunk", branch: landing.branch, change: null });
	ctx.touched.add(change.key);
	return await mustTarget(ctx.db, target.id);
}

async function moveCommit(
	ctx: Ctx,
	target: TargetRow,
	place: Pick<TargetRow, "line" | "branch" | "change">,
): Promise<void> {
	const before = scopeOf(target, null);
	const after = scopeOf({ ...target, ...place }, null);
	if (before !== after)
		await ctx.db.run(Q.scopeMove, {
			project: ctx.project.id,
			what: target.what,
			before,
			after,
			actor: ctx.actor.id,
			at: ctx.now,
			seq: ctx.seq,
		});
	await ctx.db.run(Q.placeCommit, { project: ctx.project.id, what: target.what, ...place });
}

/** Whether the change a scope names (`change:<id>`) has ended. A line and a run never end this way. */
export async function scopeEnded(db: ReadDb, scope: string): Promise<boolean> {
	if (!scope.startsWith("change:")) return false;
	const change = await db.get(Q.changeById, { id: Number(scope.slice("change:".length)) });
	return change !== null && change.ended !== null;
}
export const recentChanges = async (db: ReadDb, project: number, limit: number): Promise<ChangeRow[]> =>
	await db.all(Q.changes, { project, limit });

/** Where a failure on this target is answered: per change, on trunk, or within the run it was typed into. */
export function scopeOf(target: TargetRow, run: number | null): string {
	if (target.line === "session") return run !== null ? `run:${run}` : `session:${target.id}`;
	if (target.line === "release") return target.what;
	if (target.change !== null) return `change:${target.change}`;
	// A line belongs to a repository: what was decided about one repository's trunk says nothing about another's.
	return target.repo ? `line:${target.line}@${target.repo}` : `line:${target.line}`;
}

// ── Accept ─────────────────────────────────────────────────────────────────────────────────────────────────

export type Counts = { total: number; pass: number; fail: number; skip: number; error: number; blocked: number };

const countOutcomes = (results: readonly { outcome: Outcome }[]): Counts => {
	const counts: Counts = { total: results.length, pass: 0, fail: 0, skip: 0, error: 0, blocked: 0 };
	for (const result of results) counts[result.outcome]++;
	return counts;
};

/**
 * How one result was produced, decided per result and never for a batch as a whole.
 * - A pipeline's results are `auto`: it cannot claim a person ran something.
 * - An agent's results are `agent`, whether it names a case or a test key: what an agent reports counts only where
 *   a run asked for agents and the case admits them, and an agent cannot change that by its choice of words.
 * - A person's result that names a case is their own doing, `human`. One that names an automated test by key is
 *   `auto`: a person who runs `mainworthy report results.xml` with their own token is passing on a pipeline's work.
 */
export function methodFor(actor: ActorKind, result: Pick<ResultIn, "test">): MethodKind {
	switch (actor) {
		case "human":
			return "case" in result.test ? "human" : "auto";
		case "agent":
			return "agent";
		case "ci":
			return "auto";
		case "rule":
			throw invalid("a rule does not report results");
		default: {
			const _exhaustive: never = actor;
			return _exhaustive;
		}
	}
}

/** The method shown for a batch: the one its results share, or `auto` when a person sent both kinds together. */
function batchMethod(actor: ActorKind, results: readonly ResultIn[]): MethodKind {
	const methods = new Set(results.map((result) => methodFor(actor, result)));
	const [only] = methods;
	return methods.size === 1 && only ? only : "auto";
}

/**
 * Stores a report durably under its batch key and returns the batch. A second report with the same target, job,
 * attempt, producer and content returns the first batch with `fresh: false` and writes nothing.
 */
export async function accept(
	ctx: Ctx,
	input: {
		target: TargetRow;
		run: number | null;
		report: Pick<
			ReportInput,
			"target" | "model" | "job" | "attempt" | "shard" | "buildUrl" | "results" | "cmd" | "nothingRequired"
		>;
		/**
		 * For results recorded against a case: the command id, so recording the same outcome again later is a new
		 * fact. A report of automated tests only has no nonce: the same files sent twice are the same batch.
		 */
		nonce: string | null;
	},
): Promise<{ batch: BatchRow; fresh: boolean }> {
	const { report } = input;
	for (const result of report.results) {
		for (const step of result.steps ?? []) {
			if (step.attachment === undefined) continue;
			const file = result.attachments?.[step.attachment];
			if (!file || !attachmentType(Buffer.from(file.data, "base64")).startsWith("image/"))
				throw invalid("A step screenshot attachment must be an image");
		}
	}
	const reserved = report.results.find((result) => "key" in result.test && RESERVED_KEY.test(result.test.key));
	if (reserved && "key" in reserved.test) {
		throw invalid(
			`the test key "${reserved.test.key}" is reserved for the manual test of a case; name the case with {"case": "C-n"} or use another key`,
		);
	}
	const method = batchMethod(ctx.actor.kind, report.results);
	const job = report.job ?? "";
	const attempt = report.attempt ?? 1;
	// A file of automated results sent twice is one batch. Anything typed against a case is a new fact each time.
	const files = report.results.every((result) => "key" in result.test);
	const key = batchKey({
		target: input.target.id,
		run: input.run,
		job,
		attempt,
		method,
		actor: ctx.actor.id,
		nonce: files ? null : input.nonce,
		...(report.model !== undefined ? { model: report.model } : {}),
		...(report.shard ? { shard: report.shard } : {}),
		results: report.results,
		...(report.target && "commit" in report.target && report.target.head !== undefined
			? {
					head: report.target.head,
					buildUrl: report.buildUrl ?? null,
					pr: report.target.pr,
					branch: report.target.branch,
					observation: report.cmd ?? null,
				}
			: {}),
	});
	const existing = await ctx.db.get(Q.batchByKey, { project: ctx.project.id, key });
	if (existing) return { batch: existing, fresh: false };
	// A refusal after acceptance would leave a durable batch pending, so check new corrections before storing it.
	const corrected = new Set<number>();
	const pending = new Set(
		report.results.some((result) => result.corrects !== undefined)
			? (await ctx.db.all(Q.pendingCorrections, { project: ctx.project.id, actor: ctx.actor.id })).map(
					(row) => row.result,
				)
			: [],
	);
	for (const result of report.results) {
		if (result.corrects === undefined) continue;
		const earlier = await ctx.db.get(Q.resultById, { id: result.corrects });
		if (!earlier || earlier.project !== ctx.project.id || earlier.actor !== ctx.actor.id) continue;
		if (corrected.has(earlier.id) || isWithdrawn(ctx.db, earlier.id))
			throw conflict(
				`result ${earlier.id} was already corrected; read the latest results and correct the current result instead`,
			);
		if (pending.has(earlier.id))
			throw conflict(
				`result ${earlier.id} has an accepted correction waiting to be applied; retry that report or wait for server recovery before correcting again`,
			);
		corrected.add(earlier.id);
	}
	if (report.shard) {
		const other = (await ctx.db.all(Q.shardsOf, { target: input.target.id })).find(
			(row) => row.job === job && row.shards !== report.shard?.of,
		);
		if (other)
			throw invalid(
				`job "${job}" of this commit was reported in ${other.shards} shards; this report says ${report.shard.of}`,
			);
	}
	const { lastId } = await ctx.db.run(Q.insertBatch, {
		project: ctx.project.id,
		key,
		target: input.target.id,
		job,
		attempt,
		method,
		actor: ctx.actor.id,
		run: input.run,
		nothingRequired: report.nothingRequired ? 1 : 0,
		shard: report.shard?.index ?? null,
		shards: report.shard?.of ?? null,
		model: report.model ?? null,
		url: report.buildUrl ?? null,
		counts: JSON.stringify(countOutcomes(report.results)),
		staged: JSON.stringify(report.results),
		at: ctx.now,
		seq: ctx.seq,
	});
	const batch = await ctx.db.get(Q.batchById, { id: lastId });
	if (!batch) throw new Error("batch was not stored");
	return { batch, fresh: true };
}

export const batchById = async (db: ReadDb, id: number): Promise<BatchRow | null> => await db.get(Q.batchById, { id });
export const acceptedBatches = async (db: ReadDb): Promise<BatchRow[]> => await db.all(Q.accepted);

/**
 * The shards a commit is still waiting for: for each job of each of its targets that reported in shards, the shards
 * that have not reported, sent or applied. Empty when every job reported whole, or every shard of it arrived.
 */
/** Walk a commit's shard waits without collecting every target, job or missing index in one array. */
export async function* waitingShardPages(db: ReadDb, project: number, what: string): AsyncGenerator<ShardWait[]> {
	let target = 0;
	let job = "";
	let shards = 0;
	for (;;) {
		const rows = await db.all(Q.receiptShards, { project, what, target, job, shards });
		if (!rows.length) return;
		yield rows.flatMap((row) => {
			const reported = new Set(row.reported.split(",").map(Number));
			const missing = Array.from({ length: row.shards }, (_, i) => i + 1).filter((i) => !reported.has(i));
			return missing.length ? [{ job: row.job, env: row.env, of: row.shards, missing }] : [];
		});
		const last = rows.at(-1);
		if (!last) return;
		target = last.target;
		job = last.job;
		shards = last.shards;
	}
}

export function waitingShards(db: ReadDb, targets: readonly TargetRow[]): ShardWait[] {
	return targets.flatMap((target) =>
		db.all(Q.shardsOf, { target: target.id }).flatMap((row) => {
			const reported = new Set(row.reported.split(",").map(Number));
			const missing = Array.from({ length: row.shards }, (_, i) => i + 1).filter((i) => !reported.has(i));
			return missing.length > 0 ? [{ job: row.job, env: target.env, missing, of: row.shards }] : [];
		}),
	);
}

/** A declaration proves nothing once any ordinary report exists on any target the commit counts. */
export async function nothingRequiredOn(db: ReadDb, targets: readonly TargetRow[]): Promise<boolean> {
	let declared = false;
	for (const target of targets) {
		const reports = await db.get(Q.emptyReports, { target: target.id });
		if (reports?.ordinary) return false;
		if (reports?.declared) declared = true;
	}
	return declared;
}
/**
 * The jobs that have reported for a target, for a run that requires a job: a pipeline's report (or a person
 * passing one on) that ran something. What counts is an uncorrected decisive automated result in the batch,
 * each result by its own method: an agent's report under the job's name is not the job, a report in which every automated
 * result was skipped or could not run says the job ran nothing, and a person's own pass of a case sent along
 * with it is theirs, not the job's.
 */
export const processedJobs = async (db: ReadDb, target: number): Promise<Set<string>> =>
	new Set((await db.all(Q.processedJobs, { target })).map((r) => r.job));
/** Whether its producer has since corrected this result. */
export const isWithdrawn = async (db: ReadDb, result: number): Promise<boolean> =>
	db.get(Q.correctionOf, { result }) !== null;

// ── Apply ──────────────────────────────────────────────────────────────────────────────────────────────────

export type Applied = {
	id: number;
	ord: number;
	test: TestRow;
	outcome: Outcome;
	method: MethodKind;
	attempt: number;
	basis: ResultRow["basis"];
	basisCase: number | null;
	basisVersion: number | null;
	basisClaim: string | null;
	signature: SignatureRow | null;
	message: string | null;
	corrects: number | null;
	/** True when a higher decisive attempt changes outcome within one producer, job, method and target. */
	flipped: boolean;
	/** True when this test was first seen in this batch. */
	fresh: boolean;
};

export type ApplyResult = {
	results: Applied[];
	counts: Counts;
	basis: { exact: number; assumed: number; unresolved: number };
	flips: number;
	rejected: { index: number; reason: string }[];
	declined: { index: number; reason: string }[];
};

/**
 * Results applied between two pauses. About 7 ms of work: the longest the server's main thread is held by one
 * step of a large report, and so the longest a finished read waits to be sent. Smaller slices do not make a report
 * measurably slower; larger ones showed in the read latency under load (see `bench/README.md`).
 */
export const SLICE = 200;

/**
 * Turns a batch's staged results into result rows. `producer` is the kind of the actor that sent the batch;
 * `pinned` gives the version a planned run pinned for a case, when the batch was typed into one.
 *
 * The basis of each result is derived here and nowhere else:
 * - exact: a pinned slot, or an annotation that names a version (`@C-311@v7`);
 * - assumed: the case's current version, when the test is linked to a case or annotated with one;
 * - unresolved: no case.
 * A claim that cannot be accepted (a case or version that does not exist, a pin and an annotation that disagree, a
 * link and an annotation that name different cases) is refused, never adjusted to fit. For a result recorded
 * against a case that refuses the result (`rejected`). For an automated test the outcome is still a fact about
 * the commit, and dropping it could hide a failure from the gate: it is kept with no case (`declined`).
 */
export async function* applySteps(
	ctx: Ctx,
	batch: BatchRow,
	producer: ActorKind,
	pinned: (caseId: number) => number | null,
): AsyncGenerator<undefined, ApplyResult, void> {
	if (batch.state !== "accepted" || batch.staged === null) throw new Error(`batch ${batch.id} was already applied`);
	yield* ensureAssertionIndex(ctx.db, ctx.project.id);
	const scope = assertionScope(await mustTarget(ctx.db, batch.target), batch.id);
	let observations = 0;
	const staged = json<ResultIn[]>(batch.staged);
	const project = ctx.project.id;
	const out: ApplyResult = {
		results: [],
		counts: countOutcomes([]),
		basis: { exact: 0, assumed: 0, unresolved: 0 },
		flips: 0,
		rejected: [],
		declined: [],
	};
	const heads = new Map<number, CaseRow | null>();
	const head = async (id: number): Promise<CaseRow | null> => {
		if (!heads.has(id)) heads.set(id, await caseById(ctx.db, id));
		return heads.get(id) ?? null;
	};
	const claimAt = new Map<string, string | null>();
	const claimOf = async (caseId: number, version: number): Promise<string | null> => {
		const key = `${caseId}@${version}`;
		if (!claimAt.has(key)) {
			claimAt.set(key, versionOf(ctx.db, caseId, version)?.claim_hash ?? null);
		}
		return claimAt.get(key) ?? null;
	};

	for (let index = 0; index < staged.length; index++) {
		const input = staged[index];
		if (!input) continue;
		// A pause every slice: the transaction stays open, and the server may answer reads in between.
		if (index > 0 && index % SLICE === 0) yield;
		const resolved = await resolveTest(ctx, input);
		if ("reject" in resolved) {
			out.rejected.push({ index, reason: resolved.reject });
			continue;
		}
		const { test, fresh } = resolved;
		const typed = "case" in input.test;
		const method = methodFor(producer, input);

		// The basis: every claim about the case and the version, then the assumption, then nothing.
		let refused: string | null = null;
		const annotation =
			input.annotation ??
			caseNameAnnotation(
				"key" in input.test ? (input.test.name ?? input.test.key) : "",
				(alias) => findCase(ctx.db, project, alias) !== null,
			);
		const annotated = annotation ? await findCase(ctx.db, project, annotation.case) : null;
		const linked = test.case_id !== null ? await head(test.case_id) : null;
		if (annotation && !annotated) refused = `the annotation names ${annotation.case}, which does not exist`;
		else if (annotated && linked && annotated.id !== linked.id) {
			refused = typed
				? `the result names ${caseRef(linked)} and its annotation names ${caseRef(annotated)}`
				: `${testRef(test)} is linked to ${caseRef(linked)} and annotated with ${caseRef(annotated)}`;
		}
		let subject = annotated?.id ?? test.case_id;
		const pin = subject !== null ? pinned(subject) : null;
		const claims = [pin, annotation?.version ?? null].filter((v): v is number => v !== null);
		if (refused === null && claims.length === 2 && claims[0] !== claims[1]) {
			refused = `basis conflict: the run pinned version ${claims[0]}, the annotation says ${claims[1]}`;
		}
		let basis: ResultRow["basis"] = "unresolved";
		let basisVersion: number | null = null;
		if (refused === null && subject !== null) {
			const row = await head(subject);
			if (claims[0] !== undefined) {
				basis = "exact";
				basisVersion = claims[0];
			} else if (row) {
				basis = "assumed";
				basisVersion = row.head;
			}
			if (basisVersion !== null && (basisVersion < 1 || (row && basisVersion > row.head))) {
				refused = `${row ? caseRef(row) : "the case"} has no version ${basisVersion}`;
			}
		}
		let corrects = input.corrects ?? null;
		// A correction stands where the result it corrects stood: it is never an older attempt than that one,
		// whatever number the report that carries it has.
		let attempt = batch.attempt;
		if (refused === null && corrects !== null) {
			const earlier = await ctx.db.get(Q.resultById, { id: corrects });
			if (earlier) attempt = Math.max(attempt, earlier.attempt);
			if (
				!earlier ||
				earlier.project !== project ||
				earlier.actor !== batch.actor ||
				earlier.test !== test.id ||
				earlier.target !== batch.target ||
				earlier.run !== batch.run
			) {
				refused =
					"a result can only correct an earlier result of the same producer for the same test, recorded on the same target and in the same run";
			}
		}
		if (refused !== null) {
			if (typed) {
				out.rejected.push({ index, reason: refused });
				continue;
			}
			out.declined.push({ index, reason: `${refused}: recorded with no case` });
			basis = "unresolved";
			basisVersion = null;
			subject = null;
			corrects = null;
			attempt = batch.attempt;
		}
		const basisCase = basis === "unresolved" ? null : subject;
		const basisClaim = basisCase !== null && basisVersion !== null ? await claimOf(basisCase, basisVersion) : null;

		let signature: SignatureRow | null = null;
		let message: string | null = null;
		if (input.outcome === "fail" || input.outcome === "error") {
			message = input.failure?.message?.trim() || input.note?.trim() || null;
			signature = await ensureSignature(ctx, test.key, {
				message: message ?? "",
				...(input.failure?.detail ? { detail: input.failure.detail } : {}),
			});
		}

		if (signature) await observeAssertion(ctx, scope, signature, test);
		const previous = await ctx.db.get(Q.previousOnTarget, {
			target: batch.target,
			test: test.id,
			actor: batch.actor,
			job: batch.job,
			method,
		});
		const ord = ctx.ord();
		const { lastId } = await ctx.db.run(Q.insertResult, {
			project,
			test: test.id,
			seq: ctx.seq,
			ord,
			batch: batch.id,
			target: batch.target,
			method,
			actor: batch.actor,
			model: batch.model,
			basis,
			basisCase,
			basisVersion,
			basisClaim,
			outcome: input.outcome,
			attempt,
			duration: input.durationMs ?? null,
			signature: signature?.id ?? null,
			message,
			detail: input.failure?.detail ?? null,
			atStep: input.steps === undefined ? (input.failure?.at ?? null) : null,
			trail: input.steps === undefined ? null : JSON.stringify(input.steps),
			note: input.note ?? null,
			run: batch.run,
			corrects,
			at: ctx.now,
		});
		await recordAttachments(ctx, lastId, input.attachments ?? []);
		// What the runner saw, in order: its earlier tries, then the result (decision 0129).
		const seen: { outcome: Outcome; try: number | null }[] = [];
		for (const [index, tried] of (input.tries ?? []).entries()) {
			const message = tried.failure?.message.trim() || null;
			const cause =
				tried.outcome === "fail" || tried.outcome === "error"
					? await ensureSignature(ctx, test.key, {
							message: message ?? "",
							...(tried.failure?.detail ? { detail: tried.failure.detail } : {}),
						})
					: null;
			const { lastId: tryId } = await ctx.db.run(Q.insertTry, {
				project,
				result: lastId,
				try: index + 1,
				outcome: tried.outcome,
				duration: tried.durationMs ?? null,
				signature: cause?.id ?? null,
				message,
				detail: tried.failure?.detail ?? null,
			});
			if (cause) await observeAssertion(ctx, scope, cause, test);
			seen.push({ outcome: tried.outcome, try: tryId });
			if (++observations % SLICE === 0) yield;
		}
		seen.push({ outcome: input.outcome, try: null });
		const decisive = (o: Outcome) => (o === "pass" ? "pass" : o === "fail" || o === "error" ? "fail" : null);
		const flip = async (first: number, firstTry: number | null, secondTry: number | null) => {
			await ctx.db.run(Q.insertFlip, {
				project,
				test: test.id,
				target: batch.target,
				first,
				second: lastId,
				firstTry,
				secondTry,
				seq: ctx.seq,
			});
			out.flips++;
		};
		const decided = seen.filter((observed) => decisive(observed.outcome) !== null);
		// Across attempts, the earlier result meets this run's first decisive try, so a recovery is one flip whether
		// the pipeline or the runner retried first.
		const opening = decided[0];
		const across =
			previous !== null &&
			opening !== undefined &&
			previous.attempt < attempt &&
			corrects === null &&
			decisive(previous.outcome) !== null &&
			decisive(previous.outcome) !== decisive(opening.outcome);
		if (across && previous && opening) await flip(previous.id, null, opening.try);
		let within = false;
		for (let index = 1; index < decided.length; index++) {
			const before = decided[index - 1];
			const after = decided[index];
			if (before && after && decisive(before.outcome) !== decisive(after.outcome)) {
				await flip(lastId, before.try, after.try);
				within = true;
			}
		}
		const flipped = across || within;
		if (!fresh) await ctx.db.run(Q.touchTest, { id: test.id, seq: ctx.seq });
		out.basis[basis]++;
		out.results.push({
			id: lastId,
			ord,
			test,
			outcome: input.outcome,
			method,
			attempt,
			basis,
			basisCase,
			basisVersion,
			basisClaim,
			signature,
			message,
			corrects,
			flipped,
			fresh,
		});
	}
	for (const result of out.results) {
		if (result.signature?.class === "assertion") {
			const split = await signatureByHash(ctx.db, project, fileSignature(result.signature, result.test.file).hash);
			if (split) {
				result.signature = split;
				await ctx.db.run(Q.splitResult, { id: result.id, signature: split.id });
			}
		}
		for (const tried of await ctx.db.all(Q.assertionTries, { result: result.id })) {
			const root = await signatureById(ctx.db, tried.signature);
			if (root) {
				const split = await signatureByHash(ctx.db, project, fileSignature(root, result.test.file).hash);
				if (split) await ctx.db.run(Q.splitTry, { id: tried.id, signature: split.id });
			}
			if (++observations % SLICE === 0) yield;
		}
		if (++observations % SLICE === 0) yield;
	}
	await finishAssertionScope(ctx, scope);
	out.counts = countOutcomes(out.results);
	return out;
}

/** `applySteps` run to the end without pausing. */
export async function apply(
	ctx: Ctx,
	batch: BatchRow,
	producer: ActorKind,
	pinned: (caseId: number) => number | null,
): Promise<ApplyResult> {
	const steps = applySteps(ctx, batch, producer, pinned);
	for (let step = await steps.next(); ; step = await steps.next()) if (step.done) return step.value;
}

/**
 * Marks a batch applied: its results are rows now and its job has reported. Called before the runs are folded, so
 * a run that requires this job counts it.
 */
export async function markProcessed(ctx: Ctx, batch: BatchRow, counts: Counts): Promise<void> {
	await ctx.db.run(Q.markProcessed, { id: batch.id, counts: JSON.stringify(counts) });
}

/** Keeps the reply to a report, so the same report sent again gets the same answer. */
export async function keepReceipt(ctx: Ctx, batch: BatchRow, receipt: unknown): Promise<void> {
	await ctx.db.run(Q.setReceipt, { id: batch.id, receipt: JSON.stringify(receipt) });
}

/** Rewrites saved report replies without changing the report's identity or its results. */
export async function rewriteReportReceipts(db: WriteDb, rewrite: (receipt: string) => string): Promise<void> {
	for (const row of await db.all(Q.receipts)) {
		const receipt = rewrite(row.receipt);
		if (receipt !== row.receipt) await db.run(Q.setReceipt, { id: row.id, receipt });
	}
}

async function resolveTest(ctx: Ctx, input: ResultIn): Promise<{ test: TestRow; fresh: boolean } | { reject: string }> {
	const project = ctx.project.id;
	if ("case" in input.test) {
		const row = await findCase(ctx.db, project, input.test.case);
		if (!row) return { reject: `case ${input.test.case} does not exist` };
		const key = `case:${row.id}`;
		const found = await ctx.db.get(Q.testByKey, { project, key });
		if (found) return { test: found, fresh: false };
		return {
			test: await insertTest(ctx, { kind: "manual", key, name: row.title, file: null, caseId: row.id }),
			fresh: true,
		};
	}
	const key = input.test.key.trim();
	const found = await ctx.db.get(Q.testByKey, { project, key });
	if (found) return { test: found, fresh: false };
	const name = input.test.name?.trim() || key.split("::").at(-1) || key;
	const file = input.test.file?.trim() || (key.includes("::") ? (key.split("::")[0] ?? null) : null);
	return { test: await insertTest(ctx, { kind: "auto", key, name, file, caseId: null }), fresh: true };
}

async function insertTest(
	ctx: Ctx,
	input: { kind: "manual" | "auto"; key: string; name: string; file: string | null; caseId: number | null },
): Promise<TestRow> {
	const no = await ctx.nextNo("test");
	const { lastId } = await ctx.db.run(Q.insertTest, { project: ctx.project.id, no, ...input, seq: ctx.seq });
	return {
		id: lastId,
		project: ctx.project.id,
		no,
		...input,
		case_id: input.caseId,
		linked_by: null,
		first_seq: ctx.seq,
		last_seq: ctx.seq,
	};
}

// ── Reads ──────────────────────────────────────────────────────────────────────────────────────────────────

export const testRef = (row: { no: number }): string => `T-${row.no}`;
export const testById = async (db: ReadDb, id: number): Promise<TestRow | null> => await db.get(Q.testById, { id });
export async function findTest(db: ReadDb, project: number, text: string): Promise<TestRow | null> {
	const match = /^(?:T-)?(\d+)$/i.exec(text.trim());
	return match
		? await db.get(Q.testByNo, { project, no: Number(match[1]) })
		: await db.get(Q.testByKey, { project, key: text.trim() });
}
export const testsOfCase = async (db: ReadDb, project: number, caseId: number): Promise<TestRow[]> =>
	await db.all(Q.testsOfCase, { project, id: caseId });
/** What the question about tests that name no file calls their file. */
export const NO_FILE = "(no file)";
/**
 * The tests with no case in a file. For `NO_FILE` they are those that came with no file and no class name to take
 * one from, and with them the tests of a file that is really called that: the two share one question.
 */
export const unlinkedInFile = async (db: ReadDb, project: number, file: string): Promise<TestRow[]> =>
	await db.all(file === NO_FILE ? Q.unlinkedWithoutFile : Q.unlinkedInFile, { project, file });
export const unlinkedCount = async (db: ReadDb, project: number): Promise<number> =>
	db.get(Q.unlinkedCount, { project })?.n ?? 0;
export const resultById = async (db: ReadDb, id: number): Promise<ResultRow | null> =>
	await db.get(Q.resultById, { id });

/**
 * How long these results took, as their reports said: the sum of their durations, and how many of them named one.
 * Results that ran side by side add up, so this is the time spent testing, not how long a build waited for it.
 */
export async function testTime(db: ReadDb, results: readonly number[]): Promise<{ ms: number; timed: number }> {
	return db.get(Q.testTime, { results: JSON.stringify(results) }) ?? { ms: 0, timed: 0 };
}

/**
 * Every result one producer reported for one test from one job on one target that it has not since corrected,
 * in the order they arrived: the history a commit's gate folds when a correction or a decision takes one out.
 */
export const laneHistory = async (
	db: ReadDb,
	lane: { target: number; test: number; actor: number; job: string },
): Promise<ResultRow[]> => await db.all(Q.laneHistory, lane);

/**
 * Where an actor has reported a failure with this cause: each target, and the run it was typed into if any. Read
 * from the results themselves, so it is complete however the question about the cause came to be asked.
 */
export const producedCause = async (
	db: ReadDb,
	project: number,
	signature: number,
	actor: number,
): Promise<{ target: number; run: number | null }[]> => await db.all(Q.producedOn, { project, signature, actor });
export const lastResultsOfTest = async (
	db: ReadDb,
	project: number,
	test: number,
	limit: number,
): Promise<ResultRow[]> => await db.all(Q.lastOfTest, { project, test, limit });
/**
 * The newest results recorded for a case, from every producer. Read as three short index ranges (one per method)
 * and merged, so a case with ten thousand pipeline results costs the same as one with ten.
 */
export function lastResultsOfCase(db: ReadDb, caseId: number, limit: number): ResultRow[] {
	const methods: readonly MethodKind[] = ["human", "auto", "agent"];
	return methods
		.flatMap((method) => db.all(Q.lastOfCaseByMethod, { id: caseId, method, limit }))
		.sort((a, b) => b.seq - a.seq || b.ord - a.ord)
		.slice(0, limit);
}
export const resultsOfBatch = async (db: ReadDb, batch: number, limit: number): Promise<ResultRow[]> =>
	await db.all(Q.ofBatch, { batch, limit });
/** A runner's earlier tries of each of these results, oldest first (decision 0129). */
export async function triesOf(
	db: ReadDb,
	results: readonly number[],
): Promise<Map<number, { outcome: Outcome; message: string | null; durationMs: number | null }[]>> {
	const out = new Map<number, { outcome: Outcome; message: string | null; durationMs: number | null }[]>();
	if (results.length === 0) return out;
	for (const row of await db.all(Q.triesOf, { results: JSON.stringify(results) })) {
		const list = out.get(row.result) ?? [];
		list.push({ outcome: row.outcome, message: row.message, durationMs: row.duration_ms });
		out.set(row.result, list);
	}
	return out;
}
export const flipCount = async (db: ReadDb, project: number, test: number): Promise<number> =>
	db.get(Q.flipCount, { project, test })?.n ?? 0;
/** Which of these results stand in a lane whose test both passed and failed on their target, as reported. */
export async function flippedLanes(db: ReadDb, results: readonly number[]): Promise<Set<number>> {
	if (results.length === 0) return new Set();
	return new Set((await db.all(Q.flippedLanes, { results: JSON.stringify(results) })).map((row) => row.result));
}
/** Of these results, each failure that a later attempt of the same lane passed, with the attempt that passed. */
export async function passedOnRetry(db: ReadDb, results: readonly number[]): Promise<Map<number, number>> {
	if (results.length === 0) return new Map();
	return new Map(
		(await db.all(Q.passedOnRetry, { results: JSON.stringify(results) })).map((row) => [row.result, row.attempt]),
	);
}

/**
 * Every target reported for a commit, named by its full hash or by a prefix of at least seven characters that
 * matches one commit only: one per repository and environment it was reported for. Empty when nothing was
 * reported for it or the prefix is ambiguous.
 */
export async function targetsWithCommit(db: ReadDb, project: number, commit: string): Promise<TargetRow[]> {
	const exact = await db.all(Q.targetsByCommit, { project, commit });
	if (exact.length > 0) return exact;
	if (commit.length < 7 || !/^[0-9a-f]+$/i.test(commit)) return [];
	const rows = await db.all(Q.targetsByCommitPrefix, { project, low: commit, high: `${commit}\uffff` });
	return new Set(rows.map((row) => row.commit_sha)).size === 1 ? rows : [];
}

/**
 * The whole hash meant by the commit a run is planned for. A run stands for one commit from then on, so an
 * abbreviation is settled once, here: the text itself when a commit with exactly that hash was reported or none
 * starts with it, the one reported commit that starts with it, and a refusal when more than one does.
 */
export async function resolveCommit(db: ReadDb, project: number, commit: string): Promise<string> {
	if (db.all(Q.targetsByCommit, { project, commit }).length > 0) return commit;
	if (commit.length < 7 || !/^[0-9a-f]+$/i.test(commit)) return commit;
	const found = new Set<string>();
	for (const row of await db.all(Q.targetsByCommitPrefix, { project, low: commit, high: `${commit}\uffff` }))
		if (row.commit_sha !== null) found.add(row.commit_sha);
	if (found.size > 1) {
		throw invalid(
			`${commit} is the start of ${found.size} commits (${[...found]
				.slice(0, 3)
				.map((sha) => sha.slice(0, 16))
				.join(", ")}): give more of the hash`,
		);
	}
	return [...found][0] ?? commit;
}

/**
 * The target a caller means by a commit. The same commit can exist in two repositories (a fork): with `repo` the
 * answer is that repository's; without it, a commit reported for more than one repository is refused, never
 * guessed. Null when nothing was reported for it.
 */
export async function targetByCommit(
	db: ReadDb,
	project: number,
	commit: string,
	repo?: string | null,
): Promise<TargetRow | null> {
	const all = await targetsWithCommit(db, project, commit);
	const rows = repo === undefined ? all : all.filter((row) => row.repo === (repo ?? null));
	const repos = [...new Set(rows.map((row) => row.repo ?? "(no repository)"))];
	if (repos.length > 1) {
		throw invalid(
			`commit ${commit} was reported for ${repos.length} repositories (${repos.join(", ")}): say which with \`repo\``,
		);
	}
	return rows[0] ?? null;
}

/**
 * The identity of a batch: a digest of what was sent. A 10,000-result report is megabytes, and this runs on the
 * thread that answers requests, so it is the platform's SHA-256 over one serialisation and not the canonical
 * hash the rest of the record uses (which sorts every key in JavaScript and takes five times as long). The same
 * report sent twice is serialised the same way, which is all a batch key has to guarantee.
 */
const batchKey = (parts: unknown): string => createHash("sha256").update(JSON.stringify(parts)).digest("hex");

/** Keys of this shape name the manual test of a case. An automated test cannot take one. */
const RESERVED_KEY = /^case:\d+$/i;

/**
 * Every result recorded for a case on any of the given targets that its producer has not since corrected, oldest
 * first: what a new run can count at once. A corrected result is withdrawn by the one that corrects it, wherever
 * it would otherwise count.
 */
export async function resultsOfCaseOnTargets(
	db: ReadDb,
	caseId: number,
	targets: readonly number[],
): Promise<ResultRow[]> {
	if (targets.length === 0) return [];
	return await db.allDynamic<ResultRow>(
		`SELECT r.* FROM results r WHERE r.basis_case = ? AND r.target IN (${placeholders(targets.length)})
		 AND ${uncorrectedResults("r.id")}
		 ORDER BY r.seq, r.ord`,
		[caseId, ...targets],
	);
}

export async function caseSelectionOfFiles(db: ReadDb, project: number, files: ReadonlySet<string>) {
	const selected = files.size
		? await db.get(Q.caseSelectionOfFiles, { project, files: JSON.stringify([...files]) })
		: null;
	return {
		ids: selected ? json<number[]>(selected.ids) : [],
		covered: new Set(selected ? json<string[]>(selected.files) : []),
	};
}

export const caseLinksOfFiles = async (
	db: ReadDb,
	project: number,
	files: ReadonlySet<string>,
	cases: readonly number[],
) =>
	files.size && cases.length
		? await db.all(Q.caseLinksOfFiles, { project, files: JSON.stringify([...files]), cases: JSON.stringify(cases) })
		: [];

export const caseIdsOfTests = async (db: ReadDb, project: number, tests: readonly number[]): Promise<number[]> =>
	tests.length
		? (await db.all(Q.caseIdsOfTests, { project, tests: JSON.stringify(tests) })).map((row) => row.case_id)
		: [];

/** Three indexed result seeks per requested case, without reading its result history or payloads. */
export const lastResultsOfCases = async (db: ReadDb, cases: readonly number[]) =>
	new Map((await db.all(Q.lastOfCases, { cases: JSON.stringify(cases) })).map((row) => [row.case_id, row]));

/**
 * A page of automated tests, newest first, optionally only those with no case or matching a text. The manual test
 * a case's hand-run results hang on is the case's, and is not listed.
 */
export async function listTests(
	db: ReadDb,
	input: { project: number; unlinked: boolean; text: string | undefined; before: number | null; limit: number },
): Promise<TestRow[]> {
	const where: string[] = ["project = ?", "kind = 'auto'"];
	const params: SqlValue[] = [input.project];
	if (input.unlinked) where.push("case_id IS NULL");
	if (input.text) {
		where.push("(key LIKE ? OR name LIKE ? OR file LIKE ?)");
		params.push(`%${input.text}%`, `%${input.text}%`, `%${input.text}%`);
	}
	if (input.before !== null) {
		where.push("id < ?");
		params.push(input.before);
	}
	return await db.allDynamic<TestRow>(`SELECT * FROM tests WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`, [
		...params,
		input.limit,
	]);
}

export type Proof = { result: ResultRow; current: boolean } | null;

/** The proof strip of a case: per producer, the latest result and whether it was on the current version. */
export async function proofOf(db: ReadDb, row: { id: number; head: number }): Promise<Record<MethodKind, Proof>> {
	const one = async (method: MethodKind): Promise<Proof> => {
		const latest = await db.get(Q.latestOfCaseByMethod, { id: row.id, method });
		return latest ? { result: latest, current: latest.basis_version === row.head } : null;
	};
	return { human: await one("human"), auto: await one("auto"), agent: await one("agent") };
}

// ── Standing ───────────────────────────────────────────────────────────────────────────────────────────────

/** Links a test to a case, or unlinks it with null. Standing: only by a `map` decision, which the link records. */
export async function linkTest(ctx: Ctx, witness: Witness, test: TestRow, caseId: number | null): Promise<void> {
	await ctx.db.run(Q.linkTest, { id: test.id, caseId, by: decisionOf(witness, "map") });
	ctx.touched.add(testRef(test));
}

/**
 * Puts a test's link back to what it was before the `map` decision `from`. Revert only: called when that decision
 * is withdrawn, which is itself recorded in the ledger. It does nothing when the link is no longer that
 * decision's: a newer decision made it, and withdrawing an older one must not undo it. `to` is the earlier link
 * and the decision that made it, or nulls when there was none or its decision no longer stands.
 */
export async function restoreLink(
	ctx: Ctx,
	test: TestRow,
	from: number,
	to: { caseId: number | null; by: number | null },
): Promise<boolean> {
	if (test.linked_by !== from) return false;
	await ctx.db.run(Q.linkTest, { id: test.id, caseId: to.caseId, by: to.by });
	ctx.touched.add(testRef(test));
	return true;
}

/**
 * Where these tests have failed with a cause in a scope, as reported: each test with each environment it failed in.
 * A newer attempt that passed does not take a failure out. The job is left out, because a sharded pipeline moves a
 * test from one job to another; so is who reported, because a pipeline's token can be replaced. A gate counts
 * pipelines and people, so an agent's failure is left out.
 */
export async function failedIn(
	db: ReadDb,
	input: { project: number; signature: number; scope: string; tests: ReadonlySet<number> },
): Promise<{ test: number; env: string; commit: string | null }[]> {
	const targets = new Map<number, TargetRow>();
	return (await db.all(Q.failedWith, { project: input.project, signature: input.signature })).flatMap((row) => {
		if (!input.tests.has(row.test)) return [];
		let target = targets.get(row.target);
		if (!target) {
			target = mustTarget(db, row.target);
			targets.set(row.target, target);
		}
		return scopeOf(target, null) === input.scope
			? [{ test: row.test, env: target.env, commit: target.commit_sha }]
			: [];
	});
}

/**
 * How a cause seen on a target is answered in a scope, if it is: by the answer given for that target, and
 * otherwise by the answer for every target of the scope. (The two coexist only where the narrower one is the
 * later judgement, or is the answer to a dispute, which another question's answer does not end.)
 */
export const excuseFor = async (db: ReadDb, project: number, signature: number, scope: string, target: number) =>
	db.get(Q.excuse, { project, signature, scope, target }) ?? db.get(Q.excuse, { project, signature, scope, target: 0 });

/**
 * Records how a cause is answered in a scope. Standing: only by a `failure` decision. `targets` limits it to the
 * targets named, for a decision that holds there only: the same cause on another commit of the scope, or in
 * another environment of the same commit, stays unexplained. Null covers every target of the scope.
 */
export async function setExcuse(
	ctx: Ctx,
	witness: Witness,
	input: { signature: number; scope: string; class: "attributed" | "excused"; targets: readonly number[] | null },
): Promise<void> {
	const decision = decisionOf(witness, "failure");
	for (const target of input.targets ?? [0]) {
		await ctx.db.run(Q.setExcuse, {
			project: ctx.project.id,
			signature: input.signature,
			scope: input.scope,
			decision,
			class: input.class,
			expires: witness.expiresAt,
			target,
		});
	}
}

/**
 * Removes the excuses `decision` made, when that decision is withdrawn or stops holding. An excuse another
 * decision made for the same cause and scope is left alone.
 */
export async function dropExcuse(ctx: Ctx, signature: number, scope: string, decision: number): Promise<void> {
	await ctx.db.run(Q.dropExcuse, { project: ctx.project.id, signature, scope, decision });
}

/** An exact result's answer and the broader cause's answer, with the newer judgement taking precedence. */
export async function excuseForResult(
	db: ReadDb,
	result: Pick<ResultRow, "id" | "project" | "signature" | "target">,
	scope: string,
) {
	const broad =
		result.signature === null ? null : await excuseFor(db, result.project, result.signature, scope, result.target);
	const exact = await db.get(Q.resultExcuse, { result: result.id });
	return exact && (!broad || exact.decision > broad.decision) ? exact : broad;
}

/** A disputed slot needs its own judgement; a cause or another slot's answer cannot settle it. */
export async function excuseForDisputedSlot(db: ReadDb, slot: number, result: number, run: number) {
	const exact = await db.get(Q.slotExcuse, { result, slot });
	if (exact) return exact;
	const current = await resultById(db, result);
	if (current?.method !== "agent" || current.signature === null) return null;
	const scope = scopeOf(await mustTarget(db, current.target), run);
	return (
		(await db.all(Q.slotCauseExcuses, { slot, signature: current.signature })).find(
			(prior) => scopeOf(mustTarget(db, prior.target), run) === scope,
		) ?? null
	);
}

/** Standing for precisely the results named by a failure decision. */
export async function setResultExcuses(
	ctx: Ctx,
	witness: Witness,
	results: readonly number[],
	klass: "attributed" | "excused",
	scope: { kind: "result" } | { kind: "slot"; slot: number } = { kind: "result" },
): Promise<void> {
	const decision = decisionOf(witness, "failure");
	for (const result of results)
		await ctx.db.run(Q.setResultExcuse, {
			result,
			slot: scope.kind === "slot" ? scope.slot : null,
			decision,
			class: klass,
			expires: witness.expiresAt,
		});
}
export async function dropResultExcuses(ctx: Ctx, decision: number): Promise<void> {
	await ctx.db.run(Q.dropResultExcuses, { decision });
}
export const changesBasedOn = async (
	db: ReadDb,
	project: number,
	base: string,
	repo: string | null,
): Promise<number[]> => (await db.all(Q.changesBasedOn, { project, base, repo })).map((row) => row.id);
