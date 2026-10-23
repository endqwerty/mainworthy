// Report replies shared by the browser and server.
import { z } from "zod";
import { Automate, MethodKind } from "./model.ts";
import {
	flag as schemaFlag,
	nullableText as schemaNullableText,
	number as schemaNumber,
	text as schemaText,
	whole as schemaWhole,
} from "./schema.ts";
import type { StatsKind } from "./stats.ts";

const whole = schemaWhole.min(0);
const page = {
	total: whole.describe("All rows matching this report, before paging."),
	cursor: whole.nullable().describe("The next page, or null when there are no more rows."),
};
/** Passes over passes and failures; null when nothing passed or failed. */
const rate = schemaNumber.min(0).max(1).nullable();

/** What a day's results were. A quarantined test's failure is `quarantined`, not `fail`; skips and blocks are not in the rate. */
export const OutcomeCounts = z.object({
	pass: whole,
	fail: whole,
	skip: whole,
	blocked: whole,
	quarantined: whole,
	rate,
});
export type OutcomeCounts = z.infer<typeof OutcomeCounts>;

const TestRow = z.object({
	test: schemaText,
	name: schemaText,
	file: schemaNullableText,
	case: schemaNullableText,
});

export const PassRateReply = z.object({
	of: z.literal("pass-rate"),
	zone: schemaText,
	method: MethodKind.nullable(),
	days: z.array(OutcomeCounts.extend({ day: schemaText })),
	total: OutcomeCounts,
});
export const FlakyReply = z.object({
	...page,
	of: z.literal("flaky"),
	/** Automated tests with a result in the window. */
	tests: whole,
	/** Of those, the tests with a flip in the window. */
	flaky: whole,
	items: z.array(TestRow.extend({ flips: whole, lastAt: schemaNumber, quarantined: schemaFlag })),
});
export const RerunsReply = z.object({
	...page,
	of: z.literal("reruns"),
	reruns: whole,
	lostMs: whole,
	/** Counted executions whose time is not covered by a reported duration. */
	unknown: whole,
	items: z.array(TestRow.extend({ reruns: whole, lostMs: whole })),
});
export const AutomationReply = z.object({
	...page,
	of: z.literal("automation"),
	/** Active cases. */
	cases: whole,
	/** Active cases with at least one automated test. */
	automated: whole,
	/** The rest, by what each says about automating it. */
	manual: z.object({ wanted: whole, none: whole, notApplicable: whole }),
	/** Automated over the cases that can be automated; null when there are none. */
	rate,
	backlog: z.array(
		z.object({
			case: schemaText,
			title: schemaText,
			automate: Automate.exclude(["not-applicable"]),
			/** Results recorded by a person in the window. */
			runs: whole,
			/** Their time, where they said it; null when none did. */
			timeMs: whole.nullable(),
		}),
	),
});
export const CoverageReply = z.object({
	...page,
	of: z.literal("coverage"),
	requirements: whole,
	/** Requirements with at least one active case. */
	covered: whole,
	items: z.array(
		z.object({
			key: schemaText,
			title: schemaText,
			cases: whole,
			passed: whole,
			failed: whole,
			/** Cases whose tests' latest results were only skips or blocks. */
			other: whole,
			notRun: whole,
		}),
	),
});
export const StatsReply = z.discriminatedUnion("of", [
	PassRateReply,
	FlakyReply,
	RerunsReply,
	AutomationReply,
	CoverageReply,
]);
export type StatsReply = z.infer<typeof StatsReply>;
export type StatsOf<K extends StatsKind> = Extract<StatsReply, { of: K }>;
