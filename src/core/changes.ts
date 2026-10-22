// A gate read when a merge was reported, kept independently of later evidence and scope changes.
import { z } from "zod";
import { MethodKind } from "./model.ts";
import { GateStatus } from "./ops.ts";
import { RESULT_STANDINGS } from "./runs.ts";

export const MergeReceipt = z.object({
	id: z.number().int(),
	head: z.string().nullable(),
	at: z.number().int(),
	by: z.number().int(),
	policy: z.number().int(),
	gate: GateStatus.omit({ open: true, waiting: true }),
	snapshot: z.string().regex(/^[a-f0-9]{64}$/),
	count: z.number().int().nonnegative(),
	evidenceCount: z.number().int().nonnegative(),
	openCount: z.number().int().nonnegative(),
	waitingCount: z.number().int().nonnegative(),
});
export type MergeReceipt = z.infer<typeof MergeReceipt>;

export const MergeReceiptResult = z.object({
	result: z.number().int(),
	test: z.string(),
	name: z.string(),
	file: z.string().nullable(),
	target: z.number().int(),
	outcome: z.string(),
	method: MethodKind,
	job: z.string(),
	env: z.string(),
	standing: z.enum(RESULT_STANDINGS),
	scope: z.string(),
	flipped: z.boolean(),
	quarantined: z.boolean(),
	decision: z.number().int().nullable(),
	decisionAnswer: z.string().nullable(),
});
export type MergeReceiptResult = z.infer<typeof MergeReceiptResult>;
