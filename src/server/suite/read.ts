// Reads over the suite: listing, search, selection, the folder tree and version history.
// Every list is a bounded range read on a key from the schema; nothing here fetches everything and filters.
import { diffBodies, summariseDiff } from "../../core/diff.ts";
import type { CaseBody } from "../../core/model.ts";
import type { Selection } from "../../core/ops.ts";
import type { Ctx } from "../kernel/ctx.ts";
import { type Db, json, placeholders, type SqlValue, sql } from "../kernel/db.ts";
import { notFound } from "../kernel/errors.ts";
import { type CaseRow, type FolderIndex, type FolderRow, folderIndex, mustCase, type VersionRow } from "./suite.ts";

const Q = {
	countsByFolder: sql<{ project: number }, { folder: number; n: number }>(
		"SELECT folder, count(*) AS n FROM cases WHERE project = $project AND state = 'active' GROUP BY folder",
	),
	versions: sql<{ id: number }, VersionRow>("SELECT * FROM versions WHERE case_id = $id ORDER BY no DESC"),
	placements: sql<
		{ id: number; limit: number },
		{ before: string; after: string; actor: number; at: number; seq: number }
	>("SELECT before, after, actor, at, seq FROM placements WHERE case_id = $id ORDER BY seq DESC LIMIT $limit"),
	changedSince: sql<{ project: number; rev: number; limit: number }, CaseRow>(
		"SELECT * FROM cases WHERE project = $project AND rev > $rev ORDER BY rev LIMIT $limit",
	),
	tags: sql<{ project: number }, { tag: string; n: number }>(
		"SELECT tag, count(*) AS n FROM case_tags WHERE project = $project GROUP BY tag ORDER BY n DESC, tag LIMIT 500",
	),
	requirements: sql<{ project: number }, { key: string; title: string; cases: number }>(
		`SELECT r.key, r.title, (SELECT count(*) FROM covers c WHERE c.requirement = r.id) AS cases
		 FROM requirements r WHERE r.project = $project ORDER BY r.key LIMIT 1000`,
	),
	casesCovering: sql<{ project: number; key: string }, CaseRow>(
		`SELECT c.* FROM requirements r JOIN covers v ON v.requirement = r.id JOIN cases c ON c.id = v.case_id
		 WHERE r.project = $project AND r.key = $key`,
	),
	total: sql<{ project: number }, { n: number }>(
		"SELECT count(*) AS n FROM cases WHERE project = $project AND state = 'active'",
	),
	versionAt: sql<{ id: number; seq: number }, VersionRow>(
		"SELECT * FROM versions WHERE case_id = $id AND seq <= $seq ORDER BY no DESC LIMIT 1",
	),
};

export type SuiteProblem = { rule: string; total: number; rows: { ref: string; message: string }[] };

/**
 * Structural problems the suite's own data can show, each with a total and its first rows. Deterministic: the
 * same rules a person would apply by reading, with no model involved.
 */
export function structuralProblems(db: Db, project: number): SuiteProblem[] {
	const rules: { rule: string; where: string; message: (title: string) => string }[] = [
		{ rule: "no-steps", where: "c.step_count = 0", message: (title) => `"${title}" has no steps` },
		{ rule: "no-title", where: "c.title = ''", message: () => "has no title" },
		{
			rule: "no-expected",
			where:
				"c.step_count > 0 AND NOT EXISTS (SELECT 1 FROM versions v, json_each(v.body, '$.steps') s WHERE v.case_id = c.id AND v.no = c.head AND json_extract(s.value, '$.expected') IS NOT NULL)",
			message: (title) => `"${title}" has steps but no expected result, so it cannot fail`,
		},
		{
			rule: "duplicate-title",
			where:
				"EXISTS (SELECT 1 FROM cases d WHERE d.project = c.project AND d.folder = c.folder AND d.state = 'active' AND d.title = c.title AND d.id < c.id AND c.title <> '')",
			message: (title) => `"${title}" has the same title as another case in its folder`,
		},
	];
	return rules.map(({ rule, where, message }) => {
		const scope = `FROM cases c WHERE c.project = ? AND c.state = 'active' AND ${where}`;
		const total = db.allDynamic<{ n: number }>(`SELECT count(*) AS n ${scope}`, [project])[0]?.n ?? 0;
		const rows = db.allDynamic<{ no: number; title: string }>(`SELECT no, title ${scope} ORDER BY no LIMIT 50`, [
			project,
		]);
		return { rule, total, rows: rows.map((row) => ({ ref: `C-${row.no}`, message: message(row.title) })) };
	});
}

/** Archived cases, newest first: a test still linked to one of these is linked to nothing a run can use. */
export const archivedCases = (db: Db, project: number, limit: number): CaseRow[] =>
	db.allDynamic<CaseRow>("SELECT * FROM cases WHERE project = ? AND state = 'archived' ORDER BY rev DESC LIMIT ?", [
		project,
		limit,
	]);

/** Turns what a person typed into an FTS5 query: every word must match, and the last one matches as a prefix. */
export function ftsQuery(text: string): string | null {
	const words = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu);
	if (!words || words.length === 0) return null;
	return words.map((word, i) => (i === words.length - 1 ? `"${word}"*` : `"${word}"`)).join(" ");
}

/** A folder and everything under it. */
export function subtree(index: FolderIndex, root: number): number[] {
	const children = new Map<number | null, number[]>();
	for (const row of index.byId.values()) {
		const list = children.get(row.parent) ?? [];
		list.push(row.id);
		children.set(row.parent, list);
	}
	const out: number[] = [];
	const walk = (id: number) => {
		out.push(id);
		for (const child of children.get(id) ?? []) walk(child);
	};
	walk(root);
	return out;
}

export function resolveFolderId(index: FolderIndex, target: number | string): number {
	const row =
		typeof target === "number"
			? index.byId.get(target)
			: index.byPath.get(
					target
						.split("/")
						.map((part) => part.trim())
						.filter(Boolean)
						.join("/")
						.toLowerCase(),
				);
	if (!row) throw notFound(`folder ${target}`);
	return row.id;
}

export type CaseQuery = {
	folder?: number | string | undefined;
	deep?: boolean | undefined;
	tags?: readonly string[] | undefined;
	state?: string | undefined;
	text?: string | undefined;
	limit: number;
	cursor?: string | undefined;
};

/**
 * One page of cases. Without text: in outline order (folder, then rank), from the cursor. With text: by relevance,
 * one page only. Folder and tag filters are applied by the database in the same query.
 */
export function listCases(
	ctx: Ctx,
	query: CaseQuery,
): { items: CaseRow[]; cursor: string | null; count: number | null } {
	const project = ctx.project.id;
	const where: string[] = ["c.project = ?", "c.state = ?"];
	const params: SqlValue[] = [project, query.state === "archived" ? "archived" : "active"];
	if (query.folder !== undefined) {
		const index = folderIndex(ctx.db, project);
		const root = resolveFolderId(index, query.folder);
		const ids = query.deep ? subtree(index, root) : [root];
		where.push(`c.folder IN (${placeholders(ids.length)})`);
		params.push(...ids);
	}
	for (const tag of query.tags ?? []) {
		where.push("c.id IN (SELECT case_id FROM case_tags WHERE project = ? AND tag = ?)");
		params.push(project, tag.toLowerCase().replace(/^#/, ""));
	}

	if (query.text?.trim()) {
		const direct = /^(?:c-)?(\d+)$/i.exec(query.text.trim());
		const match = ftsQuery(query.text);
		const found: CaseRow[] = [];
		if (direct) {
			const row = ctx.db.raw
				.query<CaseRow, [number, number]>("SELECT * FROM cases WHERE project = ? AND no = ?")
				.get(project, Number(direct[1]));
			if (row) found.push(row);
		}
		if (match) {
			const rows = ctx.db.allDynamic<CaseRow>(
				`SELECT c.* FROM search_docs s JOIN cases c ON c.id = s.rowid
				 WHERE s.search_docs MATCH ? AND ${where.join(" AND ")}
				 ORDER BY bm25(search_docs, 8.0, 1.0, 4.0) LIMIT ?`,
				[match, ...params, query.limit],
			);
			for (const row of rows) if (!found.some((f) => f.id === row.id)) found.push(row);
		}
		return { items: found.slice(0, query.limit), cursor: null, count: found.length };
	}

	// The count is of the whole selection, not the page, so a list can say "2,000 cases" and a plan "214 selected".
	const count =
		ctx.db.allDynamic<{ n: number }>(`SELECT count(*) AS n FROM cases c WHERE ${where.join(" AND ")}`, params)[0]?.n ??
		0;
	if (query.cursor) {
		const [folder, rank] = splitCursor(query.cursor);
		where.push("(c.folder > ? OR (c.folder = ? AND c.rank > ?))");
		params.push(folder, folder, rank);
	}
	const rows = ctx.db.allDynamic<CaseRow>(
		`SELECT c.* FROM cases c WHERE ${where.join(" AND ")} ORDER BY c.folder, c.rank LIMIT ?`,
		[...params, query.limit + 1],
	);
	const items = rows.slice(0, query.limit);
	const last = items.at(-1);
	return { items, cursor: rows.length > query.limit && last ? `${last.folder}:${last.rank}` : null, count };
}

function splitCursor(cursor: string): [number, string] {
	const at = cursor.indexOf(":");
	return [Number(cursor.slice(0, at)), cursor.slice(at + 1)];
}

/** The active cases a plan selects, in outline order. Criteria narrow each other; `cases` names them outright. */
export function selectCases(ctx: Ctx, selection: Selection): CaseRow[] {
	const project = ctx.project.id;
	const named = selection.cases?.map((text) => mustCase(ctx.db, project, text)) ?? null;
	const narrowing = selection.folders?.length || selection.tags?.length || selection.text;
	if (named && !narrowing) return named.filter((row) => row.state === "active");

	const index = folderIndex(ctx.db, project);
	const where: string[] = ["c.project = ?", "c.state = 'active'"];
	const params: SqlValue[] = [project];
	if (selection.folders?.length) {
		const ids = [...new Set(selection.folders.flatMap((folder) => subtree(index, resolveFolderId(index, folder))))];
		where.push(`c.folder IN (${placeholders(ids.length)})`);
		params.push(...ids);
	}
	for (const tag of selection.tags ?? []) {
		where.push("c.id IN (SELECT case_id FROM case_tags WHERE project = ? AND tag = ?)");
		params.push(project, tag.toLowerCase().replace(/^#/, ""));
	}
	if (selection.text) {
		const match = ftsQuery(selection.text);
		if (!match) return [];
		where.push("c.id IN (SELECT rowid FROM search_docs WHERE search_docs MATCH ?)");
		params.push(match);
	}
	if (named) {
		where.push(`c.id IN (${placeholders(named.length)})`);
		params.push(...named.map((row) => row.id));
	}
	return ctx.db.allDynamic<CaseRow>(
		`SELECT c.* FROM cases c WHERE ${where.join(" AND ")} ORDER BY c.folder, c.rank LIMIT 20000`,
		params,
	);
}

export type FolderNode = {
	id: number;
	parent: number | null;
	name: string;
	path: string;
	rank: string;
	state: string;
	cases: number;
};

export function folderTree(db: Db, project: number): { folders: FolderNode[]; total: number } {
	const index = folderIndex(db, project);
	const counts = new Map(db.all(Q.countsByFolder, { project }).map((row) => [row.folder, row.n]));
	const folders = [...index.byId.values()].map((row: FolderRow) => ({
		id: row.id,
		parent: row.parent,
		name: row.name,
		path: index.path(row.id),
		rank: row.rank,
		state: row.state,
		cases: counts.get(row.id) ?? 0,
	}));
	return { folders, total: db.get(Q.total, { project })?.n ?? 0 };
}

export type VersionEntry = {
	version: number;
	hash: string;
	author: number;
	reason: string | null;
	at: number;
	seq: number;
	decision: number;
	summary: string;
};

/** The versions of a case, newest first, each with a one-line summary of what it changed. */
export function versionList(db: Db, caseId: number): VersionEntry[] {
	const rows = db.all(Q.versions, { id: caseId });
	return rows.map((row, i) => {
		const previous = rows[i + 1];
		const summary = previous
			? summariseDiff(diffBodies(json<CaseBody>(previous.body), json<CaseBody>(row.body)))
			: "created";
		return {
			version: row.no,
			hash: row.hash,
			author: row.author,
			reason: row.reason,
			at: row.at,
			seq: row.seq,
			decision: row.decision,
			summary,
		};
	});
}

/** The version of a case that was current at a point on the project's clock, or null if it did not exist yet. */
export const versionAt = (db: Db, caseId: number, seq: number): VersionRow | null =>
	db.get(Q.versionAt, { id: caseId, seq });
export const placementsOf = (db: Db, caseId: number, limit: number) => db.all(Q.placements, { id: caseId, limit });
export const casesChangedSince = (db: Db, project: number, rev: number, limit: number): CaseRow[] =>
	db.all(Q.changedSince, { project, rev, limit });
export const tagCounts = (db: Db, project: number) => db.all(Q.tags, { project });
export const requirementList = (db: Db, project: number) => db.all(Q.requirements, { project });
export const casesCovering = (db: Db, project: number, key: string): CaseRow[] =>
	db.all(Q.casesCovering, { project, key });
