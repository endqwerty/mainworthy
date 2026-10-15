import { expect, test } from "bun:test";
import { type AuditRecord, AuditReply, auditChecksum, verifyAudit } from "../src/core/audit.ts";
import { canonicalJson } from "../src/core/hash.ts";
import type { PolicySettings } from "../src/core/kinds.ts";
import { actorByName } from "../src/server/identity/identity.ts";
import { findProject } from "../src/server/kernel/ctx.ts";
import { OPS } from "../src/server/ops/index.ts";
import { invoke } from "../src/server/ops/registry.ts";
import { ciReport, harness } from "./helpers.ts";

function entries(text: string): AuditRecord[] {
	return text
		.trimEnd()
		.split("\n")
		.slice(1, -1)
		.map((line) => JSON.parse(line));
}
function rehash(text: string, mutate: (lines: Record<string, unknown>[]) => void): string {
	const lines: Record<string, unknown>[] = text
		.trimEnd()
		.split("\n")
		.map((line) => JSON.parse(line));
	lines.pop();
	mutate(lines);
	const body = `${lines.map((line) => canonicalJson(line)).join("\n")}\n`;
	return `${body}${canonicalJson({ end: true, records: lines.length - 1, sha256: auditChecksum(body) })}\n`;
}
function fixture() {
	const h = harness();
	h.call("propose", { edits: [{ op: "create", outline: "A case\n- Do it\n  => It works" }] });
	const first = AuditReply.parse(h.call("audit", {}));
	const cutoff =
		entries(first.ndjson)
			.flatMap((record) => ("at" in record ? [record.at] : []))
			.reduce((a, b) => Math.max(a, b), 0) + 1;
	h.advance(100);
	h.call("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "A changed case" } }] });
	return { h, first, cutoff };
}

test("audit refuses reordered context and event records even after rehashing", () => {
	const { h } = fixture();
	try {
		const file = AuditReply.parse(h.call("audit", {})).ndjson;
		const changes: ((lines: Record<string, unknown>[]) => void)[] = [
			(lines) => {
				const first = lines[1];
				const second = lines[2];
				if (first && second) [lines[1], lines[2]] = [second, first];
			},
			(lines) => {
				const context = lines.splice(1, 1)[0];
				if (context) lines.push(context);
			},
			(lines) => {
				const indices = lines.flatMap((row, index) => (row.type === "decision" ? [index] : []));
				const [a = 0, b = 0] = indices;
				const first = lines[a];
				const second = lines[b];
				if (first && second) [lines[a], lines[b]] = [second, first];
			},
		];
		for (const change of changes)
			expect(() => verifyAudit(rehash(file, change))).toThrow(/line \d+ record \S+: records out of order/);
	} finally {
		h.close();
	}
});

test("audit event order breaks equal-time ties by sequence and then id", () => {
	const { h } = fixture();
	try {
		const file = AuditReply.parse(h.call("audit", {})).ndjson;
		for (const bySequence of [true, false]) {
			const ordered = rehash(file, (lines) => {
				const events = lines.filter((row) => ["decision", "policy", "case-version"].includes(String(row.type)));
				for (const row of events) {
					row.at = 0;
					if (!bySequence) row.seq = 99;
				}
				if (lines[0]) lines[0].seq = 99;
				events.sort((a, b) => Number(a.seq) - Number(b.seq) || String(a.id).localeCompare(String(b.id), "en"));
				lines.splice(lines.length - events.length, events.length, ...events);
			});
			expect(verifyAudit(ordered)).toMatchObject({ project: "scratch", records: 9 });
			const swapped = rehash(ordered, (lines) => {
				const a = lines.at(-2);
				const b = lines.at(-1);
				if (a && b) lines.splice(-2, 2, b, a);
			});
			expect(() => verifyAudit(swapped)).toThrow(/line \d+ record \S+: records out of order/);
		}
	} finally {
		h.close();
	}
});

test("audit errors name the line and record once without raw schema output", () => {
	const { h } = fixture();
	try {
		const file = AuditReply.parse(h.call("audit", {})).ndjson;
		const line = file.split("\n").findIndex((row) => row.includes('"id":"version:1:1"')) + 1;
		const invalidSchema = rehash(file, (lines) => {
			const row = lines.find((item) => item.id === "version:1:1");
			if (row) row.body = {};
		});
		expect(() => verifyAudit(invalidSchema)).toThrow(
			new RegExp(`^invalid audit: line ${line} record version:1:1: body.title: [^\\n]+$`),
		);
		const noncanonical = file.replace('"id":"version:1:1"', '"id": "version:1:1"');
		const lines = noncanonical.trimEnd().split("\n");
		lines.pop();
		const body = `${lines.join("\n")}\n`;
		const rechecked = `${body}${canonicalJson({ end: true, records: lines.length - 1, sha256: auditChecksum(body) })}\n`;
		expect(() => verifyAudit(rechecked)).toThrow(
			new RegExp(`^invalid audit: line ${line} record version:1:1: each line must be canonical JSON$`),
		);
		const wrongHash = rehash(file, (rows) => {
			const row = rows.find((item) => item.id === "version:1:1");
			if (row) row.hash = "000000000000";
		});
		expect(() => verifyAudit(wrongHash)).toThrow(
			new RegExp(`^invalid audit: line ${line} record version:1:1: case body hash mismatch$`),
		);
	} finally {
		h.close();
	}
});

test("audit exports retained change endings in range and only for its project", () => {
	const h = harness();
	try {
		h.call("report", ciReport({ commit: "ended-change", pr: 326, n: 1, fail: { 0: "failure" } }));
		expect(h.call<{ items: unknown[] }>("inbox", { kind: "failure" }).items).toHaveLength(1);
		h.advance(100);
		h.call("change", { change: "pr:326", state: "closed" });
		const from = h.app.now();
		expect(h.call<{ items: unknown[] }>("inbox", { kind: "failure" }).items).toHaveLength(0);
		const file = AuditReply.parse(h.call("audit", {})).ndjson;
		const ending = rowsOfType(file, "change-end");
		expect(ending).toEqual([
			{ type: "change-end", id: "change-end:1", change: 1, key: "pr:326", repo: "acme/web", state: "closed", at: from },
		]);
		expect(rowsOfType(AuditReply.parse(h.call("audit", { from })).ndjson, "change-end")).toEqual(ending);
		expect(rowsOfType(AuditReply.parse(h.call("audit", { to: from })).ndjson, "change-end")).toEqual([]);
		h.call("admin", { do: "project.create", key: "other" });
		const other = invoke(h.app, OPS, { op: "audit", project: "other", input: {}, actor: () => h.owner });
		if (!other.ok) throw new Error(other.error.message);
		expect(rowsOfType(AuditReply.parse(other.result).ndjson, "change-end")).toEqual([]);
		expect(verifyAudit(file)).toMatchObject({ project: "scratch", records: 5 });
		for (const [key, value] of [
			["state", "open"],
			["change", 999],
			["at", from + 999],
		] as const)
			expect(() =>
				verifyAudit(
					rehash(file, (lines) => {
						const row = lines.find((item) => item.type === "change-end");
						if (row) row[key] = value;
					}),
				),
			).toThrow();
		h.call("change", { change: "pr:326", state: "open" });
		expect(rowsOfType(AuditReply.parse(h.call("audit", {})).ndjson, "change-end")).toEqual([]);
		h.advance(100);
		h.call("change", { change: "pr:326", state: "merged" });
		expect(rowsOfType(AuditReply.parse(h.call("audit", {})).ndjson, "change-end")[0]).toMatchObject({
			state: "merged",
		});
	} finally {
		h.close();
	}
});

test("an admin can export a validated project audit without writing a command", () => {
	const h = harness();
	try {
		const before = h.app.db.raw.query("SELECT count(*) AS n FROM commands").get();
		const reply = AuditReply.parse(h.call("audit", {}));
		expect(verifyAudit(reply.ndjson)).toMatchObject({
			format: 1,
			project: "scratch",
			records: 1,
			unavailableDecisionEvidence: 0,
		});
		expect(h.app.db.raw.query("SELECT count(*) AS n FROM commands").get()).toEqual(before);
		const reader = h.actor("reader", "human", ["read"]);
		expect(h.raw("audit", {}, reader)).toMatchObject({ ok: false, error: { code: "forbidden" } });
		expect(h.raw("audit", { from: 10, to: 5 })).toMatchObject({ ok: false, error: { code: "invalid" } });
		expect(h.raw("audit", { to: Number.MAX_SAFE_INTEGER })).toMatchObject({ ok: false, error: { code: "invalid" } });
	} finally {
		h.close();
	}
});

test("audit exports every retained version, decision and policy, with exact evidence and no other project", () => {
	const { h } = fixture();
	try {
		h.call("admin", { do: "project.create", key: "other" });
		const exported = AuditReply.parse(h.call("audit", {}));
		const records = entries(exported.ndjson);
		expect(records.filter((record) => record.type === "case-version").map((record) => record.body.title)).toEqual([
			"A case",
			"A changed case",
		]);
		expect(records.filter((record) => record.type === "policy").map((record) => record.version)).toEqual([1]);
		expect(records.filter((record) => record.type === "decision")).toHaveLength(2);
		for (const record of records)
			if (record.type === "decision") {
				expect(record.signers[0]?.by).toMatchObject({ name: "policy", kind: "rule" });
				expect(record.evidence.state).toBe("recorded");
			}
		expect(verifyAudit(exported.ndjson).unavailableDecisionEvidence).toBe(0);
		expect(exported.ndjson).not.toContain('"other"');
		expect(exported.ndjson).not.toContain('"tokens"');
	} finally {
		h.close();
	}
});

test("range exports mark actual old version predecessors and decisions, and exclude later events", () => {
	const { h, first, cutoff } = fixture();
	try {
		const partial = AuditReply.parse(h.call("audit", { from: cutoff }));
		const version = entries(partial.ndjson).find((record) => record.type === "case-version");
		expect(version).toMatchObject({ version: 2, parent: { scope: "before-range", id: "version:1:1" } });
		expect(verifyAudit(partial.ndjson).beforeRangeReferences).toBe(1);
		const earlier = AuditReply.parse(h.call("audit", { to: cutoff }));
		expect(entries(earlier.ndjson)).toEqual(entries(first.ndjson));
	} finally {
		h.close();
	}
});

test("legacy decision evidence is explicitly unavailable rather than replaced by current question evidence", () => {
	const { h } = fixture();
	try {
		h.app.db.raw.query("UPDATE decisions SET on_evidence = NULL WHERE id = 1").run();
		const file = AuditReply.parse(h.call("audit", {})).ndjson;
		expect(entries(file).find((record) => record.type === "decision")).toMatchObject({
			evidence: { state: "not-recorded" },
		});
		expect(verifyAudit(file).unavailableDecisionEvidence).toBe(1);
	} finally {
		h.close();
	}
});

test("checksum, truncation, trailing data, malformed JSON and unsupported versions are refused", () => {
	const { h, first } = fixture();
	try {
		for (const bad of [
			first.ndjson.replace("A case", "B case"),
			first.ndjson.slice(0, -20),
			`${first.ndjson}{}\n`,
			"null\n{}\n",
			"\n",
			first.ndjson.replace('"format":1', '"format":2'),
		]) {
			expect(() => verifyAudit(bad)).toThrow();
		}
	} finally {
		h.close();
	}
});

test("verification checks references, body hashes, duplicates and ranges even with a recalculated checksum", () => {
	const { h } = fixture();
	try {
		const file = AuditReply.parse(h.call("audit", {})).ndjson;
		const changes: ((lines: Record<string, unknown>[]) => void)[] = [
			(lines) => {
				lines.splice(1, 1);
			},
			(lines) => {
				const row = lines.find((record) => record.type === "case-version");
				if (row) row.decision = { scope: "included", id: "decision:999" };
			},
			(lines) => {
				const row = lines.find((record) => record.type === "case-version");
				if (row) row.hash = "000000000000";
			},
			(lines) => {
				const row = lines.find((record) => record.type === "decision");
				if (row)
					row.evidence = {
						state: "recorded",
						hash: "000000000000",
						ref: { scope: "included", id: "evidence:1:000000000000" },
					};
			},
			(lines) => {
				const row = lines.find((record) => record.type === "decision");
				if (row) row.prior = { scope: "included", id: row.id };
			},
			(lines) => {
				const row = lines.find((record) => record.type === "case-version");
				if (row) row.parent = { scope: "before-range", id: "version:1:1", at: 0 };
			},
			(lines) => {
				const row = lines.find((record) => record.type === "decision");
				if (row) row.at = Number.MAX_SAFE_INTEGER;
			},
			(lines) => {
				const row = lines[1];
				if (row) lines.push(row);
			},
			(lines) => {
				const row = lines[1];
				if (row) row.unrecognized = true;
			},
		];
		for (const change of changes) expect(() => verifyAudit(rehash(file, change))).toThrow();
	} finally {
		h.close();
	}
});

test("answers, advice and withdrawals retain their actors, reasons and exact evidence hashes", () => {
	const h = harness();
	try {
		h.call("report", ciReport({ commit: "audit-answer", n: 1, fail: { 0: "failed for audit" } }));
		const q = h.call<{ items: { q: string; evidenceHash: string }[] }>("inbox", { kind: "failure" }).items[0];
		if (!q) throw new Error("missing failure question");
		const agent = h.actor("helper", "agent", ["read", "produce"]);
		expect(
			h.call("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "flaky" }, reason: "advice" }, agent),
		).toMatchObject([{ status: "advised" }]);
		expect(
			h.call("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "flaky" }, reason: "confirmed" }),
		).toMatchObject([{ status: "decided" }]);
		const beforeUndo = AuditReply.parse(h.call("audit", {}));
		const beforeCutoff =
			entries(beforeUndo.ndjson)
				.flatMap((record) => ("at" in record ? [record.at] : []))
				.reduce((a, b) => Math.max(a, b), 0) + 1;
		h.advance(100);
		expect(h.call("decide", { undo: q.q, reason: "look again" })).toMatchObject([{ status: "reopened" }]);
		const file = AuditReply.parse(h.call("audit", {})).ndjson;
		const answers = entries(file).filter((record) => record.type === "answer");
		expect(
			answers.map((record) => ({
				by: record.by.name,
				reason: record.reason,
				counts: record.counts,
				hash: record.evidence.hash,
			})),
		).toEqual([
			{ by: "helper", reason: "advice", counts: false, hash: q.evidenceHash },
			{ by: "robin", reason: "confirmed", counts: true, hash: q.evidenceHash },
		]);
		const withdrawal = entries(file).find(
			(record) =>
				record.type === "decision" &&
				record.answer !== null &&
				typeof record.answer === "object" &&
				!Array.isArray(record.answer) &&
				record.answer.is === "withdrawn",
		);
		expect(withdrawal).toMatchObject({
			evidence: { state: "recorded", hash: q.evidenceHash },
			signers: [{ by: { name: "robin" }, reason: "look again" }],
			prior: { scope: "included" },
		});
		const partial = AuditReply.parse(h.call("audit", { from: beforeCutoff }));
		expect(entries(partial.ndjson).find((record) => record.type === "decision")).toMatchObject({
			prior: { scope: "before-range" },
		});
		expect(verifyAudit(partial.ndjson).beforeRangeReferences).toBe(1);
	} finally {
		h.close();
	}
});

test("policy changes include their adopting decision and a verifiable previous policy reference", () => {
	const h = harness();
	try {
		const baseline = AuditReply.parse(h.call("audit", {}));
		const created = entries(baseline.ndjson).find((record) => record.type === "policy");
		if (created?.type !== "policy") throw new Error("missing policy");
		h.call("propose", { edits: [{ op: "policy", unlinked: "create" }] });
		const q = h.call<{ items: { q: string; evidenceHash: string }[] }>("inbox", { kind: "adopt" }).items[0];
		if (!q) throw new Error("missing policy question");
		h.call("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "accept" } });
		const partial = AuditReply.parse(h.call("audit", { from: created.at + 1 }));
		expect(entries(partial.ndjson).find((record) => record.type === "policy")).toMatchObject({
			version: 2,
			prior: { scope: "before-range", id: "policy:1" },
			decision: { scope: "included" },
		});
		expect(verifyAudit(partial.ndjson).beforeRangeReferences).toBe(1);
	} finally {
		h.close();
	}
});

test("saved decision evidence survives later question updates", () => {
	const { h } = fixture();
	try {
		const before = entries(AuditReply.parse(h.call("audit", {})).ndjson).find((record) => record.type === "decision");
		if (before?.type !== "decision") throw new Error("missing decision");
		h.app.db.raw.query("UPDATE questions SET evidence_hash = '000000000000'").run();
		const after = entries(AuditReply.parse(h.call("audit", {})).ndjson).find((record) => record.type === "decision");
		expect(after).toMatchObject({ evidence: before.evidence });
	} finally {
		h.close();
	}
});

test("caller-dated demo versions can be audited when their timestamps run backward", () => {
	const h = harness();
	try {
		h.call("admin", { do: "project.demo", key: "scratch" });
		for (const [index, at] of [1_790_000_000_000, 1_780_000_000_000].entries()) {
			const input =
				index === 0
					? { edits: [{ op: "create", outline: "Demo first" }] }
					: { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Demo second" } }] };
			expect(invoke(h.app, OPS, { op: "propose", project: "scratch", input, actor: () => h.owner, at })).toMatchObject({
				ok: true,
			});
		}
		const file = AuditReply.parse(h.call("audit", {})).ndjson;
		expect(verifyAudit(file).unavailableDecisionEvidence).toBe(0);
		expect(
			entries(file)
				.filter((record) => record.type === "case-version")
				.map((record) => record.version),
		).toEqual([2, 1]);
	} finally {
		h.close();
	}
});

test("verification rejects missing middle case and policy versions even after rehashing", () => {
	const { h } = fixture();
	try {
		h.call("propose", { edits: [{ op: "edit", case: "C-1", base: 2, body: { title: "Third case version" } }] });
		for (const unlinked of ["ask", "create"]) {
			h.call("propose", { edits: [{ op: "policy", unlinked }] });
			const q = h.call<{ items: { q: string; evidenceHash: string }[] }>("inbox", { kind: "adopt" }).items[0];
			if (!q) throw new Error("missing policy question");
			h.call("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "accept" } });
		}
		const file = AuditReply.parse(h.call("audit", {})).ndjson;
		const changes: ((lines: Record<string, unknown>[]) => void)[] = [
			(lines) => {
				const middle = lines.findIndex((record) => record.id === "version:1:2");
				lines.splice(middle, 1);
				const third = lines.find((record) => record.id === "version:1:3");
				if (third) third.parent = { scope: "included", id: "version:1:1" };
			},
			(lines) => {
				const middle = lines.findIndex((record) => record.id === "policy:2");
				lines.splice(middle, 1);
				const third = lines.find((record) => record.id === "policy:3");
				if (third) third.prior = { scope: "included", id: "policy:1" };
			},
			(lines) => {
				const row = lines.find((record) => record.id === "version:1:2");
				if (row) row.parent = null;
			},
			(lines) => {
				const row = lines.find((record) => record.id === "policy:2");
				if (row) row.prior = null;
			},
		];
		for (const change of changes) expect(() => verifyAudit(rehash(file, change))).toThrow(/parent|prior/);
	} finally {
		h.close();
	}
});

test("a demo answer can precede its question's recorded date, but never its opening sequence", () => {
	const h = harness();
	try {
		h.call("admin", { do: "project.demo", key: "scratch" });
		const reported = invoke(h.app, OPS, {
			op: "report",
			project: "scratch",
			input: ciReport({ commit: "audit-dated-answer", n: 1, fail: { 0: "demo failure" } }),
			actor: () => h.owner,
			at: 1_790_000_000_000,
		});
		expect(reported).toMatchObject({ ok: true });
		const q = h.call<{ items: { q: string; evidenceHash: string }[] }>("inbox", { kind: "failure" }).items[0];
		if (!q) throw new Error("missing question");
		expect(
			invoke(h.app, OPS, {
				op: "decide",
				project: "scratch",
				input: { q: q.q, onEvidence: q.evidenceHash, answer: { is: "flaky" } },
				actor: () => h.owner,
				at: 1_780_000_000_000,
			}),
		).toMatchObject({ ok: true, result: [{ status: "decided" }] });
		h.call("propose", { edits: [{ op: "create", outline: "Advance project sequence" }] });
		const file = AuditReply.parse(h.call("audit", {})).ndjson;
		expect(verifyAudit(file).unavailableDecisionEvidence).toBe(0);
		const decided = entries(file).find((record) => record.type === "decision" && record.kind === "failure");
		if (decided?.type !== "decision") throw new Error("missing failure decision");
		expect(() =>
			verifyAudit(
				rehash(file, (lines) => {
					const question = lines.find((record) => record.id === decided.question.id);
					if (question) question.openedSeq = decided.seq + 1;
				}),
			),
		).toThrow(/opening sequence/);
		expect(() =>
			verifyAudit(
				rehash(file, (lines) => {
					const question = lines.find((record) => record.type === "question");
					if (question) question.openedSeq = Number(lines[0]?.seq) + 1;
				}),
			),
		).toThrow(/sequence/);
	} finally {
		h.close();
	}
});

test("a range cutting a backward-dated demo chain asks for a wider range", () => {
	const h = harness();
	try {
		h.call("admin", { do: "project.demo", key: "scratch" });
		for (const [index, at] of [1_790_000_000_000, 1_780_000_000_000].entries()) {
			const input =
				index === 0
					? { edits: [{ op: "create", outline: "Demo first" }] }
					: { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Demo second" } }] };
			expect(invoke(h.app, OPS, { op: "propose", project: "scratch", input, actor: () => h.owner, at })).toMatchObject({
				ok: true,
			});
		}
		expect(h.raw("audit", { to: 1_785_000_000_000 })).toMatchObject({
			ok: false,
			error: { code: "invalid", message: expect.stringContaining("widen") },
		});
	} finally {
		h.close();
	}
});

test("a reopened question cannot precede the opening sequence of its prior question", () => {
	const h = harness();
	try {
		h.call("report", ciReport({ commit: "audit-prior-first", n: 1, fail: { 0: "same failure" } }));
		const first = h.call<{ items: { q: string; evidenceHash: string }[] }>("inbox", { kind: "failure" }).items[0];
		if (!first) throw new Error("missing first question");
		h.call("decide", { q: first.q, onEvidence: first.evidenceHash, answer: { is: "flaky" } });
		h.advance(15 * 24 * 60 * 60 * 1000);
		h.call("report", ciReport({ commit: "audit-prior-second", n: 1, fail: { 0: "same failure" } }));
		const next = h.call<{ items: { q: string; evidenceHash: string }[] }>("inbox", { kind: "failure" }).items[0];
		if (!next || next.q === first.q) throw new Error("missing reopened question");
		h.call("decide", { q: next.q, onEvidence: next.evidenceHash, answer: { is: "flaky" } });
		const file = AuditReply.parse(h.call("audit", {})).ndjson;
		const questions = entries(file).filter((record) => record.type === "question");
		const current = questions.find((record) => record.prior !== null);
		const prior = questions.find((record) => record.id === current?.prior?.id);
		if (!current || !prior) throw new Error("missing question chain");
		expect(() =>
			verifyAudit(
				rehash(file, (lines) => {
					const row = lines.find((record) => record.id === current.id);
					if (row) row.openedSeq = prior.openedSeq - 1;
				}),
			),
		).toThrow(/question prior mismatch/);
	} finally {
		h.close();
	}
});

test("inherited audit decisions resolve exact head and base results after their standing ends", () => {
	const h = harness();
	try {
		h.call("report", ciReport({ commit: "audit-base", n: 2, fail: { 0: "same cause" } }));
		const before = entries(AuditReply.parse(h.call("audit", {})).ndjson);
		const from = Math.max(...before.flatMap((row) => ("at" in row ? [row.at] : []))) + 1;
		h.call("report", ciReport({ commit: "audit-head", pr: 40, base: "audit-base", n: 2, fail: { 0: "same cause" } }));
		const partial = AuditReply.parse(h.call("audit", { from })).ndjson;
		expect(entries(partial).some((row) => row.type === "result" && row.at < from)).toBe(true);
		expect(verifyAudit(partial).project).toBe("scratch");
		h.call("report", ciReport({ commit: "audit-base", n: 2, attempt: 2 }));
		const file = AuditReply.parse(h.call("audit", {})).ndjson;
		const rows = entries(file);
		const decision = rows.find((row) => row.type === "decision" && canonicalJson(row.answer) === '{"is":"inherited"}');
		expect(decision).toMatchObject({ inherited: [{ result: { scope: "included" }, base: [{ scope: "included" }] }] });
		expect(rows.filter((row) => row.type === "result")).toHaveLength(2);
		expect(rows.some((row) => row.type === "decision" && canonicalJson(row.answer) === '{"is":"outdated"}')).toBe(true);
		for (const change of [
			(lines: Record<string, unknown>[]) => {
				const row = lines.find((r) => r.id === decision?.id);
				if (row) row.inherited = [];
			},
			(lines: Record<string, unknown>[]) => {
				const at = lines.findIndex((r) => r.type === "result");
				lines.splice(at, 1);
			},
			(lines: Record<string, unknown>[]) => {
				const row = lines.find((r) => r.type === "result");
				if (row) row.test = 999;
			},
		])
			expect(() => verifyAudit(rehash(file, change))).toThrow(/inherited|reference/);
		expect(verifyAudit(file).unavailableDecisionEvidence).toBe(0);
	} finally {
		h.close();
	}
});

test("audit includes project and global team grant history, removed memberships and current scoped state", () => {
	const h = harness();
	try {
		h.actor("reviewer", "human", ["read", "produce"]);
		h.call("admin", { do: "project.create", key: "other" });
		for (const [name, project] of [
			["Quality", "scratch"],
			["Other", "other"],
			["Global", undefined],
		]) {
			h.call("admin", { do: "team.create", name });
			h.call("admin", { do: "team.grant.set", team: name, project, can: ["answer"] });
			h.call("admin", { do: "team.member.add", team: name, person: "reviewer" });
		}
		h.call("report", ciReport({ commit: "team-signed", n: 1, fail: { 0: "needs a person" } }));
		const q = h.call<{ items: { q: string; evidenceHash: string }[] }>("inbox", { kind: "failure" }).items[0];
		const project = findProject(h.app.db, "scratch");
		const signer = actorByName(h.app.db, "reviewer", project?.id ?? -1);
		if (!q || !signer) throw new Error("missing team signer or question");
		expect(h.call("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "flaky" } }, signer)).toMatchObject([
			{ status: "decided" },
		]);
		h.call("admin", { do: "team.member.remove", team: "Quality", person: "reviewer" });
		h.call("admin", { do: "team.grant.remove", team: "Quality", project: "scratch" });
		h.call("admin", { do: "team.grant.set", team: "Quality", project: "other", can: ["admin"] });
		const file = AuditReply.parse(h.call("audit", {})).ndjson;
		expect(rowsOfType(file, "decision")).toContainEqual(
			expect.objectContaining({
				signers: [expect.objectContaining({ by: expect.objectContaining({ name: "reviewer" }) })],
			}),
		);
		expect(rowsOfType(file, "team")).toEqual([
			expect.objectContaining({ name: "Quality", members: [], grants: [] }),
			expect.objectContaining({
				name: "Global",
				members: [expect.objectContaining({ name: "reviewer" })],
				grants: [{ project: "*", can: ["answer"] }],
			}),
		]);
		expect(rowsOfType(file, "team-event").map((row) => row.action)).toEqual([
			"created",
			"grant.set",
			"member.add",
			"created",
			"grant.set",
			"member.add",
			"member.remove",
			"grant.remove",
		]);
		expect(file).not.toContain('"other"');
		expect(file).not.toContain('"Other"');
		const mutations: [string, unknown][] = [
			["team", { scope: "included", id: "team:999" }],
			["project", "other"],
			["person", null],
		];
		for (const [key, value] of mutations) {
			expect(() =>
				verifyAudit(
					rehash(file, (lines) => {
						const row = lines.find((r) => r.type === "team-event" && r.action === "member.add");
						if (row) row[key] = value;
					}),
				),
			).toThrow();
		}
		expect(verifyAudit(file).project).toBe("scratch");
	} finally {
		h.close();
	}
});

function rowsOfType(text: string, type: string): Record<string, unknown>[] {
	return text
		.trimEnd()
		.split("\n")
		.slice(1, -1)
		.map((line) => JSON.parse(line))
		.filter((row) => row.type === type);
}

test("audit retains and validates each policy's custom field definitions", () => {
	const h = harness();
	try {
		const fields = { priority: { kind: "choice", label: "Priority", choices: ["high", "low"], required: true } };
		const { settings } = h.call<{ settings: PolicySettings }>("admin", { do: "policy.show", project: "scratch" });
		h.call("propose", { edits: [{ op: "policy", base: 1, settings: { ...settings, fields } }] });
		const q = h.call<{ items: { q: string; evidenceHash: string }[] }>("inbox", { kind: "adopt" }).items[0];
		if (!q) throw new Error("missing policy question");
		h.call("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "accept" } });
		const file = AuditReply.parse(h.call("audit", {})).ndjson;
		expect(rowsOfType(file, "policy").at(-1)).toMatchObject({ version: 2, settings: { fields } });
		expect(() =>
			verifyAudit(
				rehash(file, (lines) => {
					const row = lines.find((r) => r.type === "policy" && r.version === 2);
					if (row) row.settings = { ...settings, fields: { priority: { kind: "unrecognised" } } };
				}),
			),
		).toThrow(/policy/);
	} finally {
		h.close();
	}
});

test("an audit export of a case that pins a fragment carries the pin and verifies", () => {
	const h = harness();
	try {
		h.call("propose", {
			edits: [
				{
					op: "create",
					kind: "fragment",
					body: { title: "Sign in", steps: [{ id: "ab", action: "Enter a password", expected: "Signed in" }] },
				},
			],
		});
		h.call("propose", {
			edits: [
				{ op: "create", body: { title: "Checkout", steps: [{ id: "cd", use: { fragment: "C-1", version: 1 } }] } },
			],
		});
		const reply = AuditReply.parse(h.call("audit", {}));
		expect(verifyAudit(reply.ndjson)).toMatchObject({ records: expect.any(Number) });
		const pinned = entries(reply.ndjson).find((record) => record.type === "case-version" && record.case === "C-2");
		expect(pinned).toMatchObject({ body: { steps: [{ id: "cd", use: { fragment: "C-1", version: 1 } }] } });
		const unknown = rehash(reply.ndjson, (lines) => {
			for (const line of lines)
				if (line.type === "case-version" && line.case === "C-2")
					for (const step of (line.body as { steps: Record<string, unknown>[] }).steps) step.extra = true;
		});
		expect(() => verifyAudit(unknown)).toThrow();
		const unknownInPin = rehash(reply.ndjson, (lines) => {
			for (const line of lines)
				if (line.type === "case-version" && line.case === "C-2")
					for (const step of (line.body as { steps: { use: Record<string, unknown> }[] }).steps) step.use.extra = true;
		});
		expect(() => verifyAudit(unknownInPin)).toThrow();
	} finally {
		h.close();
	}
});
