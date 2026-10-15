import { stripVTControlCharacters } from "node:util";
import { z } from "zod";
import type { Outcome } from "../../core/ops.ts";
import { nativeResult, type ParsedReport } from "./native.ts";

const ErrorInfo = z.object({ message: z.string().optional(), stack: z.string().optional() });
const Attempt = z.object({
	status: z.enum(["passed", "failed", "timedOut", "skipped", "interrupted"]),
	duration: z.number().nonnegative(),
	retry: z.number().int().nonnegative(),
	error: ErrorInfo.optional(),
	errors: z.array(ErrorInfo).optional(),
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
				const detail = [
					final.error?.stack ?? final.error?.message,
					...(final.errors ?? []).map((error) => error.stack ?? error.message),
				]
					.filter(Boolean)
					.join("\n");
				const unexpectedPass = test.expectedStatus === "failed" && final.status === "passed";
				const expectedFailure = test.expectedStatus === "failed" && final.status === "failed";
				results.push(
					nativeResult({
						name: spec.title,
						file: spec.file || suite.file,
						suites: [test.projectName, ...path],
						outcome: unexpectedPass ? "fail" : expectedFailure ? "pass" : outcomes[final.status],
						durationMs: test.results.reduce((sum, attempt) => sum + attempt.duration, 0),
						retries: final.retry,
						detail: unexpectedPass ? "Expected test to fail, but it passed" : stripVTControlCharacters(detail),
					}),
				);
			}
		}
		for (const child of (suite.suites ?? []).toReversed()) pending.push({ suite: child, path, root: false });
	}
	return { results, warnings: [] };
}
