import { z } from "zod";
import { CaseBody, ExpandedStep, MethodKind } from "../../core/model.ts";
import { ResultLocation } from "../../core/ops.ts";
import { ResultTrail } from "../../core/results.ts";
import { Obligation, SlotState, SlotWork, Tally, TargetMatch, Verdict } from "../../core/runs.ts";

export const Run = z.object({
	location: ResultLocation.nullable(),
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
	inProgress: z.number(),
	workUntil: z.number().nullable(),
	/** Of a change run: how many of its tests both passed and failed on its commit. A planned run has none. */
	flips: z.number().nullable(),
	/** The change a change run's commit belongs to. A planned run has none. */
	change: z.object({ key: z.string(), title: z.string().nullable() }).nullable(),
	createdAt: z.number(),
	createdBy: z.string(),
	open: z.array(z.string()),
});
export type Run = z.infer<typeof Run>;
export const Fill = z.object({
	model: z.string().nullable(),
	result: z.number(),
	by: z.string(),
	method: MethodKind,
	outcome: z.enum(["pass", "fail", "skip", "blocked", "error"]),
	admitted: z.string(),
	at: z.number(),
	note: z.string().nullable(),
	atStep: z.string().nullable(),
	steps: ResultTrail.nullable(),
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
	work: SlotWork,
	fills: z.array(Fill),
});
export type Slot = z.infer<typeof Slot>;
export const RunCase = CaseBody.extend({
	steps: z.array(ExpandedStep),
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
				`${count} ${name === "unexplained" || name === "attributed" ? `${name} failure${count === 1 ? "" : "s"}` : name}`,
		)
		.join(" · ");
}
