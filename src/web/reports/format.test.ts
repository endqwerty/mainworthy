import { expect, test } from "bun:test";
import { count, percent, spent } from "./format.ts";

test("a rate near either end keeps a decimal, so a failure never rounds away", () => {
	expect([1, 0.9996, 0.986, 0.5, 0.004, 0, null].map(percent)).toEqual([
		"100%",
		"99.9%",
		"99%",
		"50%",
		"0.4%",
		"0%",
		"none",
	]);
});

test("a length of time is said in the largest unit that keeps it readable", () => {
	expect([11, 1_900, 42_000, 600_000, 5_400_000].map(spent)).toEqual([
		"11 ms",
		"1.9 s",
		"42 s",
		"10 min",
		"1 h 30 min",
	]);
});

test("a count takes an s for any number but one", () => {
	expect([count(0, "rerun"), count(1, "rerun"), count(2, "quarantined failure")]).toEqual([
		"0 reruns",
		"1 rerun",
		"2 quarantined failures",
	]);
});
