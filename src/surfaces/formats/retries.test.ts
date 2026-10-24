import { expect, test } from "bun:test";
import { harness } from "../../../test/helpers.ts";
import { SameCodeEvidence } from "../../core/flaky.ts";
import type { GateStatus } from "../../core/ops.ts";
import { normaliseFailure } from "../../core/signature.ts";
import { parseReport } from "./report.ts";

const fixture = (format: string) =>
	Bun.file(new URL(`../../../test/fixtures/reports/${format}-retries.json`, import.meta.url)).text();
const options = { file: "retries.json", rootDir: "/workspace" };
const assertion = (extra: Record<string, unknown>) =>
	JSON.stringify({
		testResults: [
			{
				name: "test.js",
				status: "passed",
				assertionResults: [{ title: "sample", ancestorTitles: [], status: "passed", ...extra }],
			},
		],
	});

test.each(["auto", "jest"] as const)("%s keeps Jest's two earlier failures and final outcome", async (format) => {
	const { results } = parseReport(await fixture("jest"), { ...options, format });
	expect(results.map((result) => [result.outcome, result.tries?.map((tried) => tried.outcome)])).toEqual([
		["pass", ["fail", "fail"]],
		["fail", ["fail", "fail"]],
		["pass", undefined],
		["skip", undefined],
	]);
	expect(results[0]?.tries?.[0]?.failure?.detail).toContain("Received: 1");
	expect(results[0]?.tries?.[1]?.failure?.detail).toContain("Received: 2");
	expect(results[0]?.tries?.[0]?.durationMs).toBeUndefined();
});

test("Jest invocation counts keep failed tries even without logging retry diagnostics", () => {
	const parsed = parseReport(assertion({ invocations: 3, retryReasons: [] }), options);
	expect(parsed.results[0]?.tries?.map((tried) => tried.outcome)).toEqual(["fail", "fail"]);
	expect(parsed.warnings.join(" ")).toContain("diagnostics");
});

test("Jest does not attribute flattened multiple errors to individual tries", () => {
	const { results, warnings } = parseReport(
		assertion({ invocations: 3, retryReasons: ["body failed", "cleanup failed", "second body failed"] }),
		options,
	);
	expect(results[0]?.tries).toHaveLength(2);
	expect(results[0]?.tries).toEqual([{ outcome: "fail" }, { outcome: "fail" }]);
	expect(warnings.join(" ")).toContain("diagnostics");
});

test("all retry reasons belong to the same try when Jest retried only once", () => {
	const { results, warnings } = parseReport(
		assertion({ invocations: 2, retryReasons: ["body failed", "cleanup failed"] }),
		options,
	);
	expect(results[0]?.tries).toEqual([
		{ outcome: "fail", failure: { message: "body failed", detail: "body failed\ncleanup failed" } },
	]);
	expect(warnings).toEqual([]);
});

test.each(["auto", "vitest"] as const)(
	"%s keeps Vitest's retained failures as one observation without inventing an attempt count",
	async (format) => {
		const { results, warnings } = parseReport(await fixture("vitest"), { ...options, format });
		expect(results.map((result) => result.outcome)).toEqual(["pass", "fail", "pass", "skip"]);
		expect(results[0]?.tries).toHaveLength(1);
		expect(results[0]?.tries?.[0]).toMatchObject({
			outcome: "fail",
			failure: { message: "AssertionError: expected 1 to be 3 // Object.is equality" },
		});
		expect(results[0]?.tries?.[0]?.failure?.detail).toContain("expected 2 to be 3");
		expect(results[1]?.tries).toBeUndefined();
		expect(results[2]?.tries).toBeUndefined();
		expect(warnings.join(" ")).toContain("count");
	},
);

test("pytest's rerun marker keeps earlier failure evidence and judges its final stages", async () => {
	const { results, warnings } = parseReport(await fixture("pytest"), options);
	expect(results.map((result) => [result.outcome, result.tries?.map((tried) => tried.outcome)])).toEqual([
		["pass", ["fail"]],
		["fail", undefined],
		["pass", undefined],
		["skip", undefined],
	]);
	expect(results[0]?.tries?.[0]?.durationMs).toBeUndefined();
	expect(warnings.join(" ")).toContain("count");
});

test.each(["jest", "vitest", "pytest"] as const)(
	"%s upload stores tries and one recovery flip while the gate counts final outcomes",
	async (format) => {
		const h = await harness({ unlinked: "track" });
		try {
			const { results } = parseReport(await fixture(format), { ...options, format });
			await h.call("report", { target: { commit: "aabb0736", repo: "acme/web" }, results });
			const page = (
				await h.call<{ flips: number; last: { tries: { outcome: string }[] }[] }[]>("get", { refs: ["T-1"] })
			)[0];
			expect(page?.flips).toBe(1);
			expect(page?.last[0]?.tries.map((tried) => tried.outcome)).toEqual(
				format === "jest" ? ["fail", "fail"] : ["fail"],
			);
			expect((await h.call<GateStatus>("gate", { commit: "aabb0736", repo: "acme/web" })).tally).toMatchObject({
				pass: 2,
				skipped: 1,
				unexplained: 1,
			});
		} finally {
			await h.close();
		}
	},
);

test.each([{ invocations: -1 }, { invocations: 1.5 }, { invocations: 102 }, { retryReasons: [42] }])(
	"malformed or over-limit Jest retry metadata refuses the report: %j",
	(extra) => {
		expect(() => parseReport(assertion(extra), options)).toThrow('"retries.json":');
	},
);

test.each([
	["error", { setup: { outcome: "failed", duration: 0 } }],
	["skip", { setup: { outcome: "skipped", duration: 0 } }],
	["fail", { call: { outcome: "failed", duration: 0 } }],
	["error", { call: { outcome: "passed", duration: 0 }, teardown: { outcome: "failed", duration: 0 } }],
] as const)("pytest's retained rerun marker does not override a final %s", (outcome, stages) => {
	const text = JSON.stringify({ exitcode: 0, tests: [{ nodeid: "test.py::sample", outcome: "rerun", ...stages }] });
	const { results } = parseReport(text, options);
	expect(results[0]?.outcome).toBe(outcome);
	expect(results[0]?.tries?.map((tried) => tried.outcome)).toEqual(["fail"]);
});

test("pytest's rerun marker cannot turn missing or unfinished final stages into a pass", () => {
	for (const stages of [{ setup: { outcome: "passed", duration: 0 } }, { call: { outcome: "rerun", duration: 0 } }]) {
		const text = JSON.stringify({ exitcode: 0, tests: [{ nodeid: "test.py::sample", outcome: "rerun", ...stages }] });
		expect(() => parseReport(text, options)).toThrow('"retries.json":');
	}
});

test("a retry whose diagnostic was lost makes no cause claim in the adapter output", async () => {
	const jest = parseReport(assertion({ invocations: 3, retryReasons: [] }), options);
	const pytest = parseReport(await fixture("pytest"), options);
	expect(jest.results[0]?.tries).toEqual([{ outcome: "fail" }, { outcome: "fail" }]);
	expect(pytest.results[0]?.tries).toEqual([{ outcome: "fail" }]);
});

test.each([
	["jest", assertion({ title: "timeout once", invocations: 2, retryReasons: [] })],
	[
		"pytest",
		JSON.stringify({
			exitcode: 0,
			tests: [{ nodeid: "test.py::test_recovers", outcome: "rerun", call: { outcome: "passed", duration: 0 } }],
		}),
	],
	[
		"playwright",
		JSON.stringify({
			suites: [
				{
					title: "test.js",
					file: "test.js",
					specs: [
						{
							title: "timeout once",
							file: "test.js",
							tests: [
								{
									projectName: "chromium",
									expectedStatus: "passed",
									results: [
										{ status: "failed", duration: 1, retry: 0 },
										{ status: "passed", duration: 1, retry: 1 },
									],
								},
							],
						},
					],
				},
			],
		}),
	],
	["junit", '<testsuite><testcase name="timeout once"><flakyFailure/></testcase></testsuite>'],
] as const)(
	"%s recoveries without diagnostics have an unknown cause and no signature grouping",
	async (format, text) => {
		const h = await harness({ unlinked: "track" });
		try {
			const { results } = parseReport(text, { ...options, format });
			const tried = results[0]?.tries?.[0];
			expect(tried?.outcome).toBe("fail");
			for (const attempt of [1, 2]) {
				await h.call("report", { target: { commit: `unknown773${attempt}`, repo: "acme/web" }, results });
			}
			const page = (await h.call<{ flips: number; sameCode: unknown }[]>("get", { refs: ["T-1"] }))[0];
			expect(page?.flips).toBe(2);
			expect(SameCodeEvidence.parse(page?.sameCode).signals).toEqual([]);
			expect(normaliseFailure({ message: tried?.failure?.message ?? "" }).class).toBe("unknown");
			expect(
				await h.app.database.read((db) => db.allDynamic<Record<string, unknown>>("SELECT class FROM signatures", [])),
			).toEqual([{ class: "unknown" }]);
		} finally {
			await h.close();
		}
	},
);

test.each([
	{
		end: "first",
		tries: [{ outcome: "fail" }, { outcome: "pass" }],
		flips: 2,
		signals: [{ class: "assertion", flips: 1, suggested: false }],
	},
	{ end: "second", tries: [{ outcome: "pass" }, { outcome: "fail" }], flips: 1, signals: [] },
])(
	"an unknown try at the $end end of a flip does not borrow the final failure's cause",
	async ({ tries, flips, signals }) => {
		const h = await harness({ unlinked: "track" });
		try {
			await h.call("report", {
				target: { commit: "unknown774", repo: "acme/web" },
				results: [
					{
						test: { key: "one", name: "timeout once" },
						outcome: "fail",
						failure: { message: "expected 1, got 2" },
						tries,
					},
				],
			});
			const page = (await h.call<{ flips: number; sameCode: unknown }[]>("get", { refs: ["T-1"] }))[0];
			expect(page?.flips).toBe(flips);
			expect(SameCodeEvidence.parse(page?.sameCode).signals).toMatchObject(signals);
		} finally {
			await h.close();
		}
	},
);

const warningReport = (format: "jest" | "vitest" | "pytest", names: string[], file = "tests/sample.js") =>
	format === "pytest"
		? {
				exitcode: 0,
				tests: names.map((name) => ({
					nodeid: `test.py::${name}`,
					outcome: "rerun",
					call: { outcome: "passed", duration: 0 },
				})),
			}
		: {
				testResults: [0, 1].map((part) => ({
					name: file,
					status: "passed",
					assertionResults: names
						.filter((_, index) => index % 2 === part)
						.map((title) => ({
							title,
							ancestorTitles: [],
							status: "passed",
							...(format === "jest"
								? { invocations: 2, retryReasons: [] }
								: { failureMessages: ["failed before recovery"] }),
						})),
				})),
			};

const unsafeIdentifier = "\n::error::report title\u001b]0;report title\u0007\u001b[31m\u0085\u009b\u2028\u2029";
// biome-ignore lint/suspicious/noControlCharactersInRegex: diagnostics must not carry terminal control characters.
const controls = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

test.each(["jest", "vitest", "pytest"] as const)(
	"%s retry warnings escape report-controlled terminal and CI controls",
	(format) => {
		const { warnings } = parseReport(
			JSON.stringify(warningReport(format, [unsafeIdentifier], `tests/${unsafeIdentifier}.js`)),
			options,
		);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).not.toMatch(controls);
		expect(warnings[0]).toContain("\\n::error::report title");
		expect(warnings[0]).toContain("\\u001b");
		expect(warnings[0]).toContain("\\u0085");
		expect(warnings[0]).toContain("\\u009b");
	},
);

test.each(["jest", "vitest", "pytest"] as const)(
	"%s retry warnings cap the whole report, clip identifiers and count omitted warnings once",
	(format) => {
		const names = Array.from({ length: 1007 }, (_, index) => `${index}-${"long name ".repeat(300)}`);
		const { results, warnings } = parseReport(JSON.stringify(warningReport(format, names)), options);
		expect(results).toHaveLength(1007);
		expect(warnings).toHaveLength(1001);
		expect(warnings.at(-1)).toBe("7 additional warnings omitted");
		expect(warnings.every((warning) => warning.length <= 1000)).toBe(true);
		expect(warnings.filter((warning) => warning.includes("warnings omitted"))).toHaveLength(1);
	},
);

test("the invalid Jest retry error escapes its report-controlled identifier", () => {
	let message = "";
	try {
		parseReport(assertion({ title: unsafeIdentifier, invocations: 1, retryReasons: ["reason"] }), options);
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		message = error.message;
	}
	expect(message).toContain("without another invocation");
	expect(message).not.toMatch(controls);
	expect(message).toContain("\\n::error::report title");
});
