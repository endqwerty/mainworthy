import { expect, test } from "bun:test";
import { type Ask, firstMatch, type Kind, standingOf } from "./kinds.ts";
import { PRESET_GUIDE, PRESET_SUMMARY, whoAnswers } from "./policy-guide.ts";
import { PRESET_NAMES, PRESETS, type PresetName, presetOf } from "./presets.ts";

const clause = (preset: PresetName, kind: Kind, facts: string[], answer?: string) => {
	const found = firstMatch(PRESETS[preset].clauses, { kind, facts: new Set(facts), ...(answer ? { answer } : {}) });
	if (!found) throw new Error(`${preset} has no clause for ${kind}`);
	return found;
};

test("the guide says who answers each question under each preset", () => {
	// The sentences in PRESET_SUMMARY restate this table. A preset that changes a cell changes its sentence too.
	const person = "A person";
	const advised = "A person; agents advise";
	const reasoned = "A person, with a reason";
	const notReporter = "A person who did not report it";
	// The same under every preset, and never with a reason: `strict` asks for one everywhere else.
	const conflict = "Its author if a person, or an admin. Reject: its author (person or agent), or an admin";
	const policy = "An admin, not an agent";
	expect(PRESET_GUIDE.map((row) => [row.question, row.answeredBy.loose, row.answeredBy.standard])).toEqual([
		["A person's edit to a case", "By rule: Accept", "By rule: Accept"],
		["An agent's edit to a case", "By rule: Accept", person],
		["A test with no case", "By rule: Track without a case", "A person or an agent"],
		["A failed result", advised, advised],
		["A result that two reports disagree on", advised, notReporter],
		["A finding", `${advised}. Duplicate: a person or an agent`, advised],
		["Closing a run that passed", "By rule: Approve", "By rule: Approve"],
		["An edit that conflicts with a newer version", conflict, conflict],
		["A change to the policy", policy, policy],
	]);
	expect(PRESET_GUIDE.map((row) => row.answeredBy.strict)).toEqual([
		reasoned,
		reasoned,
		reasoned,
		`${notReporter}, with a reason`,
		`${notReporter}, with a reason`,
		reasoned,
		reasoned,
		conflict,
		policy,
	]);
	expect(Object.keys(PRESET_SUMMARY)).toEqual(PRESET_NAMES);
});

test("one row speaks for every question it names", () => {
	// "A failed result" is asked with one scope and "A finding" with one author. The row is true of the others.
	for (const preset of PRESET_NAMES) {
		const failed = whoAnswers(clause(preset, "failure", ["scope:change"]));
		for (const scope of ["scope:trunk", "scope:run"])
			expect(whoAnswers(clause(preset, "failure", [scope]))).toBe(failed);
		for (const facts of [
			["scope:trunk", "hint:disputed"],
			["scope:change", "hint:disputed"],
		])
			expect(whoAnswers(clause(preset, "failure", facts))).toBe(
				whoAnswers(clause(preset, "failure", ["scope:run", "hint:disputed"])),
			);
		const finding = whoAnswers(clause(preset, "finding", ["author:agent"]));
		for (const facts of [["author:human"], ["author:agent", "category:defect"]])
			expect(whoAnswers(clause(preset, "finding", facts))).toBe(finding);
		for (const author of ["author:agent", "author:ci"]) {
			expect(whoAnswers(clause(preset, "adopt", [author, "policy"]))).toBe("An admin, not an agent");
			expect(whoAnswers(clause(preset, "adopt", [author, "conflict"]))).toBe("Its author if a person, or an admin");
		}
	}
});

test("a cell names an answer that a clause singles out", () => {
	// Under loose an agent may settle a finding as a duplicate, though it only advises on the others.
	expect(clause("loose", "finding", ["author:agent"], "duplicate").id).toBe("finding-duplicate");
	expect(clause("loose", "finding", ["author:agent"], "accept").id).toBe("finding-any");
	// An agent may withdraw its own conflicting edit under every preset, and cannot merge it.
	for (const preset of PRESET_NAMES) {
		expect(clause(preset, "adopt", ["author:agent", "conflict"], "reject").ask.agents).toBe("answer");
		expect(clause(preset, "adopt", ["author:agent", "conflict"], "merge").ask.agents).toBe("none");
	}
});

test("who answers, for each way a clause can ask", () => {
	const base: Ask = { who: "member", agents: "none", notProducer: false, reason: "optional" };
	const of = (more: Partial<Ask>, answer?: unknown) =>
		whoAnswers({ id: "c", kind: "adopt", when: ["always"], blocks: "nothing", ask: { ...base, ...more }, answer });
	expect(of({ who: "rule" }, { is: "accept" })).toBe("By rule: Accept");
	expect(of({ who: "rule" })).toBe("By rule");
	expect(of({ who: "admin", agents: "answer" })).toBe("An admin, agents included");
	expect(of({ who: "admin", agents: "advise", notProducer: true })).toBe(
		"An admin who did not report it; agents advise",
	);
	expect(of({ who: "author", agents: "answer", reason: "required" })).toBe(
		"Its author (person or agent), or an admin, with a reason",
	);
	expect(of({ agents: "answer", notProducer: true, reason: "required" })).toBe(
		"A person or an agent, excluding whoever reported it, with a reason",
	);
});

test("the wording agrees with who may answer, for every way a clause can ask", () => {
	const person = { kind: "human", can: ["read", "answer"] } as const;
	const admin = { kind: "human", can: ["read", "answer", "admin"] } as const;
	const agent = { kind: "agent", can: ["read", "produce", "answer", "admin"] } as const;
	for (const who of ["member", "admin", "author"] as const)
		for (const agents of ["answer", "advise", "none"] as const)
			for (const notProducer of [false, true]) {
				const ask: Ask = { who, agents, notProducer, reason: "optional" };
				const text = whoAnswers({ id: "c", kind: "adopt", when: ["always"], blocks: "nothing", ask });
				const stands = (actor: typeof person | typeof admin | typeof agent, isAuthor = false, isProducer = false) =>
					standingOf({ actor, ask, isAuthor, isProducer });
				// An admin who is a person and did not write the proposal counts wherever the text names an admin.
				expect(stands(admin) === "counts").toBe(who !== "author" || text.includes("or an admin"));
				if (who === "member") expect(stands(person)).toBe("counts");
				if (who === "admin") expect(stands(person)).toBe("forbidden");
				// An agent's answer counts exactly where the text says an agent may answer.
				const agentCounts = stands(agent, who === "author") === "counts";
				expect(agentCounts).toBe(/or an agent|agents included|person or agent/.test(text));
				expect(stands(agent, who === "author") === "advice").toBe(text.includes("agents advise"));
				// Whoever reported the evidence is out wherever the text says so, a person and an agent alike.
				expect(stands(admin, who === "author", true) === "counts").toBe(!/report/.test(text));
				expect(stands(agent, who === "author", true) === "counts").toBe(agentCounts && !/report/.test(text));
			}
});

test("a policy is a preset only while it has the preset's clauses", () => {
	for (const preset of PRESET_NAMES) {
		// As the server stores and returns it: through JSON.
		expect(presetOf(JSON.parse(JSON.stringify(PRESETS[preset])))).toBe(preset);
	}
	expect(presetOf({ preset: "loose", clauses: PRESETS.strict.clauses })).toBeNull();
	expect(presetOf({ preset: "custom", clauses: PRESETS.loose.clauses })).toBeNull();
});
