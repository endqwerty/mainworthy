import { stripVTControlCharacters } from "node:util";
import { z } from "zod";
import { caseAnnotation } from "../../core/case-annotation.ts";
import type { Outcome } from "../../core/ops.ts";
import { ResultTrail, TRAIL_LIMITS } from "../../core/results.ts";
import { clip } from "../../core/text.ts";
import { nativeResult, type ParsedReport, reportIdentifier } from "./native.ts";

const ErrorInfo = z.object({ message: z.string().optional(), stack: z.string().optional() });
const RunnerStep = z.object({
	title: z.string(),
	duration: z.number().nonnegative(),
	error: ErrorInfo.optional(),
	steps: z.array(z.unknown()).max(TRAIL_LIMITS.actions, "Limit: 100 actions per step").optional(),
});
const Attempt = z.object({
	status: z.enum(["passed", "failed", "timedOut", "skipped", "interrupted"]),
	duration: z.number().nonnegative(),
	retry: z.number().int().nonnegative(),
	error: ErrorInfo.optional(),
	errors: z.array(ErrorInfo).optional(),
	steps: z.array(RunnerStep).max(TRAIL_LIMITS.steps, "Limit: 100 steps per result").optional(),
});
const outcomes: Record<z.infer<typeof Attempt>["status"], Outcome> = {
	passed: "pass",
	failed: "fail",
	skipped: "skip",
	timedOut: "error",
	interrupted: "error",
};
const Suite = z.object({
	title: z.string(),
	file: z.string(),
	suites: z.array(z.unknown()).optional(),
	specs: z.array(
		z.object({
			title: z.string().min(1),
			file: z.string(),
			tests: z
				.array(
					z.object({
						projectName: z.string(),
						expectedStatus: z.enum(["passed", "failed", "skipped"]),
						annotations: z.array(z.object({ type: z.string(), description: z.string().optional() })).optional(),
						results: z.array(Attempt).min(1),
					}),
				)
				.min(1),
		}),
	),
});
const Report = z.object({ suites: z.array(z.unknown()), errors: z.array(z.unknown()).optional() });

export function parsePlaywright(value: unknown): ParsedReport {
	const report = Report.parse(value);
	if (report.errors?.length)
		throw new Error("Playwright reported errors outside test executions; fix the runner before uploading");
	const results: ParsedReport["results"] = [];
	const pending: { suite: unknown; path: string[]; root: boolean }[] = report.suites
		.toReversed()
		.map((suite) => ({ suite, path: [], root: true }));
	while (pending.length) {
		const entry = pending.pop();
		if (!entry) break;
		const suite = Suite.parse(entry.suite);
		const path = entry.root ? entry.path : [...entry.path, suite.title];
		for (const spec of suite.specs) {
			for (const test of spec.tests) {
				const final = test.results.reduce((latest, attempt) =>
					(latest.status === "skipped" && attempt.status !== "skipped") ||
					(attempt.status !== "skipped" && attempt.retry > latest.retry)
						? attempt
						: latest,
				);
				// Every try is judged as the result is: a test expected to fail passes when it fails.
				const judged = (attempt: z.infer<typeof Attempt>): Outcome =>
					test.expectedStatus === "failed" && attempt.status === "passed"
						? "fail"
						: test.expectedStatus === "failed" && attempt.status === "failed"
							? "pass"
							: outcomes[attempt.status];
				const detailOf = (attempt: z.infer<typeof Attempt>): string =>
					test.expectedStatus === "failed" && attempt.status === "passed"
						? "Expected test to fail, but it passed"
						: stripVTControlCharacters(
								[
									attempt.error?.stack ?? attempt.error?.message,
									...(attempt.errors ?? []).map((error) => error.stack ?? error.message),
								]
									.filter(Boolean)
									.join("\n"),
							);
				// The runner's earlier tries, oldest first: the ones before the try it ended on (decision 0129).
				const tries = test.results
					.filter((attempt) => attempt !== final && attempt.retry < final.retry)
					.toSorted((a, b) => a.retry - b.retry)
					.map((attempt) => {
						const outcome = judged(attempt);
						const detail = detailOf(attempt).trim();
						return {
							outcome,
							durationMs: Math.round(attempt.duration),
							...((outcome === "fail" || outcome === "error") && detail
								? { failure: { message: clip(detail.split(/\r?\n/)[0] ?? detail, 4000), detail: clip(detail, 20_000) } }
								: {}),
						};
					});
				// Kept whole or refused: dropping the oldest tries could drop the one that passed, and with it the flip.
				if (tries.length > 100)
					throw new Error(
						`Playwright tried ${reportIdentifier(spec.title)} ${tries.length + 1} times, more than the 101 a result and its 100 tries keep`,
					);
				const result = nativeResult({
					name: spec.title,
					file: spec.file || suite.file,
					suites: [test.projectName, ...path],
					outcome: judged(final),
					durationMs: test.results.reduce((sum, attempt) => sum + attempt.duration, 0),
					retries: final.retry,
					tries,
					annotation: test.annotations
						?.filter((item) => item.type === "mainworthy")
						.map((item) => caseAnnotation(item.description ?? ""))
						.findLast((claim) => claim !== undefined),
					detail: detailOf(final),
				});
				if (final.steps)
					result.steps = ResultTrail.parse(
						final.steps.map((step) => {
							const actions = [];
							const pending = (step.steps ?? []).toReversed().map((value) => ({ value, path: "" }));
							while (pending.length) {
								const entry = pending.pop();
								if (!entry) break;
								const child = RunnerStep.parse(entry.value);
								const text = entry.path + child.title;
								if (actions.length >= TRAIL_LIMITS.actions) throw new Error("Limit: 100 actions per step");
								actions.push({ text, outcome: child.error ? "fail" : "pass", durationMs: Math.round(child.duration) });
								for (const value of (child.steps ?? []).toReversed()) pending.push({ value, path: `${text} / ` });
							}
							return {
								step: step.title,
								outcome: step.error ? "fail" : "pass",
								durationMs: Math.round(step.duration),
								actions,
							};
						}),
					);
				results.push(result);
			}
		}
		for (const child of (suite.suites ?? []).toReversed()) pending.push({ suite: child, path, root: false });
	}
	return { results, warnings: [] };
}
