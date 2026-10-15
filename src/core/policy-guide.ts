// What a policy means to someone choosing one: a few sentences per preset, and who answers each everyday question.
// The table is read from the presets' clauses, so it cannot say something a preset does not do. The sentences
// are written by hand and restate the table (a test holds the table, so a changed preset shows up beside them).
import { z } from "zod";
import { ANSWER_LABELS, applicableAnswers, type Clause, clauseOf, type Facts } from "./kinds.ts";
import { PRESETS, type PresetName } from "./presets.ts";

export const PRESET_SUMMARY: Record<PresetName, string> = {
	loose:
		"Edits to cases take effect at once and a test needs no case. A failure already present on the base is excused by rule while its evidence holds. A person answers other failures and findings, and a run that passed closes by itself.",
	standard:
		"An agent's edit waits for a person. A person's own edit still takes effect at once, and a test needs no case.",
	strict:
		"A person, never an agent, answers every edit, test with no case, failure, finding and passed run, and gives a reason. The project can have its tests with no case tracked instead. A policy change and a conflicting edit are handled as under the other presets. Custom clauses can require a named role. Approval by two people is not built yet.",
};

/** The questions the guide lists, each with the facts such a question carries when the server raises it. */
const QUESTIONS: { question: string; facts: Facts }[] = [
	{ question: "A person's edit to a case", facts: { kind: "adopt", facts: new Set(["author:human"]) } },
	{ question: "An agent's edit to a case", facts: { kind: "adopt", facts: new Set(["author:agent"]) } },
	{ question: "A test with no case", facts: { kind: "map", facts: new Set() } },
	{ question: "A failed result", facts: { kind: "failure", facts: new Set(["scope:change"]) } },
	{
		question: "A test already failing on the base",
		facts: { kind: "failure", facts: new Set(["scope:change", "inherited"]) },
	},
	{
		question: "A result that two reports disagree on",
		facts: { kind: "failure", facts: new Set(["scope:run", "hint:disputed"]) },
	},
	{ question: "A finding", facts: { kind: "finding", facts: new Set(["author:agent"]) } },
	{ question: "Closing a run that passed", facts: { kind: "signoff", facts: new Set(["verdict:passed"]) } },
	{
		question: "An edit that conflicts with a newer version",
		facts: { kind: "adopt", facts: new Set(["author:human", "conflict"]) },
	},
	{ question: "A change to the policy", facts: { kind: "adopt", facts: new Set(["author:human", "policy"]) } },
];

const RuleAnswer = z.object({ is: z.string() });

/**
 * Who a clause asks, for a reader who has not met the clause table. `describeAsk` says the same of one open
 * question in the queue's words ("one member who is not an agent"); this names the rule's answer and what an
 * agent's answer is worth, which is what tells the presets apart. It follows `standingOf`.
 */
export function whoAnswers(clause: Clause): string {
	const { ask } = clause;
	const reason = ask.reason === "required" ? ", with a reason" : "";
	switch (ask.who) {
		case "rule": {
			const answer = RuleAnswer.safeParse(clause.answer);
			const label = answer.success ? ANSWER_LABELS[answer.data.is] : undefined;
			return label ? `By rule: ${label}` : "By rule";
		}
		case "author": {
			// An agent that wrote the proposal answers only where the clause lets an agent answer. An admin who is a
			// person may always step in.
			const author = ask.agents === "answer" ? "Its author (person or agent)" : "Its author if a person";
			return `${author}, or an admin${ask.notProducer ? ", excluding whoever reported it" : ""}${reason}`;
		}
		case "member": {
			if (ask.agents === "answer")
				return `A person or an agent${ask.notProducer ? ", excluding whoever reported it" : ""}${reason}`;
			return `A person${ask.notProducer ? " who did not report it" : ""}${reason}${ask.agents === "advise" ? "; agents advise" : ""}`;
		}
		case "admin": {
			const agents = { answer: ", agents included", advise: "; agents advise", none: ", not an agent" }[ask.agents];
			return `An admin${ask.notProducer ? " who did not report it" : ""}${reason}${agents}`;
		}
		default: {
			const who: `role:${string}` = ask.who;
			const agents = { answer: ", agents included", advise: "; agents advise", none: ", not an agent" }[ask.agents];
			return `A member with role ${who.slice(5)}${ask.notProducer ? " who did not report it" : ""}${reason}${agents}`;
		}
	}
}

export type GuideRow = { question: string; answeredBy: Record<PresetName, string> };

const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);

/**
 * Who answers a question under a preset. A clause can single out one answer (`answer:duplicate`), and then who
 * may give that answer differs from who is asked: each such answer is named after the usual one.
 */
function answeredBy(preset: PresetName, facts: Facts): string {
	const who = (answer?: string): string => {
		const clause = clauseOf(PRESETS[preset], answer === undefined ? facts : { ...facts, answer });
		if (!clause) throw new Error(`preset ${preset} has no clause for a ${facts.kind} question`);
		return whoAnswers(clause);
	};
	const usual = who();
	const singled = applicableAnswers(facts.kind, facts.facts)
		.filter((answer) => who(answer) !== usual)
		.map((answer) => `${ANSWER_LABELS[answer] ?? answer}: ${lowerFirst(who(answer))}`);
	return [usual, ...singled].join(". ");
}

/** One row per question, one answer per preset: the comparison shown where a policy is chosen. */
export const PRESET_GUIDE: GuideRow[] = QUESTIONS.map(({ question, facts }) => ({
	question,
	answeredBy: {
		loose: answeredBy("loose", facts),
		standard: answeredBy("standard", facts),
		strict: answeredBy("strict", facts),
	},
}));
