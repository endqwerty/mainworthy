// A gate read when a merge was reported, kept independently of later evidence and scope changes.
import { z } from "zod";
import { Kind } from "./kinds.ts";
import { MethodKind } from "./model.ts";
import { GateStatus } from "./ops.ts";
import { RESULT_STANDINGS } from "./runs.ts";

export const MergeReceipt = z.object({
	id: z.number().int(),
	head: z.string().nullable(),
	at: z.number().int(),
	by: z.number().int(),
	policy: z.number().int(),
	gate: GateStatus,
	results: z.array(
		z.object({
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
		}),
	),
	decisions: z.array(
		z.object({
			id: z.number().int(),
			kind: Kind,
			answer: z.looseObject({ is: z.string() }),
			basis: z.string(),
			evidence: z.string().nullable(),
			signers: z.array(
				z.object({ by: z.number().int(), clause: z.string(), policy: z.number().int(), reason: z.string().nullable() }),
			),
			holds: z.array(z.unknown()),
			expiresAt: z.number().nullable(),
			at: z.number().int(),
		}),
	),
});
export type MergeReceipt = z.infer<typeof MergeReceipt>;
