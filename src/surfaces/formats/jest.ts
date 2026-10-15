import { posix, win32 } from "node:path";
import { z } from "zod";
import { nativeResult, type ParsedReport } from "./native.ts";

const Report = z.object({
	rootDir: z.string().min(1).optional(),
	wasInterrupted: z.boolean().optional(),
	runExecError: z.unknown().optional(),
	testResults: z.array(
		z.object({
			name: z.string().min(1),
			status: z.enum(["passed", "failed", "skipped", "focused"]),
			message: z.string().optional(),
			assertionResults: z.array(
				z.object({
					title: z.string().min(1),
					ancestorTitles: z.array(z.string()),
					status: z.enum(["passed", "failed", "skipped", "pending", "todo", "disabled"]),
					duration: z.number().nonnegative().nullish(),
					failureMessages: z.array(z.string()).nullish(),
				}),
			),
		}),
	),
});

/** Jest and Vitest deliberately share the assertionResults JSON representation. */
export function parseJest(value: unknown, rootDir: string): ParsedReport {
	const report = Report.parse(value);
	const root = (report.rootDir ?? rootDir).replace(/\\/g, "/");
	if (report.wasInterrupted || report.runExecError != null)
		throw new Error("Jest/Vitest did not finish; fix the runner before uploading");
	const results: ParsedReport["results"] = [];
	for (const suite of report.testResults) {
		const name = suite.name.replace(/\\/g, "/");
		const path = /^[a-z]:\//i.test(name) || name.startsWith("//") ? win32 : posix;
		const file = path.isAbsolute(name) ? path.relative(root, name).replace(/\\/g, "/") : name;
		if (path.isAbsolute(file)) throw new Error("Jest/Vitest source path and root must be on the same drive");
		if (suite.status === "failed" && !suite.assertionResults.length)
			throw new Error(`Jest/Vitest suite ${suite.name} reported an execution error; fix the runner before uploading`);
		if (suite.status === "failed" && !suite.assertionResults.some((test) => test.status === "failed"))
			throw new Error(`Jest/Vitest suite ${suite.name} failed without a failed test`);
		for (const test of suite.assertionResults) {
			results.push(
				nativeResult({
					name: test.title,
					file,
					suites: test.ancestorTitles,
					outcome: test.status === "passed" ? "pass" : test.status === "failed" ? "fail" : "skip",
					...(test.duration == null ? {} : { durationMs: test.duration }),
					detail: test.failureMessages?.join("\n"),
				}),
			);
		}
	}
	return { results, warnings: [] };
}
