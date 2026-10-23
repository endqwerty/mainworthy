import { expect, test } from "bun:test";
import { parseCaseImport } from "./cases.ts";
import { parseJest } from "./jest.ts";
import { parseJUnit } from "./junit.ts";
import { reportJson } from "./native.ts";
import { parsePlaywright } from "./playwright.ts";
import { parsePytest } from "./pytest.ts";
import { parseReport } from "./report.ts";
import { parseTRX } from "./trx.ts";

const identifier = "\n::error::x\u001b]0;x\u0007\u0085\u202e";
// biome-ignore lint/suspicious/noControlCharactersInRegex: diagnostics must not emit terminal or line controls.
const controls = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const failure = (run: () => unknown): string => {
	try {
		run();
	} catch (error) {
		if (error instanceof Error) return error.message;
		throw error;
	}
	throw new Error("Expected the report to be refused");
};
const suite = (name: string, assertionResults: unknown[] = []) => ({ name, status: "failed", assertionResults });

test.each([undefined, 2])("report JSON escapes controls without shortening keys or values (indent %j)", (space) => {
	const text = `${identifier}${'long value 🦊"\\'.repeat(30)}`;
	const value = { [text]: [text, null, 7, true] };
	const json = reportJson(value, space);
	expect(JSON.parse(json)).toEqual(value);
	expect(json.replaceAll("\n", "")).not.toMatch(controls);
	expect(json).toContain("\\n::error::x");
	expect(json).toContain("\\u0085");
});

test.each([
	["suite execution error", () => parseJest({ testResults: [suite(identifier)] }, "/repo")],
	[
		"suite without a failed test",
		() =>
			parseJest(
				{ testResults: [suite(identifier, [{ title: "one", ancestorTitles: [], status: "passed" }])] },
				"/repo",
			),
	],
	["relative root", () => parseJest({ rootDir: identifier, testResults: [] }, "/repo")],
	["filesystem root", () => parseJest({ rootDir: `/${identifier}/..`, testResults: [] }, "/repo")],
	["different path styles", () => parseJest({ testResults: [suite(`/${identifier}`)] }, "C:/repo")],
	["different drives", () => parseJest({ testResults: [suite(`D:/${identifier}`)] }, "C:/repo")],
	["outside root", () => parseJest({ testResults: [suite(`../${identifier}`)] }, "/repo")],
] as const)("Jest %s quotes external identifiers", (_name, run) => {
	const message = failure(run);
	expect(message).toContain("\\n::error::x");
	expect(message).toContain("\\u001b");
	expect(message).toContain("\\u0085");
	expect(message).not.toMatch(controls);
});

test.each([undefined, { setup: { outcome: "passed", duration: 0 } }])(
	"pytest stage errors quote node ids (%j)",
	(stages) => {
		const message = failure(() =>
			parsePytest({ exitcode: 0, tests: [{ nodeid: `test.py::${identifier}`, outcome: "passed", ...stages }] }),
		);
		expect(message).toContain("\\n::error::x");
		expect(message).not.toMatch(controls);
	},
);

test("Playwright retry-limit errors quote test names", () => {
	const message = failure(() =>
		parsePlaywright({
			suites: [
				{
					title: "",
					file: "one.js",
					specs: [
						{
							title: identifier,
							file: "one.js",
							tests: [
								{
									projectName: "",
									expectedStatus: "passed",
									results: Array.from({ length: 102 }, (_, retry) => ({ status: "passed", duration: 0, retry })),
								},
							],
						},
					],
				},
			],
		}),
	);
	expect(message).toContain("\\n::error::x");
	expect(message).not.toMatch(controls);
});

test("JUnit retry warnings and limits quote test names", () => {
	const name = identifier.replaceAll("\n", "&#10;").replaceAll("\u001b", "&#27;").replaceAll("\u0007", "&#7;");
	const { warnings } = parseJUnit(
		`<testsuite><testcase name="${name}"><failure/>${"<rerunFailure/>".repeat(102)}</testcase></testsuite>`,
	);
	const warning = warnings.find((value) => value.includes("earlier runs"));
	expect(warning).toBeDefined();
	expect(warning).toContain("\\n::error::x");
	expect(warning).not.toMatch(controls);
	// XML-invalid C0 characters damage a testcase, so use XML-valid C1 for the ordinal retry group.
	const message = failure(() =>
		parseJUnit(
			`<testsuite>${Array.from({ length: 102 }, (_, retry) => `<testcase name="x\u0085${retry ? ` (retry ${retry})` : ""}"/>`).join("")}</testsuite>`,
		),
	);
	expect(message).toContain("\\u0085");
	expect(message).not.toMatch(controls);
});

test("JUnit warning filenames are safe, including the omitted-warning summary", () => {
	const { warnings } = parseJUnit(`<testsuite>${"<testcase/>".repeat(1001)}</testsuite>`, { file: identifier });
	expect(warnings).toHaveLength(1001);
	expect(warnings.at(-1)).toContain("additional warnings omitted");
	for (const warning of warnings) {
		expect(warning).toContain("\\n::error::x");
		expect(warning).not.toMatch(controls);
	}
});

test("native report error filenames are quoted", () => {
	const message = failure(() => parseReport("{}", { file: identifier, format: "jest" }));
	expect(message).toContain("\\n::error::x");
	expect(message).not.toMatch(controls);
});

test.each([
	["ESC", "\u001b"],
	["C1 next line", "\u0085"],
	["bidi override", "\u202e"],
	["Unicode line separator", "\u2028"],
])("JSON syntax errors escape the invalid token %s", (_name, token) => {
	expect(failure(() => parseReport(`{"x":${token}}`, { file: "one.json" }))).not.toMatch(controls);
});

test("TRX parser errors escape expanded namespace names", () => {
	const message = failure(() => parseTRX('<TestRun xmlns:p="&#10;::error::x&#x85;" p:a="one" p:a="two"/>'));
	expect(message).toContain("::error::x");
	expect(message).not.toMatch(controls);
});

const table = (rows: string[][]): string =>
	rows.map((row) => row.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(",")).join("\n");
test.each([
	[
		"conflicting suite",
		[
			["id", "title", "suite_id", "suite"],
			["1", "One", identifier, "One"],
			["2", "Two", identifier, "Two"],
		],
	],
	[
		"missing suite",
		[
			["id", "title", "suite_id", "suite_parent_id", "suite"],
			["1", "One", "1", identifier, "One"],
		],
	],
	[
		"steps type",
		[
			["id", "title", "steps_type"],
			["1", "One", identifier],
		],
	],
	[
		"execution type",
		[
			["id", "title", "automation"],
			["1", "One", identifier],
		],
	],
	[
		"step JSON",
		[
			["v2.id", "title", "steps_actions"],
			["1", "One", "1. \u0085"],
		],
	],
])("Qase %s errors escape import-controlled values", (_name, rows) => {
	expect(failure(() => parseCaseImport(table(rows), "qase"))).not.toMatch(controls);
});
