// The operations that produce evidence, request it, or decide: propose, report, claim, plan, decide.
// Each composes the owning modules; none of them writes a table itself.
import { contentHash } from "../../core/hash.ts";
import type { ActorKind } from "../../core/kinds.ts";
import {
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
import { answer, type Raise, type Raised, raise, refold, undo } from "../decisions/decisions.ts";
import { raiseAdopt } from "../decisions/kinds.ts";
import { decisionById, latestByFingerprint, type QuestionRow, questionRef } from "../decisions/questions.ts";
import {
	accept,
	applySteps,
	type BatchRow,
	batchById,
	changeById,
	ensureTarget,
	failsOnBase,
	markProcessed,
	mustTarget,
	type TargetRow,
	testRef,
	unlinkedInFile,
} from "../evidence/evidence.ts";
import { insertFinding, insertReview, reviewedAt } from "../evidence/findings.ts";
import { actorByName, actorLabel } from "../identity/identity.ts";
import type { Ctx } from "../kernel/ctx.ts";
import { json } from "../kernel/db.ts";
import { conflict, invalid, notFound } from "../kernel/errors.ts";
import { currentPolicy } from "../policy/policy.ts";
import {
	applyBatchSteps,
	defaultObligations,
	type FailingGroup,
	gateOf,
	mustRun,
	noteAccepted,
	pinnedVersions,
	plan,
	runById,
	runRef,
	runsFor,
} from "../runs/runs.ts";
import { selectCases } from "../suite/read.ts";
import { type CaseRow, caseById, caseRef, mustCase, seal } from "../suite/suite.ts";
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
	summary:
		"Create or change cases, folders, links or the policy. Saving and proposing are the same call; policy decides what happens next.",
	input: ProposeInput,
	needs: "produce",
	scope: "project",
	effect: "write",
	mcp: "Create or change test cases. Each edit of an existing case names the version it was made on (`base`). Reply: adopted (it is current), open (a person must accept it) or conflict.",
	run: propose,
});

// ── report ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Step one of a report: store it durably and mark every run it matters to as waiting for it. */
export function acceptReport(ctx: Ctx, input: ReportInput): { batch: BatchRow; fresh: boolean } {
	const run = input.run ? mustRun(ctx.db, ctx.project.id, input.run) : null;
	if (run?.state === "closed") throw conflict(`${runRef(run)} is closed; withdraw its sign-off to reopen it`);
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

	const accepted = accept(ctx, { target, run: run?.id ?? null, report: input, nonce: input.cmd ?? `${ctx.seq}` });
	if (accepted.fresh) noteAccepted(ctx, runsFor(ctx, target, run?.id ?? null), accepted.batch.seq);
	return accepted;
}

/**
 * Step two: apply a staged batch. In one transaction: results with their basis, the runs they fill, one question
 * per cause of failure, unlinked tests, and each run's new verdict.
 */
export function* processBatchSteps(ctx: Ctx, batchId: number): Generator<Pause, ReportReceipt, void> {
	const batch = batchById(ctx.db, batchId);
	if (!batch) throw notFound(`batch ${batchId}`);
	const target = mustTarget(ctx.db, batch.target);
	const runs = runsFor(ctx, target, batch.run);
	const pinned = batch.run !== null ? pinnedVersions(ctx.db, batch.run) : new Map<number, number>();
	const applied = yield* applySteps(ctx, batch, (caseId) => pinned.get(caseId) ?? null);
	const groups = yield* applyBatchSteps(ctx, { batch, target, applied: applied.results, runs });
	const producer = actorLabel(ctx.db, batch.actor).kind;

	const questions: QuestionBrief[] = [];
	for (const group of groups) {
		const raised = raiseFailure(ctx, { group, target, batch, producer });
		questions.push(brief(ctx, raised, group.tests.length));
	}

	const files = new Set<string>();
	for (const result of applied.results) {
		if (result.fresh && result.test.kind === "auto" && result.test.case_id === null)
			files.add(result.test.file ?? "(no file)");
	}
	for (const file of files) raiseMap(ctx, file, producer);

	refold(
		ctx,
		runs.map((run) => run.id),
		{ dissolveStale: true },
	);
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
		results: applied.results.length <= 200 ? applied.results.map((r) => r.id) : [],
		gate: fresh ? gateOf(ctx, fresh) : null,
	};
	markProcessed(ctx, batch, applied.counts, receipt);
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

function raiseFailure(
	ctx: Ctx,
	input: { group: FailingGroup; target: TargetRow; batch: BatchRow; producer: ActorKind },
): Raised {
	const { group, target, batch } = input;
	const scopeKind = group.scope.startsWith("change:") ? "change" : group.scope.startsWith("line:") ? "trunk" : "run";
	const key = `${group.signature.hash}|${group.scope}`;
	// One question per cause: an occurrence adds its tests to the open question instead of opening another.
	const open = latestByFingerprint(ctx.db, ctx.project.id, contentHash({ kind: "failure", key }));
	const earlier =
		open?.state === "open"
			? json<{ tests?: { id: number; t: string; name: string; case: string | null }[]; producers?: number[] }>(
					open.evidence,
				)
			: {};
	const tests = new Map((earlier.tests ?? []).map((test) => [test.id, test]));
	for (const test of group.tests) {
		const row = test.case_id !== null ? caseById(ctx.db, test.case_id) : null;
		tests.set(test.id, { id: test.id, t: testRef(test), name: test.name, case: row ? caseRef(row) : null });
	}
	const hints: string[] = [];
	if (
		scopeKind === "change" &&
		group.tests.length > 0 &&
		group.tests.every((test) => failsOnBase(ctx.db, target, test.id, group.signature.id))
	) {
		hints.push("hint:fails-on-base");
	}
	if (group.disputed) hints.push("hint:disputed");
	const change = target.change !== null ? changeById(ctx.db, target.change) : null;
	const listed = [...tests.values()];
	const cases = [...new Set(listed.flatMap((test) => (test.case ? [test.case] : [])))];
	return raise(ctx, {
		kind: "failure",
		key,
		subject: { signature: group.signature.id, scope: group.scope },
		title: group.signature.text.slice(0, 160),
		producer: input.producer,
		evidence: {
			signature: { class: group.signature.class, text: group.signature.text },
			scope: change ? change.key : group.scope,
			message: group.message,
			tests: listed.slice(0, 50),
			count: listed.length,
			target: target.commit_sha ? target.commit_sha.slice(0, 12) : target.what,
			branch: target.branch,
			hints: hints.map((hint) => hint.slice(5)),
			producers: [...new Set([...(earlier.producers ?? []), batch.actor])],
			sample: group.results[0] ?? null,
		},
		material: { signature: group.signature.id, scope: group.scope, hints },
		facts: [`scope:${scopeKind}`, ...hints],
		refs: [
			`scope:${group.scope}`,
			...group.runs.map(runRef),
			...(change ? [change.key] : []),
			...listed.slice(0, 20).map((test) => test.t),
			...cases.slice(0, 20),
		],
		runs: group.runs,
		target: target.id,
	});
}

/** Tests that arrived with no case, by file: one `map` question per file, which a loose project's rule answers. */
function raiseMap(ctx: Ctx, file: string, producer: ActorKind): Raised {
	const tests = file === "(no file)" ? [] : unlinkedInFile(ctx.db, ctx.project.id, file);
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
	summary:
		"Record results: a parsed CI report, one manual result, or an agent's batch. The producer is the token's actor.",
	input: ReportInput,
	needs: "produce",
	scope: "project",
	effect: "write",
	mcp: "Record test results in one batch. Give `target` (the commit tested) or `run` (a planned run). Each result names a test by `key` or a case by ref. Reply: counts, the questions raised per cause of failure, and the gate.",
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
		const basis = contentHash({ version: row.head_hash, about: input.about ?? null });
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
			title: `${finding.category}: ${finding.note.slice(0, 120)}`,
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
				finder: ctx.actor.name,
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
	summary: "Record a review and what it found. A review with no findings is still recorded.",
	input: ClaimInput,
	needs: "produce",
	scope: "project",
	effect: "write",
	mcp: "Record a review: the cases you read (`reviewed`, as C-311@hash) and your findings. A finding already raised comes back under `known` with its answer, so you do not raise it twice.",
	run: claim,
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
	refold(ctx, [planned.run.id]);
	return { run: runRef(planned.run), slots: planned.slots, already: planned.already };
}

export const planOp = defineOp({
	name: "plan",
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
	if ("undo" in input) return [undo(ctx, { q: input.undo, reason: input.reason })];
	if ("all" in input) return input.all.map((one) => answer(ctx, { ...one, reason: one.reason ?? input.reason }));
	return [answer(ctx, { q: input.q, onEvidence: input.onEvidence, answer: input.answer, reason: input.reason })];
}

export const decideOp = defineOp({
	name: "decide",
	summary:
		"Answer a question, or withdraw a decision. Policy says whether your answer settles it, is advice, or is refused.",
	input: DecideInput,
	needs: "produce",
	scope: "project",
	effect: "write",
	mcp: 'Answer a question from `inbox`. Pass the `evidenceHash` you saw as `onEvidence`. Reply status: decided, advised (recorded; a person decides), conflict (evidence changed) or forbidden. Failure answers: {"is":"defect"|"test"|"expected"|"flaky"|"infra"}.',
	run: decide,
});

export type { Raise };
