import { z } from "zod";
import { Attachment, AttachmentReply } from "./attachments.ts";
import { AuditReply } from "./audit.ts";
import { CsvImportRow } from "./csv.ts";
import { Quarantine, SameCodeEvidence } from "./flaky.ts";
import { ActorKind, Policy, Unlinked } from "./kinds.ts";
import { Automate, CaseBody, CaseKind, ConflictAddress, ExpandedStep, MethodKind, Step } from "./model.ts";
import {
	AnnounceReply,
	ArtifactCode,
	ChangeReply,
	ClaimReply,
	CommandFate,
	DecideReply,
	GateStatus,
	InboxReply,
	PlanReply,
	Problem,
	ProposeReply,
	QuarantineEdit,
	QuestionItem,
	ReportReceipt,
} from "./ops.ts";
import {
	CredentialRow,
	InvitationCreated,
	InvitationRow,
	PersonalTokenCreated,
	PersonalTokenRow,
	SessionRow,
	TotpConfirmed,
	TotpEnrolment,
} from "./people.ts";
import { Obligation, TargetMatch, Verdict } from "./runs.ts";
import { StatsReply } from "./stats.ts";
import { TeamReply, TeamSource } from "./teams.ts";
import { TrackerReceipt } from "./tracker.ts";

const text = z.string();
const number = z.number();
const whole = z.number().int();
const flag = z.boolean();
const texts = z.array(text);
const nullableText = text.nullable();
const counts = z.record(text, number);
const data = z.record(text, z.unknown());
const Body = CaseBody;
const Proof = z.looseObject({ outcome: text, at: number, current: flag, basis: text }).nullable();
const Proofs = z.looseObject({ human: Proof, auto: Proof, agent: Proof });
const CaseDocument = z.looseObject({
	ref: text.regex(/^C-\d+$/),
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
const CaseSummary = z.looseObject({
	ref: text.regex(/^C-\d+$/),
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
	result: whole,
	test: text.regex(/^T-\d+$/),
	name: text,
	file: nullableText,
	case: nullableText,
	outcome: text,
	standing: text,
	quarantined: flag,
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
				base: z.unknown().optional(),
				mine: z.unknown().optional(),
				theirs: z.unknown().optional(),
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
	id: whole,
	case: nullableText,
	title: nullableText,
	version: whole,
	head: whole.nullable(),
	state: text,
	rank: number,
	assignee: nullableText,
	fills: z.array(
		z.looseObject({
			result: whole,
			by: text,
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
	CaseDocument,
	z.looseObject({ ref: text.regex(/^C-\d+$/), unchanged: z.literal(true), hash: text, etag: text }),
	z.looseObject({ ref: text.regex(/^C-\d+$/), version: whole, hash: text, etag: text, md: text }),
	QuestionItem,
	Run,
	Proposal,
	TestSummary.extend({ flips: whole, sameCode: SameCodeEvidence, last: z.array(Result) }),
]);
export const GetReply = z.array(GetRow);
const FindRow: z.ZodType<Record<string, unknown>> = z.union([
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
	count: whole.nullable(),
	cursor: nullableText,
	items: z.array(FindRow),
	/** For results: every row the gate counts, by how it counts them, whatever the filter. */
	tally: counts.optional(),
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
	name: text,
	seq: whole,
	createdAt: number,
	policy: text,
	unlinked: Unlinked,
	demo: flag,
});
export const AdminReply = z.union([
	z.looseObject({ key: text, since: number }),
	TeamReply,
	z.looseObject({ key: text, name: text, policy: text }),
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
	z.object({ email: text.nullable(), verified: flag }),
	TotpEnrolment,
	TotpConfirmed,
	z.array(CredentialRow),
	PersonalTokenCreated,
	z.array(PersonalTokenRow),
	z.object({ revoked: flag }),
	z.object({
		challenge: text,
		rp: z.object({ id: text, name: text }),
		user: z.object({ id: text, name: text, displayName: text }),
		pubKeyCredParams: z.array(z.object({ type: text, alg: number })).readonly(),
		timeout: number,
		attestation: text,
		authenticatorSelection: z.object({
			residentKey: text,
			requireResidentKey: z.literal(true),
			userVerification: text,
		}),
		excludeCredentials: z.array(z.object({ type: text, id: text, transports: texts.readonly() })).readonly(),
	}),
	z.object({ id: whole, label: text }),
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

/** Reply contracts shared by clients and registered beside each operation's input on the server. */
export const REPLIES = {
	attach: Attachment,
	attachment: AttachmentReply,
	audit: AuditReply,
	tracker: TrackerReceipt,
	"tracker-status": TrackerReceipt,
	announce: AnnounceReply,
	propose: ProposeReply,
	"import-csv": CsvImportReply,
	report: ReportReceipt,
	claim: ClaimReply,
	plan: PlanReply,
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
