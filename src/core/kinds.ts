// The closed vocabulary of questions: each kind, its answers, and who may be asked.
// This file is the one place a kind or an answer is declared (principle P10). The server's kind handlers, the
// queue's keys and the policy presets are checked against it.
import { z } from "zod";
import { CaseBody } from "./model.ts";

export const Kind = z.enum(["adopt", "map", "failure", "finding", "signoff"]);
export type Kind = z.infer<typeof Kind>;
export const KINDS = Kind.options;

export const ActorKind = z.enum(["human", "agent", "ci", "rule"]);
export type ActorKind = z.infer<typeof ActorKind>;

/**
 * What a grant may hold. `record` is a pipeline's whole job: put results on the record, say that a change
 * ended, and read the verdict.
 * `produce` is everything a producer does (cases, results, reviews, answers) and so includes it.
 */
export const Capability = z.enum(["read", "record", "produce", "answer", "plan", "admin"]);
export type Capability = z.infer<typeof Capability>;

/** What holding one capability also gives. Nothing else implies anything. */
const IMPLIES: Partial<Record<Capability, readonly Capability[]>> = { produce: ["record"] };
/**
 * The most a pipeline may hold, whatever its grant says: it records, and it may be let read. It never changes the
 * suite, answers, plans or administers, under any policy, because it cannot call the operations that do.
 */
export const CI_CAPABILITIES: readonly Capability[] = ["read", "record"];

/**
 * What an actor of this kind holds, given the capabilities its grants list. The one place a stored grant becomes
 * authority: the implied capabilities are added, and a pipeline is held to `CI_CAPABILITIES`.
 */
export function heldCapabilities(kind: ActorKind, granted: Iterable<Capability>): Capability[] {
	const held = new Set<Capability>();
	for (const capability of granted) {
		held.add(capability);
		for (const implied of IMPLIES[capability] ?? []) held.add(implied);
	}
	return Capability.options.filter(
		(capability) => held.has(capability) && (kind !== "ci" || CI_CAPABILITIES.includes(capability)),
	);
}

/** Why an actor of this kind may not be granted these capabilities, or null when it may. */
export function whyNotGrantable(kind: ActorKind, can: readonly Capability[]): string | null {
	if (kind === "rule") return "a rule holds no grant";
	const beyond = kind === "ci" ? can.filter((capability) => !CI_CAPABILITIES.includes(capability)) : [];
	return beyond.length > 0
		? `a pipeline may hold ${CI_CAPABILITIES.join(" and ")}, not ${beyond.join(", ")}; give an agent or a person the rest`
		: null;
}

/** What a new actor of this kind is granted when nobody says: a person everything, an agent the work, a pipeline its job. */
export function defaultCapabilities(kind: Exclude<ActorKind, "rule">): readonly Capability[] {
	switch (kind) {
		case "human":
			return Capability.options;
		case "agent":
			return ["read", "produce"];
		case "ci":
			return ["record"];
		default: {
			const _exhaustive: never = kind;
			return _exhaustive;
		}
	}
}

/**
 * What an operation asks of its caller: one capability, any one of several, or `self`.
 *
 * `self` asks for no capability. The operation is about what is the caller's own (their sessions, their ways of
 * signing in), so whoever is signed in may run it, whatever their grants, and the operation says whose things it
 * touches. A pipeline is the exception: its token reaches the operations of its job and no other (decisions
 * 0014 and 0022), and the policy's own actor is never a caller.
 */
export type Need = Capability | "self" | readonly [Capability, Capability, ...Capability[]];
/** The capabilities a need names, any one of which is enough. None for `self`, which names no capability. */
export const needs = (need: Need): readonly Capability[] =>
	need === "self" ? [] : typeof need === "string" ? [need] : need;
export const mayRun = (caller: { kind: ActorKind; can: readonly Capability[] }, need: Need): boolean =>
	need === "self"
		? caller.kind === "human" || caller.kind === "agent"
		: needs(need).some((capability) => caller.can.includes(capability));

// ── Answers ────────────────────────────────────────────────────────────────────────────────────────────────

export const AdoptAnswer = z.discriminatedUnion("is", [
	z.object({ is: z.literal("accept") }),
	z.object({ is: z.literal("reject") }),
	/** Resolves a same-field conflict on one case: the author supplies the body to adopt. */
	z.object({ is: z.literal("merge"), body: CaseBody }),
]);

export const MapAnswer = z.discriminatedUnion("is", [
	/** Pairs of test ref and case ref: `[["T-12", "C-3"]]`. */
	z.object({ is: z.literal("link"), pairs: z.array(z.tuple([z.string(), z.string()])).min(1) }),
	/** One new case per unlinked test, titled after the test and linked to it. */
	z.object({ is: z.literal("create"), folder: z.string().optional() }),
	/** Keep the tests as tests without cases; they still have history and a place in the gate. */
	z.object({ is: z.literal("track") }),
	z.object({ is: z.literal("unlink") }),
]);

export const FailureAnswer = z.discriminatedUnion("is", [
	// attributed: the target needs a fix, so its gate is `failed`
	z.object({ is: z.literal("defect"), ref: z.string().max(200).optional() }),
	z.object({ is: z.literal("test") }),
	z.object({ is: z.literal("expected") }),
	// excused: recorded, not blocking
	z.object({ is: z.literal("flaky") }),
	z.object({ is: z.literal("infra") }),
	/**
	 * Already failing on the base of the change with the same cause; not this change's doing. A person's answer
	 * for the build they were looking at: no rule gives it, and the next commit is asked about again.
	 */
	z.object({ is: z.literal("inherited") }),
	/** A disputed slot: the failing result was a mistake and the passing one stands. */
	z.object({ is: z.literal("mistaken") }),
]);
export type FailureAnswer = z.infer<typeof FailureAnswer>;

export const FindingAnswer = z.discriminatedUnion("is", [
	/** `apply`: the finding's suggestion becomes a sealed proposal authored by the finder. */
	z.object({ is: z.literal("accept"), apply: z.boolean().default(false) }),
	z.object({ is: z.literal("reject") }),
	z.object({ is: z.literal("duplicate"), of: z.string().optional() }),
	z.object({ is: z.literal("defer") }),
]);

export const SignoffAnswer = z.discriminatedUnion("is", [
	z.object({ is: z.literal("approve") }),
	z.object({ is: z.literal("reject") }),
]);

export const ANSWERS = {
	adopt: AdoptAnswer,
	map: MapAnswer,
	failure: FailureAnswer,
	finding: FindingAnswer,
	signoff: SignoffAnswer,
} as const satisfies Record<Kind, z.ZodType>;

export type AnswerOf<K extends Kind> = z.infer<(typeof ANSWERS)[K]>;
export type AnyAnswer = { [K in Kind]: AnswerOf<K> }[Kind];

/** How a failure answer counts in a run: `attributed` makes the gate `failed`; `excused` does not block. */
export function failureClass(answer: FailureAnswer): "attributed" | "excused" {
	switch (answer.is) {
		case "defect":
		case "test":
		case "expected":
			return "attributed";
		case "flaky":
		case "infra":
		case "inherited":
		case "mistaken":
			return "excused";
		default: {
			const _exhaustive: never = answer;
			return _exhaustive;
		}
	}
}

/**
 * The single key that gives each answer in the queue (commitment L4). Checked for uniqueness per kind by a test,
 * and read by the UI, so the keys are declared here and nowhere else.
 */
export const ANSWER_KEYS = {
	adopt: { a: "accept", r: "reject" },
	map: { l: "link", c: "create", t: "track" },
	failure: { d: "defect", t: "test", e: "expected", f: "flaky", i: "infra", n: "inherited", m: "mistaken" },
	finding: { a: "accept", r: "reject", d: "duplicate", z: "defer" },
	signoff: { a: "approve", r: "reject" },
} as const satisfies Record<Kind, Record<string, string>>;

export const ANSWER_LABELS: Record<string, string> = {
	accept: "Accept",
	reject: "Reject",
	merge: "Merge",
	link: "Link to a case",
	create: "Create cases",
	track: "Track without a case",
	unlink: "Unlink",
	defect: "Defect in the product",
	test: "The test is wrong",
	expected: "Expected: behaviour changed",
	flaky: "Flaky",
	infra: "Infrastructure",
	inherited: "Already failing on base",
	mistaken: "The failure was a mistake",
	duplicate: "Duplicate",
	defer: "Defer",
	approve: "Approve",
	// Rows the ledger writes itself: a decision was withdrawn, ran out of time, or was overtaken by new evidence.
	withdrawn: "Withdrawn",
	expired: "Expired",
	outdated: "The evidence changed",
};

/**
 * What each answer does, in one sentence, shown beside its key so nobody has to stop and work out what a key
 * will do before pressing it. Declared here once; the queue prints it.
 */
export const ANSWER_HELP = {
	adopt: {
		accept: "Makes this the current version.",
		reject: "Leaves the case as it is. The proposal stays in the history.",
		merge: "Adopts the version you put together from both sides.",
	},
	map: {
		link: "Results of this test count for the case from now on.",
		create: "Makes one case per test and links them.",
		track: "Keeps them as tests without cases. They still gate the build.",
		unlink: "The test stops counting for its case.",
	},
	failure: {
		defect: "A product bug. The gate fails until a build passes.",
		test: "The test is wrong. The gate fails until the test is fixed.",
		expected: "The behaviour changed on purpose. The gate fails until the case and the test say so.",
		flaky: "Unreliable. Not blocking; asked again when the hold runs out or the evidence changes.",
		infra: "The environment, not the product. Excused for this build only.",
		inherited: "Already failing where this change started. Not this change's doing.",
		mistaken: "The failing result was a mistake. The passing result stands.",
	},
	finding: {
		accept: "Agree. A suggestion it carries becomes a proposed edit by its author.",
		reject: "Disagree. It is not raised again for this version.",
		duplicate: "Already covered by another finding.",
		defer: "Not now. It stays on record.",
	},
	signoff: {
		approve: "Closes the run with the verdict it has now.",
		reject: "Leaves the run open.",
	},
} as const satisfies Record<Kind, Record<string, string>>;

/**
 * The answers that make sense for one question, in key order. A failure on trunk cannot be "already failing on
 * the base", and "the failure was a mistake" exists only where a pass and a fail disagree. The queue offers
 * exactly these, and the server refuses a failure answer outside them.
 */
export function applicableAnswers(kind: Kind, facts: ReadonlySet<string>): string[] {
	switch (kind) {
		case "adopt":
			return facts.has("conflict") ? ["merge", "reject"] : ["accept", "reject"];
		case "map":
			return ["link", "create", "track"];
		case "failure":
			return [
				"defect",
				"test",
				"expected",
				"flaky",
				"infra",
				...(facts.has("scope:change") ? ["inherited"] : []),
				...(facts.has("hint:disputed") ? ["mistaken"] : []),
			];
		case "finding":
			return ["accept", "reject", "duplicate", "defer"];
		case "signoff":
			return ["approve", "reject"];
		default: {
			const _exhaustive: never = kind;
			return _exhaustive;
		}
	}
}

// ── Who is asked ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * Who must answer a question.
 * - `rule`: the policy answers at once with the clause's `answer`, and the decision is recorded like any other.
 *   Once a person has answered the question otherwise, the rule does not answer it again when that answer ends:
 *   a person is asked until a person gives the rule's answer.
 * - `member`: an actor with the `answer` capability.
 * - `admin`: an actor with the `admin` capability.
 * - `author`: the author of the proposal the question is about (a conflict only its author can resolve).
 */
export const Ask = z.object({
	who: z.enum(["rule", "member", "admin", "author"]),
	/** What an agent's answer is worth: counted, shown as advice, or refused. */
	agents: z.enum(["answer", "advise", "none"]),
	/** When true, an actor who produced the evidence in question may not settle it. */
	notProducer: z.boolean(),
	reason: z.enum(["optional", "required"]),
});
export type Ask = z.infer<typeof Ask>;

/**
 * The conditions a clause can test. A closed list: a clause is data, never code.
 * `answer:<is>` matches only once an answer is on the table, so a clause can treat one answer differently.
 */
export const Predicate = z.union([
	z.enum([
		"always",
		"author:human",
		"author:agent",
		"author:ci",
		"conflict",
		"policy",
		"scope:change",
		"scope:trunk",
		"scope:run",
		"hint:disputed",
		"category:defect",
		"verdict:passed",
		// What the project's own `unlinked` setting says, so a clause can test a setting like any other fact.
		"unlinked:track",
		"unlinked:create",
	]),
	z.templateLiteral(["answer:", z.string().regex(/^[a-z]+$/)]),
]);
export type Predicate = z.infer<typeof Predicate>;

/**
 * How urgent an open question is and which runs it lists: nothing, the gate of its change, a release (planned
 * run), or both. It does not decide a verdict (see `retally`).
 */
export const Blocks = z.enum(["nothing", "change", "release", "all"]);
export type Blocks = z.infer<typeof Blocks>;

export const Clause = z.object({
	id: z.string().regex(/^[a-z0-9-]+$/),
	kind: Kind,
	/** Every predicate must hold. The first matching clause of a kind wins. */
	when: z.array(Predicate).min(1),
	ask: Ask,
	/** For `who: rule`: the answer the rule gives. */
	answer: z.unknown().optional(),
	blocks: Blocks,
});
export type Clause = z.infer<typeof Clause>;

/**
 * What happens to a test that arrives with no case. `ask`: a question in the queue, one per file. `track`: the
 * test is kept without a case and nobody is asked. `create`: a case is made for each test and linked to it.
 */
export const Unlinked = z.enum(["ask", "track", "create"]);
export type Unlinked = z.infer<typeof Unlinked>;

export const UNLINKED_LABELS: Record<Unlinked, string> = {
	ask: "Ask in the queue",
	track: "Track without a case",
	create: "Create a case for each test",
};

/** What each choice does, in a sentence, shown where the choice is made. */
export const UNLINKED_HELP: Record<Unlinked, string> = {
	ask: "Each file with such tests is one question in the queue. It blocks nothing.",
	track: "The tests are kept without cases and nobody is asked. They still gate the build.",
	create: "A case is made for each test, named after it and linked to it. Nobody is asked.",
};

/** What a project may change without touching a clause (open questions 12 and 25). */
export const PolicySettings = z.object({
	unlinked: Unlinked,
	/** Which bases a planned run's slots accept by default. */
	basis: z.enum(["exact", "exact-or-assumed"]),
	holds: z.object({
		/** A `flaky` answer stops carrying forward after this many days. */
		flakyDays: z.number().int().min(1).max(365),
		/** An `infra` excuse covers the build it was given for, and no other, when true. */
		infraThisTargetOnly: z.boolean(),
	}),
});
export type PolicySettings = z.infer<typeof PolicySettings>;

export const Policy = z.object({
	preset: z.string(),
	clauses: z.array(Clause),
	settings: PolicySettings,
});
export type Policy = z.infer<typeof Policy>;

/** What a clause is matched against: the facts of a question, plus the answer once one is proposed. */
export type Facts = { kind: Kind; facts: ReadonlySet<string>; answer?: string };

/** The facts a policy's settings add to every question it is asked about. */
const settingFacts = (settings: PolicySettings): string[] =>
	settings.unlinked === "ask" ? [] : [`unlinked:${settings.unlinked}`];

/**
 * The clause of a policy that owns a question, or null if the policy is not total: the first clause of the
 * question's kind whose predicates all hold, the policy's settings counted among the facts.
 */
export function clauseOf(policy: Pick<Policy, "clauses" | "settings">, q: Facts): Clause | null {
	const added = settingFacts(policy.settings);
	const facts = added.length === 0 ? q : { ...q, facts: new Set([...q.facts, ...added]) };
	for (const clause of policy.clauses) {
		if (clause.kind !== q.kind) continue;
		if (clause.when.every((p) => holds(p, facts))) return clause;
	}
	return null;
}

function holds(predicate: Predicate, q: Facts): boolean {
	if (predicate === "always") return true;
	if (predicate.startsWith("answer:")) return q.answer !== undefined && predicate === `answer:${q.answer}`;
	return q.facts.has(predicate);
}

/**
 * Whether an actor's answer counts, is advice, or is refused. Pure: policy and identity in, standing out.
 * `isAuthor` and `isProducer` are facts about this actor and this question that the caller looks up.
 */
export function standingOf(input: {
	actor: { kind: ActorKind; can: readonly Capability[] };
	ask: Ask;
	isAuthor: boolean;
	isProducer: boolean;
}): "counts" | "advice" | "forbidden" {
	const { actor, ask } = input;
	if (actor.kind === "ci") return "forbidden";
	if (ask.who === "author") {
		// Only the proposal's author, or an admin stepping in. An agent author counts only where the clause says an
		// agent may answer (withdrawing its own proposal), so an agent cannot push its own conflict through.
		const stands = input.isAuthor
			? !(actor.kind === "agent" && ask.agents !== "answer")
			: actor.kind === "human" && actor.can.includes("admin");
		if (!stands) return "forbidden";
		// The clause's other condition holds for the author and for the administrator alike.
		return ask.notProducer && input.isProducer ? "forbidden" : "counts";
	}
	if (ask.who === "rule") {
		// A rule answered or will answer. A person with the right may still overrule it; nobody else may.
		return actor.kind === "human" && actor.can.includes("answer") ? "counts" : "forbidden";
	}
	// From here a clause is held to everything it asks at once: the role, whether an agent may answer, and who
	// produced the evidence. None of the three is skipped because another was met first.
	const role = ask.who === "admin" ? actor.can.includes("admin") : actor.can.includes("answer");
	if (actor.kind === "agent") {
		if (ask.agents === "none") return "forbidden";
		if (!actor.can.includes("produce") && !actor.can.includes("answer")) return "forbidden";
		// An agent that the clause lets speak, but whose answer does not count (the clause wants advice only, it
		// lacks the right or the role, or it produced the evidence), advises: a person decides.
		if (ask.agents === "advise" || !actor.can.includes("answer") || !role) return "advice";
		return ask.notProducer && input.isProducer ? "advice" : "counts";
	}
	if (!role) return "forbidden";
	if (ask.notProducer && input.isProducer) return "forbidden";
	return "counts";
}

/** One sentence saying who a question is waiting for, shown in the queue and returned to an agent. */
export function describeAsk(ask: Ask): string {
	const who: Record<Ask["who"], string> = {
		rule: "a rule",
		member: "one member",
		admin: "an admin",
		author: "the author of the proposal",
	};
	const parts = [who[ask.who]];
	if (ask.notProducer) parts.push("who did not produce the evidence");
	if (ask.agents === "none") parts.push("who is not an agent");
	if (ask.reason === "required") parts.push("with a reason");
	return parts.join(" ");
}
