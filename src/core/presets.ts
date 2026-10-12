// The policy presets: three clause lists over one model (principle P5). A team's strictness is which list is in
// force. `strict` is a fixture that proves the same data works under a policy where a person answers everything;
// the regulated preset proper needs the `gap` kind and role sign-off, which are not built yet.
import { type Ask, type Clause, KINDS, type Kind, type Policy, type PolicySettings } from "./kinds.ts";

const rule: Ask = { who: "rule", agents: "none", notProducer: false, reason: "optional" };
const member: Ask = { who: "member", agents: "advise", notProducer: false, reason: "optional" };
const memberOnly: Ask = { who: "member", agents: "none", notProducer: false, reason: "optional" };
const memberOrAgent: Ask = { who: "member", agents: "answer", notProducer: false, reason: "optional" };
const author: Ask = { who: "author", agents: "none", notProducer: false, reason: "optional" };
const admin: Ask = { who: "admin", agents: "none", notProducer: false, reason: "optional" };

const settings: PolicySettings = {
	basis: "exact-or-assumed",
	holds: { flakyDays: 14, infraThisTargetOnly: true },
};

/** Clauses every preset starts with: a conflict goes to its author, and the policy itself is an admin's to change. */
const common: Clause[] = [
	// The author of a conflicted proposal, a person or an agent, may always withdraw it.
	{
		id: "adopt-withdraw",
		kind: "adopt",
		when: ["conflict", "answer:reject"],
		ask: { ...author, agents: "answer" },
		blocks: "nothing",
	},
	{ id: "adopt-conflict", kind: "adopt", when: ["conflict"], ask: author, blocks: "nothing" },
	{ id: "adopt-policy", kind: "adopt", when: ["policy"], ask: admin, blocks: "nothing" },
];

const loose: Clause[] = [
	...common,
	{ id: "adopt-any", kind: "adopt", when: ["always"], ask: rule, answer: { is: "accept" }, blocks: "nothing" },
	{ id: "map-track", kind: "map", when: ["always"], ask: rule, answer: { is: "track" }, blocks: "nothing" },
	{ id: "failure-disputed", kind: "failure", when: ["hint:disputed"], ask: member, blocks: "all" },
	{
		id: "failure-on-base",
		kind: "failure",
		when: ["scope:change", "hint:fails-on-base"],
		ask: rule,
		answer: { is: "inherited" },
		blocks: "nothing",
	},
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
	{ id: "map-any", kind: "map", when: ["always"], ask: memberOrAgent, blocks: "nothing" },
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
	{ id: "map-any", kind: "map", when: ["always"], ask: reasoned, blocks: "nothing" },
	{ id: "failure-any", kind: "failure", when: ["always"], ask: { ...reasoned, notProducer: true }, blocks: "all" },
	{ id: "finding-any", kind: "finding", when: ["always"], ask: reasoned, blocks: "nothing" },
	{ id: "signoff-any", kind: "signoff", when: ["always"], ask: reasoned, blocks: "nothing" },
];

export type PresetName = "loose" | "standard" | "strict";

export const PRESETS: Record<PresetName, Policy> = {
	loose: { preset: "loose", clauses: loose, settings },
	standard: { preset: "standard", clauses: standard, settings },
	strict: { preset: "strict", clauses: strict, settings: { ...settings, basis: "exact" } },
};

export const PRESET_NAMES = Object.keys(PRESETS) as PresetName[];

/** A policy is total when every kind ends in a clause that always matches, so no question is left unowned. */
export function missingCatchAll(clauses: readonly Clause[]): Kind[] {
	return KINDS.filter((kind) => {
		const last = clauses.filter((c) => c.kind === kind).at(-1);
		return !(last?.when.length === 1 && last.when[0] === "always");
	});
}
