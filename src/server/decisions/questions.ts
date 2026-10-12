// Storage for the queue and the ledger. Owns questions, question_refs, answers and decisions.
// The rules (who may answer, when a decision holds) are in decisions.ts; this file only reads and writes rows.
import type { ActorKind, Ask, Kind } from "../../core/kinds.ts";
import { type Ctx, ref } from "../kernel/ctx.ts";
import { type Db, json, sql } from "../kernel/db.ts";
import { notFound } from "../kernel/errors.ts";

export type QuestionRow = {
	id: number;
	project: number;
	no: number;
	kind: Kind;
	subject: string;
	fingerprint: string;
	epoch: number;
	prior: number | null;
	title: string;
	producer: ActorKind;
	evidence: string;
	/** What a person answering must have seen: an answer names it, and one on an older value is a conflict. */
	evidence_hash: string;
	/** What a decision stands on. It leaves out the build, so an answer carries from one commit to the next. */
	basis: string;
	seen_count: number;
	seen_first: number;
	seen_last: number;
	carried: number;
	ask: string;
	blocks: string;
	owner: number;
	rank: number;
	state: "open" | "decided" | "dissolved";
	decision: number | null;
	opened_at: number;
	rev: number;
};

export type DecisionRow = {
	id: number;
	project: number;
	question: number;
	kind: Kind;
	answer: string;
	signers: string;
	basis: string;
	holds: string;
	expires_at: number | null;
	supersedes: number | null;
	effects: string;
	at: number;
	seq: number;
};

export type AnswerRow = {
	id: number;
	question: number;
	actor: number;
	answer: string;
	reason: string | null;
	on_evidence: string;
	counts: number;
	at: number;
	seq: number;
};

/** When a decision stops carrying forward. It ends when any one term ends. */
export type HoldTerm =
	| { until: "basis-changes"; basis: string }
	/** Holds on the target the person answering was looking at (the latest the question had seen), and on no other. */
	| { until: "this-target"; targets: number[] }
	| { until: "time"; at: number }
	/** Holds for the results the decision named and for nothing reported later: a new result is asked about. */
	| { until: "results-named" };

export type Signer = { by: number; clause: string; policy: number; reason: string | null };

const Q = {
	latest: sql<{ project: number; fingerprint: string }, QuestionRow>(
		"SELECT * FROM questions WHERE project = $project AND fingerprint = $fingerprint ORDER BY epoch DESC LIMIT 1",
	),
	// The questions of one cause that are open or whose decision is in force. A decision that stopped holding left
	// a row saying so (`expired`, `outdated`) as its question's decision: that question is history.
	live: sql<{ project: number; fingerprint: string }, QuestionRow>(
		`SELECT q.* FROM questions q LEFT JOIN decisions d ON d.id = q.decision
		 WHERE q.project = $project AND q.fingerprint = $fingerprint
		   AND (q.state = 'open' OR (q.state = 'decided' AND d.id IS NOT NULL
		        AND json_extract(d.answer, '$.is') NOT IN ('expired', 'outdated', 'withdrawn')))
		 ORDER BY q.epoch DESC, q.id DESC`,
	),
	byNo: sql<{ project: number; no: number }, QuestionRow>(
		"SELECT * FROM questions WHERE project = $project AND no = $no",
	),
	byId: sql<{ id: number }, QuestionRow>("SELECT * FROM questions WHERE id = $id"),
	insert: sql<{
		project: number;
		no: number;
		kind: string;
		subject: string;
		fingerprint: string;
		epoch: number;
		prior: number | null;
		title: string;
		producer: string;
		evidence: string;
		hash: string;
		basis: string;
		seq: number;
		ask: string;
		blocks: string;
		rank: number;
		at: number;
	}>(
		`INSERT INTO questions (project, no, kind, subject, fingerprint, epoch, prior, title, producer, evidence, evidence_hash,
		                        basis, seen_first, seen_last, ask, blocks, rank, state, opened_at, rev)
		 VALUES ($project, $no, $kind, $subject, $fingerprint, $epoch, $prior, $title, $producer, $evidence, $hash,
		         $basis, $seq, $seq, $ask, $blocks, $rank, 'open', $at, $seq)`,
	),
	attach: sql<{
		id: number;
		title: string;
		evidence: string;
		hash: string;
		basis: string;
		blocks: string;
		seq: number;
	}>(
		`UPDATE questions SET title = $title, evidence = $evidence, evidence_hash = $hash, basis = $basis, blocks = $blocks,
		                      seen_count = seen_count + 1, seen_last = $seq, rev = $seq WHERE id = $id`,
	),
	carry: sql<{ id: number; seq: number }>(
		"UPDATE questions SET carried = carried + 1, seen_count = seen_count + 1, seen_last = $seq, rev = $seq WHERE id = $id",
	),
	setState: sql<{ id: number; state: string; decision: number | null; seq: number }>(
		"UPDATE questions SET state = $state, decision = $decision, rev = $seq WHERE id = $id",
	),
	setAsk: sql<{ id: number; ask: string }>("UPDATE questions SET ask = $ask WHERE id = $id"),
	setFacts: sql<{ id: number; facts: string }>(
		"UPDATE questions SET evidence = json_set(evidence, '$.facts', json($facts)) WHERE id = $id",
	),
	addRef: sql<{ project: number; ref: string; question: number }>(
		"INSERT OR IGNORE INTO question_refs (project, ref, question) VALUES ($project, $ref, $question)",
	),
	refsOf: sql<{ question: number }, { ref: string }>(
		"SELECT ref FROM question_refs WHERE question = $question ORDER BY ref",
	),
	onRef: sql<{ project: number; ref: string }, QuestionRow>(
		`SELECT q.* FROM question_refs r JOIN questions q ON q.id = r.question
		 WHERE r.project = $project AND r.ref = $ref ORDER BY q.id DESC LIMIT 200`,
	),
	openOnRef: sql<
		{ project: number; ref: string },
		{ id: number; no: number; kind: Kind; subject: string; blocks: string }
	>(
		`SELECT q.id, q.no, q.kind, q.subject, q.blocks FROM question_refs r JOIN questions q ON q.id = r.question
		 WHERE r.project = $project AND r.ref = $ref AND q.state = 'open'`,
	),
	openCountOnRef: sql<{ project: number; ref: string }, { n: number }>(
		`SELECT count(*) AS n FROM question_refs r JOIN questions q ON q.id = r.question
		 WHERE r.project = $project AND r.ref = $ref AND q.state = 'open'`,
	),
	queue: sql<{ project: number; state: string; rank: number; limit: number }, QuestionRow>(
		`SELECT * FROM questions WHERE project = $project AND state = $state AND owner = 0 AND rank > $rank
		 ORDER BY rank LIMIT $limit`,
	),
	queueOfKind: sql<{ project: number; state: string; kind: string; rank: number; limit: number }, QuestionRow>(
		`SELECT * FROM questions WHERE project = $project AND state = $state AND owner = 0 AND rank > $rank AND kind = $kind
		 ORDER BY rank LIMIT $limit`,
	),
	// Newest first. Several questions can be decided at one revision (one command), so the page is cut on the
	// revision and the id together.
	ledger: sql<{ project: number; rev: number; id: number; limit: number }, QuestionRow>(
		`SELECT * FROM questions WHERE project = $project AND state = 'decided' AND (rev, id) < ($rev, $id)
		 ORDER BY rev DESC, id DESC LIMIT $limit`,
	),
	ledgerOfKind: sql<{ project: number; kind: string; rev: number; id: number; limit: number }, QuestionRow>(
		`SELECT * FROM questions WHERE project = $project AND state = 'decided' AND kind = $kind AND (rev, id) < ($rev, $id)
		 ORDER BY rev DESC, id DESC LIMIT $limit`,
	),
	openCount: sql<{ project: number }, { n: number }>(
		"SELECT count(*) AS n FROM questions WHERE project = $project AND state = 'open' AND owner = 0",
	),
	openByKind: sql<{ project: number }, { kind: Kind; n: number }>(
		"SELECT kind, count(*) AS n FROM questions WHERE project = $project AND state = 'open' AND owner = 0 GROUP BY kind",
	),
	changedSince: sql<{ project: number; rev: number; id: number; limit: number }, QuestionRow>(
		"SELECT * FROM questions WHERE project = $project AND (rev, id) >= ($rev, $id) ORDER BY rev, id LIMIT $limit",
	),
	insertAnswer: sql<{
		question: number;
		actor: number;
		answer: string;
		reason: string | null;
		hash: string;
		counts: number;
		at: number;
		seq: number;
	}>(
		`INSERT INTO answers (question, actor, answer, reason, on_evidence, counts, at, seq)
		 VALUES ($question, $actor, $answer, $reason, $hash, $counts, $at, $seq)`,
	),
	answersOf: sql<{ question: number }, AnswerRow>("SELECT * FROM answers WHERE question = $question ORDER BY id"),
	insertDecision: sql<{
		project: number;
		question: number;
		kind: string;
		answer: string;
		signers: string;
		basis: string;
		holds: string;
		expires: number | null;
		supersedes: number | null;
		at: number;
		seq: number;
	}>(
		`INSERT INTO decisions (project, question, kind, answer, signers, basis, holds, expires_at, supersedes, at, seq)
		 VALUES ($project, $question, $kind, $answer, $signers, $basis, $holds, $expires, $supersedes, $at, $seq)`,
	),
	setEffects: sql<{ id: number; effects: string }>("UPDATE decisions SET effects = $effects WHERE id = $id"),
	decisionById: sql<{ id: number }, DecisionRow>("SELECT * FROM decisions WHERE id = $id"),
	decisionsOf: sql<{ question: number }, DecisionRow>("SELECT * FROM decisions WHERE question = $question ORDER BY id"),
	expired: sql<{ project: number; now: number }, DecisionRow>(
		`SELECT d.* FROM decisions d JOIN questions q ON q.decision = d.id
		 WHERE d.project = $project AND d.expires_at IS NOT NULL AND d.expires_at <= $now AND q.state = 'decided'`,
	),
};

export const questionRef = (row: { no: number }): string => ref("question", row.no);

export const latestByFingerprint = (db: Db, project: number, fingerprint: string): QuestionRow | null =>
	db.get(Q.latest, { project, fingerprint });

/**
 * Every question about a cause that is open or decided with the decision still in force, newest first. Usually
 * one. More when an answer held for certain targets only and the cause was asked about again for the others.
 */
export const liveByFingerprint = (db: Db, project: number, fingerprint: string): QuestionRow[] =>
	db.all(Q.live, { project, fingerprint });

export const questionById = (db: Db, id: number): QuestionRow | null => db.get(Q.byId, { id });

export function mustQuestion(db: Db, project: number, text: string): QuestionRow {
	const match = /^(?:Q-)?(\d+)$/i.exec(text.trim());
	const row = match ? db.get(Q.byNo, { project, no: Number(match[1]) }) : null;
	if (!row) throw notFound(`question ${text}`);
	return row;
}

export function insertQuestion(
	ctx: Ctx,
	input: {
		kind: Kind;
		subject: unknown;
		fingerprint: string;
		epoch: number;
		prior: number | null;
		title: string;
		producer: ActorKind;
		evidence: unknown;
		hash: string;
		basis: string;
		ask: Ask;
		blocks: number[];
		rank: number;
		refs: readonly string[];
	},
): QuestionRow {
	const no = ctx.nextNo("question");
	const { lastId } = ctx.db.run(Q.insert, {
		project: ctx.project.id,
		no,
		kind: input.kind,
		subject: JSON.stringify(input.subject),
		fingerprint: input.fingerprint,
		epoch: input.epoch,
		prior: input.prior,
		title: input.title,
		producer: input.producer,
		evidence: JSON.stringify(input.evidence),
		hash: input.hash,
		basis: input.basis,
		seq: ctx.seq,
		ask: JSON.stringify(input.ask),
		blocks: JSON.stringify(input.blocks),
		rank: input.rank,
		at: ctx.now,
	});
	for (const about of input.refs) ctx.db.run(Q.addRef, { project: ctx.project.id, ref: about, question: lastId });
	ctx.touched.add(ref("question", no));
	const row = ctx.db.get(Q.byId, { id: lastId });
	if (!row) throw new Error("question was not stored");
	return row;
}

export function attachEvidence(
	ctx: Ctx,
	question: QuestionRow,
	input: { title: string; evidence: unknown; hash: string; basis: string; blocks: number[]; refs: readonly string[] },
): QuestionRow {
	const blocks = [...new Set([...json<number[]>(question.blocks), ...input.blocks])];
	ctx.db.run(Q.attach, {
		id: question.id,
		title: input.title,
		evidence: JSON.stringify(input.evidence),
		hash: input.hash,
		basis: input.basis,
		blocks: JSON.stringify(blocks),
		seq: ctx.seq,
	});
	for (const about of input.refs) ctx.db.run(Q.addRef, { project: ctx.project.id, ref: about, question: question.id });
	ctx.touched.add(questionRef(question));
	return questionById(ctx.db, question.id) ?? question;
}

/** Adds things a question is about, so each of them lists it. Returns how many it did not name before. */
export function alsoAbout(ctx: Ctx, question: QuestionRow, refs: readonly string[]): number {
	let added = 0;
	for (const about of refs)
		added += ctx.db.run(Q.addRef, { project: ctx.project.id, ref: about, question: question.id }).changes;
	if (added > 0) ctx.touched.add(questionRef(question));
	return added;
}

export function noteCarried(ctx: Ctx, question: QuestionRow, refs: readonly string[]): void {
	ctx.db.run(Q.carry, { id: question.id, seq: ctx.seq });
	for (const about of refs) ctx.db.run(Q.addRef, { project: ctx.project.id, ref: about, question: question.id });
}

export function setQuestionState(
	ctx: Ctx,
	question: QuestionRow,
	state: QuestionRow["state"],
	decision: number | null,
): void {
	ctx.db.run(Q.setState, { id: question.id, state, decision, seq: ctx.seq });
	ctx.touched.add(questionRef(question));
}

export const setQuestionAsk = (ctx: Ctx, question: QuestionRow, ask: Ask): void => {
	ctx.db.run(Q.setAsk, { id: question.id, ask: JSON.stringify(ask) });
};

/** Keeps on a question the policy facts its answer was given under, so that changing the answer is held to them. */
export const setQuestionFacts = (ctx: Ctx, question: QuestionRow, facts: readonly string[]): void => {
	ctx.db.run(Q.setFacts, { id: question.id, facts: JSON.stringify(facts) });
};

export const refsOf = (db: Db, question: number): string[] => db.all(Q.refsOf, { question }).map((r) => r.ref);
export const questionsOn = (db: Db, project: number, about: string): QuestionRow[] =>
	db.all(Q.onRef, { project, ref: about });
export const openQuestionsOn = (db: Db, project: number, about: string) => db.all(Q.openOnRef, { project, ref: about });
export const openCountOn = (db: Db, project: number, about: string): number =>
	db.get(Q.openCountOnRef, { project, ref: about })?.n ?? 0;

export function queuePage(
	db: Db,
	input: { project: number; state: "open"; kind: Kind | undefined; after: number; limit: number },
) {
	const base = { project: input.project, state: input.state, rank: input.after, limit: input.limit };
	return input.kind ? db.all(Q.queueOfKind, { ...base, kind: input.kind }) : db.all(Q.queue, base);
}

/** A page of the ledger, newest first, after the position `before` (the revision and id of the last row seen). */
export function ledgerPage(
	db: Db,
	input: { project: number; kind: Kind | undefined; before: { rev: number; id: number } | null; limit: number },
) {
	const at = input.before ?? { rev: Number.MAX_SAFE_INTEGER, id: Number.MAX_SAFE_INTEGER };
	const base = { project: input.project, rev: at.rev, id: at.id, limit: input.limit };
	return input.kind ? db.all(Q.ledgerOfKind, { ...base, kind: input.kind }) : db.all(Q.ledger, base);
}

export function openCounts(db: Db, project: number): Record<string, number> {
	const counts: Record<string, number> = { open: db.get(Q.openCount, { project })?.n ?? 0 };
	for (const row of db.all(Q.openByKind, { project })) counts[row.kind] = row.n;
	return counts;
}

/** Questions changed at or after a position (a revision and a question id within it), in that order. */
export const questionsChangedSince = (
	db: Db,
	project: number,
	from: { rev: number; id: number },
	limit: number,
): QuestionRow[] => db.all(Q.changedSince, { project, rev: from.rev, id: from.id, limit });

export function insertAnswer(
	ctx: Ctx,
	input: { question: number; answer: unknown; reason: string | null; hash: string; counts: boolean },
): void {
	ctx.db.run(Q.insertAnswer, {
		question: input.question,
		actor: ctx.actor.id,
		answer: JSON.stringify(input.answer),
		reason: input.reason,
		hash: input.hash,
		counts: input.counts ? 1 : 0,
		at: ctx.now,
		seq: ctx.seq,
	});
}

export const answersOf = (db: Db, question: number): AnswerRow[] => db.all(Q.answersOf, { question });

export function insertDecision(
	ctx: Ctx,
	input: {
		question: QuestionRow;
		answer: unknown;
		signers: Signer[];
		holds: HoldTerm[];
		supersedes: number | null;
	},
): DecisionRow {
	const expires = input.holds.flatMap((term) => (term.until === "time" ? [term.at] : []));
	const { lastId } = ctx.db.run(Q.insertDecision, {
		project: ctx.project.id,
		question: input.question.id,
		kind: input.question.kind,
		answer: JSON.stringify(input.answer),
		signers: JSON.stringify(input.signers),
		basis: input.question.basis,
		holds: JSON.stringify(input.holds),
		expires: expires.length > 0 ? Math.min(...expires) : null,
		supersedes: input.supersedes,
		at: ctx.now,
		seq: ctx.seq,
	});
	const row = ctx.db.get(Q.decisionById, { id: lastId });
	if (!row) throw new Error("decision was not stored");
	return row;
}

export const setDecisionEffects = (ctx: Ctx, decision: number, effects: unknown): void => {
	ctx.db.run(Q.setEffects, { id: decision, effects: JSON.stringify(effects) });
};

export const decisionById = (db: Db, id: number): DecisionRow | null => db.get(Q.decisionById, { id });
export const decisionsOf = (db: Db, question: number): DecisionRow[] => db.all(Q.decisionsOf, { question });
export const expiredDecisions = (db: Db, project: number, now: number): DecisionRow[] =>
	db.all(Q.expired, { project, now });
