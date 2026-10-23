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
	byId: sql<{ id: number }, SignatureRow>("SELECT * FROM signatures WHERE id = $id"),
	insertSignature: sql<{ project: number; hash: string; class: string; text: string; seq: number }>(
		"INSERT INTO signatures (project, hash, class, text, first_seq) VALUES ($project, $hash, $class, $text, $seq)",
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
	const normal = normaliseFailure(failure);
	if (normal.class === "unknown")
		return await storeSignature(ctx, {
			class: normal.class,
			hash: contentHash({ class: normal.class, test: testKey }),
			text: "Unknown failure cause",
		});
	return await storeSignature(ctx, { ...normal, hash: signatureHash(normal) });
}

export async function storeSignature(
	ctx: Ctx,
	signature: Pick<SignatureRow, "hash" | "class" | "text">,
): Promise<SignatureRow> {
	const found = await ctx.db.get(Q.signature, { project: ctx.project.id, hash: signature.hash });
	if (found) return found;
	const { lastId } = await ctx.db.run(Q.insertSignature, {
		project: ctx.project.id,
		...signature,
		seq: ctx.seq,
	});
	return { id: lastId, project: ctx.project.id, ...signature, first_seq: ctx.seq };
}
