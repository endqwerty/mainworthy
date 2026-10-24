import { describe, expect, test } from "bun:test";
import { budget } from "../../../scripts/budget.ts";
import { ResultIn } from "../../core/ops.ts";
import { parseJUnit } from "./junit.ts";

function result(
	key: string,
	name: string,
	outcome: ResultIn["outcome"] = "pass",
	fields: Omit<ResultIn, "test" | "outcome"> & { file?: string } = {},
): ResultIn {
	const { file, ...rest } = fields;
	return { test: { key, name, ...(file === undefined ? {} : { file }) }, outcome, ...rest };
}

describe("JUnit parsing performance", () => {
	test("does not rescan large logs for each warning", () => {
		const xml = `<testsuite><system-out>${"x".repeat(2_000_000)}</system-out>${'<testcase name="one" time=""/>'.repeat(5000)}</testsuite>`;
		const start = performance.now();
		const parsed = parseJUnit(xml);
		budget("JUnit 2 MB log and 5000 warning cases: parse elapsed", performance.now() - start, 500, "ms");
		expect(parsed.results).toHaveLength(5000);
		expect(parsed.warnings).toHaveLength(1001);
		expect(parsed.warnings.at(-1)).toContain("4000 additional warnings omitted");
	});

	test("strips stacked retry markers without slow matching on long whitespace", () => {
		const start = performance.now();
		const parsed = parseJUnit(
			`<testsuite><testcase name="${" ".repeat(80_000)}x"/><testcase name="works (retry 1) [retry #2]"/></testsuite>`,
		);
		budget("JUnit 80000-space name and stacked retry markers: parse elapsed", performance.now() - start, 500, "ms");
		expect(parsed.results[1]).toEqual(result("works", "works (retry 1) [retry #2]"));
	});

	test("retry parsing stays bounded inside malformed and repeated markers", () => {
		const start = performance.now();
		const parsed = parseJUnit(
			`<testsuite><testcase name="t (retry${" ".repeat(80_000)}x"/><testcase name="works${" (retry 1)".repeat(10_000)}"/></testsuite>`,
		);
		budget("JUnit malformed and 10000 repeated retry markers: parse elapsed", performance.now() - start, 500, "ms");
		expect(parsed.results[1]?.test).toEqual({
			key: "works",
			name: `works${" (retry 1)".repeat(10_000)}`.slice(0, 500),
		});
	});

	test("unmatched closing tags do not repeatedly scan the element stack", () => {
		const start = performance.now();
		const parsed = parseJUnit("<a>".repeat(20_000) + "</b>".repeat(20_000));
		budget("JUnit 20000 unmatched closing tags: parse elapsed", performance.now() - start, 500, "ms");
		expect(parsed.results).toEqual([]);
		expect(parsed.warnings.length).toBeLessThanOrEqual(1001);
	});

	test("nested suite errors invalidate each recovered result once", () => {
		const xml = `${"<testsuite><error/>".repeat(12_000)}${'<testcase name="one"/>'.repeat(12_000)}${"</testsuite>".repeat(12_000)}`;
		const start = performance.now();
		const parsed = parseJUnit(xml);
		budget(
			"JUnit 12000 nested suite errors and recovered results: parse elapsed",
			performance.now() - start,
			500,
			"ms",
		);
		expect(parsed.results).toHaveLength(12_000);
		expect(parsed.results.every((item) => item.outcome === "error")).toBe(true);
	});

	test("deep paths with large suite names do not repeatedly hash ancestors", () => {
		const xml = `${Array.from({ length: 4000 }, (_, index) => `<testsuite name="${"s".repeat(500)}"><testcase name="case ${index}"/>`).join("")}${"</testsuite>".repeat(4000)}`;
		const start = performance.now();
		const parsed = parseJUnit(xml);
		budget("JUnit 4000 deep paths with 500-character suite names: parse elapsed", performance.now() - start, 500, "ms");
		expect(parsed.results).toHaveLength(4000);
		expect(parsed.results.every((item) => ResultIn.safeParse(item).success)).toBe(true);
		expect(new Set(parsed.results.map((item) => ("key" in item.test ? item.test.key : ""))).size).toBe(4000);
	});

	test("a large inherited file is not copied in full for every displayed key", () => {
		const file = `${"f".repeat(982)}🦊${"x".repeat(2_000_000)}`;
		const cases = Array.from({ length: 4000 }, (_, index) => `<testcase name="case ${index}"/>`).join("");
		const xml = `<testsuite file="${file}">${cases}</testsuite>`;
		const start = performance.now();
		const parsed = parseJUnit(xml);
		budget("JUnit 4000 cases inheriting a 2 MB file: parse elapsed", performance.now() - start, 500, "ms");
		expect(parsed.results).toHaveLength(4000);
		expect(parsed.results[0]).toMatchObject({
			test: { name: "case 0", file: "f".repeat(500) },
			outcome: "pass",
		});
		const keys = parsed.results.map((item) => ("key" in item.test ? item.test.key : ""));
		expect(keys[0]?.split("#")[0]).toBe("f".repeat(982));
		expect(keys[0]).toHaveLength(999);
		expect(new Set(keys).size).toBe(4000);
	});

	test("records parsing time for 10,000 cases and 200 failures", () => {
		const body = "stack trace line\n".repeat(25).slice(0, 400);
		const cases = Array.from(
			{ length: 10_000 },
			(_, index) =>
				`<testcase name="parameterised test ${index} [sample input ${index}]" classname="example.application.checkout.CheckoutIntegrationTest" file="tests/integration/checkout/checkout-with-coupons-and-tax.spec.ts" time="0.012">${index % 50 === 0 ? `<failure message="expected 90, received 100">${body}</failure>` : ""}</testcase>`,
		).join("");
		const xml = `<testsuites><testsuite name="checkout">${cases}</testsuite></testsuites>`;
		parseJUnit(xml);
		const times: number[] = [];
		for (let run = 0; run < 10; run++) {
			const start = performance.now();
			const parsed = parseJUnit(xml);
			times.push(performance.now() - start);
			expect(parsed.results).toHaveLength(10_000);
			expect(parsed.results.filter((item) => item.outcome === "fail")).toHaveLength(200);
			expect(parsed.warnings).toEqual([]);
			expect(parsed.results[0]?.failure?.detail).toHaveLength(400);
		}
		times.sort((a, b) => a - b);
		const median = ((times[4] ?? 0) + (times[5] ?? 0)) / 2;
		console.log(
			`JUnit benchmark: ${xml.length} bytes, median ${median.toFixed(2)} ms of 10 runs, range ${times[0]?.toFixed(2)}–${times[9]?.toFixed(2)} ms`,
		);
		budget("JUnit 10000 cases and 200 failures: parse median of 10 runs", median, 300, "ms");
	});
});
