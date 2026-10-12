import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { newStepId } from "./ids.ts";
import { StepId } from "./model.ts";

describe("newStepId", () => {
	test("is deterministic with a supplied source and leaves taken unchanged", () => {
		const taken = new Set(["a0", "a1"]);
		expect(newStepId(taken, () => 0)).toBe("a2");
		expect([...taken]).toEqual(["a0", "a1"]);
	});
	test("grows the id after all two-character ids are occupied", () => {
		const taken = new Set<string>();
		for (const first of "abcdefghijklmnopqrstuvwxyz") {
			for (const second of "abcdefghijklmnopqrstuvwxyz0123456789") taken.add(first + second);
		}
		expect(newStepId(taken, () => 0)).toBe("a00");
	});
	test("makes progress even with a constant or out-of-range source", () => {
		for (const sample of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1, 5]) {
			const id = newStepId(new Set(), () => sample);
			expect(id).toMatch(/^[a-z][a-z0-9]{1,3}$/);
		}
	});
	test("throws on complete namespace exhaustion", () => {
		const empty = new Set<string>();
		const taken: ReadonlySet<string> = {
			size: 1_247_688,
			has: () => true,
			entries: () => empty.entries(),
			keys: () => empty.keys(),
			values: () => empty.values(),
			[Symbol.iterator]: () => empty.values(),
			forEach: () => {},
		};
		expect(() => newStepId(taken, () => 0)).toThrow(RangeError);
	});
	test("always returns an unused valid short id", () => {
		fc.assert(
			fc.property(
				fc.array(fc.string(), { maxLength: 100 }),
				fc.double({ min: 0, max: 1, noNaN: true }),
				(ids, sample) => {
					const taken = new Set(ids);
					const id = newStepId(taken, () => sample);
					expect(taken.has(id)).toBe(false);
					expect(id).toMatch(/^[a-z][a-z0-9]{1,3}$/);
					expect(StepId.safeParse(id).success).toBe(true);
				},
			),
		);
	});
	test("repeated allocations are unique", () => {
		fc.assert(
			fc.property(fc.integer({ min: 1, max: 1_000 }), (count) => {
				const taken = new Set<string>();
				for (let i = 0; i < count; i++) taken.add(newStepId(taken, () => 0));
				expect(taken.size).toBe(count);
			}),
			{ numRuns: 30 },
		);
	});
});
