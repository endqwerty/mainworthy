import { expect, test } from "bun:test";
import { isZone, localDays } from "./days.ts";

const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

test("the days end with today's and each starts at midnight where the reader is", () => {
	// 2027-01-15 08:00 UTC is midnight in Los Angeles, and still the 14th in Honolulu.
	const now = Date.UTC(2027, 0, 15, 8, 0, 0, 1);
	expect(localDays(now, 2, "UTC").map((d) => [d.day, iso(d.from), iso(d.to)])).toEqual([
		["2027-01-14", "2027-01-14T00:00:00.000Z", "2027-01-15T00:00:00.000Z"],
		["2027-01-15", "2027-01-15T00:00:00.000Z", "2027-01-16T00:00:00.000Z"],
	]);
	expect(localDays(now, 1, "America/Los_Angeles").map((d) => [d.day, iso(d.from)])).toEqual([
		["2027-01-15", "2027-01-15T08:00:00.000Z"],
	]);
	expect(localDays(now, 1, "Pacific/Honolulu").map((d) => [d.day, iso(d.from)])).toEqual([
		["2027-01-14", "2027-01-14T10:00:00.000Z"],
	]);
	expect(localDays(now, 1, "Asia/Kolkata").map((d) => [d.day, iso(d.from)])).toEqual([
		["2027-01-15", "2027-01-14T18:30:00.000Z"],
	]);
});

test("a day the clocks change on is 23 or 25 hours long, and the days still meet", () => {
	const spring = localDays(Date.UTC(2027, 2, 15, 12), 3, "America/Los_Angeles");
	expect(spring.map((d) => [d.day, (d.to - d.from) / HOUR])).toEqual([
		["2027-03-13", 24],
		["2027-03-14", 23],
		["2027-03-15", 24],
	]);
	const autumn = localDays(Date.UTC(2027, 10, 7, 20), 1, "America/Los_Angeles");
	expect(autumn.map((d) => [d.day, (d.to - d.from) / HOUR])).toEqual([["2027-11-07", 25]]);
	for (let i = 1; i < spring.length; i++) expect(spring[i]?.from).toBe(spring[i - 1]?.to ?? Number.NaN);
});

test("a time zone is a name the platform knows", () => {
	expect([isZone("UTC"), isZone("Europe/Berlin"), isZone("America/Los_Angeles")]).toEqual([true, true, true]);
	expect([isZone("Mars/Olympus"), isZone(""), isZone("+05:00x")]).toEqual([false, false, false]);
});
