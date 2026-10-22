import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { AuditReply, verifyAudit } from "../src/core/audit.ts";
import { MergeReceipt } from "../src/core/changes.ts";
import type { GateStatus, InboxReply, ReportReceipt } from "../src/core/ops.ts";
import { mergeReceiptById } from "../src/server/decisions/questions.ts";
import { changeByKey, setMergeReceipt } from "../src/server/evidence/evidence.ts";
import { findProject, makeCtx } from "../src/server/kernel/ctx.ts";
import { Db } from "../src/server/kernel/db.ts";
import { migrate } from "../src/server/kernel/migrate.ts";
import { exportArchive } from "../src/server/transfer/transfer.ts";
import { ciReport, type Harness, harness } from "./helpers.ts";

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
			results: [{ result: sent.results[0], standing: "excused", decision }],
		});
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
		expect(receipt()).toMatchObject({ head: "unseen726", gate: { verdict: "pending" }, results: [] });
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
	h.app.db.exec(
		"ALTER TABLE change_ends DROP COLUMN receipt; DROP TABLE merge_receipts; INSERT INTO change_ends (change, ended, at) VALUES (1, 'merged', 1); UPDATE meta SET value = '39' WHERE key = 'schema_version'",
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
