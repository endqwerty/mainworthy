import { AttachInput, AttachmentReadInput } from "../../core/attachments.ts";
import { REPLIES } from "../../core/replies.ts";
import { attachmentContent, attachmentsOf, recordAttachments } from "../evidence/attachments.ts";
import { resultById } from "../evidence/evidence.ts";
import type { Ctx } from "../kernel/ctx.ts";
import type { ReadDb } from "../kernel/db.ts";
import { forbidden, notFound } from "../kernel/errors.ts";
import { defineOp } from "./registry.ts";

async function mustResult(ctx: Ctx<ReadDb>, id: number) {
	const result = await resultById(ctx.db, id);
	if (!result || result.project !== ctx.project.id) throw notFound(`result ${id}`);
	return result;
}
export const attachOp = defineOp({
	name: "attach",
	input: AttachInput,
	output: REPLIES.attach,
	summary: "Append a screenshot or small file to a result you recorded. Supply the file as base64.",
	needs: "record",
	scope: "project",
	effect: "write",
	mcp: null,
	async run(ctx, input) {
		const result = await mustResult(ctx, input.result);
		if (result.actor !== ctx.actor.id) throw forbidden("Only the producer of a result may attach evidence to it");
		const saved = (await recordAttachments(ctx, result.id, [input.attachment]))[0];
		if (!saved) throw new Error("attachment was not recorded");
		return saved;
	},
});
export const attachmentOp = defineOp({
	name: "attachment",
	input: AttachmentReadInput,
	output: REPLIES.attachment,
	summary: "List a result's attachments, or read one as base64 with its file name and safe content type.",
	needs: "read",
	scope: "project",
	effect: "read",
	mcp: null,
	async run(ctx, input) {
		await mustResult(ctx, input.result);
		return input.id === undefined
			? { kind: "list" as const, items: await attachmentsOf(ctx.db, input.result) }
			: await attachmentContent(ctx, input.result, input.id);
	},
});
