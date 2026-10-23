import { z } from "zod";
import { CaseBody, ExpandedStep, MethodKind } from "../../core/model.ts";
import { ResultLocation, ResultTrail } from "../../core/results.ts";
import { Obligation, ShardWait, SlotState, SlotWork, Tally, TargetMatch, Verdict } from "../../core/runs.ts";
import {
	nullableNumber as schemaNullableNumber,
	nullableText as schemaNullableText,
	number as schemaNumber,
	text as schemaText,
	texts as schemaTexts,
} from "../../core/schema.ts";

export const Run = z.object({
	location: ResultLocation.nullable(),
	ref: schemaText,
	name: schemaText,
	origin: z.enum(["planned", "change"]),
	state: z.enum(["open", "closed"]),
	verdict: Verdict,
	reason: schemaText,
	/** Of a change run: the jobs that reported in shards and are missing some. */
	waiting: z.array(ShardWait).optional(),
	tally: Tally,
	accepts: TargetMatch,
	require: z.array(Obligation),
	slots: schemaNullableNumber,
	inProgress: schemaNumber,
	workUntil: schemaNullableNumber,
	/** Of a change run: how many of its tests both passed and failed on its commit. A planned run has none. */
	flips: schemaNullableNumber,
	/** The change a change run's commit belongs to. A planned run has none. */
	change: z.object({ key: schemaText, title: schemaNullableText }).nullable(),
	createdAt: schemaNumber,
	createdBy: schemaText,
	open: schemaTexts,
});
export type Run = z.infer<typeof Run>;
export const Fill = z.object({
	model: schemaNullableText,
	result: schemaNumber,
	by: schemaText,
	method: MethodKind,
	outcome: z.enum(["pass", "fail", "skip", "blocked", "error"]),
	admitted: schemaText,
	at: schemaNumber,
	note: schemaNullableText,
	atStep: schemaNullableText,
	steps: ResultTrail.nullable(),
});
export type Fill = z.infer<typeof Fill>;
export const Slot = z.object({
	id: schemaNumber,
	case: schemaText,
	title: schemaText,
	version: schemaNumber,
	head: schemaNumber,
	state: SlotState,
	rank: schemaNumber,
	assignee: schemaNullableText,
	work: SlotWork,
	fills: z.array(Fill),
});
export type Slot = z.infer<typeof Slot>;
export const RunCase = CaseBody.extend({
	steps: z.array(ExpandedStep),
	fields: z.record(schemaText, schemaText).default({}),
	ref: schemaText,
	version: schemaNumber,
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
