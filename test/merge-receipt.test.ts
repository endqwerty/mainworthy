import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { z } from "zod";
import { AuditReply, verifyAudit } from "../src/core/audit.ts";
import { MergeReceipt, receiptNodeHash, receiptSnapshotHash } from "../src/core/changes.ts";
import type { GateStatus, InboxReply, ReportReceipt } from "../src/core/ops.ts";
import { mergeReceiptById } from "../src/server/decisions/questions.ts";
import { changeByKey, setMergeReceipt } from "../src/server/evidence/evidence.ts";
import { findProject, makeCtx } from "../src/server/kernel/ctx.ts";
import { Db } from "../src/server/kernel/db.ts";
import { migrate } from "../src/server/kernel/migrate.ts";
import { exportArchive } from "../src/server/transfer/transfer.ts";
import { openApi } from "../src/surfaces/http.ts";
import { ciReport, dropReceiptSchema, type Harness, harness } from "./helpers.ts";

let h: Harness;
beforeEach(() => {
	h = harness();
});
afterEach(() => h.close());
const receipt = () => {
	const found = h.call<{ change: unknown }>("impact", { change: "pr:726" });
	return z.object({ mergeReceipt: MergeReceipt.nullable() }).parse(found.change).mergeReceipt;
};
const end = (extra = {}) => h.call("change", { change: "pr:726", state: "merged", ...extra });
const report = (commit = "receipt726", fail = true) =>
	ciReport({ commit, branch: "feature", pr: 726, n: 1, ...(fail ? { fail: { 0: "Timed out" } } : {}) });

describe("the gate when a merge was reported", () => {
	test("a fast-forward preserves counted standing and its decision before trunk judges it", () => {
		const sent = h.call<ReportReceipt>("report", report());
		const q = h.call<InboxReply>("inbox", { kind: "failure" }).items[0];
		if (!q) throw new Error("Expected failure");
		const decision = h.call<{ decision: number }[]>("decide", {
			q: q.q,
			onEvidence: q.evidenceHash,
			answer: { is: "flaky" },
		})[0]?.decision;
		expect(h.call<GateStatus>("gate", { change: "pr:726" }).verdict).toBe("passed");
		end({ head: "receipt726", landing: { commit: "receipt726", branch: "main" } });
		expect(receipt()).toMatchObject({
			head: "receipt726",
			gate: { verdict: "passed", tally: { excused: 1, unexplained: 0 } },
			count: 1,
		});
		expect(h.call<{ items: unknown[] }>("find", { in: "receipt-results", receipt: receipt()?.id }).items).toMatchObject(
			[{ result: sent.results[0], standing: "excused", decision, decisionAnswer: "flaky" }],
		);
		expect(h.call<GateStatus>("gate", { change: "pr:726" }).verdict).toBe("blocked");
		const frozen = receipt();
		h.advance(15 * 86400000);
		h.call("report", { ...report(), attempt: 2 });
		expect(end({ landing: { commit: "receipt726", branch: "main" } })).toMatchObject({ already: true });
		expect(receipt()).toEqual(frozen);
		expect(
			h.call<{ change: { mergeReceipt: unknown } }>("impact", { change: "pr:726" }).change.mergeReceipt,
		).toMatchObject(frozen ?? {});
	});

	test("an unreported head records pending and later jobs do not rewrite it", () => {
		h.call("report", report());
		end({ head: "unseen726" });
		expect(receipt()).toMatchObject({ head: "unseen726", gate: { verdict: "pending" }, count: 0 });
		const frozen = receipt();
		h.call("report", report("unseen726", false));
		expect(h.call<GateStatus>("gate", { change: "pr:726" }).verdict).toBe("passed");
		expect(end()).toMatchObject({ already: true });
		expect(receipt()).toEqual(frozen);
	});

	test("the ending's explicit head owns the receipt even if an older head was passing", () => {
		h.call("report", report("oldhead726", false));
		h.call("report", report("newhead726"));
		end({ head: "oldhead726" });
		expect(receipt()).toMatchObject({ head: "oldhead726", gate: { verdict: "passed" } });
		const firstAt = receipt()?.at ?? 0;
		end({ head: "newhead726" });
		expect(receipt()).toMatchObject({ head: "newhead726", gate: { verdict: "blocked" } });
		expect(receipt()?.at).toBeGreaterThan(firstAt);
	});

	test("closed and reopened changes have no current merge receipt, and a new merge takes a new one", () => {
		h.call("report", report());
		expect(receipt()).toBeNull();
		end();
		const firstAt = receipt()?.at ?? 0;
		h.call("change", { change: "pr:726", state: "closed" });
		expect(receipt()).toBeNull();
		h.call("change", { change: "pr:726", state: "open" });
		expect(receipt()).toBeNull();
		h.call("report", { ...report("receipt726", false), attempt: 2 });
		end();
		expect(receipt()).toMatchObject({ gate: { verdict: "passed" } });
		expect(receipt()?.at).toBeGreaterThan(firstAt);
	});
});

test("receipt history persists and remains in the audit after reopening, while archives omit it", () => {
	h.call("report", report("receipt726", false));
	end();
	const frozen = receipt();
	if (!frozen) throw new Error("Expected receipt");
	const stored = new Db(h.app.db.raw.serialize());
	try {
		expect(mergeReceiptById(stored, 1, frozen.id)).toEqual(frozen);
	} finally {
		stored.close();
	}
	h.call("change", { change: "pr:726", state: "open" });
	expect(receipt()).toBeNull();
	end();
	const audit = AuditReply.parse(h.call("audit", {}));
	expect(verifyAudit(audit.ndjson).records).toBeGreaterThan(0);
	const history = audit.ndjson
		.split("\n")
		.filter((line) => line.includes('"type":"merge-receipt"'))
		.map((line) => JSON.parse(line));
	expect(history).toHaveLength(2);
	expect(history[0]).toMatchObject({ receipt: frozen });
	const chunks: string[] = [];
	exportArchive(h.app.db, (chunk) => chunks.push(chunk), { project: "scratch" });
	expect(chunks.join("")).not.toContain('"t":"merge_receipts"');
});

test("an old merged change gains no invented receipt during migration", () => {
	h.call("report", report("receipt726", false));
	dropReceiptSchema(h.app.db);
	h.app.db.exec(
		"INSERT INTO change_ends (change, ended, at) VALUES (1, 'merged', 1); UPDATE meta SET value = '40' WHERE key = 'schema_version'",
	);
	migrate(h.app.db, ":memory:");
	expect(receipt()).toBeNull();
	expect(h.call<GateStatus>("gate", { change: "pr:726" }).verdict).toBe("passed");
	expect(end()).toMatchObject({ already: false });
	expect(receipt()).toMatchObject({ head: "receipt726", gate: { verdict: "passed" } });
});

test("a failed landing rolls back the receipt and its active selection", () => {
	h.call("report", report("receipt726", false));
	h.app.db.exec(
		"CREATE TRIGGER fail_landing BEFORE UPDATE OF landing_commit ON change_ends BEGIN SELECT RAISE(ABORT, 'landing interrupted'); END",
	);
	expect(
		h.raw("change", { change: "pr:726", state: "merged", landing: { commit: "receipt726", branch: "main" } }).ok,
	).toBe(false);
	expect(receipt()).toBeNull();
	expect(h.app.db.raw.query("SELECT count(*) AS n FROM merge_receipts").get()).toEqual({ n: 0 });
	h.app.db.exec("DROP TRIGGER fail_landing");
	end();
	expect(receipt()?.gate.verdict).toBe("passed");
});

test("selecting a merge receipt refuses a value the decision machinery did not mint", () => {
	h.call("report", report());
	const change = changeByKey(h.app.db, 1, "pr:726");
	const project = findProject(h.app.db, "scratch");
	if (!change || !project) throw new Error("Expected change and project");
	const ctx = makeCtx(h.app, project, h.owner, true);
	expect(() => Reflect.apply(setMergeReceipt, null, [ctx, {}, change])).toThrow("not a witness");
	expect(receipt()).toBeNull();
});

test("OpenAPI declares merge receipts and landing gates in the impact output schema", () => {
	const schema = z.object({ paths: z.record(z.string(), z.unknown()) }).parse(openApi()).paths[
		"/api/p/{project}/impact"
	];
	if (!schema) throw new Error("Expected impact path");
	expect(JSON.stringify(schema)).toContain('"mergeReceipt":');
	expect(JSON.stringify(schema)).toContain('"landing":');
});

test("a large report shares its frozen evidence across repeated reopen and merge observations", () => {
	h.call("report", ciReport({ commit: "receipt726", branch: "feature", pr: 726, n: 3000 }));
	end();
	const before = h.app.db.raw.serialize().byteLength;
	for (let i = 0; i < 6; i++) {
		h.call("change", { change: "pr:726", state: "open" });
		end();
	}
	expect(h.app.db.raw.serialize().byteLength - before).toBeLessThan(65536);
});

test("reading a change with a large receipt returns a bounded manifest and pages its frozen results", () => {
	h.call("report", ciReport({ commit: "receipt726", branch: "feature", pr: 726, n: 3000 }));
	end();
	const impact = h.call<{ change: { mergeReceipt: { id: number; count: number } } }>("impact", { change: "pr:726" });
	expect(JSON.stringify(impact.change.mergeReceipt).length).toBeLessThan(4096);
	expect(impact.change.mergeReceipt.count).toBe(3000);
	const page = h.call<{ count: number; cursor: string | null; items: unknown[] }>("find", {
		in: "receipt-results",
		receipt: impact.change.mergeReceipt.id,
		limit: 25,
	});
	expect(page.count).toBe(3000);
	expect(page.items).toHaveLength(25);
	expect(page.cursor).not.toBeNull();
});

test("frozen receipt pages remain complete across new evidence, and audit pages verify their manifest", () => {
	h.call("report", ciReport({ commit: "receipt726", branch: "feature", pr: 726, n: 123 }));
	end();
	const kept = receipt();
	if (!kept) throw new Error("Expected receipt");
	const first = h.call<{ items: { result: number; name: string }[]; cursor: string | null }>("find", {
		in: "receipt-results",
		receipt: kept.id,
		limit: 25,
	});
	h.call("change", { change: "pr:726", state: "open" });
	h.call("report", { ...ciReport({ commit: "receipt726", branch: "feature", pr: 726, n: 123 }), attempt: 2 });
	let cursor = first.cursor;
	const rows = [...first.items];
	while (cursor) {
		const page = h.call<typeof first>("find", { in: "receipt-results", receipt: kept.id, cursor, limit: 25 });
		rows.push(...page.items);
		cursor = page.cursor;
	}
	expect(rows).toHaveLength(123);
	expect(new Set(rows.map((row) => row.result)).size).toBe(123);
	expect(h.raw("find", { in: "receipt-results", receipt: kept.id, cursor: `999.results.0` }).ok).toBe(false);
	const evidence: { kind: string; hash: string; body: string }[] = [];

	let auditCursor: string | null = null;
	let count = 0;
	do {
		const page = AuditReply.parse(
			h.call("audit", { receipt: kept.id, limit: 17, ...(auditCursor ? { cursor: auditCursor } : {}) }),
		);
		expect(verifyAudit(page.ndjson).records).toBe(page.records);
		const members = page.ndjson
			.split("\n")
			.filter((line) => line.includes('"type":"merge-evidence"'))
			.map((line) =>
				z.object({ ordinal: z.number(), kind: z.string(), hash: z.string(), body: z.string() }).parse(JSON.parse(line)),
			)
			.sort((a, b) => a.ordinal - b.ordinal);
		for (const member of members) {
			evidence.push(member);
			count++;
		}
		auditCursor = page.cursor ?? null;
	} while (auditCursor);
	expect(count).toBe(kept.evidenceCount);
	function tree(items: { key: number; hash: string; count: number }[]): string | null {
		if (!items.length) return null;
		let rows = items;
		for (let level = 0; level <= 10; level++) {
			const groups = new Map<number, typeof rows>();
			for (const row of rows) {
				const parent = Math.floor(row.key / 32);
				const group = groups.get(parent) ?? [];
				group.push(row);
				groups.set(parent, group);
			}
			rows = [...groups].map(([key, children]) => ({
				key,
				count: children.reduce((sum, row) => sum + row.count, 0),
				hash: receiptNodeHash(
					level,
					children.map((row) => ({ slot: row.key % 32, hash: row.hash, count: row.count })),
				),
			}));
		}
		return rows[0]?.hash ?? null;
	}
	const gates = evidence.filter((row) => row.kind === "gate").map((row, key) => ({ key, hash: row.hash, count: 1 }));
	const results = evidence
		.filter((row) => row.kind === "result")
		.map((row) => ({
			key: z.object({ result: z.number() }).parse(JSON.parse(row.body)).result,
			hash: row.hash,
			count: 1,
		}));
	expect(receiptSnapshotHash(tree(results), tree(gates))).toBe(kept.snapshot);
});

test("a receipt summarizes large shard waits and pages their complete frozen evidence", () => {
	h.call("report", ciReport({ commit: "receipt726", branch: "feature", pr: 726, n: 1, shard: { index: 1, of: 1000 } }));
	end();
	const kept = receipt();
	expect(kept).toMatchObject({ gate: { verdict: "pending" }, waitingCount: 1 });
	expect(JSON.stringify(kept).length).toBeLessThan(4096);
	const audit = AuditReply.parse(h.call("audit", { receipt: kept?.id }));
	expect(audit.ndjson).toContain('"collection\\":\\"waiting');
	expect(verifyAudit(audit.ndjson).records).toBe(kept?.evidenceCount ?? 0);
});

for (const mutation of ["questions", "one result"] as const)
	test(`large failing receipts share pages when changing ${mutation}`, () => {
		const n = z.coerce
			.number()
			.int()
			.min(3000)
			.max(100000)
			.parse(process.env.MAINWORTHY_RECEIPT_TEST_RESULTS ?? 3000);
		h.call("report", ciReport({ commit: "receipt726", branch: "feature", pr: 726, n, fail: { 7: "boom" } }));
		end();
		const before = h.app.db.raw.serialize().byteLength;
		const members = () =>
			z.object({ n: z.number() }).parse(h.app.db.raw.query("SELECT count(*) AS n FROM merge_receipt_members").get()).n;
		const initial = members();
		const mergeMs: number[] = [];
		for (let i = 0; i < 6; i++) {
			h.call("change", { change: "pr:726", state: "open" });
			if (mutation === "one result")
				h.call("report", ciReport({ commit: "receipt726", branch: "feature", pr: 726, n: 1, only: [n + i] }));
			const start = performance.now();
			end();
			mergeMs.push(performance.now() - start);
		}
		if (process.env.MAINWORTHY_RECEIPT_TEST_RESULTS)
			console.log(
				JSON.stringify({
					mutation,
					n,
					mergeMs,
					members: members() - initial,
					growthBytes: h.app.db.raw.serialize().byteLength - before,
				}),
			);
		expect(members() - initial).toBeLessThan(1500);
		expect(h.app.db.raw.serialize().byteLength - before).toBeLessThan(262144);
	});

test("a clean result tree performs no result-page reads on reopen and merge", () => {
	h.call("report", ciReport({ commit: "receipt726", branch: "feature", pr: 726, n: 3000, fail: { 7: "boom" } }));
	end();
	h.call("change", { change: "pr:726", state: "open" });
	const reads = spyOn(h.app.db, "all");
	try {
		end();
		expect(
			reads.mock.calls.filter(
				([statement]) => statement.text.includes("FROM run_tests") && statement.text.includes("result/32"),
			),
		).toHaveLength(0);
	} finally {
		reads.mockRestore();
	}
});

test("cached receipt pages refresh cause answers, labels and removed result keys", () => {
	const sent = h.call<ReportReceipt>("report", report());
	end();
	const old = receipt();
	h.call("change", { change: "pr:726", state: "open" });
	const question = h.call<InboxReply>("inbox", { kind: "failure" }).items[0];
	if (!question || !old) throw new Error("Expected question and receipt");
	h.call("decide", { q: question.q, onEvidence: question.evidenceHash, answer: { is: "flaky" } });
	end();
	const excused = receipt();
	expect(h.call<{ items: unknown[] }>("find", { in: "receipt-results", receipt: excused?.id }).items).toMatchObject([
		{ standing: "excused", decisionAnswer: "flaky" },
	]);
	expect(h.call<{ items: unknown[] }>("find", { in: "receipt-results", receipt: old.id }).items).toMatchObject([
		{ standing: "unexplained", decision: null },
	]);
	h.call("change", { change: "pr:726", state: "open" });
	h.call("decide", { undo: question.q, reason: "Recheck this failure" });
	end();
	expect(h.call<{ items: unknown[] }>("find", { in: "receipt-results", receipt: receipt()?.id }).items).toMatchObject([
		{ standing: "unexplained", decision: null },
	]);
	h.call("change", { change: "pr:726", state: "open" });
	const corrected = { ...report("receipt726", false), attempt: 2 };
	h.call("report", { ...corrected, results: corrected.results.map((row) => ({ ...row, corrects: sent.results[0] })) });
	h.app.db.exec("UPDATE tests SET name='Renamed test' WHERE id=1");
	end();
	expect(h.call<{ items: unknown[] }>("find", { in: "receipt-results", receipt: receipt()?.id }).items).toMatchObject([
		{ name: "Renamed test", standing: "pass", decision: null },
	]);
	expect(
		h.call<{ items: { result: number }[] }>("find", { in: "receipt-results", receipt: receipt()?.id }).items[0]?.result,
	).not.toBe(sent.results[0] ?? 0);
});

test("one test in many lanes keeps bounded tree leaves and complete result pages", () => {
	for (let i = 0; i < 100; i++) h.call("report", { ...report("receipt726", false), job: `lane-${i}` });
	end();
	const kept = receipt();
	if (!kept) throw new Error("Expected receipt");
	let cursor: string | null = null;
	const ids: number[] = [];
	do {
		const page: { items: { result: number }[]; cursor: string | null } = h.call<{
			items: { result: number }[];
			cursor: string | null;
		}>("find", {
			in: "receipt-results",
			receipt: kept.id,
			...(cursor ? { cursor } : {}),
			limit: 500,
		});
		expect(page.items.length).toBeLessThanOrEqual(50);
		ids.push(...page.items.map((row) => row.result));
		cursor = page.cursor;
	} while (cursor);
	expect(ids).toHaveLength(100);
	expect(new Set(ids).size).toBe(100);
});
