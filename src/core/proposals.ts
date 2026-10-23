// Proposal inputs shared by draft storage, the server and the CLI.
import { z } from "zod";
import { projectCommand } from "./commands.ts";
import { QuarantineExit } from "./flaky.ts";
import { Clause, PolicySettings, Unlinked } from "./kinds.ts";
import { CaseBody, CaseKind } from "./model.ts";
import { FolderRef } from "./selection.ts";

const ref = (what: string) => z.string().describe(what);

const TagChange = z.object({
	set: z.array(z.string()).optional(),
	add: z.array(z.string()).optional(),
	remove: z.array(z.string()).optional(),
});

export const CaseAlias = z
	.string()
	.trim()
	.regex(/^(?![CQRTP]-)(?!\d+$)[a-z0-9][a-z0-9_.:/-]{0,119}$/i);

export const QuarantineEdit = z
	.object({
		op: z.literal("quarantine"),
		test: z.string().regex(/^T-\d+$/),
		base: z.number().int().positive().nullable(),
		exit: QuarantineExit.nullable(),
	})
	.meta({ "x-mcp-hidden": true });
export const Edit = z.discriminatedUnion("op", [
	QuarantineEdit,
	z
		.object({
			op: z.literal("fragment"),
			fragment: z.string(),
			from: z.number().int().positive(),
			to: z.number().int().positive(),
			cases: z
				.array(z.object({ case: z.string(), base: z.number().int().positive() }))
				.min(1)
				.max(5000),
		})
		.meta({ "x-mcp-hidden": true }),
	z.object({
		op: z.literal("create"),
		kind: CaseKind.optional().meta({ "x-mcp-hidden": true }),
		/** The case as structured content, as canonical Markdown, or as free text in the capture outline. */
		body: CaseBody.partial().optional(),
		md: z.string().optional(),
		outline: z.string().optional(),
		folder: FolderRef.optional(),
		tags: z.array(z.string()).optional(),
		covers: z.array(z.string()).optional(),
		aliases: z.array(z.string()).max(20).optional(),
		/** Place the new case after this case (a ref); the end of the folder when absent. */
		after: z.string().optional(),
	}),
	z.object({
		op: z.literal("edit"),
		case: ref("The case, for example C-311."),
		base: z
			.number()
			.int()
			.describe("The version this edit was made on. A stale base is merged or reported, never overwritten."),
		body: CaseBody.partial().optional(),
		md: z.string().optional(),
	}),
	z.object({
		op: z.literal("place"),
		cases: z.array(z.string()).min(1),
		folder: FolderRef.optional(),
		after: z.string().nullable().optional(),
		tags: TagChange.optional(),
	}),
	z.object({ op: z.literal("state"), cases: z.array(z.string()).min(1), to: z.enum(["active", "archived"]) }),
	z.object({
		op: z.literal("restore"),
		case: ref("The case."),
		to: z.number().int().describe("The version to restore."),
	}),
	z.object({
		op: z.literal("folder"),
		folder: FolderRef.optional().describe("The folder to change. Absent when creating one."),
		name: z.string().min(1).max(120).optional(),
		parent: FolderRef.nullable().optional(),
		archive: z.boolean().optional(),
	}),
	z.object({
		op: z.literal("cover"),
		case: ref("The case."),
		requirement: z.string(),
		on: z.boolean(),
		title: z.string().optional(),
	}),
	z.object({
		op: z.literal("policy"),
		base: z.number().int().positive().optional().describe("Required with clauses or settings."),
		preset: z.string().optional(),
		clauses: z.array(Clause).optional(),
		settings: PolicySettings.optional(),
		/** What happens to a test with no case, changed without replacing the other settings. */
		unlinked: Unlinked.optional(),
		emptyReports: PolicySettings.shape.emptyReports.removeDefault().optional(),
	}),
]);
export type Edit = z.infer<typeof Edit>;

export const ProposeInput = z.object({
	edits: z.array(Edit).min(1).max(5000),
	reason: z.string().max(500).optional().describe("Why. Shown in the case history."),
	...projectCommand,
});
export type ProposeInput = z.infer<typeof ProposeInput>;
