// The reports (decision 0094): what the stream of results says over a window of days. One operation, `stats`,
// answers each; `of` names which, and each has its own reply.

import { z } from "zod";
import { isZone } from "./days.ts";
import { Automate, MethodKind } from "./model.ts";

const days = z.number().int().min(1).max(90).default(30).describe("How many days to read, today included: 1 to 90.");
const top = z.number().int().min(1).max(200).default(20).describe("How many rows to list.");

export const StatsInput = z.discriminatedUnion("of", [
	z.object({
		of: z.literal("pass-rate").describe("Per day: the results that passed, failed, were skipped or blocked."),
		days,
		zone: z
			.string()
			.max(64)
			.refine(isZone, "not a time zone: write a name such as Europe/Berlin or UTC, not an offset")
			.default("UTC")
			.describe("Whose days: a time zone such as Europe/Berlin."),
		method: MethodKind.optional().describe("Only one producer's results: human, auto or agent."),
	}),
	z.object({
		of: z.literal("flaky").describe("The tests that passed and failed on the same code, most often first."),
		days,
		limit: top,
	}),
	z.object({
		of: z.literal("reruns").describe("The attempts that were run again, and the time they took."),
		days,
		limit: top,
	}),
	z.object({
		of: z.literal("automation").describe("How many cases have an automated test, and which to automate next."),
		days,
		limit: top,
	}),
	z.object({
		of: z.literal("coverage").describe("Each requirement's cases, by the latest result of their tests."),
		days,
		limit: z.number().int().min(1).max(500).default(100).describe("How many requirements to list."),
	}),
]);
export type StatsInput = z.infer<typeof StatsInput>;
export type StatsKind = StatsInput["of"];

const whole = z.number().int().min(0);
/** Passes over passes and failures; null when nothing passed or failed. */
const rate = z.number().min(0).max(1).nullable();

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
	test: z.string(),
	name: z.string(),
	file: z.string().nullable(),
	case: z.string().nullable(),
});

export const PassRateReply = z.object({
	of: z.literal("pass-rate"),
	zone: z.string(),
	method: MethodKind.nullable(),
	days: z.array(OutcomeCounts.extend({ day: z.string() })),
	total: OutcomeCounts,
});
export const FlakyReply = z.object({
	of: z.literal("flaky"),
	/** Automated tests with a result in the window. */
	tests: whole,
	/** Of those, the tests with a flip in the window. */
	flaky: whole,
	items: z.array(TestRow.extend({ flips: whole, lastAt: z.number(), quarantined: z.boolean() })),
});
export const RerunsReply = z.object({
	of: z.literal("reruns"),
	reruns: whole,
	lostMs: whole,
	/** Attempts that were run again and reported no duration: their time is not in `lostMs`. */
	unknown: whole,
	items: z.array(TestRow.extend({ reruns: whole, lostMs: whole })),
});
export const AutomationReply = z.object({
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
			case: z.string(),
			title: z.string(),
			automate: Automate.exclude(["not-applicable"]),
			/** Results recorded by a person in the window. */
			runs: whole,
			/** Their time, where they said it; null when none did. */
			timeMs: whole.nullable(),
		}),
	),
});
export const CoverageReply = z.object({
	of: z.literal("coverage"),
	requirements: whole,
	/** Requirements with at least one active case. */
	covered: whole,
	items: z.array(
		z.object({
			key: z.string(),
			title: z.string(),
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
