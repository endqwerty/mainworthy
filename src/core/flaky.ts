import { z } from "zod";
import { ResultLocation } from "./results.ts";
import { flag as schemaFlag, number as schemaNumber, text as schemaText, whole as schemaWhole } from "./schema.ts";

export const FlakyDetectionSettings = z
	.object({
		enabled: schemaFlag,
		windowDays: schemaWhole.min(1).max(365),
		minFlips: schemaWhole.min(1).max(100),
	})
	.default({ enabled: true, windowDays: 14, minFlips: 2 });
export type FlakyDetectionSettings = z.infer<typeof FlakyDetectionSettings>;

/** One end of a flip: a result, or the runner's try `try` of it (decision 0129). */
const Observation = z.object({
	id: schemaNumber,
	outcome: z.enum(["pass", "fail", "error"]),
	attempt: schemaNumber,
	try: schemaNumber.optional(),
});
export const SameCodeEvidence = z.object({
	...FlakyDetectionSettings.removeDefault().shape,
	signals: z.array(
		z.object({
			signature: z.object({ id: schemaNumber, text: schemaText }),
			class: z.enum(["assertion", "timeout", "infra"]),
			flips: schemaNumber,
			suggested: schemaFlag,
			samples: z.array(
				z.object({
					commit: schemaText,
					location: ResultLocation.optional(),
					env: schemaText,
					job: schemaText,
					actor: schemaNumber,
					first: Observation,
					second: Observation,
				}),
			),
		}),
	),
});
export type SameCodeEvidence = z.infer<typeof SameCodeEvidence>;

export const QuarantineExit = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("person") }),
	z.object({ kind: z.literal("expiry"), at: schemaWhole.nonnegative().max(8_640_000_000_000_000) }),
	z.object({ kind: z.literal("passes"), count: schemaWhole.min(1).max(100) }),
]);
export type QuarantineExit = z.infer<typeof QuarantineExit>;
export const Quarantine = z.object({
	decision: schemaWhole,
	reason: schemaText,
	by: schemaText,
	since: schemaNumber,
	exit: QuarantineExit.nullable(),
	active: schemaFlag,
});
export type Quarantine = z.infer<typeof Quarantine>;
