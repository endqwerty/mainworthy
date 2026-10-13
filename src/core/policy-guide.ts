// What a policy means to someone choosing one: a sentence per preset, and who answers each everyday question.
// The table is read from the presets' clauses, so it cannot say something a preset does not do. The sentences
// are written by hand and restate the table (a test holds the table, so a changed preset shows up beside them).
import { z } from "zod";
import { ANSWER_LABELS, Clause, type Facts, firstMatch, type Policy } from "./kinds.ts";
import { PRESET_NAMES, PRESETS, type PresetName } from "./presets.ts";

export const PRESET_SUMMARY: Record<PresetName, string> = {
	loose:
		"Edits take effect at once and a test needs no case. A person is asked about failures and findings, and a run that passed closes by itself.",
	standard:
		"An agent's edit waits for a person, and a test with no case is a question. A person's own edit still takes effect at once.",
	strict:
		"A person answers every question and gives a reason, and no agent's answer counts. Approval by a named role or by two people is not built yet.",
};

/**
 * The questions the guide lists, each with the facts such a question carries when the server raises it. Conflicts
 * and policy changes are left out: every preset starts with the same clauses for them, and the guide says so in
 * a line of its own.
 */
const QUESTIONS: { question: string; facts: Facts }[] = [
	{ question: "A person's edit to a case", facts: { kind: "adopt", facts: new Set(["author:human"]) } },
	{ question: "An agent's edit to a case", facts: { kind: "adopt", facts: new Set(["author:agent"]) } },
	{ question: "A test with no case", facts: { kind: "map", facts: new Set() } },
	{ question: "A failed result", facts: { kind: "failure", facts: new Set(["scope:change"]) } },
	{
		question: "A result that two reports disagree on",
		facts: { kind: "failure", facts: new Set(["scope:run", "hint:disputed"]) },
	},
	{ question: "A finding", facts: { kind: "finding", facts: new Set(["author:agent"]) } },
	{ question: "Closing a run that passed", facts: { kind: "signoff", facts: new Set(["verdict:passed"]) } },
];

const RuleAnswer = z.object({ is: z.string() });

/**
 * Who a clause asks, for a reader who has not met the clause table. `describeAsk` says the same of one open
 * question in the queue's words ("one member who is not an agent"); this names the rule's answer and what an
 * agent's answer is worth, which is what tells the presets apart.
 */
export function whoAnswers(clause: Clause): string {
	const { ask } = clause;
	const conditions = `${ask.notProducer ? " who did not report it" : ""}${ask.reason === "required" ? ", with a reason" : ""}`;
	switch (ask.who) {
		case "rule": {
			const answer = RuleAnswer.safeParse(clause.answer);
			const label = answer.success ? ANSWER_LABELS[answer.data.is] : undefined;
			return label ? `By rule: ${label}` : "By rule";
		}
		case "author":
			// An agent that wrote the proposal answers only where the clause lets an agent answer.
			return `Its author${ask.agents === "answer" ? "" : ", unless an agent"}${conditions}`;
		case "member":
			return `A person${ask.agents === "answer" ? " or an agent" : ""}${conditions}${ask.agents === "advise" ? "; agents advise" : ""}`;
		case "admin": {
			const agents = { answer: ", agents included", advise: "; agents advise", none: ", not an agent" }[ask.agents];
			return `An admin${conditions}${agents}`;
		}
		default: {
			const _exhaustive: never = ask.who;
			return _exhaustive;
		}
	}
}

export type GuideRow = { question: string; answeredBy: Record<PresetName, string> };

const answeredBy = (preset: PresetName, facts: Facts): string => {
	const clause = firstMatch(PRESETS[preset].clauses, facts);
	if (!clause) throw new Error(`preset ${preset} has no clause for a ${facts.kind} question`);
	return whoAnswers(clause);
};

/** One row per question, one answer per preset: the comparison shown where a policy is chosen. */
export const PRESET_GUIDE: GuideRow[] = QUESTIONS.map(({ question, facts }) => ({
	question,
	answeredBy: {
		loose: answeredBy("loose", facts),
		standard: answeredBy("standard", facts),
		strict: answeredBy("strict", facts),
	},
}));

const canonical = (clauses: readonly Clause[]): string => JSON.stringify(Clause.array().parse(clauses));

/**
 * The preset a policy is, or null. A policy can carry a preset's name over clauses of its own (an edit may name
 * both), and then the preset's sentence would describe a table that is not in force.
 */
export function presetOf(policy: Pick<Policy, "preset" | "clauses">): PresetName | null {
	const name = PRESET_NAMES.find((preset) => preset === policy.preset);
	return name && canonical(policy.clauses) === canonical(PRESETS[name].clauses) ? name : null;
}
