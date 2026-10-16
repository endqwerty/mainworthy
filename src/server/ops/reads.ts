// The read operations. Each is bounded, carries hashes and a cursor, and returns only what was asked for, because
// the same reads serve the web UI and an agent whose every token is counted (decision 0006).
import type { z } from "zod";
import { diffBodies, summariseDiff } from "../../core/diff.ts";
import { QuarantineExit } from "../../core/flaky.ts";
import { contentHash } from "../../core/hash.ts";
import { printCase } from "../../core/markdown.ts";
import type { CaseBody, MethodKind } from "../../core/model.ts";
import {
	CheckInput,
	type CommandFate,
	CommandInput,
	FindInput,
	GateInput,
	type GateStatus,
	GetInput,
	HistoryInput,
	ImpactInput,
	InboxInput,
	type InboxReply,
	type Problem,
	SinceInput,
	TimelineInput,
} from "../../core/ops.ts";
import { REPLIES } from "../../core/replies.ts";
import { emptyTally, isResultStanding, RESULT_STANDINGS } from "../../core/runs.ts";
import { openFailureQuestion, toItem, toItemFor } from "../decisions/decisions.ts";
import {
	decisionById,
	ledgerPage,
	mustQuestion,
	openCountOn,
	openCounts,
	openQuestionsOn,
	type QuestionRow,
	questionById,
	questionRef,
	questionsChangedSince,
	questionsOn,
	queuePage,
	refsOf,
} from "../decisions/questions.ts";
import {
	batchById,
	caseIdsOfFile,
	changeById,
	changeByKey,
	findTest,
	flipCount,
	lastResultsOfCase,
	lastResultsOfTest,
	listTests,
	mustTarget,
	proofOf,
	type ResultRow,
	recentChanges,
	resultById,
	signatureById,
	testById,
	testRef,
	testsOfCase,
	unlinkedCount,
} from "../evidence/evidence.ts";
import { findingsOfCase, reviewBasis, reviewsAtVersion, reviewsOfCase } from "../evidence/findings.ts";
import { sameCodeEvidence } from "../evidence/flaky.ts";
import { effectiveQuarantine, quarantineEntries, quarantineEntry } from "../evidence/quarantine.ts";
import { deployments } from "../evidence/releases.ts";
import { actorLabel } from "../identity/identity.ts";
import { type Ctx, findCommand, UNFINISHED } from "../kernel/ctx.ts";
import { json } from "../kernel/db.ts";
import { conflict, invalid, notFound } from "../kernel/errors.ts";
import { currentPolicy, policyName } from "../policy/policy.ts";
import {
	type CountedTest,
	countedTests,
	failingTestsOf,
	fillsOf,
	flippedIn,
	gate,
	gateOf,
	gateRun,
	mustRun,
	type RunRow,
	recentRuns,
	runById,
	runRef,
	type SlotRow,
	slotCount,
	slotsPage,
} from "../runs/runs.ts";
import {
	archivedCases,
	casesChangedSince,
	casesCovering,
	folderTree,
	listCases,
	placementsOf,
	requirementList,
	structuralProblems,
	tagCounts,
	versionAt,
	versionList,
} from "../suite/read.ts";
import {
	adoption,
	adoptionPolicy,
	bodyOf,
	type CaseRow,
	caseById,
	caseRef,
	coversOf,
	expandSteps,
	findCase,
	folderIndex,
	fragmentUsers,
	mustCase,
	type ProposalRow,
	proposalByNo,
	resolvedOf,
	versionOf,
} from "../suite/suite.ts";
import { withTrackerPollError } from "../trackers/polls.ts";
import { defineOp } from "./registry.ts";

const who = (ctx: Ctx, id: number) => actorLabel(ctx.db, id);

// ── inbox ──────────────────────────────────────────────────────────────────────────────────────────────────

export function inbox(ctx: Ctx, input: InboxInput): InboxReply {
	const limit = input.limit ?? 50;
	const counts = openCounts(ctx.db, ctx.project.id);
	let rows: QuestionRow[];
	if (input.on) {
		rows = questionsOn(
			ctx.db,
			ctx.project.id,
			input.on.toUpperCase().startsWith("PR:") ? input.on.toLowerCase() : input.on,
		)
			.filter((row) => row.state === input.state && (!input.kind || row.kind === input.kind))
			.slice(0, limit);
		return { counts, items: rows.map((row) => withTrackerPollError(ctx.db, toItemFor(ctx, row))), cursor: null };
	}
	if (input.state === "decided") {
		// The ledger's cursor is the revision and the id of the last row: many questions are decided at one revision.
		const at = /^(\d+)\.(\d+)$/.exec(input.cursor ?? "");
		if (input.cursor && !at) throw invalid("that is not a cursor of the ledger");
		const before = at ? { rev: Number(at[1]), id: Number(at[2]) } : null;
		rows = ledgerPage(ctx.db, { project: ctx.project.id, kind: input.kind, before, limit: limit + 1 });
	} else {
		const after = input.cursor ? Number(input.cursor) : Number.MIN_SAFE_INTEGER;
		if (Number.isNaN(after)) throw invalid("that is not a cursor of the queue");
		rows = queuePage(ctx.db, { project: ctx.project.id, state: "open", kind: input.kind, after, limit: limit + 1 });
	}
	const page = rows.slice(0, limit);
	const last = page.at(-1);
	const cursor =
		rows.length > limit && last ? (input.state === "open" ? String(last.rank) : `${last.rev}.${last.id}`) : null;
	return { counts, items: page.map((row) => withTrackerPollError(ctx.db, toItemFor(ctx, row))), cursor };
}

export const inboxOp = defineOp({
	name: "inbox",
	output: REPLIES.inbox,
	summary: "The queue: every question that needs an answer, most blocking first. With state=decided: the ledger.",
	input: InboxInput,
	needs: "read",
	scope: "project",
	effect: "read",
	mcp: "Open questions and evidenceHash; filter with on.",
	run: inbox,
});

// ── get ────────────────────────────────────────────────────────────────────────────────────────────────────

const CASE_FIELDS = ["title", "pre", "steps", "methods", "tags", "covers", "place", "proof", "tests"] as const;

export function caseView(
	ctx: Ctx,
	row: CaseRow,
	options: { fields?: readonly string[] | undefined; version?: number | undefined } = {},
): Record<string, unknown> {
	const want = new Set(options.fields ?? CASE_FIELDS);
	const version = options.version ?? row.head;
	const stored = versionOf(ctx.db, row.id, version);
	if (!stored) throw notFound(`${caseRef(row)} version ${version}`);
	const body = json<CaseBody>(stored.body);
	const out: Record<string, unknown> = {
		ref: caseRef(row),
		version,
		head: row.head,
		hash: stored.hash,
		claim: stored.claim_hash,
		state: row.state,
		kind: row.kind,
	};
	if (want.has("title")) out.title = body.title;
	if (want.has("pre")) out.pre = body.pre;
	if (want.has("steps")) {
		out.steps = expandSteps(ctx.db, ctx.project.id, body);
		const hasFragments = body.steps.some((step) => Boolean(step.use));
		if (hasFragments) out.sourceSteps = body.steps;
		out.hasFragments = hasFragments;
	}
	if (want.has("fields")) out.fields = body.fields;
	if (want.has("users") && row.kind === "fragment") out.users = fragmentUsers(ctx.db, ctx.project.id, caseRef(row));
	if (want.has("methods")) {
		out.methods = body.methods;
		out.automate = body.automate;
	}
	if (want.has("tags")) out.tags = json<string[]>(row.tags);
	if (want.has("covers")) out.covers = coversOf(ctx.db, row.id);
	if (want.has("place")) {
		out.folder = { id: row.folder, path: folderIndex(ctx.db, row.project).path(row.folder) };
		out.updated = { at: row.updated_at, by: who(ctx, row.updated_by).name, kind: who(ctx, row.updated_by).kind };
	}
	if (want.has("proof")) {
		out.proof = proofOf(ctx.db, row);
		out.open = openCountOn(ctx.db, row.project, caseRef(row));
	}
	if (want.has("tests"))
		out.tests = testsOfCase(ctx.db, row.project, row.id)
			.filter((test) => test.kind === "auto")
			.map((test) => ({ t: testRef(test), name: test.name, file: test.file }));
	return out;
}

export function runView(ctx: Ctx, run: RunRow): Record<string, unknown> {
	const status = gateOf(ctx, run);
	const change = run.change !== null ? changeById(ctx.db, run.change) : null;
	return {
		ref: runRef(run),
		name: run.name,
		origin: run.origin,
		state: run.state,
		verdict: status.verdict,
		reason: status.reason,
		stale: status.stale,
		tally: status.tally,
		...(status.quarantined ? { quarantined: status.quarantined } : {}),
		open: status.open,
		accepts: json(run.accepts),
		require: json(run.require),
		slots: run.origin === "planned" ? slotCount(ctx.db, run.id) : null,
		flips: run.origin === "change" ? flippedIn(ctx.db, run.id) : null,
		failing:
			run.origin === "change"
				? failingTestsOf(ctx.db, run.id, 50).map((row) => {
						const test = testById(ctx.db, row.test);
						const linked = test?.case_id != null ? caseById(ctx.db, test.case_id) : null;
						return {
							test: test ? testRef(test) : null,
							name: test?.name ?? null,
							file: test?.file ?? null,
							case: linked ? caseRef(linked) : null,
							quarantine: test ? quarantineView(ctx, test.id) : null,
							cause: row.signature !== null ? (signatureById(ctx.db, row.signature)?.text ?? null) : null,
							flipped: row.flipped === 1,
						};
					})
				: null,
		change: change
			? {
					key: change.key,
					title: change.title,
					url: change.url,
					branch: change.branch,
					head: change.head_sha,
					base: change.base_sha,
				}
			: null,
		createdAt: run.created_at,
		createdBy: who(ctx, run.created_by).name,
	};
}

/**
 * A proposal as a reviewer needs it: per edit, the case by ref, the body proposed, the body it would replace, and
 * for a conflict both sides of each field, so the diff can be drawn without another read. While the proposal waits,
 * an edit's body is what accepting writes now, and `refused` says why accepting is refused, if it is.
 */
function proposalView(ctx: Ctx, proposal: ProposalRow): Record<string, unknown> {
	const index = folderIndex(ctx.db, proposal.project);
	const refOf = (id: number): string | null => {
		const row = caseById(ctx.db, id);
		return row ? caseRef(row) : null;
	};
	const waiting = openQuestionsOn(ctx.db, proposal.project, `P-${proposal.no}`).some(
		(question) => question.kind === "adopt",
	);
	const resolved = resolvedOf(proposal);
	const policy = waiting ? adoptionPolicy(ctx.db, proposal.project, resolved) : null;
	const edits = resolved.slice(0, 200).map((edit) => {
		switch (edit.op) {
			case "create":
				return {
					op: edit.op,
					body: edit.body,
					folder: "id" in edit.folder ? index.path(edit.folder.id) : edit.folder.path,
					tags: edit.tags,
					covers: edit.covers,
				};
			case "edit": {
				const row = caseById(ctx.db, edit.caseId);
				// While it waits, what accepting does now: once the case has moved on, that is not what was proposed.
				const now = row && policy ? adoption(ctx.db, row, edit, policy) : null;
				return {
					op: edit.op,
					case: refOf(edit.caseId),
					base: edit.base,
					head: row?.head ?? edit.head,
					body: now?.body ?? edit.body,
					mine: edit.mine,
					current: row ? bodyOf(ctx.db, row.id, row.head) : null,
					conflicts: edit.conflicts,
					refused: now?.refused?.message ?? null,
				};
			}
			case "restore":
				return { op: edit.op, case: refOf(edit.caseId), to: edit.to, body: edit.body };
			case "place":
				return {
					op: edit.op,
					cases: edit.caseIds.map(refOf),
					folder: edit.folder ? ("id" in edit.folder ? index.path(edit.folder.id) : edit.folder.path) : null,
					tags: edit.tags,
				};
			case "state":
				return { op: edit.op, cases: edit.caseIds.map(refOf), to: edit.to };
			case "cover":
				return { op: edit.op, case: refOf(edit.caseId), requirement: edit.key, on: edit.on };
			case "folder":
				return { op: edit.op, name: edit.name, archive: edit.archive };
			case "policy":
				return { op: edit.op, preset: edit.policy.preset, clauses: edit.policy.clauses.length };
			case "quarantine":
				return edit;
			default: {
				const _exhaustive: never = edit;
				return _exhaustive;
			}
		}
	});
	const label = who(ctx, proposal.author);
	return {
		ref: `P-${proposal.no}`,
		author: label.name,
		kind: label.kind,
		reason: proposal.reason,
		at: proposal.at,
		edits,
	};
}

function resultView(ctx: Ctx, row: ResultRow): Record<string, unknown> {
	const test = testById(ctx.db, row.test);
	const target = mustTarget(ctx.db, row.target);
	const batch = batchById(ctx.db, row.batch);
	return {
		id: row.id,
		test: test ? testRef(test) : null,
		name: test?.name ?? null,
		outcome: row.outcome,
		method: row.method,
		by: who(ctx, row.actor).name,
		at: row.at,
		basis: row.basis,
		version: row.basis_version,
		attempt: row.attempt,
		durationMs: row.duration_ms,
		message: row.message,
		note: row.note,
		atStep: row.at_step,
		signature: row.signature !== null ? (signatureById(ctx.db, row.signature)?.text ?? null) : null,
		corrects: row.corrects,
		commit: target.commit_sha,
		change: target.change !== null ? (changeById(ctx.db, target.change)?.key ?? null) : null,
		job: batch?.job ?? "",
		build: batch?.build_url ?? null,
	};
}

function quarantineView(ctx: Ctx, test: number) {
	const entry = quarantineEntry(ctx.db, ctx.project.id, test);
	return entry
		? {
				decision: entry.decision,
				reason: entry.reason,
				by: who(ctx, entry.actor).name,
				since: entry.at,
				exit: entry.exit_rule === null ? null : QuarantineExit.parse(json<unknown>(entry.exit_rule)),
				active: effectiveQuarantine(ctx.db, entry, ctx.now),
			}
		: null;
}
export function get(ctx: Ctx, input: GetInput): Record<string, unknown>[] {
	return input.refs.map((text) => {
		const kind = text.trim().slice(0, 2).toUpperCase();
		if (kind === "Q-")
			return withTrackerPollError(
				ctx.db,
				toItem(ctx.db, mustQuestion(ctx.db, ctx.project.id, text)),
			) as unknown as Record<string, unknown>;
		if (kind === "R-") return runView(ctx, mustRun(ctx.db, ctx.project.id, text));
		if (kind === "T-") {
			const test = findTest(ctx.db, ctx.project.id, text);
			if (!test) throw notFound(`test ${text}`);
			const linked = test.case_id !== null ? caseById(ctx.db, test.case_id) : null;
			return {
				ref: testRef(test),
				kind: test.kind,
				key: test.key,
				name: test.name,
				file: test.file,
				case: linked ? caseRef(linked) : null,
				flips: flipCount(ctx.db, test.project, test.id),
				quarantine: quarantineView(ctx, test.id),
				sameCode: sameCodeEvidence(ctx.db, {
					project: test.project,
					test: test.id,
					now: ctx.now,
					settings: currentPolicy(ctx.db, test.project).settings.flakyDetection,
				}),
				last: lastResultsOfTest(ctx.db, test.project, test.id, 20).map((row) => resultView(ctx, row)),
			};
		}
		if (kind === "P-") {
			const proposal = proposalByNo(ctx.db, ctx.project.id, Number(text.trim().slice(2)));
			if (!proposal) throw notFound(`proposal ${text}`);
			return proposalView(ctx, proposal);
		}
		const row = mustCase(ctx.db, ctx.project.id, text);
		const version = input.refs.length === 1 ? input.version : undefined;
		if (version === undefined && input.unless?.[caseRef(row)] === row.head_hash)
			return { ref: caseRef(row), unchanged: true, hash: row.head_hash };
		if (input.as === "md") {
			const stored = versionOf(ctx.db, row.id, version ?? row.head);
			if (!stored) throw notFound(`${caseRef(row)} version ${version}`);
			const md = printCase({
				ref: caseRef(row),
				kind: row.kind,
				body: json<CaseBody>(stored.body),
				tags: json<string[]>(row.tags),
				covers: coversOf(ctx.db, row.id),
			});
			return { ref: caseRef(row), version: stored.no, hash: stored.hash, md };
		}
		return caseView(ctx, row, { fields: input.fields, version });
	});
}

export const getOp = defineOp({
	name: "get",
	output: REPLIES.get,
	summary: "Read cases, questions, runs, tests or proposals by ref.",
	input: GetInput,
	needs: "read",
	scope: "project",
	effect: "read",
	mcp: "Read refs. For cases: as, fields, unless.",
	run: get,
});

// ── find ───────────────────────────────────────────────────────────────────────────────────────────────────

type Found = {
	count: number | null;
	items: Record<string, unknown>[];
	cursor: string | null;
	tally?: Record<string, number>;
};

/**
 * The tests a commit's gate counted, each as it counts it: one row per test and lane, so the rows add up to the
 * gate's tally. Ordered problems first, then by when the result arrived. A retry, a decision or a link moves a row
 * in that order or in and out of a filter, so the cursor also carries a hash of the list it was taken from: a page
 * asked for after that list changed is refused, and the list is read again from the start, instead of skipping or
 * repeating the row that moved.
 */
function countedResults(ctx: Ctx, input: FindInput, limit: number): Found {
	if (!input.commit && !input.change && !input.run) throw invalid("results need a commit, a change or a run");
	const wanted = input.state;
	if (wanted !== undefined && !isResultStanding(wanted))
		throw invalid(`"${wanted}" is not how a gate counts a result: use one of ${RESULT_STANDINGS.join(", ")}`);
	const run = gateRun(ctx, input);
	if (run?.origin === "planned")
		throw invalid(
			`${runRef(run)} is a planned run: its results are in its slots (find --in slots --run ${runRef(run)})`,
		);
	const counted = run ? countedTests(ctx.db, run) : [];
	const tally: Record<string, number> = { ...emptyTally() };
	for (const row of counted) tally[row.standing] = (tally[row.standing] ?? 0) + 1;

	const rank = (row: CountedTest): number => RESULT_STANDINGS.indexOf(row.standing);
	const text = input.text?.toLowerCase();
	const matching = counted
		.filter((row) => {
			if (wanted !== undefined && row.standing !== wanted) return false;
			if (!text && !input.unlinked) return true;
			const test = testById(ctx.db, row.test);
			if (!test) return false;
			if (input.unlinked && caseOfCount(ctx, row, test) !== null) return false;
			return !text || `${test.name} ${test.key} ${test.file ?? ""}`.toLowerCase().includes(text);
		})
		.sort((a, b) => rank(a) - rank(b) || a.result - b.result);
	// The list this query gives, and the query: a row that joins or leaves it, moves in it or changes how it counts
	// makes a different version, and so does the same cursor sent with another filter.
	const version = contentHash({
		query: { state: wanted ?? null, unlinked: input.unlinked ?? false, text: text ?? null },
		rows: matching.map((row) => [row.result, row.standing]),
	}).slice(0, 12);
	const after = input.cursor ? parseResultCursor(input.cursor) : null;
	if (after && after.version !== version)
		throw conflict("the results changed since this cursor was given: read them again from the first page");
	const rest = after
		? matching.filter((row) => rank(row) > after.rank || (rank(row) === after.rank && row.result > after.result))
		: matching;
	const page = rest.slice(0, limit);
	const last = page.at(-1);
	return {
		count: matching.length,
		items: page.map((row) => countedView(ctx, row)),
		cursor: rest.length > limit && last ? `${rank(last)}.${last.result}.${version}` : null,
		tally,
	};
}

function parseResultCursor(cursor: string): { rank: number; result: number; version: string } {
	const match = /^(\d+)\.(\d+)\.([0-9a-z]+)$/.exec(cursor.trim());
	if (!match) throw invalid(`"${cursor}" is not a cursor of results`);
	return { rank: Number(match[1]), result: Number(match[2]), version: match[3] ?? "" };
}

function countedView(ctx: Ctx, row: CountedTest): Record<string, unknown> {
	const result = resultById(ctx.db, row.result);
	const test = testById(ctx.db, row.test);
	if (!result || !test) throw new Error(`result ${row.result} of a counted test is missing`);
	const linked = caseOfCount(ctx, row, test);
	const view = resultView(ctx, result);
	return {
		result: result.id,
		test: testRef(test),
		name: test.name,
		file: test.file,
		case: linked ? caseRef(linked) : null,
		outcome: result.outcome,
		standing: row.standing,
		quarantined: row.excuse?.quarantined ?? false,
		question: questionOfCount(ctx, row),
		attempt: result.attempt,
		durationMs: result.duration_ms,
		message: result.message,
		job: view.job,
		by: view.by,
		at: result.at,
		commit: view.commit,
		build: view.build,
	};
}

/** The case a counted result is evidence for: the one it claimed, else the one its test is linked to. */
function caseOfCount(ctx: Ctx, row: CountedTest, test: { case_id: number | null }): CaseRow | null {
	const claimed = resultById(ctx.db, row.result)?.basis_case ?? null;
	const id = claimed ?? test.case_id;
	return id !== null ? caseById(ctx.db, id) : null;
}

/** The question a failure's standing comes from: the one that decided it, or the open one it waits for. */
function questionOfCount(ctx: Ctx, row: CountedTest): string | null {
	if (row.excuse) {
		const decision = decisionById(ctx.db, row.excuse.decision);
		const question = decision ? questionById(ctx.db, decision.question) : null;
		return question ? questionRef(question) : null;
	}
	if (row.standing !== "unexplained" || row.signature === null) return null;
	const signature = signatureById(ctx.db, row.signature);
	if (!signature) return null;
	const open = openFailureQuestion(ctx.db, ctx.project.id, {
		signature: signature.hash,
		scope: row.scope,
		target: row.target,
	});
	return open ? questionRef(open) : null;
}

function caseRow(ctx: Ctx, row: CaseRow, rich: boolean): Record<string, unknown> {
	const base: Record<string, unknown> = {
		ref: caseRef(row),
		title: row.title,
		folder: row.folder,
		rank: row.rank,
		tags: json<string[]>(row.tags),
		version: row.head,
		hash: row.head_hash,
		steps: row.step_count,
		methods: json<MethodKind[]>(row.methods),
		state: row.state,
		updatedAt: row.updated_at,
		updatedBy: who(ctx, row.updated_by).kind,
	};
	if (rich) {
		base.proof = proofOf(ctx.db, row);
		base.open = openCountOn(ctx.db, row.project, caseRef(row));
	}
	return base;
}

function slotRow(ctx: Ctx, slot: SlotRow): Record<string, unknown> {
	const row = caseById(ctx.db, slot.case_id);
	const fills = fillsOf(ctx.db, slot.id);
	return {
		id: slot.id,
		case: row ? caseRef(row) : null,
		title: row?.title ?? null,
		version: slot.version,
		head: row?.head ?? null,
		state: slot.state,
		rank: slot.rank,
		assignee: slot.assignee !== null ? who(ctx, slot.assignee).name : null,
		fills: fills.map((fill) => ({
			result: fill.id,
			by: who(ctx, fill.actor).name,
			method: fill.method,
			outcome: fill.outcome,
			admitted: fill.admitted,
			at: fill.at,
			note: fill.note ?? fill.message,
			atStep: fill.atStep,
		})),
	};
}

export function find(ctx: Ctx, input: FindInput): Found {
	const limit = input.limit ?? 100;
	const project = ctx.project.id;
	switch (input.in) {
		case "results":
			return countedResults(ctx, input, limit);
		case "deployments": {
			const rows = deployments(ctx.db, {
				project,
				before: input.cursor ? Number(input.cursor) : Number.MAX_SAFE_INTEGER,
				limit: limit + 1,
			});
			const page = rows.slice(0, limit);
			return {
				count: null,
				items: page.map((row) => ({
					...row,
					code: json<unknown>(row.code),
					by: actorLabel(ctx.db, row.actor).name,
					attestation: { by: actorLabel(ctx.db, row.attested_by).name, at: row.attested_at },
				})),
				cursor: rows.length > limit ? String(page.at(-1)?.id ?? "") : null,
			};
		}
		case "cases": {
			const page = listCases(ctx, {
				folder: input.folder,
				deep: input.deep,
				tags: input.tags,
				state: input.state,
				text: input.text,
				limit,
				cursor: input.cursor,
			});
			return { count: page.count, items: page.items.map((row) => caseRow(ctx, row, true)), cursor: page.cursor };
		}
		case "folders": {
			const tree = folderTree(ctx.db, project);
			return { count: tree.total, items: tree.folders, cursor: null };
		}
		// Kept apart from the folder tree, which every screen loads: counting tags reads every tag row.
		case "tags":
			return { count: null, items: tagCounts(ctx.db, project), cursor: null };
		case "requirements":
			return { count: null, items: requirementList(ctx.db, project), cursor: null };
		case "runs": {
			const origin = input.state === "change" ? "change" : "planned";
			const before = input.cursor ? Number(input.cursor) : Number.MAX_SAFE_INTEGER;
			const rows = recentRuns(ctx.db, project, origin, before, limit + 1);
			const page = rows.slice(0, limit);
			return {
				count: null,
				items: page.map((run) => runView(ctx, run)),
				cursor: rows.length > limit ? String(page.at(-1)?.id ?? "") : null,
			};
		}
		case "slots": {
			if (!input.run) throw invalid("find slots needs a run");
			const run = mustRun(ctx.db, project, input.run);
			const after = input.cursor ? Number(input.cursor) : -1;
			const rows = slotsPage(ctx.db, run.id, after, limit + 1);
			const page = rows.slice(0, limit);
			return {
				count: slotCount(ctx.db, run.id),
				items: page.map((slot) => slotRow(ctx, slot)),
				cursor: rows.length > limit ? String(page.at(-1)?.rank ?? "") : null,
			};
		}
		case "tests": {
			if (input.state === "quarantined") {
				const active = quarantineEntries(ctx.db, project)
					.filter((entry) => effectiveQuarantine(ctx.db, entry, ctx.now))
					.flatMap((entry) => {
						const test = testById(ctx.db, entry.test);
						return test ? [test] : [];
					})
					.filter(
						(test) =>
							(!input.text || `${test.key} ${test.name}`.toLowerCase().includes(input.text.toLowerCase())) &&
							(!input.unlinked || test.case_id === null),
					);
				const after = active.filter((test) => !input.cursor || test.id < Number(input.cursor));
				const page = after.slice(0, limit);
				return {
					count: active.length,
					items: page.map((test) => {
						const linked = test.case_id === null ? null : caseById(ctx.db, test.case_id);
						return {
							ref: testRef(test),
							kind: test.kind,
							name: test.name,
							file: test.file,
							key: test.key,
							case: linked ? caseRef(linked) : null,
							quarantine: quarantineView(ctx, test.id),
						};
					}),
					cursor: after.length > limit ? String(page.at(-1)?.id) : null,
				};
			}
			const rows = listTests(ctx.db, {
				project,
				unlinked: input.unlinked ?? false,
				text: input.text,
				before: input.cursor ? Number(input.cursor) : null,
				limit: limit + 1,
			});
			const page = rows.slice(0, limit);
			return {
				count: input.unlinked ? unlinkedCount(ctx.db, project) : null,
				items: page.map((test) => {
					const linked = test.case_id !== null ? caseById(ctx.db, test.case_id) : null;
					return {
						ref: testRef(test),
						kind: test.kind,
						name: test.name,
						file: test.file,
						key: test.key,
						case: linked ? caseRef(linked) : null,
						quarantine: quarantineView(ctx, test.id),
					};
				}),
				cursor: rows.length > limit ? String(page.at(-1)?.id ?? "") : null,
			};
		}
		case "changes": {
			const items = recentChanges(ctx.db, project, limit).map((change) => {
				const status = change.head_sha ? gate(ctx, { commit: change.head_sha }) : null;
				return {
					key: change.key,
					title: change.title,
					branch: change.branch,
					head: change.head_sha,
					url: change.url,
					state: change.ended ?? "open",
					run: status?.run ?? null,
					verdict: status?.verdict ?? null,
					reason: status?.reason ?? null,
				};
			});
			return { count: null, items, cursor: null };
		}
		default: {
			const _exhaustive: never = input.in;
			throw invalid(`cannot search ${_exhaustive}`);
		}
	}
}

export const findOp = defineOp({
	name: "find",
	output: REPLIES.find,
	summary:
		"Search and list: cases (by text, folder, tag), tests, runs, slots of a run, folders, requirements, changes.",
	input: FindInput,
	needs: "read",
	scope: "project",
	effect: "read",
	mcp: "Search cases by text, folder or tag; list tests (`unlinked: true`), runs or slots. Page with `cursor`.",
	run: find,
});

// ── history and timeline ───────────────────────────────────────────────────────────────────────────────────

export function history(ctx: Ctx, input: HistoryInput): Record<string, unknown> {
	const row = mustCase(ctx.db, ctx.project.id, input.ref);
	if (input.from !== undefined || input.to !== undefined) {
		const to = input.to ?? row.head;
		const from = input.from ?? Math.max(1, to - 1);
		const diff = diffBodies(bodyOf(ctx.db, row.id, from), bodyOf(ctx.db, row.id, to));
		return { ref: caseRef(row), from, to, summary: summariseDiff(diff), diff };
	}
	return {
		ref: caseRef(row),
		head: row.head,
		versions: versionList(ctx.db, row.id).map((v) => ({
			version: v.version,
			hash: v.hash,
			by: who(ctx, v.author).name,
			kind: who(ctx, v.author).kind,
			reason: v.reason,
			at: v.at,
			summary: v.summary,
		})),
	};
}

export const historyOp = defineOp({
	name: "history",
	output: REPLIES.history,
	summary: "The versions of a case, or the step-level diff between two of them.",
	input: HistoryInput,
	needs: "read",
	scope: "project",
	effect: "read",
	mcp: null,
	run: history,
});

/** Everything that happened to a case, newest first: versions, moves, results from every producer, findings, questions. */
export function timeline(ctx: Ctx, input: z.infer<typeof TimelineInput>): Record<string, unknown> {
	const row = mustCase(ctx.db, ctx.project.id, input.ref);
	const limit = input.limit ?? 100;
	type Entry = { t: string; seq: number; at: number } & Record<string, unknown>;
	const entries: Entry[] = [];
	for (const v of versionList(ctx.db, row.id)) {
		entries.push({
			t: "version",
			seq: v.seq,
			at: v.at,
			version: v.version,
			hash: v.hash,
			by: who(ctx, v.author).name,
			kind: who(ctx, v.author).kind,
			reason: v.reason,
			summary: v.summary,
			reviews: reviewsAtVersion(ctx.db, row.id, v.version).length,
		});
	}
	for (const p of placementsOf(ctx.db, row.id, limit)) {
		const before = json<{ folder: number; tags: string[]; state: string }>(p.before);
		const after = json<{ folder: number; tags: string[]; state: string }>(p.after);
		const index = folderIndex(ctx.db, row.project);
		const what = [
			before.folder !== after.folder ? `moved to ${index.path(after.folder)}` : null,
			before.state !== after.state ? after.state : null,
			before.tags.join(" ") !== after.tags.join(" ") ? `tags: ${after.tags.join(", ") || "none"}` : null,
		].filter(Boolean);
		entries.push({
			t: "placement",
			seq: p.seq,
			at: p.at,
			by: who(ctx, p.actor).name,
			kind: who(ctx, p.actor).kind,
			what: what.join("; ") || "reordered",
		});
	}
	for (const r of lastResultsOfCase(ctx.db, row.id, limit))
		entries.push({ ...resultView(ctx, r), t: "result", seq: r.seq, at: r.at, ord: r.ord });
	for (const f of findingsOfCase(ctx.db, row.id, limit)) {
		entries.push({
			t: "finding",
			seq: f.seq,
			at: f.at,
			by: who(ctx, f.actor).name,
			kind: who(ctx, f.actor).kind,
			on: f.locus,
			category: f.category,
			note: f.note,
			lens: f.lens,
		});
	}
	for (const r of reviewsOfCase(ctx.db, row.id, limit)) {
		entries.push({
			t: "review",
			seq: r.seq,
			at: r.at,
			by: who(ctx, r.reviewer).name,
			kind: who(ctx, r.reviewer).kind,
			lens: r.lens,
			version: r.version,
			about: r.about,
		});
	}
	const questions = questionsOn(ctx.db, row.project, caseRef(row)).map((q) =>
		withTrackerPollError(ctx.db, toItem(ctx.db, q)),
	);
	entries.sort((a, b) => b.seq - a.seq || Number(b.ord ?? 0) - Number(a.ord ?? 0));
	return { ref: caseRef(row), head: row.head, entries: entries.slice(0, limit), questions };
}

export const timelineOp = defineOp({
	name: "timeline",
	output: REPLIES.timeline,
	summary:
		"One timeline for a case: versions, moves, results from every producer, findings, reviews and its questions.",
	input: TimelineInput,
	needs: "read",
	scope: "project",
	effect: "read",
	mcp: null,
	run: timeline,
});

// ── gate ───────────────────────────────────────────────────────────────────────────────────────────────────

export const gateOp = defineOp({
	name: "gate",
	output: REPLIES.gate,
	summary:
		"The verdict for a commit, a change or a run: passed, failed (needs a fix), blocked (needs a decision), pending (needs evidence).",
	input: GateInput,
	// A pipeline reads the verdict it reports for, and nothing else of the project: the verdict, the tally and the
	// refs of the open questions, not a case, a result or a question's text.
	needs: ["read", "record"],
	scope: "project",
	effect: "read",
	mcp: "Is this commit, change or run tested? Returns passed, failed, blocked or pending with the reason and the open questions.",
	run: (ctx: Ctx, input: GateInput): GateStatus => gate(ctx, input),
});

// ── since ──────────────────────────────────────────────────────────────────────────────────────────────────

type Position = { rev: number; id: number };
type Cursor = { base: number; cases: Position; questions: Position };

/**
 * A cursor is `s:<seq>`: everything up to that sequence number has been read. While a reply is paging through more
 * changes than one page holds it is `s:<seq>:<rev>.<id>:<rev>.<id>`: the same base, and how far the pages have
 * got through the changed cases and the changed questions. Many rows can share one revision (a bulk change is one
 * command), so a position is a revision and an id within it, never a revision alone.
 */
function parseCursor(cursor: string): Cursor {
	const match = /^(?:s:)?(\d+)(?::(\d+)\.(\d+):(\d+)\.(\d+))?$/.exec(cursor.trim());
	if (!match) throw invalid(`"${cursor}" is not a cursor`);
	const base = Number(match[1]);
	const start: Position = { rev: base + 1, id: 0 };
	if (match[2] === undefined) return { base, cases: start, questions: start };
	return {
		base,
		cases: { rev: Number(match[2]), id: Number(match[3]) },
		questions: { rev: Number(match[4]), id: Number(match[5]) },
	};
}

const cursorSeq = (cursor: string): number => parseCursor(cursor).base;

export function since(ctx: Ctx, input: SinceInput): Record<string, unknown> {
	const from = parseCursor(input.cursor);
	const limit = input.limit ?? 200;
	/** One page and where the next starts: after the last row returned, or past everything when the page is whole. */
	const page = <T extends { rev: number; id: number }>(rows: T[]): { rows: T[]; next: Position; more: boolean } => {
		const more = rows.length > limit;
		const kept = more ? rows.slice(0, limit) : rows;
		const last = kept.at(-1);
		return { rows: kept, more, next: more && last ? { rev: last.rev, id: last.id + 1 } : { rev: ctx.seq + 1, id: 0 } };
	};
	const cases = page(casesChangedSince(ctx.db, ctx.project.id, from.cases, limit + 1));
	const questions = page(questionsChangedSince(ctx.db, ctx.project.id, from.questions, limit + 1));
	const changed = cases.rows.map((row) => {
		const before = versionAt(ctx.db, row.id, from.base);
		const summary = !before
			? "created"
			: before.no === row.head
				? "moved or retagged"
				: summariseDiff(diffBodies(json<CaseBody>(before.body), bodyOf(ctx.db, row.id, row.head)));
		return {
			ref: caseRef(row),
			version: row.head,
			hash: row.head_hash,
			title: row.title,
			state: row.state,
			changed: summary,
		};
	});
	const settled = questions.rows
		.filter((q) => q.state !== "open")
		.map((q) => {
			const item = toItem(ctx.db, q);
			return {
				q: questionRef(q),
				kind: q.kind,
				title: q.title,
				state: q.state,
				answer: item.decision?.answer ?? null,
				by: item.decision?.by ?? [],
			};
		});
	// The cursor moves past a change only once the change has been returned. `more` says to call again with it.
	const more = cases.more || questions.more;
	const at = (position: Position) => `${position.rev}.${position.id}`;
	return {
		changed,
		settled,
		cursor: more ? `s:${from.base}:${at(cases.next)}:${at(questions.next)}` : `s:${ctx.seq}`,
		more,
	};
}

export const sinceOp = defineOp({
	name: "since",
	output: REPLIES.since,
	summary: "What changed since a cursor: cases with what changed in each, and questions that were settled.",
	input: SinceInput,
	needs: "read",
	scope: "project",
	effect: "read",
	mcp: "What changed since an earlier `cursor`: changed cases (one-line diff, no bodies) and settled questions. If `more`, call again with the new cursor.",
	run: since,
});

// ── check ──────────────────────────────────────────────────────────────────────────────────────────────────

/** A type-checker for the suite: structural problems the data can show, with no model involved. */
export function check(
	ctx: Ctx,
	input: z.infer<typeof CheckInput>,
): { problems: Problem[]; counts: Record<string, number> } {
	const limit = input.limit ?? 200;
	const project = ctx.project.id;
	const problems: Problem[] = [];
	const counts: Record<string, number> = {};
	const add = (rule: string, rows: { ref: string; message: string }[], total: number) => {
		counts[rule] = total;
		for (const row of rows) if (problems.length < limit) problems.push({ rule, ...row });
	};
	for (const problem of structuralProblems(ctx.db, project)) add(problem.rule, problem.rows, problem.total);
	const dangling = archivedCases(ctx.db, project, 200).flatMap((row) =>
		testsOfCase(ctx.db, project, row.id).map((test) => ({
			ref: testRef(test),
			message: `"${test.name}" is linked to ${caseRef(row)}, which is archived`,
		})),
	);
	add("linked-to-archived", dangling, dangling.length);
	counts["unlinked-tests"] = unlinkedCount(ctx.db, project);
	return { problems, counts };
}

export const checkOp = defineOp({
	name: "check",
	output: REPLIES.check,
	summary:
		"Check the suite for structural problems: cases with no steps or no expected result, duplicate titles, dangling links.",
	input: CheckInput,
	needs: "read",
	scope: "project",
	effect: "read",
	mcp: null,
	run: check,
});

// ── impact ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Where to look for a change: the cases it touches, why each is in the set, its last result, whether this caller
 * already reviewed it at this version and change head, and the questions already open or decided. Counts first, bounded.
 */
export function impact(ctx: Ctx, input: ImpactInput): Record<string, unknown> {
	const project = ctx.project.id;
	const change = input.change ? changeByKey(ctx.db, project, input.change) : null;
	if (input.change && !change && !input.files) throw notFound(`change ${input.change}`);
	const files = input.files ?? (change ? json<string[]>(change.files) : []);
	const from = input.since ? cursorSeq(input.since) : null;
	const why = new Map<number, Set<string>>();
	const note = (caseId: number, reason: string) => {
		const set = why.get(caseId) ?? new Set<string>();
		set.add(reason);
		why.set(caseId, set);
	};

	const uncovered: string[] = [];
	for (const file of files.slice(0, 2000)) {
		let hit = false;
		for (const caseId of caseIdsOfFile(ctx.db, project, file)) {
			note(caseId, `test:${file}`);
			hit = true;
		}
		if (!hit && !/\.(md|txt|json|ya?ml|lock)$/i.test(file)) uncovered.push(file);
	}
	for (const key of (change?.title ?? "").match(/[A-Z][A-Z0-9]+-\d+/g) ?? []) {
		for (const row of casesCovering(ctx.db, project, key)) note(row.id, `req:${key}`);
	}
	const run = change?.head_sha ? gate(ctx, { change: change.key }) : null;
	const headRun = run?.run ? mustRun(ctx.db, project, run.run) : null;
	if (headRun) {
		for (const failing of failingTestsOf(ctx.db, headRun.id, 200)) {
			const test = testById(ctx.db, failing.test);
			if (test?.case_id != null) note(test.case_id, "failing");
		}
	}
	// A case an open question about this change names is part of the change's picture, whoever raised it: an
	// agent's failure does not count in the gate, and is still something a reviewer should see.
	if (change) {
		for (const asked of questionsOn(ctx.db, project, change.key)) {
			if (asked.state !== "open") continue;
			for (const about of refsOf(ctx.db, asked.id)) {
				const row = /^C-\d+$/.test(about) ? findCase(ctx.db, project, about) : null;
				if (row) note(row.id, "question");
			}
		}
	}

	const cases: Record<string, unknown>[] = [];
	let unreviewed = 0;
	let failing = 0;
	for (const [caseId, reasons] of why) {
		const row = caseById(ctx.db, caseId);
		if (row?.state !== "active") continue;
		if (from !== null && row.rev <= from && (change?.rev ?? 0) <= from && !reasons.has("failing")) continue;
		const basis = change?.head_sha
			? reviewBasis({ version: row.head_hash, about: change.key, patch: change.head_sha })
			: null;
		const reviewed =
			input.ledger &&
			basis !== null &&
			reviewsAtVersion(ctx.db, row.id, row.head).some(
				(review) => review.reviewer === ctx.actor.id && review.basis === basis,
			);
		if (!reviewed) unreviewed++;
		if (reasons.has("failing")) failing++;
		const last = lastResultsOfCase(ctx.db, row.id, 1)[0];
		const open = questionsOn(ctx.db, project, caseRef(row)).filter((q) => q.state === "open");
		cases.push({
			id: caseRef(row),
			title: row.title,
			hash: row.head_hash,
			why: [...reasons],
			last: last ? `${last.outcome}@v${last.basis_version ?? "?"}` : null,
			...(reviewed ? { reviewed: true } : {}),
			...(open.length > 0 ? { open: open.map((q) => ({ q: questionRef(q), evidence: q.evidence_hash })) } : {}),
		});
	}
	cases.sort((a, b) => Number(Boolean(a.reviewed)) - Number(Boolean(b.reviewed)));
	const decided = change
		? questionsOn(ctx.db, project, change.key)
				.filter((q) => q.state === "decided")
				.slice(0, 20)
				.map((q) => {
					const item = toItem(ctx.db, q);
					return {
						q: item.q,
						kind: item.kind,
						title: item.title,
						answer: item.decision?.answer ?? null,
						by: item.decision?.by ?? [],
					};
				})
		: [];
	return {
		change: change
			? {
					key: change.key,
					head: change.head_sha,
					base: change.base_sha,
					files: files.length,
					title: change.title,
					state: change.ended ?? "open",
				}
			: { files: files.length },
		gate: run ? { verdict: run.verdict, reason: run.reason, run: run.run } : null,
		counts: { cases: cases.length, unreviewed, failing, uncovered: uncovered.length },
		cases: cases.slice(0, 200),
		uncovered: uncovered.slice(0, 50),
		decided,
		policy: policyName(currentPolicy(ctx.db, project)),
		cursor: `s:${ctx.seq}`,
	};
}

export const impactOp = defineOp({
	name: "impact",
	output: REPLIES.impact,
	summary:
		"The cases a change touches and why, with what was already reviewed or decided. Where to look, instead of the whole suite.",
	input: ImpactInput,
	needs: "read",
	scope: "project",
	effect: "read",
	mcp: "Start a review with a change (`pr:482`) or changed `files`. Returns affected cases, hashes, prior reviews, questions and uncovered files. Reuse `cursor` as `since`.",
	run: impact,
});

// ── command ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What became of a command the caller sent. A client whose reply was lost asks this, instead of guessing from
 * what it reads back or sending the request again (issue #71). A command of another caller or another project
 * is `none`: an id tells nobody what somebody else did. An instance command is in no project, so its reply,
 * which can stand for a secret, is never returned here.
 */
export function commandFate(ctx: Ctx, input: CommandInput): CommandFate {
	const row = findCommand(ctx.db, input.cmd);
	if (!row || row.project !== ctx.project.id || row.actor !== ctx.actor.id) return { state: "none" };
	if (row.outcome === UNFINISHED) return { state: "begun", op: row.op };
	return { state: "done", op: row.op, seq: row.seq, reply: json<unknown>(row.outcome) };
}

export const commandOp = defineOp({
	name: "command",
	output: REPLIES.command,
	summary: "What became of a command you sent under an idempotency key: not recorded, begun, or done with its reply.",
	input: CommandInput,
	needs: "read",
	scope: "project",
	effect: "read",
	mcp: null,
	run: commandFate,
});

export { runById };
