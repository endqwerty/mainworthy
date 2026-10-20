import { z } from "zod";
import { projectCommand } from "./commands.ts";

export const ATTACHMENT_LIMITS = {
	file: 4 * 1024 ** 2,
	report: 16 * 1024 ** 2,
	perResult: 20,
	perReport: 100,
} as const;
export const attachmentBytes = (data: string): number =>
	(data.length * 3) / 4 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
export const AttachmentData = z
	.string()
	.max(Math.ceil(ATTACHMENT_LIMITS.file / 3) * 4)
	.refine((data) => {
		if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return false;
		const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
		const last = alphabet.indexOf(data[data.length - padding - 1] ?? "A");
		return (
			attachmentBytes(data) <= ATTACHMENT_LIMITS.file && (padding === 0 || (last & (padding === 2 ? 15 : 3)) === 0)
		);
	}, "Use canonical base64 for a file of at most 4 MiB");
export const AttachmentName = z
	.string()
	.trim()
	.min(1)
	.max(200)
	// biome-ignore lint/suspicious/noControlCharactersInRegex: filenames must not contain header or path control characters.
	.regex(/^[^/\\\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+$/)
	.refine((name) => name !== "." && name !== "..", "Use a file name, without a path");
export const AttachmentInput = z.object({
	name: AttachmentName,
	data: AttachmentData,
	at: z.string().trim().min(1).max(40).optional(),
});
export type AttachmentInput = z.infer<typeof AttachmentInput>;
export const Attachment = z.object({
	id: z.number().int().positive(),
	result: z.number().int().positive(),
	name: AttachmentName,
	hash: z.string().regex(/^[a-f0-9]{64}$/),
	size: z.number().int().min(0).max(ATTACHMENT_LIMITS.file),
	type: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp", "application/octet-stream"]),
	at: z.string().max(40).nullable(),
});
export type Attachment = z.infer<typeof Attachment>;
export const AttachInput = z.object({
	result: z.number().int().positive(),
	attachment: AttachmentInput,
	...projectCommand,
});
export const AttachmentReadInput = z.object({
	result: z.number().int().positive(),
	id: z.number().int().positive().optional(),
});
export const AttachmentReply = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("list"), items: z.array(Attachment) }),
	z.object({ kind: z.literal("file"), attachment: Attachment, data: AttachmentData }),
]);
