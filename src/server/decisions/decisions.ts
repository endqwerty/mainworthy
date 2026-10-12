// Decisions: the only writer of standing. Questions are raised here, one per cause; answers are checked against
// the policy here; and `settle` is the single place that mints a witness and applies a decision's effect.
//
// Three rules hold everywhere (decision 0008):
// - a detector suggests, a decision excuses: nothing in this file changes standing without a decision row;
// - an answer names the evidence it saw, and an answer on changed evidence is a conflict, not a decision;
// - a decision carries forward only while its hold stands, and is asked again with the old answer shown when not.
import { contentHash } from "../../core/hash.ts";
import {
	type ActorKind,
	ANSWERS,
	type AnyAnswer,
	type Ask,
	applicableAnswers,
	type Blocks,
	describeAsk,
	type Kind,
	standingOf,
} from "../../core/kinds.ts";
import type { DecideReply, QuestionItem } from "../../core/ops.ts";
import { clip } from "../../core/text.ts";
import { changeById, mustTarget, signatureById, type TargetRow, testRef } from "../evidence/evidence.ts";
import { actorLabel, ruleActor } from "../identity/identity.ts";
import type { Ctx } from "../kernel/ctx.ts";
import { type Db, json } from "../kernel/db.ts";
import { OpError } from "../kernel/errors.ts";
import { claimMint } from "../kernel/witness.ts";
import { clauseFor, currentPolicy } from "../policy/policy.ts";
import {
	type Blocker,
	causeKey,
	type FailingGroup,
	failingWithCause,
	failsOnBase,
	newestInScope,
	passesAny,
	type RunRow,
	retally,
	runById,
	runRef,
	runsDependingOn,
	shownFailure,
	unexplainedIn,
	unexplainedShown,
} from "../runs/runs.ts";
import { caseById, caseRef } from "../suite/suite.ts";
import { HANDLERS, runsAbout } from "./kinds.ts";
import {
	alsoAbout,
	answersOf,
	attachEvidence,
	type DecisionRow,
	decisionById,
	decisionsOf,
	type HoldTerm,
	insertAnswer,
	insertDecision,
	insertQuestion,
	latestByFingerprint,
	liveByFingerprint,
	mustQuestion,
	noteCarried,
	openQuestionsOn,
	type QuestionRow,
	questionById,
	questionRef,
	refsOf,
	type Signer,
	setDecisionEffects,
	setQuestionAsk,
	setQuestionState,
} from "./questions.ts";

export type Raise = {
	kind: Kind;
	/** Names the cause. Two raises with the same kind and key are the same question. */
	key: string;
	subject: Record<string, unknown>;
	title: string;
	/** Whose evidence raised it: shown as the producer glyph in the queue. */
	producer: ActorKind;
	/** What the person answering sees. */
	evidence: Record<string, unknown>;
	/** The part of the evidence an answer stands on. When it changes, earlier answers no longer apply. */
	material: unknown;
	/** Policy facts (`scope:change`, `hint:fails-on-base`, `author:agent`, ...). */
	facts: readonly string[];
	/** Things the question is about: `C-311`, `R-4`, `T-12`, `pr:482`. */
	refs: readonly string[];
	/** Runs an open question of this kind may hold back, subject to the clause. */
	runs: readonly Pick<RunRow, "id" | "origin">[];
	/** The target this occurrence was seen on, for decisions that hold for one target only. */
	target?: number;
};

export type Raised =
	| { s: "open"; question: QuestionRow }
	| { s: "attached"; question: QuestionRow }
	| { s: "carried"; question: QuestionRow; decision: DecisionRow }
	| { s: "decided"; question: QuestionRow; decision: DecisionRow; effects: Record<string, unknown> };

/**
 * What is kept as a question's evidence: what the answerer sees, plus the policy facts and the target of the
 * latest occurrence, which answering and holds read back. Built in one place so an occurrence attached to an open
 * question carries them exactly as the first one did.
 */
function stored(r: Raise): Record<string, unknown> {
	return { ...r.evidence, facts: r.facts, ...(r.target !== undefined ? { targetId: r.target } : {}) };
}

/** The one mint of decision witnesses. Claimed here when the module loads; nothing else can claim it. */
const mintWitness = claimMint();

const PRIORITY: Record<Blocks, number> = { all: 3, change: 2, release: 2, nothing: 1 };

function blockedRuns(blocks: Blocks, runs: Raise["runs"]): number[] {
	return runs
		.filter(
			(run) =>
				blocks === "all" ||
				(blocks === "change" && run.origin === "change") ||
				(blocks === "release" && run.origin === "planned"),
		)
		.map((run) => run.id);
}

/**
 * The one way a question comes to exist. Looks at what is already asked and decided about this cause and then:
 * nothing: opens a question; a decision that still holds for this occurrence: carries the answer forward (no new
 * question); an open question: attaches the occurrence; otherwise asks again, with the old answer linked. A
 * decision that no longer holds is withdrawn on the way, and every run that rested on it is recomputed. If the
 * policy's clause for the question is a rule, the rule answers at once and the decision is recorded like any other.
 *
 * A cause can have more than one answer in force. One that holds for certain targets (an infrastructure failure
 * in one environment) leaves the cause open elsewhere, where it is asked and answered on its own. So every
 * standing decision about the cause is looked at, never only the newest question's.
 */
export function raise(ctx: Ctx, r: Raise): Raised {
	const fingerprint = contentHash({ kind: r.kind, key: r.key });
	// Two hashes. The basis is what a decision stands on: the cause, without the build, so an answer carries from
	// one commit to the next. The evidence hash is what a person answering must have seen: the basis and the
	// latest build, so an answer prepared before a newer build arrived is a conflict and not a decision about a
	// build its author never saw.
	const basis = contentHash(r.material);
	const hash = seenHash(basis, r.target);
	const latest = latestByFingerprint(ctx.db, ctx.project.id, fingerprint);
	if (!latest) return open(ctx, r, fingerprint, hash, basis, 0, null);
	const occurrence = { hash: basis, target: r.target, facts: r.facts, now: ctx.now };
	const standing = standingOn(ctx, fingerprint);
	for (const { question, decision } of standing) {
		if (!stillHolds(decision, occurrence)) continue;
		noteCarried(ctx, question, r.refs);
		return { s: "carried", question, decision };
	}
	// A decision that covers certain targets still stands on those when the cause turns up on another one: the
	// new occurrence is asked about, and what was decided where it was decided is left as it is. Any other way
	// of no longer holding (the evidence changed, the time ran out, a fact is gone) withdraws its standing.
	const rested: number[] = [];
	let ended: QuestionRow | null = null;
	for (const { question, decision } of standing) {
		if (stillHolds(decision, occurrence, { anyTarget: true })) continue;
		HANDLERS[question.kind].revert(ctx, question, decision);
		lapse(ctx, question, decision, occurrence.now);
		rested.push(...runsDependingOn(ctx.db, decision.id));
		ended ??= question;
	}
	const joined = openFor(ctx.db, ctx.project.id, fingerprint, r.target);
	let raised: Raised;
	if (joined) {
		const clause = clauseFor(currentPolicy(ctx.db, ctx.project.id), { kind: r.kind, facts: new Set(r.facts) });
		const question = attachEvidence(ctx, joined, {
			title: r.title,
			evidence: stored(r),
			hash,
			basis,
			blocks: blockedRuns(clause.blocks, r.runs),
			refs: r.refs,
		});
		if (clause.ask.who === "rule" && !heldOpen(ctx, question, basis)) {
			setQuestionAsk(ctx, question, clause.ask);
			raised = settleByRule(ctx, question, clause.id, clause.answer);
		} else raised = { s: "attached", question };
	} else {
		// Asked again. It follows the question whose answer just ended, so that answer's chain runs on through it.
		raised = open(ctx, r, fingerprint, hash, basis, latest.epoch + 1, (ended ?? latest).id);
	}
	// The runs that counted a failure as excused by a decision withdrawn above: an earlier commit of the change,
	// a run planned on it, a run since closed. The question asked in its place names them, and they are recomputed
	// now: none is left reading `passed` on an answer that no longer stands, or blocked with nobody asked.
	if (rested.length > 0) {
		const named = rested.flatMap((id) => {
			const run = runById(ctx.db, id);
			return run ? [runRef(run)] : [];
		});
		alsoAbout(ctx, raised.question, named);
		refold(ctx, rested);
	}
	return raised;
}

/** The decisions in force about a cause, newest question first. */
function standingOn(ctx: Ctx, fingerprint: string): { question: QuestionRow; decision: DecisionRow }[] {
	return liveByFingerprint(ctx.db, ctx.project.id, fingerprint).flatMap((question) => {
		const decision =
			question.state === "decided" && question.decision !== null ? decisionById(ctx.db, question.decision) : null;
		return decision ? [{ question, decision }] : [];
	});
}

/**
 * The open question a new occurrence of a cause joins: the one that has already seen this target, else the
 * newest. Usually there is at most one; two when an answer for one environment was withdrawn while the other
 * environment's question is still open.
 */
export function openFor(db: Db, project: number, fingerprint: string, target: number | undefined): QuestionRow | null {
	const opened = liveByFingerprint(db, project, fingerprint).filter((question) => question.state === "open");
	const seenHere =
		target === undefined
			? undefined
			: opened.find((question) => (json<{ targets?: number[] }>(question.evidence).targets ?? []).includes(target));
	return seenHere ?? opened[0] ?? null;
}

const seenHash = (basis: string, target: number | undefined): string => contentHash({ basis, target: target ?? null });

/**
 * Records in the ledger that a decision stopped holding (its time ran out, or the evidence it stood on changed)
 * and that its question was asked again. The row is signed by the rule actor and supersedes the decision; the
 * question then points at it, so the timed sweep does not find the old decision and reopen a question that has
 * already been asked again, and the next answer's chain runs through it.
 */
function lapse(ctx: Ctx, question: QuestionRow, decision: DecisionRow, now: number): DecisionRow {
	const timedOut = json<HoldTerm[]>(decision.holds).some((term) => term.until === "time" && now >= term.at);
	const row = insertDecision(ctx, {
		question,
		answer: { is: timedOut ? "expired" : "outdated" },
		signers: [
			{
				by: ruleActor(ctx.db).id,
				clause: timedOut ? "hold-expired" : "hold-ended",
				policy: currentPolicy(ctx.db, ctx.project.id).version,
				reason: null,
			},
		],
		holds: [],
		supersedes: decision.id,
	});
	setQuestionState(ctx, question, "decided", row.id);
	return row;
}

/**
 * A person withdrew the decision on this question and nothing material has changed since. A rule must not answer
 * it again behind their back: it stays open until a person answers or the evidence moves.
 */
function heldOpen(ctx: Ctx, question: QuestionRow, hash: string): boolean {
	const last = decisionsOf(ctx.db, question.id).at(-1);
	return last !== undefined && json<{ is?: string }>(last.answer).is === "withdrawn" && last.basis === hash;
}

function open(
	ctx: Ctx,
	r: Raise,
	fingerprint: string,
	hash: string,
	basis: string,
	epoch: number,
	prior: number | null,
): Raised {
	const policy = currentPolicy(ctx.db, ctx.project.id);
	const clause = clauseFor(policy, { kind: r.kind, facts: new Set(r.facts) });
	const question = insertQuestion(ctx, {
		kind: r.kind,
		subject: r.subject,
		fingerprint,
		epoch,
		prior,
		title: r.title,
		producer: r.producer,
		evidence: stored(r),
		hash,
		basis,
		ask: clause.ask,
		blocks: blockedRuns(clause.blocks, r.runs),
		// Most blocking first, then newest first: one ascending range read is the queue.
		rank: -(PRIORITY[clause.blocks] * 1_000_000_000_000 + ctx.seq * 1000 + (ctx.ord() % 1000)),
		refs: r.refs,
	});
	if (clause.ask.who === "rule") return settleByRule(ctx, question, clause.id, clause.answer);
	return { s: "open", question };
}

function settleByRule(ctx: Ctx, question: QuestionRow, clause: string, answer: unknown): Raised {
	const parsed = ANSWERS[question.kind].safeParse(answer);
	if (!parsed.success)
		throw new Error(`clause ${clause} gives an answer that a ${question.kind} question does not accept`);
	const policy = currentPolicy(ctx.db, ctx.project.id).version;
	const signer: Signer = { by: ruleActor(ctx.db).id, clause, policy, reason: null };
	try {
		const settled = ctx.db.savepoint(() => settle(ctx, question, [signer], parsed.data as AnyAnswer));
		return {
			s: "decided",
			question: questionById(ctx.db, question.id) ?? question,
			decision: settled.decision,
			effects: settled.effects,
		};
	} catch (error) {
		// The rule could not apply its answer (a conflict it cannot resolve). The question stays open for a person.
		if (error instanceof OpError) return { s: "open", question };
		throw error;
	}
}

/**
 * Does a decision still cover a new occurrence? It stops as soon as any one of its hold terms ends. With
 * `anyTarget` the target term is left out: the answer is whether it would hold on the targets it does cover.
 */
export function stillHolds(
	decision: Pick<DecisionRow, "holds">,
	occurrence: { hash: string; target: number | undefined; facts: readonly string[]; now: number },
	options: { anyTarget?: boolean } = {},
): boolean {
	return json<HoldTerm[]>(decision.holds).every((term) => {
		switch (term.until) {
			case "basis-changes":
				return term.basis === occurrence.hash;
			case "this-target":
				return options.anyTarget || (occurrence.target !== undefined && term.targets.includes(occurrence.target));
			case "time":
				return occurrence.now < term.at;
			case "fact-gone":
				return occurrence.facts.includes(term.fact);
			case "results-named":
				// It covers the results it named and no occurrence reported since. Like a target term, that is not a
				// reason to withdraw it: what it decided about those results stands.
				return options.anyTarget === true;
			default: {
				const _exhaustive: never = term;
				return _exhaustive;
			}
		}
	});
}

// ── Answering ──────────────────────────────────────────────────────────────────────────────────────────────

const reply = (q: QuestionRow, status: DecideReply["status"], more: Partial<DecideReply> = {}): DecideReply => ({
	q: questionRef(q),
	status,
	needs: null,
	decision: null,
	effects: null,
	evidence: null,
	...more,
});

/**
 * One actor's answer to one question. Policy decides what it is worth: it may settle the question, be recorded as
 * advice, or be refused. The same call at every strictness and from every surface.
 */
export function answer(
	ctx: Ctx,
	input: { q: string; onEvidence: string; answer: unknown; reason: string | undefined },
): DecideReply {
	const question = mustQuestion(ctx.db, ctx.project.id, input.q);
	const parsed = ANSWERS[question.kind].safeParse(input.answer);
	if (!parsed.success) {
		const allowed = (ANSWERS[question.kind].options as readonly { shape: { is: { value: string } } }[]).map(
			(o) => o.shape.is.value,
		);
		return reply(question, "invalid", {
			needs: `an answer for a ${question.kind} question: is one of ${allowed.join(", ")}`,
		});
	}
	const given = parsed.data as AnyAnswer;
	if (input.onEvidence !== question.evidence_hash) {
		return reply(question, "conflict", {
			needs: "the evidence changed; read the question again and answer on its current evidence",
			evidence: question.evidence_hash,
		});
	}
	if (question.state === "dissolved") return reply(question, "conflict", { needs: "this question no longer applies" });
	const asked = askedAgain(ctx, question);
	if (asked) return reply(question, "conflict", { needs: asked });
	if (question.state === "decided" && question.decision !== null) {
		const prior = decisionById(ctx.db, question.decision);
		if (prior && JSON.stringify(json(prior.answer)) === JSON.stringify(given))
			return reply(question, "already", { decision: prior.id });
	}

	const policy = currentPolicy(ctx.db, ctx.project.id);
	const facts = new Set(json<{ facts?: string[] }>(question.evidence).facts ?? []);
	if (question.kind === "failure" && !applicableAnswers(question.kind, facts).includes(given.is)) {
		return reply(question, "invalid", {
			needs: `one of ${applicableAnswers(question.kind, facts).join(", ")}: \`${given.is}\` does not apply to this failure`,
		});
	}
	const clause = clauseFor(policy, { kind: question.kind, facts, answer: given.is });
	// The clause that would settle this answer. A rule clause still lets a person overrule it; then the general
	// clause for the kind says who that person must be.
	const ask: Ask = clause.ask.who === "rule" ? { ...clause.ask, who: "member" } : clause.ask;
	const standing = standingOf({
		actor: ctx.actor,
		ask,
		isAuthor: HANDLERS[question.kind].isAuthor(ctx, question),
		// Read from the results, and only where the clause asks: most clauses do not.
		isProducer: ask.notProducer && HANDLERS[question.kind].isProducer(ctx, question),
	});
	if (standing === "forbidden") return reply(question, "forbidden", { needs: describeAsk(ask) });
	if (ask.reason === "required" && !input.reason?.trim()) return reply(question, "invalid", { needs: "a reason" });

	insertAnswer(ctx, {
		question: question.id,
		answer: given,
		reason: input.reason ?? null,
		hash: question.evidence_hash,
		counts: standing === "counts",
	});
	if (standing === "advice") {
		ctx.touched.add(questionRef(question));
		return reply(question, "advised", { needs: describeAsk({ ...ask, agents: "none" }) });
	}
	const signer: Signer = { by: ctx.actor.id, clause: clause.id, policy: policy.version, reason: input.reason ?? null };
	try {
		const settled = ctx.db.savepoint(() => settle(ctx, question, [signer], given));
		return reply(question, "decided", { decision: settled.decision.id, effects: settled.effects });
	} catch (error) {
		if (error instanceof OpError)
			return reply(question, error.code === "conflict" ? "conflict" : "invalid", { needs: error.message });
		throw error;
	}
}

/**
 * A question that was asked again after its decision stopped holding is history: the newer question is the one to
 * answer or to undo. Answering the old one would decide the same cause twice. A question that is open, or whose
 * decision is still in force, is answered and undone where it is, even when the cause has since been asked about
 * for another target: that question is about the other target, and its answer is not this one's.
 */
function askedAgain(ctx: Ctx, question: QuestionRow): string | null {
	if (question.state === "open") return null;
	const latest = latestByFingerprint(ctx.db, ctx.project.id, question.fingerprint);
	if (!latest || latest.id === question.id) return null;
	const inForce = liveByFingerprint(ctx.db, ctx.project.id, question.fingerprint).some(
		(live) => live.id === question.id,
	);
	return inForce ? null : `this question was asked again as ${questionRef(latest)}; answer that one`;
}

/**
 * Records a decision and applies its effect. The only caller of any standing writer: it mints the witness.
 * A decision that replaces an earlier one on the same question first withdraws what the earlier one did; the
 * earlier row is never edited, and the new row names it in `supersedes`.
 */
function settle(
	ctx: Ctx,
	question: QuestionRow,
	signers: Signer[],
	given: AnyAnswer,
): { decision: DecisionRow; effects: Record<string, unknown> } {
	const handler = HANDLERS[question.kind];
	let supersedes: number | null = null;
	if (question.state === "decided" && question.decision !== null) {
		const prior = decisionById(ctx.db, question.decision);
		if (prior) {
			handler.revert(ctx, question, prior);
			supersedes = prior.id;
		}
	} else {
		// A reopened question: the new decision follows the last row in its ledger (a withdrawal or an expiry). For
		// a question asked again after its hold ended, it follows the row that says so on the question before it. One
		// asked again because the earlier answer covered other targets supersedes nothing: that answer still stands.
		supersedes = decisionsOf(ctx.db, question.id).at(-1)?.id ?? endedBefore(ctx, question);
	}
	const policy = currentPolicy(ctx.db, ctx.project.id);
	const holds = handler.holds({ question, answer: given, now: ctx.now, policy });
	const rested = endReplaced(ctx, question, holds);
	const decision = insertDecision(ctx, { question, answer: given, signers, holds, supersedes });
	setQuestionState(ctx, question, "decided", decision.id);
	const witness = mintWitness(
		decision.id,
		question.kind,
		signers.map((signer) => signer.by),
		decision.expires_at,
	);
	const effects = handler.effect(ctx, witness, question, given, { raise });
	setDecisionEffects(ctx, decision.id, effects);
	const about = runsAbout(ctx, question);
	if (Array.isArray(effects.reask) && effects.reask.length > 0) askAgain(ctx, question, effects.reask as number[]);
	about.push(...answeredElsewhere(ctx, question, decision), ...rested);
	refold(ctx, [...about, ...(supersedes !== null ? runsDependingOn(ctx.db, supersedes) : [])]);
	return { decision: { ...decision, effects: JSON.stringify(effects) }, effects };
}

/** What a decision covers: the targets it names, every target of the cause's scope, or only the results it named. */
const covers = (holds: readonly HoldTerm[]): readonly number[] | "all" | "results" => {
	if (holds.some((term) => term.until === "results-named")) return "results";
	const here = holds.find((term) => term.until === "this-target");
	return here?.until === "this-target" ? here.targets : "all";
};

/**
 * One answer in force per cause and target. A decision about to be made on this question takes the place of
 * another question's answer when both cover the whole cause, or both name the same target. That other answer is
 * ended here, with a row in the ledger that says so, before the new one is recorded: it is not left listed as
 * standing with its effect overwritten. Returns the runs that rested on it or were about it, to be recomputed.
 */
function endReplaced(ctx: Ctx, question: QuestionRow, holds: readonly HoldTerm[]): number[] {
	const mine = covers(holds);
	const runs: number[] = [];
	for (const { question: other, decision } of standingOn(ctx, question.fingerprint)) {
		if (other.id === question.id) continue;
		const theirs = covers(json<HoldTerm[]>(decision.holds));
		// A decision about named results takes nobody's place and nobody takes its place.
		const same =
			mine === "results" || theirs === "results"
				? false
				: mine === "all"
					? theirs === "all"
					: theirs !== "all" && theirs.some((target) => mine.includes(target));
		if (!same) continue;
		HANDLERS[other.kind].revert(ctx, other, decision);
		lapse(ctx, other, decision, ctx.now);
		runs.push(...runsDependingOn(ctx.db, decision.id), ...runsAbout(ctx, other));
	}
	return runs;
}

/** The row that ended the answer of the question this one was asked after, if it was asked for that reason. */
function endedBefore(ctx: Ctx, question: QuestionRow): number | null {
	const before = question.prior !== null ? questionById(ctx.db, question.prior) : null;
	const last = before?.decision != null ? decisionById(ctx.db, before.decision) : null;
	const is = last ? json<{ is?: string }>(last.answer).is : undefined;
	return last && (is === "expired" || is === "outdated") ? last.id : null;
}

/**
 * Closes the other open questions about the same cause that this decision has just answered: every target they
 * had seen the cause on is now covered. Nobody is left asked about something that has a valid answer. Returns the
 * runs those questions named, to be recomputed.
 */
function answeredElsewhere(ctx: Ctx, question: QuestionRow, decision: DecisionRow): number[] {
	const runs: number[] = [];
	for (const other of liveByFingerprint(ctx.db, ctx.project.id, question.fingerprint)) {
		if (other.id === question.id || other.state !== "open") continue;
		const seen = json<{ facts?: string[]; targets?: number[]; targetId?: number }>(other.evidence);
		const targets = seen.targets ?? (seen.targetId !== undefined ? [seen.targetId] : []);
		const covered =
			targets.length > 0 &&
			targets.every((target) =>
				stillHolds(decision, { hash: other.basis, target, facts: seen.facts ?? [], now: ctx.now }),
			);
		if (!covered) continue;
		runs.push(...runsAbout(ctx, other));
		setQuestionState(ctx, other, "dissolved", null);
	}
	return runs;
}

/**
 * Opens the question again for targets its decision did not cover. The new question follows the decided one
 * (`prior`) and shows the same evidence, so the person who answered for one environment is asked about the other
 * with their first answer in view. It names the runs that still show the cause unexplained, and no others. A
 * target that another answer in force already covers, or that an open question about this cause already lists,
 * is not asked about a second time.
 */
function askAgain(ctx: Ctx, question: QuestionRow, targets: readonly number[]): void {
	const {
		facts,
		targetId: _decided,
		...shown
	} = json<Record<string, unknown> & { facts?: string[] }>(question.evidence);
	const others = liveByFingerprint(ctx.db, ctx.project.id, question.fingerprint).filter(
		(other) => other.id !== question.id,
	);
	const pending = targets.filter(
		(target) =>
			!others.some((other) => {
				if (other.state === "open")
					return (json<{ targets?: number[] }>(other.evidence).targets ?? []).includes(target);
				const decision = other.decision !== null ? decisionById(ctx.db, other.decision) : null;
				return (
					decision !== null && stillHolds(decision, { hash: question.basis, target, facts: facts ?? [], now: ctx.now })
				);
			}),
	);
	const latest = pending.at(-1);
	if (latest === undefined) return;
	const subject = json<Record<string, unknown> & { signature?: number; scope?: string }>(question.subject);
	const key =
		subject.signature !== undefined && subject.scope !== undefined ? causeKey(subject.signature, subject.scope) : null;
	const runs = runsAbout(ctx, question).flatMap((id) => {
		const run = runById(ctx.db, id);
		return run && (key === null || unexplainedIn(ctx.db, run).has(key)) ? [run] : [];
	});
	const newest = latestByFingerprint(ctx.db, ctx.project.id, question.fingerprint) ?? question;
	open(
		ctx,
		{
			kind: question.kind,
			key: "",
			subject,
			title: question.title,
			producer: question.producer,
			evidence: { ...shown, targets: pending },
			material: null,
			facts: facts ?? [],
			refs: [...refsOf(ctx.db, question.id).filter((about) => !/^R-\d+$/.test(about)), ...runs.map(runRef)],
			runs,
			target: latest,
		},
		question.fingerprint,
		seenHash(question.basis, latest),
		question.basis,
		newest.epoch + 1,
		question.id,
	);
}

/**
 * Withdraws the current decision on a question and opens it again. The withdrawal is itself a decision in the
 * ledger, superseding the one it withdraws, so both remain (commitment L6: undo never erases).
 */
export function undo(ctx: Ctx, input: { q: string; reason: string | undefined }): DecideReply {
	const question = mustQuestion(ctx.db, ctx.project.id, input.q);
	if (question.state !== "decided" || question.decision === null)
		return reply(question, "invalid", { needs: "a decided question" });
	const asked = askedAgain(ctx, question);
	if (asked) return reply(question, "conflict", { needs: asked });
	const prior = decisionById(ctx.db, question.decision);
	if (!prior) return reply(question, "invalid", { needs: "a decided question" });
	const handler = HANDLERS[question.kind];
	if (!handler.undoable) return reply(question, "invalid", { needs: handler.undoHint });
	// Taking an answer away is held to what giving it was: the clause for that answer says who may (not a producer
	// of the evidence, where it says so) and whether a reason is owed.
	const policy = currentPolicy(ctx.db, ctx.project.id);
	const facts = new Set(json<{ facts?: string[] }>(question.evidence).facts ?? []);
	const given = json<{ is?: string }>(prior.answer).is;
	const clause = clauseFor(policy, { kind: question.kind, facts, ...(given ? { answer: given } : {}) });
	const ask: Ask = clause.ask.who === "rule" ? { ...clause.ask, who: "member" } : clause.ask;
	const standing = standingOf({
		actor: ctx.actor,
		ask,
		isAuthor: handler.isAuthor(ctx, question),
		isProducer: ask.notProducer && handler.isProducer(ctx, question),
	});
	if (standing !== "counts") return reply(question, "forbidden", { needs: describeAsk(ask) });
	if (ask.reason === "required" && !input.reason?.trim()) return reply(question, "invalid", { needs: "a reason" });
	handler.revert(ctx, question, prior);
	const signer: Signer = { by: ctx.actor.id, clause: clause.id, policy: policy.version, reason: input.reason ?? null };
	const decision = insertDecision(ctx, {
		question,
		answer: { is: "withdrawn" },
		signers: [signer],
		holds: [],
		supersedes: prior.id,
	});
	setQuestionState(ctx, question, "open", null);
	// Open again, it asks what any question of its kind asks. Where that is a rule, a person now decides: the
	// rule does not answer again behind the back of whoever withdrew its answer.
	const general = clauseFor(policy, { kind: question.kind, facts }).ask;
	setQuestionAsk(ctx, question, general.who === "rule" ? { ...general, who: "member" } : general);
	refold(ctx, [...runsAbout(ctx, question), ...runsDependingOn(ctx.db, prior.id)]);
	return reply(question, "reopened", { decision: decision.id });
}

// ── Failures ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Puts one cause of failure to the queue. `by` is the actor whose result shows it, `producer` that actor's kind.
 * Called for the failures of a report as it is applied, and for the failures a run shows when it is planned
 * over evidence that already fails: there is one door, so the question, its carried answer and the runs it
 * reaches are the same either way.
 */
export function raiseFailure(
	ctx: Ctx,
	input: { group: FailingGroup; target: TargetRow; by: number; producer: ActorKind },
): Raised {
	const { group, target } = input;
	const scopeKind = group.scope.startsWith("change:") ? "change" : group.scope.startsWith("line:") ? "trunk" : "run";
	const key = `${group.signature.hash}|${group.scope}`;
	// One question per cause: an occurrence adds its tests to the open question instead of opening another.
	const open = openFor(ctx.db, ctx.project.id, contentHash({ kind: "failure", key }), target.id);
	const earlier = open
		? json<{
				tests?: { id: number; t: string; name: string; case: string | null }[];
				producers?: number[];
				targets?: number[];
			}>(open.evidence)
		: {};
	const tests = new Map((earlier.tests ?? []).map((test) => [test.id, test]));
	for (const test of group.tests) {
		const row = test.case_id !== null ? caseById(ctx.db, test.case_id) : null;
		tests.set(test.id, { id: test.id, t: testRef(test), name: test.name, case: row ? caseRef(row) : null });
	}
	const hints: string[] = [];
	// "Already failing on the base" is a statement about the cause, so it must be true of every test that fails
	// with it on this commit now, not only of those in the report that happens to be arriving: how a pipeline
	// splits its results over reports must not change what a rule may excuse.
	const failingNow = new Set([
		...group.tests.map((test) => test.id),
		...failingWithCause(ctx.db, target, group.signature.id),
	]);
	if (
		scopeKind === "change" &&
		failingNow.size > 0 &&
		[...failingNow].every((test) => failsOnBase(ctx.db, target, test, group.signature.id))
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
		title: clip(group.signature.text, 160),
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
			producers: [...new Set([...(earlier.producers ?? []), input.by])],
			// Every target this question has seen the cause on: an answer that holds "here only" covers these.
			targets: [...new Set([...(earlier.targets ?? []), target.id])],
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

/**
 * Every failure a run shows unexplained has a question somebody can answer. That is checked here, each time a run
 * is recomputed, and not left to each path that can take a question away: an answer changed to one that covers
 * less, an answer withdrawn after another closed its neighbour's question, a closed run opened again. A run that
 * speaks (an open planned run, or the run of the newest commit in its scope) is never blocked with nobody asked.
 * An older commit of a change is not asked about again: a newer commit has replaced it.
 */
function askUnexplained(ctx: Ctx, run: RunRow): boolean {
	const speaks =
		run.origin === "planned"
			? run.state === "open"
			: run.scope !== null && newestInScope(ctx.db, run.project, run.scope)?.id === run.id;
	if (!speaks) return false;
	let asked = false;
	for (const cause of unexplainedShown(ctx.db, run)) {
		const signature = signatureById(ctx.db, cause.signature);
		if (!signature) continue;
		const fingerprint = contentHash({ kind: "failure", key: `${signature.hash}|${cause.scope}` });
		const open = openFor(ctx.db, ctx.project.id, fingerprint, cause.target);
		if (open && (json<{ targets?: number[] }>(open.evidence).targets ?? []).includes(cause.target)) {
			alsoAbout(ctx, open, [runRef(run)]);
			continue;
		}
		const shown = shownFailure(ctx, run, cause);
		if (!shown) continue;
		const raised = raiseFailure(ctx, {
			group: shown.group,
			target: mustTarget(ctx.db, cause.target),
			by: shown.by,
			producer: actorLabel(ctx.db, shown.by).kind,
		});
		asked ||= raised.s !== "carried";
	}
	return asked;
}

// ── Keeping runs in step ───────────────────────────────────────────────────────────────────────────────────

/**
 * Recomputes the given runs and acts on what follows: a planned run that has just passed gets its sign-off
 * question (which a rule may answer and so close the run).
 */
export function refold(ctx: Ctx, runIds: Iterable<number>, options: { dissolveStale?: boolean } = {}): void {
	for (const id of new Set(runIds)) {
		const existing = runById(ctx.db, id);
		if (!existing) continue;
		let result = retally(ctx, id, blockersOf(ctx, existing));
		if (result.failing.size > 0 && askUnexplained(ctx, result.run))
			result = retally(ctx, id, blockersOf(ctx, result.run));
		if (options.dissolveStale) dissolveStale(ctx, result.run);
		if (!result.wantsSignoff) continue;
		const run = result.run;
		raise(ctx, {
			kind: "signoff",
			key: `run:${run.id}`,
			subject: { run: run.id },
			title: `Close ${runRef(run)} ${run.name}`,
			producer: "rule",
			evidence: { run: runRef(run), name: run.name, verdict: run.verdict, tally: json(run.tally) },
			material: { tally: json(run.tally), applied: run.applied_seq },
			facts: ["verdict:passed"],
			refs: [runRef(run)],
			runs: [],
		});
	}
}

/** The open questions about a run, as the run fold needs them. */
function blockersOf(ctx: Ctx, run: RunRow): Blocker[] {
	return openQuestionsOn(ctx.db, ctx.project.id, runRef(run)).map((open) => ({
		ref: questionRef(open),
		kind: open.kind,
		signature: open.kind === "failure" ? (json<{ signature?: number }>(open.subject).signature ?? null) : null,
		scope: open.kind === "failure" ? (json<{ scope?: string }>(open.subject).scope ?? null) : null,
		blocks: json<number[]>(open.blocks),
	}));
}

/**
 * A failure question about a cause that stopped failing is closed as dissolved: nobody should be asked why
 * something failed after it passed. The question and its history remain. Called for each run a report counted
 * toward, about the questions that name the run or its scope.
 */
function dissolveStale(ctx: Ctx, run: RunRow): void {
	const candidates = new Set<number>();
	for (const about of [runRef(run), ...(run.scope !== null ? [`scope:${run.scope}`] : [])]) {
		for (const open of openQuestionsOn(ctx.db, ctx.project.id, about)) {
			if (open.kind === "failure") candidates.add(open.id);
		}
	}
	const shown = new Map<number, Set<string>>();
	for (const id of candidates) {
		const question = questionById(ctx.db, id);
		if (question?.state !== "open" || !stoppedFailing(ctx, question, shown)) continue;
		setQuestionState(ctx, question, "dissolved", null);
		// A run that listed this question among those it waits for is recomputed without it.
		for (const about of runsAbout(ctx, question)) {
			const named = runById(ctx.db, about);
			if (named && json<string[]>(named.blocking).includes(questionRef(question)))
				retally(ctx, named.id, blockersOf(ctx, named));
		}
	}
}

/**
 * Has the cause of this question stopped failing everywhere that speaks for it? Two kinds of run speak: the run
 * of the newest commit in the question's scope (an older commit's late report says nothing about the current
 * one), and every open planned run the question names. None of them may still show the cause unexplained: a
 * question is never closed while a run it would unblock is blocked by it. A planned run counts what it asked for,
 * so a pipeline's pass does not clear a slot that asked for an agent.
 *
 * And absence is not proof. Something must show the failure gone: one of the question's own tests passing in the
 * newest commit's run (a newer commit whose failing job has not reported yet says nothing), or a planned run
 * that showed the cause and no longer does, which only a newer attempt, a correction or a decision can bring about.
 */
function stoppedFailing(ctx: Ctx, question: QuestionRow, shown: Map<number, Set<string>>): boolean {
	const subject = json<{ signature: number; scope: string }>(question.subject);
	const key = causeKey(subject.signature, subject.scope);
	const shows = (run: RunRow): boolean => {
		let causes = shown.get(run.id);
		if (!causes) {
			causes = unexplainedIn(ctx.db, run);
			shown.set(run.id, causes);
		}
		return causes.has(key);
	};
	let gone = false;
	const newest = newestInScope(ctx.db, ctx.project.id, subject.scope);
	if (newest) {
		if (shows(newest)) return false;
		const tests = (json<{ tests?: { id: number }[] }>(question.evidence).tests ?? []).map((test) => test.id);
		gone = passesAny(ctx.db, newest.id, tests);
	}
	for (const id of runsAbout(ctx, question)) {
		const run = runById(ctx.db, id);
		if (run?.origin !== "planned" || run.state !== "open") continue;
		if (shows(run)) return false;
		gone = true;
	}
	return gone;
}

/**
 * Reopens every question whose decision has run out of time, and recomputes the runs that rested on it. The gate
 * already reads `pending` once a hold expires; this makes the question visible again without waiting for the next
 * report. The expiry is a row in the ledger, signed by the rule actor and superseding the decision that ran out, so
 * the next answer follows it and the chain is unbroken. Returns the number reopened.
 */
export function sweepExpired(ctx: Ctx, expired: readonly DecisionRow[]): number {
	let reopened = 0;
	for (const decision of expired) {
		const question = questionById(ctx.db, decision.question);
		if (question?.state !== "decided" || question.decision !== decision.id) continue;
		HANDLERS[question.kind].revert(ctx, question, decision);
		insertDecision(ctx, {
			question,
			answer: { is: "expired" },
			signers: [
				{
					by: ruleActor(ctx.db).id,
					clause: "hold-expired",
					policy: currentPolicy(ctx.db, ctx.project.id).version,
					reason: null,
				},
			],
			holds: [],
			supersedes: decision.id,
		});
		setQuestionState(ctx, question, "open", null);
		refold(ctx, [...runsAbout(ctx, question), ...runsDependingOn(ctx.db, decision.id)]);
		reopened++;
	}
	return reopened;
}

// ── Reading ────────────────────────────────────────────────────────────────────────────────────────────────

/** A question as the queue, a case page and an agent see it. */
export function toItem(db: Db, row: QuestionRow): QuestionItem {
	const ask = json<Ask>(row.ask);
	const answers = answersOf(db, row.id);
	const decision = row.decision !== null ? decisionById(db, row.decision) : null;
	const signers = decision ? json<Signer[]>(decision.signers) : [];
	const rule = signers.find((signer) => actorLabel(db, signer.by).kind === "rule");
	return {
		q: questionRef(row),
		kind: row.kind,
		title: row.title,
		producer: row.producer,
		state: row.state,
		evidence: json<Record<string, unknown>>(row.evidence),
		evidenceHash: row.evidence_hash,
		seen: { count: row.seen_count, carried: row.carried },
		needs: describeAsk(ask),
		answers: applicableAnswers(row.kind, new Set(json<{ facts?: string[] }>(row.evidence).facts ?? [])),
		blocks: json<number[]>(row.blocks).flatMap((id) => {
			const run = runById(db, id);
			return run ? [runRef(run)] : [];
		}),
		about: refsOf(db, row.id),
		openedAt: row.opened_at,
		advice: answers
			.filter((a) => a.counts === 0 && a.on_evidence === row.evidence_hash)
			.map((a) => ({
				by: actorLabel(db, a.actor).name,
				kind: actorLabel(db, a.actor).kind,
				answer: json<Record<string, unknown>>(a.answer),
				reason: a.reason,
			})),
		decision: decision
			? {
					id: decision.id,
					answer: json<Record<string, unknown>>(decision.answer),
					by: signers.map((signer) => actorLabel(db, signer.by).name),
					rule: rule ? rule.clause : null,
					reason: signers.find((signer) => signer.reason)?.reason ?? null,
					at: decision.at,
				}
			: null,
	};
}

/** Whether the acting actor may settle this question, so a surface can show the keys or say who is needed. */
export function mayAnswer(ctx: Ctx, row: QuestionRow): "counts" | "advice" | "forbidden" {
	const ask = json<Ask>(row.ask);
	const handler = HANDLERS[row.kind];
	return standingOf({
		actor: ctx.actor,
		ask: ask.who === "rule" ? { ...ask, who: "member" } : ask,
		isAuthor: handler.isAuthor(ctx, row),
		isProducer: ask.notProducer && handler.isProducer(ctx, row),
	});
}
