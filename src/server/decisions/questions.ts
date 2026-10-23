// Storage for the queue and the ledgers. Owns questions, question_refs, answers, decisions and merge_receipts.
// The rules (who may answer, when a decision holds) are in decisions.ts; this file only reads and writes rows.
import { z } from "zod";
import { MergeReceipt, MergeReceiptResult, receiptNodeHash, receiptSnapshotHash } from "../../core/changes.ts";
import { type ActorKind, type Ask, ATTRIBUTED, type Kind } from "../../core/kinds.ts";
import { type Ctx, ref } from "../kernel/ctx.ts";
import { type Db, json, sql } from "../kernel/db.ts";
import { invalid, notFound } from "../kernel/errors.ts";

const causeFields = { signature: z.number(), scope: z.string() };
const StoredFailureSubject = z.union([
	z.strictObject(causeFields).transform((subject) => ({ kind: "cause" as const, ...subject })),
	z
		.strictObject({ ...causeFields, perResult: z.literal(true) })
		.transform(({ signature, scope }) => ({ kind: "inherited" as const, signature, scope })),
	z.strictObject({ ...causeFields, slot: z.number() }).transform((subject) => ({ kind: "slot" as const, ...subject })),
]);

export type FailureSubject = z.output<typeof StoredFailureSubject>;

export type QuestionSubjectInput =
	| { kind: "failure"; subject: FailureSubject }
	| { kind: Exclude<Kind, "failure">; subject: Record<string, unknown> };

type QuestionSubject =
	| { kind: "failure"; subject: FailureSubject }
	| { kind: Exclude<Kind, "failure">; subject: string };

type StoredQuestionRow = {
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

export type QuestionRow = Omit<StoredQuestionRow, "kind" | "subject"> & QuestionSubject;

function readSubject(row: Pick<StoredQuestionRow, "kind" | "subject">): QuestionSubject {
	return row.kind === "failure"
		? { kind: "failure", subject: StoredFailureSubject.parse(json<unknown>(row.subject)) }
		: { kind: row.kind, subject: row.subject };
}

function readQuestion(row: StoredQuestionRow): QuestionRow {
	return { ...row, ...readSubject(row) };
}

function storedFailureSubject(subject: FailureSubject): z.input<typeof StoredFailureSubject> {
	switch (subject.kind) {
		case "cause":
			return { signature: subject.signature, scope: subject.scope };
		case "inherited":
			return { signature: subject.signature, scope: subject.scope, perResult: true };
		case "slot":
			return { slot: subject.slot, signature: subject.signature, scope: subject.scope };
		default: {
			const _exhaustive: never = subject;
			return _exhaustive;
		}
	}
}

export type DecisionRow = {
	on_evidence: string | null;
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
	/**
	 * Holds for what the decision named and for nothing reported later: the results a "mistaken" answer set
	 * aside, the tests a link gave a case. What turns up later is asked about, and does not undo it.
	 */
	| { until: "results-named" };

export type Signer = { by: number; clause: string; policy: number; reason: string | null };

// Only the recorded endings of a hold belong in Settled after their question dissolves.
const HOLD_ENDING = `d.supersedes IS NOT NULL AND (
 (json_extract(d.answer, '$.is') = 'expired' AND json_extract(d.signers, '$[0].clause') = 'hold-expired')
 OR (json_extract(d.answer, '$.is') = 'outdated' AND json_extract(d.signers, '$[0].clause') IN ('tracker-closed', 'passed'))
)`;

type ReceiptRoot = { id: number; hash: string; count: number };
type ReceiptMember = { slot: number; child: number | null; payload: number | null; hash: string; count: number };

const Q = {
	receiptDecision: sql<{ id: number }, { answer: string }>(
		"SELECT json_extract(answer, '$.is') AS answer FROM decisions WHERE id=$id",
	),
	node: sql<{ id: number }, ReceiptRoot>("SELECT id,hash,count FROM merge_receipt_nodes WHERE id=$id"),
	nodeByHash: sql<{ project: number; hash: string }, ReceiptRoot>(
		"SELECT id,hash,count FROM merge_receipt_nodes WHERE project=$project AND hash=$hash",
	),
	insertNode: sql<{ project: number; hash: string; level: number; count: number }>(
		"INSERT INTO merge_receipt_nodes(project,hash,level,count) VALUES ($project,$hash,$level,$count)",
	),
	members: sql<{ node: number }, ReceiptMember>(
		`SELECT m.slot,m.child,m.payload,coalesce(n.hash,p.hash) AS hash,coalesce(n.count,1) AS count FROM merge_receipt_members m LEFT JOIN merge_receipt_nodes n ON n.id=m.child LEFT JOIN merge_receipt_payloads p ON p.id=m.payload WHERE m.node=$node ORDER BY m.slot`,
	),
	insertMember: sql<{ node: number; slot: number; child: number | null; payload: number | null }>(
		"INSERT INTO merge_receipt_members(node,slot,child,payload) VALUES ($node,$slot,$child,$payload)",
	),
	payload: sql<{ id: number }, { hash: string; body: string }>(
		"SELECT hash,body FROM merge_receipt_payloads WHERE id=$id",
	),
	insertPayload: sql<{ project: number; hash: string; body: string }>(
		"INSERT INTO merge_receipt_payloads(project,hash,body) VALUES ($project,$hash,$body) ON CONFLICT(project,hash) DO NOTHING",
	),
	payloadByHash: sql<{ project: number; hash: string }, { id: number }>(
		"SELECT id FROM merge_receipt_payloads WHERE project=$project AND hash=$hash",
	),
	cache: sql<{ run: number; project: number }, { root: number | null }>(
		"SELECT root FROM merge_receipt_heads WHERE run=$run AND project=$project",
	),
	setCache: sql<{ run: number; project: number; root: number | null }>(
		"INSERT INTO merge_receipt_heads(run,project,root) VALUES ($run,$project,$root) ON CONFLICT(run) DO UPDATE SET root=excluded.root",
	),
	dirty: sql<{ run: number; after: number }, { bucket: number }>(
		"SELECT bucket FROM merge_receipt_dirty WHERE run=$run AND bucket>$after ORDER BY bucket LIMIT 50",
	),
	clearDirty: sql<{ run: number }>("DELETE FROM merge_receipt_dirty WHERE run=$run"),
	snapshotByHash: sql<{ project: number; hash: string }, { id: number; count: number; evidence_count: number }>(
		"SELECT id,count,evidence_count FROM merge_receipt_snapshots WHERE project=$project AND hash=$hash",
	),
	insertSnapshot: sql<{
		project: number;
		hash: string;
		result_root: number | null;
		gate_root: number | null;
		count: number;
		evidence_count: number;
	}>(
		"INSERT INTO merge_receipt_snapshots(project,hash,result_root,gate_root,count,evidence_count) VALUES ($project,$hash,$result_root,$gate_root,$count,$evidence_count)",
	),
	roots: sql<{ project: number; receipt: number }, { result_root: number | null; gate_root: number | null }>(
		"SELECT s.result_root,s.gate_root FROM merge_receipts r JOIN merge_receipt_snapshots s ON s.id=r.evidence WHERE r.project=$project AND r.id=$receipt",
	),
	mergeReceipt: sql<{ id: number; project: number }, { id: number; snapshot: string }>(
		"SELECT id, snapshot FROM merge_receipts WHERE id = $id AND project = $project",
	),
	insertMergeReceipt: sql<{
		project: number;
		change: number;
		actor: number;
		at: number;
		seq: number;
		snapshot: string;
		evidence: number;
	}>(
		"INSERT INTO merge_receipts (project, change, actor, at, seq, snapshot, evidence) VALUES ($project, $change, $actor, $at, $seq, $snapshot, $evidence)",
	),
	latest: sql<{ project: number; fingerprint: string }, StoredQuestionRow>(
		"SELECT * FROM questions WHERE project = $project AND fingerprint = $fingerprint ORDER BY epoch DESC LIMIT 1",
	),
	// The questions of one cause that are open or whose decision is in force. A decision that stopped holding left
	// a row saying so (`expired`, `outdated`) as its question's decision: that question is history.
	live: sql<{ project: number; fingerprint: string }, StoredQuestionRow>(
		`SELECT q.* FROM questions q LEFT JOIN decisions d ON d.id = q.decision
		 WHERE q.project = $project AND q.fingerprint = $fingerprint
		   AND (q.state = 'open' OR (q.state = 'decided' AND d.id IS NOT NULL
		        AND json_extract(d.answer, '$.is') NOT IN ('expired', 'outdated', 'withdrawn')))
		 ORDER BY q.epoch DESC, q.id DESC`,
	),
	byNo: sql<{ project: number; no: number }, StoredQuestionRow>(
		"SELECT * FROM questions WHERE project = $project AND no = $no",
	),
	byId: sql<{ id: number }, StoredQuestionRow>("SELECT * FROM questions WHERE id = $id"),
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
	forgetAuthor: sql<{ name: string; pseudonym: string }>(
		`UPDATE questions SET evidence = json_set(evidence, '$.author', $pseudonym)
		 WHERE kind = 'adopt' AND json_extract(evidence, '$.author') = $name`,
	),
	forgetFinder: sql<{ name: string; pseudonym: string }>(
		`UPDATE questions SET evidence = json_set(evidence, '$.finder', $pseudonym)
		 WHERE kind = 'finding' AND json_extract(evidence, '$.finder') = $name`,
	),
	setParties: sql<{ id: number; parties: string }>(
		"UPDATE questions SET evidence = json_set(evidence, '$.parties', json($parties)) WHERE id = $id",
	),
	setFacts: sql<{ id: number; facts: string; parties: string }>(
		`UPDATE questions SET evidence = json_set(evidence, '$.facts', json($facts), '$.parties', json($parties))
		 WHERE id = $id`,
	),
	addRef: sql<{ project: number; ref: string; question: number }>(
		"INSERT OR IGNORE INTO question_refs (project, ref, question) VALUES ($project, $ref, $question)",
	),
	refsOf: sql<{ question: number }, { ref: string }>(
		"SELECT ref FROM question_refs WHERE question = $question ORDER BY ref",
	),
	onRef: sql<{ project: number; ref: string }, StoredQuestionRow>(
		`SELECT q.* FROM question_refs r JOIN questions q ON q.id = r.question
		 WHERE r.project = $project AND r.ref = $ref ORDER BY q.id DESC LIMIT 200`,
	),
	// Every question about a thing, with no cap: for a calculation that must reach each of them. (`onRef` is the
	// capped list a page shows.)
	allOnRef: sql<{ project: number; ref: string }, StoredQuestionRow>(
		`SELECT q.* FROM question_refs r JOIN questions q ON q.id = r.question
		 WHERE r.project = $project AND r.ref = $ref ORDER BY q.id`,
	),
	// A cause answer that says the target needs a fix and still stands: it ends when its cause passes.
	attributedOnRef: sql<{ project: number; ref: string }, StoredQuestionRow>(
		`SELECT q.* FROM question_refs r JOIN questions q ON q.id = r.question JOIN decisions d ON d.id = q.decision
		 WHERE r.project = $project AND r.ref = $ref AND q.kind = 'failure' AND q.state = 'decided'
		   AND json_extract(q.subject, '$.slot') IS NULL AND json_extract(q.subject, '$.perResult') IS NULL
		   AND json_extract(d.answer, '$.is') IN (${ATTRIBUTED.map((is) => `'${is}'`).join(", ")})
		 ORDER BY q.id`,
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
	// The queue is ordered by rank and id together: one report can raise many questions that share a rank, so a page
	// cut on the rank alone would skip the rest of them. (`questions_queue` ends in the id, so no sort is needed.)
	queue: sql<{ project: number; state: string; rank: number; id: number; limit: number }, StoredQuestionRow>(
		`SELECT * FROM questions WHERE project = $project AND state = $state AND owner = 0 AND (rank, id) > ($rank, $id)
		 ORDER BY rank, id LIMIT $limit`,
	),
	queueOfKind: sql<
		{ project: number; state: string; kind: string; rank: number; id: number; limit: number },
		StoredQuestionRow
	>(
		`SELECT * FROM questions WHERE project = $project AND state = $state AND owner = 0 AND (rank, id) > ($rank, $id)
		 AND kind = $kind ORDER BY rank, id LIMIT $limit`,
	),
	// Newest first. Several questions can be decided at one revision (one command), so the page is cut on the
	// revision and the id together.
	ledger: sql<{ project: number; rev: number; id: number; limit: number }, StoredQuestionRow>(
		`SELECT q.* FROM questions q LEFT JOIN decisions d ON d.id = q.decision
		 WHERE q.project = $project AND (q.state = 'decided' OR (q.state = 'dissolved' AND ${HOLD_ENDING}))
		 AND (q.rev, q.id) < ($rev, $id) ORDER BY q.rev DESC, q.id DESC LIMIT $limit`,
	),
	ledgerOfKind: sql<{ project: number; kind: string; rev: number; id: number; limit: number }, StoredQuestionRow>(
		`SELECT q.* FROM questions q LEFT JOIN decisions d ON d.id = q.decision
		 WHERE q.project = $project AND (q.state = 'decided' OR (q.state = 'dissolved' AND ${HOLD_ENDING}))
		 AND q.kind = $kind AND (q.rev, q.id) < ($rev, $id) ORDER BY q.rev DESC, q.id DESC LIMIT $limit`,
	),
	openIdsOfKind: sql<{ project: number; kind: string }, { id: number }>(
		"SELECT id FROM questions WHERE project = $project AND state = 'open' AND owner = 0 AND kind = $kind ORDER BY id",
	),
	openCount: sql<{ project: number }, { n: number }>(
		"SELECT count(*) AS n FROM questions WHERE project = $project AND state = 'open' AND owner = 0",
	),
	openByKind: sql<{ project: number }, { kind: Kind; n: number }>(
		"SELECT kind, count(*) AS n FROM questions WHERE project = $project AND state = 'open' AND owner = 0 GROUP BY kind",
	),
	changedSince: sql<{ project: number; rev: number; id: number; limit: number }, StoredQuestionRow>(
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
		hash: string;
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
		`INSERT INTO decisions (project, question, kind, answer, signers, basis, holds, expires_at, supersedes, at, seq, on_evidence)
		 VALUES ($project, $question, $kind, $answer, $signers, $basis, $holds, $expires, $supersedes, $at, $seq, $hash)`,
	),
	setEffects: sql<{ id: number; effects: string }>("UPDATE decisions SET effects = $effects WHERE id = $id"),
	decisionById: sql<{ id: number }, DecisionRow>("SELECT * FROM decisions WHERE id = $id"),
	holdEndingById: sql<{ id: number }, DecisionRow>(`SELECT d.* FROM decisions d WHERE d.id = $id AND ${HOLD_ENDING}`),
	decisionsOf: sql<{ question: number }, DecisionRow>("SELECT * FROM decisions WHERE question = $question ORDER BY id"),
	expired: sql<{ project: number; now: number }, DecisionRow>(
		`SELECT d.* FROM decisions d JOIN questions q ON q.decision = d.id
		 WHERE d.project = $project AND d.expires_at IS NOT NULL AND d.expires_at <= $now AND q.state = 'decided'`,
	),
	defects: sql<{ project: number }, DecisionRow>(
		`SELECT d.* FROM decisions d JOIN questions q ON q.decision = d.id
		 WHERE d.project = $project AND q.state = 'decided' AND d.kind = 'failure'
		 AND json_extract(d.answer, '$.is') = 'defect' AND json_type(d.answer, '$.ref') = 'text'`,
	),
};

/** Old evidence kept display names. Attribution is outside the material basis and target hashed by raise. */
export function forgetQuestionNames(db: Db, name: string, pseudonym: string): void {
	db.run(Q.forgetAuthor, { name, pseudonym });
	db.run(Q.forgetFinder, { name, pseudonym });
}

export const questionRef = (row: { no: number }): string => ref("question", row.no);

export function latestByFingerprint(db: Db, project: number, fingerprint: string): QuestionRow | null {
	const row = db.get(Q.latest, { project, fingerprint });
	return row ? readQuestion(row) : null;
}

/**
 * Every question about a cause that is open or decided with the decision still in force, newest first. Usually
 * one. More when an answer held for certain targets only and the cause was asked about again for the others.
 */
export const liveByFingerprint = (db: Db, project: number, fingerprint: string): QuestionRow[] =>
	db.all(Q.live, { project, fingerprint }).map(readQuestion);

export function questionById(db: Db, id: number): QuestionRow | null {
	const row = db.get(Q.byId, { id });
	return row ? readQuestion(row) : null;
}

export function mustQuestion(db: Db, project: number, text: string): QuestionRow {
	const match = /^(?:Q-)?(\d+)$/i.exec(text.trim());
	const row = match ? db.get(Q.byNo, { project, no: Number(match[1]) }) : null;
	if (!row) throw notFound(`question ${text}`);
	return readQuestion(row);
}

export function insertQuestion(
	ctx: Ctx,
	input: QuestionSubjectInput & {
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
		subject: JSON.stringify(input.kind === "failure" ? storedFailureSubject(input.subject) : input.subject),
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
	const row = questionById(ctx.db, lastId);
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

/** Adds to the parties a question keeps: whoever a dispute about its cause is kept from. */
export const addQuestionParties = (ctx: Ctx, question: QuestionRow, parties: readonly number[]): void => {
	const kept = json<{ parties?: number[] }>(question.evidence).parties ?? [];
	const all = [...new Set([...kept, ...parties])];
	if (all.length !== kept.length) ctx.db.run(Q.setParties, { id: question.id, parties: JSON.stringify(all) });
};

/**
 * Keeps on a question the policy facts its answer was given under and the parties to the dispute it settled, so
 * that changing or withdrawing the answer is held to the same clause and kept from the same people.
 */
export const setQuestionFacts = (
	ctx: Ctx,
	question: QuestionRow,
	facts: readonly string[],
	parties: readonly number[],
): void => {
	ctx.db.run(Q.setFacts, { id: question.id, facts: JSON.stringify(facts), parties: JSON.stringify(parties) });
};

export const refsOf = (db: Db, question: number): string[] => db.all(Q.refsOf, { question }).map((r) => r.ref);
export const questionsOn = (db: Db, project: number, about: string): QuestionRow[] =>
	db.all(Q.onRef, { project, ref: about }).map(readQuestion);
export const openQuestionsOn = (db: Db, project: number, about: string) =>
	db.all(Q.openOnRef, { project, ref: about }).map((row) => ({ ...row, ...readSubject(row) }));
/** The failure questions about a thing whose standing answer says the target needs a fix (`ATTRIBUTED`). */
export const attributedQuestionsOn = (db: Db, project: number, about: string): QuestionRow[] =>
	db.all(Q.attributedOnRef, { project, ref: about }).map(readQuestion);
/** Every question about a thing, oldest first, however many there are. */
export const everyQuestionOn = (db: Db, project: number, about: string): QuestionRow[] =>
	db.all(Q.allOnRef, { project, ref: about }).map(readQuestion);
export const openCountOn = (db: Db, project: number, about: string): number =>
	db.get(Q.openCountOnRef, { project, ref: about })?.n ?? 0;

/** A position in the queue: the rank and id of the last question seen. A client holds it as an opaque string. */
export type QueueCursor = { rank: number; id: number };

export const queueCursorOf = (row: Pick<QuestionRow, "rank" | "id">): string => `${row.rank}:${row.id}`;

/** The position a cursor names, or `undefined` for text that no page gave. */
export function parseQueueCursor(text: string): QueueCursor | undefined {
	const at = /^(-?\d+):(\d+)$/.exec(text);
	if (!at) return undefined;
	const [rank, id] = [Number(at[1]), Number(at[2])];
	return Number.isSafeInteger(rank) && Number.isSafeInteger(id) ? { rank, id } : undefined;
}

export function queuePage(
	db: Db,
	input: { project: number; state: "open"; kind: Kind | undefined; after: QueueCursor | null; limit: number },
) {
	const at = input.after ?? { rank: Number.MIN_SAFE_INTEGER, id: Number.MIN_SAFE_INTEGER };
	const base = { project: input.project, state: input.state, rank: at.rank, id: at.id, limit: input.limit };
	return (input.kind ? db.all(Q.queueOfKind, { ...base, kind: input.kind }) : db.all(Q.queue, base)).map(readQuestion);
}

/** A page of the ledger, newest first, after the position `before` (the revision and id of the last row seen). */
export function ledgerPage(
	db: Db,
	input: { project: number; kind: Kind | undefined; before: { rev: number; id: number } | null; limit: number },
) {
	const at = input.before ?? { rev: Number.MAX_SAFE_INTEGER, id: Number.MAX_SAFE_INTEGER };
	const base = { project: input.project, rev: at.rev, id: at.id, limit: input.limit };
	return (input.kind ? db.all(Q.ledgerOfKind, { ...base, kind: input.kind }) : db.all(Q.ledger, base)).map(
		readQuestion,
	);
}

/** The ids of every open question of a kind in the queue, oldest first, however many there are. */
export const openQuestionIds = (db: Db, project: number, kind: Kind): number[] =>
	db.all(Q.openIdsOfKind, { project, kind }).map((row) => row.id);

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
): QuestionRow[] => db.all(Q.changedSince, { project, rev: from.rev, id: from.id, limit }).map(readQuestion);

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
		hash: input.question.evidence_hash,
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
export const holdEndingById = (db: Db, id: number): DecisionRow | null => db.get(Q.holdEndingById, { id });
export const decisionsOf = (db: Db, question: number): DecisionRow[] => db.all(Q.decisionsOf, { question });
export const expiredDecisions = (db: Db, project: number, now: number): DecisionRow[] =>
	db.all(Q.expired, { project, now });

export const liveDefectDecisions = (db: Db, project: number): DecisionRow[] => db.all(Q.defects, { project });

/** An immutable observation decision, independent of question answers and their holds. */
export function insertMergeReceipt(
	ctx: Ctx,
	change: number,
	snapshot: Omit<MergeReceipt, "id">,
	evidence: number,
): number {
	return ctx.db.run(Q.insertMergeReceipt, {
		project: ctx.project.id,
		change,
		actor: ctx.actor.id,
		at: ctx.now,
		seq: ctx.seq,
		snapshot: JSON.stringify(snapshot),
		evidence,
	}).lastId;
}

export function mergeReceiptById(db: Db, project: number, id: number | null): MergeReceipt | null {
	if (id === null) return null;
	const row = db.get(Q.mergeReceipt, { id, project });
	return row ? MergeReceipt.parse({ ...json<Record<string, unknown>>(row.snapshot), id: row.id }) : null;
}

export const receiptDecisionAnswer = (db: Db, id: number): string => {
	const row = db.get(Q.receiptDecision, { id });
	if (!row) throw new Error(`counted decision ${id} is missing`);
	return row.answer;
};
const digest = (body: string) => new Bun.CryptoHasher("sha256").update(body).digest("hex");
const rootOf = (db: Db, id: number | null): ReceiptRoot | null => (id === null ? null : db.get(Q.node, { id }));

function payloadOf(ctx: Ctx, body: string): ReceiptRoot {
	if (Buffer.byteLength(body) > 32768) throw invalid("merge receipt evidence item exceeds 32 KiB");
	const hash = digest(body);
	const project = ctx.project.id;
	ctx.db.run(Q.insertPayload, { project, hash, body });
	const row = ctx.db.get(Q.payloadByHash, { project, hash });
	if (!row) throw new Error("receipt payload was not stored");
	return { ...row, hash, count: 1 };
}
function nodeOf(ctx: Ctx, level: number, members: ReceiptMember[]): ReceiptRoot | null {
	if (!members.length) return null;
	members.sort((a, b) => a.slot - b.slot);
	if (members.length > 32 || new Set(members.map((row) => row.slot)).size !== members.length)
		throw new Error("receipt page keys are not unique");
	const hash = receiptNodeHash(level, members);
	const project = ctx.project.id;
	const found = ctx.db.get(Q.nodeByHash, { project, hash });
	if (found) return found;
	const count = members.reduce((sum, row) => sum + row.count, 0);
	const id = ctx.db.run(Q.insertNode, { project, hash, level, count }).lastId;
	for (const row of members)
		ctx.db.run(Q.insertMember, { node: id, slot: row.slot, child: row.child, payload: row.payload });
	return { id, hash, count };
}

/** Copy only changed leaves and their ancestors. The iterator and recursion hold at most 32 entries per level. */
function updateTree(
	ctx: Ctx,
	root: ReceiptRoot | null,
	buckets: Iterable<number>,
	load: (bucket: number) => Iterable<{ key: number; body: string }>,
): ReceiptRoot | null {
	const iterator = buckets[Symbol.iterator]();
	let next = iterator.next();
	if (next.done) return root;
	function update(old: ReceiptRoot | null, level: number, base: number): ReceiptRoot | null {
		if (level === 0) {
			const members: ReceiptMember[] = [];
			for (const row of load(base)) {
				if (!Number.isSafeInteger(row.key) || row.key < 0)
					throw invalid("receipt key must be a nonnegative safe integer");
				const payload = payloadOf(ctx, row.body);
				members.push({ slot: row.key % 32, child: null, payload: payload.id, hash: payload.hash, count: 1 });
			}
			next = iterator.next();
			return nodeOf(ctx, 0, members);
		}
		const members = new Map((old ? ctx.db.all(Q.members, { node: old.id }) : []).map((row) => [row.slot, row]));
		const span = 32 ** (level - 1);
		while (!next.done && next.value < base + 32 ** level) {
			const slot = Math.floor((next.value - base) / span);
			const held = members.get(slot);
			const child = update(
				held?.child ? { id: held.child, hash: held.hash, count: held.count } : null,
				level - 1,
				base + slot * span,
			);
			if (child) members.set(slot, { slot, child: child.id, payload: null, hash: child.hash, count: child.count });
			else members.delete(slot);
		}
		return nodeOf(ctx, level, [...members.values()]);
	}
	return update(root, 10, 0);
}
function* dirtyBuckets(db: Db, run: number): Generator<number> {
	let after = -1;
	for (;;) {
		const page = db.all(Q.dirty, { run, after });
		if (!page.length) return;
		for (const row of page) {
			yield row.bucket;
			after = row.bucket;
		}
	}
}
/** Disposable roots are reused only while source-change triggers leave their dirty set empty. */
export function storeReceiptResults(
	ctx: Ctx,
	run: number,
	buckets: () => Iterable<number>,
	load: (bucket: number) => Iterable<{ key: number; body: string }>,
): ReceiptRoot | null {
	const cached = ctx.db.get(Q.cache, { run, project: ctx.project.id });
	const root = updateTree(
		ctx,
		cached ? rootOf(ctx.db, cached.root) : null,
		cached ? dirtyBuckets(ctx.db, run) : buckets(),
		load,
	);
	ctx.db.run(Q.setCache, { run, project: ctx.project.id, root: root?.id ?? null });
	ctx.db.run(Q.clearDirty, { run });
	return root;
}
/** Gate identity is separate: a new question reference cannot duplicate result memberships. */
export function storeMergeSnapshot(ctx: Ctx, results: ReceiptRoot | null, gate: Iterable<string>) {
	const iterator = gate[Symbol.iterator]();
	let next = iterator.next();
	let key = 0;
	function* buckets(): Generator<number> {
		while (!next.done) yield Math.floor(key / 32);
	}
	function* load(bucket: number): Generator<{ key: number; body: string }> {
		while (!next.done && Math.floor(key / 32) === bucket) {
			yield { key: key++, body: next.value };
			next = iterator.next();
		}
	}
	const gates = updateTree(ctx, null, buckets(), load);
	const hash = receiptSnapshotHash(results?.hash ?? null, gates?.hash ?? null);
	const project = ctx.project.id;
	const found = ctx.db.get(Q.snapshotByHash, { project, hash });
	if (found) return { ...found, hash };
	const count = results?.count ?? 0;
	const evidence_count = count + (gates?.count ?? 0);
	const id = ctx.db.run(Q.insertSnapshot, {
		project,
		hash,
		result_root: results?.id ?? null,
		gate_root: gates?.id ?? null,
		count,
		evidence_count,
	}).lastId;
	return { id, hash, count, evidence_count };
}
function* treePage(db: Db, node: ReceiptRoot | null, skip: number): Generator<{ hash: string; body: string }> {
	if (!node) return;
	for (const row of db.all(Q.members, { node: node.id })) {
		if (skip >= row.count) {
			skip -= row.count;
			continue;
		}
		if (row.child !== null) yield* treePage(db, { id: row.child, hash: row.hash, count: row.count }, skip);
		else if (row.payload !== null) {
			const payload = db.get(Q.payload, { id: row.payload });
			if (!payload) throw new Error("receipt payload is missing");
			yield payload;
		}
		skip = 0;
	}
}
/** Rank cursors are stable because historical roots and subtree counts are immutable. */
export function mergeReceiptPage(
	db: Db,
	project: number,
	receipt: number,
	cursor: string | undefined,
	limit: number,
	collection: "results" | "evidence" = "results",
) {
	const manifest = mergeReceiptById(db, project, receipt);
	const roots = db.get(Q.roots, { project, receipt });
	if (!manifest || !roots) throw notFound("merge receipt");
	const match = cursor ? /^(\d+)\.(results|evidence)\.(\d+)$/.exec(cursor) : null;
	if (
		cursor &&
		(!match || Number(match[1]) !== receipt || match[2] !== collection || !Number.isSafeInteger(Number(match[3])))
	)
		throw invalid("that is not a cursor of this receipt collection");
	const start = match ? Number(match[3]) + 1 : 0;
	const resultRoot = rootOf(db, roots.result_root);
	const gateRoot = rootOf(db, roots.gate_root);
	function* rows(): Generator<{ kind: "result" | "gate"; hash: string; body: string }> {
		if (collection === "evidence" && start < (gateRoot?.count ?? 0))
			for (const row of treePage(db, gateRoot, start)) yield { kind: "gate", ...row };
		const after = collection === "results" ? start : Math.max(0, start - (gateRoot?.count ?? 0));
		for (const row of treePage(db, resultRoot, after)) yield { kind: "result", ...row };
	}
	const page: { ordinal: number; kind: "result" | "gate"; hash: string; body: string }[] = [];
	let bytes = 0;
	let more = false;
	for (const row of rows()) {
		if (page.length >= Math.min(limit, 50) || bytes + Buffer.byteLength(row.body) > 65536) {
			more = true;
			break;
		}
		page.push({ ordinal: start + page.length, ...row });
		bytes += Buffer.byteLength(row.body);
	}
	const last = page.at(-1);
	return {
		count: collection === "results" ? manifest.count : manifest.evidenceCount,
		items: page.map((row) => (collection === "results" ? MergeReceiptResult.parse(json(row.body)) : row)),
		cursor: more && last ? `${receipt}.${collection}.${last.ordinal}` : null,
	};
}
