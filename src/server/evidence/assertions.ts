// The broad-assertion rule reads distinct observations, never the payload of a commit's raw results or tries.
import { signatureHash } from "../../core/signature.ts";
import { allProjects, type Ctx } from "../kernel/ctx.ts";
import { type ReadDb, type WriteDb, sql } from "../kernel/db.ts";
import { invalid } from "../kernel/errors.ts";
import { fileSignature, type SignatureRow, signatureByHash, signatureById, storeSignature } from "./signatures.ts";

const PAGE = 200;
const Q = {
	ready: sql<{ project: number }, { project: number }>("SELECT project FROM assertion_index WHERE project = $project"),
	markReady: sql<{ project: number }>("INSERT OR IGNORE INTO assertion_index(project) VALUES ($project)"),
	clearRoots: sql<{ project: number }>("DELETE FROM assertion_roots WHERE project = $project"),
	clearSeen: sql<{ project: number }>("DELETE FROM assertion_seen WHERE project = $project"),
	clearSpreads: sql<{ project: number }>("DELETE FROM assertion_spreads WHERE project = $project"),
	clearReady: sql<{ project: number }>("DELETE FROM assertion_index WHERE project = $project"),
	root: sql<{ signature: number }, SignatureRow>(
		"SELECT s.* FROM assertion_roots a JOIN signatures s ON s.id = a.root WHERE a.signature = $signature",
	),
	rememberRoot: sql<{ project: number; signature: number; root: number }>(
		"INSERT OR IGNORE INTO assertion_roots(project, signature, root) VALUES ($project, $signature, $root)",
	),
	see: sql<{ project: number; scope: string; root: number; test: number; file: string | null }>(
		"INSERT OR IGNORE INTO assertion_seen(project, scope, root, test, file) VALUES ($project, $scope, $root, $test, $file)",
	),
	active: sql<{ project: number; scope: string; root: number }, { root: number }>(
		"SELECT root FROM assertion_spreads WHERE project = $project AND scope = $scope AND root = $root",
	),
	activate: sql<{ project: number; scope: string; root: number }>(
		"INSERT OR IGNORE INTO assertion_spreads(project, scope, root) VALUES ($project, $scope, $root)",
	),
	tests: sql<{ project: number; scope: string; root: number }, { n: number }>(
		"SELECT count(*) AS n FROM (SELECT test FROM assertion_seen WHERE project = $project AND scope = $scope AND root = $root LIMIT 51)",
	),
	firstFile: sql<{ project: number; scope: string; root: number }, { file: string | null }>(
		"SELECT file FROM assertion_seen WHERE project = $project AND scope = $scope AND root = $root ORDER BY file LIMIT 1",
	),
	nextFile: sql<{ project: number; scope: string; root: number; after: string }, { file: string }>(
		"SELECT file FROM assertion_seen WHERE project = $project AND scope = $scope AND root = $root AND file > $after ORDER BY file LIMIT 1",
	),
	// NULL is the first index entry; the empty string, if present in an imported test, is a distinct reported file.
	firstReported: sql<{ project: number; scope: string; root: number }, { file: string }>(
		"SELECT file FROM assertion_seen WHERE project = $project AND scope = $scope AND root = $root AND file IS NOT NULL ORDER BY file LIMIT 1",
	),
	clearSessionSeen: sql<{ project: number; scope: string }>(
		"DELETE FROM assertion_seen WHERE project = $project AND scope = $scope",
	),
	clearSessionSpread: sql<{ project: number; scope: string }>(
		"DELETE FROM assertion_spreads WHERE project = $project AND scope = $scope",
	),
	history: sql<
		{ project: number; after: number },
		{ id: number; test: number; file: string | null; signature: number | null; what: string; commit_sha: string | null }
	>(
		`SELECT r.id, r.test, t.file, r.signature, g.what, g.commit_sha FROM results r
   JOIN tests t ON t.id = r.test JOIN targets g ON g.id = r.target
   WHERE r.project = $project AND r.id > $after ORDER BY r.id LIMIT 200`,
	),
	firstTries: sql<{ result: number }, { signature: number | null; try: number }>(
		"SELECT signature, try FROM result_tries WHERE result = $result ORDER BY try LIMIT 200",
	),
	nextTries: sql<{ result: number; after: number }, { signature: number | null; try: number }>(
		"SELECT signature, try FROM result_tries WHERE result = $result AND try > $after ORDER BY try LIMIT 200",
	),
};

export const assertionScope = (target: { what: string; commit_sha: string | null }, batch: number): string =>
	target.commit_sha === null ? `batch:${batch}` : `commit:${target.what}`;

async function rememberRoot(db: WriteDb, root: SignatureRow, signature: number): Promise<void> {
	await db.run(Q.rememberRoot, { project: root.project, root: root.id, signature });
}

/** Verify both hashes when recovering a file child; a failure message can itself start with "Split by file". */
async function originalRoot(db: WriteDb, signature: SignatureRow, file: string | null): Promise<SignatureRow> {
	const known = await db.get(Q.root, { signature: signature.id });
	if (known) return known;
	let root = signature;
	if (signatureHash(signature) !== signature.hash) {
		const prefix = `Split by file (${file ?? "no file reported"}): `;
		const text = signature.text.slice(prefix.length);
		const candidate = await signatureByHash(db, signature.project, signatureHash({ class: signature.class, text }));
		if (
			!signature.text.startsWith(prefix) ||
			!candidate ||
			candidate.class !== signature.class ||
			candidate.text !== text ||
			fileSignature(candidate, file).hash !== signature.hash
		) {
			throw invalid(`cannot reconstruct assertion root ${signature.id}`);
		}
		root = candidate;
	}
	await rememberRoot(db, root, signature.id);
	return root;
}

async function child(ctx: Ctx, root: SignatureRow, file: string | null): Promise<void> {
	const split = await storeSignature(ctx, fileSignature(root, file));
	await rememberRoot(ctx.db, root, split.id);
}

/** At most six covering-index successor seeks, regardless of repeated tests in one file. */
async function broad(db: ReadDb, key: { project: number; scope: string; root: number }): Promise<boolean> {
	if ((db.get(Q.tests, key)?.n ?? 0) < 51) return false;
	let file = (await db.get(Q.firstReported, key))?.file;
	for (let n = 1; file !== undefined; n++) {
		if (n === 6) return true;
		file = (await db.get(Q.nextFile, { ...key, after: file }))?.file;
	}
	return false;
}

async function recordObservation(
	db: WriteDb,
	key: { project: number; scope: string; root: number },
	test: { id: number; file: string | null },
): Promise<"narrow" | "activated" | "active"> {
	if (db.get(Q.active, key)) return "active";
	await db.run(Q.see, { ...key, test: test.id, file: test.file });
	if (!broad(db, key)) return "narrow";
	await db.run(Q.activate, key);
	return "activated";
}

export async function observeAssertion(
	ctx: Ctx,
	scope: string,
	root: SignatureRow,
	test: { id: number; file: string | null },
): Promise<void> {
	if (root.class !== "assertion") return;
	const key = { project: ctx.project.id, scope, root: root.id };
	await rememberRoot(ctx.db, root, root.id);
	const state = await recordObservation(ctx.db, key, test);
	if (state === "narrow") return;
	if (state === "active") {
		await child(ctx, root, test.file);
		return;
	}
	let file = await ctx.db.get(Q.firstFile, key);
	while (file) {
		await child(ctx, root, file.file);
		file =
			file.file === null
				? await ctx.db.get(Q.firstReported, key)
				: await ctx.db.get(Q.nextFile, { ...key, after: file.file });
	}
}

export async function finishAssertionScope(ctx: Ctx, scope: string): Promise<void> {
	if (!scope.startsWith("batch:")) return;
	await ctx.db.run(Q.clearSessionSeen, { project: ctx.project.id, scope });
	await ctx.db.run(Q.clearSessionSpread, { project: ctx.project.id, scope });
}

/** One-time derived reconstruction. The caller's transaction includes the completion marker. No evidence is rewritten. */
export async function* ensureAssertionIndex(db: WriteDb, project: number): AsyncGenerator<undefined, void, void> {
	if (db.get(Q.ready, { project })) return;
	await db.run(Q.clearRoots, { project });
	await db.run(Q.clearSeen, { project });
	await db.run(Q.clearSpreads, { project });
	let after = 0;
	let work = 0;
	for (;;) {
		const rows = await db.all(Q.history, { project, after });
		if (rows.length === 0) break;
		for (const row of rows) {
			after = row.id;
			const remember = async (id: number | null) => {
				const signature = id === null ? null : await signatureById(db, id);
				if (signature?.class !== "assertion") return;
				const root = await originalRoot(db, signature, row.file);
				if (row.commit_sha !== null)
					await recordObservation(
						db,
						{ project, scope: `commit:${row.what}`, root: root.id },
						{ id: row.test, file: row.file },
					);
			};
			await remember(row.signature);
			let tries = await db.all(Q.firstTries, { result: row.id });
			for (;;) {
				let last: number | null = null;
				for (const tried of tries) {
					await remember(tried.signature);
					last = tried.try;
					if (++work % PAGE === 0) yield;
				}
				if (tries.length < PAGE || last === null) break;
				yield;
				tries = await db.all(Q.nextTries, { result: row.id, after: last });
			}
			if (++work % PAGE === 0) yield;
		}
		yield;
	}
	await db.run(Q.markReady, { project });
}

/** Startup and archive import rebuild privately, before any accepted batch can use the index. */
export async function rebuildAssertionIndexes(
	db: WriteDb,
	force = false,
	progress: () => void = () => {},
): Promise<void> {
	await db.transaction(async () => {
		for (const { id: project } of await allProjects(db)) {
			if (force) await db.run(Q.clearReady, { project });
			for await (const _ of ensureAssertionIndex(db, project)) {
				progress();
			}
		}
	});
}
