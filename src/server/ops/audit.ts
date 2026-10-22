import { z } from "zod";
import { AuditInput, type AuditRecord, compareAuditRecords, encodeAudit } from "../../core/audit.ts";
import { REPLIES } from "../../core/replies.ts";
import { mergeReceiptById, mergeReceiptPage } from "../decisions/questions.ts";
import type { Ctx } from "../kernel/ctx.ts";
import { invalid } from "../kernel/errors.ts";
import { exportAudit } from "../transfer/audit.ts";
import { defineOp } from "./registry.ts";

export const auditOp = defineOp({
	name: "audit",
	summary:
		"Export a project's retained decisions, answers, policy changes and case versions as a verifiable audit file.",
	input: AuditInput,
	output: REPLIES.audit,
	needs: "admin",
	scope: "project",
	effect: "read",
	mcp: null,
	run: (ctx, input) => (input.receipt === undefined ? exportAudit(ctx, input) : exportReceiptAudit(ctx, input)),
});

function exportReceiptAudit(ctx: Ctx, input: AuditInput) {
	const to = input.to ?? ctx.now + 1;
	if (to > ctx.now + 1 || to <= input.from)
		throw invalid("audit needs from < to <= the server's current time plus one millisecond");

	const receipt = mergeReceiptById(ctx.db, ctx.project.id, input.receipt ?? null);
	if (!receipt || receipt.at < input.from || receipt.at >= to)
		throw invalid("receipt is outside this project's selected audit range");
	const page = mergeReceiptPage(ctx.db, ctx.project.id, receipt.id, input.cursor, input.limit ?? 50, "evidence");
	const item = z.object({
		ordinal: z.number(),
		kind: z.enum(["result", "gate"]),
		hash: z.string(),
		body: z.string(),
	});
	const records: AuditRecord[] = page.items.map((raw) => {
		const row = item.parse(raw);
		return {
			type: "merge-evidence",
			id: `merge-evidence:${receipt.id}:${row.ordinal}`,
			at: receipt.at,
			seq: ctx.seq,
			receipt: receipt.id,
			...row,
		};
	});
	return {
		...encodeAudit(
			{
				mainworthy: "audit",
				format: 1,
				project: ctx.project.key,
				from: input.from,
				to,
				exportedAt: ctx.now,
				seq: ctx.seq,
				grantChanges: "team-history-only",
				teamState: "at-export",
				evidencePayloads: "not-retained",
				actorNames: "at-export",
			},
			records.sort(compareAuditRecords),
		),
		cursor: page.cursor,
		evidenceCount: receipt.evidenceCount,
		snapshot: receipt.snapshot,
	};
}
