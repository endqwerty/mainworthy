import { expect, test } from "bun:test";
import type { Clause, Policy } from "../../core/kinds.ts";
import { PRESETS } from "../../core/presets.ts";
import { policyChanges } from "./policy-changes.ts";

const standard = (): Policy => structuredClone(PRESETS.standard) as Policy;
const added: Clause = {
	id: "failure-special",
	kind: "failure",
	when: ["scope:change"],
	ask: { who: "member", agents: "none", notProducer: true, reason: "required" },
	blocks: "all",
};
const ids = (policy: Policy) => policy.clauses.map((clause) => clause.id);

test("a clause added in two places reads differently, since the first that matches wins", () => {
	const at = (index: number): Policy => {
		const next = standard();
		next.clauses.splice(index, 0, added);
		return next;
	};
	const first = policyChanges(standard(), at(0));
	const last = policyChanges(standard(), at(standard().clauses.length));
	expect(first).not.toEqual(last);
	expect(first.at(-1)).toBe(`The first clause that matches wins. The order becomes ${ids(at(0)).join(", ")}`);
});

test("a setting changed deep in the settings is named by its path, and an unchanged policy says so", () => {
	const next = standard();
	next.settings.holds.flakyDays += 1;
	expect(policyChanges(standard(), next)).toEqual([
		`Setting holds.flakyDays: ${standard().settings.holds.flakyDays} becomes ${next.settings.holds.flakyDays}`,
	]);
	expect(policyChanges(standard(), standard())).toEqual([]);
});
