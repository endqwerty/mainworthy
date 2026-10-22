import { posix, win32 } from "node:path";
import { z } from "zod";
import { clip } from "../../core/text.ts";
import { nativeResult, type ParsedReport, reportIdentifier, reportWarnings } from "./native.ts";

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
					invocations: z.number().int().nonnegative().max(101).optional(),
					retryReasons: z.array(z.string()).optional(),
				}),
			),
		}),
	),
});

/** Jest and Vitest deliberately share the assertionResults JSON representation. */
export function parseJest(value: unknown, rootDir: string): ParsedReport {
	const report = Report.parse(value);
	const root = (report.rootDir ?? rootDir).replace(/\\/g, "/");
	const rootPath = /^[a-z]:/i.test(root) || root.startsWith("//") ? win32 : posix;
	if (!rootPath.isAbsolute(root)) throw new Error(`Jest/Vitest root must be absolute: ${root}`);
	const normalizedRoot = rootPath.normalize(root);
	if (normalizedRoot === rootPath.parse(normalizedRoot).root)
		throw new Error(`Jest/Vitest filesystem root: ${root}; use the source checkout root`);
	if (report.wasInterrupted || report.runExecError != null)
		throw new Error("Jest/Vitest did not finish; fix the runner before uploading");
	const results: ParsedReport["results"] = [];
	const warnings = reportWarnings();
	for (const suite of report.testResults) {
		const name = suite.name.replace(/\\/g, "/");
		const path = /^[a-z]:\//i.test(name) || name.startsWith("//") ? win32 : posix;
		if (path.isAbsolute(name) && path !== rootPath)
			throw new Error(`Jest/Vitest source path and root must be on the same drive: ${root}; source: ${suite.name}`);
		const file = path.normalize(path.isAbsolute(name) ? path.relative(root, name) : name).replace(/\\/g, "/");
		if (path.isAbsolute(file))
			throw new Error(`Jest/Vitest source path and root must be on the same drive: ${root}; source: ${suite.name}`);
		if (file === ".." || file.startsWith("../"))
			throw new Error(`Jest/Vitest outside root: ${root}; source: ${suite.name}`);
		if (suite.status === "failed" && !suite.assertionResults.length)
			throw new Error(`Jest/Vitest suite ${suite.name} reported an execution error; fix the runner before uploading`);
		if (suite.status === "failed" && !suite.assertionResults.some((test) => test.status === "failed"))
			throw new Error(`Jest/Vitest suite ${suite.name} failed without a failed test`);
		for (const test of suite.assertionResults) {
			const retries = Math.max(0, (test.invocations ?? 1) - 1);
			if (test.invocations !== undefined && !retries && test.retryReasons?.length)
				throw new Error(`Jest test ${reportIdentifier(test.title)} has retry reasons without another invocation`);
			// Jest counts invocations, but flattens multiple errors per try. Vitest keeps errors without boundaries.
			const details = retries
				? Array.from({ length: retries }, (_, index) =>
						retries === 1
							? (test.retryReasons?.join("\n") ?? "")
							: test.retryReasons?.length === retries
								? (test.retryReasons[index] ?? "")
								: "",
					)
				: test.retryReasons?.length
					? [test.retryReasons.join("\n")]
					: test.invocations === undefined && test.status === "passed" && test.failureMessages?.length
						? [test.failureMessages.join("\n")]
						: [];
			if (retries && (!test.retryReasons?.length || (retries > 1 && test.retryReasons.length !== retries)))
				warnings.add(
					() => `Jest test ${reportIdentifier(`${file}::${test.title}`)}: individual retry diagnostics are unavailable`,
				);
			if (details.length && !retries)
				warnings.add(
					() =>
						`Jest/Vitest test ${reportIdentifier(`${file}::${test.title}`)}: report omits retry count and boundaries; kept earlier failures as one try`,
				);
			const tries = details.map((value) => {
				const detail = value.trim();
				return {
					outcome: "fail" as const,
					...(detail
						? { failure: { message: clip(detail.split(/\r?\n/)[0] ?? detail, 4000), detail: clip(detail, 20_000) } }
						: {}),
				};
			});
			results.push(
				nativeResult({
					name: test.title,
					file,
					suites: test.ancestorTitles,
					outcome: test.status === "passed" ? "pass" : test.status === "failed" ? "fail" : "skip",
					...(test.duration == null ? {} : { durationMs: test.duration }),
					detail: test.failureMessages?.join("\n"),
					retries,
					tries,
				}),
			);
		}
	}
	return { results, warnings: warnings.finish() };
}
