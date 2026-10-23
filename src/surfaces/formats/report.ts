import { z } from "zod";
import { parseJest } from "./jest.ts";
import { parseJUnit } from "./junit.ts";
import { type ParsedReport, reportIdentifier } from "./native.ts";
import { parsePlaywright } from "./playwright.ts";
import { parsePytest } from "./pytest.ts";
import { parseTRX } from "./trx.ts";

export const ReportFormat = z.enum(["auto", "junit", "playwright", "jest", "vitest", "pytest", "trx"]);
export type ReportFormat = z.infer<typeof ReportFormat>;

/** Detects each file independently; JUnit still uses its existing parser and diagnostics. */
export function parseReport(
	text: string,
	options: { file: string; format?: ReportFormat; rootDir?: string },
): ParsedReport {
	const format = options.format ?? "auto";
	if (format === "junit") return parseJUnit(text, { file: options.file });
	const trimmed = text.replace(/^\uFEFF/, "").trimStart();
	const json = trimmed.startsWith("{") || (!trimmed.startsWith("<") && /\.json$/i.test(options.file));
	if (
		format === "auto" &&
		!json &&
		!/^(?:\s*<\?[^?]*\?>|\s*<!--[\s\S]*?-->)*\s*<(?:[\w.-]+:)?TestRun(?:\s|>)/.test(trimmed) &&
		!/\.trx$/i.test(options.file)
	)
		return parseJUnit(text, { file: options.file });
	try {
		let parsed: ParsedReport;
		if (format === "trx" || (format === "auto" && (trimmed.startsWith("<") || /\.trx$/i.test(options.file)))) {
			parsed = parseTRX(text);
		} else {
			const value: unknown = JSON.parse(trimmed);
			const shape = z
				.object({ suites: z.unknown().optional(), testResults: z.unknown().optional(), tests: z.unknown().optional() })
				.parse(value);
			const selected =
				format !== "auto"
					? format
					: shape.suites !== undefined
						? "playwright"
						: shape.testResults !== undefined
							? "jest"
							: shape.tests !== undefined
								? "pytest"
								: null;
			switch (selected) {
				case "playwright":
					parsed = parsePlaywright(value);
					break;
				case "jest":
				case "vitest":
					parsed = parseJest(value, options.rootDir ?? process.cwd());
					break;
				case "pytest":
					parsed = parsePytest(value);
					break;
				default:
					throw new Error("Unrecognized JSON report; use Playwright, Jest/Vitest or pytest-json-report output");
			}
		}
		if (!parsed.results.length) throw new Error("Report contains no test executions");
		return parsed;
	} catch (error) {
		const detail =
			error instanceof z.ZodError
				? error.issues
						.slice(0, 5)
						.map((issue) => `${issue.path.join(".") || "report"}: ${issue.message}`)
						.join("; ")
				: error instanceof SyntaxError
					? reportIdentifier(error.message)
					: error instanceof Error
						? error.message
						: "Invalid report";
		throw new Error(`${reportIdentifier(options.file)}: ${detail}`);
	}
}
