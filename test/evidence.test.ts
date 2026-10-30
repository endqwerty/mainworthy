// One red build: reports, causes, decisions and the gate. The fixtures named D1, D3, C3, C5, E3 and E8 are the
// commitments in docs/product-design.md sections 4.2 and 9.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ciPolicy } from "../scripts/work/ci.ts";
import { type Instance, start } from "../src/app/start.ts";
import { Client } from "../src/cli/client.ts";
import { SameCodeEvidence } from "../src/core/flaky.ts";
import { contentHash } from "../src/core/hash.ts";
import { Policy } from "../src/core/kinds.ts";
import type { ClaimReply, CommandFate, DecideReply, GateStatus, InboxReply, ReportReceipt } from "../src/core/ops.ts";
import { PRESETS } from "../src/core/presets.ts";
import { stakes } from "../src/core/stakes.ts";
import { toItem } from "../src/server/decisions/decisions.ts";
import {
	alsoAbout,
	attachEvidence,
	insertQuestion,
	mustQuestion,
	noteCarried,
	refsOf,
} from "../src/server/decisions/questions.ts";
import { isWithdrawn, resultsByIds } from "../src/server/evidence/evidence.ts";
import { sameCodeEvidence } from "../src/server/evidence/flaky.ts";
import { ruleActor } from "../src/server/identity/identity.ts";
import { type Config, defaultConfig, openApp } from "../src/server/kernel/app.ts";
import { findProject, makeCtx, stampSeq } from "../src/server/kernel/ctx.ts";
import type { WriteDb } from "../src/server/kernel/db.ts";
import { Database, type SqlValue, sql } from "../src/server/kernel/db.ts";
import { recoverAccepted, sweep } from "../src/server/ops/jobs.ts";
import { acceptReport, processBatch } from "../src/server/ops/writes.ts";
import { exportArchive, importArchive, linesOf } from "../src/server/transfer/transfer.ts";
import { archiveRoutes } from "../src/surfaces/archive.ts";
import { type TestDatabase, testDatabase } from "./db.ts";
import { ciReport, type Harness, harness } from "./helpers.ts";

let h: Harness;
beforeEach(async () => {
	h = await harness();
});
afterEach(async () => await h?.close());

const gate = async (commit: string) => await h.call<GateStatus>("gate", { commit });
const queue = async () => await h.call<InboxReply>("inbox");
const decide = async (q: { q: string; evidenceHash: string }, answer: Record<string, unknown>, as = h.owner) =>
	(
		await h.call<{ status: string; needs: string | null }[]>(
			"decide",
			{ q: q.q, onEvidence: q.evidenceHash, answer },
			as,
		)
	)[0];
const count = async (table: string) =>
	(await h.app.database.read(async (db) => await db.allDynamic<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)))[0]
		?.n ?? 0;
const first = <T>(items: T[]): T => {
	const item = items[0];
	if (item === undefined) throw new Error("expected at least one item");
	return item;
};

test("question reference writers batch refs and preserve deduplication, carry and touch semantics", async () => {
	await h.app.database.write((db) =>
		db.transaction(async () => {
			const project = await findProject(db, "scratch");
			if (!project) throw new Error("missing project");
			const ctx = makeCtx(h.app, db, project, h.owner, true);
			const refs = Array.from({ length: 64 }, (_, i) => `C-${i + 1}`);
			let before = h.app.database.statementCount;
			let question = await insertQuestion(ctx, {
				kind: "finding",
				subject: { finding: 1 },
				fingerprint: "ref-fixture",
				epoch: 0,
				prior: null,
				title: "Reference fixture",
				producer: "human",
				evidence: {},
				hash: "hash",
				basis: "basis",
				ask: { who: "member", agents: "none", notProducer: false, reason: "optional" },
				blocks: [],
				rank: 0,
				refs,
			});
			expect(h.app.database.statementCount - before).toBeLessThanOrEqual(4);
			expect(await refsOf(db, question.id)).toEqual(refs.toSorted());
			ctx.touched.clear();
			const more = Array.from({ length: 205 }, (_, i) => `T-${i + 1}`);
			before = h.app.database.statementCount;
			expect(await alsoAbout(ctx, question, [...refs, ...more, ...more])).toBe(205);
			expect(h.app.database.statementCount - before).toBeLessThanOrEqual(3);
			expect([...ctx.touched]).toEqual([`Q-${question.no}`]);
			ctx.touched.clear();
			expect(await alsoAbout(ctx, question, [...more, ...refs])).toBe(0);
			expect(ctx.touched.size).toBe(0);
			const unique = Array.from({ length: 401 }, (_, i) => `U-${i + 1}`);
			before = h.app.database.statementCount;
			expect(await alsoAbout(ctx, question, unique)).toBe(401);
			expect(h.app.database.statementCount - before).toBeLessThanOrEqual(3);
			expect(await refsOf(db, question.id)).toEqual([...refs, ...more, ...unique].toSorted());
			before = h.app.database.statementCount;
			question = await attachEvidence(ctx, question, {
				title: "Attached",
				evidence: { updated: true },
				hash: "next",
				basis: "basis",
				blocks: [],
				refs: [...refs, "R-1", "R-1"],
			});
			expect(h.app.database.statementCount - before).toBeLessThanOrEqual(3);
			expect(question.title).toBe("Attached");
			expect(JSON.parse(question.evidence)).toEqual({ updated: true });
			before = h.app.database.statementCount;
			await noteCarried(ctx, question, [...refs, "R-2", "R-2"]);
			expect(h.app.database.statementCount - before).toBeLessThanOrEqual(2);
			expect((await mustQuestion(db, project.id, `Q-${question.no}`)).carried).toBe(1);
			expect(await refsOf(db, question.id)).toEqual([...refs, ...more, ...unique, "R-1", "R-2"].toSorted());
			before = h.app.database.statementCount;
			expect(await alsoAbout(ctx, question, [])).toBe(0);
			expect(h.app.database.statementCount - before).toBe(0);
			await stampSeq(ctx);
		}),
	);
});

test("same-code sample locations use one batch without changing commit order", async () => {
	for (let i = 1; i <= 4; i++) {
		await h.call("report", ciReport({ commit: `samples-${i}`, n: 1, attempt: 1 }));
		await h.call("report", ciReport({ commit: `samples-${i}`, n: 1, attempt: 2, fail: { 0: "expected stable" } }));
	}
	const evidence = await h.app.database.read(async (db) => {
		const before = h.app.database.statementCount;
		const result = await sameCodeEvidence(db, {
			project: 1,
			test: 1,
			now: h.app.now(),
			settings: { enabled: true, windowDays: 14, minFlips: 2 },
		});
		expect(h.app.database.statementCount - before).toBeLessThanOrEqual(3);
		return result;
	});
	expect(evidence.signals).toHaveLength(1);
	expect(evidence.signals[0]).toMatchObject({ flips: 4, suggested: true, signature: { text: "expected stable" } });
	expect(evidence.signals[0]?.samples.map(({ commit, location }) => ({ commit, location }))).toEqual(
		[4, 3, 2].map((i) => ({
			commit: `samples-${i}`,
			location: { label: "main", commit: `samples-${i}`, change: null },
		})),
	);
});

test("a first report reuses a test repeated after an application pause", async () => {
	const input = ciReport({ commit: "repeated-across-slices", n: 201 });
	const repeated = input.results[0];
	if (!repeated) throw new Error("missing first result");
	input.results[200] = { ...repeated, outcome: "fail", failure: { message: "the later observation failed" } };
	const receipt = await h.call<ReportReceipt>("report", input);
	expect(receipt.counts.total).toBe(201);
	expect(await count("tests")).toBe(200);
	expect(await count("results")).toBe(201);
	expect(
		await h.app.database.read((db) =>
			db.allDynamic("SELECT count(*) AS n FROM results WHERE test = (SELECT id FROM tests WHERE no = 1)"),
		),
	).toEqual([{ n: 2 }]);
});

describe("standing excuse precedence", () => {
	test("an exact target wins, another target falls back to the cause, and an unanswered cause stays unexplained", async () => {
		const report = async (commit: string, attempt = 1, message = "shared cause") =>
			await h.call<ReportReceipt>("report", ciReport({ commit, attempt, n: 1, fail: { 0: message } }));
		const failure = async () => first((await queue()).items.filter((item) => item.kind === "failure"));
		expect((await report("lookup01")).gate).toMatchObject({ verdict: "blocked", tally: { unexplained: 1 } });
		const broad = await failure();
		expect((await decide(broad, { is: "infra" }))?.status).toBe("decided");
		await report("lookup02");
		const exact = await failure();
		expect((await decide(exact, { is: "infra" }))?.status).toBe("decided");
		expect((await decide(broad, { is: "defect" }))?.status).toBe("decided");
		expect((await decide(exact, { is: "infra" }))?.status).toBe("decided");
		expect(
			await h.app.database.read(
				async (db) =>
					await db.all(sql<[], Record<string, unknown>>("SELECT target, class FROM excuses ORDER BY target")),
			),
		).toEqual([
			{ target: 0, class: "attributed" },
			{ target: 2, class: "excused" },
		]);
		expect((await report("lookup02", 2)).gate).toMatchObject({
			verdict: "passed",
			tally: { excused: 1, attributed: 0, unexplained: 0 },
		});
		expect((await report("lookup03")).gate).toMatchObject({
			verdict: "failed",
			tally: { excused: 0, attributed: 1, unexplained: 0 },
		});
		expect((await report("lookup04", 1, "another cause")).gate).toMatchObject({
			verdict: "blocked",
			tally: { excused: 0, attributed: 0, unexplained: 1 },
		});
	});

	test("a newer exact-result decision wins over both target and scope standing in counted results", async () => {
		const failed = { test: { key: "one" }, outcome: "fail", failure: { message: "shared cause" } };
		await h.call("report", { target: { repo: "app", commit: "lookupbase", branch: "main" }, results: [failed] });
		expect((await decide(first((await queue()).items), { is: "defect" }))?.status).toBe("decided");
		const receipt = await h.call<ReportReceipt>("report", {
			target: { repo: "app", commit: "lookuphead", branch: "feature", pr: 91, base: "lookupbase" },
			results: [failed],
		});
		expect(receipt.questions).toMatchObject([{ how: "decided by rule", answer: "inherited" }]);
		const exact = first(receipt.questions);
		// Seed overlapping older standing without refolding: refreshing inherited questions removes this overlap.
		await h.app.database.write(
			async (db) =>
				await db.transaction(
					async () =>
						await db.run(
							sql<
								readonly SqlValue[],
								Record<string, unknown>
							>(`INSERT INTO excuses (project, signature, scope, target, decision, class, expires_at)
			 SELECT r.project, r.signature, 'change:' || t.change, wanted.target, e.decision, e.class, e.expires_at
			 FROM results r JOIN targets t ON t.id = r.target
			 JOIN excuses e ON e.project = r.project AND e.signature = r.signature AND e.target = 0
			 CROSS JOIN (SELECT 0 AS target UNION ALL SELECT target FROM results WHERE id = $1) wanted
			 WHERE r.id = $2`),
							[first(receipt.results), first(receipt.results)],
						),
				),
		);
		const found = await h.call<{ items: { standing: string; question: string }[] }>("find", {
			in: "results",
			commit: "lookuphead",
			repo: "app",
		});
		expect(found.items).toMatchObject([{ standing: "excused", question: exact.q }]);
		expect(
			await h.app.database.read(
				async (db) =>
					await db.all(sql<[], Record<string, unknown>>("SELECT class FROM excuses WHERE scope LIKE 'change:%'")),
			),
		).toEqual([{ class: "attributed" }, { class: "attributed" }]);
	});
});

describe("a green report", () => {
	test("is recorded with an explicit basis and the gate passes", async () => {
		const receipt = await h.call<ReportReceipt>("report", ciReport({ commit: "aaaaaaa1", n: 20 }));
		expect(receipt.counts).toMatchObject({ total: 20, pass: 20, fail: 0 });
		expect(receipt.basis).toEqual({ exact: 0, assumed: 0, unresolved: 20 }); // no test is linked to a case yet
		expect(receipt.gate?.verdict).toBe("passed");
		expect(await gate("aaaaaaa1")).toMatchObject({ verdict: "passed", stale: false });
	});

	test("sent twice writes once and returns the same receipt", async () => {
		const report = ciReport({ commit: "aaaaaaa1", n: 20 });
		const one = await h.call<ReportReceipt>("report", report);
		const rows = await count("results");
		const two = await h.call<ReportReceipt>("report", report);
		expect(two).toEqual({ ...one, fresh: false });
		expect(await count("results")).toBe(rows);
		expect(await count("batches")).toBe(1);
	});

	test("a commit nobody reported on is pending, never green", async () => {
		expect(await gate("deadbeef")).toMatchObject({ verdict: "pending", run: null });
	});
});

describe("a red report", () => {
	test("forgetting rewrites report attribution in command replay and receipts while preserving decisions", async () => {
		const person = await h.actor("erasure-person", "human", ["read", "produce", "answer"]);
		const report = ciReport({ commit: "ddddddd1", n: 1, fail: { 0: "expected total" } });
		await h.call("report", report);
		expect((await decide(first((await queue()).items), { is: "defect" }, person))?.status).toBe("decided");
		const input = { ...report, attempt: 2, cmd: "receipt-command-01" };
		const receipt = await h.call<ReportReceipt>("report", input);
		expect(receipt.questions[0]).toMatchObject({ by: person.name, answer: "defect" });
		const fate = await h.call<CommandFate>("command", { cmd: input.cmd });
		if (fate.state !== "done") throw new Error("the report command did not finish");
		const decisions = await h.app.database.read(
			async (db) => await db.all(sql<[], Record<string, unknown>>("SELECT * FROM decisions ORDER BY id")),
		);
		const commands = await h.app.database.read(
			async (db) =>
				await db.all(sql<[], Record<string, unknown>>("SELECT id, request, seq, touched FROM commands ORDER BY id")),
		);
		const results = await count("results");
		await h.call("admin", { do: "actor.forget", name: person.name });
		const expected = {
			...receipt,
			questions: receipt.questions.map((question) => ({ ...question, by: `forgotten-${person.id}` })),
		};
		expect(await h.call<CommandFate>("command", { cmd: input.cmd })).toEqual({ ...fate, reply: expected });
		expect(await h.call<ReportReceipt>("report", input)).toEqual(expected);
		expect(await h.call<ReportReceipt>("report", { ...input, cmd: undefined })).toEqual({ ...expected, fresh: false });
		expect(
			(
				await h.app.database.read(
					async (db) =>
						await db.all(sql<[], Record<string, unknown>>("SELECT receipt FROM batches WHERE receipt IS NOT NULL")),
				)
			)
				.map((row) => JSON.stringify(row))
				.join(""),
		).not.toContain(person.name);
		expect(
			await h.app.database.read(
				async (db) => await db.all(sql<[], Record<string, unknown>>("SELECT * FROM decisions ORDER BY id")),
			),
		).toEqual(decisions);
		expect(
			await h.app.database.read(
				async (db) =>
					await db.all(sql<[], Record<string, unknown>>("SELECT id, request, seq, touched FROM commands ORDER BY id")),
			),
		).toEqual(commands);
		expect(await count("results")).toBe(results);
		expect((await h.call<InboxReply>("inbox", { state: "decided", kind: "failure" })).items[0]?.decision?.by).toEqual([
			`forgotten-${person.id}`,
		]);
		expect(await h.raw("report", { ...input, attempt: 3 })).toMatchObject({ ok: false, error: { code: "conflict" } });
	});

	test("forgetting rewrites known claim attribution but leaves arbitrary content and other replies alone", async () => {
		const person = await h.actor("erasure-person", "human", ["read", "produce", "answer"]);
		await h.call("propose", { edits: [{ op: "create", outline: person.name }] });
		const claim = { lens: "review", findings: [{ on: "C-1", category: "ambiguous", note: person.name }] };
		await h.call("claim", claim);
		expect((await decide(first((await queue()).items), { is: "reject" }, person))?.status).toBe("decided");
		const input = { ...claim, cmd: "known-claim-01" };
		const reply = await h.call<ClaimReply>("claim", input);
		expect(reply.known[0]).toMatchObject({ by: person.name, answer: "reject" });
		const project = { do: "project.create", key: "another", name: person.name, cmd: "project-create-01" };
		const projectReply = await h.call("admin", project);
		const before = await h.call("get", { refs: ["C-1"] });
		await h.call("admin", { do: "actor.forget", name: person.name });
		const expected = { ...reply, known: reply.known.map((known) => ({ ...known, by: `forgotten-${person.id}` })) };
		expect(await h.call<ClaimReply>("claim", input)).toEqual(expected);
		expect(await h.call<CommandFate>("command", { cmd: input.cmd })).toMatchObject({ state: "done", reply: expected });
		expect(await h.call<unknown>("get", { refs: ["C-1"] })).toEqual(before);
		expect(await h.call<unknown>("admin", project)).toEqual(projectReply);
		expect((await h.call<InboxReply>("inbox", { state: "decided", kind: "finding" })).items[0]?.evidence.note).toBe(
			person.name,
		);
	});

	test("D1: 500 failures with one cause open one question", async () => {
		const fail = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [i, "expected 90.00, got 100.00"]));
		const receipt = await h.call<ReportReceipt>("report", ciReport({ commit: "bbbbbbb1", n: 600, fail }));
		expect(receipt.counts.fail).toBe(500);
		expect(receipt.questions).toHaveLength(1);
		expect(receipt.questions[0]).toMatchObject({ how: "new", tests: 500, state: "open" });
		expect((await queue()).counts.failure).toBe(1);
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
		async ({ order }) => {
			const applied = [];
			for (const shard of order) {
				const report = assertionShard(shard);
				applied.push({ report, receipt: await h.call<ReportReceipt>("report", report) });
			}
			expect(first(applied).receipt.questions).toHaveLength(1);
			for (const { receipt } of applied.slice(1)) {
				expect(receipt.questions).toHaveLength(6);
				expect(receipt.questions.every((q) => q.title.startsWith("Split by file (shard-"))).toBe(true);
			}
			expect((await queue()).counts.failure).toBe(31);
			expect((await gate("broad001")).tally).toMatchObject({ unexplained: 240, excused: 0 });
			const file = first((await queue()).items.filter((q) => q.title.includes("/file-0.test.ts): assertion failed")));
			expect((await decide(file, { is: "flaky" }))?.status).toBe("decided");
			expect((await gate("broad001")).tally).toMatchObject({ unexplained: 233, excused: 7 });
			for (const { report, receipt } of applied) {
				expect(await h.call<ReportReceipt>("report", report)).toEqual({ ...receipt, fresh: false });
			}
			expect(await count("results")).toBe(240);
			expect(await count("batches")).toBe(6);
		},
	);

	test("a split across shards preserves the earlier generic answer and its results", async () => {
		const receipt = await h.call<ReportReceipt>("report", assertionShard(0));
		const question = first((await queue()).items);
		expect((await decide(question, { is: "flaky", reason: "the first shard's evidence" }))?.status).toBe("decided");
		const earlier = await h.app.database.read(
			async (db) => await db.all(sql<[], Record<string, unknown>>("SELECT * FROM results ORDER BY id")),
		);
		const decisions = await h.app.database.read(
			async (db) =>
				await db.all(sql<[], Record<string, unknown>>("SELECT * FROM decisions WHERE kind = 'failure' ORDER BY id")),
		);
		const excuses = await h.app.database.read(
			async (db) => await db.all(sql<[], Record<string, unknown>>("SELECT * FROM excuses ORDER BY decision")),
		);
		const next = await h.call<ReportReceipt>("report", assertionShard(1));
		expect(next.questions).toHaveLength(6);
		expect(next.questions.every((q) => q.state === "open")).toBe(true);
		expect((await gate("broad001")).tally).toMatchObject({ unexplained: 40, excused: 40 });
		expect(
			await h.app.database.read(
				async (db) => await db.all(sql<[], Record<string, unknown>>("SELECT * FROM results ORDER BY id LIMIT 40")),
			),
		).toEqual(earlier);
		expect(
			await h.app.database.read(
				async (db) =>
					await db.all(sql<[], Record<string, unknown>>("SELECT * FROM decisions WHERE kind = 'failure' ORDER BY id")),
			),
		).toEqual(decisions);
		expect(
			await h.app.database.read(
				async (db) => await db.all(sql<[], Record<string, unknown>>("SELECT * FROM excuses ORDER BY decision")),
			),
		).toEqual(excuses);
		expect((await h.call<InboxReply>("inbox", { state: "decided", kind: "failure" })).items[0]).toMatchObject({
			q: question.q,
			title: "assertion failed",
		});
		expect(await h.call<ReportReceipt>("report", assertionShard(0))).toEqual({ ...receipt, fresh: false });
	});

	test.each([false, true])(
		"a stable shard order reuses the first shard's file causes on later commits, answered=%j",
		async (answered) => {
			const commits = answered ? ["c0000001", "c0000002"] : ["c1000001", "c1000002", "c1000003"];
			const firstShards: ReportReceipt[] = [];
			for (const commit of commits) {
				for (let shard = 0; shard < 6; shard++) {
					const report = assertionShard(shard);
					const receipt = await h.call<ReportReceipt>("report", { ...report, target: { ...report.target, commit } });
					if (shard === 0) firstShards.push(receipt);
				}
				if (answered && commit === commits[0]) {
					const generic = first((await queue()).items.filter((q) => q.title === "assertion failed"));
					expect((await decide(generic, { is: "flaky" }))?.status).toBe("decided");
				}
			}
			expect(first(firstShards).questions).toMatchObject([{ title: "assertion failed", tests: 40, state: "open" }]);
			for (const receipt of firstShards.slice(1)) {
				expect(receipt.questions).toHaveLength(6);
				expect(
					receipt.questions.every((q) => q.title.startsWith("Split by file (shard-0/") && q.state === "open"),
				).toBe(true);
			}
			expect((await gate(first(commits))).tally).toMatchObject({
				excused: answered ? 40 : 0,
				unexplained: answered ? 200 : 240,
			});
			for (const commit of commits.slice(1)) {
				expect((await gate(commit)).tally).toMatchObject({ excused: 0, unexplained: 240 });
			}
			expect((await queue()).counts.failure).toBe(answered ? 36 : 37);
			const generic = (await h.call<InboxReply>("inbox", { kind: "failure", state: answered ? "decided" : "open" }))
				.items;
			expect(generic.find((q) => q.title === "assertion failed")?.evidence.tests).toHaveLength(40);
		},
	);

	test("a null-file cause seen only before the split is reused on later commits", async () => {
		const report = genericReport(1);
		const missing = {
			...report,
			job: "without-file",
			results: [{ test: { key: "without-file" }, outcome: "fail", failure: { message: "assertion failed" } }],
		};
		const receipt = await h.call<ReportReceipt>("report", missing);
		expect((await decide(first((await queue()).items), { is: "flaky" }))?.status).toBe("decided");
		await h.call("report", assertionShard(0));
		await h.call("report", assertionShard(1));
		expect((await gate("broad001")).tally).toMatchObject({ excused: 41, unexplained: 40 });
		expect(await h.call<ReportReceipt>("report", missing)).toEqual({ ...receipt, fresh: false });
		const next = await h.call<ReportReceipt>("report", {
			...missing,
			target: { ...missing.target, commit: "broad002" },
		});
		expect(next.questions).toMatchObject([
			{ title: "Split by file (no file reported): assertion failed", tests: 1, state: "open" },
		]);
		expect((await gate("broad002")).tally).toMatchObject({ excused: 0, unexplained: 1 });
	});

	test("new files in small later shards count earlier split results under the original cause", async () => {
		await h.call("report", assertionShard(0));
		await h.call("report", assertionShard(1));
		const receipt = await h.call<ReportReceipt>("report", assertionShard(2, 1));
		expect(receipt.questions[0]).toMatchObject({
			title: "Split by file (shard-2/file-0.test.ts): assertion failed",
			tests: 1,
		});
		expect((await gate("broad001")).tally.unexplained).toBe(81);
	});

	test("cross-report thresholds count distinct tests and keep different assertions separate", async () => {
		const report = assertionShard(0);
		await h.call("report", report);
		const retry = await h.call<ReportReceipt>("report", { ...report, attempt: 2 });
		expect(retry.questions).toHaveLength(1);
		expect(retry.questions[0]?.title).toBe("assertion failed");
		const other = assertionShard(1);
		const distinct = await h.call<ReportReceipt>("report", {
			...other,
			results: other.results.map((result) => ({ ...result, failure: { message: "expected eight, got nine" } })),
		});
		expect(distinct.questions).toHaveLength(1);
		expect(distinct.questions[0]?.title).toBe("expected eight, got nine");
		const atLimit = await h.call<ReportReceipt>("report", assertionShard(2, 10));
		expect(atLimit.questions).toHaveLength(1);
		expect(atLimit.questions[0]?.title).toBe("assertion failed");
		const overLimit = await h.call<ReportReceipt>("report", assertionShard(3, 1));
		expect(overLimit.questions[0]?.title).toBe("Split by file (shard-3/file-0.test.ts): assertion failed");
	});

	test("the guard combines environments of one repository and commit, not other commits or repositories", async () => {
		await h.call("report", assertionShard(0));
		const other = assertionShard(1);
		for (const target of [
			{ ...other.target, commit: "broad002" },
			{ ...other.target, repo: "acme/other" },
		]) {
			const receipt = await h.call<ReportReceipt>("report", { ...other, target });
			expect(receipt.questions).toHaveLength(1);
			expect(receipt.questions[0]?.title).toBe("assertion failed");
		}
		const receipt = await h.call<ReportReceipt>("report", { ...other, target: { ...other.target, env: "another" } });
		expect(receipt.questions).toHaveLength(6);
		expect((await h.call<GateStatus>("gate", { commit: "broad001", repo: "acme/web" })).tally.unexplained).toBe(80);
	});

	test("five reported files and missing files across shards do not cross the file threshold", async () => {
		const report = genericReport(30, 5);
		await h.call("report", report);
		const sameFiles = await h.call<ReportReceipt>("report", {
			...report,
			job: "another",
			results: report.results.map((result) => ({
				...result,
				test: { ...result.test, key: `${result.test.key} extra` },
			})),
		});
		expect(sameFiles.questions[0]?.title).toBe("assertion failed");
		const missingFiles = await h.call<ReportReceipt>("report", {
			...report,
			job: "missing",
			results: Array.from({ length: 20 }, (_, i) => ({
				test: { key: `without-file-${i}` },
				outcome: "fail",
				failure: { message: "assertion failed" },
			})),
		});
		expect(missingFiles.questions[0]?.title).toBe("assertion failed");
		const sixthFile = await h.call<ReportReceipt>("report", assertionShard(1, 1));
		expect(sixthFile.questions[0]?.title).toBe("Split by file (shard-1/file-0.test.ts): assertion failed");
		expect((await gate("broad001")).tally.unexplained).toBe(81);
	});

	test("the guard counts applied reports even when acceptance order is reversed", async () => {
		const inTx = async <T>(fn: (ctx: ReturnType<typeof makeCtx<WriteDb>>) => T): Promise<T> =>
			await h.app.database.write(
				async (db) =>
					await db.transaction(async () => {
						const project = await findProject(db, "scratch");
						if (!project) throw new Error("no project");
						const ctx = makeCtx(h.app, db, project, h.owner, true);
						const out = await fn(ctx);
						await stampSeq(ctx);
						return out;
					}),
			);
		const firstBatch = (await inTx(async (ctx) => await acceptReport(ctx, assertionShard(0)))).batch;
		const secondBatch = (await inTx(async (ctx) => await acceptReport(ctx, assertionShard(1)))).batch;
		const firstApplied = await inTx(async (ctx) => await processBatch(ctx, secondBatch.id));
		expect(firstApplied.questions).toHaveLength(1);
		expect(firstApplied.questions[0]?.title).toBe("assertion failed");
		const secondApplied = await inTx(async (ctx) => await processBatch(ctx, firstBatch.id));
		expect(secondApplied.questions).toHaveLength(6);
		expect(await gate("broad001")).toMatchObject({ verdict: "blocked", stale: false, tally: { unexplained: 80 } });
		expect(await recoverAccepted(h.app)).toBe(0);
	});

	test("a broad assertion is split by file, and one answer excuses only that file", async () => {
		const report = genericReport();
		const receipt = await h.call<ReportReceipt>("report", report);
		expect(receipt.questions).toHaveLength(6);
		expect(receipt.questions.map((q) => q.tests)).toEqual([10, 10, 10, 10, 10, 10]);
		const questions = (await queue()).items.filter((q) => q.kind === "failure");
		expect(questions.map((q) => q.title).sort()).toEqual(
			Array.from({ length: 6 }, (_, i) => `Split by file (file-${i}.test.ts): assertion failed`),
		);
		const fileZero = questions.find((q) => q.title === "Split by file (file-0.test.ts): assertion failed");
		if (!fileZero) throw new Error("the first file's question was not raised");
		expect((await decide(fileZero, { is: "flaky", reason: "known in this file" }))?.status).toBe("decided");
		expect((await gate("broad001")).tally).toMatchObject({ excused: 10, unexplained: 50 });
		expect((await gate("broad001")).verdict).toBe("blocked");
		const retry = await h.call<ReportReceipt>("report", { ...report, attempt: 2 });
		expect(retry.questions.filter((q) => q.state === "open")).toHaveLength(5);
		expect((await gate("broad001")).tally).toMatchObject({ excused: 10, unexplained: 50 });
		const later = await h.call<ReportReceipt>("report", {
			...report,
			target: { ...report.target, commit: "broad002" },
			results: [first(report.results)],
		});
		expect(later.questions[0]?.title).toBe("Split by file (file-0.test.ts): assertion failed");
		expect(later.gate?.tally).toMatchObject({ excused: 1, unexplained: 0 });
		expect(await h.call<ReportReceipt>("report", report)).toMatchObject({ fresh: false, questions: receipt.questions });
	});

	test.each([
		[50, 6, "assertion failed"],
		[51, 5, "assertion failed"],
		[60, 5, "assertion failed"],
		[60, 6, "Timeout 5000ms exceeded"],
		[60, 6, "connect ECONNREFUSED localhost:5432"],
	])("the guard keeps %i tests in %i files with %s together", async (n, files, message) => {
		const receipt = await h.call<ReportReceipt>("report", genericReport(n, files, message));
		expect(receipt.questions).toHaveLength(1);
		expect(receipt.questions[0]?.tests).toBe(n);
	});

	test("51 tests across six files split even when one file already has a split signature", async () => {
		const report = genericReport();
		await h.call("report", report);
		const later = genericReport(51);
		later.results = later.results.map((result, i) => ({
			...result,
			test: i % 6 === 0 ? result.test : { key: `new-${i % 6}.ts::test ${i}`, file: `new-${i % 6}.ts` },
		}));
		const receipt = await h.call<ReportReceipt>("report", {
			...later,
			target: { ...later.target, commit: "mixed001" },
		});
		expect(receipt.questions).toHaveLength(6);
		expect(receipt.questions.map((q) => q.tests).sort()).toEqual([8, 8, 8, 9, 9, 9]);
		expect(receipt.questions.every((q) => q.title.startsWith("Split by file ("))).toBe(true);
	});

	test("a missing file stays separate from a file named no file reported", async () => {
		const report = genericReport();
		const receipt = await h.call<ReportReceipt>("report", {
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

	test("the guard sees the whole report across application slices", async () => {
		const receipt = await h.call<ReportReceipt>("report", genericReport(600));
		expect(receipt.questions).toHaveLength(6);
		expect(receipt.questions.map((q) => q.tests)).toEqual([100, 100, 100, 100, 100, 100]);
		expect(receipt.gate?.tally.unexplained).toBe(600);
	});

	test("each normalised assertion has its own thresholds", async () => {
		const report = genericReport();
		const receipt = await h.call<ReportReceipt>("report", {
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

	test("the guard counts distinct tests, not repeated results", async () => {
		const report = genericReport(6);
		const receipt = await h.call<ReportReceipt>("report", {
			...report,
			results: Array(10).fill(report.results).flat(),
		});
		expect(receipt.questions).toHaveLength(1);
		expect((await queue()).items.find((q) => q.kind === "failure")?.title).toBe("assertion failed");
	});

	test("a prior answer for the generic cause cannot excuse a broad report", async () => {
		const report = genericReport();
		await h.call("report", {
			...report,
			target: { ...report.target, commit: "prior001" },
			results: [first(report.results)],
		});
		await decide(first((await queue()).items), { is: "flaky", reason: "known earlier" });
		const receipt = await h.call<ReportReceipt>("report", report);
		expect(receipt.questions).toHaveLength(6);
		expect(receipt.gate?.tally).toMatchObject({ excused: 0, unexplained: 60 });
		expect((await gate("prior001")).tally).toMatchObject({ excused: 1, unexplained: 0 });
	});

	test("volatile parts of a message do not split a cause, different assertions do", async () => {
		const receipt = await h.call<ReportReceipt>(
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

	test("C3: a decision changes the gate without re-running the pipeline", async () => {
		await h.call("report", ciReport({ commit: "ccccccc1", n: 10, fail: { 3: "connect ECONNREFUSED 10.0.0.5:5432" } }));
		expect((await gate("ccccccc1")).verdict).toBe("blocked");
		expect((await decide(first((await queue()).items), { is: "infra" }))?.status).toBe("decided");
		const after = await gate("ccccccc1");
		expect(after).toMatchObject({ verdict: "passed" });
		expect(after.tally).toMatchObject({ pass: 9, excused: 1, unexplained: 0 });
	});

	test("a defect is attributed: the gate says failed, which needs a fix, not a decision", async () => {
		await h.call("report", ciReport({ commit: "ccccccc2", n: 10, fail: { 3: "expected 90.00, got 100.00" } }));
		await decide(first((await queue()).items), { is: "defect", ref: "WEB-301" });
		expect(await gate("ccccccc2")).toMatchObject({
			verdict: "failed",
			reason: "failed: 1 failure attributed to this target",
		});
	});

	test("D3: the same failing commit re-run asks nothing new", async () => {
		const fail = { 3: "expected 90.00, got 100.00" };
		await h.call("report", ciReport({ commit: "ddddddd1", n: 10, fail }));
		await decide(first((await queue()).items), { is: "defect" });
		const again = await h.call<ReportReceipt>("report", ciReport({ commit: "ddddddd1", n: 10, fail, attempt: 2 }));
		expect(again.questions[0]).toMatchObject({ how: "already decided", answer: "defect", by: "robin" });
		expect((await queue()).counts.open).toBe(0);
		expect(await count("questions WHERE kind = 'failure'")).toBe(1);
	});

	test("an answer on evidence that has changed is a conflict, with the new evidence", async () => {
		await h.call("report", ciReport({ commit: "eeeeeee1", pr: 7, branch: "fix", n: 3, fail: { 0: "boom" } }));
		const seen = first((await queue()).items);
		// trunk fails the same way, then the change gets a newer build
		await h.call("report", ciReport({ commit: "0000000a", n: 3, fail: { 0: "boom" } })); // trunk now fails the same way
		await h.call("report", ciReport({ commit: "eeeeeee2", pr: 7, branch: "fix", n: 3, fail: { 0: "boom" } }));
		const reply = await h.raw("decide", { q: seen.q, onEvidence: seen.evidenceHash, answer: { is: "flaky" } });
		// a newer build has arrived since the answer was prepared, so it is a conflict
		expect(reply.ok && (reply.result as { status: string }[])[0]?.status).toBe("conflict");
	});

	test("one undo command withdraws unchanged decisions, refuses replacements, and replays without writes", async () => {
		await h.call("report", ciReport({ commit: "undo-many", n: 2, fail: { 0: "first failure", 1: "second failure" } }));
		const questions = (await queue()).items;
		expect(questions).toHaveLength(2);
		const receipts = await h.call<DecideReply[]>("decide", {
			all: questions.map((q) => ({ q: q.q, onEvidence: q.evidenceHash, answer: { is: "flaky" } })),
		});
		const changed = first(questions);
		const unchanged = first(questions.slice(1));
		const replacement = first(
			await h.call<DecideReply[]>("decide", {
				q: changed.q,
				onEvidence: changed.evidenceHash,
				answer: { is: "defect" },
			}),
		);
		const input = {
			undo: receipts.map((reply) => ({ q: reply.q, ifDecision: reply.decision })),
			reason: "Taking back the selection",
			cmd: "withdraw-selection",
		};
		const before = await count("decisions");
		const reply = await h.call<DecideReply[]>("decide", input);
		expect(reply.map(({ q, status }) => ({ q, status }))).toEqual([
			{ q: changed.q, status: "conflict" },
			{ q: unchanged.q, status: "reopened" },
		]);
		expect(await count("decisions")).toBe(before + 1);
		expect(first((await h.call<InboxReply>("inbox", { state: "decided" })).items).decision).toMatchObject({
			id: replacement.decision,
		});
		expect(
			await h.app.database.read(
				async (db) =>
					await db.get(
						sql<[], Record<string, unknown>>(
							"SELECT signers::jsonb->0->>'reason' AS reason FROM decisions ORDER BY id DESC LIMIT 1",
						),
					),
			),
		).toEqual({ reason: input.reason });
		const state = await h.raw("inbox");
		if (!state.ok) throw new Error("No inbox");
		const seq = state.seq;
		expect(seq).toBeNumber();
		expect(await h.call<DecideReply[]>("decide", input)).toEqual(reply);
		expect(await count("decisions")).toBe(before + 1);
		expect(await h.raw("inbox")).toMatchObject({ ok: true, seq });
	});

	test("one undo accepts 500 conditional withdrawals and refuses empty, oversized or unconditional lists", async () => {
		await h.call("propose", {
			edits: Array.from({ length: 500 }, (_, i) => ({ op: "create", outline: `Reviewed case ${i}` })),
		});
		const cases = await h.app.database.read(async (db) =>
			db.all(sql<[], { id: number; no: number; head_hash: string }>("SELECT id, no, head_hash FROM cases ORDER BY no")),
		);
		const template = first(cases);
		await h.call("claim", {
			lens: "undo-limit",
			findings: [{ on: `C-${template.no}`, category: "ambiguous", note: "Name the expected result" }],
		});
		// Build the history from one real review; the 500 conditional withdrawals below still use decide.
		const copies = cases.slice(1).map((row) => {
			const on = `C-${row.no}`;
			const basis = contentHash({ on, category: "ambiguous", basis: row.head_hash });
			return {
				id: row.id,
				fingerprint: contentHash({ kind: "finding", key: `${on}|ambiguous` }),
				basis,
				hash: contentHash({ basis, target: null }),
			};
		});
		await h.app.database.write(async (db) =>
			db.transaction(async () => {
				await db.run(
					sql<{
						ids: number[];
						fingerprints: string[];
						bases: string[];
						hashes: string[];
					}>(`
 WITH seeds AS (
  SELECT c.*, u.fingerprint, u.basis, u.hash
  FROM unnest($ids::bigint[], $fingerprints::text[], $bases::text[], $hashes::text[])
   AS u(id,fingerprint,basis,hash) JOIN cases c ON c.id=u.id
 ), template AS (
  SELECT q.* FROM questions q JOIN findings f ON f.question=q.id WHERE f.lens='undo-limit'
 ), made AS (
  INSERT INTO questions
   (project,no,kind,subject,fingerprint,epoch,prior,title,producer,evidence,evidence_hash,basis,
    seen_count,seen_first,seen_last,carried,ask,blocks,owner,rank,state,decision,opened_at,rev)
  SELECT q.project,q.no+c.no-1,q.kind,
   (q.subject::jsonb || jsonb_build_object('on','C-'||c.no))::text,c.fingerprint,q.epoch,q.prior,q.title,q.producer,
   (q.evidence::jsonb || jsonb_build_object('on','C-'||c.no,'case','C-'||c.no,'caseTitle',c.title))::text,
   c.hash,c.basis,q.seen_count,q.seen_first,q.seen_last,q.carried,q.ask,q.blocks,q.owner,q.rank-c.no+1,
   'open',NULL,q.opened_at,q.rev FROM template q CROSS JOIN seeds c RETURNING *
 ), refs AS (
  INSERT INTO question_refs(project,ref,question)
  SELECT q.project,'C-'||c.no,q.id FROM made q JOIN seeds c ON c.fingerprint=q.fingerprint

 )
 INSERT INTO findings(project,actor,lens,locus,case_id,category,note,repro,suggest,basis,question,at,seq)
 SELECT f.project,f.actor,f.lens,'C-'||c.no,c.id,f.category,f.note,f.repro,f.suggest,c.head_hash,q.id,f.at,f.seq
 FROM findings f CROSS JOIN seeds c JOIN made q ON q.fingerprint=c.fingerprint WHERE f.lens='undo-limit'`),
					{
						ids: copies.map((row) => row.id),
						fingerprints: copies.map((row) => row.fingerprint),
						bases: copies.map((row) => row.basis),
						hashes: copies.map((row) => row.hash),
					},
				);
				await db.exec(`UPDATE counters SET value=(SELECT max(no) FROM questions WHERE project=counters.project)
 WHERE name='question'`);
			}),
		);
		const questions = (await h.call<InboxReply>("inbox", { limit: 500 })).items;
		expect(questions).toHaveLength(500);
		const chosen = first(questions);
		const receipt = first(
			await h.call<DecideReply[]>("decide", {
				q: chosen.q,
				onEvidence: chosen.evidenceHash,
				answer: { is: "defer" },
			}),
		);
		// Defer has no standing effect. Copy its ledger and owner signature, rebasing every evidence hold.
		const receipts = await h.app.database.write(async (db) =>
			db.transaction(async () => {
				await db.run(
					sql<{ decision: number | null }>(`
 WITH template AS (SELECT * FROM decisions WHERE id=$decision), copied AS (
  INSERT INTO decisions(project,question,kind,answer,signers,basis,holds,expires_at,supersedes,effects,at,seq,on_evidence)
  SELECT q.project,q.id,q.kind,d.answer,d.signers,q.basis,
   jsonb_build_array(jsonb_build_object('until','basis-changes','basis',q.basis))::text,
   d.expires_at,NULL,d.effects,d.at,d.seq,q.evidence_hash
  FROM questions q CROSS JOIN template d WHERE q.kind='finding' AND q.state='open' RETURNING question
 )
 INSERT INTO answers(question,actor,answer,reason,on_evidence,counts,at,seq)
 SELECT q.id,a.actor,a.answer,a.reason,q.evidence_hash,a.counts,a.at,a.seq
 FROM copied c JOIN questions q ON q.id=c.question CROSS JOIN template d JOIN answers a ON a.question=d.question`),
					{ decision: receipt.decision },
				);
				await db.exec(`UPDATE questions q SET state='decided',decision=d.id,rev=d.seq
 FROM decisions d WHERE d.question=q.id AND q.kind='finding' AND q.state='open'`);
				return await db.all(
					sql<[], { q: string; decision: number }>(`
 SELECT 'Q-'||q.no AS q,d.id AS decision FROM questions q JOIN decisions d ON d.id=q.decision AND d.question=q.id
 WHERE q.kind='finding' AND q.state='decided' ORDER BY q.rank,q.id`),
				);
			}),
		);
		expect(
			await h.app.database.read((db) =>
				db.all(
					sql<readonly [], { n: number }>(`
 SELECT count(*) AS n FROM findings f JOIN cases c ON c.id=f.case_id JOIN questions q ON q.id=f.question
 JOIN decisions d ON d.id=q.decision AND d.question=q.id JOIN answers a ON a.question=q.id
 WHERE f.basis=c.head_hash AND f.locus='C-'||c.no AND d.basis=q.basis AND d.on_evidence=q.evidence_hash
 AND a.on_evidence=q.evidence_hash AND q.state='decided'
 AND d.holds::jsonb @> jsonb_build_array(jsonb_build_object('until','basis-changes','basis',q.basis))
`),
				),
			),
		).toEqual([{ n: 500 }]);

		const undo = receipts.map((reply) => ({ q: reply.q, ifDecision: reply.decision }));
		const before = await count("decisions");
		for (const invalid of [[], [...undo, undo[0]], [{ q: questions[0]?.q }]]) {
			expect(await h.raw("decide", { undo: invalid })).toMatchObject({ ok: false, error: { code: "invalid" } });
		}
		expect(await count("decisions")).toBe(before);
		expect((await h.call<DecideReply[]>("decide", { undo })).map((reply) => reply.status)).toEqual(
			Array(500).fill("reopened"),
		);
		expect(await count("decisions")).toBe(before + 500);
		expect((await queue()).counts.open).toBe(500);
	});

	test("undo withdraws a decision: the gate returns, and both decisions stay in the ledger", async () => {
		await h.call("report", ciReport({ commit: "fffffff1", n: 5, fail: { 1: "expected 1, got 2" } }));
		const q = first((await queue()).items);
		await decide(q, { is: "flaky" });
		expect((await gate("fffffff1")).verdict).toBe("passed");
		const undone = await h.call<{ status: string }[]>("decide", { undo: q.q });
		expect(undone[0]?.status).toBe("reopened");
		expect((await gate("fffffff1")).verdict).toBe("blocked");
		expect((await queue()).counts.open).toBe(1);
		expect(await count("decisions WHERE kind = 'failure'")).toBe(2);
		expect(await count("excuses")).toBe(0);
	});

	test("undo with a decision receipt leaves an intervening answer in force", async () => {
		await h.call("report", ciReport({ commit: "fffffff2", n: 1, fail: { 0: "expected one, got two" } }));
		const q = first((await queue()).items);
		const give = async (is: string, as = h.owner) =>
			first(await h.call<DecideReply[]>("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is } }, as));
		const receipt = await give("flaky");
		const colleague = await h.actor("colleague", "human", ["read", "produce", "answer"]);
		const replacement = await give("defect", colleague);
		expect(receipt.status).toBe("decided");
		expect(replacement.status).toBe("decided");
		const decisions = await count("decisions");
		const stale = first(await h.call<DecideReply[]>("decide", { undo: q.q, ifDecision: receipt.decision }));
		expect(stale.status).toBe("conflict");
		expect(stale.needs).toContain("decision changed");
		expect(first((await h.call<InboxReply>("inbox", { state: "decided" })).items).decision).toMatchObject({
			id: replacement.decision,
		});
		expect((await gate("fffffff2")).verdict).toBe("failed");
		expect(await count("decisions")).toBe(decisions);
		for (const ifDecision of [0, -1, 1.5, null, "decision"]) {
			expect(await h.raw("decide", { undo: q.q, ifDecision })).toMatchObject({
				ok: false,
				error: { code: "invalid" },
			});
		}
		expect(await count("decisions")).toBe(decisions);
		expect(first(await h.call<DecideReply[]>("decide", { undo: q.q, ifDecision: replacement.decision })).status).toBe(
			"reopened",
		);
		expect((await gate("fffffff2")).verdict).toBe("blocked");
		expect(first(await h.call<DecideReply[]>("decide", { undo: q.q, ifDecision: replacement.decision })).status).toBe(
			"conflict",
		);
	});

	test("receiptless undo deliberately withdraws the decision that stands now", async () => {
		await h.call("report", ciReport({ commit: "fffffff3", n: 1, fail: { 0: "expected one, got two" } }));
		const q = first((await queue()).items);
		await decide(q, { is: "flaky" });
		await decide(q, { is: "defect" });
		expect(first(await h.call<DecideReply[]>("decide", { undo: q.q })).status).toBe("reopened");
		expect((await gate("fffffff3")).verdict).toBe("blocked");
	});

	test("a retry that passes is a recorded flip, the gate passes, and nobody is asked why it failed", async () => {
		await h.call("report", ciReport({ commit: "abababa1", n: 5, fail: { 2: "expected 1, got 2" } }));
		expect((await queue()).counts.open).toBe(1);
		const retry = await h.call<ReportReceipt>("report", ciReport({ commit: "abababa1", n: 5, attempt: 2 }));
		expect(retry.flips).toBe(1);
		expect(retry.gate?.verdict).toBe("passed");
		expect((await queue()).counts.open).toBe(0);
		expect(await count("questions WHERE state = 'dissolved'")).toBe(1);
		expect(await count("flips")).toBe(1);
	});
});

describe("same-code detector suggestions", () => {
	const sameCode = async () =>
		SameCodeEvidence.parse((await h.call<Record<string, unknown>[]>("get", { refs: ["T-1"] }))[0]?.sameCode);
	const report = async (attempt: number, message?: string, job = "e2e") =>
		await h.call<ReportReceipt>(
			"report",
			ciReport({ commit: "detector1", n: 1, attempt, job, fail: message ? { 0: message } : {} }),
		);

	test("shows assertion evidence without silently excusing the current failure", async () => {
		await report(1, "expected 1, got 2");
		await report(2);
		const failing = await report(3, "expected 1, got 2");
		expect(await sameCode()).toMatchObject({
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
		expect((await sameCode()).signals[0]?.samples[0]).toMatchObject({
			commit: "detector1",
			job: "e2e",
			first: { id: 2, outcome: "pass", attempt: 2 },
			second: { id: 3, outcome: "fail", attempt: 3 },
		});
		expect(failing.gate?.verdict).toBe("blocked");
		expect(await count("excuses")).toBe(0);
		expect((await queue()).items[0]?.evidence.tests).toMatchObject([
			{ sameCode: { signals: [{ class: "assertion", suggested: true }] } },
		]);
	});

	test("keeps assertion, timeout and infrastructure evidence separate", async () => {
		await report(1);
		await report(2, "expected 1, got 2");
		await report(3);
		await report(4, "ECONNRESET");
		await report(5);
		await report(6, "TimeoutError: waiting for element");
		await report(7);
		expect(await sameCode()).toMatchObject({
			signals: [
				{ class: "assertion", flips: 2, suggested: true },
				{ class: "timeout", flips: 2, suggested: true },
				{ class: "infra", flips: 2, suggested: true },
			],
		});
	});

	test("different assertion causes do not pool flips toward the threshold", async () => {
		await report(1, "expected 1, got 2");
		await report(2);
		await report(3, "expected 3, got 4");
		expect((await sameCode()).signals).toMatchObject([
			{ signature: { text: "expected 1, got 2" }, class: "assertion", flips: 1, suggested: false },
			{ signature: { text: "expected 3, got 4" }, class: "assertion", flips: 1, suggested: false },
		]);
	});

	test("a file-split cause counts its own flips and keeps the original cause's history separate", async () => {
		const input = ciReport({ commit: "splitflip1", n: 0 });
		const tests = Array.from({ length: 60 }, (_, i) => ({
			key: `file-${i % 6}.test.ts::test ${i}`,
			file: `file-${i % 6}.test.ts`,
		}));
		const chosen = first(tests);
		const send = async (attempt: number, outcome: "pass" | "fail", broad = false) =>
			await h.call<ReportReceipt>("report", {
				...input,
				attempt,
				results: (broad ? tests : [chosen]).map((test) => ({
					test,
					outcome,
					...(outcome === "fail" ? { failure: { message: "assertion failed" } } : {}),
				})),
			});
		await send(1, "pass");
		await send(2, "fail");
		await send(3, "pass");
		const splitReport = await send(4, "fail", true);
		expect(splitReport.questions).toHaveLength(6);
		expect((await sameCode()).signals).toMatchObject([
			{ signature: { text: "assertion failed" }, class: "assertion", flips: 2, suggested: true },
			{
				signature: { text: "Split by file (file-0.test.ts): assertion failed" },
				class: "assertion",
				flips: 1,
				suggested: false,
			},
		]);
		const fileZero = async () =>
			(await queue()).items.find((q) => q.title === "Split by file (file-0.test.ts): assertion failed");
		expect(first(z.array(z.unknown()).parse((await fileZero())?.evidence.tests))).toMatchObject({
			t: "T-1",
			sameCode: { signals: [{ flips: 1, suggested: false }] },
		});
		const otherFile = (await queue()).items.find((q) => q.title === "Split by file (file-1.test.ts): assertion failed");
		expect(otherFile?.evidence.tests).toHaveLength(10);
		expect(otherFile?.evidence.tests).not.toContainEqual(expect.objectContaining({ sameCode: expect.anything() }));
		await send(5, "pass");
		const retry = await send(6, "fail");
		expect(retry.questions[0]?.title).toBe("Split by file (file-0.test.ts): assertion failed");
		expect((await sameCode()).signals).toMatchObject([
			{ signature: { text: "assertion failed" }, flips: 2, suggested: true },
			{ signature: { text: "Split by file (file-0.test.ts): assertion failed" }, flips: 3, suggested: true },
		]);
		const snapshot = first(
			z
				.array(z.object({ sameCode: SameCodeEvidence.optional() }).passthrough())
				.parse((await fileZero())?.evidence.tests),
		).sameCode;
		expect(snapshot?.signals).toHaveLength(1);
		expect(snapshot?.signals[0]).toMatchObject({
			signature: { text: "Split by file (file-0.test.ts): assertion failed" },
			flips: 3,
			suggested: true,
		});
		expect(retry.gate).toMatchObject({ verdict: "blocked", tally: { unexplained: 60, excused: 0 } });
	});

	test("a different job and an older attempt do not add detector evidence", async () => {
		await report(2, "expected 1, got 2");
		await report(3, undefined, "unit");
		await report(1);
		expect(await sameCode()).toMatchObject({ signals: [] });
		await report(3);
		expect(await sameCode()).toMatchObject({ signals: [{ class: "assertion", flips: 1, suggested: false }] });
	});

	test("a skipped retry does not hide a decisive flip, and replaying a batch adds nothing", async () => {
		await report(1, "expected 1, got 2");
		const skipped = ciReport({ commit: "detector1", n: 1, attempt: 2 });
		await h.call("report", { ...skipped, results: skipped.results.map((r) => ({ ...r, outcome: "skip" })) });
		await report(3);
		await report(3);
		expect(await sameCode()).toMatchObject({ signals: [{ class: "assertion", flips: 1, suggested: false }] });
	});

	test("project settings change thresholds, disable suggestions, and expire old evidence", async () => {
		const configure = async (flakyDetection: { enabled: boolean; windowDays: number; minFlips: number }) => {
			const policy = Policy.extend({ version: z.number() }).parse(
				await h.call("admin", { do: "policy.show", project: "scratch" }),
			);
			const proposed = await h.call<{ question: string }>("propose", {
				edits: [{ op: "policy", base: policy.version, settings: { ...policy.settings, flakyDetection } }],
			});
			const q = (await h.call<InboxReply["items"]>("get", { refs: [proposed.question] }))[0];
			if (!q) throw new Error("policy question missing");
			expect((await decide(q, { is: "accept" }))?.status).toBe("decided");
		};
		await report(1, "expected 1, got 2");
		await report(2);
		await report(3, "expected 1, got 2");
		await configure({ enabled: true, windowDays: 1, minFlips: 3 });
		expect((await sameCode()).signals).toMatchObject([{ class: "assertion", flips: 2, suggested: false }]);
		await configure({ enabled: false, windowDays: 1, minFlips: 1 });
		expect(await sameCode()).toEqual({ enabled: false, windowDays: 1, minFlips: 1, signals: [] });
		const other = await harness({ project: "other" });
		try {
			expect(
				Policy.parse(await other.call("admin", { do: "policy.show", project: "other" })).settings.flakyDetection,
			).toEqual({ enabled: true, windowDays: 14, minFlips: 2 });
		} finally {
			await other.close();
		}

		expect(await count("flips")).toBe(2);
		await configure({ enabled: true, windowDays: 1, minFlips: 1 });
		expect((await sameCode()).signals).toMatchObject([{ flips: 2, suggested: true }]);
		h.advance(86_400_001);
		expect((await sameCode()).signals).toEqual([]);
		expect((await gate("detector1")).verdict).toBe("blocked");
	});

	test("invalid detector settings are refused without changing the policy", async () => {
		const policy = Policy.extend({ version: z.number() }).parse(
			await h.call("admin", { do: "policy.show", project: "scratch" }),
		);
		for (const bad of [
			{ enabled: "yes" },
			{ minFlips: 0 },
			{ minFlips: 101 },
			{ windowDays: 0 },
			{ windowDays: 366 },
		]) {
			expect(
				await h.raw("propose", {
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
		expect(
			Policy.parse(await h.call("admin", { do: "policy.show", project: "scratch" })).settings.flakyDetection,
		).toEqual({
			enabled: true,
			windowDays: 14,
			minFlips: 2,
		});
	});

	test("one producer cannot create a flip with another producer's result", async () => {
		await report(1, "expected 1, got 2");
		const pipeline = await h.actor("other-pipeline", "ci", ["record"]);
		await h.call("report", ciReport({ commit: "detector1", n: 1, attempt: 2 }), pipeline);
		expect((await sameCode()).signals).toEqual([]);
		await report(2);
		expect((await sameCode()).signals).toMatchObject([{ class: "assertion", flips: 1 }]);
	});

	test("same-attempt disagreement is not a retry flip", async () => {
		await report(1, "expected 1, got 2");
		await report(1);
		expect((await sameCode()).signals).toEqual([]);
		await report(2);
		expect((await sameCode()).signals).toMatchObject([{ class: "assertion", flips: 1 }]);
	});

	test("a later same-attempt failure removes a pass from detector evidence", async () => {
		await report(1, "expected 1, got 2");
		await report(2);
		expect((await sameCode()).signals).toMatchObject([{ flips: 1 }]);
		await report(2, "expected 1, got 2");
		expect((await sameCode()).signals).toEqual([]);
		await report(3);
		expect((await sameCode()).signals).toMatchObject([
			{ flips: 1, samples: [{ first: { outcome: "fail", attempt: 2 }, second: { outcome: "pass", attempt: 3 } }] },
		]);
	});

	test("counts every flip but bounds concrete examples to three per failure cause", async () => {
		for (const attempt of [1, 2, 3, 4, 5]) await report(attempt, attempt % 2 === 1 ? "expected 1, got 2" : undefined);
		expect((await sameCode()).signals).toMatchObject([{ class: "assertion", flips: 4, suggested: true }]);
		expect((await sameCode()).signals[0]?.samples).toHaveLength(3);
	});

	test("different environments, repositories and commits do not cross", async () => {
		await report(1, "expected 1, got 2");
		const pass = ciReport({ commit: "detector1", n: 1, attempt: 2 });
		for (const target of [
			{ ...pass.target, env: "staging" },
			{ ...pass.target, repo: "acme/other" },
			{ ...pass.target, commit: "detector2" },
		])
			await h.call("report", { ...pass, target });
		expect((await sameCode()).signals).toEqual([]);
		await report(2);
		expect((await sameCode()).signals).toMatchObject([{ class: "assertion", flips: 1 }]);
	});

	test("a corrected observation stops supporting a suggestion", async () => {
		const initial = await report(1, "expected 1, got 2");
		await report(2);
		expect((await sameCode()).signals).toMatchObject([{ flips: 1 }]);
		const corrected = ciReport({ commit: "detector1", n: 1, attempt: 3 });
		await h.call("report", {
			...corrected,
			results: corrected.results.map((r) => ({ ...r, corrects: initial.results[0] })),
		});
		expect((await sameCode()).signals).toEqual([]);
	});

	test("agents and session targets do not become same-code suggestions", async () => {
		const agent = await h.actor("review-bot", "agent", ["read", "produce"]);
		for (const attempt of [1, 2, 3])
			await h.call(
				"report",
				ciReport({ commit: "detector1", n: 1, attempt, fail: attempt === 2 ? {} : { 0: "expected 1, got 2" } }),
				agent,
			);
		expect((await sameCode()).signals).toEqual([]);
		for (const attempt of [1, 2, 3]) {
			const input = ciReport({
				commit: "detector1",
				n: 1,
				attempt,
				fail: attempt === 2 ? {} : { 0: "expected 1, got 2" },
			});
			await h.call("report", { ...input, target: { session: "manual-session" } });
		}
		expect((await sameCode()).signals).toEqual([]);
		await report(1);
		await report(2, "expected 1, got 2");
		expect((await sameCode()).signals).toMatchObject([{ class: "assertion", flips: 1 }]);
	});

	test("policies stored before detection settings still read with defaults", async () => {
		const policy = Policy.parse(await h.call("admin", { do: "policy.show", project: "scratch" }));
		const { flakyDetection: _, ...legacy } = policy.settings;
		await h.app.database.write(
			async (db) =>
				await db.transaction(
					async () =>
						await db.run(sql<readonly SqlValue[], Record<string, unknown>>("UPDATE policies SET settings = $1"), [
							JSON.stringify(legacy),
						]),
				),
		);
		expect(
			Policy.parse(await h.call("admin", { do: "policy.show", project: "scratch" })).settings.flakyDetection,
		).toEqual({
			enabled: true,
			minFlips: 2,
			windowDays: 14,
		});
		await report(1);
		await report(2, "expected 1, got 2");
		expect((await sameCode()).signals).toMatchObject([{ class: "assertion", flips: 1 }]);
	});
});

describe("a change against its base", () => {
	const failure = { 4: "expected 90.00, got 100.00" };

	test("loose: a failure the base has too is excused by a recorded rule for each commit", async () => {
		await h.call("report", ciReport({ commit: "base0001", n: 10, fail: failure }));
		await decide(first((await queue()).items), { is: "defect" });
		const change = (commit: string) =>
			ciReport({ commit, branch: "feature", pr: 482, base: "base0001", n: 10, fail: failure });
		const pr = await h.call<ReportReceipt>("report", change("feat0001"));
		expect(pr.questions[0]).toMatchObject({ how: "decided by rule", state: "decided", answer: "inherited" });
		expect(pr.gate).toMatchObject({ verdict: "passed", tally: { excused: 1 } });
		const next = await h.call<ReportReceipt>("report", change("feat0001b"));
		expect(next.questions[0]).toMatchObject({ how: "decided by rule", state: "decided", answer: "inherited" });
		expect(next.questions[0]?.q).not.toBe(pr.questions[0]?.q);
		expect(next.gate?.verdict).toBe("passed");
	});

	test("loose: a failure the change introduced is a question, and it blocks the change", async () => {
		await h.call("report", ciReport({ commit: "base0002", n: 10 }));
		const pr = await h.call<ReportReceipt>(
			"report",
			ciReport({ commit: "feat0002", branch: "feature", pr: 483, base: "base0002", n: 10, fail: failure }),
		);
		expect(pr.questions[0]).toMatchObject({ how: "new", state: "open" });
		expect(pr.gate).toMatchObject({ verdict: "blocked" });
		expect((await h.call<GateStatus>("gate", { change: "pr:483" })).verdict).toBe("blocked");
	});

	test("a decision on one push of a pull request still stands on the next push", async () => {
		await h.call("report", ciReport({ commit: "base0003", n: 10 }));
		await h.call(
			"report",
			ciReport({ commit: "feat0003", branch: "feature", pr: 484, base: "base0003", n: 10, fail: failure }),
		);
		await decide(first((await queue()).items), { is: "flaky" });
		const next = await h.call<ReportReceipt>(
			"report",
			ciReport({ commit: "feat0004", branch: "feature", pr: 484, base: "base0003", n: 10, fail: failure }),
		);
		expect(next.questions[0]).toMatchObject({ how: "already decided", answer: "flaky" });
		expect(next.gate?.verdict).toBe("passed");
	});

	test("standard: the same data, but the base failure is only a hint and a person decides", async () => {
		const s = await harness({ preset: "standard" });
		await s.call("report", ciReport({ commit: "base0001", n: 10, fail: failure }));
		const pr = await s.call<ReportReceipt>(
			"report",
			ciReport({ commit: "feat0001", branch: "feature", pr: 482, base: "base0001", n: 10, fail: failure }),
		);
		expect(pr.questions[0]).toMatchObject({ how: "new", state: "open" });
		const open = await s.call<InboxReply>("inbox", { on: "pr:482" });
		expect((first(open.items).evidence as { hints: string[] }).hints).toContain("fails-on-base");
		await s.close();
	});
});

describe("holds", () => {
	test("E8: a flaky excuse expires with no new report: the gate reads pending, and the next occurrence is asked again", async () => {
		const fail = { 0: "expected 1, got 2" };
		await h.call("report", ciReport({ commit: "1111111a", n: 3, fail }));
		await decide(first((await queue()).items), { is: "flaky" });
		expect((await gate("1111111a")).verdict).toBe("passed");
		h.advance(15 * 86_400_000);
		const stale = await gate("1111111a");
		expect(stale).toMatchObject({
			verdict: "pending",
			stale: true,
			reason: "pending: a decision this run rests on has expired",
		});
		const next = await h.call<ReportReceipt>("report", ciReport({ commit: "1111111b", n: 3, fail }));
		expect(next.questions[0]).toMatchObject({ how: "new", state: "open" });
		const asked = first((await queue()).items);
		const prior = await h.app.database.read(
			async (db) =>
				await db.get(
					sql<[], { prior: number | null; epoch: number }>("SELECT prior, epoch FROM questions WHERE state = 'open'"),
				),
		);
		expect(prior).toMatchObject({ epoch: 1 });
		expect(prior?.prior).not.toBeNull();
		expect(asked.kind).toBe("failure");
	});

	/** The ledger rows of a question, oldest first: each answer and how it ended. */
	const ledger = async (q: string) =>
		(
			await h.app.database.read(
				async (db) =>
					await db.all(
						sql<readonly SqlValue[], { answer: string; signers: string }>(
							"SELECT d.answer, d.signers FROM decisions d JOIN questions q ON q.id = d.question WHERE q.no = $1 ORDER BY d.id",
						),
						[Number(q.slice(2))],
					),
			)
		).map((row) => ({
			is: (JSON.parse(row.answer) as { is: string }).is,
			clause: (JSON.parse(row.signers) as { clause: string; reason: string | null }[])[0]?.clause,
			reason: (JSON.parse(row.signers) as { clause: string; reason: string | null }[])[0]?.reason ?? null,
		}));
	const state = async (q: string) => (await h.call<{ state: string }[]>("get", { refs: [q] }))[0]?.state;

	test.each(["loose", "standard"])(
		"an agent report preserves a PR question when its head's run belongs to another scope, preset=%s",
		async (preset) => {
			const s = await harness({ preset });
			try {
				await s.call("propose", { edits: [{ op: "create", outline: "Checkout works" }] });
				const ci = await s.actor("pipeline", "ci", ["read", "record"]);
				const agent = await s.actor("reviewer", "agent", ["read", "produce"]);
				const old = ciReport({
					commit: "scope001",
					pr: 7,
					branch: "feature",
					n: 1,
					fail: { 0: "checkout total is wrong" },
				});
				await s.call("report", old, ci);
				// A typed result keeps this commit in its own scope when CI later names the PR.
				await s.call("report", {
					target: { commit: "scope002", repo: "acme/web" },
					results: [{ test: { case: "C-1" }, outcome: "pass" }],
				});
				await s.call("report", ciReport({ commit: "scope002", pr: 7, branch: "feature", n: 1 }), ci);
				expect(await s.call<GateStatus>("gate", { change: "pr:7" })).toMatchObject({ run: "R-2", verdict: "passed" });
				const blocked = { run: "R-1", verdict: "blocked", open: ["Q-2"], tally: { unexplained: 1 } };
				expect(await s.call<GateStatus>("gate", { commit: "scope001" })).toMatchObject(blocked);

				await s.call("report", ciReport({ commit: "scope001", pr: 7, branch: "feature", n: 1, attempt: 2 }), agent);
				expect(await s.call<GateStatus>("gate", { commit: "scope001" })).toMatchObject(blocked);
				expect((await s.call<{ state: string }[]>("get", { refs: ["Q-2"] }))[0]?.state).toBe("open");
				expect((await s.call<InboxReply>("inbox", { kind: "failure" })).items.map((item) => item.q)).toEqual(["Q-2"]);
			} finally {
				await s.close();
			}
		},
	);

	test.each([false, true])(
		"a discarded head passing preserves the reset head's failure, defect answer=%s",
		async (answered) => {
			const ci = await h.actor("pipeline", "ci", ["read", "record"]);
			const at = (commit: string, attempt = 1, failing = true) =>
				ciReport({
					commit,
					pr: 12,
					branch: "feature",
					n: 1,
					attempt,
					...(failing ? { fail: { 0: "checkout total is wrong" } } : {}),
				});
			const old = at("old00001");
			await h.call("report", old, ci);
			const asked = first((await queue()).items);
			if (answered) expect((await decide(asked, { is: "defect" }))?.status).toBe("decided");
			await h.call("report", at("new00002"), ci);
			await h.call(
				"report",
				{ ...old, target: { ...old.target, head: "old00001" }, buildUrl: "https://ci.example/reset" },
				ci,
			);
			const current = { run: "R-1", verdict: answered ? "failed" : "blocked", open: answered ? [] : ["Q-1"] };
			expect(await h.call<GateStatus>("gate", { change: "pr:12" })).toMatchObject(current);

			await h.call("report", at("new00002", 2, false), ci);
			expect(await h.call<GateStatus>("gate", { change: "pr:12" })).toMatchObject(current);
			expect(await state(asked.q)).toBe(answered ? "decided" : "open");
			const inbox = await h.call<InboxReply>("inbox", { kind: "failure" });
			expect(inbox.counts.open).toBe(answered ? 0 : 1);
			expect(inbox.items.map((item) => item.q)).toEqual(answered ? [] : ["Q-1"]);
			expect(await gate("new00002")).toMatchObject({ run: "R-2", verdict: "passed" });

			await h.call("report", at("old00001", 2, false), ci);
			expect(await h.call<GateStatus>("gate", { change: "pr:12" })).toMatchObject({
				run: "R-1",
				verdict: "passed",
				open: [],
			});
			expect(await state(asked.q)).toBe("dissolved");
			if (answered) expect((await ledger(asked.q)).map((entry) => entry.is)).toEqual(["defect", "outdated"]);
		},
	);

	test.each([false, true])(
		"a discarded head passing supplies no proof for an unreported head, defect answer=%s",
		async (answered) => {
			const failed = ciReport({
				commit: "old00001",
				pr: 12,
				branch: "feature",
				n: 1,
				fail: { 0: "checkout total is wrong" },
			});
			await h.call("report", failed);
			const asked = first((await queue()).items);
			if (answered) expect((await decide(asked, { is: "defect" }))?.status).toBe("decided");
			await h.call("report", {
				...failed,
				target: { ...failed.target, head: "unseen003" },
				buildUrl: "https://ci.example/unseen",
			});
			await h.call("report", ciReport({ commit: "old00001", pr: 12, branch: "feature", n: 1, attempt: 2 }));
			expect(await h.call<GateStatus>("gate", { change: "pr:12" })).toMatchObject({
				run: null,
				verdict: "pending",
				open: [],
			});
			expect(await state(asked.q)).toBe(answered ? "decided" : "open");
			expect(await gate("old00001")).toMatchObject({ run: "R-1", verdict: "passed" });
		},
	);

	test("passing many independent causes preserves each ending and its evidence across slices", async () => {
		await ciPolicy(async (op, input) => await h.call(op, input), "scratch");
		const n = 203;
		await h.call(
			"report",
			ciReport({
				commit: "manyfix1",
				n,
				fail: Object.fromEntries(Array.from({ length: n }, (_, i) => [i, `different cause ${i}`])),
			}),
		);
		const decisions = () =>
			h.app.database.read(
				async (db) =>
					await db.all(
						sql<
							readonly [],
							{
								id: number;
								question: number;
								basis: string;
								on_evidence: string;
								answer: string;
								holds: string;
								supersedes: number | null;
								effects: string;
								state: string;
								signers: string;
								expires_at: number | null;
							}
						>(
							`SELECT d.*, q.state FROM questions q JOIN decisions d ON d.id = q.decision
				 WHERE q.kind = 'failure' ORDER BY q.id`,
						),
					),
			);
		const before = await decisions();
		const priorLedgerSize = await count("decisions");
		expect(before).toHaveLength(n);
		expect(await count("excuses")).toBe(n);
		await h.call("report", ciReport({ commit: "manyfix2", n }));
		const after = await decisions();
		expect(after).toHaveLength(n);
		for (const [i, row] of after.entries()) {
			const prior = before[i];
			expect(prior).toBeDefined();
			expect(row).toMatchObject({
				question: prior?.question,
				basis: prior?.basis,
				on_evidence: prior?.on_evidence,
				supersedes: prior?.id,
				state: "dissolved",
				expires_at: null,
				holds: "[]",
				effects: "{}",
			});
			expect(JSON.parse(row.answer)).toEqual({ is: "outdated", fixed: true });
			expect(JSON.parse(row.signers)).toMatchObject([
				{
					clause: "passed",
					policy: 2,
					reason: "Every test it named passed on manyfix2 where it had failed; the answer ended.",
				},
			]);
		}
		expect(await count("excuses")).toBe(0);
		expect(await count("result_excuses")).toBe(0);
		expect(await count("decisions")).toBe(priorLedgerSize + n);
		expect(await gate("manyfix1")).toMatchObject({ verdict: "blocked", open: [] });
		expect(await gate("manyfix2")).toMatchObject({ verdict: "passed", open: [] });
	});

	test("an answer that needs a fix ends when a later commit of the pull request passes, and a new failure is asked", async () => {
		const fail = { 0: "expected 90, got 100" };
		await h.call("report", ciReport({ commit: "fixed01a", branch: "fix", pr: 41, n: 3, fail }));
		const asked = first((await queue()).items);
		await decide(asked, { is: "test" });
		expect((await gate("fixed01a")).verdict).toBe("failed");
		await h.call("report", ciReport({ commit: "fixed01b", branch: "fix", pr: 41, n: 3 }));
		expect((await gate("fixed01b")).verdict).toBe("passed");
		expect(await state(asked.q)).toBe("dissolved");
		const ended = {
			q: asked.q,
			state: "dissolved",
			decision: {
				answer: { is: "outdated" },
				by: ["policy"],
				rule: "passed",
				reason: "Every test it named passed on fixed01b where it had failed; the answer ended.",
				fixedIn: { change: "pr:41", state: "open" },
				supersedes: { answer: { is: "test" }, by: ["robin"], reason: null },
			},
		};
		expect(await h.call("get", { refs: [asked.q] })).toMatchObject([ended]);
		expect((await h.call<InboxReply>("inbox", { state: "decided", kind: "failure", limit: 1 })).items).toMatchObject([
			ended,
		]);
		expect((await h.call<InboxReply>("inbox", { state: "decided", on: "pr:41" })).items).toMatchObject([ended]);
		const chunks: string[] = [];
		await h.app.database.read(async (db) => await exportArchive(db, (chunk) => chunks.push(chunk)));
		const restoredFixture = await testDatabase();
		const restored = await Database.open({ url: restoredFixture.url });
		try {
			await restored.write(
				async (db) => await db.transaction(async () => await importArchive(db, linesOf(chunks.join("")))),
			);
			await restored.read(async (db) => {
				const question = await mustQuestion(db, 1, asked.q);
				expect(await toItem(db, question)).toMatchObject(ended);
			});
		} finally {
			await restored.close();
			await restoredFixture.close();
		}
		expect(await ledger(asked.q)).toEqual([
			{ is: "test", clause: expect.any(String), reason: null },
			{
				is: "outdated",
				clause: "passed",
				reason: "Every test it named passed on fixed01b where it had failed; the answer ended.",
			},
		]);
		// Like any answer that ended, it no longer explains the older commit, and nobody is asked about that one.
		expect(await gate("fixed01a")).toMatchObject({ verdict: "blocked", open: [] });
		expect((await queue()).items).toEqual([]);
		// The ending says which pull request fixed the failure, and that it merged once it has.
		await h.call("change", { change: "pr:41", state: "merged" });
		expect((await h.call<InboxReply>("inbox", { state: "decided", on: "pr:41" })).items).toMatchObject([
			{ q: asked.q, decision: { fixedIn: { change: "pr:41", state: "merged" } } },
		]);
		await h.call("change", { change: "pr:41", state: "open" });
		const again = await h.call<ReportReceipt>(
			"report",
			ciReport({ commit: "fixed01c", branch: "fix", pr: 41, n: 3, fail }),
		);
		expect(again.questions[0]).toMatchObject({ how: "new", state: "open" });
		expect(again.gate?.verdict).toBe("blocked");
		expect(first((await queue()).items).q).not.toBe(asked.q);
	});

	test("a retry claims no fix; another commit of the change does, whenever it was reported, and keeps it", async () => {
		const fail = { 0: "expected 90, got 100" };
		const settled = async (change: string) =>
			(await h.call<InboxReply>("inbox", { state: "decided", on: change })).items;
		// The same commit passing when it runs again is a retry: it proves no fix.
		await h.call("report", ciReport({ commit: "retry042a", branch: "retry", pr: 42, n: 1, fail }));
		await decide(first((await queue()).items), { is: "defect" });
		await h.call("report", ciReport({ commit: "retry042a", branch: "retry", pr: 42, n: 1, attempt: 2 }));
		expect(await settled("pr:42")).toMatchObject([{ state: "dissolved", decision: { rule: "passed" } }]);
		expect((await settled("pr:42"))[0]?.decision).not.toHaveProperty("fixedIn");
		// Another commit of the change passing is a fix by the change, even reported after the merge: the merge named
		// it as the head. Nothing later (reopening, merging again, an archive without how changes ended) undoes it.
		await h.call("report", ciReport({ commit: "late043a", branch: "late", pr: 43, n: 1, fail }));
		await decide(first((await queue()).items), { is: "defect" });
		await h.call("change", { change: "pr:43", state: "merged", head: "late043b" });
		h.advance(60_000);
		await h.call("report", ciReport({ commit: "late043b", branch: "late", pr: 43, n: 1 }));
		const fixed = (state: string) => [{ state: "dissolved", decision: { fixedIn: { change: "pr:43", state } } }];
		expect(await settled("pr:43")).toMatchObject(fixed("merged"));
		await h.call("change", { change: "pr:43", state: "open" });
		expect(await settled("pr:43")).toMatchObject(fixed("open"));
		await h.call("change", { change: "pr:43", state: "closed" });
		expect(await settled("pr:43")).toMatchObject(fixed("closed"));
		const chunks: string[] = [];
		await h.app.database.read(async (db) => await exportArchive(db, (chunk) => chunks.push(chunk)));
		const restoredFixture = await testDatabase();
		const restored = await Database.open({ url: restoredFixture.url });
		try {
			await restored.write(
				async (db) => await db.transaction(async () => await importArchive(db, linesOf(chunks.join("")))),
			);
			const question = (await settled("pr:43"))[0];
			if (!question) throw new Error("expected the ended answer");
			expect(await restored.read(async (db) => await toItem(db, await mustQuestion(db, 1, question.q)))).toMatchObject(
				fixed("open")[0] ?? {},
			);
		} finally {
			await restored.close();
			await restoredFixture.close();
		}
		// A reset back to an older commit that passes is another commit too: the change no longer has the failure.
		await h.call("report", ciReport({ commit: "older044a", branch: "reset", pr: 44, n: 1 }));
		await h.call("report", ciReport({ commit: "newer044b", branch: "reset", pr: 44, n: 1, fail }));
		await decide(first((await queue()).items), { is: "defect" });
		const reset = ciReport({ commit: "older044a", branch: "reset", pr: 44, n: 1, attempt: 2 });
		await h.call("report", { ...reset, target: { ...reset.target, head: "older044a" } });
		expect(await settled("pr:44")).toMatchObject([{ decision: { fixedIn: { change: "pr:44", state: "open" } } }]);
		// One commit spelled two ways, abbreviated or in another case, is the same commit: its pass is a retry.
		for (const [pr, failed, passed] of [
			[45, "abcdef0123456789abcdef0123456789abcdef01", "abcdef0"],
			[46, "ABCDEF0123456789", "abcdef0123456789"],
		] as const) {
			await h.call("report", ciReport({ commit: failed, branch: `spelt${pr}`, pr, n: 1, fail }));
			await decide(first((await queue()).items), { is: "defect" });
			await h.call("report", ciReport({ commit: passed, branch: `spelt${pr}`, pr, n: 1 }));
			expect(await settled(`pr:${pr}`)).toMatchObject([{ state: "dissolved", decision: { rule: "passed" } }]);
			expect((await settled(`pr:${pr}`))[0]?.decision).not.toHaveProperty("fixedIn");
		}
	});

	test("an expired flaky answer stays in Settled when its failure has gone, without claiming a pass ended it", async () => {
		await h.call(
			"report",
			ciReport({ commit: "expired408a", branch: "fix", pr: 408, n: 1, fail: { 0: "expected 90, got 100" } }),
		);
		const asked = first((await queue()).items);
		await decide(asked, { is: "flaky" });
		await h.call("report", ciReport({ commit: "expired408b", branch: "fix", pr: 408, n: 1 }));
		h.advance(15 * 86_400_000);
		const rule = await h.app.database.read(async (db) => await ruleActor(db));
		expect(await sweep(h.app, rule.id)).toBe(1);
		const ended = {
			q: asked.q,
			state: "dissolved",
			decision: {
				answer: { is: "expired" },
				by: ["policy"],
				rule: "hold-expired",
				reason: null,
				supersedes: { answer: { is: "flaky" }, by: ["robin"], reason: null },
			},
		};
		expect(await h.call("get", { refs: [asked.q] })).toMatchObject([ended]);
		expect((await h.call<InboxReply>("inbox", { state: "decided", kind: "failure" })).items).toMatchObject([ended]);
		// A hold that ran out says nothing about a fix, though the pull request passes.
		expect(
			(await h.call<InboxReply>("inbox", { state: "decided", kind: "failure" })).items[0]?.decision,
		).not.toHaveProperty("fixedIn");
		expect((await queue()).counts.open).toBe(0);
		expect((await gate("expired408b")).verdict).toBe("passed");
	});

	test("Settled paginates decided and ended answers together, leaving out unanswered dissolved questions", async () => {
		const report = async (commit: string, pr: number, fail: Record<number, string> = {}) =>
			await h.call("report", ciReport({ commit, branch: "fix", pr, n: 1, fail }));
		await report("page408a", 408, { 0: "expected 90, got 100" });
		const ended = first((await queue()).items);
		await decide(ended, { is: "test" });
		await report("page408b", 408);
		await report("page409a", 409, { 0: "expected 90, got 100" });
		const standing = first((await queue()).items);
		await decide(standing, { is: "flaky" });
		await report("page410a", 410, { 0: "expected 90, got 100" });
		const unanswered = first((await queue()).items);
		await report("page410b", 410);
		expect(await h.call("get", { refs: [unanswered.q] })).toMatchObject([{ state: "dissolved", decision: null }]);
		for (const kind of [undefined, "failure"] as const) {
			const firstPage = await h.call<InboxReply>("inbox", { state: "decided", kind, limit: 1 });
			expect(firstPage.items).toMatchObject([
				{ q: standing.q, state: "decided", decision: { answer: { is: "flaky" } } },
			]);
			expect(firstPage.cursor).not.toBeNull();
			const nextPage = await h.call<InboxReply>("inbox", {
				state: "decided",
				kind,
				limit: 1,
				cursor: firstPage.cursor,
			});
			expect(nextPage.items).toMatchObject([
				{
					q: ended.q,
					state: "dissolved",
					decision: { answer: { is: "outdated" }, supersedes: { answer: { is: "test" } } },
				},
			]);
			if (kind === "failure") expect(nextPage.cursor).toBeNull();
			else {
				const lastPage = await h.call<InboxReply>("inbox", { state: "decided", limit: 1, cursor: nextPage.cursor });
				expect(lastPage.items).toMatchObject([
					{ kind: "map", state: "decided", decision: { answer: { is: "track" } } },
				]);
				expect(lastPage.cursor).toBeNull();
			}
		}
	});

	test("on the line too: a defect answer ends when the line passes, and the regression is asked", async () => {
		const fail = { 1: "checkout total is wrong" };
		await h.call("report", ciReport({ commit: "line001a", n: 3, fail }));
		const asked = first((await queue()).items);
		await decide(asked, { is: "defect" });
		// While the line keeps failing the answer carries, so nobody is asked on every commit.
		const still = await h.call<ReportReceipt>("report", ciReport({ commit: "line001b", n: 3, fail }));
		expect(still.questions[0]).toMatchObject({ how: "already decided", q: asked.q });
		expect(still.gate?.verdict).toBe("failed");
		await h.call("report", ciReport({ commit: "line001c", n: 3 }));
		expect(await state(asked.q)).toBe("dissolved");
		const again = await h.call<ReportReceipt>("report", ciReport({ commit: "line001d", n: 3, fail }));
		expect(again.questions[0]).toMatchObject({ how: "new", state: "open" });
	});

	test("a flaky answer does not end on a pass: a flaky test passes", async () => {
		const fail = { 0: "timed out after 5000 ms" };
		await h.call("report", ciReport({ commit: "flaky01a", branch: "fix", pr: 42, n: 3, fail }));
		const asked = first((await queue()).items);
		await decide(asked, { is: "flaky" });
		await h.call("report", ciReport({ commit: "flaky01b", branch: "fix", pr: 42, n: 3 }));
		expect(await state(asked.q)).toBe("decided");
		const again = await h.call<ReportReceipt>(
			"report",
			ciReport({ commit: "flaky01c", branch: "fix", pr: 42, n: 3, fail }),
		);
		expect(again.questions[0]).toMatchObject({ how: "already decided", q: asked.q });
		expect(again.gate?.verdict).toBe("passed");
	});

	test("a pass from one job does not end the answer while another job that failed has not reported", async () => {
		const fail = { 0: "connection reset by fixture" };
		const unit = (commit: string, failing: boolean) =>
			ciReport({
				commit,
				branch: "fix",
				pr: 43,
				n: 2,
				job: "unit",
				file: "tests/unit.spec.ts",
				...(failing ? { fail } : {}),
			});
		const e2e = (commit: string, failing: boolean) =>
			ciReport({ commit, branch: "fix", pr: 43, n: 2, job: "e2e", ...(failing ? { fail } : {}) });
		await h.call("report", e2e("shard01a", true));
		await h.call("report", unit("shard01a", true));
		const asked = first((await queue()).items);
		await decide(asked, { is: "defect" });
		await h.call("report", e2e("shard01b", false));
		expect(await state(asked.q)).toBe("decided");
		// The other job still fails with the cause on the same commit: the answer carries, nobody is asked again.
		const late = await h.call<ReportReceipt>("report", unit("shard01b", true));
		expect(late.questions[0]).toMatchObject({ how: "already decided", q: asked.q });
		expect((await gate("shard01b")).verdict).toBe("failed");
		await h.call("report", e2e("shard01c", false));
		await h.call("report", unit("shard01c", false));
		expect(await state(asked.q)).toBe("dissolved");
	});

	test("a passing retry of the failing commit ends the answer, and a later failure is asked again", async () => {
		const fail = { 0: "expected 4 items, got 3" };
		const at = (commit: string, attempt: number, failing: boolean) =>
			ciReport({ commit, branch: "retry", pr: 45, n: 2, job: "checks", attempt, ...(failing ? { fail } : {}) });
		await h.call("report", at("retry01a", 1, true));
		const asked = first((await queue()).items);
		await decide(asked, { is: "test" });
		await h.call("report", at("retry01a", 2, false));
		expect(await state(asked.q)).toBe("dissolved");
		const again = await h.call<ReportReceipt>("report", at("retry01c", 1, true));
		expect(again.questions[0]).toMatchObject({ how: "new", state: "open" });
	});

	test("a job that failed and then passed on a retry still has to pass on the next commit", async () => {
		const fail = { 0: "the order total is wrong" };
		const unit = (commit: string, attempt: number, failing: boolean) =>
			ciReport({
				commit,
				branch: "fix",
				pr: 46,
				n: 2,
				job: "unit",
				file: "tests/unit.spec.ts",
				attempt,
				...(failing ? { fail } : {}),
			});
		const e2e = (commit: string, attempt: number, failing: boolean) =>
			ciReport({ commit, branch: "fix", pr: 46, n: 2, job: "e2e", attempt, ...(failing ? { fail } : {}) });
		await h.call("report", unit("retry02a", 1, true));
		await h.call("report", e2e("retry02a", 1, true));
		const asked = first((await queue()).items);
		await decide(asked, { is: "defect" });
		await h.call("report", e2e("retry02a", 2, false));
		await h.call("report", unit("retry02b", 1, false));
		// e2e failed on the first commit and has not reported on this one: its test has not passed, so the answer holds.
		expect(await state(asked.q)).toBe("decided");
		await h.call("report", e2e("retry02b", 1, false));
		expect(await state(asked.q)).toBe("dissolved");
	});

	test("a test that failed in two environments must pass in both, whatever they are called", async () => {
		const fail = { 0: "a specific checkout assertion" };
		const report = (commit: string, env: string, failing: boolean) => {
			const input = ciReport({ commit, branch: "fix", pr: 47, n: 1, ...(failing ? { fail } : {}) });
			return { ...input, target: { ...input.target, env } };
		};
		await h.call("report", report("lanes01a", "linux|chrome", true));
		await h.call("report", report("lanes01a", "linux", true));
		const asked = first((await queue()).items);
		await decide(asked, { is: "test" });
		await h.call("report", report("lanes01b", "linux|chrome", false));
		expect(await state(asked.q)).toBe("decided");
		await h.call("report", report("lanes01b", "linux", false));
		expect(await state(asked.q)).toBe("dissolved");
	});

	test("a test that moved to another shard ends the answer where it passes", async () => {
		const fail = { 0: "expected the receipt, got none" };
		await h.call("report", ciReport({ commit: "shard02a", branch: "fix", pr: 48, n: 2, job: "shard-2", fail }));
		const asked = first((await queue()).items);
		await decide(asked, { is: "defect" });
		// The shards were balanced again: the same test now runs in another job.
		await h.call("report", ciReport({ commit: "shard02b", branch: "fix", pr: 48, n: 2, job: "shard-3" }));
		expect(await state(asked.q)).toBe("dissolved");
	});

	test("every environment the question saw before the answer must pass, in whatever order they reported", async () => {
		const fail = { 0: "the receipt shows the wrong tax" };
		const report = (commit: string, env: string, failing: boolean) => {
			const input = ciReport({ commit, branch: "fix", pr: 49, n: 1, ...(failing ? { fail } : {}) });
			return { ...input, target: { ...input.target, env } };
		};
		await h.call("report", report("order01a", "early", true));
		await h.call("report", report("order01a", "late", true));
		const asked = first((await queue()).items);
		await decide(asked, { is: "defect" });
		await h.call("report", report("order01b", "late", false));
		expect(await state(asked.q)).toBe("decided");
		await h.call("report", report("order01b", "early", false));
		expect(await state(asked.q)).toBe("dissolved");
	});

	for (const classification of ["defect", "test", "expected"]) {
		test(`a carried ${classification} must wait for every failing test to pass`, async () => {
			const report = (commit: string, only: number[], fail: Record<number, string>, job = "tests") =>
				h.call("report", ciReport({ commit, pr: 400, branch: "feature", n: 2, only, fail, job }));
			await report("head0001", [0], { 0: "same cause" });
			const asked = first((await queue()).items);
			expect(await decide(asked, { is: classification })).toMatchObject({ status: "decided" });
			await report("head0002", [0, 1], { 0: "same cause", 1: "same cause" });
			expect(await gate("head0002")).toMatchObject({ verdict: "failed" });
			await report("head0003", [0], {});
			expect(await h.call("get", { refs: [asked.q] })).toMatchObject([
				{ decision: { answer: { is: classification } } },
			]);
			expect(await gate("head0002")).toMatchObject({ verdict: "failed" });
			expect(await decide(asked, { is: classification })).toMatchObject({ status: "already" });
			await report("head0003", [1], {}, "late");
			expect(await h.call("get", { refs: [asked.q] })).toMatchObject([
				{ state: "dissolved", decision: { answer: { is: "outdated", fixed: true }, rule: "passed" } },
			]);
		});
	}

	for (const classification of ["defect", "test", "expected"]) {
		test(`a changed carried ${classification} answer requires the extended evidence`, async () => {
			const report = (commit: string, only: number[]) =>
				h.call(
					"report",
					ciReport({ commit, pr: 401, branch: "feature", n: 2, only, fail: { 0: "same cause", 1: "same cause" } }),
				);
			await report("carry001", [0]);
			const asked = first((await queue()).items);
			expect(await decide(asked, { is: classification })).toMatchObject({ status: "decided" });
			await report("carry002", [0, 1]);
			expect(await decide(asked, { is: classification })).toMatchObject({ status: "already" });
			const refused = first(
				await h.call<DecideReply[]>("decide", {
					q: asked.q,
					onEvidence: asked.evidenceHash,
					answer: { is: "flaky" },
				}),
			);
			expect(refused.status).toBe("conflict");
			const current = first(await h.call<{ evidenceHash: string }[]>("get", { refs: [asked.q] }));
			expect(current.evidenceHash).not.toBe(asked.evidenceHash);
			expect(refused.evidence).toBe(current.evidenceHash);
			expect(await decide({ q: asked.q, evidenceHash: "unseen" }, { is: classification })).toMatchObject({
				status: "conflict",
			});
			expect(await decide({ q: asked.q, ...current }, { is: classification })).toMatchObject({ status: "already" });
			expect(await decide({ q: asked.q, ...current }, { is: "flaky" })).toMatchObject({ status: "decided" });
		});
	}

	test("a carried cause beyond fifty listed tests keeps its answer even after every listed test passes", async () => {
		const firstTests = Array.from({ length: 50 }, (_, i) => i);
		const report = (commit: string, only: number[], failing: boolean) =>
			h.call(
				"report",
				ciReport({
					commit,
					pr: 401,
					branch: "feature",
					n: 52,
					only,
					fail: failing ? Object.fromEntries(only.map((i) => [i, "same cause"])) : {},
				}),
			);
		await report("limit001", firstTests, true);
		const asked = first((await queue()).items);
		await decide(asked, { is: "defect" });
		await report("limit002", [50], true);
		const before = first(await h.call<{ evidenceHash: string }[]>("get", { refs: [asked.q] }));
		await report("limit003", [51], true);
		expect(await decide({ q: asked.q, ...before }, { is: "flaky" })).toMatchObject({ status: "conflict" });
		expect(await decide(asked, { is: "defect" })).toMatchObject({ status: "already" });
		await report("limit004", [...firstTests, 50], false);
		expect(await h.call("get", { refs: [asked.q] })).toMatchObject([
			{ state: "decided", evidence: { count: 51 }, decision: { answer: { is: "defect" } } },
		]);
	});

	test("every test the question saw before the answer must pass, in whatever order they reported", async () => {
		const fail = { 0: "the basket is empty after sign-in" };
		const report = (commit: string, file: string, failing: boolean) =>
			ciReport({ commit, branch: "fix", pr: 50, n: 1, job: file, file, ...(failing ? { fail } : {}) });
		await h.call("report", report("order02a", "tests/first.spec.ts", true));
		await h.call("report", report("order02a", "tests/last.spec.ts", true));
		const asked = first((await queue()).items);
		await decide(asked, { is: "test" });
		await h.call("report", report("order02b", "tests/last.spec.ts", false));
		expect(await state(asked.q)).toBe("decided");
		await h.call("report", report("order02b", "tests/first.spec.ts", false));
		expect(await state(asked.q)).toBe("dissolved");
	});

	test("an agent's later report of the cause does not keep the answer once the pipeline passes", async () => {
		const fail = { 0: "the coupon is applied twice" };
		await h.call("report", ciReport({ commit: "agent01a", branch: "fix", pr: 51, n: 1, fail }));
		const agent = await h.actor("explorer", "agent", ["read", "produce"]);
		await h.call("report", ciReport({ commit: "agent01a", branch: "fix", pr: 51, n: 1, job: "explore", fail }), agent);
		const asked = first((await queue()).items.filter((item) => item.kind === "failure"));
		await decide(asked, { is: "defect" });
		await h.call("report", ciReport({ commit: "agent01b", branch: "fix", pr: 51, n: 1 }));
		expect(await state(asked.q)).toBe("dissolved");
	});

	test("a question asked again on a retried commit waits for every environment its cause failed in", async () => {
		const fail = { 0: "the voucher is rejected" };
		const report = (commit: string, env: string, attempt: number, failing: boolean) => {
			const input = ciReport({ commit, branch: "fix", pr: 52, n: 1, attempt, ...(failing ? { fail } : {}) });
			return { ...input, target: { ...input.target, env } };
		};
		await h.call("report", report("epoch01a", "new", 1, true));
		await h.call("report", report("epoch01a", "old", 1, true));
		const asked = first((await queue()).items);
		await decide(asked, { is: "defect" });
		await h.call("report", report("epoch01a", "new", 2, false));
		await h.call("report", report("epoch01a", "old", 2, false));
		expect(await state(asked.q)).toBe("dissolved");
		// The cause comes back on a retry of the same commit, in one environment: a new question about it.
		await h.call("report", report("epoch01a", "new", 3, true));
		const again = first((await queue()).items);
		expect(again.q).not.toBe(asked.q);
		await decide(again, { is: "defect" });
		await h.call("report", report("epoch01b", "new", 1, false));
		// The cause failed in `old` in this scope too, and `old` has not reported on this commit.
		expect(await state(again.q)).toBe("decided");
		await h.call("report", report("epoch01b", "old", 1, false));
		expect(await state(again.q)).toBe("dissolved");
	});

	test("a change closed and opened again asks about its failures, and that answer ends when they pass", async () => {
		const fail = { 0: "the coupon expired a day early", 1: "the coupon expired a day early" };
		await h.call("report", ciReport({ commit: "reopen1a", branch: "fix", pr: 53, n: 2, fail }));
		const asked = first((await queue()).items);
		await h.call("change", { change: "pr:53", state: "closed" });
		expect(await state(asked.q)).toBe("dissolved");
		await h.call("change", { change: "pr:53", state: "open" });
		const again = first((await queue()).items);
		expect(again.q).not.toBe(asked.q);
		await decide(again, { is: "defect" });
		// Only test 1 reports on the next commit: test 0 failed too, so the answer holds.
		await h.call("report", ciReport({ commit: "reopen1b", branch: "fix", pr: 53, n: 2, only: [1] }));
		expect(await state(again.q)).toBe("decided");
		await h.call("report", ciReport({ commit: "reopen1c", branch: "fix", pr: 53, n: 2 }));
		expect(await state(again.q)).toBe("dissolved");
		const recurred = await h.call<ReportReceipt>(
			"report",
			ciReport({ commit: "reopen1d", branch: "fix", pr: 53, n: 2, fail }),
		);
		expect(recurred.questions[0]).toMatchObject({ how: "new", state: "open" });
	});

	test("a planned run over failures in two environments waits for each where it failed, and no other", async () => {
		const message = "the order total is wrong";
		const report = async (commit: string, env: string, i: number, failing: boolean, attempt = 1) => {
			const input = ciReport({
				commit,
				branch: "fix",
				pr: 54,
				n: 2,
				only: [i],
				attempt,
				fail: failing ? { [i]: message } : {},
			});
			return h.call("report", {
				...input,
				target: { ...input.target, env },
				results: input.results.map((result) => ({ ...result, annotation: { case: `C-${i + 1}`, version: 1 } })),
			});
		};
		await h.call("propose", {
			edits: [
				{ op: "create", outline: "First checkout" },
				{ op: "create", outline: "Second checkout" },
			],
		});
		await report("planp01a", "A", 0, true);
		await report("planp01a", "B", 1, true);
		await decide(first((await queue()).items), { is: "defect" });
		await report("planp01b", "A", 0, false);
		await report("planp01b", "B", 1, false);
		await h.call("plan", { name: "Old evidence", select: {}, accepts: { commit: "planp01a" } });
		const asked = first(
			(await queue()).items.filter((item) => item.kind === "failure" && !item.answers.includes("mistaken")),
		);
		await decide(asked, { is: "defect" });
		await report("planp01a", "A", 0, false, 2);
		await report("planp01a", "B", 1, false, 2);
		await report("planp01b", "A", 0, false, 2);
		await report("planp01b", "B", 1, false, 2);
		// Test 0 never ran in B: nothing waits for it there.
		expect(await state(asked.q)).toBe("dissolved");
	});

	test("a commit that moves into a pull request takes all of its failures along", async () => {
		const message = "the order total is wrong";
		const report = async (commit: string, env: string, only: number[], failing: boolean, pr?: number) => {
			const input = ciReport({
				commit,
				n: 2,
				only,
				...(pr ? { pr, branch: "feature" } : {}),
				fail: failing ? { 0: message, 1: message } : {},
			});
			return h.call("report", { ...input, target: { ...input.target, env, ...(pr ? {} : { branch: undefined }) } });
		};
		await report("movep01a", "A", [0], true);
		await report("movep01a", "B", [1], true);
		// A report that says the commit belongs to pull request 77 moves it, and its failures, into that scope.
		await report("movep01a", "A", [0], false, 77);
		const asked = first((await queue()).items.filter((item) => item.evidence.scope === "pr:77"));
		await decide(asked, { is: "defect" });
		await report("movep01b", "B", [1], false, 77);
		expect(await state(asked.q)).toBe("decided");
		await report("movep01b", "A", [0], false, 77);
		expect(await state(asked.q)).toBe("dissolved");
	});

	test("a pass of other tests does not end the answer: the tests it named must pass", async () => {
		const fail = { 0: "expected 3 rows, got 2" };
		await h.call("report", ciReport({ commit: "named01a", branch: "fix", pr: 44, n: 2, fail }));
		const asked = first((await queue()).items);
		await decide(asked, { is: "test" });
		// The fix renamed the file: none of the tests the answer named ran.
		await h.call("report", ciReport({ commit: "named01b", branch: "fix", pr: 44, n: 2, file: "tests/rows.spec.ts" }));
		expect(await state(asked.q)).toBe("decided");
	});

	test("an infrastructure excuse covers the commit it was given for and no other", async () => {
		const fail = { 0: "connect ECONNREFUSED 10.0.0.5:5432" };
		await h.call("report", ciReport({ commit: "2222222a", n: 3, fail }));
		await decide(first((await queue()).items), { is: "infra" });
		const next = await h.call<ReportReceipt>("report", ciReport({ commit: "2222222b", n: 3, fail }));
		expect(next.questions[0]).toMatchObject({ how: "new" });
		expect(next.gate?.verdict).toBe("blocked");
	});
});

describe("a commit reported in shards", () => {
	const shard = (commit: string, index: number, only: number[], fail: Record<number, string> = {}, pr = 60) =>
		ciReport({ commit, branch: "fix", pr, n: 6, job: "tests", shard: { index, of: 3 }, only, fail });
	const state = async (q: string) => (await h.call<{ state: string }[]>("get", { refs: [q] }))[0]?.state;

	test("its gate waits for every shard of the job, and passes when the last one does", async () => {
		await h.call("report", shard("shard10a", 1, [0, 1]));
		expect(await gate("shard10a")).toMatchObject({
			verdict: "pending",
			reason: "pending: waiting for shards 2 and 3 of 3 of job tests",
			waiting: [{ job: "tests", env: "", missing: [2, 3], of: 3 }],
		});
		await h.call("report", shard("shard10a", 3, [4, 5]));
		expect((await gate("shard10a")).reason).toBe("pending: waiting for shard 2 of 3 of job tests");
		await h.call("report", shard("shard10a", 2, [2, 3]));
		const done = await gate("shard10a");
		expect(done.verdict).toBe("passed");
		expect(done.waiting).toBeUndefined();
	});

	test("a commit's run, its change and the change's landing say which shards they wait for beside the reason", async () => {
		const waiting = [{ job: "tests", env: "", missing: [2, 3], of: 3 }];
		await h.call("report", shard("shard15a", 1, [0, 1], {}, 61));
		const change = async () =>
			(
				await h.call<{ items: { key: string; waiting?: unknown; landing: { waiting?: unknown } | null }[] }>("find", {
					in: "changes",
				})
			).items.find((item) => item.key === "pr:61");
		expect(await change()).toMatchObject({ waiting, landing: null });
		const run = (
			await h.call<{ ref: string; waiting?: unknown }[]>("get", { refs: [(await gate("shard15a")).run ?? ""] })
		)[0];
		expect(run?.waiting).toEqual(waiting);
		await h.call("change", { change: "pr:61", state: "merged", landing: { commit: "shard15b", branch: "main" } });
		await h.call(
			"report",
			ciReport({ commit: "shard15b", n: 6, job: "tests", shard: { index: 3, of: 3 }, only: [4, 5] }),
		);
		expect((await change())?.landing?.waiting).toEqual([{ job: "tests", env: "", missing: [1, 2], of: 3 }]);
		for (const index of [2, 3])
			await h.call("report", shard("shard15a", index, [index * 2 - 2, index * 2 - 1], {}, 61));
		expect((await change())?.waiting).toBeUndefined();
	});

	test("a failure in a shard that reported shows at once", async () => {
		await h.call("report", shard("shard11a", 2, [2, 3], { 2: "expected 3, got 4" }));
		expect((await gate("shard11a")).verdict).toBe("blocked");
	});

	test("a shard that says the job has another number of shards is refused", async () => {
		await h.call("report", shard("shard12a", 1, [0, 1]));
		const other = { ...shard("shard12a", 2, [2, 3]), shard: { index: 2, of: 4 } };
		expect(await h.raw("report", other)).toMatchObject({ ok: false, error: { code: "invalid" } });
	});

	test("a shard is about a commit, not a planned run", async () => {
		const input = { run: "R-1", job: "tests", shard: { index: 1, of: 2 }, results: shard("x", 1, [0]).results };
		expect(await h.raw("report", input)).toMatchObject({ ok: false, error: { code: "invalid" } });
	});

	test("an answer that needs a fix waits for the whole commit before it ends", async () => {
		await h.call("report", shard("shard13a", 1, [0, 1], { 0: "the total is off by one" }));
		await h.call("report", shard("shard13a", 2, [2, 3]));
		await h.call("report", shard("shard13a", 3, [4, 5]));
		const asked = first((await queue()).items);
		await decide(asked, { is: "defect" });
		// The shards were balanced again: test 0 passes in shard 3, while shards 1 and 2 have not reported.
		await h.call("report", shard("shard13b", 3, [0, 5]));
		expect(await state(asked.q)).toBe("decided");
		// A test of the cause that never failed before fails in a later shard: the answer covers it, nobody is asked.
		const late = await h.call<ReportReceipt>("report", shard("shard13b", 1, [1, 2], { 1: "the total is off by one" }));
		expect(late.questions[0]).toMatchObject({ how: "already decided", q: asked.q });
		expect((await gate("shard13b")).verdict).toBe("failed");
		await h.call("report", shard("shard13b", 2, [3, 4]));
		expect(await state(asked.q)).toBe("decided");
		// The next commit passes in every shard.
		await h.call("report", shard("shard13c", 1, [0, 1]));
		await h.call("report", shard("shard13c", 2, [2, 3]));
		expect(await state(asked.q)).toBe("decided");
		await h.call("report", shard("shard13c", 3, [4, 5]));
		expect(await state(asked.q)).toBe("dissolved");
	});

	test("an open failure question waits for the whole commit before it closes", async () => {
		await h.call("report", shard("shard14a", 1, [0, 1], { 0: "the button is missing" }));
		const asked = first((await queue()).items);
		await h.call("report", shard("shard14b", 1, [0, 1]));
		expect(await state(asked.q)).toBe("open");
		await h.call("report", shard("shard14b", 2, [2, 3]));
		await h.call("report", shard("shard14b", 3, [4, 5]));
		expect(await state(asked.q)).toBe("dissolved");
	});

	test("a planned run that clears does not close the question while the newest commit waits for a shard", async () => {
		await h.call("propose", { edits: [{ op: "create", outline: "Checkout total" }] });
		const report = async (commit: string, outcome: "pass" | "fail", attempt = 1) => {
			const input = shard(commit, 1, [0], outcome === "fail" ? { 0: "the total is off by one" } : {}, 88);
			return h.call("report", {
				...input,
				attempt,
				results: input.results.map((result) => ({ ...result, annotation: { case: "C-1", version: 1 } })),
			});
		};
		await report("planwait1", "fail");
		await h.call("plan", { name: "Release", select: {}, accepts: { commit: "planwait1" } });
		const asked = first((await queue()).items.filter((item) => item.kind === "failure"));
		await report("planwait2", "pass");
		expect(await state(asked.q)).toBe("open");
		// A passing retry on the older commit clears the planned run, but the newest commit still waits for shards.
		await report("planwait1", "pass", 2);
		expect(await state(asked.q)).toBe("open");
	});

	test("a shard that is accepted and not yet applied keeps the answer until it is", async () => {
		const inTx = async <T>(fn: (ctx: ReturnType<typeof makeCtx<WriteDb>>) => T): Promise<T> =>
			await h.app.database.write(
				async (db) =>
					await db.transaction(async () => {
						const project = await findProject(db, "scratch");
						if (!project) throw new Error("no project");
						const ctx = makeCtx(h.app, db, project, h.owner, true);
						const out = await fn(ctx);
						await stampSeq(ctx);
						return out;
					}),
			);
		const cause = "the receipt total is off by one";
		const two = (commit: string, index: number, only: number[], fail: Record<number, string> = {}) => ({
			...ciReport({ commit, branch: "fix", pr: 89, n: 6, job: "tests", only, fail }),
			shard: { index, of: 2 },
		});
		await h.call("report", two("unapp01a", 1, [0, 1, 2], { 0: cause }));
		await h.call("report", two("unapp01a", 2, [3, 4, 5]));
		const asked = first((await queue()).items);
		await decide(asked, { is: "defect" });
		// Shard 2 of the next commit is accepted, holding a new test that fails with the cause, and is not applied yet.
		const late = (await inTx(async (ctx) => await acceptReport(ctx, two("unapp01b", 2, [3, 4, 5], { 3: cause }))))
			.batch;
		await h.call("report", two("unapp01b", 1, [0, 1, 2]));
		expect(await state(asked.q)).toBe("decided");
		const applied = await inTx(async (ctx) => await processBatch(ctx, late.id));
		expect(applied.questions[0]).toMatchObject({ how: "already decided", q: asked.q });
	});

	test("a shard's retry counts as that shard", async () => {
		await h.call("report", shard("shard15a", 1, [0, 1]));
		await h.call("report", shard("shard15a", 2, [2, 3], { 2: "timed out" }));
		await h.call("report", { ...shard("shard15a", 2, [2, 3]), attempt: 2 });
		await h.call("report", shard("shard15a", 3, [4, 5]));
		expect((await gate("shard15a")).verdict).toBe("passed");
	});
});

describe("who may answer", () => {
	test("loose: an agent advises on a failure and a person decides", async () => {
		const agent = await h.actor("triage-bot", "agent", ["read", "produce"]);
		await h.call("report", ciReport({ commit: "3333333a", n: 3, fail: { 0: "expected 1, got 2" } }));
		const q = first((await queue()).items);
		const advised = await decide(q, { is: "defect" }, agent);
		expect(advised).toMatchObject({ status: "advised", needs: "one member who is not an agent" });
		expect((await gate("3333333a")).verdict).toBe("blocked");
		const shown = first((await queue()).items);
		expect(shown.advice).toEqual([{ by: "triage-bot", kind: "agent", answer: { is: "defect" }, reason: null }]);
		expect((await decide(shown, { is: "defect" }))?.status).toBe("decided");
	});

	test("a pipeline cannot answer, and a reader cannot answer", async () => {
		const ci = await h.actor("github-actions", "ci", ["read", "record"]);
		const reader = await h.actor("pm", "human", ["read"]);
		await h.call("report", ciReport({ commit: "3333333b", n: 3, fail: { 0: "expected 1, got 2" } }), ci);
		const q = first((await queue()).items);
		// Neither may call `decide` at all: a pipeline records, a reader reads.
		for (const actor of [ci, reader]) {
			const refused = await h.raw("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "flaky" } }, actor);
			expect(refused).toMatchObject({ ok: false, error: { code: "forbidden" } });
		}
	});

	test("an answer the kind does not have is invalid and says which are allowed", async () => {
		await h.call("report", ciReport({ commit: "3333333c", n: 3, fail: { 0: "expected 1, got 2" } }));
		const reply = await decide(first((await queue()).items), { is: "accept" });
		expect(reply?.status).toBe("invalid");
		expect(reply?.needs).toContain("defect");
	});
});

describe("basis", () => {
	test("E3: a linked test is assumed at the current version; an annotation with a version is exact; neither is guessed", async () => {
		await h.call("propose", { edits: [{ op: "create", outline: "Coupon applies\n  Apply SAVE10 > Total is 90" }] });
		const s = await harness({ preset: "standard", unlinked: "ask" });
		await s.call("propose", { edits: [{ op: "create", outline: "Coupon applies\n  Apply SAVE10 > Total is 90" }] });
		await s.call("report", ciReport({ commit: "4444444a", n: 2 }));
		const map = first((await s.call<InboxReply>("inbox", { kind: "map" })).items);
		const tests = (map.evidence as { tests: { t: string }[] }).tests;
		expect(tests).toHaveLength(2);
		const linked = await s.call<{ status: string }[]>("decide", {
			q: map.q,
			onEvidence: map.evidenceHash,
			answer: { is: "link", pairs: [[first(tests).t, "C-1"]] },
		});
		expect(linked[0]?.status).toBe("decided");
		const next = await s.call<ReportReceipt>("report", ciReport({ commit: "4444444b", n: 2 }));
		expect(next.basis).toEqual({ exact: 0, assumed: 1, unresolved: 1 });
		const annotated = await s.call<ReportReceipt>("report", {
			target: { commit: "4444444c", branch: "main" },
			results: [{ test: { key: "tests/x.spec.ts::coupon @C-1@v1", name: "coupon @C-1@v1" }, outcome: "pass" }],
		});
		expect(annotated.basis).toEqual({ exact: 1, assumed: 0, unresolved: 0 });
		const wrong = await s.call<ReportReceipt>("report", {
			target: { commit: "4444444d", branch: "main" },
			results: [{ test: { key: "tests/x.spec.ts::coupon @C-1@v9", name: "coupon @C-1@v9" }, outcome: "pass" }],
		});
		// An automated result is a fact about the commit whatever it claims about a case: the claim is refused, the
		// outcome is kept with no case, and the reason comes back.
		expect(wrong.rejected).toEqual([]);
		expect(wrong.declined).toEqual([{ index: 0, reason: "C-1 has no version 9: recorded with no case" }]);
		expect(wrong.basis).toEqual({ exact: 0, assumed: 0, unresolved: 1 });
		await s.close();
	});
});

describe("the horizon", () => {
	test("C5: accepting an upload turns a green gate pending until it is applied; a stale green is never served", async () => {
		await h.call("report", ciReport({ commit: "5555555a", n: 5 }));
		expect((await gate("5555555a")).verdict).toBe("passed");

		const inTx = async <T>(fn: (ctx: ReturnType<typeof makeCtx<WriteDb>>) => T): Promise<T> =>
			await h.app.database.write(
				async (db) =>
					await db.transaction(async () => {
						const project = await findProject(db, "scratch");
						if (!project) throw new Error("no project");
						const ctx = makeCtx(h.app, db, project, h.owner, true);
						const out = await fn(ctx);
						await stampSeq(ctx);
						return out;
					}),
			);
		const { batch } = await inTx(
			async (ctx) =>
				await acceptReport(ctx, ciReport({ commit: "5555555a", n: 5, fail: { 1: "expected 1, got 2" }, attempt: 2 })),
		);
		const between = await gate("5555555a");
		expect(between).toMatchObject({
			verdict: "pending",
			stale: true,
			reason: "pending: 1 report accepted and not yet applied",
		});

		await inTx(async (ctx) => await processBatch(ctx, batch.id));
		expect(await gate("5555555a")).toMatchObject({ verdict: "blocked", stale: false });
	});
});

describe("work the server does on its own", () => {
	// The recovery step on its own. `test/restart.test.ts` kills a real server in the middle of a report.
	test("a report that was accepted and never applied is applied by recovery, once; the gate was pending meanwhile", async () => {
		await h.call("report", ciReport({ commit: "6666666a", n: 4 }));
		await h.app.database.write(
			async (db) =>
				await db.transaction(async () => {
					const project = await findProject(db, "scratch");
					if (!project) throw new Error("no project");
					const ctx = makeCtx(h.app, db, project, h.owner, true);
					await acceptReport(ctx, ciReport({ commit: "6666666a", n: 4, fail: { 0: "expected 1, got 2" }, attempt: 2 }));
					await stampSeq(ctx);
				}),
		);
		// ...the process dies here. Nothing is lost: the batch is staged, and the gate does not claim green.
		expect((await gate("6666666a")).verdict).toBe("pending");
		expect(await recoverAccepted(h.app)).toBe(1);
		expect(
			await h.app.database.read((db) =>
				db.allDynamic("SELECT op FROM change_events WHERE project=1 AND seq=(SELECT seq FROM projects WHERE id=1)"),
			),
		).toEqual([{ op: "report" }]);
		expect(await gate("6666666a")).toMatchObject({ verdict: "blocked", stale: false });
		expect(await recoverAccepted(h.app)).toBe(0);
	});

	// Issue #123. The server read the id of the policy's actor once, when it started, and an import replaces the
	// actors. In an archive from an instance whose first actor is a person, `policy` has that person's id plus one.
	test("the minute job acts as the policy after an import gave the policy's actor another id", async () => {
		let now = 1_800_000_000_000;
		const directories: string[] = [];
		const databases: TestDatabase[] = [];
		const instances: Instance[] = [];
		const configFor = async (): Promise<Config> => {
			const database = await testDatabase();
			databases.push(database);
			const directory = await mkdtemp(join(tmpdir(), "mainworthy-minute-"));
			directories.push(directory);
			return defaultConfig({
				MAINWORTHY_DATA: directory,
				MAINWORTHY_DATABASE_URL: database.url,
				MAINWORTHY_PORT: "0",
				MAINWORTHY_OWNER: "robin",
				MAINWORTHY_MODE: "local",
			});
		};
		const boot = async (config: Config): Promise<Instance> => {
			const instance = await start(config, (app, owner) => ({ ui: null, routes: archiveRoutes(app, owner) }), {
				now: () => now,
			});
			instances.push(instance);
			return instance;
		};
		const actors = async (instance: Instance) =>
			await instance.app.database.read(
				async (db) => await db.all(sql<[], { id: number; name: string }>("SELECT id, name FROM actors ORDER BY id")),
			);
		const client = (instance: Instance) => new Client({ url: instance.url, token: undefined, project: "scratch" });
		const asked = z.object({
			counts: z.object({ open: z.number() }),
			items: z.array(z.object({ q: z.string(), evidenceHash: z.string() })),
		});
		try {
			const from = await configFor();
			const seed = await openApp(from);
			await seed.database.write(
				async (db) =>
					await db.transaction(async () => {
						await db.run(sql("INSERT INTO orgs (name, created_at) VALUES ('default', 0)"));
						await db.run(sql("INSERT INTO actors (org, kind, name, created_at) VALUES (1, 'human', 'robin', 0)"));
					}),
			);
			await seed.close();
			const source = await boot(from);
			const target = await boot(await configFor());
			expect(await actors(source)).toEqual([
				{ id: 1, name: "robin" },
				{ id: 2, name: "policy" },
			]);
			expect(await actors(target)).toEqual([
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
			expect(await actors(target)).toEqual(await actors(source));
			expect(asked.parse(await client(target).call("inbox", {})).counts.open).toBe(0);

			const published: { op: string; actor: string }[] = [];
			target.app.subscribe((event) => published.push({ op: event.op, actor: event.actor }));
			now += 15 * 86_400_000;
			await target.minute();
			expect(asked.parse(await client(target).call("inbox", {})).counts.open).toBe(1);
			// What every open page is told about the change names the policy, not the person who now has the id the
			// policy had when the server started. The row that records that the excuse ran out is the policy's too.
			expect(published).toEqual([{ op: "sweep", actor: "policy" }]);
			const ranOut = await target.app.database.read(
				async (db) =>
					await db.get(
						sql<[], { answer: string; signers: string }>(
							"SELECT answer, signers FROM decisions WHERE kind = 'failure' ORDER BY id DESC LIMIT 1",
						),
					),
			);
			expect(ranOut).toEqual({
				answer: '{"is":"expired"}',
				signers: '[{"by":2,"clause":"hold-expired","policy":1,"reason":null}]',
			});
		} finally {
			for (const instance of instances) await instance.stop();
			for (const database of databases) await database.close();
			for (const directory of directories) await rm(directory, { recursive: true, force: true });
		}
	});

	test("the sweep reopens a question whose excuse ran out, so it is visible before the next report", async () => {
		await h.call("report", ciReport({ commit: "7777777a", n: 3, fail: { 0: "expected 1, got 2" } }));
		await decide(first((await queue()).items), { is: "flaky" });
		expect((await queue()).counts.open).toBe(0);
		const rule =
			(
				await h.app.database.read(
					async (db) => await db.get(sql<[], { id: number }>("SELECT id FROM actors WHERE kind = 'rule'")),
				)
			)?.id ?? 0;
		expect(await sweep(h.app, rule)).toBe(0); // still holds
		h.advance(15 * 86_400_000);
		expect(await sweep(h.app, rule)).toBe(1);
		expect(
			await h.app.database.read((db) =>
				db.allDynamic("SELECT op FROM change_events WHERE project=1 AND seq=(SELECT seq FROM projects WHERE id=1)"),
			),
		).toEqual([{ op: "sweep" }]);
		expect((await queue()).counts.open).toBe(1);
		expect(await gate("7777777a")).toMatchObject({ verdict: "blocked", stale: false });
		// The expired decision stays in the ledger, followed by the row that records that it ran out.
		expect(await count("decisions WHERE kind = 'failure'")).toBe(2);
		expect(await count("excuses")).toBe(0);
	});
});

describe("what a failure question says leaving it costs", () => {
	// The sentence under a question's title (`stakes`) is held to what the server does with the same question.
	const said = (item: InboxReply["items"][number]) =>
		stakes({ kind: item.kind, blocks: item.blocks, facts: new Set(item.evidence.facts as string[]) });
	const held = "While this is open, no gate that counts the unexplained failure passes.";

	test("while a failure question is open, no gate that counts the failure passes, whether or not it names a run", async () => {
		await h.call("report", ciReport({ commit: "stakes001", n: 1, fail: { 0: "expected 90, got 100" } }));
		await h.call("report", ciReport({ commit: "stakes002", branch: "fix", pr: 7, n: 1, fail: { 0: "timed out" } }));
		const [change, trunk] = (await queue()).items;
		if (!change || !trunk) throw new Error("two failure questions expected");
		expect(said(change)).toBe(`Listed as blocking ${change.blocks.join(", ")}. ${held}`);
		expect((await gate("stakes002")).verdict).toBe("blocked");
		// A failure on the line names no run under `loose`, and its commit's gate does not pass all the same.
		expect(trunk.blocks).toEqual([]);
		expect(said(trunk)).toBe(held);
		expect((await gate("stakes001")).verdict).toBe("blocked");
		// Beside a failure a person called a defect, the gate reads failed: still not passed.
		await h.call("report", {
			...ciReport({ commit: "stakes001", n: 1, fail: { 0: "another cause entirely" }, file: "tests/other.spec.ts" }),
			job: "other",
		});
		const other = first((await queue()).items.filter((item) => item.title.includes("another cause")));
		await decide(other, { is: "defect" });
		expect((await gate("stakes001")).verdict).not.toBe("passed");
	});

	test("the sentence is true of a failure no gate counts: an agent's, on a commit whose gate passes", async () => {
		const agent = await h.actor("runner", "agent", ["read", "produce"]);
		await h.call("report", ciReport({ commit: "stakes003", n: 1, file: "tests/passes.spec.ts" }));
		await h.call(
			"report",
			ciReport({ commit: "stakes003", n: 1, file: "tests/agent.spec.ts", fail: { 0: "agent saw it" } }),
			agent,
		);
		expect(said(first((await queue()).items))).toBe(held);
		expect(await gate("stakes003")).toMatchObject({ verdict: "passed", open: [] });
	});

	test("a listed run can pass again while the question stays open for a newer commit: it is listed, not said to be blocked", async () => {
		// The same test fails in job `one` on two commits of a pull request, and the older commit's job is run again.
		for (const commit of ["stakes005", "stakes006"])
			await h.call("report", {
				...ciReport({ commit, branch: "fix", pr: 9, n: 1, fail: { 0: "timed out" } }),
				job: "one",
			});
		await h.call("report", {
			...ciReport({ commit: "stakes005", branch: "fix", pr: 9, n: 1 }),
			job: "one",
			attempt: 2,
		});
		const asked = first((await queue()).items);
		expect((await gate("stakes005")).verdict).toBe("passed");
		expect((await gate("stakes006")).verdict).toBe("blocked");
		expect(said(asked)).toStartWith("Listed as blocking ");
		expect(said(asked)).toEndWith(held);
	});

	test("a failing result stops counting when it is replaced, and not when a pass is reported beside it", async () => {
		// The guide's account of how a block ends without an answer, which the sentence leaves to it.
		await h.call("propose", { edits: [{ op: "create", outline: "Coupon applies\n  Apply SAVE10 > Total is 90" }] });
		const run = (await h.call<{ run: string }>("plan", { name: "Release check", select: { cases: ["C-1"] } })).run;
		const failed = await h.call<ReportReceipt>("report", {
			run,
			results: [{ test: { case: "C-1" }, outcome: "fail", failure: { message: "expected 90, got 100" } }],
		});
		await h.call("report", { run, results: [{ test: { case: "C-1" }, outcome: "pass" }] });
		expect((await h.call<GateStatus>("gate", { run })).verdict).toBe("blocked");
		// A result that corrects it replaces it, whatever its outcome: skipped, the run waits for a result again.
		await h.call("report", { run, results: [{ test: { case: "C-1" }, outcome: "skip", corrects: failed.results[0] }] });
		expect((await h.call<GateStatus>("gate", { run })).verdict).not.toBe("blocked");
		// On a commit: a newer attempt of another job does not replace it, nor does a newer attempt of the same
		// job in which the test was skipped. A newer attempt of the same job that passes does.
		await h.call("report", { ...ciReport({ commit: "stakes004", n: 1, fail: { 0: "timed out" } }), job: "one" });
		await h.call("report", { ...ciReport({ commit: "stakes004", n: 1 }), job: "two", attempt: 2 });
		expect((await gate("stakes004")).verdict).toBe("blocked");
		const again = ciReport({ commit: "stakes004", n: 1 });
		await h.call("report", {
			...again,
			job: "one",
			attempt: 2,
			results: again.results.map((result) => ({ test: result.test, outcome: "skip" })),
		});
		expect((await gate("stakes004")).verdict).toBe("blocked");
		await h.call("report", { ...again, job: "one", attempt: 3 });
		expect((await gate("stakes004")).verdict).toBe("passed");
	});
});

describe("a question that gains occurrences while open", () => {
	test("keeps its policy facts and its latest target, so the answer lands under the right clause and hold", async () => {
		const fail = { 0: "connect ECONNREFUSED 10.0.0.5:5432" };
		await h.call("report", ciReport({ commit: "8888888a", branch: "feature", pr: 9, n: 3, fail }));
		await h.call("report", ciReport({ commit: "8888888b", branch: "feature", pr: 9, n: 3, fail })); // attaches to the open question
		const q = first((await queue()).items);
		expect(q.seen.count).toBe(2);
		expect(q.blocks).toHaveLength(2); // both pushes' runs wait on it
		expect((q.evidence as { facts: string[] }).facts).toContain("scope:change");
		await decide(q, { is: "infra" });
		expect((await gate("8888888b")).verdict).toBe("passed");
		const signer = await h.app.database.read(
			async (db) => await db.get(sql<[], { signers: string }>("SELECT signers FROM decisions WHERE kind = 'failure'")),
		);
		expect(JSON.parse(signer?.signers ?? "[]")[0].clause).toBe("failure-change");
		// infrastructure is excused for the build it was given on (the latest), so the next push asks again
		const next = await h.call<ReportReceipt>(
			"report",
			ciReport({ commit: "8888888c", branch: "feature", pr: 9, n: 3, fail }),
		);
		expect(next.questions[0]).toMatchObject({ how: "new" });
	});
});

describe("which answers apply", () => {
	test("a trunk failure cannot be called inherited or mistaken; a change's failure can be inherited", async () => {
		await h.call("report", ciReport({ commit: "9999999a", n: 2, fail: { 0: "expected 1, got 2" } }));
		const trunk = first((await queue()).items);
		expect(trunk.answers).toEqual(["defect", "test", "expected", "flaky", "infra"]);
		expect(await decide(trunk, { is: "inherited" })).toMatchObject({ status: "invalid" });
		expect((await decide(trunk, { is: "mistaken" }))?.needs).toContain("does not apply");
		await h.call(
			"report",
			ciReport({ commit: "9999999b", branch: "feature", pr: 12, n: 2, fail: { 1: "expected 3, got 4" } }),
		);
		const change = (await queue()).items.find((item) => item.about.includes("pr:12"));
		expect(change?.answers).toEqual(["defect", "test", "expected", "flaky", "infra", "inherited"]);
	});
});

describe("a change that ends", () => {
	test("a fast-forward landing moves every environment into trunk without carrying pull request answers", async () => {
		const commit = "landed001";
		const report = ciReport({ commit, branch: "feature", pr: 68, n: 1, fail: { 0: "same cause" } });
		await h.call("report", { ...report, target: { ...report.target, env: "one" } });
		await h.call("report", { ...report, target: { ...report.target, env: "two" } });
		const asked = first((await queue()).items);
		await decide(asked, { is: "flaky" });
		const before = await gate(commit);
		expect(before.verdict).toBe("passed");
		const decisions = await h.app.database.read(
			async (db) => await db.all(sql<[], Record<string, unknown>>("SELECT * FROM decisions")),
		);
		await h.call("change", { change: "pr:68", state: "merged", landing: { commit, branch: "main" } });
		expect(
			await h.app.database.read(
				async (db) =>
					await db.all(sql<[], Record<string, unknown>>("SELECT DISTINCT line, branch, change FROM targets")),
			),
		).toEqual([{ line: "trunk", branch: "main", change: null }]);
		expect(await gate(commit)).toMatchObject({
			run: before.run,
			verdict: "blocked",
			tally: { unexplained: 2, excused: 0 },
		});
		expect(first((await queue()).items).evidence.scope).toBe("line:trunk@acme/web");
		expect(
			await h.app.database.read(
				async (db) => await db.all(sql<[], Record<string, unknown>>("SELECT * FROM decisions")),
			),
		).toEqual(decisions);
		expect(
			await h.app.database.read(
				async (db) =>
					await db.all(sql<[], Record<string, unknown>>("SELECT before_scope, after_scope, actor FROM scope_moves")),
			),
		).toEqual([{ before_scope: "change:1", after_scope: "line:trunk@acme/web", actor: h.owner.id }]);
		expect(
			await h.call("change", { change: "pr:68", state: "merged", landing: { commit, branch: "main" } }),
		).toMatchObject({
			already: true,
		});
		expect(await count("scope_moves")).toBe(1);
		expect((await h.call<InboxReply>("inbox", { state: "decided" })).items.map((q) => q.q)).toContain(asked.q);
		await decide(first((await queue()).items), { is: "defect" });
		expect(await h.call<GateStatus>("gate", { change: "pr:68" })).toMatchObject({ run: before.run, verdict: "failed" });
		await h.call("report", {
			...report,
			attempt: 2,
			target: { ...report.target, branch: "main", pr: undefined, env: "three" },
		});
		expect(await gate(commit)).toMatchObject({
			run: before.run,
			verdict: "failed",
			tally: { attributed: 3, excused: 0 },
		});
		expect(await count("runs")).toBe(1);
	});

	test.each([true, false])("a merged change ignores code host head observations, landing=%s", async (landing) => {
		const old = ciReport({ commit: "landold01", branch: "feature", pr: 68, n: 1 });
		const landed = ciReport({ commit: "landnew01", branch: "feature", pr: 68, n: 1, fail: { 0: "defect" } });
		await h.call("report", old);
		await h.call("report", landed);
		await h.call("change", {
			change: "pr:68",
			state: "merged",
			...(landing ? { landing: { commit: "landnew01", branch: "main" } } : {}),
		});
		const trunkGate = await gate("landnew01");
		expect(trunkGate.verdict).toBe("blocked");
		expect((await queue()).items.map((q) => q.evidence.scope)).toEqual(landing ? ["line:trunk@acme/web"] : []);

		const reset = { ...landed, job: "head-after-landing", target: { ...landed.target, head: "landold01" } };
		expect((await h.call<ReportReceipt>("report", reset)).fresh).toBe(true);
		expect(await h.call<GateStatus>("gate", { change: "pr:68" })).toMatchObject({
			run: trunkGate.run,
			verdict: "blocked",
		});
		expect(
			await h.app.database.read(
				async (db) =>
					await db.get(sql<[], Record<string, unknown>>("SELECT head_sha FROM changes WHERE key = 'pr:68'")),
			),
		).toEqual({
			head_sha: "landnew01",
		});
		expect(
			await h.app.database.read(
				async (db) => await db.all(sql<[], Record<string, unknown>>("SELECT ended FROM change_ends")),
			),
		).toEqual([{ ended: "merged" }]);
		await h.call("report", { ...landed, job: "late-after-reset", target: { ...landed.target, env: "two" } });
		expect((await h.call<GateStatus>("gate", { change: "pr:68" })).run).toBe(trunkGate.run);
		expect(
			await h.app.database.read(
				async (db) =>
					await db.all(
						sql<[], Record<string, unknown>>("SELECT line, branch, change FROM targets WHERE commit_sha = 'landnew01'"),
					),
			),
		).toEqual([
			{ line: landing ? "trunk" : "change", branch: landing ? "main" : "feature", change: landing ? null : 1 },
			{ line: landing ? "trunk" : "change", branch: landing ? "main" : "feature", change: landing ? null : 1 },
		]);
		expect(await gate("landnew01")).toMatchObject({
			run: trunkGate.run,
			verdict: "blocked",
			tally: { unexplained: 3 },
		});
		expect((await queue()).items.map((q) => q.evidence.scope)).toEqual(landing ? ["line:trunk@acme/web"] : []);
		expect(await count("scope_moves")).toBe(landing ? 1 : 0);
		await h.call("report", { ...landed, job: "head-forward", target: { ...landed.target, head: "unseen01" } });
		expect((await h.call<ReportReceipt>("report", reset)).fresh).toBe(false);
		expect(await h.call<GateStatus>("gate", { change: "pr:68" })).toMatchObject({
			run: trunkGate.run,
			verdict: "blocked",
		});
	});

	test.each([undefined, "linux"])(
		"a fast-forward of a head no report has named waits for its failing CI, env=%s",
		async (env) => {
			await h.call("report", ciReport({ commit: "headX0001", branch: "feature", pr: 12, n: 1 }));
			const merge = {
				change: "pr:12",
				state: "merged",
				head: "headY0001",
				landing: { commit: "headY0001", branch: "main" },
			};
			await h.call("change", merge);
			expect(await h.call<GateStatus>("gate", { change: "pr:12" })).toMatchObject({ verdict: "pending", run: null });
			expect(await changes()).toMatchObject([{ key: "pr:12", head: "headY0001", state: "merged", verdict: "pending" }]);
			expect(await h.call("change", merge)).toMatchObject({ already: true });
			const report = ciReport({
				commit: "headY0001",
				branch: "feature",
				pr: 12,
				n: 1,
				fail: { 0: "final push fails" },
			});
			await h.call("report", { ...report, target: { ...report.target, env } });
			const failed = await gate("headY0001");
			expect(failed.verdict).toBe("blocked");
			expect(await h.call<GateStatus>("gate", { change: "pr:12" })).toMatchObject({
				run: failed.run,
				verdict: "blocked",
			});
			const asked = first((await queue()).items);
			expect(asked.evidence.scope).toBe("line:trunk@acme/web");
			expect(await h.call("change", merge)).toMatchObject({ already: true });
			expect((await queue()).items.map((q) => q.q)).toEqual([asked.q]);
			await h.call("report", { ...report, target: { ...report.target, env: "mac", head: "headX0001" } });
			expect(
				await h.app.database.read(
					async (db) =>
						await db.all(
							sql<[], Record<string, unknown>>(
								"SELECT DISTINCT line, branch, change FROM targets WHERE commit_sha = 'headY0001'",
							),
						),
				),
			).toEqual([{ line: "trunk", branch: "main", change: null }]);
			expect(await h.call<GateStatus>("gate", { change: "pr:12" })).toMatchObject({
				run: failed.run,
				verdict: "blocked",
			});
			expect((await queue()).items.map((q) => q.evidence.scope)).toEqual(["line:trunk@acme/web"]);
		},
	);

	test("the merge's head can be older than the recorded head", async () => {
		await h.call(
			"report",
			ciReport({ commit: "older0012", branch: "feature", pr: 12, n: 1, fail: { 0: "older failure" } }),
		);
		await h.call("report", ciReport({ commit: "newer0012", branch: "feature", pr: 12, n: 1 }));
		expect((await h.call<GateStatus>("gate", { change: "pr:12" })).verdict).toBe("passed");
		await h.call("change", {
			change: "pr:12",
			state: "merged",
			head: "older0012",
			landing: { commit: "older0012", branch: "main" },
		});
		expect(await changes()).toMatchObject([{ key: "pr:12", head: "older0012", state: "merged", verdict: "blocked" }]);
		expect(await h.call<GateStatus>("gate", { change: "pr:12" })).toMatchObject({
			run: (await gate("older0012")).run,
			verdict: "blocked",
		});
		expect((await queue()).items.map((q) => q.evidence.scope)).toEqual(["line:trunk@acme/web"]);
		await h.call("report", { ...ciReport({ commit: "newer0012", branch: "feature", pr: 12, n: 1 }), attempt: 2 });
		expect(await h.call<GateStatus>("gate", { change: "pr:12" })).toMatchObject({
			run: (await gate("older0012")).run,
			verdict: "blocked",
		});
	});

	test("a merge with another hash leaves the original commit's scope and decisions alone", async () => {
		await h.call(
			"report",
			ciReport({ commit: "landed002", branch: "feature", pr: 68, n: 1, fail: { 0: "same cause" } }),
		);
		await decide(first((await queue()).items), { is: "flaky" });
		await h.call("change", { change: "pr:68", state: "merged", landing: { commit: "merge0002", branch: "main" } });
		expect((await gate("landed002")).verdict).toBe("passed");
		expect(
			await h.app.database.read(
				async (db) =>
					await db.all(
						sql<[], Record<string, unknown>>("SELECT DISTINCT line FROM targets WHERE commit_sha = 'landed002'"),
					),
			),
		).toEqual([{ line: "change" }]);
		expect(await changes()).toMatchObject([
			{
				key: "pr:68",
				head: "landed002",
				state: "merged",
				verdict: "passed",
				landing: { commit: "merge0002", branch: "main", run: null, verdict: "pending" },
			},
		]);
		expect(await h.call<GateStatus>("gate", { change: "pr:68" })).toMatchObject({
			run: (await gate("landed002")).run,
			verdict: "passed",
		});
	});

	test("a rebased landing keeps the pull request's gate, and the landed commit's gate is its own", async () => {
		await h.call("report", ciReport({ commit: "prhead077", branch: "feature", pr: 77, n: 2 }));
		await h.call("change", {
			change: "pr:77",
			state: "merged",
			head: "prhead077",
			landing: { commit: "rebase077", branch: "main" },
		});
		const landed = { commit: "rebase077", branch: "main", run: null, verdict: "pending" };
		expect(await h.call<GateStatus>("gate", { change: "pr:77" })).toMatchObject({
			run: (await gate("prhead077")).run,
			verdict: "passed",
		});
		expect(await changes()).toMatchObject([
			{ key: "pr:77", head: "prhead077", state: "merged", verdict: "passed", landing: landed },
		]);
		await h.call("report", ciReport({ commit: "rebase077", n: 2, fail: { 1: "broke on main" } }));
		expect((await h.call<GateStatus>("gate", { change: "pr:77" })).verdict).toBe("passed");
		expect(await changes()).toMatchObject([
			{
				head: "prhead077",
				verdict: "passed",
				landing: {
					...landed,
					run: (await gate("rebase077")).run,
					verdict: "blocked",
					reason: "blocked: 1 failure unexplained, 1 question open",
				},
			},
		]);
		expect((await queue()).items.map((q) => q.evidence.scope)).toEqual(["line:trunk@acme/web"]);
	});

	test("the merge names the head that merged, even one no report has named yet", async () => {
		await h.call("report", ciReport({ commit: "first0078", branch: "feature", pr: 78, n: 1 }));
		await h.call("change", {
			change: "pr:78",
			state: "merged",
			head: "final0078",
			landing: { commit: "rebase078", branch: "main" },
		});
		expect(await changes()).toMatchObject([{ key: "pr:78", head: "final0078", verdict: "pending" }]);
		expect(await h.call<GateStatus>("gate", { change: "pr:78" })).toMatchObject({ run: null, verdict: "pending" });
		await h.call(
			"report",
			ciReport({ commit: "final0078", branch: "feature", pr: 78, n: 1, fail: { 0: "late failure" } }),
		);
		expect(await h.call<GateStatus>("gate", { change: "pr:78" })).toMatchObject({
			run: (await gate("final0078")).run,
			verdict: "blocked",
		});
		// An ended change is not asked about (decision 0022): the failure is there to read, not to answer.
		expect((await queue()).items).toEqual([]);
	});

	test("a landing's gate is read in the change's repository, even when that is none", async () => {
		const { repo: _repo, ...target } = ciReport({ commit: "head0079", branch: "feature", pr: 79, n: 1 }).target;
		await h.call("report", { ...ciReport({ commit: "head0079", branch: "feature", pr: 79, n: 1 }), target });
		await h.call("change", {
			change: "pr:79",
			state: "merged",
			head: "head0079",
			landing: { commit: "land0079", branch: "main" },
		});
		// Another repository reports the same hash: it is not this landing, and does not make it ambiguous.
		await h.call("report", {
			...ciReport({ commit: "land0079", n: 1, fail: { 0: "other repo" } }),
			target: { repo: "acme/other", commit: "land0079", branch: "main" },
		});
		expect(await changes()).toMatchObject([
			{
				key: "pr:79",
				head: "head0079",
				verdict: "passed",
				landing: { commit: "land0079", run: null, verdict: "pending" },
			},
		]);
		expect(
			(await h.call<{ change: { landing: unknown } }>("impact", { change: "pr:79" })).change.landing,
		).toMatchObject({
			commit: "land0079",
			verdict: "pending",
		});
	});

	test("a head the code host names on an open change is asked about, and the old head's question leaves", async () => {
		await h.call(
			"report",
			ciReport({ commit: "first080", branch: "feature", pr: 80, n: 1, fail: { 0: "first fails" } }),
		);
		const asked = first((await queue()).items);
		await h.call("report", ciReport({ commit: "second80", branch: "feature", pr: 80, n: 1 }));
		expect((await queue()).items).toEqual([]);
		const moved = await h.call<{ questions: string[]; already: boolean }>("change", {
			change: "pr:80",
			state: "open",
			head: "first080",
		});
		const again = first((await queue()).items);
		expect(moved).toMatchObject({ questions: [again.q], already: false });
		expect(again).toMatchObject({ kind: "failure", state: "open", title: asked.title });
		expect(await h.call<GateStatus>("gate", { change: "pr:80" })).toMatchObject({
			verdict: "blocked",
			open: [again.q],
		});
		expect(await h.call("change", { change: "pr:80", state: "open", head: "first080" })).toMatchObject({
			already: true,
		});
		await h.call("change", { change: "pr:80", state: "open", head: "second80" });
		expect((await queue()).items).toEqual([]);
		expect((await h.call<GateStatus>("gate", { change: "pr:80" })).verdict).toBe("passed");
	});

	test("a landing received after the end still moves its commit to trunk, and reopening does not move it back", async () => {
		await h.call(
			"report",
			ciReport({ commit: "landed003", branch: "feature", pr: 68, n: 1, fail: { 0: "same cause" } }),
		);
		await h.call("change", { change: "pr:68", state: "merged" });
		await h.call("change", { change: "pr:68", state: "merged", landing: { commit: "landed003", branch: "main" } });
		expect(first((await queue()).items).evidence.scope).toBe("line:trunk@acme/web");
		await h.call("change", { change: "pr:68", state: "open" });
		expect((await queue()).items.map((q) => q.evidence.scope)).toEqual(["line:trunk@acme/web"]);
	});

	test("a commit first reported by hash gains its branch scope and keeps one exact gate", async () => {
		const report = ciReport({ commit: "placed068", branch: "feature", n: 1, fail: { 0: "same cause" } });
		await h.call("report", { ...report, target: { commit: report.target.commit, repo: report.target.repo } });
		await decide(first((await queue()).items), { is: "flaky" });
		const before = await gate("placed068");
		await h.call("report", report);
		expect(await gate("placed068")).toMatchObject({ run: before.run, verdict: "blocked" });
		expect(first((await queue()).items).about).toContain("branch:feature");
		expect(await count("runs")).toBe(1);
	});

	test("a typed failure keeps its open question when CI later names the commit's branch", async () => {
		await h.call("propose", { edits: [{ op: "create", outline: "Checkout works" }] });
		const tester = await h.actor("tester", "human", ["read", "produce"]);
		const ci = await h.actor("ci", "ci", ["read", "record"]);
		const run = await h.call<{ run: string }>("plan", {
			name: "Dispute",
			select: {},
			accepts: { commit: "typed0068" },
		});
		await h.call(
			"report",
			{
				run: run.run,
				results: [{ test: { case: "C-1" }, outcome: "fail", failure: { message: "expected 10, got 12" } }],
			},
			tester,
		);
		const asked = first((await queue()).items.filter((q) => q.kind === "failure"));
		await h.call(
			"report",
			{
				target: { commit: "typed0068", branch: "main" },
				results: [{ test: { key: "checkout" }, outcome: "pass", annotation: { case: "C-1", version: 1 } }],
			},
			ci,
		);
		const questions = (await queue()).items.filter((q) => q.kind === "failure");
		const cause = first(questions.filter((q) => q.q === asked.q));
		const disputed = first(questions.filter((q) => q.title.startsWith(`Disputed C-1 in ${run.run}:`)));
		expect(cause).toMatchObject({ state: "open", evidence: { message: "expected 10, got 12" } });
		expect(cause.evidence.hints).not.toContain("disputed");
		expect(cause.answers).not.toContain("mistaken");
		expect(disputed).toMatchObject({
			state: "open",
			evidence: { hints: ["disputed"], message: "expected 10, got 12" },
		});
		expect(disputed.q).not.toBe(asked.q);
		expect(disputed.answers).toEqual(["defect", "test", "expected", "flaky", "infra", "mistaken"]);
		const status = await h.call<GateStatus>("gate", { run: run.run });
		expect(status.verdict).toBe("blocked");
		expect(status.open.toSorted()).toEqual([asked.q, disputed.q].toSorted());
		expect(await count("scope_moves")).toBe(0);
	});

	test("a typed failure keeps its answer when CI later names the commit's branch", async () => {
		await h.call("propose", { edits: [{ op: "create", outline: "Checkout works" }] });
		const run = await h.call<{ run: string }>("plan", {
			name: "Answered",
			select: {},
			accepts: { commit: "typed0069" },
		});
		await h.call("report", {
			run: run.run,
			results: [{ test: { case: "C-1" }, outcome: "fail", failure: { message: "same cause" } }],
		});
		const asked = first((await queue()).items.filter((q) => q.kind === "failure"));
		expect((await decide(asked, { is: "flaky" }))?.status).toBe("decided");
		const decisions = await h.app.database.read(
			async (db) => await db.all(sql<[], Record<string, unknown>>("SELECT * FROM decisions WHERE kind = 'failure'")),
		);
		await h.call("report", {
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
		expect((await h.call<{ state: string }[]>("get", { refs: [asked.q] }))[0]?.state).toBe("decided");
		expect(
			await h.app.database.read(
				async (db) => await db.all(sql<[], Record<string, unknown>>("SELECT * FROM decisions WHERE kind = 'failure'")),
			),
		).toEqual(decisions);
		expect(await h.call<GateStatus>("gate", { run: run.run })).toMatchObject({
			verdict: "passed",
			tally: { excused: 1 },
		});
		expect((await queue()).items.filter((q) => q.kind === "failure")).toEqual([]);
		expect(await count("scope_moves")).toBe(0);
	});

	test("a landing uses trunk's existing answer while older pull request commits keep their answer", async () => {
		const fail = { 0: "same cause" };
		await h.call("report", ciReport({ commit: "trunk0068", n: 1, fail }));
		await decide(first((await queue()).items), { is: "defect" });
		await h.call("report", ciReport({ commit: "older0068", branch: "feature", pr: 68, n: 1, fail }));
		await decide(first((await queue()).items), { is: "flaky" });
		await h.call("report", ciReport({ commit: "newer0068", branch: "feature", pr: 68, n: 1, fail }));
		expect((await gate("newer0068")).verdict).toBe("passed");
		await h.call("change", { change: "pr:68", state: "merged", landing: { commit: "newer0068", branch: "main" } });
		expect((await gate("newer0068")).verdict).toBe("failed");
		expect((await gate("older0068")).verdict).toBe("passed");
		expect((await queue()).items).toEqual([]);
	});

	test("a landing recomputes a planned run and replaces its old failure question", async () => {
		await h.call("propose", { edits: [{ op: "create", outline: "Checkout works" }] });
		await h.call("report", {
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
		const planned = await h.call<{ run: string }>("plan", {
			name: "Release",
			select: {},
			accepts: { commit: "planned68" },
		});
		const asked = first((await queue()).items);
		await h.call("change", { change: "pr:68", state: "merged", landing: { commit: "planned68", branch: "main" } });
		const again = first((await queue()).items);
		expect(again.q).not.toBe(asked.q);
		expect(again.evidence.scope).toBe("line:trunk@acme/web");
		expect(await h.call<GateStatus>("gate", { run: planned.run })).toMatchObject({
			verdict: "blocked",
			open: [again.q],
		});
		expect((await h.call<{ state: string }[]>("get", { refs: [asked.q] }))[0]?.state).toBe("dissolved");
	});

	test("landing metadata is refused for an open change or an agent and moves only its repository", async () => {
		const report = ciReport({ commit: "repos0068", branch: "feature", pr: 68, n: 1, fail: { 0: "same cause" } });
		await h.call("report", report);
		await h.call("report", { ...report, target: { ...report.target, repo: "example/other" } });
		const landing = { commit: "repos0068", branch: "main" };
		expect(await h.raw("change", { change: "pr:68", state: "open", landing })).toMatchObject({
			ok: false,
			error: { code: "invalid" },
		});
		const agent = await h.actor("reviewer", "agent", ["read", "produce"]);
		expect(await h.raw("change", { change: "pr:68", state: "merged", landing }, agent)).toMatchObject({
			ok: false,
			error: { code: "forbidden" },
		});
		expect(await count("scope_moves")).toBe(0);
		await h.call("change", { change: "pr:68", state: "merged", landing });
		expect(
			await h.app.database.read(
				async (db) => await db.all(sql<[], Record<string, unknown>>("SELECT repo, line FROM targets ORDER BY id")),
			),
		).toEqual([
			{ repo: "acme/web", line: "trunk" },
			{ repo: "example/other", line: "change" },
		]);
		expect(await count("scope_moves")).toBe(1);
	});

	type Ended = { change: string; state: string; questions: string[]; already: boolean };
	const end = async (change: string, state: "merged" | "closed" | "open", as = h.owner) =>
		await h.call<Ended>("change", { change, state }, as);
	const changes = async () =>
		(
			await h.call<{ items: { key: string; head: string | null; state: string; verdict: string | null }[] }>("find", {
				in: "changes",
			})
		).items;
	/** A pull request whose only commit fails one test, and the question about it. */
	const failingPull = async (pr = 12, commit = "ended0001") => {
		await h.call("report", ciReport({ commit, branch: "fix", pr, n: 2, fail: { 0: "expected 90, got 100" } }));
		const asked = (await queue()).items.find((item) => item.about.includes(`pr:${pr}`));
		if (!asked) throw new Error("the failing pull request raised no question");
		return asked;
	};

	test("a report that corrects only a change's URL updates it, and a report that corrects nothing writes nothing", async () => {
		const urls = async () =>
			(await h.call<{ items: { key: string; url: string | null }[] }>("find", { in: "changes" })).items.map(
				(c) => c.url,
			);
		const rev = async () =>
			await h.app.database.read(
				async (db) => await db.all(sql<[], Record<string, unknown>>("SELECT rev FROM changes")),
			);
		const at = (attempt: number, url: string) => {
			const report = ciReport({ commit: "url00001", branch: "fix", pr: 12, n: 2, attempt });
			return { ...report, target: { ...report.target, url } };
		};
		await h.call("report", at(1, "https://github.com/acme/old/issues/12"));
		expect(await urls()).toEqual(["https://github.com/acme/old/issues/12"]);
		const written = await rev();
		await h.call("report", at(2, "https://github.com/acme/old/issues/12"));
		expect(await rev()).toEqual(written);
		await h.call("report", at(3, "https://github.com/acme/new/pull/12"));
		expect(await urls()).toEqual(["https://github.com/acme/new/pull/12"]);
		expect(await rev()).not.toEqual(written);
	});

	test("its unanswered failures are no longer asked about, and nothing else about it changes", async () => {
		const asked = await failingPull();
		expect(asked.blocks).toHaveLength(1);
		expect(await end("pr:12", "merged")).toEqual({
			change: "pr:12",
			state: "merged",
			questions: [asked.q],
			already: false,
		});
		expect((await queue()).counts.open).toBe(0);
		expect((await h.call<{ state: string }[]>("get", { refs: [asked.q] }))[0]?.state).toBe("dissolved");
		expect(await changes()).toMatchObject([{ key: "pr:12", state: "merged", verdict: "blocked" }]);
		// The commit's own verdict is history: it failed, nobody explained it, and nobody is asked now.
		expect(await gate("ended0001")).toMatchObject({ verdict: "blocked", open: [] });
		// Saying it again changes nothing about the change or its questions.
		expect(await end("PR:12", "merged")).toEqual({ change: "pr:12", state: "merged", questions: [], already: true });
	});

	test.each([true, false])(
		"a merged change keeps its head after another commit reports, landing=%s",
		async (landing) => {
			await failingPull();
			await h.call("change", {
				change: "pr:12",
				state: "merged",
				...(landing ? { landing: { commit: "ended0001", branch: "main" } } : {}),
			});
			const later = await h.call<ReportReceipt>(
				"report",
				ciReport({ commit: "ended0002", branch: "fix", pr: 12, n: 2 }),
			);
			expect(later.counts).toMatchObject({ total: 2, pass: 2 });
			expect(later.questions).toEqual([]);
			expect((await gate("ended0002")).verdict).toBe("passed");
			expect(await changes()).toMatchObject([{ key: "pr:12", head: "ended0001", state: "merged", verdict: "blocked" }]);
			expect(await h.call<GateStatus>("gate", { change: "pr:12" })).toMatchObject({
				run: (await gate("ended0001")).run,
				verdict: "blocked",
			});
			await h.call("report", ciReport({ commit: "ended0001", branch: "fix", pr: 12, n: 2, attempt: 2 }));
			expect(await changes()).toMatchObject([{ key: "pr:12", head: "ended0001", state: "merged", verdict: "passed" }]);
			expect((await queue()).counts.open).toBe(0);
		},
	);

	test("a closed unmerged change follows later reports and asks about its latest head when reopened", async () => {
		await failingPull();
		await end("pr:12", "closed");
		await h.call("report", ciReport({ commit: "ended0002", branch: "fix", pr: 12, n: 2, fail: { 1: "new failure" } }));
		expect(await changes()).toMatchObject([{ key: "pr:12", head: "ended0002", state: "closed", verdict: "blocked" }]);
		expect((await queue()).counts.open).toBe(0);
		const reopened = await end("pr:12", "open");
		expect(reopened.questions).toHaveLength(1);
		expect(await h.call<GateStatus>("gate", { change: "pr:12" })).toMatchObject({
			run: (await gate("ended0002")).run,
			verdict: "blocked",
			open: reopened.questions,
		});
	});

	test("a closed unmerged change follows a code host head observation", async () => {
		await h.call("report", ciReport({ commit: "ended0001", branch: "fix", pr: 12, n: 1 }));
		await failingPull(12, "ended0002");
		await end("pr:12", "closed");
		const old = ciReport({ commit: "ended0001", branch: "fix", pr: 12, n: 1, job: "observe-reset" });
		expect(
			(await h.call<ReportReceipt>("report", { ...old, target: { ...old.target, head: "ended0001" } })).fresh,
		).toBe(true);
		expect(await changes()).toMatchObject([{ key: "pr:12", head: "ended0001", state: "closed", verdict: "passed" }]);
		expect(await h.call<GateStatus>("gate", { change: "pr:12" })).toMatchObject({
			run: (await gate("ended0001")).run,
			verdict: "passed",
		});
		expect((await queue()).counts.open).toBe(0);
	});

	test("a merged change follows new reports again after it is explicitly reopened", async () => {
		await failingPull();
		await end("pr:12", "merged");
		await end("pr:12", "open");
		await h.call("report", ciReport({ commit: "ended0002", branch: "fix", pr: 12, n: 2 }));
		expect(await changes()).toMatchObject([{ key: "pr:12", head: "ended0002", state: "open", verdict: "passed" }]);
		expect((await queue()).counts.open).toBe(0);
	});

	test("the same failure on the line is its own question, and stays", async () => {
		await failingPull();
		await h.call("report", ciReport({ commit: "ended0002", n: 2, fail: { 0: "expected 90, got 100" } }));
		expect((await queue()).counts.failure).toBe(2);
		await end("pr:12", "merged");
		const left = (await queue()).items;
		expect(left.map((item) => item.evidence.scope)).toEqual(["line:trunk@acme/web"]);
		expect(await gate("ended0002")).toMatchObject({ verdict: "blocked", open: [first(left).q] });
	});

	test("an answer already given stands, and a finding about the change is still asked", async () => {
		const asked = await failingPull();
		await decide(asked, { is: "flaky" });
		const agent = await h.actor("reviewer", "agent", ["read", "produce"]);
		await h.call("propose", { edits: [{ op: "create", outline: "Coupon applies\n  Apply SAVE10 > Total is 90" }] });
		await h.call(
			"claim",
			{ lens: "review", about: "pr:12", findings: [{ on: "C-1", category: "ambiguous", note: "Say which total" }] },
			agent,
		);
		expect((await end("pr:12", "closed")).questions).toEqual([]);
		expect((await queue()).counts).toMatchObject({ open: 1, finding: 1 });
		expect(
			(await h.call<InboxReply>("inbox", { state: "decided", kind: "failure" })).items.map((item) => item.q),
		).toEqual([asked.q]);
		expect((await gate("ended0001")).verdict).toBe("passed");
	});

	test("a report that arrives after the end is recorded and counted, and nobody is asked", async () => {
		await failingPull();
		await end("pr:12", "merged");
		// The pipeline's second shard finishes after the merge, with another failure.
		const late = await h.call<ReportReceipt>("report", {
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
		expect((await queue()).counts.open).toBe(0);
		expect(await gate("ended0001")).toMatchObject({ verdict: "blocked", open: [] });
		// A newer commit of the ended change is not asked about either.
		await h.call(
			"report",
			ciReport({ commit: "ended0003", branch: "fix", pr: 12, n: 2, fail: { 0: "expected 90, got 100" } }),
		);
		expect((await queue()).counts.open).toBe(0);
	});

	test("reopening with an unreported merged head waits for evidence in the change's scope", async () => {
		const asked = await failingPull();
		await h.call("change", {
			change: "pr:12",
			state: "merged",
			head: "unseen001",
			landing: { commit: "unseen001", branch: "main" },
		});
		expect((await h.call<{ state: string }[]>("get", { refs: [asked.q] }))[0]?.state).toBe("dissolved");
		expect(await end("pr:12", "open")).toMatchObject({ state: "open", questions: [] });
		expect(await h.call<GateStatus>("gate", { change: "pr:12" })).toMatchObject({ run: null, verdict: "pending" });
		expect((await queue()).counts.open).toBe(0);

		const report = ciReport({
			commit: "ended0001",
			branch: "fix",
			pr: 12,
			n: 2,
			attempt: 2,
			fail: { 0: "expected 90, got 100" },
		});
		await h.call("report", { ...report, target: { ...report.target, head: "ended0001" } });
		const again = first((await queue()).items);
		expect(again).toMatchObject({ kind: "failure", state: "open", title: asked.title });
		expect(await h.call<GateStatus>("gate", { change: "pr:12" })).toMatchObject({
			run: "R-1",
			verdict: "blocked",
			open: [again.q],
		});
	});

	test("a change that is open again is asked about at once, with no new report", async () => {
		const asked = await failingPull();
		await end("pr:12", "closed");
		const reopened = await end("pr:12", "open");
		expect(reopened).toMatchObject({ change: "pr:12", state: "open", already: false });
		expect(reopened.questions).toHaveLength(1);
		const again = first((await queue()).items);
		expect(reopened.questions).toEqual([again.q]);
		expect(again.q).not.toBe(asked.q);
		expect(again.title).toBe(asked.title);
		expect(await gate("ended0001")).toMatchObject({ verdict: "blocked", open: [again.q] });
		expect((await changes())[0]?.state).toBe("open");
	});

	test("an open planned run that shows the failure still waits for its answer", async () => {
		await h.call("propose", { edits: [{ op: "create", outline: "Coupon applies\n  Apply SAVE10 > Total is 90" }] });
		await h.call("report", {
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
		const planned = await h.call<{ run: string }>("plan", {
			name: "Release check",
			select: { cases: ["C-1"] },
			accepts: { commit: "ended0004", repo: "acme/web" },
		});
		const asked = first((await queue()).items.filter((item) => item.kind === "failure"));
		expect(asked.about).toContain(planned.run);
		expect(await h.call<GateStatus>("gate", { run: planned.run })).toMatchObject({
			verdict: "blocked",
			open: [asked.q],
		});
		expect((await end("pr:12", "merged")).questions).toEqual([]);
		expect((await queue()).items.map((item) => item.q)).toContain(asked.q);
		expect(await h.call<GateStatus>("gate", { run: planned.run })).toMatchObject({
			verdict: "blocked",
			open: [asked.q],
		});
		// Once the run has its answer, nothing is left to ask about the ended change.
		await decide(asked, { is: "flaky" });
		expect((await queue()).counts.failure ?? 0).toBe(0);
	});

	test("an answer taken back or run out after the end asks nobody", async () => {
		const asked = await failingPull();
		await decide(asked, { is: "flaky" });
		await end("pr:12", "merged");
		const undone = (await h.call<{ status: string; needs: string | null }[]>("decide", { undo: asked.q }))[0];
		expect(undone?.status).toBe("reopened");
		expect(undone?.needs).toContain("has ended");
		expect((await queue()).counts.open).toBe(0);
		expect(await gate("ended0001")).toMatchObject({ verdict: "blocked", open: [] });
		// A flaky answer that runs out on another ended change does not come back to the queue either.
		const other = await failingPull(13, "ended0005");
		await decide(other, { is: "flaky" });
		await end("pr:13", "closed");
		h.advance(15 * 86_400_000);
		const rule =
			(
				await h.app.database.read(
					async (db) => await db.get(sql<[], { id: number }>("SELECT id FROM actors WHERE kind = 'rule'")),
				)
			)?.id ?? 0;
		await sweep(h.app, rule);
		expect((await queue()).counts.open).toBe(0);
	});

	test("an archive does not say which changes ended: after an import each is open, and what was closed stays closed", async () => {
		const asked = await failingPull();
		await end("pr:12", "merged");
		const chunks: string[] = [];
		await h.app.database.read(async (db) => await exportArchive(db, (chunk) => chunks.push(chunk)));
		expect(chunks.join("")).not.toContain("change_ends");
		const otherFixture = await testDatabase();
		const other = await Database.open({ url: otherFixture.url });
		try {
			await other.write(
				async (db) => await db.transaction(async () => await importArchive(db, linesOf(chunks.join("")))),
			);
			expect(
				await other.read(
					async (db) => await db.get(sql<[], Record<string, unknown>>("SELECT count(*) AS n FROM change_ends")),
				),
			).toEqual({ n: 0 });
			const rows = await other.read(
				async (db) =>
					await db.all(
						sql<[number], { key: string; state: string }>(
							"SELECT c.key, q.state FROM changes c JOIN questions q ON q.no = $1",
						),
						[Number(asked.q.slice(2))],
					),
			);
			expect(rows).toEqual([{ key: "pr:12", state: "dissolved" }]);
		} finally {
			await other.close();
			await otherFixture.close();
		}
	});

	test("a pipeline or a person says so; an agent's word is not taken, and an unknown change is not found", async () => {
		await failingPull();
		const pipeline = await h.actor("pipeline", "ci", ["record"]);
		const agent = await h.actor("runner", "agent", ["read", "produce"]);
		expect(await h.raw("change", { change: "pr:12", state: "merged" }, agent)).toMatchObject({
			ok: false,
			error: { code: "forbidden" },
		});
		expect((await queue()).counts.open).toBe(1);
		expect(await h.raw("change", { change: "pr:404", state: "merged" }, pipeline)).toMatchObject({
			ok: false,
			error: { code: "not_found" },
		});
		expect((await end("pr:12", "merged", pipeline)).questions).toHaveLength(1);
		expect((await queue()).counts.open).toBe(0);
	});
});

describe("imported invalid correction edges", () => {
	const mismatches = ["project", "test", "actor", "target", "run"] as const;
	async function importedCorrection(field: (typeof mismatches)[number]) {
		await h.call("propose", {
			edits: [
				{ op: "create", body: { title: "Original", methods: ["human"] } },
				{ op: "create", body: { title: "Other", methods: ["human"] } },
			],
		});
		const { run } = await h.call<{ run: string }>("plan", { name: "Original run", select: { cases: ["C-1"] } });
		const original = await h.call<ReportReceipt>("report", {
			run,
			results: [{ test: { case: "C-1" }, outcome: "pass" }],
		});
		const id = first(original.results);
		const other = await h.actor("other-producer", "human", ["read", "produce"]);
		await h.call(
			"report",
			{ target: { session: "other" }, results: [{ test: { case: "C-2" }, outcome: "skip" }] },
			other,
		);
		await h.call("admin", { do: "project.create", key: "other", preset: "loose" });
		const value = {
			project: "(SELECT id FROM projects WHERE key = 'other')",
			test: "b.test",
			actor: "b.actor",
			target: "b.target",
			run: "NULL",
		};
		const columns = ["project", "test", "actor", "target", "run"];
		await h.app.database.write(
			async (db) =>
				await db.transaction(
					async () =>
						await db.exec(`
			INSERT INTO results (project,test,actor,target,run,seq,ord,batch,method,basis,basis_case,basis_version,basis_claim,outcome,attempt,at,corrects)
			SELECT ${columns.map((c) => (c === field ? value[field] : `a.${c}`)).join(",")},a.seq,a.ord+1,a.batch,a.method,a.basis,a.basis_case,a.basis_version,a.basis_claim,'skip',a.attempt,a.at,a.id
			FROM (SELECT * FROM results WHERE id = ${id}) a, (SELECT * FROM results ORDER BY id DESC LIMIT 1) b
		`),
				),
		);
		return { id, run };
	}

	for (const field of mismatches) {
		test(`${field} mismatch preserves standing and held evidence, reopened runs and legitimate corrections`, async () => {
			const { id, run } = await importedCorrection(field);
			expect(await h.app.database.read(async (db) => (await resultsByIds(db, [id]))[0]?.standing), field).toBe(true);
			expect(await h.app.database.read((db) => isWithdrawn(db, id)), field).toBe(false);
			const signoff = first((await h.call<InboxReply>("inbox", { state: "decided", kind: "signoff" })).items);
			await h.call("decide", { undo: signoff.q });
			expect(await h.call<GateStatus>("gate", { run }), field).toMatchObject({
				verdict: "passed",
				tally: { pass: 1, missing: 0 },
			});
			const corrected = await h.call<ReportReceipt>("report", {
				run,
				results: [{ test: { case: "C-1" }, outcome: "pass", corrects: id }],
			});
			expect(corrected.results, field).toHaveLength(1);
			expect(await h.app.database.read((db) => isWithdrawn(db, id)), field).toBe(true);
			expect(await h.app.database.read(async (db) => (await resultsByIds(db, [id]))[0]?.standing), field).toBe(false);
		});
	}
});

test("what a waiting agent edit shows of its clause is the clause that decides it", async () => {
	await h.close();
	h = await harness({ preset: "standard" });
	await h.call("propose", { edits: [{ op: "create", outline: "Original" }] });
	const agent = await h.actor("writer", "agent", ["read", "produce"]);
	await h.call("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Proposed" } }] }, agent);
	const q = (await queue()).items[0];
	if (!q) throw new Error("missing question");
	expect((await decide(q, { is: "accept" }))?.status).toBe("decided");
	const settled = await h.call<InboxReply>("inbox", { state: "decided" });
	const decision = settled.items.find((item) => item.q === q.q)?.decision;
	const decided = PRESETS.standard.clauses.find((clause) => clause.id === decision?.signers?.[0]?.clause);
	if (!decided) throw new Error("missing deciding clause");
	expect(q.asked).toMatchObject({ when: decided.when, ask: decided.ask, special: null });
});
