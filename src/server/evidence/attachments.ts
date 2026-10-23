import { ATTACHMENT_LIMITS, type Attachment, type AttachmentInput, attachmentBytes } from "../../core/attachments.ts";
import { attachmentType } from "../kernel/blobs.ts";
import type { Ctx } from "../kernel/ctx.ts";
import { type ReadDb, sql } from "../kernel/db.ts";
import { invalid, notFound } from "../kernel/errors.ts";

const Q = {
	list: sql<{ result: number }, Attachment>("SELECT * FROM attachments WHERE result = $result ORDER BY id"),
	insert: sql<{ result: number; name: string; hash: string; size: number; type: string; at: string | null }>(
		"INSERT INTO attachments (result, name, hash, size, type, at) VALUES ($result, $name, $hash, $size, $type, $at)",
	),
	hashes: sql<readonly [], { hash: string }>("SELECT DISTINCT hash FROM attachments"),
};
export const attachmentsOf = async (db: ReadDb, result: number): Promise<Attachment[]> =>
	await db.all(Q.list, { result });
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
	return files.map((file) => {
		const bytes = Buffer.from(file.data, "base64");
		const hash = ctx.app.blobs.put(bytes);
		const entry = {
			result,
			name: file.name,
			hash,
			size: bytes.length,
			type: attachmentType(bytes),
			at: file.at ?? null,
		};
		const inserted = ctx.db.run(Q.insert, entry);
		return { id: inserted.lastId, ...entry };
	});
}
export async function attachmentContent(ctx: Ctx, result: number, id: number) {
	const attachment = (await attachmentsOf(ctx.db, result)).find((item) => item.id === id);
	if (!attachment) throw notFound("attachment");
	const bytes = ctx.app.blobs.get(attachment.hash);
	if (!bytes || bytes.length !== attachment.size || attachmentType(bytes) !== attachment.type)
		throw notFound("attachment content is missing or damaged; restore it from a backup");
	return { kind: "file" as const, attachment, data: Buffer.from(bytes).toString("base64") };
}
