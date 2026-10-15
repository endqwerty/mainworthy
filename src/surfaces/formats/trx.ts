import { SaxesParser } from "saxes";
import { z } from "zod";
import { nativeResult, type ParsedReport } from "./native.ts";

const Attributes = z.object({
	testId: z.string().min(1),
	testName: z.string().min(1),
	outcome: z.enum([
		"Passed",
		"Failed",
		"Error",
		"Timeout",
		"Aborted",
		"NotRunnable",
		"NotExecuted",
		"Disconnected",
		"Inconclusive",
		"Warning",
		"Completed",
		"InProgress",
		"Pending",
	]),
	duration: z.string().optional(),
});
type Execution = { attributes: z.infer<typeof Attributes>; message: string; detail: string };

function duration(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const match = /^(?:(\d+)\.)?(\d+):([0-5]\d):([0-5]\d(?:\.\d{1,7})?)$/.exec(value);
	if (!match) throw new Error("Invalid TRX duration; expected [days.]hours:minutes:seconds");
	return (Number(match[1] ?? 0) * 86400 + Number(match[2]) * 3600 + Number(match[3]) * 60 + Number(match[4])) * 1000;
}

export function parseTRX(xml: string): ParsedReport {
	const parser = new SaxesParser({ xmlns: true });
	const stack: string[] = [];
	const executions: Execution[] = [];
	const definitions = new Map<string, string>();
	let current: Execution | undefined;
	let definition: string | undefined;
	let root = false;
	let summary: string | undefined;
	parser.on("doctype", () => {
		throw new Error("TRX document types are not supported");
	});
	parser.on("opentag", (tag) => {
		if (stack.length >= 32) throw new Error("TRX nesting exceeds 32 elements");
		if (!root) {
			if (
				tag.local !== "TestRun" ||
				(tag.uri !== "" && !/^http:\/\/microsoft\.com\/schemas\/VisualStudio\/TeamTest\/(?:2006|2010)$/.test(tag.uri))
			)
				throw new Error("Expected a TRX TestRun root");
			root = true;
		}
		const parent = stack.at(-1);
		stack.push(tag.local);
		if (tag.uri !== "" && !/^http:\/\/microsoft\.com\/schemas\/VisualStudio\/TeamTest\/(?:2006|2010)$/.test(tag.uri))
			throw new Error("Unsupported XML namespace in TRX report");
		const attrs = Object.fromEntries(
			Object.values(tag.attributes)
				.filter((attr) => attr.uri === "")
				.map((attr) => [attr.local, attr.value]),
		);
		if (parent === "Results" && stack.length === 3) {
			if (tag.local !== "UnitTestResult") throw new Error(`Unsupported TRX result ${tag.local}`);
			current = { attributes: Attributes.parse(attrs), message: "", detail: "" };
		} else if (tag.local === "UnitTest" && parent === "TestDefinitions" && stack.length === 3) {
			definition = z.string().min(1).parse(attrs.id);
		} else if (tag.local === "TestMethod" && parent === "UnitTest" && definition !== undefined) {
			definitions.set(definition, z.string().parse(attrs.className));
		} else if (tag.local === "ResultSummary" && stack.length === 2) {
			summary = attrs.outcome;
		} else if (
			tag.local === "RunInfo" &&
			attrs.outcome &&
			attrs.outcome !== "Passed" &&
			attrs.outcome !== "Completed"
		) {
			throw new Error("TRX reported a run-level error; fix the runner before uploading");
		}
	});
	const text = (value: string) => {
		if (!current || stack.length !== 6 || stack[3] !== "Output" || stack[4] !== "ErrorInfo") return;
		if (stack[5] === "Message") current.message += value.slice(0, Math.max(0, 4000 - current.message.length));
		if (stack[5] === "StackTrace") current.detail += value.slice(0, Math.max(0, 20_000 - current.detail.length));
	};
	parser.on("text", text);
	parser.on("cdata", text);
	parser.on("closetag", (tag) => {
		if (tag.local === "UnitTestResult" && stack.length === 3 && current) {
			executions.push(current);
			current = undefined;
		}
		if (tag.local === "UnitTest" && stack.length === 3) definition = undefined;
		stack.pop();
	});
	parser.write(xml).close();
	const results = executions.map(({ attributes: test, message, detail }) =>
		nativeResult({
			name: test.testName,
			className: definitions.get(test.testId),
			suites: [],
			outcome:
				test.outcome === "Passed"
					? "pass"
					: test.outcome === "Failed"
						? "fail"
						: test.outcome === "NotExecuted"
							? "skip"
							: "error",
			durationMs: duration(test.duration),
			detail: [message, detail].filter(Boolean).join("\n"),
		}),
	);
	if (
		summary &&
		summary !== "Passed" &&
		summary !== "Completed" &&
		!results.some((result) => result.outcome === "fail" || result.outcome === "error")
	)
		throw new Error("TRX run did not pass but contains no failed test execution");
	return { results, warnings: [] };
}
