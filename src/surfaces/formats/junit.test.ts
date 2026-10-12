import { describe, expect, test } from "bun:test";
import { ResultIn } from "../../core/ops.ts";
import { parseJUnit } from "./junit.ts";

const fixtureDirectory = new URL("../../../test/fixtures/junit/", import.meta.url);

function result(
	key: string,
	name: string,
	outcome: ResultIn["outcome"] = "pass",
	fields: Omit<ResultIn, "test" | "outcome"> & { file?: string } = {},
): ResultIn {
	const { file, ...rest } = fields;
	return { test: { key, name, ...(file === undefined ? {} : { file }) }, outcome, ...rest };
}

const fixtures: { file: string; suites: number; results: ResultIn[] }[] = [
	{
		file: "playwright.xml",
		suites: 1,
		results: [
			result("tests/checkout.spec.ts::chromium::applies coupon @C-311@v7", "applies coupon @C-311@v7", "pass", {
				file: "tests/checkout.spec.ts",
				durationMs: 123,
				annotation: { case: "C-311", version: 7 },
			}),
			result("tests/checkout.spec.ts::chromium::rejects expired coupon", "rejects expired coupon", "fail", {
				file: "tests/checkout.spec.ts",
				durationMs: 1250,
				failure: {
					message: "Expected <90>, got 100",
					detail: "Error: total mismatch\n    at tests/checkout.spec.ts:42:3",
				},
			}),
		],
	},
	{
		file: "jest-junit.xml",
		suites: 1,
		results: [
			result("cart.spec::cart::adds [1, 2]", "adds [1, 2]", "fail", {
				durationMs: 5,
				failure: { message: "wrong sum", detail: "AssertionError: 4 != 3" },
			}),
			result("cart.spec::cart::adds [1, 2]", "adds [1, 2] (retry 1)", "pass", { durationMs: 2 }),
			result("cart.spec::cart::adds [1, 2]", "adds [1, 2] [retry #2]", "pass", { durationMs: 3 }),
		],
	},
	{
		file: "vitest.xml",
		suites: 1,
		results: [
			result("math.test.ts::math.test.ts::adds @C-310", "adds @C-310", "pass", {
				durationMs: 1,
				annotation: { case: "C-311", version: 7 },
			}),
			result("math.test.ts::math.test.ts::todo", "todo", "skip", { durationMs: 0 }),
		],
	},
	{
		file: "pytest.xml",
		suites: 1,
		results: [
			result("tests/test_cart.py::pytest::test_x[param] @C-42", "test_x[param] @C-42", "pass", {
				file: "tests/test_cart.py",
				durationMs: 15,
				annotation: { case: "C-42" },
			}),
			result("tests/test_cart.py::pytest::test_optional", "test_optional", "skip", {
				file: "tests/test_cart.py",
				durationMs: 1,
			}),
		],
	},
	{
		file: "surefire.xml",
		suites: 1,
		results: [
			result("com.acme.CartTest::com.acme.CartTest::eventuallyPasses", "eventuallyPasses", "pass", {
				durationMs: 10,
				note: "passed after 2 retries",
			}),
			result("com.acme.CartTest::com.acme.CartTest::rerunsThenPasses", "rerunsThenPasses", "pass", {
				note: "passed after 1 retries",
			}),
			result("com.acme.CartTest::com.acme.CartTest::stillFails", "stillFails", "fail", {
				failure: { message: "final failure", detail: "stack" },
			}),
		],
	},
	{
		file: "gradle.xml",
		suites: 1,
		results: [
			result("com.acme.CheckoutTest::com.acme.CheckoutTest::checkoutWorks", "checkoutWorks", "fail", {
				durationMs: 100,
				failure: {
					message: "Expected successful checkout",
					detail: "\nExpected successful checkout\nat com.acme.CheckoutTest.checkoutWorks(CheckoutTest.java:19)",
				},
			}),
		],
	},
	{
		file: "gotestsum.xml",
		suites: 1,
		results: [
			result("example.com/acme/cart::example.com/acme/cart::TestCart/adds_item", "TestCart/adds_item", "pass", {
				durationMs: 2,
			}),
			result("example.com/acme/cart::example.com/acme/cart::TestNetwork", "TestNetwork", "skip", { durationMs: 0 }),
		],
	},
	{
		file: "go-junit-report.xml",
		suites: 1,
		results: [
			result("example.com/acme/tax::example.com/acme/tax::TestTax/US/CA", "TestTax/US/CA", "fail", {
				durationMs: 4,
				failure: { message: "", detail: "tax_test.go:20: wrong rate" },
			}),
		],
	},
	{
		file: "phpunit.xml",
		suites: 3,
		results: [
			result(
				"tests/Feature/CartTest.php::All::Feature::CartTest::testCoupon with data set #0",
				"testCoupon with data set #0",
				"pass",
				{ file: "tests/Feature/CartTest.php", durationMs: 20 },
			),
			result("tests/Feature/PaymentsTest.php::All::Feature::CartTest::testPayments", "testPayments", "error", {
				file: "tests/Feature/PaymentsTest.php",
				durationMs: 100,
				failure: { message: "Database unavailable", detail: "PDOException: refused" },
			}),
		],
	},
	{
		file: "rspec.xml",
		suites: 1,
		results: [
			result("spec/cart_spec.rb::spec.cart::handles 'quotes' & tax", "handles 'quotes' & tax", "pass", {
				file: "spec/cart_spec.rb",
				durationMs: 7,
			}),
			result("spec/cart_spec.rb::spec.cart::pending example", "pending example", "skip", { file: "spec/cart_spec.rb" }),
		],
	},
	{
		file: "dotnet.xml",
		suites: 1,
		results: [
			result("Acme.Tests.CartTests::Acme.Tests::AddsItems(1,2)", "AddsItems(1,2)", "pass", { durationMs: 8 }),
			result("Acme.Tests.CartTests::Acme.Tests::Disabled", "Disabled", "skip"),
			result("Acme.Tests.CartTests::Acme.Tests::NotRun", "NotRun", "skip"),
			result("Acme.Tests.CartTests::Acme.Tests::Unavailable", "Unavailable", "error", {
				failure: {
					message: "System.InvalidOperationException: host unavailable",
					detail: "System.InvalidOperationException: host unavailable\n  at Acme.Tests.CartTests.Unavailable()",
				},
			}),
		],
	},
	{
		file: "xml-features.xml",
		suites: 2,
		results: [
			result("tests/xml.spec.ts::outer::inner::AA 🚀 \"x\" <x> & 'x'", "AA 🚀 \"x\" <x> & 'x'", "pass", {
				file: "tests/xml.spec.ts",
				durationMs: 0,
			}),
			result("tests/xml.spec.ts::outer::inner::CDATA", "CDATA", "fail", {
				file: "tests/xml.spec.ts",
				failure: { message: "first <literal> &amp; line", detail: "\nfirst <literal> &amp; line\nsecond line" },
			}),
		],
	},
];

describe("parseJUnit runner fixtures", () => {
	for (const fixture of fixtures) {
		test(fixture.file, async () => {
			const xml = await Bun.file(new URL(fixture.file, fixtureDirectory)).text();
			const parsed = parseJUnit(xml, { file: fixture.file });
			expect(parsed).toEqual({ results: fixture.results, suites: fixture.suites, warnings: [] });
			for (const item of parsed.results) expect(ResultIn.safeParse(item).success).toBe(true);
		});
	}
});

describe("parseJUnit recovery and boundaries", () => {
	test.each(["", "  \uFEFF  ", "not XML", '{"tests":[]}'])("empty/non-XML %j", (xml) => {
		const parsed = parseJUnit(xml);
		expect(parsed.results).toEqual([]);
		expect(parsed.suites).toBe(0);
		expect(parsed.warnings).toHaveLength(1);
		expect(parsed.warnings[0]).toMatch(/byte offset \d+/);
	});

	test("recovers completed and unfinished cases, with a UTF-8 byte offset", () => {
		const xml = '<testsuite name="é"><testcase name="done"/><testcase name="broken"><failure>oh no';
		const parsed = parseJUnit(xml, { file: "broken.xml" });
		expect(parsed.results).toEqual([
			result("é::done", "done"),
			result("é::broken", "broken", "fail", { failure: { message: "oh no", detail: "oh no" } }),
		]);
		expect(
			parsed.warnings.some((warning) => warning.includes(`byte offset ${new TextEncoder().encode(xml).length}`)),
		).toBe(true);
		expect(parsed.warnings[0]).toContain("broken.xml");
	});

	test.each([
		'<testsuite name="s"><testcase name="a"/><testcase name="b">',
		'<testsuite name="s"><testcase name="a"/><testcase name="b"><failure mess',
		'<testsuite name="s"><testcase name="a"/><testcase name="b"><failure message="5" wide">stack</failure>',
		'<testsuite name="s"><testcase name="a"/><testcase name="b"><failure<other/></testcase></testsuite>',
		'<testsuite name="s"><testcase name="a"/><testcase name="b"></testsuite>',
	])("never turns incomplete testcases into passing evidence: %s", (xml) => {
		const parsed = parseJUnit(xml);
		expect(parsed.results[0]?.outcome).toBe("pass");
		expect(parsed.results[1]?.outcome).toBe("error");
		expect(parsed.warnings.length).toBeGreaterThan(0);
		for (const item of parsed.results) expect(ResultIn.safeParse(item).success).toBe(true);
	});

	test("does not rescan large logs for each warning", () => {
		const xml = `<testsuite><system-out>${"x".repeat(2_000_000)}</system-out>${'<testcase name="one" time=""/>'.repeat(5000)}</testsuite>`;
		const start = performance.now();
		const parsed = parseJUnit(xml);
		expect(performance.now() - start).toBeLessThan(500);
		expect(parsed.results).toHaveLength(5000);
		expect(parsed.warnings).toHaveLength(1001);
		expect(parsed.warnings.at(-1)).toContain("4000 additional warnings omitted");
	});

	test("strips stacked retry markers without slow matching on long whitespace", () => {
		const start = performance.now();
		const parsed = parseJUnit(
			`<testsuite><testcase name="${" ".repeat(80_000)}x"/><testcase name="works (retry 1) [retry #2]"/></testsuite>`,
		);
		expect(performance.now() - start).toBeLessThan(500);
		expect(parsed.results[1]).toEqual(result("works", "works (retry 1) [retry #2]"));
	});

	test("Surefire retry errors are flaky signals, too", () => {
		expect(parseJUnit('<testsuite><testcase name="one"><flakyError/><rerunError/></testcase></testsuite>')).toEqual({
			results: [result("one", "one", "pass", { note: "passed after 2 retries" })],
			suites: 1,
			warnings: [],
		});
	});

	test.each([
		'<!<failure message="boom"/>',
		'<!failure message="boom"/>',
		'<!DOCTYPE x [ <failure message="boom"/> ]>',
	])("a declaration inside a testcase cannot swallow a failure: %s", (declaration) => {
		const parsed = parseJUnit(`<testsuite><testcase name="one">${declaration}</testcase></testsuite>`);
		expect(parsed.results[0]?.outcome).toBe("error");
		expect(parsed.warnings.length).toBeGreaterThan(0);
	});

	test("does not drop a failure after a prematurely closed testcase", () => {
		const parsed = parseJUnit(
			'<testsuite><testcase name="one"/><failure message="boom">stack</failure></testcase></testsuite>',
		);
		expect(parsed.results[0]?.outcome).toBe("fail");
		expect(parsed.results[0]?.failure).toEqual({ message: "boom", detail: "stack" });
		expect(parsed.warnings.length).toBeGreaterThan(0);
	});

	test("suite setup errors affect the cases the suite could not run", () => {
		const parsed = parseJUnit(
			'<testsuite name="s"><error message="beforeAll failed">setup stack</error><testcase name="one"/><testcase name="two"/></testsuite>',
		);
		expect(parsed.results.map((item) => item.outcome)).toEqual(["error", "error"]);
		expect(parsed.results[0]?.failure).toEqual({ message: "beforeAll failed", detail: "setup stack" });
		expect(parsed.warnings.length).toBeGreaterThan(0);
	});

	test("damage outside a testcase makes recovered evidence uncertain", () => {
		const parsed = parseJUnit(
			'<testsuite name="s" foo="bar><testcase name="a><failure/></testcase><testcase name=\'b\'/></testsuite>',
		);
		expect(parsed.results).toHaveLength(1);
		expect(parsed.results[0]?.outcome).toBe("error");
		expect(parsed.warnings.length).toBeGreaterThan(0);
	});

	test("retry parsing stays bounded inside malformed and repeated markers", () => {
		const start = performance.now();
		const parsed = parseJUnit(
			`<testsuite><testcase name="t (retry${" ".repeat(80_000)}x"/><testcase name="works${" (retry 1)".repeat(10_000)}"/></testsuite>`,
		);
		expect(performance.now() - start).toBeLessThan(500);
		expect(parsed.results[1]?.test).toEqual({
			key: "works",
			name: `works${" (retry 1)".repeat(10_000)}`.slice(0, 500),
		});
	});

	test("unmatched closing tags do not repeatedly scan the element stack", () => {
		const start = performance.now();
		const parsed = parseJUnit("<a>".repeat(20_000) + "</b>".repeat(20_000));
		expect(performance.now() - start).toBeLessThan(500);
		expect(parsed.results).toEqual([]);
		expect(parsed.warnings.length).toBeLessThanOrEqual(1001);
	});

	test("deep suite paths stay stable within the key limit", () => {
		const parsed = parseJUnit(
			`${'<testsuite name="s">'.repeat(4000)}<testcase name="deep"/>${"</testsuite>".repeat(4000)}`,
		);
		expect(parsed.suites).toBe(4000);
		expect(parsed.results).toHaveLength(1);
		const item = ResultIn.parse(parsed.results[0]);
		expect("key" in item.test && item.test.key.length === 1000).toBe(true);
		expect(item.outcome).toBe("pass");
	});

	test.each([
		'<testsuite><testcase name="one"></testsuite>',
		'<testsuite><testcase name="one" time=nope/></testsuite>',
		'<testsuite><testcase name="one"/><!----',
		'<testsuite><testcase name="one"><failure><![CDATA[unfinished',
		'<testsuite><testcase name="one"/><testcase name="unterminated',
		'<testsuite><testcase name="one &unknown; &#x110000;"/></testsuite>',
	])("malformed XML never throws: %s", (xml) => {
		const parsed = parseJUnit(xml);
		expect(parsed.warnings.length).toBeGreaterThan(0);
		for (const item of parsed.results) expect(ResultIn.safeParse(item).success).toBe(true);
	});

	test("every truncated prefix is safe", () => {
		const xml =
			'<testsuites><testsuite name="s"><testcase name="a"><failure message="m">é&amp;🦊</failure></testcase></testsuite></testsuites>';
		for (let end = 0; end <= xml.length; end++) {
			const parsed = parseJUnit(xml.slice(0, end));
			for (const item of parsed.results) expect(ResultIn.safeParse(item).success).toBe(true);
		}
	});

	test.each([
		'<testsuites bad=unquoted><testsuite><testcase name="one"/></testsuite></testsuites>',
		'<testsuite><testcase name="one"classname="c"/></testsuite>',
		'<testsuite><testcase name="one" vendor="&unsupported;"/></testsuite>',
		'<testsuite><testcase name="one" vendor="x" vendor="y"/></testsuite>',
		'<testsuite><testcase name="one" vendor="raw < value"/></testsuite>',
	])("warns about malformed attributes while recovering the testcase: %s", (xml) => {
		const parsed = parseJUnit(xml);
		expect(parsed.results).toHaveLength(1);
		expect(parsed.warnings.length).toBeGreaterThan(0);
		for (const warning of parsed.warnings) expect(warning).toMatch(/byte offset \d+/);
	});

	test("honours limits, retains a first-line message, and omits invalid durations", () => {
		const message = "m".repeat(5000);
		const detail = "s".repeat(25_000);
		const xml = `<testsuite name="s"><testcase name="${"n".repeat(1500)}" file="${"f".repeat(700)}" time="NaN"><failure message="${message}">${detail}</failure></testcase></testsuite>`;
		const parsed = parseJUnit(xml);
		const item = parsed.results[0];
		expect(item?.failure?.message).toHaveLength(4000);
		expect(item?.failure?.detail).toHaveLength(20_000);
		expect(item?.durationMs).toBeUndefined();
		expect(ResultIn.safeParse(item).success).toBe(true);
		expect(parsed.warnings.length).toBeGreaterThan(0);
	});

	test("uses error before failure before skip when a malformed report contains all three", () => {
		const parsed = parseJUnit(
			'<testsuite><testcase name="one" status="skipped"><failure message="fail"/><error message="error"/><skipped/></testcase></testsuite>',
		);
		expect(parsed.results).toEqual([result("one", "one", "error", { failure: { message: "error", detail: "" } })]);
	});

	test("ignores testcase-looking content in logs and metadata", () => {
		const parsed = parseJUnit(
			'<testsuite name="s"><properties><testcase name="fake"/></properties><system-out><![CDATA[<testcase name="fake"/>]]></system-out><testcase name="real"><system-err><testcase name="fake"/></system-err></testcase></testsuite>',
		);
		expect(parsed).toEqual({ results: [result("s::real", "real")], suites: 1, warnings: [] });
	});

	test("handles quoted >, processing instructions, namespaces and a doctype without entity expansion", () => {
		const parsed = parseJUnit(
			'<?xml version="1.0"?><!DOCTYPE testsuite [<!ELEMENT testsuite ANY>]><j:testsuite xmlns:j="urn:junit" name="s"><j:testcase name="x > y"/></j:testsuite>',
		);
		expect(parsed).toEqual({ results: [result("s::x > y", "x > y")], suites: 1, warnings: [] });
	});

	test("does not treat report filenames as test source files", () => {
		expect(parseJUnit('<testsuite><testcase name="test"/></testsuite>', { file: "report.xml" }).results).toEqual([
			result("test", "test"),
		]);
	});

	test("10,000 cases and 200 failures parse within the budget", () => {
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
		expect(median).toBeLessThan(300);
	});
});
