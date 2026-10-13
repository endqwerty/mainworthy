import { expect, test } from "bun:test";
import { firstMatch, type Kind } from "./kinds.ts";
import { PRESET_GUIDE, PRESET_SUMMARY, presetOf, whoAnswers } from "./policy-guide.ts";
import { PRESET_NAMES, PRESETS, type PresetName } from "./presets.ts";

const clause = (preset: PresetName, kind: Kind, facts: string[]) => {
	const found = firstMatch(PRESETS[preset].clauses, { kind, facts: new Set(facts) });
	if (!found) throw new Error(`${preset} has no clause for ${kind}`);
	return found;
};

test("the guide says who answers each question under each preset", () => {
	// The sentences in PRESET_SUMMARY restate this table. A preset that changes a cell changes its sentence too.
	const person = "A person";
	const advised = "A person; agents advise";
	const reasoned = "A person, with a reason";
	const notReporter = "A person who did not report it";
	expect(PRESET_GUIDE.map((row) => [row.question, row.answeredBy.loose, row.answeredBy.standard])).toEqual([
		["A person's edit to a case", "By rule: Accept", "By rule: Accept"],
		["An agent's edit to a case", "By rule: Accept", person],
		["A test with no case", "By rule: Track without a case", "A person or an agent"],
		["A failed result", advised, advised],
		["A result that two reports disagree on", advised, notReporter],
		["A finding", advised, advised],
		["Closing a run that passed", "By rule: Approve", "By rule: Approve"],
	]);
	expect(PRESET_GUIDE.map((row) => row.answeredBy.strict)).toEqual([
		reasoned,
		reasoned,
		reasoned,
		`${notReporter}, with a reason`,
		`${notReporter}, with a reason`,
		reasoned,
		reasoned,
	]);
	expect(Object.keys(PRESET_SUMMARY)).toEqual(PRESET_NAMES);
});

test("one row speaks for every question it names", () => {
	// "A failed result" is asked with one scope and "A finding" with one author. The row is true of the others.
	for (const preset of PRESET_NAMES) {
		const failed = whoAnswers(clause(preset, "failure", ["scope:change"]));
		for (const scope of ["scope:trunk", "scope:run"])
			expect(whoAnswers(clause(preset, "failure", [scope]))).toBe(failed);
		const finding = whoAnswers(clause(preset, "finding", ["author:agent"]));
		for (const facts of [["author:human"], ["author:agent", "category:defect"]])
			expect(whoAnswers(clause(preset, "finding", facts))).toBe(finding);
	}
});

test("what the guide says of every policy holds for every preset", () => {
	for (const preset of PRESET_NAMES) {
		expect(whoAnswers(clause(preset, "adopt", ["author:human", "policy"]))).toBe("An admin, not an agent");
		expect(whoAnswers(clause(preset, "adopt", ["author:agent", "conflict"]))).toBe("Its author, unless an agent");
	}
});

test("who answers, for each way a clause can ask", () => {
	const ask = { who: "member", agents: "none", notProducer: false, reason: "optional" } as const;
	const of = (more: object, answer?: unknown) =>
		whoAnswers({ id: "c", kind: "adopt", when: ["always"], blocks: "nothing", ask: { ...ask, ...more }, answer });
	expect(of({ who: "rule" }, { is: "accept" })).toBe("By rule: Accept");
	expect(of({ who: "rule" })).toBe("By rule");
	expect(of({ who: "admin", agents: "answer" })).toBe("An admin, agents included");
	expect(of({ who: "admin", agents: "advise" })).toBe("An admin; agents advise");
	expect(of({ who: "author", agents: "answer" })).toBe("Its author");
	expect(of({ agents: "answer", notProducer: true, reason: "required" })).toBe(
		"A person or an agent who did not report it, with a reason",
	);
});

test("a policy is a preset only while it has the preset's clauses", () => {
	for (const preset of PRESET_NAMES) {
		// As the server stores and returns it: through JSON.
		expect(presetOf(JSON.parse(JSON.stringify(PRESETS[preset])))).toBe(preset);
	}
	expect(presetOf({ preset: "loose", clauses: PRESETS.strict.clauses })).toBeNull();
	expect(presetOf({ preset: "custom", clauses: PRESETS.loose.clauses })).toBeNull();
});
