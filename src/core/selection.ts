// Case selections and the input contracts that preview or plan them.
import { z } from "zod";
import { projectCommand } from "./commands.ts";
import { MAX_OBLIGATIONS, Obligation, TargetMatch } from "./runs.ts";
import {
	optionalFlag as schemaOptionalFlag,
	optionalText as schemaOptionalText,
	optionalTexts as schemaOptionalTexts,
	text as schemaText,
	whole as schemaWhole,
} from "./schema.ts";

/** A folder by id, or by path (`checkout/coupons`); a path that does not exist yet is created by the edit. */
export const FolderRef = z.union([schemaWhole, schemaText.max(400)]);

export const limit = schemaWhole.min(1).max(500).optional();
export const cursor = schemaOptionalText.describe("The cursor from the previous page.");

export const Selection = z.object({
	cases: schemaOptionalTexts,
	folders: z.array(FolderRef).optional(),
	tags: schemaOptionalTexts,
	text: schemaOptionalText,
});
export type Selection = z.infer<typeof Selection>;

export const PlanInput = z.object({
	name: schemaText.min(1).max(200),
	select: Selection,
	accepts: TargetMatch.optional().describe("Which results count. Default: only results recorded in this run."),
	require: z.array(Obligation).max(MAX_OBLIGATIONS).optional(),
	assign: schemaOptionalTexts.describe("Actor names to split the slots between."),
	...projectCommand,
});
export type PlanInput = z.infer<typeof PlanInput>;

export const FindInput = z.object({
	receipt: schemaWhole.positive().optional().describe("For receipt-results: merge receipt id."),
	in: z
		.union([
			z.enum(["cases", "tests", "runs", "folders", "tags", "requirements", "slots", "changes", "receipt-results"]),
			// Deployments and results are listed for CLI and HTTP; MCP's find keeps its earlier choices, whose
			// tools/list is at its token budget (src/surfaces/mcp.ts).
			z.literal("deployments").meta({ "x-mcp-hidden": true }),
			z.literal("results").meta({ "x-mcp-hidden": true }),
		])
		.default("cases"),
	select: Selection.optional()
		.describe("For cases: preview a run selection instead of the listing filters. Excludes fragments.")
		.meta({ "x-mcp-hidden": true }),
	text: schemaText.max(200).optional(),
	folder: FolderRef.optional(),
	deep: schemaOptionalFlag.describe("With `folder`: include its subfolders."),
	tags: schemaOptionalTexts,
	state: schemaOptionalText,
	origin: z
		.enum(["planned", "change"])
		.optional()
		.describe("For runs: planned by hand, or one per reported commit.")
		.meta({ "x-mcp-hidden": true }),
	run: schemaOptionalText.describe("For slots: the run."),
	commit: schemaOptionalText.describe("For results: the commit.").meta({ "x-mcp-hidden": true }),
	change: schemaOptionalText.describe("For results and runs: a change key (pr:482).").meta({ "x-mcp-hidden": true }),
	repo: schemaOptionalText.meta({ "x-mcp-hidden": true }),
	unlinked: schemaOptionalFlag.describe("For tests: only those with no case."),
	limit,
	cursor,
});
export type FindInput = z.infer<typeof FindInput>;
