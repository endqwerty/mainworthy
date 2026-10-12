// One red build: reports, causes, decisions and the gate. The fixtures named D1, D3, C3, C5, E3 and E8 are the
// commitments in docs/product-design.md sections 4.2 and 9.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { GateStatus, InboxReply, ReportReceipt } from "../src/core/ops.ts";
import { recoverAccepted, sweep } from "../src/server/jobs.ts";
import { findProject, makeCtx, stampSeq } from "../src/server/kernel/ctx.ts";
import { acceptReport, processBatch } from "../src/server/ops/writes.ts";
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
		expect(again.questions[0]).toMatchObject({ how: "already decided", answer: "defect", by: "daniel" });
		expect(queue().counts.open).toBe(0);
		expect(count("questions WHERE kind = 'failure'")).toBe(1);
	});

	test("an answer on evidence that has changed is a conflict, with the new evidence", () => {
		h.call("report", ciReport({ commit: "eeeeeee1", pr: 7, branch: "fix", n: 3, fail: { 0: "boom" } }));
		const seen = first(queue().items);
		// the same cause now also disputes nothing but gains a hint: fails on base
		h.call("report", ciReport({ commit: "0000000a", n: 3, fail: { 0: "boom" } })); // trunk now fails the same way
		h.call("report", ciReport({ commit: "eeeeeee2", pr: 7, branch: "fix", n: 3, fail: { 0: "boom" } }));
		const reply = h.raw("decide", { q: seen.q, onEvidence: seen.evidenceHash, answer: { is: "flaky" } });
		// in a loose project the rule has already excused it as inherited, so the stale answer cannot land
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

	test("loose: a failure already failing on the base is excused by the rule, as a recorded decision", () => {
		h.call("report", ciReport({ commit: "base0001", n: 10, fail: failure }));
		decide(first(queue().items), { is: "defect" }); // trunk is red and somebody owns it
		const pr = h.call<ReportReceipt>(
			"report",
			ciReport({ commit: "feat0001", branch: "feature", pr: 482, base: "base0001", n: 10, fail: failure }),
		);
		expect(pr.questions[0]).toMatchObject({ how: "decided by rule", answer: "inherited", by: "policy" });
		expect(pr.gate?.verdict).toBe("passed");
		expect(pr.gate?.tally.excused).toBe(1);
		const ledger = h.call<InboxReply>("inbox", { state: "decided", kind: "failure" });
		expect(ledger.items.find((item) => item.decision?.rule === "failure-on-base")).toBeDefined();
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
		const ci = h.actor("github-actions", "ci", ["read", "produce"]);
		const reader = h.actor("pm", "human", ["read"]);
		h.call("report", ciReport({ commit: "3333333b", n: 3, fail: { 0: "expected 1, got 2" } }), ci);
		const q = first(queue().items);
		expect(decide(q, { is: "flaky" }, ci)?.status).toBe("forbidden");
		const refused = h.raw("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "flaky" } }, reader);
		expect(refused).toMatchObject({ ok: false, error: { code: "forbidden" } });
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
		const s = harness({ preset: "standard" });
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
		expect(wrong.rejected).toEqual([{ index: 0, reason: "the case has no version 9" }]);
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
	test("a report accepted before a crash is applied on the next start; the gate was pending meanwhile", () => {
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
		expect(count("decisions WHERE kind = 'failure'")).toBe(1); // the expired decision stays in the ledger
		expect(count("excuses")).toBe(0);
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
