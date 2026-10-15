import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { parseCase, printCase } from "./markdown.ts";
import { CaseDoc } from "./model.ts";
import { docArbitrary, exampleBody } from "./test-support.ts";

describe("canonical case Markdown", () => {
	test.each(["\u2028", "\u2029"])("preserves Unicode separator %j in every string position", (text) => {
		const doc: CaseDoc = {
			ref: text,
			body: {
				...exampleBody(),
				title: text,
				pre: text,
				fields: Object.fromEntries([[text, text]]),
				steps: [{ id: "a1", action: text, expected: text }],
			},
			tags: [text],
			covers: [text],
		};
		expect(parseCase(printCase(doc))).toEqual({ ok: true, doc });
	});
	test("prints the exact canonical layout and omissions", () => {
		const doc: CaseDoc = { ref: "C-1", body: exampleBody(), tags: ["checkout"], covers: [] };
		const text =
			"---\nid: C-1\nkind: case\ntitle: Checkout applies a percentage coupon\nmethods: [human]\ncovers: []\ntags: [checkout]\n---\n## Preconditions\nSigned in as a customer with an empty cart.\n\n## Steps\n- Open the cart with one $100.00 item ^a1\n- Apply coupon SAVE10 ^b7\n  > Total shows $90.00\n- Reload the page ^c3\n  > Coupon is still applied\n";
		expect(printCase(doc)).toBe(text);
		expect(parseCase(text)).toEqual({ ok: true, doc });
	});
	test("omits absent id, none automation and empty preconditions", () => {
		const doc: CaseDoc = { ref: null, body: { ...exampleBody(), pre: "" }, tags: [], covers: [] };
		const text = printCase(doc);
		expect(text).not.toContain("id:");
		expect(text).not.toContain("automate:");
		expect(text).not.toContain("## Preconditions");
		expect(parseCase(text)).toEqual({ ok: true, doc });
	});
	test("escapes every ambiguous body boundary and header scalar", () => {
		const doc: CaseDoc = {
			ref: " 'C:1' ",
			body: {
				...exampleBody(),
				title: '  a: "quoted" title  ',
				pre: "\n## Steps\n\n  leading\r\n\tunicode 東京\n",
				steps: [
					{
						id: "a1",
						action: "\n> literal\n- literal\n# heading\n  spaces\nending ^id\n\t\\t\r\n",
						expected: "\n\n> expectation\n  trailing  \n",
					},
				],
				fields: Object.fromEntries([
					["__proto__", "safe"],
					[" key: with 'quotes' ", "\nvalue\t"],
				]),
			},
			tags: ["a,b", '"quoted"', "", " [tag] ", "\n"],
			covers: ["'single'", "a: b"],
		};
		expect(parseCase(printCase(doc))).toEqual({ ok: true, doc });
	});
	test("preserves existing schema-valid ids, including repeated ids", () => {
		const doc: CaseDoc = {
			ref: null,
			body: {
				...exampleBody(),
				steps: [
					{ id: "12abcdef", action: "one", expected: null },
					{ id: "12abcdef", action: "two", expected: null },
				],
			},
			tags: [],
			covers: [],
		};
		expect(parseCase(printCase(doc))).toEqual({ ok: true, doc });
	});
	test("assigns deterministic ids without colliding with later explicit ones", () => {
		const text = "---\ntitle: Written by hand\n---\n## Steps\n- First\n- Existing ^a0\n- Third\n  > Ready\n";
		const result = parseCase(text);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.doc.body.steps.map((step) => step.id)).toEqual(["a1", "a0", "a2"]);
		expect(parseCase(text)).toEqual(result);
	});
	test("accepts CRLF and single-quoted YAML strings and arrays", () => {
		const text =
			"---\nkind: case\ntitle: 'It''s a title'\nmethods: ['human', auto]\ntags: ['a,b', 'it''s']\nfields:\n  'x:y': 'it''s fine'\n---\n## Steps\n* Act\n> Done\n";
		const result = parseCase(text.replace(/\n/g, "\r\n"));
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.doc.body.title).toBe("It's a title");
			expect(result.doc.tags).toEqual(["a,b", "it's"]);
			expect(result.doc.body.fields).toEqual({ "x:y": "it's fine" });
		}
	});
	test("reports unknown and duplicate header keys at their source lines", () => {
		const result = parseCase("---\ntitle: A\nunknown: X\ntitle: B\n---\n## Steps\n");
		expect(result).toEqual({
			ok: false,
			errors: [
				{ line: 3, message: "Unknown header key unknown" },
				{ line: 4, message: "Duplicate header key title" },
			],
		});
	});
	test.each([
		["", { legacy: "Keep me" }],
		["# fields: {}\n", { legacy: "Keep me" }],
		["fields:\n", {}],
		["fields: {}\n", {}],
		['"fields": {}\n', {}],
		["fields:\n  risk: low\n", { risk: "low" }],
	])("uses fallback fields only when the header omits them: %j", (header, fields) => {
		const text = `\uFEFF---\r\ntitle: Edited\r\n${header.replace(/\n/g, "\r\n")}---\r\n## Steps\r\n- fields: is body text ^a1\r\n`;
		const result = parseCase(text, { fields: { legacy: "Keep me" } });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.doc.body.fields).toEqual(fields);
			expect(result.doc.body.steps).toEqual([{ id: "a1", action: "fields: is body text", expected: null }]);
		}
	});
	test.each([
		["Missing header", "## Steps\n- Act"],
		["Missing close", "---\ntitle: A"],
		["Bad scalar", '---\ntitle: "unclosed\n---\n## Steps'],
		["Bad methods", "---\nmethods: [robot]\n---\n## Steps"],
		["Empty methods", "---\nmethods: []\n---\n## Steps"],
		["Bad automate", "---\nautomate: maybe\n---\n## Steps"],
		["Missing steps", "---\ntitle: A\n---"],
		["Empty action", "---\n---\n## Steps\n-  ^a1"],
		["Empty expected", "---\n---\n## Steps\n- Act ^a1\n  > "],
	])("rejects %s without throwing", (_label, text) => {
		expect(parseCase(text).ok).toBe(false);
	});
	test("round-trips arbitrary valid CaseDocs", () => {
		fc.assert(
			fc.property(docArbitrary, (doc) => {
				expect(CaseDoc.safeParse(doc).success).toBe(true);
				expect(parseCase(printCase(doc))).toEqual({ ok: true, doc });
			}),
			{ numRuns: 1_000 },
		);
	});
	test("printing a parsed canonical document is byte-for-byte stable", () => {
		fc.assert(
			fc.property(docArbitrary, (doc) => {
				const text = printCase(doc);
				const result = parseCase(text);
				if (!result.ok) throw new Error(JSON.stringify(result.errors));
				expect(printCase(result.doc)).toBe(text);
			}),
			{ numRuns: 1_000 },
		);
	});
	test("malformed arbitrary input never throws", () => {
		fc.assert(
			fc.property(fc.string({ unit: "binary", maxLength: 500 }), (text) => {
				parseCase(text);
			}),
			{ numRuns: 1_000 },
		);
	});
});
