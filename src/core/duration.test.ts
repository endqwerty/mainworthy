import { expect, test } from "bun:test";
import { durationMs, untilPhrase } from "./duration.ts";

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

test("the time left is said in days from two days up, in hours below that, and not at all once it is past", () => {
	const HOUR = 3_600_000;
	const DAY = 24 * HOUR;
	const now = 1_800_000_000_000;
	const said = (left: number): string | null => untilPhrase(now + left, now);
	expect([said(90 * DAY), said(90 * DAY - 1000), said(13 * DAY + 11 * HOUR), said(2 * DAY)]).toEqual([
		"in 90 days",
		"in 90 days",
		"in 13 days",
		"in 2 days",
	]);
	expect([said(2 * DAY - 1), said(90 * 60_000), said(HOUR + 60_000), said(HOUR)]).toEqual([
		"in 48 hours",
		"in 2 hours",
		"in 1 hour",
		"in 1 hour",
	]);
	expect([said(HOUR - 1), said(1), said(0), said(-DAY)]).toEqual(["in under an hour", "in under an hour", null, null]);
});
