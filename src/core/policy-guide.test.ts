import { expect, test } from "bun:test";
import { type Ask, clauseOf, type Kind, Predicate, standingOf } from "./kinds.ts";
import {
	ADOPT_PREDICATES,
	PRESET_GUIDE,
	PRESET_SUMMARY,
	shownPredicates,
	whoAnswers,
	whyWaiting,
	yourAnswerCounts,
} from "./policy-guide.ts";
import { PRESET_NAMES, PRESETS, type PresetName, presetOf } from "./presets.ts";
import { QuestionItem } from "./replies.ts";

const clause = (preset: PresetName, kind: Kind, facts: string[], answer?: string) => {
	const found = clauseOf(PRESETS[preset], { kind, facts: new Set(facts), ...(answer ? { answer } : {}) });
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
		["A test with no case", "By rule: Track without a case", "By rule: Track without a case"],
		["A failed result", advised, advised],
		["A test already failing on the base", "By rule: Already failing on base", advised],
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
	expect(of({ who: "role:approver", reason: "required", notProducer: true })).toBe(
		"A member with role approver who did not report it, with a reason, not an agent",
	);

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

test("why an adoption waits follows its actual clause and ask", () => {
	for (const preset of PRESET_NAMES) {
		for (const subject of ["author:human", "author:agent", "conflict", "policy"]) {
			const clause = clauseOf(PRESETS[preset], { kind: "adopt", facts: new Set([subject, "author:human"]) });
			if (!clause) throw new Error("no adopt clause");
			const asked = { when: clause.when, ask: clause.ask, ruled: false, hidden: 0, special: null };
			const line = whyWaiting(asked);
			if (clause.ask.who === "rule") expect(line).toBeNull();
			else
				expect(line).toBe(
					`Not in effect yet. Under this project's policy, ${subject === "policy" ? "a change to the policy" : subject === "conflict" ? "an edit that conflicts with a newer version" : clause.when.includes("always") ? "every edit" : "an agent's edit"} waits for ${whoAnswers(clause).replace(/^./, (c) => c.toLowerCase())}.`,
				);
		}
	}
	const ask = { who: "member", agents: "none", reason: "optional", notProducer: false } as const;
	const asked = {
		when: ["author:agent", "folder:checkout"],
		ask,
		ruled: false,
		hidden: 0,
		special: null,
	} as const;
	expect(whyWaiting(asked)).toBe(
		"Not in effect yet. Under this project's policy, an agent's edit in checkout waits for a person.",
	);
	expect(whyWaiting({ ...asked, special: "quarantine" })).toBe(
		"Not in effect yet. Every quarantine waits for a person.",
	);
	expect(whyWaiting({ ...asked, special: "refused-replay" })).toContain(
		"Which folders and tags it touches is not known now",
	);
	expect(whyWaiting({ ...asked, ruled: true })).toContain("A rule would answer this, but its answer was set aside");
	expect(whyWaiting({ ...asked, ask: { ...ask, who: "rule" } })).toBeNull();
	// A server from before `asked` sends none: its questions still parse, and say no more than they know.
	expect(QuestionItem.shape.asked.parse(undefined)).toBeUndefined();
	expect(whyWaiting(undefined)).toBeNull();
});
test("every fixed policy predicate is classified for adoption copy", () => {
	expect(Object.keys(ADOPT_PREDICATES).sort()).toEqual(Predicate.options[0].options.toSorted());
});
test("a counted answer keeps the server's warning that accepting would be refused", () => {
	expect(yourAnswerCounts("one member who is not an agent")).toBe("Your answer counts.");
	expect(
		yourAnswerCounts('one member who is not an agent; accepting refused: folder path "Checkout" is ambiguous'),
	).toBe('Your answer counts; accepting refused: folder path "Checkout" is ambiguous.');
});
test("a reply carries each fixed predicate once and a few short scopes, and says how many it left out", () => {
	const folders = Array.from({ length: 50 }, (_, i) => `folder:area${i}`);
	const long = `tag:${"x".repeat(300)}`;
	expect(shownPredicates(["author:agent", ...folders, "author:agent", long, "tag:critical"])).toEqual({
		when: ["author:agent", ...folders.slice(0, 8)],
		hidden: 44,
	});
	expect(shownPredicates(["folder:checkout", "tag:critical", "author:agent"])).toEqual({
		when: ["author:agent", "folder:checkout", "tag:critical"],
		hidden: 0,
	});
	const ask = { who: "member", agents: "none", reason: "optional", notProducer: false } as const;
	const asked = {
		ask,
		ruled: false,
		special: null,
		...shownPredicates(["always", `folder:${"y".repeat(215)}`]),
	};
	expect(whyWaiting(asked)).toBe(
		"Not in effect yet. Under this project's policy, every edit that meets 1 more folder or tag condition waits for a person.",
	);
});
