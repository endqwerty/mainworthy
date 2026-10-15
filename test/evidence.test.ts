// One red build: reports, causes, decisions and the gate. The fixtures named D1, D3, C3, C5, E3 and E8 are the
// commitments in docs/product-design.md sections 4.2 and 9.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Client } from "../src/cli/client.ts";
import { SameCodeEvidence } from "../src/core/flaky.ts";
import { Policy } from "../src/core/kinds.ts";
import type { ClaimReply, CommandFate, DecideReply, GateStatus, InboxReply, ReportReceipt } from "../src/core/ops.ts";
import { stakes } from "../src/core/stakes.ts";
import { recoverAccepted, sweep } from "../src/server/jobs.ts";
import { type Config, defaultConfig, openApp } from "../src/server/kernel/app.ts";
import { findProject, makeCtx, stampSeq } from "../src/server/kernel/ctx.ts";
import { Db } from "../src/server/kernel/db.ts";
import { migrate } from "../src/server/kernel/migrate.ts";
import { acceptReport, processBatch } from "../src/server/ops/writes.ts";
import { type Instance, start } from "../src/server/start.ts";
import { exportArchive, importArchive, linesOf } from "../src/server/transfer/transfer.ts";
import { archiveRoutes } from "../src/surfaces/archive.ts";
import { ciReport, type Harness, harness } from "./helpers.ts";

let h: Harness;
beforeEach(() => {
	h = harness();
});
afterEach(() => h.close());

const gate = (commit: string) => h.call<GateStatus>("gate", { commit });
const queue = () => h.call<InboxReply>("inbox");
const decide = (q: { q: string; evidenceHash: string }, answer: Record<string, unknown>, as = h.owner) =>
	h.call<{ status: string; needs: string | null }[]>("decide", { q: q.q, onEvidence: q.evidenceHash, answer }, as)[0];
const count = (table: string) =>
	h.app.db.raw.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? 0;
const first = <T>(items: T[]): T => {
	const item = items[0];
	if (item === undefined) throw new Error("expected at least one item");
	return item;
};

describe("a green report", () => {
	test("is recorded with an explicit basis and the gate passes", () => {
		const receipt = h.call<ReportReceipt>("report", ciReport({ commit: "aaaaaaa1", n: 20 }));
		expect(receipt.counts).toMatchObject({ total: 20, pass: 20, fail: 0 });
		expect(receipt.basis).toEqual({ exact: 0, assumed: 0, unresolved: 20 }); // no test is linked to a case yet
		expect(receipt.gate?.verdict).toBe("passed");
		expect(gate("aaaaaaa1")).toMatchObject({ verdict: "passed", stale: false });
	});

	test("sent twice writes once and returns the same receipt", () => {
		const report = ciReport({ commit: "aaaaaaa1", n: 20 });
		const one = h.call<ReportReceipt>("report", report);
		const rows = count("results");
		const two = h.call<ReportReceipt>("report", report);
		expect(two).toEqual({ ...one, fresh: false });
		expect(count("results")).toBe(rows);
		expect(count("batches")).toBe(1);
	});

	test("a commit nobody reported on is pending, never green", () => {
		expect(gate("deadbeef")).toMatchObject({ verdict: "pending", run: null });
	});
});

describe("a red report", () => {
	test("forgetting rewrites report attribution in command replay and receipts while preserving decisions", () => {
		const person = h.actor("erasure-person", "human", ["read", "produce", "answer"]);
		const report = ciReport({ commit: "ddddddd1", n: 1, fail: { 0: "expected total" } });
		h.call("report", report);
		expect(decide(first(queue().items), { is: "defect" }, person)?.status).toBe("decided");
		const input = { ...report, attempt: 2, cmd: "receipt-command-01" };
		const receipt = h.call<ReportReceipt>("report", input);
		expect(receipt.questions[0]).toMatchObject({ by: person.name, answer: "defect" });
		const fate = h.call<CommandFate>("command", { cmd: input.cmd });
		if (fate.state !== "done") throw new Error("the report command did not finish");
		const decisions = h.app.db.raw.query("SELECT * FROM decisions ORDER BY id").all();
		const commands = h.app.db.raw.query("SELECT id, request, seq, touched FROM commands ORDER BY id").all();
		const results = count("results");
		h.call("admin", { do: "actor.forget", name: person.name });
		const expected = {
			...receipt,
			questions: receipt.questions.map((question) => ({ ...question, by: `forgotten-${person.id}` })),
		};
		expect(h.call<CommandFate>("command", { cmd: input.cmd })).toEqual({ ...fate, reply: expected });
		expect(h.call<ReportReceipt>("report", input)).toEqual(expected);
		expect(h.call<ReportReceipt>("report", { ...input, cmd: undefined })).toEqual({ ...expected, fresh: false });
		expect(
			h.app.db.raw
				.query("SELECT receipt FROM batches WHERE receipt IS NOT NULL")
				.all()
				.map((row) => JSON.stringify(row))
				.join(""),
		).not.toContain(person.name);
		expect(h.app.db.raw.query("SELECT * FROM decisions ORDER BY id").all()).toEqual(decisions);
		expect(h.app.db.raw.query("SELECT id, request, seq, touched FROM commands ORDER BY id").all()).toEqual(commands);
		expect(count("results")).toBe(results);
		expect(h.call<InboxReply>("inbox", { state: "decided", kind: "failure" }).items[0]?.decision?.by).toEqual([
			`forgotten-${person.id}`,
		]);
		expect(h.raw("report", { ...input, attempt: 3 })).toMatchObject({ ok: false, error: { code: "conflict" } });
	});

	test("forgetting rewrites known claim attribution but leaves arbitrary content and other replies alone", () => {
		const person = h.actor("erasure-person", "human", ["read", "produce", "answer"]);
		h.call("propose", { edits: [{ op: "create", outline: person.name }] });
		const claim = { lens: "review", findings: [{ on: "C-1", category: "ambiguous", note: person.name }] };
		h.call("claim", claim);
		expect(decide(first(queue().items), { is: "reject" }, person)?.status).toBe("decided");
		const input = { ...claim, cmd: "known-claim-01" };
		const reply = h.call<ClaimReply>("claim", input);
		expect(reply.known[0]).toMatchObject({ by: person.name, answer: "reject" });
		const project = { do: "project.create", key: "another", name: person.name, cmd: "project-create-01" };
		const projectReply = h.call("admin", project);
		const before = h.call("get", { refs: ["C-1"] });
		h.call("admin", { do: "actor.forget", name: person.name });
		const expected = { ...reply, known: reply.known.map((known) => ({ ...known, by: `forgotten-${person.id}` })) };
		expect(h.call<ClaimReply>("claim", input)).toEqual(expected);
		expect(h.call<CommandFate>("command", { cmd: input.cmd })).toMatchObject({ state: "done", reply: expected });
		expect(h.call<unknown>("get", { refs: ["C-1"] })).toEqual(before);
		expect(h.call<unknown>("admin", project)).toEqual(projectReply);
		expect(h.call<InboxReply>("inbox", { state: "decided", kind: "finding" }).items[0]?.evidence.note).toBe(
			person.name,
		);
	});

	test("D1: 500 failures with one cause open one question", () => {
		const fail = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [i, "expected 90.00, got 100.00"]));
		const receipt = h.call<ReportReceipt>("report", ciReport({ commit: "bbbbbbb1", n: 600, fail }));
		expect(receipt.counts.fail).toBe(500);
		expect(receipt.questions).toHaveLength(1);
		expect(receipt.questions[0]).toMatchObject({ how: "new", tests: 500, state: "open" });
		expect(queue().counts.failure).toBe(1);
		expect(receipt.gate).toMatchObject({ verdict: "blocked" });
		expect(receipt.gate?.tally.unexplained).toBe(500);
	});

	const genericReport = (n = 60, files = 6, message = "assertion failed") => ({
		...ciReport({ commit: "broad001", n: 0 }),
		results: Array.from({ length: n }, (_, i) => ({
			test: { key: `file-${i % files}.test.ts::test ${i}`, file: `file-${i % files}.test.ts` },
			outcome: "fail" as const,
			failure: { message },
		})),
	});
	const assertionShard = (shard: number, n = 40) => {
		const report = genericReport(n);
		return {
			...report,
			job: `shard-${shard}`,
			results: report.results.map((result) => ({
				...result,
				test: { key: `shard-${shard}/${result.test.key}`, file: `shard-${shard}/${result.test.file}` },
			})),
		};
	};

	test.each([{ order: [0, 1, 2, 3, 4, 5] }, { order: [5, 4, 3, 2, 1, 0] }])(
		"a broad assertion spread across six CI shards splits as reports accumulate: %j",
		({ order }) => {
			const applied = order.map((shard) => {
				const report = assertionShard(shard);
				return { report, receipt: h.call<ReportReceipt>("report", report) };
			});
			expect(first(applied).receipt.questions).toHaveLength(1);
			for (const { receipt } of applied.slice(1)) {
				expect(receipt.questions).toHaveLength(6);
				expect(receipt.questions.every((q) => q.title.startsWith("Split by file (shard-"))).toBe(true);
			}
			expect(queue().counts.failure).toBe(31);
			expect(gate("broad001").tally).toMatchObject({ unexplained: 240, excused: 0 });
			const file = first(queue().items.filter((q) => q.title.includes("/file-0.test.ts): assertion failed")));
			expect(decide(file, { is: "flaky" })?.status).toBe("decided");
			expect(gate("broad001").tally).toMatchObject({ unexplained: 233, excused: 7 });
			for (const { report, receipt } of applied) {
				expect(h.call<ReportReceipt>("report", report)).toEqual({ ...receipt, fresh: false });
			}
			expect(count("results")).toBe(240);
			expect(count("batches")).toBe(6);
		},
	);

	test("a split across shards preserves the earlier generic answer and its results", () => {
		const receipt = h.call<ReportReceipt>("report", assertionShard(0));
		const question = first(queue().items);
		expect(decide(question, { is: "flaky", reason: "the first shard's evidence" })?.status).toBe("decided");
		const earlier = h.app.db.raw.query("SELECT * FROM results ORDER BY id").all();
		const decisions = h.app.db.raw.query("SELECT * FROM decisions WHERE kind = 'failure' ORDER BY id").all();
		const excuses = h.app.db.raw.query("SELECT * FROM excuses ORDER BY decision").all();
		const next = h.call<ReportReceipt>("report", assertionShard(1));
		expect(next.questions).toHaveLength(6);
		expect(next.questions.every((q) => q.state === "open")).toBe(true);
		expect(gate("broad001").tally).toMatchObject({ unexplained: 40, excused: 40 });
		expect(h.app.db.raw.query("SELECT * FROM results ORDER BY id LIMIT 40").all()).toEqual(earlier);
		expect(h.app.db.raw.query("SELECT * FROM decisions WHERE kind = 'failure' ORDER BY id").all()).toEqual(decisions);
		expect(h.app.db.raw.query("SELECT * FROM excuses ORDER BY decision").all()).toEqual(excuses);
		expect(h.call<InboxReply>("inbox", { state: "decided", kind: "failure" }).items[0]).toMatchObject({
			q: question.q,
			title: "assertion failed",
		});
		expect(h.call<ReportReceipt>("report", assertionShard(0))).toEqual({ ...receipt, fresh: false });
	});

	test.each([false, true])(
		"a stable shard order reuses the first shard's file causes on later commits, answered=%j",
		(answered) => {
			const commits = answered ? ["c0000001", "c0000002"] : ["c1000001", "c1000002", "c1000003"];
			const firstShards: ReportReceipt[] = [];
			for (const commit of commits) {
				for (let shard = 0; shard < 6; shard++) {
					const report = assertionShard(shard);
					const receipt = h.call<ReportReceipt>("report", { ...report, target: { ...report.target, commit } });
					if (shard === 0) firstShards.push(receipt);
				}
				if (answered && commit === commits[0]) {
					const generic = first(queue().items.filter((q) => q.title === "assertion failed"));
					expect(decide(generic, { is: "flaky" })?.status).toBe("decided");
				}
			}
			expect(first(firstShards).questions).toMatchObject([{ title: "assertion failed", tests: 40, state: "open" }]);
			for (const receipt of firstShards.slice(1)) {
				expect(receipt.questions).toHaveLength(6);
				expect(
					receipt.questions.every((q) => q.title.startsWith("Split by file (shard-0/") && q.state === "open"),
				).toBe(true);
			}
			expect(gate(first(commits)).tally).toMatchObject({
				excused: answered ? 40 : 0,
				unexplained: answered ? 200 : 240,
			});
			for (const commit of commits.slice(1)) {
				expect(gate(commit).tally).toMatchObject({ excused: 0, unexplained: 240 });
			}
			expect(queue().counts.failure).toBe(answered ? 36 : 37);
			const generic = h.call<InboxReply>("inbox", { kind: "failure", state: answered ? "decided" : "open" }).items;
			expect(generic.find((q) => q.title === "assertion failed")?.evidence.tests).toHaveLength(40);
		},
	);

	test("a null-file cause seen only before the split is reused on later commits", () => {
		const report = genericReport(1);
		const missing = {
			...report,
			job: "without-file",
			results: [{ test: { key: "without-file" }, outcome: "fail", failure: { message: "assertion failed" } }],
		};
		const receipt = h.call<ReportReceipt>("report", missing);
		expect(decide(first(queue().items), { is: "flaky" })?.status).toBe("decided");
		h.call("report", assertionShard(0));
		h.call("report", assertionShard(1));
		expect(gate("broad001").tally).toMatchObject({ excused: 41, unexplained: 40 });
		expect(h.call<ReportReceipt>("report", missing)).toEqual({ ...receipt, fresh: false });
		const next = h.call<ReportReceipt>("report", { ...missing, target: { ...missing.target, commit: "broad002" } });
		expect(next.questions).toMatchObject([
			{ title: "Split by file (no file reported): assertion failed", tests: 1, state: "open" },
		]);
		expect(gate("broad002").tally).toMatchObject({ excused: 0, unexplained: 1 });
	});

	test("new files in small later shards count earlier split results under the original cause", () => {
		h.call("report", assertionShard(0));
		h.call("report", assertionShard(1));
		const receipt = h.call<ReportReceipt>("report", assertionShard(2, 1));
		expect(receipt.questions[0]).toMatchObject({
			title: "Split by file (shard-2/file-0.test.ts): assertion failed",
			tests: 1,
		});
		expect(gate("broad001").tally.unexplained).toBe(81);
	});

	test("cross-report thresholds count distinct tests and keep different assertions separate", () => {
		const report = assertionShard(0);
		h.call("report", report);
		const retry = h.call<ReportReceipt>("report", { ...report, attempt: 2 });
		expect(retry.questions).toHaveLength(1);
		expect(retry.questions[0]?.title).toBe("assertion failed");
		const other = assertionShard(1);
		const distinct = h.call<ReportReceipt>("report", {
			...other,
			results: other.results.map((result) => ({ ...result, failure: { message: "expected eight, got nine" } })),
		});
		expect(distinct.questions).toHaveLength(1);
		expect(distinct.questions[0]?.title).toBe("expected eight, got nine");
		const atLimit = h.call<ReportReceipt>("report", assertionShard(2, 10));
		expect(atLimit.questions).toHaveLength(1);
		expect(atLimit.questions[0]?.title).toBe("assertion failed");
		const overLimit = h.call<ReportReceipt>("report", assertionShard(3, 1));
		expect(overLimit.questions[0]?.title).toBe("Split by file (shard-3/file-0.test.ts): assertion failed");
	});

	test("the guard combines environments of one repository and commit, not other commits or repositories", () => {
		h.call("report", assertionShard(0));
		const other = assertionShard(1);
		for (const target of [
			{ ...other.target, commit: "broad002" },
			{ ...other.target, repo: "acme/other" },
		]) {
			const receipt = h.call<ReportReceipt>("report", { ...other, target });
			expect(receipt.questions).toHaveLength(1);
			expect(receipt.questions[0]?.title).toBe("assertion failed");
		}
		const receipt = h.call<ReportReceipt>("report", { ...other, target: { ...other.target, env: "another" } });
		expect(receipt.questions).toHaveLength(6);
		expect(h.call<GateStatus>("gate", { commit: "broad001", repo: "acme/web" }).tally.unexplained).toBe(80);
	});

	test("five reported files and missing files across shards do not cross the file threshold", () => {
		const report = genericReport(30, 5);
		h.call("report", report);
		const sameFiles = h.call<ReportReceipt>("report", {
			...report,
			job: "another",
			results: report.results.map((result) => ({
				...result,
				test: { ...result.test, key: `${result.test.key} extra` },
			})),
		});
		expect(sameFiles.questions[0]?.title).toBe("assertion failed");
		const missingFiles = h.call<ReportReceipt>("report", {
			...report,
			job: "missing",
			results: Array.from({ length: 20 }, (_, i) => ({
				test: { key: `without-file-${i}` },
				outcome: "fail",
				failure: { message: "assertion failed" },
			})),
		});
		expect(missingFiles.questions[0]?.title).toBe("assertion failed");
		const sixthFile = h.call<ReportReceipt>("report", assertionShard(1, 1));
		expect(sixthFile.questions[0]?.title).toBe("Split by file (shard-1/file-0.test.ts): assertion failed");
		expect(gate("broad001").tally.unexplained).toBe(81);
	});

	test("the guard counts applied reports even when acceptance order is reversed", () => {
		const inTx = <T>(fn: (ctx: ReturnType<typeof makeCtx>) => T): T =>
			h.app.db.transaction(() => {
				const project = findProject(h.app.db, "scratch");
				if (!project) throw new Error("no project");
				const ctx = makeCtx(h.app, project, h.owner, true);
				const out = fn(ctx);
				stampSeq(ctx);
				return out;
			});
		const firstBatch = inTx((ctx) => acceptReport(ctx, assertionShard(0))).batch;
		const secondBatch = inTx((ctx) => acceptReport(ctx, assertionShard(1))).batch;
		const firstApplied = inTx((ctx) => processBatch(ctx, secondBatch.id));
		expect(firstApplied.questions).toHaveLength(1);
		expect(firstApplied.questions[0]?.title).toBe("assertion failed");
		const secondApplied = inTx((ctx) => processBatch(ctx, firstBatch.id));
		expect(secondApplied.questions).toHaveLength(6);
		expect(gate("broad001")).toMatchObject({ verdict: "blocked", stale: false, tally: { unexplained: 80 } });
		expect(recoverAccepted(h.app)).toBe(0);
	});

	test("a broad assertion is split by file, and one answer excuses only that file", () => {
		const report = genericReport();
		const receipt = h.call<ReportReceipt>("report", report);
		expect(receipt.questions).toHaveLength(6);
		expect(receipt.questions.map((q) => q.tests)).toEqual([10, 10, 10, 10, 10, 10]);
		const questions = queue().items.filter((q) => q.kind === "failure");
		expect(questions.map((q) => q.title).sort()).toEqual(
			Array.from({ length: 6 }, (_, i) => `Split by file (file-${i}.test.ts): assertion failed`),
		);
		const fileZero = questions.find((q) => q.title === "Split by file (file-0.test.ts): assertion failed");
		if (!fileZero) throw new Error("the first file's question was not raised");
		expect(decide(fileZero, { is: "flaky", reason: "known in this file" })?.status).toBe("decided");
		expect(gate("broad001").tally).toMatchObject({ excused: 10, unexplained: 50 });
		expect(gate("broad001").verdict).toBe("blocked");
		const retry = h.call<ReportReceipt>("report", { ...report, attempt: 2 });
		expect(retry.questions.filter((q) => q.state === "open")).toHaveLength(5);
		expect(gate("broad001").tally).toMatchObject({ excused: 10, unexplained: 50 });
		const later = h.call<ReportReceipt>("report", {
			...report,
			target: { ...report.target, commit: "broad002" },
			results: [first(report.results)],
		});
		expect(later.questions[0]?.title).toBe("Split by file (file-0.test.ts): assertion failed");
		expect(later.gate?.tally).toMatchObject({ excused: 1, unexplained: 0 });
		expect(h.call<ReportReceipt>("report", report)).toMatchObject({ fresh: false, questions: receipt.questions });
	});

	test.each([
		[50, 6, "assertion failed"],
		[51, 5, "assertion failed"],
		[60, 5, "assertion failed"],
		[60, 6, "Timeout 5000ms exceeded"],
		[60, 6, "connect ECONNREFUSED localhost:5432"],
	])("the guard keeps %i tests in %i files with %s together", (n, files, message) => {
		const receipt = h.call<ReportReceipt>("report", genericReport(n, files, message));
		expect(receipt.questions).toHaveLength(1);
		expect(receipt.questions[0]?.tests).toBe(n);
	});

	test("51 tests across six files split even when one file already has a split signature", () => {
		const report = genericReport();
		h.call("report", report);
		const later = genericReport(51);
		later.results = later.results.map((result, i) => ({
			...result,
			test: i % 6 === 0 ? result.test : { key: `new-${i % 6}.ts::test ${i}`, file: `new-${i % 6}.ts` },
		}));
		const receipt = h.call<ReportReceipt>("report", { ...later, target: { ...later.target, commit: "mixed001" } });
		expect(receipt.questions).toHaveLength(6);
		expect(receipt.questions.map((q) => q.tests).sort()).toEqual([8, 8, 8, 9, 9, 9]);
		expect(receipt.questions.every((q) => q.title.startsWith("Split by file ("))).toBe(true);
	});

	test("a missing file stays separate from a file named no file reported", () => {
		const report = genericReport();
		const receipt = h.call<ReportReceipt>("report", {
			...report,
			results: [
				...report.results,
				{ test: { key: "without-file" }, outcome: "fail", failure: { message: "assertion failed" } },
				{
					test: { key: "named-file", file: "no file reported" },
					outcome: "fail",
					failure: { message: "assertion failed" },
				},
			],
		});
		expect(receipt.questions).toHaveLength(8);
		expect(new Set(receipt.questions.map((q) => q.q)).size).toBe(8);
		expect(receipt.questions.filter((q) => q.tests === 1)).toHaveLength(2);
	});

	test("the guard sees the whole report across application slices", () => {
		const receipt = h.call<ReportReceipt>("report", genericReport(600));
		expect(receipt.questions).toHaveLength(6);
		expect(receipt.questions.map((q) => q.tests)).toEqual([100, 100, 100, 100, 100, 100]);
		expect(receipt.gate?.tally.unexplained).toBe(600);
	});

	test("each normalised assertion has its own thresholds", () => {
		const report = genericReport();
		const receipt = h.call<ReportReceipt>("report", {
			...report,
			results: report.results.map((result, i) => ({
				...result,
				failure: { message: i < 30 ? "expected 5, got 7" : "expected 8, got 9" },
			})),
		});
		expect(receipt.questions).toHaveLength(2);
		expect(receipt.questions.map((q) => q.tests)).toEqual([30, 30]);
		expect(receipt.questions.map((q) => q.title)).toEqual(["expected 5, got 7", "expected 8, got 9"]);
	});

	test("the guard counts distinct tests, not repeated results", () => {
		const report = genericReport(6);
		const receipt = h.call<ReportReceipt>("report", { ...report, results: Array(10).fill(report.results).flat() });
		expect(receipt.questions).toHaveLength(1);
		expect(queue().items.find((q) => q.kind === "failure")?.title).toBe("assertion failed");
	});

	test("a prior answer for the generic cause cannot excuse a broad report", () => {
		const report = genericReport();
		h.call("report", { ...report, target: { ...report.target, commit: "prior001" }, results: [first(report.results)] });
		decide(first(queue().items), { is: "flaky", reason: "known earlier" });
		const receipt = h.call<ReportReceipt>("report", report);
		expect(receipt.questions).toHaveLength(6);
		expect(receipt.gate?.tally).toMatchObject({ excused: 0, unexplained: 60 });
		expect(gate("prior001").tally).toMatchObject({ excused: 1, unexplained: 0 });
	});

	test("volatile parts of a message do not split a cause, different assertions do", () => {
		const receipt = h.call<ReportReceipt>(
			"report",
			ciReport({
				commit: "bbbbbbb2",
				n: 4,
				fail: {
					0: "Timeout 5003ms exceeded while waiting",
					1: "Timeout 5210ms exceeded while waiting",
					2: "expected 5, got 7",
					3: "expected 90.00, got 100.00",
				},
			}),
		);
		expect(receipt.questions).toHaveLength(3);
	});

	test("C3: a decision changes the gate without re-running the pipeline", () => {
		h.call("report", ciReport({ commit: "ccccccc1", n: 10, fail: { 3: "connect ECONNREFUSED 10.0.0.5:5432" } }));
		expect(gate("ccccccc1").verdict).toBe("blocked");
		expect(decide(first(queue().items), { is: "infra" })?.status).toBe("decided");
		const after = gate("ccccccc1");
		expect(after).toMatchObject({ verdict: "passed" });
		expect(after.tally).toMatchObject({ pass: 9, excused: 1, unexplained: 0 });
	});

	test("a defect is attributed: the gate says failed, which needs a fix, not a decision", () => {
		h.call("report", ciReport({ commit: "ccccccc2", n: 10, fail: { 3: "expected 90.00, got 100.00" } }));
		decide(first(queue().items), { is: "defect", ref: "WEB-301" });
		expect(gate("ccccccc2")).toMatchObject({
			verdict: "failed",
			reason: "failed: 1 failure attributed to this target",
		});
	});

	test("D3: the same failing commit re-run asks nothing new", () => {
		const fail = { 3: "expected 90.00, got 100.00" };
		h.call("report", ciReport({ commit: "ddddddd1", n: 10, fail }));
		decide(first(queue().items), { is: "defect" });
		const again = h.call<ReportReceipt>("report", ciReport({ commit: "ddddddd1", n: 10, fail, attempt: 2 }));
		expect(again.questions[0]).toMatchObject({ how: "already decided", answer: "defect", by: "robin" });
		expect(queue().counts.open).toBe(0);
		expect(count("questions WHERE kind = 'failure'")).toBe(1);
	});

	test("an answer on evidence that has changed is a conflict, with the new evidence", () => {
		h.call("report", ciReport({ commit: "eeeeeee1", pr: 7, branch: "fix", n: 3, fail: { 0: "boom" } }));
		const seen = first(queue().items);
		// trunk fails the same way, then the change gets a newer build
		h.call("report", ciReport({ commit: "0000000a", n: 3, fail: { 0: "boom" } })); // trunk now fails the same way
		h.call("report", ciReport({ commit: "eeeeeee2", pr: 7, branch: "fix", n: 3, fail: { 0: "boom" } }));
		const reply = h.raw("decide", { q: seen.q, onEvidence: seen.evidenceHash, answer: { is: "flaky" } });
		// a newer build has arrived since the answer was prepared, so it is a conflict
		expect(reply.ok && (reply.result as { status: string }[])[0]?.status).toBe("conflict");
	});

	test("undo withdraws a decision: the gate returns, and both decisions stay in the ledger", () => {
		h.call("report", ciReport({ commit: "fffffff1", n: 5, fail: { 1: "expected 1, got 2" } }));
		const q = first(queue().items);
		decide(q, { is: "flaky" });
		expect(gate("fffffff1").verdict).toBe("passed");
		const undone = h.call<{ status: string }[]>("decide", { undo: q.q });
		expect(undone[0]?.status).toBe("reopened");
		expect(gate("fffffff1").verdict).toBe("blocked");
		expect(queue().counts.open).toBe(1);
		expect(count("decisions WHERE kind = 'failure'")).toBe(2);
		expect(count("excuses")).toBe(0);
	});

	test("undo with a decision receipt leaves an intervening answer in force", () => {
		h.call("report", ciReport({ commit: "fffffff2", n: 1, fail: { 0: "expected one, got two" } }));
		const q = first(queue().items);
		const give = (is: string, as = h.owner) =>
			first(h.call<DecideReply[]>("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is } }, as));
		const receipt = give("flaky");
		const colleague = h.actor("colleague", "human", ["read", "produce", "answer"]);
		const replacement = give("defect", colleague);
		expect(receipt.status).toBe("decided");
		expect(replacement.status).toBe("decided");
		const decisions = count("decisions");
		const stale = first(h.call<DecideReply[]>("decide", { undo: q.q, ifDecision: receipt.decision }));
		expect(stale.status).toBe("conflict");
		expect(stale.needs).toContain("decision changed");
		expect(first(h.call<InboxReply>("inbox", { state: "decided" }).items).decision).toMatchObject({
			id: replacement.decision,
		});
		expect(gate("fffffff2").verdict).toBe("failed");
		expect(count("decisions")).toBe(decisions);
		for (const ifDecision of [0, -1, 1.5, null, "decision"]) {
			expect(h.raw("decide", { undo: q.q, ifDecision })).toMatchObject({
				ok: false,
				error: { code: "invalid" },
			});
		}
		expect(count("decisions")).toBe(decisions);
		expect(first(h.call<DecideReply[]>("decide", { undo: q.q, ifDecision: replacement.decision })).status).toBe(
			"reopened",
		);
		expect(gate("fffffff2").verdict).toBe("blocked");
		expect(first(h.call<DecideReply[]>("decide", { undo: q.q, ifDecision: replacement.decision })).status).toBe(
			"conflict",
		);
	});

	test("receiptless undo deliberately withdraws the decision that stands now", () => {
		h.call("report", ciReport({ commit: "fffffff3", n: 1, fail: { 0: "expected one, got two" } }));
		const q = first(queue().items);
		decide(q, { is: "flaky" });
		decide(q, { is: "defect" });
		expect(first(h.call<DecideReply[]>("decide", { undo: q.q })).status).toBe("reopened");
		expect(gate("fffffff3").verdict).toBe("blocked");
	});

	test("a retry that passes is a recorded flip, the gate passes, and nobody is asked why it failed", () => {
		h.call("report", ciReport({ commit: "abababa1", n: 5, fail: { 2: "expected 1, got 2" } }));
		expect(queue().counts.open).toBe(1);
		const retry = h.call<ReportReceipt>("report", ciReport({ commit: "abababa1", n: 5, attempt: 2 }));
		expect(retry.flips).toBe(1);
		expect(retry.gate?.verdict).toBe("passed");
		expect(queue().counts.open).toBe(0);
		expect(count("questions WHERE state = 'dissolved'")).toBe(1);
		expect(count("flips")).toBe(1);
	});
});

describe("same-code detector suggestions", () => {
	const sameCode = () =>
		SameCodeEvidence.parse(h.call<Record<string, unknown>[]>("get", { refs: ["T-1"] })[0]?.sameCode);
	const report = (attempt: number, message?: string, job = "e2e") =>
		h.call<ReportReceipt>(
			"report",
			ciReport({ commit: "detector1", n: 1, attempt, job, fail: message ? { 0: message } : {} }),
		);

	test("shows assertion evidence without silently excusing the current failure", () => {
		report(1, "expected 1, got 2");
		report(2);
		const failing = report(3, "expected 1, got 2");
		expect(sameCode()).toMatchObject({
			enabled: true,
			windowDays: 14,
			minFlips: 2,
			signals: [
				{
					class: "assertion",
					flips: 2,
					suggested: true,
				},
			],
		});
		expect(sameCode().signals[0]?.samples[0]).toMatchObject({
			commit: "detector1",
			job: "e2e",
			first: { id: 2, outcome: "pass", attempt: 2 },
			second: { id: 3, outcome: "fail", attempt: 3 },
		});
		expect(failing.gate?.verdict).toBe("blocked");
		expect(count("excuses")).toBe(0);
		expect(queue().items[0]?.evidence.tests).toMatchObject([
			{ sameCode: { signals: [{ class: "assertion", suggested: true }] } },
		]);
	});

	test("keeps assertion, timeout and infrastructure evidence separate", () => {
		report(1);
		report(2, "expected 1, got 2");
		report(3);
		report(4, "ECONNRESET");
		report(5);
		report(6, "TimeoutError: waiting for element");
		report(7);
		expect(sameCode()).toMatchObject({
			signals: [
				{ class: "assertion", flips: 2, suggested: true },
				{ class: "timeout", flips: 2, suggested: true },
				{ class: "infra", flips: 2, suggested: true },
			],
		});
	});

	test("different assertion causes do not pool flips toward the threshold", () => {
		report(1, "expected 1, got 2");
		report(2);
		report(3, "expected 3, got 4");
		expect(sameCode().signals).toMatchObject([
			{ signature: { text: "expected 1, got 2" }, class: "assertion", flips: 1, suggested: false },
			{ signature: { text: "expected 3, got 4" }, class: "assertion", flips: 1, suggested: false },
		]);
	});

	test("a file-split cause counts its own flips and keeps the original cause's history separate", () => {
		const input = ciReport({ commit: "splitflip1", n: 0 });
		const tests = Array.from({ length: 60 }, (_, i) => ({
			key: `file-${i % 6}.test.ts::test ${i}`,
			file: `file-${i % 6}.test.ts`,
		}));
		const chosen = first(tests);
		const send = (attempt: number, outcome: "pass" | "fail", broad = false) =>
			h.call<ReportReceipt>("report", {
				...input,
				attempt,
				results: (broad ? tests : [chosen]).map((test) => ({
					test,
					outcome,
					...(outcome === "fail" ? { failure: { message: "assertion failed" } } : {}),
				})),
			});
		send(1, "pass");
		send(2, "fail");
		send(3, "pass");
		const splitReport = send(4, "fail", true);
		expect(splitReport.questions).toHaveLength(6);
		expect(sameCode().signals).toMatchObject([
			{ signature: { text: "assertion failed" }, class: "assertion", flips: 2, suggested: true },
			{
				signature: { text: "Split by file (file-0.test.ts): assertion failed" },
				class: "assertion",
				flips: 1,
				suggested: false,
			},
		]);
		const fileZero = () => queue().items.find((q) => q.title === "Split by file (file-0.test.ts): assertion failed");
		expect(first(z.array(z.unknown()).parse(fileZero()?.evidence.tests))).toMatchObject({
			t: "T-1",
			sameCode: { signals: [{ flips: 1, suggested: false }] },
		});
		const otherFile = queue().items.find((q) => q.title === "Split by file (file-1.test.ts): assertion failed");
		expect(otherFile?.evidence.tests).toHaveLength(10);
		expect(otherFile?.evidence.tests).not.toContainEqual(expect.objectContaining({ sameCode: expect.anything() }));
		send(5, "pass");
		const retry = send(6, "fail");
		expect(retry.questions[0]?.title).toBe("Split by file (file-0.test.ts): assertion failed");
		expect(sameCode().signals).toMatchObject([
			{ signature: { text: "assertion failed" }, flips: 2, suggested: true },
			{ signature: { text: "Split by file (file-0.test.ts): assertion failed" }, flips: 3, suggested: true },
		]);
		const snapshot = first(
			z.array(z.object({ sameCode: SameCodeEvidence.optional() }).passthrough()).parse(fileZero()?.evidence.tests),
		).sameCode;
		expect(snapshot?.signals).toHaveLength(1);
		expect(snapshot?.signals[0]).toMatchObject({
			signature: { text: "Split by file (file-0.test.ts): assertion failed" },
			flips: 3,
			suggested: true,
		});
		expect(retry.gate).toMatchObject({ verdict: "blocked", tally: { unexplained: 60, excused: 0 } });
	});

	test("a different job and an older attempt do not add detector evidence", () => {
		report(2, "expected 1, got 2");
		report(3, undefined, "unit");
		report(1);
		expect(sameCode()).toMatchObject({ signals: [] });
		report(3);
		expect(sameCode()).toMatchObject({ signals: [{ class: "assertion", flips: 1, suggested: false }] });
	});

	test("a skipped retry does not hide a decisive flip, and replaying a batch adds nothing", () => {
		report(1, "expected 1, got 2");
		const skipped = ciReport({ commit: "detector1", n: 1, attempt: 2 });
		h.call("report", { ...skipped, results: skipped.results.map((r) => ({ ...r, outcome: "skip" })) });
		report(3);
		report(3);
		expect(sameCode()).toMatchObject({ signals: [{ class: "assertion", flips: 1, suggested: false }] });
	});

	test("project settings change thresholds, disable suggestions, and expire old evidence", () => {
		const configure = (flakyDetection: { enabled: boolean; windowDays: number; minFlips: number }) => {
			const policy = Policy.extend({ version: z.number() }).parse(
				h.call("admin", { do: "policy.show", project: "scratch" }),
			);
			const proposed = h.call<{ question: string }>("propose", {
				edits: [{ op: "policy", base: policy.version, settings: { ...policy.settings, flakyDetection } }],
			});
			const q = h.call<InboxReply["items"]>("get", { refs: [proposed.question] })[0];
			if (!q) throw new Error("policy question missing");
			expect(decide(q, { is: "accept" })?.status).toBe("decided");
		};
		report(1, "expected 1, got 2");
		report(2);
		report(3, "expected 1, got 2");
		configure({ enabled: true, windowDays: 1, minFlips: 3 });
		expect(sameCode().signals).toMatchObject([{ class: "assertion", flips: 2, suggested: false }]);
		configure({ enabled: false, windowDays: 1, minFlips: 1 });
		expect(sameCode()).toEqual({ enabled: false, windowDays: 1, minFlips: 1, signals: [] });
		const other = harness({ project: "other" });
		try {
			expect(
				Policy.parse(other.call("admin", { do: "policy.show", project: "other" })).settings.flakyDetection,
			).toEqual({ enabled: true, windowDays: 14, minFlips: 2 });
		} finally {
			other.close();
		}

		expect(count("flips")).toBe(2);
		configure({ enabled: true, windowDays: 1, minFlips: 1 });
		expect(sameCode().signals).toMatchObject([{ flips: 2, suggested: true }]);
		h.advance(86_400_001);
		expect(sameCode().signals).toEqual([]);
		expect(gate("detector1").verdict).toBe("blocked");
	});

	test("invalid detector settings are refused without changing the policy", () => {
		const policy = Policy.extend({ version: z.number() }).parse(
			h.call("admin", { do: "policy.show", project: "scratch" }),
		);
		for (const bad of [
			{ enabled: "yes" },
			{ minFlips: 0 },
			{ minFlips: 101 },
			{ windowDays: 0 },
			{ windowDays: 366 },
		]) {
			expect(
				h.raw("propose", {
					edits: [
						{
							op: "policy",
							base: policy.version,
							settings: { ...policy.settings, flakyDetection: { ...policy.settings.flakyDetection, ...bad } },
						},
					],
				}),
			).toMatchObject({ ok: false, error: { code: "invalid" } });
		}
		expect(Policy.parse(h.call("admin", { do: "policy.show", project: "scratch" })).settings.flakyDetection).toEqual({
			enabled: true,
			windowDays: 14,
			minFlips: 2,
		});
	});

	test("one producer cannot create a flip with another producer's result", () => {
		report(1, "expected 1, got 2");
		const pipeline = h.actor("other-pipeline", "ci", ["record"]);
		h.call("report", ciReport({ commit: "detector1", n: 1, attempt: 2 }), pipeline);
		expect(sameCode().signals).toEqual([]);
		report(2);
		expect(sameCode().signals).toMatchObject([{ class: "assertion", flips: 1 }]);
	});

	test("same-attempt disagreement is not a retry flip", () => {
		report(1, "expected 1, got 2");
		report(1);
		expect(sameCode().signals).toEqual([]);
		report(2);
		expect(sameCode().signals).toMatchObject([{ class: "assertion", flips: 1 }]);
	});

	test("a later same-attempt failure removes a pass from detector evidence", () => {
		report(1, "expected 1, got 2");
		report(2);
		expect(sameCode().signals).toMatchObject([{ flips: 1 }]);
		report(2, "expected 1, got 2");
		expect(sameCode().signals).toEqual([]);
		report(3);
		expect(sameCode().signals).toMatchObject([
			{ flips: 1, samples: [{ first: { outcome: "fail", attempt: 2 }, second: { outcome: "pass", attempt: 3 } }] },
		]);
	});

	test("counts every flip but bounds concrete examples to three per failure cause", () => {
		for (const attempt of [1, 2, 3, 4, 5]) report(attempt, attempt % 2 === 1 ? "expected 1, got 2" : undefined);
		expect(sameCode().signals).toMatchObject([{ class: "assertion", flips: 4, suggested: true }]);
		expect(sameCode().signals[0]?.samples).toHaveLength(3);
	});

	test("different environments, repositories and commits do not cross", () => {
		report(1, "expected 1, got 2");
		const pass = ciReport({ commit: "detector1", n: 1, attempt: 2 });
		for (const target of [
			{ ...pass.target, env: "staging" },
			{ ...pass.target, repo: "acme/other" },
			{ ...pass.target, commit: "detector2" },
		])
			h.call("report", { ...pass, target });
		expect(sameCode().signals).toEqual([]);
		report(2);
		expect(sameCode().signals).toMatchObject([{ class: "assertion", flips: 1 }]);
	});

	test("a corrected observation stops supporting a suggestion", () => {
		const initial = report(1, "expected 1, got 2");
		report(2);
		expect(sameCode().signals).toMatchObject([{ flips: 1 }]);
		const corrected = ciReport({ commit: "detector1", n: 1, attempt: 3 });
		h.call("report", { ...corrected, results: corrected.results.map((r) => ({ ...r, corrects: initial.results[0] })) });
		expect(sameCode().signals).toEqual([]);
	});

	test("agents and session targets do not become same-code suggestions", () => {
		const agent = h.actor("review-bot", "agent", ["read", "produce"]);
		for (const attempt of [1, 2, 3])
			h.call(
				"report",
				ciReport({ commit: "detector1", n: 1, attempt, fail: attempt === 2 ? {} : { 0: "expected 1, got 2" } }),
				agent,
			);
		expect(sameCode().signals).toEqual([]);
		for (const attempt of [1, 2, 3]) {
			const input = ciReport({
				commit: "detector1",
				n: 1,
				attempt,
				fail: attempt === 2 ? {} : { 0: "expected 1, got 2" },
			});
			h.call("report", { ...input, target: { session: "manual-session" } });
		}
		expect(sameCode().signals).toEqual([]);
		report(1);
		report(2, "expected 1, got 2");
		expect(sameCode().signals).toMatchObject([{ class: "assertion", flips: 1 }]);
	});

	test("policies stored before detection settings still read with defaults", () => {
		const policy = Policy.parse(h.call("admin", { do: "policy.show", project: "scratch" }));
		const { flakyDetection: _, ...legacy } = policy.settings;
		h.app.db.raw.query("UPDATE policies SET settings = ?").run(JSON.stringify(legacy));
		expect(Policy.parse(h.call("admin", { do: "policy.show", project: "scratch" })).settings.flakyDetection).toEqual({
			enabled: true,
			minFlips: 2,
			windowDays: 14,
		});
		report(1);
		report(2, "expected 1, got 2");
		expect(sameCode().signals).toMatchObject([{ class: "assertion", flips: 1 }]);
	});
});

describe("a change against its base", () => {
	const failure = { 4: "expected 90.00, got 100.00" };

	test("loose: a failure the base has too is excused by a recorded rule for each commit", () => {
		h.call("report", ciReport({ commit: "base0001", n: 10, fail: failure }));
		decide(first(queue().items), { is: "defect" });
		const change = (commit: string) =>
			ciReport({ commit, branch: "feature", pr: 482, base: "base0001", n: 10, fail: failure });
		const pr = h.call<ReportReceipt>("report", change("feat0001"));
		expect(pr.questions[0]).toMatchObject({ how: "decided by rule", state: "decided", answer: "inherited" });
		expect(pr.gate).toMatchObject({ verdict: "passed", tally: { excused: 1 } });
		const next = h.call<ReportReceipt>("report", change("feat0001b"));
		expect(next.questions[0]).toMatchObject({ how: "decided by rule", state: "decided", answer: "inherited" });
		expect(next.questions[0]?.q).not.toBe(pr.questions[0]?.q);
		expect(next.gate?.verdict).toBe("passed");
	});

	test("loose: a failure the change introduced is a question, and it blocks the change", () => {
		h.call("report", ciReport({ commit: "base0002", n: 10 }));
		const pr = h.call<ReportReceipt>(
			"report",
			ciReport({ commit: "feat0002", branch: "feature", pr: 483, base: "base0002", n: 10, fail: failure }),
		);
		expect(pr.questions[0]).toMatchObject({ how: "new", state: "open" });
		expect(pr.gate).toMatchObject({ verdict: "blocked" });
		expect(h.call<GateStatus>("gate", { change: "pr:483" }).verdict).toBe("blocked");
	});

	test("a decision on one push of a pull request still stands on the next push", () => {
		h.call("report", ciReport({ commit: "base0003", n: 10 }));
		h.call(
			"report",
			ciReport({ commit: "feat0003", branch: "feature", pr: 484, base: "base0003", n: 10, fail: failure }),
		);
		decide(first(queue().items), { is: "flaky" });
		const next = h.call<ReportReceipt>(
			"report",
			ciReport({ commit: "feat0004", branch: "feature", pr: 484, base: "base0003", n: 10, fail: failure }),
		);
		expect(next.questions[0]).toMatchObject({ how: "already decided", answer: "flaky" });
		expect(next.gate?.verdict).toBe("passed");
	});

	test("standard: the same data, but the base failure is only a hint and a person decides", () => {
		const s = harness({ preset: "standard" });
		s.call("report", ciReport({ commit: "base0001", n: 10, fail: failure }));
		const pr = s.call<ReportReceipt>(
			"report",
			ciReport({ commit: "feat0001", branch: "feature", pr: 482, base: "base0001", n: 10, fail: failure }),
		);
		expect(pr.questions[0]).toMatchObject({ how: "new", state: "open" });
		const open = s.call<InboxReply>("inbox", { on: "pr:482" });
		expect((first(open.items).evidence as { hints: string[] }).hints).toContain("fails-on-base");
		s.close();
	});
});

describe("holds", () => {
	test("E8: a flaky excuse expires with no new report: the gate reads pending, and the next occurrence is asked again", () => {
		const fail = { 0: "expected 1, got 2" };
		h.call("report", ciReport({ commit: "1111111a", n: 3, fail }));
		decide(first(queue().items), { is: "flaky" });
		expect(gate("1111111a").verdict).toBe("passed");
		h.advance(15 * 86_400_000);
		const stale = gate("1111111a");
		expect(stale).toMatchObject({
			verdict: "pending",
			stale: true,
			reason: "pending: a decision this run rests on has expired",
		});
		const next = h.call<ReportReceipt>("report", ciReport({ commit: "1111111b", n: 3, fail }));
		expect(next.questions[0]).toMatchObject({ how: "new", state: "open" });
		const asked = first(queue().items);
		const prior = h.app.db.raw
			.query<{ prior: number | null; epoch: number }, []>("SELECT prior, epoch FROM questions WHERE state = 'open'")
			.get();
		expect(prior).toMatchObject({ epoch: 1 });
		expect(prior?.prior).not.toBeNull();
		expect(asked.kind).toBe("failure");
	});

	test("an infrastructure excuse covers the commit it was given for and no other", () => {
		const fail = { 0: "connect ECONNREFUSED 10.0.0.5:5432" };
		h.call("report", ciReport({ commit: "2222222a", n: 3, fail }));
		decide(first(queue().items), { is: "infra" });
		const next = h.call<ReportReceipt>("report", ciReport({ commit: "2222222b", n: 3, fail }));
		expect(next.questions[0]).toMatchObject({ how: "new" });
		expect(next.gate?.verdict).toBe("blocked");
	});
});

describe("who may answer", () => {
	test("loose: an agent advises on a failure and a person decides", () => {
		const agent = h.actor("triage-bot", "agent", ["read", "produce"]);
		h.call("report", ciReport({ commit: "3333333a", n: 3, fail: { 0: "expected 1, got 2" } }));
		const q = first(queue().items);
		const advised = decide(q, { is: "defect" }, agent);
		expect(advised).toMatchObject({ status: "advised", needs: "one member who is not an agent" });
		expect(gate("3333333a").verdict).toBe("blocked");
		const shown = first(queue().items);
		expect(shown.advice).toEqual([{ by: "triage-bot", kind: "agent", answer: { is: "defect" }, reason: null }]);
		expect(decide(shown, { is: "defect" })?.status).toBe("decided");
	});

	test("a pipeline cannot answer, and a reader cannot answer", () => {
		const ci = h.actor("github-actions", "ci", ["read", "record"]);
		const reader = h.actor("pm", "human", ["read"]);
		h.call("report", ciReport({ commit: "3333333b", n: 3, fail: { 0: "expected 1, got 2" } }), ci);
		const q = first(queue().items);
		// Neither may call `decide` at all: a pipeline records, a reader reads.
		for (const actor of [ci, reader]) {
			const refused = h.raw("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "flaky" } }, actor);
			expect(refused).toMatchObject({ ok: false, error: { code: "forbidden" } });
		}
	});

	test("an answer the kind does not have is invalid and says which are allowed", () => {
		h.call("report", ciReport({ commit: "3333333c", n: 3, fail: { 0: "expected 1, got 2" } }));
		const reply = decide(first(queue().items), { is: "accept" });
		expect(reply?.status).toBe("invalid");
		expect(reply?.needs).toContain("defect");
	});
});

describe("basis", () => {
	test("E3: a linked test is assumed at the current version; an annotation with a version is exact; neither is guessed", () => {
		h.call("propose", { edits: [{ op: "create", outline: "Coupon applies\n  Apply SAVE10 > Total is 90" }] });
		const s = harness({ preset: "standard", unlinked: "ask" });
		s.call("propose", { edits: [{ op: "create", outline: "Coupon applies\n  Apply SAVE10 > Total is 90" }] });
		s.call("report", ciReport({ commit: "4444444a", n: 2 }));
		const map = first(s.call<InboxReply>("inbox", { kind: "map" }).items);
		const tests = (map.evidence as { tests: { t: string }[] }).tests;
		expect(tests).toHaveLength(2);
		const linked = s.call<{ status: string }[]>("decide", {
			q: map.q,
			onEvidence: map.evidenceHash,
			answer: { is: "link", pairs: [[first(tests).t, "C-1"]] },
		});
		expect(linked[0]?.status).toBe("decided");
		const next = s.call<ReportReceipt>("report", ciReport({ commit: "4444444b", n: 2 }));
		expect(next.basis).toEqual({ exact: 0, assumed: 1, unresolved: 1 });
		const annotated = s.call<ReportReceipt>("report", {
			target: { commit: "4444444c", branch: "main" },
			results: [{ test: { key: "tests/x.spec.ts::coupon @C-1@v1", name: "coupon @C-1@v1" }, outcome: "pass" }],
		});
		expect(annotated.basis).toEqual({ exact: 1, assumed: 0, unresolved: 0 });
		const wrong = s.call<ReportReceipt>("report", {
			target: { commit: "4444444d", branch: "main" },
			results: [{ test: { key: "tests/x.spec.ts::coupon @C-1@v9", name: "coupon @C-1@v9" }, outcome: "pass" }],
		});
		// An automated result is a fact about the commit whatever it claims about a case: the claim is refused, the
		// outcome is kept with no case, and the reason comes back.
		expect(wrong.rejected).toEqual([]);
		expect(wrong.declined).toEqual([{ index: 0, reason: "C-1 has no version 9: recorded with no case" }]);
		expect(wrong.basis).toEqual({ exact: 0, assumed: 0, unresolved: 1 });
		s.close();
	});
});

describe("the horizon", () => {
	test("C5: accepting an upload turns a green gate pending until it is applied; a stale green is never served", () => {
		h.call("report", ciReport({ commit: "5555555a", n: 5 }));
		expect(gate("5555555a").verdict).toBe("passed");

		const inTx = <T>(fn: (ctx: ReturnType<typeof makeCtx>) => T): T =>
			h.app.db.transaction(() => {
				const project = findProject(h.app.db, "scratch");
				if (!project) throw new Error("no project");
				const ctx = makeCtx(h.app, project, h.owner, true);
				const out = fn(ctx);
				stampSeq(ctx);
				return out;
			});
		const { batch } = inTx((ctx) =>
			acceptReport(ctx, ciReport({ commit: "5555555a", n: 5, fail: { 1: "expected 1, got 2" }, attempt: 2 })),
		);
		const between = gate("5555555a");
		expect(between).toMatchObject({
			verdict: "pending",
			stale: true,
			reason: "pending: 1 report accepted and not yet applied",
		});

		inTx((ctx) => processBatch(ctx, batch.id));
		expect(gate("5555555a")).toMatchObject({ verdict: "blocked", stale: false });
	});
});

describe("work the server does on its own", () => {
	// The recovery step on its own. `test/restart.test.ts` kills a real server in the middle of a report.
	test("a report that was accepted and never applied is applied by recovery, once; the gate was pending meanwhile", () => {
		h.call("report", ciReport({ commit: "6666666a", n: 4 }));
		h.app.db.transaction(() => {
			const project = findProject(h.app.db, "scratch");
			if (!project) throw new Error("no project");
			const ctx = makeCtx(h.app, project, h.owner, true);
			acceptReport(ctx, ciReport({ commit: "6666666a", n: 4, fail: { 0: "expected 1, got 2" }, attempt: 2 }));
			stampSeq(ctx);
		});
		// ...the process dies here. Nothing is lost: the batch is staged, and the gate does not claim green.
		expect(gate("6666666a").verdict).toBe("pending");
		expect(recoverAccepted(h.app)).toBe(1);
		expect(gate("6666666a")).toMatchObject({ verdict: "blocked", stale: false });
		expect(recoverAccepted(h.app)).toBe(0);
	});

	// Issue #123. The server read the id of the policy's actor once, when it started, and an import replaces the
	// actors. In an archive from an instance whose first actor is a person, `policy` has that person's id plus one.
	test("the minute job acts as the policy after an import gave the policy's actor another id", async () => {
		let now = 1_800_000_000_000;
		const directories: string[] = [];
		const instances: Instance[] = [];
		const configFor = async (): Promise<Config> => {
			const directory = await mkdtemp(join(tmpdir(), "mainworthy-minute-"));
			directories.push(directory);
			return defaultConfig({
				MAINWORTHY_DATA: directory,
				MAINWORTHY_PORT: "0",
				MAINWORTHY_OWNER: "robin",
				MAINWORTHY_MODE: "local",
			});
		};
		const boot = (config: Config): Instance => {
			const instance = start(config, (app, owner) => ({ ui: null, routes: archiveRoutes(app, owner) }), {
				readers: 0,
				now: () => now,
			});
			instances.push(instance);
			return instance;
		};
		const actors = (instance: Instance) =>
			instance.app.db.raw.query<{ id: number; name: string }, []>("SELECT id, name FROM actors ORDER BY id").all();
		const client = (instance: Instance) => new Client({ url: instance.url, token: undefined, project: "scratch" });
		const asked = z.object({
			counts: z.object({ open: z.number() }),
			items: z.array(z.object({ q: z.string(), evidenceHash: z.string() })),
		});
		try {
			const from = await configFor();
			const seed = openApp(from);
			seed.db.exec(
				"INSERT INTO orgs (name, created_at) VALUES ('default', 0); INSERT INTO actors (org, kind, name, created_at) VALUES (1, 'human', 'robin', 0)",
			);
			seed.close();
			const source = boot(from);
			const target = boot(await configFor());
			expect(actors(source)).toEqual([
				{ id: 1, name: "robin" },
				{ id: 2, name: "policy" },
			]);
			expect(actors(target)).toEqual([
				{ id: 1, name: "policy" },
				{ id: 2, name: "robin" },
			]);

			await client(source).call("report", ciReport({ commit: "8888888a", n: 3, fail: { 0: "expected 1, got 2" } }));
			const question = first(asked.parse(await client(source).call("inbox", {})).items);
			await client(source).call("decide", {
				q: question.q,
				onEvidence: question.evidenceHash,
				answer: { is: "flaky" },
			});
			const archive = await client(source).request("/api/export");
			const imported = await client(target).request("/api/import", { method: "POST", body: await archive.text() });
			expect(imported.status).toBe(200);
			expect(actors(target)).toEqual(actors(source));
			expect(asked.parse(await client(target).call("inbox", {})).counts.open).toBe(0);

			const published: { op: string; actor: string }[] = [];
			target.app.subscribe((event) => published.push({ op: event.op, actor: event.actor }));
			now += 15 * 86_400_000;
			await target.minute();
			expect(asked.parse(await client(target).call("inbox", {})).counts.open).toBe(1);
			// What every open page is told about the change names the policy, not the person who now has the id the
			// policy had when the server started. The row that records that the excuse ran out is the policy's too.
			expect(published).toEqual([{ op: "sweep", actor: "policy" }]);
			const ranOut = target.app.db.raw
				.query<{ answer: string; signers: string }, []>(
					"SELECT answer, signers FROM decisions WHERE kind = 'failure' ORDER BY id DESC LIMIT 1",
				)
				.get();
			expect(ranOut).toEqual({
				answer: '{"is":"expired"}',
				signers: '[{"by":2,"clause":"hold-expired","policy":1,"reason":null}]',
			});
		} finally {
			for (const instance of instances) await instance.stop();
			for (const directory of directories) await rm(directory, { recursive: true, force: true });
		}
	});

	test("the sweep reopens a question whose excuse ran out, so it is visible before the next report", () => {
		h.call("report", ciReport({ commit: "7777777a", n: 3, fail: { 0: "expected 1, got 2" } }));
		decide(first(queue().items), { is: "flaky" });
		expect(queue().counts.open).toBe(0);
		const rule = h.app.db.raw.query<{ id: number }, []>("SELECT id FROM actors WHERE kind = 'rule'").get()?.id ?? 0;
		expect(sweep(h.app, rule)).toBe(0); // still holds
		h.advance(15 * 86_400_000);
		expect(sweep(h.app, rule)).toBe(1);
		expect(queue().counts.open).toBe(1);
		expect(gate("7777777a")).toMatchObject({ verdict: "blocked", stale: false });
		// The expired decision stays in the ledger, followed by the row that records that it ran out.
		expect(count("decisions WHERE kind = 'failure'")).toBe(2);
		expect(count("excuses")).toBe(0);
	});
});

describe("what a failure question says leaving it costs", () => {
	// The sentence under a question's title (`stakes`) is held to what the server does with the same question.
	const said = (item: InboxReply["items"][number]) =>
		stakes({ kind: item.kind, blocks: item.blocks, facts: new Set(item.evidence.facts as string[]) });
	const held = "While this is open, no gate that counts the unexplained failure passes.";

	test("while a failure question is open, no gate that counts the failure passes, whether or not it names a run", () => {
		h.call("report", ciReport({ commit: "stakes001", n: 1, fail: { 0: "expected 90, got 100" } }));
		h.call("report", ciReport({ commit: "stakes002", branch: "fix", pr: 7, n: 1, fail: { 0: "timed out" } }));
		const [change, trunk] = queue().items;
		if (!change || !trunk) throw new Error("two failure questions expected");
		expect(said(change)).toBe(`Listed as blocking ${change.blocks.join(", ")}. ${held}`);
		expect(gate("stakes002").verdict).toBe("blocked");
		// A failure on the line names no run under `loose`, and its commit's gate does not pass all the same.
		expect(trunk.blocks).toEqual([]);
		expect(said(trunk)).toBe(held);
		expect(gate("stakes001").verdict).toBe("blocked");
		// Beside a failure a person called a defect, the gate reads failed: still not passed.
		h.call("report", {
			...ciReport({ commit: "stakes001", n: 1, fail: { 0: "another cause entirely" }, file: "tests/other.spec.ts" }),
			job: "other",
		});
		const other = first(queue().items.filter((item) => item.title.includes("another cause")));
		decide(other, { is: "defect" });
		expect(gate("stakes001").verdict).not.toBe("passed");
	});

	test("the sentence is true of a failure no gate counts: an agent's, on a commit whose gate passes", () => {
		const agent = h.actor("runner", "agent", ["read", "produce"]);
		h.call("report", ciReport({ commit: "stakes003", n: 1, file: "tests/passes.spec.ts" }));
		h.call(
			"report",
			ciReport({ commit: "stakes003", n: 1, file: "tests/agent.spec.ts", fail: { 0: "agent saw it" } }),
			agent,
		);
		expect(said(first(queue().items))).toBe(held);
		expect(gate("stakes003")).toMatchObject({ verdict: "passed", open: [] });
	});

	test("a listed run can pass again while the question stays open for a newer commit: it is listed, not said to be blocked", () => {
		// The same test fails in job `one` on two commits of a pull request, and the older commit's job is run again.
		for (const commit of ["stakes005", "stakes006"])
			h.call("report", { ...ciReport({ commit, branch: "fix", pr: 9, n: 1, fail: { 0: "timed out" } }), job: "one" });
		h.call("report", { ...ciReport({ commit: "stakes005", branch: "fix", pr: 9, n: 1 }), job: "one", attempt: 2 });
		const asked = first(queue().items);
		expect(gate("stakes005").verdict).toBe("passed");
		expect(gate("stakes006").verdict).toBe("blocked");
		expect(said(asked)).toStartWith("Listed as blocking ");
		expect(said(asked)).toEndWith(held);
	});

	test("a failing result stops counting when it is replaced, and not when a pass is reported beside it", () => {
		// The guide's account of how a block ends without an answer, which the sentence leaves to it.
		h.call("propose", { edits: [{ op: "create", outline: "Coupon applies\n  Apply SAVE10 > Total is 90" }] });
		const run = h.call<{ run: string }>("plan", { name: "Release check", select: { cases: ["C-1"] } }).run;
		const failed = h.call<ReportReceipt>("report", {
			run,
			results: [{ test: { case: "C-1" }, outcome: "fail", failure: { message: "expected 90, got 100" } }],
		});
		h.call("report", { run, results: [{ test: { case: "C-1" }, outcome: "pass" }] });
		expect(h.call<GateStatus>("gate", { run }).verdict).toBe("blocked");
		// A result that corrects it replaces it, whatever its outcome: skipped, the run waits for a result again.
		h.call("report", { run, results: [{ test: { case: "C-1" }, outcome: "skip", corrects: failed.results[0] }] });
		expect(h.call<GateStatus>("gate", { run }).verdict).not.toBe("blocked");
		// On a commit: a newer attempt of another job does not replace it, nor does a newer attempt of the same
		// job in which the test was skipped. A newer attempt of the same job that passes does.
		h.call("report", { ...ciReport({ commit: "stakes004", n: 1, fail: { 0: "timed out" } }), job: "one" });
		h.call("report", { ...ciReport({ commit: "stakes004", n: 1 }), job: "two", attempt: 2 });
		expect(gate("stakes004").verdict).toBe("blocked");
		const again = ciReport({ commit: "stakes004", n: 1 });
		h.call("report", {
			...again,
			job: "one",
			attempt: 2,
			results: again.results.map((result) => ({ test: result.test, outcome: "skip" })),
		});
		expect(gate("stakes004").verdict).toBe("blocked");
		h.call("report", { ...again, job: "one", attempt: 3 });
		expect(gate("stakes004").verdict).toBe("passed");
	});
});

describe("a question that gains occurrences while open", () => {
	test("keeps its policy facts and its latest target, so the answer lands under the right clause and hold", () => {
		const fail = { 0: "connect ECONNREFUSED 10.0.0.5:5432" };
		h.call("report", ciReport({ commit: "8888888a", branch: "feature", pr: 9, n: 3, fail }));
		h.call("report", ciReport({ commit: "8888888b", branch: "feature", pr: 9, n: 3, fail })); // attaches to the open question
		const q = first(queue().items);
		expect(q.seen.count).toBe(2);
		expect(q.blocks).toHaveLength(2); // both pushes' runs wait on it
		expect((q.evidence as { facts: string[] }).facts).toContain("scope:change");
		decide(q, { is: "infra" });
		expect(gate("8888888b").verdict).toBe("passed");
		const signer = h.app.db.raw
			.query<{ signers: string }, []>("SELECT signers FROM decisions WHERE kind = 'failure'")
			.get();
		expect(JSON.parse(signer?.signers ?? "[]")[0].clause).toBe("failure-change");
		// infrastructure is excused for the build it was given on (the latest), so the next push asks again
		const next = h.call<ReportReceipt>(
			"report",
			ciReport({ commit: "8888888c", branch: "feature", pr: 9, n: 3, fail }),
		);
		expect(next.questions[0]).toMatchObject({ how: "new" });
	});
});

describe("which answers apply", () => {
	test("a trunk failure cannot be called inherited or mistaken; a change's failure can be inherited", () => {
		h.call("report", ciReport({ commit: "9999999a", n: 2, fail: { 0: "expected 1, got 2" } }));
		const trunk = first(queue().items);
		expect(trunk.answers).toEqual(["defect", "test", "expected", "flaky", "infra"]);
		expect(decide(trunk, { is: "inherited" })).toMatchObject({ status: "invalid" });
		expect(decide(trunk, { is: "mistaken" })?.needs).toContain("does not apply");
		h.call(
			"report",
			ciReport({ commit: "9999999b", branch: "feature", pr: 12, n: 2, fail: { 1: "expected 3, got 4" } }),
		);
		const change = queue().items.find((item) => item.about.includes("pr:12"));
		expect(change?.answers).toEqual(["defect", "test", "expected", "flaky", "infra", "inherited"]);
	});
});

describe("a change that ends", () => {
	test("a fast-forward landing moves every environment into trunk without carrying pull request answers", () => {
		const commit = "landed001";
		const report = ciReport({ commit, branch: "feature", pr: 68, n: 1, fail: { 0: "same cause" } });
		h.call("report", { ...report, target: { ...report.target, env: "one" } });
		h.call("report", { ...report, target: { ...report.target, env: "two" } });
		const asked = first(queue().items);
		decide(asked, { is: "flaky" });
		const before = gate(commit);
		expect(before.verdict).toBe("passed");
		const decisions = h.app.db.raw.query("SELECT * FROM decisions").all();
		h.call("change", { change: "pr:68", state: "merged", landing: { commit, branch: "main" } });
		expect(h.app.db.raw.query("SELECT DISTINCT line, branch, change FROM targets").all()).toEqual([
			{ line: "trunk", branch: "main", change: null },
		]);
		expect(gate(commit)).toMatchObject({ run: before.run, verdict: "blocked", tally: { unexplained: 2, excused: 0 } });
		expect(first(queue().items).evidence.scope).toBe("line:trunk@acme/web");
		expect(h.app.db.raw.query("SELECT * FROM decisions").all()).toEqual(decisions);
		expect(h.app.db.raw.query("SELECT before_scope, after_scope, actor FROM scope_moves").all()).toEqual([
			{ before_scope: "change:1", after_scope: "line:trunk@acme/web", actor: h.owner.id },
		]);
		expect(h.call("change", { change: "pr:68", state: "merged", landing: { commit, branch: "main" } })).toMatchObject({
			already: true,
		});
		expect(count("scope_moves")).toBe(1);
		expect(h.call<InboxReply>("inbox", { state: "decided" }).items.map((q) => q.q)).toContain(asked.q);
		decide(first(queue().items), { is: "defect" });
		expect(h.call<GateStatus>("gate", { change: "pr:68" })).toMatchObject({ run: before.run, verdict: "failed" });
		h.call("report", {
			...report,
			attempt: 2,
			target: { ...report.target, branch: "main", pr: undefined, env: "three" },
		});
		expect(gate(commit)).toMatchObject({ run: before.run, verdict: "failed", tally: { attributed: 3, excused: 0 } });
		expect(count("runs")).toBe(1);
	});

	test.each([true, false])("a merged change ignores code host head observations, landing=%s", (landing) => {
		const old = ciReport({ commit: "landold01", branch: "feature", pr: 68, n: 1 });
		const landed = ciReport({ commit: "landnew01", branch: "feature", pr: 68, n: 1, fail: { 0: "defect" } });
		h.call("report", old);
		h.call("report", landed);
		h.call("change", {
			change: "pr:68",
			state: "merged",
			...(landing ? { landing: { commit: "landnew01", branch: "main" } } : {}),
		});
		const trunkGate = gate("landnew01");
		expect(trunkGate.verdict).toBe("blocked");
		expect(queue().items.map((q) => q.evidence.scope)).toEqual(landing ? ["line:trunk@acme/web"] : []);

		const reset = { ...landed, job: "head-after-landing", target: { ...landed.target, head: "landold01" } };
		expect(h.call<ReportReceipt>("report", reset).fresh).toBe(true);
		expect(h.call<GateStatus>("gate", { change: "pr:68" })).toMatchObject({
			run: trunkGate.run,
			verdict: "blocked",
		});
		expect(h.app.db.raw.query("SELECT head_sha FROM changes WHERE key = 'pr:68'").get()).toEqual({
			head_sha: "landnew01",
		});
		expect(h.app.db.raw.query("SELECT ended FROM change_ends").all()).toEqual([{ ended: "merged" }]);
		h.call("report", { ...landed, job: "late-after-reset", target: { ...landed.target, env: "two" } });
		expect(h.call<GateStatus>("gate", { change: "pr:68" }).run).toBe(trunkGate.run);
		expect(h.app.db.raw.query("SELECT line, branch, change FROM targets WHERE commit_sha = 'landnew01'").all()).toEqual(
			[
				{ line: landing ? "trunk" : "change", branch: landing ? "main" : "feature", change: landing ? null : 1 },
				{ line: landing ? "trunk" : "change", branch: landing ? "main" : "feature", change: landing ? null : 1 },
			],
		);
		expect(gate("landnew01")).toMatchObject({ run: trunkGate.run, verdict: "blocked", tally: { unexplained: 3 } });
		expect(queue().items.map((q) => q.evidence.scope)).toEqual(landing ? ["line:trunk@acme/web"] : []);
		expect(count("scope_moves")).toBe(landing ? 1 : 0);
		h.call("report", { ...landed, job: "head-forward", target: { ...landed.target, head: "unseen01" } });
		expect(h.call<ReportReceipt>("report", reset).fresh).toBe(false);
		expect(h.call<GateStatus>("gate", { change: "pr:68" })).toMatchObject({ run: trunkGate.run, verdict: "blocked" });
	});

	test.each([undefined, "linux"])(
		"a landing selects an unreported head before its failing CI arrives, env=%s",
		(env) => {
			h.call("report", ciReport({ commit: "headX0001", branch: "feature", pr: 12, n: 1 }));
			const merge = { change: "pr:12", state: "merged", landing: { commit: "headY0001", branch: "main" } };
			h.call("change", merge);
			expect(h.call<GateStatus>("gate", { change: "pr:12" })).toMatchObject({ verdict: "pending", run: null });
			expect(changes()).toMatchObject([{ key: "pr:12", head: "headY0001", state: "merged", verdict: "pending" }]);
			expect(h.call("change", merge)).toMatchObject({ already: true });
			const report = ciReport({
				commit: "headY0001",
				branch: "feature",
				pr: 12,
				n: 1,
				fail: { 0: "final push fails" },
			});
			h.call("report", { ...report, target: { ...report.target, env } });
			const failed = gate("headY0001");
			expect(failed.verdict).toBe("blocked");
			expect(h.call<GateStatus>("gate", { change: "pr:12" })).toMatchObject({ run: failed.run, verdict: "blocked" });
			const asked = first(queue().items);
			expect(asked.evidence.scope).toBe("line:trunk@acme/web");
			expect(h.call("change", merge)).toMatchObject({ already: true });
			expect(queue().items.map((q) => q.q)).toEqual([asked.q]);
			h.call("report", { ...report, target: { ...report.target, env: "mac", head: "headX0001" } });
			expect(
				h.app.db.raw.query("SELECT DISTINCT line, branch, change FROM targets WHERE commit_sha = 'headY0001'").all(),
			).toEqual([{ line: "trunk", branch: "main", change: null }]);
			expect(h.call<GateStatus>("gate", { change: "pr:12" })).toMatchObject({ run: failed.run, verdict: "blocked" });
			expect(queue().items.map((q) => q.evidence.scope)).toEqual(["line:trunk@acme/web"]);
		},
	);

	test("a landing selects an older commit than the recorded head", () => {
		h.call("report", ciReport({ commit: "older0012", branch: "feature", pr: 12, n: 1, fail: { 0: "older failure" } }));
		h.call("report", ciReport({ commit: "newer0012", branch: "feature", pr: 12, n: 1 }));
		expect(h.call<GateStatus>("gate", { change: "pr:12" }).verdict).toBe("passed");
		h.call("change", { change: "pr:12", state: "merged", landing: { commit: "older0012", branch: "main" } });
		expect(changes()).toMatchObject([{ key: "pr:12", head: "older0012", state: "merged", verdict: "blocked" }]);
		expect(h.call<GateStatus>("gate", { change: "pr:12" })).toMatchObject({
			run: gate("older0012").run,
			verdict: "blocked",
		});
		expect(queue().items.map((q) => q.evidence.scope)).toEqual(["line:trunk@acme/web"]);
		h.call("report", { ...ciReport({ commit: "newer0012", branch: "feature", pr: 12, n: 1 }), attempt: 2 });
		expect(h.call<GateStatus>("gate", { change: "pr:12" })).toMatchObject({
			run: gate("older0012").run,
			verdict: "blocked",
		});
	});

	test("a merge with another hash leaves the original commit's scope and decisions alone", () => {
		h.call("report", ciReport({ commit: "landed002", branch: "feature", pr: 68, n: 1, fail: { 0: "same cause" } }));
		decide(first(queue().items), { is: "flaky" });
		h.call("change", { change: "pr:68", state: "merged", landing: { commit: "merge0002", branch: "main" } });
		expect(gate("landed002").verdict).toBe("passed");
		expect(h.app.db.raw.query("SELECT DISTINCT line FROM targets WHERE commit_sha = 'landed002'").all()).toEqual([
			{ line: "change" },
		]);
		expect(changes()).toMatchObject([{ key: "pr:68", head: "merge0002", state: "merged", verdict: "pending" }]);
		expect(gate("merge0002")).toMatchObject({ verdict: "pending", run: null });
	});

	test("a landing received after the end still moves the head, and reopening does not move it back", () => {
		h.call("report", ciReport({ commit: "landed003", branch: "feature", pr: 68, n: 1, fail: { 0: "same cause" } }));
		h.call("change", { change: "pr:68", state: "merged" });
		h.call("change", { change: "pr:68", state: "merged", landing: { commit: "landed003", branch: "main" } });
		expect(first(queue().items).evidence.scope).toBe("line:trunk@acme/web");
		h.call("change", { change: "pr:68", state: "open" });
		expect(queue().items.map((q) => q.evidence.scope)).toEqual(["line:trunk@acme/web"]);
	});

	test("a commit first reported by hash gains its branch scope and keeps one exact gate", () => {
		const report = ciReport({ commit: "placed068", branch: "feature", n: 1, fail: { 0: "same cause" } });
		h.call("report", { ...report, target: { commit: report.target.commit, repo: report.target.repo } });
		decide(first(queue().items), { is: "flaky" });
		const before = gate("placed068");
		h.call("report", report);
		expect(gate("placed068")).toMatchObject({ run: before.run, verdict: "blocked" });
		expect(first(queue().items).about).toContain("branch:feature");
		expect(count("runs")).toBe(1);
	});

	test("a typed failure keeps its open question when CI later names the commit's branch", () => {
		h.call("propose", { edits: [{ op: "create", outline: "Checkout works" }] });
		const tester = h.actor("tester", "human", ["read", "produce"]);
		const ci = h.actor("ci", "ci", ["read", "record"]);
		const run = h.call<{ run: string }>("plan", {
			name: "Dispute",
			select: {},
			accepts: { commit: "typed0068" },
		});
		h.call(
			"report",
			{
				run: run.run,
				results: [{ test: { case: "C-1" }, outcome: "fail", failure: { message: "expected 10, got 12" } }],
			},
			tester,
		);
		const asked = first(queue().items.filter((q) => q.kind === "failure"));
		h.call(
			"report",
			{
				target: { commit: "typed0068", branch: "main" },
				results: [{ test: { key: "checkout" }, outcome: "pass", annotation: { case: "C-1", version: 1 } }],
			},
			ci,
		);
		const disputed = first(queue().items.filter((q) => q.kind === "failure"));
		expect(disputed).toMatchObject({ q: asked.q, evidence: { hints: ["disputed"], message: "expected 10, got 12" } });
		expect(disputed.answers).toEqual(["defect", "test", "expected", "flaky", "infra", "inherited", "mistaken"]);
		expect(h.call<GateStatus>("gate", { run: run.run })).toMatchObject({ verdict: "blocked", open: [asked.q] });
		expect(count("scope_moves")).toBe(0);
	});

	test("a typed failure keeps its answer when CI later names the commit's branch", () => {
		h.call("propose", { edits: [{ op: "create", outline: "Checkout works" }] });
		const run = h.call<{ run: string }>("plan", {
			name: "Answered",
			select: {},
			accepts: { commit: "typed0069" },
		});
		h.call("report", {
			run: run.run,
			results: [{ test: { case: "C-1" }, outcome: "fail", failure: { message: "same cause" } }],
		});
		const asked = first(queue().items.filter((q) => q.kind === "failure"));
		expect(decide(asked, { is: "flaky" })?.status).toBe("decided");
		const decisions = h.app.db.raw.query("SELECT * FROM decisions WHERE kind = 'failure'").all();
		h.call("report", {
			target: { commit: "typed0069", branch: "main" },
			results: [
				{
					test: { key: "checkout" },
					outcome: "fail",
					failure: { message: "same cause" },
					annotation: { case: "C-1", version: 1 },
				},
			],
		});
		expect(h.call<{ state: string }[]>("get", { refs: [asked.q] })[0]?.state).toBe("decided");
		expect(h.app.db.raw.query("SELECT * FROM decisions WHERE kind = 'failure'").all()).toEqual(decisions);
		expect(h.call<GateStatus>("gate", { run: run.run })).toMatchObject({ verdict: "passed", tally: { excused: 1 } });
		expect(queue().items.filter((q) => q.kind === "failure")).toEqual([]);
		expect(count("scope_moves")).toBe(0);
	});

	test("a landing uses trunk's existing answer while older pull request commits keep their answer", () => {
		const fail = { 0: "same cause" };
		h.call("report", ciReport({ commit: "trunk0068", n: 1, fail }));
		decide(first(queue().items), { is: "defect" });
		h.call("report", ciReport({ commit: "older0068", branch: "feature", pr: 68, n: 1, fail }));
		decide(first(queue().items), { is: "flaky" });
		h.call("report", ciReport({ commit: "newer0068", branch: "feature", pr: 68, n: 1, fail }));
		expect(gate("newer0068").verdict).toBe("passed");
		h.call("change", { change: "pr:68", state: "merged", landing: { commit: "newer0068", branch: "main" } });
		expect(gate("newer0068").verdict).toBe("failed");
		expect(gate("older0068").verdict).toBe("passed");
		expect(queue().items).toEqual([]);
	});

	test("a landing recomputes a planned run and replaces its old failure question", () => {
		h.call("propose", { edits: [{ op: "create", outline: "Checkout works" }] });
		h.call("report", {
			target: { commit: "planned68", repo: "acme/web", branch: "feature", pr: 68 },
			results: [
				{
					test: { key: "checkout" },
					annotation: { case: "C-1", version: 1 },
					outcome: "fail",
					failure: { message: "same cause" },
				},
			],
		});
		const planned = h.call<{ run: string }>("plan", { name: "Release", select: {}, accepts: { commit: "planned68" } });
		const asked = first(queue().items);
		h.call("change", { change: "pr:68", state: "merged", landing: { commit: "planned68", branch: "main" } });
		const again = first(queue().items);
		expect(again.q).not.toBe(asked.q);
		expect(again.evidence.scope).toBe("line:trunk@acme/web");
		expect(h.call<GateStatus>("gate", { run: planned.run })).toMatchObject({ verdict: "blocked", open: [again.q] });
		expect(h.call<{ state: string }[]>("get", { refs: [asked.q] })[0]?.state).toBe("dissolved");
	});

	test("landing metadata is refused for an open change or an agent and moves only its repository", () => {
		const report = ciReport({ commit: "repos0068", branch: "feature", pr: 68, n: 1, fail: { 0: "same cause" } });
		h.call("report", report);
		h.call("report", { ...report, target: { ...report.target, repo: "example/other" } });
		const landing = { commit: "repos0068", branch: "main" };
		expect(h.raw("change", { change: "pr:68", state: "open", landing })).toMatchObject({
			ok: false,
			error: { code: "invalid" },
		});
		const agent = h.actor("reviewer", "agent", ["read", "produce"]);
		expect(h.raw("change", { change: "pr:68", state: "merged", landing }, agent)).toMatchObject({
			ok: false,
			error: { code: "forbidden" },
		});
		expect(count("scope_moves")).toBe(0);
		h.call("change", { change: "pr:68", state: "merged", landing });
		expect(h.app.db.raw.query("SELECT repo, line FROM targets ORDER BY id").all()).toEqual([
			{ repo: "acme/web", line: "trunk" },
			{ repo: "example/other", line: "change" },
		]);
		expect(count("scope_moves")).toBe(1);
	});

	type Ended = { change: string; state: string; questions: string[]; already: boolean };
	const end = (change: string, state: "merged" | "closed" | "open", as = h.owner) =>
		h.call<Ended>("change", { change, state }, as);
	const changes = () =>
		h.call<{ items: { key: string; head: string | null; state: string; verdict: string | null }[] }>("find", {
			in: "changes",
		}).items;
	/** A pull request whose only commit fails one test, and the question about it. */
	const failingPull = (pr = 12, commit = "ended0001") => {
		h.call("report", ciReport({ commit, branch: "fix", pr, n: 2, fail: { 0: "expected 90, got 100" } }));
		const asked = queue().items.find((item) => item.about.includes(`pr:${pr}`));
		if (!asked) throw new Error("the failing pull request raised no question");
		return asked;
	};

	test("its unanswered failures are no longer asked about, and nothing else about it changes", () => {
		const asked = failingPull();
		expect(asked.blocks).toHaveLength(1);
		expect(end("pr:12", "merged")).toEqual({ change: "pr:12", state: "merged", questions: [asked.q], already: false });
		expect(queue().counts.open).toBe(0);
		expect(h.call<{ state: string }[]>("get", { refs: [asked.q] })[0]?.state).toBe("dissolved");
		expect(changes()).toMatchObject([{ key: "pr:12", state: "merged", verdict: "blocked" }]);
		// The commit's own verdict is history: it failed, nobody explained it, and nobody is asked now.
		expect(gate("ended0001")).toMatchObject({ verdict: "blocked", open: [] });
		// Saying it again changes nothing about the change or its questions.
		expect(end("PR:12", "merged")).toEqual({ change: "pr:12", state: "merged", questions: [], already: true });
	});

	test.each([true, false])("a merged change keeps its head after another commit reports, landing=%s", (landing) => {
		failingPull();
		h.call("change", {
			change: "pr:12",
			state: "merged",
			...(landing ? { landing: { commit: "ended0001", branch: "main" } } : {}),
		});
		const later = h.call<ReportReceipt>("report", ciReport({ commit: "ended0002", branch: "fix", pr: 12, n: 2 }));
		expect(later.counts).toMatchObject({ total: 2, pass: 2 });
		expect(later.questions).toEqual([]);
		expect(gate("ended0002").verdict).toBe("passed");
		expect(changes()).toMatchObject([{ key: "pr:12", head: "ended0001", state: "merged", verdict: "blocked" }]);
		expect(h.call<GateStatus>("gate", { change: "pr:12" })).toMatchObject({
			run: gate("ended0001").run,
			verdict: "blocked",
		});
		h.call("report", ciReport({ commit: "ended0001", branch: "fix", pr: 12, n: 2, attempt: 2 }));
		expect(changes()).toMatchObject([{ key: "pr:12", head: "ended0001", state: "merged", verdict: "passed" }]);
		expect(queue().counts.open).toBe(0);
	});

	test("a closed unmerged change follows later reports and asks about its latest head when reopened", () => {
		failingPull();
		end("pr:12", "closed");
		h.call("report", ciReport({ commit: "ended0002", branch: "fix", pr: 12, n: 2, fail: { 1: "new failure" } }));
		expect(changes()).toMatchObject([{ key: "pr:12", head: "ended0002", state: "closed", verdict: "blocked" }]);
		expect(queue().counts.open).toBe(0);
		const reopened = end("pr:12", "open");
		expect(reopened.questions).toHaveLength(1);
		expect(h.call<GateStatus>("gate", { change: "pr:12" })).toMatchObject({
			run: gate("ended0002").run,
			verdict: "blocked",
			open: reopened.questions,
		});
	});

	test("a closed unmerged change follows a code host head observation", () => {
		h.call("report", ciReport({ commit: "ended0001", branch: "fix", pr: 12, n: 1 }));
		failingPull(12, "ended0002");
		end("pr:12", "closed");
		const old = ciReport({ commit: "ended0001", branch: "fix", pr: 12, n: 1, job: "observe-reset" });
		expect(h.call<ReportReceipt>("report", { ...old, target: { ...old.target, head: "ended0001" } }).fresh).toBe(true);
		expect(changes()).toMatchObject([{ key: "pr:12", head: "ended0001", state: "closed", verdict: "passed" }]);
		expect(h.call<GateStatus>("gate", { change: "pr:12" })).toMatchObject({
			run: gate("ended0001").run,
			verdict: "passed",
		});
		expect(queue().counts.open).toBe(0);
	});

	test("a merged change follows new reports again after it is explicitly reopened", () => {
		failingPull();
		end("pr:12", "merged");
		end("pr:12", "open");
		h.call("report", ciReport({ commit: "ended0002", branch: "fix", pr: 12, n: 2 }));
		expect(changes()).toMatchObject([{ key: "pr:12", head: "ended0002", state: "open", verdict: "passed" }]);
		expect(queue().counts.open).toBe(0);
	});

	test("the same failure on the line is its own question, and stays", () => {
		failingPull();
		h.call("report", ciReport({ commit: "ended0002", n: 2, fail: { 0: "expected 90, got 100" } }));
		expect(queue().counts.failure).toBe(2);
		end("pr:12", "merged");
		const left = queue().items;
		expect(left.map((item) => item.evidence.scope)).toEqual(["line:trunk@acme/web"]);
		expect(gate("ended0002")).toMatchObject({ verdict: "blocked", open: [first(left).q] });
	});

	test("an answer already given stands, and a finding about the change is still asked", () => {
		const asked = failingPull();
		decide(asked, { is: "flaky" });
		const agent = h.actor("reviewer", "agent", ["read", "produce"]);
		h.call("propose", { edits: [{ op: "create", outline: "Coupon applies\n  Apply SAVE10 > Total is 90" }] });
		h.call(
			"claim",
			{ lens: "review", about: "pr:12", findings: [{ on: "C-1", category: "ambiguous", note: "Say which total" }] },
			agent,
		);
		expect(end("pr:12", "closed").questions).toEqual([]);
		expect(queue().counts).toMatchObject({ open: 1, finding: 1 });
		expect(h.call<InboxReply>("inbox", { state: "decided", kind: "failure" }).items.map((item) => item.q)).toEqual([
			asked.q,
		]);
		expect(gate("ended0001").verdict).toBe("passed");
	});

	test("a report that arrives after the end is recorded and counted, and nobody is asked", () => {
		failingPull();
		end("pr:12", "merged");
		// The pipeline's second shard finishes after the merge, with another failure.
		const late = h.call<ReportReceipt>("report", {
			...ciReport({
				commit: "ended0001",
				branch: "fix",
				pr: 12,
				n: 1,
				fail: { 0: "timed out" },
				file: "tests/late.spec.ts",
			}),
			job: "late",
		});
		expect(late.counts.fail).toBe(1);
		expect(late.questions).toEqual([]);
		expect(queue().counts.open).toBe(0);
		expect(gate("ended0001")).toMatchObject({ verdict: "blocked", open: [] });
		// A newer commit of the ended change is not asked about either.
		h.call(
			"report",
			ciReport({ commit: "ended0003", branch: "fix", pr: 12, n: 2, fail: { 0: "expected 90, got 100" } }),
		);
		expect(queue().counts.open).toBe(0);
	});

	test("a change that is open again is asked about at once, with no new report", () => {
		const asked = failingPull();
		end("pr:12", "closed");
		const reopened = end("pr:12", "open");
		expect(reopened).toMatchObject({ change: "pr:12", state: "open", already: false });
		expect(reopened.questions).toHaveLength(1);
		const again = first(queue().items);
		expect(reopened.questions).toEqual([again.q]);
		expect(again.q).not.toBe(asked.q);
		expect(again.title).toBe(asked.title);
		expect(gate("ended0001")).toMatchObject({ verdict: "blocked", open: [again.q] });
		expect(changes()[0]?.state).toBe("open");
	});

	test("an open planned run that shows the failure still waits for its answer", () => {
		h.call("propose", { edits: [{ op: "create", outline: "Coupon applies\n  Apply SAVE10 > Total is 90" }] });
		h.call("report", {
			target: { commit: "ended0004", repo: "acme/web", branch: "fix", pr: 12 },
			results: [
				{
					test: { key: "tests/coupon.spec.ts::applies", file: "tests/coupon.spec.ts" },
					annotation: { case: "C-1", version: 1 },
					outcome: "fail",
					failure: { message: "expected 90, got 100" },
				},
			],
		});
		const planned = h.call<{ run: string }>("plan", {
			name: "Release check",
			select: { cases: ["C-1"] },
			accepts: { commit: "ended0004", repo: "acme/web" },
		});
		const asked = first(queue().items.filter((item) => item.kind === "failure"));
		expect(asked.about).toContain(planned.run);
		expect(h.call<GateStatus>("gate", { run: planned.run })).toMatchObject({ verdict: "blocked", open: [asked.q] });
		expect(end("pr:12", "merged").questions).toEqual([]);
		expect(queue().items.map((item) => item.q)).toContain(asked.q);
		expect(h.call<GateStatus>("gate", { run: planned.run })).toMatchObject({ verdict: "blocked", open: [asked.q] });
		// Once the run has its answer, nothing is left to ask about the ended change.
		decide(asked, { is: "flaky" });
		expect(queue().counts.failure ?? 0).toBe(0);
	});

	test("an answer taken back or run out after the end asks nobody", () => {
		const asked = failingPull();
		decide(asked, { is: "flaky" });
		end("pr:12", "merged");
		const undone = h.call<{ status: string; needs: string | null }[]>("decide", { undo: asked.q })[0];
		expect(undone?.status).toBe("reopened");
		expect(undone?.needs).toContain("has ended");
		expect(queue().counts.open).toBe(0);
		expect(gate("ended0001")).toMatchObject({ verdict: "blocked", open: [] });
		// A flaky answer that runs out on another ended change does not come back to the queue either.
		const other = failingPull(13, "ended0005");
		decide(other, { is: "flaky" });
		end("pr:13", "closed");
		h.advance(15 * 86_400_000);
		const rule = h.app.db.raw.query<{ id: number }, []>("SELECT id FROM actors WHERE kind = 'rule'").get()?.id ?? 0;
		sweep(h.app, rule);
		expect(queue().counts.open).toBe(0);
	});

	test("an archive does not say which changes ended: after an import each is open, and what was closed stays closed", () => {
		const asked = failingPull();
		end("pr:12", "merged");
		const chunks: string[] = [];
		exportArchive(h.app.db, (chunk) => chunks.push(chunk));
		expect(chunks.join("")).not.toContain("change_ends");
		const other = new Db(":memory:");
		try {
			migrate(other, ":memory:");
			importArchive(other, linesOf(chunks.join("")));
			expect(other.raw.query("SELECT count(*) AS n FROM change_ends").get()).toEqual({ n: 0 });
			const rows = other.raw
				.query<{ key: string; state: string }, []>(
					`SELECT c.key, q.state FROM changes c JOIN questions q ON q.no = ${asked.q.slice(2)}`,
				)
				.all();
			expect(rows).toEqual([{ key: "pr:12", state: "dissolved" }]);
		} finally {
			other.close();
		}
	});

	test("a pipeline or a person says so; an agent's word is not taken, and an unknown change is not found", () => {
		failingPull();
		const pipeline = h.actor("pipeline", "ci", ["record"]);
		const agent = h.actor("runner", "agent", ["read", "produce"]);
		expect(h.raw("change", { change: "pr:12", state: "merged" }, agent)).toMatchObject({
			ok: false,
			error: { code: "forbidden" },
		});
		expect(queue().counts.open).toBe(1);
		expect(h.raw("change", { change: "pr:404", state: "merged" }, pipeline)).toMatchObject({
			ok: false,
			error: { code: "not_found" },
		});
		expect(end("pr:12", "merged", pipeline).questions).toHaveLength(1);
		expect(queue().counts.open).toBe(0);
	});
});
