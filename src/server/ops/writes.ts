// The operations that produce evidence, request it, or decide: propose, report, claim, plan, decide.
// Each composes the owning modules; none of them writes a table itself.
import { contentHash } from "../../core/hash.ts";
import type { ActorKind } from "../../core/kinds.ts";
import {
	ChangeInput,
	type ChangeReply,
	ClaimInput,
	type ClaimReply,
	DecideInput,
	type DecideReply,
	PlanInput,
	type PlanReply,
	ProposeInput,
	type ProposeReply,
	type QuestionBrief,
	ReportInput,
	type ReportReceipt,
} from "../../core/ops.ts";
import { REPLIES } from "../../core/replies.ts";
import { clip } from "../../core/text.ts";
import {
	answer,
	askAgainAbout,
	askWhereCommitIs,
	type Raise,
	type Raised,
	raise,
	raiseFailure,
	refold,
	stopAskingAbout,
	undo,
} from "../decisions/decisions.ts";
import { raiseAdopt } from "../decisions/kinds.ts";
import { decisionById, type QuestionRow, questionRef } from "../decisions/questions.ts";
import {
	accept,
	applySteps,
	type BatchRow,
	batchById,
	changeById,
	changeByKey,
	ensureTarget,
	firstCountedReport,
	keepReceipt,
	markProcessed,
	mustTarget,
	NO_FILE,
	scopeEnded,
	setChangeEnded,
	type TargetRow,
	testRef,
	unlinkedInFile,
} from "../evidence/evidence.ts";
import { insertFinding, insertReview, reviewBasis, reviewedAt } from "../evidence/findings.ts";
import { actorByName, actorLabel } from "../identity/identity.ts";
import type { Ctx } from "../kernel/ctx.ts";
import { json } from "../kernel/db.ts";
import { conflict, forbidden, invalid, notFound } from "../kernel/errors.ts";
import { currentPolicy } from "../policy/policy.ts";
import {
	applyBatchSteps,
	defaultObligations,
	describeAccepts,
	failuresShown,
	gateOf,
	mustRun,
	noteAccepted,
	noteApplied,
	nothingCounted,
	pinnedVersions,
	plan,
	plannedCounting,
	type RunRow,
	runAccepts,
	runById,
	runRef,
	runsFor,
} from "../runs/runs.ts";
import { selectCases } from "../suite/read.ts";
import { type CaseRow, caseRef, mustCase, seal } from "../suite/suite.ts";
import { COMMIT, defineOp, type Pause } from "./registry.ts";

// ── propose ────────────────────────────────────────────────────────────────────────────────────────────────

export function propose(ctx: Ctx, input: ProposeInput): ProposeReply {
	const sealed = seal(ctx, { edits: input.edits, reason: input.reason });
	if (!sealed) return { proposal: null, status: "adopted", question: null, needs: null, cases: [], conflicts: [] };
	const raised = raiseAdopt(ctx, { raise }, sealed);
	const base = {
		proposal: `P-${sealed.proposal.no}`,
		question: questionRef(raised.question),
		conflicts: sealed.conflicts,
	};
	if (raised.s === "decided") {
		const effects = raised.effects as { cases?: ProposeReply["cases"]; rejected?: boolean };
		return { ...base, status: effects.rejected ? "rejected" : "adopted", needs: null, cases: effects.cases ?? [] };
	}
	const needs = json<{ who: string }>(raised.question.ask).who;
	return {
		...base,
		status: sealed.conflicts.length > 0 ? "conflict" : "open",
		needs:
			sealed.conflicts.length > 0
				? `the case changed since the base you named: answer ${questionRef(raised.question)} with a merge, or reject it and propose again on the current version`
				: needs === "admin"
					? "an admin"
					: "a member who is not an agent",
		cases: [],
	};
}

export const proposeOp = defineOp({
	name: "propose",
	output: REPLIES.propose,
	summary:
		"Create or change cases, folders, links or the policy. Saving and proposing are the same call; policy decides what happens next.",
	input: ProposeInput,
	needs: "produce",
	scope: "project",
	effect: "write",
	mcp: "Propose cases at their base version. Status: adopted=current, open=needs acceptance, conflict=resolve, rejected.",
	run: propose,
});

// ── report ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Step one of a report: store it durably and mark every run it matters to as waiting for it. A report that names
 * both a run and a target is refused when the run does not count that target: naming a run is not a way to make
 * evidence about another build count for it.
 */
export function acceptReport(ctx: Ctx, input: ReportInput): { batch: BatchRow; fresh: boolean } {
	const run = input.run ? mustRun(ctx.db, ctx.project.id, input.run) : null;
	if (run?.state === "closed" && !json<{ commit?: string }>(run.accepts).commit)
		throw conflict(`${runRef(run)} is closed; withdraw its sign-off to reopen it`);
	let target: TargetRow;
	if (input.target) target = ensureTarget(ctx, input.target);
	else if (run) {
		const accepts = json<{ commit?: string; repo?: string; env?: string }>(run.accepts);
		target = accepts.commit
			? ensureTarget(ctx, {
					commit: accepts.commit,
					...(accepts.repo ? { repo: accepts.repo } : {}),
					...(accepts.env ? { env: accepts.env } : {}),
				})
			: ensureTarget(ctx, { session: runRef(run) });
	} else throw invalid("a report needs a target (what was tested) or a run");
	if (run && !runAccepts(run, target)) {
		throw invalid(
			`${runRef(run)} counts ${describeAccepts(run)}, and this report is for another target. Report it without \`run\` to record it for its own target.`,
		);
	}

	const accepted = accept(ctx, { target, run: run?.id ?? null, report: input, nonce: input.cmd ?? `${ctx.seq}` });
	if (accepted.fresh) {
		const runs = runsFor(ctx, target, run?.id ?? null, ctx.actor.kind);
		noteAccepted(ctx, runs, accepted.batch.seq);
		// The first report of a commit that a gate counts says where the commit is, and that is so from this
		// moment (`ensureTarget`). Every other run that counts the commit waits for this report too: until it is
		// applied and they are recomputed, none of them goes on showing a verdict from before the move.
		noteAccepted(ctx, alsoWaiting(ctx, accepted.batch, target, runs), accepted.batch.seq);
	}
	return accepted;
}

/**
 * The planned runs that count a batch's commit without counting its target (another environment, another
 * repository of a run that names none), when the batch is the first report of the commit that a gate counts.
 * They wait for it with the runs it folds into, from acceptance to application, and are recomputed with them.
 */
function alsoWaiting(ctx: Ctx, batch: BatchRow, target: TargetRow, runs: readonly RunRow[]): RunRow[] {
	if (target.commit_sha === null || !firstCountedReport(ctx.db, batch, target)) return [];
	const folded = new Set(runs.map((run) => run.id));
	return plannedCounting(ctx.db, ctx.project.id, target.commit_sha).flatMap((id) => {
		const run = folded.has(id) ? null : runById(ctx.db, id);
		return run ? [run] : [];
	});
}

/**
 * Step two: apply a staged batch. In one transaction: results with their basis, the runs they fill, one question
 * per cause of failure, unlinked tests, and each run's new verdict.
 */
export function* processBatchSteps(ctx: Ctx, batchId: number): Generator<Pause, ReportReceipt, void> {
	const batch = batchById(ctx.db, batchId);
	if (!batch) throw notFound(`batch ${batchId}`);
	const target = mustTarget(ctx.db, batch.target);
	const producer = actorLabel(ctx.db, batch.actor).kind;
	const runs = runsFor(ctx, target, batch.run, producer);
	const pinned = batch.run !== null ? pinnedVersions(ctx.db, batch.run) : new Map<number, number>();
	const applied = yield* applySteps(ctx, batch, producer, (caseId) => pinned.get(caseId) ?? null);
	const groups = yield* applyBatchSteps(ctx, { batch, target, applied: applied.results, runs });

	const questions: QuestionBrief[] = [];
	for (const group of groups) {
		// A report for a change that has ended (a pipeline that finished after the merge) is recorded and counted,
		// and not asked about, unless an open planned run shows the failure and waits for the answer.
		if (scopeEnded(ctx.db, group.scope) && !group.runs.some((run) => run.origin === "planned" && run.state === "open"))
			continue;
		const raised = raiseFailure(ctx, { group, target, by: batch.actor, producer });
		questions.push(brief(ctx, raised, group.tests.length));
	}

	const files = new Set<string>();
	for (const result of applied.results) {
		if (result.fresh && result.test.kind === "auto" && result.test.case_id === null)
			files.add(result.test.file ?? NO_FILE);
	}
	for (const file of files) raiseMap(ctx, file, producer);

	// The batch is applied before the runs are folded: a run that requires this job must count it.
	markProcessed(ctx, batch, applied.counts);
	// The first report of a commit that a gate counts says where the commit is (only an agent may have said so
	// before): every run that counts the commit is recomputed with the others, because its failures are
	// answered there from now on.
	const waiting = alsoWaiting(ctx, batch, target, runs);
	if (target.commit_sha !== null && firstCountedReport(ctx.db, batch, target)) {
		for (const id of plannedCounting(ctx.db, ctx.project.id, target.commit_sha)) ctx.recompute.add(id);
		askWhereCommitIs(ctx, target);
	}
	noteApplied(
		ctx,
		waiting.map((run) => run.id),
		batch.seq,
	);
	// They are folded with the others below, after the report is marked applied for them: a question asked on
	// the way here may already have recomputed them while they were still waiting.
	for (const run of waiting) ctx.recompute.add(run.id);
	refold(
		ctx,
		runs.map((run) => run.id),
		{ dissolveStale: true },
	);
	// Whatever else asked on the way here (a commit that found its place, a run recomputed): a change that has
	// ended is not asked about.
	const ended = target.change !== null ? changeById(ctx.db, target.change) : null;
	if (ended && ended.ended !== null) stopAskingAbout(ctx, ended);
	const gated = runs.find((run) => run.origin === "change") ?? runs.find((run) => run.id === batch.run) ?? null;
	const fresh = gated ? runById(ctx.db, gated.id) : null;
	const receipt: ReportReceipt = {
		batch: batch.id,
		fresh: true,
		target: target.commit_sha
			? `${target.commit_sha.slice(0, 7)}${target.branch ? ` (${target.branch})` : ""}`
			: target.what,
		counts: applied.counts,
		basis: applied.basis,
		questions,
		unlinked: applied.results.filter((r) => r.basis === "unresolved").length,
		flips: applied.flips,
		rejected: applied.rejected,
		declined: applied.declined,
		results: applied.results.length <= 200 ? applied.results.map((r) => r.id) : [],
		gate: fresh ? gateOf(ctx, fresh) : target.commit_sha !== null ? nothingCounted() : null,
	};
	keepReceipt(ctx, batch, receipt);
	return receipt;
}

function brief(ctx: Ctx, raised: Raised, tests: number): QuestionBrief {
	const question = raised.question;
	const decision = raised.s === "carried" || raised.s === "decided" ? raised.decision : null;
	const signer = decision ? json<{ by: number }[]>(decision.signers)[0] : undefined;
	return {
		q: questionRef(question),
		kind: question.kind,
		title: question.title,
		state: decision ? "decided" : "open",
		how:
			raised.s === "carried"
				? "already decided"
				: raised.s === "decided"
					? "decided by rule"
					: raised.s === "attached"
						? "already open"
						: "new",
		answer: decision ? (json<{ is: string }>(decision.answer).is ?? null) : null,
		by: signer ? actorLabel(ctx.db, signer.by).name : null,
		tests,
	};
}

/** Tests that arrived with no case, by file: one `map` question per file, which a loose project's rule answers. */
function raiseMap(ctx: Ctx, file: string, producer: ActorKind): Raised {
	const tests = unlinkedInFile(ctx.db, ctx.project.id, file);
	return raise(ctx, {
		kind: "map",
		key: `file:${file}`,
		subject: { file },
		title: `${tests.length || "Some"} test${tests.length === 1 ? "" : "s"} in ${file} ${tests.length === 1 ? "has" : "have"} no case`,
		producer,
		evidence: {
			file,
			tests: tests.slice(0, 50).map((test) => ({ id: test.id, t: testRef(test), name: test.name })),
			count: tests.length,
		},
		material: { file, tests: tests.map((test) => test.id) },
		facts: [],
		refs: tests.slice(0, 20).map(testRef),
		runs: [],
	});
}

/** `processBatchSteps` run to the end without pausing: for start-up recovery and tests. */
export function processBatch(ctx: Ctx, batchId: number): ReportReceipt {
	const steps = processBatchSteps(ctx, batchId);
	for (let step = steps.next(); ; step = steps.next()) if (step.done) return step.value;
}

/**
 * A report, in two transactions. First what was sent is accepted: stored durably, and every run it matters to
 * marked as waiting, so from that commit on no reader is served the verdict from before the upload. Then it is
 * applied, in slices the server may answer reads between. A crash in between loses nothing: the batch is applied
 * on the next start, or by the client's retry.
 */
export function* reportSteps(ctx: Ctx, input: ReportInput): Generator<Pause, ReportReceipt, void> {
	const { batch, fresh } = acceptReport(ctx, input);
	if (!fresh && batch.receipt !== null) return { ...json<ReportReceipt>(batch.receipt), fresh: false };
	if (fresh) yield COMMIT;
	return yield* processBatchSteps(ctx, batch.id);
}

export const reportOp = defineOp({
	name: "report",
	output: REPLIES.report,
	summary:
		"Record results: a parsed CI report, one manual result, or an agent's batch. The producer is the token's actor.",
	input: ReportInput,
	needs: "record",
	scope: "project",
	effect: "write",
	mcp: "Record test results in one batch. Give `target` (the commit tested) or `run` (a planned run). Each result names a test by `key` or a case by ref.",
	steps: reportSteps,
});

// ── claim ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Splits a locus (`C-311#b7`, `C-311`, `req:WEB-290`, `pr:482`) into the case and step it names, if any. */
function locusOf(ctx: Ctx, on: string): { locus: string; row: CaseRow | null; step: string | null } {
	const [head, step] = on.split("#");
	const row = head && /^C-\d+$/i.test(head.trim()) ? mustCase(ctx.db, ctx.project.id, head.trim()) : null;
	return { locus: row ? `${caseRef(row)}${step ? `#${step}` : ""}` : on.trim(), row, step: step?.trim() || null };
}

export function claim(ctx: Ctx, input: ClaimInput): ClaimReply {
	const out: ClaimReply = { opened: [], known: [], reviewed: 0 };
	for (const entry of input.reviewed ?? []) {
		const [caseText, hash] = entry.split("@");
		if (!caseText || !hash) throw invalid(`reviewed entry "${entry}": expected C-311@<hash>`);
		const row = mustCase(ctx.db, ctx.project.id, caseText);
		if (row.head_hash !== hash) continue; // the case moved since it was read: that review is of an old version
		const basis = reviewBasis({ version: row.head_hash, about: input.about ?? null, patch: input.patch ?? null });
		if (!reviewedAt(ctx.db, row.id, basis, input.lens, ctx.actor.id)) {
			insertReview(ctx, { caseId: row.id, version: row.head, basis, lens: input.lens, about: input.about ?? null });
		}
		out.reviewed++;
	}
	for (const finding of input.findings) {
		const { locus, row, step } = locusOf(ctx, finding.on);
		const basis = row ? row.head_hash : contentHash(locus);
		const refs = [...(row ? [caseRef(row)] : []), ...(input.about ? [input.about] : [])];
		const raised = raise(ctx, {
			kind: "finding",
			key: `${locus}|${finding.category}`,
			subject: { on: locus, category: finding.category },
			title: `${finding.category}: ${clip(finding.note, 120)}`,
			producer: ctx.actor.kind,
			evidence: {
				on: locus,
				case: row ? caseRef(row) : null,
				caseTitle: row?.title ?? null,
				step,
				category: finding.category,
				note: finding.note,
				repro: finding.repro ?? null,
				suggest: finding.suggest ?? null,
				finderId: ctx.actor.id,
				lens: input.lens,
				about: input.about ?? null,
			},
			material: { on: locus, category: finding.category, basis },
			facts: [`author:${ctx.actor.kind}`, ...(finding.category === "defect" ? ["category:defect"] : [])],
			refs,
			runs: [],
		});
		insertFinding(ctx, {
			lens: input.lens,
			locus,
			caseId: row?.id ?? null,
			category: finding.category,
			note: finding.note,
			repro: finding.repro ?? null,
			suggest: finding.suggest ?? null,
			basis,
			question: raised.question.id,
		});
		if (raised.s === "open") out.opened.push(questionRef(raised.question));
		else out.known.push(knownOf(ctx, raised.question));
	}
	return out;
}

function knownOf(ctx: Ctx, question: QuestionRow): ClaimReply["known"][number] {
	const decision = question.decision !== null ? decisionById(ctx.db, question.decision) : null;
	const signer = decision ? json<{ by: number }[]>(decision.signers)[0] : undefined;
	return {
		q: questionRef(question),
		state: question.state,
		answer: decision ? (json<{ is: string }>(decision.answer).is ?? null) : null,
		by: signer ? actorLabel(ctx.db, signer.by).name : null,
	};
}

export const claimOp = defineOp({
	name: "claim",
	output: REPLIES.claim,
	summary: "Record a review and what it found. A review with no findings is still recorded.",
	input: ClaimInput,
	needs: "produce",
	scope: "project",
	effect: "write",
	mcp: "Review cases (`reviewed`, C-311@hash) at change `about` and commit `patch`. Record findings; `known` returns prior findings and answers.",
	run: claim,
});

// ── change ─────────────────────────────────────────────────────────────────────────────────────────────────

export function changeEnds(ctx: Ctx, input: ChangeInput): ChangeReply {
	// Where a change is, is said by a pipeline or a person, as where a commit is (see `resolveTarget`).
	if (ctx.actor.kind === "agent")
		throw forbidden("whether a change ended is said by a pipeline or a person: an agent's word about it is not taken");
	const key = input.change.toUpperCase().startsWith("PR:") ? input.change.toLowerCase() : input.change;
	const change = changeByKey(ctx.db, ctx.project.id, key);
	if (!change) throw notFound(`change ${input.change}`);
	const ended = input.state === "open" ? null : input.state;
	if (change.ended === ended) return { change: change.key, state: input.state, questions: [], already: true };
	const now = setChangeEnded(ctx, change, ended);
	const questions = ended === null ? askAgainAbout(ctx, now) : stopAskingAbout(ctx, now);
	return { change: now.key, state: input.state, questions, already: false };
}

export const changeOp = defineOp({
	name: "change",
	output: REPLIES.change,
	summary:
		"Say that a change ended (merged, or closed without merging) or is open again. An ended change is not asked about.",
	input: ChangeInput,
	needs: "record",
	scope: "project",
	effect: "write",
	mcp: null,
	run: changeEnds,
});

// ── plan ───────────────────────────────────────────────────────────────────────────────────────────────────

export function planRun(ctx: Ctx, input: PlanInput): PlanReply {
	const policy = currentPolicy(ctx.db, ctx.project.id);
	const cases = selectCases(ctx, input.select);
	const assignees = (input.assign ?? []).map((name) => {
		const actor = actorByName(ctx.db, name, ctx.project.id);
		if (!actor) throw notFound(`actor ${name}`);
		return actor.id;
	});
	const planned = plan(ctx, {
		name: input.name,
		cases,
		accepts: input.accepts ?? { self: true },
		require: input.require ?? defaultObligations(policy),
		assignees,
	});
	// Evidence already recorded may fill the new run with failures. Each is asked about (or its standing answer
	// carried) exactly as if a report had just shown it, so the run is never blocked by a failure nobody is asked
	// about, and a later decision about the cause reaches this run too.
	for (const shown of failuresShown(ctx, planned.run)) {
		raiseFailure(ctx, {
			group: shown.group,
			target: mustTarget(ctx.db, shown.target),
			by: shown.by,
			producer: actorLabel(ctx.db, shown.by).kind,
		});
	}
	refold(ctx, [planned.run.id]);
	return { run: runRef(planned.run), slots: planned.slots, already: planned.already };
}

export const planOp = defineOp({
	name: "plan",
	output: REPLIES.plan,
	summary:
		"Start a run: choose cases, say which results count and what completes it. Evidence already recorded fills it at once.",
	input: PlanInput,
	needs: "plan",
	scope: "project",
	effect: "write",
	mcp: null,
	run: planRun,
});

// ── decide ─────────────────────────────────────────────────────────────────────────────────────────────────

export function decide(ctx: Ctx, input: DecideInput): DecideReply[] {
	if ("undo" in input) return [undo(ctx, { q: input.undo, ifDecision: input.ifDecision, reason: input.reason })];
	if ("all" in input) return input.all.map((one) => answer(ctx, { ...one, reason: one.reason ?? input.reason }));
	return [answer(ctx, { q: input.q, onEvidence: input.onEvidence, answer: input.answer, reason: input.reason })];
}

export const decideOp = defineOp({
	name: "decide",
	output: REPLIES.decide,
	summary:
		"Answer a question, or withdraw a decision. Policy says whether your answer settles it, is advice, or is refused.",
	input: DecideInput,
	needs: "produce",
	scope: "project",
	effect: "write",
	mcp: "Answer inbox using evidenceHash as onEvidence. Status: decided, advised=person decides, forbidden, invalid, already, reopened, conflict=evidence or decision changed. Choose from answers. Withdraw with undo and ifDecision=reply.decision.",
	run: decide,
});

export type { Raise };
