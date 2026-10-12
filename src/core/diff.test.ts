import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { applyDiff, diffBodies, diffWords, isEmptyDiff, summariseDiff } from "./diff.ts";
import type { CaseBody } from "./model.ts";
import { bodyArbitrary, exampleBody, textArbitrary } from "./test-support.ts";

describe("body diffs", () => {
	test("keeps large pasted step diffs lossless without a quadratic allocation", () => {
		const before = `prefix ${"old ".repeat(30_000)}suffix`;
		const after = `prefix ${"new ".repeat(30_000)}suffix`;
		const segments = diffWords({ before, after });
		expect(
			segments
				.filter((s) => s.op !== "ins")
				.map((s) => s.text)
				.join(""),
		).toBe(before);
		expect(
			segments
				.filter((s) => s.op !== "del")
				.map((s) => s.text)
				.join(""),
		).toBe(after);
		expect(segments).toHaveLength(4);
	});
	test("one moved step does not mark all shifted neighbours moved", () => {
		const a = exampleBody();
		const b = { ...a, steps: [...a.steps.slice(2), ...a.steps.slice(0, 2)] };
		expect(diffBodies(a, b).steps.filter((step) => step.kind === "moved")).toHaveLength(1);
	});
	test("identical bodies have same entries and a compact empty summary", () => {
		const body = exampleBody();
		const diff = diffBodies(body, body);
		expect(isEmptyDiff(diff)).toBe(true);
		expect(diff.steps.every((step) => step.kind === "same")).toBe(true);
		expect(summariseDiff(diff)).toBe("no changes");
	});
	test("reports independent expected changes, additions and removals", () => {
		const a = exampleBody();
		const b = {
			...a,
			title: "New title",
			steps: [
				{ id: "b7", action: "Apply coupon SAVE10", expected: "Total shows $95.00" },
				{ id: "c3", action: "Reload the page", expected: "Coupon is still applied" },
				{ id: "z9", action: "Finish", expected: null },
			],
		};
		const diff = diffBodies(a, b);
		expect(diff.steps.map((step) => step.kind)).toEqual(["changed", "same", "added", "removed"]);
		expect(summariseDiff(diff)).toBe("title, b7.expected, +1 step, -1 step");
		expect(applyDiff({ body: a, diff })).toEqual(b);
	});
	test("a step can be moved and changed, without pretending insertions are moves", () => {
		const a = exampleBody();
		const first = a.steps[0];
		const second = a.steps[1];
		const third = a.steps[2];
		if (!first || !second || !third) throw new Error("Fixture needs three steps");
		const b = { ...a, steps: [{ ...second, action: "Apply coupon SAVE20" }, first, third] };
		const changed = diffBodies(a, b).steps[0];
		expect(changed?.kind).toBe("changed");
		if (changed?.kind === "changed") {
			expect(changed.moved).toBe(true);
			expect(changed.action.kind).toBe("changed");
			expect(changed.expected.kind).toBe("same");
		}
		expect(
			diffBodies(a, { ...a, steps: [{ id: "z9", action: "New", expected: null }, ...a.steps] }).steps.map(
				(step) => step.kind,
			),
		).toEqual(["added", "same", "same", "same"]);
	});
	test("word-level segments preserve whitespace and reconstruct both texts", () => {
		expect(diffWords({ before: "total 90 dollars", after: "total 100 dollars" })).toEqual([
			{ op: "eq", text: "total " },
			{ op: "del", text: "90" },
			{ op: "ins", text: "100" },
			{ op: "eq", text: " dollars" },
		]);
		fc.assert(
			fc.property(textArbitrary, textArbitrary, (before, after) => {
				const segments = diffWords({ before, after });
				expect(
					segments
						.filter((s) => s.op !== "ins")
						.map((s) => s.text)
						.join(""),
				).toBe(before);
				expect(
					segments
						.filter((s) => s.op !== "del")
						.map((s) => s.text)
						.join(""),
				).toBe(after);
			}),
			{ numRuns: 500 },
		);
	});
	test("null expectations remain distinct from text", () => {
		const a = { ...exampleBody(), steps: [{ id: "s2", action: "Act", expected: null }] };
		const b = { ...a, steps: [{ id: "s2", action: "Act", expected: "\n" }] };
		const diff = diffBodies(a, b);
		expect(summariseDiff(diff)).toBe("s2.expected");
		expect(applyDiff({ body: a, diff })).toEqual(b);
	});
	test("applies custom-field deletions, order, methods and intent without mutating sources", () => {
		const a: CaseBody = { ...exampleBody(), fields: { old: "x" } };
		const b = {
			...a,
			fields: Object.fromEntries([["__proto__", "safe"]]),
			methods: ["auto", "agent"],
			automate: "wanted",
			steps: [...a.steps].reverse(),
		} satisfies typeof a;
		const before = structuredClone(a);
		const diff = diffBodies(a, b);
		expect(applyDiff({ body: a, diff })).toEqual(b);
		expect(a).toEqual(before);
		expect(diff.fields.kind).toBe("changed");
	});
	test("diffBodies(a, a) is empty for arbitrary bodies", () => {
		fc.assert(
			fc.property(bodyArbitrary, (body) => expect(isEmptyDiff(diffBodies(body, body))).toBe(true)),
			{ numRuns: 300 },
		);
	});
	test("applying all after-values to a reproduces arbitrary b", () => {
		fc.assert(
			fc.property(bodyArbitrary, bodyArbitrary, (a, b) => {
				expect(applyDiff({ body: a, diff: diffBodies(a, b) })).toEqual(b);
			}),
			{ numRuns: 500 },
		);
	});
	test("also reconstructs revisions retaining and editing existing ids", () => {
		fc.assert(
			fc.property(bodyArbitrary, textArbitrary, (a, replacement) => {
				const b = { ...a, steps: a.steps.map((step) => ({ ...step, expected: `${replacement}x` })).reverse() };
				expect(applyDiff({ body: a, diff: diffBodies(a, b) })).toEqual(b);
			}),
			{ numRuns: 300 },
		);
	});
});
