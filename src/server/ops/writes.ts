// The operations that produce evidence, request it, or decide: propose, report, claim, plan, decide.
// Each composes the owning modules; none of them writes a table itself.
import { contentHash } from "../../core/hash.ts";
import { type ActorKind, Ask, describeAsk } from "../../core/kinds.ts";
import {
	AnnounceInput,
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
import type { TargetMatch } from "../../core/runs.ts";
import { clip } from "../../core/text.ts";
import {
	answerSteps,
	askAgainAbout,
	askWhereCommitIs,
	type Raise,
	type Raised,
	raise,
	raiseFailure,
	raiseFailures,
	raiseSteps,
	recordMergeReceipt,
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
	cancelBatch,
	changeById,
	changeByKey,
	ensureTarget,
	firstCountedReport,
	keepReceipt,
	landChange,
	markProcessed,
	mustTarget,
	NO_FILE,
	observeEndingHead,
	scopeEnded,
	setChangeEnded,
	type TargetRow,
	testRef,
	unlinkedInFile,
} from "../evidence/evidence.ts";
import { insertFinding, insertReview, reviewBasis, reviewedAt } from "../evidence/findings.ts";
import { recordQuarantines, validateQuarantineEdit } from "../evidence/quarantine.ts";
import { announce } from "../evidence/releases.ts";
import {
	actorByName,
	actorLabel,
	batchAllowed,
	forgetBatchAdmission,
	keepBatchAdmission,
} from "../identity/identity.ts";
import { begunCommand, type Ctx, finishCommand, stampSeq } from "../kernel/ctx.ts";
import { json } from "../kernel/db.ts";
import { AcceptedRefusal, conflict, forbidden, invalid, notFound } from "../kernel/errors.ts";
import { complete } from "../kernel/steps.ts";
import { currentPolicy } from "../policy/policy.ts";
import {
	applyBatchSteps,
	changeRunsOf,
	defaultObligations,
	describeAccepts,
	ensureChangeRun,
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
import { enrollCommitStatus } from "../statuses/statuses.ts";
import { selectCases } from "../suite/read.ts";
import { type CaseRow, caseRef, mustCase, sealSteps } from "../suite/suite.ts";
import { COMMIT, defineOp, type Pause } from "./registry.ts";

export const announceOp = defineOp({
	name: "announce",
	summary: "Announce a deployment and bind its build label to an attested artifact. Pipelines and human admins only.",
	input: AnnounceInput,
	output: REPLIES.announce,
	needs: "record",
	scope: "project",
	effect: "write",
	mcp: null,
	run: announce,
});

// ── propose ────────────────────────────────────────────────────────────────────────────────────────────────

export async function propose(ctx: Ctx, input: ProposeInput): Promise<ProposeReply> {
	return await complete(proposeSteps(ctx, input));
}

export async function* proposeSteps(ctx: Ctx, input: ProposeInput): AsyncGenerator<undefined, ProposeReply, void> {
	for (const edit of input.edits) if (edit.op === "quarantine") await validateQuarantineEdit(ctx, edit);
	const sealed = yield* sealSteps(ctx, { edits: input.edits, reason: input.reason });
	if (!sealed)
		return { proposal: null, status: "adopted", question: null, needs: null, cases: [], placements: [], conflicts: [] };
	const raised = yield* await raiseAdopt(ctx, { raise: raiseSteps }, sealed);
	const base = {
		proposal: `P-${sealed.proposal.no}`,
		question: questionRef(raised.question),
		conflicts: sealed.conflicts,
	};
	if (raised.s === "decided") {
		const effects = raised.effects as {
			cases?: ProposeReply["cases"];
			placements?: ProposeReply["placements"];
			rejected?: boolean;
		};
		return {
			...base,
			status: effects.rejected ? "rejected" : "adopted",
			needs: null,
			cases: effects.cases ?? [],
			placements: effects.placements ?? [],
		};
	}
	const ask = Ask.parse(json(raised.question.ask));
	const needs = ask.who;
	return {
		...base,
		status: sealed.conflicts.length > 0 ? "conflict" : "open",
		needs:
			sealed.conflicts.length > 0
				? `the case changed since the base you named: answer ${questionRef(raised.question)} with a merge, or reject it and propose again on the current version`
				: needs.startsWith("role:")
					? describeAsk(ask)
					: needs === "admin"
						? "an admin"
						: "a member who is not an agent",
		cases: [],
		placements: [],
	};
}

export const proposeOp = defineOp({
	name: "propose",
	output: REPLIES.propose,
	present: (actor, reply) => ({ ...reply, placements: actor.can.includes("read") ? reply.placements : [] }),
	summary:
		"Create or change cases, folders, links or the policy. Saving and proposing are the same call; policy decides what happens next.",
	input: ProposeInput,
	needs: "produce",
	scope: "project",
	effect: "write",
	mcp: "Propose cases at base: adopted=current, open=needs acceptance, conflict=resolve, rejected.",
	steps: proposeSteps,
});

// ── report ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Step one of a report: store it durably and mark every run it matters to as waiting for it. A report that names
 * both a run and a target is refused when the run does not count that target: naming a run is not a way to make
 * evidence about another build count for it.
 */
export async function acceptReport(ctx: Ctx, input: ReportInput): Promise<{ batch: BatchRow; fresh: boolean }> {
	if (input.model !== undefined && ctx.actor.kind !== "agent")
		throw invalid("Only an agent's report can name a model.");
	if (input.nothingRequired && (ctx.actor.kind !== "ci" || !input.target || !("commit" in input.target)))
		throw invalid("nothingRequired needs a CI actor and an explicit commit target");
	if (input.nothingRequired && input.run !== undefined)
		throw invalid("nothing required is a declaration about a commit, not a planned run");
	if (input.shard && (input.run !== undefined || !input.target || !("commit" in input.target)))
		throw invalid("a shard is part of a job's report about a commit: give the commit as the target");
	const run = input.run ? await mustRun(ctx.db, ctx.project.id, input.run) : null;
	if (run?.state === "closed" && !json<{ commit?: string }>(run.accepts).commit)
		throw conflict(`${runRef(run)} is closed; withdraw its sign-off to reopen it`);
	let target: TargetRow;
	// An explicit head observation waits for batch deduplication: retrying an old report must not move it again.
	if (input.target) target = await ensureTarget(ctx, input.target, !("head" in input.target));
	else if (run) {
		const accepts = json<TargetMatch>(run.accepts);
		target = "self" in accepts ? await ensureTarget(ctx, { session: runRef(run) }) : await ensureTarget(ctx, accepts);
	} else throw invalid("a report needs a target (what was tested) or a run");
	if (run && !(await runAccepts(ctx.db, run, target))) {
		throw invalid(
			`${runRef(run)} counts ${describeAccepts(run)}, and this report is for another target. Report it without \`run\` to record it for its own target.`,
		);
	}
	await refreshCommitScope(ctx, target);

	const accepted = await accept(ctx, { target, run: run?.id ?? null, report: input, nonce: input.cmd ?? `${ctx.seq}` });
	if (accepted.fresh) {
		await keepBatchAdmission(ctx, accepted.batch.id);
		if (input.target && "head" in input.target) await ensureTarget(ctx, input.target);
		const runs = await runsFor(ctx, target, run?.id ?? null, ctx.actor.kind);
		await noteAccepted(ctx, runs, accepted.batch.seq);
		// The first report of a commit that a gate counts says where the commit is, and that is so from this
		// moment (`ensureTarget`). Every other run that counts the commit waits for this report too: until it is
		// applied and they are recomputed, none of them goes on showing a verdict from before the move.
		await noteAccepted(ctx, await alsoWaiting(ctx, accepted.batch, target, runs), accepted.batch.seq);
		await enrollCommitStatus(ctx, target);
	}
	// Target metadata is accepted even when this report's results were already processed.
	// Retargeting must therefore update inherited standing before a saved receipt can return.
	if (ctx.changedBases.size > 0) await refold(ctx, [], { dissolveStale: true });
	return accepted;
}

/**
 * The planned runs that count a batch's commit without counting its target (another environment, another
 * repository of a run that names none), when the batch is the first report of the commit that a gate counts.
 * They wait for it with the runs it folds into, from acceptance to application, and are recomputed with them.
 */
async function alsoWaiting(ctx: Ctx, batch: BatchRow, target: TargetRow, runs: readonly RunRow[]): Promise<RunRow[]> {
	if (target.commit_sha === null || !(await firstCountedReport(ctx.db, batch, target))) return [];
	const folded = new Set(runs.map((run) => run.id));
	return (
		await Array.fromAsync(await plannedCounting(ctx.db, ctx.project.id, target.commit_sha), async (id) => {
			const run = folded.has(id) ? null : await runById(ctx.db, id);
			return run ? [run] : [];
		})
	).flat();
}

/**
 * Step two: apply a staged batch. In one transaction: results with their basis, the runs they fill, one question
 * per cause of failure, unlinked tests, and each run's new verdict.
 */
export async function* processBatchSteps(
	ctx: Ctx,
	batchId: number,
): AsyncGenerator<Pause<ReportReceipt>, ReportReceipt, void> {
	const batch = await batchById(ctx.db, batchId);
	if (!batch) throw notFound(`batch ${batchId}`);
	ctx.now = batch.at;
	if (batch.state === "cancelled") throw new AcceptedRefusal();
	if (batch.state === "processed" && batch.receipt !== null)
		return { ...json<ReportReceipt>(batch.receipt), fresh: false };
	if (!(await batchAllowed(ctx.app, ctx.db, batch.id, batch.actor, batch.project))) {
		const target = await mustTarget(ctx.db, batch.target);
		const producer = (await actorLabel(ctx.db, batch.actor)).kind;
		const runs = await runsFor(ctx, target, batch.run, producer);
		const waiting = await alsoWaiting(ctx, batch, target, runs);
		await cancelBatch(ctx, batch.id);
		await forgetBatchAdmission(ctx.db, batch.id);
		await noteApplied(ctx, [...new Map([...runs, ...waiting].map((run) => [run.id, run])).values()], batch.seq);
		await refold(
			ctx,
			[...runs, ...waiting].map((run) => run.id),
			{ dissolveStale: true },
		);
		for (const run of [...runs, ...waiting]) ctx.touched.add(runRef(run));
		const cmd = await begunCommand(ctx, { op: "report", seq: batch.seq });
		if (cmd) await finishCommand(ctx, { id: cmd, outcome: { refused: "report" } });
		await stampSeq(ctx);
		const event = {
			project: ctx.project.key,
			seq: ctx.seq,
			op: "report",
			actor: ctx.actor.name,
			touched: [...ctx.touched],
		};
		await ctx.app.recordChange(ctx.db, event);
		throw new AcceptedRefusal();
	}
	const target = await mustTarget(ctx.db, batch.target);
	const producer = (await actorLabel(ctx.db, batch.actor)).kind;
	const runs = await runsFor(ctx, target, batch.run, producer);
	const pinned = batch.run !== null ? await pinnedVersions(ctx.db, batch.run) : new Map<number, number>();
	const applied = yield* applySteps(ctx, batch, producer, (caseId) => pinned.get(caseId) ?? null);
	await recordQuarantines(ctx, applied.results);
	const groups = yield* applyBatchSteps(ctx, { batch, target, applied: applied.results, runs });

	const questions: QuestionBrief[] = [];
	const asking: typeof groups = [];
	for (const group of groups) {
		// Ended change reports ask only when an open planned run still waits for an answer.
		if (
			!(await scopeEnded(ctx.db, group.scope)) ||
			group.runs.some((run) => run.origin === "planned" && run.state === "open")
		)
			asking.push(group);
	}
	const raised = await raiseFailures(
		ctx,
		asking.map((group) => ({ group, target, by: batch.actor, producer })),
	);
	for (const [index, question] of raised.entries())
		questions.push(await brief(ctx, question, asking[index]?.tests.length ?? 0));

	const files = new Set<string>();
	for (const result of applied.results) {
		if (result.fresh && result.test.kind === "auto" && result.test.case_id === null)
			files.add(result.test.file ?? NO_FILE);
	}
	for (const file of files) {
		yield* raiseMapSteps(ctx, file, producer);
		yield;
	}

	// The batch is applied before the runs are folded: a run that requires this job must count it.
	await markProcessed(ctx, batch, applied.counts);
	// The first report of a commit that a gate counts says where the commit is (only an agent may have said so
	// before): every run that counts the commit is recomputed with the others, because its failures are
	// answered there from now on.
	const waiting = await alsoWaiting(ctx, batch, target, runs);
	if (target.commit_sha !== null && (await firstCountedReport(ctx.db, batch, target))) {
		for (const id of await plannedCounting(ctx.db, ctx.project.id, target.commit_sha)) ctx.recompute.add(id);
		await askWhereCommitIs(ctx, target);
	}
	await noteApplied(ctx, waiting, batch.seq);
	// They are folded with the others below, after the report is marked applied for them: a question asked on
	// the way here may already have recomputed them while they were still waiting.
	for (const run of waiting) ctx.recompute.add(run.id);
	await refold(
		ctx,
		runs.map((run) => run.id),
		{ dissolveStale: true },
	);
	// Whatever else asked on the way here (a commit that found its place, a run recomputed): a change that has
	// ended is not asked about.
	const ended = target.change !== null ? await changeById(ctx.db, target.change) : null;
	if (ended && ended.ended !== null) await stopAskingAbout(ctx, ended);
	const gated = runs.find((run) => run.origin === "change") ?? runs.find((run) => run.id === batch.run) ?? null;
	const fresh = gated ? await runById(ctx.db, gated.id) : null;
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
		gate: fresh ? await gateOf(ctx, fresh) : target.commit_sha !== null ? nothingCounted() : null,
	};
	await keepReceipt(ctx, batch, receipt);
	const acceptedCommand = await begunCommand(ctx, { op: "report", seq: batch.seq });
	if (acceptedCommand) await finishCommand(ctx, { id: acceptedCommand, outcome: receipt });
	await forgetBatchAdmission(ctx.db, batch.id);
	return receipt;
}

async function brief(ctx: Ctx, raised: Raised, tests: number): Promise<QuestionBrief> {
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
		by: signer ? (await actorLabel(ctx.db, signer.by)).name : null,
		tests,
	};
}

/** Tests that arrived with no case, by file: one `map` question per file, which a loose project's rule answers. */
async function* raiseMapSteps(ctx: Ctx, file: string, producer: ActorKind): AsyncGenerator<undefined, Raised, void> {
	const tests = await unlinkedInFile(ctx.db, ctx.project.id, file);
	return yield* raiseSteps(ctx, {
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
export async function processBatch(ctx: Ctx, batchId: number): Promise<ReportReceipt> {
	const steps = processBatchSteps(ctx, batchId);
	for (let step = await steps.next(); ; step = await steps.next()) if (step.done) return step.value;
}

/**
 * Applies a batch that was accepted and not applied (`recoverAccepted`) and finishes the command its acceptance
 * bound, in the same transaction, as the request would have: the command is done, with the receipt as its reply.
 * A batch accepted without a command id has none to finish.
 */
export async function applyAccepted(ctx: Ctx, batch: BatchRow): Promise<ReportReceipt> {
	const receipt = await processBatch(ctx, batch.id);
	const cmd = await begunCommand(ctx, { op: reportOp.name, seq: batch.seq });
	if (cmd) await finishCommand(ctx, { id: cmd, outcome: receipt });
	return receipt;
}

/**
 * A report, in two transactions. First what was sent is accepted: stored durably, and every run it matters to
 * marked as waiting, so from that commit on no reader is served the verdict from before the upload. Then it is
 * applied, in slices the server may answer reads between. A crash in between loses nothing: the batch is applied
 * on the next start, or by the client's retry.
 */
export async function* reportSteps(
	ctx: Ctx,
	input: ReportInput,
): AsyncGenerator<Pause<ReportReceipt>, ReportReceipt, void> {
	const { batch, fresh } = await acceptReport(ctx, input);
	if (!fresh && batch.receipt !== null) return { ...json<ReportReceipt>(batch.receipt), fresh: false };
	const target = await mustTarget(ctx.db, batch.target);
	const runs = await runsFor(ctx, target, batch.run, ctx.actor.kind);
	const gated = runs.find((run) => run.origin === "change") ?? runs.find((run) => run.id === batch.run);
	const pending: ReportReceipt = {
		batch: batch.id,
		fresh,
		target: target.commit_sha
			? `${target.commit_sha.slice(0, 7)}${target.branch ? ` (${target.branch})` : ""}`
			: target.what,
		counts: { total: 0, pass: 0, fail: 0, skip: 0, error: 0, blocked: 0 },
		basis: { exact: 0, assumed: 0, unresolved: 0 },
		questions: [],
		unlinked: 0,
		flips: 0,
		rejected: [],
		declined: [],
		results: [],
		gate: {
			...(gated ? await gateOf(ctx, gated) : nothingCounted()),
			verdict: "pending",
			reason: "pending: report accepted; waiting for application",
		},
	};
	yield { commit: COMMIT, pending };
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
	mcp: "Report to target or run; tests by key or case.",
	steps: reportSteps,
});

// ── claim ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Splits a locus (`C-311#b7`, `C-311`, `req:WEB-290`, `pr:482`) into the case and step it names, if any. */
async function locusOf(ctx: Ctx, on: string): Promise<{ locus: string; row: CaseRow | null; step: string | null }> {
	const [head, step] = on.split("#");
	const row = head && /^C-\d+$/i.test(head.trim()) ? await mustCase(ctx.db, ctx.project.id, head.trim()) : null;
	return { locus: row ? `${caseRef(row)}${step ? `#${step}` : ""}` : on.trim(), row, step: step?.trim() || null };
}

export async function claim(ctx: Ctx, input: ClaimInput): Promise<ClaimReply> {
	const out: ClaimReply = { opened: [], known: [], reviewed: 0 };
	for (const entry of input.reviewed ?? []) {
		const [caseText, hash] = entry.split("@");
		if (!caseText || !hash) throw invalid(`reviewed entry "${entry}": expected C-311@<hash>`);
		const row = await mustCase(ctx.db, ctx.project.id, caseText);
		if (row.head_hash !== hash) continue; // the case moved since it was read: that review is of an old version
		const basis = reviewBasis({ version: row.head_hash, about: input.about ?? null, patch: input.patch ?? null });
		if (!(await reviewedAt(ctx.db, row.id, basis, input.lens, ctx.actor.id))) {
			await insertReview(ctx, {
				caseId: row.id,
				version: row.head,
				basis,
				lens: input.lens,
				about: input.about ?? null,
			});
		}
		out.reviewed++;
	}
	for (const finding of input.findings) {
		const { locus, row, step } = await locusOf(ctx, finding.on);
		const basis = row ? row.head_hash : contentHash(locus);
		const refs = [...(row ? [caseRef(row)] : []), ...(input.about ? [input.about] : [])];
		const raised = await raise(ctx, {
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
		await insertFinding(ctx, {
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
		else out.known.push(await knownOf(ctx, raised.question));
	}
	return out;
}

async function knownOf(ctx: Ctx, question: QuestionRow): Promise<ClaimReply["known"][number]> {
	const decision = question.decision !== null ? await decisionById(ctx.db, question.decision) : null;
	const signer = decision ? json<{ by: number }[]>(decision.signers)[0] : undefined;
	return {
		q: questionRef(question),
		state: question.state,
		answer: decision ? (json<{ is: string }>(decision.answer).is ?? null) : null,
		by: signer ? (await actorLabel(ctx.db, signer.by)).name : null,
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
	mcp: "Review cases C-311@hash at about/patch; known reads prior findings.",
	run: claim,
});

// ── change ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Scope changes preserve the exact gate and recompute every planned run that counts the commit. */
async function refreshCommitScope(ctx: Ctx, target: TargetRow): Promise<void> {
	const run = await ensureChangeRun(ctx, target, false);
	if (!run || !ctx.recompute.has(run.id) || target.commit_sha === null) return;
	await askWhereCommitIs(ctx, target);
	await refold(ctx, [run.id, ...(await plannedCounting(ctx.db, ctx.project.id, target.commit_sha))], {
		dissolveStale: true,
	});
}

export async function changeEnds(ctx: Ctx, input: ChangeInput): Promise<ChangeReply> {
	// Where a change is, is said by a pipeline or a person, as where a commit is (see `resolveTarget`).
	if (ctx.actor.kind === "agent")
		throw forbidden("whether a change ended is said by a pipeline or a person: an agent's word about it is not taken");
	if (input.landing && input.state !== "merged") throw invalid("a landing is reported only for a merged change");
	const key = input.change.toUpperCase().startsWith("PR:") ? input.change.toLowerCase() : input.change;
	const change = await changeByKey(ctx.db, ctx.project.id, key);
	if (!change) throw notFound(`change ${input.change}`);
	const ended = input.state === "open" ? null : input.state;
	const same = change.ended === ended;
	const headed = input.head ? await observeEndingHead(ctx, change, input.head) : change;
	const moved = headed !== change;
	const now =
		ended === "merged"
			? await recordMergeReceipt(ctx, headed)
			: same
				? headed
				: await setChangeEnded(ctx, headed, ended);
	// An open change whose head moved is asked about as a report that moved it would be: the old head's questions
	// dissolve, and the new head's unexplained failures are asked about.
	if (ended === null && moved) await refold(ctx, await changeRunsOf(ctx.db, now.id), { dissolveStale: true });
	const questions =
		ended === null
			? same && !moved
				? []
				: await askAgainAbout(ctx, now)
			: same
				? []
				: await stopAskingAbout(ctx, now);
	const landed = input.landing ? await landChange(ctx, now, input.landing) : null;
	if (landed) await refreshCommitScope(ctx, landed);
	return {
		change: now.key,
		state: input.state,
		questions,
		already: same && !moved && landed === null && now.receipt === change.receipt,
	};
}

export const changeOp = defineOp({
	name: "change",
	output: REPLIES.change,
	summary:
		"Say that a change ended or is open again. A merge records the head gate when reported. An ended change is not asked about.",
	input: ChangeInput,
	needs: "record",
	scope: "project",
	effect: "write",
	mcp: null,
	run: changeEnds,
});

// ── plan ───────────────────────────────────────────────────────────────────────────────────────────────────

export async function planRun(ctx: Ctx, input: PlanInput): Promise<PlanReply> {
	const policy = await currentPolicy(ctx.db, ctx.project.id);
	const cases = await selectCases(ctx, input.select);
	const assignees = await Array.fromAsync(input.assign ?? [], async (name) => {
		const actor = await actorByName(ctx.db, name, ctx.project.id);
		if (!actor) throw notFound(`actor ${name}`);
		return actor.id;
	});
	const planned = await plan(ctx, {
		name: input.name,
		cases,
		accepts: input.accepts ?? { self: true },
		require: input.require ?? defaultObligations(policy),
		assignees,
	});
	// Evidence already recorded may fill the new run with failures. Each is asked about (or its standing answer
	// carried) exactly as if a report had just shown it, so the run is never blocked by a failure nobody is asked
	// about, and a later decision about the cause reaches this run too.
	for (const shown of await failuresShown(ctx, planned.run)) {
		await raiseFailure(ctx, {
			group: shown.group,
			target: await mustTarget(ctx.db, shown.target),
			by: shown.by,
			producer: (await actorLabel(ctx.db, shown.by)).kind,
		});
	}
	await refold(ctx, [planned.run.id]);
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

export async function decide(ctx: Ctx, input: DecideInput): Promise<DecideReply[]> {
	return await complete(decideSteps(ctx, input));
}

export async function* decideSteps(ctx: Ctx, input: DecideInput): AsyncGenerator<undefined, DecideReply[], void> {
	if ("undo" in input) {
		const withdrawals =
			typeof input.undo === "string"
				? [{ q: input.undo, ifDecision: "ifDecision" in input ? input.ifDecision : undefined }]
				: input.undo;
		return await Array.fromAsync(withdrawals, async (one) => await undo(ctx, { ...one, reason: input.reason }));
	}
	if ("all" in input) {
		const replies: DecideReply[] = [];
		for (const one of input.all) replies.push(yield* answerSteps(ctx, { ...one, reason: one.reason ?? input.reason }));
		return replies;
	}
	return [yield* answerSteps(ctx, input)];
}

export const decideOp = defineOp({
	name: "decide",
	output: REPLIES.decide,
	present: (actor, replies) =>
		actor.can.includes("read")
			? replies
			: replies.map((reply) => ({
					...reply,
					effects:
						reply.effects && "placements" in reply.effects ? { ...reply.effects, placements: [] } : reply.effects,
				})),
	summary:
		"Answer a question, or withdraw a decision. Policy says whether your answer settles it, is advice, or is refused.",
	input: DecideInput,
	needs: "produce",
	scope: "project",
	effect: "write",
	mcp: "onEvidence=evidenceHash. decided, advised=person decides, forbidden, invalid, already, reopened, conflict=changed. undo requires ifDecision.",
	steps: decideSteps,
});

export type { Raise };
