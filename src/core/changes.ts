// A gate read when a merge was reported, kept independently of later evidence and scope changes.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { z } from "zod";
import { MethodKind } from "./model.ts";
import { GateStatus, RESULT_STANDINGS } from "./runs.ts";
import {
	flag as schemaFlag,
	nullableText as schemaNullableText,
	nullableWhole as schemaNullableWhole,
	text as schemaText,
	whole as schemaWhole,
} from "./schema.ts";

export const ArtifactCode = z
	.array(
		z.object({
			repo: schemaText.trim().min(1).max(200),
			commit: schemaText.regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "use a full lowercase commit hash"),
		}),
	)
	.min(1)
	.max(100);

export const MergeReceipt = z.object({
	id: schemaWhole,
	head: schemaNullableText,
	at: schemaWhole,
	by: schemaWhole,
	policy: schemaWhole,
	gate: GateStatus.omit({ open: true, waiting: true }),
	snapshot: schemaText.regex(/^[a-f0-9]{64}$/),
	count: schemaWhole.nonnegative(),
	evidenceCount: schemaWhole.nonnegative(),
	openCount: schemaWhole.nonnegative(),
	waitingCount: schemaWhole.nonnegative(),
});
export type MergeReceipt = z.infer<typeof MergeReceipt>;

export const MergeReceiptResult = z.object({
	result: schemaWhole,
	test: schemaText,
	name: schemaText,
	file: schemaNullableText,
	target: schemaWhole,
	outcome: schemaText,
	method: MethodKind,
	job: schemaText,
	env: schemaText,
	standing: z.enum(RESULT_STANDINGS),
	scope: schemaText,
	flipped: schemaFlag,
	quarantined: schemaFlag,
	decision: schemaNullableWhole,
	decisionAnswer: schemaNullableText,
});
export type MergeReceiptResult = z.infer<typeof MergeReceiptResult>;

/** Versioned canonical radix-32 nodes. Counts authenticate rank-based pagination; ids never enter the digest. */
export function receiptNodeHash(
	level: number,
	entries: readonly { slot: number; hash: string; count: number }[],
): string {
	return bytesToHex(
		sha256(
			utf8ToBytes(
				JSON.stringify(["mainworthy.receipt.node.v2", level, entries.map((row) => [row.slot, row.hash, row.count])]),
			),
		),
	);
}
export function receiptSnapshotHash(results: string | null, gate: string | null): string {
	return bytesToHex(sha256(utf8ToBytes(JSON.stringify(["mainworthy.receipt.snapshot.v2", results, gate]))));
}
