// The policy presets: three clause lists over one model (principle P5). A team's strictness is which list is in
// force. `strict` is a fixture that proves the same data works under a policy where a person answers everything;
// the regulated preset proper needs the `gap` kind and role sign-off, which are not built yet.
import { type Ask, Clause, KINDS, type Kind, type Policy, type PolicySettings } from "./kinds.ts";

const rule: Ask = { who: "rule", agents: "none", notProducer: false, reason: "optional" };
const member: Ask = { who: "member", agents: "advise", notProducer: false, reason: "optional" };
const memberOnly: Ask = { who: "member", agents: "none", notProducer: false, reason: "optional" };
const memberOrAgent: Ask = { who: "member", agents: "answer", notProducer: false, reason: "optional" };
const author: Ask = { who: "author", agents: "none", notProducer: false, reason: "optional" };
const admin: Ask = { who: "admin", agents: "none", notProducer: false, reason: "optional" };

const settings: PolicySettings = {
	unlinked: "track",
	basis: "exact-or-assumed",
	holds: { flakyDays: 14, infraThisTargetOnly: true },
};

/**
 * Clauses every preset starts with: the policy itself is an admin's to change, and a conflict goes to its author.
 * The policy clause comes before the conflict clause, so a proposal that touches the policy needs an admin whatever
 * else it carries. Resolving a conflict adopts nothing by itself: the resolution is a new proposal, and the
 * clauses below decide who adopts it.
 */
const common: Clause[] = [
	// The author of a conflicted proposal, a person or an agent, may always withdraw it.
	{
		id: "adopt-withdraw",
		kind: "adopt",
		when: ["conflict", "answer:reject"],
		ask: { ...author, agents: "answer" },
		blocks: "nothing",
	},
	{ id: "adopt-policy", kind: "adopt", when: ["policy"], ask: admin, blocks: "nothing" },
	{ id: "adopt-conflict", kind: "adopt", when: ["conflict"], ask: author, blocks: "nothing" },
];

/**
 * A test with no case, in every preset: the project's `unlinked` setting says whether a rule tracks it, a rule
 * makes its case, or somebody is asked. The presets differ in the setting they start with and in who is asked.
 */
const unlinked = (ask: Ask): Clause[] => [
	{ id: "map-track", kind: "map", when: ["unlinked:track"], ask: rule, answer: { is: "track" }, blocks: "nothing" },
	{ id: "map-create", kind: "map", when: ["unlinked:create"], ask: rule, answer: { is: "create" }, blocks: "nothing" },
	{ id: "map-any", kind: "map", when: ["always"], ask, blocks: "nothing" },
];

const loose: Clause[] = [
	...common,
	{ id: "adopt-any", kind: "adopt", when: ["always"], ask: rule, answer: { is: "accept" }, blocks: "nothing" },
	...unlinked(memberOrAgent),
	{ id: "failure-disputed", kind: "failure", when: ["hint:disputed"], ask: member, blocks: "all" },
	{ id: "failure-change", kind: "failure", when: ["scope:change"], ask: member, blocks: "change" },
	{ id: "failure-any", kind: "failure", when: ["always"], ask: member, blocks: "release" },
	{ id: "finding-duplicate", kind: "finding", when: ["answer:duplicate"], ask: memberOrAgent, blocks: "nothing" },
	{ id: "finding-any", kind: "finding", when: ["always"], ask: member, blocks: "nothing" },
	{
		id: "signoff-passed",
		kind: "signoff",
		when: ["verdict:passed"],
		ask: rule,
		answer: { is: "approve" },
		blocks: "nothing",
	},
	{ id: "signoff-any", kind: "signoff", when: ["always"], ask: memberOnly, blocks: "nothing" },
];

const standard: Clause[] = [
	...common,
	{ id: "adopt-agent", kind: "adopt", when: ["author:agent"], ask: memberOnly, blocks: "nothing" },
	{ id: "adopt-any", kind: "adopt", when: ["always"], ask: rule, answer: { is: "accept" }, blocks: "nothing" },
	...unlinked(memberOrAgent),
	{
		id: "failure-disputed",
		kind: "failure",
		when: ["hint:disputed"],
		ask: { ...memberOnly, notProducer: true },
		blocks: "all",
	},
	{ id: "failure-change", kind: "failure", when: ["scope:change"], ask: member, blocks: "change" },
	{ id: "failure-any", kind: "failure", when: ["always"], ask: member, blocks: "release" },
	{ id: "finding-any", kind: "finding", when: ["always"], ask: member, blocks: "nothing" },
	// Until role sign-off is built, `standard` closes a passed run by rule, and the ledger names this clause.
	{
		id: "signoff-passed-preview",
		kind: "signoff",
		when: ["verdict:passed"],
		ask: rule,
		answer: { is: "approve" },
		blocks: "nothing",
	},
	{ id: "signoff-any", kind: "signoff", when: ["always"], ask: memberOnly, blocks: "nothing" },
];

const reasoned: Ask = { who: "member", agents: "none", notProducer: false, reason: "required" };

const strict: Clause[] = [
	...common,
	{ id: "adopt-any", kind: "adopt", when: ["always"], ask: reasoned, blocks: "nothing" },
	...unlinked(reasoned),
	{ id: "failure-any", kind: "failure", when: ["always"], ask: { ...reasoned, notProducer: true }, blocks: "all" },
	{ id: "finding-any", kind: "finding", when: ["always"], ask: reasoned, blocks: "nothing" },
	{ id: "signoff-any", kind: "signoff", when: ["always"], ask: reasoned, blocks: "nothing" },
];

export type PresetName = "loose" | "standard" | "strict";

export const PRESETS: Record<PresetName, Policy> = {
	loose: { preset: "loose", clauses: loose, settings },
	standard: { preset: "standard", clauses: standard, settings },
	strict: { preset: "strict", clauses: strict, settings: { ...settings, unlinked: "ask", basis: "exact" } },
};

export const PRESET_NAMES = Object.keys(PRESETS) as PresetName[];

const canonical = (clauses: readonly Clause[]): string => JSON.stringify(Clause.array().parse(clauses));

/**
 * The preset a policy is, or null. A policy can carry a preset's name over clauses of its own (an edit may name
 * both, and a stored policy keeps its clauses when a later release changes the preset), so the name alone does
 * not say what is in force.
 */
export function presetOf(policy: Pick<Policy, "preset" | "clauses">): PresetName | null {
	const name = PRESET_NAMES.find((preset) => preset === policy.preset);
	return name && canonical(policy.clauses) === canonical(PRESETS[name].clauses) ? name : null;
}

/** A policy is total when every kind ends in a clause that always matches, so no question is left unowned. */
export function missingCatchAll(clauses: readonly Clause[]): Kind[] {
	return KINDS.filter((kind) => {
		const last = clauses.filter((c) => c.kind === kind).at(-1);
		return !(last?.when.length === 1 && last.when[0] === "always");
	});
}
