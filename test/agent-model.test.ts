import { afterEach, describe, expect, test } from "bun:test";
import type { ReportReceipt, WorkReply } from "../src/core/ops.ts";
import { dropResetIndexes } from "./demo-removal-fixture.ts";
import { ciReport, dropReceiptSchema, type Harness, harness } from "./helpers.ts";

let h: Harness;
afterEach(() => h?.close());

describe("the model behind an agent's results", () => {
	test("an agent's whole batch keeps its trimmed model beside every producer", async () => {
		h = await harness();
		const agent = h.actor("runner", "agent", ["read", "produce"]);
		const report = { ...ciReport({ commit: "model001", n: 2 }), model: " claude-opus-5-5 " };
		const receipt = await h.call<ReportReceipt>("report", report, agent);
		const tests = await h.call<{ items: { ref: string }[] }>("find", { in: "tests" });
		expect(tests.items.map(({ ref }) => ref).sort()).toEqual(["T-1", "T-2"]);
		for (const row of tests.items) {
			const [detail] = await h.call<{ last: { by: string; model: string | null }[] }[]>("get", { refs: [row.ref] });
			expect(detail?.last.map(({ by, model }) => ({ by, model }))).toEqual([
				{ by: "runner", model: "claude-opus-5-5" },
			]);
		}
		expect(await h.call<ReportReceipt>("report", report, agent)).toEqual({ ...receipt, fresh: false });
		expect((await h.call<ReportReceipt>("report", { ...report, model: "gpt-6.1-sol" }, agent)).fresh).toBe(true);
	});

	test.each(["human", "ci"] as const)("a %s cannot attach a model or leave an accepted batch", async (kind) => {
		h = await harness();
		const actor = h.actor("reporter", kind, ["read", "record"]);
		expect(
			await h.raw("report", { ...ciReport({ commit: "model002", n: 1 }), model: "gpt-6.1-sol" }, actor),
		).toMatchObject({
			ok: false,
			error: { code: "invalid", message: "Only an agent's report can name a model." },
		});
		expect(h.app.db.raw.query("SELECT count(*) AS n FROM batches").get()).toEqual({ n: 0 });
		expect((await h.call<ReportReceipt>("report", ciReport({ commit: "model002", n: 1 }), actor)).counts.total).toBe(1);
	});

	test.each(["", "  ", "m".repeat(121)])("an invalid model is refused: %j", async (model) => {
		h = await harness();
		const agent = h.actor("runner", "agent", ["read", "produce"]);
		expect(await h.raw("report", { ...ciReport({ commit: "model003", n: 1 }), model }, agent)).toMatchObject({
			ok: false,
			error: { code: "invalid" },
		});
	});

	test("an agent may omit its model without inventing one", async () => {
		h = await harness();
		const agent = h.actor("runner", "agent", ["read", "produce"]);
		await h.call("report", ciReport({ commit: "model004", n: 1 }), agent);
		const [detail] = await h.call<{ last: { by: string; model: string | null }[] }[]>("get", { refs: ["T-1"] });
		expect(detail?.last.map(({ by, model }) => ({ by, model }))).toEqual([{ by: "runner", model: null }]);
	});
});

test("accepted reports recover the model, and planned slots and case activity expose it", async () => {
	h = await harness();
	const agent = h.actor("runner", "agent", ["read", "produce"]);
	await h.call("propose", {
		edits: [
			{
				op: "create",
				body: { title: "Coupon", methods: ["agent"], steps: [{ id: "s1", action: "Apply", expected: "90" }] },
			},
		],
	});
	const { run } = await h.call<{ run: string }>("plan", {
		name: "Agent check",
		select: { cases: ["C-1"] },
		require: [{ id: "agent", kind: "exercise", methods: ["agent"], minActors: 1, basis: "exact" }],
	});
	expect((await h.call<WorkReply>("work", { do: "take", run }, agent)).work).toMatchObject({
		kind: "held",
		actor: "runner",
	});
	const { acceptReport } = await import("../src/server/ops/writes.ts");
	const { findProject, makeCtx, stampSeq } = await import("../src/server/kernel/ctx.ts");
	const { recoverAccepted } = await import("../src/server/ops/jobs.ts");
	await h.app.db.transaction(async () => {
		const project = await findProject(h.app.db, "scratch");
		if (!project) throw new Error("missing project");
		const ctx = makeCtx(h.app, project, agent, true);
		await acceptReport(ctx, { run, model: "gpt-6.1-sol", results: [{ test: { case: "C-1" }, outcome: "pass" }] });
		await stampSeq(ctx);
	});
	expect(await recoverAccepted(h.app)).toBe(1);
	const slots = await h.call<{ items: { work: WorkReply["work"]; fills: { by: string; model: string | null }[] }[] }>(
		"find",
		{ in: "slots", run },
	);
	expect(slots.items[0]?.work).toEqual({ kind: "free" });
	expect(slots.items[0]?.fills.map(({ by, model }) => ({ by, model }))).toEqual([
		{ by: "runner", model: "gpt-6.1-sol" },
	]);
	const activity = await h.call<{ entries: { t: string; by: string; model?: string | null }[] }>("timeline", {
		ref: "C-1",
	});
	expect(activity.entries.filter(({ t }) => t === "result").map(({ by, model }) => ({ by, model }))).toEqual([
		{ by: "runner", model: "gpt-6.1-sol" },
	]);
	expect(await recoverAccepted(h.app)).toBe(0);
});

test("schema 32 evidence upgrades with an unspecified model and keeps working", async () => {
	h = await harness();
	const agent = h.actor("runner", "agent", ["read", "produce"]);
	await h.call("report", ciReport({ commit: "legacy638", n: 1 }), agent);
	await dropResetIndexes(h.app.db);
	await dropReceiptSchema(h.app.db);
	await h.app.db.exec(
		"DROP TABLE assertion_seen; DROP TABLE assertion_spreads; DROP TABLE assertion_roots; DROP TABLE assertion_index; DROP INDEX results_assertion_rebuild; DROP INDEX flips_first_try; DROP INDEX flips_second_try; ALTER TABLE flips DROP COLUMN first_try; ALTER TABLE flips DROP COLUMN second_try; DROP TABLE result_tries; DROP TABLE handoffs; DROP INDEX change_ends_landing; ALTER TABLE change_ends DROP COLUMN landing_branch; ALTER TABLE change_ends DROP COLUMN landing_repo; ALTER TABLE change_ends DROP COLUMN landing_commit; DROP INDEX projects_identity; ALTER TABLE projects DROP COLUMN identity; ALTER TABLE results RENAME COLUMN trail TO steps; ALTER TABLE results DROP COLUMN model; ALTER TABLE batches DROP COLUMN model; UPDATE meta SET value = '32' WHERE key = 'schema_version'",
	);
	const { migrate, SCHEMA_VERSION } = await import("../src/server/kernel/migrate.ts");
	expect(await migrate(h.app.db, ":memory:")).toEqual({ from: 32, to: SCHEMA_VERSION, backup: null });
	const [detail] = await h.call<{ last: { by: string; model: string | null }[] }[]>("get", { refs: ["T-1"] });
	expect(detail?.last.map(({ by, model }) => ({ by, model }))).toEqual([{ by: "runner", model: null }]);
	await h.call("report", { ...ciReport({ commit: "legacy638", n: 1, attempt: 2 }), model: "m".repeat(120) }, agent);
	const [latest] = await h.call<{ last: { model: string | null }[] }[]>("get", { refs: ["T-1"] });
	expect(latest?.last[0]?.model).toBe("m".repeat(120));
});

test("archive replay preserves an agent result's model", async () => {
	h = await harness();
	const agent = h.actor("runner", "agent", ["read", "produce"]);
	await h.call("report", { ...ciReport({ commit: "archive638", n: 1 }), model: "claude-opus-5-5" }, agent);
	const { exportArchive, importArchive, linesOf } = await import("../src/server/transfer/transfer.ts");
	const { Db } = await import("../src/server/kernel/db.ts");
	const { migrate } = await import("../src/server/kernel/migrate.ts");
	const chunks: string[] = [];
	exportArchive(h.app.db, (chunk) => chunks.push(chunk));
	const copy = new Db(":memory:");
	try {
		await migrate(copy, ":memory:");
		await importArchive(copy, linesOf(chunks.join("")));
		expect(copy.raw.query("SELECT model, method FROM results").all()).toEqual([
			{ model: "claude-opus-5-5", method: "agent" },
		]);
	} finally {
		copy.close();
	}
});
