import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { GateStatus, InboxReply } from "../src/core/ops.ts";
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
};
type Results = { count: number; cursor: string | null; items: Row[]; tally: Record<string, number> };

let h: Harness;
beforeEach(() => {
	h = harness({ unlinked: "track" });
});
afterEach(() => h.close());

const COMMIT = "c0ffee0000000000000000000000000000000001";
const target = { commit: COMMIT, repo: "acme/web", branch: "feature", pr: 7 };
const result = (name: string, outcome: string, message?: string) => ({
	test: { key: `tests/shop.spec.ts::${name}`, name, file: "tests/shop.spec.ts" },
	...(name.startsWith("coupon") ? { annotation: { case: "C-1" } } : {}),
	outcome,
	durationMs: 12,
	...(message ? { failure: { message } } : {}),
});
const results = (input: Record<string, unknown> = {}) => h.call<Results>("find", { in: "results", ...input });
const gate = () => h.call<GateStatus>("gate", { commit: COMMIT });
function answer(message: string, is: string) {
	const q = h.call<InboxReply>("inbox", {}).items.find((item) => item.title.includes(message));
	if (!q) throw new Error(`no question about ${message}`);
	h.call("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is }, reason: "checked" });
	return q.q;
}

/** One commit with a result of every kind the gate tells apart, from a case and without one. */
function seed() {
	h.call("propose", { edits: [{ op: "create", outline: "Coupon applies\n  Apply SAVE10 > Total is 90" }] });
	h.call("report", {
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
	h.call("report", { target, job: "e2e", attempt: 2, results: [result("cart removes", "pass")] });
	const flaky = answer("socket hang up", "flaky");
	const defect = answer("TypeError", "defect");
	const open = h.call<InboxReply>("inbox", {}).items.find((item) => item.title.includes("expected $90"))?.q ?? null;
	return { flaky, defect, open };
}

describe("the results behind a gate", () => {
	test("every counted row is listed once, and the rows add up to the gate's tally", () => {
		const { flaky, defect, open } = seed();
		const g = gate();
		const all = results({ commit: COMMIT, limit: 500 });
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

	test("problems come first, and a filter or a page never loses or repeats a row", () => {
		seed();
		const order = results({ commit: COMMIT }).items.map((row) => row.standing);
		expect(order).toEqual(["unexplained", "attributed", "excused", "missing", "skipped", "pass", "pass", "pass"]);

		const seen: string[] = [];
		for (let cursor: string | null = null, pages = 0; pages < 10; pages++) {
			const page: Results = results({ commit: COMMIT, limit: 3, ...(cursor ? { cursor } : {}) });
			seen.push(...page.items.map((row) => row.name));
			cursor = page.cursor;
			if (!cursor) break;
		}
		expect(seen).toHaveLength(8);
		expect(new Set(seen).size).toBe(8);

		expect(
			results({ commit: COMMIT, state: "pass" })
				.items.map((row) => row.name)
				.sort(),
		).toEqual(["cart adds", "cart removes", "coupon"]);
		expect(results({ commit: COMMIT, state: "pass" }).count).toBe(3);
		expect(results({ commit: COMMIT, unlinked: true }).items.every((row) => row.case === null)).toBe(true);
		expect(results({ commit: COMMIT, unlinked: true }).count).toBe(7);
		expect(results({ commit: COMMIT, text: "FLAKES" }).items.map((row) => row.name)).toEqual(["cart flakes"]);
		expect(() => results({ commit: COMMIT, state: "green" })).toThrow(/invalid/);
	});

	test("a change reads its head's rows, and a commit nobody reported has none", () => {
		seed();
		expect(results({ change: "pr:7" }).count).toBe(8);
		const none = results({ commit: "dead000000000000000000000000000000000000" });
		expect(none).toMatchObject({ count: 0, cursor: null, items: [] });
		expect(() => results({})).toThrow(/invalid/);
	});

	test("a quarantined failure is listed as excused, as the gate counts it", () => {
		seed();
		const total = results({ commit: COMMIT, text: "cart total" }).items[0]?.test;
		const p = h.call<{ question: string }>("propose", {
			edits: [{ op: "quarantine", test: total, base: null, exit: { kind: "person" } }],
			reason: "Unreliable",
		});
		const q = h.call<InboxReply>("inbox", { kind: "adopt" }).items.find((item) => item.q === p.question);
		if (!q) throw new Error("quarantine was not queued");
		h.call("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "accept" }, reason: "Repairing it" });
		// A quarantine covers what is reported while it stands: the rerun's failure is the one it excuses.
		h.call("report", {
			target,
			job: "e2e",
			attempt: 3,
			results: [result("cart total", "fail", "expected $90, got $100")],
		});
		const all = results({ commit: COMMIT });
		expect(all.tally).toEqual(gate().tally);
		expect(all.items.find((row) => row.test === total)).toMatchObject({ standing: "excused", quarantined: true });
	});

	test("a test's page names the commit, change and job of each result", () => {
		seed();
		const adds = results({ commit: COMMIT, text: "cart adds" }).items[0]?.test ?? "";
		const [page] = h.call<{ last: Record<string, unknown>[] }[]>("get", { refs: [adds] });
		expect(page?.last[0]).toMatchObject({
			outcome: "pass",
			commit: COMMIT,
			change: "pr:7",
			job: "e2e",
			build: "https://ci.example.com/build/1",
		});
	});
	test("a cursor read after the results changed is refused, so no row is skipped or listed twice", () => {
		seed();
		const first = results({ commit: COMMIT, limit: 6 });
		expect(first.cursor).not.toBeNull();
		// "cart adds" passed and is not on the first page yet; a retry makes it fail, which would sort it before the
		// cursor. Reading on would skip it, so the next page is refused and the list is read again from the start.
		h.call("report", { target, job: "e2e", attempt: 3, results: [result("cart adds", "fail", "now it fails")] });
		expect(() => results({ commit: COMMIT, limit: 6, cursor: first.cursor })).toThrow(/conflict: .*changed/);
		const again = results({ commit: COMMIT, limit: 500 });
		expect(again.items.filter((row) => row.name === "cart adds")).toHaveLength(1);
		expect(again.tally).toEqual(gate().tally);
	});

	test("a filtered cursor is refused once a row joins or leaves the filter (the verifier's finding)", () => {
		const k = harness({ unlinked: "ask" });
		try {
			k.call("propose", { edits: [{ op: "create", outline: "A case" }] });
			k.call("report", ciReport({ commit: "probe001", n: 3 }));
			const q = k.call<InboxReply>("inbox", { kind: "map" }).items[0];
			if (!q) throw new Error("no map question");
			k.call("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "link", pairs: [["T-1", "C-1"]] } });
			const read = (input: Record<string, unknown>) =>
				k.call<Results>("find", { in: "results", commit: "probe001", unlinked: true, ...input });
			const first = read({ limit: 1 });
			expect(first.items.map((row) => row.test)).toEqual(["T-2"]);
			// Undoing the link brings T-1 back into the filter, before the cursor.
			k.call("decide", { undo: q.q });
			expect(() => read({ limit: 500, cursor: first.cursor })).toThrow(/conflict: .*changed/);
			// A cursor is for the query that gave it.
			const fresh = read({ limit: 1 });
			expect(() => read({ limit: 500, cursor: fresh.cursor, unlinked: false })).toThrow(/conflict/);
		} finally {
			k.close();
		}
	});

	test("the list of tests finds a test by its file", () => {
		h.call("report", {
			target,
			job: "e2e",
			results: [{ test: { key: "opaque-id", name: "checks out", file: "specs/needle.spec.ts" }, outcome: "pass" }],
		});
		const found = h.call<{ items: { name: string }[] }>("find", { in: "tests", text: "needle" });
		expect(found.items.map((row) => row.name)).toEqual(["checks out"]);
	});

	test("the list of tests holds only automated tests, not a case run by hand (issue #355)", () => {
		h.call("propose", { edits: [{ op: "create", outline: "Needle case\n  Pay > Paid" }] });
		h.call("report", { target, job: "by hand", results: [{ test: { case: "C-1" }, outcome: "pass" }] });
		h.call("report", {
			target,
			job: "e2e",
			results: [{ test: { key: "needle-auto", name: "needle pays", file: "specs/pay.spec.ts" }, outcome: "pass" }],
		});
		const names = (input: Record<string, unknown>) =>
			h.call<{ items: { name: string }[] }>("find", { in: "tests", ...input }).items.map((row) => row.name);
		expect(names({})).toEqual(["needle pays"]);
		expect(names({ text: "Needle" })).toEqual(["needle pays"]);
		expect(names({ unlinked: true })).toEqual(["needle pays"]);
	});
});
