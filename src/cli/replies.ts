import { z } from "zod";
import type { Api, OpName } from "../core/api.ts";
import { ActorKind, Kind } from "../core/kinds.ts";
import { Verdict } from "../core/runs.ts";

const record = z.record(z.string(), z.unknown());
const rows = z.array(record);
const strings = z.array(z.string());
const counts = z.record(z.string(), z.number());
const Question = z
	.object({
		q: z.string(),
		kind: Kind,
		title: z.string(),
		producer: ActorKind,
		state: z.enum(["open", "decided", "dissolved"]),
		evidence: record,
		evidenceHash: z.string(),
		seen: z.object({ count: z.number(), carried: z.number() }),
		needs: z.string(),
		answers: strings,
		blocks: strings,
		about: strings,
		openedAt: z.number(),
		advice: z.array(z.object({ by: z.string(), kind: ActorKind, answer: record, reason: z.string().nullable() })),
		you: z.enum(["counts", "advice", "forbidden"]).optional(),
		decision: z
			.object({
				id: z.number(),
				answer: record,
				by: strings,
				rule: z.string().nullable(),
				reason: z.string().nullable(),
				at: z.number(),
			})
			.nullable(),
	})
	.transform(({ you, ...question }) => ({ ...question, ...(you === undefined ? {} : { you }) }));

const Gate = z.object({
	run: z.string().nullable(),
	verdict: Verdict,
	reason: z.string(),
	tally: counts,
	open: strings,
	url: z.string().nullable(),
	stale: z.boolean(),
});
const CaseStamp = z.object({ ref: z.string(), version: z.number(), hash: z.string() });
const InvitationPurpose = z.enum(["join", "recover"]);
const InvitationCreated = z.object({
	id: z.number(),
	name: z.string(),
	purpose: InvitationPurpose,
	can: strings,
	project: z.string(),
	expiresAt: z.number(),
	code: z.string(),
	link: z.string(),
	note: z.string(),
});

/** Runtime reply validation stays checked against Api: a changed required field or type fails compilation here. */
export const REPLY_SCHEMAS: { [N in OpName]: z.ZodType<Api[N]["reply"]> } = {
	propose: z.object({
		proposal: z.string().nullable(),
		status: z.enum(["adopted", "open", "conflict", "rejected"]),
		question: z.string().nullable(),
		needs: z.string().nullable(),
		cases: z.array(CaseStamp),
		conflicts: z.array(z.object({ case: z.string(), paths: strings })),
	}),
	report: z.object({
		batch: z.number(),
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
		basis: z.object({ exact: z.number(), assumed: z.number(), unresolved: z.number() }),
		questions: z.array(
			z.object({
				q: z.string(),
				kind: Kind,
				title: z.string(),
				state: z.enum(["open", "decided"]),
				how: z.enum(["new", "already open", "already decided", "decided by rule"]),
				answer: z.string().nullable(),
				by: z.string().nullable(),
				tests: z.number(),
			}),
		),
		unlinked: z.number(),
		flips: z.number(),
		rejected: z.array(z.object({ index: z.number(), reason: z.string() })),
		declined: z.array(z.object({ index: z.number(), reason: z.string() })).default([]),
		results: z.array(z.number()),
		gate: Gate.nullable(),
	}),
	claim: z.object({
		opened: strings,
		known: z.array(
			z.object({ q: z.string(), state: z.string(), answer: z.string().nullable(), by: z.string().nullable() }),
		),
		reviewed: z.number(),
	}),
	plan: z.object({ run: z.string(), slots: z.number(), already: z.number() }),
	decide: z.array(
		z.object({
			q: z.string(),
			status: z.enum(["decided", "advised", "conflict", "forbidden", "invalid", "already", "reopened"]),
			needs: z.string().nullable(),
			decision: z.number().nullable(),
			effects: record.nullable(),
			evidence: z.string().nullable(),
		}),
	),
	inbox: z.object({ counts, items: z.array(Question), cursor: z.string().nullable() }),
	get: rows,
	find: z
		.looseObject({
			count: z.number().nullable(),
			items: rows,
			cursor: z.string().nullable(),
			tags: z.array(z.object({ tag: z.string(), n: z.number() })).optional(),
		})
		.transform(({ tags, ...found }) => ({ ...found, ...(tags === undefined ? {} : { tags }) })),
	impact: record,
	since: z.object({ changed: rows, settled: rows, cursor: z.string() }),
	gate: Gate,
	history: record,
	timeline: z.object({ ref: z.string(), head: z.number(), entries: rows, questions: z.array(Question) }),
	check: z.object({ problems: z.array(z.object({ rule: z.string(), ref: z.string(), message: z.string() })), counts }),
	command: z.discriminatedUnion("state", [
		z.object({ state: z.literal("none") }),
		z.object({ state: z.literal("begun"), op: z.string() }),
		z.object({ state: z.literal("done"), op: z.string(), seq: z.number(), reply: z.unknown() }),
	]),
	admin: z.unknown(),
	session: z.union([
		z.array(
			z.object({
				id: z.number(),
				openedWith: z.enum(["token", "password", "passkey"]),
				label: z.string(),
				userAgent: z.string().nullable(),
				createdAt: z.number(),
				createdFrom: z.string().nullable(),
				lastUsedAt: z.number(),
				lastUsedFrom: z.string().nullable(),
				expiresAt: z.number(),
				current: z.boolean(),
			}),
		),
		z.object({ ended: z.literal(true), current: z.boolean() }),
	]),
	credential: z.union([
		z.array(
			z.object({
				id: z.number(),
				kind: z.enum(["password", "passkey"]),
				label: z.string(),
				createdAt: z.number(),
				lastUsedAt: z.number().nullable(),
			}),
		),
		record,
	]),
	invitation: z.union([
		InvitationCreated,
		z.array(
			z.object({
				id: z.number(),
				name: z.string(),
				purpose: InvitationPurpose,
				createdBy: z.string(),
				createdAt: z.number(),
				expiresAt: z.number(),
				state: z.enum(["open", "used", "revoked", "expired"]),
			}),
		),
		z.object({ revoked: z.boolean() }),
	]),
};
