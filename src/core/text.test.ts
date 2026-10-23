import { expect, test } from "bun:test";
import { clip, clipEnd, escapeControls, malformedText, reportJson } from "./text.ts";

test("terminal escaping covers all C0, DEL, C1, line-separator and bidi override/isolate controls", () => {
	const codes = [
		...Array.from({ length: 32 }, (_, index) => index),
		...Array.from({ length: 33 }, (_, index) => 127 + index),
		0x2028,
		0x2029,
		0x202a,
		0x202b,
		0x202c,
		0x202d,
		0x202e,
		0x2066,
		0x2067,
		0x2068,
		0x2069,
	];
	const prefix = 'ordinary "quotes" \\ and 🦊';
	expect(escapeControls(prefix + String.fromCharCode(...codes))).toBe(
		prefix + codes.map((code) => `\\u${code.toString(16).padStart(4, "0")}`).join(""),
	);
});

test("report JSON serializes an undefined top-level value as null", () => {
	expect(reportJson(undefined)).toBe("null");
});

test.each([undefined, 2])("report JSON escapes controls without shortening keys or values (indent %j)", (space) => {
	const text = `\n::error::x\u001b]0;x\u0007\u0085\u202e${'long value 🦊"\\'.repeat(30)}`;
	const value = { [text]: [text, null, 7, true] };
	const json = reportJson(value, space);
	expect(JSON.parse(json)).toEqual(value);
	// biome-ignore lint/suspicious/noControlCharactersInRegex: serialized data must not carry terminal controls.
	expect(json.replaceAll("\n", "")).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/);
	expect(json).toContain("\\n::error::x");
	expect(json).toContain("\\u0085");
});

test("clip never leaves half of a two-unit character", () => {
	expect(clip("abc", 5)).toBe("abc");
	expect(clip("abcdef", 3)).toBe("abc");
	const text = "ab😀cd";
	expect(clip(text, 3)).toBe("ab");
	expect(clip(text, 4)).toBe("ab😀");
	for (let max = 0; max <= text.length; max++) expect(clip(text, max).isWellFormed()).toBe(true);
	expect(clip("😀", 1)).toBe("");
	expect(clipEnd(text, 3)).toBe("cd");
	expect(clipEnd(text, 4)).toBe("😀cd");
	for (let max = 0; max <= text.length; max++) expect(clipEnd(text, max).isWellFormed()).toBe(true);
});

test("malformedText finds half a character anywhere in an input, and says where", () => {
	expect(malformedText({ title: "ok 😀", steps: [{ action: "é" }] })).toBeNull();
	expect(malformedText({ title: "ok", steps: [{ action: "bad \ud83d" }] })).toBe("steps[0].action");
	expect(malformedText("\udc00")).toBe("input");
	expect(malformedText({ "k\ud800": 1 })).toBe("input");
	expect(malformedText([1, null, true])).toBeNull();
});
