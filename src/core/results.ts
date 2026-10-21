import { z } from "zod";

/** The server's recorded developer-facing identity for a tested target. */
export const ResultLocation = z.object({
	label: z.string(),
	commit: z.string().nullable(),
	change: z.string().nullable(),
});
export type ResultLocation = z.infer<typeof ResultLocation>;

export const Outcome = z.enum(["pass", "fail", "skip", "blocked", "error"]);
export type Outcome = z.infer<typeof Outcome>;
export const TRAIL_LIMITS = {
	steps: 100,
	actions: 100,
	stepText: 160,
	actionText: 2000,
	resultBytes: 65_536,
	reportBytes: 1_048_576,
} as const;
const milliseconds = z.number().int().min(0);
export const ResultAction = z.object({
	text: z.string().min(1).max(TRAIL_LIMITS.actionText, "Limit: 2000 characters per action"),
	outcome: Outcome.optional(),
	durationMs: milliseconds.optional(),
});
export const ResultStep = z.object({
	step: z
		.string()
		.min(1)
		.max(TRAIL_LIMITS.stepText, "Limit: 160 characters per step")
		.describe("Case step ID or runner label."),
	outcome: Outcome,
	durationMs: milliseconds.optional(),
	actions: z.array(ResultAction).max(TRAIL_LIMITS.actions, "Limit: 100 actions per step").optional(),
	attachment: z.number().int().min(0).optional().describe("Screenshot's zero-based attachment index."),
});
export type ResultStep = z.infer<typeof ResultStep>;
export const ResultTrail = z.array(ResultStep).max(TRAIL_LIMITS.steps, "Limit: 100 steps per result");
export const trailBytes = (steps: readonly ResultStep[]): number =>
	new TextEncoder().encode(JSON.stringify(steps)).length;
export const failedStep = (steps: readonly ResultStep[]): string | null =>
	steps.find((step) => step.outcome === "fail" || step.outcome === "error")?.step ?? null;
/** Missing or zero durations do not imply that a step was slow. Equal durations share a tint. */
export function stepHeat(steps: readonly ResultStep[], step: ResultStep): number {
	const maximum = Math.max(0, ...steps.map((item) => item.durationMs ?? 0));
	return maximum > 0 && step.durationMs !== undefined ? step.durationMs / maximum : 0;
}
