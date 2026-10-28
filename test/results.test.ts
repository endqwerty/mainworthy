import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { GateStatus, InboxReply, ReportReceipt } from "../src/core/ops.ts";
import { sql } from "../src/server/kernel/db.ts";
import { jobOp } from "../src/server/ops/jobs.ts";
import { invokeService } from "../src/server/ops/registry.ts";
import { ciReport, type Harness, harness } from "./helpers.ts";

// What a gate counted, test by test (issue #343): every row a commit's gate counts can be read back, and the
// rows add up to the gate's tally.

type Row = {
	test: string;
	name: string;
	file: string | null;
	case: string | null;
	outcome: string;
	standing: string;
	attempt: number;
	durationMs: number | null;
	message: string | null;
	job: string;
	by: string;
	build: string | null;
	commit: string | null;
	question: string | null;
	flipped: boolean;
	recentFlips: number;
};
type Results = {
	count: number;
	cursor: string | null;
	items: Row[];
	tally: Record<string, number>;
	testTime: { ms: number; timed: number };
	flaky: { flipped: number; failing: number; days: number };
};

let h: Harness;
beforeEach(async () => {
	h = await harness({ unlinked: "track" });
});
afterEach(async () => await h?.close());

const COMMIT = "c0ffee0000000000000000000000000000000001";
const target = { commit: COMMIT, repo: "acme/web", branch: "feature", pr: 7 };
const result = (name: string, outcome: string, message?: string) => ({
	test: { key: `tests/shop.spec.ts::${name}`, name, file: "tests/shop.spec.ts" },
	...(name.startsWith("coupon") ? { annotation: { case: "C-1" } } : {}),
	outcome,
	durationMs: 12,
	...(message ? { failure: { message } } : {}),
});
const results = async (input: Record<string, unknown> = {}) =>
	await h.call<Results>("find", { in: "results", ...input });
const gate = async () => await h.call<GateStatus>("gate", { commit: COMMIT });
async function answer(message: string, is: string) {
	const q = (await h.call<InboxReply>("inbox", {})).items.find((item) => item.title.includes(message));
	if (!q) throw new Error(`no question about ${message}`);
	await h.call("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is }, reason: "checked" });
	return q.q;
}

/** One commit with a result of every kind the gate tells apart, from a case and without one. */
async function seed() {
	await h.call("propose", { edits: [{ op: "create", outline: "Coupon applies\n  Apply SAVE10 > Total is 90" }] });
	await h.call("report", {
		target,
		job: "e2e",
		buildUrl: "https://ci.example.com/build/1",
		results: [
			result("coupon", "pass"),
			result("cart adds", "pass"),
			result("cart removes", "fail", "retried away"),
			result("cart is slow", "skip"),
			result("cart needs stock", "blocked"),
			result("cart total", "fail", "expected $90, got $100"),
			result("cart flakes", "fail", "socket hang up"),
			result("cart breaks", "error", "TypeError: total is undefined"),
		],
	});
	// A rerun of one test in the same job and lane: the second attempt is the one the gate counts.
	await h.call("report", { target, job: "e2e", attempt: 2, results: [result("cart removes", "pass")] });
	const flaky = await answer("socket hang up", "flaky");
	const defect = await answer("TypeError", "defect");
	const open =
		(await h.call<InboxReply>("inbox", {})).items.find((item) => item.title.includes("expected $90"))?.q ?? null;
	return { flaky, defect, open };
}

describe("the results behind a gate", () => {
	test("every counted row is listed once, and the rows add up to the gate's tally", async () => {
		const { flaky, defect, open } = await seed();
		const g = await gate();
		const all = await results({ commit: COMMIT, limit: 500 });
		expect(all.items).toHaveLength(8);
		expect(all.count).toBe(8);
		const tally: Record<string, number> = {};
		for (const row of all.items) tally[row.standing] = (tally[row.standing] ?? 0) + 1;
		for (const [standing, n] of Object.entries(g.tally))
			expect([standing, tally[standing] ?? 0]).toEqual([standing, n]);
		expect(all.tally).toEqual(g.tally);

		const by = (name: string) => all.items.find((row) => row.name === name);
		expect(by("coupon")).toMatchObject({ case: "C-1", outcome: "pass", standing: "pass" });
		expect(by("cart adds")).toMatchObject({
			case: null,
			outcome: "pass",
			standing: "pass",
			file: "tests/shop.spec.ts",
			job: "e2e",
			durationMs: 12,
			build: "https://ci.example.com/build/1",
			commit: COMMIT,
		});
		expect(by("cart removes")).toMatchObject({ outcome: "pass", standing: "pass", attempt: 2 });
		expect(by("cart is slow")).toMatchObject({ outcome: "skip", standing: "skipped" });
		expect(by("cart needs stock")).toMatchObject({ outcome: "blocked", standing: "missing" });
		expect(by("cart total")).toMatchObject({
			outcome: "fail",
			standing: "unexplained",
			message: "expected $90, got $100",
			question: open,
		});
		expect(by("cart flakes")).toMatchObject({ outcome: "fail", standing: "excused", question: flaky });
		expect(by("cart breaks")).toMatchObject({ outcome: "error", standing: "attributed", question: defect });
	});

	test("problems come first, and a filter or a page never loses or repeats a row", async () => {
		await seed();
		const order = (await results({ commit: COMMIT })).items.map((row) => row.standing);
		expect(order).toEqual(["unexplained", "attributed", "excused", "missing", "skipped", "pass", "pass", "pass"]);

		const seen: string[] = [];
		for (let cursor: string | null = null, pages = 0; pages < 10; pages++) {
			const page: Results = await results({ commit: COMMIT, limit: 3, ...(cursor ? { cursor } : {}) });
			seen.push(...page.items.map((row) => row.name));
			cursor = page.cursor;
			if (!cursor) break;
		}
		expect(seen).toHaveLength(8);
		expect(new Set(seen).size).toBe(8);

		expect((await results({ commit: COMMIT, state: "pass" })).items.map((row) => row.name).sort()).toEqual([
			"cart adds",
			"cart removes",
			"coupon",
		]);
		expect((await results({ commit: COMMIT, state: "pass" })).count).toBe(3);
		expect((await results({ commit: COMMIT, unlinked: true })).items.every((row) => row.case === null)).toBe(true);
		expect((await results({ commit: COMMIT, unlinked: true })).count).toBe(7);
		expect((await results({ commit: COMMIT, text: "FLAKES" })).items.map((row) => row.name)).toEqual(["cart flakes"]);
		await expect(results({ commit: COMMIT, state: "green" })).rejects.toThrow(/invalid/);
	});

	test("a change reads its head's rows, and a commit nobody reported has none", async () => {
		await seed();
		expect((await results({ change: "pr:7" })).count).toBe(8);
		const head = "c0ffee0000000000000000000000000000000002";
		await h.call("report", {
			target: { ...target, commit: head },
			job: "e2e",
			results: [result("new head check", "pass")],
		});
		expect(await results({ change: "pr:7" })).toMatchObject({
			count: 1,
			items: [{ name: "new head check", commit: head }],
		});
		expect((await results({ commit: COMMIT })).items.map((row) => row.name).sort()).toEqual([
			"cart adds",
			"cart breaks",
			"cart flakes",
			"cart is slow",
			"cart needs stock",
			"cart removes",
			"cart total",
			"coupon",
		]);
		const none = await results({ commit: "dead000000000000000000000000000000000000" });
		expect(none).toMatchObject({ count: 0, cursor: null, items: [] });
		await expect(results({})).rejects.toThrow(/invalid/);
	});

	test("the test time sums the durations of the results the gate counts, whatever the filter", async () => {
		const timed = (name: string, outcome: string, durationMs?: number) => ({
			test: { key: `tests/time.spec.ts::${name}`, name, file: "tests/time.spec.ts" },
			outcome,
			...(durationMs === undefined ? {} : { durationMs }),
		});
		await h.call("report", {
			target,
			job: "unit",
			results: [timed("fast", "pass", 1200), timed("retried", "fail", 5000), timed("untimed", "skip")],
		});
		// The rerun is the attempt the gate counts, so the first attempt's 5 s is not part of the sum.
		await h.call("report", { target, job: "unit", attempt: 2, results: [timed("retried", "pass", 40)] });
		expect((await results({ commit: COMMIT })).testTime).toEqual({ ms: 1240, timed: 2 });
		expect((await results({ commit: COMMIT, state: "skipped" })).testTime).toEqual({ ms: 1240, timed: 2 });
		expect((await results({ commit: "dead000000000000000000000000000000000000" })).testTime).toEqual({
			ms: 0,
			timed: 0,
		});
	});

	test("the test time stays bounded when historical durations exceed SQLite's integer sum", async () => {
		await h.call("report", { ...ciReport({ commit: COMMIT, n: 1025 }), target });
		// Earlier versions and imported archives can retain durations above today's report limit.
		await h.app.database.write(
			async (db) =>
				await db.transaction(
					async () =>
						await db.run(sql<[], Record<string, unknown>>("UPDATE results SET duration_ms = 9000000000000000")),
				),
		);
		expect(await results({ commit: COMMIT })).toMatchObject({
			count: 1025,
			testTime: { ms: Number.MAX_SAFE_INTEGER, timed: 1025 },
		});
	});

	test("a quarantined failure is listed as excused, as the gate counts it", async () => {
		await seed();
		const total = (await results({ commit: COMMIT, text: "cart total" })).items[0]?.test;
		const p = await h.call<{ question: string }>("propose", {
			edits: [{ op: "quarantine", test: total, base: null, exit: { kind: "person" } }],
			reason: "Unreliable",
		});
		const q = (await h.call<InboxReply>("inbox", { kind: "adopt" })).items.find((item) => item.q === p.question);
		if (!q) throw new Error("quarantine was not queued");
		await h.call("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "accept" }, reason: "Repairing it" });
		// A quarantine covers what is reported while it stands: the rerun's failure is the one it excuses.
		await h.call("report", {
			target,
			job: "e2e",
			attempt: 3,
			results: [result("cart total", "fail", "expected $90, got $100")],
		});
		const all = await results({ commit: COMMIT });
		expect(all.tally).toEqual((await gate()).tally);
		expect(all.items.find((row) => row.test === total)).toMatchObject({ standing: "excused", quarantined: true });
	});

	test("a test that failed and passed on the same commit is flaky, and its next failure says it flipped before", async () => {
		await seed();
		const first = await results({ commit: COMMIT, limit: 500 });
		const by = (rows: Row[], name: string) => rows.find((row) => row.name === name);
		// It failed, then passed on a retry: the gate counts the pass, and the row says the commit saw both.
		expect(by(first.items, "cart removes")).toMatchObject({ standing: "pass", flipped: true, recentFlips: 1 });
		expect(by(first.items, "cart total")).toMatchObject({ standing: "unexplained", flipped: false, recentFlips: 0 });
		expect(first.flaky).toEqual({ flipped: 1, failing: 0, days: 14 });
		// Among the passes, the flaky one comes first, though its retry arrived last.
		expect(first.items.filter((row) => row.standing === "pass").map((row) => row.name)).toEqual([
			"cart removes",
			"coupon",
			"cart adds",
		]);

		// The next commit fails it again: nothing has passed it there, and the row says how often it flipped lately.
		const NEXT = "c0ffee0000000000000000000000000000000002";
		await h.call("report", {
			target: { ...target, commit: NEXT },
			job: "e2e",
			results: [result("cart removes", "fail", "retried away"), result("cart total", "fail", "expected $90, got $100")],
		});
		const next = await results({ commit: NEXT });
		expect(by(next.items, "cart removes")).toMatchObject({ standing: "unexplained", flipped: false, recentFlips: 1 });
		expect(by(next.items, "cart total")).toMatchObject({ standing: "unexplained", flipped: false, recentFlips: 0 });
		expect(next.flaky).toEqual({ flipped: 0, failing: 1, days: 14 });
		// A filter changes the rows, not what the commit as a whole shows.
		expect((await results({ commit: NEXT, text: "cart total" })).flaky).toEqual({ flipped: 0, failing: 1, days: 14 });
	});

	test("a test's page names the commit, change and job of each result", async () => {
		await seed();
		const adds = (await results({ commit: COMMIT, text: "cart adds" })).items[0]?.test ?? "";
		const [page] = await h.call<{ last: Record<string, unknown>[] }[]>("get", { refs: [adds] });
		expect(page?.last[0]).toMatchObject({
			outcome: "pass",
			commit: COMMIT,
			change: "pr:7",
			job: "e2e",
			build: "https://ci.example.com/build/1",
		});
	});
	test("a cursor read after the results changed is refused, so no row is skipped or listed twice", async () => {
		await seed();
		const first = await results({ commit: COMMIT, limit: 6 });
		expect(first.cursor).not.toBeNull();
		// "cart adds" passed and is not on the first page yet; a retry makes it fail, which would sort it before the
		// cursor. Reading on would skip it, so the next page is refused and the list is read again from the start.
		await h.call("report", { target, job: "e2e", attempt: 3, results: [result("cart adds", "fail", "now it fails")] });
		await expect(results({ commit: COMMIT, limit: 6, cursor: first.cursor })).rejects.toThrow(/conflict: .*changed/);
		const again = await results({ commit: COMMIT, limit: 500 });
		expect(again.items.filter((row) => row.name === "cart adds")).toHaveLength(1);
		expect(again.tally).toEqual((await gate()).tally);
	});

	test("a filtered cursor is refused once a row joins or leaves the filter (the verifier's finding)", async () => {
		const k = await harness({ unlinked: "ask" });
		try {
			await k.call("propose", { edits: [{ op: "create", outline: "A case" }] });
			await k.call("report", ciReport({ commit: "probe001", n: 3 }));
			const q = (await k.call<InboxReply>("inbox", { kind: "map" })).items[0];
			if (!q) throw new Error("no map question");
			await k.call("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "link", pairs: [["T-1", "C-1"]] } });
			const read = async (input: Record<string, unknown>) =>
				await k.call<Results>("find", { in: "results", commit: "probe001", unlinked: true, ...input });
			const first = await read({ limit: 1 });
			expect(first.items.map((row) => row.test)).toEqual(["T-2"]);
			// Undoing the link brings T-1 back into the filter, before the cursor.
			await k.call("decide", { undo: q.q });
			await expect(read({ limit: 500, cursor: first.cursor })).rejects.toThrow(/conflict: .*changed/);
			// A cursor is for the query that gave it.
			const fresh = await read({ limit: 1 });
			await expect(read({ limit: 500, cursor: fresh.cursor, unlinked: false })).rejects.toThrow(/conflict/);
		} finally {
			await k.close();
		}
	});

	test("the queue's pages reach every question one report raised, however many share a rank (issue #367)", async () => {
		const k = await harness({ unlinked: "ask" });
		try {
			// One question is raised for each file with tests that no case covers, so each test has its own file.
			const report = ciReport({ commit: "probe002", n: 1100 });
			await k.call("report", {
				...report,
				results: report.results.map((row, i) => ({
					...row,
					test: { ...row.test, key: `tests/file${i}.spec.ts::test ${i}`, file: `tests/file${i}.spec.ts` },
				})),
			});
			await invokeService(k.app, jobOp, { do: "drain" });
			expect((await k.call<InboxReply>("inbox", { limit: 1 })).counts.open).toBe(1100);
			const listed: string[] = [];
			let page = await k.call<InboxReply>("inbox", { limit: 99 });
			for (;;) {
				listed.push(...page.items.map((item) => item.q));
				if (!page.cursor) break;
				page = await k.call<InboxReply>("inbox", { limit: 99, cursor: page.cursor });
			}
			expect(listed).toHaveLength(1100);
			expect(new Set(listed).size).toBe(1100);
			await expect(k.call("inbox", { cursor: "12" })).rejects.toThrow(/not a cursor of the queue/);
		} finally {
			await k.close();
		}
	});

	test("the list of tests finds a test by its file", async () => {
		await h.call("report", {
			target,
			job: "e2e",
			results: [{ test: { key: "opaque-id", name: "checks out", file: "specs/needle.spec.ts" }, outcome: "pass" }],
		});
		const found = await h.call<{ items: { name: string }[] }>("find", { in: "tests", text: "needle" });
		expect(found.items.map((row) => row.name)).toEqual(["checks out"]);
	});

	test("the list of tests holds only automated tests, not a case run by hand (issue #355)", async () => {
		await h.call("propose", { edits: [{ op: "create", outline: "Needle case\n  Pay > Paid" }] });
		await h.call("report", { target, job: "by hand", results: [{ test: { case: "C-1" }, outcome: "pass" }] });
		await h.call("report", {
			target,
			job: "e2e",
			results: [{ test: { key: "needle-auto", name: "needle pays", file: "specs/pay.spec.ts" }, outcome: "pass" }],
		});
		const names = async (input: Record<string, unknown>) =>
			(await h.call<{ items: { name: string }[] }>("find", { in: "tests", ...input })).items.map((row) => row.name);
		expect(await names({})).toEqual(["needle pays"]);
		expect(await names({ text: "Needle" })).toEqual(["needle pays"]);
		expect(await names({ unlinked: true })).toEqual(["needle pays"]);
	});
});

describe("what reads as flaky", () => {
	type Last = { id: number; outcome: string; attempt: number; passedOnRetry: number | null };
	const testPage = async (ref: string) =>
		(await h.call<{ flips: number; last: Last[] }[]>("get", { refs: [ref] }))[0] ?? { flips: -1, last: [] };
	const report = async (commit: string, input: Partial<Parameters<typeof ciReport>[0]> = {}, env?: string) => {
		const sent = ciReport({ commit, n: 2, ...input });
		await h.call("report", env ? { ...sent, target: { ...sent.target, env } } : sent);
	};

	test("a flip whose failure its producer corrected is no flake anywhere (issue #630)", async () => {
		await report("aaaa0001", { fail: { 1: "socket hang up" } });
		const failed = (await testPage("T-2")).last[0]?.id;
		await report("aaaa0001", { attempt: 2, only: [1] });
		expect((await results({ commit: "aaaa0001" })).flaky).toEqual({ flipped: 1, failing: 0, days: 14 });
		expect((await testPage("T-2")).last.find((row) => row.id === failed)?.passedOnRetry).toBe(2);

		const fixed = ciReport({ commit: "aaaa0001", n: 2, attempt: 3, only: [1] });
		await h.call("report", { ...fixed, results: fixed.results.map((r) => ({ ...r, corrects: failed })) });
		const read = await results({ commit: "aaaa0001" });
		expect(read.flaky).toEqual({ flipped: 0, failing: 0, days: 14 });
		expect(read.items.find((row) => row.test === "T-2")).toMatchObject({ flipped: false, recentFlips: 0 });
		const [run] = await h.call<{ flips: number }[]>("get", { refs: ["R-1"] });
		expect(run?.flips).toBe(0);
		const page = await testPage("T-2");
		expect(page.flips).toBe(0);
		expect(page.last.find((row) => row.id === failed)?.passedOnRetry).toBeNull();
	});

	test("a pass in another environment does not make a failure flaky", async () => {
		await report("bbbb0001", { fail: { 1: "boom" } }, "linux");
		await report("bbbb0001", { attempt: 2, only: [1] }, "windows");
		const page = await testPage("T-2");
		expect(page.flips).toBe(0);
		expect(page.last.find((row) => row.outcome === "fail")?.passedOnRetry).toBeNull();
		expect((await results({ commit: "bbbb0001" })).flaky).toEqual({ flipped: 0, failing: 0, days: 14 });

		await report("bbbb0001", { attempt: 3, only: [1] }, "linux");
		expect((await testPage("T-2")).last.find((row) => row.outcome === "fail")?.passedOnRetry).toBe(3);
	});

	test("every failure before the attempt that passed is flaky, not only the last one", async () => {
		await report("cccc0001", { fail: { 1: "boom" } });
		await report("cccc0001", { attempt: 2, only: [1], fail: { 1: "boom" } });
		await report("cccc0001", { attempt: 3, only: [1] });
		const last = (await testPage("T-2")).last;
		expect(last.map((row) => [row.attempt, row.outcome, row.passedOnRetry])).toEqual([
			[3, "pass", null],
			[2, "fail", 3],
			[1, "fail", 3],
		]);
	});
});

test("a correction can name an earlier result of the same report", async () => {
	const input = ciReport({ commit: "same-report-correction", n: 1 });
	const initial = await h.call<ReportReceipt>("report", input);
	const previous = initial.results[0];
	if (previous === undefined) throw new Error("missing initial result");
	const guessed = previous + 1;
	const test = input.results[0]?.test;
	if (!test) throw new Error("missing test");
	const receipt = await h.call<ReportReceipt>("report", {
		...input,
		attempt: 2,
		results: [
			{ test, outcome: "fail", failure: { message: "withdraw this observation" } },
			{ test, outcome: "pass", corrects: guessed },
		],
	});
	expect(receipt.results).toEqual([guessed, guessed + 1]);
	expect(receipt.declined).toEqual([]);
	expect(receipt.gate).toMatchObject({ verdict: "passed", tally: { pass: 1, unexplained: 0 } });
	expect(
		await h.app.database.read(
			async (db) =>
				await db.all(
					sql<readonly [], { id: number; corrects: number | null }>("SELECT id,corrects FROM results ORDER BY id"),
				),
		),
	).toEqual([
		{ id: previous, corrects: null },
		{ id: guessed, corrects: null },
		{ id: guessed + 1, corrects: guessed },
	]);
});

test("test text search preserves literal backslashes in keys, names and files", async () => {
	const tests = [
		{ key: String.raw`win\path\key`, name: "key match" },
		{ key: "name", name: String.raw`win\path\name` },
		{ key: "file", file: String.raw`win\path\check.spec.ts` },
	];
	await h.call("report", {
		target: { commit: "backslash" },
		results: tests.map((test) => ({ test, outcome: "pass" })),
	});
	for (const text of [String.raw`win\path`, "win\\", "WIN%path", "win_path"]) {
		const found = await h.call<{ items: unknown[] }>("find", { in: "tests", text });

		expect(found.items).toHaveLength(3);
	}
});
