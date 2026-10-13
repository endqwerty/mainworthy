// The wire contract of every operation: one input schema and one output type each. The HTTP API, the OpenAPI
// document, the MCP tools, the CLI and the web client are all derived from these, so a shape is declared once.
import { z } from "zod";
import { DURATION_FORMAT, DURATION_PATTERN } from "./duration.ts";
import {
	ActorKind,
	AdoptAnswer,
	Capability,
	Clause,
	FailureAnswer,
	FindingAnswer,
	Kind,
	MapAnswer,
	PolicySettings,
	SignoffAnswer,
	Unlinked,
} from "./kinds.ts";
import { Automate, CaseBody, MethodKind } from "./model.ts";
import { Obligation, TargetMatch, type Verdict } from "./runs.ts";

/**
 * A client-generated id that names one request. Sent again unchanged, it returns the first reply and writes
 * nothing; sent again with other content, it is refused with `conflict`.
 */
export const cmd = z
	.string()
	.min(8)
	.max(64)
	.optional()
	.describe("Idempotency key. A retry with the same value writes nothing.");
const ref = (what: string) => z.string().describe(what);
const limit = z.number().int().min(1).max(500).optional();
const cursor = z.string().optional().describe("The cursor from the previous page.");

// ── propose ────────────────────────────────────────────────────────────────────────────────────────────────

/** A folder by id, or by path (`checkout/coupons`); a path that does not exist yet is created by the edit. */
const FolderRef = z.union([z.number().int(), z.string().max(400)]);

const TagChange = z.object({
	set: z.array(z.string()).optional(),
	add: z.array(z.string()).optional(),
	remove: z.array(z.string()).optional(),
});

export const Edit = z.discriminatedUnion("op", [
	z.object({
		op: z.literal("create"),
		/** The case as structured content, as canonical Markdown, or as free text in the capture outline. */
		body: CaseBody.partial().optional(),
		md: z.string().optional(),
		outline: z.string().optional(),
		folder: FolderRef.optional(),
		tags: z.array(z.string()).optional(),
		covers: z.array(z.string()).optional(),
		/** Place the new case after this case (a ref); the end of the folder when absent. */
		after: z.string().optional(),
	}),
	z.object({
		op: z.literal("edit"),
		case: ref("The case, for example C-311."),
		base: z
			.number()
			.int()
			.describe("The version this edit was made on. A stale base is merged or reported, never overwritten."),
		body: CaseBody.partial().optional(),
		md: z.string().optional(),
	}),
	z.object({
		op: z.literal("place"),
		cases: z.array(z.string()).min(1),
		folder: FolderRef.optional(),
		after: z.string().nullable().optional(),
		tags: TagChange.optional(),
	}),
	z.object({ op: z.literal("state"), cases: z.array(z.string()).min(1), to: z.enum(["active", "archived"]) }),
	z.object({
		op: z.literal("restore"),
		case: ref("The case."),
		to: z.number().int().describe("The version to restore."),
	}),
	z.object({
		op: z.literal("folder"),
		folder: FolderRef.optional().describe("The folder to change. Absent when creating one."),
		name: z.string().min(1).max(120).optional(),
		parent: FolderRef.nullable().optional(),
		archive: z.boolean().optional(),
	}),
	z.object({
		op: z.literal("cover"),
		case: ref("The case."),
		requirement: z.string(),
		on: z.boolean(),
		title: z.string().optional(),
	}),
	z.object({
		op: z.literal("policy"),
		preset: z.string().optional(),
		clauses: z.array(Clause).optional(),
		settings: PolicySettings.optional(),
		/** The one setting a project admin changes without reading the others: what happens to a test with no case. */
		unlinked: Unlinked.optional(),
	}),
]);
export type Edit = z.infer<typeof Edit>;

export const ProposeInput = z.object({
	edits: z.array(Edit).min(1).max(5000),
	reason: z.string().max(500).optional().describe("Why. Shown in the case history."),
	cmd,
});
export type ProposeInput = z.infer<typeof ProposeInput>;

export type CaseStamp = { ref: string; version: number; hash: string };
export type ProposeReply = {
	/** Null when the edits changed nothing, so nothing was proposed. */
	proposal: string | null;
	/** `adopted`: it is the current version. `open`: a person must accept it. `conflict`: the author must resolve it. */
	status: "adopted" | "open" | "conflict" | "rejected";
	question: string | null;
	needs: string | null;
	cases: CaseStamp[];
	conflicts: { case: string; paths: string[] }[];
};

// ── report ─────────────────────────────────────────────────────────────────────────────────────────────────

export const Outcome = z.enum(["pass", "fail", "skip", "blocked", "error"]);
export type Outcome = z.infer<typeof Outcome>;

export const ResultIn = z.object({
	test: z.union([
		z.object({
			key: z.string().trim().min(1).max(1000),
			name: z.string().max(500).optional(),
			file: z.string().max(500).optional(),
		}),
		z.object({ case: ref("The case this manual or agent result is for.") }),
	]),
	outcome: Outcome,
	durationMs: z.number().int().min(0).optional(),
	failure: z
		.object({
			message: z.string().max(4000),
			detail: z.string().max(20_000).optional(),
			at: z.string().max(40).optional(),
		})
		.optional(),
	steps: z.array(z.object({ step: z.string(), outcome: Outcome })).optional(),
	note: z.string().max(4000).optional(),
	/** A claim by the producer that this result exercised this version of this case (`@C-311@v7` in a test name). */
	annotation: z.object({ case: z.string(), version: z.number().int().optional() }).optional(),
	corrects: z.number().int().optional().describe("The id of an earlier result of yours that this one replaces."),
});
export type ResultIn = z.infer<typeof ResultIn>;

export const TargetIn = z.union([
	z.object({
		commit: z.string().min(7).max(64),
		repo: z.string().max(200).optional(),
		branch: z.string().max(200).optional(),
		env: z.string().max(60).optional(),
		pr: z.number().int().optional(),
		base: z.string().max(64).optional().describe("The commit this change is based on."),
		title: z.string().max(300).optional(),
		url: z.string().max(500).optional(),
		files: z.array(z.string()).max(5000).optional().describe("Paths the change touches, for impact."),
	}),
	z.object({ session: z.string().min(1).max(120) }),
]);
export type TargetIn = z.infer<typeof TargetIn>;

export const ReportInput = z.object({
	target: TargetIn.optional().describe("What was tested. Required unless `run` is given."),
	run: z.string().optional().describe("A planned run these results are for, for example R-4."),
	job: z.string().max(120).optional(),
	attempt: z.number().int().min(1).optional(),
	buildUrl: z.string().max(500).optional(),
	results: z.array(ResultIn).min(1).max(100_000),
	cmd,
});
export type ReportInput = z.infer<typeof ReportInput>;

export type QuestionBrief = {
	q: string;
	kind: Kind;
	title: string;
	state: "open" | "decided";
	/** Why this cause did or did not become a new question for a person. */
	how: "new" | "already open" | "already decided" | "decided by rule";
	answer: string | null;
	by: string | null;
	tests: number;
};
export type GateStatus = {
	run: string | null;
	verdict: Verdict;
	reason: string;
	tally: Record<string, number>;
	open: string[];
	url: string | null;
	/** True when the stored verdict was overridden because an upload is unapplied or a hold expired. */
	stale: boolean;
};
export type ReportReceipt = {
	batch: number;
	/** False when this exact report was already received: nothing was written. */
	fresh: boolean;
	target: string;
	counts: { total: number; pass: number; fail: number; skip: number; error: number; blocked: number };
	basis: { exact: number; assumed: number; unresolved: number };
	/** Failures by cause: new questions, questions already decided, and those a rule settled. */
	questions: QuestionBrief[];
	unlinked: number;
	flips: number;
	/** Results that were refused, by position in the report, with the reason. Nothing is relabelled to make it fit. */
	rejected: { index: number; reason: string }[];
	/**
	 * Automated results kept with no case because their claim about a case or a version was refused, with the
	 * reason. Their outcome still counts for the commit: a failure is not dropped from the gate.
	 */
	declined: { index: number; reason: string }[];
	/** Ids of the results written, for a small report (a person's keypress), so a correction can name one. */
	results: number[];
	gate: GateStatus | null;
};

// ── claim ──────────────────────────────────────────────────────────────────────────────────────────────────

export const FindingCategory = z.enum([
	"cannot-fail",
	"ambiguous",
	"missing-expected",
	"uncovered-path",
	"duplicate",
	"outdated",
	"defect",
	"other",
]);
export type FindingCategory = z.infer<typeof FindingCategory>;

export const FindingIn = z.object({
	on: z
		.string()
		.describe("Where: a case (C-311), a step (C-311#b7), a requirement (req:WEB-290) or a change (pr:482)."),
	category: FindingCategory,
	note: z.string().min(1).max(2000),
	repro: z.string().max(4000).optional(),
	suggest: z
		.union([
			z.object({ step: z.string().optional(), action: z.string().optional(), expected: z.string().optional() }),
			z.object({ case: z.object({ title: z.string(), folder: z.string().optional(), steps: z.array(z.string()) }) }),
		])
		.optional(),
});
export type FindingIn = z.infer<typeof FindingIn>;

export const ClaimInput = z.object({
	lens: z.string().min(1).max(60).describe("The kind of review, for example adversarial-review."),
	about: z.string().max(120).optional().describe("The change reviewed, for example pr:482."),
	reviewed: z
		.array(z.string())
		.max(1000)
		.optional()
		.describe("Cases read, each as C-311@<hash>. Recorded even with no findings."),
	findings: z.array(FindingIn).max(200).default([]),
	cmd,
});
export type ClaimInput = z.infer<typeof ClaimInput>;
export type ClaimReply = {
	opened: string[];
	known: { q: string; state: string; answer: string | null; by: string | null }[];
	reviewed: number;
};

// ── decide ─────────────────────────────────────────────────────────────────────────────────────────────────

export const AnyAnswerSchema = z.union([AdoptAnswer, MapAnswer, FailureAnswer, FindingAnswer, SignoffAnswer]);

const OneDecision = z.object({
	q: ref("The question, for example Q-12."),
	onEvidence: z
		.string()
		.describe(
			"The evidence hash you saw. If the evidence changed since, the reply is a conflict with the new evidence.",
		),
	answer: z
		.record(z.string(), z.unknown())
		.describe('The answer, for example {"is":"defect"}. The allowed answers depend on the question kind.'),
	reason: z.string().max(1000).optional(),
});
export const DecideInput = z.union([
	OneDecision.extend({ cmd }),
	z.object({ all: z.array(OneDecision).min(1).max(500), reason: z.string().max(1000).optional(), cmd }),
	z.object({ undo: ref("The question whose decision to withdraw."), reason: z.string().max(1000).optional(), cmd }),
]);
export type DecideInput = z.infer<typeof DecideInput>;

export type DecideReply = {
	q: string;
	/**
	 * `decided`: your answer settled it. `advised`: recorded as advice; someone else decides. `conflict`: the
	 * evidence changed, or it was already decided differently. `forbidden`: policy does not let you answer.
	 */
	status: "decided" | "advised" | "conflict" | "forbidden" | "invalid" | "already" | "reopened";
	needs: string | null;
	decision: number | null;
	effects: Record<string, unknown> | null;
	/** On a conflict: the evidence hash to answer on now. */
	evidence: string | null;
};

// ── change ─────────────────────────────────────────────────────────────────────────────────────────────────

export const ChangeInput = z.object({
	change: z.string().min(1).max(300).describe("The change, for example pr:482."),
	state: z
		.enum(["merged", "closed", "open"])
		.describe("How the change ended: merged, or closed without merging. open: it is open again."),
	cmd,
});
export type ChangeInput = z.infer<typeof ChangeInput>;
export type ChangeReply = {
	change: string;
	state: "merged" | "closed" | "open";
	/** The failure questions this ended (no longer asked) or, for a change that is open again, the ones asked now. */
	questions: string[];
	/** True when the change was already as the caller says: its end and its questions are as they were. */
	already: boolean;
};

// ── plan ───────────────────────────────────────────────────────────────────────────────────────────────────

export const Selection = z.object({
	cases: z.array(z.string()).optional(),
	folders: z.array(FolderRef).optional(),
	tags: z.array(z.string()).optional(),
	text: z.string().optional(),
});
export type Selection = z.infer<typeof Selection>;

export const PlanInput = z.object({
	name: z.string().min(1).max(200),
	select: Selection,
	accepts: TargetMatch.optional().describe("Which results count. Default: only results recorded in this run."),
	require: z.array(Obligation).optional(),
	assign: z.array(z.string()).optional().describe("Actor names to split the slots between."),
	cmd,
});
export type PlanInput = z.infer<typeof PlanInput>;
export type PlanReply = { run: string; slots: number; already: number };

// ── reads ──────────────────────────────────────────────────────────────────────────────────────────────────

export const InboxInput = z.object({
	state: z.enum(["open", "decided"]).default("open"),
	kind: Kind.optional(),
	on: z.string().optional().describe("Only questions about this case, run, test or change."),
	limit,
	cursor,
});
export type InboxInput = z.infer<typeof InboxInput>;

export type QuestionItem = {
	q: string;
	kind: Kind;
	title: string;
	producer: ActorKind;
	state: "open" | "decided" | "dissolved";
	evidence: Record<string, unknown>;
	evidenceHash: string;
	seen: { count: number; carried: number };
	needs: string;
	/** The answers that apply to this question, in key order. The keys and labels are in `ANSWER_KEYS`. */
	answers: string[];
	blocks: string[];
	about: string[];
	openedAt: number;
	advice: { by: string; kind: ActorKind; answer: Record<string, unknown>; reason: string | null }[];
	/** In a listing: what the caller's own answer would be worth under the policy. */
	you?: "counts" | "advice" | "forbidden";
	decision: {
		id: number;
		answer: Record<string, unknown>;
		by: string[];
		rule: string | null;
		reason: string | null;
		at: number;
	} | null;
};
export type InboxReply = { counts: Record<string, number>; items: QuestionItem[]; cursor: string | null };

export const GetInput = z.object({
	refs: z
		.array(z.string())
		.min(1)
		.max(200)
		.describe("Refs of cases (C-), questions (Q-), runs (R-), tests (T-) or proposals (P-)."),
	fields: z
		.array(z.string())
		.optional()
		.describe("For cases: any of title, pre, steps, methods, tags, covers, place, proof. Default: all."),
	as: z
		.enum(["data", "md"])
		.default("data")
		.describe("`md` returns a case as canonical Markdown: fewer tokens than JSON."),
	unless: z
		.record(z.string(), z.string())
		.optional()
		.describe("Ref to the hash you already hold. An unchanged case comes back as {ref, unchanged: true}."),
	version: z.number().int().optional().describe("For one case: this version instead of the current one."),
});
export type GetInput = z.infer<typeof GetInput>;

export const FindInput = z.object({
	in: z.enum(["cases", "tests", "runs", "folders", "tags", "requirements", "slots", "changes"]).default("cases"),
	text: z.string().max(200).optional(),
	folder: FolderRef.optional(),
	deep: z.boolean().optional().describe("With `folder`: include its subfolders."),
	tags: z.array(z.string()).optional(),
	state: z.string().optional(),
	run: z.string().optional().describe("For slots: the run."),
	unlinked: z.boolean().optional().describe("For tests: only those with no case."),
	limit,
	cursor,
});
export type FindInput = z.infer<typeof FindInput>;

export const HistoryInput = z.object({
	ref: ref("The case."),
	from: z.number().int().optional(),
	to: z.number().int().optional().describe("With `from`: the step-level diff between the two versions."),
});
export type HistoryInput = z.infer<typeof HistoryInput>;

export const ImpactInput = z.object({
	change: z.string().optional().describe("A change key, for example pr:482."),
	files: z
		.array(z.string())
		.max(5000)
		.optional()
		.describe("Changed paths, when the change is not known to Mainworthy."),
	since: z.string().optional().describe("A cursor from an earlier call: only what moved since."),
	ledger: z.boolean().default(true).describe("False for fresh eyes: do not hide what was already reviewed."),
});
export type ImpactInput = z.infer<typeof ImpactInput>;

export const SinceInput = z.object({ cursor: z.string().describe("A cursor from any earlier read."), limit });
export type SinceInput = z.infer<typeof SinceInput>;

export const GateInput = z.object({
	commit: z.string().optional(),
	run: z.string().optional(),
	change: z.string().optional().describe("A change key, for example pr:482: the gate of its latest commit."),
	repo: z.string().optional(),
});
export type GateInput = z.infer<typeof GateInput>;

export const CheckInput = z.object({ limit });
export type Problem = { rule: string; ref: string; message: string };

export const TimelineInput = z.object({ ref: ref("The case."), limit });

export const CommandInput = z.object({
	cmd: z.string().min(8).max(64).describe("The idempotency key the command was sent under."),
});
export type CommandInput = z.infer<typeof CommandInput>;

/**
 * What became of a command. `none`: nothing is recorded under that id for the caller in this project; the command
 * did not arrive, has not run yet, or was refused with an error. `begun`: accepted and not finished (a report
 * accepted and not yet applied). `done`: it ran, and `reply` is the reply it was given, at sequence `seq`.
 */
export type CommandFate =
	| { state: "none" }
	| { state: "begun"; op: string }
	| { state: "done"; op: string; seq: number; reply: unknown };

// ── administer ─────────────────────────────────────────────────────────────────────────────────────────────

export const AdminInput = z.discriminatedUnion("do", [
	z.object({
		do: z.literal("project.create"),
		key: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
		name: z.string().max(120).optional(),
		preset: z.string().optional(),
		unlinked: Unlinked.optional().describe(
			"What happens to a test with no case: ask, track or create. Absent: what the preset starts with.",
		),
		cmd,
	}),
	z.object({ do: z.literal("project.list") }),
	z.object({
		do: z.literal("token.create"),
		actor: z.string(),
		kind: ActorKind.exclude(["rule"]),
		can: z
			.array(Capability)
			.default([])
			.describe(
				"What a new actor may do. Absent: a person everything, an agent read and produce, a pipeline record. Not for an actor that exists: use grant.set.",
			),
		project: z.string().optional().describe("Limit the grant to one project. Absent: every project."),
		label: z.string().max(120).optional(),
		expires: z
			.string()
			.regex(DURATION_PATTERN, `not a duration: write ${DURATION_FORMAT}`)
			.optional()
			.describe(
				"How long the token works from now: 90d, 12h, 2w. After that it is refused as a revoked one is. Absent: it has no end.",
			),
		cmd,
	}),
	z.object({ do: z.literal("token.list") }),
	z.object({ do: z.literal("token.revoke"), id: z.number().int(), cmd }),
	z.object({ do: z.literal("actor.list") }),
	z.object({
		do: z.literal("grant.set"),
		actor: z.string(),
		project: z.string().optional().describe("The project the grant is for. Absent: every project."),
		can: z.array(Capability).min(1).describe("What the actor may do there from now on, in place of what it could."),
		cmd,
	}),
	z.object({
		do: z.literal("grant.remove"),
		actor: z.string(),
		project: z.string().optional().describe("The project the grant is for. Absent: the grant on every project."),
		cmd,
	}),
	z.object({
		do: z.literal("actor.forget"),
		name: z
			.string()
			.describe(
				"Removes who this actor was: a pseudonym replaces the name and its tokens stop working. History keeps what was done.",
			),
		cmd,
	}),
	z.object({ do: z.literal("policy.show"), project: z.string() }),
]);
export type AdminInput = z.infer<typeof AdminInput>;

export const TransferInput = z.discriminatedUnion("do", [
	z.object({ do: z.literal("export") }),
	z.object({ do: z.literal("import"), archive: z.string().describe("The archive text an export produced.") }),
]);
export type TransferInput = z.infer<typeof TransferInput>;

export { Automate, MethodKind };
