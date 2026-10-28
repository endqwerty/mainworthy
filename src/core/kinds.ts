// The closed vocabulary of questions: each kind, its answers, and who may be asked.
// This file is the one place a kind or an answer is declared (principle P10). The server's kind handlers, the
// queue's keys and the policy presets are checked against it.
import { z } from "zod";
import { FlakyDetectionSettings } from "./flaky.ts";
import { CaseBody, cleanPath, cleanTag, EDIT_MAX, FieldDefinitions, REQUIREMENT_KEY, TAG } from "./model.ts";
import {
	flag as schemaFlag,
	optionalText as schemaOptionalText,
	text as schemaText,
	unknownValue as schemaUnknownValue,
	whole as schemaWhole,
} from "./schema.ts";

export const Kind = z.enum(["adopt", "map", "failure", "finding", "signoff"]);
export type Kind = z.infer<typeof Kind>;
export const KINDS = Kind.options;

/**
 * What every client calls a kind of question: on a row's tag, on the queue's filter, and counted. Unlinked
 * questions are counted by their tests: one is about a file's tests with no case, or about every test that came
 * with no file, so neither questions nor files are what a person is answering for.
 */
export const KIND_WORDS: Record<Kind, { tag: string; filter: string; one: string; many: string }> = {
	adopt: { tag: "proposal", filter: "Proposals", one: "proposal", many: "proposals" },
	map: { tag: "unlinked", filter: "Unlinked", one: "unlinked test", many: "unlinked tests" },
	failure: { tag: "failure", filter: "Failures", one: "failure", many: "failures" },
	finding: { tag: "finding", filter: "Findings", one: "finding", many: "findings" },
	signoff: { tag: "sign-off", filter: "Sign-offs", one: "sign-off", many: "sign-offs" },
};

/** "1 failure", "3 failures", "2 unlinked tests". */
export function countOf(count: number, kind: Kind): string {
	return `${count} ${count === 1 ? KIND_WORDS[kind].one : KIND_WORDS[kind].many}`;
}

export const ActorKind = z.enum(["human", "agent", "ci", "rule"]);
export type ActorKind = z.infer<typeof ActorKind>;

/**
 * What a grant may hold. `record` is a pipeline's whole job: put results and attachments on the
 * record, say that a change ended, and read the verdict.
 * `produce` is everything a producer does (cases, results, reviews, answers) and so includes it.
 */
export const Capability = z.enum(["read", "record", "produce", "answer", "plan", "admin"]);
export type Capability = z.infer<typeof Capability>;

export const Role = schemaText.regex(/^[a-z][a-z0-9-]{0,31}$/);
export type Role = z.infer<typeof Role>;

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

type CapabilityList = readonly [Capability, Capability, ...Capability[]];

/**
 * What an operation asks of its caller: one capability, any one of several, all of several, or `self`.
 *
 * `self` asks for no capability. The operation is about what is the caller's own (their sessions, their ways of
 * signing in), so whoever is signed in may run it, whatever their grants, and the operation says whose things it
 * touches. A pipeline is the exception: its token reaches the operations of its job and no other (decisions
 * 0014 and 0022), and the policy's own actor is never a caller.
 */
export type Need = Capability | "self" | CapabilityList | { readonly all: CapabilityList };
/** The capabilities a need names. None for `self`, which names no capability. */
export const needs = (need: Need): readonly Capability[] =>
	need === "self" ? [] : typeof need === "string" ? [need] : "all" in need ? need.all : need;
export const mayRun = (caller: { kind: ActorKind; can: readonly Capability[] }, need: Need): boolean =>
	need === "self"
		? caller.kind === "human" || caller.kind === "agent"
		: typeof need === "object" && "all" in need
			? need.all.every((capability) => caller.can.includes(capability))
			: needs(need).some((capability) => caller.can.includes(capability));

// ── Answers ────────────────────────────────────────────────────────────────────────────────────────────────

export const AdoptAnswer = z.discriminatedUnion("is", [
	z.object({ is: z.literal("accept") }),
	z.object({ is: z.literal("reject") }),
	/** Resolves a same-field conflict on one case: the author supplies the body to adopt. */
	z.object({
		is: z.literal("merge"),
		body: CaseBody,
		/** Inline additions extracted from the merged body; the conflict fixes their case. */
		tags: z
			.array(schemaText.transform(cleanTag).pipe(schemaText.regex(TAG)))
			.max(EDIT_MAX)
			.optional(),
		covers: z
			.array(
				z
					.string()
					.regex(REQUIREMENT_KEY)
					.transform((key) => key.toUpperCase()),
			)
			.max(EDIT_MAX)
			.optional(),
	}),
]);

export const MapAnswer = z.discriminatedUnion("is", [
	/** Pairs of test ref and case ref: `[["T-12", "C-3"]]`. */
	z.object({ is: z.literal("link"), pairs: z.array(z.tuple([schemaText, schemaText])).min(1) }),
	/** One new case per unlinked test, titled after the test and linked to it. */
	z.object({ is: z.literal("create"), folder: schemaOptionalText }),
	/** Keep the tests as tests without cases; they still have history and a place in the gate. */
	z.object({ is: z.literal("track") }),
	z.object({ is: z.literal("unlink") }),
]);

export const FailureAnswer = z.discriminatedUnion("is", [
	// attributed: the target needs a fix, so its gate is `failed`
	z.object({ is: z.literal("defect"), ref: schemaText.max(200).optional() }),
	z.object({ is: z.literal("test") }),
	z.object({ is: z.literal("expected") }),
	// excused: recorded, not blocking
	z.object({ is: z.literal("flaky") }),
	z.object({ is: z.literal("infra") }),
	/**
	 * Already failing on the base of the change with the same cause. A rule's answer names exact results
	 * and their base evidence. A person's broad answer covers one build.
	 */
	z.object({ is: z.literal("inherited") }),
	/** A disputed slot: the failing result was a mistake and the passing one stands. */
	z.object({ is: z.literal("mistaken") }),
]);
export type FailureAnswer = z.infer<typeof FailureAnswer>;

export const FindingAnswer = z.discriminatedUnion("is", [
	/** `apply`: the finding's suggestion becomes a sealed proposal authored by the finder. */
	z.object({ is: z.literal("accept"), apply: schemaFlag.default(false) }),
	z.object({ is: z.literal("reject") }),
	z.object({ is: z.literal("duplicate"), of: schemaOptionalText }),
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

/**
 * The answers that say the target needs a fix. A cause answered so carries to later commits while it keeps
 * failing, and ends when it passes there: the fix arrived, and a later failure is a new question (decision 0102).
 */
export const ATTRIBUTED = ["defect", "test", "expected"] as const satisfies readonly FailureAnswer["is"][];

/** How a failure answer counts in a run: `attributed` makes the gate `failed`; `excused` does not block. */
export const failureClass = (answer: FailureAnswer): "attributed" | "excused" =>
	(ATTRIBUTED as readonly string[]).includes(answer.is) ? "attributed" : "excused";

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

/**
 * For an answer that ended because the cause passed on another commit of its pull request or branch, one it never
 * failed on (decision 0141): that change, and how it stands now. The change fixed the failure itself, so no issue
 * need track it.
 */
export const FixedIn = z.object({ change: schemaText, state: z.enum(["open", "merged", "closed"]) });
export type FixedIn = z.infer<typeof FixedIn>;

/**
 * What a screen says about how an answer ended: the change that fixed it (`FixedIn`), or who ended it, a rule or
 * people.
 */
export function endingText(ending: { fixedIn?: FixedIn | undefined; rule: string | null; by: string[] }): string {
	const { fixedIn, rule, by } = ending;
	if (!fixedIn) return `Ended by ${rule ? `rule ${rule}` : by.join(", ")}`;
	const ended = { open: "", merged: ", which merged", closed: ", which closed without merging" }[fixedIn.state];
	return `Fixed by another commit of ${fixedIn.change}${ended}`;
}

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
 * exactly these, and the server refuses failure and adoption answers outside them.
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
 * - `role:<name>`: an actor with `answer` and that named role on the project.
 * - `author`: the author of the proposal the question is about (a conflict only its author can resolve).
 */
export const Ask = z.object({
	approvals: z.number().int().min(1).optional(),
	who: z.union([
		z.enum(["rule", "member", "admin", "author"]),
		z.templateLiteral(["role:", Role]).meta({ "x-mcp-hidden": true }),
	]),
	/** What an agent's answer is worth: counted, shown as advice, or refused. */
	agents: z.enum(["answer", "advise", "none"]),
	/** When true, an actor who produced the evidence in question may not settle it. */
	notProducer: schemaFlag,
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
		"inherited",
		"category:defect",
		"verdict:passed",
		// What the project's own `unlinked` setting says, so a clause can test a setting like any other fact.
		"unlinked:track",
		"unlinked:create",
	]),
	schemaText.regex(/^(?:answer:[a-z]+|(?:folder|tag):.*)$/),
]);
export type Predicate = z.infer<typeof Predicate>;

function normalisedPredicate(predicate: Predicate): Predicate {
	if (predicate.startsWith("folder:"))
		return `folder:${cleanPath(predicate.slice(7)).join("/").toLowerCase().normalize("NFC")}`;
	if (predicate.startsWith("tag:")) return `tag:${cleanTag(predicate.slice(4))}`;
	return predicate;
}

/**
 * How urgent an open question is and which runs it lists: nothing, the gate of its change, a release (planned
 * run), or both. It does not decide a verdict (see `retally`).
 */
export const Blocks = z.enum(["nothing", "change", "release", "all"]);
export type Blocks = z.infer<typeof Blocks>;

export const Clause = z
	.object({
		id: schemaText.regex(/^[a-z0-9-]+$/),
		kind: Kind,
		/** Every predicate must hold. The first matching clause of a kind wins. */
		when: z.array(Predicate).min(1),
		ask: Ask,
		/** For `who: rule`: the answer the rule gives. */
		answer: schemaUnknownValue.optional(),
		blocks: Blocks,
	})
	.superRefine((clause, ctx) => {
		if (
			(clause.ask.approvals ?? 1) > 1 &&
			(clause.kind !== "signoff" ||
				clause.ask.who === "rule" ||
				clause.ask.who === "author" ||
				clause.ask.agents !== "none")
		)
			ctx.addIssue({
				code: "custom",
				path: ["ask", "approvals"],
				message: "Multiple approvals require a sign-off clause asking people, with agents: none",
			});
		for (const [index, predicate] of clause.when.entries()) {
			const normalised = normalisedPredicate(predicate);
			const valid = predicate.startsWith("folder:")
				? normalised.length > 7
				: !predicate.startsWith("tag:") || TAG.test(normalised.slice(4));
			if (predicate !== normalised || !valid) {
				ctx.addIssue({
					code: "custom",
					path: ["when", index],
					message: `clause "${clause.id}": ${JSON.stringify(predicate)} ${valid ? "must be written in its normalised form" : "is not a valid scope predicate; normalised form"} ${JSON.stringify(normalised)}`,
				});
			}
		}
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
	/** Project definitions for the case body's string-valued custom fields. */
	fields: FieldDefinitions.optional().meta({ "x-mcp-hidden": true }),
	flakyDetection: FlakyDetectionSettings,
	unlinked: Unlinked,
	/** An explicit CI declaration may pass a commit with no ordinary reports. */
	emptyReports: z.enum(["pending", "nothing-required"]).default("pending"),
	/** Which bases a planned run's slots accept by default. */
	basis: z.enum(["exact", "exact-or-assumed"]),
	holds: z.object({
		/** A `flaky` answer stops carrying forward after this many days. */
		flakyDays: schemaWhole.min(1).max(365),
		/** An `infra` excuse covers the build it was given for, and no other, when true. */
		infraThisTargetOnly: schemaFlag,
	}),
});
export type PolicySettings = z.infer<typeof PolicySettings>;

export const Policy = z.object({
	preset: schemaText,
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
	return q.facts.has(normalisedPredicate(predicate));
}

/**
 * Whether an actor's answer counts, is advice, or is refused. Pure: policy and identity in, standing out.
 * `isAuthor` and `isProducer` are facts about this actor and this question that the caller looks up.
 */
export function standingOf(input: {
	actor: { kind: ActorKind; can: readonly Capability[]; roles?: readonly Role[] };
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
	const role =
		ask.who === "admin"
			? actor.can.includes("admin")
			: actor.can.includes("answer") && (ask.who === "member" || actor.roles?.includes(ask.who.slice(5)) === true);
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
	const who: Record<Exclude<Ask["who"], `role:${string}`>, string> = {
		rule: "a rule",
		member: "one member",
		admin: "an admin",
		author: "the author of the proposal",
	};
	const parts = [
		ask.who === "rule" || ask.who === "member" || ask.who === "admin" || ask.who === "author"
			? who[ask.who]
			: `a member with role ${ask.who.slice(5)}`,
	];
	if (ask.notProducer) parts.push("who did not produce the evidence");
	if (ask.agents === "none") parts.push("who is not an agent");
	if (ask.reason === "required") parts.push("with a reason");
	return (ask.approvals ?? 1) > 1
		? `${ask.approvals} distinct people; each must be ${parts.join(" ").replace(/^one member/, "a member")}`
		: parts.join(" ");
}

/** The most answers or withdrawals one `decide` request carries, and so the Queue selection limit. */
export const DECIDE_MAX = 500;
