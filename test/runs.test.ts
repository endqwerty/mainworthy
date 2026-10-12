// Three producers, one run: planned runs, slots and what may fill them (fixtures E1, E3, E7 in the design).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { GateStatus, InboxReply, PlanReply, ReportReceipt } from "../src/core/ops.ts";
import { type Harness, harness } from "./helpers.ts";

let h: Harness;
afterEach(() => h.close());

type Slot = {
	id: number;
	case: string;
	version: number;
	state: string;
	fills: { by: string; method: string; outcome: string; admitted: string; result: number }[];
};
type RunView = {
	ref: string;
	state: string;
	verdict: string;
	reason: string;
	tally: Record<string, number>;
	slots: number;
};

const seed = (n = 3) =>
	h.call("propose", {
		edits: Array.from({ length: n }, (_, i) => ({
			op: "create",
			outline: `Case ${i + 1}\n  Do thing ${i + 1} > It works`,
			folder: "checkout",
			tags: ["regression"],
		})),
	});
const run = (ref: string) => {
	const view = h.call<RunView[]>("get", { refs: [ref] })[0];
	if (!view) throw new Error("no run");
	return view;
};
const slots = (ref: string) => h.call<{ items: Slot[] }>("find", { in: "slots", run: ref }).items;
const record = (runRef: string, caseRef: string, outcome: string, extra: Record<string, unknown> = {}, as = h.owner) =>
	h.call<ReportReceipt>("report", { run: runRef, results: [{ test: { case: caseRef }, outcome, ...extra }] }, as);
const queue = () => h.call<InboxReply>("inbox");
const first = <T>(items: T[]): T => {
	const item = items[0];
	if (item === undefined) throw new Error("expected at least one item");
	return item;
};
/** Links the automated test `key` to a case by answering the `map` question of a standard project. */
function link(key: string, caseRef: string, commit: string) {
	h.call("report", {
		target: { commit, branch: "main" },
		results: [{ test: { key, file: key.split("::")[0] }, outcome: "pass" }],
	});
	const map = first(h.call<InboxReply>("inbox", { kind: "map" }).items);
	const test = first((map.evidence as { tests: { t: string }[] }).tests).t;
	h.call("decide", { q: map.q, onEvidence: map.evidenceHash, answer: { is: "link", pairs: [[test, caseRef]] } });
}

describe("a run typed by hand", () => {
	beforeEach(() => {
		h = harness();
		seed();
	});

	test("pins each case's version, starts pending, and closes by a recorded rule once every slot passes", () => {
		const planned = h.call<PlanReply>("plan", {
			name: "1.4.0 rc3 regression",
			select: { folders: ["checkout"], tags: ["regression"] },
		});
		expect(planned).toEqual({ run: "R-1", slots: 3, already: 0 });
		expect(run("R-1")).toMatchObject({ state: "open", verdict: "pending", reason: "pending: 3 results missing" });

		const receipt = record("R-1", "C-1", "pass");
		expect(receipt.basis).toEqual({ exact: 1, assumed: 0, unresolved: 0 }); // the slot pinned the version
		record("R-1", "C-2", "pass");
		expect(run("R-1").tally).toMatchObject({ pass: 2, missing: 1 });
		record("R-1", "C-3", "pass");

		expect(run("R-1")).toMatchObject({ state: "closed", verdict: "passed" });
		const ledger = h.call<InboxReply>("inbox", { state: "decided", kind: "signoff" });
		expect(first(ledger.items).decision).toMatchObject({
			answer: { is: "approve" },
			rule: "signoff-passed",
			by: ["policy"],
		});
	});

	test("a failure opens a question in the run's own scope; the run is blocked until it is answered", () => {
		h.call("plan", { name: "smoke", select: { folders: ["checkout"] } });
		record("R-1", "C-1", "pass");
		record("R-1", "C-2", "fail", {
			note: "Total shows $100.00 after SAVE10",
			steps: [{ step: "x1", outcome: "fail" }],
		});
		expect(run("R-1")).toMatchObject({ verdict: "blocked" });
		const q = first(queue().items);
		expect(q).toMatchObject({ kind: "failure", producer: "human", title: "Total shows $100.00 after SAVE10" });
		expect(q.blocks).toEqual(["R-1"]);
		h.call("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "defect", ref: "WEB-301" } });
		expect(run("R-1")).toMatchObject({ verdict: "failed" });
	});

	test("recording again replaces your own earlier result for that case; both stay in the history", () => {
		h.call("plan", { name: "smoke", select: { cases: ["C-1"] } });
		const failed = record("R-1", "C-1", "fail", { note: "wrong total" });
		expect(first(slots("R-1")).state).toBe("failing");
		record("R-1", "C-1", "pass", { corrects: first(failed.results) });
		expect(first(slots("R-1")).state).toBe("satisfied");
		expect(run("R-1")).toMatchObject({ verdict: "passed", state: "closed" });
		expect(h.app.db.raw.query<{ n: number }, []>("SELECT count(*) AS n FROM results").get()?.n).toBe(2);
	});

	test("blocked and skipped are not proof: the run stays pending", () => {
		h.call("plan", { name: "smoke", select: { cases: ["C-1", "C-2"] } });
		record("R-1", "C-1", "pass");
		record("R-1", "C-2", "blocked", { note: "env down" });
		expect(run("R-1")).toMatchObject({ verdict: "pending", state: "open" });
		expect(run("R-1").tally).toMatchObject({ pass: 1, missing: 1, skipped: 1 });
	});

	test("E7: a case edited or moved after the run started keeps its slot and its pinned version", () => {
		h.call("plan", { name: "smoke", select: { cases: ["C-1"] } });
		h.call("propose", {
			edits: [
				{ op: "edit", case: "C-1", base: 1, body: { title: "Renamed" } },
				{ op: "place", cases: ["C-1"], folder: "elsewhere" },
			],
		});
		expect(first(slots("R-1"))).toMatchObject({ case: "C-1", version: 1 });
		const receipt = record("R-1", "C-1", "pass");
		expect(receipt.basis.exact).toBe(1);
		expect(h.app.db.raw.query<{ v: number }, []>("SELECT basis_version AS v FROM results").get()?.v).toBe(1);
	});

	test("a closed run takes no more results until its sign-off is withdrawn", () => {
		h.call("plan", { name: "smoke", select: { cases: ["C-1"] } });
		record("R-1", "C-1", "pass");
		const refused = h.raw("report", { run: "R-1", results: [{ test: { case: "C-1" }, outcome: "fail" }] });
		expect(refused).toMatchObject({ ok: false, error: { code: "conflict" } });
		const signoff = first(h.call<InboxReply>("inbox", { state: "decided", kind: "signoff" }).items);
		expect(h.call<{ status: string }[]>("decide", { undo: signoff.q })[0]?.status).toBe("reopened");
		expect(run("R-1").state).toBe("open");
	});
});

describe("a run that accepts a build", () => {
	beforeEach(() => {
		h = harness({ preset: "standard" });
		seed();
		link("tests/a.spec.ts::case one", "C-1", "seed0001");
	});

	test("results a pipeline already reported on that commit fill the slots, so nobody repeats them by hand", () => {
		h.call("report", {
			target: { commit: "rc300001", branch: "main" },
			results: [{ test: { key: "tests/a.spec.ts::case one" }, outcome: "pass" }],
		});
		const planned = h.call<PlanReply>("plan", {
			name: "rc3",
			select: { folders: ["checkout"] },
			accepts: { commit: "rc300001" },
		});
		expect(planned).toEqual({ run: "R-3", slots: 3, already: 1 });
		const filled = slots("R-3").find((slot) => slot.case === "C-1");
		expect(filled).toMatchObject({ state: "satisfied" });
		expect(filled?.fills[0]).toMatchObject({ method: "auto", outcome: "pass", admitted: "assumed" });
		expect(run("R-3").tally).toMatchObject({ pass: 1, missing: 2 });
	});

	test("a report that arrives after the run started fills it too", () => {
		h.call("report", {
			target: { commit: "rc300002", branch: "main" },
			results: [{ test: { key: "tests/other.spec.ts::x" }, outcome: "pass" }],
		});
		h.call("plan", { name: "rc3", select: { cases: ["C-1"] }, accepts: { commit: "rc300002" } });
		expect(first(slots("R-3")).state).toBe("missing");
		h.call("report", {
			target: { commit: "rc300002", branch: "main" },
			job: "late",
			results: [{ test: { key: "tests/a.spec.ts::case one" }, outcome: "pass" }],
		});
		expect(first(slots("R-3")).state).toBe("satisfied");
		expect(run("R-3")).toMatchObject({ verdict: "passed", state: "closed" });
	});

	test("E3: an assumed result does not count when the run asks for an exact basis", () => {
		h.call("report", {
			target: { commit: "rc300003", branch: "main" },
			results: [{ test: { key: "tests/a.spec.ts::case one" }, outcome: "pass" }],
		});
		const exact = [{ id: "exercise", kind: "exercise", methods: ["human", "auto"], minActors: 1, basis: "exact" }];
		const planned = h.call<PlanReply>("plan", {
			name: "strict rc3",
			select: { cases: ["C-1"] },
			accepts: { commit: "rc300003" },
			require: exact,
		});
		expect(planned.already).toBe(0);
		expect(run(planned.run)).toMatchObject({ verdict: "pending" });
		// the same test, annotated with the version it exercised, is exact and counts
		h.call("report", {
			target: { commit: "rc300003", branch: "main" },
			job: "annotated",
			results: [
				{ test: { key: "tests/a.spec.ts::case one" }, annotation: { case: "C-1", version: 1 }, outcome: "pass" },
			],
		});
		expect(first(slots(planned.run)).fills[0]).toMatchObject({ admitted: "exact" });
		expect(run(planned.run)).toMatchObject({ verdict: "passed" });
	});

	test("a slot that asks for a person is not filled by a linked test", () => {
		const humanOnly = [
			{ id: "by-hand", kind: "exercise", methods: ["human"], minActors: 1, basis: "exact-or-assumed" },
		];
		h.call("report", {
			target: { commit: "rc300004", branch: "main" },
			results: [{ test: { key: "tests/a.spec.ts::case one" }, outcome: "pass" }],
		});
		const planned = h.call<PlanReply>("plan", {
			name: "a11y",
			select: { cases: ["C-1"] },
			accepts: { commit: "rc300004" },
			require: humanOnly,
		});
		expect(planned.already).toBe(0);
		expect(first(slots(planned.run)).state).toBe("missing");
	});

	test("E1: a manual fail beside a pipeline pass is disputed until a person decides; a later write never hides it", () => {
		h.call("report", {
			target: { commit: "rc300005", branch: "main" },
			results: [{ test: { key: "tests/a.spec.ts::case one" }, outcome: "pass" }],
		});
		const planned = h.call<PlanReply>("plan", {
			name: "rc3",
			select: { cases: ["C-1"] },
			accepts: { commit: "rc300005" },
		});
		// the run closed by rule on the pipeline's pass; reopen it to test by hand
		const signoff = first(h.call<InboxReply>("inbox", { state: "decided", kind: "signoff" }).items);
		h.call("decide", { undo: signoff.q });
		record(planned.run, "C-1", "fail", { note: "Total is wrong on a real device" });
		expect(first(slots(planned.run)).state).toBe("disputed");
		expect(run(planned.run)).toMatchObject({ verdict: "blocked" });
		const q = first(queue().items);
		expect((q.evidence as { hints: string[] }).hints).toContain("disputed");
		// the producer of the failing result may not settle the dispute under the standard preset
		const own = h.call<{ status: string }[]>("decide", {
			q: q.q,
			onEvidence: q.evidenceHash,
			answer: { is: "mistaken" },
		});
		expect(own[0]?.status).toBe("forbidden");
		const lead = h.actor("mira", "human", ["read", "produce", "answer", "plan"]);
		const settled = h.call<{ status: string }[]>(
			"decide",
			{ q: q.q, onEvidence: q.evidenceHash, answer: { is: "mistaken" } },
			lead,
		);
		expect(settled[0]?.status).toBe("decided");
		expect(first(slots(planned.run)).state).toBe("satisfied");
	});
});

describe("an agent's evidence", () => {
	beforeEach(() => {
		h = harness();
		seed(1);
	});

	test("is recorded and visible, and does not fill a slot unless the run asks for it and the case declares it", () => {
		const agent = h.actor("explorer", "agent", ["read", "produce"]);
		h.call("plan", { name: "default", select: { cases: ["C-1"] } });
		record("R-1", "C-1", "pass", {}, agent);
		expect(first(slots("R-1")).state).toBe("missing");
		const timeline = h.call<{ entries: { t: string; method?: string; by?: string }[] }>("timeline", { ref: "C-1" });
		expect(timeline.entries.find((e) => e.t === "result")).toMatchObject({ method: "agent", by: "explorer" });

		// opt in: the case declares an agent method, and the run names agent
		h.call("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { methods: ["human", "agent"] } }] });
		const withAgents = [
			{ id: "exercise", kind: "exercise", methods: ["human", "agent"], minActors: 1, basis: "exact-or-assumed" },
		];
		const planned = h.call<PlanReply>("plan", {
			name: "agents welcome",
			select: { cases: ["C-1"] },
			require: withAgents,
		});
		record(planned.run, "C-1", "pass", {}, agent);
		expect(first(slots(planned.run))).toMatchObject({ state: "satisfied" });
	});

	test("a review is recorded but is never a runtime pass", () => {
		const agent = h.actor("reviewer", "agent", ["read", "produce"]);
		h.call("plan", { name: "default", select: { cases: ["C-1"] } });
		const hash = h.call<{ hash: string }[]>("get", { refs: ["C-1"] })[0]?.hash;
		const claimed = h.call<{ reviewed: number; opened: string[] }>(
			"claim",
			{ lens: "adversarial-review", reviewed: [`C-1@${hash}`], findings: [] },
			agent,
		);
		expect(claimed).toMatchObject({ reviewed: 1, opened: [] });
		expect(first(slots("R-1")).state).toBe("missing");
		expect(h.call<GateStatus>("gate", { run: "R-1" }).verdict).toBe("pending");
	});
});
