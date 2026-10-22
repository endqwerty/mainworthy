import { afterEach, describe, expect, test } from "bun:test";
import { random } from "../src/cli/demo/cases.ts";
import type { InboxReply, ProposeReply } from "../src/core/ops.ts";
import { replacesInLane } from "../src/core/runs.ts";
import type { StatsKind, StatsOf } from "../src/core/stats.ts";
import { parseJUnit } from "../src/surfaces/formats/junit.ts";
import { parsePlaywright } from "../src/surfaces/formats/playwright.ts";
import { ciReport, type Harness, harness } from "./helpers.ts";

// The reports (issue #56): pass rate over time, flaky tests, time lost to reruns, automation and its backlog, and
// coverage by requirement, each read from the one stream of results.

const DAY = 86_400_000;
let h: Harness;
afterEach(() => h.close());

const stats = <K extends StatsKind>(input: { of: K } & Record<string, unknown>) => h.call<StatsOf<K>>("stats", input);
const manual = (ref: string, outcome: string) =>
	h.call("report", { target: { session: "manual" }, results: [{ test: { case: ref }, outcome }] });
const lastResult = (test: string) => {
	const [view] = h.call<{ last: { id: number }[] }[]>("get", { refs: [test] });
	const id = view?.last[0]?.id;
	if (id === undefined) throw new Error(`no result of ${test}`);
	return id;
};

/**
 * Three automated tests over three days, starting 2027-01-15 08:00 UTC:
 * day 1, commit A: T-2 fails, then passes on a rerun of the same job (11 ms lost, one flip);
 * day 2, commit B: T-3 fails and is corrected to a pass, T-2 fails, and a person is blocked on C-1;
 * day 3: nothing.
 */
function threeDays() {
	h = harness({ unlinked: "track" });
	h.call("propose", { edits: [{ op: "create", outline: "Pay by card\n  Pay > Paid" }] });
	h.call("report", ciReport({ commit: "aaaa0001", n: 3, fail: { 1: "expected 200, got 500" } }));
	h.call("report", ciReport({ commit: "aaaa0001", n: 3, attempt: 2, only: [1] }));
	h.advance(DAY);
	h.call("report", ciReport({ commit: "bbbb0002", n: 3, fail: { 1: "timeout", 2: "wrong total" } }));
	const wrong = lastResult("T-3");
	const corrected = ciReport({ commit: "bbbb0002", n: 3, only: [2] });
	h.call("report", { ...corrected, results: corrected.results.map((r) => ({ ...r, corrects: wrong })) });
	manual("C-1", "blocked");
	h.advance(DAY);
}

describe("pass rate over time", () => {
	test("each day counts the result each test's lane ended with: a rerun and a correction replace what they repeat", () => {
		threeDays();
		const read = stats({ of: "pass-rate", days: 3 });
		expect(read.zone).toBe("UTC");
		expect(read.days).toEqual([
			{ day: "2027-01-15", pass: 3, fail: 0, skip: 0, blocked: 0, quarantined: 0, rate: 1 },
			{ day: "2027-01-16", pass: 2, fail: 1, skip: 0, blocked: 1, quarantined: 0, rate: 2 / 3 },
			{ day: "2027-01-17", pass: 0, fail: 0, skip: 0, blocked: 0, quarantined: 0, rate: null },
		]);
		expect(read.total).toEqual({ pass: 5, fail: 1, skip: 0, blocked: 1, quarantined: 0, rate: 5 / 6 });
	});

	test("the days are the reader's: in Honolulu the first report was on the evening of the 14th", () => {
		threeDays();
		const read = stats({ of: "pass-rate", days: 3, zone: "Pacific/Honolulu" });
		expect(read.days.map((d) => [d.day, d.pass + d.fail + d.blocked])).toEqual([
			["2027-01-14", 3],
			["2027-01-15", 4],
			["2027-01-16", 0],
		]);
	});

	test("one producer's results alone, and a day outside the window is not read", () => {
		threeDays();
		expect(stats({ of: "pass-rate", days: 3, method: "human" }).total).toMatchObject({
			pass: 0,
			fail: 0,
			blocked: 1,
			rate: null,
		});
		expect(stats({ of: "pass-rate", days: 2 }).total).toMatchObject({ pass: 2, fail: 1, blocked: 1 });
	});

	test("a quarantined test's failure is counted apart and does not lower the rate", () => {
		h = harness({ unlinked: "track" });
		h.call("report", ciReport({ commit: "aaaa0001", n: 2, fail: { 1: "flaky socket" } }));
		const p = h.call<ProposeReply>("propose", {
			edits: [{ op: "quarantine", test: "T-2", base: null, exit: { kind: "person" } }],
			reason: "Unreliable",
		});
		const q = h.call<InboxReply>("inbox", { kind: "adopt" }).items.find((item) => item.q === p.question);
		if (!q) throw new Error("no quarantine question");
		h.call("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "accept" }, reason: "repairing" });
		h.call("report", ciReport({ commit: "aaaa0002", n: 2, fail: { 1: "flaky socket" } }));
		expect(stats({ of: "pass-rate", days: 1 }).total).toEqual({
			pass: 2,
			fail: 1,
			skip: 0,
			blocked: 0,
			quarantined: 1,
			rate: 2 / 3,
		});
	});

	test("a window is 1 to 90 days, and a time zone the platform does not know is refused", () => {
		h = harness();
		for (const input of [
			{ of: "pass-rate", days: 91 },
			{ of: "pass-rate", days: 0 },
			{ of: "pass-rate", zone: "Mars/Olympus" },
			{ of: "pass-rate", zone: "+05:37" },
			{ of: "everything" },
		]) {
			const reply = h.raw("stats", input);
			expect(reply.ok ? "accepted" : reply.error.code).toBe("invalid");
		}
	});
});

describe("the pass rate counts what a gate counts", () => {
	test("random reports of two jobs, attempts in order: each lane counts the result replacesInLane folds to", () => {
		h = harness({ unlinked: "track" });
		const rng = random(56);
		const outcomes = ["pass", "fail", "error", "skip", "blocked"] as const;
		type Sent = { attempt: number; outcome: string };
		const lanes = new Map<string, Sent[]>();
		for (const job of ["e2e", "unit"])
			for (let attempt = 1; attempt <= 3; attempt++)
				for (let again = 0; again < 2; again++) {
					const results = [0, 1, 2, 3, 4, 5].flatMap((i) => {
						if (attempt > 1 && rng() < 0.4) return [];
						const outcome = outcomes[Math.floor(rng() * outcomes.length)] ?? "pass";
						const key = `${job}:${i}`;
						lanes.set(key, [...(lanes.get(key) ?? []), { attempt, outcome }]);
						const message = outcome === "fail" || outcome === "error" ? `broke ${i}` : undefined;
						return [
							{
								test: { key: `tests/a.spec.ts::t${i}`, name: `t${i}`, file: "tests/a.spec.ts" },
								outcome,
								...(message ? { failure: { message } } : {}),
							},
						];
					});
					if (results.length > 0)
						h.call("report", { target: { commit: "cafe0001", branch: "main" }, job, attempt, results });
				}
		const expected = { pass: 0, fail: 0, skip: 0, blocked: 0 };
		for (const sent of lanes.values()) {
			let held: Sent | undefined;
			for (const next of sent) if (!held || replacesInLane(held, next)) held = next;
			const outcome = held?.outcome === "error" ? "fail" : held?.outcome;
			if (outcome) expected[outcome as keyof typeof expected] += 1;
		}
		expect(stats({ of: "pass-rate", days: 1 }).total).toMatchObject(expected);
	});
});

describe("flaky tests and time lost to reruns", () => {
	test("reported result and try durations are limited to 30 days at the operation boundary", () => {
		h = harness({ unlinked: "track" });
		const one = ciReport({ commit: "aaaa0001", n: 1 });
		for (const durationMs of [0, 2_592_000_000, 2_592_000_001, 9_000_000_000_000_000]) {
			for (const field of ["result", "try"]) {
				const reply = h.raw("report", {
					...one,
					results: one.results.map((r) => ({
						...r,
						...(field === "result" ? { durationMs } : { tries: [{ outcome: "pass", durationMs }] }),
					})),
				});
				expect([field, durationMs, reply.ok ? "accepted" : reply.error.code]).toEqual([
					field,
					durationMs,
					durationMs <= 2_592_000_000 ? "accepted" : "invalid",
				]);
			}
		}
	});

	test("large runner totals and historical durations stay readable with bounded per-test and headline time", () => {
		h = harness({ unlinked: "track" });
		for (let target = 0; target < 11; target++) {
			const one = ciReport({ commit: `aaaa${target.toString().padStart(4, "0")}`, n: 2 });
			h.call("report", {
				...one,
				results: one.results.map((r) => ({
					...r,
					tries: Array.from({ length: 100 }, () => ({ outcome: "pass", durationMs: 2_592_000_000 })),
				})),
			});
		}
		expect(stats({ of: "reruns", days: 1 })).toMatchObject({ reruns: 2200, lostMs: 5_702_400_000_000, unknown: 0 });
		// Earlier builds and archives can contain durations above today's input limit.
		h.app.db.raw.exec("UPDATE result_tries SET duration_ms = 9000000000000000");
		expect(stats({ of: "reruns", days: 1 })).toMatchObject({
			reruns: 2200,
			lostMs: Number.MAX_SAFE_INTEGER,
			unknown: 0,
			items: [{ lostMs: Number.MAX_SAFE_INTEGER }, { lostMs: Number.MAX_SAFE_INTEGER }],
		});
		// Each execution's own sum can overflow too, before costs are added across executions.
		h.app.db.raw.exec("UPDATE result_tries SET duration_ms = 9000000000000000000");
		expect(stats({ of: "reruns", days: 1 })).toMatchObject({ reruns: 2200, lostMs: Number.MAX_SAFE_INTEGER });
	});

	test("historical repeated pipeline durations cannot overflow the reruns report", () => {
		h = harness({ unlinked: "track" });
		for (const attempt of [1, 2, 3]) h.call("report", ciReport({ commit: "aaaa0001", n: 1, attempt }));
		h.app.db.raw.exec("UPDATE results SET duration_ms = 9000000000000000000");
		expect(stats({ of: "reruns", days: 1 })).toMatchObject({
			reruns: 2,
			lostMs: Number.MAX_SAFE_INTEGER,
			unknown: 0,
			items: [{ lostMs: Number.MAX_SAFE_INTEGER }],
		});
	});

	test("a runner's earlier tries count once, including unknown durations and tries that did not fail", () => {
		h = harness({ unlinked: "track" });
		const one = ciReport({ commit: "aaaa0001", n: 1 });
		h.call("report", {
			...one,
			results: one.results.map((r) => ({
				...r,
				durationMs: 100,
				tries: [
					{ outcome: "fail", durationMs: 11, failure: { message: "socket hang up" } },
					{ outcome: "error", durationMs: 22, failure: { message: "runner stopped" } },
					{ outcome: "skip", durationMs: 0 },
					{ outcome: "pass" },
				],
			})),
		});
		expect(stats({ of: "reruns", days: 1 })).toEqual({
			of: "reruns",
			reruns: 4,
			lostMs: 33,
			unknown: 1,
			items: [{ test: "T-1", name: "test 0", file: "tests/checkout.spec.ts", case: null, reruns: 4, lostMs: 33 }],
		});
		h.advance(2 * DAY);
		expect(stats({ of: "reruns", days: 1 })).toMatchObject({ reruns: 0, lostMs: 0, unknown: 0, items: [] });
	});

	test("repeated Surefire attempts keep their untimed tries unknown beside the testcase's time", () => {
		h = harness({ unlinked: "track" });
		const parsed = parseJUnit(`<testsuite><testcase classname="CartTest" name="adds" time="5.0">
			<flakyFailure message="first failure"/><flakyFailure message="second failure"/>
		</testcase></testsuite>`);
		for (const attempt of [1, 2]) {
			h.call("report", {
				target: { commit: "aaaa0001", branch: "main" },
				job: "unit",
				attempt,
				results: parsed.results,
			});
			expect(stats({ of: "reruns", days: 1 })).toMatchObject(
				attempt === 1 ? { reruns: 2, lostMs: 0, unknown: 2 } : { reruns: 5, lostMs: 5000, unknown: 4 },
			);
		}
	});

	test("a correction can add runner tries, and a worse duplicate without tries still decides the attempt", () => {
		h = harness({ unlinked: "track" });
		const one = ciReport({ commit: "aaaa0001", n: 1 });
		h.call("report", one);
		h.call("report", {
			...one,
			results: one.results.map((r) => ({
				...r,
				corrects: lastResult("T-1"),
				tries: [{ outcome: "pass", durationMs: 10 }],
			})),
		});
		expect(stats({ of: "reruns", days: 1 })).toMatchObject({ reruns: 1, lostMs: 10, unknown: 0 });
		h.call("report", {
			...one,
			results: one.results.map((r) => ({ ...r, outcome: "fail", failure: { message: "broken" } })),
		});
		expect(stats({ of: "reruns", days: 1 })).toMatchObject({ reruns: 0, lostMs: 0, unknown: 0, items: [] });
	});

	test("runner retries and pipeline reruns count together without adding Playwright's summed time twice", () => {
		h = harness({ unlinked: "track" });
		const parsed = parsePlaywright({
			suites: [
				{
					title: "cart",
					file: "cart.spec.ts",
					specs: [
						{
							title: "adds",
							file: "cart.spec.ts",
							tests: [
								{
									projectName: "chromium",
									expectedStatus: "passed",
									results: [
										{ status: "failed", duration: 10, retry: 0, error: { message: "socket hang up" } },
										{ status: "passed", duration: 20, retry: 1 },
									],
								},
							],
						},
					],
				},
			],
		});
		const send = (attempt: number) =>
			h.call("report", {
				target: { commit: "aaaa0001", branch: "main" },
				job: "e2e",
				attempt,
				results: parsed.results,
			});
		send(1);
		expect(stats({ of: "reruns", days: 1 })).toMatchObject({ reruns: 1, lostMs: 10, unknown: 0 });
		send(2);
		// The first attempt's 30 ms already contains its 10 ms try; only attempt 2's try adds another 10 ms.
		expect(stats({ of: "reruns", days: 1 })).toMatchObject({ reruns: 3, lostMs: 40, unknown: 0 });
		send(2);
		expect(stats({ of: "reruns", days: 1 })).toMatchObject({ reruns: 3, lostMs: 40, unknown: 0 });
		h.call("report", {
			target: { commit: "aaaa0001", branch: "main" },
			job: "unit",
			attempt: 99,
			results: parsed.results,
		});
		h.call("report", {
			target: { commit: "bbbb0002", branch: "main" },
			job: "e2e",
			attempt: 99,
			results: parsed.results,
		});
		// Neither another job nor another commit repeats e2e's final attempt; each contributes only its own try.
		expect(stats({ of: "reruns", days: 1 })).toMatchObject({ reruns: 5, lostMs: 60, unknown: 0 });
	});

	test("a correction replaces runner tries at their original attempt and window, with worse-then-later ranking", () => {
		h = harness({ unlinked: "track" });
		const one = ciReport({ commit: "aaaa0001", n: 1 });
		const send = (extra: Record<string, unknown>, attempt = 1) =>
			h.call("report", {
				...one,
				attempt,
				results: one.results.map((r) => ({ ...r, ...extra })),
			});
		send({
			outcome: "fail",
			failure: { message: "socket hang up" },
			durationMs: 30,
			tries: [{ outcome: "pass", durationMs: 10 }],
		});
		const original = lastResult("T-1");
		send({ durationMs: 100, tries: [{ outcome: "pass", durationMs: 80 }] });
		expect(stats({ of: "reruns", days: 1 })).toMatchObject({ reruns: 1, lostMs: 10 });
		send({ durationMs: 40, corrects: original, tries: [{ outcome: "pass", durationMs: 20 }] }, 3);
		expect(stats({ of: "reruns", days: 1 })).toMatchObject({ reruns: 1, lostMs: 20 });
		h.advance(2 * DAY);
		send({ durationMs: 50, corrects: lastResult("T-1"), tries: [{ outcome: "pass", durationMs: 25 }] }, 3);
		expect(stats({ of: "reruns", days: 1 })).toMatchObject({ reruns: 0, lostMs: 0 });
		expect(stats({ of: "reruns", days: 3 })).toMatchObject({ reruns: 1, lostMs: 25 });
		send({ durationMs: 60 }, 2);
		expect(stats({ of: "reruns", days: 3 })).toMatchObject({ reruns: 2, lostMs: 50 });
	});

	test("an untimed repeated attempt keeps its known try durations and counts the missing ones", () => {
		h = harness({ unlinked: "track" });
		const one = ciReport({ commit: "aaaa0001", n: 1 });
		h.call("report", {
			...one,
			results: one.results.map((r) => ({
				...r,
				durationMs: undefined,
				tries: [{ outcome: "pass", durationMs: 10 }, { outcome: "skip" }],
			})),
		});
		h.call("report", { ...one, attempt: 2 });
		expect(stats({ of: "reruns", days: 1 })).toMatchObject({ reruns: 3, lostMs: 10, unknown: 2 });
		const first = h
			.call<{ last: { id: number; attempt: number }[] }[]>("get", { refs: ["T-1"] })[0]
			?.last.find((row) => row.attempt === 1);
		if (!first) throw new Error("no first attempt");
		h.call("report", {
			...one,
			results: one.results.map((r) => ({
				...r,
				corrects: first.id,
				durationMs: 30,
				tries: [{ outcome: "pass", durationMs: 10 }, { outcome: "skip" }],
			})),
		});
		// A reported duration does not cover an untimed try: Surefire reports only one execution's time.
		expect(stats({ of: "reruns", days: 1 })).toMatchObject({ reruns: 3, lostMs: 30, unknown: 1 });
	});

	test("a test that failed and passed on the same code is flaky, and the attempt that was run again is time lost", () => {
		threeDays();
		expect(stats({ of: "flaky", days: 3 })).toEqual({
			of: "flaky",
			tests: 3,
			flaky: 1,
			items: [
				{
					test: "T-2",
					name: "test 1",
					file: "tests/checkout.spec.ts",
					case: null,
					flips: 1,
					lastAt: expect.any(Number),
					quarantined: false,
				},
			],
		});
		expect(stats({ of: "reruns", days: 3 })).toEqual({
			of: "reruns",
			reruns: 1,
			lostMs: 11,
			unknown: 0,
			items: [{ test: "T-2", name: "test 1", file: "tests/checkout.spec.ts", case: null, reruns: 1, lostMs: 11 }],
		});
		// The rerun was on the first day, which a window of the last day does not reach.
		expect(stats({ of: "flaky", days: 1 })).toMatchObject({ flaky: 0, items: [] });
		expect(stats({ of: "reruns", days: 1 })).toEqual({ of: "reruns", reruns: 0, lostMs: 0, unknown: 0, items: [] });
	});
});

describe("what a flip and a rerun are (review of #461)", () => {
	test("a flip whose failure its producer corrected is not flaky", () => {
		h = harness({ unlinked: "track" });
		h.call("report", ciReport({ commit: "aaaa0001", n: 2, fail: { 1: "socket hang up" } }));
		const failed = lastResult("T-2");
		h.call("report", ciReport({ commit: "aaaa0001", n: 2, attempt: 2, only: [1] }));
		expect(stats({ of: "flaky", days: 1 })).toMatchObject({ flaky: 1 });
		const fixed = ciReport({ commit: "aaaa0001", n: 2, only: [1] });
		h.call("report", { ...fixed, results: fixed.results.map((r) => ({ ...r, corrects: failed })) });
		expect(stats({ of: "flaky", days: 1 })).toMatchObject({ flaky: 0, items: [] });
	});

	test("a case run by hand that failed and then passed is no automated test that flipped", () => {
		h = harness({ unlinked: "track" });
		h.call("propose", { edits: [{ op: "create", outline: "Manual check\n  Look > Fine" }] });
		const run = (outcome: string, attempt: number) =>
			h.call("report", {
				target: { commit: "aaaa0001", branch: "main" },
				attempt,
				results: [{ test: { case: "C-1" }, outcome }],
			});
		run("fail", 1);
		run("pass", 2);
		expect(stats({ of: "flaky", days: 1 })).toMatchObject({ tests: 0, flaky: 0, items: [] });
	});

	test("an automated test an agent reports is one of the automated tests", () => {
		h = harness({ unlinked: "track" });
		h.call("report", ciReport({ commit: "aaaa0001", n: 2 }));
		const agent = h.actor("reviewer", "agent", ["read", "produce"]);
		const extra = ciReport({ commit: "aaaa0001", n: 3, only: [2] });
		h.call("report", { ...extra, method: "agent" }, agent);
		expect(stats({ of: "flaky", days: 1 })).toMatchObject({ tests: 3 });
	});

	test("a correction sent with a later attempt still leaves the first attempt repeated (verifier, round 2)", () => {
		for (const batchAttempt of [1, 2, 3]) {
			h = harness({ unlinked: "track" });
			const first = ciReport({ commit: "aaaa0001", n: 1, fail: { 0: "socket hang up" } });
			h.call("report", { ...first, results: first.results.map((r) => ({ ...r, durationMs: 10 })) });
			const failed = lastResult("T-1");
			const second = ciReport({ commit: "aaaa0001", n: 1, attempt: 2 });
			h.call("report", { ...second, results: second.results.map((r) => ({ ...r, durationMs: 20 })) });
			const fix = ciReport({ commit: "aaaa0001", n: 1, attempt: batchAttempt });
			h.call("report", { ...fix, results: fix.results.map((r) => ({ ...r, durationMs: 999, corrects: failed })) });
			// The correction stands in place of the attempt it corrects, its time included, whatever attempt it came with.
			expect([batchAttempt, stats({ of: "reruns", days: 1 })]).toMatchObject([
				batchAttempt,
				{ reruns: 1, lostMs: 999 },
			]);
			h.close();
		}
		h = harness();
	});

	test("legacy branching corrections count the worse of what stands, not the longest chain (verifier, round 3)", () => {
		h = harness({ unlinked: "track" });
		const send = (outcome: "pass" | "fail", durationMs: number, extra: Record<string, unknown> = {}, attempt = 1) => {
			const one = ciReport({
				commit: "aaaa0001",
				n: 1,
				attempt,
				...(outcome === "fail" ? { fail: { 0: "broke" } } : {}),
			});
			h.call("report", { ...one, results: one.results.map((r) => ({ ...r, durationMs, ...extra })) });
			return lastResult("T-1");
		};
		const original = send("fail", 10);
		send("pass", 20, {}, 2);
		const first = send("pass", 999, { corrects: original });
		send("pass", 777, { corrects: first });
		const sibling = send("fail", 555);
		// Stored history from before second corrections were refused still folds, including after archive import.
		h.app.db.raw.query("UPDATE results SET corrects = ? WHERE id = ?").run(original, sibling);
		// Two corrections stand, 777 ms (pass) and 555 ms (fail): the attempt counts the worse, as the gate does.
		expect(stats({ of: "reruns", days: 1 })).toMatchObject({ reruns: 1, lostMs: 555 });
	});

	test("two results of one attempt and then a rerun are one rerun, timed by the result that attempt counted", () => {
		h = harness({ unlinked: "track" });
		const first = ciReport({ commit: "aaaa0001", n: 1, fail: { 0: "socket hang up" } });
		h.call("report", { ...first, results: first.results.map((r) => ({ ...r, durationMs: 40 })) });
		h.call("report", {
			...first,
			results: first.results.map((r) => ({ ...r, outcome: "pass", failure: undefined, durationMs: 7 })),
		});
		h.call("report", ciReport({ commit: "aaaa0001", n: 1, attempt: 2 }));
		expect(stats({ of: "reruns", days: 1 })).toMatchObject({ reruns: 1, lostMs: 40, unknown: 0 });
	});
});

/**
 * C-1 to C-3 are made for the pipeline's three tests (C-2's fails); C-4 to C-6 are run by hand, and want automation,
 * have no say, and cannot be automated; C-3 is then archived. REQ-1 is covered by C-1 and C-4, REQ-2 by C-2 and C-5,
 * REQ-3 by C-6, and REQ-4 only by the archived C-3.
 */
function suite() {
	h = harness({ unlinked: "create" });
	h.call("report", ciReport({ commit: "aaaa0001", n: 3, fail: { 1: "expected 200, got 500" } }));
	const made = (title: string, automate: string) => ({
		op: "create",
		body: { title, methods: ["human"], automate },
	});
	h.call("propose", {
		edits: [made("Gift wrap", "wanted"), made("Store pickup", "none"), made("Printed receipt", "not-applicable")],
	});
	const covers: [string, string][] = [
		["C-1", "REQ-1"],
		["C-4", "REQ-1"],
		["C-2", "REQ-2"],
		["C-5", "REQ-2"],
		["C-6", "REQ-3"],
		["C-3", "REQ-4"],
	];
	h.call("propose", {
		edits: covers.map(([ref, requirement]) => ({ op: "cover", case: ref, requirement, on: true })),
	});
	h.call("propose", { edits: [{ op: "state", cases: ["C-3"], to: "archived" }] });
	manual("C-4", "blocked");
	manual("C-4", "pass");
	manual("C-5", "pass");
}

describe("automation and its backlog", () => {
	test("manual time stays bounded for historical durations and distinguishes zero from unreported", () => {
		h = harness();
		h.call("propose", {
			edits: ["Large", "Zero", "Untimed"].map((title) => ({
				op: "create",
				body: { title, methods: ["human"], automate: "wanted" },
			})),
		});
		for (let i = 0; i < 1025; i++)
			h.call("report", {
				target: { session: `manual-${i}` },
				results: [{ test: { case: "C-1" }, outcome: "pass", durationMs: 1 }],
			});
		// Historical and restored rows are not restricted by today's report input limit.
		h.app.db.raw.exec("UPDATE results SET duration_ms = 9000000000000000");
		h.call("report", {
			target: { session: "zero" },
			results: [{ test: { case: "C-2" }, outcome: "pass", durationMs: 0 }],
		});
		manual("C-3", "pass");
		expect(stats({ of: "automation" }).backlog).toEqual([
			{ case: "C-1", title: "Large", automate: "wanted", runs: 1025, timeMs: Number.MAX_SAFE_INTEGER },
			{ case: "C-2", title: "Zero", automate: "wanted", runs: 1, timeMs: 0 },
			{ case: "C-3", title: "Untimed", automate: "wanted", runs: 1, timeMs: null },
		]);
	});

	test("the rate leaves out what cannot be automated, and the backlog puts the most run by hand first", () => {
		suite();
		expect(stats({ of: "automation" })).toEqual({
			of: "automation",
			cases: 5,
			automated: 2,
			manual: { wanted: 1, none: 1, notApplicable: 1 },
			rate: 0.5,
			backlog: [
				{ case: "C-4", title: "Gift wrap", automate: "wanted", runs: 2, timeMs: null },
				{ case: "C-5", title: "Store pickup", automate: "none", runs: 1, timeMs: null },
			],
		});
	});
});

describe("coverage by requirement", () => {
	test("each requirement counts its active cases by the latest result of their tests", () => {
		suite();
		expect(stats({ of: "coverage" })).toEqual({
			of: "coverage",
			requirements: 4,
			covered: 3,
			items: [
				{ key: "REQ-1", title: "", cases: 2, passed: 2, failed: 0, other: 0, notRun: 0 },
				{ key: "REQ-2", title: "", cases: 2, passed: 1, failed: 1, other: 0, notRun: 0 },
				{ key: "REQ-3", title: "", cases: 1, passed: 0, failed: 0, other: 0, notRun: 1 },
				{ key: "REQ-4", title: "", cases: 0, passed: 0, failed: 0, other: 0, notRun: 0 },
			],
		});
	});
});
