import { expect, test } from "bun:test";
import { clip, clipEnd, malformedText } from "./text.ts";

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
