import { expect, test } from "bun:test";
import { ReportInput } from "../../core/ops.ts";
import { normaliseFailure, signatureHash } from "../../core/signature.ts";
import { parseJUnit } from "./junit.ts";
import { parseReport, type ReportFormat } from "./report.ts";

const directory = new URL("../../../test/fixtures/reports/", import.meta.url);
const fixture = (name: string) => Bun.file(new URL(name, directory)).text();
const parse = (value: unknown, format: ReportFormat = "auto") =>
	parseReport(JSON.stringify(value), { file: "report.json", format });
const jestReport = (status = "passed", extra = {}) => ({
	testResults: [
		{
			name: "./tests\\sample.js",
			status: status === "failed" ? "failed" : "passed",
			assertionResults: [
				{
					title: "adds @C-1@v2",
					ancestorTitles: ["math"],
					status,
					duration: 12.5,
					failureMessages: ["expected 2\n at sample.js:8"],
					...extra,
				},
			],
		},
	],
});
const playwrightReport = (results: unknown[], expectedStatus = "passed") => ({
	errors: [],
	suites: [
		{
			title: "tests/sample.js",
			file: "tests/sample.js",
			specs: [
				{ title: "adds", file: "tests/sample.js", tests: [{ projectName: "chromium", expectedStatus, results }] },
			],
		},
	],
});

test("generated Playwright JSON keeps project, nesting, annotations, failures and total retry duration", async () => {
	const parsed = parseReport(await fixture("playwright.json"), { file: "playwright.json" });
	expect(
		parsed.results.map(
			(result) => [result.test, result.outcome, result.durationMs, result.note, result.annotation] as const,
		),
	).toEqual([
		[
			{ key: "sample.spec.cjs::chromium::checkout::passes @C-1@v1", name: "passes @C-1@v1", file: "sample.spec.cjs" },
			"pass",
			4,
			undefined,
			{ case: "C-1", version: 1 },
		],
		[
			{ key: "sample.spec.cjs::chromium::checkout::fails", name: "fails", file: "sample.spec.cjs" },
			"fail",
			19,
			undefined,
			undefined,
		],
		[
			{ key: "sample.spec.cjs::chromium::checkout::skipped", name: "skipped", file: "sample.spec.cjs" },
			"skip",
			0,
			undefined,
			undefined,
		],
		[
			{ key: "sample.spec.cjs::chromium::checkout::retry", name: "retry", file: "sample.spec.cjs" },
			"pass",
			26,
			"passed after 1 retries",
			undefined,
		],
	]);
	expect(parsed.results[1]?.failure?.detail).toContain("Expected:");
	expect(ReportInput.parse({ target: { session: "fixture" }, results: parsed.results }).results).toHaveLength(4);
});

test.each(["jest", "vitest"] as const)("%s JSON normalizes matching assertions identically", async (format) => {
	const parsed = parseReport(await fixture(`${format}.json`), { file: `${format}.json`, format });
	expect(parsed.results).toEqual([
		{
			test: {
				key: "tests/sample.test.js::checkout::passes @C-1@v1",
				name: "passes @C-1@v1",
				file: "tests/sample.test.js",
			},
			outcome: "pass",
			durationMs: 13,
			annotation: { case: "C-1", version: 1 },
		},
		{
			test: { key: "tests/sample.test.js::checkout::fails", name: "fails", file: "tests/sample.test.js" },
			outcome: "fail",
			durationMs: 8,
			failure: { message: "Expected 2, received 1", detail: "Expected 2, received 1\n at sample.test.js:8:3" },
		},
		{
			test: { key: "tests/sample.test.js::checkout::skipped", name: "skipped", file: "tests/sample.test.js" },
			outcome: "skip",
		},
	]);
});

test("pytest-json-report keeps setup/call/teardown duration and fixture errors", async () => {
	const { results } = parseReport(await fixture("pytest.json"), { file: "pytest.json" });
	expect(results.map((result) => [result.test, result.outcome, result.durationMs])).toEqual([
		[
			{ key: "tests/test_sample.py::TestCheckout::test_pass", name: "test_pass", file: "tests/test_sample.py" },
			"pass",
			14,
		],
		[
			{ key: "tests/test_sample.py::TestCheckout::test_fail", name: "test_fail", file: "tests/test_sample.py" },
			"fail",
			8,
		],
		[{ key: "tests/test_sample.py::test_skip", name: "test_skip", file: "tests/test_sample.py" }, "skip", 1],
		[
			{ key: "tests/test_sample.py::test_setup_error", name: "test_setup_error", file: "tests/test_sample.py" },
			"error",
			1,
		],
	]);
	expect(results[1]?.failure).toEqual({
		message: "assert 1 == 2",
		detail: "test_sample.py:8: AssertionError: assert 1 == 2",
	});
	expect(results[3]?.failure?.detail).toContain("fixture unavailable");
});

test("TRX joins definitions by id after results and decodes entities and CDATA", async () => {
	const { results } = parseReport(await fixture("sample.trx"), { file: "renamed.xml" });
	expect(results).toEqual([
		{
			test: { key: "Shop.Checkout::Pass @C-1@v1", name: "Pass @C-1@v1" },
			outcome: "pass",
			durationMs: 13,
			annotation: { case: "C-1", version: 1 },
		},
		{
			test: { key: "Shop.Checkout::Fail", name: "Fail" },
			outcome: "fail",
			durationMs: 8,
			failure: {
				message: "Expected <2>, received 1",
				detail: "Expected <2>, received 1\nat Checkout.Fail() in tests/Checkout.cs:line 8",
			},
		},
		{ test: { key: "Shop.Checkout::Skipped", name: "Skipped" }, outcome: "skip", durationMs: 0 },
	]);
});

test("native identity matches JUnit for equivalent file, suite, annotation and retry names", () => {
	const native = parse(jestReport("passed", { title: "adds @C-1@v2 (retry #1)" })).results[0];
	const junit = parseJUnit(
		'<testsuite name="math"><testcase file="./tests\\sample.js" name="adds @C-1@v2 (retry #1)" time="0.0125" /></testsuite>',
	).results[0];
	expect(native).toEqual(junit);
	expect(native?.test).toEqual({
		key: "tests/sample.js::math::adds @C-1@v2",
		name: "adds @C-1@v2 (retry #1)",
		file: "tests/sample.js",
	});
});

test("long native keys keep the same distinguishing digest as JUnit", () => {
	const title = "a".repeat(1200);
	const native = parse(jestReport("passed", { title })).results[0];
	const junit = parseJUnit(
		`<testsuite name="math"><testcase file="tests/sample.js" name="${title}" time="0.0125" /></testsuite>`,
	).results[0];
	expect(native).toEqual(junit);
	const other = parse(jestReport("passed", { title: `${title}b` })).results[0];
	expect(native?.test).not.toEqual(other?.test);
});

test("native suite paths normalize like JUnit paths", () => {
	const native = parse(jestReport("passed", { ancestorTitles: ["./math\\nested"] })).results[0];
	const junit = parseJUnit(
		'<testsuite name="./math\\nested"><testcase file="tests/sample.js" name="adds @C-1@v2" time="0.0125" /></testsuite>',
	).results[0];
	expect(native).toEqual(junit);
	expect(native?.test).toEqual({
		key: "tests/sample.js::math/nested::adds @C-1@v2",
		name: "adds @C-1@v2",
		file: "tests/sample.js",
	});
});

test("the JUnit default and explicit parser retain their exact diagnostics", () => {
	const xml = '<testsuite><testcase name="bad duration" time="nope"/></testsuite>';
	const expected = parseJUnit(xml, { file: "report.xml" });
	expect(parseReport(xml, { file: "report.xml" })).toEqual(expected);
	expect(parseReport(xml, { file: "report.xml", format: "junit" })).toEqual(expected);
});

test("Playwright chooses the last decisive retry and keeps project identities separate", () => {
	const report = playwrightReport([
		{ status: "skipped", duration: 0, retry: 2 },
		{ status: "passed", duration: 3, retry: 1 },
		{ status: "failed", duration: 2, retry: 0 },
	]);
	const result = parse(report).results[0];
	expect(result).toEqual({
		test: { key: "tests/sample.js::chromium::adds", name: "adds", file: "tests/sample.js" },
		outcome: "pass",
		durationMs: 5,
		note: "passed after 1 retries",
	});
	expect(
		parse(
			playwrightReport([
				{ status: "failed", duration: 2, retry: 0 },
				{ status: "skipped", duration: 0, retry: 1 },
			]),
		).results[0]?.outcome,
	).toBe("fail");
	const suite = report.suites[0];
	if (!suite) throw new Error("missing fixture suite");
	const spec = suite.specs[0];
	if (!spec) throw new Error("missing fixture spec");
	spec.tests.push({
		projectName: "firefox",
		expectedStatus: "passed",
		results: [{ status: "passed", duration: 1, retry: 0 }],
	});
	expect(parse(report).results.map((result) => result.test)).toContainEqual({
		key: "tests/sample.js::firefox::adds",
		name: "adds",
		file: "tests/sample.js",
	});
});

test("Playwright expected failures pass, unexpected passes fail, and timeouts remain errors", () => {
	expect(parse(playwrightReport([{ status: "failed", duration: 1, retry: 0 }], "failed")).results[0]?.outcome).toBe(
		"pass",
	);
	expect(
		parse(playwrightReport([{ status: "passed", duration: 1, retry: 0 }], "failed")).results[0]?.failure?.message,
	).toBe("Expected test to fail, but it passed");
	for (const status of ["timedOut", "interrupted"])
		expect(parse(playwrightReport([{ status, duration: 1, retry: 0 }])).results[0]?.outcome).toBe("error");
});

test("native JSON rejects malformed or unknown statuses instead of uploading partial results", () => {
	for (const value of [
		null,
		{},
		{ testResults: null },
		jestReport("unknown"),
		jestReport("passed", { duration: -1 }),
		jestReport("passed", { failureMessages: [42] }),
		{ ...playwrightReport([]) },
		{ ...playwrightReport([{ status: "passed", duration: 1, retry: 0 }]), errors: [{ message: "runner crashed" }] },
	]) {
		expect(() => parse(value)).toThrow("report.json:");
	}
	expect(() => parseReport('{"testResults":', { file: "broken.json" })).toThrow("broken.json:");
	expect(() => parse(jestReport(), "pytest")).toThrow("exitcode");
});

test("runner errors cannot become a passing native upload", () => {
	for (const value of [
		{ ...jestReport(), wasInterrupted: true },
		{ ...jestReport(), runExecError: { message: "setup" } },
		{ testResults: [{ name: "tests.js", status: "failed", assertionResults: [] }] },
		{
			testResults: [
				{
					name: "tests.js",
					status: "failed",
					assertionResults: [{ title: "pass", ancestorTitles: [], status: "passed" }],
				},
			],
		},
		{ exitcode: 2, tests: [] },
		{ exitcode: 0, tests: [], collectors: [{ outcome: "failed" }] },
		{ exitcode: 0, tests: [{ nodeid: "test.py::test_pass", outcome: "passed" }] },
	]) {
		expect(() => parse(value)).toThrow("report.json:");
	}
});

test("Jest focused and skipped suites keep each assertion's own outcome", () => {
	for (const status of ["focused", "skipped"]) {
		const report = jestReport("pending");
		const suite = report.testResults[0];
		if (!suite) throw new Error("missing fixture suite");
		suite.status = status;
		expect(parse(report).results[0]).toEqual({
			test: { key: "tests/sample.js::math::adds @C-1@v2", name: "adds @C-1@v2", file: "tests/sample.js" },
			outcome: "skip",
			durationMs: 13,
			annotation: { case: "C-1", version: 2 },
		});
	}
});

test("pytest honors expected failure and teardown errors and preserves parameterized node ids", () => {
	const parsed = parse({
		exitcode: 1,
		tests: [
			{
				nodeid: "tests/test.py::test_xfail[a::b]",
				outcome: "xfailed",
				call: { duration: 0.01, outcome: "failed", crash: { message: "expected failure" } },
			},
			{
				nodeid: "tests/test.py::test_teardown",
				outcome: "passed",
				call: { duration: 0.01, outcome: "passed" },
				teardown: { duration: 0.002, outcome: "failed", crash: { message: "cleanup failed" } },
			},
		],
	});
	expect(parsed.results[0]?.test).toEqual({
		key: "tests/test.py::test_xfail[a::b]",
		name: "test_xfail[a::b]",
		file: "tests/test.py",
	});
	expect(parsed.results[0]?.outcome).toBe("skip");
	expect(parsed.results[1]?.outcome).toBe("error");
	expect(parsed.results[1]?.failure?.message).toBe("cleanup failed");
});

test("TRX rejects malformed XML, unknown results, document types and run-level errors", async () => {
	const sample = await fixture("sample.trx");
	for (const xml of [
		sample.replace('outcome="Passed"', 'outcome="Unknown"'),
		sample.replace("</TestRun>", ""),
		sample.replace("Expected &lt;2&gt;", "Expected &bogus;"),
		sample.replace("<Results>", "<Results><TestResultAggregation/>"),
		sample.replace("<Results>", "<Results><Other/>"),
		sample.replace("<Results>", '<RunInfos><RunInfo outcome="Error"/></RunInfos><Results>'),
		'<!DOCTYPE TestRun [<!ENTITY example "pass">]><TestRun/>',
	]) {
		expect(() => parseReport(xml, { file: "sample.trx" })).toThrow("sample.trx:");
	}
	expect(() =>
		parseReport(
			'<TestRun><Results><UnitTestResult testId="a" testName="a" duration="bad" outcome="Passed"/></Results></TestRun>',
			{ file: "sample.trx" },
		),
	).toThrow("Invalid TRX duration");
});

test("TRX handles namespace prefixes, missing definitions and long TimeSpan durations", () => {
	const parsed = parseReport(
		'<?xml version="1.0"?><!-- report --><t:TestRun xmlns:t="http://microsoft.com/schemas/VisualStudio/TeamTest/2010"><t:Results><t:UnitTestResult testId="random-guid" testName="unknown test" outcome="Passed" duration="1.02:03:04.1234567"/></t:Results></t:TestRun>',
		{ file: "renamed.xml" },
	);
	expect(parsed.results[0]).toEqual({
		test: { key: "unknown test", name: "unknown test" },
		outcome: "pass",
		durationMs: 93784123,
	});
});

test.each(["jest", "vitest"] as const)("real %s absolute paths are relative to the checkout root", async (format) => {
	const text = await fixture(`real-${format}.json`);
	const { results } = parseReport(text, { file: "report.json", rootDir: "/home/robin/project" });
	expect(results.map((result) => ["key" in result.test ? result.test.key : result.test.case, result.outcome])).toEqual([
		["tests/sample.test.js::checkout::passes @C-1@v1", "pass"],
		["tests/sample.test.js::checkout::fails", "fail"],
		["tests/sample.test.js::checkout::skipped", "skip"],
		["tests/sample.test.js::checkout::todo", "skip"],
		["tests/sample.test.js::checkout::parameter 1", "pass"],
		["tests/sample.test.js::checkout::parameter 2", "pass"],
		["tests/sample.test.js::checkout::retry", "pass"],
	]);
	expect(results.map((result) => ("key" in result.test ? result.test.file : result.test.case))).toEqual(
		Array(7).fill("tests/sample.test.js"),
	);
	const report = { ...JSON.parse(text), rootDir: "/home/robin/project" };
	expect(parseReport(JSON.stringify(report), { file: "report.json", rootDir: "/elsewhere" }).results).toEqual(results);
});

test("real pytest class assertions have distinct signatures and fixture errors name the crash", async () => {
	const { results } = parseReport(await fixture("real-pytest.json"), { file: "report.json" });
	const assertions = results.filter((result) => result.outcome === "fail");
	const signatures = assertions.map((result) => {
		if (!result.failure) throw new Error("missing assertion diagnostic");
		return signatureHash(
			normaliseFailure({
				message: result.failure.message,
				...(result.failure.detail === undefined ? {} : { detail: result.failure.detail }),
			}),
		);
	});
	expect(new Set(signatures).size).toBe(2);
	expect(assertions.map((result) => result.failure?.message)).toEqual([
		"assert 1 == 2",
		"AssertionError: assert 'robin' == 'sam'\n  \n  - sam\n  + robin",
	]);
	expect(assertions[0]?.failure?.detail).toContain("self = <test_sample.TestCart object at");
	expect(results.find((result) => result.outcome === "error")?.failure?.message).toBe("RuntimeError: fixture boom");
	expect(results.map((result) => result.outcome)).toEqual([
		"pass",
		"fail",
		"fail",
		"skip",
		"skip",
		"pass",
		"pass",
		"error",
	]);
});

test("real Playwright diagnostics remove colours while preserving retries and parameterized tests", async () => {
	const { results } = parseReport(await fixture("real-playwright.json"), { file: "report.json" });
	const failure = results.find((result) => result.outcome === "fail")?.failure;
	expect(failure?.message).toContain("Error: expect(received).toBe(expected)");
	expect(failure?.detail).toContain("Expected: 2");
	expect(failure?.detail).toContain("Received: 1");
	expect(JSON.stringify(failure)).not.toContain("\\u001b");
	expect(results.find((result) => "key" in result.test && result.test.name === "retry")?.note).toBe(
		"passed after 1 retries",
	);
	expect(results.map((result) => result.outcome)).toEqual(["pass", "fail", "skip", "skip", "pass", "pass", "pass"]);
});

test("TRX refuses XML deeper than 32 elements", () => {
	const xml = `<TestRun>${"<a>".repeat(40)}${"</a>".repeat(40)}</TestRun>`;
	expect(() => parseReport(xml, { file: "deep.trx" })).toThrow("deep.trx: TRX nesting exceeds 32 elements");
});

test("invalid JSON root diagnostics name the report", () => {
	expect(() => parseReport("[1,2]", { file: "array.json" })).toThrow(
		"array.json: report: Invalid input: expected object, received array",
	);
});

test("pytest without crash metadata uses the final diagnostic line and keeps the traceback", () => {
	const { results } = parse({
		exitcode: 1,
		tests: [
			{
				nodeid: "tests/test.py::TestCart::test_total",
				outcome: "failed",
				call: { duration: 0, outcome: "failed", longrepr: "self = <TestCart object>\n\nE assert 3 == 4" },
			},
		],
	});
	expect(results[0]?.failure).toEqual({
		message: "E assert 3 == 4",
		detail: "self = <TestCart object>\n\nE assert 3 == 4",
	});
});

test("Jest Windows paths use the report root before the CLI root", () => {
	const report = jestReport();
	const suite = report.testResults[0];
	if (!suite) throw new Error("missing suite");
	suite.name = "C:\\Users\\robin\\project\\tests\\sample.js";
	const { results } = parseReport(JSON.stringify({ ...report, rootDir: "C:/Users/robin/project" }), {
		file: "report.json",
		rootDir: "/elsewhere",
	});
	expect(results[0]?.test).toEqual({
		key: "tests/sample.js::math::adds @C-1@v2",
		file: "tests/sample.js",
		name: "adds @C-1@v2",
	});
});

test.each([
	["/home/robin/project/tests/a.js", "/home/robin/other", "outside root"],
	["/home/robin", "/home/robin/project", "outside root"],
	["../tests/a.js", "/home/robin/project", "outside root"],
	["tests/../../a.js", "/home/robin/project", "outside root"],
	["C:/Users/robin/repo/tests/a.js", "C:/Users/robin/other", "outside root"],
	["D:/repo/tests/a.js", "C:/repo", "source path and root must be on the same drive"],
	["//server/share/repo/tests/a.js", "C:/repo", "source path and root must be on the same drive"],
	["/home/robin/project/tests/a.js", "C:/repo", "source path and root must be on the same drive"],
	["/home/robin/project/tests/a.js", "relative/root", "root must be absolute"],
	["C:/repo/tests/a.js", "C:repo", "root must be absolute"],
	["/home/robin/project/tests/a.js", "/", "filesystem root"],
	["/home/robin/project/tests/a.js", "/project/..", "filesystem root"],
	["C:/repo/tests/a.js", "C:/", "filesystem root"],
	["//server/share/tests/a.js", "//server/share/", "filesystem root"],
])("Jest refuses source %s with root %s", (name, rootDir, reason) => {
	const report = jestReport();
	const suite = report.testResults[0];
	if (!suite) throw new Error("missing suite");
	suite.name = name;
	expect(() =>
		parseReport(JSON.stringify({ ...report, rootDir }), { file: "refused.json", rootDir: "/valid/cli/root" }),
	).toThrow(`refused.json: Jest/Vitest ${reason}: ${rootDir}`);
});

test.each([
	["c:\\WORK\\repo\\tests\\sample.js", "C:/work/repo"],
	["\\\\server\\share\\repo\\tests\\sample.js", "//server/share/repo"],
])("Jest keeps contained Windows source %s relative to %s", (name, rootDir) => {
	const report = jestReport();
	const suite = report.testResults[0];
	if (!suite) throw new Error("missing suite");
	suite.name = name;
	expect(parseReport(JSON.stringify({ ...report, rootDir }), { file: "windows.json" }).results[0]?.test).toEqual({
		key: "tests/sample.js::math::adds @C-1@v2",
		file: "tests/sample.js",
		name: "adds @C-1@v2",
	});
});

test.each(["jest", "vitest"] as const)("real %s report refuses a source outside the CLI root", async (format) => {
	const text = await fixture(`real-${format}.json`);
	expect(() => parseReport(text, { file: "other-checkout.json", rootDir: "/home/robin/other" })).toThrow(
		"other-checkout.json: Jest/Vitest outside root: /home/robin/other",
	);
});
