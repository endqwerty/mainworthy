// A test runner that retries a test inside one run (Playwright's `retries`, Surefire's `rerunFailingTestsCount`)
// reports its earlier tries with the result (decision 0129). The result itself is what the gate counts; the tries
// are evidence: a try that disagrees with the next is a flip, as a retry by the pipeline is.
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { GateStatus } from "../src/core/ops.ts";
import { type Harness, harness } from "./helpers.ts";

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
	sameCode: { signals: { signature: { text: string }; flips: number }[] };
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
