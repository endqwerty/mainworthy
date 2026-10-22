import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { z } from "zod";
import { MergeReceipt } from "./changes.ts";
import { canonicalJson, claimHash, versionHash } from "./hash.ts";
import { ActorKind, Capability, Clause, Kind, PolicySettings } from "./kinds.ts";
import { CaseBody, FragmentPin, FragmentStep, InlineStep, MethodKind } from "./model.ts";
import { TeamEvent, TeamGrant } from "./teams.ts";

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[a-f0-9]{12}$/);
const id = z
	.string()
	.regex(
		/^(?:decision:\d+|answer:\d+|policy:\d+|version:\d+:\d+|question:\d+|result:\d+|team:\d+|team-event:\d+|change-end:\d+|merge-receipt:\d+|merge-evidence:\d+:\d+|evidence:\d+:[a-f0-9]{12})$/,
	);
export const AuditInput = z
	.strictObject({
		from: integer.default(0),
		to: integer.optional(),
		receipt: integer.positive().optional(),
		cursor: z.string().optional(),
		limit: integer.min(1).max(50).optional(),
	})
	.refine((value) => value.to === undefined || value.to > value.from, { message: "to must be greater than from" });
export type AuditInput = z.infer<typeof AuditInput>;
export const AuditReply = z.strictObject({
	format: z.literal(1),
	project: z.string(),
	records: integer,
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
	ndjson: z.string(),
	cursor: z.string().nullable().optional(),
	evidenceCount: integer.optional(),
	snapshot: z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.optional(),
});
const Reference = z.discriminatedUnion("scope", [
	z.strictObject({ scope: z.literal("included"), id }),
	z.strictObject({ scope: z.literal("before-range"), id, at: integer }),
]);
export type AuditReference = z.infer<typeof Reference>;
const Actor = z.strictObject({ id: integer, name: z.string(), kind: ActorKind });
const Evidence = z.discriminatedUnion("state", [
	z.strictObject({ state: z.literal("recorded"), hash, ref: Reference }),
	z.strictObject({ state: z.literal("not-recorded") }),
]);
const event = { id, at: integer, seq: integer };
export const AuditHeader = z.strictObject({
	mainworthy: z.literal("audit"),
	format: z.literal(1),
	project: z.string().min(1),
	from: integer,
	to: integer,
	exportedAt: integer,
	seq: integer,
	grantChanges: z.literal("team-history-only"),
	teamState: z.literal("at-export"),
	evidencePayloads: z.literal("not-retained"),
	actorNames: z.literal("at-export"),
});
export type AuditHeader = z.infer<typeof AuditHeader>;
export const AuditRecord = z.discriminatedUnion("type", [
	z.strictObject({
		type: z.literal("merge-evidence"),
		...event,
		receipt: integer,
		ordinal: integer,
		kind: z.enum(["result", "gate"]),
		hash: z.string().regex(/^[a-f0-9]{64}$/),
		body: z.string().max(32768),
	}),
	z.strictObject({
		type: z.literal("merge-receipt"),
		...event,
		change: integer,
		key: z.string(),
		by: Actor,
		receipt: MergeReceipt,
	}),
	z.strictObject({
		type: z.literal("change-end"),
		id,
		at: integer,
		change: integer,
		key: z.string().min(1),
		repo: z.string().nullable(),
		state: z.enum(["merged", "closed"]),
	}),
	z.strictObject({
		type: z.literal("question"),
		id,
		openedAt: integer,
		openedSeq: integer,
		ref: z.string().regex(/^Q-\d+$/),
		kind: Kind,
		fingerprint: hash,
		prior: Reference.nullable(),
	}),
	z.strictObject({ type: z.literal("evidence"), id, question: Reference, hash }),
	z.strictObject({
		type: z.literal("result"),
		...event,
		test: integer,
		target: integer,
		commit: z.string().nullable(),
		repo: z.string().nullable(),
		env: z.string(),
		job: z.string(),
		method: MethodKind,
		by: Actor,
		outcome: z.enum(["pass", "fail", "skip", "blocked", "error"]),
		signature: integer.nullable(),
	}),
	z.strictObject({
		type: z.literal("team"),
		id,
		name: z.string(),
		createdAt: integer,
		members: z.array(Actor),
		grants: z.array(TeamGrant.strict()),
	}),
	z.strictObject({
		type: z.literal("team-event"),
		id,
		at: integer,
		team: Reference,
		by: Actor,
		action: TeamEvent.shape.action,
		person: Actor.nullable(),
		project: z.string().nullable(),
		can: z.array(Capability).nullable(),
	}),
	z.strictObject({
		type: z.literal("decision"),
		...event,
		question: Reference,
		prior: Reference.nullable(),
		kind: Kind,
		answer: z.json(),
		basis: hash,
		evidence: Evidence,
		holds: z.json(),
		effects: z.json(),
		inherited: z.array(z.strictObject({ result: Reference, base: z.array(Reference).min(1) })),
		expiresAt: integer.nullable(),
		signers: z.array(z.strictObject({ by: Actor, clause: z.string(), policy: integer, reason: z.string().nullable() })),
	}),
	z.strictObject({
		type: z.literal("answer"),
		...event,
		question: Reference,
		by: Actor,
		answer: z.json(),
		reason: z.string().nullable(),
		counts: z.boolean(),
		evidence: Evidence.options[0],
	}),
	z.strictObject({
		type: z.literal("policy"),
		...event,
		version: integer,
		by: Actor,
		prior: Reference.nullable(),
		decision: Reference.nullable(),
		preset: z.string(),
		clauses: z.json(),
		settings: z.json(),
	}),
	z.strictObject({
		type: z.literal("case-version"),
		...event,
		caseId: integer,
		case: z.string().regex(/^C-\d+$/),
		version: integer,
		by: Actor,
		parent: Reference.nullable(),
		decision: Reference,
		body: CaseBody.strict().extend({
			steps: z.array(z.union([InlineStep.strict(), FragmentStep.extend({ use: FragmentPin.strict() }).strict()])),
		}),
		hash,
		claimHash: hash,
		reason: z.string().nullable(),
	}),
]);
export type AuditRecord = z.infer<typeof AuditRecord>;
const Footer = z.strictObject({ end: z.literal(true), records: integer, sha256: z.string().regex(/^[a-f0-9]{64}$/) });

function auditEvent(record: AuditRecord) {
	switch (record.type) {
		case "question":
		case "evidence":
		case "result":
		case "team":
			return null;
		default:
			return record;
	}
}

export function compareAuditRecords(left: AuditRecord, right: AuditRecord): number {
	const a = auditEvent(left);
	const b = auditEvent(right);
	if (a && b) {
		const order = a.at - b.at || ("seq" in a ? a.seq : 0) - ("seq" in b ? b.seq : 0);
		if (order) return order;
	} else if (a || b) return a ? 1 : -1;
	return left.id.localeCompare(right.id, "en");
}

export function auditChecksum(text: string): string {
	return bytesToHex(sha256(utf8ToBytes(text)));
}

export function encodeAudit(header: AuditHeader, records: AuditRecord[]): z.infer<typeof AuditReply> {
	const body = `${[header, ...records].map((value) => canonicalJson(value)).join("\n")}\n`;
	const checksum = auditChecksum(body);
	const ndjson = `${body}${canonicalJson({ end: true, records: records.length, sha256: checksum })}\n`;
	verifyAudit(ndjson);
	return { format: 1, project: header.project, records: records.length, sha256: checksum, ndjson };
}

type Link = { ref: AuditReference; type: AuditRecord["type"] };
function links(record: AuditRecord): Link[] {
	const link = (ref: AuditReference | null, type: AuditRecord["type"]): Link[] => (ref ? [{ ref, type }] : []);
	switch (record.type) {
		case "question":
			return link(record.prior, "question");
		case "evidence":
			return link(record.question, "question");
		case "result":
		case "team":
		case "merge-evidence":
		case "merge-receipt":
		case "change-end":
			return [];
		case "team-event":
			return link(record.team, "team");
		case "decision":
			return [
				...link(record.question, "question"),
				...link(record.prior, "decision"),
				...link(record.evidence.state === "recorded" ? record.evidence.ref : null, "evidence"),
				...record.inherited.flatMap((row) => [
					...link(row.result, "result"),
					...row.base.flatMap((ref) => link(ref, "result")),
				]),
			];
		case "answer":
			return [...link(record.question, "question"), ...link(record.evidence.ref, "evidence")];
		case "policy":
			return [...link(record.prior, "policy"), ...link(record.decision, "decision")];
		case "case-version":
			return [...link(record.parent, "case-version"), ...link(record.decision, "decision")];
	}
}

const typePrefix: Record<AuditRecord["type"], string> = {
	question: "question:",
	evidence: "evidence:",
	result: "result:",
	team: "team:",
	"team-event": "team-event:",
	"change-end": "change-end:",
	"merge-receipt": "merge-receipt:",
	"merge-evidence": "merge-evidence:",
	decision: "decision:",
	answer: "answer:",
	policy: "policy:",
	"case-version": "version:",
};
function fail(message: string): never {
	throw new Error(`invalid audit: ${message}`);
}
function failLine(line: number, label: string, message: string): never {
	fail(`line ${line} ${label}: ${message}`);
}
function parse<S extends z.ZodType>(schema: S, line: string, number: number, label: string): z.output<S> {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		failLine(number, label, "invalid JSON");
	}
	const identity = z.object({ id: z.string() }).safeParse(value);
	const location = identity.success ? `${label} ${JSON.stringify(identity.data.id).slice(1, -1)}` : label;
	if (canonicalJson(value) !== line) failLine(number, location, "each line must be canonical JSON");
	const parsed = schema.safeParse(value);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		const path = issue?.path.join(".");
		failLine(number, location, `${path ? `${path}: ` : ""}${issue?.message ?? "invalid record"}`);
	}
	return parsed.data;
}

export function verifyAudit(text: string) {
	if (text.startsWith("\uFEFF")) failLine(1, "header", "byte-order mark is not allowed");
	if (!text.endsWith("\n")) fail("missing final newline or truncated footer");
	const lines = text.slice(0, -1).split("\n");
	const first = lines.shift();
	const last = lines.pop();
	if (!first || !last) fail("header and footer are required");
	const header = parse(AuditHeader, first, 1, "header");
	if (header.to <= header.from || header.to > header.exportedAt + 1) failLine(1, "header", "invalid time range");
	const footerLine = lines.length + 2;
	const footer = parse(Footer, last, footerLine, "footer");
	if (footer.records !== lines.length) failLine(footerLine, "footer", "record count mismatch");
	if (auditChecksum(`${[first, ...lines].join("\n")}\n`) !== footer.sha256)
		failLine(footerLine, "footer", "checksum mismatch");
	const records = lines.map((line, index) => parse(AuditRecord, line, index + 2, "record"));
	const byId = new Map<string, AuditRecord>();
	for (const [index, record] of records.entries()) {
		function fail(message: string): never {
			failLine(index + 2, `record ${record.id}`, message);
		}
		const previous = records[index - 1];
		if (previous && compareAuditRecords(previous, record) > 0) fail("records out of order");
		if (byId.has(record.id)) fail("duplicate id");
		if (!record.id.startsWith(typePrefix[record.type])) fail("wrong id type");
		if ("at" in record && (record.at >= header.to || (record.type !== "result" && record.at < header.from)))
			fail("record outside snapshot or range");
		if ("seq" in record && record.seq > header.seq) fail("record outside snapshot sequence");
		if (record.type === "question" && (record.openedAt >= header.to || record.openedSeq > header.seq))
			fail("question outside range or sequence");
		if (record.type === "change-end" && record.id !== `change-end:${record.change}`) fail("change ending id mismatch");
		if (record.type === "merge-evidence") {
			if (
				record.id !== `merge-evidence:${record.receipt}:${record.ordinal}` ||
				auditChecksum(record.body) !== record.hash
			)
				fail("merge evidence identity mismatch");
		}
		if (record.type === "merge-receipt") {
			if (record.id !== `merge-receipt:${record.receipt.id}`) fail("merge receipt id mismatch");
			if (record.at !== record.receipt.at || record.by.id !== record.receipt.by)
				fail("merge receipt provenance mismatch");
		}
		if (record.type === "case-version") {
			if (record.id !== `version:${record.caseId}:${record.version}`) fail("case version id mismatch");
			if (versionHash(record.body) !== record.hash || claimHash(record.body) !== record.claimHash)
				fail("case body hash mismatch");
		}
		if (record.type === "policy" && record.id !== `policy:${record.version}`) fail("policy id mismatch");
		byId.set(record.id, record);
	}
	let beforeRangeReferences = 0;
	let unavailableDecisionEvidence = 0;
	for (const [index, record] of records.entries()) {
		function fail(message: string): never {
			failLine(index + 2, `record ${record.id}`, message);
		}
		for (const { ref, type } of links(record)) {
			if (!ref.id.startsWith(typePrefix[type])) fail(`wrong reference type ${ref.id}`);
			if (ref.scope === "before-range") {
				if (
					type === "question" ||
					type === "evidence" ||
					type === "result" ||
					type === "team" ||
					ref.at >= header.from ||
					byId.has(ref.id)
				)
					fail(`invalid before-range reference ${ref.id}`);
				beforeRangeReferences++;
			} else {
				const target = byId.get(ref.id);
				if (!target || target.type !== type) fail(`unresolved reference ${ref.id}`);
				if ("seq" in target && "seq" in record && target.seq > record.seq) fail(`future reference ${ref.id}`);
			}
		}
		if (record.type === "evidence") {
			if (record.id !== `evidence:${record.question.id.slice("question:".length)}:${record.hash}`)
				fail("evidence id mismatch");
		}
		if (record.type === "answer" || record.type === "decision") {
			if (record.evidence.state === "not-recorded") unavailableDecisionEvidence++;
			else {
				const evidence = byId.get(record.evidence.ref.id);
				if (
					evidence?.type !== "evidence" ||
					evidence.hash !== record.evidence.hash ||
					evidence.question.id !== record.question.id
				)
					fail("evidence reference mismatch");
			}
			const question = byId.get(record.question.id);
			if (question?.type !== "question") fail("question reference mismatch");
			if (question.openedSeq > record.seq) fail("answer or decision precedes question opening sequence");
			if (record.type === "decision" && question.kind !== record.kind) fail("question kind mismatch");
		}
		if (record.type === "question" && record.prior) {
			const prior = byId.get(record.prior.id);
			if (prior?.type !== "question" || prior.fingerprint !== record.fingerprint || prior.openedSeq > record.openedSeq)
				fail("question prior mismatch");
		}
		if (record.type === "case-version") {
			const expected = record.version === 1 ? null : `version:${record.caseId}:${record.version - 1}`;
			if (record.version < 1 || (record.parent?.id ?? null) !== expected) fail("version parent mismatch");
		}
		if (record.type === "policy") {
			const expected = record.version === 1 ? null : `policy:${record.version - 1}`;
			if (record.version < 1 || (record.prior?.id ?? null) !== expected) fail("policy prior mismatch");
			if (!PolicySettings.safeParse(record.settings).success || !z.array(Clause).safeParse(record.clauses).success)
				fail("invalid policy settings or clauses");
		}
		if (record.type === "team") {
			if (record.grants.some((grant) => grant.project !== "*" && grant.project !== header.project))
				fail("team grant outside project");
			if (record.members.some((member) => member.kind !== "human")) fail("team member is not a person");
		}
		if (record.type === "team-event") {
			if (record.project !== null && record.project !== "*" && record.project !== header.project)
				fail("team event outside project");
			const member = record.action === "member.add" || record.action === "member.remove";
			const grant = record.action === "grant.set" || record.action === "grant.remove";
			if (
				member !== (record.person !== null) ||
				(record.person && record.person.kind !== "human") ||
				grant !== (record.project !== null) ||
				(record.action === "grant.set") !== (record.can !== null) ||
				record.can?.length === 0
			)
				fail("invalid team event action fields");
		}
		if (record.type === "decision") {
			const effects = z
				.object({ inherited: z.array(z.object({ result: integer, base: z.array(integer).min(1) })).default([]) })
				.safeParse(record.effects);
			if (!effects.success) fail("invalid inherited effects");
			const expected = effects.data.inherited;
			const actual = record.inherited.map((row) => ({
				result: Number(row.result.id.slice(7)),
				base: row.base.map((ref) => Number(ref.id.slice(7))),
			}));
			if (canonicalJson(expected) !== canonicalJson(actual)) fail("inherited effects mismatch");
			for (const row of record.inherited) {
				const head = byId.get(row.result.id);
				if (head?.type !== "result") fail("inherited result missing");
				for (const ref of row.base) {
					const base = byId.get(ref.id);
					if (
						base?.type !== "result" ||
						base.id === head.id ||
						base.test !== head.test ||
						base.signature === null ||
						base.signature !== head.signature ||
						base.repo !== head.repo ||
						base.env !== head.env ||
						base.job !== head.job ||
						base.method !== head.method ||
						base.method === "agent" ||
						base.by.kind === "agent" ||
						head.by.kind === "agent" ||
						!["fail", "error"].includes(base.outcome) ||
						!["fail", "error"].includes(head.outcome)
					)
						fail("inherited base lane mismatch");
				}
			}
		}
	}
	// Count dependencies without recursive traversal, including long histories.
	const remaining = new Map(
		records.map((record) => [record.id, links(record).filter(({ ref }) => ref.scope === "included").length]),
	);
	const dependents = new Map<string, string[]>();
	for (const record of records)
		for (const { ref } of links(record)) {
			if (ref.scope !== "included") continue;
			const list = dependents.get(ref.id) ?? [];
			list.push(record.id);
			dependents.set(ref.id, list);
		}
	const ready = records.filter((record) => remaining.get(record.id) === 0).map((record) => record.id);
	for (let i = 0; i < ready.length; i++)
		for (const dependent of dependents.get(ready[i] ?? "") ?? []) {
			const count = (remaining.get(dependent) ?? 0) - 1;
			remaining.set(dependent, count);
			if (count === 0) ready.push(dependent);
		}
	if (ready.length !== records.length) {
		const index = records.findIndex((record) => (remaining.get(record.id) ?? 0) > 0);
		failLine(index + 2, `record ${records[index]?.id}`, "reference cycle");
	}
	return {
		format: 1,
		project: header.project,
		records: records.length,
		sha256: footer.sha256,
		beforeRangeReferences,
		unavailableDecisionEvidence,
	};
}
