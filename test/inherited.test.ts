import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { budget } from "../scripts/budget.ts";
import { start } from "../src/app/start.ts";
import { Client } from "../src/cli/client.ts";
import type { Policy } from "../src/core/kinds.ts";
import type { DecideReply, GateStatus, InboxReply, ReportReceipt } from "../src/core/ops.ts";
import { defaultConfig } from "../src/server/kernel/app.ts";
import { findProject, makeCtx, stampSeq } from "../src/server/kernel/ctx.ts";
import { sql, type WriteDb } from "../src/server/kernel/db.ts";
import { recoverAccepted, sweep } from "../src/server/ops/jobs.ts";
import { acceptReport } from "../src/server/ops/writes.ts";
import { inheritedEvidenceOf, mustRun } from "../src/server/runs/runs.ts";
import { testDatabase } from "./db.ts";
import { ciReport, type Harness, harness } from "./helpers.ts";

let h: Harness;
beforeEach(async () => {
	h = await harness();
});
afterEach(async () => await h?.close());
const gate = async (commit: string) => await h.call<GateStatus>("gate", { commit });
const base = async (fail: Record<number, string> = { 0: "same cause" }, attempt = 1) =>
	await h.call("report", ciReport({ commit: "base0001", n: 2, fail, attempt }));
const change = async (fail: Record<number, string>, commit = "change01", attempt = 1) =>
	await h.call("report", ciReport({ commit, branch: "feature", pr: 69, base: "base0001", n: 2, fail, attempt }));

test("inherited support reads sibling comparison metadata in batches", async () => {
	const fail = Object.fromEntries(Array.from({ length: 25 }, (_, index) => [index, "same cause"]));
	await h.call("report", ciReport({ commit: "base0001", n: 25, fail }));
	await h.call("report", ciReport({ commit: "change01", branch: "feature", pr: 69, base: "base0001", n: 25, fail }));
	const project = await h.app.database.read((db) => findProject(db, "scratch"));
	if (!project) throw new Error("no project");
	const run = await h.app.database.read((db) => mustRun(db, project.id, "R-2"));
	h.app.database.resetStatementCount();
	const evidence = await h.app.database.read((db) => inheritedEvidenceOf(db, run));
	expect(evidence).toHaveLength(25);
	expect(evidence.every((row) => row.base.length === 1)).toBe(true);
	expect(h.app.database.statementCount).toBeLessThanOrEqual(20);
});

test("policy adoption batches changes whose base has never been reported, then inherits later base proof", async () => {
	await h.close();
	h = await harness({ preset: "standard" });
	for (let pr = 1; pr <= 30; pr++)
		await h.call(
			"report",
			ciReport({
				commit: `future-change-${pr}`,
				pr,
				branch: `feature-${pr}`,
				base: "future-base",
				n: 1,
				fail: { 0: "same cause" },
			}),
		);
	await h.call("propose", { edits: [{ op: "policy", preset: "loose" }] });
	const adoption = (await h.call<InboxReply>("inbox", { kind: "adopt" })).items[0];
	if (!adoption) throw new Error("missing policy adoption");
	h.app.database.resetStatementCount();
	expect(
		await h.call("decide", { q: adoption.q, onEvidence: adoption.evidenceHash, answer: { is: "accept" } }),
	).toMatchObject([{ status: "decided" }]);
	expect(
		h.app.database.statementCount,
		"missing bases cannot require one reconciliation per historical run",
	).toBeLessThan(120);
	for (let pr = 1; pr <= 30; pr++)
		expect(await gate(`future-change-${pr}`)).toMatchObject({
			verdict: "blocked",
			tally: { unexplained: 1, excused: 0 },
		});
	await h.call("report", ciReport({ commit: "future-base", n: 1, fail: { 0: "same cause" } }));
	for (let pr = 1; pr <= 30; pr++)
		expect(await gate(`future-change-${pr}`)).toMatchObject({
			verdict: "passed",
			tally: { unexplained: 0, excused: 1 },
		});
});

for (const answer of ["inherited", "mistaken"]) {
	for (const existing of [false, true]) {
		test(`a rule's ${answer} answer cannot excuse a ${existing ? "pre-existing" : "new"} trunk failure`, async () => {
			if (existing) await base();
			const policy = await h.call<Policy & { version: number }>("admin", { do: "policy.show", project: "scratch" });
			const clauses = policy.clauses.map((clause) =>
				clause.kind === "failure" ? { ...clause, ask: { ...clause.ask, who: "rule" }, answer: { is: answer } } : clause,
			);
			await h.call("propose", { edits: [{ op: "policy", base: policy.version, clauses }] });
			const adoption = (await h.call<InboxReply>("inbox", { kind: "adopt" })).items[0];
			if (!adoption) throw new Error("missing policy adoption");
			expect(
				await h.call("decide", { q: adoption.q, onEvidence: adoption.evidenceHash, answer: { is: "accept" } }),
			).toMatchObject([{ status: "decided" }]);
			const receipt = await h.call<ReportReceipt>(
				"report",
				ciReport({ commit: "base0001", branch: "main", n: 1, fail: { 0: "same cause" }, attempt: existing ? 2 : 1 }),
			);
			const blocked = { verdict: "blocked", tally: { excused: 0, unexplained: 1 } };
			expect(receipt.gate).toMatchObject(blocked);
			expect(await gate("base0001")).toMatchObject(blocked);
			const questions = (await h.call<InboxReply>("inbox", { kind: "failure" })).items;
			expect(questions).toHaveLength(1);
			const question = questions[0];
			if (!question) throw new Error("missing trunk failure question");
			expect(question).toMatchObject({ state: "open", needs: "one member", decision: null });
			expect(question.answers).toEqual(["defect", "test", "expected", "flaky", "infra"]);
			expect(
				await h.call("decide", { q: question.q, onEvidence: question.evidenceHash, answer: { is: answer } }),
			).toMatchObject([{ status: "invalid" }]);
			expect(
				await h.call("decide", { q: question.q, onEvidence: question.evidenceHash, answer: { is: "defect" } }),
			).toMatchObject([{ status: "decided" }]);
			expect(await gate("base0001")).toMatchObject({
				verdict: "failed",
				tally: { excused: 0, unexplained: 0, attributed: 1 },
			});
		});
	}
}

for (const preset of ["loose", "standard"]) {
	for (const declarationFirst of [true, false]) {
		test(`${preset} keeps inherited failures visible with a declaration ${declarationFirst ? "before" : "after"} results`, async () => {
			await h.close();
			h = await harness({ preset });
			await h.call("propose", { edits: [{ op: "policy", emptyReports: "nothing-required" }] });
			const adoption = (await h.call<InboxReply>("inbox", { kind: "adopt" })).items[0];
			if (!adoption) throw new Error("missing policy adoption");
			await h.call("decide", { q: adoption.q, onEvidence: adoption.evidenceHash, answer: { is: "accept" } });
			await base();
			const ordinary = ciReport({
				commit: "change01",
				pr: 69,
				base: "base0001",
				n: 2,
				fail: { 0: "same cause", 1: "new cause" },
			});
			const declaration = { ...ordinary, job: "path-filter", results: [], nothingRequired: true };
			if (declarationFirst) {
				await h.call("report", declaration, await h.actor("declarer", "ci", ["read", "record"]));
				expect(await gate("change01")).toMatchObject({ verdict: "passed", tally: { excused: 0, unexplained: 0 } });
			}
			await h.call("report", ordinary);
			if (!declarationFirst) await h.call("report", declaration, await h.actor("declarer", "ci", ["read", "record"]));
			expect(await gate("change01")).toMatchObject({
				verdict: "blocked",
				stale: false,
				tally: preset === "loose" ? { excused: 1, unexplained: 1 } : { excused: 0, unexplained: 2 },
			});
			expect(
				await h.app.database.read(
					async (db) =>
						await db.get(
							sql<readonly [], { n: number }>(
								"SELECT count(*) AS n FROM results WHERE batch IN (SELECT id FROM batches WHERE nothing_required = 1)",
							),
						),
				),
			).toEqual({ n: 0 });
			await base({}, 2);
			expect(await gate("change01")).toMatchObject({
				verdict: "blocked",
				stale: false,
				tally: { excused: 0, unexplained: 2 },
			});
		});
	}
}

test("a base declaration cannot supply inherited failure evidence", async () => {
	const input = ciReport({ commit: "base0001", n: 0 });
	await h.call("report", { ...input, nothingRequired: true }, await h.actor("declarer", "ci", ["record"]));
	await change({ 0: "same cause" });
	expect(await gate("change01")).toMatchObject({ verdict: "blocked", tally: { excused: 0, unexplained: 1 } });
});

test("loose accepts more than fifty distinct inherited causes", async () => {
	const fail = Object.fromEntries(Array.from({ length: 52 }, (_, i) => [i, `distinct cause ${i}`]));
	await h.call("report", ciReport({ commit: "base0001", n: 52, fail }));
	await h.call("report", ciReport({ commit: "change01", pr: 69, base: "base0001", n: 52, fail }));
	expect(await gate("change01")).toMatchObject({ verdict: "passed", tally: { excused: 52, unexplained: 0 } });
});

for (const preset of ["standard", "loose"]) {
	test(`${preset} reads base evidence in proportion to 600 distinct causes`, async () => {
		await h.close();
		h = await harness({ preset });
		const fail = Object.fromEntries(Array.from({ length: 600 }, (_, i) => [i, `distinct cause ${i}`]));
		await h.call("report", ciReport({ commit: "base0001", n: 600, fail }));
		const run = (await gate("base0001")).run;
		if (!run) throw new Error("missing base run");
		const baseRun = Number(run.slice(2));
		let reads = 0;
		const all = (await h.app.database.write((db) => Object.getPrototypeOf(db) as WriteDb)).all;
		const spy = spyOn(
			await h.app.database.write((db) => Object.getPrototypeOf(db) as WriteDb),
			"all",
		).mockImplementation(async function (this: WriteDb, statement, ...params) {
			const rows = await Reflect.apply(all, this, [statement, ...params]);
			if (statement.text.includes("FROM run_tests") && params[0] && "run" in params[0] && params[0].run === baseRun)
				reads += rows.length;
			return rows;
		});
		try {
			await h.call("report", ciReport({ commit: "change01", pr: 69, base: "base0001", n: 600, fail }));
			expect((await gate("change01")).tally).toMatchObject(
				preset === "loose" ? { excused: 600, unexplained: 0 } : { excused: 0, unexplained: 600 },
			);
			budget(
				`evidence reads for 600 inherited failures (${preset})`,
				reads,
				600 * (preset === "loose" ? 6 : 2),
				"reads",
			);
		} finally {
			spy.mockRestore();
		}
	}, 120_000);
}

test("a report's inherited answer reads only its affected runs, regardless of sibling failures", async () => {
	await base();
	for (let pr = 1; pr <= 20; pr++) {
		await h.call(
			"report",
			ciReport({
				commit: `sibling${String(pr).padStart(4, "0")}`,
				pr,
				base: "base0001",
				n: 2,
				fail: { 0: "same cause" },
			}),
		);
	}
	let reads = 0;
	const all = (await h.app.database.write((db) => Object.getPrototypeOf(db) as WriteDb)).all;
	const spy = spyOn(await h.app.database.write((db) => Object.getPrototypeOf(db) as WriteDb), "all").mockImplementation(
		async function (this: WriteDb, statement, ...params) {
			const rows = await Reflect.apply(all, this, [statement, ...params]);
			if (statement.text.startsWith("SELECT test, result, target, outcome, signature FROM run_tests"))
				reads += rows.length;
			return rows;
		},
	);
	try {
		const receipt = await h.call<ReportReceipt>(
			"report",
			ciReport({ commit: "sibling0001", pr: 1, base: "base0001", n: 2, fail: { 0: "same cause" }, attempt: 2 }),
		);
		expect(receipt).toMatchObject({
			fresh: true,
			counts: { pass: 1, fail: 1 },
			gate: { verdict: "passed", tally: { excused: 1, unexplained: 0 } },
		});
		expect((await h.call<InboxReply>("inbox", { on: "pr:2", kind: "failure" })).items).toEqual([]);
		expect(await gate("sibling0002")).toMatchObject({ verdict: "passed", tally: { excused: 1, unexplained: 0 } });
		budget("evidence reads for a sibling excuse", reads, 12, "reads");
	} finally {
		spy.mockRestore();
	}
});

for (const dimension of ["env", "job"] as const) {
	test(`inheritance matches the base's ${dimension} lane`, async () => {
		const report = (commit: string, fail: boolean, otherLane: boolean) => {
			const input = ciReport({ commit, n: 1, fail: fail ? { 0: "same cause" } : {}, job: "e2e" });
			return {
				...input,
				target: {
					...input.target,
					env: otherLane && dimension === "env" ? "linux" : "mac",
					...(commit === "change01" ? { pr: 69, base: "base0001" } : {}),
				},
				job: otherLane && dimension === "job" ? "unit" : "e2e",
			};
		};
		await h.call("report", report("base0001", true, true));
		await h.call("report", report("base0001", false, false));
		await h.call("report", report("change01", true, false));
		expect((await gate("change01")).tally).toMatchObject({ excused: 0, unexplained: 1 });
	});
}

test("after loose changes to standard one question owns the failure", async () => {
	await base();
	await change({ 0: "same cause" });
	await h.call("propose", { edits: [{ op: "policy", preset: "standard" }] });
	const adoption = (await h.call<InboxReply>("inbox", { kind: "adopt" })).items[0];
	if (!adoption) throw new Error("missing policy adoption");
	await h.call("decide", { q: adoption.q, onEvidence: adoption.evidenceHash, answer: { is: "accept" } });
	await base({ 0: "same cause" }, 2);
	const questions = (await h.call<InboxReply>("inbox", { on: "pr:69", kind: "failure" })).items;
	expect(questions).toHaveLength(1);
	const question = questions[0];
	if (!question) throw new Error("missing failure question");
	await h.call("decide", { q: question.q, onEvidence: question.evidenceHash, answer: { is: "flaky" } });
	expect((await gate("change01")).tally).toMatchObject({ excused: 1, unexplained: 0 });
	expect((await h.call<InboxReply>("inbox", { on: "pr:69", kind: "failure" })).items).toHaveLength(0);
});

for (const unrelatedReport of [false, true]) {
	test(`standard retires inherited standing ${unrelatedReport ? "after an unrelated passing report" : "on adoption alone"}`, async () => {
		await base();
		await change({ 0: "same cause" });
		expect(await gate("change01")).toMatchObject({ verdict: "passed", tally: { excused: 1, unexplained: 0 } });
		await h.call("propose", { edits: [{ op: "policy", preset: "standard" }] });
		const adoption = (await h.call<InboxReply>("inbox", { kind: "adopt" })).items[0];
		if (!adoption) throw new Error("missing policy adoption");
		await h.call("decide", { q: adoption.q, onEvidence: adoption.evidenceHash, answer: { is: "accept" } });
		if (unrelatedReport) {
			const input = ciReport({ commit: "change01", branch: "feature", pr: 69, base: "base0001", n: 2 });
			await h.call("report", { ...input, results: input.results.slice(1) });
		}
		expect(await gate("change01")).toMatchObject({ verdict: "blocked", tally: { excused: 0, unexplained: 1 } });
		const questions = (await h.call<InboxReply>("inbox", { on: "pr:69", kind: "failure" })).items;
		expect(questions).toHaveLength(1);
		expect(questions[0]).toMatchObject({ state: "open", title: "same cause" });
		expect(questions[0]?.evidence).not.toHaveProperty("inherited");
	});
}

for (const initial of ["loose", "standard"] as const) {
	test(`loose restores inherited standing on adoption after starting ${initial}`, async () => {
		if (initial === "standard") {
			await h.close();
			h = await harness({ preset: "standard" });
		}
		await base();
		await change({ 0: "same cause" });
		const use = async (preset: "loose" | "standard") => {
			await h.call("propose", { edits: [{ op: "policy", preset }] });
			const adoption = (await h.call<InboxReply>("inbox", { kind: "adopt" })).items[0];
			if (!adoption) throw new Error("missing policy adoption");
			expect(
				await h.call("decide", { q: adoption.q, onEvidence: adoption.evidenceHash, answer: { is: "accept" } }),
			).toMatchObject([{ status: "decided" }]);
		};
		if (initial === "loose") {
			expect(await gate("change01")).toMatchObject({ verdict: "passed", tally: { excused: 1, unexplained: 0 } });
			await use("standard");
		}
		expect(await gate("change01")).toMatchObject({ verdict: "blocked", tally: { excused: 0, unexplained: 1 } });
		const cause = (await h.call<InboxReply>("inbox", { kind: "failure", on: "pr:69" })).items;
		expect(cause).toMatchObject([{ state: "open", title: "same cause" }]);
		await use("loose");
		expect(await gate("change01")).toMatchObject({ verdict: "passed", tally: { excused: 1, unexplained: 0 } });
		expect((await h.call<InboxReply>("inbox", { kind: "failure", on: "pr:69" })).items).toEqual([]);
		expect(await h.call("get", { refs: [cause[0]?.q] })).toMatchObject([{ state: "dissolved" }]);
		const decided = (await h.call<InboxReply>("inbox", { state: "decided", kind: "failure", on: "pr:69" })).items;
		expect(decided).toHaveLength(1);
		expect(decided[0]).toMatchObject({
			decision: { answer: { is: "inherited" }, by: ["policy"], rule: "failure-inherited" },
		});
		expect(await gate("base0001")).toMatchObject({ verdict: "blocked", tally: { excused: 0, unexplained: 1 } });
	});
}

test("loose keeps a cause question open while one of its failures still needs an answer", async () => {
	await h.close();
	h = await harness({ preset: "standard" });
	await base();
	await change({ 0: "same cause", 1: "same cause" });
	const cause = (await h.call<InboxReply>("inbox", { kind: "failure", on: "pr:69" })).items[0];
	if (!cause) throw new Error("missing cause question");
	await h.call("propose", { edits: [{ op: "policy", preset: "loose" }] });
	const adoption = (await h.call<InboxReply>("inbox", { kind: "adopt" })).items[0];
	if (!adoption) throw new Error("missing policy adoption");
	expect(
		await h.call("decide", { q: adoption.q, onEvidence: adoption.evidenceHash, answer: { is: "accept" } }),
	).toMatchObject([{ status: "decided" }]);
	expect(await gate("change01")).toMatchObject({ verdict: "blocked", tally: { excused: 1, unexplained: 1 } });
	expect((await h.call<InboxReply>("inbox", { kind: "failure", on: "pr:69" })).items).toMatchObject([
		{ q: cause.q, state: "open", title: "same cause" },
	]);
});

for (const answer of ["flaky", "defect", "inherited"] as const) {
	test(`a direct ${answer} replacement of inherited standing uses manual failure holds`, async () => {
		await base();
		await change({ 0: "same cause" });
		const automatic = (await h.call<InboxReply>("inbox", { state: "decided", kind: "failure", on: "pr:69" })).items[0];
		if (!automatic) throw new Error("missing rule decision");
		const [replacement] = await h.call<DecideReply[]>("decide", {
			q: automatic.q,
			onEvidence: automatic.evidenceHash,
			answer: { is: answer },
		});
		if (!replacement) throw new Error("missing replacement reply");
		expect(replacement).toMatchObject({ q: automatic.q, status: "decided" });
		const expected = {
			verdict: answer === "defect" ? "failed" : "passed",
			tally: { attributed: answer === "defect" ? 1 : 0, excused: answer === "defect" ? 0 : 1, unexplained: 0 },
		};
		expect(await gate("change01")).toMatchObject(expected);
		const decided = (await h.call<InboxReply>("inbox", { state: "decided", on: "pr:69", kind: "failure" })).items;
		expect(decided).toHaveLength(1);
		expect(decided[0]).toMatchObject({ q: replacement.effects?.question, decision: { answer: { is: answer } } });
		expect(decided[0]?.evidence).not.toHaveProperty("inherited");
		if (answer === "flaky") {
			h.advance(13 * 86_400_000);
			expect(await sweep(h.app, h.owner.id)).toBe(0);
			expect(await gate("change01")).toMatchObject(expected);
			h.advance(2 * 86_400_000);
			expect(await sweep(h.app, h.owner.id)).toBe(1);
			expect(await gate("change01")).toMatchObject({ verdict: "blocked", tally: { excused: 0, unexplained: 1 } });
			expect((await h.call<InboxReply>("inbox", { on: "pr:69", kind: "failure" })).items).toHaveLength(1);
			return;
		}
		await base({ 0: "same cause" }, 2);
		expect(await gate("change01")).toMatchObject(expected);
		expect((await h.call<InboxReply>("inbox", { on: "pr:69", kind: "failure" })).items).toHaveLength(0);
		expect(
			await h.call("decide", { undo: replacement.effects?.question, ifDecision: replacement.decision }),
		).toMatchObject([{ status: "reopened" }]);
		expect(await gate("change01")).toMatchObject({ verdict: "blocked", tally: { excused: 0, unexplained: 1 } });
		expect((await h.call<InboxReply>("inbox", { on: "pr:69", kind: "failure" })).items).toHaveLength(1);
	});
}

for (const answer of ["defect", "flaky"] as const) {
	test(`a direct ${answer} replacement overrules an automatic ordinary cause answer`, async () => {
		const policy = await h.call<Policy & { version: number }>("admin", { do: "policy.show", project: "scratch" });
		await h.call("propose", {
			edits: [
				{
					op: "policy",
					base: policy.version,
					clauses: policy.clauses.map((clause) =>
						clause.id === "failure-change"
							? { ...clause, ask: { ...clause.ask, who: "rule" }, answer: { is: "flaky" } }
							: clause,
					),
				},
			],
		});
		const adoption = (await h.call<InboxReply>("inbox", { kind: "adopt" })).items[0];
		if (!adoption) throw new Error("missing policy adoption");
		await h.call("decide", { q: adoption.q, onEvidence: adoption.evidenceHash, answer: { is: "accept" } });
		await base();
		await change({ 0: "same cause" });
		const automatic = (await h.call<InboxReply>("inbox", { state: "decided", kind: "failure", on: "pr:69" })).items[0];
		if (!automatic) throw new Error("missing inherited answer");
		const [replacement] = await h.call<DecideReply[]>("decide", {
			q: automatic.q,
			onEvidence: automatic.evidenceHash,
			answer: { is: answer },
		});
		expect(replacement).toMatchObject({ q: automatic.q, status: "decided" });
		const decided = (await h.call<InboxReply>("inbox", { state: "decided", kind: "failure", on: "pr:69" })).items;
		expect(decided).toHaveLength(1);
		expect(decided[0]).toMatchObject({
			q: replacement?.effects?.question,
			decision: { id: replacement?.decision, answer: { is: answer }, by: ["robin"], rule: null },
		});
		expect(decided[0]?.evidence).not.toHaveProperty("inherited");
		const expected = {
			verdict: answer === "defect" ? "failed" : "passed",
			tally: { attributed: answer === "defect" ? 1 : 0, excused: answer === "defect" ? 0 : 1, unexplained: 0 },
		};
		expect(await gate("change01")).toMatchObject(expected);
		await base({ 0: "same cause" }, 2);
		expect(await gate("change01")).toMatchObject(expected);
		expect(
			(await h.call<InboxReply>("inbox", { state: "decided", kind: "failure", on: "pr:69" })).items[0],
		).toMatchObject({
			decision: { id: replacement?.decision, answer: { is: answer }, by: ["robin"] },
		});
		if (answer === "flaky") {
			h.advance(13 * 86_400_000);
			expect(await sweep(h.app, h.owner.id)).toBe(0);
			h.advance(2 * 86_400_000);
			expect(await sweep(h.app, h.owner.id)).toBe(1);
		}
	});
}

test("an agent's advice-only inherited replacement is refused without claiming lost advice", async () => {
	const policy = await h.call<Policy & { version: number }>("admin", { do: "policy.show", project: "scratch" });
	await h.call("propose", {
		edits: [
			{
				op: "policy",
				base: policy.version,
				clauses: policy.clauses.map((clause) =>
					clause.id === "failure-inherited" ? { ...clause, ask: { ...clause.ask, agents: "answer" } } : clause,
				),
			},
		],
	});
	const adoption = (await h.call<InboxReply>("inbox", { kind: "adopt" })).items[0];
	if (!adoption) throw new Error("missing policy adoption");
	await h.call("decide", { q: adoption.q, onEvidence: adoption.evidenceHash, answer: { is: "accept" } });
	await base();
	await change({ 0: "same cause" });
	const agent = await h.actor("reviewer", "agent", ["read", "produce", "answer"]);
	const automatic = (await h.call<InboxReply>("inbox", { state: "decided", kind: "failure", on: "pr:69" }, agent))
		.items[0];
	if (!automatic) throw new Error("missing inherited answer");
	expect(
		await h.call(
			"decide",
			{
				q: automatic.q,
				onEvidence: automatic.evidenceHash,
				answer: { is: "defect" },
				reason: "Needs a fix",
			},
			agent,
		),
	).toMatchObject([
		{
			q: automatic.q,
			status: "forbidden",
			needs: "one member who is not an agent",
			decision: null,
		},
	]);
	expect(await h.call<InboxReply["items"]>("get", { refs: [automatic.q] })).toMatchObject([
		{
			q: automatic.q,
			state: "decided",
			decision: { id: automatic.decision?.id, answer: { is: "inherited" } },
			advice: [],
		},
	]);
	expect(await gate("change01")).toMatchObject({
		verdict: "passed",
		tally: { excused: 1, attributed: 0, unexplained: 0 },
	});
});

test("Settled keeps an ended cause answer but excludes the inherited question handed off to it", async () => {
	await base();
	await change({ 0: "same cause" });
	const automatic = (await h.call<InboxReply>("inbox", { state: "decided", kind: "failure", on: "pr:69" })).items[0];
	if (!automatic) throw new Error("missing rule decision");
	const [replacement] = await h.call<DecideReply[]>("decide", {
		q: automatic.q,
		onEvidence: automatic.evidenceHash,
		answer: { is: "test" },
	});
	if (typeof replacement?.effects?.question !== "string") throw new Error("missing cause question");
	const causeQuestion = replacement.effects.question;
	await change({}, "change02");
	expect(await gate("change02")).toMatchObject({ verdict: "passed", tally: { pass: 2, unexplained: 0 } });
	expect(await h.call("get", { refs: [automatic.q, causeQuestion] })).toMatchObject([
		{ q: automatic.q, state: "dissolved", decision: { answer: { is: "withdrawn" } } },
		{
			q: causeQuestion,
			state: "dissolved",
			decision: { answer: { is: "outdated" }, rule: "passed", supersedes: { answer: { is: "test" }, by: ["robin"] } },
		},
	]);
	await h.call(
		"report",
		ciReport({ commit: "other001", branch: "other", pr: 70, base: "base0001", n: 2, fail: { 0: "same cause" } }),
	);
	const reconciled = (await h.call<InboxReply>("inbox", { state: "decided", kind: "failure", on: "pr:70" })).items[0];
	if (!reconciled) throw new Error("missing second inherited question");
	await base({}, 2);
	const [retired] = await h.call<InboxReply["items"]>("get", { refs: [reconciled.q] });
	expect(retired).toMatchObject({ state: "dissolved", decision: { answer: { is: "outdated" }, rule: "hold-ended" } });
	expect(retired?.decision).not.toHaveProperty("supersedes");
	for (const filters of [{}, { kind: "failure" }, { on: "pr:69" }, { on: "pr:69", kind: "failure" }]) {
		const settled = (await h.call<InboxReply>("inbox", { state: "decided", ...filters })).items;
		expect(settled.filter((q) => q.kind === "failure").map((q) => q.q)).toEqual([causeQuestion]);
	}
});

for (const refusal of ["reason", "admin"] as const) {
	test(`a rejected direct replacement keeps the inherited answer when the cause requires ${refusal}`, async () => {
		const policy = await h.call<Policy & { version: number }>("admin", { do: "policy.show", project: "scratch" });
		await h.call("propose", {
			edits: [
				{
					op: "policy",
					base: policy.version,
					clauses: policy.clauses.map((clause) =>
						clause.kind === "failure" && clause.ask.who !== "rule"
							? {
									...clause,
									ask: {
										...clause.ask,
										...(refusal === "reason" ? { reason: "required" } : { who: "admin" }),
									},
								}
							: clause,
					),
				},
			],
		});
		const adoption = (await h.call<InboxReply>("inbox", { kind: "adopt" })).items[0];
		if (!adoption) throw new Error("missing policy adoption");
		await h.call("decide", { q: adoption.q, onEvidence: adoption.evidenceHash, answer: { is: "accept" } });
		await base();
		await change({ 0: "same cause" });
		const automatic = (await h.call<InboxReply>("inbox", { state: "decided", kind: "failure", on: "pr:69" })).items[0];
		if (!automatic) throw new Error("missing rule decision");
		const input = { q: automatic.q, onEvidence: automatic.evidenceHash, answer: { is: "defect" } };
		const member = await h.actor("member", "human", ["read", "produce", "answer"]);
		const caller = refusal === "reason" ? h.owner : member;
		expect(await h.call("decide", input, caller)).toMatchObject([
			{
				q: automatic.q,
				status: refusal === "reason" ? "invalid" : "forbidden",
				needs: refusal === "reason" ? "a reason" : "an admin",
			},
		]);
		expect(await gate("change01")).toMatchObject({ verdict: "passed", tally: { excused: 1, unexplained: 0 } });
		expect((await h.call<InboxReply>("inbox", { state: "decided", kind: "failure", on: "pr:69" })).items).toMatchObject(
			[{ q: automatic.q, decision: { answer: { is: "inherited" } } }],
		);
		expect(await h.call("decide", { ...input, reason: "The product needs a fix" })).toMatchObject([
			{ status: "decided" },
		]);
		expect(await gate("change01")).toMatchObject({
			verdict: "failed",
			tally: { attributed: 1, excused: 0, unexplained: 0 },
		});
	});
}

for (const refusal of ["reason", "admin"] as const) {
	test(`a direct replacement preserves the inherited withdrawal refusal for ${refusal}`, async () => {
		const policy = await h.call<Policy & { version: number }>("admin", { do: "policy.show", project: "scratch" });
		await h.call("propose", {
			edits: [
				{
					op: "policy",
					base: policy.version,
					clauses: [
						{
							id: "withdraw-inherited",
							kind: "failure",
							when: ["answer:inherited"],
							ask: {
								who: refusal === "admin" ? "admin" : "member",
								agents: "none",
								notProducer: false,
								reason: refusal === "reason" ? "required" : "optional",
							},
							blocks: "change",
						},
						...policy.clauses,
					],
				},
			],
		});
		const adoption = (await h.call<InboxReply>("inbox", { kind: "adopt" })).items[0];
		if (!adoption) throw new Error("missing policy adoption");
		await h.call("decide", { q: adoption.q, onEvidence: adoption.evidenceHash, answer: { is: "accept" } });
		await base();
		await change({ 0: "same cause" });
		const automatic = (await h.call<InboxReply>("inbox", { state: "decided", kind: "failure", on: "pr:69" })).items[0];
		if (!automatic) throw new Error("missing inherited answer");
		const input = { q: automatic.q, onEvidence: automatic.evidenceHash, answer: { is: "defect" } };
		const member = await h.actor("member", "human", ["read", "produce", "answer"]);
		const caller = refusal === "admin" ? member : h.owner;
		expect(await h.call("decide", input, caller)).toMatchObject([
			{
				q: automatic.q,
				status: refusal === "admin" ? "forbidden" : "invalid",
				needs: refusal === "admin" ? "an admin who is not an agent" : "a reason",
				decision: null,
			},
		]);
		expect(await gate("change01")).toMatchObject({ verdict: "passed", tally: { excused: 1, unexplained: 0 } });
		expect(await h.call<InboxReply["items"]>("get", { refs: [automatic.q] })).toMatchObject([
			{
				q: automatic.q,
				state: "decided",
				decision: { id: automatic.decision?.id, answer: { is: "inherited" } },
			},
		]);
		expect(await h.call("decide", { ...input, reason: "The product needs a fix" })).toMatchObject([
			{ status: "decided" },
		]);
		expect(await gate("change01")).toMatchObject({
			verdict: "failed",
			tally: { excused: 0, attributed: 1, unexplained: 0 },
		});
	});
}

test("loose inherits individual tests, not their shared cause or report", async () => {
	await base();
	await change({ 0: "same cause", 1: "same cause" });
	expect((await gate("change01")).tally).toMatchObject({ excused: 1, unexplained: 1 });
	expect((await gate("change01")).verdict).toBe("blocked");
	const decisions = await h.call<InboxReply>("inbox", { state: "decided", kind: "failure", on: "pr:69" });
	expect(decisions.items.some((q) => q.decision?.answer.is === "inherited")).toBe(true);
});

for (const trunkAnswer of [false, true]) {
	test(`landing ends inherited standing and uses trunk answers: ${trunkAnswer}`, async () => {
		await h.call("propose", { edits: [{ op: "create", outline: "Checkout works" }] });
		const report = (commit: string, pr?: number) => {
			const input = ciReport({
				commit,
				branch: pr ? "feature" : "main",
				...(pr ? { pr, base: "base0001" } : {}),
				n: 1,
				fail: { 0: "same cause" },
			});
			return { ...input, results: input.results.map((row) => ({ ...row, annotation: { case: "C-1", version: 1 } })) };
		};
		await h.call("report", report("base0001"));
		if (trunkAnswer) {
			const question = (await h.call<InboxReply>("inbox", { kind: "failure" })).items[0];
			if (!question) throw new Error("missing trunk failure");
			await h.call("decide", { q: question.q, onEvidence: question.evidenceHash, answer: { is: "defect" } });
		}
		await h.call("report", report("older0069", 69));
		await h.call("report", report("change01", 69));
		const planned = await h.call<{ run: string }>("plan", {
			name: "Release",
			select: {},
			accepts: { commit: "change01" },
		});
		const before = await gate("change01");
		expect(before).toMatchObject({ verdict: "passed", tally: { excused: 1, unexplained: 0 } });
		expect((await h.call<GateStatus>("gate", { run: planned.run })).tally.excused).toBe(1);
		await h.call("change", { change: "pr:69", state: "merged", landing: { commit: "change01", branch: "main" } });
		const expected = {
			verdict: trunkAnswer ? "failed" : "blocked",
			tally: { excused: 0, unexplained: trunkAnswer ? 0 : 1 },
		};
		expect(await gate("change01")).toMatchObject({ run: before.run, ...expected });
		expect(await h.call<GateStatus>("gate", { run: planned.run })).toMatchObject(expected);
		expect(await gate("older0069")).toMatchObject({ verdict: "passed", tally: { excused: 1 } });
		const trunk = (await h.call<InboxReply>("inbox", { kind: "failure" })).items;
		expect(trunkAnswer ? trunk.length : trunk.filter((q) => q.evidence.scope === "line:trunk@acme/web").length).toBe(
			trunkAnswer ? 0 : 1,
		);
		// Renewed base support must not restore the landed commit's old excuse.
		await base({ 0: "same cause" }, 2);
		expect(await gate("change01")).toMatchObject(expected);
	});
}

test("a newer passing base attempt ends inherited standing immediately", async () => {
	await base();
	await change({ 0: "same cause" });
	expect((await gate("change01")).tally.excused).toBe(1);
	await base({}, 2);
	expect(await gate("change01")).toMatchObject({ verdict: "blocked", tally: { excused: 0, unexplained: 1 } });
	expect((await h.call<InboxReply>("inbox", { on: "pr:69" })).items).toHaveLength(1);
});

test("another commit cannot excuse a test the base does not fail", async () => {
	await base();
	await change({ 1: "same cause" }, "change01");
	await change({ 0: "same cause" }, "change02");
	expect((await gate("change02")).tally.excused).toBe(1);
	expect((await gate("change01")).tally).toMatchObject({ excused: 0, unexplained: 1 });
});

test("splitting reports cannot excuse a different test with the same cause", async () => {
	await base();
	const input = ciReport({
		commit: "change01",
		branch: "feature",
		pr: 69,
		base: "base0001",
		n: 2,
		fail: { 0: "same cause", 1: "same cause" },
	});
	await h.call("report", { ...input, results: input.results.slice(0, 1) });
	expect((await gate("change01")).tally.excused).toBe(1);
	await h.call("report", { ...input, results: input.results.slice(1) });
	expect((await gate("change01")).tally).toMatchObject({ excused: 1, unexplained: 1 });
});

test("the 501st failure is considered even after the display sample ends", async () => {
	const fail = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [i, "same cause"]));
	await h.call("report", ciReport({ commit: "base0001", n: 501, fail: { ...fail, 500: "different base cause" } }));
	await h.call("report", ciReport({ commit: "change01", branch: "feature", pr: 69, base: "base0001", n: 501, fail }));
	expect((await gate("change01")).tally).toMatchObject({ excused: 500, unexplained: 1 });
});

test("base evidence arriving later excuses an existing failure and closes its question", async () => {
	await change({ 0: "same cause" });
	expect((await gate("change01")).verdict).toBe("blocked");
	await base();
	expect(await gate("change01")).toMatchObject({ verdict: "passed", tally: { excused: 1 } });
	expect((await h.call<InboxReply>("inbox", { on: "pr:69" })).items).toHaveLength(0);
});

test("retargeting the change recomputes both old and new commits", async () => {
	await base();
	await change({ 0: "same cause" });
	await h.call("report", ciReport({ commit: "base0002", n: 2 }));
	await h.call(
		"report",
		ciReport({ commit: "change02", branch: "feature", pr: 69, base: "base0002", n: 2, fail: { 0: "same cause" } }),
	);
	expect((await gate("change01")).tally).toMatchObject({ excused: 0, unexplained: 1 });
	expect((await gate("change02")).tally).toMatchObject({ excused: 0, unexplained: 1 });
});

test("correcting the base's failure at a lower attempt removes support", async () => {
	const receipt = await h.call<{ results: number[] }>(
		"report",
		ciReport({ commit: "base0001", n: 2, fail: { 0: "same cause" }, attempt: 2 }),
	);
	await change({ 0: "same cause" });
	const correction = ciReport({ commit: "base0001", n: 2 });
	await h.call("report", { ...correction, results: [{ ...correction.results[0], corrects: receipt.results[0] }] });
	expect(await gate("change01")).toMatchObject({ verdict: "blocked", tally: { excused: 0, unexplained: 1 } });
});

test("a new result refreshes the exact support and a later base pass revokes it", async () => {
	await base();
	await change({ 0: "same cause" });
	await change({ 0: "same cause" }, "change01", 2);
	expect((await gate("change01")).tally.excused).toBe(1);
	await base({}, 2);
	expect((await gate("change01")).tally).toMatchObject({ excused: 0, unexplained: 1 });
});

test("withdrawing the automatic answer leaves a person's question open", async () => {
	await base();
	await change({ 0: "same cause" });
	const q = (await h.call<InboxReply>("inbox", { state: "decided", kind: "failure", on: "pr:69" })).items[0];
	if (!q) throw new Error("missing rule decision");
	await h.call("decide", { undo: q.q });
	expect((await gate("change01")).tally).toMatchObject({ excused: 0, unexplained: 1 });
	const questions = (await h.call<InboxReply>("inbox", { on: "pr:69", kind: "failure" })).items;
	expect(questions).toHaveLength(1);
	expect(questions[0]?.evidence).not.toHaveProperty("inherited");
});

for (const answer of ["flaky", "defect"] as const) {
	test(`a person's ${answer} answer after undo survives failing base and change retries`, async () => {
		await base();
		await change({ 0: "same cause" });
		const automatic = (await h.call<InboxReply>("inbox", { state: "decided", kind: "failure", on: "pr:69" })).items[0];
		if (!automatic) throw new Error("missing rule decision");
		await h.call("decide", { undo: automatic.q });
		const questions = (await h.call<InboxReply>("inbox", { on: "pr:69", kind: "failure" })).items;
		const question = questions.find((q) => q.q === automatic.q) ?? questions[0];
		if (!question) throw new Error("missing person's question");
		await h.call("decide", { q: question.q, onEvidence: question.evidenceHash, answer: { is: answer } });
		const expected = {
			verdict: answer === "defect" ? "failed" : "passed",
			tally: { attributed: answer === "defect" ? 1 : 0, excused: answer === "flaky" ? 1 : 0, unexplained: 0 },
		};
		expect(await gate("change01")).toMatchObject(expected);
		await base({ 0: "same cause" }, 2);
		expect(await gate("change01")).toMatchObject(expected);
		expect((await h.call<InboxReply>("inbox", { on: "pr:69", kind: "failure" })).items).toHaveLength(0);
		await change({ 0: "same cause" }, "change01", 2);
		expect(await gate("change01")).toMatchObject(expected);
		expect((await h.call<InboxReply>("inbox", { on: "pr:69", kind: "failure" })).items).toHaveLength(0);
	});
}

test("undo keeps the rule from answering that commit's cause again after retries", async () => {
	await base();
	await change({ 0: "same cause" });
	const automatic = (await h.call<InboxReply>("inbox", { state: "decided", kind: "failure", on: "pr:69" })).items[0];
	if (!automatic) throw new Error("missing rule decision");
	await h.call("decide", { undo: automatic.q });
	await base({ 0: "same cause" }, 2);
	expect(await gate("change01")).toMatchObject({ verdict: "blocked", tally: { excused: 0, unexplained: 1 } });
	await change({ 0: "same cause" }, "change01", 2);
	expect(await gate("change01")).toMatchObject({ verdict: "blocked", tally: { excused: 0, unexplained: 1 } });
	expect((await h.call<InboxReply>("inbox", { on: "pr:69", kind: "failure" })).items).toHaveLength(1);
	await change({ 0: "same cause" }, "change02");
	expect(await gate("change02")).toMatchObject({ verdict: "passed", tally: { excused: 1, unexplained: 0 } });
});

test("an agent's matching failure stays unexplained in a planned run without changing the commit", async () => {
	await h.call("propose", {
		edits: [
			{
				op: "create",
				body: {
					title: "A case",
					methods: ["auto", "agent"],
					steps: [{ id: "s1", action: "Do it", expected: "It works" }],
				},
			},
		],
	});
	const send = async (commit: string, target: Record<string, unknown>, method = "auto", as = h.owner) =>
		await h.call(
			"report",
			{
				target: { commit, repo: "app", ...target },
				job: "check",
				results: [
					{
						test: { key: "same-test" },
						annotation: { case: "C-1", version: 1 },
						method,
						outcome: "fail",
						failure: { message: "same cause" },
					},
				],
			},
			as,
		);
	await send("base0001", { branch: "main" });
	await send("change01", { branch: "feature", pr: 69, base: "base0001" });
	const planned = await h.call<{ run: string }>("plan", {
		name: "agents",
		select: { cases: ["C-1"] },
		accepts: { commit: "change01", repo: "app" },
		require: [
			{ kind: "exercise", id: "review", methods: ["auto", "agent"], basis: "exact", minActors: 1 },
			{ kind: "jobs", id: "wait", jobs: ["other-job"] },
		],
	});
	const before = await gate("change01");
	const agent = await h.actor("reviewer", "agent", ["read", "produce"]);
	await send("change01", { branch: "feature", pr: 69, base: "base0001" }, "agent", agent);
	expect(await gate("change01")).toEqual(before);
	expect(await h.call<GateStatus>("gate", { run: planned.run })).toMatchObject({
		verdict: "blocked",
		tally: { excused: 0, unexplained: 1 },
	});
	await base({}, 2);
});

test("a duplicate report that changes the base cannot return with stale inherited standing", async () => {
	await base();
	await change({ 0: "same cause" });
	await h.call("report", ciReport({ commit: "base0002", n: 2 }));
	await h.call(
		"report",
		ciReport({ commit: "change01", branch: "feature", pr: 69, base: "base0002", n: 2, fail: { 0: "same cause" } }),
	);
	expect(await gate("change01")).toMatchObject({ verdict: "blocked", tally: { excused: 0, unexplained: 1 } });
});

test("accepted base results replayed by startup recovery revoke inheritance", async () => {
	await base();
	await change({ 0: "same cause" });
	await h.app.database.write(
		async (db) =>
			await db.transaction(async () => {
				const project = await findProject(db, "scratch");
				if (!project) throw new Error("missing project");
				const ctx = makeCtx(h.app, db, project, h.owner, true);
				await acceptReport(ctx, ciReport({ commit: "base0001", n: 2, attempt: 2 }));
				await stampSeq(ctx);
			}),
	);
	expect(await recoverAccepted(h.app)).toBe(1);
	expect(await gate("change01")).toMatchObject({ verdict: "blocked", tally: { excused: 0, unexplained: 1 } });
	expect(await recoverAccepted(h.app)).toBe(0);
});

test("a base result judged a mistake stops supporting the change, and undo restores it", async () => {
	await h.call("propose", { edits: [{ op: "create", outline: "Case\n Do it > It works" }] });
	const report = async (commit: string, target: Record<string, unknown>, outcome: string, as = h.owner) =>
		await h.call(
			"report",
			{
				target: { commit, repo: "app", ...target },
				results: [
					{
						test: { key: "one" },
						annotation: { case: "C-1", version: 1 },
						outcome,
						...(outcome === "fail" ? { failure: { message: "same cause" } } : {}),
					},
				],
			},
			as,
		);
	await report("base0001", { branch: "main" }, "fail");
	await report("change01", { branch: "feature", pr: 69, base: "base0001" }, "fail");
	await h.call("plan", {
		name: "base disagreement",
		select: { cases: ["C-1"] },
		accepts: { commit: "base0001", repo: "app" },
		require: [{ kind: "exercise", id: "run", methods: ["auto"], basis: "exact", minActors: 1 }],
	});
	const other = await h.actor("second-pipeline", "ci", ["read", "record"]);
	await report("base0001", { branch: "main" }, "pass", other);
	const question = (await h.call<InboxReply>("inbox", { kind: "failure" })).items.find((q) =>
		q.answers.includes("mistaken"),
	);
	if (!question) throw new Error("missing disputed base result");
	await h.call("decide", { q: question.q, onEvidence: question.evidenceHash, answer: { is: "mistaken" } });
	expect(await gate("change01")).toMatchObject({ verdict: "blocked", tally: { excused: 0, unexplained: 1 } });
	await h.call("decide", { undo: question.q });
	expect(await gate("change01")).toMatchObject({ verdict: "passed", tally: { excused: 1 } });
});

test("an agent's results on the base cannot supply the rule's evidence", async () => {
	const agent = await h.actor("reviewer", "agent", ["read", "produce"]);
	await h.call("report", ciReport({ commit: "base0001", n: 2, fail: { 0: "same cause" } }), agent);
	await change({ 0: "same cause" });
	expect(await gate("change01")).toMatchObject({ verdict: "blocked", tally: { excused: 0, unexplained: 1 } });
});

test("a skipped base retry keeps a real failure's support", async () => {
	await base();
	await change({ 0: "same cause" });
	const input = ciReport({ commit: "base0001", n: 2, attempt: 2 });
	await h.call("report", { ...input, results: input.results.map((row) => ({ ...row, outcome: "skip" })) });
	expect(await gate("change01")).toMatchObject({ verdict: "passed", tally: { excused: 1 } });
});

test.each([
	{ version: 1, excused: 0 },
	{ version: 2, excused: 1 },
])(
	"a closed run inherits only its remaining failures after late proof of case version $version",
	async ({ version, excused }) => {
		await h.call("propose", { edits: [{ op: "create", outline: "Case\n Do it > It works" }] });
		const send = async (commit: string, outcome: string, attempt = 1, version = 1) =>
			await h.call("report", {
				target: {
					commit,
					repo: "app",
					...(commit === "change01" ? { pr: 69, branch: "feature", base: "base0001" } : { branch: "main" }),
				},
				attempt,
				results: [
					{
						test: { key: "one" },
						annotation: { case: "C-1", version },
						outcome,
						...(outcome === "fail" ? { failure: { message: "same cause" } } : {}),
					},
				],
			});
		await send("base0001", "fail");
		await send("change01", "fail");
		const planned = await h.call<{ run: string }>("plan", {
			name: "pinned evidence",
			select: { cases: ["C-1"] },
			accepts: { commit: "change01", repo: "app" },
		});
		expect((await h.call<GateStatus>("gate", { run: planned.run })).tally.excused).toBe(1);
		if (version === 2)
			await h.call("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Revised case" } }] });
		await send("change01", "pass", 2, version);
		expect((await h.call<GateStatus>("gate", { run: planned.run })).tally).toMatchObject({
			excused,
			pass: 1 - excused,
		});
		await send("base0001", "pass", 2);
		expect((await h.call<GateStatus>("gate", { run: planned.run })).tally).toMatchObject({
			excused: 0,
			unexplained: excused,
			pass: 1 - excused,
		});
	},
);

test("mutual base references reconcile from results without cycling decisions", async () => {
	await h.call(
		"report",
		ciReport({ commit: "change01", branch: "one", pr: 69, base: "change02", n: 1, fail: { 0: "same cause" } }),
	);
	await h.call(
		"report",
		ciReport({ commit: "change02", branch: "two", pr: 70, base: "change01", n: 1, fail: { 0: "same cause" } }),
	);
	expect((await gate("change01")).tally.excused).toBe(1);
	expect((await gate("change02")).tally.excused).toBe(1);
});

for (const revocation of ["base", "policy"]) {
	test(`HTTP report and gate expose inheritance and immediate ${revocation} revocation`, async () => {
		const directory = await mkdtemp(join(tmpdir(), "mainworthy-inherited-"));
		const fixture = await testDatabase();
		const instance = await start(
			defaultConfig({
				MAINWORTHY_DATA: directory,
				MAINWORTHY_DATABASE_URL: fixture.url,
				MAINWORTHY_PORT: "0",
				MAINWORTHY_OWNER: "robin",
				MAINWORTHY_MODE: "local",
			}),
			() => ({ ui: null }),
			{},
		);
		try {
			const client = new Client({ url: instance.url, token: undefined, project: "scratch" });
			await client.call("report", ciReport({ commit: "base0001", n: 1, fail: { 0: "same cause" } }));
			await client.call(
				"report",
				ciReport({ commit: "change01", branch: "feature", pr: 69, base: "base0001", n: 1, fail: { 0: "same cause" } }),
			);
			expect(await client.call("gate", { commit: "change01" })).toMatchObject({
				verdict: "passed",
				tally: { excused: 1 },
			});
			if (revocation === "base") {
				await client.call("report", ciReport({ commit: "base0001", n: 1, attempt: 2 }));
			} else {
				await client.call("propose", { edits: [{ op: "policy", preset: "standard" }] });
				const adoption = (await client.call("inbox", { kind: "adopt" })).items[0];
				if (!adoption) throw new Error("missing policy adoption");
				await client.call("decide", { q: adoption.q, onEvidence: adoption.evidenceHash, answer: { is: "accept" } });
			}
			expect(await client.call("gate", { commit: "change01" })).toMatchObject({
				verdict: "blocked",
				tally: { excused: 0, unexplained: 1 },
			});
		} finally {
			await instance.stop();
			await fixture.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
}

test("a receipt names the matching rule decision for each of several causes", async () => {
	const fail = { 0: "coupon amount is wrong", 1: "inventory lookup timed out" };
	await base(fail);
	const receipt = await h.call<{ questions: { q: string; title: string }[] }>(
		"report",
		ciReport({ commit: "change01", branch: "feature", pr: 69, base: "base0001", n: 2, fail }),
	);
	expect(new Set(receipt.questions.map((question) => question.q)).size).toBe(2);
	expect(new Set(receipt.questions.map((question) => question.title))).toEqual(new Set(Object.values(fail)));
});

test("retargeting reaches the changed pull request when the report's commit already belongs elsewhere", async () => {
	await base();
	await change({ 0: "same cause" });
	await h.call("report", ciReport({ commit: "base0002", n: 2 }));
	await h.call(
		"report",
		ciReport({ commit: "change02", branch: "other", pr: 70, base: "base0001", n: 2, fail: { 0: "same cause" } }),
	);
	await h.call(
		"report",
		ciReport({ commit: "change02", branch: "feature", pr: 69, base: "base0002", n: 2, fail: { 0: "same cause" } }),
	);
	expect(await gate("change01")).toMatchObject({ verdict: "blocked", tally: { excused: 0, unexplained: 1 } });
	expect(await gate("change02")).toMatchObject({ verdict: "passed", tally: { excused: 1 } });
});
