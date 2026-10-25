import { ATTACHMENT_LIMITS, type Attachment, type AttachmentInput, attachmentBytes } from "../../core/attachments.ts";
import { attachmentType } from "../kernel/blobs.ts";
import type { Ctx } from "../kernel/ctx.ts";
import { type ReadDb, sql } from "../kernel/db.ts";
import { invalid, notFound } from "../kernel/errors.ts";

const Q = {
	insertSlice: sql<
		{
			results: readonly number[];
			names: readonly string[];
			hashes: readonly string[];
			sizes: readonly number[];
			types: readonly string[];
			ats: readonly (string | null)[];
		},
		Attachment
	>(`
 INSERT INTO attachments(result,name,hash,size,type,at)
 SELECT u.result,u.name,u.hash,u.size,u.type,u.at FROM unnest($results::bigint[],$names::text[],$hashes::text[],$sizes::bigint[],$types::text[],$ats::text[]) WITH ORDINALITY AS u(result,name,hash,size,type,at,position)
 ORDER BY u.position RETURNING *`),

	list: sql<{ result: number }, Attachment>("SELECT * FROM attachments WHERE result = $result ORDER BY id"),
	referenced: sql<{ hash: string }, { present: boolean }>(
		"SELECT EXISTS(SELECT 1 FROM attachments WHERE hash=$hash) AS present",
	),
	hashes: sql<readonly [], { hash: string }>("SELECT DISTINCT hash FROM attachments"),
};
export const attachmentsOf = async (db: ReadDb, result: number): Promise<Attachment[]> =>
	await db.all(Q.list, { result });
export const attachmentReferenced = async (db: ReadDb, hash: string): Promise<boolean> =>
	(await db.one(Q.referenced, { hash })).present;
export const attachmentHashes = async (db: ReadDb): Promise<Set<string>> =>
	new Set((await db.all(Q.hashes)).map((row) => row.hash));
/** Files are immutable evidence. A retry under its command id never appends twice. */
export async function recordAttachments(
	ctx: Ctx,
	result: number,
	files: readonly AttachmentInput[],
): Promise<Attachment[]> {
	if (files.length === 0) return [];
	const existing = await attachmentsOf(ctx.db, result);
	const size =
		existing.reduce((sum, item) => sum + item.size, 0) +
		files.reduce((sum, item) => sum + attachmentBytes(item.data), 0);
	if (existing.length + files.length > ATTACHMENT_LIMITS.perResult || size > ATTACHMENT_LIMITS.report)
		throw invalid("A result may carry at most 20 attachments and 16 MiB");
	return await recordAttachmentSlice(ctx, [{ result, files }]);
}
export async function attachmentContent(ctx: Ctx<ReadDb>, result: number, id: number) {
	const attachment = (await attachmentsOf(ctx.db, result)).find((item) => item.id === id);
	if (!attachment) throw notFound("attachment");
	const bytes = await ctx.app.blobs.get(attachment.hash);
	if (!bytes || bytes.length !== attachment.size || attachmentType(bytes) !== attachment.type)
		throw notFound("attachment content is missing or damaged; restore it from a backup");
	return { kind: "file" as const, attachment, data: Buffer.from(bytes).toString("base64") };
}

/** Report application passes only newly inserted result ids, so no existing attachment read is needed. */
export async function recordAttachmentSlice(
	ctx: Ctx,
	entries: readonly { result: number; files: readonly AttachmentInput[] }[],
): Promise<Attachment[]> {
	const rows: Omit<Attachment, "id">[] = [];
	for (const { result, files } of entries) {
		if (
			files.length > ATTACHMENT_LIMITS.perResult ||
			files.reduce((sum, file) => sum + attachmentBytes(file.data), 0) > ATTACHMENT_LIMITS.report
		)
			throw invalid("A result may carry at most 20 attachments and 16 MiB");
		for (const file of files) {
			const bytes = Buffer.from(file.data, "base64");
			rows.push({
				result,
				name: file.name,
				hash: await ctx.app.blobs.put(bytes),
				size: bytes.length,
				type: attachmentType(bytes),
				at: file.at ?? null,
			});
		}
	}
	if (!rows.length) return [];
	return await ctx.db.all(Q.insertSlice, {
		results: rows.map((row) => row.result),
		names: rows.map((row) => row.name),
		hashes: rows.map((row) => row.hash),
		sizes: rows.map((row) => row.size),
		types: rows.map((row) => row.type),
		ats: rows.map((row) => row.at),
	});
}
