import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { GateStatus } from "../src/core/ops.ts";
import { findProject, makeCtx, stampSeq } from "../src/server/kernel/ctx.ts";
import { acceptReport } from "../src/server/ops/writes.ts";
import { type Harness, harness } from "./helpers.ts";

// A change run's reported test span (issue #722): from the earliest start to the latest end its counted reports
// named, shown only when every one of them named both and nothing declared is still on its way.

type Span = { startedAt: number; endedAt: number };
type Results = { count: number; cursor: string | null; reportedSpan: Span | null };

let h: Harness;
beforeEach(async () => {
	h = await harness();
});
afterEach(async () => await h?.close());

const COMMIT = "5ba9000000000000000000000000000000000001";
const target = { commit: COMMIT, repo: "acme/web", branch: "feature", pr: 7 };
const T0 = 1_790_000_000_000;
const pass = (name: string) => ({ test: { key: `tests/span.spec.ts::${name}`, name }, outcome: "pass", durationMs: 5 });
const fail = (name: string) => ({ ...pass(name), outcome: "fail", failure: { message: `${name} broke` } });
const results = async (input: Record<string, unknown> = {}) =>
	await h.call<Results>("find", { in: "results", commit: COMMIT, ...input });
const report = async (input: Record<string, unknown>) => await h.call("report", { target, job: "e2e", ...input });
const rows = async <T>(query: string): Promise<T[]> => await h.app.database.read((db) => db.allDynamic<T>(query));

describe("a change run's reported test span", () => {
	test("is the earliest start to the latest end of its reports, whatever the filter or the page", async () => {
		await report({
			shard: { index: 1, of: 2 },
			span: { startedAt: T0 + 1_000, endedAt: T0 + 60_000 },
			results: [pass("a"), pass("b")],
		});
		await report({
			shard: { index: 2, of: 2 },
			span: { startedAt: T0, endedAt: T0 + 45_000 },
			results: [pass("c"), fail("d")],
		});
		const span = { startedAt: T0, endedAt: T0 + 60_000 };
		expect((await results()).reportedSpan).toEqual(span);
		expect((await results({ state: "pass" })).reportedSpan).toEqual(span);
		expect((await results({ text: "nothing matches this" })).reportedSpan).toEqual(span);
		const first = await results({ limit: 1 });
		expect(first.reportedSpan).toEqual(span);
		expect((await results({ limit: 1, cursor: first.cursor })).reportedSpan).toEqual(span);
		expect((await h.call<Results>("find", { in: "results", change: "pr:7" })).reportedSpan).toEqual(span);
	});

	test("is absent while a declared shard has not reported", async () => {
		await report({
			shard: { index: 1, of: 2 },
			span: { startedAt: T0, endedAt: T0 + 60_000 },
			results: [pass("a")],
		});
		expect((await results()).reportedSpan).toBeNull();
		await report({
			shard: { index: 2, of: 2 },
			span: { startedAt: T0 + 5_000, endedAt: T0 + 70_000 },
			results: [pass("b")],
		});
		expect((await results()).reportedSpan).toEqual({ startedAt: T0, endedAt: T0 + 70_000 });
	});

	test("is absent when one contributing report named no span", async () => {
		await report({ span: { startedAt: T0, endedAt: T0 + 60_000 }, results: [pass("a")] });
		await report({ job: "unit", results: [pass("b")] });
		expect((await results()).reportedSpan).toBeNull();
	});

	test("is absent while an accepted report waits to be applied", async () => {
		await report({ span: { startedAt: T0, endedAt: T0 + 60_000 }, results: [pass("a")] });
		expect((await results()).reportedSpan).not.toBeNull();
		await h.app.database.write((db) =>
			db.transaction(async () => {
				const project = await findProject(db, "scratch");
				if (!project) throw new Error("no project");
				const ctx = makeCtx(h.app, db, project, h.owner, true);
				await acceptReport(ctx, {
					target,
					job: "late",
					span: { startedAt: T0, endedAt: T0 + 90_000 },
					results: [{ test: { key: "tests/span.spec.ts::late" }, outcome: "pass" }],
				});
				await stampSeq(ctx);
			}),
		);
		expect((await results()).reportedSpan).toBeNull();
	});

	test("is absent for a commit with nothing counted", async () => {
		expect((await results({ commit: "dead000000000000000000000000000000000000" })).reportedSpan).toBeNull();
	});

	test("takes in a retry's wait when both attempts supply counted results, and only the rerun when it replaced all", async () => {
		await report({ span: { startedAt: T0, endedAt: T0 + 60_000 }, results: [pass("a"), fail("b")] });
		await report({ attempt: 2, span: { startedAt: T0 + 600_000, endedAt: T0 + 630_000 }, results: [pass("b")] });
		// Attempt 1 still supplies `a`, so the span runs from its start to the rerun's end, the wait between them included.
		expect((await results()).reportedSpan).toEqual({ startedAt: T0, endedAt: T0 + 630_000 });

		const other = "5ba9000000000000000000000000000000000002";
		await h.call("report", {
			target: { ...target, commit: other },
			job: "e2e",
			span: { startedAt: T0, endedAt: T0 + 60_000 },
			results: [fail("b")],
		});
		await h.call("report", {
			target: { ...target, commit: other },
			job: "e2e",
			attempt: 2,
			span: { startedAt: T0 + 600_000, endedAt: T0 + 630_000 },
			results: [pass("b")],
		});
		expect((await results({ commit: other })).reportedSpan).toEqual({
			startedAt: T0 + 600_000,
			endedAt: T0 + 630_000,
		});
	});

	test("a batch holds both halves of a span or neither (the verifier's finding)", async () => {
		await report({ span: { startedAt: T0, endedAt: T0 + 60_000 }, results: [pass("a")] });
		for (const half of ["started_at", "ended_at"])
			await expect(
				h.app.database.write((db) => db.transaction(() => db.exec(`UPDATE batches SET ${half} = NULL`))),
			).rejects.toThrow(/batches_span/);
		// The verifier's finding: a stored time beyond what a reply can carry made the results read fail.
		await expect(
			h.app.database.write((db) => db.transaction(() => db.exec("UPDATE batches SET ended_at = 9007199254740992"))),
		).rejects.toThrow(/batches_span/);
	});

	test("never moves a gate or the time a write is stored at", async () => {
		await report({ results: [pass("a"), fail("b")] });
		const before = await h.call<GateStatus>("gate", { commit: COMMIT });
		const other = "5ba9000000000000000000000000000000000003";
		await h.call("report", {
			target: { ...target, commit: other },
			job: "e2e",
			span: { startedAt: T0, endedAt: T0 + 60_000 },
			results: [pass("a"), fail("b")],
		});
		const after = await h.call<GateStatus>("gate", { commit: other });
		expect({ verdict: after.verdict, tally: after.tally }).toEqual({ verdict: before.verdict, tally: before.tally });
		const stored = await rows<{ at: number; started_at: number | null; ended_at: number | null }>(
			"SELECT at, started_at, ended_at FROM batches ORDER BY id",
		);
		expect(stored.map((row) => [row.started_at, row.ended_at])).toEqual([
			[null, null],
			[T0, T0 + 60_000],
		]);
		// The harness clock starts at 1,800,000,000,000: every write keeps the server's time, never the span's.
		for (const row of stored) expect(row.at).toBeGreaterThan(1_800_000_000_000);
		for (const row of await rows<{ at: number }>("SELECT at FROM results"))
			expect(row.at).toBeGreaterThan(1_800_000_000_000);
	});

	test("a span that ends before it starts, or is no whole number of milliseconds, is refused", async () => {
		for (const span of [
			{ startedAt: T0, endedAt: T0 - 1 },
			{ startedAt: -1, endedAt: T0 },
			{ startedAt: T0 + 0.5, endedAt: T0 + 1 },
			{ startedAt: T0 },
		]) {
			const reply = await h.raw("report", { target, job: "e2e", span, results: [pass("a")] });
			expect(reply).toMatchObject({ ok: false, error: { code: "invalid" } });
		}
		expect(await rows("SELECT id FROM batches")).toEqual([]);
	});

	test("the same report with the same span is one batch; another span is another report", async () => {
		const input = { span: { startedAt: T0, endedAt: T0 + 60_000 }, results: [pass("a")] };
		expect(await report(input)).toMatchObject({ fresh: true });
		expect(await report(input)).toMatchObject({ fresh: false });
		expect(await report({ ...input, span: { startedAt: T0, endedAt: T0 + 61_000 } })).toMatchObject({ fresh: true });
	});
});
