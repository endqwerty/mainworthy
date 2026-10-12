import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { parseOutline, splitExpected } from "./outline.ts";

describe("capture grammar", () => {
	test("keeps the tail of a malformed table ending in an escaped pipe", () => {
		const result = parseOutline("| open | see | c \\|");
		expect(
			[result.title ?? "", ...result.steps.map((step) => `${step.action} ${step.expected ?? ""}`)].join(" "),
		).toContain("c");
	});
	test("drops a numeric table column even without an expectation column", () => {
		expect(parseOutline("| 1 | Open |").steps).toEqual([{ action: "Open", expected: null }]);
	});
	test("a prefixed line without a preceding step stays action text", () => {
		expect(parseOutline("- Expected: literal").steps).toEqual([{ action: "Expected: literal", expected: null }]);
	});
	test.each(["-", "*", "+", "•", "1.", "1)", "(1)", "a.", "[ ]", "[x]", "Step 3:"])("strips %s", (marker) => {
		expect(parseOutline(`${marker} Open cart`).steps).toEqual([{ action: "Open cart", expected: null }]);
	});
	test.each([" > ", " => ", " -> ", " → ", " Expected:", " Expected result:", " Expect:", " Then:"])(
		"splits %s",
		(delimiter) =>
			expect(splitExpected(`Open cart${delimiter} Ready`)).toEqual({ action: "Open cart", expected: "Ready" }),
	);
	test("chooses the first delimiter, case-insensitively", () => {
		expect(splitExpected("Open EXPECTED RESULT: Ready > Later")).toEqual({ action: "Open", expected: "Ready > Later" });
		expect(splitExpected("Unexpected: text")).toEqual({ action: "Unexpected: text", expected: null });
		expect(splitExpected("  untouched  ")).toEqual({ action: "  untouched  ", expected: null });
	});
	test("detects a title, tags and requirements only in the title", () => {
		expect(parseOutline("Checkout #checkout @REQ-12 daniel@example.com\n  Open #123 > Ready\n  Reload")).toEqual({
			title: "Checkout daniel@example.com",
			tags: ["checkout"],
			covers: ["REQ-12"],
			steps: [
				{ action: "Open #123", expected: "Ready" },
				{ action: "Reload", expected: null },
			],
		});
	});
	test("requires every later line to be indented or marked for an implicit title", () => {
		expect(parseOutline("Open\nReload").title).toBeNull();
		expect(parseOutline("## A title\nOpen\nReload").title).toBe("A title");
		expect(parseOutline("A title").title).toBe("A title");
		expect(parseOutline("  Open").steps).toEqual([{ action: "Open", expected: null }]);
	});
	test("joins deeper and explicitly prefixed expected lines", () => {
		expect(
			parseOutline("- Open > Ready\n  Still ready\n> And ready\nExpected: Visible\n- Reload\n  Then: Ready").steps,
		).toEqual([
			{ action: "Open", expected: "Ready\nStill ready\nAnd ready\nVisible" },
			{ action: "Reload", expected: "Ready" },
		]);
	});
	test("does not discard an orphaned continuation prefix", () => {
		expect(parseOutline("> Read this\n- Do it").title).toBe("> Read this");
		expect(parseOutline("  > Read this").steps).toEqual([{ action: "> Read this", expected: null }]);
	});
	test("reads spreadsheet rows, including empty expectations and extra columns", () => {
		expect(parseOutline("Open\tReady\nReload\tStill ready\nDone\t\nExtra\tone\ttwo").steps).toEqual([
			{ action: "Open", expected: "Ready" },
			{ action: "Reload", expected: "Still ready" },
			{ action: "Done", expected: null },
			{ action: "Extra", expected: "one\ttwo" },
		]);
	});
	test("reads Markdown tables and drops header, separator and step number", () => {
		expect(
			parseOutline("| # | Action | Expected |\n|---|:---|---:|\n| 1 | Open | Ready |\n| 2 | Reload | Still ready |")
				.steps,
		).toEqual([
			{ action: "Open", expected: "Ready" },
			{ action: "Reload", expected: "Still ready" },
		]);
		expect(parseOutline("| Action | Expected |\n| actual | content |").steps).toHaveLength(2);
	});
	test("keeps escaped pipes and otherwise ordinary punctuation", () => {
		expect(parseOutline("| a \\| b | c |").steps[0]).toEqual({ action: "a \\| b", expected: "c" });
		expect(parseOutline("- [x] Open").steps[0]?.action).toBe("Open");
		expect(parseOutline("Use a@REQ-12.example\nNext #tag").covers).toEqual([]);
	});
	test("accepts blank input and CRLF", () => {
		expect(parseOutline(" \r\n\t")).toEqual({ title: null, steps: [], tags: [], covers: [] });
		expect(parseOutline("# Title\r\n- Open\r\n  > Ready").steps).toEqual([{ action: "Open", expected: "Ready" }]);
	});
	test("never throws on arbitrary Unicode input", () => {
		fc.assert(
			fc.property(fc.string({ unit: "binary", maxLength: 2_000 }), (input) => {
				parseOutline(input);
			}),
			{ numRuns: 1_000 },
		);
	});
	test("every nonsyntax alphanumeric character of arbitrary input appears in the output", () => {
		fc.assert(
			fc.property(fc.oneof(fc.string({ unit: "binary", maxLength: 500 }), fc.string({ maxLength: 500 })), (input) => {
				const result = parseOutline(input);
				const output = [
					result.title ?? "",
					...result.steps.flatMap((s) => [s.action, s.expected ?? ""]),
					...result.tags,
					...result.covers,
				].join("");
				// These are grammar tokens the brief explicitly requires discarding, not user content.
				const nonempty = input.split(/\r\n|\n|\r/).filter((line) => line.trim() !== "");
				const withoutHeaders = nonempty
					.filter(
						(line, index) =>
							!(
								line.trim().startsWith("|") &&
								/^\|(?:[ \t]*:?-{3,}:?[ \t]*\|){2,}$/.test(nonempty[index + 1]?.trim() ?? "")
							),
					)
					.join("\n");
				const content = withoutHeaders
					.replace(/^(\s*\|)\s*\d+\s*\|/gm, "$1")
					.replace(/^(\s*)\d+\t(?=[^\n]*\t)/gm, "$1")
					.replace(
						/(^|[\r\n])[ \t]*(?:(?:[-*+•]|\d+[.)]|\(\d+\)|[a-z]\.|\[[ x]\]|step[ \t]+\d+:)(?:[ \t]+|$))+/gi,
						"$1",
					)
					.replace(/(^|[ \t])(?:expected(?: result)?|expect|then):[ \t]*/gi, "$1");
				for (const char of content.match(/[\p{L}\p{N}]/gu) ?? []) expect(output).toContain(char);
			}),
			{ numRuns: 1_000 },
		);
	});
	test("retains all action and expectation text in generated structured captures", () => {
		fc.assert(
			fc.property(
				fc.array(fc.tuple(fc.stringMatching(/^[A-Z][a-z0-9]{1,20}$/), fc.stringMatching(/^[A-Z][a-z0-9]{1,20}$/)), {
					minLength: 1,
					maxLength: 20,
				}),
				(steps) => {
					const input = steps.map(([action, expected]) => `- ${action} > ${expected}`).join("\n");
					expect(parseOutline(input).steps).toEqual(steps.map(([action, expected]) => ({ action, expected })));
				},
			),
		);
	});
});
