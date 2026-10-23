// Reads over the suite: listing, search, selection, the folder tree and version history.
// Every list is a bounded range read on a key from the schema; nothing here fetches everything and filters.
import { diffBodies, summariseDiff } from "../../core/diff.ts";
import { type Automate, type CaseBody, cleanPath } from "../../core/model.ts";
import type { Selection } from "../../core/ops.ts";
import type { Ctx } from "../kernel/ctx.ts";
import { type ReadDb, json, placeholders, type SqlValue, sql } from "../kernel/db.ts";
import { invalid, notFound } from "../kernel/errors.ts";
import { type CaseRow, type FolderIndex, type FolderRow, folderIndex, mustCase, type VersionRow } from "./suite.ts";

type ImpactHead = Pick<CaseRow, "id" | "no" | "head" | "head_hash"> & { failing: boolean };

const Q = {
	impactHeads: sql<
		{ project: number; candidates: string; since: number | null },
		Omit<ImpactHead, "failing"> & { failing: number }
	>(
		`SELECT c.id, c.no, c.head, c.head_hash, json_extract(asked.value, '$.failing') AS failing
		 FROM json_each($candidates) asked CROSS JOIN cases c ON c.id = json_extract(asked.value, '$.id')
		 WHERE c.project = $project AND c.state = 'active'
		 AND ($since IS NULL OR c.rev > $since OR json_extract(asked.value, '$.failing') = 1)`,
	),
	impactCountsAndIds: sql<
		{ selection: string; offset: number },
		{ cases: number; unreviewed: number; failing: number; page: string }
	>(
		`WITH selected AS MATERIALIZED (
			SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.no') AS no,
			 json_extract(value, '$.reviewed') AS reviewed, json_extract(value, '$.failing') AS failing
			FROM json_each($selection)
		)
		SELECT count(*) AS cases, coalesce(sum(1 - reviewed), 0) AS unreviewed,
		 coalesce(sum(failing), 0) AS failing,
		 (SELECT json_group_array(id) FROM (
			SELECT id FROM selected ORDER BY reviewed, no LIMIT 200 OFFSET $offset
		 )) AS page FROM selected`,
	),
	impactPage: sql<{ project: number; ids: string }, CaseRow>(
		`SELECT c.* FROM json_each($ids) asked CROSS JOIN cases c ON c.id = asked.value
		 WHERE c.project = $project ORDER BY CAST(asked.key AS INTEGER)`,
	),
	caseIdsOfRefs: sql<{ project: number; refs: string }, { id: number }>(
		`SELECT id FROM cases WHERE project = $project
		 AND no IN (SELECT CAST(substr(value, 3) AS INTEGER) FROM json_each($refs))`,
	),
	caseIdsOfRequirements: sql<{ project: number; keys: string }, { id: number }>(
		`SELECT DISTINCT v.case_id AS id FROM json_each($keys) asked
		 CROSS JOIN requirements r ON r.project = $project AND r.key = asked.value
		 CROSS JOIN covers v ON v.requirement = r.id`,
	),
	caseLinksOfRequirements: sql<{ project: number; keys: string; cases: string }, { id: number; key: string }>(
		`SELECT v.case_id AS id, r.key FROM json_each($cases) asked
		 CROSS JOIN covers v ON v.case_id = asked.value
		 CROSS JOIN requirements r ON r.id = v.requirement
		 WHERE r.project = $project AND r.key IN (SELECT value FROM json_each($keys))`,
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
	automation: sql<{ project: number }, { id: number; no: number; title: string; automate: Automate }>(
		"SELECT id, no, title, automate FROM cases WHERE project = $project AND state = 'active' ORDER BY no",
	),
	covering: sql<{ project: number }, { key: string; title: string; case_id: number | null }>(
		`SELECT r.key, r.title, c.id AS case_id FROM requirements r
		 LEFT JOIN covers v ON v.requirement = r.id
		 LEFT JOIN cases c ON c.id = v.case_id AND c.state = 'active'
		 WHERE r.project = $project ORDER BY r.key, c.no`,
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
export function structuralProblems(db: ReadDb, project: number): SuiteProblem[] {
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
export const archivedCases = async (db: ReadDb, project: number, limit: number): Promise<CaseRow[]> =>
	await db.allDynamic<CaseRow>(
		"SELECT * FROM cases WHERE project = ? AND state = 'archived' ORDER BY rev DESC LIMIT ?",
		[project, limit],
	);

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
 * from a place in that order (the cursor). Folder and tag filters are applied by the database in the same query.
 */
export async function listCases(
	ctx: Ctx,
	query: CaseQuery,
): Promise<{ items: CaseRow[]; cursor: string | null; count: number | null }> {
	const project = ctx.project.id;
	const where: string[] = ["c.project = ?", "c.state = ?"];
	const params: SqlValue[] = [project, query.state === "archived" ? "archived" : "active"];
	if (query.folder !== undefined) {
		const index = await folderIndex(ctx.db, project);
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
		const from = searchOffset(query.cursor);
		const { ids, exact } = await searchIds(ctx, query, where, params);
		// Only a search of every match has an order that holds from one page to the next. One too broad to rank is
		// read only as far as its first page needs, and a longer read would change that order, so it answers one page
		// and no cursor; a cursor into it reads nothing more.
		const page = exact || from === 0 ? ids.slice(from, from + query.limit) : [];
		const rows = page.length
			? await ctx.db.allDynamic<CaseRow>(`SELECT c.* FROM cases c WHERE c.id IN (${placeholders(page.length)})`, page)
			: [];
		const order = new Map(page.map((id, i) => [id, i]));
		rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
		// A search is paged by its place in its own order, which is read again for each page. A case that joins or
		// leaves the matches between two pages can move one row across the boundary; the page size changes nothing.
		// A search too broad to rank is bounded: its count is null ("more than shown"), as is its reach.
		return {
			items: rows,
			cursor: exact && ids.length > from + query.limit ? String(from + query.limit) : null,
			count: exact ? ids.length : null,
		};
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
	const rows = await ctx.db.allDynamic<CaseRow>(
		`SELECT c.* FROM cases c WHERE ${where.join(" AND ")} ORDER BY c.folder, c.rank LIMIT ?`,
		[...params, query.limit + 1],
	);
	const items = rows.slice(0, query.limit);
	const last = items.at(-1);
	return { items, cursor: rows.length > query.limit && last ? `${last.folder}:${last.rank}` : null, count };
}

/** Where a search page starts in the search's order: the cursor a search gave, which is a place, not a case. */
function searchOffset(cursor: string | undefined): number {
	if (cursor === undefined) return 0;
	if (!/^\d+$/.test(cursor)) throw invalid(`"${cursor}" is not a cursor of a search`);
	return Math.min(Number(cursor), RANKED_MATCHES);
}

/**
 * The cases a text search finds, best first, as far as this page needs. `exact` says the list is every match: the
 * selection has at most RANKED_MATCHES of them, each scored after applying the folder, tags and state.
 * Otherwise the word is too common to rank: newest first, matches in the title before matches in the steps, and the
 * list is only as long as the page asked for needs.
 */
async function searchIds(
	ctx: Ctx,
	query: CaseQuery,
	where: string[],
	params: SqlValue[],
): Promise<{ ids: number[]; exact: boolean }> {
	const project = ctx.project.id;
	const text = query.text ?? "";
	const direct = /^(?:c-)?(\d+)$/i.exec(text.trim());
	const match = ftsQuery(text);
	const ids: number[] = [];
	// A ref is found like any match: only where the folder, the tags and the state let it be.
	if (direct) {
		const [row] = await ctx.db.allDynamic<{ id: number }>(
			`SELECT c.id FROM cases c WHERE c.no = ? AND ${where.join(" AND ")}`,
			[Number(direct[1]), ...params],
		);
		if (row) ids.push(row.id);
	}
	if (!match) return { ids, exact: true };
	const filtered = query.folder !== undefined || (query.tags?.length ?? 0) > 0;
	const candidates = async (match: string, newest: boolean, limit: number): Promise<number[]> => {
		// Unary + keeps the case index on the filter range instead of probing it once per FTS rowid.
		if (filtered && !newest)
			return (
				await ctx.db.allDynamic<{ id: number }>(
					`SELECT c.id FROM cases c WHERE ${where.join(" AND ")}
				 AND +c.id IN (SELECT rowid FROM search_docs WHERE search_docs MATCH ?) LIMIT ?`,
					[...params, match, limit],
				)
			).map((row) => row.id);
		return (
			await ctx.db.allDynamic<{ rowid: number }>(
				`SELECT rowid FROM search_docs WHERE search_docs MATCH ? AND project = ?
			 AND EXISTS (SELECT 1 FROM cases c WHERE c.id = search_docs.rowid AND ${where.join(" AND ")})
			 ${newest ? "ORDER BY rowid DESC" : ""} LIMIT ?`,
				[match, project, ...params, limit],
			)
		).map((row) => row.rowid);
	};
	const append = (more: number[]) => {
		const seen = new Set(ids);
		for (const id of more) if (!seen.has(id)) ids.push(id);
	};
	// How many match? Stop counting past the limit: this read is bounded whatever the word.
	const probe = await candidates(match, false, RANKED_MATCHES + 1);
	if (probe.length <= RANKED_MATCHES) {
		if (probe.length) {
			// Unary + keeps one MATCH scan and sorts only survivors by the configured rank. Without it,
			// FTS repeats MATCH per rowid or ranks every full-text match before filtering.
			append(
				(
					await ctx.db.allDynamic<{ rowid: number }>(
						`SELECT rowid FROM search_docs WHERE search_docs MATCH ? AND +rowid IN (${placeholders(probe.length)})
					 ORDER BY +rank`,
						[match, ...probe],
					)
				).map((row) => row.rowid),
			);
		}
		return { ids, exact: true };
	}
	const inTitle = await candidates(`title : (${match})`, true, query.limit);
	append(inTitle);
	if (ids.length < query.limit) append(await candidates(match, true, query.limit));
	return { ids, exact: false };
}

function splitCursor(cursor: string): [number, string] {
	const at = cursor.indexOf(":");
	return [Number(cursor.slice(0, at)), cursor.slice(at + 1)];
}

/** The active cases a plan selects, in outline order. Criteria narrow each other; `cases` names them outright. */
export async function selectCases(ctx: Ctx, selection: Selection): Promise<CaseRow[]> {
	const project = ctx.project.id;
	if ((selection.cases?.length ?? 0) > MAX_SELECTION) throw tooMany();
	const named = selection.cases
		? [
				...new Map(
					selection.cases.map((text) => {
						const row = mustCase(ctx.db, project, text);
						return [row.id, row];
					}),
				).values(),
			]
		: null;
	const narrowing = selection.folders?.length || selection.tags?.length || selection.text;
	if (named?.some((row) => row.kind === "fragment"))
		throw invalid("fragments are shared steps; select their cases to run");
	if (named && !narrowing) return named.filter((row) => row.state === "active");

	const index = await folderIndex(ctx.db, project);
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
	const rows = await ctx.db.allDynamic<CaseRow>(
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

export async function folderTree(db: ReadDb, project: number): Promise<{ folders: FolderNode[]; total: number }> {
	const index = await folderIndex(db, project);
	const counts = new Map((await db.all(Q.countsByFolder, { project })).map((row) => [row.folder, row.n]));
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
export async function versionList(db: ReadDb, caseId: number): Promise<VersionEntry[]> {
	const rows = await db.all(Q.versions, { id: caseId });
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
export const versionAt = async (db: ReadDb, caseId: number, seq: number): Promise<VersionRow | null> =>
	await db.get(Q.versionAt, { id: caseId, seq });
export const placementsOf = async (db: ReadDb, caseId: number, limit: number) =>
	await db.all(Q.placements, { id: caseId, limit });
/** Cases changed at or after a position (a revision and a case id within it), in that order: one page of a cursor. */
export const casesChangedSince = async (
	db: ReadDb,
	project: number,
	from: { rev: number; id: number },
	limit: number,
): Promise<CaseRow[]> => await db.all(Q.changedSince, { project, rev: from.rev, id: from.id, limit });
export const tagCounts = async (db: ReadDb, project: number) => await db.all(Q.tags, { project });
export const requirementList = async (db: ReadDb, project: number) => await db.all(Q.requirements, { project });
/** The active cases, with what each says about automating it, by number. */
export const automationOfCases = async (db: ReadDb, project: number) => await db.all(Q.automation, { project });
/** Every requirement, by key, with the ids of the active cases that cover it. */
export async function requirementCases(
	db: ReadDb,
	project: number,
): Promise<{ key: string; title: string; cases: number[] }[]> {
	const out: { key: string; title: string; cases: number[] }[] = [];
	for (const row of await db.all(Q.covering, { project })) {
		const last = out.at(-1);
		const entry = last?.key === row.key ? last : { key: row.key, title: row.title, cases: [] };
		if (entry !== last) out.push(entry);
		if (row.case_id !== null && !entry.cases.includes(row.case_id)) entry.cases.push(row.case_id);
	}
	return out;
}
export const casesCovering = async (db: ReadDb, project: number, key: string): Promise<CaseRow[]> =>
	await db.all(Q.casesCovering, { project, key });

export const caseIdsOfRequirements = async (db: ReadDb, project: number, keys: readonly string[]): Promise<number[]> =>
	keys.length
		? (await db.all(Q.caseIdsOfRequirements, { project, keys: JSON.stringify(keys) })).map((row) => row.id)
		: [];

export const caseLinksOfRequirements = async (
	db: ReadDb,
	project: number,
	keys: readonly string[],
	cases: readonly number[],
) =>
	keys.length && cases.length
		? await db.all(Q.caseLinksOfRequirements, { project, keys: JSON.stringify(keys), cases: JSON.stringify(cases) })
		: [];

export const caseIdsOfRefs = async (db: ReadDb, project: number, refs: readonly string[]): Promise<number[]> =>
	refs.length ? (await db.all(Q.caseIdsOfRefs, { project, refs: JSON.stringify(refs) })).map((row) => row.id) : [];

export async function impactHeads(
	db: ReadDb,
	project: number,
	candidates: readonly { id: number; failing: boolean }[],
	since: number | null,
): Promise<ImpactHead[]> {
	return (await db.all(Q.impactHeads, { project, candidates: JSON.stringify(candidates), since })).map((row) => ({
		...row,
		failing: row.failing === 1,
	}));
}

export async function impactCasePage(
	db: ReadDb,
	project: number,
	selection: readonly (Pick<ImpactHead, "id" | "no" | "failing"> & { reviewed: boolean })[],
	offset: number,
) {
	const selected = await db.get(Q.impactCountsAndIds, { selection: JSON.stringify(selection), offset });
	if (!selected) throw new Error("impact aggregate returned no row");
	const { page, ...counts } = selected;
	return { counts, rows: await db.all(Q.impactPage, { project, ids: page }) };
}
