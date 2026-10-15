// The case document: the part of the model that the browser and the server both compute on.
// Types are inferred from the schemas; a value that parsed here is trusted everywhere inside.
import { z } from "zod";

export const MethodKind = z.enum(["human", "auto", "agent"]);
export type MethodKind = z.infer<typeof MethodKind>;

/** A step id is short, unique within its case and never reused, so results, diffs and findings can anchor to it. */
export const StepId = z.string().regex(/^[a-z0-9]{2,8}$/);
export type StepId = z.infer<typeof StepId>;

export const CaseKind = z.enum(["case", "fragment"]);
export type CaseKind = z.infer<typeof CaseKind>;
export const FragmentPin = z.object({
	fragment: z.string().regex(/^C-[1-9]\d*$/),
	version: z.number().int().positive(),
});

export const InlineStep = z.object({
	id: StepId,
	/** What to do. One or more lines of plain text; never empty. */
	action: z.string().min(1),
	/** What must be true afterwards. `null` when the author has not said. */
	expected: z.string().min(1).nullable(),
});
export const FragmentStep = z
	.object({
		id: StepId,
		use: FragmentPin,
		action: z.string().length(0).default(""),
		expected: z
			.string()
			.nullable()
			.refine((value): boolean => value === null, "A fragment reference has no expected text")
			.default(null),
	})
	.meta({ "x-mcp-hidden": true });
export const Step = z.union([
	InlineStep.extend({ use: z.never().optional().meta({ "x-mcp-hidden": true }) }),
	FragmentStep,
]);
export type Step = z.infer<typeof Step>;
export const ExpandedStep = InlineStep.extend({
	id: z.string(),
	source: FragmentPin.extend({ step: StepId, use: StepId }).optional(),
});
export type ExpandedStep = z.infer<typeof ExpandedStep>;

export const Automate = z.enum(["none", "wanted", "not-applicable"]);
export type Automate = z.infer<typeof Automate>;

/** The versioned content of a case. Placement (folder, rank, tags) and links are not part of it. */
export const CaseBody = z.object({
	title: z.string(),
	/** Preconditions, free text. Empty string when there are none. */
	pre: z.string(),
	steps: z.array(Step),
	/** Who may produce evidence for this case. Never empty. */
	methods: z.array(MethodKind).min(1),
	automate: Automate,
	/** Custom field values, including keys without a project definition. */
	fields: z.record(z.string(), z.string()),
});
export type CaseBody = z.infer<typeof CaseBody>;

export const emptyBody = (title = ""): CaseBody => ({
	title,
	pre: "",
	steps: [],
	methods: ["human"],
	automate: "none",
	fields: {},
});

/** Everything the canonical Markdown form of a case carries: the body plus the header fields. */
export const CaseDoc = z.object({
	kind: CaseKind.optional(),
	/** `C-311`, or null for a case that has no ref yet (a file about to be imported). */
	ref: z.string().nullable(),
	body: CaseBody,
	tags: z.array(z.string()),
	/** Requirement keys this case covers, for example `WEB-290`. */
	covers: z.array(z.string()),
});
export type CaseDoc = z.infer<typeof CaseDoc>;

/** A tag is lower case, starts with a letter or digit, and may contain `-`, `_`, `.` and `/`. */
export const TAG = /^[a-z0-9][a-z0-9_./-]{0,39}$/;
/** Folder paths trim each segment and ignore empty segments; dot segments are literal names. */
export const cleanPath = (text: string): string[] =>
	text
		.replace(/\p{Cf}/gu, "")
		.normalize("NFC")
		.split("/")
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
export const cleanTag = (text: string): string =>
	text
		.replace(/\p{Cf}/gu, "")
		.normalize("NFC")
		.trim()
		.replace(/^#/, "")
		.toLowerCase()
		.normalize("NFC");
/** A requirement key as typed inline after `@`: `WEB-290`, `REQ-17`. */
export const REQUIREMENT_KEY = /^[A-Za-z][A-Za-z0-9]{0,15}-[0-9]{1,9}$/;

export const FieldDefinition = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("text"), label: z.string().trim().min(1).max(120), required: z.boolean() }),
	z.object({
		kind: z.literal("choice"),
		label: z.string().trim().min(1).max(120),
		required: z.boolean(),
		choices: z
			.array(
				z
					.string()
					.min(1)
					.max(200)
					.regex(/^[^\r\n]+$/, "Choices must fit on one line"),
			)
			.min(1)
			.max(100)
			.refine(
				(choices) => choices.every((choice) => choice.trim().length > 0) && new Set(choices).size === choices.length,
				"Choices must be nonblank and unique",
			),
	}),
]);
export const FieldDefinitions = z.record(z.string().min(1).max(80), FieldDefinition);
export type FieldDefinitions = z.infer<typeof FieldDefinitions>;

/** Undefined keys remain free text. An edit can keep unchanged values from its current stored head. */
export function fieldErrors(
	fields: CaseBody["fields"],
	definitions: FieldDefinitions,
	previous?: CaseBody["fields"],
): string[] {
	const errors: string[] = [];
	for (const [key, definition] of Object.entries(definitions)) {
		const value = Object.hasOwn(fields, key) ? fields[key] : undefined;
		if (previous !== undefined && value === (Object.hasOwn(previous, key) ? previous[key] : undefined)) continue;
		if (value === undefined || value.trim() === "") {
			if (definition.required) errors.push(`${key}: ${definition.label} is required`);
		} else if (definition.kind === "choice" && !definition.choices.includes(value)) {
			errors.push(`${key}: choose one of ${definition.choices.join(", ")}`);
		}
	}
	return errors;
}

export function stepAction(step: Step): string {
	return step.use ? `!use ${step.use.fragment}@v${step.use.version}` : step.action;
}
