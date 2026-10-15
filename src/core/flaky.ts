import { z } from "zod";

export const FlakyDetectionSettings = z
	.object({
		enabled: z.boolean(),
		windowDays: z.number().int().min(1).max(365),
		minFlips: z.number().int().min(1).max(100),
	})
	.default({ enabled: true, windowDays: 14, minFlips: 2 });
export type FlakyDetectionSettings = z.infer<typeof FlakyDetectionSettings>;

const Observation = z.object({ id: z.number(), outcome: z.enum(["pass", "fail", "error"]), attempt: z.number() });
export const SameCodeEvidence = z.object({
	...FlakyDetectionSettings.removeDefault().shape,
	signals: z.array(
		z.object({
			signature: z.object({ id: z.number(), text: z.string() }),
			class: z.enum(["assertion", "timeout", "infra"]),
			flips: z.number(),
			suggested: z.boolean(),
			samples: z.array(
				z.object({
					commit: z.string(),
					env: z.string(),
					job: z.string(),
					actor: z.number(),
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
	z.object({ kind: z.literal("expiry"), at: z.number().int().nonnegative().max(8_640_000_000_000_000) }),
	z.object({ kind: z.literal("passes"), count: z.number().int().min(1).max(100) }),
]);
export type QuarantineExit = z.infer<typeof QuarantineExit>;
export const Quarantine = z.object({
	decision: z.number().int(),
	reason: z.string(),
	by: z.string(),
	since: z.number(),
	exit: QuarantineExit.nullable(),
	active: z.boolean(),
});
export type Quarantine = z.infer<typeof Quarantine>;
