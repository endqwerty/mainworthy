// The wire contract of every operation: one input schema and one output schema each. The HTTP API, the OpenAPI
// document, the MCP tools, the CLI and the web client are all derived from these, so a shape is declared once.
import { z } from "zod";
import { ATTACHMENT_LIMITS, AttachmentInput, attachmentBytes } from "./attachments.ts";
import { cmd, projectCommand } from "./commands.ts";
import { DURATION_FORMAT, DURATION_PATTERN } from "./duration.ts";
import { QuarantineExit } from "./flaky.ts";
import {
	ActorKind,
	AdoptAnswer,
	Capability,
	Clause,
	FailureAnswer,
	FindingAnswer,
	FixedIn,
	Kind,
	MapAnswer,
	PolicySettings,
	Role,
	SignoffAnswer,
	Unlinked,
} from "./kinds.ts";
import { Automate, CaseBody, CaseKind, ConflictAddress, MethodKind } from "./model.ts";
import { Outcome, ResultTrail, TRAIL_LIMITS, trailBytes } from "./results.ts";
import { Obligation, ShardWait, SlotWork, TargetMatch, Verdict } from "./runs.ts";
import { TeamInput } from "./teams.ts";

export { cmd } from "./commands.ts";
export { ResultLocation } from "./results.ts";

const ref = (what: string) => z.string().describe(what);
const limit = z.number().int().min(1).max(500).optional();
const cursor = z.string().optional().describe("The cursor from the previous page.");

export { Outcome } from "./results.ts";

// ── propose ────────────────────────────────────────────────────────────────────────────────────────────────

/** A folder by id, or by path (`checkout/coupons`); a path that does not exist yet is created by the edit. */
const FolderRef = z.union([z.number().int(), z.string().max(400)]);

const TagChange = z.object({
	set: z.array(z.string()).optional(),
	add: z.array(z.string()).optional(),
	remove: z.array(z.string()).optional(),
});

export const CaseAlias = z
	.string()
	.trim()
	.regex(/^(?![CQRTP]-)(?!\d+$)[a-z0-9][a-z0-9_.:/-]{0,119}$/i);

export const QuarantineEdit = z
	.object({
		op: z.literal("quarantine"),
		test: z.string().regex(/^T-\d+$/),
		base: z.number().int().positive().nullable(),
		exit: QuarantineExit.nullable(),
	})
	.meta({ "x-mcp-hidden": true });
export const Edit = z.discriminatedUnion("op", [
	QuarantineEdit,
	z
		.object({
			op: z.literal("fragment"),
			fragment: z.string(),
			from: z.number().int().positive(),
			to: z.number().int().positive(),
			cases: z
				.array(z.object({ case: z.string(), base: z.number().int().positive() }))
				.min(1)
				.max(5000),
		})
		.meta({ "x-mcp-hidden": true }),
	z.object({
		op: z.literal("create"),
		kind: CaseKind.optional().meta({ "x-mcp-hidden": true }),
		/** The case as structured content, as canonical Markdown, or as free text in the capture outline. */
		body: CaseBody.partial().optional(),
		md: z.string().optional(),
		outline: z.string().optional(),
		folder: FolderRef.optional(),
		tags: z.array(z.string()).optional(),
		covers: z.array(z.string()).optional(),
		aliases: z.array(z.string()).max(20).optional(),
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
		base: z.number().int().positive().optional().describe("Required with clauses or settings."),
		preset: z.string().optional(),
		clauses: z.array(Clause).optional(),
		settings: PolicySettings.optional(),
		/** What happens to a test with no case, changed without replacing the other settings. */
		unlinked: Unlinked.optional(),
		emptyReports: PolicySettings.shape.emptyReports.removeDefault().optional(),
	}),
]);
export type Edit = z.infer<typeof Edit>;

export const ProposeInput = z.object({
	edits: z.array(Edit).min(1).max(5000),
	reason: z.string().max(500).optional().describe("Why. Shown in the case history."),
	...projectCommand,
});
export type ProposeInput = z.infer<typeof ProposeInput>;

export const CaseStamp = z.object({
	ref: z.string(),
	version: z.number(),
	hash: z.string(),
});
export type CaseStamp = z.infer<typeof CaseStamp>;
export const ProposeReply = z.object({
	/** Null when the edits changed nothing, so nothing was proposed. */
	proposal: z.string().nullable(),
	/** `adopted`: it is the current version. `open`: a person must accept it. `conflict`: the author must resolve it. */
	status: z.enum(["adopted", "open", "conflict", "rejected"]),
	question: z.string().nullable(),
	needs: z.string().nullable(),
	cases: z.array(CaseStamp),
	conflicts: z.array(
		z.object({
			case: z.string(),
			addresses: z.array(ConflictAddress),
		}),
	),
});
export type ProposeReply = z.infer<typeof ProposeReply>;

// ── report ─────────────────────────────────────────────────────────────────────────────────────────────────

const resultDuration = z
	.number()
	.int()
	.min(0)
	.max(30 * 86_400_000)
	.describe("Milliseconds; at most 30 days.");

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
	attachments: z.array(AttachmentInput).max(ATTACHMENT_LIMITS.perResult).optional().meta({ "x-mcp-hidden": true }),
	durationMs: resultDuration.optional(),
	failure: z
		.object({
			message: z.string().max(4000),
			detail: z.string().max(20_000).optional(),
			at: z.string().max(40).optional().meta({ "x-mcp-hidden": true }),
		})
		.optional(),
	steps: ResultTrail.optional(),
	note: z.string().max(4000).optional(),
	/** A claim by the producer that this result exercised this version of this case (`@C-311@v7` in a test name). */
	annotation: z.object({ case: z.string(), version: z.number().int().optional() }).optional(),
	corrects: z.number().int().optional().describe("The id of an earlier result of yours that this one replaces."),
	/**
	 * The test runner's earlier tries of this test in this run, oldest first; the result is its last word (decision
	 * 0129). Evidence only: a try that disagrees with the next is a flip, and the gate counts the result.
	 */
	tries: z
		.array(
			z.object({
				outcome: Outcome,
				durationMs: resultDuration.optional(),
				failure: z.object({ message: z.string().max(4000), detail: z.string().max(20_000).optional() }).optional(),
			}),
		)
		.max(100)
		.optional()
		.meta({ "x-mcp-hidden": true }),
});
export type ResultIn = z.infer<typeof ResultIn>;

export const TargetIn = z.union([
	z
		.object({
			build: z
				.string()
				.trim()
				.min(1)
				.max(120)
				.describe("For CLI and HTTP. MCP's report schema omits the build target; use a planned run."),
			env: z.string().trim().min(1).max(60).optional(),
		})
		.meta({ "x-mcp-hidden": true }),
	z.object({
		commit: z.string().min(7).max(64),
		head: z.string().min(7).max(64).optional().describe("Current code host head."),
		repo: z.string().max(200).optional(),
		branch: z.string().max(200).optional(),
		env: z.string().max(60).optional(),
		pr: z.number().int().optional(),
		base: z.string().max(64).optional().describe("The commit this change is based on."),
		title: z.string().max(300).optional(),
		url: z.string().max(500).optional(),
		files: z.array(z.string()).max(5000).optional().describe("Paths the change touches, for impact."),
	}),
	z.strictObject({ session: z.string().min(1).max(120) }),
]);
export type TargetIn = z.infer<typeof TargetIn>;

export const ReportInput = z
	.object({
		target: TargetIn.optional().describe("What was tested. Required unless `run` is given."),
		run: z.string().optional().describe("A planned run these results are for, for example R-4."),
		model: z
			.string()
			.trim()
			.min(1)
			.max(120)
			.optional()
			.describe(
				"The model that produced this report's results. Agent tokens only; 1 to 120 characters after trimming.",
			),
		job: z.string().max(120).optional(),
		attempt: z.number().int().min(1).optional(),
		shard: z
			.object({ index: z.number().int().min(1), of: z.number().int().min(1).max(1000) })
			.refine((shard) => shard.index <= shard.of, { message: "a shard's index is at most the number of shards" })
			.optional()
			.meta({ "x-mcp-hidden": true })
			.describe(
				"This report is one shard of its job: index of of. A commit's gate waits until every shard of the job has reported.",
			),
		buildUrl: z.string().max(500).optional(),
		results: z.array(ResultIn).max(100_000),
		nothingRequired: z
			.literal(true)
			.optional()
			.meta({ "x-mcp-hidden": true })
			.describe("CI-only empty declaration; requires policy permission."),
		...projectCommand,
	})
	.refine((report) => (report.nothingRequired ? report.results.length === 0 : report.results.length > 0), {
		message: "send results, or an empty results array with nothingRequired: true, never both",
		path: ["results"],
	})
	.superRefine((report, ctx) => {
		let size = 0;
		let count = 0;
		let trails = 0;
		for (const [index, result] of report.results.entries()) {
			if (result.steps) {
				const bytes = trailBytes(result.steps);
				trails += bytes;
				if (bytes > TRAIL_LIMITS.resultBytes)
					ctx.addIssue({
						code: "custom",
						message: "Limit: 65536 bytes per result trail",
						path: ["results", index, "steps"],
					});
				for (const [ordinal, step] of result.steps.entries()) {
					if (step.attachment !== undefined && step.attachment >= (result.attachments?.length ?? 0))
						ctx.addIssue({
							code: "custom",
							message: "A step attachment index must name this result's own attachments (zero-based)",
							path: ["results", index, "steps", ordinal, "attachment"],
						});
				}
			}
			let resultSize = 0;
			for (const attachment of result.attachments ?? []) {
				resultSize += attachmentBytes(attachment.data);
				count++;
			}
			if (resultSize > ATTACHMENT_LIMITS.report)
				ctx.addIssue({ code: "custom", message: "Attachments exceed 16 MiB for one result", path: ["results"] });
			size += resultSize;
		}
		if (trails > TRAIL_LIMITS.reportBytes)
			ctx.addIssue({ code: "custom", message: "Limit: 1048576 bytes of trails per report", path: ["results"] });
		if (size > ATTACHMENT_LIMITS.report || count > ATTACHMENT_LIMITS.perReport)
			ctx.addIssue({ code: "custom", message: "Attachments exceed 16 MiB or 100 files per report", path: ["results"] });
	});
export type ReportInput = z.infer<typeof ReportInput>;

export const QuestionBrief = z.object({
	q: z.string(),
	kind: Kind,
	title: z.string(),
	state: z.enum(["open", "decided"]),
	/** Why this cause did or did not become a new question for a person. */
	how: z.enum(["new", "already open", "already decided", "decided by rule"]),
	answer: z.string().nullable(),
	by: z.string().nullable(),
	tests: z.number(),
});
export type QuestionBrief = z.infer<typeof QuestionBrief>;
export const GateStatus = z.object({
	quarantined: z.number().int().nonnegative().optional(),
	run: z.string().nullable(),
	verdict: Verdict,
	reason: z.string(),
	tally: z.record(z.string(), z.number()),
	open: z.array(z.string()),
	url: z.string().nullable(),
	/** True when the stored verdict was overridden because an upload is unapplied or a hold expired. */
	stale: z.boolean(),
	/** Jobs of the commit that reported in shards and are missing some: the gate is pending until they report. */
	waiting: z.array(ShardWait).optional(),
});
export type GateStatus = z.infer<typeof GateStatus>;
export const ReportReceipt = z.object({
	batch: z.number(),
	/** False when this exact report was already received: nothing was written. */
	fresh: z.boolean(),
	target: z.string(),
	counts: z.object({
		total: z.number(),
		pass: z.number(),
		fail: z.number(),
		skip: z.number(),
		error: z.number(),
		blocked: z.number(),
	}),
	basis: z.object({
		exact: z.number(),
		assumed: z.number(),
		unresolved: z.number(),
	}),
	/** Failures by cause: new questions, questions already decided, and those a rule settled. */
	questions: z.array(QuestionBrief),
	unlinked: z.number(),
	flips: z.number(),
	/** Results that were refused, by position in the report, with the reason. Nothing is relabelled to make it fit. */
	rejected: z.array(
		z.object({
			index: z.number(),
			reason: z.string(),
		}),
	),
	/**
	 * Automated results kept with no case because their claim about a case or a version was refused, with the
	 * reason. Their outcome still counts for the commit: a failure is not dropped from the gate.
	 */
	declined: z.array(
		z.object({
			index: z.number(),
			reason: z.string(),
		}),
	),
	/** Ids of the results written, for a small report (a person's keypress), so a correction can name one. */
	results: z.array(z.number()),
	gate: z.union([GateStatus, z.null()]),
});
export type ReportReceipt = z.infer<typeof ReportReceipt>;

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
			z.object({ case: z.object({ title: z.string(), folder: z.string().optional(), steps: z.array(z.string()) }) }),
			z.object({ step: z.string().optional(), action: z.string().optional(), expected: z.string().optional() }),
		])
		.optional(),
});
export type FindingIn = z.infer<typeof FindingIn>;

export const ClaimInput = z.object({
	lens: z.string().min(1).max(60).describe("The kind of review, for example adversarial-review."),
	about: z.string().max(120).optional().describe("The change reviewed, for example pr:482."),
	patch: z
		.string()
		.min(7)
		.max(64)
		.optional()
		.describe("Exact commit from impact's change.head; required for review reuse."),
	reviewed: z
		.array(z.string())
		.max(1000)
		.optional()
		.describe("Cases read, each as C-311@<hash>. Recorded even with no findings."),
	findings: z.array(FindingIn).max(200).default([]),
	...projectCommand,
});
export type ClaimInput = z.infer<typeof ClaimInput>;
export const ClaimReply = z.object({
	opened: z.array(z.string()),
	known: z.array(
		z.object({
			q: z.string(),
			state: z.string(),
			answer: z.string().nullable(),
			by: z.string().nullable(),
		}),
	),
	reviewed: z.number(),
});
export type ClaimReply = z.infer<typeof ClaimReply>;

// ── decide ─────────────────────────────────────────────────────────────────────────────────────────────────

export const AnyAnswerSchema = z.union([AdoptAnswer, MapAnswer, FailureAnswer, FindingAnswer, SignoffAnswer]);

const OneDecision = z.object({
	q: ref("The question, for example Q-12."),
	ifOpen: z.boolean().optional().describe("Refuse if the question is no longer open.").meta({ "x-mcp-hidden": true }),
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
/** The most answers or withdrawals one `decide` request carries, and so the Queue selection limit. */
export const DECIDE_MAX = 500;
export const DecideInput = z.union([
	OneDecision.extend(projectCommand),
	z.object({
		all: z.array(OneDecision).min(1).max(DECIDE_MAX),
		reason: z.string().max(1000).optional(),
		...projectCommand,
	}),
	z.object({
		undo: ref("The question whose decision to withdraw."),
		ifDecision: z.number().int().positive().optional(),
		reason: z.string().max(1000).optional(),
		...projectCommand,
	}),
	z
		.object({
			undo: z
				.array(
					z.object({ q: ref("The question whose decision to withdraw."), ifDecision: z.number().int().positive() }),
				)
				.min(1)
				.max(DECIDE_MAX),
			reason: z.string().max(1000).optional(),
			...projectCommand,
		})
		.meta({ "x-mcp-hidden": true }),
]);
export type DecideInput = z.infer<typeof DecideInput>;

export const DecideReply = z.object({
	q: z.string(),
	/**
	 * `decided`: your answer settled it. `advised`: recorded as advice; someone else decides. `conflict`: the
	 * evidence changed, it was already decided differently, or the decision to undo changed. `forbidden`: policy
	 * does not let you answer.
	 */
	status: z.enum(["decided", "advised", "conflict", "forbidden", "invalid", "already", "reopened"]),
	needs: z.string().nullable(),
	decision: z.number().nullable(),
	effects: z.union([z.record(z.string(), z.unknown()), z.null()]),
	/** On a conflict: the evidence hash to answer on now. */
	evidence: z.string().nullable(),
});
export type DecideReply = z.infer<typeof DecideReply>;

// ── change ─────────────────────────────────────────────────────────────────────────────────────────────────

export const ChangeInput = z.object({
	change: z.string().min(1).max(300).describe("The change, for example pr:482."),
	state: z
		.enum(["merged", "closed", "open"])
		.describe(
			"How the change ended: merged records the head gate when reported; closed is without merging. open: it is open again.",
		),
	head: z
		.string()
		.min(7)
		.max(64)
		.optional()
		.describe(
			"The change's head commit as the code host says it is now: for merged, the head that merged. The change's gate is this commit's.",
		),
	landing: z
		.object({
			commit: z.string().min(1).max(300),
			branch: z.enum(["main", "master", "trunk"]),
		})
		.optional()
		.describe(
			"For merged: the exact commit that reached trunk and its branch. It moves to trunk and its failures are judged there; it has a gate of its own, which is the change's only when it is the head.",
		),
	...projectCommand,
});
export type ChangeInput = z.infer<typeof ChangeInput>;
export const ChangeReply = z.object({
	change: z.string(),
	state: z.enum(["merged", "closed", "open"]),
	/** The failure questions this ended (no longer asked) or, for a change that is open again, the ones asked now. */
	questions: z.array(z.string()),
	/** True when the change was already as the caller says: its end and its questions are as they were. */
	already: z.boolean(),
});
export type ChangeReply = z.infer<typeof ChangeReply>;

// ── announce ───────────────────────────────────────────────────────────────────────────────────────────────

export const ArtifactCode = z
	.array(
		z.object({
			repo: z.string().trim().min(1).max(200),
			commit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "use a full lowercase commit hash"),
		}),
	)
	.min(1)
	.max(100);
export const AnnounceInput = z.object({
	deploy: z.string().trim().min(1).max(120).describe("Build label. Its artifact binding cannot change."),
	env: z.string().trim().min(1).max(60).describe("Environment deployed to."),
	digest: z
		.string()
		.regex(/^sha256:[0-9a-f]{64}$/)
		.optional()
		.describe("Artifact digest. Required for a new build label."),
	code: ArtifactCode.optional().describe("Source repositories and full commits. Required with a new artifact."),
	...projectCommand,
});
export type AnnounceInput = z.infer<typeof AnnounceInput>;
export const AnnounceReply = z.object({
	deployment: z.number().int(),
	build: z.string(),
	digest: z.string(),
	env: z.string(),
	code: ArtifactCode,
	by: z.string(),
	at: z.number(),
});
export type AnnounceReply = z.infer<typeof AnnounceReply>;

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
	...projectCommand,
});
export type PlanInput = z.infer<typeof PlanInput>;
export const PlanReply = z.object({
	run: z.string(),
	slots: z.number(),
	already: z.number(),
});
export type PlanReply = z.infer<typeof PlanReply>;

export const WorkInput = z
	.strictObject({
		do: z.enum(["take", "give-back"]),
		run: z.string(),
		slot: z
			.number()
			.int()
			.positive()
			.optional()
			.describe("Slot id from find slots. Omit to take the next free unfinished slot."),
		seconds: z
			.number()
			.int()
			.min(30)
			.max(86_400)
			.default(900)
			.describe("Lease length in seconds, from 30 to 86400. Default: 900."),
		...projectCommand,
	})
	.superRefine((input, ctx) => {
		if (input.do === "give-back" && input.slot === undefined)
			ctx.addIssue({ code: "custom", path: ["slot"], message: "giving back needs a slot" });
	});
export const WorkReply = z.object({
	run: z.string(),
	slot: z.number().int().nullable(),
	case: z.string().nullable(),
	work: SlotWork,
});
export type WorkReply = z.infer<typeof WorkReply>;

// ── reads ──────────────────────────────────────────────────────────────────────────────────────────────────

export const InboxInput = z.object({
	state: z.enum(["open", "decided"]).default("open"),
	kind: Kind.optional(),
	on: z.string().optional().describe("Only questions about this case, run, test or change."),
	limit,
	cursor,
});
export type InboxInput = z.infer<typeof InboxInput>;

const DecisionItem = z.object({
	id: z.number(),
	answer: z.record(z.string(), z.unknown()),
	by: z.array(z.string()),
	rule: z.string().nullable(),
	reason: z.string().nullable(),
	trackerError: z.string().optional(),
	at: z.number(),
});

export const QuestionItem = z.object({
	q: z.string(),
	kind: Kind,
	title: z.string(),
	producer: ActorKind,
	state: z.enum(["open", "decided", "dissolved"]),
	evidence: z.record(z.string(), z.unknown()),
	evidenceHash: z.string(),
	seen: z.object({
		count: z.number(),
		carried: z.number(),
	}),
	needs: z.string(),
	/** The answers that apply to this question, in key order. The keys and labels are in `ANSWER_KEYS`. */
	answers: z.array(z.string()),
	blocks: z.array(z.string()),
	about: z.array(z.string()),
	openedAt: z.number(),
	advice: z.array(
		z.object({
			by: z.string(),
			kind: ActorKind,
			answer: z.record(z.string(), z.unknown()),
			reason: z.string().nullable(),
		}),
	),
	/** In a listing: what the caller's own answer would be worth under the policy. */
	you: z.enum(["counts", "advice", "forbidden"]).optional(),
	decision: z.union([
		DecisionItem.extend({
			/** For an ending: the answer it ended, with its original attribution. */
			supersedes: DecisionItem.optional(),
			fixedIn: FixedIn.optional(),
			effects: z
				.record(z.string(), z.unknown())
				.describe("The recorded effects of this decision, including adopted case refs and versions."),
		}),
		z.null(),
	]),
});
export type QuestionItem = z.infer<typeof QuestionItem>;
export const InboxReply = z.object({
	counts: z.record(z.string(), z.number()),
	items: z.array(QuestionItem),
	cursor: z.string().nullable(),
});
export type InboxReply = z.infer<typeof InboxReply>;

export const GetInput = z.object({
	repo: z.string().optional().describe("For commit refs: disambiguate repositories."),
	cursor: z
		.string()
		.optional()
		.describe(
			"For one proposal: the cursor from its previous page of edits. Restart without it after a project change.",
		),
	refs: z.array(z.string()).min(1).max(200).describe("C-, Q-, R-, T-, P-, commit:hash or change:key."),
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
		.describe("Ref to the etag from get for the same as/fields. Unchanged: {ref, unchanged: true, etag}."),
	version: z.number().int().optional().describe("For one case: this version instead of the current one."),
});
export type GetInput = z.infer<typeof GetInput>;

export const FindInput = z.object({
	receipt: z.number().int().positive().optional().describe("For receipt-results: merge receipt id."),
	in: z
		.union([
			z.enum(["cases", "tests", "runs", "folders", "tags", "requirements", "slots", "changes", "receipt-results"]),
			// Deployments and results are listed for CLI and HTTP; MCP's find keeps its earlier choices, whose
			// tools/list is at its token budget (src/surfaces/mcp.ts).
			z.literal("deployments").meta({ "x-mcp-hidden": true }),
			z.literal("results").meta({ "x-mcp-hidden": true }),
		])
		.default("cases"),
	select: Selection.optional()
		.describe("For cases: preview a run selection instead of the listing filters. Excludes fragments.")
		.meta({ "x-mcp-hidden": true }),
	text: z.string().max(200).optional(),
	folder: FolderRef.optional(),
	deep: z.boolean().optional().describe("With `folder`: include its subfolders."),
	tags: z.array(z.string()).optional(),
	state: z.string().optional(),
	origin: z
		.enum(["planned", "change"])
		.optional()
		.describe("For runs: planned by hand, or one per reported commit.")
		.meta({ "x-mcp-hidden": true }),
	run: z.string().optional().describe("For slots: the run."),
	commit: z.string().optional().describe("For results: the commit.").meta({ "x-mcp-hidden": true }),
	change: z.string().optional().describe("For results and runs: a change key (pr:482).").meta({ "x-mcp-hidden": true }),
	repo: z.string().optional().meta({ "x-mcp-hidden": true }),
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
export const Problem = z.object({
	rule: z.string(),
	ref: z.string(),
	message: z.string(),
});
export type Problem = z.infer<typeof Problem>;

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
export const CommandFate = z.union([
	z.object({
		state: z.literal("none"),
	}),
	z.object({
		state: z.literal("begun"),
		op: z.string(),
	}),
	z.object({
		state: z.literal("done"),
		op: z.string(),
		seq: z.number(),
		reply: z.unknown(),
	}),
]);
export type CommandFate = z.infer<typeof CommandFate>;

// ── administer ─────────────────────────────────────────────────────────────────────────────────────────────

export const AdminInput = z.discriminatedUnion("do", [
	...TeamInput.options,
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
		do: z.literal("project.demo"),
		key: z
			.string()
			.describe(
				"Makes the project a demo: a write to it may say when it happened. Only a project nothing was written to, and it is not undone.",
			),
		cmd,
	}),
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
		roles: z
			.array(Role)
			.max(32)
			.optional()
			.describe("Named roles on this grant. Absent: keep its roles; []: clear them."),
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
