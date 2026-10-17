import { afterEach, describe, expect, test } from "bun:test";
import { random } from "../src/cli/demo/cases.ts";
import type { InboxReply, ProposeReply } from "../src/core/ops.ts";
import { replacesInLane } from "../src/core/runs.ts";
import type { StatsKind, StatsOf } from "../src/core/stats.ts";
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
