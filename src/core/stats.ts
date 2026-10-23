// The reports (decision 0095): what the stream of results says over a window of days. One operation, `stats`,
// answers each; `of` names which, and each has its own reply.

import { z } from "zod";
import { isZone } from "./days.ts";
import { MethodKind } from "./model.ts";

const days = z.number().int().min(1).max(90).default(30).describe("How many days to read, today included: 1 to 90.");
const cursor = z
	.number()
	.int()
	.min(0)
	.max(Number.MAX_SAFE_INTEGER)
	.default(0)
	.describe("The cursor from the previous page, or 0 for the first page.");
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
		cursor,
	}),
	z.object({
		of: z
			.literal("reruns")
			.describe("Repeated pipeline attempts and earlier runner tries, with their time counted once."),
		days,
		limit: top,
		cursor,
	}),
	z.object({
		of: z.literal("automation").describe("How many cases have an automated test, and which to automate next."),
		days,
		limit: top,
		cursor,
	}),
	z.object({
		of: z.literal("coverage").describe("Each requirement's cases, by the latest result of their tests."),
		days,
		limit: z.number().int().min(1).max(500).default(100).describe("How many requirements to list."),
		cursor,
	}),
]);
export type StatsInput = z.infer<typeof StatsInput>;
export type StatsKind = StatsInput["of"];

export {
	AutomationReply,
	CoverageReply,
	FlakyReply,
	OutcomeCounts,
	PassRateReply,
	RerunsReply,
	type StatsOf,
	StatsReply,
} from "./stats-replies.ts";
