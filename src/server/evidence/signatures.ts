import { contentHash } from "../../core/hash.ts";
import { normaliseFailure, signatureHash } from "../../core/signature.ts";
import type { Ctx } from "../kernel/ctx.ts";
import { type Db, sql } from "../kernel/db.ts";

export type SignatureRow = {
	id: number;
	project: number;
	hash: string;
	class: "assertion" | "timeout" | "infra";
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
export const signatureById = (db: Db, id: number): SignatureRow | null => db.get(Q.byId, { id });
export const signatureByHash = (db: Db, project: number, hash: string): SignatureRow | null =>
	db.get(Q.signature, { project, hash });

export function fileSignature(signature: Pick<SignatureRow, "hash" | "class" | "text">, file: string | null) {
	return {
		hash: contentHash({ signature: signature.hash, file }),
		class: signature.class,
		text: `Split by file (${file ?? "no file reported"}): ${signature.text}`,
	};
}

export function ensureSignature(ctx: Ctx, failure: { message: string; detail?: string }): SignatureRow {
	const normal = normaliseFailure(failure);
	return storeSignature(ctx, { ...normal, hash: signatureHash(normal) });
}

export function storeSignature(ctx: Ctx, signature: Pick<SignatureRow, "hash" | "class" | "text">): SignatureRow {
	const found = ctx.db.get(Q.signature, { project: ctx.project.id, hash: signature.hash });
	if (found) return found;
	const { lastId } = ctx.db.run(Q.insertSignature, {
		project: ctx.project.id,
		...signature,
		seq: ctx.seq,
	});
	return { id: lastId, project: ctx.project.id, ...signature, first_seq: ctx.seq };
}
