// The read operations. Each is bounded, carries hashes and a cursor, and returns only what was asked for, because
// the same reads serve the web UI and an agent whose every token is counted (decision 0006).
import type { z } from "zod";
import { diffBodies, summariseDiff } from "../../core/diff.ts";
import { QuarantineExit } from "../../core/flaky.ts";
import { contentHash } from "../../core/hash.ts";
import { printCase } from "../../core/markdown.ts";
import type { CaseBody, FieldDefinitions, MethodKind } from "../../core/model.ts";
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
	holdEndingById,
	ledgerPage,
	mergeReceiptById,
	mergeReceiptPage,
	mustQuestion,
	openCountOn,
	openCounts,
	openQuestionSummariesOnRefs,
	openQuestionsOn,
	parseQueueCursor,
	type QuestionRow,
	questionById,
	questionRef,
	questionsChangedSince,
	questionsOn,
	queueCursorOf,
	queuePage,
	refsOfQuestions,
} from "../decisions/questions.ts";
import {
	batchById,
	type ChangeRow,
	caseIdsOfTests,
	caseLinksOfFiles,
	caseSelectionOfFiles,
	changeById,
	changeByKey,
	findTest,
	flipCount,
	flippedLanes,
	landingOf,
	lastResultsOfCase,
	lastResultsOfCases,
	lastResultsOfTest,
	listTests,
	mustTarget,
	passedOnRetry,
	proofOf,
	type ResultRow,
	recentChanges,
	resultById,
	resultFailedStep,
	resultLocation,
	resultLocations,
	resultTrail,
	signatureById,
	type TargetRow,
	targetByCommit,
	testById,
	testRef,
	testsOfCase,
	testTime,
	triesOf,
	unlinkedCount,
} from "../evidence/evidence.ts";
import { findingsOfCase, reviewBasis, reviewedCaseIds, reviewsAtVersion, reviewsOfCase } from "../evidence/findings.ts";
import { sameCodeEvidence } from "../evidence/flaky.ts";
import { effectiveQuarantine, quarantineEntries, quarantineEntry } from "../evidence/quarantine.ts";
import { deployments } from "../evidence/releases.ts";
import { flipsOf } from "../evidence/stats.ts";
import { actorLabel } from "../identity/identity.ts";
import { type Ctx, findCommand, UNFINISHED } from "../kernel/ctx.ts";
import { json, type ReadDb } from "../kernel/db.ts";
import { conflict, invalid, notFound } from "../kernel/errors.ts";
import { currentPolicy, policyName } from "../policy/policy.ts";
import {
	type CountedTest,
	countedTests,
	failingTestIds,
	failingTestsOf,
	fillsOf,
	flippedIn,
	gate,
	gateOf,
	gateOfCommitIn,
	gateRun,
	leaseOf,
	mustRun,
	type RunRow,
	recentRuns,
	runById,
	runRef,
	type SlotRow,
	slotCount,
	slotsPage,
	workIn,
} from "../runs/runs.ts";
import {
	archivedCases,
	caseIdsOfRefs,
	caseIdsOfRequirements,
	caseLinksOfRequirements,
	casesChangedSince,
	folderTree,
	impactCasePage,
	impactHeads,
	listCases,
	placementsOf,
	requirementList,
	selectCases,
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

const who = async (ctx: Ctx<ReadDb>, id: number) => await actorLabel(ctx.db, id);

// ── inbox ──────────────────────────────────────────────────────────────────────────────────────────────────

export async function inbox(ctx: Ctx<ReadDb>, input: InboxInput): Promise<InboxReply> {
	const limit = input.limit ?? 50;
	const counts = await openCounts(ctx.db, ctx.project.id);
	let rows: QuestionRow[];
	if (input.on) {
		rows = (
			await questionsOn(
				ctx.db,
				ctx.project.id,
				input.on.toUpperCase().startsWith("PR:") ? input.on.toLowerCase() : input.on,
			)
		)
			.filter(
				(row) =>
					(row.state === input.state ||
						(input.state === "decided" &&
							row.state === "dissolved" &&
							row.decision !== null &&
							holdEndingById(ctx.db, row.decision) !== null)) &&
					(!input.kind || row.kind === input.kind),
			)
			.slice(0, limit);
		return { counts, items: rows.map((row) => withTrackerPollError(ctx.db, toItemFor(ctx, row))), cursor: null };
	}
	if (input.state === "decided") {
		// The ledger's cursor is the revision and the id of the last row: many questions are decided at one revision.
		const at = /^(\d+)\.(\d+)$/.exec(input.cursor ?? "");
		if (input.cursor && !at) throw invalid("that is not a cursor of the ledger");
		const before = at ? { rev: Number(at[1]), id: Number(at[2]) } : null;
		rows = await ledgerPage(ctx.db, { project: ctx.project.id, kind: input.kind, before, limit: limit + 1 });
	} else {
		const after = input.cursor ? (parseQueueCursor(input.cursor) ?? null) : null;
		if (input.cursor && !after) throw invalid("that is not a cursor of the queue");
		rows = await queuePage(ctx.db, {
			project: ctx.project.id,
			state: "open",
			kind: input.kind,
			after,
			limit: limit + 1,
		});
	}
	const page = rows.slice(0, limit);
	const last = page.at(-1);
	const cursor =
		rows.length > limit && last ? (input.state === "open" ? queueCursorOf(last) : `${last.rev}.${last.id}`) : null;
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
	mcp: "Open questions with evidenceHash; on filters.",
	run: inbox,
});

// ── get ────────────────────────────────────────────────────────────────────────────────────────────────────

const CASE_FIELDS = [
	"title",
	"pre",
	"steps",
	"methods",
	"tags",
	"covers",
	"place",
	"proof",
	"tests",
	"fields",
] as const;

export async function caseView(
	ctx: Ctx<ReadDb>,
	row: CaseRow,
	options: { fields?: readonly string[] | undefined; version?: number | undefined } = {},
): Promise<Record<string, unknown>> {
	const want = new Set(options.fields ?? CASE_FIELDS);
	const version = options.version ?? row.head;
	const stored = await versionOf(ctx.db, row.id, version);
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
		out.steps = await expandSteps(ctx.db, ctx.project.id, body);
		const hasFragments = body.steps.some((step) => Boolean(step.use));
		if (hasFragments) out.sourceSteps = body.steps;
		out.hasFragments = hasFragments;
	}
	if (want.has("fields")) out.fields = body.fields;
	if (want.has("users") && row.kind === "fragment")
		out.users = await fragmentUsers(ctx.db, ctx.project.id, caseRef(row));
	if (want.has("methods")) {
		out.methods = body.methods;
		out.automate = body.automate;
	}
	if (want.has("tags")) out.tags = json<string[]>(row.tags);
	if (want.has("covers")) out.covers = await coversOf(ctx.db, row.id);
	if (want.has("place")) {
		out.folder = { id: row.folder, path: (await folderIndex(ctx.db, row.project)).path(row.folder) };
		out.updated = {
			at: row.updated_at,
			by: (await who(ctx, row.updated_by)).name,
			kind: (await who(ctx, row.updated_by)).kind,
		};
	}
	if (want.has("proof")) {
		out.proof = await caseProof(ctx, row);
		out.open = await openCountOn(ctx.db, row.project, caseRef(row));
	}
	if (want.has("tests"))
		out.tests = (await testsOfCase(ctx.db, row.project, row.id))
			.filter((test) => test.kind === "auto")
			.map((test) => ({ t: testRef(test), name: test.name, file: test.file }));
	return out;
}

async function runTarget(ctx: Ctx<ReadDb>, run: RunRow): Promise<TargetRow | null> {
	const accepts = json<{ commit?: string; repo?: string }>(run.accepts);
	return accepts.commit ? await targetByCommit(ctx.db, ctx.project.id, accepts.commit, accepts.repo ?? null) : null;
}

export async function runView(
	ctx: Ctx<ReadDb>,
	run: RunRow,
	locationOf = async (target: TargetRow) => await resultLocation(ctx.db, target),
): Promise<Record<string, unknown>> {
	const status = await gateOf(ctx, run);
	const work = await workIn(ctx, run.id);
	const change = run.change !== null ? await changeById(ctx.db, run.change) : null;
	const target = await runTarget(ctx, run);
	const failing = run.origin === "change" ? await failingTestsOf(ctx.db, run.id, 50) : null;
	// A lane stays marked flipped after a correction withdrew its flip (#630); the flips say whether it still stands.
	const flipped = await flippedLanes(
		ctx.db,
		(failing ?? []).filter((row) => row.flipped === 1).map((row) => row.result),
	);
	return {
		ref: runRef(run),
		location: target ? await locationOf(target) : null,
		name: run.name,
		origin: run.origin,
		state: run.state,
		verdict: status.verdict,
		reason: status.reason,
		...(status.waiting ? { waiting: status.waiting } : {}),
		stale: status.stale,
		tally: status.tally,
		...(status.quarantined ? { quarantined: status.quarantined } : {}),
		open: status.open,
		accepts: json(run.accepts),
		require: json(run.require),
		gate: status,
		slots: run.origin === "planned" ? await slotCount(ctx.db, run.id) : null,
		inProgress: work.n,
		workUntil: work.until,
		flips: run.origin === "change" ? await flippedIn(ctx.db, run.id) : null,
		failing:
			failing?.map((row) => {
				const test = testById(ctx.db, row.test);
				const linked = test?.case_id != null ? caseById(ctx.db, test.case_id) : null;
				return {
					test: test ? testRef(test) : null,
					name: test?.name ?? null,
					file: test?.file ?? null,
					case: linked ? caseRef(linked) : null,
					quarantine: test ? quarantineView(ctx, test.id) : null,
					cause: row.signature !== null ? (signatureById(ctx.db, row.signature)?.text ?? null) : null,
					flipped: flipped.has(row.result),
				};
			}) ?? null,
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
		createdBy: (await who(ctx, run.created_by)).name,
	};
}

/**
 * A proposal as a reviewer needs it: per edit, the case by ref, the body proposed, the body it would replace, and
 * for a conflict both sides of each field, so the diff can be drawn without another read. While the proposal waits,
 * an edit's body is the edit applied to its case as it is now, or, when `refused` says why accepting that edit on its
 * own would be refused now, the edit as it was proposed. Accepting the whole proposal applies its edits in order and checks the proposal as a whole,
 * so it can still be refused when no edit is.
 * The reply holds at most 200 edits. `count` says how many the proposal has; `cursor` reads the next page at the same project sequence.
 */
async function proposalView(
	ctx: Ctx<ReadDb>,
	proposal: ProposalRow,
	cursor?: string,
): Promise<Record<string, unknown>> {
	const at = cursor ? /^(\d+)\.(\d+)\.(\d+)$/.exec(cursor) : null;
	if (cursor && (!at || Number(at[1]) !== proposal.no || !Number.isSafeInteger(Number(at[3])) || Number(at[3]) < 1))
		throw invalid("that is not a cursor of this proposal");
	if (at && Number(at[2]) !== ctx.seq)
		throw conflict("The project changed. Read the proposal again from its first page.");
	const offset = at ? Number(at[3]) : 0;
	const index = await folderIndex(ctx.db, proposal.project);
	const refOf = async (id: number): Promise<string | null> => {
		const row = await caseById(ctx.db, id);
		return row ? caseRef(row) : null;
	};
	const waiting = (await openQuestionsOn(ctx.db, proposal.project, `P-${proposal.no}`)).some(
		(question) => question.kind === "adopt",
	);
	const resolved = resolvedOf(proposal);
	const policy = waiting ? await adoptionPolicy(ctx.db, proposal.project, resolved) : null;
	const inForce = await currentPolicy(ctx.db, proposal.project);
	if (offset >= resolved.length && cursor) throw invalid("that cursor is past the proposal's edits");
	const edits = resolved.slice(offset, offset + 200).map((edit) => {
		switch (edit.op) {
			case "create":
				return {
					op: edit.op,
					body: edit.body,
					folder: "id" in edit.folder ? index.path(edit.folder.id) : edit.folder.path,
					tags: edit.tags,
					covers: edit.covers,
					after: edit.after === null ? null : refOf(edit.after),
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
					// An edit that would be refused is shown as it was proposed: it applies to nothing.
					body: now && now.refused === null ? now.body : edit.body,
					mine: edit.mine,
					current: row ? bodyOf(ctx.db, row.id, row.head) : null,
					conflicts: edit.conflicts,
					refused: now?.refused?.message ?? null,
				};
			}
			case "restore": {
				const row = caseById(ctx.db, edit.caseId);
				return {
					op: edit.op,
					case: refOf(edit.caseId),
					to: edit.to,
					body: edit.body,
					current: row ? bodyOf(ctx.db, row.id, row.head) : null,
				};
			}
			case "place":
				// A move or an explicit position ranks the cases again. `after` is the case the edit asks them to follow,
				// or "" for the end of the folder. Where they land then follows ranking (docs/guide/decide.md), which
				// the read does not predict. A change of tags alone leaves the order as it is, and has no `after`.
				return {
					op: edit.op,
					cases: edit.caseIds.map(refOf),
					folder: edit.folder ? ("id" in edit.folder ? index.path(edit.folder.id) : edit.folder.path) : null,
					tags: edit.tags,
					...(edit.folder || edit.after !== undefined
						? { after: typeof edit.after === "number" ? (refOf(edit.after) ?? "") : "" }
						: {}),
				};
			case "state":
				return { op: edit.op, cases: edit.caseIds.map(refOf), to: edit.to };
			case "cover":
				return { op: edit.op, case: refOf(edit.caseId), requirement: edit.key, on: edit.on };
			case "folder":
				return {
					op: edit.op,
					folder: edit.id === null ? null : index.path(edit.id),
					name: edit.name,
					parent:
						edit.parent === undefined
							? undefined
							: edit.parent === null
								? ""
								: "id" in edit.parent
									? index.path(edit.parent.id)
									: edit.parent.path,
					archive: edit.archive,
				};
			case "policy":
				// The whole policy accepting writes, and the one it replaces. Accepting refuses when the policy has
				// changed since the proposal was made (`stale`).
				return {
					op: edit.op,
					preset: edit.policy.preset,
					clauses: edit.policy.clauses.length,
					policy: edit.policy,
					inForce: { preset: inForce.preset, clauses: inForce.clauses, settings: inForce.settings },
					stale: edit.base !== inForce.version,
				};
			case "quarantine":
				return edit;
			default: {
				const _exhaustive: never = edit;
				return _exhaustive;
			}
		}
	});
	const label = await who(ctx, proposal.author);
	return {
		ref: `P-${proposal.no}`,
		author: label.name,
		kind: label.kind,
		reason: proposal.reason,
		at: proposal.at,
		// A cursor binds pages to one project sequence: accepting must not combine different versions.
		count: resolved.length,
		cursor: offset + edits.length < resolved.length ? `${proposal.no}.${ctx.seq}.${offset + edits.length}` : null,
		edits,
	};
}

async function resultView(
	ctx: Ctx<ReadDb>,
	row: ResultRow,
	locationOf = async (target: TargetRow) => await resultLocation(ctx.db, target),
): Promise<Record<string, unknown>> {
	const test = await testById(ctx.db, row.test);
	const target = await mustTarget(ctx.db, row.target);
	const batch = await batchById(ctx.db, row.batch);
	return {
		id: row.id,
		test: test ? testRef(test) : null,
		name: test?.name ?? null,
		outcome: row.outcome,
		method: row.method,
		by: (await who(ctx, row.actor)).name,
		model: row.model,
		at: row.at,
		basis: row.basis,
		version: row.basis_version,
		attempt: row.attempt,
		durationMs: row.duration_ms,
		message: row.message,
		note: row.note,
		atStep: resultFailedStep(row),
		steps: resultTrail(row),
		signature: row.signature !== null ? (signatureById(ctx.db, row.signature)?.text ?? null) : null,
		corrects: row.corrects,
		location: await locationOf(target),
		commit: target.commit_sha,
		change: target.change !== null ? (changeById(ctx.db, target.change)?.key ?? null) : null,
		job: batch?.job ?? "",
		build: batch?.build_url ?? null,
	};
}

async function quarantineView(ctx: Ctx<ReadDb>, test: number) {
	const entry = await quarantineEntry(ctx.db, ctx.project.id, test);
	return entry
		? {
				decision: entry.decision,
				reason: entry.reason,
				by: (await who(ctx, entry.actor)).name,
				since: entry.at,
				exit: entry.exit_rule === null ? null : QuarantineExit.parse(json<unknown>(entry.exit_rule)),
				active: await effectiveQuarantine(ctx.db, entry, ctx.now),
			}
		: null;
}
export async function get(ctx: Ctx<ReadDb>, input: GetInput): Promise<Record<string, unknown>[]> {
	if (input.cursor && (input.refs.length !== 1 || !/^P-\d+$/i.test(input.refs[0]?.trim() ?? "")))
		throw invalid("a proposal cursor needs exactly one P- ref");
	const readOne = async (text: string): Promise<Record<string, unknown>> => {
		if (text.startsWith("result:")) {
			const id = /^result:([1-9]\d*)$/.exec(text)?.[1];
			const row = id && Number.isSafeInteger(Number(id)) ? resultById(ctx.db, Number(id)) : null;
			if (!row || row.project !== ctx.project.id) throw notFound(text);
			return { ref: text, ...resultView(ctx, row), detail: row.detail };
		}
		if (text.startsWith("commit:"))
			return { ref: text, gate: gate(ctx, { commit: text.slice(7), ...(input.repo ? { repo: input.repo } : {}) }) };
		if (text.startsWith("change:")) return { ref: text, gate: gate(ctx, { change: text.slice(7) }) };
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
			const last = lastResultsOfTest(ctx.db, test.project, test.id, 20);
			const retried = passedOnRetry(
				ctx.db,
				last.map((row) => row.id),
			);
			const tried = triesOf(
				ctx.db,
				last.map((row) => row.id),
			);
			const locationOf = resultLocations(
				ctx.db,
				last.map((row) => mustTarget(ctx.db, row.target)),
			);
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
				last: last.map((row) => ({
					...resultView(ctx, row, locationOf),
					passedOnRetry: retried.get(row.id) ?? null,
					tries: tried.get(row.id) ?? [],
				})),
			};
		}
		if (kind === "P-") {
			const proposal = proposalByNo(ctx.db, ctx.project.id, Number(text.trim().slice(2)));
			if (!proposal) throw notFound(`proposal ${text}`);
			return proposalView(ctx, proposal, input.cursor);
		}
		const row = await mustCase(ctx.db, ctx.project.id, text);
		const version = input.refs.length === 1 ? input.version : undefined;
		let document: Record<string, unknown>;
		if (input.as === "md") {
			const stored = await versionOf(ctx.db, row.id, version ?? row.head);
			if (!stored) throw notFound(`${caseRef(row)} version ${version}`);
			const md = printCase({
				ref: caseRef(row),
				kind: row.kind,
				body: json<CaseBody>(stored.body),
				tags: json<string[]>(row.tags),
				covers: await coversOf(ctx.db, row.id),
			});
			document = { ref: caseRef(row), version: stored.no, hash: stored.hash, md };
		} else {
			document = await caseView(ctx, row, { fields: input.fields, version });
		}
		const etag = contentHash(document);
		if (version === undefined && input.unless?.[caseRef(row)] === etag)
			return { ref: caseRef(row), unchanged: true, hash: document.hash, etag };
		return { ...document, etag };
	};
	const out: Record<string, unknown>[] = [];
	for (const text of input.refs) out.push(await readOne(text));
	return out;
}

export const getOp = defineOp({
	name: "get",
	output: REPLIES.get,
	summary: "Read cases, questions, runs, tests, results or proposals by ref.",
	input: GetInput,
	needs: "read",
	scope: "project",
	effect: "read",
	mcp: "Read refs including result:id; verdicts: commit:hash, change:key, R-n. unless=etag; cursor pages proposals.",
	run: get,
});

// ── find ───────────────────────────────────────────────────────────────────────────────────────────────────

type Found = {
	fieldDefinitions?: FieldDefinitions;
	count: number | null;
	items: Record<string, unknown>[];
	cursor: string | null;
	tally?: Record<string, number>;
	testTime?: { ms: number; timed: number };
	flaky?: { flipped: number; failing: number; days: number };
};

/** The rows that fail a gate: a failure nothing excuses, or one an answer says needs a fix. */
const FAILS_GATE: ReadonlySet<string> = new Set(["unexplained", "attributed"]);

/**
 * The tests a commit's gate counted, each as it counts it: one row per test and lane, so the rows add up to the
 * gate's tally. Ordered problems first, a flaky row first among its own, so a pass that a failure preceded is not
 * the last of hundreds, then by when the result arrived. A retry, a decision or a link moves a row in that order or
 * in and out of a filter, so the cursor also carries a hash of the list it was taken from: a page asked for after
 * that list changed is refused, and the list is read again from the start, instead of skipping or repeating the row
 * that moved.
 */
async function countedResults(ctx: Ctx<ReadDb>, input: FindInput, limit: number): Promise<Found> {
	if (!input.commit && !input.change && !input.run) throw invalid("results need a commit, a change or a run");
	const wanted = input.state;
	if (wanted !== undefined && !isResultStanding(wanted))
		throw invalid(`"${wanted}" is not how a gate counts a result: use one of ${RESULT_STANDINGS.join(", ")}`);
	const run = await gateRun(ctx, input);
	if (run?.origin === "planned")
		throw invalid(
			`${runRef(run)} is a planned run: its results are in its slots (find --in slots --run ${runRef(run)})`,
		);
	const counted = run ? await countedTests(ctx.db, run) : [];
	const tally: Record<string, number> = { ...emptyTally() };
	for (const row of counted) tally[row.standing] = (tally[row.standing] ?? 0) + 1;
	const time = await testTime(
		ctx.db,
		counted.map((row) => row.result),
	);

	const rank = (row: CountedTest): number => 2 * RESULT_STANDINGS.indexOf(row.standing) + (row.flipped ? 0 : 1);
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
		rows: matching.map((row) => [row.result, row.standing, row.flipped]),
	}).slice(0, 12);
	const after = input.cursor ? parseResultCursor(input.cursor) : null;
	if (after && after.version !== version)
		throw conflict("the results changed since this cursor was given: read them again from the first page");
	const rest = after
		? matching.filter((row) => rank(row) > after.rank || (rank(row) === after.rank && row.result > after.result))
		: matching;
	const page = rest.slice(0, limit);
	const last = page.at(-1);
	const locationOf = await resultLocations(
		ctx.db,
		page.map((row) => mustTarget(ctx.db, row.target)),
	);
	// Flips over the same days the flaky report and the detector read, so a row and those agree on a test.
	const days = (await currentPolicy(ctx.db, ctx.project.id)).settings.flakyDetection.windowDays;
	const failing = counted.filter((row) => FAILS_GATE.has(row.standing));
	const flips = await flipsOf(
		ctx.db,
		ctx.project.id,
		[...failing, ...page].map((row) => row.test),
		ctx.now - days * 86_400_000,
	);
	return {
		count: matching.length,
		items: page.map((row) => ({ ...countedView(ctx, row, locationOf), recentFlips: flips.get(row.test) ?? 0 })),
		cursor: rest.length > limit && last ? `${rank(last)}.${last.result}.${version}` : null,
		tally,
		testTime: time,
		flaky: {
			flipped: counted.filter((row) => row.flipped).length,
			failing: failing.filter((row) => flips.has(row.test)).length,
			days,
		},
	};
}

function parseResultCursor(cursor: string): { rank: number; result: number; version: string } {
	const match = /^(\d+)\.(\d+)\.([0-9a-z]+)$/.exec(cursor.trim());
	if (!match) throw invalid(`"${cursor}" is not a cursor of results`);
	return { rank: Number(match[1]), result: Number(match[2]), version: match[3] ?? "" };
}

async function countedView(
	ctx: Ctx<ReadDb>,
	row: CountedTest,
	locationOf: (target: TargetRow) => ReturnType<typeof resultLocation>,
): Promise<Record<string, unknown>> {
	const result = await resultById(ctx.db, row.result);
	const test = await testById(ctx.db, row.test);
	if (!result || !test) throw new Error(`result ${row.result} of a counted test is missing`);
	const linked = await caseOfCount(ctx, row, test);
	const view = await resultView(ctx, result, locationOf);
	return {
		result: result.id,
		test: testRef(test),
		name: test.name,
		file: test.file,
		case: linked ? caseRef(linked) : null,
		outcome: result.outcome,
		standing: row.standing,
		quarantined: row.excuse?.quarantined ?? false,
		flipped: row.flipped,
		question: await questionOfCount(ctx, row),
		attempt: result.attempt,
		durationMs: result.duration_ms,
		message: result.message,
		job: view.job,
		by: view.by,
		model: result.model,
		steps: resultTrail(result),
		at: result.at,
		location: view.location,
		commit: view.commit,
		build: view.build,
	};
}

/** The case a counted result is evidence for: the one it claimed, else the one its test is linked to. */
async function caseOfCount(
	ctx: Ctx<ReadDb>,
	row: CountedTest,
	test: { case_id: number | null },
): Promise<CaseRow | null> {
	const claimed = resultById(ctx.db, row.result)?.basis_case ?? null;
	const id = claimed ?? test.case_id;
	return id !== null ? await caseById(ctx.db, id) : null;
}

/** The question a failure's standing comes from: the one that decided it, or the open one it waits for. */
async function questionOfCount(ctx: Ctx<ReadDb>, row: CountedTest): Promise<string | null> {
	if (row.excuse) {
		const decision = await decisionById(ctx.db, row.excuse.decision);
		const question = decision ? await questionById(ctx.db, decision.question) : null;
		return question ? questionRef(question) : null;
	}
	if (row.standing !== "unexplained" || row.signature === null) return null;
	const signature = await signatureById(ctx.db, row.signature);
	if (!signature) return null;
	const open = await openFailureQuestion(ctx.db, ctx.project.id, {
		signature: signature.hash,
		scope: row.scope,
		target: row.target,
	});
	return open ? questionRef(open) : null;
}

async function caseProof(ctx: Ctx<ReadDb>, row: CaseRow) {
	const proofs = await proofOf(ctx.db, row);
	const one = async (proof: (typeof proofs)[MethodKind]) => {
		if (!proof) return null;
		const { result, current } = proof;
		return {
			id: result.id,
			version: result.basis_version,
			by: (await who(ctx, result.actor)).name,
			method: result.method,
			model: result.model,
			name: testById(ctx.db, result.test)?.name ?? null,
			outcome: result.outcome,
			at: result.at,
			current,
			basis: result.basis,
		};
	};
	return { human: await one(proofs.human), auto: await one(proofs.auto), agent: await one(proofs.agent) };
}

async function caseRow(ctx: Ctx<ReadDb>, row: CaseRow, rich: boolean): Promise<Record<string, unknown>> {
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
		updatedBy: (await who(ctx, row.updated_by)).kind,
	};
	if (rich) {
		base.proof = await caseProof(ctx, row);
		base.open = await openCountOn(ctx.db, row.project, caseRef(row));
	}
	return base;
}

async function slotRow(ctx: Ctx<ReadDb>, slot: SlotRow): Promise<Record<string, unknown>> {
	const row = await caseById(ctx.db, slot.case_id);
	const fills = await fillsOf(ctx.db, slot.id);
	const lease = await leaseOf(ctx, slot.id);
	return {
		id: slot.id,
		case: row ? caseRef(row) : null,
		title: row?.title ?? null,
		version: slot.version,
		head: row?.head ?? null,
		state: slot.state,
		rank: slot.rank,
		assignee: slot.assignee !== null ? (await who(ctx, slot.assignee)).name : null,
		work: lease
			? { kind: "held", actor: (await who(ctx, lease.actor)).name, since: lease.since, until: lease.until }
			: { kind: "free" },
		fills: fills.map((fill) => ({
			result: fill.id,
			by: who(ctx, fill.actor).name,
			model: fill.model,
			method: fill.method,
			outcome: fill.outcome,
			admitted: fill.admitted,
			at: fill.at,
			note: fill.note ?? fill.message,
			atStep: fill.atStep,
			steps: fill.steps,
		})),
	};
}

const RUN_STATES = ["open", "closed"] as const satisfies readonly RunRow["state"][];

export async function find(ctx: Ctx<ReadDb>, input: FindInput): Promise<Found> {
	const limit = input.limit ?? 100;
	const project = ctx.project.id;
	switch (input.in) {
		case "receipt-results":
			if (!input.receipt) throw invalid("receipt-results needs a receipt id");
			return await mergeReceiptPage(ctx.db, project, input.receipt, input.cursor, input.limit ?? 50);
		case "results":
			return await countedResults(ctx, input, limit);
		case "deployments": {
			const rows = await deployments(ctx.db, {
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
			const fieldDefinitions = currentPolicy(ctx.db, project).settings.fields ?? {};
			if (input.select) {
				const selected = await selectCases(ctx, input.select);
				const from = input.cursor ? Number(input.cursor) : 0;
				if (!Number.isSafeInteger(from) || from < 0) throw invalid("that is not a cursor of a selection");
				return {
					fieldDefinitions,
					count: selected.length,
					items: selected.slice(from, from + limit).map((row) => caseRow(ctx, row, true)),
					cursor: selected.length > from + limit ? String(from + limit) : null,
				};
			}
			const page = await listCases(ctx, {
				folder: input.folder,
				deep: input.deep,
				tags: input.tags,
				state: input.state,
				text: input.text,
				limit,
				cursor: input.cursor,
			});
			return {
				fieldDefinitions,
				count: page.count,
				items: page.items.map((row) => caseRow(ctx, row, true)),
				cursor: page.cursor,
			};
		}
		case "folders": {
			const tree = await folderTree(ctx.db, project);
			return { count: tree.total, items: tree.folders, cursor: null };
		}
		// Kept apart from the folder tree, which every screen loads: counting tags reads every tag row.
		case "tags":
			return { count: null, items: await tagCounts(ctx.db, project), cursor: null };
		case "requirements":
			return { count: null, items: await requirementList(ctx.db, project), cursor: null };
		case "runs": {
			const state = RUN_STATES.find((known) => known === input.state) ?? null;
			if (input.state !== undefined && state === null)
				throw invalid(`a run is "open" or "closed", not "${input.state}"`);
			const change = input.change ? await changeByKey(ctx.db, project, input.change) : null;
			if (input.change && !change) throw notFound(`change ${input.change}`);
			const before = input.cursor ? Number(input.cursor) : Number.MAX_SAFE_INTEGER;
			const filter = { origin: input.origin ?? null, state, change: change?.id ?? null };
			const rows = await recentRuns(ctx.db, project, filter, before, limit + 1);
			const page = rows.slice(0, limit);
			const targets = page.flatMap((run) => {
				const target = runTarget(ctx, run);
				return target ? [target] : [];
			});
			const locationOf = await resultLocations(ctx.db, targets);
			return {
				count: null,
				items: page.map((run) => runView(ctx, run, locationOf)),
				cursor: rows.length > limit ? String(page.at(-1)?.id ?? "") : null,
			};
		}
		case "slots": {
			if (!input.run) throw invalid("find slots needs a run");
			const run = await mustRun(ctx.db, project, input.run);
			const after = input.cursor ? Number(input.cursor) : -1;
			const rows = await slotsPage(ctx.db, run.id, after, limit + 1);
			const page = rows.slice(0, limit);
			return {
				count: await slotCount(ctx.db, run.id),
				items: page.map((slot) => slotRow(ctx, slot)),
				cursor: rows.length > limit ? String(page.at(-1)?.rank ?? "") : null,
			};
		}
		case "tests": {
			if (input.state === "quarantined") {
				const active = (await quarantineEntries(ctx.db, project))
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
			const rows = await listTests(ctx.db, {
				project,
				unlinked: input.unlinked ?? false,
				text: input.text,
				before: input.cursor ? Number(input.cursor) : null,
				limit: limit + 1,
			});
			const page = rows.slice(0, limit);
			return {
				count: input.unlinked ? await unlinkedCount(ctx.db, project) : null,
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
			const items = (await recentChanges(ctx.db, project, limit)).map((change) => {
				const status = change.head_sha ? gate(ctx, { change: change.key }) : null;
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
					...(status?.waiting ? { waiting: status.waiting } : {}),
					landing: landingView(ctx, change),
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
	mcp: "Find cases/tests/runs/slots; cursor pages.",
	run: find,
});

// ── history and timeline ───────────────────────────────────────────────────────────────────────────────────

export async function history(ctx: Ctx<ReadDb>, input: HistoryInput): Promise<Record<string, unknown>> {
	const row = await mustCase(ctx.db, ctx.project.id, input.ref);
	if (input.from !== undefined || input.to !== undefined) {
		const to = input.to ?? row.head;
		const from = input.from ?? Math.max(1, to - 1);
		const diff = diffBodies(await bodyOf(ctx.db, row.id, from), await bodyOf(ctx.db, row.id, to));
		return { ref: caseRef(row), from, to, summary: summariseDiff(diff), diff };
	}
	return {
		ref: caseRef(row),
		head: row.head,
		versions: (await versionList(ctx.db, row.id)).map((v) => ({
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
export async function timeline(
	ctx: Ctx<ReadDb>,
	input: z.infer<typeof TimelineInput>,
): Promise<Record<string, unknown>> {
	const row = await mustCase(ctx.db, ctx.project.id, input.ref);
	const limit = input.limit ?? 100;
	type Entry = { t: string; seq: number; at: number } & Record<string, unknown>;
	const entries: Entry[] = [];
	for (const v of await versionList(ctx.db, row.id)) {
		entries.push({
			t: "version",
			seq: v.seq,
			at: v.at,
			version: v.version,
			hash: v.hash,
			by: (await who(ctx, v.author)).name,
			kind: (await who(ctx, v.author)).kind,
			reason: v.reason,
			summary: v.summary,
			reviews: (await reviewsAtVersion(ctx.db, row.id, v.version)).length,
		});
	}
	for (const p of await placementsOf(ctx.db, row.id, limit)) {
		const before = json<{ folder: number; tags: string[]; state: string }>(p.before);
		const after = json<{ folder: number; tags: string[]; state: string }>(p.after);
		const index = await folderIndex(ctx.db, row.project);
		const what = [
			before.folder !== after.folder ? `moved to ${index.path(after.folder)}` : null,
			before.state !== after.state ? after.state : null,
			before.tags.join(" ") !== after.tags.join(" ") ? `tags: ${after.tags.join(", ") || "none"}` : null,
		].filter(Boolean);
		entries.push({
			t: "placement",
			seq: p.seq,
			at: p.at,
			by: (await who(ctx, p.actor)).name,
			kind: (await who(ctx, p.actor)).kind,
			what: what.join("; ") || "reordered",
		});
	}
	const results = lastResultsOfCase(ctx.db, row.id, limit);
	const locationOf = await resultLocations(
		ctx.db,
		results.map((result) => mustTarget(ctx.db, result.target)),
	);
	for (const r of results)
		entries.push({ ...(await resultView(ctx, r, locationOf)), t: "result", seq: r.seq, at: r.at, ord: r.ord });
	for (const f of await findingsOfCase(ctx.db, row.id, limit)) {
		entries.push({
			t: "finding",
			seq: f.seq,
			at: f.at,
			by: (await who(ctx, f.actor)).name,
			kind: (await who(ctx, f.actor)).kind,
			on: f.locus,
			category: f.category,
			note: f.note,
			lens: f.lens,
		});
	}
	for (const r of await reviewsOfCase(ctx.db, row.id, limit)) {
		entries.push({
			t: "review",
			seq: r.seq,
			at: r.at,
			by: (await who(ctx, r.reviewer)).name,
			kind: (await who(ctx, r.reviewer)).kind,
			lens: r.lens,
			version: r.version,
			about: r.about,
		});
	}
	const questions = (await questionsOn(ctx.db, row.project, caseRef(row))).map((q) =>
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
	mcp: null,
	run: async (ctx: Ctx<ReadDb>, input: GateInput): Promise<GateStatus> => await gate(ctx, input),
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

export async function since(ctx: Ctx<ReadDb>, input: SinceInput): Promise<Record<string, unknown>> {
	const from = parseCursor(input.cursor);
	const limit = input.limit ?? 200;
	/** One page and where the next starts: after the last row returned, or past everything when the page is whole. */
	const page = <T extends { rev: number; id: number }>(rows: T[]): { rows: T[]; next: Position; more: boolean } => {
		const more = rows.length > limit;
		const kept = more ? rows.slice(0, limit) : rows;
		const last = kept.at(-1);
		return { rows: kept, more, next: more && last ? { rev: last.rev, id: last.id + 1 } : { rev: ctx.seq + 1, id: 0 } };
	};
	const cases = page(await casesChangedSince(ctx.db, ctx.project.id, from.cases, limit + 1));
	const questions = page(await questionsChangedSince(ctx.db, ctx.project.id, from.questions, limit + 1));
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
	mcp: "Case changes and settled questions since cursor; repeat while more.",
	run: since,
});

// ── check ──────────────────────────────────────────────────────────────────────────────────────────────────

/** A type-checker for the suite: structural problems the data can show, with no model involved. */
export async function check(
	ctx: Ctx<ReadDb>,
	input: z.infer<typeof CheckInput>,
): Promise<{ problems: Problem[]; counts: Record<string, number> }> {
	const limit = input.limit ?? 200;
	const project = ctx.project.id;
	const problems: Problem[] = [];
	const counts: Record<string, number> = {};
	const add = (rule: string, rows: { ref: string; message: string }[], total: number) => {
		counts[rule] = total;
		for (const row of rows) if (problems.length < limit) problems.push({ rule, ...row });
	};
	for (const problem of structuralProblems(ctx.db, project)) add(problem.rule, problem.rows, problem.total);
	const dangling = (await archivedCases(ctx.db, project, 200)).flatMap((row) =>
		testsOfCase(ctx.db, project, row.id).map((test) => ({
			ref: testRef(test),
			message: `"${test.name}" is linked to ${caseRef(row)}, which is archived`,
		})),
	);
	add("linked-to-archived", dangling, dangling.length);
	counts["unlinked-tests"] = await unlinkedCount(ctx.db, project);
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
 * The commit a merged change landed as on trunk and that commit's own gate. A rebase or a squash lands a commit the
 * pull request never had, so this is not the change's gate unless it is the head. `run` is null when nothing a gate
 * counts has been reported for it.
 */
async function landingView(ctx: Ctx<ReadDb>, change: ChangeRow) {
	const landing = landingOf(change);
	if (!landing) return null;
	const status = await gateOfCommitIn(ctx, change.repo, landing.commit);
	return {
		...landing,
		run: status.run,
		verdict: status.verdict,
		reason: status.reason,
		...(status.waiting ? { waiting: status.waiting } : {}),
	};
}

/**
 * Where to look for a change: the cases it touches, why each is in the set, its last result, whether this caller
 * already reviewed it at this version and change head, and the questions already open or decided. Counts first, bounded.
 */
export async function impact(ctx: Ctx<ReadDb>, input: ImpactInput): Promise<Record<string, unknown>> {
	const project = ctx.project.id;
	const version = contentHash({
		project: ctx.project.identity,
		actor: ctx.actor.id,
		seq: ctx.seq,
		change: input.change ?? null,
		files: input.files ?? null,
		since: input.since ?? null,
		ledger: input.ledger,
	});
	const at = input.cursor ? /^(\d+)\.([0-9a-f]{12})$/.exec(input.cursor) : null;
	const offset = at ? Number(at[1]) : 0;
	if (input.cursor && (!at || !Number.isSafeInteger(offset) || offset < 200 || offset % 200 !== 0))
		throw invalid("that is not an impact continuation");
	if (at && at[2] !== version)
		throw conflict("the project or impact inputs changed: restart without cursor, keeping the original since");
	const change = input.change ? await changeByKey(ctx.db, project, input.change) : null;
	if (input.change && !change && !input.files) throw notFound(`change ${input.change}`);
	const files = input.files ?? (change ? json<string[]>(change.files) : []);
	const from = input.since ? cursorSeq(input.since) : null;
	const uniqueFiles = new Set(files);
	const fileSelection = await caseSelectionOfFiles(ctx.db, project, uniqueFiles);
	const candidates = new Set(fileSelection.ids);
	const uncovered = files.filter(
		(file) => !fileSelection.covered.has(file) && !/\.(md|txt|json|ya?ml|lock)$/i.test(file),
	);
	const keys = [...new Set((change?.title ?? "").match(/[A-Z][A-Z0-9]+-\d+/g) ?? [])];
	for (const id of await caseIdsOfRequirements(ctx.db, project, keys)) candidates.add(id);
	const run = change?.head_sha ? await gate(ctx, { change: change.key }) : null;
	const headRun = run?.run ? await mustRun(ctx.db, project, run.run) : null;
	const failing = new Set(
		headRun ? await caseIdsOfTests(ctx.db, project, await failingTestIds(ctx.db, headRun.id)) : [],
	);
	for (const id of failing) candidates.add(id);
	const changeQuestions = change ? await questionsOn(ctx.db, project, change.key) : [];
	const mentioned = (
		await refsOfQuestions(
			ctx.db,
			changeQuestions.filter((q) => q.state === "open").map((q) => q.id),
		)
	).filter((ref) => /^C-\d+$/.test(ref));
	const questioned = new Set(await caseIdsOfRefs(ctx.db, project, mentioned));
	for (const id of questioned) candidates.add(id);

	const heads = await impactHeads(
		ctx.db,
		project,
		[...candidates].map((id) => ({ id, failing: failing.has(id) })),
		from !== null && (change?.rev ?? 0) <= from ? from : null,
	);
	const reviewed =
		input.ledger && change?.head_sha
			? await reviewedCaseIds(
					ctx.db,
					ctx.actor.id,
					heads.map((row) => ({
						id: row.id,
						version: row.head,
						basis: reviewBasis({ version: row.head_hash, about: change.key, patch: change.head_sha }),
					})),
				)
			: new Set<number>();
	const selected = await impactCasePage(
		ctx.db,
		project,
		heads.map((row) => ({ id: row.id, no: row.no, failing: row.failing, reviewed: reviewed.has(row.id) })),
		offset,
	);
	if (input.cursor && offset >= selected.counts.cases) throw invalid("that continuation is past the impact cases");
	const pageIds = selected.rows.map((row) => row.id);
	const why = new Map<number, Set<string>>();
	const note = (id: number, reason: string) => {
		const reasons = why.get(id) ?? new Set<string>();
		reasons.add(reason);
		why.set(id, reasons);
	};
	for (const link of await caseLinksOfFiles(ctx.db, project, uniqueFiles, pageIds))
		note(link.case_id, `test:${link.file}`);
	for (const link of await caseLinksOfRequirements(ctx.db, project, keys, pageIds)) note(link.id, `req:${link.key}`);
	for (const id of pageIds) {
		if (failing.has(id)) note(id, "failing");
		if (questioned.has(id)) note(id, "question");
	}
	const reasonOrder = new Map(
		[...[...uniqueFiles].map((file) => `test:${file}`), ...keys.map((key) => `req:${key}`), "failing", "question"].map(
			(reason, index) => [reason, index],
		),
	);
	const lastResults = await lastResultsOfCases(ctx.db, pageIds);
	const openQuestions = await openQuestionSummariesOnRefs(ctx.db, project, selected.rows.map(caseRef));
	const page: z.infer<typeof REPLIES.impact>["cases"] = selected.rows.map((row) => {
		const last = lastResults.get(row.id);
		const open = openQuestions.get(caseRef(row)) ?? [];
		return {
			id: caseRef(row),
			title: row.title,
			hash: row.head_hash,
			why: [...(why.get(row.id) ?? [])].sort((a, b) => (reasonOrder.get(a) ?? 0) - (reasonOrder.get(b) ?? 0)),
			last: last ? `${last.outcome}@v${last.basis_version ?? "?"}` : null,
			...(reviewed.has(row.id) ? { reviewed: true } : {}),
			...(open.length > 0 ? { open } : {}),
		};
	});
	const next = offset + page.length < selected.counts.cases ? `${offset + page.length}.${version}` : null;
	const decided = change
		? changeQuestions
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
					landing: await landingView(ctx, change),
					mergeReceipt: await mergeReceiptById(ctx.db, project, change.receipt),
				}
			: { files: files.length },
		gate: run ? { verdict: run.verdict, reason: run.reason, run: run.run } : null,
		counts: { ...selected.counts, uncovered: uncovered.length },
		cases: page,
		uncovered: uncovered.slice(0, 50),
		decided,
		policy: policyName(await currentPolicy(ctx.db, project)),
		cursor: next ? `s:${from ?? 0}` : `s:${ctx.seq}`,
		next,
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
	mcp: "Cases for change/files. Page next as cursor with the same inputs; only the final cursor becomes since. Restart after project writes.",
	run: impact,
});

// ── command ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What became of a command the caller sent. A client whose reply was lost asks this, instead of guessing from
 * what it reads back or sending the request again (issue #71). A command of another caller or another project
 * is `none`: an id tells nobody what somebody else did. An instance command is in no project, so its reply,
 * which can stand for a secret, is never returned here.
 */
export async function commandFate(ctx: Ctx<ReadDb>, input: CommandInput): Promise<CommandFate> {
	const row = await findCommand(ctx.db, input.cmd);
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
