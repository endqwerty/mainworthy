// A test runner that retries a test inside one run (Playwright's `retries`, Surefire's `rerunFailingTestsCount`)
// reports its earlier tries with the result (decision 0129). The result itself is what the gate counts; the tries
// are evidence: a try that disagrees with the next is a flip, as a retry by the pipeline is.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { type GateStatus, type InboxReply, ReportInput, type ReportReceipt } from "../src/core/ops.ts";
import { rebuildAssertionIndexes } from "../src/server/evidence/assertions.ts";
import { findProject, makeCtx, stampSeq } from "../src/server/kernel/ctx.ts";
import { Db, declaredSql } from "../src/server/kernel/db.ts";
import { MIGRATIONS, migrate } from "../src/server/kernel/migrate.ts";
import { OPS } from "../src/server/ops/index.ts";
import { recoverAccepted } from "../src/server/ops/jobs.ts";
import { invoke } from "../src/server/ops/registry.ts";
import { acceptReport, processBatchSteps } from "../src/server/ops/writes.ts";
import { exportArchive, importArchive, linesOf } from "../src/server/transfer/transfer.ts";
import { parseReport } from "../src/surfaces/formats/report.ts";
import { dropReceiptSchema, type Harness, harness } from "./helpers.ts";

let h: Harness;
beforeEach(() => {
	h = harness({ unlinked: "track" });
});
afterEach(() => h.close());

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
const report = (commit: string, outcome: string, tries: Try[] = [], attempt = 1, extra: Record<string, unknown> = {}) =>
	h.call<{ results?: { id: number }[] }>("report", {
		target: { commit, repo: "acme/web", branch: "main" },
		job: "e2e",
		attempt,
		results: [result(outcome, tries, extra)],
	});
const gate = (commit: string) => h.call<GateStatus>("gate", { commit, repo: "acme/web" });
type Page = {
	flips: number;
	sameCode: { signals: { signature: { id: number; text: string }; flips: number }[] };
	last: {
		id: number;
		outcome: string;
		tries: { outcome: string; message: string | null; durationMs: number | null }[];
	}[];
};
const page = () => h.call<Page[]>("get", { refs: ["T-1"] })[0];
const row = (commit: string) =>
	h.call<{ items: { flipped: boolean; standing: string }[] }>("find", { in: "results", commit }).items[0];
const flaky = () => h.call<{ flaky: number }>("stats", { of: "flaky", days: 1 }).flaky;

test("a pass after a failed try counts as the pass, and the try is a flip everywhere flips are read", () => {
	report("aaaa0001", "pass", [failed()]);
	expect(gate("aaaa0001")).toMatchObject({ verdict: "passed", tally: { pass: 1, unexplained: 0 } });
	expect(row("aaaa0001")).toMatchObject({ standing: "pass", flipped: true });
	const read = page();
	expect(read?.flips).toBe(1);
	expect(read?.last[0]?.tries).toEqual([
		{ outcome: "fail", message: "locator.click: Timeout 5000ms exceeded.", durationMs: null },
	]);
	expect(read?.sameCode.signals).toMatchObject([
		{ signature: { text: "locator.click: Timeout <duration> exceeded." }, flips: 1 },
	]);
	expect(flaky()).toBe(1);
});

test("a recovery is one flip, whether the pipeline or the runner retried first", () => {
	// The pipeline's first attempt failed; its second failed once inside the runner, then passed.
	report("bbbb0001", "fail");
	report("bbbb0001", "pass", [failed("expected 2, got 1")], 2);
	expect(page()?.flips).toBe(1);
	expect(gate("bbbb0001").verdict).toBe("passed");
});

test("a pass then a failure inside one run is a flip, and the failure counts", () => {
	// A serial group runs again together: a member that passed can fail the second time.
	report("cccc0001", "fail", [{ outcome: "pass" }]);
	expect(gate("cccc0001")).toMatchObject({ tally: { pass: 0, unexplained: 1 } });
	expect(row("cccc0001")).toMatchObject({ standing: "unexplained", flipped: true });
	expect(page()?.flips).toBe(1);
});

test("tries that only failed, or only skipped, are no flip", () => {
	report("dddd0001", "fail", [failed(), failed()]);
	expect(page()?.flips).toBe(0);
	expect(row("dddd0001")).toMatchObject({ standing: "unexplained", flipped: false });
	report("dddd0002", "pass", [{ outcome: "skip" }]);
	expect(page()?.flips).toBe(0);
	expect(page()?.last[0]?.tries).toEqual([{ outcome: "skip", message: null, durationMs: null }]);
});

test("a correction withdraws the flips of the result it corrects", () => {
	const sent = report("eeee0001", "pass", [failed()]);
	const id = sent.results?.[0]?.id ?? page()?.last[0]?.id;
	expect(page()?.flips).toBe(1);
	report("eeee0001", "pass", [], 1, { corrects: id });
	expect(page()?.flips).toBe(0);
	expect(flaky()).toBe(0);
});

test("an earlier attempt that the runner's retry recovered reads as passed on that attempt", () => {
	report("abab0001", "fail");
	report("abab0001", "pass", [failed("expected 2, got 1")], 2);
	const retried = h.call<{ last: { attempt: number; outcome: string; passedOnRetry: number | null }[] }[]>("get", {
		refs: ["T-1"],
	})[0]?.last;
	expect(retried?.map((row) => [row.attempt, row.outcome, row.passedOnRetry])).toEqual([
		[2, "pass", null],
		[1, "fail", 2],
	]);
});

test("a later attempt that passed on its first try and ended passing recovered the failure", () => {
	report("adad0001", "fail");
	report("adad0001", "pass", [{ outcome: "pass" }], 2);
	const rows = h.call<{ last: { attempt: number; passedOnRetry: number | null }[] }[]>("get", { refs: ["T-1"] })[0]
		?.last;
	expect(rows?.map((row) => [row.attempt, row.passedOnRetry])).toEqual([
		[2, null],
		[1, 2],
	]);
});

test("an attempt that passed only on a try and ended failing recovered nothing", () => {
	report("acac0001", "fail");
	report("acac0001", "fail", [failed(), { outcome: "pass" }], 2);
	const rows = h.call<{ last: { attempt: number; passedOnRetry: number | null }[] }[]>("get", { refs: ["T-1"] })[0]
		?.last;
	expect(rows?.map((row) => [row.attempt, row.passedOnRetry])).toEqual([
		[2, null],
		[1, null],
	]);
});

test("a report holds at most a hundred tries of a result", () => {
	report("ffff0001", "fail", [{ outcome: "pass" }, ...Array.from({ length: 99 }, () => failed())]);
	expect(page()?.flips).toBe(1);
	expect(() =>
		report(
			"ffff0002",
			"pass",
			Array.from({ length: 101 }, () => failed()),
		),
	).toThrow();
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

test("runner and pipeline flips of a broad assertion count under the same file cause", () => {
	const tests = broadTests();
	h.call("report", broadReport(tests));
	expect(page()?.sameCode.signals).toMatchObject([
		{ signature: { text: "Split by file (file-0.test.ts): assertion failed" }, flips: 1 },
	]);
	expect(gate("broad001").verdict).toBe("passed");
	const failure = {
		...broadReport(tests),
		attempt: 2,
		results: [{ test: tests[0], outcome: "fail", failure: { message: "assertion failed" } }],
	};
	h.call("report", failure);
	h.call("report", { ...failure, attempt: 3, results: [{ test: tests[0], outcome: "pass" }] });
	expect(page()?.sameCode.signals).toMatchObject([
		{ signature: { text: "Split by file (file-0.test.ts): assertion failed" }, flips: 3 },
	]);
	expect(page()?.sameCode.signals).toHaveLength(1);
	const other = h.call<Page[]>("get", { refs: ["T-2"] })[0];
	expect(other?.sameCode.signals).toMatchObject([
		{ signature: { text: "Split by file (file-1.test.ts): assertion failed" }, flips: 1 },
	]);
});

test.each([
	{ n: 50, files: 6, split: false },
	{ n: 51, files: 5, split: false },
	{ n: 51, files: 6, split: true },
])("runner assertions count distinct tests and reported files: %j", ({ n, files, split }) => {
	const input = broadReport(broadTests(n, files));
	input.results = input.results.map((result) => ({
		...result,
		tries: [failed("assertion failed"), failed("assertion failed")],
	}));
	h.call("report", input);
	expect(page()?.sameCode.signals).toMatchObject([
		{ signature: { text: split ? "Split by file (file-0.test.ts): assertion failed" : "assertion failed" }, flips: 1 },
	]);
});

test("earlier shard tries count toward a split, but their historical causes stay unchanged", () => {
	const tests = broadTests();
	h.call("report", broadReport(tests.slice(0, 30), { job: "first-shard" }));
	h.call("report", {
		...broadReport(tests.slice(30), { job: "second-shard" }),
		results: tests.slice(30).map((test) => ({
			test,
			outcome: "fail",
			tries: [{ outcome: "pass" }],
			failure: { message: "assertion failed" },
		})),
	});
	expect(page()?.sameCode.signals).toMatchObject([{ signature: { text: "assertion failed" }, flips: 1 }]);
	expect(h.call<Page[]>("get", { refs: ["T-31"] })[0]?.sameCode.signals).toMatchObject([
		{ signature: { text: "Split by file (file-0.test.ts): assertion failed" }, flips: 1 },
	]);
	h.call("report", broadReport(tests.slice(0, 1), { attempt: 2, job: "first-shard" }));
	expect(page()?.sameCode.signals).toMatchObject([
		{ signature: { text: "assertion failed" }, flips: 1 },
		{ signature: { text: "Split by file (file-0.test.ts): assertion failed" }, flips: 2 },
	]);
});

test("a try keeps its own cause when the final result fails differently", () => {
	const input = broadReport();
	h.call("report", {
		...input,
		results: input.results.map((result) => ({
			...result,
			outcome: "fail",
			failure: { message: "locator.click: Timeout 5000ms exceeded." },
			tries: [...result.tries, { outcome: "pass" }],
		})),
	});
	expect(page()?.sameCode.signals).toMatchObject([
		{ signature: { text: "Split by file (file-0.test.ts): assertion failed" }, flips: 1 },
		{ signature: { text: "locator.click: Timeout <duration> exceeded." }, flips: 1 },
	]);
});

test("later tries reuse file causes on another commit, keeping missing and literal file names separate", () => {
	const input = broadReport();
	const tests = [{ key: "missing-file" }, { key: "literal-file", file: "no file reported" }];
	const results = tests.map((test) => ({ test, outcome: "pass", tries: [failed("assertion failed")] }));
	h.call("report", { ...input, results: [...input.results, ...results] });
	const read = () => h.call<Page[]>("get", { refs: ["T-61", "T-62"] });
	const before = read();
	for (const page of before) {
		expect(page.sameCode.signals).toMatchObject([
			{ signature: { text: "Split by file (no file reported): assertion failed" }, flips: 1 },
		]);
	}
	expect(before[0]?.sameCode.signals[0]?.signature.id).not.toBe(before[1]?.sameCode.signals[0]?.signature.id);
	const later = { ...input, target: { ...input.target, commit: "broad002" }, results };
	h.call("report", later);
	h.call("report", later);
	expect(read().map((page) => page.sameCode.signals.map(({ signature, flips }) => ({ signature, flips })))).toEqual(
		before.map((page) => page.sameCode.signals.map(({ signature }) => ({ signature, flips: 2 }))),
	);
});

test.each([
	{ commit: "broad002", repo: "acme/web" },
	{ commit: "broad001", repo: "acme/other" },
])("tries on another commit or repository do not make an assertion broad: %j", (target) => {
	const tests = broadTests();
	h.call("report", broadReport(tests.slice(0, 30)));
	h.call("report", broadReport(tests.slice(30), { target: { ...target, branch: "main" } }));
	expect(h.call<Page[]>("get", { refs: ["T-31"] })[0]?.sameCode.signals).toMatchObject([
		{ signature: { text: "assertion failed" }, flips: 1 },
	]);
});

test("unknown tries never make a reported assertion broad or support a detector suggestion", () => {
	const tests = broadTests().map((test) => ({ ...test, name: "works" }));
	h.call("report", {
		...broadReport(tests.slice(0, 30)),
		results: tests.slice(0, 30).map((test) => ({ test, outcome: "pass", tries: [{ outcome: "fail" }] })),
	});
	h.call("report", {
		...broadReport(tests.slice(30), { job: "second-shard" }),
		results: tests.slice(30).map((test) => ({
			test,
			outcome: "pass",
			tries: [failed("expected 1 to be 2")],
		})),
	});
	expect(h.call<Page[]>("get", { refs: ["T-1"] })[0]?.sameCode.signals).toEqual([]);
	expect(h.call<Page[]>("get", { refs: ["T-31"] })[0]?.sameCode.signals).toMatchObject([
		{ signature: { text: "expected 1 to be 2" }, flips: 1 },
	]);
	expect(h.app.db.raw.query("SELECT count(*) AS n FROM assertion_seen").get()).toEqual({ n: 30 });
});

test.each([
	undefined,
	{ message: "failed" },
	{ message: "FAILED" },
	{ message: "Error:" },
	{ message: "Traceback (most recent call last):" },
])("unknown failures remain answerable per test without sharing decisions or detector suggestions: %j", (failure) => {
	const target = { commit: "silent001", head: "silent001", repo: "acme/web", pr: 7, branch: "feature" };
	const results = ["first", "second"].map((key) => ({
		test: { key, name: "timeout once" },
		outcome: "fail",
		...(failure ? { failure } : {}),
	}));
	const receipt = h.call<ReportReceipt>("report", { target, results });
	expect(receipt.gate?.open).toHaveLength(2);
	let questions = h.call<InboxReply>("inbox", { kind: "failure", on: "pr:7" }).items;
	expect(questions).toHaveLength(2);
	const signatures = h.app.db.raw
		.query<{ id: number; class: string }, []>("SELECT id, class FROM signatures ORDER BY id")
		.all();
	expect(signatures).toEqual([
		{ id: expect.any(Number), class: "unknown" },
		{ id: expect.any(Number), class: "unknown" },
	]);
	expect(signatures[0]?.id).not.toBe(signatures[1]?.id);
	const question = questions[0];
	if (!question) throw new Error("missing failure question");
	h.call("decide", { q: question.q, onEvidence: question.evidenceHash, answer: { is: "flaky" } });
	expect(gate("silent001")).toMatchObject({ verdict: "blocked", tally: { unexplained: 1, excused: 1 } });
	questions = h.call<InboxReply>("inbox", { kind: "failure", on: "pr:7" }).items;
	expect(questions).toHaveLength(1);
	const other = questions[0];
	if (!other) throw new Error("missing second failure question");
	h.call("decide", { q: other.q, onEvidence: other.evidenceHash, answer: { is: "infra" } });
	expect(gate("silent001")).toMatchObject({ verdict: "passed", open: [], tally: { unexplained: 0, excused: 2 } });
	for (const [attempt, outcome] of [
		[2, "pass"],
		[3, "fail"],
		[4, "pass"],
	] as const) {
		h.call("report", { target, attempt, results: results.map((result) => ({ ...result, outcome })) });
	}
	for (const ref of ["T-1", "T-2"]) {
		const read = h.call<Page[]>("get", { refs: [ref] })[0];
		expect(read?.flips).toBe(3);
		expect(read?.sameCode.signals).toEqual([]);
	}
});

test("diagnostic detail supplies a result and its runner try with a known cause", () => {
	const failure = { message: "", detail: "Error:\nAssertionError: expected 1 to be 2\n at cart (cart.ts:3:1)" };
	const target = { commit: "detail001", head: "detail001", repo: "acme/web", pr: 7, branch: "feature" };
	h.call("report", {
		target,
		results: [{ test: { key: "detail", name: "timeout once" }, outcome: "fail", failure }],
	});
	const question = h.call<InboxReply>("inbox", { kind: "failure", on: "pr:7" }).items[0];
	expect(question?.evidence).toMatchObject({
		signature: { class: "assertion", text: "AssertionError: expected 1 to be 2 | at cart (cart.ts)" },
	});
	h.call("report", {
		target,
		attempt: 2,
		results: [{ test: { key: "detail" }, outcome: "pass", tries: [{ outcome: "fail", failure }] }],
	});
	expect(gate("detail001").verdict).toBe("passed");
	expect(page()?.sameCode.signals).toMatchObject([
		{ signature: { text: "AssertionError: expected 1 to be 2 | at cart (cart.ts)" }, flips: 1 },
	]);
});

test("the unknown cause migration preserves known classes, ids and references", () => {
	const migration = MIGRATIONS.find((entry) => entry.name === "unknown_causes");
	if (!migration) throw new Error("missing unknown cause migration");
	const db = new Db(":memory:");
	try {
		for (const earlier of MIGRATIONS.filter((entry) => entry.version < migration.version)) db.exec(earlier.sql);
		db.raw.exec(`
			INSERT INTO meta VALUES ('schema_version', '${migration.version - 1}');
			INSERT INTO orgs VALUES (1, 'Example', 1);
			INSERT INTO projects (id, org, key, name, created_at, identity) VALUES (1, 1, 'shop', 'Shop', 1, 'shop-identity');
			INSERT INTO signatures (id, project, hash, class, text, first_seq) VALUES
			 (10, 1, 'assertion', 'assertion', 'expected 1', 1),
			 (11, 1, 'timeout', 'timeout', 'TimeoutError', 2),
			 (12, 1, 'infra', 'infra', 'ECONNRESET', 3);
			INSERT INTO assertion_roots VALUES (1, 10, 10);
		`);
		const before = db.raw.query("SELECT id, project, hash, class, text, first_seq FROM signatures ORDER BY id").all();
		migrate(db, ":memory:");
		expect(db.raw.query("SELECT id, project, hash, class, text, first_seq FROM signatures ORDER BY id").all()).toEqual(
			before,
		);
		expect(db.raw.query("SELECT * FROM assertion_roots").all()).toEqual([{ project: 1, signature: 10, root: 10 }]);
		db.raw.exec(
			"INSERT INTO signatures (project, hash, class, text, first_seq) VALUES (1, 'unknown', 'unknown', 'Unknown failure cause', 4)",
		);
		expect(() =>
			db.raw.exec(
				"INSERT INTO signatures (project, hash, class, text, first_seq) VALUES (1, 'unknown', 'unknown', 'Unknown failure cause', 4)",
			),
		).toThrow("UNIQUE");
		expect(() =>
			db.raw.exec(
				"INSERT INTO signatures (project, hash, class, text, first_seq) VALUES (1, 'invalid', 'invalid', 'invalid', 4)",
			),
		).toThrow("CHECK");
		expect(db.raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
	} finally {
		db.close();
	}
});

test("an unknown failure on the base cannot explain the head's unknown failure", () => {
	const results = [{ test: { key: "one" }, outcome: "fail" }];
	h.call("report", { target: { commit: "silentbase", repo: "acme/web", branch: "main" }, results });
	const receipt = h.call<ReportReceipt>("report", {
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
	const questions = h.call<InboxReply>("inbox", { kind: "failure", on: "pr:7" }).items;
	expect(questions).toHaveLength(1);
	expect(questions[0]?.evidence.hints).not.toContain("fails-on-base");
});

test("unknown causes and their decisions survive archive replay for later reports of the same test", () => {
	const results = [{ test: { key: "one" }, outcome: "fail", tries: [{ outcome: "fail" }] }];
	const target = { commit: "silentarchive", head: "silentarchive", repo: "acme/web", pr: 7, branch: "feature" };
	h.call("report", { target, results });
	const question = h.call<InboxReply>("inbox", { kind: "failure" }).items[0];
	if (!question) throw new Error("missing failure question");
	h.call("decide", { q: question.q, onEvidence: question.evidenceHash, answer: { is: "flaky" } });
	const chunks: string[] = [];
	exportArchive(h.app.db, (chunk) => chunks.push(chunk), { now: 1_800_000_000_000 });
	const db = new Db(":memory:");
	try {
		migrate(db, ":memory:");
		importArchive(db, linesOf(chunks.join("")));
		expect(db.raw.query("SELECT class, text FROM signatures").all()).toEqual([
			{ class: "unknown", text: "Unknown failure cause" },
		]);
		expect(db.raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
		const project = findProject(db, "scratch");
		if (!project) throw new Error("missing project");
		const app = { ...h.app, db };
		db.transaction(() => {
			const ctx = makeCtx(app, project, h.owner, true);
			acceptReport(ctx, ReportInput.parse({ target, results, attempt: 2 }));
			stampSeq(ctx);
		});
		expect(recoverAccepted(app)).toBe(1);
		expect(db.raw.query("SELECT class, text FROM signatures").all()).toHaveLength(1);
		expect(
			invoke(app, OPS, {
				op: "gate",
				project: "scratch",
				input: { change: "pr:7", repo: "acme/web" },
				actor: () => h.owner,
			}),
		).toMatchObject({
			ok: true,
			result: { verdict: "passed", open: [], tally: { excused: 1, unexplained: 0 } },
		});
	} finally {
		db.close();
	}
});

test("large assertion history cannot make a report materialize unbounded rows", () => {
	const ci = h.actor("pipeline", "ci", ["read", "record"]);
	const target = { repo: "acme/web", commit: "history-bound-01", branch: "main" };
	const db = h.app.db;
	const all = db.all.bind(db);
	let largestRead = 0;
	let probing = false;
	let probeRows = 0;
	db.all = (statement, ...params) => {
		const rows = all(statement, ...params);
		largestRead = Math.max(largestRead, rows.length);
		if (probing) probeRows += rows.length;
		return rows;
	};
	try {
		h.call(
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
		h.call(
			"report",
			{
				target,
				job: "probe",
				results: [{ test: { key: "probe" }, outcome: "fail", failure: { message: "unrelated assertion" } }],
			},
			ci,
		);
		expect(largestRead).toBeLessThanOrEqual(200);
		expect(probeRows).toBeLessThanOrEqual(512);
	} finally {
		db.all = all;
	}
	expect(gate(target.commit).tally.unexplained).toBe(61);
});

test.each(["rebuild", "archive"])(
	"first recovery after %s of broad history uses bounded single-row reads",
	(maintenance) => {
		const tests = Array.from({ length: 1200 }, (_, i) => ({ key: `history-${i}`, file: `history-${i}.test.ts` }));
		const input = broadReport(tests);
		h.call("report", input, h.actor("pipeline", "ci", ["read", "record"]));
		const pending = inContext((ctx) =>
			acceptReport(ctx, ReportInput.parse({ ...broadReport(tests.slice(-1)), job: "pending" })),
		).batch;
		const imported = maintenance === "archive" ? new Db(":memory:") : null;
		const db = imported ?? h.app.db;
		try {
			if (imported) {
				const chunks: string[] = [];
				exportArchive(h.app.db, (chunk) => chunks.push(chunk), { now: 1_800_000_000_000 });
				migrate(imported, ":memory:");
				importArchive(imported, linesOf(chunks.join("")));
			} else rebuildAssertionIndexes(db, true);
			const get = db.get.bind(db);
			let rowsRead = 0;
			db.get = (statement, ...params) => {
				const row = get(statement, ...params);
				if (row) rowsRead++;
				return row;
			};
			try {
				const app = { ...h.app, db };
				expect(recoverAccepted(app)).toBe(1);
				expect(rowsRead).toBeLessThanOrEqual(512);
				expect(recoverAccepted(app)).toBe(0);
			} finally {
				db.get = get;
			}
			expect(
				db.raw
					.query(`SELECT s.text FROM result_tries tr JOIN results r ON r.id = tr.result
				JOIN signatures s ON s.id = tr.signature WHERE r.batch = ?`)
					.all(pending.id),
			).toEqual([{ text: "Split by file (history-1199.test.ts): assertion failed" }]);
			expect(db.raw.query("SELECT count(*) AS n FROM assertion_seen").get()).toEqual({ n: 51 });
		} finally {
			imported?.close();
		}
	},
);

test("repeated tries and reports stop retaining threshold observations once the root is broad", () => {
	const input = broadReport();
	input.results = input.results.map((result) => ({
		...result,
		tries: Array.from({ length: 100 }, () => failed("assertion failed")),
	}));
	for (let attempt = 1; attempt <= 3; attempt++) h.call("report", { ...input, attempt });
	expect(h.app.db.raw.query("SELECT count(*) AS n FROM assertion_seen").get()).toEqual({ n: 51 });
	expect(page()?.sameCode.signals).toMatchObject([
		{ signature: { text: "Split by file (file-0.test.ts): assertion failed" }, flips: 5 },
	]);
});

const inContext = <T>(fn: (ctx: ReturnType<typeof makeCtx>) => T): T =>
	h.app.db.transaction(() => {
		const project = findProject(h.app.db, "scratch");
		if (!project) throw new Error("missing project");
		const ctx = makeCtx(h.app, project, h.owner, true);
		const value = fn(ctx);
		stampSeq(ctx);
		return value;
	});

test("application yields within a batch's tries, and recovery after rollback applies it once", () => {
	const input = broadReport(broadTests(6));
	input.results = input.results.map((result) => ({
		...result,
		tries: Array.from({ length: 100 }, () => failed("assertion failed")),
	}));
	const batch = inContext((ctx) => acceptReport(ctx, ReportInput.parse(input))).batch;
	expect(() =>
		inContext((ctx) => {
			const steps = processBatchSteps(ctx, batch.id);
			expect(steps.next().done).toBe(false);
			expect(h.app.db.raw.query("SELECT count(*) AS n FROM result_tries").get()).toEqual({ n: 200 });
			throw new Error("interrupted application");
		}),
	).toThrow("interrupted application");
	expect(h.app.db.raw.query("SELECT count(*) AS n FROM assertion_seen").get()).toEqual({ n: 0 });
	expect(recoverAccepted(h.app)).toBe(1);
	expect(recoverAccepted(h.app)).toBe(0);
	expect(h.app.db.raw.query("SELECT count(*) AS n FROM result_tries").get()).toEqual({ n: 600 });
	expect(gate(input.target.commit).verdict).toBe("passed");
});

test("old unsplit tries rebuild before pending recovery without rewriting historical causes", () => {
	const input = broadReport();
	h.call("report", input);
	dropReceiptSchema(h.app.db);
	h.app.db.raw.exec(`
		UPDATE result_tries SET signature = (SELECT root FROM assertion_roots WHERE signature = result_tries.signature);

		DROP TABLE assertion_seen; DROP TABLE assertion_spreads; DROP TABLE assertion_roots; DROP TABLE assertion_index;
		DROP INDEX results_assertion_rebuild;
		UPDATE meta SET value = '39' WHERE key = 'schema_version';
	`);
	migrate(h.app.db, ":memory:");
	const before = h.app.db.raw.query("SELECT id, signature FROM result_tries ORDER BY id").all();
	inContext((ctx) =>
		acceptReport(
			ctx,
			ReportInput.parse({
				...input,
				attempt: 2,
				results: [{ test: input.results[0]?.test, outcome: "fail", failure: { message: "assertion failed" } }],
			}),
		),
	);
	rebuildAssertionIndexes(h.app.db);
	expect(h.app.db.raw.query("SELECT id, signature FROM result_tries ORDER BY id").all()).toEqual(before);
	expect(recoverAccepted(h.app)).toBe(1);
	expect(page()?.sameCode.signals).toMatchObject([
		{ signature: { text: "assertion failed" }, flips: 1 },
		{ signature: { text: "Split by file (file-0.test.ts): assertion failed" }, flips: 1 },
	]);
});

test("archive import reconstructs roots using full filenames and keeps split-looking original causes", () => {
	const input = broadReport();
	input.results = input.results.map((result, i) => ({
		...result,
		test: { key: result.test.key, file: `part ): file-${i % 6}.test.ts` },
		tries: [failed("Split by file (literal): assertion failed")],
	}));
	h.call("report", input);
	const before = h.app.db.raw.query("SELECT id, signature FROM result_tries ORDER BY id").all();
	const chunks: string[] = [];
	exportArchive(h.app.db, (chunk) => chunks.push(chunk), { now: 1_800_000_000_000 });
	const text = chunks.join("");
	expect(text).not.toContain('"t":"assertion_');
	const to = new Db(":memory:");
	try {
		migrate(to, ":memory:");
		importArchive(to, linesOf(text));
		expect(to.raw.query("SELECT id, signature FROM result_tries ORDER BY id").all()).toEqual(before);
		expect(to.raw.query("SELECT count(*) AS n FROM assertion_seen").get()).toEqual({ n: 51 });
		expect(to.raw.query("SELECT count(*) AS n FROM assertion_roots WHERE root != signature").get()).toEqual({ n: 6 });
	} finally {
		to.close();
	}
});

test("assertion file thresholds use covering index seeks without sorting or scanning duplicate history", () => {
	const queries = declaredSql().filter((text) => text.startsWith("SELECT file FROM assertion_seen"));
	expect(queries).toHaveLength(3);
	for (const text of queries) {
		const params = Object.fromEntries(
			[...text.matchAll(/\$(\w+)/g)].map((match) => [match[1] ?? "", match[1] === "after" ? "file-0" : 1]),
		);
		const plan = h.app.db.raw
			.query<{ detail: string }, [Record<string, string | number>]>(`EXPLAIN QUERY PLAN ${text}`)
			.all(params)
			.map((row) => row.detail)
			.join("\n");
		expect(plan).toContain("SEARCH assertion_seen USING COVERING INDEX assertion_seen_files");
		expect(plan).not.toContain("TEMP B-TREE");
	}
});

test("legacy missing file causes are created only when that file recurs on its broad commit", () => {
	const earlier = Array.from({ length: 40 }, (_, i) => ({ key: `old-file-${i}::test`, file: `old-file-${i}` }));
	h.call("report", broadReport(earlier));
	h.call("report", broadReport(broadTests(20), { job: "later-shard" }));
	const missing = "Split by file (old-file-0): assertion failed";
	h.app.db.raw
		.query("DELETE FROM assertion_roots WHERE signature IN (SELECT id FROM signatures WHERE text = ?)")
		.run(missing);
	h.app.db.raw.query("DELETE FROM signatures WHERE text = ?").run(missing);
	rebuildAssertionIndexes(h.app.db, true);
	expect(h.app.db.raw.query("SELECT 1 FROM signatures WHERE text = ?").get(missing)).toBeNull();
	const another = broadReport(earlier.slice(0, 1), {
		target: { repo: "acme/web", commit: "another-commit", branch: "main" },
	});
	h.call("report", another);
	expect(page()?.sameCode.signals).toMatchObject([{ signature: { text: "assertion failed" }, flips: 2 }]);
	h.call("report", broadReport(broadTests(1), { job: "activate" }));
	expect(h.app.db.raw.query("SELECT 1 FROM signatures WHERE text = ?").get(missing)).toBeNull();
	h.call("report", broadReport(earlier.slice(0, 1), { job: "recurring-file" }));
	expect(h.app.db.raw.query("SELECT 1 FROM signatures WHERE text = ?").get(missing)).not.toBeNull();
	h.call("report", { ...another, attempt: 2 });
	expect(page()?.sameCode.signals).toMatchObject([
		{ signature: { text: "assertion failed" }, flips: 2 },
		{ signature: { text: missing }, flips: 3 },
	]);
});

test("JUnit suffixed testcases pass the gate and record their retry flip through report", () => {
	const parsed = parseReport(
		`<testsuite><testcase name="adds"><failure message="expected 2, got 1"/></testcase><testcase name="adds (retry #1)"/></testsuite>`,
		{ format: "junit", file: "retry.xml" },
	);
	h.call("report", {
		target: { commit: "fedc7331", repo: "acme/web", branch: "main" },
		job: "e2e",
		results: parsed.results,
	});
	expect(gate("fedc7331")).toMatchObject({ verdict: "passed", tally: { pass: 1, unexplained: 0 } });
	expect(page()?.last[0]?.tries).toEqual([{ outcome: "fail", message: "expected 2, got 1", durationMs: null }]);
	expect(page()?.flips).toBe(1);
	expect(row("fedc7331")).toMatchObject({ standing: "pass", flipped: true });
	expect(flaky()).toBe(1);
});

test("JUnit duplicates without an unambiguous retry sequence still count the worse outcome", () => {
	const parsed = parseReport(
		`<testsuite><testcase name="adds"><failure message="expected 2, got 1"/></testcase><testcase name="adds [retry 2]"/></testsuite>`,
		{ file: "retry.xml" },
	);
	h.call("report", {
		target: { commit: "fedc7332", repo: "acme/web", branch: "main" },
		job: "e2e",
		results: parsed.results,
	});
	expect(gate("fedc7332")).toMatchObject({ verdict: "blocked", tally: { pass: 0, unexplained: 1 } });
	expect(page()?.flips).toBe(0);
});

test("distinct JUnit identities sharing a rendered key cannot turn a failure into a retry pass", () => {
	const parsed = parseReport(
		`<testsuite><testcase classname="a" name="b::c"><failure message="real failure"/></testcase><testcase classname="a::b" name="c (retry #1)"/></testsuite>`,
		{ file: "collision.xml" },
	);
	h.call("report", {
		target: { commit: "fedc7333", repo: "acme/web", branch: "main" },
		job: "e2e",
		results: parsed.results,
	});
	expect(gate("fedc7333")).toMatchObject({ verdict: "blocked", tally: { pass: 0, unexplained: 1 } });
	expect(page()?.flips).toBe(0);
});

test("a file prefix and matching classname cannot turn a failure into a retry pass", () => {
	const parsed = parseReport(
		`<testsuite><testcase file="a" name="t"><failure message="real failure"/></testcase><testcase classname="a" name="t (retry #1)"/></testsuite>`,
		{ file: "file-class.xml" },
	);
	h.call("report", {
		target: { commit: "fedc7335", repo: "acme/web", branch: "main" },
		job: "e2e",
		results: parsed.results,
	});
	expect(gate("fedc7335")).toMatchObject({ verdict: "blocked", tally: { pass: 0, unexplained: 1 } });
	expect(page()?.flips).toBe(0);
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

test.each(rawIdentityChanges)("raw JUnit identity changes stay separate: %j", (change) => {
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
	h.call("report", {
		target: { commit: "fedc7336", repo: "acme/web", branch: "main" },
		job: "e2e",
		results: parsed.results,
	});
	expect(gate("fedc7336")).toMatchObject({ verdict: "blocked", tally: { unexplained: 1 } });
	expect(flaky()).toBe(0);
});

test.each(["(retry #1)", "[retry 1]"])(
	"raw identity retains genuine retries despite run-only differences: %s",
	(suffix) => {
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
		h.call("report", {
			target: { commit: "fedc7337", repo: "acme/web", branch: "main" },
			job: "e2e",
			results: parsed.results,
		});
		expect(gate("fedc7337")).toMatchObject({ verdict: "passed", tally: { pass: 1 } });
		expect(flaky()).toBe(1);
	},
);

test("genuine retries in different classes sharing a file and name group independently", () => {
	const xml = `<testsuite>${["t.TestA", "t.TestB"].map((classname) => `<testcase file="t.py" classname="${classname}" name="x"><failure message="real"/></testcase><testcase file="t.py" classname="${classname}" name="x (retry #1)"/>`).join("")}</testsuite>`;
	const parsed = parseReport(xml, { file: "classes.xml" });
	expect(parsed.results).toHaveLength(2);
	for (const result of parsed.results) expect(result).toMatchObject({ outcome: "pass", tries: [{ outcome: "fail" }] });
	h.call("report", {
		target: { commit: "fedc7338", repo: "acme/web", branch: "main" },
		job: "e2e",
		results: parsed.results,
	});
	expect(gate("fedc7338").verdict).toBe("passed");
});

test("raw name whitespace survives the removal of one retry separator", () => {
	const parsed = parseReport(
		`<testsuite><testcase name="x "><failure message="real"/></testcase><testcase name="x  (retry #1)"/></testsuite>`,
		{ file: "name-whitespace.xml" },
	);
	expect(parsed.results).toHaveLength(1);
	expect(parsed.results[0]).toMatchObject({ test: { name: "x " }, outcome: "pass", tries: [{ outcome: "fail" }] });
	h.call("report", {
		target: { commit: "fedc7339", repo: "acme/web", branch: "main" },
		job: "e2e",
		results: parsed.results,
	});
	expect(gate("fedc7339").verdict).toBe("passed");
});
