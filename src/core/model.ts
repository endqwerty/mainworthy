// The case document: the part of the model that the browser and the server both compute on.
// Types are inferred from the schemas; a value that parsed here is trusted everywhere inside.
import { z } from "zod";

export const MethodKind = z.enum(["human", "auto", "agent"]);
export type MethodKind = z.infer<typeof MethodKind>;

/** A step id is short, unique within its case and never reused, so results, diffs and findings can anchor to it. */
export const StepId = z.string().regex(/^[a-z0-9]{2,8}$/);
export type StepId = z.infer<typeof StepId>;

export const Step = z.object({
	id: StepId,
	/** What to do. One or more lines of plain text; never empty. */
	action: z.string().min(1),
	/** What must be true afterwards. `null` when the author has not said. */
	expected: z.string().min(1).nullable(),
});
export type Step = z.infer<typeof Step>;

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
	/** Custom field values. Reserved; always empty in the MVP. */
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
/** A requirement key as typed inline after `@`: `WEB-290`, `REQ-17`. */
export const REQUIREMENT_KEY = /^[A-Za-z][A-Za-z0-9]{0,15}-[0-9]{1,9}$/;
