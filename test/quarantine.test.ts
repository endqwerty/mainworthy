import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type AuditRecord, AuditReply, verifyAudit } from "../src/core/audit.ts";
import type { Quarantine } from "../src/core/flaky.ts";
import type { GateStatus, InboxReply, ProposeReply, ReportReceipt } from "../src/core/ops.ts";
import { effectiveQuarantine, quarantineEntries, quarantineLookup } from "../src/server/evidence/quarantine.ts";
import { Db, declaredSql } from "../src/server/kernel/db.ts";
import { migrate } from "../src/server/kernel/migrate.ts";
import { pollDefectHolds } from "../src/server/tracker-holds.ts";
import { exportArchive, importArchive } from "../src/server/transfer/transfer.ts";
import { ciReport, type Harness, harness } from "./helpers.ts";

let h: Harness;
beforeEach(() => {
	h = harness({ unlinked: "track" });
});
afterEach(() => h.close());
const report = (commit: string, fail = true, branch = "main", attempt = 1) =>
	h.call<ReportReceipt>(
		"report",
		ciReport({ commit, n: 1, branch, attempt, ...(fail ? { fail: { 0: "expected green" } } : {}) }),
	);
const gate = (commit: string) => h.call<GateStatus>("gate", { commit });
function quarantine(exit: unknown, base: number | null = null) {
	const p = h.call<ProposeReply>("propose", {
		edits: [{ op: "quarantine", test: "T-1", base, exit }],
		reason: "Unreliable checkout",
	});
	const q = h.call<InboxReply>("inbox", { kind: "adopt" }).items.find((q) => q.q === p.question);
	if (!q) throw new Error("quarantine proposal was not queued for a person");
	return h.call<{ status: string; decision: number }[]>("decide", {
		q: q.q,
		onEvidence: q.evidenceHash,
		answer: { is: "accept" },
		reason: "Keep failures visible while repairing the test",
	})[0];
}

describe("quarantine covers observations when reported", () => {
	for (const kind of ["person", "expiry", "passes"] as const) {
		test(`past verdicts survive a ${kind} exit and later failures block`, () => {
			report("aaaa0001");
			const entry = quarantine(
				kind === "expiry" ? { kind, at: 1_800_000_001_000 } : kind === "passes" ? { kind, count: 1 } : { kind },
			);
			if (!entry) throw new Error("missing quarantine decision");
			report("aaaa0002");
			expect(gate("aaaa0002")).toMatchObject({ verdict: "passed", quarantined: 1 });
			if (kind === "person") quarantine(null, entry.decision);
			else if (kind === "expiry") h.advance(1_800_000_001_000 - h.app.now() - 1);
			else report("aaaa0003", false);
			expect(gate("aaaa0002")).toMatchObject({ verdict: "passed", quarantined: 1, tally: { excused: 1 } });
			report("aaaa0004");
			expect(gate("aaaa0004")).toMatchObject({ verdict: "blocked", tally: { unexplained: 1 } });
			expect(gate("aaaa0002")).toMatchObject({ verdict: "passed", quarantined: 1 });
			expect(gate("aaaa0001")).toMatchObject({ verdict: "blocked", tally: { unexplained: 1 } });
		});
	}
	test("a correction after the pass exit changes its commit but never reopens quarantine", () => {
		report("aaaa0001");
		quarantine({ kind: "passes", count: 1 });
		report("aaaa0002", false);
		const detail = h.call<{ last: { id: number }[] }[]>("get", { refs: ["T-1"] })[0];
		const original = detail?.last[0];
		if (!original) throw new Error("missing original observation");
		const input = ciReport({ commit: "aaaa0002", n: 1, fail: { 0: "corrected failure" } });
		h.call("report", { ...input, results: input.results.map((row) => ({ ...row, corrects: original.id })) });
		expect(h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] })[0]?.quarantine.active).toBe(false);
		expect(gate("aaaa0002")).toMatchObject({ verdict: "blocked", tally: { unexplained: 1 } });
		report("aaaa0003");
		expect(gate("aaaa0003").verdict).toBe("blocked");
	});
	test("the threshold result is covered but later results in the same report are not", () => {
		report("aaaa0001");
		const entry = quarantine({ kind: "passes", count: 1 });
		const input = ciReport({ commit: "aaaa0002", n: 1 });
		const pass = input.results[0];
		if (!pass) throw new Error("missing test input");
		const receipt = h.call<ReportReceipt>("report", {
			...input,
			results: [pass, { ...pass, outcome: "fail", failure: { message: "later in the same report" } }],
		});
		const covered = quarantineLookup(h.app.db, 1);
		expect(covered(receipt.results?.[0] ?? 0)).toMatchObject({ decision: entry?.decision, quarantined: true });
		expect(covered(receipt.results?.[1] ?? 0)).toBe(null);
		expect(gate("aaaa0002")).toMatchObject({ verdict: "blocked", tally: { unexplained: 1 } });
		expect(h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] })[0]?.quarantine.active).toBe(false);
	});
	test("a correction before the pass exit can complete the streak at its own sequence", () => {
		report("aaaa0001");
		quarantine({ kind: "passes", count: 2 });
		const failure = report("aaaa0002").results?.[0];
		if (!failure) throw new Error("missing original failure");
		report("aaaa0003", false);
		expect(h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] })[0]?.quarantine.active).toBe(true);
		const input = ciReport({ commit: "aaaa0002", n: 1 });
		h.call("report", { ...input, results: input.results.map((row) => ({ ...row, corrects: failure })) });
		expect(gate("aaaa0002")).toMatchObject({ verdict: "passed", tally: { pass: 1 } });
		expect(h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] })[0]?.quarantine.active).toBe(false);
		report("aaaa0004");
		expect(gate("aaaa0004").verdict).toBe("blocked");
	});
	test("a report folds only its changed run and a person's exit folds no old runs", () => {
		report("aaaa0001");
		const entry = quarantine({ kind: "person" });
		if (!entry) throw new Error("missing quarantine decision");
		report("aaaa0002");
		const db = h.app.db;
		const run = db.run.bind(db);
		let folds = 0;
		db.run = (statement, ...params) => {
			if (statement.text.startsWith("UPDATE runs SET tally")) folds++;
			return run(statement, ...params);
		};
		try {
			report("aaaa0003");
			expect(folds).toBe(1);
			folds = 0;
			quarantine(null, entry.decision);
			expect(folds).toBe(0);
		} finally {
			db.run = run;
		}
		expect(gate("aaaa0002")).toMatchObject({ verdict: "passed", quarantined: 1 });
		expect(gate("aaaa0003")).toMatchObject({ verdict: "passed", quarantined: 1 });
	});
	test("replacement entries retain each earlier observation's covering decision", () => {
		report("aaaa0001");
		const first = quarantine({ kind: "person" });
		if (!first) throw new Error("missing entry decision");
		const older = report("aaaa0002").results?.[0];
		const exit = quarantine(null, first.decision);
		if (!exit || !older) throw new Error("missing exit or result");
		report("aaaa0003");
		const second = quarantine({ kind: "person" }, exit.decision);
		const newer = report("aaaa0004").results?.[0];
		if (!second || !newer) throw new Error("missing replacement entry or result");
		const covered = quarantineLookup(h.app.db, 1);
		expect(covered(older)).toMatchObject({ decision: first.decision });
		expect(covered(newer)).toMatchObject({ decision: second.decision });
		expect(gate("aaaa0002")).toMatchObject({ verdict: "passed", quarantined: 1 });
		expect(gate("aaaa0003").verdict).toBe("blocked");
		expect(gate("aaaa0004")).toMatchObject({ verdict: "passed", quarantined: 1 });
	});
});

describe("quarantine", () => {
	test("the history plan finds a commit's targets before looking up their test results", () => {
		const statement = declaredSql().find((text) => text.includes("FROM targets initial"));
		if (!statement) throw new Error("missing quarantine history statement");
		const plan = h.app.db.raw
			.query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${statement}`)
			.all()
			.map((row) => row.detail);
		const initial = plan.indexOf("SEARCH initial USING COVERING INDEX targets_commit (project=? AND commit_sha=?)");
		const first = plan.indexOf("SEARCH first USING INDEX results_target (target=? AND test=?)");
		expect(initial).toBeGreaterThanOrEqual(0);
		expect(first).toBeGreaterThan(initial);
	});
	test("a person's decision excuses one test and makes quarantined failures explicit", () => {
		report("aaaa0001");
		expect(gate("aaaa0001").verdict).toBe("blocked");
		expect(quarantine({ kind: "person" })?.status).toBe("decided");
		expect(gate("aaaa0001").verdict).toBe("blocked");
		report("aaaa0001", true, "main", 2);
		expect(gate("aaaa0001")).toMatchObject({ verdict: "passed", quarantined: 1, tally: { excused: 1, pass: 0 } });
		expect(gate("aaaa0001").reason).toContain("1 quarantined failure recorded, not blocking");
		const list = h.call<{ items: { ref: string; quarantine: Quarantine }[]; count: number }>("find", {
			in: "tests",
			state: "quarantined",
		});
		expect(list.count).toBe(1);
		expect(list.items[0]).toMatchObject({
			ref: "T-1",
			quarantine: {
				reason: "Keep failures visible while repairing the test",
				by: "robin",
				exit: { kind: "person" },
				active: true,
			},
		});
		const entry = list.items[0]?.quarantine;
		if (!entry) throw new Error("missing quarantine entry");
		const d = quarantine(null, entry.decision);
		expect(d?.status).toBe("decided");
		expect(gate("aaaa0001").verdict).toBe("passed");
	});
	test("expiry leaves earlier results excused and the first result at its deadline blocks", () => {
		report("aaaa0001");
		quarantine({ kind: "expiry", at: 1_800_000_001_000 });
		h.advance(1_800_000_001_000 - h.app.now() - 2);
		report("aaaa0002");
		report("aaaa0003");
		expect(gate("aaaa0002")).toMatchObject({ verdict: "passed", quarantined: 1 });
		expect(gate("aaaa0003")).toMatchObject({ verdict: "blocked", tally: { unexplained: 1 } });
	});
	test("distinct passing trunk commits exit despite later failing commits, while change passes do not", () => {
		report("aaaa0001");
		quarantine({ kind: "passes", count: 2 });
		report("aaaa0001", true, "main", 2);
		report("aaaa0002", false, "feature");
		report("aaaa0003", false);
		report("aaaa0003", false, "main", 2);
		expect(gate("aaaa0001").verdict).toBe("passed");
		report("aaaa0004", false);
		expect(gate("aaaa0001").verdict).toBe("passed");
		expect(h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] })[0]?.quarantine.active).toBe(false);
		report("aaaa0005");
		expect(gate("aaaa0005").verdict).toBe("blocked");
	});
	test("a same-attempt failure after the exit cannot reopen quarantine", () => {
		report("aaaa0001");
		quarantine({ kind: "passes", count: 1 });
		report("aaaa0002", false);
		expect(h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] })[0]?.quarantine.active).toBe(false);
		report("aaaa0002");
		expect(h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] })[0]?.quarantine.active).toBe(false);
		expect(gate("aaaa0002")).toMatchObject({ verdict: "blocked", tally: { unexplained: 1, pass: 0 } });
	});
	test("a retry of a commit first reported before entry does not count toward the pass exit", () => {
		report("aaaa0001");
		quarantine({ kind: "passes", count: 2 });
		report("aaaa0001", false, "main", 2);
		report("aaaa0002", false);
		expect(h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] })[0]?.quarantine.active).toBe(true);
		report("aaaa0003", false);
		expect(h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] })[0]?.quarantine.active).toBe(false);
	});
	test("a same-attempt pass on a pre-entry failure cannot end quarantine", () => {
		report("aaaa0001");
		quarantine({ kind: "passes", count: 1 });
		report("aaaa0001", false);
		expect(gate("aaaa0001")).toMatchObject({ verdict: "blocked", tally: { unexplained: 1, pass: 0 } });
		expect(h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] })[0]?.quarantine.active).toBe(true);
		report("aaaa0002", false);
		expect(gate("aaaa0001")).toMatchObject({ verdict: "blocked", tally: { unexplained: 1 } });
	});
	test("a commit first reported after entry counts when its retry passes as the gate does", () => {
		report("aaaa0001");
		quarantine({ kind: "passes", count: 1 });
		report("aaaa0002");
		expect(h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] })[0]?.quarantine.active).toBe(true);
		report("aaaa0002", false);
		expect(h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] })[0]?.quarantine.active).toBe(true);
		report("aaaa0002", false, "main", 2);
		expect(h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] })[0]?.quarantine.active).toBe(false);
		expect(gate("aaaa0002")).toMatchObject({ verdict: "passed", tally: { pass: 1, unexplained: 0 } });
		expect(gate("aaaa0001")).toMatchObject({ verdict: "blocked", tally: { unexplained: 1 } });
	});
});

describe("quarantine boundaries", () => {
	test("agents propose and advise but never decide, even with answer and admin grants", () => {
		report("aaaa0001");
		const agent = h.actor("reviewer", "agent", ["read", "produce", "answer", "admin"]);
		const proposed = h.call<ProposeReply>(
			"propose",
			{
				edits: [{ op: "quarantine", test: "T-1", base: null, exit: { kind: "person" } }],
				reason: "Observed retry flips",
			},
			agent,
		);
		expect(proposed.status).toBe("open");
		const q = h.call<InboxReply>("inbox", { kind: "adopt" }).items.find((q) => q.q === proposed.question);
		if (!q) throw new Error("missing proposal");
		const input = { q: q.q, onEvidence: q.evidenceHash, answer: { is: "accept" }, reason: "Looks unreliable" };
		expect(h.call<{ status: string }[]>("decide", input, agent)[0]?.status).toBe("advised");
		expect(gate("aaaa0001").verdict).toBe("blocked");
		expect(h.call<{ status: string }[]>("decide", { ...input, reason: " " })[0]?.status).toBe("invalid");
		expect(h.call<{ status: string }[]>("decide", input)[0]?.status).toBe("decided");
		report("aaaa0001", true, "main", 2);
		expect(gate("aaaa0001").verdict).toBe("passed");
		const detail = h.call<{ quarantine: { decision: number } }[]>("get", { refs: ["T-1"] })[0];
		const end = h.call<ProposeReply>(
			"propose",
			{ edits: [{ op: "quarantine", test: "T-1", base: detail?.quarantine.decision, exit: null }], reason: "End it" },
			agent,
		);
		const endQ = h.call<InboxReply>("inbox", { kind: "adopt" }).items.find((q) => q.q === end.question);
		if (!endQ) throw new Error("missing exit proposal");
		expect(
			h.call<{ status: string }[]>(
				"decide",
				{ q: endQ.q, onEvidence: endQ.evidenceHash, answer: { is: "accept" }, reason: "End" },
				agent,
			)[0]?.status,
		).toBe("advised");
		expect(gate("aaaa0001").verdict).toBe("passed");
	});
	test("a stale proposal cannot replace a newer quarantine decision", () => {
		report("aaaa0001");
		const stale = h.call<ProposeReply>("propose", {
			edits: [{ op: "quarantine", test: "T-1", base: null, exit: { kind: "person" } }],
			reason: "Earlier draft",
		});
		quarantine({ kind: "passes", count: 2 });
		const q = h.call<InboxReply>("inbox", { kind: "adopt" }).items.find((q) => q.q === stale.question);
		if (!q) throw new Error("missing stale question");
		expect(
			h.raw("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "accept" }, reason: "Earlier" }),
		).toMatchObject({ ok: true, result: [{ status: "conflict" }] });
		expect(gate("aaaa0001").verdict).toBe("blocked");
	});
	test("another test with the same cause still blocks and keeps the quarantine visible", () => {
		h.call("report", ciReport({ commit: "aaaa0001", n: 2, fail: { 0: "expected green", 1: "expected green" } }));
		quarantine({ kind: "person" });
		h.call(
			"report",
			ciReport({ commit: "aaaa0001", n: 2, attempt: 2, fail: { 0: "expected green", 1: "expected green" } }),
		);
		expect(gate("aaaa0001")).toMatchObject({
			verdict: "blocked",
			quarantined: 1,
			tally: { excused: 1, unexplained: 1 },
		});
		expect(gate("aaaa0001").reason).toContain("1 quarantined failure recorded, not blocking");
	});
	test("new failure signatures stay quarantined but required jobs still wait", () => {
		report("aaaa0001");
		quarantine({ kind: "person" });
		const input = ciReport({ commit: "aaaa0002", n: 1, fail: { 0: "connection timeout" } });
		h.call("report", input);
		h.call("propose", { edits: [{ op: "create", outline: "Jobs case" }] });
		const planned = h.call<{ run: string }>("plan", {
			name: "All jobs",
			select: { cases: ["C-1"] },
			accepts: { commit: "aaaa0002" },
			require: [
				{ id: "exercise", kind: "exercise", methods: ["auto"], minActors: 1, basis: "exact-or-assumed" },
				{ id: "jobs", kind: "jobs", jobs: ["e2e", "unit"] },
			],
		});
		expect(gate("aaaa0002")).toMatchObject({ verdict: "passed", quarantined: 1 });
		expect(h.call<GateStatus>("gate", { run: planned.run })).toMatchObject({
			verdict: "pending",
			tally: { missing: 2 },
		});
	});
	test("skips and failures reset the pass streak, while two clean commits end it", () => {
		report("aaaa0001");
		quarantine({ kind: "passes", count: 2 });
		report("aaaa0001", true, "main", 2);
		report("aaaa0002", false);
		const skip = ciReport({ commit: "aaaa0003", n: 1 });
		h.call("report", { ...skip, results: skip.results.map((row) => ({ ...row, outcome: "skip" })) });
		report("aaaa0004", false);
		expect(gate("aaaa0001").verdict).toBe("passed");
		report("aaaa0005");
		report("aaaa0006", false);
		expect(gate("aaaa0001").verdict).toBe("passed");
		report("aaaa0007", false);
		expect(gate("aaaa0001").verdict).toBe("passed");
		expect(h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] })[0]?.quarantine.active).toBe(false);
	});
	test("a failing lane on a trunk commit prevents a clean commit", () => {
		report("aaaa0001");
		quarantine({ kind: "passes", count: 2 });
		report("aaaa0001", true, "main", 2);
		report("aaaa0002", false);
		h.call("report", ciReport({ commit: "aaaa0002", job: "other-job", n: 1, fail: { 0: "expected green" } }));
		report("aaaa0003", false);
		expect(gate("aaaa0001").verdict).toBe("passed");
		report("aaaa0004", false);
		expect(gate("aaaa0001").verdict).toBe("passed");
		expect(h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] })[0]?.quarantine.active).toBe(false);
	});
	test("same-attempt disagreement keeps the failure, higher attempts can pass", () => {
		report("aaaa0001");
		quarantine({ kind: "passes", count: 2 });
		report("aaaa0001", true, "main", 2);
		report("aaaa0002");
		report("aaaa0002", false);
		report("aaaa0003", false);
		expect(gate("aaaa0001").verdict).toBe("passed");
		report("aaaa0003");
		expect(gate("aaaa0001").verdict).toBe("passed");
		report("aaaa0002", false, "main", 2);
		report("aaaa0003", false, "main", 2);
		expect(gate("aaaa0001").verdict).toBe("passed");
		expect(h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] })[0]?.quarantine.active).toBe(false);
	});
	test("agent reports do not satisfy a pass rule", () => {
		report("aaaa0001");
		quarantine({ kind: "passes", count: 1 });
		report("aaaa0001", true, "main", 2);
		const agent = h.actor("reporting-agent", "agent", ["read", "produce"]);
		h.call("report", ciReport({ commit: "aaaa0002", n: 1 }), agent);
		expect(gate("aaaa0001").verdict).toBe("passed");
		report("aaaa0003", false);
		expect(gate("aaaa0001").verdict).toBe("passed");
		expect(h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] })[0]?.quarantine.active).toBe(false);
	});
	test("entry is project scoped and rejects missing tests, manual tests, mixed edits and missing reasons", () => {
		report("aaaa0001");
		for (const input of [
			{ edits: [{ op: "quarantine", test: "T-1", base: null, exit: { kind: "person" } }] },
			{ edits: [{ op: "quarantine", test: "T-99", base: null, exit: { kind: "person" } }], reason: "Missing" },
			{ edits: [{ op: "quarantine", test: "T-1", base: null, exit: { kind: "expiry", at: 1 } }], reason: "Expired" },
			{ edits: [{ op: "quarantine", test: "T-1", base: null, exit: { kind: "passes", count: 0 } }], reason: "Invalid" },
			{
				edits: [
					{ op: "quarantine", test: "T-1", base: null, exit: { kind: "person" } },
					{ op: "create", outline: "Other edit" },
				],
				reason: "Mixed",
			},
		])
			expect(h.raw("propose", input).ok).toBe(false);
		h.call("propose", { edits: [{ op: "create", outline: "Manual case" }] });
		h.call("report", { target: { session: "manual" }, results: [{ test: { case: "C-1" }, outcome: "pass" }] });
		expect(
			h.raw("propose", {
				edits: [{ op: "quarantine", test: "T-2", base: null, exit: { kind: "person" } }],
				reason: "Manual",
			}),
		).toMatchObject({ ok: false, error: { code: "invalid" } });
		quarantine({ kind: "person" });
		const other = harness({ project: "other", unlinked: "track" });
		try {
			other.call("report", ciReport({ commit: "aaaa0001", n: 1, fail: { 0: "expected green" } }));
			expect(other.call<GateStatus>("gate", { commit: "aaaa0001" }).verdict).toBe("blocked");
		} finally {
			other.close();
		}
	});
	test("planned runs keep observation-time coverage at expiry, including a run planned afterward", () => {
		h.call("propose", { edits: [{ op: "create", body: { title: "Checkout", methods: ["auto"] } }] });
		const planned = h.call<{ run: string }>("plan", {
			name: "Checkout regression",
			select: { cases: ["C-1"] },
			accepts: { commit: "aaaa0001" },
		});
		const input = ciReport({ commit: "aaaa0001", n: 1, fail: { 0: "expected green" } });
		h.call("report", {
			...input,
			results: input.results.map((row) => ({ ...row, annotation: { case: "C-1", version: 1 } })),
		});
		expect(h.call<GateStatus>("gate", { run: planned.run }).verdict).toBe("blocked");
		quarantine({ kind: "expiry", at: 1_800_000_001_000 });
		h.call("report", {
			...input,
			attempt: 2,
			results: input.results.map((row) => ({ ...row, annotation: { case: "C-1", version: 1 } })),
		});
		expect(h.call<GateStatus>("gate", { run: planned.run })).toMatchObject({
			verdict: "passed",
			quarantined: 1,
			tally: { excused: 1, pass: 0 },
		});
		h.advance(1000);
		expect(h.call<GateStatus>("gate", { run: planned.run })).toMatchObject({
			verdict: "passed",
			quarantined: 1,
			tally: { excused: 1, unexplained: 0 },
		});
		expect(h.call<{ tally: GateStatus["tally"] }[]>("get", { refs: [planned.run] })[0]?.tally.excused).toBe(1);
		const later = h.call<{ run: string }>("plan", {
			name: "Later checkout regression",
			select: { cases: ["C-1"] },
			accepts: { commit: "aaaa0001" },
		});
		expect(h.call<GateStatus>("gate", { run: later.run })).toMatchObject({ verdict: "passed", quarantined: 1 });
	});
});

test("archives retain quarantine decisions, exit rules and observations", () => {
	report("aaaa0001");
	quarantine({ kind: "passes", count: 2 });
	report("aaaa0001", true, "main", 2);
	report("aaaa0002", false);
	report("aaaa0003", false);
	const detail = h.call<{ last: { id: number; outcome: string }[] }[]>("get", { refs: ["T-1"] })[0];
	const failure = detail?.last.find((result) => result.outcome === "fail");
	if (!failure) throw new Error("missing quarantined failure");
	let archive = "";
	exportArchive(
		h.app.db,
		(chunk) => {
			archive += chunk;
		},
		{ now: 1_800_000_000_500 },
	);
	expect(archive).toContain('"quarantines"');
	const imported = new Db(":memory:");
	try {
		migrate(imported, ":memory:");
		importArchive(imported, archive.trimEnd().split("\n"));
		const entry = quarantineEntries(imported, 1)[0];
		if (!entry) throw new Error("quarantine did not survive archive import");
		expect(entry).toMatchObject({
			actor: h.owner.id,
			reason: "Keep failures visible while repairing the test",
			exit_rule: '{"kind":"passes","count":2}',
		});
		expect(effectiveQuarantine(imported, entry, h.app.now())).toBe(false);
		expect(quarantineLookup(imported, 1)(failure.id)).toMatchObject({ decision: entry.decision, quarantined: true });
	} finally {
		imported.close();
	}
	expect(gate("aaaa0001")).toMatchObject({ verdict: "passed", quarantined: 1 });
});

test("audit keeps each quarantine test and exit rule after its standing is replaced", () => {
	report("aaaa0001");
	const entry = quarantine({ kind: "passes", count: 2 });
	if (!entry) throw new Error("missing entry decision");
	const ending = quarantine(null, entry.decision);
	if (!ending) throw new Error("missing exit decision");
	const file = AuditReply.parse(h.call("audit", {})).ndjson;
	expect(verifyAudit(file).unavailableDecisionEvidence).toBe(0);
	const records: AuditRecord[] = file
		.trimEnd()
		.split("\n")
		.slice(1, -1)
		.map((line) => JSON.parse(line));
	for (const [decision, base, exit] of [
		[entry.decision, null, { kind: "passes", count: 2 }],
		[ending.decision, entry.decision, null],
	] as const) {
		expect(records.find((record) => record.id === `decision:${decision}`)).toMatchObject({
			type: "decision",
			kind: "adopt",
			answer: { is: "accept" },
			effects: { quarantine: { op: "quarantine", test: "T-1", base, exit } },
			signers: [{ by: { name: "robin", kind: "human" }, reason: "Keep failures visible while repairing the test" }],
		});
	}
});

for (const mixed of [false, true]) {
	test(`quarantine excuses only automated failures in a disputed slot, mixed=${mixed}`, () => {
		h.call("propose", { edits: [{ op: "create", outline: "Checkout regression" }] });
		const planned = h.call<{ run: string }>("plan", {
			name: "Disputed checkout",
			select: { cases: ["C-1"] },
			accepts: { commit: "aaaa0001" },
		});
		const input = ciReport({ commit: "aaaa0001", n: 1, fail: { 0: "expected green" } });
		h.call("report", {
			...input,
			results: input.results.map((row) => ({ ...row, annotation: { case: "C-1", version: 1 } })),
		});
		h.call("report", { run: planned.run, results: [{ test: { case: "C-1" }, outcome: "pass" }] });
		if (mixed) {
			const tester = h.actor("tester", "human", ["read", "produce"]);
			h.call(
				"report",
				{
					run: planned.run,
					results: [{ test: { case: "C-1" }, outcome: "fail", failure: { message: "Manual failure" } }],
				},
				tester,
			);
		}
		expect(h.call<GateStatus>("gate", { run: planned.run })).toMatchObject({
			verdict: "blocked",
			tally: { disputed: 1 },
		});
		quarantine({ kind: "expiry", at: 1_800_000_001_000 });
		h.call("report", {
			...input,
			attempt: 2,
			results: input.results.map((row) => ({ ...row, annotation: { case: "C-1", version: 1 } })),
		});
		expect(h.call<GateStatus>("gate", { run: planned.run })).toMatchObject({
			verdict: mixed ? "blocked" : "passed",
			quarantined: 1,
			tally: mixed ? { disputed: 1, excused: 0 } : { disputed: 0, excused: 1, pass: 0 },
		});
		expect(
			h.call<{ items: { state: string }[] }>("find", { in: "slots", run: planned.run }).items.map((slot) => slot.state),
		).toEqual(["disputed"]);
		h.advance(1000);
		expect(h.call<GateStatus>("gate", { run: planned.run })).toMatchObject({
			verdict: mixed ? "blocked" : "passed",
			quarantined: 1,
			tally: mixed ? { disputed: 1, excused: 0 } : { disputed: 0, excused: 1, pass: 0 },
		});
	});
}

for (const endBeforeClosure of [false, true]) {
	test(`tracker closure and quarantine exit preserve each other's decisions, exitFirst=${endBeforeClosure}`, async () => {
		h.app.config.github = { project: "scratch", repository: "acme/web", token: "local-test-tracker-credential" };
		report("aaaa0001");
		const failure = h.call<InboxReply>("inbox", { kind: "failure" }).items[0];
		if (!failure) throw new Error("missing failure question");
		const defect = h.call<{ status: string; decision: number }[]>("decide", {
			q: failure.q,
			onEvidence: failure.evidenceHash,
			answer: { is: "defect", ref: "https://github.com/acme/web/issues/42" },
			reason: "Tracked checkout defect",
		})[0];
		expect(defect?.status).toBe("decided");
		expect(gate("aaaa0001")).toMatchObject({ verdict: "failed", tally: { attributed: 1 } });
		const entry = quarantine({ kind: "person" });
		if (!entry) throw new Error("missing quarantine decision");
		expect(gate("aaaa0001")).toMatchObject({ verdict: "failed", tally: { attributed: 1 } });
		report("aaaa0001", true, "main", 2);
		expect(gate("aaaa0001")).toMatchObject({ verdict: "passed", quarantined: 1 });
		if (endBeforeClosure) {
			quarantine(null, entry.decision);
			expect(gate("aaaa0001")).toMatchObject({ verdict: "passed", quarantined: 1 });
		}
		const issue = { ref: "github:acme/web#42", url: "https://github.com/acme/web/issues/42", state: "closed" } as const;
		expect(await pollDefectHolds(h.app, { createDefect: async () => issue, getItem: async () => issue })).toBe(1);
		const file = AuditReply.parse(h.call("audit", {})).ndjson;
		const records: AuditRecord[] = file
			.trimEnd()
			.split("\n")
			.slice(1, -1)
			.map((line) => JSON.parse(line));
		expect(
			records.find((record) => record.type === "decision" && record.prior?.id === `decision:${defect?.decision}`),
		).toMatchObject({
			type: "decision",
			answer: { is: "outdated" },
			signers: [{ by: { name: "policy", kind: "rule" }, clause: "tracker-closed" }],
		});
		if (!endBeforeClosure) {
			expect(gate("aaaa0001")).toMatchObject({ verdict: "passed", quarantined: 1, tally: { excused: 1 } });
			expect(h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] })[0]?.quarantine).toMatchObject({
				decision: entry.decision,
				active: true,
			});
			quarantine(null, entry.decision);
		}
		expect(gate("aaaa0001")).toMatchObject({
			verdict: "passed",
			quarantined: 1,
			tally: { unexplained: 0, attributed: 0, excused: 1 },
		});
	});
}
