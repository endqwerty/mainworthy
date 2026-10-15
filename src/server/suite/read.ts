// Reads over the suite: listing, search, selection, the folder tree and version history.
// Every list is a bounded range read on a key from the schema; nothing here fetches everything and filters.
import { diffBodies, summariseDiff } from "../../core/diff.ts";
import { type CaseBody, cleanPath } from "../../core/model.ts";
import type { Selection } from "../../core/ops.ts";
import type { Ctx } from "../kernel/ctx.ts";
import { type Db, json, placeholders, type SqlValue, sql } from "../kernel/db.ts";
import { invalid, notFound } from "../kernel/errors.ts";
import { type CaseRow, type FolderIndex, type FolderRow, folderIndex, mustCase, type VersionRow } from "./suite.ts";

const Q = {
	searchAny: sql<{ match: string; project: number; limit: number }, { rowid: number }>(
		"SELECT rowid FROM search_docs WHERE search_docs MATCH $match AND project = $project LIMIT $limit",
	),
	searchRanked: sql<{ match: string; project: number; limit: number }, { rowid: number }>(
		"SELECT rowid FROM search_docs WHERE search_docs MATCH $match AND project = $project ORDER BY rank LIMIT $limit",
	),
	searchNewest: sql<{ match: string; project: number; limit: number }, { rowid: number }>(
		"SELECT rowid FROM search_docs WHERE search_docs MATCH $match AND project = $project ORDER BY rowid DESC LIMIT $limit",
	),
	countsByFolder: sql<{ project: number }, { folder: number; n: number }>(
		"SELECT folder, count(*) AS n FROM cases WHERE project = $project AND state = 'active' GROUP BY folder",
	),
	versions: sql<{ id: number }, VersionRow>("SELECT * FROM versions WHERE case_id = $id ORDER BY no DESC"),
	placements: sql<
		{ id: number; limit: number },
		{ before: string; after: string; actor: number; at: number; seq: number }
	>("SELECT before, after, actor, at, seq FROM placements WHERE case_id = $id ORDER BY seq DESC LIMIT $limit"),
	changedSince: sql<{ project: number; rev: number; id: number; limit: number }, CaseRow>(
		"SELECT * FROM cases WHERE project = $project AND (rev, id) >= ($rev, $id) ORDER BY rev, id LIMIT $limit",
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
				"c.step_count > 0 AND NOT EXISTS (SELECT 1 FROM versions v, json_each(v.body, '$.steps') s WHERE v.case_id = c.id AND v.no = c.head AND (json_extract(s.value, '$.expected') IS NOT NULL OR EXISTS (SELECT 1 FROM cases f JOIN versions fv ON fv.case_id = f.id, json_each(fv.body, '$.steps') fs WHERE f.project = c.project AND f.no = CAST(substr(json_extract(s.value, '$.use.fragment'), 3) AS INTEGER) AND fv.no = json_extract(s.value, '$.use.version') AND json_extract(fs.value, '$.expected') IS NOT NULL)))",
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

/**
 * The most matches a search scores for relevance. Beyond this a word is too common for a ranking to help, and
 * scoring every match is what makes a search slow; such a search returns the newest matches instead.
 */
export const RANKED_MATCHES = 2000;

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
		typeof target === "number" ? index.byId.get(target) : index.byPath.get(cleanPath(target).join("/").toLowerCase());
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
		// A ref is found like any match: only where the folder, the tags and the state let it be.
		if (direct) {
			const [row] = ctx.db.allDynamic<CaseRow>(`SELECT c.* FROM cases c WHERE c.no = ? AND ${where.join(" AND ")}`, [
				Number(direct[1]),
				...params,
			]);
			if (row) found.push(row);
		}
		let broad = false;
		if (match) {
			// Work inside the full-text index first and fetch only the survivors: joining every match to its case
			// before sorting costs a row read per match, and a common word matches tens of thousands of cases.
			const filtered = where.length > 2 || query.state === "archived";
			const cut = Math.min(Math.max(query.limit * (filtered ? 20 : 3), 200), RANKED_MATCHES);
			const args = { project, limit: cut };
			// How many match? Stop counting at the limit: this read is bounded whatever the word.
			const probe = ctx.db.all(Q.searchAny, { match, project, limit: RANKED_MATCHES + 1 });
			let ranked: number[];
			if (probe.length <= RANKED_MATCHES) {
				// Few enough to score every one: order by relevance.
				ranked = ctx.db.all(Q.searchRanked, { match, ...args }).map((row) => row.rowid);
			} else {
				// Too many for relevance to mean anything, and scoring them all would make the user wait. Newest
				// first, matches in the title before matches in the steps; the caller is told to narrow the search.
				broad = true;
				const inTitle = ctx.db.all(Q.searchNewest, { match: `title : (${match})`, ...args }).map((row) => row.rowid);
				const seen = new Set(inTitle);
				const anywhere =
					inTitle.length >= cut ? [] : ctx.db.all(Q.searchNewest, { match, ...args }).map((row) => row.rowid);
				ranked = [...inTitle, ...anywhere.filter((id) => !seen.has(id))].slice(0, cut);
			}
			if (ranked.length > 0) {
				const order = new Map(ranked.map((id, i) => [id, i]));
				const rows = ctx.db.allDynamic<CaseRow>(
					`SELECT c.* FROM cases c WHERE c.id IN (${placeholders(ranked.length)}) AND ${where.join(" AND ")}`,
					[...ranked, ...params],
				);
				rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
				for (const row of rows) if (!found.some((f) => f.id === row.id)) found.push(row);
			}
			// The cut above is of every match in the project. When a folder, a tag or the archive narrows the search,
			// matches that qualify can lie beyond it. What the cut gave is the best-ranked of them; if that does not
			// fill the page, the rest are read with the filter applied first, newest first, so a match that exists
			// is never reported as absent.
			if (filtered && found.length < query.limit && (broad || ranked.length >= cut)) {
				const rest = ctx.db.allDynamic<CaseRow>(
					`SELECT c.* FROM cases c WHERE ${where.join(" AND ")}
					 AND c.id IN (SELECT rowid FROM search_docs WHERE search_docs MATCH ?)
					 ORDER BY c.rev DESC, c.id DESC LIMIT ?`,
					[...params, match, query.limit + found.length + 1],
				);
				for (const row of rest) if (!found.some((f) => f.id === row.id)) found.push(row);
				if (found.length > query.limit) broad = true;
			}
		}
		// For a broad search the true number of matches is unknown by design: null says "more than shown".
		return { items: found.slice(0, query.limit), cursor: null, count: broad ? null : found.length };
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
	if ((selection.cases?.length ?? 0) > MAX_SELECTION) throw tooMany();
	const named = selection.cases?.map((text) => mustCase(ctx.db, project, text)) ?? null;
	const narrowing = selection.folders?.length || selection.tags?.length || selection.text;
	if (named?.some((row) => row.kind === "fragment"))
		throw invalid("fragments are shared steps; select their cases to run");
	if (named && !narrowing) return named.filter((row) => row.state === "active");

	const index = folderIndex(ctx.db, project);
	const where: string[] = ["c.project = ?", "c.state = 'active'", "c.kind = 'case'"];
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
	// A selection is used whole or not at all: a run planned over part of what was asked for could be signed
	// off without the rest. More than a run can sensibly hold is refused, with what to do about it.
	const rows = ctx.db.allDynamic<CaseRow>(
		`SELECT c.* FROM cases c WHERE ${where.join(" AND ")} ORDER BY c.folder, c.rank LIMIT ${MAX_SELECTION + 1}`,
		params,
	);
	if (rows.length > MAX_SELECTION) throw tooMany();
	return rows;
}

/** The most cases one selection may name, by criteria or outright. */
const MAX_SELECTION = 20_000;
const tooMany = () =>
	invalid(
		`the selection is more than ${MAX_SELECTION.toLocaleString("en-US")} cases; narrow it by folder, tag or text, or plan two runs`,
	);

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
/** Cases changed at or after a position (a revision and a case id within it), in that order: one page of a cursor. */
export const casesChangedSince = (
	db: Db,
	project: number,
	from: { rev: number; id: number },
	limit: number,
): CaseRow[] => db.all(Q.changedSince, { project, rev: from.rev, id: from.id, limit });
export const tagCounts = (db: Db, project: number) => db.all(Q.tags, { project });
export const requirementList = (db: Db, project: number) => db.all(Q.requirements, { project });
export const casesCovering = (db: Db, project: number, key: string): CaseRow[] =>
	db.all(Q.casesCovering, { project, key });
