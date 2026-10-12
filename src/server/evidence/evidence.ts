// Evidence: what was observed. Owns tests, targets, changes, batches, signatures, results, flips and excuses.
//
// A report is taken in two steps. `accept` stores the normalised results durably under the batch key, so the same
// report twice is a no-op and a crash loses nothing. `apply` turns the staged results into result rows, each with an
// explicit basis. Between the two, every run the report matters to reads `pending` (see runs.ts).
import { contentHash } from "../../core/hash.ts";
import type { MethodKind } from "../../core/model.ts";
import type { Outcome, ReportInput, ResultIn, TargetIn } from "../../core/ops.ts";
import { normaliseFailure, signatureHash } from "../../core/signature.ts";
import type { Ctx } from "../kernel/ctx.ts";
import { type Db, json, placeholders, type SqlValue, sql } from "../kernel/db.ts";
import { invalid } from "../kernel/errors.ts";
import type { Witness } from "../kernel/witness.ts";
import { type CaseRow, caseById, findCase, versionOf } from "../suite/suite.ts";

export type TestRow = {
	id: number;
	project: number;
	no: number;
	kind: "manual" | "auto";
	key: string;
	name: string;
	file: string | null;
	case_id: number | null;
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
	branch: string | null;
	title: string | null;
	url: string | null;
	files: string;
	rev: number;
};
export type BatchRow = {
	id: number;
	project: number;
	key: string;
	target: number;
	job: string;
	attempt: number;
	method: MethodKind;
	actor: number;
	run: number | null;
	build_url: string | null;
	state: "accepted" | "processed";
	counts: string;
	staged: string | null;
	receipt: string | null;
	at: number;
	seq: number;
};
export type SignatureRow = {
	id: number;
	project: number;
	hash: string;
	class: "assertion" | "timeout" | "infra";
	text: string;
	first_seq: number;
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
	steps: string | null;
	note: string | null;
	run: number | null;
	corrects: number | null;
	at: number;
};

const TRUNK_BRANCHES = new Set(["main", "master", "trunk"]);

const Q = {
	target: sql<{ project: number; what: string; env: string }, TargetRow>(
		"SELECT * FROM targets WHERE project = $project AND what = $what AND env = $env",
	),
	targetById: sql<{ id: number }, TargetRow>("SELECT * FROM targets WHERE id = $id"),
	targetsOfCommit: sql<{ project: number; what: string }, TargetRow>(
		"SELECT * FROM targets WHERE project = $project AND what = $what",
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
	change: sql<{ project: number; key: string }, ChangeRow>(
		"SELECT * FROM changes WHERE project = $project AND key = $key",
	),
	changeById: sql<{ id: number }, ChangeRow>("SELECT * FROM changes WHERE id = $id"),
	changes: sql<{ project: number; limit: number }, ChangeRow>(
		"SELECT * FROM changes WHERE project = $project ORDER BY rev DESC LIMIT $limit",
	),
	insertChange: sql<{
		project: number;
		key: string;
		repo: string | null;
		base: string | null;
		head: string | null;
		branch: string | null;
		title: string | null;
		url: string | null;
		files: string;
		rev: number;
	}>(
		`INSERT INTO changes (project, key, repo, base_sha, head_sha, branch, title, url, files, rev)
		 VALUES ($project, $key, $repo, $base, $head, $branch, $title, $url, $files, $rev)`,
	),
	updateChange: sql<{
		id: number;
		base: string | null;
		head: string | null;
		title: string | null;
		url: string | null;
		files: string;
		rev: number;
	}>(
		"UPDATE changes SET base_sha = $base, head_sha = $head, title = $title, url = $url, files = $files, rev = $rev WHERE id = $id",
	),
	batchByKey: sql<{ project: number; key: string }, BatchRow>(
		"SELECT * FROM batches WHERE project = $project AND key = $key",
	),
	batchById: sql<{ id: number }, BatchRow>("SELECT * FROM batches WHERE id = $id"),
	insertBatch: sql<{
		project: number;
		key: string;
		target: number;
		job: string;
		attempt: number;
		method: string;
		actor: number;
		run: number | null;
		url: string | null;
		counts: string;
		staged: string;
		at: number;
		seq: number;
	}>(
		`INSERT INTO batches (project, key, target, job, attempt, method, actor, run, build_url, state, counts, staged, at, seq)
		 VALUES ($project, $key, $target, $job, $attempt, $method, $actor, $run, $url, 'accepted', $counts, $staged, $at, $seq)`,
	),
	markProcessed: sql<{ id: number; counts: string; receipt: string }>(
		"UPDATE batches SET state = 'processed', counts = $counts, staged = NULL, receipt = $receipt WHERE id = $id",
	),
	accepted: sql<readonly [], BatchRow>("SELECT * FROM batches WHERE state = 'accepted' ORDER BY id"),
	processedJobs: sql<{ target: number }, { job: string }>(
		"SELECT DISTINCT job FROM batches WHERE target = $target AND state = 'processed'",
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
	linkTest: sql<{ id: number; caseId: number | null }>("UPDATE tests SET case_id = $caseId WHERE id = $id"),
	unlinkedInFile: sql<{ project: number; file: string }, TestRow>(
		"SELECT * FROM tests WHERE project = $project AND file = $file AND case_id IS NULL AND kind = 'auto' ORDER BY id LIMIT 500",
	),
	unlinkedCount: sql<{ project: number }, { n: number }>(
		"SELECT count(*) AS n FROM tests WHERE project = $project AND case_id IS NULL AND kind = 'auto'",
	),
	signature: sql<{ project: number; hash: string }, SignatureRow>(
		"SELECT * FROM signatures WHERE project = $project AND hash = $hash",
	),
	signatureById: sql<{ id: number }, SignatureRow>("SELECT * FROM signatures WHERE id = $id"),
	insertSignature: sql<{ project: number; hash: string; class: string; text: string; seq: number }>(
		"INSERT INTO signatures (project, hash, class, text, first_seq) VALUES ($project, $hash, $class, $text, $seq)",
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
		steps: string | null;
		note: string | null;
		run: number | null;
		corrects: number | null;
		at: number;
	}>(
		`INSERT INTO results (project, test, seq, ord, batch, target, method, actor, basis, basis_case, basis_version, basis_claim,
		                      outcome, attempt, duration_ms, signature, message, detail, at_step, steps, note, run, corrects, at)
		 VALUES ($project, $test, $seq, $ord, $batch, $target, $method, $actor, $basis, $basisCase, $basisVersion, $basisClaim,
		         $outcome, $attempt, $duration, $signature, $message, $detail, $atStep, $steps, $note, $run, $corrects, $at)`,
	),
	resultById: sql<{ id: number }, ResultRow>("SELECT * FROM results WHERE id = $id"),
	previousOnTarget: sql<{ target: number; test: number }, { id: number; outcome: Outcome }>(
		"SELECT id, outcome FROM results WHERE target = $target AND test = $test ORDER BY attempt DESC, id DESC LIMIT 1",
	),
	insertFlip: sql<{ project: number; test: number; target: number; first: number; second: number; seq: number }>(
		"INSERT INTO flips (project, test, target, first_result, second_result, seq) VALUES ($project, $test, $target, $first, $second, $seq)",
	),
	flipCount: sql<{ project: number; test: number }, { n: number }>(
		"SELECT count(*) AS n FROM flips WHERE project = $project AND test = $test",
	),
	lastOfTest: sql<{ project: number; test: number; limit: number }, ResultRow>(
		"SELECT * FROM results WHERE project = $project AND test = $test ORDER BY seq DESC, ord DESC LIMIT $limit",
	),
	lastOfCase: sql<{ id: number; limit: number }, ResultRow>(
		"SELECT * FROM results WHERE basis_case = $id ORDER BY seq DESC, ord DESC LIMIT $limit",
	),
	latestOfCaseByMethod: sql<
		{ id: number; method: string },
		{ outcome: Outcome; at: number; basis: string; basis_version: number | null }
	>(
		`SELECT outcome, at, basis, basis_version FROM results WHERE basis_case = $id AND method = $method
		 ORDER BY seq DESC, ord DESC LIMIT 1`,
	),
	latestOnTrunk: sql<{ project: number; test: number }, { outcome: Outcome; signature: number | null }>(
		`SELECT r.outcome, r.signature FROM results r JOIN targets t ON t.id = r.target
		 WHERE r.project = $project AND r.test = $test AND t.line = 'trunk' ORDER BY r.seq DESC, r.ord DESC LIMIT 1`,
	),
	latestOnTarget: sql<{ target: number; test: number }, { outcome: Outcome; signature: number | null }>(
		"SELECT outcome, signature FROM results WHERE target = $target AND test = $test ORDER BY attempt DESC, id DESC LIMIT 1",
	),
	ofBatch: sql<{ batch: number; limit: number }, ResultRow>(
		"SELECT * FROM results WHERE batch = $batch ORDER BY ord LIMIT $limit",
	),
	excuse: sql<
		{ project: number; signature: number; scope: string },
		{ decision: number; class: "attributed" | "excused"; expires_at: number | null }
	>(
		"SELECT decision, class, expires_at FROM excuses WHERE project = $project AND signature = $signature AND scope = $scope",
	),
	setExcuse: sql<{
		project: number;
		signature: number;
		scope: string;
		decision: number;
		class: string;
		expires: number | null;
	}>(
		`INSERT INTO excuses (project, signature, scope, decision, class, expires_at)
		 VALUES ($project, $signature, $scope, $decision, $class, $expires)
		 ON CONFLICT (project, signature, scope)
		 DO UPDATE SET decision = excluded.decision, class = excluded.class, expires_at = excluded.expires_at`,
	),
	targetByCommit: sql<{ project: number; commit: string }, TargetRow>(
		"SELECT * FROM targets WHERE project = $project AND commit_sha = $commit ORDER BY id LIMIT 1",
	),
	targetByCommitPrefix: sql<{ project: number; low: string; high: string }, TargetRow>(
		"SELECT * FROM targets WHERE project = $project AND commit_sha >= $low AND commit_sha < $high ORDER BY id LIMIT 2",
	),
	caseIdsOfFile: sql<{ project: number; file: string }, { case_id: number | null }>(
		"SELECT case_id FROM tests WHERE project = $project AND file = $file LIMIT 500",
	),
	dropExcuse: sql<{ project: number; signature: number; scope: string }>(
		"DELETE FROM excuses WHERE project = $project AND signature = $signature AND scope = $scope",
	),
};

// ── Targets and changes ────────────────────────────────────────────────────────────────────────────────────

export const codeWhat = (repo: string | undefined | null, commit: string): string => `code:${repo ?? ""}@${commit}`;

/**
 * Finds or records what was tested. A commit on `main`, `master` or `trunk` with no pull request is the trunk
 * line; anything else with a commit is a change, keyed by its pull request, else its branch, else the commit, so
 * a decision made on one push of a pull request still stands on the next.
 */
export function ensureTarget(ctx: Ctx, input: TargetIn): TargetRow {
	const project = ctx.project.id;
	if ("session" in input) {
		const what = `session:${input.session}`;
		const found = ctx.db.get(Q.target, { project, what, env: "" });
		if (found) return found;
		const { lastId } = ctx.db.run(Q.insertTarget, {
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
		return mustTarget(ctx.db, lastId);
	}
	const what = codeWhat(input.repo, input.commit);
	const env = input.env ?? "";
	const trunk = input.pr === undefined && input.branch !== undefined && TRUNK_BRANCHES.has(input.branch);
	let change: ChangeRow | null = null;
	if (!trunk) {
		const key =
			input.pr !== undefined
				? `pr:${input.pr}`
				: input.branch
					? `branch:${input.branch}`
					: `commit:${input.commit.slice(0, 12)}`;
		change = upsertChange(ctx, key, input);
	}
	const found = ctx.db.get(Q.target, { project, what, env });
	if (found) return found;
	const { lastId } = ctx.db.run(Q.insertTarget, {
		project,
		what,
		env,
		repo: input.repo ?? null,
		commit: input.commit,
		branch: input.branch ?? null,
		line: trunk ? "trunk" : "change",
		change: change?.id ?? null,
		seq: ctx.seq,
	});
	return mustTarget(ctx.db, lastId);
}

function upsertChange(ctx: Ctx, key: string, input: Extract<TargetIn, { commit: string }>): ChangeRow {
	const existing = ctx.db.get(Q.change, { project: ctx.project.id, key });
	if (!existing) {
		const { lastId } = ctx.db.run(Q.insertChange, {
			project: ctx.project.id,
			key,
			repo: input.repo ?? null,
			base: input.base ?? null,
			head: input.commit,
			branch: input.branch ?? null,
			title: input.title ?? null,
			url: input.url ?? null,
			files: JSON.stringify(input.files ?? []),
			rev: ctx.seq,
		});
		ctx.touched.add(key);
		const row = ctx.db.get(Q.changeById, { id: lastId });
		if (!row) throw new Error("change was not stored");
		return row;
	}
	const files = input.files ?? json<string[]>(existing.files);
	const next = {
		id: existing.id,
		base: input.base ?? existing.base_sha,
		head: input.commit,
		title: input.title ?? existing.title,
		url: input.url ?? existing.url,
		files: JSON.stringify(files),
		rev: ctx.seq,
	};
	if (
		next.base !== existing.base_sha ||
		next.head !== existing.head_sha ||
		next.title !== existing.title ||
		next.files !== existing.files
	) {
		ctx.db.run(Q.updateChange, next);
		ctx.touched.add(key);
	}
	return ctx.db.get(Q.changeById, { id: existing.id }) ?? existing;
}

export function mustTarget(db: Db, id: number): TargetRow {
	const row = db.get(Q.targetById, { id });
	if (!row) throw new Error(`target ${id} is missing`);
	return row;
}
export const targetsOfCommit = (db: Db, project: number, what: string): TargetRow[] =>
	db.all(Q.targetsOfCommit, { project, what });
export const changeByKey = (db: Db, project: number, key: string): ChangeRow | null =>
	db.get(Q.change, { project, key });
export const changeById = (db: Db, id: number): ChangeRow | null => db.get(Q.changeById, { id });
export const recentChanges = (db: Db, project: number, limit: number): ChangeRow[] =>
	db.all(Q.changes, { project, limit });

/** Where a failure on this target is answered: per change, on trunk, or within the run it was typed into. */
export function scopeOf(target: TargetRow, run: number | null): string {
	if (target.line === "session") return run !== null ? `run:${run}` : `session:${target.id}`;
	if (target.change !== null) return `change:${target.change}`;
	return `line:${target.line}`;
}

// ── Accept ─────────────────────────────────────────────────────────────────────────────────────────────────

export type Counts = { total: number; pass: number; fail: number; skip: number; error: number; blocked: number };

const countOutcomes = (results: readonly { outcome: Outcome }[]): Counts => {
	const counts: Counts = { total: results.length, pass: 0, fail: 0, skip: 0, error: 0, blocked: 0 };
	for (const result of results) counts[result.outcome]++;
	return counts;
};

/**
 * How a batch of results was produced. A result that names an automated test by key is `auto` whoever sends it: a
 * person who runs `casebook report results.xml` with their own token is reporting a pipeline's work, not claiming
 * they did it by hand. A result that names a case is the actor's own doing: a person's is `human`, an agent's is
 * `agent`. A pipeline cannot claim a person ran something, so its results are always `auto`.
 */
export function methodFor(ctx: Ctx, results: readonly ResultIn[]): MethodKind {
	const manual = results.every((result) => "case" in result.test);
	switch (ctx.actor.kind) {
		case "human":
			return manual ? "human" : "auto";
		case "agent":
			return manual ? "agent" : "auto";
		case "ci":
			return "auto";
		case "rule":
			throw invalid("a rule does not report results");
		default: {
			const _exhaustive: never = ctx.actor.kind;
			return _exhaustive;
		}
	}
}

/**
 * Stores a report durably under its batch key and returns the batch. A second report with the same target, job,
 * attempt, producer and content returns the first batch with `fresh: false` and writes nothing.
 */
export function accept(
	ctx: Ctx,
	input: {
		target: TargetRow;
		run: number | null;
		report: Pick<ReportInput, "job" | "attempt" | "buildUrl" | "results">;
		/**
		 * For results a person or an agent records by hand: the command id, so recording the same outcome again later
		 * is a new fact. A pipeline's report has no nonce: the same files sent twice are the same batch.
		 */
		nonce: string | null;
	},
): { batch: BatchRow; fresh: boolean } {
	const { report } = input;
	const method = methodFor(ctx, report.results);
	const job = report.job ?? "";
	const attempt = report.attempt ?? 1;
	const key = contentHash({
		target: input.target.id,
		run: input.run,
		job,
		attempt,
		method,
		actor: ctx.actor.id,
		nonce: method === "auto" ? null : input.nonce,
		results: report.results,
	});
	const existing = ctx.db.get(Q.batchByKey, { project: ctx.project.id, key });
	if (existing) return { batch: existing, fresh: false };
	const { lastId } = ctx.db.run(Q.insertBatch, {
		project: ctx.project.id,
		key,
		target: input.target.id,
		job,
		attempt,
		method,
		actor: ctx.actor.id,
		run: input.run,
		url: report.buildUrl ?? null,
		counts: JSON.stringify(countOutcomes(report.results)),
		staged: JSON.stringify(report.results),
		at: ctx.now,
		seq: ctx.seq,
	});
	const batch = ctx.db.get(Q.batchById, { id: lastId });
	if (!batch) throw new Error("batch was not stored");
	return { batch, fresh: true };
}

export const batchById = (db: Db, id: number): BatchRow | null => db.get(Q.batchById, { id });
export const acceptedBatches = (db: Db): BatchRow[] => db.all(Q.accepted);
export const processedJobs = (db: Db, target: number): Set<string> =>
	new Set(db.all(Q.processedJobs, { target }).map((r) => r.job));

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
	/** True when an earlier result of this test on the same target had the other outcome. */
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
};

const ANNOTATION = /@(C-\d+)(?:@v(\d+))?/i;
/** Results applied between two pauses. About 15 ms of work: the longest a read can wait behind a large report. */
export const SLICE = 500;

/**
 * Turns a batch's staged results into result rows. `pinned` gives the version a planned run pinned for a case,
 * when the batch was typed into one.
 *
 * The basis of each result is derived here and nowhere else:
 * - exact: a pinned slot, or an annotation that names a version (`@C-311@v7`);
 * - assumed: the case's current version, when the test is linked to a case or annotated with one;
 * - unresolved: no case.
 * A pinned slot and an annotation that disagree reject the result. Nothing is relabelled.
 */
export function* applySteps(
	ctx: Ctx,
	batch: BatchRow,
	pinned: (caseId: number) => number | null,
): Generator<undefined, ApplyResult, void> {
	if (batch.state !== "accepted" || batch.staged === null) throw new Error(`batch ${batch.id} was already applied`);
	const staged = json<ResultIn[]>(batch.staged);
	const project = ctx.project.id;
	const out: ApplyResult = {
		results: [],
		counts: countOutcomes([]),
		basis: { exact: 0, assumed: 0, unresolved: 0 },
		flips: 0,
		rejected: [],
	};
	const heads = new Map<number, CaseRow | null>();
	const head = (id: number): CaseRow | null => {
		if (!heads.has(id)) heads.set(id, caseById(ctx.db, id));
		return heads.get(id) ?? null;
	};
	const claimAt = new Map<string, string | null>();
	const claimOf = (caseId: number, version: number): string | null => {
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
		const resolved = resolveTest(ctx, input);
		if ("reject" in resolved) {
			out.rejected.push({ index, reason: resolved.reject });
			continue;
		}
		const { test, fresh } = resolved;

		// The basis: every claim about the version, then the assumption, then nothing.
		const annotation = input.annotation ?? annotationIn("key" in input.test ? (input.test.name ?? input.test.key) : "");
		const annotated = annotation ? findCase(ctx.db, project, annotation.case) : null;
		if (annotation && !annotated) {
			out.rejected.push({ index, reason: `annotation names ${annotation.case}, which does not exist` });
			continue;
		}
		const subject = annotated?.id ?? test.case_id;
		const pin = subject !== null ? pinned(subject) : null;
		const claims = [pin, annotation?.version ?? null].filter((v): v is number => v !== null);
		if (claims.length === 2 && claims[0] !== claims[1]) {
			out.rejected.push({
				index,
				reason: `basis conflict: the run pinned version ${claims[0]}, the annotation says ${claims[1]}`,
			});
			continue;
		}
		let basis: ResultRow["basis"] = "unresolved";
		let basisVersion: number | null = null;
		if (subject !== null) {
			const row = head(subject);
			if (claims[0] !== undefined) {
				basis = "exact";
				basisVersion = claims[0];
			} else if (row) {
				basis = "assumed";
				basisVersion = row.head;
			}
			if (basisVersion !== null && (basisVersion < 1 || (row && basisVersion > row.head))) {
				out.rejected.push({ index, reason: `the case has no version ${basisVersion}` });
				continue;
			}
		}
		const basisCase = basis === "unresolved" ? null : subject;
		const basisClaim = basisCase !== null && basisVersion !== null ? claimOf(basisCase, basisVersion) : null;

		let signature: SignatureRow | null = null;
		let message: string | null = null;
		if (input.outcome === "fail" || input.outcome === "error") {
			message = input.failure?.message?.trim() || input.note?.trim() || `no failure message (${test.name})`;
			signature = ensureSignature(ctx, { message, ...(input.failure?.detail ? { detail: input.failure.detail } : {}) });
		}

		if (input.corrects !== undefined) {
			const earlier = ctx.db.get(Q.resultById, { id: input.corrects });
			if (!earlier || earlier.project !== project || earlier.actor !== ctx.actor.id || earlier.test !== test.id) {
				out.rejected.push({
					index,
					reason: "a result can only correct an earlier result of the same producer for the same test",
				});
				continue;
			}
		}

		const previous = ctx.db.get(Q.previousOnTarget, { target: batch.target, test: test.id });
		const ord = ctx.ord();
		const { lastId } = ctx.db.run(Q.insertResult, {
			project,
			test: test.id,
			seq: ctx.seq,
			ord,
			batch: batch.id,
			target: batch.target,
			method: batch.method,
			actor: batch.actor,
			basis,
			basisCase,
			basisVersion,
			basisClaim,
			outcome: input.outcome,
			attempt: batch.attempt,
			duration: input.durationMs ?? null,
			signature: signature?.id ?? null,
			message,
			detail: input.failure?.detail ?? null,
			atStep: input.failure?.at ?? input.steps?.find((step) => step.outcome === "fail")?.step ?? null,
			steps: input.steps ? JSON.stringify(input.steps) : null,
			note: input.note ?? null,
			run: batch.run,
			corrects: input.corrects ?? null,
			at: ctx.now,
		});
		const decisive = (o: Outcome) => (o === "pass" ? "pass" : o === "fail" || o === "error" ? "fail" : null);
		const flipped =
			previous !== null &&
			input.corrects === undefined &&
			decisive(previous.outcome) !== null &&
			decisive(input.outcome) !== null &&
			decisive(previous.outcome) !== decisive(input.outcome);
		if (flipped && previous) {
			ctx.db.run(Q.insertFlip, {
				project,
				test: test.id,
				target: batch.target,
				first: previous.id,
				second: lastId,
				seq: ctx.seq,
			});
			out.flips++;
		}
		if (!fresh) ctx.db.run(Q.touchTest, { id: test.id, seq: ctx.seq });
		out.basis[basis]++;
		out.results.push({
			id: lastId,
			ord,
			test,
			outcome: input.outcome,
			method: batch.method,
			attempt: batch.attempt,
			basis,
			basisCase,
			basisVersion,
			basisClaim,
			signature,
			message,
			corrects: input.corrects ?? null,
			flipped,
			fresh,
		});
	}
	out.counts = countOutcomes(out.results);
	return out;
}

/** `applySteps` run to the end without pausing. */
export function apply(ctx: Ctx, batch: BatchRow, pinned: (caseId: number) => number | null): ApplyResult {
	const steps = applySteps(ctx, batch, pinned);
	for (let step = steps.next(); ; step = steps.next()) if (step.done) return step.value;
}

export function markProcessed(ctx: Ctx, batch: BatchRow, counts: Counts, receipt: unknown): void {
	ctx.db.run(Q.markProcessed, { id: batch.id, counts: JSON.stringify(counts), receipt: JSON.stringify(receipt) });
}

function annotationIn(name: string): { case: string; version?: number } | null {
	const match = ANNOTATION.exec(name);
	if (!match?.[1]) return null;
	return match[2] ? { case: match[1].toUpperCase(), version: Number(match[2]) } : { case: match[1].toUpperCase() };
}

function resolveTest(ctx: Ctx, input: ResultIn): { test: TestRow; fresh: boolean } | { reject: string } {
	const project = ctx.project.id;
	if ("case" in input.test) {
		const row = findCase(ctx.db, project, input.test.case);
		if (!row) return { reject: `case ${input.test.case} does not exist` };
		const key = `case:${row.id}`;
		const found = ctx.db.get(Q.testByKey, { project, key });
		if (found) return { test: found, fresh: false };
		return { test: insertTest(ctx, { kind: "manual", key, name: row.title, file: null, caseId: row.id }), fresh: true };
	}
	const key = input.test.key.trim();
	const found = ctx.db.get(Q.testByKey, { project, key });
	if (found) return { test: found, fresh: false };
	const name = input.test.name?.trim() || key.split("::").at(-1) || key;
	const file = input.test.file?.trim() || (key.includes("::") ? (key.split("::")[0] ?? null) : null);
	return { test: insertTest(ctx, { kind: "auto", key, name, file, caseId: null }), fresh: true };
}

function insertTest(
	ctx: Ctx,
	input: { kind: "manual" | "auto"; key: string; name: string; file: string | null; caseId: number | null },
): TestRow {
	const no = ctx.nextNo("test");
	const { lastId } = ctx.db.run(Q.insertTest, { project: ctx.project.id, no, ...input, seq: ctx.seq });
	return {
		id: lastId,
		project: ctx.project.id,
		no,
		...input,
		case_id: input.caseId,
		first_seq: ctx.seq,
		last_seq: ctx.seq,
	};
}

function ensureSignature(ctx: Ctx, failure: { message: string; detail?: string }): SignatureRow {
	const normal = normaliseFailure(failure);
	const hash = signatureHash(normal);
	const found = ctx.db.get(Q.signature, { project: ctx.project.id, hash });
	if (found) return found;
	const { lastId } = ctx.db.run(Q.insertSignature, {
		project: ctx.project.id,
		hash,
		class: normal.class,
		text: normal.text,
		seq: ctx.seq,
	});
	return { id: lastId, project: ctx.project.id, hash, class: normal.class, text: normal.text, first_seq: ctx.seq };
}

// ── Reads ──────────────────────────────────────────────────────────────────────────────────────────────────

export const testRef = (row: { no: number }): string => `T-${row.no}`;
export const testById = (db: Db, id: number): TestRow | null => db.get(Q.testById, { id });
export function findTest(db: Db, project: number, text: string): TestRow | null {
	const match = /^(?:T-)?(\d+)$/i.exec(text.trim());
	return match
		? db.get(Q.testByNo, { project, no: Number(match[1]) })
		: db.get(Q.testByKey, { project, key: text.trim() });
}
export const testsOfCase = (db: Db, project: number, caseId: number): TestRow[] =>
	db.all(Q.testsOfCase, { project, id: caseId });
export const unlinkedInFile = (db: Db, project: number, file: string): TestRow[] =>
	db.all(Q.unlinkedInFile, { project, file });
export const unlinkedCount = (db: Db, project: number): number => db.get(Q.unlinkedCount, { project })?.n ?? 0;
export const signatureById = (db: Db, id: number): SignatureRow | null => db.get(Q.signatureById, { id });
export const resultById = (db: Db, id: number): ResultRow | null => db.get(Q.resultById, { id });
export const lastResultsOfTest = (db: Db, project: number, test: number, limit: number): ResultRow[] =>
	db.all(Q.lastOfTest, { project, test, limit });
export const lastResultsOfCase = (db: Db, caseId: number, limit: number): ResultRow[] =>
	db.all(Q.lastOfCase, { id: caseId, limit });
export const resultsOfBatch = (db: Db, batch: number, limit: number): ResultRow[] =>
	db.all(Q.ofBatch, { batch, limit });
export const flipCount = (db: Db, project: number, test: number): number =>
	db.get(Q.flipCount, { project, test })?.n ?? 0;

/**
 * The target for a commit, by its full hash or an unambiguous prefix of at least seven characters. Null when
 * nothing was reported for it, or when the prefix matches more than one commit.
 */
export function targetByCommit(db: Db, project: number, commit: string): TargetRow | null {
	const exact = db.get(Q.targetByCommit, { project, commit });
	if (exact) return exact;
	if (commit.length < 7 || !/^[0-9a-f]+$/i.test(commit)) return null;
	const rows = db.all(Q.targetByCommitPrefix, { project, low: commit, high: `${commit}\uffff` });
	return rows.length === 1 ? (rows[0] ?? null) : null;
}

/** Every result recorded for a case on any of the given targets, oldest first: what a new run can count at once. */
export function resultsOfCaseOnTargets(db: Db, caseId: number, targets: readonly number[]): ResultRow[] {
	if (targets.length === 0) return [];
	return db.allDynamic<ResultRow>(
		`SELECT * FROM results WHERE basis_case = ? AND target IN (${placeholders(targets.length)}) ORDER BY seq, ord`,
		[caseId, ...targets],
	);
}

/** The cases linked to the tests in a file, for impact: a changed test file touches these cases. */
export const caseIdsOfFile = (db: Db, project: number, file: string): number[] =>
	db.all(Q.caseIdsOfFile, { project, file }).flatMap((row) => (row.case_id === null ? [] : [row.case_id]));

/** A page of tests, newest first, optionally only those with no case or matching a text. */
export function listTests(
	db: Db,
	input: { project: number; unlinked: boolean; text: string | undefined; before: number | null; limit: number },
): TestRow[] {
	const where: string[] = ["project = ?"];
	const params: SqlValue[] = [input.project];
	if (input.unlinked) where.push("case_id IS NULL AND kind = 'auto'");
	if (input.text) {
		where.push("(key LIKE ? OR name LIKE ?)");
		params.push(`%${input.text}%`, `%${input.text}%`);
	}
	if (input.before !== null) {
		where.push("id < ?");
		params.push(input.before);
	}
	return db.allDynamic<TestRow>(`SELECT * FROM tests WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`, [
		...params,
		input.limit,
	]);
}

export type Proof = { outcome: Outcome; at: number; current: boolean; basis: string } | null;

/** The proof strip of a case: per producer, the latest result and whether it was on the current version. */
export function proofOf(db: Db, row: { id: number; head: number }): Record<MethodKind, Proof> {
	const one = (method: MethodKind): Proof => {
		const latest = db.get(Q.latestOfCaseByMethod, { id: row.id, method });
		return latest
			? { outcome: latest.outcome, at: latest.at, current: latest.basis_version === row.head, basis: latest.basis }
			: null;
	};
	return { human: one("human"), auto: one("auto"), agent: one("agent") };
}

/**
 * Does this test already fail, with the same cause, where the change started? The base commit if Casebook has
 * results for it, otherwise the latest result on trunk. A hint for the person or the rule that answers; it never
 * excuses anything by itself.
 */
export function failsOnBase(db: Db, target: TargetRow, test: number, signature: number): boolean {
	if (target.line !== "change" || target.change === null) return false;
	const change = db.get(Q.changeById, { id: target.change });
	if (change?.base_sha) {
		for (const base of db.all(Q.targetsOfCommit, {
			project: target.project,
			what: codeWhat(change.repo, change.base_sha),
		})) {
			const latest = db.get(Q.latestOnTarget, { target: base.id, test });
			if (latest) return latest.signature === signature && latest.outcome !== "pass";
		}
	}
	const trunk = db.get(Q.latestOnTrunk, { project: target.project, test });
	return trunk !== null && trunk.outcome !== "pass" && trunk.signature === signature;
}

// ── Standing ───────────────────────────────────────────────────────────────────────────────────────────────

/** Links a test to a case, or unlinks it with null. Standing: only by a `map` decision. */
export function linkTest(ctx: Ctx, _witness: Witness, test: TestRow, caseId: number | null): void {
	ctx.db.run(Q.linkTest, { id: test.id, caseId });
	ctx.touched.add(testRef(test));
}

/**
 * Puts a test's link back to what it was before a `map` decision. Revert only: called when that decision is
 * withdrawn, which is itself recorded in the ledger. A test fails if anything but the kind handlers calls it.
 */
export function restoreLink(ctx: Ctx, test: TestRow, caseId: number | null): void {
	ctx.db.run(Q.linkTest, { id: test.id, caseId });
	ctx.touched.add(testRef(test));
}

export const excuseFor = (db: Db, project: number, signature: number, scope: string) =>
	db.get(Q.excuse, { project, signature, scope });

/** Records how a cause is answered in a scope. Standing: only by a `failure` decision. */
export function setExcuse(
	ctx: Ctx,
	witness: Witness,
	input: { signature: number; scope: string; class: "attributed" | "excused" },
): void {
	ctx.db.run(Q.setExcuse, {
		project: ctx.project.id,
		signature: input.signature,
		scope: input.scope,
		decision: witness.decision,
		class: input.class,
		expires: witness.expiresAt,
	});
}

/** Removes an excuse when its decision is withdrawn or stops holding. */
export function dropExcuse(ctx: Ctx, signature: number, scope: string): void {
	ctx.db.run(Q.dropExcuse, { project: ctx.project.id, signature, scope });
}
