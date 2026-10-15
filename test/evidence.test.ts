// One red build: reports, causes, decisions and the gate. The fixtures named D1, D3, C3, C5, E3 and E8 are the
// commitments in docs/product-design.md sections 4.2 and 9.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Client } from "../src/cli/client.ts";
import type { ClaimReply, CommandFate, GateStatus, InboxReply, ReportReceipt } from "../src/core/ops.ts";
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

describe("a change against its base", () => {
	const failure = { 4: "expected 90.00, got 100.00" };

	test("a failure the base has too is shown as such, and a person may call it inherited for that build", () => {
		h.call("report", ciReport({ commit: "base0001", n: 10, fail: failure }));
		decide(first(queue().items), { is: "defect" }); // trunk is red and somebody owns it
		const change = (commit: string) =>
			ciReport({ commit, branch: "feature", pr: 482, base: "base0001", n: 10, fail: failure });
		const pr = h.call<ReportReceipt>("report", change("feat0001"));
		// No rule excuses it: the base comparison is a hint for the person who answers.
		expect(pr.questions[0]).toMatchObject({ how: "new", state: "open" });
		expect(pr.gate?.verdict).toBe("blocked");
		const asked = queue().items.find((item) => item.about.includes("pr:482"));
		if (!asked) throw new Error("the change's failure was not asked about");
		expect((asked.evidence as { hints: string[] }).hints).toContain("fails-on-base");
		expect(asked.answers).toContain("inherited");
		expect(decide(asked, { is: "inherited" })).toMatchObject({ status: "decided" });
		expect(h.call<GateStatus>("gate", { change: "pr:482" })).toMatchObject({
			verdict: "passed",
			tally: { excused: 1 },
		});
		// It was said of that build. The next push is asked about again.
		const next = h.call<ReportReceipt>("report", change("feat0001b"));
		expect(next.questions[0]).toMatchObject({ how: "new", state: "open" });
		expect(next.gate?.verdict).toBe("blocked");
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
			seed.db.raw.exec(
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
	type Ended = { change: string; state: string; questions: string[]; already: boolean };
	const end = (change: string, state: "merged" | "closed" | "open", as = h.owner) =>
		h.call<Ended>("change", { change, state }, as);
	const changes = () =>
		h.call<{ items: { key: string; state: string; verdict: string | null }[] }>("find", { in: "changes" }).items;
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
