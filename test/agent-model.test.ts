import { afterEach, describe, expect, test } from "bun:test";
import type { ReportReceipt, WorkReply } from "../src/core/ops.ts";
import { sql } from "../src/server/kernel/db.ts";

import { ciReport, type Harness, harness } from "./helpers.ts";

let h: Harness;
afterEach(async () => await h?.close());

describe("the model behind an agent's results", () => {
	test("an agent's whole batch keeps its trimmed model beside every producer", async () => {
		h = await harness();
		const agent = await h.actor("runner", "agent", ["read", "produce"]);
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
		const actor = await h.actor("reporter", kind, ["read", "record"]);
		expect(
			await h.raw("report", { ...ciReport({ commit: "model002", n: 1 }), model: "gpt-6.1-sol" }, actor),
		).toMatchObject({
			ok: false,
			error: { code: "invalid", message: "Only an agent's report can name a model." },
		});
		expect(
			await h.app.database.read(
				async (db) => await db.get(sql<readonly [], { n: number }>("SELECT count(*) AS n FROM batches")),
			),
		).toEqual({ n: 0 });
		expect((await h.call<ReportReceipt>("report", ciReport({ commit: "model002", n: 1 }), actor)).counts.total).toBe(1);
	});

	test.each(["", "  ", "m".repeat(121)])("an invalid model is refused: %j", async (model) => {
		h = await harness();
		const agent = await h.actor("runner", "agent", ["read", "produce"]);
		expect(await h.raw("report", { ...ciReport({ commit: "model003", n: 1 }), model }, agent)).toMatchObject({
			ok: false,
			error: { code: "invalid" },
		});
	});

	test("an agent may omit its model without inventing one", async () => {
		h = await harness();
		const agent = await h.actor("runner", "agent", ["read", "produce"]);
		await h.call("report", ciReport({ commit: "model004", n: 1 }), agent);
		const [detail] = await h.call<{ last: { by: string; model: string | null }[] }[]>("get", { refs: ["T-1"] });
		expect(detail?.last.map(({ by, model }) => ({ by, model }))).toEqual([{ by: "runner", model: null }]);
	});
});

test("accepted reports recover the model, and planned slots and case activity expose it", async () => {
	h = await harness();
	const agent = await h.actor("runner", "agent", ["read", "produce"]);
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
	await h.app.database.write(
		async (db) =>
			await db.transaction(async () => {
				const project = await findProject(db, "scratch");
				if (!project) throw new Error("missing project");
				const ctx = makeCtx(h.app, db, project, agent, true);
				await acceptReport(ctx, { run, model: "gpt-6.1-sol", results: [{ test: { case: "C-1" }, outcome: "pass" }] });
				await stampSeq(ctx);
			}),
	);
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

test("archive replay preserves an agent result's model", async () => {
	h = await harness();
	const agent = await h.actor("runner", "agent", ["read", "produce"]);
	await h.call("report", { ...ciReport({ commit: "archive638", n: 1 }), model: "claude-opus-5-5" }, agent);
	const { exportArchive, importArchive, linesOf } = await import("../src/server/transfer/transfer.ts");
	const { Database } = await import("../src/server/kernel/db.ts");
	const { testDatabase } = await import("./db.ts");

	const chunks: string[] = [];
	await h.app.database.write(
		async (db) => await db.transaction(async () => await exportArchive(db, (chunk) => chunks.push(chunk))),
	);
	const copyFixture = await testDatabase();
	const copy = await Database.open({ url: copyFixture.url });
	try {
		await copy.write(async (db) => await importArchive(db, linesOf(chunks.join(""))));
		expect(
			await copy.read(
				async (db) => await db.all(sql<readonly [], Record<string, unknown>>("SELECT model, method FROM results")),
			),
		).toEqual([{ model: "claude-opus-5-5", method: "agent" }]);
	} finally {
		await copy.close();
		await copyFixture.close();
	}
});
