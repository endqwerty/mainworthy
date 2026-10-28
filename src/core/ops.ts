// The wire contract of every operation: one input schema and one output schema each. The HTTP API, the OpenAPI
// document, the MCP tools, the CLI and the web client are all derived from these, so a shape is declared once.
import { z } from "zod";
import { ATTACHMENT_LIMITS, AttachmentInput, attachmentBytes } from "./attachments.ts";
import { ArtifactCode } from "./changes.ts";
import { cmd, projectCommand } from "./commands.ts";
import { DURATION_FORMAT, DURATION_PATTERN } from "./duration.ts";
import {
	ActorKind,
	AdoptAnswer,
	Capability,
	DECIDE_MAX,
	FailureAnswer,
	FindingAnswer,
	Kind,
	MapAnswer,
	Role,
	SignoffAnswer,
	Unlinked,
} from "./kinds.ts";
import { Automate, MethodKind } from "./model.ts";
import { Outcome, ResultTrail, TRAIL_LIMITS, trailBytes } from "./results.ts";
import { cursor, limit } from "./selection.ts";
import { TeamInput } from "./teams.ts";

export { ArtifactCode } from "./changes.ts";
export { cmd } from "./commands.ts";
export { DECIDE_MAX } from "./kinds.ts";
export { CaseAlias, Edit, ProposeInput, QuarantineEdit } from "./proposals.ts";
export {
	AnnounceReply,
	CaseStamp,
	ChangeReply,
	ClaimReply,
	CommandFate,
	DecideReply,
	InboxReply,
	PlanReply,
	Problem,
	ProposeReply,
	QuestionBrief,
	QuestionItem,
	ReportReceipt,
	WorkReply,
} from "./replies.ts";
export { ResultLocation } from "./results.ts";
export { GateStatus } from "./runs.ts";
export { FindInput, PlanInput, Selection } from "./selection.ts";

const ref = (what: string) => z.string().describe(what);

export { Outcome } from "./results.ts";

// ── report ─────────────────────────────────────────────────────────────────────────────────────────────────

export const resultDuration = z
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

const epochMs = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/**
 * When a report's tests started and ended, by the runner's own clock: evidence the report carries, like a result's
 * duration. It never sets the time of a write, which stays the server's (decision 0100, issue #722).
 */
export const ReportSpan = z
	.strictObject({
		startedAt: epochMs.describe("Milliseconds since 1970 when the runner started these tests, by its clock."),
		endedAt: epochMs.describe("Milliseconds since 1970 when it ended them; not before startedAt."),
	})
	.refine((span) => span.endedAt >= span.startedAt, { message: "a span ends at or after its start" });
export type ReportSpan = z.infer<typeof ReportSpan>;

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
		span: ReportSpan.optional()
			.meta({ "x-mcp-hidden": true })
			.describe(
				"When the runner started and ended these tests, as the report says. A change run shows its reported test span only when every report it counts names one.",
			),
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
export const DecideInput = z.union([
	OneDecision.extend(projectCommand),
	z.object({
		all: z
			.array(OneDecision)
			.min(1)
			.max(DECIDE_MAX)
			.refine(
				(all) => new Set(all.map(({ q }) => q.trim().replace(/^(?:Q-)?0*(\d+)$/i, "$1"))).size === all.length,
				"Each question may appear only once in a decide request.",
			),
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
// ── announce ───────────────────────────────────────────────────────────────────────────────────────────────

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
// ── plan ───────────────────────────────────────────────────────────────────────────────────────────────────

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
// ── reads ──────────────────────────────────────────────────────────────────────────────────────────────────

export const InboxInput = z.object({
	state: z.enum(["open", "decided"]).default("open"),
	kind: Kind.optional(),
	on: z.string().optional().describe("Only questions about this case, run, test or change."),
	limit,
	cursor,
});
export type InboxInput = z.infer<typeof InboxInput>;

export const GetInput = z.object({
	projectIdentity: projectCommand.projectIdentity,
	repo: z.string().optional().describe("For commit refs: disambiguate repositories."),
	cursor: z
		.string()
		.optional()
		.describe(
			"For one proposal: the cursor from its previous page of edits. Restart without it after a project change.",
		),
	refs: z.array(z.string()).min(1).max(200).describe("C-, Q-, R-, T-, P-, result:id, commit:hash or change:key."),
	fields: z
		.array(z.string())
		.optional()
		.describe("For cases: any of title, pre, steps, methods, fields, tags, covers, place, proof. Default: all."),
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
	cursor: z
		.string()
		.optional()
		.describe("The previous impact next value. Keep the same inputs; restart after a project change."),
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
export const TimelineInput = z.object({ ref: ref("The case."), limit });

export const CommandInput = z.object({
	cmd: z.string().min(8).max(64).describe("The idempotency key the command was sent under."),
});
export type CommandInput = z.infer<typeof CommandInput>;

// ── administer ─────────────────────────────────────────────────────────────────────────────────────────────

/** What a project's key may be: lowercase letters, digits and hyphens, at most forty characters. */
export const PROJECT_KEY = /^[a-z0-9][a-z0-9-]{0,39}$/;

export const AdminInput = z.discriminatedUnion("do", [
	...TeamInput.options,
	z.object({
		do: z.literal("project.create"),
		key: z.string().regex(PROJECT_KEY),
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
		projectIdentity: projectCommand.projectIdentity,
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
		projectIdentity: projectCommand.projectIdentity,
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
		projectIdentity: projectCommand.projectIdentity,
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
		projectIdentity: projectCommand.projectIdentity,
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
