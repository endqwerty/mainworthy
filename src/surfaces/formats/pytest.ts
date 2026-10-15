import { z } from "zod";
import { caseAnnotation } from "../../core/case-annotation.ts";
import { nativeResult, type ParsedReport } from "./native.ts";

const Stage = z.object({
	outcome: z.enum(["passed", "failed", "skipped"]),
	duration: z.number().nonnegative(),
	longrepr: z.union([z.string(), z.tuple([z.string(), z.number(), z.string()])]).optional(),
	crash: z.object({ message: z.string() }).optional(),
});
const Report = z.object({
	exitcode: z.number().int(),
	collectors: z.array(z.object({ outcome: z.enum(["passed", "failed", "skipped"]) })).optional(),
	tests: z.array(
		z.object({
			nodeid: z.string().min(1),
			user_properties: z.array(z.object({ mainworthy: z.string().optional() })).optional(),
			outcome: z.enum(["passed", "failed", "skipped", "xfailed", "xpassed", "error"]),
			setup: Stage.optional(),
			call: Stage.optional(),
			teardown: Stage.optional(),
		}),
	),
});

export function parsePytest(value: unknown): ParsedReport {
	const report = Report.parse(value);
	if (
		report.exitcode < 0 ||
		report.exitcode > 1 ||
		report.collectors?.some((collector) => collector.outcome === "failed")
	)
		throw new Error("pytest did not complete test collection/execution; fix the runner before uploading");
	const results: ParsedReport["results"] = [];
	for (const test of report.tests) {
		const separator = test.nodeid.indexOf("::");
		const file = test.nodeid.slice(0, separator);
		const path = test.nodeid.slice(separator + 2);
		const parameter = path.indexOf("[");
		const names = (parameter < 0 ? path : path.slice(0, parameter)).split("::");
		const title = names.pop();
		if (separator < 1 || !title) throw new Error("pytest nodeid must identify a file and test");
		const name = title + (parameter < 0 ? "" : path.slice(parameter));
		const stages = [test.setup, test.call, test.teardown].filter((stage) => stage !== undefined);
		if (!stages.length) throw new Error(`pytest test ${test.nodeid} has no completed stage`);
		const broken = stages.filter((stage) => stage.outcome === "failed");
		const failures = broken.map((stage) => {
			const detail = typeof stage.longrepr === "string" ? stage.longrepr : (stage.longrepr?.join(":") ?? "");
			return {
				message: stage.crash?.message.trim() || detail.trim().split(/\r?\n/).at(-1),
				detail: detail || stage.crash?.message,
			};
		});
		const error = test.outcome === "error" || test.setup?.outcome === "failed" || test.teardown?.outcome === "failed";
		const outcome = error
			? "error"
			: test.outcome === "xfailed"
				? "skip"
				: test.outcome === "failed" || broken.length
					? "fail"
					: test.outcome === "passed" || test.outcome === "xpassed"
						? "pass"
						: "skip";
		results.push(
			nativeResult({
				name,
				file,
				suites: names,
				outcome,
				annotation: test.user_properties
					?.map((item) => caseAnnotation(item.mainworthy ?? ""))
					.findLast((claim) => claim !== undefined),
				durationMs: stages.reduce((sum, stage) => sum + stage.duration, 0) * 1000,
				message: failures
					.map((failure) => failure.message)
					.filter(Boolean)
					.join("\n"),
				detail: failures
					.map((failure) => failure.detail)
					.filter(Boolean)
					.join("\n"),
			}),
		);
	}
	return { results, warnings: [] };
}
