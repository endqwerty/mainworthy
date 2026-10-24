import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type AuditRecord, verifyAudit } from "../src/core/audit.ts";
import type { Quarantine } from "../src/core/flaky.ts";
import type { GateStatus, InboxReply, ProposeReply, ReportReceipt } from "../src/core/ops.ts";
import { AuditReply } from "../src/core/replies.ts";
import { effectiveQuarantine, quarantineEntries, quarantineLookup } from "../src/server/evidence/quarantine.ts";
import { Database } from "../src/server/kernel/db.ts";
import { pollDefectHolds } from "../src/server/ops/tracker-holds.ts";
import { exportArchive, importArchive } from "../src/server/transfer/transfer.ts";
import { testDatabase } from "./db.ts";
import { ciReport, type Harness, harness } from "./helpers.ts";

let h: Harness;
beforeEach(async () => {
	h = await harness({ unlinked: "track" });
});
afterEach(async () => await h?.close());
const report = async (commit: string, fail = true, branch = "main", attempt = 1) =>
	await h.call<ReportReceipt>(
		"report",
		ciReport({ commit, n: 1, branch, attempt, ...(fail ? { fail: { 0: "expected green" } } : {}) }),
	);
const gate = async (commit: string) => await h.call<GateStatus>("gate", { commit });
async function quarantine(exit: unknown, base: number | null = null) {
	const p = await h.call<ProposeReply>("propose", {
		edits: [{ op: "quarantine", test: "T-1", base, exit }],
		reason: "Unreliable checkout",
	});
	const q = (await h.call<InboxReply>("inbox", { kind: "adopt" })).items.find((q) => q.q === p.question);
	if (!q) throw new Error("quarantine proposal was not queued for a person");
	return (
		await h.call<{ status: string; decision: number }[]>("decide", {
			q: q.q,
			onEvidence: q.evidenceHash,
			answer: { is: "accept" },
			reason: "Keep failures visible while repairing the test",
		})
	)[0];
}

describe("quarantine covers observations when reported", () => {
	for (const kind of ["person", "expiry", "passes"] as const) {
		test(`past verdicts survive a ${kind} exit and later failures block`, async () => {
			await report("aaaa0001");
			const entry = await quarantine(
				kind === "expiry" ? { kind, at: 1_800_000_001_000 } : kind === "passes" ? { kind, count: 1 } : { kind },
			);
			if (!entry) throw new Error("missing quarantine decision");
			await report("aaaa0002");
			expect(await gate("aaaa0002")).toMatchObject({ verdict: "passed", quarantined: 1 });
			if (kind === "person") await quarantine(null, entry.decision);
			else if (kind === "expiry") h.advance(1_800_000_001_000 - h.app.now() - 1);
			else await report("aaaa0003", false);
			expect(await gate("aaaa0002")).toMatchObject({ verdict: "passed", quarantined: 1, tally: { excused: 1 } });
			await report("aaaa0004");
			expect(await gate("aaaa0004")).toMatchObject({ verdict: "blocked", tally: { unexplained: 1 } });
			expect(await gate("aaaa0002")).toMatchObject({ verdict: "passed", quarantined: 1 });
			expect(await gate("aaaa0001")).toMatchObject({ verdict: "blocked", tally: { unexplained: 1 } });
		});
	}
	test("a correction after the pass exit changes its commit but never reopens quarantine", async () => {
		await report("aaaa0001");
		await quarantine({ kind: "passes", count: 1 });
		await report("aaaa0002", false);
		const detail = (await h.call<{ last: { id: number }[] }[]>("get", { refs: ["T-1"] }))[0];
		const original = detail?.last[0];
		if (!original) throw new Error("missing original observation");
		const input = ciReport({ commit: "aaaa0002", n: 1, fail: { 0: "corrected failure" } });
		await h.call("report", { ...input, results: input.results.map((row) => ({ ...row, corrects: original.id })) });
		expect((await h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] }))[0]?.quarantine.active).toBe(false);
		expect(await gate("aaaa0002")).toMatchObject({ verdict: "blocked", tally: { unexplained: 1 } });
		await report("aaaa0003");
		expect((await gate("aaaa0003")).verdict).toBe("blocked");
	});
	test("the threshold result is covered but later results in the same report are not", async () => {
		await report("aaaa0001");
		const entry = await quarantine({ kind: "passes", count: 1 });
		const input = ciReport({ commit: "aaaa0002", n: 1 });
		const pass = input.results[0];
		if (!pass) throw new Error("missing test input");
		const receipt = await h.call<ReportReceipt>("report", {
			...input,
			results: [pass, { ...pass, outcome: "fail", failure: { message: "later in the same report" } }],
		});
		const covered = async (result: number) =>
			await h.app.database.read(async (db) => await (await quarantineLookup(db, 1))(result));
		expect(await covered(receipt.results?.[0] ?? 0)).toMatchObject({ decision: entry?.decision, quarantined: true });
		expect(await covered(receipt.results?.[1] ?? 0)).toBe(null);
		expect(await gate("aaaa0002")).toMatchObject({ verdict: "blocked", tally: { unexplained: 1 } });
		expect((await h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] }))[0]?.quarantine.active).toBe(false);
	});
	test("a correction before the pass exit can complete the streak at its own sequence", async () => {
		await report("aaaa0001");
		await quarantine({ kind: "passes", count: 2 });
		const failure = (await report("aaaa0002")).results?.[0];
		if (!failure) throw new Error("missing original failure");
		await report("aaaa0003", false);
		expect((await h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] }))[0]?.quarantine.active).toBe(true);
		const input = ciReport({ commit: "aaaa0002", n: 1 });
		await h.call("report", { ...input, results: input.results.map((row) => ({ ...row, corrects: failure })) });
		expect(await gate("aaaa0002")).toMatchObject({ verdict: "passed", tally: { pass: 1 } });
		expect((await h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] }))[0]?.quarantine.active).toBe(false);
		await report("aaaa0004");
		expect((await gate("aaaa0004")).verdict).toBe("blocked");
	});
	test("a report folds only its changed run and a person's exit folds no old runs", async () => {
		await report("aaaa0001");
		const entry = await quarantine({ kind: "person" });
		if (!entry) throw new Error("missing quarantine decision");
		await report("aaaa0002");
		const database = h.app.database;
		const write = database.write.bind(database);
		let folds = 0;
		database.write = async (fn, options) =>
			await write(async (db) => {
				const run = db.run.bind(db);
				db.run = async (statement, ...params) => {
					if (statement.text.startsWith("UPDATE runs SET tally")) folds++;
					return await run(statement, ...params);
				};
				try {
					return await fn(db);
				} finally {
					db.run = run;
				}
			}, options);
		try {
			await report("aaaa0003");
			expect(folds).toBe(1);
			folds = 0;
			await quarantine(null, entry.decision);
			expect(folds).toBe(0);
		} finally {
			database.write = write;
		}
		expect(await gate("aaaa0002")).toMatchObject({ verdict: "passed", quarantined: 1 });
		expect(await gate("aaaa0003")).toMatchObject({ verdict: "passed", quarantined: 1 });
	});
	test("replacement entries retain each earlier observation's covering decision", async () => {
		await report("aaaa0001");
		const first = await quarantine({ kind: "person" });
		if (!first) throw new Error("missing entry decision");
		const older = (await report("aaaa0002")).results?.[0];
		const exit = await quarantine(null, first.decision);
		if (!exit || !older) throw new Error("missing exit or result");
		await report("aaaa0003");
		const second = await quarantine({ kind: "person" }, exit.decision);
		const newer = (await report("aaaa0004")).results?.[0];
		if (!second || !newer) throw new Error("missing replacement entry or result");
		const covered = async (result: number) =>
			await h.app.database.read(async (db) => await (await quarantineLookup(db, 1))(result));
		expect(await covered(older)).toMatchObject({ decision: first.decision });
		expect(await covered(newer)).toMatchObject({ decision: second.decision });
		expect(await gate("aaaa0002")).toMatchObject({ verdict: "passed", quarantined: 1 });
		expect((await gate("aaaa0003")).verdict).toBe("blocked");
		expect(await gate("aaaa0004")).toMatchObject({ verdict: "passed", quarantined: 1 });
	});
});

describe("quarantine", () => {
	test("a person's decision excuses one test and makes quarantined failures explicit", async () => {
		await report("aaaa0001");
		expect((await gate("aaaa0001")).verdict).toBe("blocked");
		expect((await quarantine({ kind: "person" }))?.status).toBe("decided");
		expect((await gate("aaaa0001")).verdict).toBe("blocked");
		await report("aaaa0001", true, "main", 2);
		expect(await gate("aaaa0001")).toMatchObject({ verdict: "passed", quarantined: 1, tally: { excused: 1, pass: 0 } });
		expect((await gate("aaaa0001")).reason).toContain("1 quarantined failure recorded, not blocking");
		const list = await h.call<{ items: { ref: string; quarantine: Quarantine }[]; count: number }>("find", {
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
		const d = await quarantine(null, entry.decision);
		expect(d?.status).toBe("decided");
		expect((await gate("aaaa0001")).verdict).toBe("passed");
	});
	test("expiry leaves earlier results excused and the first result at its deadline blocks", async () => {
		await report("aaaa0001");
		await quarantine({ kind: "expiry", at: 1_800_000_001_000 });
		h.advance(1_800_000_001_000 - h.app.now() - 2);
		await report("aaaa0002");
		await report("aaaa0003");
		expect(await gate("aaaa0002")).toMatchObject({ verdict: "passed", quarantined: 1 });
		expect(await gate("aaaa0003")).toMatchObject({ verdict: "blocked", tally: { unexplained: 1 } });
	});
	test("distinct passing trunk commits exit despite later failing commits, while change passes do not", async () => {
		await report("aaaa0001");
		await quarantine({ kind: "passes", count: 2 });
		await report("aaaa0001", true, "main", 2);
		expect((await h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] }))[0]?.quarantine.active).toBe(true);
		await report("aaaa0002", false, "feature");
		expect((await h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] }))[0]?.quarantine.active).toBe(true);
		await report("aaaa0003", false);
		expect((await h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] }))[0]?.quarantine.active).toBe(true);
		await report("aaaa0003", false, "main", 2);
		expect((await h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] }))[0]?.quarantine.active).toBe(true);
		expect((await gate("aaaa0001")).verdict).toBe("passed");
		await report("aaaa0004", false);
		expect((await gate("aaaa0001")).verdict).toBe("passed");
		expect((await h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] }))[0]?.quarantine.active).toBe(false);
		await report("aaaa0005");
		expect((await gate("aaaa0005")).verdict).toBe("blocked");
	});
	test("a same-attempt failure after the exit cannot reopen quarantine", async () => {
		await report("aaaa0001");
		await quarantine({ kind: "passes", count: 1 });
		await report("aaaa0002", false);
		expect((await h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] }))[0]?.quarantine.active).toBe(false);
		await report("aaaa0002");
		expect((await h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] }))[0]?.quarantine.active).toBe(false);
		expect(await gate("aaaa0002")).toMatchObject({ verdict: "blocked", tally: { unexplained: 1, pass: 0 } });
	});
	test("a retry of a commit first reported before entry does not count toward the pass exit", async () => {
		await report("aaaa0001");
		await quarantine({ kind: "passes", count: 2 });
		await report("aaaa0001", false, "main", 2);
		await report("aaaa0002", false);
		expect((await h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] }))[0]?.quarantine.active).toBe(true);
		await report("aaaa0003", false);
		expect((await h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] }))[0]?.quarantine.active).toBe(false);
	});
	test("a same-attempt pass on a pre-entry failure cannot end quarantine", async () => {
		await report("aaaa0001");
		await quarantine({ kind: "passes", count: 1 });
		await report("aaaa0001", false);
		expect(await gate("aaaa0001")).toMatchObject({ verdict: "blocked", tally: { unexplained: 1, pass: 0 } });
		expect((await h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] }))[0]?.quarantine.active).toBe(true);
		await report("aaaa0002", false);
		expect(await gate("aaaa0001")).toMatchObject({ verdict: "blocked", tally: { unexplained: 1 } });
	});
	test("a commit first reported after entry counts when its retry passes as the gate does", async () => {
		await report("aaaa0001");
		await quarantine({ kind: "passes", count: 1 });
		await report("aaaa0002");
		expect((await h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] }))[0]?.quarantine.active).toBe(true);
		await report("aaaa0002", false);
		expect((await h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] }))[0]?.quarantine.active).toBe(true);
		await report("aaaa0002", false, "main", 2);
		expect((await h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] }))[0]?.quarantine.active).toBe(false);
		expect(await gate("aaaa0002")).toMatchObject({ verdict: "passed", tally: { pass: 1, unexplained: 0 } });
		expect(await gate("aaaa0001")).toMatchObject({ verdict: "blocked", tally: { unexplained: 1 } });
	});
});

describe("quarantine boundaries", () => {
	test("agents propose and advise but never decide, even with answer and admin grants", async () => {
		await report("aaaa0001");
		const agent = await h.actor("reviewer", "agent", ["read", "produce", "answer", "admin"]);
		const proposed = await h.call<ProposeReply>(
			"propose",
			{
				edits: [{ op: "quarantine", test: "T-1", base: null, exit: { kind: "person" } }],
				reason: "Observed retry flips",
			},
			agent,
		);
		expect(proposed.status).toBe("open");
		const q = (await h.call<InboxReply>("inbox", { kind: "adopt" })).items.find((q) => q.q === proposed.question);
		if (!q) throw new Error("missing proposal");
		const input = { q: q.q, onEvidence: q.evidenceHash, answer: { is: "accept" }, reason: "Looks unreliable" };
		expect((await h.call<{ status: string }[]>("decide", input, agent))[0]?.status).toBe("advised");
		expect((await gate("aaaa0001")).verdict).toBe("blocked");
		expect((await h.call<{ status: string }[]>("decide", { ...input, reason: " " }))[0]?.status).toBe("invalid");
		expect((await h.call<{ status: string }[]>("decide", input))[0]?.status).toBe("decided");
		await report("aaaa0001", true, "main", 2);
		expect((await gate("aaaa0001")).verdict).toBe("passed");
		const detail = (await h.call<{ quarantine: { decision: number } }[]>("get", { refs: ["T-1"] }))[0];
		const end = await h.call<ProposeReply>(
			"propose",
			{ edits: [{ op: "quarantine", test: "T-1", base: detail?.quarantine.decision, exit: null }], reason: "End it" },
			agent,
		);
		const endQ = (await h.call<InboxReply>("inbox", { kind: "adopt" })).items.find((q) => q.q === end.question);
		if (!endQ) throw new Error("missing exit proposal");
		expect(
			(
				await h.call<{ status: string }[]>(
					"decide",
					{ q: endQ.q, onEvidence: endQ.evidenceHash, answer: { is: "accept" }, reason: "End" },
					agent,
				)
			)[0]?.status,
		).toBe("advised");
		expect((await gate("aaaa0001")).verdict).toBe("passed");
	});
	test("a stale proposal cannot replace a newer quarantine decision", async () => {
		await report("aaaa0001");
		const stale = await h.call<ProposeReply>("propose", {
			edits: [{ op: "quarantine", test: "T-1", base: null, exit: { kind: "person" } }],
			reason: "Earlier draft",
		});
		await quarantine({ kind: "passes", count: 2 });
		const q = (await h.call<InboxReply>("inbox", { kind: "adopt" })).items.find((q) => q.q === stale.question);
		if (!q) throw new Error("missing stale question");
		expect(
			await h.raw("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "accept" }, reason: "Earlier" }),
		).toMatchObject({ ok: true, result: [{ status: "conflict" }] });
		expect((await gate("aaaa0001")).verdict).toBe("blocked");
	});
	test("another test with the same cause still blocks and keeps the quarantine visible", async () => {
		await h.call("report", ciReport({ commit: "aaaa0001", n: 2, fail: { 0: "expected green", 1: "expected green" } }));
		await quarantine({ kind: "person" });
		await h.call(
			"report",
			ciReport({ commit: "aaaa0001", n: 2, attempt: 2, fail: { 0: "expected green", 1: "expected green" } }),
		);
		expect(await gate("aaaa0001")).toMatchObject({
			verdict: "blocked",
			quarantined: 1,
			tally: { excused: 1, unexplained: 1 },
		});
		expect((await gate("aaaa0001")).reason).toContain("1 quarantined failure recorded, not blocking");
	});
	test("new failure signatures stay quarantined but required jobs still wait", async () => {
		await report("aaaa0001");
		await quarantine({ kind: "person" });
		const input = ciReport({ commit: "aaaa0002", n: 1, fail: { 0: "connection timeout" } });
		await h.call("report", input);
		await h.call("propose", { edits: [{ op: "create", outline: "Jobs case" }] });
		const planned = await h.call<{ run: string }>("plan", {
			name: "All jobs",
			select: { cases: ["C-1"] },
			accepts: { commit: "aaaa0002" },
			require: [
				{ id: "exercise", kind: "exercise", methods: ["auto"], minActors: 1, basis: "exact-or-assumed" },
				{ id: "jobs", kind: "jobs", jobs: ["e2e", "unit"] },
			],
		});
		expect(await gate("aaaa0002")).toMatchObject({ verdict: "passed", quarantined: 1 });
		expect(await h.call<GateStatus>("gate", { run: planned.run })).toMatchObject({
			verdict: "pending",
			tally: { missing: 2 },
		});
	});
	test("skips and failures reset the pass streak, while two clean commits end it", async () => {
		await report("aaaa0001");
		await quarantine({ kind: "passes", count: 2 });
		await report("aaaa0001", true, "main", 2);
		expect((await h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] }))[0]?.quarantine.active).toBe(true);
		await report("aaaa0002", false);
		expect((await h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] }))[0]?.quarantine.active).toBe(true);
		const skip = ciReport({ commit: "aaaa0003", n: 1 });
		await h.call("report", { ...skip, results: skip.results.map((row) => ({ ...row, outcome: "skip" })) });
		expect((await h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] }))[0]?.quarantine.active).toBe(true);
		await report("aaaa0004", false);
		expect((await h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] }))[0]?.quarantine.active).toBe(true);
		expect((await gate("aaaa0001")).verdict).toBe("passed");
		await report("aaaa0005");
		expect((await h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] }))[0]?.quarantine.active).toBe(true);
		await report("aaaa0006", false);
		expect((await h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] }))[0]?.quarantine.active).toBe(true);
		expect((await gate("aaaa0001")).verdict).toBe("passed");
		await report("aaaa0007", false);
		expect((await gate("aaaa0001")).verdict).toBe("passed");
		expect((await h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] }))[0]?.quarantine.active).toBe(false);
	});
	test("a failing lane on a trunk commit prevents a clean commit", async () => {
		await report("aaaa0001");
		await quarantine({ kind: "passes", count: 2 });
		await report("aaaa0001", true, "main", 2);
		expect((await h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] }))[0]?.quarantine.active).toBe(true);
		await report("aaaa0002", false);
		expect((await h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] }))[0]?.quarantine.active).toBe(true);
		await h.call("report", ciReport({ commit: "aaaa0002", job: "other-job", n: 1, fail: { 0: "expected green" } }));
		expect((await h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] }))[0]?.quarantine.active).toBe(true);
		await report("aaaa0003", false);
		expect((await h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] }))[0]?.quarantine.active).toBe(true);
		expect((await gate("aaaa0001")).verdict).toBe("passed");
		await report("aaaa0004", false);
		expect((await gate("aaaa0001")).verdict).toBe("passed");
		expect((await h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] }))[0]?.quarantine.active).toBe(false);
	});
	test("same-attempt disagreement keeps the failure, higher attempts can pass", async () => {
		await report("aaaa0001");
		await quarantine({ kind: "passes", count: 2 });
		await report("aaaa0001", true, "main", 2);
		expect((await h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] }))[0]?.quarantine.active).toBe(true);
		await report("aaaa0002");
		expect((await h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] }))[0]?.quarantine.active).toBe(true);
		await report("aaaa0002", false);
		expect((await h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] }))[0]?.quarantine.active).toBe(true);
		await report("aaaa0003", false);
		expect((await h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] }))[0]?.quarantine.active).toBe(true);
		expect((await gate("aaaa0001")).verdict).toBe("passed");
		await report("aaaa0003");
		expect((await h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] }))[0]?.quarantine.active).toBe(true);
		expect((await gate("aaaa0001")).verdict).toBe("passed");
		await report("aaaa0002", false, "main", 2);
		expect((await h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] }))[0]?.quarantine.active).toBe(true);
		await report("aaaa0003", false, "main", 2);
		expect((await gate("aaaa0001")).verdict).toBe("passed");
		expect((await h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] }))[0]?.quarantine.active).toBe(false);
	});
	test("agent reports do not satisfy a pass rule", async () => {
		await report("aaaa0001");
		await quarantine({ kind: "passes", count: 1 });
		await report("aaaa0001", true, "main", 2);
		expect((await h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] }))[0]?.quarantine.active).toBe(true);
		const agent = await h.actor("reporting-agent", "agent", ["read", "produce"]);
		await h.call("report", ciReport({ commit: "aaaa0002", n: 1 }), agent);
		expect((await h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] }))[0]?.quarantine.active).toBe(true);
		expect((await gate("aaaa0001")).verdict).toBe("passed");
		await report("aaaa0003", false);
		expect((await gate("aaaa0001")).verdict).toBe("passed");
		expect((await h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] }))[0]?.quarantine.active).toBe(false);
	});
	test("entry is project scoped and rejects missing tests, manual tests, mixed edits and missing reasons", async () => {
		await report("aaaa0001");
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
			expect((await h.raw("propose", input)).ok).toBe(false);
		await h.call("propose", { edits: [{ op: "create", outline: "Manual case" }] });
		await h.call("report", { target: { session: "manual" }, results: [{ test: { case: "C-1" }, outcome: "pass" }] });
		expect(
			await h.raw("propose", {
				edits: [{ op: "quarantine", test: "T-2", base: null, exit: { kind: "person" } }],
				reason: "Manual",
			}),
		).toMatchObject({ ok: false, error: { code: "invalid" } });
		await quarantine({ kind: "person" });
		const other = await harness({ project: "other", unlinked: "track" });
		try {
			await other.call("report", ciReport({ commit: "aaaa0001", n: 1, fail: { 0: "expected green" } }));
			expect((await other.call<GateStatus>("gate", { commit: "aaaa0001" })).verdict).toBe("blocked");
		} finally {
			await other.close();
		}
	});
	test("planned runs keep observation-time coverage at expiry, including a run planned afterward", async () => {
		await h.call("propose", { edits: [{ op: "create", body: { title: "Checkout", methods: ["auto"] } }] });
		const planned = await h.call<{ run: string }>("plan", {
			name: "Checkout regression",
			select: { cases: ["C-1"] },
			accepts: { commit: "aaaa0001" },
		});
		const input = ciReport({ commit: "aaaa0001", n: 1, fail: { 0: "expected green" } });
		await h.call("report", {
			...input,
			results: input.results.map((row) => ({ ...row, annotation: { case: "C-1", version: 1 } })),
		});
		expect((await h.call<GateStatus>("gate", { run: planned.run })).verdict).toBe("blocked");
		await quarantine({ kind: "expiry", at: 1_800_000_001_000 });
		await h.call("report", {
			...input,
			attempt: 2,
			results: input.results.map((row) => ({ ...row, annotation: { case: "C-1", version: 1 } })),
		});
		expect(await h.call<GateStatus>("gate", { run: planned.run })).toMatchObject({
			verdict: "passed",
			quarantined: 1,
			tally: { excused: 1, pass: 0 },
		});
		h.advance(1000);
		expect(await h.call<GateStatus>("gate", { run: planned.run })).toMatchObject({
			verdict: "passed",
			quarantined: 1,
			tally: { excused: 1, unexplained: 0 },
		});
		expect((await h.call<{ tally: GateStatus["tally"] }[]>("get", { refs: [planned.run] }))[0]?.tally.excused).toBe(1);
		const later = await h.call<{ run: string }>("plan", {
			name: "Later checkout regression",
			select: { cases: ["C-1"] },
			accepts: { commit: "aaaa0001" },
		});
		expect(await h.call<GateStatus>("gate", { run: later.run })).toMatchObject({ verdict: "passed", quarantined: 1 });
	});
});

test("archives retain quarantine decisions, exit rules and observations", async () => {
	await report("aaaa0001");
	await quarantine({ kind: "passes", count: 2 });
	await report("aaaa0001", true, "main", 2);
	await report("aaaa0002", false);
	await report("aaaa0003", false);
	const detail = (await h.call<{ last: { id: number; outcome: string }[] }[]>("get", { refs: ["T-1"] }))[0];
	const failure = detail?.last.find((result) => result.outcome === "fail");
	if (!failure) throw new Error("missing quarantined failure");
	let archive = "";
	await h.app.database.read(
		async (db) =>
			await exportArchive(
				db,
				(chunk) => {
					archive += chunk;
				},
				{ now: 1_800_000_000_500 },
			),
	);
	expect(archive).toContain('"quarantines"');
	const importedFixture = await testDatabase();
	const imported = await Database.open({ url: importedFixture.url });
	try {
		await imported.write(
			async (db) => await db.transaction(async () => await importArchive(db, archive.trimEnd().split("\n"))),
		);
		const entry = (await imported.read(async (db) => await quarantineEntries(db, 1)))[0];
		if (!entry) throw new Error("quarantine did not survive archive import");
		expect(entry).toMatchObject({
			actor: h.owner.id,
			reason: "Keep failures visible while repairing the test",
			exit_rule: '{"kind":"passes","count":2}',
		});
		expect(await imported.read(async (db) => await effectiveQuarantine(db, entry, h.app.now()))).toBe(false);
		expect(await imported.read(async (db) => await (await quarantineLookup(db, 1))(failure.id))).toMatchObject({
			decision: entry.decision,
			quarantined: true,
		});
	} finally {
		await imported.close();
		await importedFixture.close();
	}
	expect(await gate("aaaa0001")).toMatchObject({ verdict: "passed", quarantined: 1 });
});

test("audit keeps each quarantine test and exit rule after its standing is replaced", async () => {
	await report("aaaa0001");
	const entry = await quarantine({ kind: "passes", count: 2 });
	if (!entry) throw new Error("missing entry decision");
	const ending = await quarantine(null, entry.decision);
	if (!ending) throw new Error("missing exit decision");
	const file = AuditReply.parse(await h.call("audit", {})).ndjson;
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
	test(`quarantine excuses only automated failures in a disputed slot, mixed=${mixed}`, async () => {
		await h.call("propose", { edits: [{ op: "create", outline: "Checkout regression" }] });
		const planned = await h.call<{ run: string }>("plan", {
			name: "Disputed checkout",
			select: { cases: ["C-1"] },
			accepts: { commit: "aaaa0001" },
		});
		const input = ciReport({ commit: "aaaa0001", n: 1, fail: { 0: "expected green" } });
		await h.call("report", {
			...input,
			results: input.results.map((row) => ({ ...row, annotation: { case: "C-1", version: 1 } })),
		});
		await h.call("report", { run: planned.run, results: [{ test: { case: "C-1" }, outcome: "pass" }] });
		if (mixed) {
			const tester = await h.actor("tester", "human", ["read", "produce"]);
			await h.call(
				"report",
				{
					run: planned.run,
					results: [{ test: { case: "C-1" }, outcome: "fail", failure: { message: "Manual failure" } }],
				},
				tester,
			);
		}
		expect(await h.call<GateStatus>("gate", { run: planned.run })).toMatchObject({
			verdict: "blocked",
			tally: { disputed: 1 },
		});
		await quarantine({ kind: "expiry", at: 1_800_000_001_000 });
		await h.call("report", {
			...input,
			attempt: 2,
			results: input.results.map((row) => ({ ...row, annotation: { case: "C-1", version: 1 } })),
		});
		expect(await h.call<GateStatus>("gate", { run: planned.run })).toMatchObject({
			verdict: mixed ? "blocked" : "passed",
			quarantined: 1,
			tally: mixed ? { disputed: 1, excused: 0 } : { disputed: 0, excused: 1, pass: 0 },
		});
		expect(
			(await h.call<{ items: { state: string }[] }>("find", { in: "slots", run: planned.run })).items.map(
				(slot) => slot.state,
			),
		).toEqual(["disputed"]);
		h.advance(1000);
		expect(await h.call<GateStatus>("gate", { run: planned.run })).toMatchObject({
			verdict: mixed ? "blocked" : "passed",
			quarantined: 1,
			tally: mixed ? { disputed: 1, excused: 0 } : { disputed: 0, excused: 1, pass: 0 },
		});
	});
}

for (const endBeforeClosure of [false, true]) {
	test(`tracker closure and quarantine exit preserve each other's decisions, exitFirst=${endBeforeClosure}`, async () => {
		h.app.config.github = { project: "scratch", repository: "acme/web", token: "local-test-tracker-credential" };
		await report("aaaa0001");
		const failure = (await h.call<InboxReply>("inbox", { kind: "failure" })).items[0];
		if (!failure) throw new Error("missing failure question");
		const defect = (
			await h.call<{ status: string; decision: number }[]>("decide", {
				q: failure.q,
				onEvidence: failure.evidenceHash,
				answer: { is: "defect", ref: "https://github.com/acme/web/issues/42" },
				reason: "Tracked checkout defect",
			})
		)[0];
		expect(defect?.status).toBe("decided");
		expect(await gate("aaaa0001")).toMatchObject({ verdict: "failed", tally: { attributed: 1 } });
		const entry = await quarantine({ kind: "person" });
		if (!entry) throw new Error("missing quarantine decision");
		expect(await gate("aaaa0001")).toMatchObject({ verdict: "failed", tally: { attributed: 1 } });
		await report("aaaa0001", true, "main", 2);
		expect(await gate("aaaa0001")).toMatchObject({ verdict: "passed", quarantined: 1 });
		if (endBeforeClosure) {
			await quarantine(null, entry.decision);
			expect(await gate("aaaa0001")).toMatchObject({ verdict: "passed", quarantined: 1 });
		}
		const issue = { ref: "github:acme/web#42", url: "https://github.com/acme/web/issues/42", state: "closed" } as const;
		expect(await pollDefectHolds(h.app, { createDefect: async () => issue, getItem: async () => issue })).toBe(1);
		const file = AuditReply.parse(await h.call("audit", {})).ndjson;
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
			expect(await gate("aaaa0001")).toMatchObject({ verdict: "passed", quarantined: 1, tally: { excused: 1 } });
			expect((await h.call<{ quarantine: Quarantine }[]>("get", { refs: ["T-1"] }))[0]?.quarantine).toMatchObject({
				decision: entry.decision,
				active: true,
			});
			await quarantine(null, entry.decision);
		}
		expect(await gate("aaaa0001")).toMatchObject({
			verdict: "passed",
			quarantined: 1,
			tally: { unexplained: 0, attributed: 0, excused: 1 },
		});
	});
}
