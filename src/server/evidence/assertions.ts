// The broad-assertion rule reads distinct observations, never the payload of a commit's raw results or tries.
import { signatureHash } from "../../core/signature.ts";
import { allProjects, type Ctx } from "../kernel/ctx.ts";
import { json, type ReadDb, sql, type WriteDb } from "../kernel/db.ts";
import { invalid } from "../kernel/errors.ts";
import { fileSignature, type SignatureRow, signaturesByHashes, storeSignature, storeSignatures } from "./signatures.ts";

const Q = {
	sliceState: sql<
		{ project: number; scope: string; roots: readonly number[] },
		{ root: number; active: boolean; seen: string; files: string }
	>(`
 SELECT u.root,a.root IS NOT NULL AS active,
 (SELECT coalesce(json_agg(json_build_array(t.test,t.file)),'[]')::text FROM (
 SELECT test,file FROM assertion_seen WHERE project=$project AND scope=$scope AND root=u.root LIMIT 51) t) AS seen,
 (SELECT coalesce(json_agg(f.file),'[]')::text FROM (
 SELECT DISTINCT file FROM assertion_seen WHERE project=$project AND scope=$scope AND root=u.root ORDER BY file NULLS FIRST LIMIT 7) f) AS files
 FROM unnest($roots::bigint[]) AS u(root) LEFT JOIN assertion_spreads a ON a.project=$project AND a.scope=$scope AND a.root=u.root`),

	rememberRoots: sql<{ project: number; signatures: readonly number[]; roots: readonly number[] }>(`
 INSERT INTO assertion_roots(project,signature,root) SELECT $project,u.signature,u.root FROM unnest($signatures::bigint[],$roots::bigint[]) AS u(signature,root) ON CONFLICT DO NOTHING`),
	seeSlice: sql<{
		project: number;
		scope: string;
		roots: readonly number[];
		tests: readonly number[];
		files: readonly (string | null)[];
	}>(`
 INSERT INTO assertion_seen(project,scope,root,test,file) SELECT $project,$scope,u.root,u.test,u.file FROM unnest($roots::bigint[],$tests::bigint[],$files::text[]) AS u(root,test,file) ON CONFLICT DO NOTHING`),
	activateSlice: sql<{ project: number; scope: string; roots: readonly number[] }>(`
 INSERT INTO assertion_spreads(project,scope,root) SELECT $project,$scope,root FROM unnest($roots::bigint[]) AS u(root) ON CONFLICT DO NOTHING`),

	ready: sql<{ project: number }, { project: number }>("SELECT project FROM assertion_index WHERE project = $project"),
	markReady: sql<{ project: number }>("INSERT INTO assertion_index(project) VALUES ($project) ON CONFLICT DO NOTHING"),
	clearRoots: sql<{ project: number }>("DELETE FROM assertion_roots WHERE project = $project"),
	clearSeen: sql<{ project: number }>("DELETE FROM assertion_seen WHERE project = $project"),
	clearSpreads: sql<{ project: number }>("DELETE FROM assertion_spreads WHERE project = $project"),
	clearReady: sql<{ project: number }>("DELETE FROM assertion_index WHERE project = $project"),
	rememberRoot: sql<{ project: number; signature: number; root: number }>(
		"INSERT INTO assertion_roots(project, signature, root) VALUES ($project, $signature, $root) ON CONFLICT DO NOTHING",
	),
	see: sql<{ project: number; scope: string; root: number; test: number; file: string | null }>(
		"INSERT INTO assertion_seen(project, scope, root, test, file) VALUES ($project, $scope, $root, $test, $file) ON CONFLICT DO NOTHING",
	),
	active: sql<{ project: number; scope: string; root: number }, { root: number }>(
		"SELECT root FROM assertion_spreads WHERE project = $project AND scope = $scope AND root = $root",
	),
	activate: sql<{ project: number; scope: string; root: number }>(
		"INSERT INTO assertion_spreads(project, scope, root) VALUES ($project, $scope, $root) ON CONFLICT DO NOTHING",
	),
	tests: sql<{ project: number; scope: string; root: number }, { n: number }>(
		"SELECT count(*) AS n FROM (SELECT test FROM assertion_seen WHERE project = $project AND scope = $scope AND root = $root LIMIT 51)",
	),
	firstFile: sql<{ project: number; scope: string; root: number }, { file: string | null }>(
		"SELECT file FROM assertion_seen WHERE project = $project AND scope = $scope AND root = $root ORDER BY file NULLS FIRST LIMIT 1",
	),
	nextFile: sql<{ project: number; scope: string; root: number; after: string }, { file: string }>(
		"SELECT file FROM assertion_seen WHERE project = $project AND scope = $scope AND root = $root AND file > $after ORDER BY file NULLS FIRST LIMIT 1",
	),
	// NULL is the first index entry; the empty string, if present in an imported test, is a distinct reported file.
	firstReported: sql<{ project: number; scope: string; root: number }, { file: string }>(
		"SELECT file FROM assertion_seen WHERE project = $project AND scope = $scope AND root = $root AND file IS NOT NULL ORDER BY file NULLS FIRST LIMIT 1",
	),
	clearSessionSeen: sql<{ project: number; scope: string }>(
		"DELETE FROM assertion_seen WHERE project = $project AND scope = $scope",
	),
	clearSessionSpread: sql<{ project: number; scope: string }>(
		"DELETE FROM assertion_spreads WHERE project = $project AND scope = $scope",
	),
	history: sql<
		{ project: number; after: number; position: number },
		SignatureRow & {
			result_id: number;
			position: number;
			test: number;
			file: string | null;
			what: string;
			commit_sha: string | null;
		}
	>(`SELECT r.id AS result_id, observation.position, r.test, t.file, stored_signature.*, g.what, g.commit_sha
 FROM results r JOIN tests t ON t.id = r.test JOIN targets g ON g.id = r.target
 CROSS JOIN LATERAL (
  SELECT r.signature, 0::bigint AS position
  UNION ALL SELECT tr.signature, tr.try AS position FROM result_tries tr WHERE tr.result = r.id
 ) observation JOIN signatures stored_signature ON stored_signature.id = observation.signature
 WHERE r.project = $project AND r.id >= $after AND (r.id > $after OR observation.position > $position)
 ORDER BY r.id, observation.position LIMIT 200`),
};

export const assertionScope = (target: { what: string; commit_sha: string | null }, batch: number): string =>
	target.commit_sha === null ? `batch:${batch}` : `commit:${target.what}`;

async function rememberRoot(db: WriteDb, root: SignatureRow, signature: number): Promise<void> {
	await db.run(Q.rememberRoot, { project: root.project, root: root.id, signature });
}

async function child(ctx: Ctx, root: SignatureRow, file: string | null): Promise<void> {
	const split = await storeSignature(ctx, fileSignature(root, file));
	await rememberRoot(ctx.db, root, split.id);
}

/** At most six covering-index successor seeks, regardless of repeated tests in one file. */
async function broad(db: ReadDb, key: { project: number; scope: string; root: number }): Promise<boolean> {
	if (((await db.get(Q.tests, key))?.n ?? 0) < 51) return false;
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
	if (await db.get(Q.active, key)) return "active";
	await db.run(Q.see, { ...key, test: test.id, file: test.file });
	if (!(await broad(db, key))) return "narrow";
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
	if (await db.get(Q.ready, { project })) return;
	await db.run(Q.clearRoots, { project });
	await db.run(Q.clearSeen, { project });
	await db.run(Q.clearSpreads, { project });
	let after = 0;
	let position = -1;
	const active = new Set<string>();
	for (;;) {
		const rows = await db.all(Q.history, { project, after, position });
		if (rows.length === 0) break;
		const observations = rows.map((row) => ({ ...row, signature: row }));
		const candidates = new Map<string, SignatureRow>();
		const hashes: string[] = [];
		for (const row of observations) {
			const signature = row.signature;
			if (signature?.class !== "assertion" || signatureHash(signature) === signature.hash) continue;
			const prefix = `Split by file (${row.file ?? "no file reported"}): `;
			hashes.push(signatureHash({ class: signature.class, text: signature.text.slice(prefix.length) }));
		}
		for (const root of await signaturesByHashes(db, project, hashes)) candidates.set(root.hash, root);
		const relations = new Map<number, number>();
		for (const row of observations) {
			after = row.result_id;
			position = row.position;
			const signature = row.signature;
			if (signature?.class !== "assertion") continue;
			let root: SignatureRow = signature;
			if (signatureHash(signature) !== signature.hash) {
				const prefix = `Split by file (${row.file ?? "no file reported"}): `;
				const text = signature.text.slice(prefix.length);
				const candidate = candidates.get(signatureHash({ class: signature.class, text }));
				if (
					!signature.text.startsWith(prefix) ||
					!candidate ||
					candidate.class !== signature.class ||
					candidate.text !== text ||
					fileSignature(candidate, row.file).hash !== signature.hash
				)
					throw invalid(`cannot reconstruct assertion root ${signature.id}`);
				root = candidate;
			}
			relations.set(signature.id, root.id);
			if (row.commit_sha === null) continue;
			const scope = `commit:${row.what}`;
			const key = JSON.stringify([scope, root.id]);
			if (active.has(key)) continue;
			const state = await recordObservation(db, { project, scope, root: root.id }, { id: row.test, file: row.file });
			if (state !== "narrow") active.add(key);
		}
		if (relations.size)
			await db.run(Q.rememberRoots, { project, signatures: [...relations.keys()], roots: [...relations.values()] });
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

/** Plan the old observation order in memory, then store a slice's roots and file children together. */
export async function observeFailureSlice(
	ctx: Ctx,
	scope: string,
	observations: readonly {
		signature: Pick<SignatureRow, "hash" | "class" | "text">;
		test: { id: number; file: string | null };
	}[],
): Promise<Map<string, SignatureRow>> {
	if (!observations.length) return new Map();
	const assertions = observations.filter((o) => o.signature.class === "assertion");
	if (!assertions.length)
		return await storeSignatures(
			ctx,
			observations.map((o) => o.signature),
		);
	const roots = new Map(assertions.map((o) => [o.signature.hash, o.signature]));
	const known = await signaturesByHashes(ctx.db, ctx.project.id, [...roots.keys()]);
	const hashes = new Map(known.map((row) => [row.id, row.hash]));
	const states = new Map(
		[...roots.keys()].map((hash) => [
			hash,
			{ active: false, seen: new Map<number, string | null>(), files: new Set<string | null>() },
		]),
	);
	for (let start = 0; start < known.length; start += 200) {
		for (const row of await ctx.db.all(Q.sliceState, {
			project: ctx.project.id,
			scope,
			roots: known.slice(start, start + 200).map((root) => root.id),
		})) {
			const hash = hashes.get(row.root),
				state = hash === undefined ? undefined : states.get(hash);
			if (!state) throw new Error("assertion state missing from slice");
			state.active = row.active;
			for (const [test, file] of json<[number, string | null][]>(row.seen)) state.seen.set(test, file);
			for (const file of json<(string | null)[]>(row.files)) state.files.add(file);
		}
	}
	const additions: typeof assertions = [];
	const activated = new Set<string>();
	const candidates: Pick<SignatureRow, "hash" | "class" | "text">[] = [];
	const children: { root: string; hash: string }[] = [];
	const child = (root: Pick<SignatureRow, "hash" | "class" | "text">, file: string | null) => {
		const signature = fileSignature(root, file);
		candidates.push(signature);
		children.push({ root: root.hash, hash: signature.hash });
	};
	for (const observation of observations) {
		const root = observation.signature;
		candidates.push(root);
		if (root.class !== "assertion") continue;
		const state = states.get(root.hash);
		if (!state) throw new Error("assertion state missing from slice");
		if (state.active) {
			child(root, observation.test.file);
			continue;
		}
		if (!state.seen.has(observation.test.id)) {
			state.seen.set(observation.test.id, observation.test.file);
			state.files.add(observation.test.file);
			additions.push(observation);
		}
		if (state.seen.size < 51 || [...state.files].filter((file) => file !== null).length < 6) continue;
		state.active = true;
		activated.add(root.hash);
		for (const file of [...state.files].sort((a, b) =>
			a === null ? -1 : b === null ? 1 : Buffer.compare(Buffer.from(a), Buffer.from(b)),
		))
			child(root, file);
	}
	const stored = await storeSignatures(ctx, candidates);
	const idOf = (hash: string) => {
		const row = stored.get(hash);
		if (!row) throw new Error("signature was not stored");
		return row.id;
	};
	const relations = new Map<string, string>([...roots.keys()].map((hash) => [hash, hash]));
	for (const child of children) relations.set(child.hash, child.root);
	await ctx.db.run(Q.rememberRoots, {
		project: ctx.project.id,
		signatures: [...relations.keys()].map(idOf),
		roots: [...relations.values()].map(idOf),
	});
	if (additions.length)
		await ctx.db.run(Q.seeSlice, {
			project: ctx.project.id,
			scope,
			roots: additions.map((o) => idOf(o.signature.hash)),
			tests: additions.map((o) => o.test.id),
			files: additions.map((o) => o.test.file),
		});
	if (activated.size)
		await ctx.db.run(Q.activateSlice, { project: ctx.project.id, scope, roots: [...activated].map(idOf) });
	return stored;
}
