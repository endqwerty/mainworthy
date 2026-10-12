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
import { actorLabel, ruleActor } from "../identity/identity.ts";
import type { Ctx } from "../kernel/ctx.ts";
import { type Db, json } from "../kernel/db.ts";
import { OpError } from "../kernel/errors.ts";
import { claimMint } from "../kernel/witness.ts";
import { clauseFor, currentPolicy } from "../policy/policy.ts";
import {
	type Blocker,
	findRun,
	isLatestInScope,
	type RunRow,
	retally,
	runById,
	runRef,
	runsDependingOn,
	scopeOfRun,
} from "../runs/runs.ts";
import { HANDLERS } from "./kinds.ts";
import {
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
 * The one way a question comes to exist. Looks up the latest question for this cause and then:
 * none: opens one; open: attaches the new occurrence; decided and the decision still holds: carries the answer
 * forward (no new question); decided and it no longer holds: withdraws that standing and asks again, with the old
 * answer linked. If the policy's clause for the question is a rule, the rule answers at once and the decision is
 * recorded like any other.
 */
export function raise(ctx: Ctx, r: Raise): Raised {
	const fingerprint = contentHash({ kind: r.kind, key: r.key });
	const hash = contentHash(r.material);
	const latest = latestByFingerprint(ctx.db, ctx.project.id, fingerprint);
	if (!latest) return open(ctx, r, fingerprint, hash, 0, null);
	if (latest.state === "open") {
		const clause = clauseFor(currentPolicy(ctx.db, ctx.project.id), { kind: r.kind, facts: new Set(r.facts) });
		const question = attachEvidence(ctx, latest, {
			title: r.title,
			evidence: stored(r),
			hash,
			blocks: blockedRuns(clause.blocks, r.runs),
			refs: r.refs,
		});
		if (clause.ask.who === "rule" && !heldOpen(ctx, question, hash)) {
			setQuestionAsk(ctx, question, clause.ask);
			return settleByRule(ctx, question, clause.id, clause.answer);
		}
		return { s: "attached", question };
	}
	if (latest.state === "decided" && latest.decision !== null) {
		const decision = decisionById(ctx.db, latest.decision);
		if (decision && stillHolds(decision, { hash, target: r.target, facts: r.facts, now: ctx.now })) {
			noteCarried(ctx, latest, r.refs);
			return { s: "carried", question: latest, decision };
		}
		if (decision) HANDLERS[latest.kind].revert(ctx, latest, decision);
	}
	return open(ctx, r, fingerprint, hash, latest.epoch + 1, latest.id);
}

/**
 * A person withdrew the decision on this question and nothing material has changed since. A rule must not answer
 * it again behind their back: it stays open until a person answers or the evidence moves.
 */
function heldOpen(ctx: Ctx, question: QuestionRow, hash: string): boolean {
	const last = decisionsOf(ctx.db, question.id).at(-1);
	return last !== undefined && json<{ is?: string }>(last.answer).is === "withdrawn" && last.basis === hash;
}

function open(ctx: Ctx, r: Raise, fingerprint: string, hash: string, epoch: number, prior: number | null): Raised {
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

/** Does a decision still cover a new occurrence? It stops as soon as any one of its hold terms ends. */
export function stillHolds(
	decision: Pick<DecisionRow, "holds">,
	occurrence: { hash: string; target: number | undefined; facts: readonly string[]; now: number },
): boolean {
	return json<HoldTerm[]>(decision.holds).every((term) => {
		switch (term.until) {
			case "basis-changes":
				return term.basis === occurrence.hash;
			case "this-target":
				return term.target === occurrence.target;
			case "time":
				return occurrence.now < term.at;
			case "fact-gone":
				return occurrence.facts.includes(term.fact);
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
		isProducer: HANDLERS[question.kind].isProducer(ctx, question),
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
 * answer or to undo. Answering the old one would decide the same cause twice.
 */
function askedAgain(ctx: Ctx, question: QuestionRow): string | null {
	const latest = latestByFingerprint(ctx.db, ctx.project.id, question.fingerprint);
	return latest && latest.id !== question.id
		? `this question was asked again as ${questionRef(latest)}; answer that one`
		: null;
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
		// A reopened question: the new decision follows the last row in its ledger (a withdrawal or an expiry), or
		// for a question asked again after its hold ended, the decision of the question before it.
		supersedes =
			decisionsOf(ctx.db, question.id).at(-1)?.id ??
			(question.prior !== null ? (questionById(ctx.db, question.prior)?.decision ?? null) : null);
	}
	const policy = currentPolicy(ctx.db, ctx.project.id);
	const holds = handler.holds({ question, answer: given, now: ctx.now, policy });
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
	refold(ctx, [...runsAbout(ctx, question), ...(supersedes !== null ? runsDependingOn(ctx.db, supersedes) : [])]);
	return { decision: { ...decision, effects: JSON.stringify(effects) }, effects };
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
	const policy = currentPolicy(ctx.db, ctx.project.id);
	const facts = new Set(json<{ facts?: string[] }>(question.evidence).facts ?? []);
	const clause = clauseFor(policy, { kind: question.kind, facts });
	const ask: Ask = clause.ask.who === "rule" ? { ...clause.ask, who: "member" } : clause.ask;
	const standing = standingOf({ actor: ctx.actor, ask, isAuthor: handler.isAuthor(ctx, question), isProducer: false });
	if (standing !== "counts") return reply(question, "forbidden", { needs: describeAsk(ask) });
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
	setQuestionAsk(ctx, question, clause.ask.who === "rule" ? ask : clause.ask);
	refold(ctx, [...runsAbout(ctx, question), ...runsDependingOn(ctx.db, prior.id)]);
	return reply(question, "reopened", { decision: decision.id });
}

// ── Keeping runs in step ───────────────────────────────────────────────────────────────────────────────────

/**
 * The runs a question is about: every run it names, whether or not it blocks them. A decision on a failure changes
 * how those runs count the failure even where policy lets the run proceed.
 */
function runsAbout(ctx: Ctx, question: QuestionRow): number[] {
	const ids = new Set(json<number[]>(question.blocks));
	for (const about of refsOf(ctx.db, question.id)) {
		if (!/^R-\d+$/.test(about)) continue;
		const run = findRun(ctx.db, ctx.project.id, about);
		if (run) ids.add(run.id);
	}
	return [...ids];
}

/**
 * Recomputes the given runs and acts on what follows: a planned run that has just passed gets its sign-off
 * question (which a rule may answer and so close the run).
 */
export function refold(ctx: Ctx, runIds: Iterable<number>, options: { dissolveStale?: boolean } = {}): void {
	for (const id of new Set(runIds)) {
		const existing = runById(ctx.db, id);
		if (!existing) continue;
		const result = retally(ctx, id, blockersOf(ctx, existing));
		if (options.dissolveStale) dissolveStale(ctx, result.run, result.failing);
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
		blocks: json<number[]>(open.blocks),
	}));
}

/**
 * A failure question about a cause that the newest evidence in its scope no longer shows is closed as dissolved:
 * nobody should be asked why something failed after it stopped failing. The question and its history remain.
 */
function dissolveStale(ctx: Ctx, run: RunRow, failing: ReadonlySet<number>): void {
	// Only the newest run of a scope speaks for it: a late report for an older commit must not close a question
	// that the current commit still raises.
	if (!isLatestInScope(ctx.db, run)) return;
	const scope = scopeOfRun(ctx.db, run);
	for (const open of openQuestionsOn(ctx.db, ctx.project.id, `scope:${scope}`)) {
		const question = questionById(ctx.db, open.id);
		if (question?.kind !== "failure") continue;
		const subject = json<{ signature: number; scope: string }>(question.subject);
		if (subject.scope !== scope || failing.has(subject.signature)) continue;
		setQuestionState(ctx, question, "dissolved", null);
	}
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
		isProducer: handler.isProducer(ctx, row),
	});
}
