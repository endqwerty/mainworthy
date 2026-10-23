// Review evidence: findings and the review ledger. Owns findings and reviews.
// A review is evidence that someone looked; it is never a result and never fills an exercise slot.
import { contentHash } from "../../core/hash.ts";
import type { Ctx } from "../kernel/ctx.ts";
import { type Db, sql } from "../kernel/db.ts";

export type FindingRow = {
	id: number;
	project: number;
	actor: number;
	lens: string;
	locus: string;
	case_id: number | null;
	category: string;
	note: string;
	repro: string | null;
	suggest: string | null;
	basis: string;
	question: number | null;
	at: number;
	seq: number;
};
export type ReviewRow = {
	id: number;
	reviewer: number;
	lens: string;
	case_id: number;
	version: number;
	basis: string;
	about: string | null;
	at: number;
	seq: number;
};

export const reviewBasis = (input: { version: string; about: string | null; patch: string | null }): string =>
	contentHash(input);

const Q = {
	insertFinding: sql<{
		project: number;
		actor: number;
		lens: string;
		locus: string;
		caseId: number | null;
		category: string;
		note: string;
		repro: string | null;
		suggest: string | null;
		basis: string;
		question: number;
		at: number;
		seq: number;
	}>(
		`INSERT INTO findings (project, actor, lens, locus, case_id, category, note, repro, suggest, basis, question, at, seq)
		 VALUES ($project, $actor, $lens, $locus, $caseId, $category, $note, $repro, $suggest, $basis, $question, $at, $seq)`,
	),
	findingsOfCase: sql<{ id: number; limit: number }, FindingRow>(
		"SELECT * FROM findings WHERE case_id = $id ORDER BY seq DESC LIMIT $limit",
	),
	insertReview: sql<{
		project: number;
		reviewer: number;
		lens: string;
		caseId: number;
		version: number;
		basis: string;
		about: string | null;
		at: number;
		seq: number;
	}>(
		`INSERT OR IGNORE INTO reviews (project, reviewer, lens, case_id, version, basis, about, at, seq)
		 VALUES ($project, $reviewer, $lens, $caseId, $version, $basis, $about, $at, $seq)`,
	),
	reviewed: sql<{ caseId: number; basis: string; lens: string; reviewer: number }, { id: number }>(
		"SELECT id FROM reviews WHERE case_id = $caseId AND basis = $basis AND lens = $lens AND reviewer = $reviewer",
	),
	reviewsOfCase: sql<{ id: number; limit: number }, ReviewRow>(
		"SELECT * FROM reviews WHERE case_id = $id ORDER BY seq DESC LIMIT $limit",
	),
	reviewsAtVersion: sql<{ id: number; version: number }, ReviewRow>(
		"SELECT * FROM reviews WHERE case_id = $id AND version = $version ORDER BY seq DESC",
	),
	reviewedCases: sql<{ actor: number; cases: string }, { id: number }>(
		`SELECT json_extract(asked.value, '$.id') AS id FROM json_each($cases) asked WHERE EXISTS (
		 SELECT 1 FROM reviews r WHERE r.case_id = json_extract(asked.value, '$.id')
		 AND r.version = json_extract(asked.value, '$.version')
		 AND r.basis = json_extract(asked.value, '$.basis') AND r.reviewer = $actor
		)`,
	),
};

export function insertFinding(
	ctx: Ctx,
	input: {
		lens: string;
		locus: string;
		caseId: number | null;
		category: string;
		note: string;
		repro: string | null;
		suggest: unknown;
		basis: string;
		question: number;
	},
): void {
	ctx.db.run(Q.insertFinding, {
		project: ctx.project.id,
		actor: ctx.actor.id,
		lens: input.lens,
		locus: input.locus,
		caseId: input.caseId,
		category: input.category,
		note: input.note,
		repro: input.repro,
		suggest: input.suggest ? JSON.stringify(input.suggest) : null,
		basis: input.basis,
		question: input.question,
		at: ctx.now,
		seq: ctx.seq,
	});
}

export function insertReview(
	ctx: Ctx,
	input: { caseId: number; version: number; basis: string; lens: string; about: string | null },
): void {
	ctx.db.run(Q.insertReview, { project: ctx.project.id, reviewer: ctx.actor.id, ...input, at: ctx.now, seq: ctx.seq });
}

export const reviewedAt = (db: Db, caseId: number, basis: string, lens: string, reviewer: number): boolean =>
	db.get(Q.reviewed, { caseId, basis, lens, reviewer }) !== null;
export const findingsOfCase = (db: Db, caseId: number, limit: number): FindingRow[] =>
	db.all(Q.findingsOfCase, { id: caseId, limit });
export const reviewsOfCase = (db: Db, caseId: number, limit: number): ReviewRow[] =>
	db.all(Q.reviewsOfCase, { id: caseId, limit });
export const reviewsAtVersion = (db: Db, caseId: number, version: number): ReviewRow[] =>
	db.all(Q.reviewsAtVersion, { id: caseId, version });

export const reviewedCaseIds = (
	db: Db,
	actor: number,
	cases: readonly { id: number; version: number; basis: string }[],
) => new Set(db.all(Q.reviewedCases, { actor, cases: JSON.stringify(cases) }).map((row) => row.id));
