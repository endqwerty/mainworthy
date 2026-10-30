// Proposal inputs shared by draft storage, the server and the CLI.
import { z } from "zod";
import { projectCommand } from "./commands.ts";
import { QuarantineExit } from "./flaky.ts";
import { ANSWER_HELP, Clause, PolicySettings, Unlinked } from "./kinds.ts";
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
export const PlaceEdit = z.object({
	op: z.literal("place"),
	cases: schemaTexts.min(1),
	folder: FolderRef.optional(),
	after: schemaNullableText.optional(),
	/** Restore the exact ordering key returned by a placement inverse. Mutually exclusive with after. */
	rank: schemaOptionalText,
	tags: TagChange.optional(),
});
export const StateEdit = z.object({
	op: z.literal("state"),
	cases: schemaTexts.min(1),
	to: z.enum(["active", "archived"]),
});
export const PlacementEdit = z.discriminatedUnion("op", [PlaceEdit, StateEdit]);
export type PlacementEdit = z.infer<typeof PlacementEdit>;

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
	PlaceEdit,
	StateEdit,
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

export const ProposalTally = z.object({
	create: z.number().optional(),
	edit: z.number().optional(),
	restore: z.number().optional(),
	place: z.number().optional(),
	state: z.number().optional(),
	folder: z.number().optional(),
	cover: z.number().optional(),
	policy: z.number().optional(),
	quarantine: z.number().optional(),
});
export type ProposalTally = z.infer<typeof ProposalTally>;
const proposalParts = {
	create: "new case",
	edit: "case edit",
	restore: "restore",
	place: "placement change",
	state: "archive change",
	folder: "folder change",
	cover: "coverage change",
	policy: "policy change",
	quarantine: "quarantine change",
} satisfies Record<keyof ProposalTally, string>;
/** How many operations a proposal holds, whatever their kinds. */
export const proposalSize = (tally: ProposalTally): number =>
	Object.values(tally).reduce<number>((sum, n) => sum + (n ?? 0), 0);
/** Counts a proposal's operations by kind: every one of them, not the shortened summary its question stores. */
export function proposalTally(edits: readonly { op: keyof ProposalTally }[]): ProposalTally {
	const tally: ProposalTally = {};
	for (const edit of edits) tally[edit.op] = (tally[edit.op] ?? 0) + 1;
	return tally;
}
/** A proposal's title in the queue: the case for one body edit, the quarantine, else what it holds, counted. */
export function proposalTitle(
	tally: ProposalTally,
	first?: { op: string; title?: string | null; test?: string; exit?: unknown },
): string {
	const total = proposalSize(tally);
	if (first?.op === "quarantine") return `${first.exit === null ? "End quarantine" : "Quarantine"} ${first.test}`;
	if (total === 1) {
		if (tally.policy) return "Policy change";
		if (first?.title && (first.op === "create" || first.op === "edit" || first.op === "restore"))
			return `${first.op === "create" ? "New case" : first.op === "edit" ? "Edit" : "Restore"}: ${first.title}`;
	}
	return Object.entries(proposalParts)
		.flatMap(([op, label]) => {
			const n = tally[op as keyof ProposalTally] ?? 0;
			return n ? [`${n} ${label}${n === 1 ? "" : "s"}`] : [];
		})
		.join(" · ");
}
/** What the evidence of an adoption question says about its proposal: the whole tally, its facts, any quarantine. */
const AdoptEvidence = z.object({
	tally: ProposalTally.optional().catch(undefined),
	facts: z.array(z.string()).optional().catch(undefined),
	edits: z.array(z.unknown()).optional().catch(undefined),
});

/**
 * What accepting and rejecting a proposal does, said for its shape: one edit, new cases, many edits, the policy, a
 * quarantine or a mix. A question raised before the tally was stored keeps the one-edit sentences.
 */
export function adoptHelp(evidence: unknown): Readonly<Record<string, string>> {
	const { tally, facts, edits } = AdoptEvidence.parse(evidence ?? {});
	const help = (accept: string, reject: string) => ({
		...ANSWER_HELP.adopt,
		accept,
		reject: `${reject} The proposal stays in the history.`,
	});
	if (!tally) return ANSWER_HELP.adopt;
	if (facts?.includes("quarantine")) {
		const quarantine = edits?.find((edit) => z.object({ op: z.literal("quarantine") }).safeParse(edit).success);
		const ends = z.object({ exit: z.null() }).safeParse(quarantine).success;
		return help(ends ? "Ends the test's quarantine." : "Quarantines the test.", "Leaves the test as it is.");
	}
	const total = proposalSize(tally);
	if (total === 1 && (tally.edit || tally.restore)) return ANSWER_HELP.adopt;
	if (tally.create === total)
		return help(
			total === 1 ? "Adds this case to the suite." : `Adds all ${total} cases to the suite.`,
			total === 1 ? "Adds no case." : "Adds none of them.",
		);
	if (tally.edit === total)
		return help("Makes the proposed version of each case current.", "Leaves every case as it is.");
	if (tally.policy === total) return help("Puts the proposed policy in force.", "Leaves the policy as it is.");
	return help("Applies every change in it at once.", "Applies none of it.");
}
