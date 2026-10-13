import { expect, test } from "bun:test";
import { durationMs } from "./duration.ts";

test("a duration is a whole number and h, d or w", () => {
	expect([durationMs("1h"), durationMs("12h"), durationMs("14d"), durationMs("2w"), durationMs("9999w")]).toEqual([
		3_600_000,
		12 * 3_600_000,
		14 * 86_400_000,
		14 * 86_400_000,
		9999 * 7 * 86_400_000,
	]);
});

test("anything else is not a duration: no zero, sign, fraction, space, other unit or fifth digit", () => {
	for (const text of ["", "14", "d", "0d", "01d", "-1d", "+1d", "1.5d", "14 d", " 14d", "14d ", "14D", "90m", "1y"])
		expect(`${text}: ${durationMs(text)}`).toBe(`${text}: null`);
	expect(durationMs("10000d")).toBeNull();
});
