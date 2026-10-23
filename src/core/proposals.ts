// Proposal inputs shared by draft storage, the server and the CLI.
import { z } from "zod";
import { projectCommand } from "./commands.ts";
import { QuarantineExit } from "./flaky.ts";
import { Clause, PolicySettings, Unlinked } from "./kinds.ts";
import { CaseBody, CaseKind, EDIT_MAX } from "./model.ts";
import {
	flag as schemaFlag,
	nullableText as schemaNullableText,
	optionalFlag as schemaOptionalFlag,
	optionalText as schemaOptionalText,
	optionalTexts as schemaOptionalTexts,
	text as schemaText,
	texts as schemaTexts,
	whole as schemaWhole,
} from "./schema.ts";
import { FolderRef } from "./selection.ts";

const ref = (what: string) => schemaText.describe(what);

const TagChange = z.object({
	set: schemaOptionalTexts,
	add: schemaOptionalTexts,
	remove: schemaOptionalTexts,
});

export const CaseAlias = z
	.string()
	.trim()
	.regex(/^(?![CQRTP]-)(?!\d+$)[a-z0-9][a-z0-9_.:/-]{0,119}$/i);

export const QuarantineEdit = z
	.object({
		op: z.literal("quarantine"),
		test: schemaText.regex(/^T-\d+$/),
		base: schemaWhole.positive().nullable(),
		exit: QuarantineExit.nullable(),
	})
	.meta({ "x-mcp-hidden": true });
export const Edit = z.discriminatedUnion("op", [
	QuarantineEdit,
	z
		.object({
			op: z.literal("fragment"),
			fragment: schemaText,
			from: schemaWhole.positive(),
			to: schemaWhole.positive(),
			cases: z
				.array(z.object({ case: schemaText, base: schemaWhole.positive() }))
				.min(1)
				.max(5000),
		})
		.meta({ "x-mcp-hidden": true }),
	z.object({
		op: z.literal("create"),
		kind: CaseKind.optional().meta({ "x-mcp-hidden": true }),
		/** The case as structured content, as canonical Markdown, or as free text in the capture outline. */
		body: CaseBody.partial().optional(),
		md: schemaOptionalText,
		outline: schemaOptionalText,
		folder: FolderRef.optional(),
		tags: schemaOptionalTexts,
		covers: schemaOptionalTexts,
		aliases: schemaTexts.max(20).optional(),
		/** Place the new case after this case (a ref); the end of the folder when absent. */
		after: schemaOptionalText,
	}),
	z.object({
		op: z.literal("edit"),
		case: ref("The case, for example C-311."),
		base: z
			.number()
			.int()
			.describe("The version this edit was made on. A stale base is merged or reported, never overwritten."),
		body: CaseBody.partial().optional(),
		md: schemaOptionalText,
	}),
	z.object({
		op: z.literal("place"),
		cases: schemaTexts.min(1),
		folder: FolderRef.optional(),
		after: schemaNullableText.optional(),
		tags: TagChange.optional(),
	}),
	z.object({ op: z.literal("state"), cases: schemaTexts.min(1), to: z.enum(["active", "archived"]) }),
	z.object({
		op: z.literal("restore"),
		case: ref("The case."),
		to: schemaWhole.describe("The version to restore."),
	}),
	z.object({
		op: z.literal("folder"),
		folder: FolderRef.optional().describe("The folder to change. Absent when creating one."),
		name: schemaText.min(1).max(120).optional(),
		parent: FolderRef.nullable().optional(),
		archive: schemaOptionalFlag,
	}),
	z.object({
		op: z.literal("cover"),
		case: ref("The case."),
		requirement: schemaText,
		on: schemaFlag,
		title: schemaOptionalText,
	}),
	z.object({
		op: z.literal("policy"),
		base: schemaWhole.positive().optional().describe("Required with clauses or settings."),
		preset: schemaOptionalText,
		clauses: z.array(Clause).optional(),
		settings: PolicySettings.optional(),
		/** What happens to a test with no case, changed without replacing the other settings. */
		unlinked: Unlinked.optional(),
		emptyReports: PolicySettings.shape.emptyReports.removeDefault().optional(),
	}),
]);
export type Edit = z.infer<typeof Edit>;

export const ProposeInput = z.object({
	edits: z.array(Edit).min(1).max(EDIT_MAX),
	reason: schemaText.max(500).optional().describe("Why. Shown in the case history."),
	...projectCommand,
});
export type ProposeInput = z.infer<typeof ProposeInput>;
