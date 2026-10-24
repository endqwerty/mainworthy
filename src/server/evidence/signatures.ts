import { contentHash } from "../../core/hash.ts";
import { type NormalisedFailure, normaliseFailure, signatureHash } from "../../core/signature.ts";
import type { Ctx } from "../kernel/ctx.ts";
import { type ReadDb, sql } from "../kernel/db.ts";

export type SignatureRow = {
	id: number;
	project: number;
	hash: string;
	class: NormalisedFailure["class"];
	text: string;
	first_seq: number;
};
const Q = {
	signature: sql<{ project: number; hash: string }, SignatureRow>(
		"SELECT * FROM signatures WHERE project = $project AND hash = $hash",
	),
	byHashes: sql<{ project: number; hashes: readonly string[] }, SignatureRow>(
		"SELECT * FROM signatures WHERE project=$project AND hash=ANY($hashes::text[])",
	),
	insertSignatures: sql<
		{ project: number; seq: number; hashes: readonly string[]; classes: readonly string[]; texts: readonly string[] },
		SignatureRow
	>(`
 INSERT INTO signatures(project,hash,class,text,first_seq)
 SELECT $project, u.hash, u.class, u.text, $seq FROM unnest($hashes::text[],$classes::text[],$texts::text[]) WITH ORDINALITY AS u(hash,class,text,position)
 ORDER BY u.position RETURNING *`),

	byId: sql<{ id: number }, SignatureRow>("SELECT * FROM signatures WHERE id = $id"),
	insertSignature: sql<{ project: number; hash: string; class: string; text: string; seq: number }, { id: number }>(
		"INSERT INTO signatures (project, hash, class, text, first_seq) VALUES ($project, $hash, $class, $text, $seq) RETURNING id",
	),
};
export const signatureById = async (db: ReadDb, id: number): Promise<SignatureRow | null> =>
	await db.get(Q.byId, { id });
export const signatureByHash = async (db: ReadDb, project: number, hash: string): Promise<SignatureRow | null> =>
	await db.get(Q.signature, { project, hash });

export function fileSignature(signature: Pick<SignatureRow, "hash" | "class" | "text">, file: string | null) {
	return {
		hash: contentHash({ signature: signature.hash, file }),
		class: signature.class,
		text: `Split by file (${file ?? "no file reported"}): ${signature.text}`,
	};
}

export async function ensureSignature(
	ctx: Ctx,
	testKey: string,
	failure: { message: string; detail?: string },
): Promise<SignatureRow> {
	return await storeSignature(ctx, failureSignature(testKey, failure));
}

export async function storeSignature(
	ctx: Ctx,
	signature: Pick<SignatureRow, "hash" | "class" | "text">,
): Promise<SignatureRow> {
	const found = await ctx.db.get(Q.signature, { project: ctx.project.id, hash: signature.hash });
	if (found) return found;
	const { id: lastId } = await ctx.db.one(Q.insertSignature, {
		project: ctx.project.id,
		...signature,
		seq: ctx.seq,
	});
	return { id: lastId, project: ctx.project.id, ...signature, first_seq: ctx.seq };
}

export function failureSignature(testKey: string, failure: { message: string; detail?: string }) {
	const normal = normaliseFailure(failure);
	return normal.class === "unknown"
		? { class: normal.class, hash: contentHash({ class: normal.class, test: testKey }), text: "Unknown failure cause" }
		: { ...normal, hash: signatureHash(normal) };
}

/** Preserve first-observed order while looking up and adding a slice's causes together. */
export async function storeSignatures(
	ctx: Ctx,
	signatures: readonly Pick<SignatureRow, "hash" | "class" | "text">[],
): Promise<Map<string, SignatureRow>> {
	const unique = new Map<string, (typeof signatures)[number]>();
	for (const signature of signatures) if (!unique.has(signature.hash)) unique.set(signature.hash, signature);
	const out = new Map<string, SignatureRow>();
	if (!unique.size) return out;
	for (const row of await signaturesByHashes(ctx.db, ctx.project.id, [...unique.keys()])) out.set(row.hash, row);
	const missing = [...unique.values()].filter((signature) => !out.has(signature.hash));
	for (let start = 0; start < missing.length; start += 200) {
		const slice = missing.slice(start, start + 200);
		for (const row of await ctx.db.all(Q.insertSignatures, {
			project: ctx.project.id,
			seq: ctx.seq,
			hashes: slice.map((s) => s.hash),
			classes: slice.map((s) => s.class),
			texts: slice.map((s) => s.text),
		}))
			out.set(row.hash, row);
	}
	return out;
}
export async function signaturesByHashes(
	db: ReadDb,
	project: number,
	hashes: readonly string[],
): Promise<SignatureRow[]> {
	const rows: SignatureRow[] = [];
	for (let start = 0; start < hashes.length; start += 200)
		rows.push(...(await db.all(Q.byHashes, { project, hashes: hashes.slice(start, start + 200) })));
	return rows;
}
