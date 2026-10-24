// A test runner that retries a test inside one run (Playwright's `retries`, Surefire's `rerunFailingTestsCount`)
// reports its earlier tries with the result (decision 0129). The result itself is what the gate counts; the tries
// are evidence: a try that disagrees with the next is a flip, as a retry by the pipeline is.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { budget } from "../scripts/budget.ts";
import { type GateStatus, type InboxReply, ReportInput, type ReportReceipt } from "../src/core/ops.ts";
import { rebuildAssertionIndexes } from "../src/server/evidence/assertions.ts";
import { findProject, makeCtx, stampSeq } from "../src/server/kernel/ctx.ts";
import type { WriteDb } from "../src/server/kernel/db.ts";
import { Database, type SqlValue, sql } from "../src/server/kernel/db.ts";
import { OPS } from "../src/server/ops/index.ts";
import { recoverAccepted } from "../src/server/ops/jobs.ts";
import { invoke } from "../src/server/ops/registry.ts";
import { acceptReport, processBatchSteps } from "../src/server/ops/writes.ts";
import { exportArchive, importArchive, linesOf } from "../src/server/transfer/transfer.ts";
import { parseReport } from "../src/surfaces/formats/report.ts";
import { testDatabase } from "./db.ts";
import { type Harness, harness } from "./helpers.ts";

let h: Harness;
beforeEach(async () => {
	h = await harness({ unlinked: "track" });
});
afterEach(async () => await h?.close());

type Try = { outcome: string; failure?: { message: string }; durationMs?: number };
const result = (outcome: string, tries: Try[] = [], extra: Record<string, unknown> = {}) => ({
	test: { key: "tests/cart.spec.ts::cart::adds", name: "adds", file: "tests/cart.spec.ts" },
	outcome,
	...(outcome === "fail" ? { failure: { message: "expected 2, got 1" } } : {}),
	...(tries.length ? { tries } : {}),
	...extra,
});
const failed = (message = "locator.click: Timeout 5000ms exceeded."): Try => ({
	outcome: "fail",
	failure: { message },
});
const report = async (
	commit: string,
	outcome: string,
	tries: Try[] = [],
	attempt = 1,
	extra: Record<string, unknown> = {},
) =>
	await h.call<{ results?: { id: number }[] }>("report", {
		target: { commit, repo: "acme/web", branch: "main" },
		job: "e2e",
		attempt,
		results: [result(outcome, tries, extra)],
	});
const gate = async (commit: string) => await h.call<GateStatus>("gate", { commit, repo: "acme/web" });
type Page = {
	flips: number;
	sameCode: { signals: { signature: { id: number; text: string }; flips: number }[] };
	last: {
		id: number;
		outcome: string;
		tries: { outcome: string; message: string | null; durationMs: number | null }[];
	}[];
};
const page = async () => (await h.call<Page[]>("get", { refs: ["T-1"] }))[0];
const row = async (commit: string) =>
	(await h.call<{ items: { flipped: boolean; standing: string }[] }>("find", { in: "results", commit })).items[0];
const flaky = async () => (await h.call<{ flaky: number }>("stats", { of: "flaky", days: 1 })).flaky;

test("a pass after a failed try counts as the pass, and the try is a flip everywhere flips are read", async () => {
	await report("aaaa0001", "pass", [failed()]);
	expect(await gate("aaaa0001")).toMatchObject({ verdict: "passed", tally: { pass: 1, unexplained: 0 } });
	expect(await row("aaaa0001")).toMatchObject({ standing: "pass", flipped: true });
	const read = await page();
	expect(read?.flips).toBe(1);
	expect(read?.last[0]?.tries).toEqual([
		{ outcome: "fail", message: "locator.click: Timeout 5000ms exceeded.", durationMs: null },
	]);
	expect(read?.sameCode.signals).toMatchObject([
		{ signature: { text: "locator.click: Timeout <duration> exceeded." }, flips: 1 },
	]);
	expect(await flaky()).toBe(1);
});

test("a recovery is one flip, whether the pipeline or the runner retried first", async () => {
	// The pipeline's first attempt failed; its second failed once inside the runner, then passed.
	await report("bbbb0001", "fail");
	await report("bbbb0001", "pass", [failed("expected 2, got 1")], 2);
	expect((await page())?.flips).toBe(1);
	expect((await gate("bbbb0001")).verdict).toBe("passed");
});

test("a pass then a failure inside one run is a flip, and the failure counts", async () => {
	// A serial group runs again together: a member that passed can fail the second time.
	await report("cccc0001", "fail", [{ outcome: "pass" }]);
	expect(await gate("cccc0001")).toMatchObject({ tally: { pass: 0, unexplained: 1 } });
	expect(await row("cccc0001")).toMatchObject({ standing: "unexplained", flipped: true });
	expect((await page())?.flips).toBe(1);
});

test("tries that only failed, or only skipped, are no flip", async () => {
	await report("dddd0001", "fail", [failed(), failed()]);
	expect((await page())?.flips).toBe(0);
	expect(await row("dddd0001")).toMatchObject({ standing: "unexplained", flipped: false });
	await report("dddd0002", "pass", [{ outcome: "skip" }]);
	expect((await page())?.flips).toBe(0);
	expect((await page())?.last[0]?.tries).toEqual([{ outcome: "skip", message: null, durationMs: null }]);
});

test("a correction withdraws the flips of the result it corrects", async () => {
	const sent = await report("eeee0001", "pass", [failed()]);
	const id = sent.results?.[0]?.id ?? (await page())?.last[0]?.id;
	expect((await page())?.flips).toBe(1);
	await report("eeee0001", "pass", [], 1, { corrects: id });
	expect((await page())?.flips).toBe(0);
	expect(await flaky()).toBe(0);
});

test("an earlier attempt that the runner's retry recovered reads as passed on that attempt", async () => {
	await report("abab0001", "fail");
	await report("abab0001", "pass", [failed("expected 2, got 1")], 2);
	const retried = (
		await h.call<{ last: { attempt: number; outcome: string; passedOnRetry: number | null }[] }[]>("get", {
			refs: ["T-1"],
		})
	)[0]?.last;
	expect(retried?.map((row) => [row.attempt, row.outcome, row.passedOnRetry])).toEqual([
		[2, "pass", null],
		[1, "fail", 2],
	]);
});

test("a later attempt that passed on its first try and ended passing recovered the failure", async () => {
	await report("adad0001", "fail");
	await report("adad0001", "pass", [{ outcome: "pass" }], 2);
	const rows = (
		await h.call<{ last: { attempt: number; passedOnRetry: number | null }[] }[]>("get", { refs: ["T-1"] })
	)[0]?.last;
	expect(rows?.map((row) => [row.attempt, row.passedOnRetry])).toEqual([
		[2, null],
		[1, 2],
	]);
});

test("an attempt that passed only on a try and ended failing recovered nothing", async () => {
	await report("acac0001", "fail");
	await report("acac0001", "fail", [failed(), { outcome: "pass" }], 2);
	const rows = (
		await h.call<{ last: { attempt: number; passedOnRetry: number | null }[] }[]>("get", { refs: ["T-1"] })
	)[0]?.last;
	expect(rows?.map((row) => [row.attempt, row.passedOnRetry])).toEqual([
		[2, null],
		[1, null],
	]);
});

test("a report holds at most a hundred tries of a result", async () => {
	await report("ffff0001", "fail", [{ outcome: "pass" }, ...Array.from({ length: 99 }, () => failed())]);
	expect((await page())?.flips).toBe(1);
	await expect(
		report(
			"ffff0002",
			"pass",
			Array.from({ length: 101 }, () => failed()),
		),
	).rejects.toThrow();
});

const broadTests = (n = 60, files = 6) =>
	Array.from({ length: n }, (_, i) => ({
		key: `file-${i % files}.test.ts::test ${i}`,
		file: `file-${i % files}.test.ts`,
	}));
const broadReport = (tests = broadTests(), extra: Record<string, unknown> = {}) => ({
	target: { commit: "broad001", repo: "acme/web", branch: "main" },
	job: "e2e",
	results: tests.map((test) => ({ test, outcome: "pass", tries: [failed("assertion failed")] })),
	...extra,
});

test("runner and pipeline flips of a broad assertion count under the same file cause", async () => {
	const tests = broadTests();
	await h.call("report", broadReport(tests));
	expect((await page())?.sameCode.signals).toMatchObject([
		{ signature: { text: "Split by file (file-0.test.ts): assertion failed" }, flips: 1 },
	]);
	expect((await gate("broad001")).verdict).toBe("passed");
	const failure = {
		...broadReport(tests),
		attempt: 2,
		results: [{ test: tests[0], outcome: "fail", failure: { message: "assertion failed" } }],
	};
	await h.call("report", failure);
	await h.call("report", { ...failure, attempt: 3, results: [{ test: tests[0], outcome: "pass" }] });
	expect((await page())?.sameCode.signals).toMatchObject([
		{ signature: { text: "Split by file (file-0.test.ts): assertion failed" }, flips: 3 },
	]);
	expect((await page())?.sameCode.signals).toHaveLength(1);
	const other = (await h.call<Page[]>("get", { refs: ["T-2"] }))[0];
	expect(other?.sameCode.signals).toMatchObject([
		{ signature: { text: "Split by file (file-1.test.ts): assertion failed" }, flips: 1 },
	]);
});

test.each([
	{ n: 50, files: 6, split: false },
	{ n: 51, files: 5, split: false },
	{ n: 51, files: 6, split: true },
])("runner assertions count distinct tests and reported files: %j", async ({ n, files, split }) => {
	const input = broadReport(broadTests(n, files));
	input.results = input.results.map((result) => ({
		...result,
		tries: [failed("assertion failed"), failed("assertion failed")],
	}));
	await h.call("report", input);
	expect((await page())?.sameCode.signals).toMatchObject([
		{ signature: { text: split ? "Split by file (file-0.test.ts): assertion failed" : "assertion failed" }, flips: 1 },
	]);
});

test("earlier shard tries count toward a split, but their historical causes stay unchanged", async () => {
	const tests = broadTests();
	await h.call("report", broadReport(tests.slice(0, 30), { job: "first-shard" }));
	await h.call("report", {
		...broadReport(tests.slice(30), { job: "second-shard" }),
		results: tests.slice(30).map((test) => ({
			test,
			outcome: "fail",
			tries: [{ outcome: "pass" }],
			failure: { message: "assertion failed" },
		})),
	});
	expect((await page())?.sameCode.signals).toMatchObject([{ signature: { text: "assertion failed" }, flips: 1 }]);
	expect((await h.call<Page[]>("get", { refs: ["T-31"] }))[0]?.sameCode.signals).toMatchObject([
		{ signature: { text: "Split by file (file-0.test.ts): assertion failed" }, flips: 1 },
	]);
	await h.call("report", broadReport(tests.slice(0, 1), { attempt: 2, job: "first-shard" }));
	expect((await page())?.sameCode.signals).toMatchObject([
		{ signature: { text: "assertion failed" }, flips: 1 },
		{ signature: { text: "Split by file (file-0.test.ts): assertion failed" }, flips: 2 },
	]);
});

test("a try keeps its own cause when the final result fails differently", async () => {
	const input = broadReport();
	await h.call("report", {
		...input,
		results: input.results.map((result) => ({
			...result,
			outcome: "fail",
			failure: { message: "locator.click: Timeout 5000ms exceeded." },
			tries: [...result.tries, { outcome: "pass" }],
		})),
	});
	expect((await page())?.sameCode.signals).toMatchObject([
		{ signature: { text: "Split by file (file-0.test.ts): assertion failed" }, flips: 1 },
		{ signature: { text: "locator.click: Timeout <duration> exceeded." }, flips: 1 },
	]);
});

test("later tries reuse file causes on another commit, keeping missing and literal file names separate", async () => {
	const input = broadReport();
	const tests = [{ key: "missing-file" }, { key: "literal-file", file: "no file reported" }];
	const results = tests.map((test) => ({ test, outcome: "pass", tries: [failed("assertion failed")] }));
	await h.call("report", { ...input, results: [...input.results, ...results] });
	const read = async () => await h.call<Page[]>("get", { refs: ["T-61", "T-62"] });
	const before = await read();
	for (const page of before) {
		expect(page.sameCode.signals).toMatchObject([
			{ signature: { text: "Split by file (no file reported): assertion failed" }, flips: 1 },
		]);
	}
	expect(before[0]?.sameCode.signals[0]?.signature.id).not.toBe(before[1]?.sameCode.signals[0]?.signature.id);
	const later = { ...input, target: { ...input.target, commit: "broad002" }, results };
	await h.call("report", later);
	await h.call("report", later);
	expect(
		(await read()).map((page) => page.sameCode.signals.map(({ signature, flips }) => ({ signature, flips }))),
	).toEqual(before.map((page) => page.sameCode.signals.map(({ signature }) => ({ signature, flips: 2 }))));
});

test.each([
	{ commit: "broad002", repo: "acme/web" },
	{ commit: "broad001", repo: "acme/other" },
])("tries on another commit or repository do not make an assertion broad: %j", async (target) => {
	const tests = broadTests();
	await h.call("report", broadReport(tests.slice(0, 30)));
	await h.call("report", broadReport(tests.slice(30), { target: { ...target, branch: "main" } }));
	expect((await h.call<Page[]>("get", { refs: ["T-31"] }))[0]?.sameCode.signals).toMatchObject([
		{ signature: { text: "assertion failed" }, flips: 1 },
	]);
});

test("unknown tries never make a reported assertion broad or support a detector suggestion", async () => {
	const tests = broadTests().map((test) => ({ ...test, name: "works" }));
	await h.call("report", {
		...broadReport(tests.slice(0, 30)),
		results: tests.slice(0, 30).map((test) => ({ test, outcome: "pass", tries: [{ outcome: "fail" }] })),
	});
	await h.call("report", {
		...broadReport(tests.slice(30), { job: "second-shard" }),
		results: tests.slice(30).map((test) => ({
			test,
			outcome: "pass",
			tries: [failed("expected 1 to be 2")],
		})),
	});
	expect((await h.call<Page[]>("get", { refs: ["T-1"] }))[0]?.sameCode.signals).toEqual([]);
	expect((await h.call<Page[]>("get", { refs: ["T-31"] }))[0]?.sameCode.signals).toMatchObject([
		{ signature: { text: "expected 1 to be 2" }, flips: 1 },
	]);
	expect(
		await h.app.database.read(
			async (db) => await db.get(sql<[], Record<string, unknown>>("SELECT count(*) AS n FROM assertion_seen")),
		),
	).toEqual({ n: 30 });
});

test.each([
	undefined,
	{ message: "failed" },
	{ message: "FAILED" },
	{ message: "Error:" },
	{ message: "Traceback (most recent call last):" },
])(
	"unknown failures remain answerable per test without sharing decisions or detector suggestions: %j",
	async (failure) => {
		const target = { commit: "silent001", head: "silent001", repo: "acme/web", pr: 7, branch: "feature" };
		const results = ["first", "second"].map((key) => ({
			test: { key, name: "timeout once" },
			outcome: "fail",
			...(failure ? { failure } : {}),
		}));
		const receipt = await h.call<ReportReceipt>("report", { target, results });
		expect(receipt.gate?.open).toHaveLength(2);
		let questions = (await h.call<InboxReply>("inbox", { kind: "failure", on: "pr:7" })).items;
		expect(questions).toHaveLength(2);
		const signatures = await h.app.database.read(
			async (db) =>
				await db.all(sql<[], { id: number; class: string }>("SELECT id, class FROM signatures ORDER BY id")),
		);
		expect(signatures).toEqual([
			{ id: expect.any(Number), class: "unknown" },
			{ id: expect.any(Number), class: "unknown" },
		]);
		expect(signatures[0]?.id).not.toBe(signatures[1]?.id);
		const question = questions[0];
		if (!question) throw new Error("missing failure question");
		await h.call("decide", { q: question.q, onEvidence: question.evidenceHash, answer: { is: "flaky" } });
		expect(await gate("silent001")).toMatchObject({ verdict: "blocked", tally: { unexplained: 1, excused: 1 } });
		questions = (await h.call<InboxReply>("inbox", { kind: "failure", on: "pr:7" })).items;
		expect(questions).toHaveLength(1);
		const other = questions[0];
		if (!other) throw new Error("missing second failure question");
		await h.call("decide", { q: other.q, onEvidence: other.evidenceHash, answer: { is: "infra" } });
		expect(await gate("silent001")).toMatchObject({
			verdict: "passed",
			open: [],
			tally: { unexplained: 0, excused: 2 },
		});
		for (const [attempt, outcome] of [
			[2, "pass"],
			[3, "fail"],
			[4, "pass"],
		] as const) {
			await h.call("report", { target, attempt, results: results.map((result) => ({ ...result, outcome })) });
		}
		for (const ref of ["T-1", "T-2"]) {
			const read = (await h.call<Page[]>("get", { refs: [ref] }))[0];
			expect(read?.flips).toBe(3);
			expect(read?.sameCode.signals).toEqual([]);
		}
	},
);

test("diagnostic detail supplies a result and its runner try with a known cause", async () => {
	const failure = { message: "", detail: "Error:\nAssertionError: expected 1 to be 2\n at cart (cart.ts:3:1)" };
	const target = { commit: "detail001", head: "detail001", repo: "acme/web", pr: 7, branch: "feature" };
	await h.call("report", {
		target,
		results: [{ test: { key: "detail", name: "timeout once" }, outcome: "fail", failure }],
	});
	const question = (await h.call<InboxReply>("inbox", { kind: "failure", on: "pr:7" })).items[0];
	expect(question?.evidence).toMatchObject({
		signature: { class: "assertion", text: "AssertionError: expected 1 to be 2 | at cart (cart.ts)" },
	});
	await h.call("report", {
		target,
		attempt: 2,
		results: [{ test: { key: "detail" }, outcome: "pass", tries: [{ outcome: "fail", failure }] }],
	});
	expect((await gate("detail001")).verdict).toBe("passed");
	expect((await page())?.sameCode.signals).toMatchObject([
		{ signature: { text: "AssertionError: expected 1 to be 2 | at cart (cart.ts)" }, flips: 1 },
	]);
});

test("an unknown failure on the base cannot explain the head's unknown failure", async () => {
	const results = [{ test: { key: "one" }, outcome: "fail" }];
	await h.call("report", { target: { commit: "silentbase", repo: "acme/web", branch: "main" }, results });
	const receipt = await h.call<ReportReceipt>("report", {
		target: {
			commit: "silenthead",
			head: "silenthead",
			base: "silentbase",
			pr: 7,
			repo: "acme/web",
			branch: "feature",
		},
		results,
	});
	expect(receipt.gate).toMatchObject({ verdict: "blocked", tally: { unexplained: 1, excused: 0 } });
	expect(receipt.questions).toMatchObject([{ state: "open" }]);
	const questions = (await h.call<InboxReply>("inbox", { kind: "failure", on: "pr:7" })).items;
	expect(questions).toHaveLength(1);
	expect(questions[0]?.evidence.hints).not.toContain("fails-on-base");
});

test("unknown causes and their decisions survive archive replay for later reports of the same test", async () => {
	const results = [{ test: { key: "one" }, outcome: "fail", tries: [{ outcome: "fail" }] }];
	const target = { commit: "silentarchive", head: "silentarchive", repo: "acme/web", pr: 7, branch: "feature" };
	await h.call("report", { target, results });
	const question = (await h.call<InboxReply>("inbox", { kind: "failure" })).items[0];
	if (!question) throw new Error("missing failure question");
	await h.call("decide", { q: question.q, onEvidence: question.evidenceHash, answer: { is: "flaky" } });
	const chunks: string[] = [];
	await h.app.database.read(
		async (db) => await exportArchive(db, (chunk) => chunks.push(chunk), { now: 1_800_000_000_000 }),
	);
	const dbFixture = await testDatabase();
	const db = await Database.open({ url: dbFixture.url });
	try {
		await db.write(async (db) => await db.transaction(async () => await importArchive(db, linesOf(chunks.join("")))));
		expect(
			await db.read(async (db) => await db.all(sql<[], Record<string, unknown>>("SELECT class, text FROM signatures"))),
		).toEqual([{ class: "unknown", text: "Unknown failure cause" }]);
		const app = { ...h.app, database: db };
		await db.write(
			async (db) =>
				await db.transaction(async () => {
					const project = await findProject(db, "scratch");
					if (!project) throw new Error("missing project");
					const ctx = makeCtx(app, db, project, h.owner, true);
					await acceptReport(ctx, ReportInput.parse({ target, results, attempt: 2 }));
					await stampSeq(ctx);
				}),
		);
		expect(await recoverAccepted(app)).toBe(1);
		expect(
			await db.read(async (db) => await db.all(sql<[], Record<string, unknown>>("SELECT class, text FROM signatures"))),
		).toHaveLength(1);
		expect(
			await invoke(app, OPS, {
				op: "gate",
				project: "scratch",
				input: { change: "pr:7", repo: "acme/web" },
				actor: async () => h.owner,
			}),
		).toMatchObject({
			ok: true,
			result: { verdict: "passed", open: [], tally: { excused: 1, unexplained: 0 } },
		});
	} finally {
		await db.close();
		await dbFixture.close();
	}
});

test("large assertion history cannot make a report materialize unbounded rows", async () => {
	const ci = await h.actor("pipeline", "ci", ["read", "record"]);
	const target = { repo: "acme/web", commit: "history-bound-01", branch: "main" };
	const database = h.app.database;
	const write = database.write.bind(database);
	let largestRead = 0;
	let largestStatement = "";
	let probing = false;
	let probeRows = 0;
	database.write = async (fn, options) =>
		await write(async (db) => {
			const all = db.all.bind(db);
			db.all = async (statement, ...params) => {
				const rows = await all(statement, ...params);
				if (rows.length > largestRead) {
					largestRead = rows.length;
					largestStatement = statement.text;
				}
				if (probing) probeRows += rows.length;
				return rows;
			};
			try {
				return await fn(db);
			} finally {
				db.all = all;
			}
		}, options);
	try {
		await h.call(
			"report",
			{
				target,
				job: "e2e",
				results: broadTests().map((test, i) => ({
					test,
					outcome: "fail",
					failure: { message: "assertion final root" },
					tries: Array.from({ length: 100 }, (_, j) => failed(`assertion try ${i * 100 + j}`)),
				})),
			},
			ci,
		);
		probing = true;
		await h.call(
			"report",
			{
				target,
				job: "probe",
				results: [{ test: { key: "probe" }, outcome: "fail", failure: { message: "unrelated assertion" } }],
			},
			ci,
		);
		budget("largest read of a retried report", largestRead, 200, "rows");
		budget("probe rows of a retried report", probeRows, 512, "rows");
	} finally {
		database.write = write;
	}
	expect((await gate(target.commit)).tally.unexplained).toBe(61);
});

test.each(["rebuild", "archive"])(
	"first recovery after %s of broad history uses bounded single-row reads",
	async (maintenance) => {
		const tests = Array.from({ length: 1200 }, (_, i) => ({ key: `history-${i}`, file: `history-${i}.test.ts` }));
		const input = broadReport(tests);
		await h.call("report", input, await h.actor("pipeline", "ci", ["read", "record"]));
		const pending = (
			await inContext(
				async (ctx) => await acceptReport(ctx, ReportInput.parse({ ...broadReport(tests.slice(-1)), job: "pending" })),
			)
		).batch;
		const importedFixture = maintenance === "archive" ? await testDatabase() : null;
		const imported = importedFixture ? await Database.open({ url: importedFixture.url }) : null;
		const db = imported ?? h.app.database;
		const beforeMaintenance = db.statementCount;
		try {
			if (imported) {
				const chunks: string[] = [];
				await h.app.database.read(
					async (db) => await exportArchive(db, (chunk) => chunks.push(chunk), { now: 1_800_000_000_000 }),
				);

				await imported.write(
					async (db) => await db.transaction(async () => await importArchive(db, linesOf(chunks.join("")))),
				);
			} else await db.write(async (db) => await db.transaction(async () => await rebuildAssertionIndexes(db, true)));
			if (!imported) expect(db.statementCount - beforeMaintenance).toBeLessThanOrEqual(512);
			const write = db.write.bind(db);
			let rowsRead = 0;
			db.write = async (fn, options) =>
				await write(async (db) => {
					const get = db.get.bind(db);
					db.get = async (statement, ...params) => {
						const row = await get(statement, ...params);
						if (row) rowsRead++;
						return row;
					};
					try {
						return await fn(db);
					} finally {
						db.get = get;
					}
				}, options);
			try {
				const app = { ...h.app, database: db };
				expect(await recoverAccepted(app)).toBe(1);
				budget("rows read recovering an accepted report", rowsRead, 512, "rows");
				expect(await recoverAccepted(app)).toBe(0);
			} finally {
				db.write = write;
			}
			expect(
				await db.read(
					async (db) =>
						await db.all(
							sql<
								readonly SqlValue[],
								Record<string, unknown>
							>(`SELECT s.text FROM result_tries tr JOIN results r ON r.id = tr.result
				JOIN signatures s ON s.id = tr.signature WHERE r.batch = $1`),
							[pending.id],
						),
				),
			).toEqual([{ text: "Split by file (history-1199.test.ts): assertion failed" }]);
			expect(
				await db.read(
					async (db) => await db.get(sql<[], Record<string, unknown>>("SELECT count(*) AS n FROM assertion_seen")),
				),
			).toEqual({ n: 51 });
		} finally {
			await imported?.close();
			await importedFixture?.close();
		}
	},
);

test("repeated tries and reports stop retaining threshold observations once the root is broad", async () => {
	const input = broadReport();
	input.results = input.results.map((result) => ({
		...result,
		tries: Array.from({ length: 100 }, () => failed("assertion failed")),
	}));
	for (let attempt = 1; attempt <= 3; attempt++) await h.call("report", { ...input, attempt });
	expect(
		await h.app.database.read(
			async (db) => await db.get(sql<[], Record<string, unknown>>("SELECT count(*) AS n FROM assertion_seen")),
		),
	).toEqual({ n: 51 });
	expect((await page())?.sameCode.signals).toMatchObject([
		{ signature: { text: "Split by file (file-0.test.ts): assertion failed" }, flips: 5 },
	]);
});

const inContext = async <T>(fn: (ctx: ReturnType<typeof makeCtx<WriteDb>>) => T): Promise<T> =>
	await h.app.database.write(
		async (db) =>
			await db.transaction(async () => {
				const project = await findProject(db, "scratch");
				if (!project) throw new Error("missing project");
				const ctx = makeCtx(h.app, db, project, h.owner, true);
				const value = await fn(ctx);
				await stampSeq(ctx);
				return value;
			}),
	);

test("application yields within a batch's tries, and recovery after rollback applies it once", async () => {
	const input = broadReport(broadTests(6));
	input.results = input.results.map((result) => ({
		...result,
		tries: Array.from({ length: 100 }, () => failed("assertion failed")),
	}));
	const batch = (await inContext(async (ctx) => await acceptReport(ctx, ReportInput.parse(input)))).batch;
	await expect(
		inContext(async (ctx) => {
			const steps = processBatchSteps(ctx, batch.id);
			expect((await steps.next()).done).toBe(false);
			expect(await ctx.db.get(sql<[], { n: number }>("SELECT count(*) AS n FROM result_tries"))).toEqual({ n: 200 });
			throw new Error("interrupted application");
		}),
	).rejects.toThrow("interrupted application");
	expect(
		await h.app.database.read(
			async (db) => await db.get(sql<[], Record<string, unknown>>("SELECT count(*) AS n FROM assertion_seen")),
		),
	).toEqual({ n: 0 });
	expect(await recoverAccepted(h.app)).toBe(1);
	expect(await recoverAccepted(h.app)).toBe(0);
	expect(
		await h.app.database.read(
			async (db) => await db.get(sql<[], Record<string, unknown>>("SELECT count(*) AS n FROM result_tries")),
		),
	).toEqual({ n: 600 });
	expect((await gate(input.target.commit)).verdict).toBe("passed");
});

test("archive import reconstructs roots using full filenames and keeps split-looking original causes", async () => {
	const input = broadReport();
	input.results = input.results.map((result, i) => ({
		...result,
		test: { key: result.test.key, file: `part ): file-${i % 6}.test.ts` },
		tries: [failed("Split by file (literal): assertion failed")],
	}));
	await h.call("report", input);
	const before = await h.app.database.read(
		async (db) => await db.all(sql<[], Record<string, unknown>>("SELECT id, signature FROM result_tries ORDER BY id")),
	);
	const chunks: string[] = [];
	await h.app.database.read(
		async (db) => await exportArchive(db, (chunk) => chunks.push(chunk), { now: 1_800_000_000_000 }),
	);
	const text = chunks.join("");
	expect(text).not.toContain('"t":"assertion_');
	const toFixture = await testDatabase();
	const to = await Database.open({ url: toFixture.url });
	try {
		await to.write(async (db) => await db.transaction(async () => await importArchive(db, linesOf(text))));
		expect(
			await to.read(
				async (db) =>
					await db.all(sql<[], Record<string, unknown>>("SELECT id, signature FROM result_tries ORDER BY id")),
			),
		).toEqual(before);
		expect(
			await to.read(
				async (db) => await db.get(sql<[], Record<string, unknown>>("SELECT count(*) AS n FROM assertion_seen")),
			),
		).toEqual({ n: 51 });
		expect(
			await to.read(
				async (db) =>
					await db.get(
						sql<[], Record<string, unknown>>("SELECT count(*) AS n FROM assertion_roots WHERE root != signature"),
					),
			),
		).toEqual({ n: 6 });
	} finally {
		await to.close();
		await toFixture.close();
	}
});

test("legacy missing file causes are created only when that file recurs on its broad commit", async () => {
	const earlier = Array.from({ length: 40 }, (_, i) => ({ key: `old-file-${i}::test`, file: `old-file-${i}` }));
	await h.call("report", broadReport(earlier));
	await h.call("report", broadReport(broadTests(20), { job: "later-shard" }));
	const missing = "Split by file (old-file-0): assertion failed";
	await h.app.database.write(
		async (db) =>
			await db.transaction(
				async () =>
					await db.run(
						sql<readonly SqlValue[], Record<string, unknown>>(
							"DELETE FROM assertion_roots WHERE signature IN (SELECT id FROM signatures WHERE text = $1)",
						),
						[missing],
					),
			),
	);
	await h.app.database.write(
		async (db) =>
			await db.transaction(
				async () =>
					await db.run(sql<readonly SqlValue[], Record<string, unknown>>("DELETE FROM signatures WHERE text = $1"), [
						missing,
					]),
			),
	);
	await h.app.database.write(async (db) => await db.transaction(async () => await rebuildAssertionIndexes(db, true)));
	expect(
		await h.app.database.read(
			async (db) =>
				await db.get(sql<readonly SqlValue[], Record<string, unknown>>("SELECT 1 FROM signatures WHERE text = $1"), [
					missing,
				]),
		),
	).toBeNull();
	const another = broadReport(earlier.slice(0, 1), {
		target: { repo: "acme/web", commit: "another-commit", branch: "main" },
	});
	await h.call("report", another);
	expect((await page())?.sameCode.signals).toMatchObject([{ signature: { text: "assertion failed" }, flips: 2 }]);
	await h.call("report", broadReport(broadTests(1), { job: "activate" }));
	expect(
		await h.app.database.read(
			async (db) =>
				await db.get(sql<readonly SqlValue[], Record<string, unknown>>("SELECT 1 FROM signatures WHERE text = $1"), [
					missing,
				]),
		),
	).toBeNull();
	await h.call("report", broadReport(earlier.slice(0, 1), { job: "recurring-file" }));
	expect(
		await h.app.database.read(
			async (db) =>
				await db.get(sql<readonly SqlValue[], Record<string, unknown>>("SELECT 1 FROM signatures WHERE text = $1"), [
					missing,
				]),
		),
	).not.toBeNull();
	await h.call("report", { ...another, attempt: 2 });
	expect((await page())?.sameCode.signals).toMatchObject([
		{ signature: { text: "assertion failed" }, flips: 2 },
		{ signature: { text: missing }, flips: 3 },
	]);
});

test("JUnit suffixed testcases pass the gate and record their retry flip through report", async () => {
	const parsed = parseReport(
		`<testsuite><testcase name="adds"><failure message="expected 2, got 1"/></testcase><testcase name="adds (retry #1)"/></testsuite>`,
		{ format: "junit", file: "retry.xml" },
	);
	await h.call("report", {
		target: { commit: "fedc7331", repo: "acme/web", branch: "main" },
		job: "e2e",
		results: parsed.results,
	});
	expect(await gate("fedc7331")).toMatchObject({ verdict: "passed", tally: { pass: 1, unexplained: 0 } });
	expect((await page())?.last[0]?.tries).toEqual([{ outcome: "fail", message: "expected 2, got 1", durationMs: null }]);
	expect((await page())?.flips).toBe(1);
	expect(await row("fedc7331")).toMatchObject({ standing: "pass", flipped: true });
	expect(await flaky()).toBe(1);
});

test("JUnit duplicates without an unambiguous retry sequence still count the worse outcome", async () => {
	const parsed = parseReport(
		`<testsuite><testcase name="adds"><failure message="expected 2, got 1"/></testcase><testcase name="adds [retry 2]"/></testsuite>`,
		{ file: "retry.xml" },
	);
	await h.call("report", {
		target: { commit: "fedc7332", repo: "acme/web", branch: "main" },
		job: "e2e",
		results: parsed.results,
	});
	expect(await gate("fedc7332")).toMatchObject({ verdict: "blocked", tally: { pass: 0, unexplained: 1 } });
	expect((await page())?.flips).toBe(0);
});

test("distinct JUnit identities sharing a rendered key cannot turn a failure into a retry pass", async () => {
	const parsed = parseReport(
		`<testsuite><testcase classname="a" name="b::c"><failure message="real failure"/></testcase><testcase classname="a::b" name="c (retry #1)"/></testsuite>`,
		{ file: "collision.xml" },
	);
	await h.call("report", {
		target: { commit: "fedc7333", repo: "acme/web", branch: "main" },
		job: "e2e",
		results: parsed.results,
	});
	expect(await gate("fedc7333")).toMatchObject({ verdict: "blocked", tally: { pass: 0, unexplained: 1 } });
	expect((await page())?.flips).toBe(0);
});

test("a file prefix and matching classname cannot turn a failure into a retry pass", async () => {
	const parsed = parseReport(
		`<testsuite><testcase file="a" name="t"><failure message="real failure"/></testcase><testcase classname="a" name="t (retry #1)"/></testsuite>`,
		{ file: "file-class.xml" },
	);
	await h.call("report", {
		target: { commit: "fedc7335", repo: "acme/web", branch: "main" },
		job: "e2e",
		results: parsed.results,
	});
	expect(await gate("fedc7335")).toMatchObject({ verdict: "blocked", tally: { pass: 0, unexplained: 1 } });
	expect((await page())?.flips).toBe(0);
});

const rawIdentityChanges: {
	attribute: string;
	before: string | undefined;
	after: string | undefined;
	separateSuites?: boolean;
}[] = [
	{ attribute: "classname", before: "t.TestA", after: "t.TestB" },
	{ attribute: "classname", before: "a\\b", after: "a/b" },
	{ attribute: "classname", before: undefined, after: "" },
	{ attribute: "classname", before: "t&#46;TestA", after: "t.TestA" },
	{ attribute: "file", before: "t.py", after: "./t.py" },
	{ attribute: "file", before: "a\\b", after: "a/b" },
	{ attribute: "file", before: undefined, after: "" },
	{ attribute: "name", before: "&#120;", after: "x" },
	{ attribute: "name", before: "x ", after: "x" },
	{ attribute: "name", before: "x", after: "x " },
	{ attribute: "id", before: "one", after: "two" },
	{ attribute: "id", before: undefined, after: "" },
	{ attribute: "line", before: "12", after: "13" },
	{ attribute: "package", before: "one", after: "two" },
	{ attribute: "custom-runner-identity", before: "one", after: "two" },
	{ attribute: "custom-runner-identity", before: undefined, after: "" },
	{ attribute: "suite instance", before: undefined, after: undefined, separateSuites: true },
];

const rawTestAttributes = (values: Record<string, string | undefined>, quote = '"') =>
	Object.entries(values)
		.filter(([, value]) => value !== undefined)
		.map(([name, value]) => `${name}=${quote}${value}${quote}`)
		.join(" ");

test.each(rawIdentityChanges)("raw JUnit identity changes stay separate: %j", async (change) => {
	const identity = {
		file: "t.py",
		classname: "t.TestA",
		name: "x",
		id: "case-1",
		line: "12",
		package: "tests",
		"custom-runner-identity": "same",
	};
	const initial = change.separateSuites ? identity : { ...identity, [change.attribute]: change.before };
	const retried = change.separateSuites ? identity : { ...identity, [change.attribute]: change.after };
	const first = `<testcase ${rawTestAttributes(initial)}><failure message="real"/></testcase>`;
	const last = `<testcase ${rawTestAttributes({ ...retried, name: `${retried.name} (retry #1)` })}/>`;
	const xml = change.separateSuites
		? `<testsuites><testsuite name="same">${first}</testsuite><testsuite name="same">${last}</testsuite></testsuites>`
		: `<testsuite>${first}${last}</testsuite>`;
	const parsed = parseReport(xml, { file: "raw-identity.xml" });
	expect(parsed.results).toHaveLength(2);
	expect(parsed.results.map((item) => item.outcome)).toEqual(["fail", "pass"]);
	expect(parsed.results.every((item) => item.tries === undefined)).toBe(true);
	await h.call("report", {
		target: { commit: "fedc7336", repo: "acme/web", branch: "main" },
		job: "e2e",
		results: parsed.results,
	});
	expect(await gate("fedc7336")).toMatchObject({ verdict: "blocked", tally: { unexplained: 1 } });
	expect(await flaky()).toBe(0);
});

test.each(["(retry #1)", "[retry 1]"])(
	"raw identity retains genuine retries despite run-only differences: %s",
	async (suffix) => {
		const identity = {
			file: "t.py",
			classname: "t.TestA",
			name: "x",
			id: "case-1",
			line: "12",
			package: "tests",
			"custom-runner-identity": "same",
		};
		const reversed = Object.fromEntries(Object.entries({ ...identity, name: `x ${suffix}` }).reverse());
		const parsed = parseReport(
			`<testsuite><testcase ${rawTestAttributes(identity)} time="0.1" status="failed" message="old" assertions="1" timestamp="2026-10-22T00:00:00Z"><failure message="real"/><system-out>first output</system-out></testcase><testcase ${rawTestAttributes(reversed, "'")} time="0.3" status="passed" message="new" assertions="2" timestamp="2026-10-22T00:00:01Z"><system-out>later output</system-out></testcase></testsuite>`,
			{ file: "raw-retry.xml" },
		);
		expect(parsed.results).toHaveLength(1);
		expect(parsed.results[0]).toMatchObject({
			outcome: "pass",
			durationMs: 400,
			tries: [{ outcome: "fail", durationMs: 100 }],
		});
		await h.call("report", {
			target: { commit: "fedc7337", repo: "acme/web", branch: "main" },
			job: "e2e",
			results: parsed.results,
		});
		expect(await gate("fedc7337")).toMatchObject({ verdict: "passed", tally: { pass: 1 } });
		expect(await flaky()).toBe(1);
	},
);

test("genuine retries in different classes sharing a file and name group independently", async () => {
	const xml = `<testsuite>${["t.TestA", "t.TestB"].map((classname) => `<testcase file="t.py" classname="${classname}" name="x"><failure message="real"/></testcase><testcase file="t.py" classname="${classname}" name="x (retry #1)"/>`).join("")}</testsuite>`;
	const parsed = parseReport(xml, { file: "classes.xml" });
	expect(parsed.results).toHaveLength(2);
	for (const result of parsed.results) expect(result).toMatchObject({ outcome: "pass", tries: [{ outcome: "fail" }] });
	await h.call("report", {
		target: { commit: "fedc7338", repo: "acme/web", branch: "main" },
		job: "e2e",
		results: parsed.results,
	});
	expect((await gate("fedc7338")).verdict).toBe("passed");
});

test("raw name whitespace survives the removal of one retry separator", async () => {
	const parsed = parseReport(
		`<testsuite><testcase name="x "><failure message="real"/></testcase><testcase name="x  (retry #1)"/></testsuite>`,
		{ file: "name-whitespace.xml" },
	);
	expect(parsed.results).toHaveLength(1);
	expect(parsed.results[0]).toMatchObject({ test: { name: "x " }, outcome: "pass", tries: [{ outcome: "fail" }] });
	await h.call("report", {
		target: { commit: "fedc7339", repo: "acme/web", branch: "main" },
		job: "e2e",
		results: parsed.results,
	});
	expect((await gate("fedc7339")).verdict).toBe("passed");
});
