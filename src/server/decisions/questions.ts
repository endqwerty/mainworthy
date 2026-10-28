// Storage for the queue and the ledgers. Owns questions, question_refs, answers, decisions and merge_receipts.
// The rules (who may answer, when a decision holds) are in decisions.ts; this file only reads and writes rows.
import { z } from "zod";
import { MergeReceipt, MergeReceiptResult, receiptNodeHash, receiptSnapshotHash } from "../../core/changes.ts";
import { contentHash } from "../../core/hash.ts";
import { type ActorKind, type Ask, ATTRIBUTED, type Kind } from "../../core/kinds.ts";
import { type Ctx, ref } from "../kernel/ctx.ts";
import { json, type ReadDb, sql, type WriteDb } from "../kernel/db.ts";
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

export function readSubject(row: Pick<StoredQuestionRow, "kind" | "subject">): QuestionSubject {
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
 ((d.answer::jsonb)->>'is' = 'expired' AND (d.signers::jsonb)->0->>'clause' = 'hold-expired')
 OR ((d.answer::jsonb)->>'is' = 'outdated' AND (d.signers::jsonb)->0->>'clause' IN ('tracker-closed', 'passed'))
)`;

type ReceiptRoot = { id: number; hash: string; count: number };
type ReceiptMember = { slot: number; child: number | null; payload: number | null; hash: string; count: number };

const Q = {
	openMapsInFile: sql<{ project: number; file: string }, StoredQuestionRow>(
		"SELECT * FROM questions WHERE project=$project AND kind='map' AND state='open' AND subject::jsonb->>'file'=$file ORDER BY id",
	),
	receiptDecision: sql<{ id: number }, { answer: string }>(
		"SELECT (answer::jsonb)->>'is' AS answer FROM decisions WHERE id=$id",
	),
	node: sql<{ id: number }, ReceiptRoot>("SELECT id,hash,count FROM merge_receipt_nodes WHERE id=$id"),
	nodeByHash: sql<{ project: number; hash: string }, ReceiptRoot>(
		"SELECT id,hash,count FROM merge_receipt_nodes WHERE project=$project AND hash=$hash",
	),
	insertNode: sql<{ project: number; hash: string; level: number; count: number }, { id: number }>(
		"INSERT INTO merge_receipt_nodes(project,hash,level,count) VALUES ($project,$hash,$level,$count) RETURNING id",
	),
	members: sql<{ node: number }, ReceiptMember>(
		`SELECT m.slot,m.child,m.payload,coalesce(n.hash,p.hash) AS hash,coalesce(n.count,1) AS count FROM merge_receipt_members m LEFT JOIN merge_receipt_nodes n ON n.id=m.child LEFT JOIN merge_receipt_payloads p ON p.id=m.payload WHERE m.node=$node ORDER BY m.slot`,
	),
	insertMembers: sql<{
		node: number;
		slots: readonly number[];
		children: readonly (number | null)[];
		payloads: readonly (number | null)[];
	}>(
		"INSERT INTO merge_receipt_members(node,slot,child,payload) SELECT $node,u.slot,u.child,u.payload FROM unnest($slots::bigint[],$children::bigint[],$payloads::bigint[]) AS u(slot,child,payload)",
	),
	payload: sql<{ id: number }, { hash: string; body: string }>(
		"SELECT hash,body FROM merge_receipt_payloads WHERE id=$id",
	),
	insertPayloads: sql<{ project: number; hashes: readonly string[]; bodies: readonly string[] }>(
		"INSERT INTO merge_receipt_payloads(project,hash,body) SELECT $project,u.hash,u.body FROM unnest($hashes::text[],$bodies::text[]) WITH ORDINALITY AS u(hash,body,position) ORDER BY u.position ON CONFLICT(project,hash) DO NOTHING",
	),
	payloadsByHashes: sql<{ project: number; hashes: readonly string[] }, { id: number; hash: string }>(
		"SELECT id,hash FROM merge_receipt_payloads WHERE project=$project AND hash=ANY($hashes::text[])",
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
	insertSnapshot: sql<
		{
			project: number;
			hash: string;
			result_root: number | null;
			gate_root: number | null;
			count: number;
			evidence_count: number;
		},
		{ id: number }
	>(
		"INSERT INTO merge_receipt_snapshots(project,hash,result_root,gate_root,count,evidence_count) VALUES ($project,$hash,$result_root,$gate_root,$count,$evidence_count) RETURNING id",
	),
	roots: sql<{ project: number; receipt: number }, { result_root: number | null; gate_root: number | null }>(
		"SELECT s.result_root,s.gate_root FROM merge_receipts r JOIN merge_receipt_snapshots s ON s.id=r.evidence WHERE r.project=$project AND r.id=$receipt",
	),
	mergeReceipt: sql<{ id: number; project: number }, { id: number; snapshot: string }>(
		"SELECT id, snapshot FROM merge_receipts WHERE id = $id AND project = $project",
	),
	insertMergeReceipt: sql<
		{
			project: number;
			change: number;
			actor: number;
			at: number;
			seq: number;
			snapshot: string;
			evidence: number;
		},
		{ id: number }
	>(
		"INSERT INTO merge_receipts (project, change, actor, at, seq, snapshot, evidence) VALUES ($project, $change, $actor, $at, $seq, $snapshot, $evidence) RETURNING id",
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
		        AND (d.answer::jsonb)->>'is' NOT IN ('expired', 'outdated', 'withdrawn')))
		 ORDER BY q.epoch DESC, q.id DESC`,
	),
	byNo: sql<{ project: number; no: number }, StoredQuestionRow>(
		"SELECT * FROM questions WHERE project = $project AND no = $no",
	),
	byId: sql<{ id: number }, StoredQuestionRow>("SELECT * FROM questions WHERE id = $id"),
	insert: sql<
		{
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
		},
		{ id: number }
	>(
		`INSERT INTO questions (project, no, kind, subject, fingerprint, epoch, prior, title, producer, evidence, evidence_hash,
		                        basis, seen_first, seen_last, ask, blocks, rank, state, opened_at, rev)
		 VALUES ($project, $no, $kind, $subject, $fingerprint, $epoch, $prior, $title, $producer, $evidence, $hash,
		         $basis, $seq, $seq, $ask, $blocks, $rank, 'open', $at, $seq) RETURNING id`,
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
	carry: sql<{ id: number; seq: number; evidence: string; hash: string }>(
		"UPDATE questions SET evidence = $evidence, evidence_hash = $hash, carried = carried + 1, seen_count = seen_count + 1, seen_last = $seq, rev = $seq WHERE id = $id",
	),
	setState: sql<{ id: number; state: string; decision: number | null; seq: number }>(
		"UPDATE questions SET state = $state, decision = $decision, rev = $seq WHERE id = $id",
	),
	setAsk: sql<{ id: number; ask: string }>("UPDATE questions SET ask = $ask WHERE id = $id"),
	forgetAuthor: sql<{ name: string; pseudonym: string }>(
		`UPDATE questions SET evidence = jsonb_set(evidence::jsonb, '{author}', to_jsonb($pseudonym::text))::text
		 WHERE kind = 'adopt' AND (evidence::jsonb)->>'author' = $name`,
	),
	forgetFinder: sql<{ name: string; pseudonym: string }>(
		`UPDATE questions SET evidence = jsonb_set(evidence::jsonb, '{finder}', to_jsonb($pseudonym::text))::text
		 WHERE kind = 'finding' AND (evidence::jsonb)->>'finder' = $name`,
	),
	setParties: sql<{ id: number; parties: string }>(
		"UPDATE questions SET evidence = jsonb_set(evidence::jsonb, '{parties}', $parties::text::jsonb)::text WHERE id = $id",
	),
	setFacts: sql<{ id: number; facts: string; parties: string }>(
		`UPDATE questions SET evidence = jsonb_set(jsonb_set(evidence::jsonb, '{facts}', $facts::text::jsonb), '{parties}', $parties::text::jsonb)::text
		 WHERE id = $id`,
	),
	addRefs: sql<{ project: number; refs: readonly string[]; question: number }>(
		`INSERT INTO question_refs (project, ref, question)
 SELECT $project, requested.ref, $question FROM unnest($refs::text[]) AS requested(ref) ON CONFLICT DO NOTHING`,
	),
	refsForItems: sql<{ ids: readonly number[] }, { question: number; ref: string }>(
		"SELECT question, ref FROM question_refs WHERE question = ANY($ids::bigint[]) ORDER BY question, ref",
	),
	answersForItems: sql<{ ids: readonly number[] }, AnswerRow>(
		"SELECT * FROM answers WHERE question = ANY($ids::bigint[]) ORDER BY id",
	),
	refsOf: sql<{ question: number }, { ref: string }>(
		"SELECT ref FROM question_refs WHERE question = $question ORDER BY ref",
	),
	refsOfQuestions: sql<{ questions: readonly number[] }, { ref: string }>(
		`SELECT DISTINCT r.ref FROM unnest($questions::bigint[]) AS asked(value)
		 JOIN question_refs r ON r.question = asked.value`,
	),
	openSummariesOnRefs: sql<
		{ project: number; refs: readonly string[] },
		{ ref: string; no: number; evidence_hash: string }
	>(
		`SELECT asked.value AS ref, q.no, q.evidence_hash FROM unnest($refs::text[]) WITH ORDINALITY AS asked(value, key) JOIN questions q ON q.id IN (
			SELECT r.question FROM question_refs r WHERE r.project = $project AND r.ref = asked.value
			ORDER BY r.question DESC LIMIT 200
		 ) WHERE q.state = 'open' ORDER BY CAST(asked.key AS INTEGER), q.id DESC`,
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
	inheritedRunRefs: sql<{ project: number }, { ref: string }>(
		"SELECT DISTINCT ref FROM question_refs WHERE project = $project AND ref LIKE 'inherited:R-%'",
	),
	// A cause answer that says the target needs a fix and still stands: it ends when its cause passes.
	attributedOnRef: sql<{ project: number; ref: string }, StoredQuestionRow>(
		"WITH answered AS MATERIALIZED (SELECT q.* FROM questions q JOIN decisions d ON d.id = q.decision WHERE q.project = $project AND q.kind = 'failure' AND q.state = 'decided' AND (q.subject::jsonb)->>'slot' IS NULL AND (q.subject::jsonb)->>'perResult' IS NULL AND (d.answer::jsonb)->>'is' IN (" +
			ATTRIBUTED.map((is) => "'" + is + "'").join(", ") +
			")) SELECT q.* FROM answered q JOIN question_refs r ON r.question = q.id WHERE r.project = $project AND r.ref = $ref ORDER BY q.id",
	),
	openOnRef: sql<
		{ project: number; ref: string },
		{ id: number; no: number; kind: Kind; subject: string; blocks: string }
	>(
		"WITH current_questions AS MATERIALIZED (SELECT id, no, kind, subject, blocks FROM questions WHERE project = $project AND state = 'open') SELECT q.* FROM current_questions q JOIN question_refs r ON r.question = q.id WHERE r.project = $project AND r.ref = $ref ORDER BY q.id",
	),
	openCountsOnRefs: sql<{ project: number; refs: readonly string[] }, { ref: string; n: number }>(
		"WITH current_questions AS MATERIALIZED (SELECT id FROM questions WHERE project = $project AND state = 'open') SELECT r.ref, count(*) AS n FROM current_questions q JOIN question_refs r ON r.question = q.id WHERE r.project = $project AND r.ref = ANY($refs::text[]) GROUP BY r.ref",
	),
	openCountOnRef: sql<{ project: number; ref: string }, { n: number }>(
		"WITH current_questions AS MATERIALIZED (SELECT id FROM questions WHERE project = $project AND state = 'open') SELECT count(*) AS n FROM current_questions q JOIN question_refs r ON r.question = q.id WHERE r.project = $project AND r.ref = $ref",
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
	freshMaps: sql<{ ids: readonly number[]; project: number }, StoredQuestionRow>(
		"SELECT q.* FROM questions q WHERE q.project = $project AND q.id = ANY($ids::bigint[]) AND q.kind = 'map' AND q.state = 'open' AND q.owner = 0 AND q.prior IS NULL AND q.decision IS NULL AND q.blocks = '[]' AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.question = q.id) AND NOT EXISTS (SELECT 1 FROM question_refs r WHERE r.question = q.id AND r.ref LIKE 'R-%') ORDER BY q.id",
	),
	trackFreshMaps: sql<{ rows: string; project: number; at: number; seq: number }, { no: number }>(
		"WITH asked AS MATERIALIZED (SELECT * FROM jsonb_to_recordset($rows::text::jsonb) AS x(id bigint, ask text, holds text, signers text)), " +
			"made AS (INSERT INTO decisions (project, question, kind, answer, signers, basis, holds, expires_at, supersedes, at, seq, on_evidence) SELECT $project, q.id, 'map', '{\"is\":\"track\"}', x.signers, q.basis, x.holds, NULL, NULL, $at, $seq, q.evidence_hash FROM asked x JOIN questions q ON q.id = x.id ORDER BY q.id RETURNING id, question) " +
			"UPDATE questions q SET ask = x.ask, state = 'decided', decision = made.id, rev = $seq FROM made JOIN asked x ON x.id = made.question WHERE q.id = made.question RETURNING q.no",
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
	pendingAnswersOf: sql<{ question: number; hash: string }, AnswerRow>(
		`SELECT * FROM (
			SELECT DISTINCT ON (actor) * FROM answers
			WHERE question = $question AND on_evidence = $hash
			AND seq > COALESCE((SELECT MAX(seq) FROM decisions WHERE question = $question), 0)
			ORDER BY actor, seq DESC, id DESC
		) latest ORDER BY seq, id`,
	),
	insertDecision: sql<
		{
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
		},
		{ id: number }
	>(
		`INSERT INTO decisions (project, question, kind, answer, signers, basis, holds, expires_at, supersedes, at, seq, on_evidence)
		 VALUES ($project, $question, $kind, $answer, $signers, $basis, $holds, $expires, $supersedes, $at, $seq, $hash) RETURNING id`,
	),
	independentFailureDecisions: sql<{ project: number; ids: readonly number[] }, DecisionRow>(
		`SELECT d.* FROM questions q JOIN decisions d ON d.id = q.decision
		 WHERE q.project = $project AND q.id = ANY($ids::bigint[]) AND q.state = 'decided'
		 AND NOT EXISTS (SELECT 1 FROM questions other WHERE other.project = q.project
		   AND other.fingerprint = q.fingerprint AND other.id != q.id AND other.state IN ('open', 'decided'))`,
	),
	endPassedHolds: sql<{ rows: string; project: number; at: number; seq: number }, { no: number }>(
		`WITH ending AS MATERIALIZED (
		 SELECT * FROM jsonb_to_recordset($rows::text::jsonb)
		 AS x(question bigint, decision bigint, answer text, signers text, ord bigint)
		), made AS (
		 INSERT INTO decisions (project, question, kind, answer, signers, basis, holds, expires_at, supersedes, at, seq, on_evidence)
		 SELECT $project, q.id, q.kind, x.answer, x.signers, q.basis, '[]', NULL, x.decision, $at, $seq, q.evidence_hash
		 FROM ending x JOIN questions q ON q.id = x.question ORDER BY x.ord RETURNING id, question
		)
		 UPDATE questions q SET state = 'dissolved', decision = made.id, rev = $seq
		 FROM made WHERE q.id = made.question RETURNING q.no`,
	),
	setEffects: sql<{ id: number; effects: string }>("UPDATE decisions SET effects = $effects WHERE id = $id"),
	decisionById: sql<{ id: number }, DecisionRow>("SELECT * FROM decisions WHERE id = $id"),
	decisionsByIds: sql<{ ids: readonly number[] }, DecisionRow>(
		"SELECT * FROM decisions WHERE id = ANY($ids::bigint[])",
	),
	holdEndingById: sql<{ id: number }, DecisionRow>(`SELECT d.* FROM decisions d WHERE d.id = $id AND ${HOLD_ENDING}`),
	nearestJudgment: sql<{ question: number }, DecisionRow>(`
 WITH RECURSIVE history AS (
  SELECT id,prior,ARRAY[id] AS path,0 AS depth FROM questions WHERE id=$question
  UNION ALL SELECT q.id,q.prior,h.path||q.id,h.depth+1 FROM questions q JOIN history h ON q.id=h.prior WHERE NOT q.id=ANY(h.path)
 ) SELECT d.* FROM history h JOIN decisions d ON d.question=h.id
 WHERE coalesce((d.answer::jsonb)->>'is','') NOT IN ('expired','outdated','withdrawn')
 ORDER BY h.depth,d.id DESC LIMIT 1`),
	decisionsOf: sql<{ question: number }, DecisionRow>("SELECT * FROM decisions WHERE question = $question ORDER BY id"),
	expired: sql<{ project: number; now: number }, DecisionRow>(
		`SELECT d.* FROM decisions d JOIN questions q ON q.decision = d.id
		 WHERE d.project = $project AND d.expires_at IS NOT NULL AND d.expires_at <= $now AND q.state = 'decided'`,
	),
	defects: sql<{ project: number }, DecisionRow>(
		`SELECT d.* FROM decisions d JOIN questions q ON q.decision = d.id
		 WHERE d.project = $project AND q.state = 'decided' AND d.kind = 'failure'
		 AND (d.answer::jsonb)->>'is' = 'defect' AND jsonb_typeof((d.answer::jsonb)->'ref') = 'string'`,
	),
};

/** Old evidence kept display names. Attribution is outside the material basis and target hashed by raise. */
export async function forgetQuestionNames(db: WriteDb, name: string, pseudonym: string): Promise<void> {
	await db.run(Q.forgetAuthor, { name, pseudonym });
	await db.run(Q.forgetFinder, { name, pseudonym });
}

export const questionRef = (row: { no: number }): string => ref("question", row.no);

export async function latestByFingerprint(
	db: ReadDb,
	project: number,
	fingerprint: string,
): Promise<QuestionRow | null> {
	const row = await db.get(Q.latest, { project, fingerprint });
	return row ? readQuestion(row) : null;
}

/**
 * Every question about a cause that is open or decided with the decision still in force, newest first. Usually
 * one. More when an answer held for certain targets only and the cause was asked about again for the others.
 */
export const liveByFingerprint = async (db: ReadDb, project: number, fingerprint: string): Promise<QuestionRow[]> =>
	(await db.all(Q.live, { project, fingerprint })).map(readQuestion);

export async function questionById(db: ReadDb, id: number): Promise<QuestionRow | null> {
	const row = await db.get(Q.byId, { id });
	return row ? readQuestion(row) : null;
}

export async function mustQuestion(db: ReadDb, project: number, text: string): Promise<QuestionRow> {
	const match = /^(?:Q-)?(\d+)$/i.exec(text.trim());
	const row = match ? await db.get(Q.byNo, { project, no: Number(match[1]) }) : null;
	if (!row) throw notFound(`question ${text}`);
	return readQuestion(row);
}

async function addRefs(ctx: Ctx, question: number, refs: readonly string[]): Promise<number> {
	let added = 0;
	for (let start = 0; start < refs.length; start += 200)
		added += (await ctx.db.run(Q.addRefs, { project: ctx.project.id, question, refs: refs.slice(start, start + 200) }))
			.changes;
	return added;
}

export async function insertQuestion(
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
): Promise<QuestionRow> {
	const no = await ctx.nextNo("question");
	const { id: insertedId } = await ctx.db.one(Q.insert, {
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
	await addRefs(ctx, insertedId, input.refs);
	ctx.touched.add(ref("question", no));
	const row = await questionById(ctx.db, insertedId);
	if (!row) throw new Error("question was not stored");
	return row;
}

export async function attachEvidence(
	ctx: Ctx,
	question: QuestionRow,
	input: { title: string; evidence: unknown; hash: string; basis: string; blocks: number[]; refs: readonly string[] },
): Promise<QuestionRow> {
	const blocks = [...new Set([...json<number[]>(question.blocks), ...input.blocks])];
	await ctx.db.run(Q.attach, {
		id: question.id,
		title: input.title,
		evidence: JSON.stringify(input.evidence),
		hash: input.hash,
		basis: input.basis,
		blocks: JSON.stringify(blocks),
		seq: ctx.seq,
	});
	await addRefs(ctx, question.id, input.refs);
	ctx.touched.add(questionRef(question));
	return (await questionById(ctx.db, question.id)) ?? question;
}

/** Adds things a question is about, so each of them lists it. Returns how many it did not name before. */
export async function alsoAbout(ctx: Ctx, question: QuestionRow, refs: readonly string[]): Promise<number> {
	const added = await addRefs(ctx, question.id, refs);
	if (added > 0) ctx.touched.add(questionRef(question));
	return added;
}

export async function noteCarried(
	ctx: Ctx,
	question: QuestionRow,
	refs: readonly string[],
	occurrence?: string,
): Promise<QuestionRow> {
	let evidence = question.evidence;
	let hash = question.evidence_hash;
	if (question.kind === "failure" && question.subject.kind === "cause" && occurrence) {
		type Tests = { tests?: { id: number; counted?: boolean }[]; count?: number };
		const kept = json<Tests>(evidence);
		const incoming = json<Tests>(occurrence);
		const tests = new Map((kept.tests ?? []).map((test) => [test.id, test]));
		const extendsTests = incoming.tests?.some((test) => !tests.has(test.id)) ?? false;
		for (const test of incoming.tests ?? []) {
			const prior = tests.get(test.id);
			tests.set(test.id, { ...test, ...prior, ...(test.counted || prior?.counted ? { counted: true } : {}) });
		}
		// Keep the original target and basis, extending the tests the standing answer covers.
		evidence = JSON.stringify({
			...kept,
			tests: [...tests.values()].slice(0, 50),
			count: Math.max(tests.size, kept.count ?? 0, incoming.count ?? 0),
		});
		// Even tests beyond the display cap change what a replacement answer must have seen.
		if (extendsTests || contentHash(kept) !== contentHash(json(evidence)))
			hash = contentHash({ prior: question.evidence_hash, occurrence: json(occurrence) });
	}
	await ctx.db.run(Q.carry, { id: question.id, seq: ctx.seq, evidence, hash });
	await addRefs(ctx, question.id, refs);
	return { ...question, evidence, evidence_hash: hash };
}

export async function setQuestionState(
	ctx: Ctx,
	question: QuestionRow,
	state: QuestionRow["state"],
	decision: number | null,
): Promise<void> {
	await ctx.db.run(Q.setState, { id: question.id, state, decision, seq: ctx.seq });
	ctx.touched.add(questionRef(question));
}

export const setQuestionAsk = async (ctx: Ctx, question: QuestionRow, ask: Ask): Promise<void> => {
	await ctx.db.run(Q.setAsk, { id: question.id, ask: JSON.stringify(ask) });
};

/** Adds to the parties a question keeps: whoever a dispute about its cause is kept from. */
export const addQuestionParties = async (
	ctx: Ctx,
	question: QuestionRow,
	parties: readonly number[],
): Promise<void> => {
	const kept = json<{ parties?: number[] }>(question.evidence).parties ?? [];
	const all = [...new Set([...kept, ...parties])];
	if (all.length !== kept.length) await ctx.db.run(Q.setParties, { id: question.id, parties: JSON.stringify(all) });
};

/**
 * Keeps on a question the policy facts its answer was given under and the parties to the dispute it settled, so
 * that changing or withdrawing the answer is held to the same clause and kept from the same people.
 */
export const setQuestionFacts = async (
	ctx: Ctx,
	question: QuestionRow,
	facts: readonly string[],
	parties: readonly number[],
): Promise<void> => {
	await ctx.db.run(Q.setFacts, { id: question.id, facts: JSON.stringify(facts), parties: JSON.stringify(parties) });
};

export const refsOf = async (db: ReadDb, question: number): Promise<string[]> =>
	(await db.all(Q.refsOf, { question })).map((r) => r.ref);
export const inheritedRunRefs = async (db: ReadDb, project: number): Promise<Set<string>> =>
	new Set((await db.all(Q.inheritedRunRefs, { project })).map((row) => row.ref.slice("inherited:".length)));
export const refsOfQuestions = async (db: ReadDb, questions: readonly number[]): Promise<string[]> =>
	questions.length ? (await db.all(Q.refsOfQuestions, { questions })).map((row) => row.ref) : [];
/** Open summaries among each ref's latest 200 questions, matching questionsOn's bound and order. */
export async function openQuestionSummariesOnRefs(db: ReadDb, project: number, refs: readonly string[]) {
	const byRef = new Map<string, { q: string; evidence: string }[]>();
	for (const row of await db.all(Q.openSummariesOnRefs, { project, refs })) {
		const items = byRef.get(row.ref) ?? [];
		items.push({ q: questionRef(row), evidence: row.evidence_hash });
		byRef.set(row.ref, items);
	}
	return byRef;
}
export const questionsOn = async (db: ReadDb, project: number, about: string): Promise<QuestionRow[]> =>
	(await db.all(Q.onRef, { project, ref: about })).map(readQuestion);
export const openQuestionsOn = async (db: ReadDb, project: number, about: string) =>
	(await db.all(Q.openOnRef, { project, ref: about })).map((row) => ({ ...row, ...readSubject(row) }));
/** The failure questions about a thing whose standing answer says the target needs a fix (`ATTRIBUTED`). */
export const attributedQuestionsOn = async (db: ReadDb, project: number, about: string): Promise<QuestionRow[]> =>
	(await db.all(Q.attributedOnRef, { project, ref: about })).map(readQuestion);
/** Every question about a thing, oldest first, however many there are. */
export const everyQuestionOn = async (db: ReadDb, project: number, about: string): Promise<QuestionRow[]> =>
	(await db.all(Q.allOnRef, { project, ref: about })).map(readQuestion);
export const openCountsOn = async (
	db: ReadDb,
	project: number,
	refs: readonly string[],
): Promise<Map<string, number>> =>
	new Map((await db.all(Q.openCountsOnRefs, { project, refs })).map((row) => [row.ref, row.n]));
export const openCountOn = async (db: ReadDb, project: number, about: string): Promise<number> =>
	(await db.get(Q.openCountOnRef, { project, ref: about }))?.n ?? 0;

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

export async function queuePage(
	db: ReadDb,
	input: { project: number; state: "open"; kind: Kind | undefined; after: QueueCursor | null; limit: number },
) {
	const at = input.after ?? { rank: Number.MIN_SAFE_INTEGER, id: Number.MIN_SAFE_INTEGER };
	const base = { project: input.project, state: input.state, rank: at.rank, id: at.id, limit: input.limit };
	return (input.kind ? await db.all(Q.queueOfKind, { ...base, kind: input.kind }) : await db.all(Q.queue, base)).map(
		readQuestion,
	);
}

/** A page of the ledger, newest first, after the position `before` (the revision and id of the last row seen). */
export async function ledgerPage(
	db: ReadDb,
	input: { project: number; kind: Kind | undefined; before: { rev: number; id: number } | null; limit: number },
) {
	const at = input.before ?? { rev: Number.MAX_SAFE_INTEGER, id: Number.MAX_SAFE_INTEGER };
	const base = { project: input.project, rev: at.rev, id: at.id, limit: input.limit };
	return (input.kind ? await db.all(Q.ledgerOfKind, { ...base, kind: input.kind }) : await db.all(Q.ledger, base)).map(
		readQuestion,
	);
}

/** The ids of every open question of a kind in the queue, oldest first, however many there are. */
/** A first mapping question with no prior judgement or affected run has no history to reconsider. */
export const freshMapQuestions = async (db: ReadDb, project: number, ids: readonly number[]): Promise<QuestionRow[]> =>
	(await db.all(Q.freshMaps, { project, ids })).map(readQuestion);

/** Track has no link or run effect; each question still receives its own immutable decision and hold. */
export async function trackFreshMapQuestions(
	ctx: Ctx,
	rows: readonly { question: QuestionRow; ask: Ask; signers: Signer[]; holds: HoldTerm[] }[],
): Promise<void> {
	const updated = await ctx.db.all(Q.trackFreshMaps, {
		project: ctx.project.id,
		at: ctx.now,
		seq: ctx.seq,
		rows: JSON.stringify(
			rows.map((row) => ({
				id: row.question.id,
				ask: JSON.stringify(row.ask),
				signers: JSON.stringify(row.signers),
				holds: JSON.stringify(row.holds),
			})),
		),
	});
	if (updated.length !== rows.length) throw new Error("map tracking did not record every decision");
	for (const row of rows) ctx.touched.add(questionRef(row.question));
}
export const openQuestionIds = async (db: ReadDb, project: number, kind: Kind): Promise<number[]> =>
	(await db.all(Q.openIdsOfKind, { project, kind })).map((row) => row.id);

export async function openCounts(db: ReadDb, project: number): Promise<Record<string, number>> {
	const counts: Record<string, number> = { open: (await db.get(Q.openCount, { project }))?.n ?? 0 };
	for (const row of await db.all(Q.openByKind, { project })) counts[row.kind] = row.n;
	return counts;
}

/** Questions changed at or after a position (a revision and a question id within it), in that order. */
export const questionsChangedSince = async (
	db: ReadDb,
	project: number,
	from: { rev: number; id: number },
	limit: number,
): Promise<QuestionRow[]> =>
	(await db.all(Q.changedSince, { project, rev: from.rev, id: from.id, limit })).map(readQuestion);

export async function insertAnswer(
	ctx: Ctx,
	input: { question: number; answer: unknown; reason: string | null; hash: string; counts: boolean },
): Promise<void> {
	await ctx.db.run(Q.insertAnswer, {
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

export async function itemReads(
	db: ReadDb,
	ids: readonly number[],
): Promise<Map<number, { answers: AnswerRow[]; refs: string[] }>> {
	const out = new Map<number, { answers: AnswerRow[]; refs: string[] }>(
		ids.map((id) => [id, { answers: [], refs: [] }]),
	);
	if (ids.length) {
		for (const row of await db.all(Q.answersForItems, { ids })) out.get(row.question)?.answers.push(row);
		for (const row of await db.all(Q.refsForItems, { ids })) out.get(row.question)?.refs.push(row.ref);
	}
	return out;
}
export const answersOf = async (db: ReadDb, question: number): Promise<AnswerRow[]> =>
	await db.all(Q.answersOf, { question });

export const pendingAnswersOf = async (db: ReadDb, question: number, hash: string): Promise<AnswerRow[]> =>
	await db.all(Q.pendingAnswersOf, { question, hash });

export async function insertDecision(
	ctx: Ctx,
	input: {
		question: QuestionRow;
		answer: unknown;
		signers: Signer[];
		holds: HoldTerm[];
		supersedes: number | null;
	},
): Promise<DecisionRow> {
	const expires = input.holds.flatMap((term) => (term.until === "time" ? [term.at] : []));
	const { id: insertedId } = await ctx.db.one(Q.insertDecision, {
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
	const row = await ctx.db.get(Q.decisionById, { id: insertedId });
	if (!row) throw new Error("decision was not stored");
	return row;
}

export const setDecisionEffects = async (ctx: Ctx, decision: number, effects: unknown): Promise<void> => {
	await ctx.db.run(Q.setEffects, { id: decision, effects: JSON.stringify(effects) });
};

/** Decisions whose question has no other live occurrence of its cause. */
export const independentFailureDecisions = async (
	db: ReadDb,
	project: number,
	ids: readonly number[],
): Promise<DecisionRow[]> => await db.all(Q.independentFailureDecisions, { project, ids });

/** Each proven passing cause keeps its own immutable ending, in the same order as individual endings. */
export async function endPassedHolds(
	ctx: Ctx,
	rows: readonly { question: QuestionRow; decision: DecisionRow; fixed: boolean; signer: Signer }[],
): Promise<void> {
	const updated = await ctx.db.all(Q.endPassedHolds, {
		project: ctx.project.id,
		at: ctx.now,
		seq: ctx.seq,
		rows: JSON.stringify(
			rows.map((row, ord) => ({
				question: row.question.id,
				decision: row.decision.id,
				ord,
				answer: JSON.stringify(row.fixed ? { is: "outdated", fixed: true } : { is: "outdated" }),
				signers: JSON.stringify([row.signer]),
			})),
		),
	});
	if (updated.length !== rows.length) throw new Error("passing causes did not record every ending");
	for (const row of rows) ctx.touched.add(questionRef(row.question));
}

export const decisionById = async (db: ReadDb, id: number): Promise<DecisionRow | null> =>
	await db.get(Q.decisionById, { id });
export async function decisionsByIds(db: ReadDb, ids: readonly number[]): Promise<Map<number, DecisionRow>> {
	const rows: DecisionRow[] = [];
	const unique = [...new Set(ids)];
	for (let at = 0; at < unique.length; at += 200)
		rows.push(...(await db.all(Q.decisionsByIds, { ids: unique.slice(at, at + 200) })));
	return new Map(rows.map((row) => [row.id, row]));
}
export const holdEndingById = async (db: ReadDb, id: number): Promise<DecisionRow | null> =>
	await db.get(Q.holdEndingById, { id });
export const nearestJudgment = async (db: ReadDb, question: number): Promise<DecisionRow | null> =>
	await db.get(Q.nearestJudgment, { question });

export const decisionsOf = async (db: ReadDb, question: number): Promise<DecisionRow[]> =>
	await db.all(Q.decisionsOf, { question });
export const expiredDecisions = async (db: ReadDb, project: number, now: number): Promise<DecisionRow[]> =>
	await db.all(Q.expired, { project, now });

export const liveDefectDecisions = async (db: ReadDb, project: number): Promise<DecisionRow[]> =>
	await db.all(Q.defects, { project });

/** An immutable observation decision, independent of question answers and their holds. */
export async function insertMergeReceipt(
	ctx: Ctx,
	change: number,
	snapshot: Omit<MergeReceipt, "id">,
	evidence: number,
): Promise<number> {
	return (
		await ctx.db.one(Q.insertMergeReceipt, {
			project: ctx.project.id,
			change,
			actor: ctx.actor.id,
			at: ctx.now,
			seq: ctx.seq,
			snapshot: JSON.stringify(snapshot),
			evidence,
		})
	).id;
}

export async function mergeReceiptById(db: ReadDb, project: number, id: number | null): Promise<MergeReceipt | null> {
	if (id === null) return null;
	const row = await db.get(Q.mergeReceipt, { id, project });
	return row ? MergeReceipt.parse({ ...json<Record<string, unknown>>(row.snapshot), id: row.id }) : null;
}

export const receiptDecisionAnswer = async (db: ReadDb, id: number): Promise<string> => {
	const row = await db.get(Q.receiptDecision, { id });
	if (!row) throw new Error(`counted decision ${id} is missing`);
	return row.answer;
};
const digest = (body: string) => new Bun.CryptoHasher("sha256").update(body).digest("hex");
const rootOf = async (db: ReadDb, id: number | null): Promise<ReceiptRoot | null> =>
	id === null ? null : await db.get(Q.node, { id });

async function payloadsOf(ctx: Ctx, bodies: readonly string[]): Promise<ReceiptRoot[]> {
	if (bodies.some((body) => Buffer.byteLength(body) > 32768))
		throw invalid("merge receipt evidence item exceeds 32 KiB");
	if (!bodies.length) return [];
	const hashes = bodies.map(digest);
	const project = ctx.project.id;
	await ctx.db.run(Q.insertPayloads, { project, hashes, bodies });
	const stored = new Map((await ctx.db.all(Q.payloadsByHashes, { project, hashes })).map((row) => [row.hash, row]));
	return hashes.map((hash) => {
		const row = stored.get(hash);
		if (!row) throw new Error("receipt payload was not stored");
		return { ...row, count: 1 };
	});
}
async function nodeOf(ctx: Ctx, level: number, members: ReceiptMember[]): Promise<ReceiptRoot | null> {
	if (!members.length) return null;
	members.sort((a, b) => a.slot - b.slot);
	if (members.length > 32 || new Set(members.map((row) => row.slot)).size !== members.length)
		throw new Error("receipt page keys are not unique");
	const hash = receiptNodeHash(level, members);
	const project = ctx.project.id;
	const found = await ctx.db.get(Q.nodeByHash, { project, hash });
	if (found) return found;
	const count = members.reduce((sum, row) => sum + row.count, 0);
	const id = (await ctx.db.one(Q.insertNode, { project, hash, level, count })).id;
	await ctx.db.run(Q.insertMembers, {
		node: id,
		slots: members.map((row) => row.slot),
		children: members.map((row) => row.child),
		payloads: members.map((row) => row.payload),
	});
	return { id, hash, count };
}

/** Copy only changed leaves and their ancestors. The iterator and recursion hold at most 32 entries per level. */
async function updateTree(
	ctx: Ctx,
	root: ReceiptRoot | null,
	buckets: AsyncGenerator<number>,
	load: (bucket: number) => AsyncGenerator<{ key: number; body: string }>,
): Promise<ReceiptRoot | null> {
	const iterator = buckets;
	let next = await iterator.next();
	if (next.done) return root;
	async function update(old: ReceiptRoot | null, level: number, base: number): Promise<ReceiptRoot | null> {
		if (level === 0) {
			const members: ReceiptMember[] = [];
			const rows: { key: number; body: string }[] = [];
			for await (const row of load(base)) {
				if (!Number.isSafeInteger(row.key) || row.key < 0)
					throw invalid("receipt key must be a nonnegative safe integer");
				rows.push(row);
			}
			const payloads = await payloadsOf(
				ctx,
				rows.map((row) => row.body),
			);
			for (const [index, row] of rows.entries()) {
				const payload = payloads[index];
				if (!payload) throw new Error("receipt payload was not stored");
				members.push({ slot: row.key % 32, child: null, payload: payload.id, hash: payload.hash, count: 1 });
			}
			next = await iterator.next();
			return await nodeOf(ctx, 0, members);
		}
		const members = new Map((old ? await ctx.db.all(Q.members, { node: old.id }) : []).map((row) => [row.slot, row]));
		const span = 32 ** (level - 1);
		while (!next.done && next.value < base + 32 ** level) {
			const slot = Math.floor((next.value - base) / span);
			const held = members.get(slot);
			const child = await update(
				held?.child ? { id: held.child, hash: held.hash, count: held.count } : null,
				level - 1,
				base + slot * span,
			);
			if (child) members.set(slot, { slot, child: child.id, payload: null, hash: child.hash, count: child.count });
			else members.delete(slot);
		}
		return await nodeOf(ctx, level, [...members.values()]);
	}
	return await update(root, 10, 0);
}
async function* dirtyBuckets(db: ReadDb, run: number): AsyncGenerator<number> {
	let after = -1;
	for (;;) {
		const page = await db.all(Q.dirty, { run, after });
		if (!page.length) return;
		for (const row of page) {
			yield row.bucket;
			after = row.bucket;
		}
	}
}
/** Disposable roots are reused only while source-change triggers leave their dirty set empty. */
export async function storeReceiptResults(
	ctx: Ctx,
	run: number,
	buckets: () => AsyncGenerator<number>,
	load: (bucket: number) => AsyncGenerator<{ key: number; body: string }>,
): Promise<ReceiptRoot | null> {
	const cached = await ctx.db.get(Q.cache, { run, project: ctx.project.id });
	const dirty = dirtyBuckets(ctx.db, run);
	const fresh = buckets();
	const root = await updateTree(ctx, cached ? await rootOf(ctx.db, cached.root) : null, cached ? dirty : fresh, load);
	await ctx.db.run(Q.setCache, { run, project: ctx.project.id, root: root?.id ?? null });
	await ctx.db.run(Q.clearDirty, { run });
	return root;
}
/** Gate identity is separate: a new question reference cannot duplicate result memberships. */
export async function storeMergeSnapshot(ctx: Ctx, results: ReceiptRoot | null, gate: AsyncGenerator<string>) {
	const iterator = gate;
	let next = await iterator.next();
	let key = 0;
	async function* buckets(): AsyncGenerator<number> {
		while (!next.done) yield Math.floor(key / 32);
	}
	async function* load(bucket: number): AsyncGenerator<{ key: number; body: string }> {
		while (!next.done && Math.floor(key / 32) === bucket) {
			yield { key: key++, body: next.value };
			next = await iterator.next();
		}
	}
	const changed = buckets();
	const gates = await updateTree(ctx, null, changed, load);
	const hash = receiptSnapshotHash(results?.hash ?? null, gates?.hash ?? null);
	const project = ctx.project.id;
	const found = await ctx.db.get(Q.snapshotByHash, { project, hash });
	if (found) return { ...found, hash };
	const count = results?.count ?? 0;
	const evidence_count = count + (gates?.count ?? 0);
	const id = (
		await ctx.db.one(Q.insertSnapshot, {
			project,
			hash,
			result_root: results?.id ?? null,
			gate_root: gates?.id ?? null,
			count,
			evidence_count,
		})
	).id;
	return { id, hash, count, evidence_count };
}
async function* treePage(
	db: ReadDb,
	node: ReceiptRoot | null,
	skip: number,
): AsyncGenerator<{ hash: string; body: string }> {
	if (!node) return;
	for (const row of await db.all(Q.members, { node: node.id })) {
		if (skip >= row.count) {
			skip -= row.count;
			continue;
		}
		if (row.child !== null) yield* treePage(db, { id: row.child, hash: row.hash, count: row.count }, skip);
		else if (row.payload !== null) {
			const payload = await db.get(Q.payload, { id: row.payload });
			if (!payload) throw new Error("receipt payload is missing");
			yield payload;
		}
		skip = 0;
	}
}
/** Rank cursors are stable because historical roots and subtree counts are immutable. */
export async function mergeReceiptPage(
	db: ReadDb,
	project: number,
	receipt: number,
	cursor: string | undefined,
	limit: number,
	collection: "results" | "evidence" = "results",
) {
	const manifest = await mergeReceiptById(db, project, receipt);
	const roots = await db.get(Q.roots, { project, receipt });
	if (!manifest || !roots) throw notFound("merge receipt");
	const match = cursor ? /^(\d+)\.(results|evidence)\.(\d+)$/.exec(cursor) : null;
	if (
		cursor &&
		(!match || Number(match[1]) !== receipt || match[2] !== collection || !Number.isSafeInteger(Number(match[3])))
	)
		throw invalid("that is not a cursor of this receipt collection");
	const start = match ? Number(match[3]) + 1 : 0;
	const resultRoot = await rootOf(db, roots.result_root);
	const gateRoot = await rootOf(db, roots.gate_root);
	async function* rows(): AsyncGenerator<{ kind: "result" | "gate"; hash: string; body: string }> {
		if (collection === "evidence" && start < (gateRoot?.count ?? 0))
			for await (const row of treePage(db, gateRoot, start)) yield { kind: "gate", ...row };
		const after = collection === "results" ? start : Math.max(0, start - (gateRoot?.count ?? 0));
		for await (const row of treePage(db, resultRoot, after)) yield { kind: "result", ...row };
	}
	const page: { ordinal: number; kind: "result" | "gate"; hash: string; body: string }[] = [];
	let bytes = 0;
	let more = false;
	for await (const row of rows()) {
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

export const openMapQuestionsInFile = async (db: ReadDb, project: number, file: string): Promise<QuestionRow[]> =>
	(await db.all(Q.openMapsInFile, { project, file })).map(readQuestion);
