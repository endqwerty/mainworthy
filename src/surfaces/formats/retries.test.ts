import { expect, test } from "bun:test";
import { harness } from "../../../test/helpers.ts";
import type { GateStatus } from "../../core/ops.ts";
import { parseReport, type ReportFormat } from "./report.ts";

const fixture = (format: string) => Bun.file(new URL(`../../../test/fixtures/reports/${format}-retries.json`, import.meta.url)).text();
const options = { file: "retries.json", rootDir: "/workspace" };
const assertion = (extra: Record<string, unknown>) => JSON.stringify({ testResults: [{ name: "test.js", status: "passed", assertionResults: [{ title: "sample", ancestorTitles: [], status: "passed", ...extra }] }] });

test.each(["auto", "jest"] as const)("%s keeps Jest's two earlier failures and final outcome", async (format) => {
	const { results } = parseReport(await fixture("jest"), { ...options, format });
	expect(results.map((result) => [result.outcome, result.tries?.map((tried) => tried.outcome)])).toEqual([
		["pass", ["fail", "fail"]], ["fail", ["fail", "fail"]], ["pass", undefined], ["skip", undefined],
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
	const { results, warnings } = parseReport(assertion({ invocations: 2, retryReasons: ["body failed", "cleanup failed"] }), options);
	expect(results[0]?.tries).toHaveLength(1);
	expect(results[0]?.tries?.[0]?.failure?.detail).not.toContain("cleanup failed");
	expect(warnings.join(" ")).toContain("diagnostics");
});

test.each(["auto", "vitest"] as const)("%s keeps Vitest's retained failures as one observation without inventing an attempt count", async (format) => {
	const { results, warnings } = parseReport(await fixture("vitest"), { ...options, format });
	expect(results.map((result) => result.outcome)).toEqual(["pass", "fail", "pass", "skip"]);
	expect(results[0]?.tries).toHaveLength(1);
	expect(results[0]?.tries?.[0]).toMatchObject({ outcome: "fail", failure: { message: "AssertionError: expected 1 to be 3 // Object.is equality" } });
	expect(results[0]?.tries?.[0]?.failure?.detail).toContain("expected 2 to be 3");
	expect(results[1]?.tries).toBeUndefined();
	expect(results[2]?.tries).toBeUndefined();
	expect(warnings.join(" ")).toContain("count");
});

test("pytest's rerun marker keeps earlier failure evidence and judges its final stages", async () => {
	const { results, warnings } = parseReport(await fixture("pytest"), options);
	expect(results.map((result) => [result.outcome, result.tries?.map((tried) => tried.outcome)])).toEqual([
		["pass", ["fail"]], ["fail", undefined], ["pass", undefined], ["skip", undefined],
	]);
	expect(results[0]?.tries?.[0]?.durationMs).toBeUndefined();
	expect(warnings.join(" ")).toContain("count");
});

test.each(["jest", "vitest", "pytest"] as const)("%s upload stores tries and one recovery flip while the gate counts final outcomes", async (format) => {
	using h = harness({ unlinked: "track" });
	const { results } = parseReport(await fixture(format), { ...options, format });
	h.call("report", { target: { commit: "aabb0736", repo: "acme/web" }, results });
	const page = h.call<{ flips: number; last: { tries: { outcome: string }[] }[] }[]>("get", { refs: ["T-1"] })[0];
	expect(page?.flips).toBe(1);
	expect(page?.last[0]?.tries.map((tried) => tried.outcome)).toEqual(format === "jest" ? ["fail", "fail"] : ["fail"]);
	expect(h.call<GateStatus>("gate", { commit: "aabb0736", repo: "acme/web" }).tally).toMatchObject({ pass: 2, skip: 1, unexplained: 1 });
});

test.each([
	{ invocations: -1 }, { invocations: 1.5 }, { invocations: 102 }, { retryReasons: [42] },
])("malformed or over-limit Jest retry metadata refuses the report: %j", (extra) => {
	expect(() => parseReport(assertion(extra), options)).toThrow("retries.json:");
});
