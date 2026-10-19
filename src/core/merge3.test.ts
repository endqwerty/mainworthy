import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { applyMergeChoice, mergeBodies } from "./merge3.ts";
import { CaseBody } from "./model.ts";
import { bodyArbitrary, exampleBody, nonemptyTextArbitrary, stepArbitrary, textArbitrary } from "./test-support.ts";

describe("three-way field merge", () => {
	test("deleting a neighbour of a moved step does not conflict or resurrect the neighbour", () => {
		const base = exampleBody();
		const deleted = { ...base, steps: base.steps.filter((step) => step.id !== "b7") };
		const moved = { ...base, steps: [...base.steps.slice(2), ...base.steps.slice(0, 2)] };
		const expected = { ...base, steps: [...base.steps.slice(2), ...base.steps.slice(0, 1)] };
		expect(mergeBodies({ base, mine: deleted, theirs: moved })).toEqual({ merged: expected, conflicts: [] });
		expect(mergeBodies({ base, mine: moved, theirs: deleted })).toEqual({ merged: expected, conflicts: [] });
	});
	test("keeps mine on conflicting scalars and reports complete values", () => {
		const base = exampleBody();
		const mine = { ...base, title: "Mine" };
		const theirs = { ...base, title: "Theirs" };
		const result = mergeBodies({ base, mine, theirs });
		expect(result.merged.title).toBe("Mine");
		expect(result.conflicts).toEqual([
			{ address: { kind: "field", name: "title" }, base: base.title, mine: "Mine", theirs: "Theirs" },
		]);
	});
	test("merges action and expectation separately on the same step", () => {
		const base = { ...exampleBody(), steps: [{ id: "b7", action: "Apply SAVE10", expected: "90 dollars" }] };
		const mine = { ...base, steps: [{ id: "b7", action: "Apply SAVE20", expected: "90 dollars" }] };
		const theirs = { ...base, steps: [{ id: "b7", action: "Apply SAVE10", expected: "80 dollars" }] };
		expect(mergeBodies({ base, mine, theirs })).toEqual({
			merged: { ...base, steps: [{ id: "b7", action: "Apply SAVE20", expected: "80 dollars" }] },
			conflicts: [],
		});
	});
	test("reports conflicting expectations, preserving null as a real value", () => {
		const base = { ...exampleBody(), steps: [{ id: "b7", action: "Act", expected: "Old" }] };
		const mine = { ...base, steps: [{ id: "b7", action: "Act", expected: null }] };
		const theirs = { ...base, steps: [{ id: "b7", action: "Act", expected: "New" }] };
		const result = mergeBodies({ base, mine, theirs });
		expect(result.merged.steps[0]?.expected).toBeNull();
		expect(result.conflicts).toEqual([
			{ address: { kind: "step-field", id: "b7", name: "expected" }, base: "Old", mine: null, theirs: "New" },
		]);
	});
	test("merges custom fields by key, including deletions and prototype-like keys", () => {
		const base = { ...exampleBody(), fields: { old: "x", shared: "before" } };
		const mine = { ...base, fields: { shared: "mine", local: "L" } };
		const theirs = {
			...base,
			fields: Object.fromEntries([
				["old", "x"],
				["shared", "before"],
				["__proto__", "T"],
			]),
		};
		expect(mergeBodies({ base, mine, theirs })).toEqual({
			merged: {
				...base,
				fields: Object.fromEntries([
					["shared", "mine"],
					["local", "L"],
					["__proto__", "T"],
				]),
			},
			conflicts: [],
		});
	});
	test("a custom-field deletion against an edit is a conflict", () => {
		const base = { ...exampleBody(), fields: { a: "old" } };
		const mine = { ...base, fields: {} };
		const theirs = { ...base, fields: { a: "new" } };
		const result = mergeBodies({ base, mine, theirs });
		expect(result.merged.fields).toEqual({});
		expect(result.conflicts).toEqual([
			{ address: { kind: "custom-field", key: "a" }, base: "old", mine: undefined, theirs: "new" },
		]);
	});
	test("delete versus edit conflicts retain mine's membership in both directions", () => {
		const base = { ...exampleBody(), steps: [{ id: "b7", action: "Act", expected: null }] };
		const removed = { ...base, steps: [] };
		const edited = { ...base, steps: [{ id: "b7", action: "Different", expected: null }] };
		const result = mergeBodies({ base, mine: removed, theirs: edited });
		expect(result.merged.steps).toEqual([]);
		expect(result.conflicts[0]?.address).toEqual({ kind: "step", id: "b7" });
		const reverse = mergeBodies({ base, mine: edited, theirs: removed });
		expect(reverse.merged.steps).toEqual(edited.steps);
		expect(reverse.conflicts).toHaveLength(1);
	});
	test("delete versus reorder is also an edit conflict", () => {
		const base = exampleBody();
		const mine = { ...base, steps: base.steps.filter((step) => step.id !== "b7") };
		const theirs = { ...base, steps: [...base.steps].reverse() };
		const result = mergeBodies({ base, mine, theirs });
		expect(result.conflicts.some((c) => c.address.kind === "step" && c.address.id === "b7")).toBe(true);
		const moved = {
			...base,
			steps: [base.steps[1], base.steps[0], base.steps[2]].filter((step) => step !== undefined),
		};
		expect(
			mergeBodies({ base, mine, theirs: moved }).conflicts.some(
				(c) => c.address.kind === "step" && c.address.id === "b7",
			),
		).toBe(true);
	});
	test("delete versus unchanged accepts the deletion", () => {
		const base = exampleBody();
		const mine = { ...base, steps: base.steps.slice(1) };
		expect(mergeBodies({ base, mine, theirs: base })).toEqual({ merged: mine, conflicts: [] });
	});
	test("keeps both sides' additions near their neighbours", () => {
		const base = exampleBody();
		const first = base.steps[0];
		if (!first) throw new Error("Missing fixture step");
		const mine = { ...base, steps: [first, { id: "m1", action: "Mine", expected: null }, ...base.steps.slice(1)] };
		const theirs = {
			...base,
			steps: [
				first,
				{ id: "t1", action: "Theirs", expected: null },
				{ id: "t2", action: "More", expected: null },
				...base.steps.slice(1),
			],
		};
		const result = mergeBodies({ base, mine, theirs });
		expect(result.conflicts).toEqual([]);
		expect(result.merged.steps.map((step) => step.id)).toEqual(["a1", "m1", "t1", "t2", "b7", "c3"]);
	});
	test("a one-sided reorder and other-side insertion can coexist", () => {
		const base = exampleBody();
		const mine = { ...base, steps: [...base.steps, { id: "m1", action: "Added", expected: null }] };
		const theirs = { ...base, steps: [...base.steps].reverse() };
		const result = mergeBodies({ base, mine, theirs });
		expect(result.conflicts).toEqual([]);
		expect(result.merged.steps.map((step) => step.id)).toEqual(["c3", "m1", "b7", "a1"]);
	});
	test("incompatible concurrent reorders conflict and retain mine", () => {
		const base = exampleBody();
		const mine = { ...base, steps: [...base.steps].reverse() };
		const theirs = { ...base, steps: [...base.steps.slice(1), ...base.steps.slice(0, 1)] };
		const result = mergeBodies({ base, mine, theirs });
		expect(result.merged.steps).toEqual(mine.steps);
		expect(result.conflicts.map((c) => c.address)).toEqual([{ kind: "step-order" }]);
	});
	test("concurrent additions with the same id merge identical fields and conflict on different fields", () => {
		const base = { ...exampleBody(), steps: [] };
		const mine = { ...base, steps: [{ id: "b7", action: "Mine", expected: null }] };
		const theirs = { ...base, steps: [{ id: "b7", action: "Theirs", expected: null }] };
		const result = mergeBodies({ base, mine, theirs });
		expect(result.merged).toEqual(mine);
		expect(result.conflicts).toEqual([
			{ address: { kind: "step-field", id: "b7", name: "action" }, base: undefined, mine: "Mine", theirs: "Theirs" },
		]);
	});
	test("choosing the surviving step keeps edits and pins for arbitrary step ids", () => {
		fc.assert(
			fc.property(bodyArbitrary, stepArbitrary, (template, step) => {
				const base = { ...template, steps: [step] };
				const mine = { ...base, steps: [] };
				const edited = step.use
					? { ...step, use: { ...step.use, version: step.use.version + 1 } }
					: { ...step, action: `${step.action} changed` };
				const current = { ...base, steps: [edited] };
				const merge = mergeBodies({ base, mine, theirs: current });
				expect(merge.conflicts).toEqual([
					{ address: { kind: "step", id: step.id }, base: step, mine: undefined, theirs: edited },
				]);
				const conflict = merge.conflicts[0];
				if (!conflict) throw Error("Missing step conflict");
				expect(applyMergeChoice({ merged: merge.merged, source: current, address: conflict.address })).toEqual(current);
			}),
			{ numRuns: 500 },
		);
	});
	test("identity laws hold for arbitrary complete bodies", () => {
		fc.assert(
			fc.property(bodyArbitrary, bodyArbitrary, (base, x) => {
				expect(mergeBodies({ base, mine: x, theirs: base })).toEqual({ merged: x, conflicts: [] });
				expect(mergeBodies({ base, mine: base, theirs: x })).toEqual({ merged: x, conflicts: [] });
				expect(mergeBodies({ base, mine: x, theirs: x })).toEqual({ merged: x, conflicts: [] });
			}),
			{ numRuns: 500 },
		);
	});
	test("arbitrary disjoint field edits merge without conflicts", () => {
		fc.assert(
			fc.property(bodyArbitrary, textArbitrary, textArbitrary, (base, title, pre) => {
				const mine = { ...base, title };
				const theirs = { ...base, pre };
				expect(mergeBodies({ base, mine, theirs })).toEqual({ merged: { ...base, title, pre }, conflicts: [] });
			}),
		);
	});
	test("arbitrary separate custom-field keys merge, with independent changes to methods and intent", () => {
		fc.assert(
			fc.property(bodyArbitrary, textArbitrary, textArbitrary, (base, local, remote) => {
				const mine: CaseBody = { ...base, methods: ["agent", "auto"], fields: { ...base.fields, local } };
				const theirs: CaseBody = { ...base, automate: "wanted", fields: { ...base.fields, remote } };
				expect(mergeBodies({ base, mine, theirs })).toEqual({
					merged: {
						...base,
						methods: ["agent", "auto"],
						automate: "wanted",
						fields: { ...base.fields, local, remote },
					},
					conflicts: [],
				});
			}),
		);
	});
	test("arbitrary disjoint step fields merge without conflicts", () => {
		fc.assert(
			fc.property(
				bodyArbitrary,
				nonemptyTextArbitrary,
				fc.option(nonemptyTextArbitrary, { nil: null }),
				(template, action, expected) => {
					const base = { ...template, steps: [{ id: "s1", action: "before", expected: "before" }] };
					const mine: CaseBody = { ...base, steps: [{ id: "s1", action, expected: "before" }] };
					const theirs: CaseBody = { ...base, steps: [{ id: "s1", action: "before", expected }] };
					expect(mergeBodies({ base, mine, theirs })).toEqual({
						merged: { ...base, steps: [{ id: "s1", action, expected }] },
						conflicts: [],
					});
				},
			),
		);
	});
	test("never mutates input and produces model-valid merged bodies", () => {
		fc.assert(
			fc.property(bodyArbitrary, bodyArbitrary, bodyArbitrary, (base, mine, theirs) => {
				const snapshots = structuredClone({ base, mine, theirs });
				const result = mergeBodies({ base, mine, theirs });
				expect({ base, mine, theirs }).toEqual(snapshots);
				expect(CaseBody.safeParse(result.merged).success).toBe(true);
			}),
		);
	});
});
