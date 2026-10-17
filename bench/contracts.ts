import { z } from "zod";
import { Outcome } from "../src/core/ops.ts";
import type { App } from "../src/server/kernel/app.ts";
import type { Actor } from "../src/server/kernel/ctx.ts";
import { OPS } from "../src/server/ops/index.ts";
import { invoke } from "../src/server/ops/registry.ts";

/** Design §6.6/C7 budgets, plus this task's execution, history, mixed-load and half-size ingest budgets. */
export const BUDGETS = {
	case: 20,
	folder: 50,
	search: 100,
	save: 50,
	bulk: 1_000,
	ingest: 2_000,
	visible: 5_000,
	test: 20,
	gate: 20,
	queue: 50,
	reports: 100,
	execute: 50,
	mixed: 50,
	smallIngest: 1_000,
};

const stamp = z.object({ ref: z.string(), version: z.number().int(), hash: z.string() });
export const Proposal = z.object({
	proposal: z.string().nullable(),
	status: z.enum(["adopted", "open", "conflict", "rejected"]),
	cases: z.array(stamp),
});
export const Proof = z.object({
	human: z.object({ outcome: Outcome, current: z.boolean(), basis: z.string(), at: z.number() }).nullable(),
	auto: z.object({ outcome: Outcome, current: z.boolean(), basis: z.string(), at: z.number() }).nullable(),
	agent: z.object({ outcome: Outcome, current: z.boolean(), basis: z.string(), at: z.number() }).nullable(),
});
export const CaseView = stamp.extend({
	head: z.number().int(),
	title: z.string(),
	pre: z.string(),
	steps: z.array(z.object({ id: z.string(), action: z.string(), expected: z.string().nullable() })),
	tags: z.array(z.string()),
	proof: Proof,
	open: z.number().int().nonnegative(),
	folder: z.object({ id: z.number().int(), path: z.string() }),
});
export const CasePage = z.object({
	count: z.number().int().nullable(),
	items: z.array(stamp.extend({ title: z.string(), folder: z.number().int(), proof: Proof, open: z.number().int() })),
	cursor: z.string().nullable(),
});
export const TestPage = z.object({
	items: z.array(
		z.object({ ref: z.string(), key: z.string(), file: z.string().nullable(), case: z.string().nullable() }),
	),
	cursor: z.string().nullable(),
});
export const TestView = z.object({
	ref: z.string(),
	key: z.string(),
	last: z.array(z.object({ id: z.number().int(), outcome: Outcome, test: z.string(), attempt: z.number().int() })),
});
export const Gate = z.object({
	run: z.string().nullable(),
	verdict: z.enum(["passed", "failed", "blocked", "pending"]),
	tally: z.record(z.string(), z.number()),
	open: z.array(z.string()),
	stale: z.boolean(),
});
export const Receipt = z.object({
	batch: z.number().int(),
	fresh: z.boolean(),
	counts: z.object({ total: z.number().int(), pass: z.number().int(), fail: z.number().int(), skip: z.number().int() }),
	basis: z.object({ exact: z.number().int(), assumed: z.number().int(), unresolved: z.number().int() }),
	rejected: z.array(z.object({ index: z.number().int(), reason: z.string() })),
	questions: z.array(z.object({ q: z.string(), kind: z.string(), how: z.string(), state: z.string() })),
	gate: Gate.nullable(),
	results: z.array(z.number().int()),
});
export const Queue = z.object({
	counts: z.record(z.string(), z.number().int().nonnegative()),
	items: z.array(
		z.object({
			q: z.string(),
			kind: z.string(),
			state: z.string(),
			evidenceHash: z.string(),
			evidence: z.record(z.string(), z.unknown()),
			seen: z.object({ count: z.number().int(), carried: z.number().int() }),
		}),
	),
	cursor: z.string().nullable(),
});
export const Decisions = z.array(z.object({ q: z.string(), status: z.string() }));
export const Plan = z.object({ run: z.string(), slots: z.number().int(), already: z.number().int() });
export const Slots = z.object({
	items: z.array(
		z.object({ case: z.string(), state: z.string(), fills: z.array(z.object({ result: z.number().int() })) }),
	),
});
export const Delta = z.object({
	changed: z.array(z.object({ ref: z.string(), changed: z.string() })),
	settled: z.array(z.object({ q: z.string() })),
	cursor: z.string(),
});
export const Impact = z.object({
	counts: z.object({ cases: z.number().int(), uncovered: z.number().int() }),
	cases: z.array(z.object({ id: z.string(), why: z.array(z.string()), hash: z.string() })),
	change: z.object({ files: z.number().int() }),
});

/** Runs the public operation boundary and refuses errors before parsing its unknown output. */
export function call<T>(
	app: App,
	actor: Actor,
	op: string,
	input: unknown,
	output: z.ZodType<T>,
	project = "benchmark",
): T {
	const reply = invoke(app, OPS, { op, project: op === "admin" ? null : project, input, actor: () => actor });
	if (!reply.ok) throw new Error(`${op}: ${reply.error.code}: ${reply.error.message}`);
	return output.parse(reply.result);
}

/** Fails a correctness check even when the operation returned a successful reply. */
export function ensure(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

/** Requires a present array member without weakening its element type. */
export function itemAt<T>(items: readonly T[], index: number): T {
	const item = items[index];
	if (item === undefined) throw new Error(`missing item ${index} of ${items.length}`);
	return item;
}
