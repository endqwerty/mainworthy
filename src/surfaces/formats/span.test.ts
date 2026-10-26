import { describe, expect, test } from "bun:test";
import { parseReport } from "./report.ts";
import { joinSpans } from "./span.ts";

// What a report says about when its tests started and ended (issue #722). A span is read only where the format's
// timing is unambiguous; anything else leaves it out and keeps the results.

const directory = new URL("../../../test/fixtures/reports/", import.meta.url);
const fixture = async (name: string) => await Bun.file(new URL(name, directory)).text();
const junit = (body: string) => parseReport(body, { file: "report.xml", format: "junit" });
const testcase = '<testcase name="adds" classname="cart" time="0.5"/>';

describe("a report's span", () => {
	test("Playwright JSON: its stats' start and duration", async () => {
		const parsed = parseReport(await fixture("real-playwright.json"), { file: "report.json" });
		const startedAt = Date.parse("2026-10-15T05:07:32.255Z");
		expect(parsed.span).toEqual({ startedAt, endedAt: startedAt + 2030 });
	});

	test("Jest and Vitest JSON: the run's start to the last file's end", async () => {
		const jest = parseReport(await fixture("real-jest.json"), { file: "report.json", rootDir: "/home/robin/project" });
		expect(jest.span).toEqual({ startedAt: 1792040850012, endedAt: 1792040850412 });
		const vitest = parseReport(await fixture("real-vitest.json"), {
			file: "report.json",
			rootDir: "/home/robin/project",
		});
		expect(vitest.span).toEqual({ startedAt: 1792040851216, endedAt: 1792040851715 });
	});

	test("Jest JSON with a file that names no end has none, and keeps its results", async () => {
		const report = JSON.parse(await fixture("real-jest.json"));
		delete report.testResults[0].endTime;
		const parsed = parseReport(JSON.stringify(report), { file: "report.json", rootDir: "/home/robin/project" });
		expect(parsed.span).toBeUndefined();
		expect(parsed.results.length).toBeGreaterThan(0);
		expect(parsed.warnings.filter((line) => line.includes("span"))).toEqual([]);
	});

	test("Jest or Vitest JSON with a time that is no time has none, says so once and keeps its results", async () => {
		const options = { file: "report.json", rootDir: "/home/robin/project" };
		for (const [name, change] of [
			[
				"a file's end is no number",
				(report: { testResults: { endTime?: unknown }[] }) => {
					report.testResults[0] = { ...report.testResults[0], endTime: "later" };
				},
			],
			// The verifier's finding: an unusable run start fell back to the files' starts and still gave a span.
			[
				"the run's start is negative",
				(report: { startTime?: unknown }) => {
					report.startTime = -1;
				},
			],
		] as const) {
			const report = JSON.parse(await fixture("real-jest.json"));
			change(report);
			const parsed = parseReport(JSON.stringify(report), options);
			expect([name, parsed.span]).toEqual([name, undefined]);
			expect(parsed.results.length).toBeGreaterThan(0);
			expect([name, parsed.warnings.filter((line) => line.includes("span")).length]).toEqual([name, 1]);
		}
	});

	test("a date that is no date in the calendar gives no span (the verifier's finding)", async () => {
		const parsed = junit(`<testsuite name="a" timestamp="2026-02-30T00:00:00Z" time="1">${testcase}</testsuite>`);
		expect(parsed.span).toBeUndefined();
		expect(parsed.results).toHaveLength(1);
		expect(parsed.warnings.filter((line) => line.includes("span"))).toHaveLength(1);
		for (const time of [
			"2026-02-30T00:00:00Z",
			"2026-10-11T24:00:00Z",
			"2026-10-11T12:60:00Z",
			"2026-10-11T12:00:00+25:00",
		]) {
			const report = JSON.parse(await fixture("real-playwright.json"));
			report.stats.startTime = time;
			expect([time, parseReport(JSON.stringify(report), { file: "report.json" }).span]).toEqual([time, undefined]);
		}
	});

	test("Playwright JSON whose stats are unusable has none, says so once and keeps its results", async () => {
		const report = JSON.parse(await fixture("real-playwright.json"));
		report.stats.startTime = "yesterday";
		const parsed = parseReport(JSON.stringify(report), { file: "report.json" });
		expect(parsed.span).toBeUndefined();
		expect(parsed.results.length).toBeGreaterThan(0);
		expect(parsed.warnings.filter((line) => line.includes("span"))).toHaveLength(1);
	});

	test("pytest JSON and TRX have none: their timing is not yet checked against a runner", async () => {
		expect(parseReport(await fixture("real-pytest.json"), { file: "report.json" }).span).toBeUndefined();
		expect(parseReport(await fixture("sample.trx"), { file: "sample.trx" }).span).toBeUndefined();
	});

	test("JUnit: the earliest start to the latest end of its outermost suites, each with a zone", () => {
		const parsed = junit(
			`<testsuites>
				<testsuite name="a" timestamp="2026-10-11T00:00:00Z" time="1.5">${testcase}</testsuite>
				<testsuite name="b" timestamp="2026-10-11T01:59:59.000+02:00" time="2">${testcase}</testsuite>
			</testsuites>`,
		);
		expect(parsed.span).toEqual({
			startedAt: Date.parse("2026-10-10T23:59:59Z"),
			endedAt: Date.parse("2026-10-11T00:00:01.500Z"),
		});
	});

	test("JUnit: a nested suite is inside its parent's span and is not counted twice", () => {
		const parsed = junit(
			`<testsuite name="outer" timestamp="2026-10-11T00:00:00Z" time="10">
				<testsuite name="inner" timestamp="2026-10-11T00:00:30Z" time="40">${testcase}</testsuite>
			</testsuite>`,
		);
		expect(parsed.span).toEqual({
			startedAt: Date.parse("2026-10-11T00:00:00Z"),
			endedAt: Date.parse("2026-10-11T00:00:10Z"),
		});
	});

	test("JUnit with a timestamp that names no zone has none, and says why once", () => {
		const parsed = junit(
			`<testsuites>
				<testsuite name="a" timestamp="2026-10-11T00:00:00" time="1">${testcase}</testsuite>
				<testsuite name="b" timestamp="2026-10-11T00:00:02" time="1">${testcase}</testsuite>
			</testsuites>`,
		);
		expect(parsed.span).toBeUndefined();
		expect(parsed.results).toHaveLength(2);
		expect(parsed.warnings.filter((line) => line.includes("zone"))).toHaveLength(1);
	});

	test("JUnit where one suite with tests names no time has none", () => {
		const parsed = junit(
			`<testsuites>
				<testsuite name="a" timestamp="2026-10-11T00:00:00Z" time="1">${testcase}</testsuite>
				<testsuite name="b">${testcase}</testsuite>
			</testsuites>`,
		);
		expect(parsed.span).toBeUndefined();
		expect(junit(`<testsuite name="b">${testcase}</testsuite>`).warnings).toEqual([]);
	});

	test("JUnit with a suite duration that is no number has none, and says so", () => {
		const parsed = junit(`<testsuite name="a" timestamp="2026-10-11T00:00:00Z" time="soon">${testcase}</testsuite>`);
		expect(parsed.span).toBeUndefined();
		expect(parsed.results).toHaveLength(1);
		expect(parsed.warnings.filter((line) => line.includes("span"))).toHaveLength(1);
	});
});

describe("the spans of several files sent as one report", () => {
	test("join when every file has one, and are absent when any file has none", () => {
		const a = { startedAt: 100, endedAt: 500 };
		const b = { startedAt: 50, endedAt: 300 };
		expect(joinSpans([a, b])).toEqual({ startedAt: 50, endedAt: 500 });
		expect(joinSpans([a, undefined])).toBeUndefined();
		expect(joinSpans([])).toBeUndefined();
	});
});
