import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { z } from "zod";
import { budget } from "../scripts/budget.ts";
import { verifyAudit } from "../src/core/audit.ts";
import { MergeReceipt, receiptNodeHash, receiptSnapshotHash } from "../src/core/changes.ts";
import type { GateStatus, InboxReply, ReportReceipt } from "../src/core/ops.ts";
import { AuditReply } from "../src/core/replies.ts";
import { mergeReceiptById } from "../src/server/decisions/questions.ts";
import { changeByKey, setMergeReceipt } from "../src/server/evidence/evidence.ts";
import { findProject, makeCtx } from "../src/server/kernel/ctx.ts";
import { Database, sql, type WriteDb } from "../src/server/kernel/db.ts";

import { exportArchive } from "../src/server/transfer/transfer.ts";
import { openApi } from "../src/surfaces/http.ts";

import { ciReport, type Harness, harness } from "./helpers.ts";

let h: Harness;
beforeEach(async () => {
	h = await harness();
});
afterEach(async () => await h?.close());
const receipt = async () => {
	const found = await h.call<{ change: unknown }>("impact", { change: "pr:726" });
	return z.object({ mergeReceipt: MergeReceipt.nullable() }).parse(found.change).mergeReceipt;
};
const end = async (extra = {}) => await h.call("change", { change: "pr:726", state: "merged", ...extra });
const report = (commit = "receipt726", fail = true) =>
	ciReport({ commit, branch: "feature", pr: 726, n: 1, ...(fail ? { fail: { 0: "Timed out" } } : {}) });

describe("the gate when a merge was reported", () => {
	test("a fast-forward preserves counted standing and its decision before trunk judges it", async () => {
		const sent = await h.call<ReportReceipt>("report", report());
		const q = (await h.call<InboxReply>("inbox", { kind: "failure" })).items[0];
		if (!q) throw new Error("Expected failure");
		const decision = (
			await h.call<{ decision: number }[]>("decide", {
				q: q.q,
				onEvidence: q.evidenceHash,
				answer: { is: "flaky" },
			})
		)[0]?.decision;
		expect((await h.call<GateStatus>("gate", { change: "pr:726" })).verdict).toBe("passed");
		await end({ head: "receipt726", landing: { commit: "receipt726", branch: "main" } });
		expect(await receipt()).toMatchObject({
			head: "receipt726",
			gate: { verdict: "passed", tally: { excused: 1, unexplained: 0 } },
			count: 1,
		});
		expect(
			(await h.call<{ items: unknown[] }>("find", { in: "receipt-results", receipt: (await receipt())?.id })).items,
		).toMatchObject([{ result: sent.results[0], standing: "excused", decision, decisionAnswer: "flaky" }]);
		expect((await h.call<GateStatus>("gate", { change: "pr:726" })).verdict).toBe("blocked");
		const frozen = await receipt();
		h.advance(15 * 86400000);
		await h.call("report", { ...report(), attempt: 2 });
		expect(await end({ landing: { commit: "receipt726", branch: "main" } })).toMatchObject({ already: true });
		expect(await receipt()).toEqual(frozen);
		expect(
			(await h.call<{ change: { mergeReceipt: unknown } }>("impact", { change: "pr:726" })).change.mergeReceipt,
		).toMatchObject(frozen ?? {});
	});

	test("an unreported head records pending and later jobs do not rewrite it", async () => {
		await h.call("report", report());
		await end({ head: "unseen726" });
		expect(await receipt()).toMatchObject({ head: "unseen726", gate: { verdict: "pending" }, count: 0 });
		const frozen = await receipt();
		await h.call("report", report("unseen726", false));
		expect((await h.call<GateStatus>("gate", { change: "pr:726" })).verdict).toBe("passed");
		expect(await end()).toMatchObject({ already: true });
		expect(await receipt()).toEqual(frozen);
	});

	test("the ending's explicit head owns the receipt even if an older head was passing", async () => {
		await h.call("report", report("oldhead726", false));
		await h.call("report", report("newhead726"));
		await end({ head: "oldhead726" });
		expect(await receipt()).toMatchObject({ head: "oldhead726", gate: { verdict: "passed" } });
		const firstAt = (await receipt())?.at ?? 0;
		await end({ head: "newhead726" });
		expect(await receipt()).toMatchObject({ head: "newhead726", gate: { verdict: "blocked" } });
		expect((await receipt())?.at).toBeGreaterThan(firstAt);
	});

	test("closed and reopened changes have no current merge receipt, and a new merge takes a new one", async () => {
		await h.call("report", report());
		expect(await receipt()).toBeNull();
		await end();
		const firstAt = (await receipt())?.at ?? 0;
		await h.call("change", { change: "pr:726", state: "closed" });
		expect(await receipt()).toBeNull();
		await h.call("change", { change: "pr:726", state: "open" });
		expect(await receipt()).toBeNull();
		await h.call("report", { ...report("receipt726", false), attempt: 2 });
		await end();
		expect(await receipt()).toMatchObject({ gate: { verdict: "passed" } });
		expect((await receipt())?.at).toBeGreaterThan(firstAt);
	});
});

test("receipt history persists and remains in the audit after reopening, while archives omit it", async () => {
	await h.call("report", report("receipt726", false));
	await end();
	const frozen = await receipt();
	if (!frozen) throw new Error("Expected receipt");
	const stored = await Database.open({ url: h.app.config.databaseUrl });
	try {
		expect(await stored.read(async (db) => await mergeReceiptById(db, 1, frozen.id))).toEqual(frozen);
	} finally {
		await stored.close();
	}
	await h.call("change", { change: "pr:726", state: "open" });
	expect(await receipt()).toBeNull();
	await end();
	const audit = AuditReply.parse(await h.call("audit", {}));
	expect(verifyAudit(audit.ndjson).records).toBeGreaterThan(0);
	const history = audit.ndjson
		.split("\n")
		.filter((line) => line.includes('"type":"merge-receipt"'))
		.map((line) => JSON.parse(line));
	expect(history).toHaveLength(2);
	expect(history[0]).toMatchObject({ receipt: frozen });
	const chunks: string[] = [];
	await h.app.database.write(
		async (db) =>
			await db.transaction(async () => await exportArchive(db, (chunk) => chunks.push(chunk), { project: "scratch" })),
	);
	expect(chunks.join("")).not.toContain('"t":"merge_receipts"');
});

test("a failed landing rolls back the receipt and its active selection", async () => {
	await h.call("report", report("receipt726", false));
	await h.app.database.write(
		async (db) =>
			await db.transaction(
				async () =>
					await db.exec(
						"CREATE FUNCTION fail_landing_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'landing interrupted'; END $$; CREATE TRIGGER fail_landing BEFORE UPDATE OF landing_commit ON change_ends FOR EACH ROW EXECUTE FUNCTION fail_landing_fn()",
					),
			),
	);
	expect(
		(await h.raw("change", { change: "pr:726", state: "merged", landing: { commit: "receipt726", branch: "main" } }))
			.ok,
	).toBe(false);
	expect(await receipt()).toBeNull();
	expect(
		await h.app.database.read(
			async (db) => await db.get(sql<readonly [], { n: number }>("SELECT count(*) AS n FROM merge_receipts")),
		),
	).toEqual({ n: 0 });
	await h.app.database.write(
		async (db) =>
			await db.transaction(
				async () => await db.exec("DROP TRIGGER fail_landing ON change_ends; DROP FUNCTION fail_landing_fn()"),
			),
	);
	await end();
	expect((await receipt())?.gate.verdict).toBe("passed");
});

test("selecting a merge receipt refuses a value the decision machinery did not mint", async () => {
	await h.call("report", report());
	const change = await h.app.database.read(async (db) => await changeByKey(db, 1, "pr:726"));
	const project = await h.app.database.read(async (db) => await findProject(db, "scratch"));
	if (!change || !project) throw new Error("Expected change and project");
	await h.app.database.write(
		async (db) =>
			await db.transaction(async () => {
				const ctx = makeCtx(h.app, db, project, h.owner, true);
				await expect(Reflect.apply(setMergeReceipt, null, [ctx, {}, change])).rejects.toThrow("not a witness");
			}),
	);
	expect(await receipt()).toBeNull();
});

test("OpenAPI declares merge receipts and landing gates in the impact output schema", () => {
	const schema = z.object({ paths: z.record(z.string(), z.unknown()) }).parse(openApi()).paths[
		"/api/p/{project}/impact"
	];
	if (!schema) throw new Error("Expected impact path");
	expect(JSON.stringify(schema)).toContain('"mergeReceipt":');
	expect(JSON.stringify(schema)).toContain('"landing":');
	expect(JSON.stringify(schema)).toContain('"next":');
});

test("a large report shares its frozen evidence across repeated reopen and merge observations", async () => {
	await h.call("report", ciReport({ commit: "receipt726", branch: "feature", pr: 726, n: 3000 }));
	const beforeFreeze = h.app.database.statementCount;
	await end();
	expect(h.app.database.statementCount - beforeFreeze).toBeLessThan(1000);
	const before = await receiptBytes();
	for (let i = 0; i < 6; i++) {
		await h.call("change", { change: "pr:726", state: "open" });
		await end();
	}
	budget("database growth of six reopened changes", (await receiptBytes()) - before, 65535, "bytes");
});

test("reading a change with a large receipt returns a bounded manifest and pages its frozen results", async () => {
	await h.call("propose", {
		edits: Array.from({ length: 201 }, (_, i) => ({
			op: "create",
			outline: `Affected case ${i + 1}\n  Check > Works`,
			covers: ["REQ-396"],
		})),
	});
	const report = ciReport({ commit: "receipt726", branch: "feature", pr: 726, n: 3000 });
	await h.call("report", { ...report, target: { ...report.target, title: "REQ-396: review affected cases" } });
	await end();
	type Impact = { change: { mergeReceipt: { id: number; count: number } }; cases: unknown[]; next: string | null };
	const impact = await h.call<Impact>("impact", { change: "pr:726" });
	budget("a large merge receipt's manifest", JSON.stringify(impact.change.mergeReceipt).length, 4095, "characters");
	expect(impact.change.mergeReceipt.count).toBe(3000);
	expect(impact.cases).toHaveLength(200);
	expect(typeof impact.next).toBe("string");
	const rest = await h.call<Impact>("impact", { change: "pr:726", cursor: impact.next });
	expect(rest.change.mergeReceipt).toEqual(impact.change.mergeReceipt);
	expect(rest.cases).toHaveLength(1);
	expect(rest.next).toBeNull();
	const page = await h.call<{ count: number; cursor: string | null; items: unknown[] }>("find", {
		in: "receipt-results",
		receipt: impact.change.mergeReceipt.id,
		limit: 25,
	});
	expect(page.count).toBe(3000);
	expect(page.items).toHaveLength(25);
	expect(page.cursor).not.toBeNull();
});

test("frozen receipt pages remain complete across new evidence, and audit pages verify their manifest", async () => {
	await h.call("report", ciReport({ commit: "receipt726", branch: "feature", pr: 726, n: 123 }));
	await end();
	const kept = await receipt();
	if (!kept) throw new Error("Expected receipt");
	const first = await h.call<{ items: { result: number; name: string }[]; cursor: string | null }>("find", {
		in: "receipt-results",
		receipt: kept.id,
		limit: 25,
	});
	await h.call("change", { change: "pr:726", state: "open" });
	await h.call("report", { ...ciReport({ commit: "receipt726", branch: "feature", pr: 726, n: 123 }), attempt: 2 });
	let cursor = first.cursor;
	const rows = [...first.items];
	while (cursor) {
		const page = await h.call<typeof first>("find", { in: "receipt-results", receipt: kept.id, cursor, limit: 25 });
		rows.push(...page.items);
		cursor = page.cursor;
	}
	expect(rows).toHaveLength(123);
	expect(new Set(rows.map((row) => row.result)).size).toBe(123);
	expect((await h.raw("find", { in: "receipt-results", receipt: kept.id, cursor: `999.results.0` })).ok).toBe(false);
	const evidence: { kind: string; hash: string; body: string }[] = [];

	let auditCursor: string | null = null;
	let count = 0;
	do {
		const page = AuditReply.parse(
			await h.call("audit", { receipt: kept.id, limit: 17, ...(auditCursor ? { cursor: auditCursor } : {}) }),
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

test("a receipt summarizes large shard waits and pages their complete frozen evidence", async () => {
	await h.call(
		"report",
		ciReport({ commit: "receipt726", branch: "feature", pr: 726, n: 1, shard: { index: 1, of: 1000 } }),
	);
	await end();
	const kept = await receipt();
	expect(kept).toMatchObject({ gate: { verdict: "pending" }, waitingCount: 1 });
	budget("a kept receipt", JSON.stringify(kept).length, 4095, "characters");
	const audit = AuditReply.parse(await h.call("audit", { receipt: kept?.id }));
	expect(audit.ndjson).toContain('"collection\\":\\"waiting');
	expect(verifyAudit(audit.ndjson).records).toBe(kept?.evidenceCount ?? 0);
});

for (const mutation of ["questions", "one result"] as const)
	test(`large failing receipts share pages when changing ${mutation}`, async () => {
		const n = z.coerce
			.number()
			.int()
			.min(3000)
			.max(100000)
			.parse(process.env.MAINWORTHY_RECEIPT_TEST_RESULTS ?? 3000);
		await h.call("report", ciReport({ commit: "receipt726", branch: "feature", pr: 726, n, fail: { 7: "boom" } }));
		await end();
		const before = await receiptBytes();
		const members = async () =>
			z
				.object({ n: z.number() })
				.parse(
					await h.app.database.read(
						async (db) =>
							await db.get(sql<readonly [], { n: number }>("SELECT count(*) AS n FROM merge_receipt_members")),
					),
				).n;
		const initial = await members();
		const mergeMs: number[] = [];
		for (let i = 0; i < 6; i++) {
			await h.call("change", { change: "pr:726", state: "open" });
			if (mutation === "one result")
				await h.call("report", ciReport({ commit: "receipt726", branch: "feature", pr: 726, n: 1, only: [n + i] }));
			const start = performance.now();
			await end();
			mergeMs.push(performance.now() - start);
		}
		if (process.env.MAINWORTHY_RECEIPT_TEST_RESULTS)
			console.log(
				JSON.stringify({
					mutation,
					n,
					mergeMs,
					members: (await members()) - initial,
					growthBytes: (await receiptBytes()) - before,
				}),
			);
		budget(`receipt members added changing ${mutation}`, (await members()) - initial, 1499, "rows");
		budget(`database growth changing ${mutation}`, (await receiptBytes()) - before, 262143, "bytes");
	});

test("a clean result tree performs no result-page reads on reopen and merge", async () => {
	await h.call("report", ciReport({ commit: "receipt726", branch: "feature", pr: 726, n: 3000, fail: { 7: "boom" } }));
	await end();
	await h.call("change", { change: "pr:726", state: "open" });
	const reads = spyOn(await h.app.database.write((db) => Object.getPrototypeOf(db) as WriteDb), "all");
	try {
		await end();
		budget(
			"result-page reads of a clean reopen and merge",
			reads.mock.calls.filter(
				([statement]) => statement.text.includes("FROM run_tests") && statement.text.includes("result/32"),
			).length,
			0,
			"reads",
		);
	} finally {
		reads.mockRestore();
	}
});

test("cached receipt pages refresh cause answers, labels and removed result keys", async () => {
	const sent = await h.call<ReportReceipt>("report", report());
	await end();
	const old = await receipt();
	await h.call("change", { change: "pr:726", state: "open" });
	const question = (await h.call<InboxReply>("inbox", { kind: "failure" })).items[0];
	if (!question || !old) throw new Error("Expected question and receipt");
	await h.call("decide", { q: question.q, onEvidence: question.evidenceHash, answer: { is: "flaky" } });
	await end();
	const excused = await receipt();
	expect(
		(await h.call<{ items: unknown[] }>("find", { in: "receipt-results", receipt: excused?.id })).items,
	).toMatchObject([{ standing: "excused", decisionAnswer: "flaky" }]);
	expect((await h.call<{ items: unknown[] }>("find", { in: "receipt-results", receipt: old.id })).items).toMatchObject([
		{ standing: "unexplained", decision: null },
	]);
	await h.call("change", { change: "pr:726", state: "open" });
	await h.call("decide", { undo: question.q, reason: "Recheck this failure" });
	await end();
	expect(
		(await h.call<{ items: unknown[] }>("find", { in: "receipt-results", receipt: (await receipt())?.id })).items,
	).toMatchObject([{ standing: "unexplained", decision: null }]);
	await h.call("change", { change: "pr:726", state: "open" });
	const corrected = { ...report("receipt726", false), attempt: 2 };
	await h.call("report", {
		...corrected,
		results: corrected.results.map((row) => ({ ...row, corrects: sent.results[0] })),
	});
	await h.app.database.write(
		async (db) => await db.transaction(async () => await db.exec("UPDATE tests SET name='Renamed test' WHERE id=1")),
	);
	await end();
	expect(
		(await h.call<{ items: unknown[] }>("find", { in: "receipt-results", receipt: (await receipt())?.id })).items,
	).toMatchObject([{ name: "Renamed test", standing: "pass", decision: null }]);
	expect(
		(await h.call<{ items: { result: number }[] }>("find", { in: "receipt-results", receipt: (await receipt())?.id }))
			.items[0]?.result,
	).not.toBe(sent.results[0] ?? 0);
});

test("one test in many lanes keeps bounded tree leaves and complete result pages", async () => {
	for (let i = 0; i < 100; i++) await h.call("report", { ...report("receipt726", false), job: `lane-${i}` });
	await end();
	const kept = await receipt();
	if (!kept) throw new Error("Expected receipt");
	let cursor: string | null = null;
	const ids: number[] = [];
	do {
		const page: { items: { result: number }[]; cursor: string | null } = await h.call<{
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

async function receiptBytes(): Promise<number> {
	return await h.app.database.read(async (db) => {
		let bytes = 0;
		for (const table of [
			"merge_receipts",
			"merge_receipt_nodes",
			"merge_receipt_members",
			"merge_receipt_payloads",
			"merge_receipt_snapshots",
		]) {
			const rows = await db.allDynamic<{ bytes: number }>(
				`SELECT coalesce(sum(pg_column_size(t)), 0)::bigint AS bytes FROM ${table} t`,
			);
			bytes += rows[0]?.bytes ?? 0;
		}
		return bytes;
	});
}
