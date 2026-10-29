import { expect, test } from "bun:test";
import { SEQUENCE_SEEDS, sequenceFailure, sequenceSeeds } from "./sequence-config.ts";

test("PR sequence runs use the fixed first three seeds, a subset of daily coverage", () => {
	expect(sequenceSeeds({})).toEqual([1, 2, 3]);
	expect(sequenceSeeds({}).length).toBeLessThanOrEqual(SEQUENCE_SEEDS.pr);
	expect(SEQUENCE_SEEDS.pr).toBe(3);
	expect(SEQUENCE_SEEDS.daily).toBeGreaterThanOrEqual(40);
	const daily = sequenceSeeds({ MAINWORTHY_SEQUENCE_SEEDS: String(SEQUENCE_SEEDS.daily) });
	expect(daily.slice(0, SEQUENCE_SEEDS.pr)).toEqual(sequenceSeeds({}));
	expect(daily).toHaveLength(SEQUENCE_SEEDS.daily);
});

test("seed count and first seed overrides select deterministic contiguous seeds", () => {
	expect(sequenceSeeds({ MAINWORTHY_SEQUENCE_SEEDS: "3", MAINWORTHY_SEQUENCE_FIRST: "29" })).toEqual([29, 30, 31]);
	expect(sequenceSeeds({ MAINWORTHY_SEQUENCE_SEEDS: "1", MAINWORTHY_SEQUENCE_FIRST: "37" })).toEqual([37]);
	for (const value of ["", "0", "-1", "1.5", "NaN", "Infinity"]) {
		expect(() => sequenceSeeds({ MAINWORTHY_SEQUENCE_SEEDS: value })).toThrow("MAINWORTHY_SEQUENCE_SEEDS");
		expect(() => sequenceSeeds({ MAINWORTHY_SEQUENCE_FIRST: value })).toThrow("MAINWORTHY_SEQUENCE_FIRST");
	}
});

test.each(["", "-extended"])("a %s failure prints the exact single-seed policy command before its detail", (suffix) => {
	const file = `test/sequences${suffix}-strict.test.ts`;
	const message = sequenceFailure(file, 37, { what: "invariant failed", step: 9 });
	expect(message).toStartWith(`Reproduce: MAINWORTHY_SEQUENCE_FIRST=37 MAINWORTHY_SEQUENCE_SEEDS=1 bun test ${file}`);
	expect(message).toContain("invariant failed");
	expect(message).toContain('"step": 9');
});
