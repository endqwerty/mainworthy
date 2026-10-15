import { z } from "zod";
import { Attachment, AttachmentReply } from "./attachments.ts";
import { SameCodeEvidence } from "./flaky.ts";
import { ActorKind, Policy, Unlinked } from "./kinds.ts";
import { Automate, CaseBody, MethodKind, Step } from "./model.ts";
import {
	ChangeReply,
	ClaimReply,
	CommandFate,
	DecideReply,
	GateStatus,
	InboxReply,
	PlanReply,
	Problem,
	ProposeReply,
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
	hash: text,
	claim: text,
	state: text,
	title: text.optional(),
	pre: text.optional(),
	steps: z.array(Step).optional(),
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
});
const TestSummary = z.looseObject({
	ref: text.regex(/^T-\d+$/),
	kind: text,
	key: text,
	name: text,
	file: nullableText,
	case: nullableText,
});
const Run = z.looseObject({
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
	z.looseObject({ op: z.literal("create"), body: Body, folder: text, tags: texts, covers: texts }),
	z.looseObject({
		op: z.literal("edit"),
		case: nullableText,
		base: whole,
		head: whole,
		body: Body,
		mine: Body,
		current: Body.nullable(),
		conflicts: z.array(z.object({ path: text, base: z.unknown(), mine: z.unknown(), theirs: z.unknown() })),
	}),
	z.looseObject({ op: z.literal("restore"), case: nullableText, to: whole, body: Body }),
	z.looseObject({ op: z.literal("place"), cases: z.array(nullableText), folder: nullableText, tags: data.nullable() }),
	z.looseObject({ op: z.literal("state"), cases: z.array(nullableText), to: text }),
	z.looseObject({ op: z.literal("cover"), case: nullableText, requirement: text, on: flag }),
	z.looseObject({ op: z.literal("folder"), name: nullableText, archive: flag }),
	z.looseObject({ op: z.literal("policy"), preset: text, clauses: whole }),
]);
const Proposal = z.looseObject({
	ref: text.regex(/^P-\d+$/),
	author: text,
	kind: ActorKind,
	reason: nullableText,
	at: number,
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
const Settled = z.looseObject({ q: text, kind: text, title: text, answer: data.nullable(), by: texts });

const GetRow: z.ZodType<Record<string, unknown>> = z.union([
	CaseDocument,
	z.looseObject({ ref: text.regex(/^C-\d+$/), unchanged: z.literal(true), hash: text }),
	z.looseObject({ ref: text.regex(/^C-\d+$/), version: whole, hash: text, md: text }),
	QuestionItem,
	Run,
	Proposal,
	TestSummary.extend({ flips: whole, sameCode: SameCodeEvidence, last: z.array(Result) }),
]);
export const GetReply = z.array(GetRow);
const FindRow: z.ZodType<Record<string, unknown>> = z.union([
	CaseSummary,
	Run,
	Slot,
	TestSummary,
	ChangeSummary,
	z.looseObject({ id: whole, parent: whole.nullable(), name: text, path: text, state: text, cases: whole }),
	z.looseObject({ tag: text, n: whole }),
	z.looseObject({ key: text, title: nullableText, cases: whole }),
]);
export const FindReply = z.looseObject({
	count: whole.nullable(),
	cursor: nullableText,
	items: z.array(FindRow),
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
const Grant = z.looseObject({ project: text, can: texts });
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
	z.looseObject({ actor: text, token: text, can: texts, expiresAt: number.nullable(), note: text }),
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
		z.looseObject({ name: text, kind: ActorKind, grants: z.array(Grant), teams: z.array(TeamSource).default([]) }),
	),
	z.looseObject({ removed: flag }),
	Grant.extend({ actor: text }),
	z.looseObject({ forgotten: text, tokensRevoked: whole }),
	Policy.extend({ version: whole }),
]);
export const SessionReply = z.union([z.array(SessionRow), z.looseObject({ ended: z.literal(true), current: flag })]);
export const CredentialReply = z.union([
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

/** Reply contracts shared by clients and registered beside each operation's input on the server. */
export const REPLIES = {
	attach: Attachment,
	attachment: AttachmentReply,
	tracker: TrackerReceipt,
	"tracker-status": TrackerReceipt,
	propose: ProposeReply,
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
	command: CommandFate,
	admin: AdminReply,
	session: SessionReply,
	credential: CredentialReply,
	invitation: InvitationReply,
};
