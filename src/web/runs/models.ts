import { z } from "zod";
import { CaseBody, MethodKind } from "../../core/model.ts";
import { Obligation, SlotState, Tally, TargetMatch, Verdict } from "../../core/runs.ts";

export const Run = z.object({
	ref: z.string(),
	name: z.string(),
	origin: z.enum(["planned", "change"]),
	state: z.enum(["open", "closed"]),
	verdict: Verdict,
	reason: z.string(),
	tally: Tally,
	accepts: TargetMatch,
	require: z.array(Obligation),
	slots: z.number().nullable(),
	createdAt: z.number(),
	createdBy: z.string(),
	open: z.array(z.string()),
});
export type Run = z.infer<typeof Run>;
export const Fill = z.object({
	result: z.number(),
	by: z.string(),
	method: MethodKind,
	outcome: z.enum(["pass", "fail", "skip", "blocked", "error"]),
	admitted: z.string(),
	at: z.number(),
	note: z.string().nullable(),
});
export type Fill = z.infer<typeof Fill>;
export const Slot = z.object({
	id: z.number(),
	case: z.string(),
	title: z.string(),
	version: z.number(),
	head: z.number(),
	state: SlotState,
	rank: z.number(),
	assignee: z.string().nullable(),
	fills: z.array(Fill),
});
export type Slot = z.infer<typeof Slot>;
export const RunCase = CaseBody.extend({
	fields: z.record(z.string(), z.string()).default({}),
	ref: z.string(),
	version: z.number(),
});
export type RunCase = z.infer<typeof RunCase>;
export const outcomeName = { pass: "Pass", fail: "Fail", blocked: "Blocked", skip: "Skip" };
export type RunOutcome = keyof typeof outcomeName;

export function tallyText(tally: Run["tally"]): string {
	return Object.entries(tally)
		.filter(([, count]) => count > 0)
		.map(
			([name, count]) =>
				`${count} ${name === "unexplained" ? "unexplained failures" : name === "attributed" ? "attributed failures" : name}`,
		)
		.join(" · ");
}
