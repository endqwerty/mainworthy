import { z } from "zod";
import { Attachment, AttachmentReply } from "./attachments.ts";
import { ArtifactCode, MergeReceipt, MergeReceiptResult } from "./changes.ts";
import { CsvImportRow } from "./csv-replies.ts";
import { Quarantine, SameCodeEvidence } from "./flaky.ts";
import { HandoffReceipt, HandoffStatus } from "./handoff.ts";
import { ActorKind, Ask, FixedIn, Kind, Policy, Predicate, Unlinked } from "./kinds.ts";
import {
	Automate,
	CaseBody,
	CaseKind,
	ConflictAddress,
	ExpandedStep,
	FieldDefinitions,
	MethodKind,
	Step,
} from "./model.ts";
import {
	CredentialRow,
	InvitationCreated,
	InvitationRow,
	PersonalTokenCreated,
	PersonalTokenRow,
	SessionRow,
} from "./people-replies.ts";
import { PlacementEdit, QuarantineEdit } from "./proposals.ts";
import { ResultLocation, ResultTrail } from "./results.ts";
import { GateStatus, Obligation, ShardWait, SlotWork, TargetMatch, Verdict } from "./runs.ts";
import {
	counts as schemaCounts,
	data as schemaData,
	flag as schemaFlag,
	nullableNumber as schemaNullableNumber,
	nullableText as schemaNullableText,
	nullableWhole as schemaNullableWhole,
	number as schemaNumber,
	optionalText as schemaOptionalText,
	text as schemaText,
	texts as schemaTexts,
	unknownValue as schemaUnknownValue,
	whole as schemaWhole,
} from "./schema.ts";
import { StatsReply } from "./stats-replies.ts";
import { TeamReply, TeamSource } from "./team-replies.ts";
import { TrackerPreview, TrackerReceipt } from "./tracker.ts";

export const CaseStamp = z.object({
	ref: schemaText,
	version: schemaNumber,
	hash: schemaText,
});
export type CaseStamp = z.infer<typeof CaseStamp>;
export const ProposeReply = z.object({
	/** Null when the edits changed nothing, so nothing was proposed. */
	proposal: schemaNullableText,
	/** `adopted`: it is the current version. `open`: a person must accept it. `conflict`: the author must resolve it. */
	status: z.enum(["adopted", "open", "conflict", "rejected"]),
	question: schemaNullableText,
	needs: schemaNullableText,
	cases: z.array(CaseStamp),
	/** Ready-to-propose inverse edits for placements actually written. No-ops contribute none. */
	placements: z.array(PlacementEdit).default([]),
	conflicts: z.array(
		z.object({
			case: schemaText,
			addresses: z.array(ConflictAddress),
		}),
	),
});
export type ProposeReply = z.infer<typeof ProposeReply>;

export const QuestionBrief = z.object({
	q: schemaText,
	kind: Kind,
	title: schemaText,
	state: z.enum(["open", "decided"]),
	/** Why this cause did or did not become a new question for a person. */
	how: z.enum(["new", "already open", "already decided", "decided by rule"]),
	answer: schemaNullableText,
	by: schemaNullableText,
	tests: schemaNumber,
});
export type QuestionBrief = z.infer<typeof QuestionBrief>;
export const ReportReceipt = z.object({
	batch: schemaNumber,
	/** False when this exact report was already received: nothing was written. */
	fresh: schemaFlag,
	target: schemaText,
	counts: z.object({
		total: schemaNumber,
		pass: schemaNumber,
		fail: schemaNumber,
		skip: schemaNumber,
		error: schemaNumber,
		blocked: schemaNumber,
	}),
	basis: z.object({
		exact: schemaNumber,
		assumed: schemaNumber,
		unresolved: schemaNumber,
	}),
	/** Failures by cause: new questions, questions already decided, and those a rule settled. */
	questions: z.array(QuestionBrief),
	unlinked: schemaNumber,
	flips: schemaNumber,
	/** Results that were refused, by position in the report, with the reason. Nothing is relabelled to make it fit. */
	rejected: z.array(
		z.object({
			index: schemaNumber,
			reason: schemaText,
		}),
	),
	/**
	 * Automated results kept with no case because their claim about a case or a version was refused, with the
	 * reason. Their outcome still counts for the commit: a failure is not dropped from the gate.
	 */
	declined: z.array(
		z.object({
			index: schemaNumber,
			reason: schemaText,
		}),
	),
	/** Ids of the results written, for a small report (a person's keypress), so a correction can name one. */
	results: z.array(schemaNumber),
	gate: z.union([GateStatus, z.null()]),
});
export type ReportReceipt = z.infer<typeof ReportReceipt>;

export const ClaimReply = z.object({
	opened: schemaTexts,
	known: z.array(
		z.object({
			q: schemaText,
			state: schemaText,
			answer: schemaNullableText,
			by: schemaNullableText,
		}),
	),
	reviewed: schemaNumber,
});
export type ClaimReply = z.infer<typeof ClaimReply>;

export const DecideReply = z.object({
	q: schemaText,
	/**
	 * `decided`: your answer settled it. `pending`: approval recorded; more people must approve.
	 * `advised`: recorded as advice; someone else decides. `conflict`: the
	 * evidence changed, it was already decided differently, or the decision to undo changed. `forbidden`: policy
	 * does not let you answer.
	 */
	status: z.enum(["decided", "pending", "advised", "conflict", "forbidden", "invalid", "already", "reopened"]),
	needs: schemaNullableText,
	decision: schemaNullableNumber,
	effects: z.union([schemaData, z.null()]),
	/** On a conflict: the evidence hash to answer on now. */
	evidence: schemaNullableText,
});
export type DecideReply = z.infer<typeof DecideReply>;

export const ChangeReply = z.object({
	change: schemaText,
	state: z.enum(["merged", "closed", "open"]),
	/** The failure questions this ended (no longer asked) or, for a change that is open again, the ones asked now. */
	questions: schemaTexts,
	/** True when the change was already as the caller says: its end and its questions are as they were. */
	already: schemaFlag,
});
export type ChangeReply = z.infer<typeof ChangeReply>;

export const AnnounceReply = z.object({
	deployment: schemaWhole,
	build: schemaText,
	digest: schemaText,
	env: schemaText,
	code: ArtifactCode,
	by: schemaText,
	at: schemaNumber,
});
export type AnnounceReply = z.infer<typeof AnnounceReply>;

export const PlanReply = z.object({
	run: schemaText,
	slots: schemaNumber,
	already: schemaNumber,
});
export type PlanReply = z.infer<typeof PlanReply>;

export const WorkReply = z.object({
	run: schemaText,
	slot: schemaNullableWhole,
	case: schemaNullableText,
	work: SlotWork,
});
export type WorkReply = z.infer<typeof WorkReply>;

const ApprovalSigner = z.object({
	by: schemaText,
	clause: schemaText,
	policy: schemaNumber,
	reason: schemaNullableText,
});

const DecisionItem = z.object({
	signers: z.array(ApprovalSigner).optional(),
	id: schemaNumber,
	answer: schemaData,
	by: schemaTexts,
	rule: schemaNullableText,
	reason: schemaNullableText,
	trackerError: schemaOptionalText,
	at: schemaNumber,
});

export const QuestionItem = z.object({
	asked: z.object({ policy: schemaText, clause: schemaText, when: z.array(Predicate), ask: Ask, ruled: z.boolean() }),
	approvalNeeded: schemaNumber.optional(),
	approvals: z.array(ApprovalSigner).optional(),
	q: schemaText,
	kind: Kind,
	title: schemaText,
	producer: ActorKind,
	state: z.enum(["open", "decided", "dissolved"]),
	evidence: schemaData,
	evidenceHash: schemaText,
	seen: z.object({
		count: schemaNumber,
		carried: schemaNumber,
	}),
	needs: schemaText,
	/** The answers that apply to this question, in key order. The keys and labels are in `ANSWER_KEYS`. */
	answers: schemaTexts,
	blocks: schemaTexts,
	about: schemaTexts,
	openedAt: schemaNumber,
	advice: z.array(
		z.object({
			by: schemaText,
			kind: ActorKind,
			answer: schemaData,
			reason: schemaNullableText,
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
				.record(schemaText, schemaUnknownValue)
				.describe("The recorded effects of this decision, including adopted case refs and versions."),
		}),
		z.null(),
	]),
});
export type QuestionItem = z.infer<typeof QuestionItem>;
export const InboxReply = z.object({
	counts: schemaCounts,
	items: z.array(QuestionItem),
	cursor: schemaNullableText,
});
export type InboxReply = z.infer<typeof InboxReply>;

export const Problem = z.object({
	rule: schemaText,
	ref: schemaText,
	message: schemaText,
});
export type Problem = z.infer<typeof Problem>;

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
		op: schemaText,
	}),
	z.object({
		state: z.literal("done"),
		op: schemaText,
		seq: schemaNumber,
		reply: schemaUnknownValue,
	}),
]);
export type CommandFate = z.infer<typeof CommandFate>;

const text = schemaText;
const number = schemaNumber;
const whole = schemaWhole;
const flag = schemaFlag;
const texts = z.array(text);
const nullableText = text.nullable();
const counts = z.record(text, number);
const data = z.record(text, schemaUnknownValue);
const Body = CaseBody;
const Proof = z
	.looseObject({
		id: whole,
		version: whole.nullable(),
		by: text,
		method: text,
		model: nullableText,
		name: nullableText,
		outcome: text,
		at: number,
		current: flag,
		basis: text,
	})
	.nullable();
export const Proofs = z.object({ human: Proof, auto: Proof, agent: Proof });
export type Proofs = z.infer<typeof Proofs>;
const caseRef = text.regex(/^C-\d+$/);
export const CaseDocument = z.looseObject({
	ref: caseRef,
	version: whole,
	head: whole,
	etag: text,
	hash: text,
	claim: text,
	state: text,
	title: text.optional(),
	pre: text.optional(),
	steps: z.array(ExpandedStep).optional(),
	sourceSteps: z.array(Step).optional(),
	hasFragments: flag.optional(),
	fields: CaseBody.shape.fields.optional(),
	kind: CaseKind.optional(),
	users: z.array(z.object({ case: text, base: whole, versions: z.array(whole) })).optional(),
	methods: z.array(MethodKind).optional(),
	automate: Automate.optional(),
	tags: texts.optional(),
	covers: texts.optional(),
	folder: z.looseObject({ id: whole, path: text }).optional(),
	updated: z.looseObject({ at: number, by: text, kind: ActorKind }).optional(),
	proof: Proofs.optional(),
	open: whole.optional(),
	tests: z.array(z.looseObject({ t: text, name: text, file: nullableText })).optional(),
});
export const CaseSummary = z.looseObject({
	ref: caseRef,
	title: text,
	folder: whole,
	rank: text,
	tags: texts,
	version: whole,
	hash: text,
	steps: whole,
	methods: z.array(MethodKind),
	state: text,
	updatedAt: number,
	updatedBy: ActorKind,
	proof: Proofs,
	open: whole,
});
const Result = z.looseObject({
	location: ResultLocation,
	model: nullableText,
	steps: ResultTrail.nullable(),
	id: whole,
	test: nullableText,
	name: nullableText,
	outcome: text,
	method: text,
	by: text,
	at: number,
	basis: text,
	version: whole.nullable(),
	attempt: whole,
	durationMs: number.nullable(),
	message: nullableText,
	note: nullableText,
	atStep: nullableText,
	signature: nullableText,
	corrects: whole.nullable(),
	commit: nullableText,
	change: nullableText,
	job: text,
	build: nullableText,
});
/** A test as a commit's gate counted it: `find --in results`. */
const CountedResult = z.looseObject({
	location: ResultLocation,
	model: nullableText,
	steps: ResultTrail.nullable(),
	result: whole,
	test: text.regex(/^T-\d+$/),
	name: text,
	file: nullableText,
	case: nullableText,
	outcome: text,
	standing: text,
	quarantined: flag,
	/** Whether the test both passed and failed on this commit, in this job: a retry changed its outcome. */
	flipped: flag,
	/** How often the test flipped between passing and failing on the same code lately (`flaky.days`). */
	recentFlips: whole,
	question: nullableText,
	attempt: whole,
	durationMs: number.nullable(),
	message: nullableText,
	job: text,
	by: text,
	at: number,
	commit: nullableText,
	build: nullableText,
});
const TestSummary = z.looseObject({
	quarantine: Quarantine.nullable(),
	ref: text.regex(/^T-\d+$/),
	kind: text,
	key: text,
	name: text,
	file: nullableText,
	case: nullableText,
});
const Run = z.looseObject({
	location: ResultLocation.nullable(),
	quarantined: GateStatus.shape.quarantined,
	ref: text.regex(/^R-\d+$/),
	name: text,
	origin: text,
	state: text,
	verdict: Verdict,
	reason: text,
	stale: flag,
	tally: counts,
	open: texts,
	accepts: TargetMatch,
	require: z.array(Obligation),
	slots: whole.nullable(),
	inProgress: whole,
	workUntil: whole.nullable(),
	gate: GateStatus,
	flips: whole.nullable(),
	failing: z
		.array(
			z.looseObject({
				test: nullableText,
				quarantine: Quarantine.nullable(),
				name: nullableText,
				file: nullableText,
				case: nullableText,
				cause: nullableText,
				flipped: flag,
			}),
		)
		.nullable(),
	change: z
		.object({
			key: text,
			title: nullableText,
			url: nullableText,
			branch: nullableText,
			head: nullableText,
			base: nullableText,
		})
		.nullable(),
	createdAt: number,
	createdBy: text,
});
const ProposalEdit = z.discriminatedUnion("op", [
	QuarantineEdit,
	z.looseObject({
		op: z.literal("create"),
		body: Body,
		folder: text,
		tags: texts,
		covers: texts,
		/** The case the new case is asked to follow, or null for the end of its folder. */
		after: nullableText,
	}),
	z.looseObject({
		op: z.literal("edit"),
		case: nullableText,
		base: whole,
		head: whole,
		body: Body,
		mine: Body,
		current: Body.nullable(),
		conflicts: z.array(
			z.object({
				address: ConflictAddress,
				base: schemaUnknownValue.optional(),
				mine: schemaUnknownValue.optional(),
				theirs: schemaUnknownValue.optional(),
			}),
		),
		/** Why accepting this edit on its own would be refused now, while the proposal waits; else null. */
		refused: nullableText,
	}),
	z.looseObject({ op: z.literal("restore"), case: nullableText, to: whole, body: Body, current: Body.nullable() }),
	z.looseObject({
		op: z.literal("place"),
		cases: z.array(nullableText),
		folder: nullableText,
		tags: data.nullable(),
		/** For a move or a position: the case the cases are asked to follow, or "" for the end of the folder. */
		after: text.optional(),
	}),
	z.looseObject({ op: z.literal("state"), cases: z.array(nullableText), to: text }),
	z.looseObject({ op: z.literal("cover"), case: nullableText, requirement: text, on: flag }),
	z.looseObject({
		op: z.literal("folder"),
		/** The folder it changes, or null when it makes one. */
		folder: nullableText,
		name: nullableText,
		/** Where it moves the folder ("" for the top), absent when it stays where it is. */
		parent: text.optional(),
		archive: flag,
	}),
	z.looseObject({
		op: z.literal("policy"),
		preset: text,
		clauses: whole,
		/** The whole policy accepting writes, the one in force, and whether accepting refuses it as stale. */
		policy: Policy,
		inForce: Policy,
		stale: flag,
	}),
]);
const Proposal = z.looseObject({
	ref: text.regex(/^P-\d+$/),
	author: text,
	kind: ActorKind,
	reason: nullableText,
	at: number,
	/** How many edits the proposal has; `edits` holds this page of at most 200. */
	count: whole,
	cursor: nullableText,
	edits: z.array(ProposalEdit),
});
const Slot = z.looseObject({
	admittedMethods: z.array(MethodKind),
	methods: z.array(MethodKind),
	id: whole,
	case: nullableText,
	title: nullableText,
	version: whole,
	head: whole.nullable(),
	state: text,
	rank: number,
	assignee: nullableText,
	work: SlotWork,
	fills: z.array(
		z.looseObject({
			result: whole,
			by: text,
			model: nullableText,
			steps: ResultTrail.nullable(),
			method: text,
			outcome: text,
			admitted: text,
			at: number,
			note: nullableText,
			atStep: nullableText,
		}),
	),
});
const ChangeSummary = z.looseObject({
	key: text,
	title: nullableText,
	branch: nullableText,
	head: nullableText,
	url: nullableText,
	state: text,
	run: nullableText,
	verdict: Verdict.nullable(),
	reason: nullableText,
});
const Deployment = z.looseObject({
	id: whole,
	build: text,
	digest: text,
	env: text,
	actor: whole,
	at: number,
	code: ArtifactCode,
	attested_by: whole,
	attested_at: number,
	by: text,
	attestation: z.object({ by: text, at: number }),
});
const Settled = z.looseObject({ q: text, kind: text, title: text, answer: data.nullable(), by: texts });

const GetRow: z.ZodType<Record<string, unknown>> = z.union([
	z.object({ ref: text.regex(/^(commit:|change:)/), gate: GateStatus }),
	Result.extend({ ref: text.regex(/^result:[1-9]\d*$/), detail: nullableText, case: nullableText }),
	CaseDocument,
	z.looseObject({ ref: caseRef, unchanged: z.literal(true), hash: text, etag: text }),
	z.looseObject({ ref: caseRef, version: whole, hash: text, etag: text, md: text }),
	QuestionItem,
	Run,
	Proposal,
	TestSummary.extend({
		flips: whole,
		sameCode: SameCodeEvidence,
		/** `passedOnRetry`: the attempt of the same lane that passed where this failure failed, else null. */
		last: z.array(Result.extend({ passedOnRetry: whole.nullable() })),
	}),
]);
export const GetReply = z.array(GetRow);
const FindRow: z.ZodType<Record<string, unknown>> = z.union([
	MergeReceiptResult,
	CaseSummary,
	CountedResult,
	Run,
	Slot,
	TestSummary,
	ChangeSummary,
	Deployment,
	z.looseObject({ id: whole, parent: whole.nullable(), name: text, path: text, state: text, cases: whole }),
	z.looseObject({ tag: text, n: whole }),
	z.looseObject({ key: text, title: nullableText, cases: whole }),
]);
export const FindReply = z.looseObject({
	/** For cases: the project definitions used when writing custom field values. */
	fieldDefinitions: FieldDefinitions.optional(),
	count: whole.nullable(),
	cursor: nullableText,
	items: z.array(FindRow),
	/** For results: every row the gate counts, by how it counts them, whatever the filter. */
	tally: counts.optional(),
	/** For results: the summed duration of every row the gate counts, and how many named one, whatever the filter. */
	testTime: z.strictObject({ ms: whole, timed: whole }).optional(),
	/**
	 * For results, whatever the filter: the earliest start to the latest end the reports behind the counted rows
	 * named, by their runners' clocks. Null unless every one of those reports named both and nothing declared is
	 * still to arrive (issue #722).
	 */
	reportedSpan: z.strictObject({ startedAt: whole, endedAt: whole }).nullable().optional(),
	/**
	 * For results, whatever the filter: how many counted tests flipped on this commit, and how many of those that
	 * fail its gate flipped on some commit in the last `days` days.
	 */
	flaky: z.strictObject({ flipped: whole, failing: whole, days: whole }).optional(),
});
export const ImpactReply = z.looseObject({
	change: z.union([
		z.looseObject({
			key: text,
			head: nullableText,
			base: nullableText,
			files: whole,
			title: nullableText,
			state: text,
			mergeReceipt: MergeReceipt.nullable(),
			landing: z
				.object({
					commit: text,
					branch: text,
					run: nullableText,
					verdict: Verdict,
					reason: text,
					waiting: z.array(ShardWait).optional(),
				})
				.nullable(),
		}),
		z.strictObject({ files: whole }),
	]),
	gate: z.looseObject({ verdict: Verdict, reason: text, run: nullableText }).nullable(),
	counts: z.looseObject({ cases: whole, unreviewed: whole, failing: whole, uncovered: whole }),
	cases: z.array(
		z.looseObject({
			id: text,
			title: text,
			hash: text,
			why: texts,
			last: nullableText,
			reviewed: z.literal(true).optional(),
			open: z.array(z.looseObject({ q: text, evidence: text })).optional(),
		}),
	),
	uncovered: texts,
	decided: z.array(Settled),
	policy: text,
	cursor: text,
	next: nullableText,
});
export const SinceReply = z.looseObject({
	changed: z.array(z.looseObject({ ref: text, version: whole, hash: text, title: text, state: text, changed: text })),
	settled: z.array(Settled.extend({ state: text })),
	cursor: text,
	more: flag,
});
const fieldDiff = <S extends z.ZodType>(value: S) =>
	z.object({ kind: z.enum(["same", "changed"]), before: value, after: value });
const TextDiff = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("same"), before: nullableText, after: nullableText }),
	z.object({
		kind: z.literal("changed"),
		before: nullableText,
		after: nullableText,
		segments: z.array(z.object({ op: z.enum(["eq", "del", "ins"]), text })),
	}),
]);
const ExistingStep = z.object({ id: text, before: Step, after: Step, from: whole, to: whole });
const StepDiff = z.discriminatedUnion("kind", [
	ExistingStep.extend({ kind: z.literal("same") }),
	ExistingStep.extend({ kind: z.literal("moved") }),
	z.object({ kind: z.literal("added"), id: text, after: Step, to: whole }),
	z.object({ kind: z.literal("removed"), id: text, before: Step, from: whole }),
	ExistingStep.extend({ kind: z.literal("changed"), moved: flag, action: TextDiff, expected: TextDiff }),
]);
const BodyDiff = z.object({
	title: fieldDiff(text),
	pre: fieldDiff(text),
	methods: fieldDiff(z.array(MethodKind)),
	automate: fieldDiff(Automate),
	fields: fieldDiff(z.record(text, text)),
	steps: z.array(StepDiff),
});
export const HistoryReply = z.union([
	z.looseObject({
		ref: text,
		head: whole,
		versions: z.array(
			z.looseObject({
				version: whole,
				hash: text,
				by: text,
				kind: ActorKind,
				reason: nullableText,
				at: number,
				summary: text,
			}),
		),
	}),
	z.looseObject({ ref: text, from: whole, to: whole, summary: text, diff: BodyDiff }),
]);
const Entry = z.looseObject({ seq: whole, at: number, by: text });
const AuthoredEntry = Entry.extend({ kind: ActorKind });
export const TimelineReply = z.object({
	ref: text,
	head: whole,
	entries: z.array(
		z.discriminatedUnion("t", [
			AuthoredEntry.extend({
				t: z.literal("version"),
				version: whole,
				hash: text,
				reason: nullableText,
				summary: text,
				reviews: whole,
			}),
			AuthoredEntry.extend({ t: z.literal("placement"), what: text }),
			Result.extend({ t: z.literal("result"), seq: whole, ord: whole }),
			AuthoredEntry.extend({ t: z.literal("finding"), on: text, category: text, note: text, lens: text }),
			AuthoredEntry.extend({ t: z.literal("review"), lens: text, version: whole, about: nullableText }),
		]),
	),
	questions: z.array(QuestionItem),
});
export const CheckReply = z.looseObject({ problems: z.array(Problem), counts });
const Grant = z.looseObject({ project: text, can: texts, roles: texts.default([]) });
const Project = z.looseObject({
	key: text,
	identity: text,
	name: text,
	seq: whole,
	createdAt: number,
	policy: text,
	unlinked: Unlinked,
	fieldDefinitions: FieldDefinitions,
	demo: flag,
});
export const AdminReply = z.union([
	z.looseObject({ key: text, since: number }),
	TeamReply,
	z.looseObject({ key: text, identity: text, name: text, policy: text }),
	z.array(Project),
	z.looseObject({ id: whole, actor: text, token: text, can: texts, expiresAt: number.nullable(), note: text }),
	z.array(
		z.looseObject({
			id: whole,
			actor: text,
			kind: ActorKind,
			label: text,
			createdAt: number,
			createdBy: nullableText,
			expiresAt: number.nullable(),
			expired: flag,
			lastUsedAt: number.nullable(),
			lastUsedFrom: nullableText,
			revoked: flag,
		}),
	),
	z.looseObject({ revoked: flag }),
	z.array(
		z.looseObject({
			name: text,
			kind: ActorKind,
			owner: flag.optional(),
			grants: z.array(Grant),
			teams: z.array(TeamSource).default([]),
		}),
	),
	z.looseObject({ removed: flag }),
	Grant.extend({ actor: text }),
	z.looseObject({ forgotten: text, tokensRevoked: whole }),
	Policy.extend({ version: whole }),
]);
export const SessionReply = z.union([z.array(SessionRow), z.looseObject({ ended: z.literal(true), current: flag })]);
export const CredentialReply = z.union([
	z.array(CredentialRow),
	PersonalTokenCreated,
	z.array(PersonalTokenRow),
	z.object({ revoked: flag }),
	z.object({ removed: z.literal(true), sessionsEnded: whole }),
]);
export const InvitationReply = z.union([InvitationCreated, z.array(InvitationRow), z.object({ revoked: flag })]);

export const CsvImportReply = z.object({
	headers: z.array(text),
	rows: z.array(CsvImportRow),
	create: whole,
	refused: whole,
	confirmation: text.nullable(),
	proposal: ProposeReply.nullable(),
});
export type CsvImportReply = z.infer<typeof CsvImportReply>;

/** `audit`'s reply. The records it carries are read by `verifyAudit` in `audit.ts`, which no client needs. */
const auditCount = schemaWhole.nonnegative().max(Number.MAX_SAFE_INTEGER);
export const AuditReply = z.strictObject({
	format: z.literal(1),
	project: schemaText,
	records: auditCount,
	sha256: schemaText.regex(/^[a-f0-9]{64}$/),
	ndjson: schemaText,
	cursor: schemaNullableText.optional(),
	evidenceCount: auditCount.optional(),
	snapshot: z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.optional(),
});
/** Reply contracts shared by clients and registered beside each operation's input on the server. */
export const JobReply = z.object({ ran: z.number().int().nonnegative() });

export const REPLIES = {
	job: JobReply,
	attach: Attachment,
	attachment: AttachmentReply,
	audit: AuditReply,
	tracker: z.union([TrackerReceipt, TrackerPreview]),
	"tracker-status": TrackerReceipt,
	handoff: HandoffReceipt,
	"handoff-status": HandoffStatus,
	announce: AnnounceReply,
	propose: ProposeReply,
	"import-csv": CsvImportReply,
	report: ReportReceipt,
	claim: ClaimReply,
	plan: PlanReply,
	work: WorkReply,
	change: ChangeReply,
	decide: z.array(DecideReply),
	inbox: InboxReply,
	get: GetReply,
	find: FindReply,
	impact: ImpactReply,
	since: SinceReply,
	gate: GateStatus,
	history: HistoryReply,
	timeline: TimelineReply,
	check: CheckReply,
	stats: StatsReply,
	command: CommandFate,
	admin: AdminReply,
	session: SessionReply,
	credential: CredentialReply,
	invitation: InvitationReply,
};
