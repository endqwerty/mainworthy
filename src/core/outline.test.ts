import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { emptyBody } from "./model.ts";
import { parseBodyInline, parseOutline, splitExpected } from "./outline.ts";

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
		expect(parseOutline("Checkout #checkout @REQ-12 robin@example.com\n  Open #123 > Ready\n  Reload")).toEqual({
			title: "Checkout robin@example.com",
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

test("body inline capture preserves draft steps, fragment pins and literal non-editor fields", () => {
	const body = {
		...emptyBody("Title #critical @REQ-1"),
		pre: "Literal #pre @REQ-2",
		fields: { risk: "#literal" },
		steps: [
			{ id: "s1", action: "Act #critical\nContinue #smoke", expected: "Ready @REQ-1 @REQ-3" },
			{ id: "s2", action: "", expected: "Still writing" },
			{ id: "s3", action: "", expected: null, use: { fragment: "C-2", version: 1 } },
		],
	};
	const before = structuredClone(body);
	const parsed = parseBodyInline(body);
	expect(parsed.tags).toEqual(["critical", "smoke"]);
	expect(parsed.covers).toEqual(["REQ-1", "REQ-3"]);
	expect(parsed.body).toEqual({
		...body,
		title: "Title",
		steps: [
			{ id: "s1", action: "Act\nContinue", expected: "Ready" },
			{ id: "s2", action: "", expected: "Still writing" },
			{ id: "s3", action: "", expected: null, use: { fragment: "C-2", version: 1 } },
		],
	});
	expect(body).toEqual(before);
	expect(parseBodyInline(parsed.body)).toEqual({ body: parsed.body, tags: [], covers: [] });
});

test("body inline capture canonicalizes requirement keys before comparing local deltas", () => {
	expect(parseBodyInline(emptyBody("Title @req-1 @REQ-1")).covers).toEqual(["REQ-1"]);
});

test("step inline capture recognizes every title whitespace boundary before trimming", () => {
	for (const space of [
		" ",
		"\t",
		"\v",
		"\f",
		"\u00a0",
		"\u1680",
		...Array.from({ length: 11 }, (_, i) => String.fromCharCode(0x2000 + i)),
		"\u2028",
		"\u2029",
		"\u202f",
		"\u205f",
		"\u3000",
		"\ufeff",
	]) {
		for (const separator of ["\n", "\r\n", "\r"]) {
			for (const [text, retained] of [
				[`${space}#critical Apply the coupon`, "Apply the coupon"],
				[`#smoke${space}#critical Apply the coupon`, "Apply the coupon"],
				[`${space}#smoke${space}#critical Apply the coupon`, "Apply the coupon"],
				[`Check total${space}#critical${space}@req-101`, "Check total"],
				[`Check total${separator}${space}#critical`, "Check total\n"],
				[`Check total${separator}${space}#critical${space}@req-101${separator}Retained`, "Check total\n\nRetained"],
			] satisfies [string, string][]) {
				const body = { ...emptyBody("Title"), steps: [{ id: "s1", action: text, expected: text }] };
				const parsed = parseBodyInline(body);
				expect(parsed.tags).toEqual(text.includes("#smoke") ? ["smoke", "critical"] : ["critical"]);
				expect(parsed.covers).toEqual(text.includes("@req-101") ? ["REQ-101"] : []);
				expect(parsed.body.steps).toEqual([{ id: "s1", action: retained, expected: retained }]);
				expect(parseBodyInline(parsed.body)).toEqual({ body: parsed.body, tags: [], covers: [] });
				expect(parseBodyInline(body, [body])).toEqual({ body, tags: [], covers: [] });
			}
		}
	}
});

test("step inline capture preserves non-token whitespace and embedded or invalid markers", () => {
	const text = "Check\u00a0total\u3000again\u2007today a#critical a@REQ-101 #bad! @invalid";
	const body = { ...emptyBody("Title"), steps: [{ id: "s1", action: text, expected: text }] };
	expect(parseBodyInline(body)).toEqual({ body, tags: [], covers: [] });
});

test("inline merge parsing keeps current/base fields literal and parses changes by field identity", () => {
	const base = {
		...emptyBody("Base #base @REQ-1"),
		steps: [{ id: "s1", action: "Base #base @REQ-1", expected: "Before" }],
	};
	const current = {
		...emptyBody("Current #current @REQ-2"),
		steps: [{ id: "s1", action: "Current #current @REQ-2", expected: "Now" }],
	};
	const chosen = {
		...current,
		steps: [
			{ id: "s1", action: "Base #base @REQ-1", expected: "Edited #critical @REQ-3" },
			{ id: "s2", action: "Current #current @REQ-2", expected: null },
		],
	};
	const parsed = parseBodyInline(chosen, [base, current]);
	expect(parsed.body.title).toBe(current.title);
	expect(parsed.body.steps).toEqual([
		{ id: "s1", action: "Base #base @REQ-1", expected: "Edited" },
		{ id: "s2", action: "Current", expected: null },
	]);
	expect(parsed.tags).toEqual(["critical", "current"]);
	expect(parsed.covers).toEqual(["REQ-3", "REQ-2"]);
});

for (const [ending, separator] of [
	["LF", "\n"],
	["CRLF", "\r\n"],
	["CR", "\r"],
] as const) {
	test(`outline and field capture share ${ending} lines without discarding field structure`, () => {
		expect(parseOutline(`# Title${separator}- Act${separator}  > Ready`)).toEqual({
			title: "Title",
			steps: [{ action: "Act", expected: "Ready" }],
			tags: [],
			covers: [],
		});
		const lines = [
			"Resolved",
			"#critical",
			"@REQ-101",
			"- Keep this > literally",
			"| left | right |",
			"## Keep heading",
		];
		const parsed = parseBodyInline({
			...emptyBody("Title"),
			steps: [{ id: "s1", action: lines.join(separator), expected: lines.join(separator) }],
		});
		expect(parsed.tags).toEqual(["critical"]);
		expect(parsed.covers).toEqual(["REQ-101"]);
		const retained = ["Resolved", "", "", ...lines.slice(3)].join("\n");
		expect(parsed.body.steps).toEqual([{ id: "s1", action: retained, expected: retained }]);
		expect(parseBodyInline(parsed.body)).toEqual({ body: parsed.body, tags: [], covers: [] });
	});
}

test("Unicode line and paragraph separators are literal within an outline line", () => {
	for (const separator of ["\u2028", "\u2029", "\u0085", "\v", "\f"]) {
		const text = `Keep${separator}literal`;
		expect(parseOutline(`# ${text}`).title).toBe(text);
		expect(parseBodyInline(emptyBody(text), [emptyBody(text)])).toEqual({
			body: emptyBody(text),
			tags: [],
			covers: [],
		});
	}
});

test("changed titles normalize every storage whitespace boundary before capturing metadata", () => {
	for (const space of [
		"\t",
		"\n",
		"\r",
		"\r\n",
		"\v",
		"\f",
		" ",
		"\u00a0",
		"\u1680",
		...Array.from({ length: 11 }, (_, i) => String.fromCharCode(0x2000 + i)),
		"\u2028",
		"\u2029",
		"\u202f",
		"\u205f",
		"\u3000",
		"\ufeff",
	]) {
		const body = emptyBody(`Price${space}#critical${space}@REQ-101`);
		expect(parseBodyInline(body)).toEqual({ body: emptyBody("Price"), tags: ["critical"], covers: ["REQ-101"] });
		expect(parseBodyInline(body, [body])).toEqual({ body, tags: [], covers: [] });
	}
});
