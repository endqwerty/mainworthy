// Things that must never happen, each found by an independent review of the engine and reproduced here first.
// One test per promise: what a result may prove, what a decision may change, and what a caller may see.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { emptyBody } from "../src/core/model.ts";
import type { DecideReply, GateStatus, InboxReply, PlanReply, ProposeReply, ReportReceipt } from "../src/core/ops.ts";
import { HANDLERS } from "../src/server/decisions/kinds.ts";
import { linkTest, setExcuse, testById } from "../src/server/evidence/evidence.ts";
import { sweep } from "../src/server/jobs.ts";
import { findProject, makeCtx } from "../src/server/kernel/ctx.ts";
import { claimMint, decisionOf, Witness } from "../src/server/kernel/witness.ts";
import { OPS } from "../src/server/ops/index.ts";
import { invoke } from "../src/server/ops/registry.ts";
import { closeRun, runById } from "../src/server/runs/runs.ts";
import { ciReport, type Harness, harness } from "./helpers.ts";

let h: Harness;
beforeEach(() => {
	h = harness();
});
afterEach(() => h.close());

type Item = InboxReply["items"][number];
type CaseView = { ref: string; version: number; title: string; pre: string; tags: string[]; state: string };
type Slot = { case: string; state: string };

const first = <T>(items: readonly T[]): T => {
	const item = items[0];
	if (item === undefined) throw new Error("expected at least one item");
	return item;
};
const seed = (n = 1, methods: string[] = ["human"]) =>
	h.call("propose", {
		edits: Array.from({ length: n }, (_, i) => ({ op: "create", body: { title: `Case ${i + 1}`, methods } })),
	});
const open = (kind: string, state = "open") => first(h.call<InboxReply>("inbox", { kind, state, limit: 500 }).items);
const decide = (question: Item, answer: unknown, as = h.owner, extra: Record<string, unknown> = {}) =>
	first(h.call<DecideReply[]>("decide", { q: question.q, onEvidence: question.evidenceHash, answer, ...extra }, as));
const getCase = (ref = "C-1") => first(h.call<CaseView[]>("get", { refs: [ref] }));
const gate = (input: Record<string, unknown>) => h.call<GateStatus>("gate", input);
const slots = (run: string) => h.call<{ items: Slot[] }>("find", { in: "slots", run }).items;
const report = (input: unknown, as = h.owner) => h.call<ReportReceipt>("report", input, as);
const plan = (input: Record<string, unknown>) => h.call<PlanReply>("plan", input);
const exercise = (methods: string[] = ["human", "auto"]) => [
	{ id: "exercise", kind: "exercise", methods, basis: "exact-or-assumed", minActors: 1 },
];
const rows = <T = Record<string, unknown>>(sql: string, ...args: (string | number)[]): T[] =>
	h.app.db.raw.query(sql).all(...args) as T[];
const usePolicy = (preset: string) => {
	h.call("propose", { edits: [{ op: "policy", preset }] });
	return decide(open("adopt"), { is: "accept" }, h.owner, { reason: "switch for the test" });
};

describe("who may change the suite and the policy", () => {
	test("resolving a conflict does not carry other edits or a policy change through", () => {
		seed(2);
		const member = h.actor("member", "human", ["read", "produce"]);
		h.call("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "New head" } }] });
		const proposed = h.call<ProposeReply>(
			"propose",
			{
				edits: [
					{ op: "edit", case: "C-1", base: 1, body: { title: "Mine" } },
					{ op: "create", outline: "Smuggled second case" },
					{ op: "state", cases: ["C-2"], to: "archived" },
					{ op: "policy", preset: "strict" },
				],
			},
			member,
		);
		expect(proposed.status).toBe("conflict");
		const merged = decide(open("adopt"), { is: "merge", body: { ...emptyBody(), title: "Merged" } }, member);
		expect(merged.status).not.toBe("decided");
		expect(rows("SELECT count(*) AS n FROM cases")).toEqual([{ n: 2 }]);
		expect(getCase("C-2").state).toBe("active");
		expect(h.call<{ preset: string }>("admin", { do: "policy.show", project: "scratch" }).preset).toBe("loose");
	});

	test("a merge answered late keeps work that landed after the conflict was shown", () => {
		seed();
		h.call("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Theirs" } }] });
		h.call("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { pre: "Independent" } }] });
		h.call("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Mine" } }] });
		const question = open("adopt");
		h.call("propose", { edits: [{ op: "edit", case: "C-1", base: 3, body: { pre: "New work after conflict" } }] });
		const merged = decide(question, { is: "merge", body: { ...emptyBody(), title: "Resolved", pre: "Independent" } });
		expect(merged.status).toBe("decided");
		expect(getCase()).toMatchObject({ title: "Resolved", pre: "New work after conflict" });
	});

	test("a strict project still reviews what a conflict's author resolved", () => {
		usePolicy("strict");
		const member = h.actor("member", "human", ["read", "produce", "answer"]);
		h.call("propose", { edits: [{ op: "create", body: { title: "Case 1" } }] });
		decide(open("adopt"), { is: "accept" }, h.owner, { reason: "first version" });
		h.call("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Head" } }] });
		decide(open("adopt"), { is: "accept" }, h.owner, { reason: "second version" });
		h.call("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Mine" } }] }, member);
		const merged = decide(open("adopt"), { is: "merge", body: { ...emptyBody(), title: "Merged" } }, member);
		expect(merged.status).toBe("decided");
		// The author's resolution is a new proposal, and strict policy asks a member with a reason before it lands.
		expect(getCase().title).toBe("Head");
		expect(open("adopt").evidence).toMatchObject({ author: "member" });
	});

	test("a queued tag change is applied to the tags as they are when it is accepted", () => {
		usePolicy("standard");
		seed();
		const agent = h.actor("writer", "agent", ["read", "produce"]);
		h.call("propose", { edits: [{ op: "place", cases: ["C-1"], tags: { add: ["agent"] } }] }, agent);
		const pending = open("adopt");
		h.call("propose", { edits: [{ op: "place", cases: ["C-1"], tags: { add: ["human"] } }] });
		expect(getCase().tags).toEqual(["human"]);
		expect(decide(pending, { is: "accept" }).status).toBe("decided");
		expect([...getCase().tags].sort()).toEqual(["agent", "human"]);
	});

	test("a folder cannot be moved into a folder that would be created inside it", () => {
		h.call("propose", { edits: [{ op: "folder", name: "Parent" }] });
		const folders = () => h.call<{ items: { id: number; name: string; path: string }[] }>("find", { in: "folders" });
		const parent = folders().items.find((folder) => folder.name === "Parent");
		if (!parent) throw new Error("no folder");
		const moved = h.raw("propose", { edits: [{ op: "folder", folder: parent.id, parent: "Parent/NewChild" }] });
		expect(moved.ok).toBe(false);
		expect(folders().items.map((folder) => folder.path)).toContain("Parent");
		expect(rows("SELECT count(*) AS n FROM folders WHERE name = 'NewChild'")).toEqual([{ n: 0 }]);
	});
});

describe("what a result may prove", () => {
	test("an agent's result stays an agent's result when it travels with an automated one", () => {
		seed(2);
		const agent = h.actor("explorer", "agent", ["read", "produce"]);
		const planned = plan({ name: "default excludes agents", select: { cases: ["C-1"] } });
		report(
			{
				run: planned.run,
				results: [
					{ test: { case: "C-1" }, outcome: "pass" },
					{ test: { key: "unrelated::pass" }, outcome: "pass" },
				],
			},
			agent,
		);
		expect(rows("SELECT DISTINCT method FROM results")).toEqual([{ method: "agent" }]);
		expect(first(slots(planned.run)).state).toBe("missing");
		expect(gate({ run: planned.run }).verdict).toBe("pending");
	});

	test("an agent cannot label its evidence as a pipeline's by naming a test key", () => {
		seed();
		const agent = h.actor("explorer", "agent", ["read", "produce"]);
		const planned = plan({ name: "people and pipelines", select: {}, accepts: { commit: "agentkey1" } });
		report(
			{
				target: { commit: "agentkey1" },
				results: [{ test: { key: "a::t" }, annotation: { case: "C-1", version: 1 }, outcome: "pass" }],
			},
			agent,
		);
		expect(first(slots(planned.run)).state).toBe("missing");
	});

	test("naming a run does not admit a result for a different target", () => {
		seed();
		const planned = plan({
			name: "commit A only",
			select: {},
			accepts: { commit: "aaaaaaa1", repo: "repo-a", env: "prod" },
		});
		const refused = h.raw("report", {
			run: planned.run,
			target: { session: "unrelated session" },
			results: [{ test: { case: "C-1" }, outcome: "pass" }],
		});
		expect(refused.ok).toBe(false);
		expect(gate({ run: planned.run }).verdict).toBe("pending");
		expect(rows("SELECT count(*) AS n FROM results")).toEqual([{ n: 0 }]);
	});

	test("a skip does not turn a failed gate green, and nothing proven is never green", () => {
		const one = (outcome: string) => ({
			target: { commit: "skipped1", branch: "main" },
			results: [{ test: { key: "a::t" }, outcome, ...(outcome === "fail" ? { failure: { message: "bug" } } : {}) }],
		});
		report(one("fail"));
		decide(open("failure"), { is: "defect" });
		expect(gate({ commit: "skipped1" }).verdict).toBe("failed");
		report(one("skip"));
		expect(gate({ commit: "skipped1" }).verdict).toBe("failed");

		const onlySkips = report({
			target: { commit: "skiponly1", branch: "main" },
			results: [{ test: { key: "b::t" }, outcome: "skip" }],
		});
		expect(onlySkips.gate?.verdict).toBe("pending");
		const allRefused = report({
			target: { commit: "reject00" },
			results: [{ test: { case: "C-99" }, outcome: "pass" }],
		});
		expect(allRefused.rejected).toHaveLength(1);
		expect(allRefused.gate?.verdict ?? "pending").toBe("pending");
		expect(gate({ commit: "reject00" }).verdict).toBe("pending");
	});

	test("an automated failure whose claim about a case is refused still counts against the gate", () => {
		seed();
		const receipt = report({
			target: { commit: "declined1", branch: "main" },
			results: [
				{
					test: { key: "a::bad" },
					annotation: { case: "C-1", version: 999 },
					outcome: "fail",
					failure: { message: "bug" },
				},
				{ test: { key: "a::good" }, outcome: "pass" },
			],
		});
		expect(receipt.declined).toHaveLength(1);
		expect(receipt.counts).toMatchObject({ total: 2, fail: 1, pass: 1 });
		expect(receipt.gate?.verdict).toBe("blocked");
		expect(rows("SELECT basis, basis_case FROM results WHERE outcome = 'fail'")).toEqual([
			{ basis: "unresolved", basis_case: null },
		]);
	});

	test("a late report for an older commit does not move a change back to it", () => {
		report(ciReport({ commit: "head0001", branch: "feature", pr: 12, n: 1 }));
		report(ciReport({ commit: "head0002", branch: "feature", pr: 12, n: 1, fail: { 0: "new defect" } }));
		expect(gate({ change: "pr:12" }).verdict).toBe("blocked");
		expect(report(ciReport({ commit: "head0001", branch: "feature", pr: 12, n: 1 })).fresh).toBe(false);
		expect(gate({ change: "pr:12" }).verdict).toBe("blocked");
		// Another job of the old commit finishing late is a new report, and still does not move the head.
		report(ciReport({ commit: "head0001", branch: "feature", pr: 12, n: 1, job: "unit" }));
		expect(gate({ change: "pr:12" })).toMatchObject({ verdict: "blocked", run: gate({ commit: "head0002" }).run });
	});

	test("in a slot, another test's pass or an older attempt does not hide a failure", () => {
		seed();
		const two = plan({ name: "two linked tests", select: {}, accepts: { commit: "slot0001" } });
		report({
			target: { commit: "slot0001" },
			results: [
				{
					test: { key: "a::failure" },
					annotation: { case: "C-1", version: 1 },
					outcome: "fail",
					failure: { message: "real failure" },
				},
				{ test: { key: "a::pass" }, annotation: { case: "C-1", version: 1 }, outcome: "pass" },
			],
		});
		expect(first(slots(two.run)).state).toBe("failing");
		expect(gate({ run: two.run }).verdict).toBe("blocked");

		const late = plan({ name: "late attempts", select: {}, accepts: { commit: "attempt1" } });
		const attempt = (outcome: string, n: number) => ({
			target: { commit: "attempt1" },
			attempt: n,
			results: [
				{
					test: { key: "b::one" },
					annotation: { case: "C-1", version: 1 },
					outcome,
					...(outcome === "fail" ? { failure: { message: "expected yes, got no" } } : {}),
				},
			],
		});
		report(attempt("fail", 2));
		report(attempt("pass", 1));
		expect(first(slots(late.run)).state).toBe("failing");
		expect(gate({ run: late.run }).verdict).toBe("blocked");
	});

	test("a correction names a result on the same target, and never changes a closed run", () => {
		seed();
		const planned = plan({ name: "closed evidence", select: {}, accepts: { commit: "closed01" } });
		const recorded = report({ run: planned.run, results: [{ test: { case: "C-1" }, outcome: "pass" }] });
		expect(gate({ run: planned.run }).verdict).toBe("passed");
		const elsewhere = report({
			target: { commit: "other001" },
			results: [
				{
					test: { case: "C-1" },
					outcome: "fail",
					failure: { message: "correction elsewhere" },
					corrects: first(recorded.results),
				},
			],
		});
		expect(elsewhere.rejected).toHaveLength(1);
		expect(first(slots(planned.run)).state).toBe("satisfied");
		expect(gate({ run: planned.run }).verdict).toBe("passed");
		expect(rows("SELECT corrected FROM slot_results")).toEqual([{ corrected: 0 }]);
	});

	test("a correction counts wherever the corrected result did: the commit's gate, and a run planned afterwards", () => {
		seed();
		const before = plan({ name: "Before the correction", select: {}, accepts: { commit: "correct2" } });
		const keyed = (outcome: string, extra: Record<string, unknown> = {}) => ({
			test: { key: "corrected" },
			annotation: { case: "C-1", version: 1 },
			outcome,
			...(outcome === "fail" ? { failure: { message: "failure of corrected" } } : {}),
			...extra,
		});
		const failed = report({ target: { commit: "correct2" }, attempt: 2, results: [keyed("fail")] });
		expect(gate({ commit: "correct2" }).verdict).toBe("blocked");
		// The correction carries the default attempt, lower than the result it corrects.
		const corrected = report({
			target: { commit: "correct2" },
			results: [keyed("pass", { corrects: first(failed.results) })],
		});
		expect(corrected.rejected).toEqual([]);
		expect(gate({ run: before.run }).verdict).toBe("passed");
		expect(gate({ commit: "correct2" }).verdict).toBe("passed");
		const after = plan({ name: "After the correction", select: {}, accepts: { commit: "correct2" } });
		expect(gate({ run: after.run }).verdict).toBe("passed");
	});

	test("in a slot, a pass in another job or environment does not replace a failure", () => {
		seed();
		const one = (outcome: string, target: Record<string, unknown>, job: string) => ({
			target,
			job,
			results: [
				{
					test: { key: "a::t" },
					annotation: { case: "C-1", version: 1 },
					outcome,
					...(outcome === "fail" ? { failure: { message: "only here" } } : {}),
				},
			],
		});
		const jobs = plan({ name: "Two jobs", select: {}, accepts: { commit: "slotjobs1" } });
		report(one("fail", { commit: "slotjobs1" }, "e2e"));
		report(one("pass", { commit: "slotjobs1" }, "unit"));
		expect(first(slots(jobs.run)).state).toBe("failing");
		expect(gate({ run: jobs.run }).verdict).toBe("blocked");
		const environments = plan({ name: "Two environments", select: {}, accepts: { commit: "slotenvs1" } });
		report(one("fail", { commit: "slotenvs1", env: "production" }, "e2e"));
		report(one("pass", { commit: "slotenvs1", env: "staging" }, "e2e"));
		expect(gate({ run: environments.run }).verdict).toBe("blocked");
		// The same job reporting again is that job's own newer answer.
		report({ ...one("pass", { commit: "slotjobs1" }, "e2e"), attempt: 2 });
		expect(gate({ run: jobs.run }).verdict).toBe("passed");
	});

	test("a run planned over a failure joins its question, and the answer reaches the run", () => {
		seed();
		report({
			target: { commit: "posthoc01" },
			results: [
				{
					test: { key: "a::t" },
					annotation: { case: "C-1", version: 1 },
					outcome: "fail",
					failure: { message: "broken" },
				},
			],
		});
		const asked = open("failure");
		const planned = plan({ name: "Planned afterwards", select: {}, accepts: { commit: "posthoc01" } });
		expect(gate({ run: planned.run })).toMatchObject({ verdict: "blocked", open: [asked.q] });
		expect(h.call<InboxReply>("inbox", { kind: "failure" }).items).toHaveLength(1);
		decide(open("failure"), { is: "flaky" });
		expect(gate({ run: planned.run }).verdict).toBe("passed");
		// A run planned after the answer starts with it.
		const later = plan({ name: "Planned after the answer", select: {}, accepts: { commit: "posthoc01" } });
		expect(gate({ run: later.run }).verdict).toBe("passed");
		h.call("decide", { undo: asked.q });
		expect(gate({ run: later.run }).verdict).toBe("blocked");
	});

	test("the same attempt reported twice keeps the failure; a newer attempt or a correction replaces it", () => {
		seed();
		const ci = h.actor("pipeline", "ci", ["read", "produce"]);
		const planned = plan({ name: "Same attempt", select: {}, accepts: { commit: "sameatt01" } });
		const one = (outcome: string, extra: Record<string, unknown> = {}) => ({
			target: { commit: "sameatt01", branch: "main" },
			job: "e2e",
			results: [
				{
					test: { key: "a::t" },
					annotation: { case: "C-1", version: 1 },
					outcome,
					...(outcome === "fail" ? { failure: { message: "broken" } } : {}),
				},
			],
			...extra,
		});
		report(one("fail"), ci);
		report(one("pass"), ci);
		expect(gate({ commit: "sameatt01" }).verdict).toBe("blocked");
		expect(gate({ run: planned.run }).verdict).toBe("blocked");
		expect(h.call<InboxReply>("inbox", { kind: "failure" }).items).toHaveLength(1);
		report(one("pass", { attempt: 2 }), ci);
		expect(gate({ commit: "sameatt01" }).verdict).toBe("passed");
		expect(gate({ run: planned.run }).verdict).toBe("passed");
	});

	test("the 'already failing on the base' hint reads what the base's gate counts, after corrections and attempts", () => {
		const ci = h.actor("pipeline", "ci", ["read", "produce"]);
		const one = (target: Record<string, unknown>, outcome: string, extra: Record<string, unknown> = {}) => ({
			target,
			job: "e2e",
			results: [
				{
					test: { key: "base::t" },
					outcome,
					...(outcome === "fail" ? { failure: { message: "same failure" } } : {}),
					...extra,
				},
			],
		});
		const hintOn = (pr: number): string[] => {
			const asked = h
				.call<InboxReply>("inbox", { kind: "failure", limit: 50 })
				.items.find((item) => item.about.includes(`pr:${pr}`));
			return (asked?.evidence as { hints?: string[] } | undefined)?.hints ?? [];
		};
		const base = { repo: "app", commit: "corrbase01", branch: "main" };
		const failed = report({ ...one(base, "fail"), attempt: 2 }, ci);
		// While the base fails, a change that fails the same way is shown the hint. Nothing is excused by it.
		const during = report(
			one({ repo: "app", commit: "corrhead00", branch: "early", pr: 4, base: "corrbase01" }, "fail"),
			ci,
		);
		expect(during.gate?.verdict).toBe("blocked");
		expect(hintOn(4)).toContain("fails-on-base");
		// The producer withdraws the failure: the base passes, and a later change is not shown the hint.
		report(one(base, "pass", { corrects: first(failed.results) }), ci);
		expect(gate({ commit: "corrbase01", repo: "app" }).verdict).toBe("passed");
		const head = report(
			one({ repo: "app", commit: "corrhead01", branch: "feature", pr: 5, base: "corrbase01" }, "fail"),
			ci,
		);
		expect(head.gate?.verdict).toBe("blocked");
		expect(first(head.questions).how).toBe("new");
		expect(hintOn(5)).not.toContain("fails-on-base");
	});

	test("a run planned before two repositories report the same commit keeps their failures apart", () => {
		seed();
		const planned = plan({ name: "Before either reported", select: {}, accepts: { commit: "sameforkcommit" } });
		const fail = (repo: string) => ({
			target: { repo, commit: "sameforkcommit", branch: "main" },
			results: [
				{
					test: { key: "a::t" },
					annotation: { case: "C-1", version: 1 },
					outcome: "fail",
					failure: { message: "same cause" },
				},
			],
		});
		report(fail("a"));
		report(fail("b"));
		const asked = h.call<InboxReply>("inbox", { kind: "failure" }).items;
		expect(asked).toHaveLength(2);
		const ofA = asked.find((item) => JSON.stringify(item.evidence).includes("trunk@a"));
		if (!ofA) throw new Error("no question for repository a");
		decide(ofA, { is: "flaky" });
		// The answer covers repository a's failure only: the run still shows b's, unexplained.
		expect(gate({ run: planned.run })).toMatchObject({ verdict: "blocked" });
		expect(gate({ commit: "sameforkcommit", repo: "b" }).verdict).toBe("blocked");
		const ofB = asked.find((item) => item.q !== ofA.q);
		if (!ofB) throw new Error("no question for repository b");
		decide(first(h.call<InboxReply>("inbox", { kind: "failure" }).items), { is: "flaky" });
		expect(gate({ run: planned.run }).verdict).toBe("passed");
	});

	test("what was decided about one repository's trunk says nothing about another's", () => {
		const fail = (repo: string, commit: string) => ({
			target: { repo, commit, branch: "main" },
			results: [{ test: { key: "a::t" }, outcome: "fail", failure: { message: "same assertion" } }],
		});
		report(fail("a", "trunka001"));
		decide(open("failure"), { is: "flaky" });
		expect(gate({ commit: "trunka001" }).verdict).toBe("passed");
		const other = report(fail("b", "trunkb001"));
		expect(other.gate?.verdict).toBe("blocked");
		expect(first(other.questions).how).toBe("new");
	});

	test("an excuse held for one target does not excuse another", () => {
		const push = (commit: string) =>
			ciReport({ commit, branch: "feature", pr: 91, n: 1, fail: { 0: "environment unavailable" } });
		report(push("hold0001"));
		report(push("hold0002"));
		expect(decide(open("failure"), { is: "infra" }).status).toBe("decided");
		expect(gate({ commit: "hold0002" }).verdict).toBe("passed");
		expect(gate({ commit: "hold0001" }).verdict).toBe("blocked");
	});

	test("an excuse for one environment of a commit does not excuse another, and the other is asked about", () => {
		const fail = (env: string) => ({
			target: { commit: "envsame1", branch: "main", env },
			results: [{ test: { key: `test-${env}` }, outcome: "fail", failure: { message: "environment unavailable" } }],
		});
		report(fail("staging"));
		decide(open("failure"), { is: "infra" });
		expect(gate({ commit: "envsame1" }).verdict).toBe("passed");
		// The same cause in production is a new thing to answer for: the earlier answer covered staging.
		report(fail("production"));
		expect(gate({ commit: "envsame1" })).toMatchObject({ verdict: "blocked", tally: { excused: 1, unexplained: 1 } });
		decide(open("failure"), { is: "infra" });
		expect(gate({ commit: "envsame1" })).toMatchObject({ verdict: "passed", tally: { excused: 2 } });
		// Seen in both before anyone answered: the answer covers the build it was given for, and the other
		// environment is asked about at once, so the gate is never blocked by a failure nobody is asked about.
		const both = (env: string) => ({ ...fail(env), target: { commit: "envsame2", branch: "main", env } });
		report(both("staging"));
		report(both("production"));
		const asked = open("failure");
		decide(asked, { is: "infra" });
		const again = open("failure");
		expect(again.q).not.toBe(asked.q);
		expect(gate({ commit: "envsame2" })).toMatchObject({ verdict: "blocked", open: [again.q] });
		decide(again, { is: "infra" });
		expect(gate({ commit: "envsame2" })).toMatchObject({ verdict: "passed", tally: { excused: 2 } });
	});

	test("a planned run over some cases does not close a question about a failure it does not cover", () => {
		seed(2);
		const subset = plan({ name: "Subset", select: { cases: ["C-1"] }, accepts: { commit: "subset01" } });
		const keyed = (key: string, outcome: string, ref: string) => ({
			test: { key },
			annotation: { case: ref, version: 1 },
			outcome,
			...(outcome === "fail" ? { failure: { message: `failure of ${key}` } } : {}),
		});
		const receipt = report({
			target: { commit: "subset01" },
			results: [keyed("passing", "pass", "C-1"), keyed("failing", "fail", "C-2")],
		});
		expect(receipt.questions).toHaveLength(1);
		expect(gate({ run: subset.run }).verdict).toBe("passed");
		expect(gate({ commit: "subset01" }).verdict).toBe("blocked");
		expect(h.call<InboxReply>("inbox", { kind: "failure" }).items.map((item) => item.q)).toEqual(
			receipt.questions.map((question) => question.q),
		);
	});

	test("a commit named by a prefix is found when it was reported in two environments", () => {
		for (const env of ["staging", "production"]) {
			report({
				target: { commit: "abcdef0123456789", branch: "main", env },
				results: [{ test: { key: env }, outcome: "pass" }],
			});
		}
		expect(gate({ commit: "abcdef0" }).verdict).toBe("passed");
	});

	test("an answer prepared before a newer build failed is a conflict, not a decision about that build", () => {
		const fail = (commit: string) =>
			ciReport({ commit, branch: "feature", pr: 77, n: 1, fail: { 0: "environment unavailable" } });
		report(fail("staletarget1"));
		const seen = open("failure");
		report(fail("staletarget2"));
		const stale = decide(seen, { is: "infra" });
		expect(stale.status).toBe("conflict");
		expect(rows("SELECT count(*) AS n FROM excuses")).toEqual([{ n: 0 }]);
		// Read again, the answer is for the build now shown; and an answer that carries (flaky) still carries.
		expect(decide(open("failure"), { is: "infra" }).status).toBe("decided");
		expect(gate({ commit: "staletarget2" }).verdict).toBe("passed");
		expect(gate({ commit: "staletarget1" }).verdict).toBe("blocked");
		const other = (commit: string) => ciReport({ commit, branch: "other", pr: 78, n: 1, fail: { 0: "sometimes" } });
		report(other("carry0001"));
		decide(open("failure"), { is: "flaky" });
		expect(first(report(other("carry0002")).questions).how).toBe("already decided");
	});

	test("the same pull request number in two repositories is two changes", () => {
		const push = (repo: string, commit: string) => ({
			target: { repo, commit, branch: "feature", pr: 1 },
			results: [{ test: { key: "a::test" }, outcome: "fail", failure: { message: "same assertion" } }],
		});
		report(push("repo-a", "repoa001"));
		decide(open("failure"), { is: "flaky" });
		const second = report(push("repo-b", "repob001"));
		expect(second.gate?.verdict).toBe("blocked");
		expect(rows("SELECT repo, head_sha FROM changes ORDER BY id")).toEqual([
			{ repo: "repo-a", head_sha: "repoa001" },
			{ repo: "repo-b", head_sha: "repob001" },
		]);
		expect(gate({ change: "pr:1" }).run).toBe(gate({ commit: "repoa001" }).run);
	});

	test("who may fill a pinned slot is read from the pinned version, not the newest", () => {
		seed();
		const agent = h.actor("writer", "agent", ["read", "produce"]);
		const planned = plan({ name: "pinned human only", select: {}, require: exercise(["agent"]) });
		h.call("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { methods: ["human", "agent"] } }] });
		report({ run: planned.run, results: [{ test: { case: "C-1" }, outcome: "pass" }] }, agent);
		expect(first(slots(planned.run)).state).toBe("missing");
	});

	test("a result that names one case and is annotated with another is refused", () => {
		seed(2);
		h.call("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "v2" } }] });
		const planned = plan({ name: "pin", select: { cases: ["C-1", "C-2"] } });
		const mismatch = report({
			run: planned.run,
			results: [{ test: { case: "C-1" }, annotation: { case: "C-2", version: 1 }, outcome: "pass" }],
		});
		expect(mismatch.rejected).toHaveLength(1);
		expect(slots(planned.run).map((slot) => slot.state)).toEqual(["missing", "missing"]);
	});

	test("an agent's results never count in a commit's gate, and cannot clear a pipeline's failure", () => {
		const agent = h.actor("explorer", "agent", ["read", "produce"]);
		const ci = h.actor("pipeline", "ci", ["read", "produce"]);
		const keyed = (key: string, outcome: string) => ({
			test: { key },
			outcome,
			...(outcome === "fail" ? { failure: { message: `failure of ${key}` } } : {}),
		});
		const alone = report({ target: { commit: "agent001", branch: "main" }, results: [keyed("one", "pass")] }, agent);
		expect(alone.gate?.verdict).toBe("pending");
		report({ target: { commit: "agent002", branch: "main" }, results: [keyed("two", "fail")] }, ci);
		expect(gate({ commit: "agent002" }).verdict).toBe("blocked");
		report({ target: { commit: "agent002", branch: "main" }, results: [keyed("two", "pass")] }, agent);
		expect(gate({ commit: "agent002" }).verdict).toBe("blocked");
		// An agent's failure is put to a person as a question, and holds no gate. It does not close the pipeline's
		// question either: a newer commit with nothing from a pipeline says nothing about that failure.
		const found = report({ target: { commit: "agent003", branch: "main" }, results: [keyed("three", "fail")] }, agent);
		expect(found.gate).toMatchObject({ verdict: "pending", open: [] });
		const asked = h.call<InboxReply>("inbox", { kind: "failure" }).items;
		expect(asked).toHaveLength(2);
		expect(gate({ commit: "agent002" }).verdict).toBe("blocked");
		expect(rows("SELECT count(*) AS n FROM results WHERE method = 'agent'")).toEqual([{ n: 3 }]);
	});

	test("one producer's pass does not replace another job's or another producer's failure of the same test", () => {
		const ci = h.actor("pipeline", "ci", ["read", "produce"]);
		const one = (outcome: string, job: string) => ({
			target: { commit: "lanes0001", branch: "main" },
			job,
			results: [{ test: { key: "a::t" }, outcome, ...(outcome === "fail" ? { failure: { message: "bug" } } : {}) }],
		});
		report(one("fail", "linux"), ci);
		report(one("pass", "macos"), ci);
		expect(gate({ commit: "lanes0001" }).verdict).toBe("blocked");
		report(one("pass", "linux"), h.owner);
		expect(gate({ commit: "lanes0001" }).verdict).toBe("blocked");
		// The same job reporting a newer attempt is that job changing its own answer.
		report({ ...one("pass", "linux"), attempt: 2 }, ci);
		expect(gate({ commit: "lanes0001" }).verdict).toBe("passed");
	});

	test("a slot with two failing causes stays blocked until both are answered", () => {
		seed();
		const planned = plan({ name: "Two causes", select: {}, accepts: { commit: "cause001" } });
		const failing = (key: string) => ({
			test: { key },
			annotation: { case: "C-1", version: 1 },
			outcome: "fail",
			failure: { message: `failure of ${key}` },
		});
		report({ target: { commit: "cause001" }, results: [failing("alpha"), failing("beta")] });
		const questions = h.call<InboxReply>("inbox", { kind: "failure", limit: 50 }).items;
		expect(questions).toHaveLength(2);
		decide(first(questions), { is: "flaky" });
		expect(gate({ run: planned.run }).verdict).toBe("blocked");
		decide(questions[1] ?? first(questions), { is: "flaky" });
		expect(gate({ run: planned.run }).verdict).toBe("passed");
	});

	test("in a planned run, a skip recorded later does not hide that producer's failure", () => {
		seed(2);
		const planned = plan({ name: "Skip is no proof", select: {} });
		const other = h.actor("second-person", "human", ["read", "produce"]);
		report({
			run: planned.run,
			results: [
				{ test: { case: "C-1" }, outcome: "fail", note: "real bug" },
				{ test: { case: "C-2" }, outcome: "pass" },
			],
		});
		report({ run: planned.run, results: [{ test: { case: "C-1" }, outcome: "pass" }] }, other);
		expect(gate({ run: planned.run }).verdict).toBe("blocked");
		report({ run: planned.run, results: [{ test: { case: "C-1" }, outcome: "skip" }] });
		expect(gate({ run: planned.run })).toMatchObject({ verdict: "blocked", tally: { disputed: 1 } });
	});

	test("the same commit in two repositories has two gates, and a lookup never answers with the other one", () => {
		seed();
		const push = (repo: string, outcome: string) => ({
			target: { repo, commit: "samecommit", pr: 12, branch: "f" },
			results: [
				{
					test: { key: "t" },
					annotation: { case: "C-1", version: 1 },
					outcome,
					...(outcome === "fail" ? { failure: { message: "broken in the fork" } } : {}),
				},
			],
		});
		report(push("a", "pass"));
		report(push("b", "fail"));
		expect(gate({ change: "pr:12" }).verdict).toBe("passed");
		expect(gate({ change: "b#pr:12" }).verdict).toBe("blocked");
		expect(gate({ commit: "samecommit", repo: "b" }).verdict).toBe("blocked");
		expect(h.raw("gate", { commit: "samecommit" })).toMatchObject({ ok: false, error: { code: "invalid" } });
		const planned = plan({ name: "Repository b", select: {}, accepts: { repo: "b", commit: "samecommit" } });
		expect(first(slots(planned.run)).state).toBe("failing");
		expect(h.raw("plan", { name: "Either", select: {}, accepts: { commit: "samecommit" } }).ok).toBe(false);
		type Impact = { gate: { verdict: string } | null };
		expect(h.call<Impact>("impact", { change: "b#pr:12" }).gate?.verdict).toBe("blocked");
	});

	test("a correction stands where the result it corrects stood, in the commit's gate and in every run alike", () => {
		h.call("propose", {
			edits: [
				{ op: "create", outline: "One" },
				{ op: "create", outline: "Keep open" },
			],
		});
		const existing = plan({ name: "Before", select: {}, accepts: { commit: "history1" } });
		const send = (attempt: number, outcome: string, corrects?: number) =>
			report({
				target: { commit: "history1", branch: "main" },
				attempt,
				results: [
					{
						test: { key: "one" },
						annotation: { case: "C-1", version: 1 },
						outcome,
						...(outcome === "fail" ? { failure: { message: "same cause" } } : {}),
						...(corrects ? { corrects } : {}),
					},
				],
			});
		send(2, "fail");
		const newest = send(3, "fail");
		// The newest attempt is corrected to a pass. The report carrying the correction is numbered 1.
		send(1, "pass", first(newest.results));
		const later = plan({ name: "After", select: { cases: ["C-1"] }, accepts: { commit: "history1" } });
		const state = (run: string) => slots(run).find((slot) => slot.case === "C-1")?.state;
		expect(gate({ commit: "history1" }).tally).toMatchObject({ pass: 1, unexplained: 0 });
		expect([state(existing.run), state(later.run)]).toEqual(["satisfied", "satisfied"]);
		expect(h.call<InboxReply>("inbox", { kind: "failure", limit: 50 }).items).toEqual([]);
	});

	test("a corrected newest attempt that decides nothing leaves the attempt before it standing, everywhere", () => {
		h.call("propose", {
			edits: [
				{ op: "create", outline: "One" },
				{ op: "create", outline: "Keep open" },
			],
		});
		const existing = plan({ name: "Before", select: {}, accepts: { commit: "history2" } });
		const send = (attempt: number, outcome: string, corrects?: number) =>
			report({
				target: { commit: "history2", branch: "main" },
				attempt,
				results: [
					{
						test: { key: "one" },
						annotation: { case: "C-1", version: 1 },
						outcome,
						...(outcome === "fail" ? { failure: { message: "same cause" } } : {}),
						...(corrects ? { corrects } : {}),
					},
				],
			});
		send(2, "fail");
		const newest = send(3, "pass");
		expect(gate({ commit: "history2" }).tally).toMatchObject({ pass: 1, unexplained: 0 });
		// The pass of attempt 3 is withdrawn (corrected to a skip): attempt 2's failure is what the lane shows again.
		send(3, "skip", first(newest.results));
		const later = plan({ name: "After", select: { cases: ["C-1"] }, accepts: { commit: "history2" } });
		const state = (run: string) => slots(run).find((slot) => slot.case === "C-1")?.state;
		expect(gate({ commit: "history2" }).tally).toMatchObject({ pass: 0, unexplained: 1 });
		expect([state(existing.run), state(later.run)]).toEqual(["failing", "failing"]);
	});

	test("a result judged a mistake counts in no run planned afterwards, and comes back everywhere when the judgement is withdrawn", () => {
		seed();
		const other = h.actor("other", "human", ["read", "produce"]);
		const target = { commit: "judged01", branch: "main" };
		const one = { test: { key: "one" }, annotation: { case: "C-1", version: 1 } };
		report({ target, results: [{ ...one, outcome: "fail", failure: { message: "same cause" } }] });
		report({ target, results: [{ ...one, outcome: "pass" }] }, other);
		const before = plan({ name: "Before", select: {}, accepts: { commit: "judged01" } });
		const dispute = open("failure");
		expect(decide(dispute, { is: "mistaken" }).status).toBe("decided");
		expect(gate({ run: before.run }).tally).toMatchObject({ pass: 1, disputed: 0 });
		// Planned again over the same results: the judged result is not counted here either, and nobody is asked.
		const after = plan({ name: "After", select: {}, accepts: { commit: "judged01" } });
		expect(gate({ run: after.run }).tally).toMatchObject({ pass: 1, disputed: 0 });
		expect(h.call<InboxReply>("inbox", { kind: "failure", limit: 50 }).items).toEqual([]);
		// Withdrawn: the result counts again in the commit's gate and in both runs.
		h.call("decide", { undo: open("signoff", "decided").q });
		expect(first(h.call<DecideReply[]>("decide", { undo: dispute.q })).status).toBe("reopened");
		expect(gate({ commit: "judged01" }).tally.unexplained).toBe(1);
		expect([first(slots(before.run)).state, first(slots(after.run)).state]).toEqual(["disputed", "disputed"]);
		expect(gate({ run: after.run }).verdict).toBe("blocked");
	});

	test("a commit is answered on the line it was first reported on, whatever line reports it later", () => {
		const fail = (key: string) => ({ test: { key }, outcome: "fail", failure: { message: "same cause" } });
		const commit = "same0001";
		// First as the head of a pull request, where its failure is called flaky.
		report({ target: { commit, repo: "app", branch: "feature", pr: 1, env: "ci" }, results: [fail("one")] });
		expect(decide(open("failure"), { is: "flaky" }).status).toBe("decided");
		// The same commit reaches trunk and is reported from there. It is the same commit with the same gate: its
		// failures are answered where the first one was, so there is one answer and one scope for the gate to count.
		const later = report({
			target: { commit, repo: "app", branch: "main", env: "production" },
			results: [fail("two")],
		});
		expect(later.questions.map((q) => q.how)).toEqual(["already decided"]);
		expect(rows("SELECT DISTINCT line, change FROM targets")).toHaveLength(1);
		expect(
			new Set(
				rows<{ subject: string }>("SELECT subject FROM questions WHERE kind = 'failure'").map(
					(q) => JSON.parse(q.subject).scope,
				),
			).size,
		).toBe(1);
		// Changing that one answer to a defect fails the commit's gate: no second scope keeps it green.
		expect(decide(open("failure", "decided"), { is: "defect" }).status).toBe("decided");
		expect(gate({ commit, repo: "app" })).toMatchObject({ verdict: "failed", tally: { attributed: 2, excused: 0 } });
	});

	test("a run planned over a commit counts every environment it was reported in, however many", () => {
		seed();
		const one = (outcome: string) => ({
			test: { key: "one" },
			annotation: { case: "C-1", version: 1 },
			outcome,
			...(outcome === "fail" ? { failure: { message: "last environment" } } : {}),
		});
		const environments = 230;
		// It passes everywhere except in the last environment reported.
		for (let i = 0; i < environments; i++)
			report({
				target: { commit: "matrix001", branch: "main", env: `env-${String(i).padStart(3, "0")}` },
				results: [one(i === environments - 1 ? "fail" : "pass")],
			});
		expect(gate({ commit: "matrix001" }).verdict).toBe("blocked");
		// A run over the commit, every environment: it sees the failure too, and is not signed off.
		const planned = plan({ name: "Whole matrix", select: {}, accepts: { commit: "matrix001" } });
		expect(rows<{ n: number }>("SELECT count(*) AS n FROM slot_results")).toEqual([{ n: environments }]);
		expect(gate({ run: planned.run }).verdict).toBe("blocked");
		expect(rows("SELECT state FROM runs WHERE origin = 'planned'")).toEqual([{ state: "open" }]);
		// A run over the last environment alone finds its result.
		const last = plan({
			name: "Last environment",
			select: {},
			accepts: { commit: "matrix001", env: `env-${environments - 1}` },
		});
		expect(first(slots(last.run)).state).toBe("failing");
	}, 60_000);

	test("an automated test cannot take the key of a case's manual test", () => {
		seed(2);
		const taken = h.raw("report", {
			target: { commit: "keycol01" },
			results: [{ test: { key: "case:1" }, outcome: "pass" }],
		});
		expect(taken).toMatchObject({ ok: false, error: { code: "invalid" } });
		const planned = plan({ name: "manual case", select: {} });
		report({ run: planned.run, results: [{ test: { case: "C-1" }, outcome: "pass" }] });
		expect(first(slots(planned.run)).state).toBe("satisfied");
		expect(rows("SELECT key, kind, case_id FROM tests")).toEqual([{ key: "case:1", kind: "manual", case_id: 1 }]);
	});

	test("a required job counts as soon as its own report is applied", () => {
		seed();
		const planned = plan({
			name: "jobs",
			select: {},
			accepts: { commit: "jobs0001" },
			require: [...exercise(), { id: "ci", kind: "jobs", jobs: ["e2e"] }],
		});
		report({
			target: { commit: "jobs0001" },
			job: "e2e",
			results: [{ test: { key: "a::test" }, annotation: { case: "C-1", version: 1 }, outcome: "pass" }],
		});
		expect(gate({ run: planned.run }).verdict).toBe("passed");
	});

	test("a test key of only spaces is refused", () => {
		const reply = h.raw("report", {
			target: { commit: "spaces001" },
			results: [{ test: { key: "   " }, outcome: "pass" }],
		});
		expect(reply.ok).toBe(false);
		expect(rows("SELECT count(*) AS n FROM tests")).toEqual([{ n: 0 }]);
	});
});

describe("what a run and a change may count", () => {
	const pipeline = () => h.actor("pipeline", "ci", ["read", "produce"]);
	const explorer = () => h.actor("explorer", "agent", ["read", "produce"]);
	const linked = (outcome: string, message = "boom") => ({
		test: { key: "t1" },
		annotation: { case: "C-1", version: 1 },
		outcome,
		...(outcome === "fail" ? { failure: { message } } : {}),
	});

	test("a run planned by an abbreviated commit counts the one commit it names", () => {
		seed(2, ["human", "auto"]);
		const a = "abcdef1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
		const b = "abcdef1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
		const ci = pipeline();
		report({ target: { commit: a, branch: "main" }, results: [linked("fail")] }, ci);
		// One commit starts with these seven characters: the run is planned for that commit, by its whole hash.
		const one = plan({ name: "By prefix", select: {}, accepts: { commit: "abcdef1" } });
		expect(rows<{ accepts: string }>("SELECT accepts FROM runs WHERE no = ?", Number(one.run.slice(2)))).toEqual([
			{ accepts: JSON.stringify({ commit: a }) },
		]);
		report({ target: { commit: b, branch: "main" }, results: [linked("pass")] }, ci);
		// The other commit's pass is not this run's: its slot still shows the failure of the commit it counts.
		expect(
			rows<{ commit_sha: string }>(
				`SELECT DISTINCT t.commit_sha FROM slot_results s JOIN results r ON r.id = s.result
				 JOIN targets t ON t.id = r.target WHERE s.run = ?`,
				Number(one.run.slice(2)),
			),
		).toEqual([{ commit_sha: a }]);
		expect(gate({ run: one.run }).verdict).toBe("blocked");
		// A result typed into the run is recorded on that commit, not on a commit named by the abbreviation.
		report({ run: one.run, results: [{ test: { case: "C-2" }, outcome: "pass" }] });
		expect(rows("SELECT 1 AS n FROM targets WHERE commit_sha = 'abcdef1'")).toEqual([]);
		// Two commits start with it now: a run cannot be planned for both.
		expect(() => plan({ name: "Which", select: {}, accepts: { commit: "abcdef1" } })).toThrow("abcdef1");
		expect(plan({ name: "Exact", select: {}, accepts: { commit: b } }).run).toBeDefined();
	});

	test("only a pipeline's report that ran something meets a run's requirement that a job reported", () => {
		usePolicy("standard");
		seed(1);
		const commit = "c0ffee0000000000000000000000000000000001";
		const planned = plan({
			name: "Release",
			select: {},
			accepts: { commit },
			require: [
				{ id: "x", kind: "exercise", methods: ["human"], basis: "exact-or-assumed", minActors: 1 },
				{ id: "jobs", kind: "jobs", jobs: ["e2e"] },
			],
		});
		report({ run: planned.run, results: [{ test: { case: "C-1" }, outcome: "pass" }] });
		const waiting = () => {
			const now = gate({ run: planned.run });
			return { verdict: now.verdict, missing: now.tally.missing };
		};
		expect(waiting()).toEqual({ verdict: "pending", missing: 1 });
		const target = { commit, branch: "main" };
		// An agent, which the run never asked for, reports under the job's name.
		report({ target, job: "e2e", results: [{ test: { key: "probe" }, outcome: "pass" }] }, explorer());
		expect(waiting()).toEqual({ verdict: "pending", missing: 1 });
		// The pipeline's job reports that it ran nothing.
		const ci = pipeline();
		report({ target, job: "e2e", results: [{ test: { key: "spec::a" }, outcome: "skip" }] }, ci);
		expect(waiting()).toEqual({ verdict: "pending", missing: 1 });
		// A person sends their own pass of the case together with one skipped key, under the job's name. The
		// automated part of that proved nothing; what is decisive in it is the person's own doing, not the job's.
		report({
			run: planned.run,
			job: "e2e",
			attempt: 3,
			results: [
				{ test: { case: "C-1" }, outcome: "pass" },
				{ test: { key: "spec::a" }, outcome: "skip" },
			],
		});
		expect(waiting()).toEqual({ verdict: "pending", missing: 1 });
		// It runs: the requirement is met.
		report({ target, job: "e2e", attempt: 2, results: [{ test: { key: "spec::a" }, outcome: "pass" }] }, ci);
		expect(waiting()).toEqual({ verdict: "passed", missing: 0 });
	});

	test("a run reopened after its evidence changed counts the evidence as it is now", () => {
		seed(1, ["human", "auto"]);
		const commit = "feedface00000000000000000000000000000001";
		const target = { commit, branch: "main" };
		const ci = pipeline();
		const planned = plan({ name: "Release", select: {}, accepts: { commit } });
		const pass = report({ target, job: "e2e", results: [linked("pass")] }, ci);
		const stored = () =>
			first(rows<{ state: string; verdict: string }>("SELECT state, verdict FROM runs WHERE origin = 'planned'"));
		expect(stored()).toEqual({ state: "closed", verdict: "passed" });
		// The pipeline withdraws its pass: the test failed. The closed run keeps what it was closed on.
		report({ target, job: "e2e", results: [{ ...linked("fail"), corrects: first(pass.results) }] }, ci);
		expect(gate({ commit }).verdict).toBe("blocked");
		expect(stored()).toEqual({ state: "closed", verdict: "passed" });
		// Its sign-off is withdrawn: the run is live again, and shows what the commit shows.
		h.call("decide", { undo: open("signoff", "decided").q, reason: "the pass was withdrawn" });
		expect(stored()).toEqual({ state: "open", verdict: "blocked" });
		expect(slots(planned.run).map((slot) => slot.state)).toEqual(["failing"]);
		expect(h.call<InboxReply>("inbox", { kind: "signoff", limit: 50 }).items).toEqual([]);
		expect(open("failure").about).toContain(planned.run);
	});

	test("a result that arrived while a run was closed counts when the run is reopened", () => {
		seed(1, ["human", "auto"]);
		const commit = "feedface00000000000000000000000000000002";
		const ci = pipeline();
		const planned = plan({ name: "Release", select: {}, accepts: { commit } });
		report({ target: { commit, branch: "main", env: "prod" }, results: [linked("pass")] }, ci);
		expect(first(rows<{ state: string }>("SELECT state FROM runs WHERE origin = 'planned'")).state).toBe("closed");
		// Another environment of the same commit fails after the run was closed.
		report({ target: { commit, branch: "main", env: "staging" }, results: [linked("fail")] }, ci);
		h.call("decide", { undo: open("signoff", "decided").q, reason: "staging failed" });
		expect(gate({ run: planned.run }).verdict).toBe("blocked");
	});

	test("a reopened run knows a result was corrected even where a decision had already set it aside", () => {
		seed(1, ["human", "auto"]);
		const ci = pipeline();
		const target = { repo: "app", commit: "corrected001", branch: "main" };
		const planned = plan({ name: "Release", select: {}, accepts: { repo: "app", commit: target.commit } });
		const failed = report({ target, results: [linked("fail", "old cause")] }, ci);
		report({ target, results: [linked("pass")] });
		const asked = open("failure");
		expect(decide(asked, { is: "mistaken" }).status).toBe("decided");
		const signoff = open("signoff", "decided");
		// While the run is closed, the pipeline withdraws its failure: the test did not run.
		report({ target, results: [{ ...linked("skip"), corrects: first(failed.results) }] }, ci);
		h.call("decide", { undo: signoff.q, reason: "look again" });
		// The `mistaken` answer is withdrawn too. The failure it had set aside was withdrawn by its producer
		// meanwhile, so it does not come back: the run and the commit read the same.
		h.call("decide", { undo: asked.q, reason: "not needed" });
		expect(rows("SELECT corrected, discounted_by FROM slot_results WHERE result = ?", first(failed.results))).toEqual([
			{ corrected: 1, discounted_by: null },
		]);
		expect(gate({ commit: target.commit, repo: "app" }).verdict).toBe("passed");
		expect(gate({ run: planned.run }).verdict).toBe("passed");
	});

	test("the first pipeline to report a change says where its head is, whatever an agent said before", () => {
		const ci = pipeline();
		const older = { repo: "app", commit: "older001", branch: "main" };
		report({ target: older, results: [{ test: { key: "one" }, outcome: "pass" }] }, ci);
		// An agent names a pull request nobody has reported, on a commit of its own, with a base, a title and files.
		report(
			{
				target: {
					repo: "app",
					commit: "agent001",
					pr: 7,
					branch: "feature",
					base: "agentbase",
					title: "From agent",
					files: ["agent.ts"],
				},
				results: [{ test: { key: "agent" }, outcome: "skip" }],
			},
			explorer(),
		);
		expect(gate({ change: "pr:7" })).toMatchObject({ run: null, verdict: "pending" });
		// The pipeline's first report of the pull request is for a commit Casebook saw before the agent's.
		report(
			{
				target: { ...older, pr: 7, branch: "feature", base: "realbase", title: "Pipeline", files: ["real.ts"] },
				attempt: 2,
				results: [{ test: { key: "one" }, outcome: "fail", failure: { message: "real failure" } }],
			},
			ci,
		);
		expect(rows("SELECT head_sha, base_sha, title, files FROM changes WHERE key = 'pr:7'")).toEqual([
			{ head_sha: "older001", base_sha: "realbase", title: "Pipeline", files: '["real.ts"]' },
		]);
		expect(gate({ change: "pr:7" }).verdict).toBe("blocked");
		// And an agent's early sighting of a commit does not make the pipeline's later report of it look old.
		report(
			{
				target: { repo: "app", commit: "early001", pr: 8, branch: "other" },
				results: [{ test: { key: "agent" }, outcome: "skip" }],
			},
			explorer(),
		);
		report(
			{
				target: { repo: "app", commit: "head0001", pr: 8, branch: "other" },
				results: [{ test: { key: "one" }, outcome: "pass" }],
			},
			ci,
		);
		report(
			{
				target: { repo: "app", commit: "early001", pr: 8, branch: "other" },
				results: [{ test: { key: "one" }, outcome: "pass" }],
			},
			ci,
		);
		expect(first(rows<{ head_sha: string }>("SELECT head_sha FROM changes WHERE key = 'pr:8'")).head_sha).toBe(
			"early001",
		);
	});

	test("an agent's report does not choose where a commit's failures are answered", () => {
		const ci = pipeline();
		const fail = { test: { key: "t0" }, outcome: "fail", failure: { message: "X boom" } };
		// Trunk fails with cause X and a person calls it flaky: that answer stands on the trunk line.
		report({ target: { repo: "acme/web", commit: "trunk0001", branch: "main" }, results: [fail] }, ci);
		expect(decide(open("failure"), { is: "flaky" }).status).toBe("decided");
		// An agent mentions a pull request's head as a commit of main. Nothing counts that.
		const probe = { test: { key: "agent::probe" }, outcome: "skip" };
		report({ target: { repo: "acme/web", commit: "head00001", branch: "main" }, results: [probe] }, explorer());
		// The pipeline reports that commit as the head of pr:7, failing with the same cause. It is the pull
		// request's failure: asked about there, not excused by what was decided about trunk.
		const reported = report(
			{
				target: { repo: "acme/web", commit: "head00001", pr: 7, branch: "feature", base: "trunk0001" },
				results: [fail],
			},
			ci,
		);
		expect(reported.questions.map((q) => q.how)).toEqual(["new"]);
		expect(gate({ change: "pr:7" }).verdict).toBe("blocked");
		expect(rows("SELECT DISTINCT line, branch FROM targets WHERE commit_sha = 'head00001'")).toEqual([
			{ line: "change", branch: "feature" },
		]);
		// The other way round: an agent calls a trunk commit a pull request's; the pipeline's report says trunk.
		report({ target: { repo: "acme/web", commit: "trunk0002", pr: 9, branch: "other" }, results: [probe] }, explorer());
		const onTrunk = report({ target: { repo: "acme/web", commit: "trunk0002", branch: "main" }, results: [fail] }, ci);
		expect(onTrunk.questions.map((q) => q.how)).toEqual(["already decided"]);
		expect(rows("SELECT DISTINCT line, change FROM targets WHERE commit_sha = 'trunk0002'")).toEqual([
			{ line: "trunk", change: null },
		]);
		// And a pipeline that sends only the hash of a commit an agent placed gives it a place of its own.
		report({ target: { repo: "acme/web", commit: "bare00001", pr: 9, branch: "other" }, results: [probe] }, explorer());
		report(
			{ target: { repo: "acme/web", commit: "bare00001" }, results: [{ test: { key: "t1" }, outcome: "pass" }] },
			ci,
		);
		expect(
			rows("SELECT c.key FROM targets t JOIN changes c ON c.id = t.change WHERE t.commit_sha = 'bare00001'"),
		).toEqual([{ key: "commit:bare00001" }]);
	});

	test("an agent's report does not move a pull request's head or make a commit the newest of its scope", () => {
		const ci = pipeline();
		const head = "c2c2c2c200000000000000000000000000000002";
		const trunk = "t3t3t3t300000000000000000000000000000003";
		const fail = { test: { key: "t1" }, outcome: "fail", failure: { message: "boom" } };
		report(
			{ target: { commit: head, base: "b1b1b1b1", repo: "acme/web", pr: 7, branch: "feature" }, results: [fail] },
			ci,
		);
		const before = gate({ change: "pr:7" });
		expect(before.verdict).toBe("blocked");
		report(
			{
				target: { commit: trunk, repo: "acme/web", branch: "main" },
				results: [{ test: { key: "t1" }, outcome: "pass" }],
			},
			ci,
		);
		// An agent says a commit that passes on trunk is the pull request's.
		const probe = { test: { key: "other" }, outcome: "skip" };
		report({ target: { commit: trunk, repo: "acme/web", pr: 7, branch: "feature" }, results: [probe] }, explorer());
		expect(gate({ change: "pr:7" })).toEqual(before);
		// And a commit nobody else has reported.
		const unseen = "dddddddd00000000000000000000000000000004";
		report({ target: { commit: unseen, repo: "acme/web", pr: 7, branch: "feature" }, results: [probe] }, explorer());
		expect(gate({ change: "pr:7" })).toEqual(before);
		expect(first(rows<{ head_sha: string }>("SELECT head_sha FROM changes WHERE key = 'pr:7'")).head_sha).toBe(head);
		// The pull request's own failure is still the one people are asked about.
		expect(open("failure").blocks).toEqual([before.run as string]);
		// When the pipeline reports that commit, it is the head.
		report(
			{
				target: { commit: unseen, repo: "acme/web", pr: 7, branch: "feature" },
				results: [{ test: { key: "t1" }, outcome: "pass" }],
			},
			ci,
		);
		expect(first(rows<{ head_sha: string }>("SELECT head_sha FROM changes WHERE key = 'pr:7'")).head_sha).toBe(unseen);
	});
});

describe("what a decision may change", () => {
	test("standing cannot cite a decision that is not in the ledger", () => {
		report(ciReport({ commit: "witness1", n: 1, fail: { 0: "bug" } }));
		const project = findProject(h.app.db, "scratch");
		if (!project) throw new Error("no project");
		const ctx = makeCtx(h.app, project, h.owner, true);
		const signature = first(rows<{ id: number }>("SELECT id FROM signatures")).id;
		const plain = { decision: 999_999, kind: "failure", signers: [h.owner.id], expiresAt: null } as unknown as Witness;
		expect(() => setExcuse(ctx, plain, { signature, scope: "line:trunk", class: "excused", targets: null })).toThrow();
		expect(rows("SELECT count(*) AS n FROM excuses")).toEqual([{ n: 0 }]);
	});

	test("withdrawing an older link decision leaves a newer decision's link alone", () => {
		usePolicy("standard");
		seed(3);
		report({
			target: { commit: "map00001" },
			results: [
				{ test: { key: "a::t", file: "a" }, outcome: "pass" },
				{ test: { key: "b::t", file: "b" }, outcome: "pass" },
			],
		});
		const maps = h.call<InboxReply>("inbox", { kind: "map" }).items;
		const about = (file: string) => {
			const found = maps.find((item) => (item.evidence as { file: string }).file === file);
			if (!found) throw new Error(`no map question for ${file}`);
			return found;
		};
		decide(about("a"), { is: "link", pairs: [["T-1", "C-1"]] });
		decide(about("b"), { is: "link", pairs: [["T-1", "C-2"]] });
		const linked = () => first(rows<{ case_id: number | null }>("SELECT case_id FROM tests WHERE no = 1")).case_id;
		const second = linked();
		h.call("decide", { undo: about("a").q });
		expect(linked()).toBe(second);
		// Withdrawing the newer one does not put back a link whose own decision was withdrawn.
		h.call("decide", { undo: about("b").q });
		expect(linked()).toBeNull();
	});

	test("a question asked again is answered and undone there, and the old one cannot touch the new decision", () => {
		report(ciReport({ commit: "again001", n: 1, fail: { 0: "stable failure" } }));
		const old = open("failure");
		decide(old, { is: "flaky" });
		h.advance(15 * 86_400_000);
		report(ciReport({ commit: "again002", n: 1, fail: { 0: "stable failure" } }));
		const again = open("failure");
		expect(again.q).not.toBe(old.q);
		decide(again, { is: "defect" });
		expect(gate({ commit: "again002" }).verdict).toBe("failed");
		const undone = first(h.call<DecideReply[]>("decide", { undo: old.q }));
		expect(undone.status).toBe("conflict");
		expect(gate({ commit: "again002" }).verdict).toBe("failed");
		expect(rows("SELECT count(*) AS n FROM excuses")).toEqual([{ n: 1 }]);
	});

	test("a witness of one kind cannot change what another kind of decision owns", () => {
		usePolicy("standard");
		seed();
		report({
			target: { commit: "kinds0001" },
			results: [{ test: { key: "a::t", file: "a" }, outcome: "fail", failure: { message: "bug" } }],
		});
		// A genuine witness, captured as the adopt handler receives it from a real decision.
		let adoptWitness: Witness | null = null;
		const adopt = HANDLERS.adopt;
		const original = adopt.effect;
		adopt.effect = (ctx, witness, ...rest) => {
			adoptWitness = witness;
			return original(ctx, witness, ...rest);
		};
		try {
			h.call("propose", { edits: [{ op: "create", outline: "Made by a real decision" }] });
		} finally {
			adopt.effect = original;
		}
		if (!adoptWitness) throw new Error("no adopt decision was made");
		const genuine: Witness = adoptWitness;
		expect(decisionOf(genuine, "adopt")).toBeGreaterThan(0);
		const project = findProject(h.app.db, "scratch");
		if (!project) throw new Error("no project");
		const ctx = makeCtx(h.app, project, h.owner, true);
		const test = testById(h.app.db, 1);
		const run = runById(h.app.db, 1);
		if (!test || !run) throw new Error("fixture missing");
		const signature = first(rows<{ id: number }>("SELECT id FROM signatures")).id;
		// The same witness is refused by every writer that another kind of decision owns, and nothing is written.
		expect(() => linkTest(ctx, genuine, test, 1)).toThrow("only a map decision");
		expect(() => setExcuse(ctx, genuine, { signature, scope: "line:trunk", class: "excused", targets: null })).toThrow(
			"only a failure decision",
		);
		expect(() => closeRun(ctx, genuine, run)).toThrow("only a signoff decision");
		expect(rows("SELECT case_id, linked_by FROM tests WHERE id = 1")).toEqual([{ case_id: null, linked_by: null }]);
		expect(rows("SELECT count(*) AS n FROM excuses")).toEqual([{ n: 0 }]);
		expect(rows("SELECT state FROM runs WHERE id = 1")).toEqual([{ state: "open" }]);
	});

	test("only the decision machinery can make a witness", () => {
		// A plain object does not type-check as a witness: the class has a private field.
		// @ts-expect-error
		const forged: Witness = { kind: "adopt", signers: [1], expiresAt: null };
		expect(() => decisionOf(forged, "adopt")).toThrow("not a witness");
		// The mint is handed out once, to the decision machinery, when it loads.
		expect(() => claimMint()).toThrow("already held");
		// The constructor is private to TypeScript only; at run time it refuses a call without the module's key.
		expect(() => Reflect.construct(Witness, [1, "failure", [h.owner.id], null])).toThrow("decision machinery");
		const made = Object.create(Witness.prototype) as Witness;
		expect(() => decisionOf(made, "adopt")).toThrow("not a witness");
	});

	test("a hold that runs out is recorded once, whether a report or the timer notices first", () => {
		const fail = (commit: string) => ciReport({ commit, n: 1, fail: { 0: "stable failure" } });
		report(fail("expiry01"));
		const old = open("failure");
		decide(old, { is: "flaky" });
		h.advance(15 * 86_400_000);
		report(fail("expiry02"));
		const again = open("failure");
		expect(again.q).not.toBe(old.q);
		const ledger = () =>
			rows<{ answer: string; supersedes: number | null }>(
				"SELECT answer, supersedes FROM decisions WHERE kind = 'failure' ORDER BY id",
			).map((row) => JSON.parse(row.answer).is);
		expect(ledger()).toEqual(["flaky", "expired"]);
		// The timer finds nothing left to do: the question was already asked again.
		const rule = first(rows<{ id: number }>("SELECT id FROM actors WHERE kind = 'rule'")).id;
		expect(sweep(h.app, rule)).toBe(0);
		expect(h.call<InboxReply>("inbox", { kind: "failure" }).items.map((item) => item.q)).toEqual([again.q]);
		decide(again, { is: "defect" });
		expect(ledger()).toEqual(["flaky", "expired", "defect"]);
		expect(rows("SELECT supersedes FROM decisions WHERE kind = 'failure' ORDER BY id")).toEqual([
			{ supersedes: null },
			{ supersedes: 2 },
			{ supersedes: 3 },
		]);
	});

	test("withdrawing a 'mistaken' answer does not undo a correction the producer made since", () => {
		seed(2);
		const planned = plan({ name: "Open until the second case", select: {} });
		const other = h.actor("other", "human", ["read", "produce"]);
		const failed = report({
			run: planned.run,
			attempt: 2,
			results: [{ test: { case: "C-1" }, outcome: "fail", note: "wrong report" }],
		});
		report({ run: planned.run, results: [{ test: { case: "C-1" }, outcome: "pass" }] }, other);
		const dispute = open("failure");
		decide(dispute, { is: "mistaken" });
		report({
			run: planned.run,
			results: [{ test: { case: "C-1" }, outcome: "pass", corrects: first(failed.results) }],
		});
		expect(gate({ run: planned.run }).tally).toMatchObject({ pass: 1, missing: 1, disputed: 0 });
		h.call("decide", { undo: dispute.q });
		expect(gate({ run: planned.run }).tally).toMatchObject({ pass: 1, missing: 1, disputed: 0 });
		expect(first(slots(planned.run)).state).toBe("satisfied");
	});

	test("under a policy where a person adopts new cases, 'create cases' says so and leaves nothing behind", () => {
		usePolicy("strict");
		report(ciReport({ commit: "mapstrict", n: 1, file: "tests/new.spec.ts" }));
		const before = rows("SELECT count(*) AS n FROM proposals");
		const reply = decide(open("map"), { is: "create" }, h.owner, { reason: "make cases for them" });
		expect(reply.status).toBe("invalid");
		expect(reply.needs).toContain("propose the cases");
		expect(rows("SELECT count(*) AS n FROM proposals")).toEqual(before);
		expect(h.call<InboxReply>("inbox", { kind: "map" }).items).toHaveLength(1);
		// Where the policy adopts them at once, the same answer creates and links.
		usePolicy("standard");
		expect(decide(open("map"), { is: "create" }).status).toBe("decided");
		expect(rows("SELECT count(*) AS n FROM tests WHERE case_id IS NOT NULL")).toEqual([{ n: 1 }]);
	});

	test("an expired decision stays in the chain of the one that replaces it", () => {
		report(ciReport({ commit: "sweep001", n: 1, fail: { 0: "stable failure" } }));
		decide(open("failure"), { is: "flaky" });
		h.advance(15 * 86_400_000);
		const rule = first(rows<{ id: number }>("SELECT id FROM actors WHERE kind = 'rule'")).id;
		expect(sweep(h.app, rule)).toBe(1);
		decide(open("failure"), { is: "defect" });
		const ledger = rows<{ id: number; answer: string; supersedes: number | null }>(
			"SELECT id, answer, supersedes FROM decisions WHERE kind = 'failure' ORDER BY id",
		);
		expect(ledger.map((row) => JSON.parse(row.answer).is)).toEqual(["flaky", "expired", "defect"]);
		expect(ledger.map((row) => row.supersedes)).toEqual([null, ledger[0]?.id ?? -1, ledger[1]?.id ?? -1]);
	});

	test("an agent's report that no run admits ends nobody's answer and leaves the commit's gate where it was", () => {
		h.call("propose", {
			edits: [
				{ op: "create", outline: "One" },
				{ op: "create", outline: "Spare" },
			],
		});
		const target = { repo: "app", commit: "head0012", pr: 12 };
		plan({ name: "Release", select: {}, accepts: { repo: "app", commit: "head0012" } });
		const result = (outcome: string) => ({
			test: { key: "one" },
			annotation: { case: "C-1", version: 1 },
			outcome,
			...(outcome === "fail" ? { failure: { message: "shared cause" } } : {}),
		});
		// A pipeline fails the case and a person passes it: the slot is disputed, and a person calls it flaky.
		report({ target, results: [result("fail")] }, h.actor("pipeline", "ci", ["read", "produce"]));
		report({ target, results: [result("pass")] });
		const dispute = open("failure");
		expect((dispute.evidence as { hints: string[] }).hints).toContain("disputed");
		expect(decide(dispute, { is: "flaky" }).status).toBe("decided");
		expect(gate({ commit: "head0012", repo: "app" }).verdict).toBe("passed");
		// An agent reports the same failure. No run asked for agents and the case does not admit them.
		const later = report({ target, results: [result("fail")] }, h.actor("explorer", "agent", ["read", "produce"]));
		expect(later.questions.map((q) => q.how)).toEqual(["already decided"]);
		expect(gate({ commit: "head0012", repo: "app" }).verdict).toBe("passed");
		expect(
			rows<{ answer: string }>("SELECT answer FROM decisions WHERE kind = 'failure'").map(
				(d) => JSON.parse(d.answer).is,
			),
		).toEqual(["flaky"]);
	});

	test("an agent's failure is asked about even where a pipeline passes the same test", () => {
		const pipeline = h.actor("pipeline", "ci", ["read", "produce"]);
		const explorer = h.actor("explorer", "agent", ["read", "produce"]);
		const target = { commit: "found001", branch: "main" };
		report({ target, results: [{ test: { key: "checkout" }, outcome: "pass" }] }, pipeline);
		// The agent found a way to make it fail. The pipeline's pass, which came before, is no proof that it is gone.
		report(
			{ target, results: [{ test: { key: "checkout" }, outcome: "fail", failure: { message: "total is wrong" } }] },
			explorer,
		);
		expect(open("failure").title).toBe("total is wrong");
		// Nor is a pass that comes after: the pipeline never showed this failure, so it cannot show it gone.
		report({ target, results: [{ test: { key: "checkout" }, outcome: "pass" }] }, pipeline);
		expect(open("failure").title).toBe("total is wrong");
		expect(gate({ commit: "found001" }).verdict).toBe("passed");
	});

	test("an agent's report does not close a person's question about an older commit", () => {
		const pipeline = h.actor("pipeline", "ci", ["read", "produce"]);
		const explorer = h.actor("explorer", "agent", ["read", "produce"]);
		const fail = (key: string) => ({ test: { key }, outcome: "fail", failure: { message: "shared cause" } });
		report(
			{
				target: { commit: "older001", branch: "main" },
				results: [fail("slow"), { test: { key: "quick" }, outcome: "pass" }],
			},
			pipeline,
		);
		const asked = open("failure");
		// The next commit has only run the quick test so far: nothing shows the slow one's failure gone.
		report(
			{ target: { commit: "newer001", branch: "main" }, results: [{ test: { key: "quick" }, outcome: "pass" }] },
			pipeline,
		);
		expect(open("failure").q).toBe(asked.q);
		const before = gate({ commit: "older001" });
		// An agent reports the quick test failing with the same cause on the older commit. No gate counts that, and
		// the quick test's pass on the newer commit says nothing about a failure the pipeline never showed.
		report({ target: { commit: "older001", branch: "main" }, results: [fail("quick")] }, explorer);
		expect(open("failure").q).toBe(asked.q);
		expect(gate({ commit: "older001" })).toEqual(before);
	});

	test("an answer withdrawn after its failure went away leaves nobody asked", () => {
		const pipeline = h.actor("pipeline", "ci", ["read", "produce"]);
		report(
			{
				target: { commit: "gone0001", branch: "main" },
				results: [{ test: { key: "one" }, outcome: "fail", failure: { message: "old bug" } }],
			},
			pipeline,
		);
		const asked = open("failure");
		decide(asked, { is: "test" });
		// The next commit passes the test: the failure is gone. The answer stays what it was.
		report(
			{ target: { commit: "gone0002", branch: "main" }, results: [{ test: { key: "one" }, outcome: "pass" }] },
			pipeline,
		);
		// Withdrawing it does not put a question about a failure that no longer exists in front of anybody, and the
		// older commit's gate does not name a question nobody can find.
		h.call("decide", { undo: asked.q, reason: "wrong answer" });
		expect(h.call<InboxReply>("inbox", { kind: "failure" }).items).toEqual([]);
		const older = gate({ commit: "gone0001" });
		expect(older.verdict).toBe("blocked");
		expect(older.open).toEqual([]);
		// And a report that touches the older commit afterwards changes nothing about it.
		report(
			{ target: { commit: "gone0001", branch: "main" }, results: [{ test: { key: "other" }, outcome: "pass" }] },
			h.actor("explorer", "agent", ["read", "produce"]),
		);
		expect(gate({ commit: "gone0001" })).toEqual(older);
	});

	test("a rule does not sign off again a run that a person refused to sign off", () => {
		seed(2);
		const planned = plan({ name: "Release", select: {} });
		const pass = (ref: string, attempt = 1) =>
			report({ run: planned.run, attempt, results: [{ test: { case: ref }, outcome: "pass" }] });
		pass("C-1");
		pass("C-2");
		const stored = () =>
			first(rows<{ state: string; verdict: string }>("SELECT state, verdict FROM runs WHERE origin = 'planned'"));
		// Under `loose` a passing run is signed off by rule. A person takes that back and refuses it.
		expect(stored()).toEqual({ state: "closed", verdict: "passed" });
		h.call("decide", { undo: open("signoff", "decided").q, reason: "not yet" });
		expect(decide(open("signoff"), { is: "reject" }, h.owner, { reason: "coverage is thin" }).status).toBe("decided");
		expect(stored()).toEqual({ state: "open", verdict: "passed" });
		// One more result arrives. The run shows something new, so it is asked about again: of a person. The rule
		// does not answer over the head of whoever refused it.
		pass("C-1", 2);
		expect(stored()).toEqual({ state: "open", verdict: "passed" });
		const asked = open("signoff");
		expect(asked.needs).toContain("member");
		// And again when the next one arrives, while the question is still open.
		pass("C-2", 2);
		expect(stored()).toEqual({ state: "open", verdict: "passed" });
		// A person approving closes it.
		expect(decide(open("signoff"), { is: "approve" }).status).toBe("decided");
		expect(stored()).toEqual({ state: "closed", verdict: "passed" });
	});

	test("a question about a disputed result stays a dispute, whoever reports the cause next", () => {
		usePolicy("standard");
		h.call("propose", {
			edits: [
				{ op: "create", outline: "One" },
				{ op: "create", outline: "Spare" },
			],
		});
		const target = { repo: "app", commit: "head0013", pr: 13 };
		plan({ name: "Release", select: {}, accepts: { repo: "app", commit: "head0013" } });
		const result = (outcome: string) => ({
			test: { key: "one" },
			annotation: { case: "C-1", version: 1 },
			outcome,
			...(outcome === "fail" ? { failure: { message: "shared cause" } } : {}),
		});
		report({ target, results: [result("fail")] }, h.actor("pipeline", "ci", ["read", "produce"]));
		report({ target, results: [result("pass")] });
		expect(open("failure").answers).toContain("mistaken");
		// The same cause from an agent, in a report that touches no slot. The slot is still disputed, so the
		// question is still about a dispute: with the answers a dispute has, and its rule about who may give them.
		report({ target, results: [result("fail")] }, h.actor("explorer", "agent", ["read", "produce"]));
		const still = open("failure");
		expect((still.evidence as { hints: string[] }).hints).toContain("disputed");
		expect(still.answers).toContain("mistaken");
		// The owner reported the pass: under `standard` a party to the dispute may not settle it.
		expect(decide(still, { is: "mistaken" }).status).toBe("forbidden");
	});

	test("a pipeline's pass does not close the question about a failure a planned run still shows", () => {
		seed(1, ["human", "agent"]);
		const agent = h.actor("agent", "agent", ["read", "produce"]);
		const pipeline = h.actor("pipeline", "ci", ["read", "produce"]);
		const planned = plan({
			name: "Agent run",
			select: {},
			accepts: { commit: "agentq01" },
			require: exercise(["agent"]),
		});
		const target = { commit: "agentq01", branch: "main" };
		const one = { test: { key: "one" }, annotation: { case: "C-1", version: 1 } };
		report({ target, results: [{ ...one, outcome: "fail", failure: { message: "same cause" } }] }, agent);
		const question = open("failure");
		expect(gate({ run: planned.run })).toMatchObject({ verdict: "blocked", open: [question.q] });
		// The pipeline's result cannot fill a slot that asked for an agent, so the run still shows the failure.
		report({ target, results: [{ ...one, outcome: "pass" }] }, pipeline);
		expect(gate({ run: planned.run })).toMatchObject({ verdict: "blocked", open: [question.q] });
		expect(open("failure").q).toBe(question.q);
		expect(decide(open("failure"), { is: "flaky" }).status).toBe("decided");
		expect(gate({ run: planned.run }).verdict).toBe("passed");
	});

	test("the question about an agent's failure closes when the agent's next attempt passes", () => {
		seed(1, ["human", "agent"]);
		const agent = h.actor("agent", "agent", ["read", "produce"]);
		const planned = plan({
			name: "Agent run",
			select: {},
			accepts: { commit: "agentq02" },
			require: exercise(["agent"]),
		});
		const target = { commit: "agentq02", branch: "main" };
		const one = { test: { key: "one" }, annotation: { case: "C-1", version: 1 } };
		report({ target, results: [{ ...one, outcome: "fail", failure: { message: "same cause" } }] }, agent);
		expect(gate({ run: planned.run }).verdict).toBe("blocked");
		report({ target, attempt: 2, results: [{ ...one, outcome: "pass" }] }, agent);
		expect(h.call<InboxReply>("inbox", { kind: "failure", limit: 50 }).items).toEqual([]);
		expect(rows("SELECT state FROM questions WHERE kind = 'failure'")).toEqual([{ state: "dissolved" }]);
		expect(gate({ run: planned.run }).open).toEqual([]);
	});

	test("an answer for one environment still stands after the other environment was asked about", () => {
		const target = (env: string) => ({ commit: "twoenv01", branch: "main", env });
		const failing = { test: { key: "one" }, outcome: "fail", failure: { message: "same cause" } };
		for (const env of ["staging", "production"]) report({ target: target(env), results: [failing] });
		const production = open("failure");
		expect(decide(production, { is: "infra" }).status).toBe("decided");
		const staging = open("failure");
		expect(staging.q).not.toBe(production.q);
		expect(decide(staging, { is: "infra" }).status).toBe("decided");
		expect(gate({ commit: "twoenv01" }).verdict).toBe("passed");

		// The same cause in production again: it was decided there, and nobody is asked a second time.
		const later = report({ target: target("production"), attempt: 2, results: [failing] });
		expect(later.questions.map((q) => [q.q, q.how])).toEqual([[production.q, "already decided"]]);
		expect(h.call<InboxReply>("inbox", { kind: "failure", limit: 50 }).items).toEqual([]);
		expect(later.gate?.verdict).toBe("passed");

		// It is withdrawn where it was made, and only production is open again.
		const undone = first(h.call<DecideReply[]>("decide", { undo: production.q }));
		expect(undone.status).toBe("reopened");
		expect(gate({ commit: "twoenv01" })).toMatchObject({ verdict: "blocked", open: [production.q] });
		expect(rows("SELECT count(*) AS n FROM excuses")).toEqual([{ n: 1 }]);
		// Answered again, it does not ask about staging a second time: staging's answer stands.
		expect(decide(open("failure"), { is: "infra" }).status).toBe("decided");
		expect(h.call<InboxReply>("inbox", { kind: "failure", limit: 50 }).items).toEqual([]);
		expect(gate({ commit: "twoenv01" }).verdict).toBe("passed");
		expect(rows("SELECT count(*) AS n FROM questions WHERE kind = 'failure'")).toEqual([{ n: 2 }]);
	});

	test("whoever reported the failure cannot settle the dispute about it, whoever raised the dispute", () => {
		usePolicy("standard");
		h.call("propose", {
			edits: [
				{ op: "create", outline: "First" },
				{ op: "create", outline: "Second" },
			],
		});
		const planned = plan({ name: "Keep open", select: {} });
		const other = h.actor("other", "human", ["read", "produce", "answer"]);
		const third = h.actor("third", "human", ["read", "produce", "answer"]);
		report({ run: planned.run, results: [{ test: { case: "C-1" }, outcome: "fail", note: "same failure" }] });
		// The question exists before there is a dispute; the other member's pass, a later report, makes it one.
		const before = open("failure");
		expect((before.evidence as { hints: string[] }).hints).not.toContain("disputed");
		report({ run: planned.run, results: [{ test: { case: "C-1" }, outcome: "pass" }] }, other);
		const dispute = open("failure");
		expect(dispute.q).toBe(before.q);
		expect((dispute.evidence as { hints: string[] }).hints).toContain("disputed");
		// The owner reported the failure, the other member the pass: neither may say which of them was wrong.
		expect(decide(dispute, { is: "mistaken" }).status).toBe("forbidden");
		expect(decide(dispute, { is: "mistaken" }, other).status).toBe("forbidden");
		expect(rows("SELECT count(*) AS n FROM slot_results WHERE discounted_by IS NOT NULL")).toEqual([{ n: 0 }]);
		expect(decide(dispute, { is: "mistaken" }, third).status).toBe("decided");
	});

	test("a failure already explained is not asked about again because somebody else then passed", () => {
		// Who may answer is judged when the answer is given. Under `standard` a dispute is kept from the people
		// who reported the results; this answer was given before there was one, and it stands. (That the order of
		// the answer and the second result matters is a recorded limit of answers per cause: issue #70.)
		usePolicy("standard");
		h.call("propose", {
			edits: [
				{ op: "create", outline: "First" },
				{ op: "create", outline: "Second" },
			],
		});
		const planned = plan({ name: "Keep open", select: {} });
		const other = h.actor("other", "human", ["read", "produce", "answer"]);
		report({ run: planned.run, results: [{ test: { case: "C-1" }, outcome: "fail", note: "same failure" }] });
		expect(decide(open("failure"), { is: "flaky" }).status).toBe("decided");
		// The answer stands on the cause, not on who else has reported since: it is not ended by a later pass.
		report({ run: planned.run, results: [{ test: { case: "C-1" }, outcome: "pass" }] }, other);
		expect(h.call<InboxReply>("inbox", { kind: "failure", limit: 50 }).items).toEqual([]);
		expect(rows<{ answer: string }>("SELECT answer FROM decisions WHERE kind = 'failure'")).toHaveLength(1);
		expect(first(slots(planned.run)).state).toBe("disputed");
		expect(gate({ run: planned.run }).tally).toMatchObject({ pass: 1, disputed: 0, unexplained: 0 });
	});

	test("once a failure is disputed, changing or withdrawing its answer is held to the clause for disputes", () => {
		usePolicy("standard");
		seed(2);
		const bob = h.actor("bob", "human", ["read", "produce", "answer"]);
		const carol = h.actor("carol", "human", ["read", "produce", "answer"]);
		const planned = plan({ name: "Keep open", select: {} });
		const typed = (outcome: string) => ({
			run: planned.run,
			results: [{ test: { case: "C-1" }, outcome, ...(outcome === "fail" ? { note: "same cause" } : {}) }],
		});
		// The owner reports a failure and answers it: nothing disputes it yet. Then Bob passes the case.
		report(typed("fail"));
		expect(decide(open("failure"), { is: "flaky" }).status).toBe("decided");
		report(typed("pass"), bob);
		expect(first(slots(planned.run)).state).toBe("disputed");
		// The answer given before stands (issue #70). But the failure is a dispute now, and what is done about it
		// from here on is held to the clause for disputes, which keeps it from the two who reported the results.
		const disputed = open("failure", "decided");
		expect(disputed.answers).toContain("mistaken");
		expect(disputed.needs).toContain("did not produce");
		expect((disputed.evidence as { hints: string[] }).hints).toContain("disputed");
		expect(decide(disputed, { is: "infra" }).status).toBe("forbidden");
		expect(decide(disputed, { is: "infra" }, bob).status).toBe("forbidden");
		expect(first(h.call<DecideReply[]>("decide", { undo: disputed.q, reason: "take it back" })).status).toBe(
			"forbidden",
		);
		expect(first(h.call<DecideReply[]>("decide", { undo: disputed.q, reason: "take it back" }, bob)).status).toBe(
			"forbidden",
		);
		expect(rows<{ answer: string }>("SELECT answer FROM decisions WHERE kind = 'failure'")).toHaveLength(1);
		// Someone who reported neither result may change it.
		expect(decide(disputed, { is: "infra" }, carol).status).toBe("decided");
	});

	test("an answer given to a dispute is not undone by the people it was kept from, once the dispute no longer shows", () => {
		usePolicy("standard");
		const alice = h.actor("alice", "human", ["read", "produce", "answer", "plan"]);
		const bob = h.actor("bob", "human", ["read", "produce", "answer", "plan"]);
		const carol = h.actor("carol", "human", ["read", "produce", "answer", "plan"]);
		seed(2);
		// Two shapes of "no longer shows": the run stays open and the judged result is set aside (`mistaken`), or
		// the run passes on the answer and is closed.
		const shapes = [
			{ name: "open", select: {}, first: "mistaken", other: "flaky" },
			{ name: "open", select: {}, first: "flaky", other: "infra" },
			{ name: "closed", select: { cases: ["C-1"] }, first: "mistaken", other: "flaky" },
			{ name: "closed", select: { cases: ["C-1"] }, first: "flaky", other: "infra" },
		];
		shapes.forEach((shape, index) => {
			const commit = `dispute${String(index).padStart(3, "0")}`;
			const planned = h.call<PlanReply>("plan", { name: commit, select: shape.select, accepts: { commit } }, alice);
			const typed = (outcome: string) => ({
				run: planned.run,
				results: [{ test: { case: "C-1" }, outcome, ...(outcome === "fail" ? { note: `cause ${index}` } : {}) }],
			});
			report(typed("fail"), alice);
			report(typed("pass"), bob);
			const dispute = open("failure");
			expect(decide(dispute, { is: "flaky" }, alice).status).toBe("forbidden");
			expect(decide(dispute, { is: shape.first }, carol).status).toBe("decided");
			const state = first(rows<{ state: string }>("SELECT state FROM runs WHERE no = ?", Number(planned.run.slice(2))));
			expect(state.state).toBe(shape.name);
			// Alice reported the failure. She may neither take Carol's judgement back nor put her own in its place.
			const judged = first(
				h
					.call<InboxReply>("inbox", { kind: "failure", state: "decided", limit: 500 })
					.items.filter((item) => item.q === dispute.q),
			);
			expect(first(h.call<DecideReply[]>("decide", { undo: judged.q, reason: "no" }, alice)).status).toBe("forbidden");
			expect(decide(judged, { is: shape.other }, alice).status).toBe("forbidden");
			expect(decide(judged, { is: shape.other }, bob).status).toBe("forbidden");
			// Carol, or anyone who reported neither result, still may.
			expect(first(h.call<DecideReply[]>("decide", { undo: judged.q, reason: "again" }, carol)).status).toBe(
				"reopened",
			);
		});
	});

	test("withdrawing an answer needs what giving it needs: not the producer, and a reason where one is required", () => {
		usePolicy("strict");
		const producer = h.actor("producer", "human", ["read", "produce", "answer"]);
		const other = h.actor("other", "human", ["read", "produce", "answer"]);
		const results = [{ test: { key: "one" }, outcome: "fail", failure: { message: "same failure" } }];
		report({ target: { commit: "undo0001", branch: "main" }, results }, producer);
		const question = open("failure");
		expect(decide(question, { is: "defect" }, other, { reason: "confirmed in the product" }).status).toBe("decided");
		const undo = (as: typeof producer, reason?: string) =>
			first(h.call<DecideReply[]>("decide", { undo: question.q, ...(reason ? { reason } : {}) }, as));
		// The producer may not replace the answer, and may not take it away either.
		expect(undo(producer, "it is mine").status).toBe("forbidden");
		// Somebody who may answer still owes the reason the clause asks for.
		expect(undo(other).status).toBe("invalid");
		expect(gate({ commit: "undo0001" }).verdict).toBe("failed");
		expect(undo(other, "classified too early").status).toBe("reopened");
		expect(gate({ commit: "undo0001" }).verdict).toBe("blocked");
	});

	test("a producer whose failure took on an existing answer cannot replace that answer", () => {
		usePolicy("strict");
		const one = h.actor("one", "human", ["read", "produce", "answer"]);
		const two = h.actor("two", "human", ["read", "produce", "answer"]);
		const results = [{ test: { key: "one" }, outcome: "fail", failure: { message: "same failure" } }];
		report({ target: { commit: "carry001", branch: "main" }, results }, one);
		expect(decide(open("failure"), { is: "flaky" }, h.owner, { reason: "seen before" }).status).toBe("decided");
		report({ target: { commit: "carry001", branch: "main" }, job: "other", results }, two);
		const decided = open("failure", "decided");
		expect(decide(decided, { is: "infra" }, two, { reason: "it is mine" }).status).toBe("forbidden");
		expect(decide(decided, { is: "infra" }, one, { reason: "it is mine" }).status).toBe("forbidden");
		expect(rows<{ answer: string }>("SELECT answer FROM decisions WHERE kind = 'failure'")).toHaveLength(1);
	});

	test("when a carried answer stops holding, every run that rested on it is recomputed", () => {
		const failing = { test: { key: "one" }, outcome: "fail", failure: { message: "same cause" } };
		const pr = (commit: string) => ({ repo: "app", commit, pr: 1, branch: "feature" });
		report({ target: pr("headfail1"), results: [failing] });
		expect(decide(open("failure"), { is: "flaky" }).status).toBe("decided");
		// The second commit of the change fails the same way and takes the answer on.
		expect(report({ target: pr("headfail2"), results: [failing] }).gate?.verdict).toBe("passed");
		expect(gate({ commit: "headfail1", repo: "app" }).verdict).toBe("passed");
		// The answer runs out (flaky holds for fourteen days). A third commit fails: the answer is ended there.
		h.advance(15 * 86_400_000);
		expect(report({ target: pr("headfail3"), results: [failing] }).gate?.verdict).toBe("blocked");
		// The earlier commits rested on the same answer. Their gates are recomputed, not left reading `passed`.
		expect(gate({ commit: "headfail1", repo: "app" }).verdict).toBe("blocked");
		expect(gate({ commit: "headfail2", repo: "app" }).verdict).toBe("blocked");
	});

	test("replacing an answer that covered every environment asks again about the one it leaves uncovered", () => {
		const target = (env: string) => ({ commit: "twoenv02", branch: "main", env });
		const failing = { test: { key: "one" }, outcome: "fail", failure: { message: "same cause" } };
		for (const env of ["staging", "production"]) report({ target: target(env), results: [failing] });
		const production = open("failure");
		expect(decide(production, { is: "infra" }).status).toBe("decided");
		const staging = open("failure");
		h.call("decide", { undo: production.q });
		// Flaky covers the cause everywhere, so production's question has its answer and is closed.
		expect(decide(staging, { is: "flaky" }).status).toBe("decided");
		expect(h.call<InboxReply>("inbox", { kind: "failure", limit: 50 }).items).toEqual([]);
		expect(gate({ commit: "twoenv02" }).verdict).toBe("passed");
		// Changed to an answer for staging only: production is unexplained again, and somebody is asked.
		expect(decide(open("failure", "decided"), { is: "infra" }).status).toBe("decided");
		const asked = h.call<InboxReply>("inbox", { kind: "failure", limit: 50 }).items;
		expect(asked).toHaveLength(1);
		expect(gate({ commit: "twoenv02" })).toMatchObject({ verdict: "blocked", open: [first(asked).q] });
		expect(decide(first(asked), { is: "infra" }).status).toBe("decided");
		expect(gate({ commit: "twoenv02" }).verdict).toBe("passed");
	});

	test("a run reopened after its failure's question was closed is asked about that failure again", () => {
		seed();
		const result = (outcome: string, attempt: number) =>
			report({
				target: { commit: "reopen01", branch: "main" },
				attempt,
				results: [
					{
						test: { key: "one" },
						annotation: { case: "C-1", version: 1 },
						outcome,
						...(outcome === "fail" ? { failure: { message: "same cause" } } : {}),
					},
				],
			});
		result("fail", 1);
		const planned = plan({ name: "Reopen later", select: {}, accepts: { commit: "reopen01" } });
		const question = open("failure");
		decide(question, { is: "flaky" });
		const signoff = h
			.call<InboxReply>("inbox", { state: "decided", limit: 50 })
			.items.find((item) => item.kind === "signoff");
		if (!signoff) throw new Error("the run was not signed off");
		h.call("decide", { undo: question.q });
		// The case is edited and the commit passes on a newer attempt, proving the new version. The run is pinned
		// to the version it was planned on, so that pass is not its evidence: reopened, it still shows the failure.
		h.call("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Case 1, reworded" } }] });
		report({
			target: { commit: "reopen01", branch: "main" },
			attempt: 2,
			results: [{ test: { key: "one" }, annotation: { case: "C-1", version: 2 }, outcome: "pass" }],
		});
		expect(gate({ commit: "reopen01" }).verdict).toBe("passed");
		expect(h.call<InboxReply>("inbox", { kind: "failure", limit: 50 }).items).toEqual([]);
		expect(first(h.call<DecideReply[]>("decide", { undo: signoff.q })).status).toBe("reopened");
		const asked = h.call<InboxReply>("inbox", { kind: "failure", limit: 50 }).items;
		expect(asked).toHaveLength(1);
		expect(gate({ run: planned.run })).toMatchObject({ verdict: "blocked", open: [first(asked).q] });
		expect(decide(first(asked), { is: "flaky" }).status).toBe("decided");
		expect(gate({ run: planned.run }).verdict).toBe("passed");
	});

	test("an answer that takes the place of another question's answer ends it, and every run that rested on it follows", () => {
		const failing = { test: { key: "one" }, outcome: "fail", failure: { message: "same cause" } };
		const on = (commit: string, env: string, attempt = 1) =>
			report({ target: { commit, branch: "main", env }, attempt, results: [failing] });
		on("first001", "staging");
		on("first001", "production");
		const production = open("failure");
		expect(decide(production, { is: "infra" }).status).toBe("decided");
		// Staging is called flaky: an answer about the cause wherever it shows. It is the newer judgement on
		// production too, so production's own answer is ended, and its question points at the one in force.
		const staging = open("failure");
		expect(decide(staging, { is: "flaky" }).status).toBe("decided");
		const stale = decide(production, { is: "defect" });
		expect(stale).toMatchObject({ status: "conflict" });
		expect(stale.needs).toContain(staging.q);
		// The next commit rests on the flaky answer.
		expect(on("second01", "staging").gate?.verdict).toBe("passed");
		// The answer in force is changed to a defect: both commits follow.
		expect(decide(open("failure", "decided"), { is: "defect" }).status).toBe("decided");
		expect(gate({ commit: "first001" }).verdict).toBe("failed");
		expect(gate({ commit: "second01" }).verdict).toBe("failed");
		// One answer in force for the cause, and the ledger says what became of the others.
		const ledger = rows<{ answer: string }>("SELECT answer FROM decisions WHERE kind = 'failure' ORDER BY id").map(
			(row) => JSON.parse(row.answer).is,
		);
		expect(ledger).toEqual(["infra", "outdated", "flaky", "defect"]);
		const retried = on("second01", "staging", 2);
		expect(retried.questions.map((q) => q.answer)).toEqual(["defect"]);
		expect(retried.gate?.verdict).toBe("failed");
	});

	test("a failure decided to be a mistake does not hold the commit's gate, and withdrawing the decision puts it back", () => {
		usePolicy("standard");
		h.call("propose", { edits: [{ op: "create", outline: "Case one" }] });
		const target = { commit: "rc300005", branch: "main" };
		report({ target, results: [{ test: { key: "a.spec.ts::one" }, annotation: { case: "C-1" }, outcome: "pass" }] });
		const planned = plan({ name: "rc3", select: { cases: ["C-1"] }, accepts: { commit: "rc300005" } });
		// The run closed by rule on the pipeline's pass; it is reopened to test by hand.
		h.call("decide", { undo: open("signoff", "decided").q });
		report({ run: planned.run, results: [{ test: { case: "C-1" }, outcome: "fail", note: "Total is wrong" }] });
		expect(gate({ commit: "rc300005" }).verdict).toBe("blocked");
		const lead = h.actor("mira", "human", ["read", "produce", "answer"]);
		const dispute = open("failure");
		expect(decide(dispute, { is: "mistaken" }, lead).status).toBe("decided");
		expect(first(slots(planned.run)).state).toBe("satisfied");
		// The commit's own gate no longer counts the result either, and nobody is asked about it again.
		expect(gate({ commit: "rc300005" })).toMatchObject({ verdict: "passed", open: [] });
		expect(h.call<InboxReply>("inbox", { kind: "failure", limit: 50 }).items).toEqual([]);
		// Withdrawn: the failure counts again in the run and in the commit's gate, with its question open.
		expect(first(h.call<DecideReply[]>("decide", { undo: dispute.q }, lead)).status).toBe("reopened");
		expect(first(slots(planned.run)).state).toBe("disputed");
		expect(gate({ commit: "rc300005" })).toMatchObject({ verdict: "blocked", open: [dispute.q] });
	});

	test("a 'mistaken' answer is about the results it named: the same failure reported again is asked about again", () => {
		h.call("propose", {
			edits: [
				{ op: "create", outline: "First" },
				{ op: "create", outline: "Keep open" },
			],
		});
		const planned = plan({ name: "Mistaken, then again", select: {} });
		const other = h.actor("other", "human", ["read", "produce"]);
		const record = (outcome: string, attempt: number, as = h.owner) =>
			report(
				{
					run: planned.run,
					attempt,
					results: [{ test: { case: "C-1" }, outcome, ...(outcome === "fail" ? { note: "same cause" } : {}) }],
				},
				as,
			);
		record("fail", 1);
		record("pass", 1, other);
		const dispute = open("failure");
		expect(decide(dispute, { is: "mistaken" }).status).toBe("decided");
		expect(gate({ run: planned.run }).tally.disputed).toBe(0);
		// The same person fails it again. That is a new result: the earlier decision said nothing about it.
		const later = record("fail", 2);
		expect(later.questions.map((q) => q.how)).toEqual(["new"]);
		const asked = open("failure");
		expect(asked.q).not.toBe(dispute.q);
		expect(gate({ run: planned.run })).toMatchObject({ verdict: "blocked", open: [asked.q] });
		// The first result stays discounted by the first decision.
		expect(rows("SELECT count(*) AS n FROM slot_results WHERE discounted_by IS NOT NULL")).toEqual([{ n: 1 }]);
	});

	test("an answer for the whole cause takes the place of every narrower answer, and their runs follow", () => {
		const failing = { test: { key: "one" }, outcome: "fail", failure: { message: "same cause" } };
		const on = (commit: string, attempt = 1) =>
			report({ target: { commit, branch: "main" }, attempt, results: [failing] });
		on("first001");
		const earlier = open("failure");
		expect(decide(earlier, { is: "infra" }).status).toBe("decided");
		on("second01");
		expect(decide(open("failure"), { is: "infra" }).status).toBe("decided");
		expect(gate({ commit: "second01" }).verdict).toBe("passed");
		// The first answer is changed to a defect, which is about the cause wherever it shows.
		expect(decide(earlier, { is: "defect" }).status).toBe("decided");
		expect(gate({ commit: "first001" }).verdict).toBe("failed");
		expect(gate({ commit: "second01" }).verdict).toBe("failed");
		const ledger = rows<{ answer: string }>("SELECT answer FROM decisions WHERE kind = 'failure' ORDER BY id").map(
			(row) => JSON.parse(row.answer).is,
		);
		expect(ledger).toEqual(["infra", "infra", "outdated", "defect"]);
		const retried = on("second01", 2);
		expect(retried.questions.map((q) => q.answer)).toEqual(["defect"]);
		expect(retried.gate?.verdict).toBe("failed");
	});

	test("every live run that shows a failure lists the question about it, not only the first one recomputed", () => {
		h.call("propose", {
			edits: [
				{ op: "create", outline: "Case" },
				{ op: "create", outline: "Spare" },
			],
		});
		const on = (commit: string) =>
			report({
				target: { commit, branch: "main" },
				results: [
					{
						test: { key: "one" },
						annotation: { case: "C-1", version: 1 },
						outcome: "fail",
						failure: { message: "same cause" },
					},
				],
			});
		on("first001");
		const plans = [1, 2].map((i) => plan({ name: `Plan ${i}`, select: {}, accepts: { commit: "first001" } }).run);
		on("second01");
		// Answered for the newer build only: both runs on the earlier build still show the failure.
		expect(decide(open("failure"), { is: "infra" }).status).toBe("decided");
		const asked = h.call<InboxReply>("inbox", { kind: "failure", limit: 50 }).items;
		expect(asked).toHaveLength(1);
		for (const run of plans) expect(gate({ run })).toMatchObject({ verdict: "blocked", open: [first(asked).q] });
	});

	test("a sign-off asked while a run passed cannot close it once it no longer passes", () => {
		usePolicy("strict");
		h.call("propose", { edits: [{ op: "create", outline: "Case" }] });
		decide(open("adopt"), { is: "accept" }, h.owner, { reason: "first version" });
		const planned = plan({ name: "Sign-off", select: {} });
		const other = h.actor("other", "human", ["read", "produce"]);
		report({ run: planned.run, results: [{ test: { case: "C-1" }, outcome: "pass" }] });
		const signoff = open("signoff");
		expect((signoff.evidence as { verdict: string }).verdict).toBe("passed");
		// Somebody else fails the same case before the sign-off is answered.
		report({ run: planned.run, results: [{ test: { case: "C-1" }, outcome: "fail", note: "broken" }] }, other);
		expect(gate({ run: planned.run }).verdict).toBe("blocked");
		const late = decide(signoff, { is: "approve" }, h.owner, { reason: "looked fine" });
		expect(late.status).toBe("conflict");
		expect(rows("SELECT state FROM runs WHERE origin = 'planned'")).toEqual([{ state: "open" }]);
		expect(h.call<InboxReply>("inbox", { kind: "signoff", limit: 50 }).items).toEqual([]);
	});

	test("'mistaken' reaches the results its question is about, and every run that holds one is recomputed", () => {
		h.call("propose", {
			edits: [
				{ op: "create", outline: "One" },
				{ op: "create", outline: "Spare" },
			],
		});
		const other = h.actor("second", "human", ["read", "produce"]);
		const result = (outcome: string, key = "one", ref = "C-1") => ({
			test: { key },
			annotation: { case: ref, version: 1 },
			outcome,
			...(outcome === "fail" ? { failure: { message: "shared cause" } } : {}),
		});
		const on = (env: string, outcome: string, as = h.owner) =>
			report({ target: { commit: "build001", branch: "main", env }, results: [result(outcome)] }, as);
		const everywhere = plan({ name: "All environments", select: {}, accepts: { commit: "build001" } });
		// A failure and another person's pass dispute the case in production. It is called infrastructure there.
		on("prod", "fail");
		on("prod", "pass", other);
		const production = open("failure");
		expect(decide(production, { is: "infra" }).status).toBe("decided");
		// The same dispute in staging, which has its own question; and a second run over staging only.
		on("staging", "fail");
		on("staging", "pass", other);
		report({
			target: { commit: "build001", branch: "main", env: "staging" },
			results: [result("pass", "spare", "C-2")],
		});
		const staging = plan({ name: "Staging only", select: {}, accepts: { commit: "build001", env: "staging" } });
		expect(gate({ run: staging.run })).toMatchObject({ verdict: "blocked", tally: { disputed: 1 } });
		// Production's answer is changed to `mistaken`. That is about production's failing result, not staging's.
		expect(decide(production, { is: "mistaken" }).status).toBe("decided");
		const discounted = rows<{ env: string }>(
			`SELECT DISTINCT t.env FROM slot_results s JOIN results r ON r.id = s.result JOIN targets t ON t.id = r.target
			 WHERE s.discounted_by IS NOT NULL`,
		);
		expect(discounted).toEqual([{ env: "prod" }]);
		// Every run's stored gate is what its slots show now.
		for (const run of [everywhere.run, staging.run]) {
			const states = slots(run).map((slot) => slot.state);
			const status = gate({ run });
			expect(status.tally.disputed ?? 0).toBe(states.filter((state) => state === "disputed").length);
			expect(status.verdict).toBe(states.includes("disputed") ? "blocked" : "passed");
		}
		expect(gate({ run: staging.run }).open).toHaveLength(1);
	});

	test("a run closed on an answer that later stops holding names the question asked in its place", () => {
		seed();
		const failing = {
			test: { key: "one" },
			outcome: "fail",
			failure: { message: "same cause" },
			annotation: { case: "C-1", version: 1 },
		};
		const head = { repo: "app", commit: "headfail1", pr: 1, branch: "feature" };
		report({ target: head, results: [failing] });
		expect(decide(open("failure"), { is: "flaky" }).status).toBe("decided");
		// Planned over the failure that was called flaky: it passes on that answer, and the rule closes it.
		const planned = plan({ name: "Prior plan", select: {}, accepts: { commit: "headfail1", repo: "app" } });
		expect(gate({ run: planned.run }).verdict).toBe("passed");
		expect(rows("SELECT state FROM runs WHERE origin = 'planned'")).toEqual([{ state: "closed" }]);
		// The answer runs out and the same failure is reported again: the answer is ended by that report.
		h.advance(15 * 86_400_000);
		report({ target: head, attempt: 2, results: [failing] });
		const asked = open("failure");
		expect(gate({ run: planned.run })).toMatchObject({ verdict: "blocked", open: [asked.q] });
		expect(decide(asked, { is: "flaky" }).status).toBe("decided");
		expect(gate({ run: planned.run }).verdict).toBe("passed");
	});
});

describe("what a caller is told", () => {
	test("a command id used in another project is a conflict, not the first project's reply", () => {
		const cmd = "same-command-01";
		const made = h.raw("propose", { cmd, edits: [{ op: "create", outline: "Once" }] });
		const again = h.raw("propose", { cmd, edits: [{ op: "create", outline: "Once" }] });
		expect(again).toEqual(made);
		h.call("admin", { do: "project.create", key: "other" });
		const cross = invoke(h.app, OPS, {
			op: "propose",
			project: "other",
			input: { cmd, edits: [{ op: "create", outline: "Other project" }] },
			actor: () => h.owner,
		});
		expect(cross).toMatchObject({ ok: false, error: { code: "conflict" } });
	});

	test("a command id sent again with another request is refused, not answered with the first reply", () => {
		const cmd = "same-command-02";
		const made = h.raw("propose", { cmd, edits: [{ op: "create", outline: "Typed so far" }] });
		expect(made.ok).toBe(true);
		// The same id with more text in it: a client that kept the id while the person typed on. Replaying the
		// first reply would tell it the longer text was saved.
		const more = h.raw("propose", { cmd, edits: [{ op: "create", outline: "Typed so far, and then some" }] });
		expect(more).toMatchObject({ ok: false, error: { code: "conflict" } });
		expect(more.ok ? "" : more.error.message).toContain("another request");
		expect(rows("SELECT count(*) AS n FROM cases")).toEqual([{ n: 1 }]);
		// The unchanged request is still a retry.
		expect(h.raw("propose", { cmd, edits: [{ op: "create", outline: "Typed so far" }] })).toEqual(made);
		// The same for a command on the instance.
		const admin = h.raw("admin", { do: "project.create", key: "first-key", cmd: "admin-command-02" });
		expect(admin.ok).toBe(true);
		expect(h.raw("admin", { do: "project.create", key: "second-key", cmd: "admin-command-02" })).toMatchObject({
			ok: false,
			error: { code: "conflict" },
		});
	});

	test("a retry is the same request however a client orders the keys of its objects", () => {
		const cmd = "reordered-request-01";
		const body = (fields: Record<string, string>) => ({ title: "Ordered", methods: ["human"], fields });
		const made = h.raw("propose", { cmd, edits: [{ op: "create", body: body({ a: "one", b: "two" }) }] });
		expect(made.ok).toBe(true);
		expect(h.raw("propose", { edits: [{ op: "create", body: body({ b: "two", a: "one" }) }], cmd })).toEqual(made);
		// The order of a list is part of what was asked.
		const two = (titles: string[]) => ({
			cmd: "reordered-request-02",
			edits: titles.map((title) => ({ op: "create", outline: title })),
		});
		expect(h.raw("propose", two(["First", "Second"])).ok).toBe(true);
		expect(h.raw("propose", two(["Second", "First"]))).toMatchObject({ ok: false, error: { code: "conflict" } });
	});

	test("a selection that names more cases than a run may hold is refused whole", () => {
		seed(1);
		const cases = Array.from({ length: 20_001 }, () => "C-1");
		expect(() => plan({ name: "Too many", select: { cases } })).toThrow("20,000");
		expect(rows("SELECT count(*) AS n FROM runs")).toEqual([{ n: 0 }]);
	});

	test("a pass that disputes a failure leaves the failure's message and sample on its question", () => {
		seed(2, ["human", "auto"]);
		const planned = plan({ name: "Release", select: {}, accepts: { commit: "message01" } });
		report({ run: planned.run, results: [{ test: { case: "C-1" }, outcome: "fail", note: "expected 10, got 12" }] });
		const asked = open("failure").evidence as { message: string; sample: number };
		expect(asked.message).toBe("expected 10, got 12");
		// A pipeline then passes the same case on that commit: the slot is disputed. The question is still about
		// the failure, and still shows it.
		report(
			{
				target: { commit: "message01", branch: "main" },
				results: [{ test: { key: "one" }, annotation: { case: "C-1", version: 1 }, outcome: "pass" }],
			},
			h.actor("pipeline", "ci", ["read", "produce"]),
		);
		const now = open("failure");
		expect((now.evidence as { hints: string[] }).hints).toContain("disputed");
		expect(now.evidence).toMatchObject({ message: asked.message, sample: asked.sample });
		expect((now.evidence as { tests: unknown[] }).tests).toHaveLength(1);
	});

	test("the number of tests a question has seen does not fall when a later report adds one", () => {
		const ci = h.actor("pipeline", "ci", ["read", "produce"]);
		const failing = (key: string) => ({ test: { key }, outcome: "fail", failure: { message: "one cause" } });
		const target = { commit: "many0001", branch: "main" };
		report({ target, results: Array.from({ length: 60 }, (_, i) => failing(`t${i}`)) }, ci);
		expect(open("failure").evidence).toMatchObject({ count: 60 });
		report({ target, job: "second", results: [failing("one-more")] }, ci);
		const seen = open("failure").evidence as { count: number; tests: unknown[] };
		expect(seen.count).toBeGreaterThanOrEqual(60);
		expect(seen.tests).toHaveLength(50);
	});

	test("a question says who is asked under the policy in force, not the one it was asked under", () => {
		report(ciReport({ commit: "policy001", n: 1, fail: { 0: "bug" } }), h.actor("pipeline", "ci", ["read", "produce"]));
		const before = open("failure").needs;
		usePolicy("strict");
		const after = open("failure").needs;
		expect(after).not.toBe(before);
		expect(after).toContain("did not produce");
	});

	test("an instance command sent twice returns its first reply", () => {
		const input = { do: "project.create", key: "idempotent-admin", cmd: "admin-command-01" };
		const made = h.raw("admin", input);
		expect(made.ok).toBe(true);
		expect(h.raw("admin", input)).toEqual(made);
		// A reply that held a secret is not kept, so its repeat says so instead of minting a second token.
		const token = {
			do: "token.create",
			actor: "ci-bot",
			kind: "ci",
			can: ["read", "produce"],
			cmd: "admin-command-02",
		};
		expect(h.raw("admin", token).ok).toBe(true);
		expect(h.raw("admin", token)).toMatchObject({ ok: false, error: { code: "conflict" } });
		expect(rows("SELECT count(*) AS n FROM tokens t JOIN actors a ON a.id = t.actor WHERE a.name = 'ci-bot'")).toEqual([
			{ n: 1 },
		]);
		expect(JSON.stringify(rows("SELECT outcome FROM commands"))).not.toContain("cb_");
	});

	test("text is never stored with half a character in it", () => {
		// 299 letters and an emoji: the title limit of 300 falls in the middle of the emoji's two units.
		h.call("propose", { edits: [{ op: "create", body: { title: `${"a".repeat(299)}😀` } }] });
		report({
			target: { commit: "unicode01", branch: "main" },
			results: [{ test: { key: "a::t" }, outcome: "fail", failure: { message: `${"b".repeat(159)}😀 and more` } }],
		});
		h.call("claim", {
			lens: "review",
			findings: [{ on: "C-1", category: "ambiguous", note: `${"c".repeat(119)}😀 tail` }],
		});
		const stored = [
			...rows<{ t: string }>("SELECT title AS t FROM cases"),
			...rows<{ t: string }>("SELECT title AS t FROM questions"),
			...rows<{ t: string }>("SELECT text AS t FROM signatures"),
		];
		expect(stored.length).toBeGreaterThanOrEqual(4);
		for (const row of stored) expect(row.t.isWellFormed()).toBe(true);
		// Half a character sent by a client is refused at the door, whatever field it is in.
		const refused = h.raw("propose", { edits: [{ op: "create", body: { title: "broken \ud83d" } }] });
		expect(refused).toMatchObject({ ok: false, error: { code: "invalid" } });
	});

	test("a search inside a folder finds a match however many other folders match too", () => {
		h.call("propose", {
			edits: [
				...Array.from({ length: 300 }, () => ({ op: "create", body: { title: "Needle" }, folder: "Elsewhere" })),
				{ op: "create", body: { title: "Needle" }, folder: "Wanted" },
			],
		});
		type Found = { count: number | null; items: { ref: string }[] };
		const found = h.call<Found>("find", { folder: "Wanted", text: "Needle", limit: 1 });
		expect(found.items.map((item) => item.ref)).toEqual(["C-301"]);
		expect(h.call<Found>("find", { folder: "Elsewhere", text: "Needle", limit: 5 }).items).toHaveLength(5);
		expect(h.call<Found>("find", { folder: "Wanted", text: "Absent", limit: 5 }).items).toEqual([]);
	});

	test("the ledger honours its kind filter and pages through decisions made at the same moment", () => {
		seed();
		report({
			target: { commit: "ledger01", branch: "main" },
			results: ["a", "b", "c"].map((file) => ({ test: { key: `${file}::one`, file }, outcome: "pass" })),
		});
		const ledger = (input: Record<string, unknown>) => h.call<InboxReply>("inbox", { state: "decided", ...input });
		const all = ledger({ limit: 500 }).items.map((item) => item.q);
		expect(all).toHaveLength(4);
		expect(ledger({ kind: "failure", limit: 500 }).items).toEqual([]);
		expect(ledger({ kind: "map", limit: 500 }).items.map((item) => item.kind)).toEqual(["map", "map", "map"]);
		const paged: string[] = [];
		for (let cursor: string | null | undefined; cursor !== null; ) {
			const page = ledger({ limit: 1, ...(cursor ? { cursor } : {}) });
			paged.push(...page.items.map((item) => item.q));
			cursor = page.cursor;
		}
		expect(paged).toEqual(all);
	});

	test("a cursor never skips the rest of a large change", () => {
		const start = h.call<{ cursor: string }>("since", { cursor: "s:0" }).cursor;
		seed(300);
		type Page = { changed: { ref: string }[]; cursor: string; more: boolean };
		const seen = new Set<string>();
		let cursor = start;
		for (let page = 0; page < 5; page++) {
			const reply = h.call<Page>("since", { cursor });
			for (const item of reply.changed) seen.add(item.ref);
			cursor = reply.cursor;
			if (!reply.more) break;
		}
		expect(seen.size).toBe(300);
		expect(h.call<Page>("since", { cursor }).changed).toEqual([]);
	});
});
