// Things that must never happen, each found by an independent review of the engine and reproduced here first.
// One test per promise: what a result may prove, what a decision may change, and what a caller may see.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { emptyBody } from "../src/core/model.ts";
import type { DecideReply, GateStatus, InboxReply, PlanReply, ProposeReply, ReportReceipt } from "../src/core/ops.ts";
import { ReportInput } from "../src/core/ops.ts";
import { PRESETS } from "../src/core/presets.ts";
import { HANDLERS } from "../src/server/decisions/kinds.ts";
import type { HoldTerm } from "../src/server/decisions/questions.ts";
import { linkTest, setExcuse, testById } from "../src/server/evidence/evidence.ts";
import { findProject, makeCtx, stampSeq } from "../src/server/kernel/ctx.ts";
import { MIGRATIONS } from "../src/server/kernel/migrate.ts";
import { claimMint, decisionOf, Witness } from "../src/server/kernel/witness.ts";
import { OPS } from "../src/server/ops/index.ts";
import { recoverAccepted, recoverDisputes, sweep } from "../src/server/ops/jobs.ts";
import { invoke, invokeAsync } from "../src/server/ops/registry.ts";
import { acceptReport } from "../src/server/ops/writes.ts";
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
const usePolicy = (preset: string, unlinked?: "ask" | "track" | "create") => {
	h.call("propose", { edits: [{ op: "policy", preset, ...(unlinked ? { unlinked } : {}) }] });
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
	const emptyPolicy = (emptyReports: "pending" | "nothing-required") => {
		h.call("propose", { edits: [{ op: "policy", emptyReports }] });
		return decide(open("adopt"), { is: "accept" }, h.owner, { reason: "Path filters can require no tests" });
	};
	const nothingRequired = (commit: string, extra: Record<string, unknown> = {}) => ({
		target: { commit, branch: "main" },
		results: [],
		nothingRequired: true,
		...extra,
	});

	test("a CI declaration of nothing required passes only under a recorded policy choice", () => {
		const pipeline = h.actor("pipeline", "ci", ["read", "record"]);
		const input = nothingRequired("empty0001");
		expect(report(input, pipeline).gate?.verdict).toBe("pending");
		expect(gate({ commit: "empty0001" }).verdict).toBe("pending");
		h.call("propose", { edits: [{ op: "policy", emptyReports: "nothing-required" }] });
		expect(gate({ commit: "empty0001" }).verdict).toBe("pending");
		expect(decide(open("adopt"), { is: "accept" })).toMatchObject({ status: "decided", effects: { policyVersion: 2 } });
		expect(h.call("admin", { do: "policy.show", project: "scratch" })).toMatchObject({
			settings: { emptyReports: "nothing-required" },
		});
		expect(gate({ commit: "empty0001" })).toMatchObject({
			verdict: "passed",
			reason: "passed: the pipeline declared nothing required under the project's policy",
			tally: { pass: 0 },
			stale: false,
		});
		expect(gate({ commit: "unknown01" }).verdict).toBe("pending");
		expect(report(input, pipeline).fresh).toBe(false);
		expect(rows("SELECT count(*) AS n FROM batches")).toEqual([{ n: 1 }]);
		emptyPolicy("pending");
		expect(gate({ commit: "empty0001" })).toMatchObject({ verdict: "pending", stale: false });
	});

	test("nothing required is explicit, only from CI, and only about a commit", () => {
		emptyPolicy("nothing-required");
		const pipeline = h.actor("pipeline", "ci", ["record"]);
		const agent = h.actor("explorer", "agent", ["produce"]);
		for (const actor of [h.owner, agent]) expect(h.raw("report", nothingRequired("empty0002"), actor).ok).toBe(false);
		for (const input of [
			{ target: { commit: "empty0002" }, results: [] },
			nothingRequired("empty0002", { target: { session: "exploration" } }),
			nothingRequired("empty0002", { results: [{ test: { key: "a::t" }, outcome: "skip" }] }),
		])
			expect(h.raw("report", input, pipeline).ok).toBe(false);
		expect(rows("SELECT count(*) AS n FROM batches")).toEqual([{ n: 0 }]);
	});

	test("nothing required refuses a planned run even with an explicit commit", () => {
		emptyPolicy("nothing-required");
		seed();
		const pipeline = h.actor("pipeline", "ci", ["record"]);
		const planned = plan({ name: "tests required", select: {}, accepts: { commit: "empty0009" } });
		expect(h.raw("report", nothingRequired("empty0009", { run: planned.run }), pipeline)).toMatchObject({
			ok: false,
			error: { code: "invalid", message: "nothing required is a declaration about a commit, not a planned run" },
		});
		expect(rows("SELECT count(*) AS n FROM batches")).toEqual([{ n: 0 }]);
		expect(gate({ run: planned.run })).toMatchObject({ verdict: "pending", tally: { missing: 1 } });
	});

	test("a nothing-required declaration waits for application and survives accepted-batch recovery", () => {
		emptyPolicy("nothing-required");
		const pipeline = h.actor("pipeline", "ci", ["read", "record"]);
		const project = findProject(h.app.db, "scratch");
		if (!project) throw new Error("no project");
		h.app.db.transaction(() => {
			const ctx = makeCtx(h.app, project, pipeline, true);
			acceptReport(ctx, { target: { commit: "empty0008" }, results: [], nothingRequired: true });
			stampSeq(ctx);
		});
		expect(gate({ commit: "empty0008" }).verdict).toBe("pending");
		recoverAccepted(h.app);
		expect(gate({ commit: "empty0008" }).verdict).toBe("passed");
		expect(rows("SELECT nothing_required, state FROM batches")).toEqual([{ nothing_required: 1, state: "processed" }]);
	});

	test("nothing required cannot hide skips, refused results, agent results or a skipped failure", () => {
		emptyPolicy("nothing-required");
		const pipeline = h.actor("pipeline", "ci", ["record"]);
		const agent = h.actor("explorer", "agent", ["produce"]);
		report(nothingRequired("empty0003"), pipeline);
		report(
			{
				target: { commit: "empty0003", env: "other" },
				job: "another-job",
				results: [{ test: { key: "a::t" }, outcome: "skip" }],
			},
			pipeline,
		);
		expect(gate({ commit: "empty0003" }).verdict).toBe("pending");
		report({ target: { commit: "empty0004" }, results: [{ test: { case: "C-99" }, outcome: "pass" }] });
		report(nothingRequired("empty0004"), pipeline);
		expect(gate({ commit: "empty0004" }).verdict).toBe("pending");
		report({ target: { commit: "empty0005" }, results: [{ test: { key: "a::t" }, outcome: "pass" }] }, agent);
		report(nothingRequired("empty0005"), pipeline);
		expect(gate({ commit: "empty0005" }).verdict).toBe("pending");
		const failed = (outcome: string, attempt: number) => ({
			target: { commit: "empty0006", branch: "main" },
			attempt,
			results: [{ test: { key: "a::t" }, outcome, failure: { message: "bug" } }],
		});
		report(failed("fail", 1), pipeline);
		expect(gate({ commit: "empty0006" }).verdict).toBe("blocked");
		report(nothingRequired("empty0006"), pipeline);
		expect(gate({ commit: "empty0006" }).verdict).toBe("blocked");
		decide(open("failure"), { is: "defect" });
		report(failed("skip", 2), pipeline);
		report(nothingRequired("empty0006", { attempt: 3 }), pipeline);
		expect(gate({ commit: "empty0006" }).verdict).toBe("failed");
	});

	test("nothing required is scoped to its repository and never fills a planned run or a job", () => {
		emptyPolicy("nothing-required");
		seed();
		const pipeline = h.actor("pipeline", "ci", ["record"]);
		const planned = plan({
			name: "the build must run tests",
			select: {},
			accepts: { commit: "empty0007", repo: "app" },
			require: [...exercise(), { id: "jobs", kind: "jobs", jobs: ["tests"] }],
		});
		report(nothingRequired("empty0007", { target: { commit: "empty0007", repo: "app" }, job: "tests" }), pipeline);
		expect(gate({ commit: "empty0007", repo: "app" }).verdict).toBe("passed");
		expect(gate({ commit: "empty0007", repo: "other" }).verdict).toBe("pending");
		expect(gate({ run: planned.run })).toMatchObject({ verdict: "pending", tally: { missing: 2 } });
	});

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

	test("a code host head follows a reset and still ignores ordinary late reports", () => {
		const old = ciReport({ commit: "head0001", branch: "feature", pr: 12, n: 1 });
		const newer = ciReport({ commit: "head0002", branch: "feature", pr: 12, n: 1, fail: { 0: "defect" } });
		report(old);
		report(newer);
		const reset = { ...old, target: { ...old.target, head: "head0001" } };
		report(reset);
		expect(gate({ change: "pr:12" })).toMatchObject({ verdict: "passed", run: gate({ commit: "head0001" }).run });
		report({ ...newer, job: "late" });
		expect(gate({ change: "pr:12" }).verdict).toBe("passed");
		report({ ...newer, target: { ...newer.target, head: "head0002" } });
		expect(gate({ change: "pr:12" }).verdict).toBe("blocked");
		expect(report(reset).fresh).toBe(false);
		expect(gate({ change: "pr:12" }).verdict).toBe("blocked");
	});

	test("a new CI build with identical results can observe a reset, while retries cannot", () => {
		const old = ciReport({ commit: "head0001", branch: "feature", pr: 12, n: 1, job: "test", attempt: 1 });
		const first = { ...old, target: { ...old.target, head: "head0001" }, buildUrl: "https://ci.example/runs/1" };
		const newer = ciReport({
			commit: "head0002",
			branch: "feature",
			pr: 12,
			n: 1,
			job: "test",
			attempt: 1,
			fail: { 0: "defect" },
		});
		const second = { ...newer, target: { ...newer.target, head: "head0002" }, buildUrl: "https://ci.example/runs/2" };
		report(first);
		report(second);
		expect(gate({ change: "pr:12" }).verdict).toBe("blocked");
		expect(report(first).fresh).toBe(false);
		expect(gate({ change: "pr:12" }).verdict).toBe("blocked");
		const reset = { ...first, buildUrl: "https://ci.example/runs/3" };
		expect(report(reset).fresh).toBe(true);
		expect(gate({ change: "pr:12" })).toMatchObject({ verdict: "passed", run: gate({ commit: "head0001" }).run });
		expect(report(reset).fresh).toBe(false);
		expect(report(second).fresh).toBe(false);
		expect(gate({ change: "pr:12" }).verdict).toBe("passed");
		expect(rows("SELECT count(*) AS n FROM batches")).toEqual([{ n: 3 }]);
	});

	test("without a head, changing the build URL still deduplicates identical reports", () => {
		const old = ciReport({ commit: "head0001", branch: "feature", n: 1 });
		report({ ...old, buildUrl: "https://ci.example/runs/1" });
		expect(report({ ...old, buildUrl: "https://ci.example/runs/2" }).fresh).toBe(false);
		expect(gate({ change: "branch:feature" }).verdict).toBe("passed");
		expect(rows("SELECT count(*) AS n FROM batches")).toEqual([{ n: 1 }]);
	});

	test("ordinary metadata updates preserve first-reported commit ordering", () => {
		const old = ciReport({ commit: "head0001", branch: "feature", n: 1 });
		report(old);
		report(ciReport({ commit: "head0002", branch: "elsewhere", n: 1 }));
		report({ ...old, job: "metadata", target: { ...old.target, title: "Updated title" } });
		report(ciReport({ commit: "head0002", branch: "feature", n: 1 }));
		expect(gate({ change: "branch:feature" }).run).toBe(gate({ commit: "head0002" }).run);
	});

	test("the reported head is separate from the tested commit and stays pending without evidence", () => {
		const old = ciReport({ commit: "head0001", branch: "feature", n: 1 });
		report(old);
		report({ ...old, target: { ...old.target, head: "unseen01" } });
		expect(gate({ change: "branch:feature" })).toMatchObject({ verdict: "pending", run: null });
		expect(gate({ commit: "head0001" }).verdict).toBe("passed");
		report({ ...old, job: "late" });
		expect(gate({ change: "branch:feature" }).verdict).toBe("pending");
		report(ciReport({ commit: "unseen01", branch: "feature", n: 1 }));
		expect(gate({ change: "branch:feature" })).toMatchObject({
			verdict: "passed",
			run: gate({ commit: "unseen01" }).run,
		});
		report(ciReport({ commit: "future01", branch: "feature", n: 1 }));
		expect(gate({ change: "branch:feature" }).run).toBe(gate({ commit: "future01" }).run);
	});

	test("a head observation protects the current head even when its hash is unchanged", () => {
		const old = ciReport({ commit: "head0001", branch: "feature", n: 1 });
		report(old);
		report(ciReport({ commit: "head0002", branch: "elsewhere", n: 1 }));
		report({ ...old, target: { ...old.target, head: "head0001" } });
		report(ciReport({ commit: "head0002", branch: "feature", n: 1, job: "late" }));
		expect(gate({ change: "branch:feature" }).run).toBe(gate({ commit: "head0001" }).run);
	});

	test("head observations are scoped to their repository and an agent cannot change them", () => {
		const old = ciReport({ commit: "head0001", branch: "feature", pr: 12, n: 1 });
		for (const repo of ["acme/web", "acme/other"]) {
			report({ ...old, target: { ...old.target, repo } });
			report({ ...old, target: { ...old.target, repo, commit: "head0002" } });
		}
		report({ ...old, target: { ...old.target, head: "head0001" } });
		expect(gate({ change: "pr:12" }).run).toBe(gate({ commit: "head0001", repo: "acme/web" }).run);
		expect(gate({ change: "acme/other#pr:12" }).run).toBe(gate({ commit: "head0002", repo: "acme/other" }).run);
		report({ ...old, target: { ...old.target, head: "head0002" } }, h.actor("reviewer", "agent", ["read", "produce"]));
		expect(gate({ change: "pr:12" }).run).toBe(gate({ commit: "head0001", repo: "acme/web" }).run);
		report({ ...old, target: { ...old.target, head: "head0002" } }, h.actor("pipeline", "ci", ["record"]));
		expect(gate({ change: "pr:12" }).run).toBe(gate({ commit: "head0002", repo: "acme/web" }).run);
	});

	test("a new observation can return to the same head without replaying an earlier observation", () => {
		const old = ciReport({ commit: "head0001", branch: "feature", pr: 12, n: 1 });
		const observed = { ...old, target: { ...old.target, head: "head0001" } };
		report(observed);
		report({ ...old, target: { ...old.target, head: "head0002" } });
		expect(report(observed).fresh).toBe(false);
		expect(gate({ change: "pr:12" }).verdict).toBe("pending");
		expect(report({ ...observed, cmd: "fresh-head-observation" }).fresh).toBe(true);
		expect(gate({ change: "pr:12" }).verdict).toBe("passed");
	});

	test("the same head observation on two pull requests is not a duplicate", () => {
		const old = ciReport({ commit: "head0001", branch: "feature", pr: 12, n: 1 });
		const observed = { ...old, target: { ...old.target, head: "head0001" } };
		report(observed);
		expect(report({ ...observed, target: { ...observed.target, pr: 13 } }).fresh).toBe(true);
		expect(gate({ change: "pr:13" }).run).toBe(gate({ commit: "head0001" }).run);
	});

	test("a head observation needs a change and a valid commit identifier", () => {
		const old = ciReport({ commit: "head0001", n: 1 });
		for (const target of [
			{ ...old.target, head: "short" },
			{ ...old.target, head: "x".repeat(65) },
			{ ...old.target, head: "head0001" },
			{ commit: "head0001", head: "head0001" },
			{ session: "manual", head: "head0001" },
		]) {
			expect(h.raw("report", { ...old, target })).toMatchObject({ ok: false, error: { code: "invalid" } });
		}
		expect(rows("SELECT count(*) AS n FROM batches")).toEqual([{ n: 0 }]);
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

	test("a correction must name a result on the same target", () => {
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

	test.each(["human", "ci"] as const)("a %s report refuses a second correction of the same result", (kind) => {
		seed(1, ["human", "auto"]);
		const actor = kind === "ci" ? h.actor("pipeline", "ci", ["read", "record"]) : h.owner;
		const planned = plan({ name: "One correction", select: {}, accepts: { commit: "correct611" } });
		const input = { target: { commit: "correct611" } };
		const test = kind === "ci" ? { key: "correction-test" } : { case: "C-1" };
		const observed = { test, annotation: { case: "C-1", version: 1 } };
		const original = first(report({ ...input, results: [{ ...observed, outcome: "pass" }] }, actor).results);
		const correction = {
			...input,
			...(kind === "human" ? { cmd: crypto.randomUUID() } : {}),
			results: [{ ...observed, outcome: "fail", note: "Still broken", corrects: original }],
		};
		const corrected = report(correction, actor);
		const before = rows("SELECT count(*) AS n FROM batches");
		expect(
			h.raw("report", { ...input, results: [{ ...observed, outcome: "pass", corrects: original }] }, actor),
		).toEqual({
			ok: false,
			error: {
				code: "conflict",
				message: `result ${original} was already corrected; read the latest results and correct the current result instead`,
			},
		});
		expect(rows("SELECT count(*) AS n FROM batches")).toEqual(before);
		expect(rows("SELECT outcome FROM results ORDER BY id")).toEqual([{ outcome: "pass" }, { outcome: "fail" }]);
		expect(gate({ run: planned.run }).verdict).toBe("blocked");
		if (kind === "ci") expect(report(correction, actor)).toMatchObject({ fresh: false, results: corrected.results });
		else expect(report(correction, actor)).toEqual(corrected);
		const latest = report(
			{ ...input, results: [{ ...observed, outcome: "pass", corrects: first(corrected.results) }] },
			actor,
		);
		expect(latest).toMatchObject({ counts: { total: 1, pass: 1 }, rejected: [], declined: [] });
		expect(gate({ run: planned.run }).verdict).toBe("passed");
	});

	test.each(["human", "ci"] as const)("a pending %s correction excludes another before recovery", (kind) => {
		seed(1, ["human", "auto"]);
		const actor = kind === "ci" ? h.actor("pipeline", "ci", ["read", "record"]) : h.owner;
		const target = { commit: "pending631" };
		const planned = plan({ name: "Pending correction", select: {}, accepts: target });
		const test = kind === "ci" ? { key: "pending-correction" } : { case: "C-1" };
		const observed = { test, annotation: { case: "C-1", version: 1 } };
		const original = first(report({ target, results: [{ ...observed, outcome: "pass" }] }, actor).results);
		const correction = ReportInput.parse({
			target,
			cmd: crypto.randomUUID(),
			results: [{ ...observed, outcome: "fail", note: "Still broken", corrects: original }],
		});
		const project = findProject(h.app.db, "scratch");
		if (!project) throw new Error("no project");
		const acceptPending = () =>
			h.app.db.transaction(() => {
				const ctx = makeCtx(h.app, project, actor, true);
				const accepted = acceptReport(ctx, correction);
				stampSeq(ctx);
				return accepted;
			});
		expect(acceptPending().fresh).toBe(true);
		expect(acceptPending().fresh).toBe(false);
		expect(gate({ run: planned.run }).verdict).toBe("pending");
		expect(
			h.raw("report", { target, results: [{ ...observed, outcome: "pass", corrects: original }] }, actor),
		).toMatchObject({
			ok: false,
			error: {
				code: "conflict",
				message: `result ${original} has an accepted correction waiting to be applied; retry that report or wait for server recovery before correcting again`,
			},
		});
		expect(rows("SELECT state FROM batches ORDER BY id")).toEqual([{ state: "processed" }, { state: "accepted" }]);
		expect(recoverAccepted(h.app)).toBe(1);
		expect(recoverAccepted(h.app)).toBe(0);
		expect(rows("SELECT outcome, corrects FROM results ORDER BY id")).toEqual([
			{ outcome: "pass", corrects: null },
			{ outcome: "fail", corrects: original },
		]);
		expect(gate({ run: planned.run }).verdict).toBe("blocked");
		const recovered = report(correction, actor);
		expect(recovered.fresh).toBe(false);
		expect(recovered.results).toHaveLength(1);
		expect(
			report({ target, results: [{ ...observed, outcome: "pass", corrects: first(recovered.results) }] }, actor),
		).toMatchObject({ counts: { total: 1, pass: 1 }, rejected: [], declined: [] });
		expect(gate({ run: planned.run }).verdict).toBe("passed");
	});

	test("accepting many corrections reads waiting batches once", () => {
		const actor = h.actor("pipeline", "ci", ["read", "record"]);
		const input = ciReport({ commit: "scans631", n: 33 });
		const original = report(input, actor).results;
		expect(original).toHaveLength(33);
		const reserved = original[32];
		const observed = input.results[32];
		if (reserved === undefined || observed === undefined) throw new Error("missing original result");
		const project = findProject(h.app.db, "scratch");
		if (!project) throw new Error("no project");
		h.app.db.transaction(() => {
			const ctx = makeCtx(h.app, project, actor, true);
			acceptReport(ctx, {
				...input,
				results: [
					...Array.from({ length: 2_000 }, () => ({ test: { key: "waiting" }, outcome: "pass" as const })),
					{ ...observed, corrects: reserved },
				],
			});
			stampSeq(ctx);
		});
		const get = spyOn(h.app.db, "get");
		const all = spyOn(h.app.db, "all");
		try {
			const corrected = report(
				{
					...input,
					results: input.results.slice(0, 32).map((result, index) => ({ ...result, corrects: original[index] })),
				},
				actor,
			);
			expect(corrected).toMatchObject({ counts: { total: 32, pass: 32 }, rejected: [], declined: [] });
			const scans = [...get.mock.calls, ...all.mock.calls].filter(
				([statement]) => /\bbatches\b/.test(statement.text) && /\bstaged\b/.test(statement.text),
			);
			expect(scans.length).toBeLessThanOrEqual(1);
			get.mockClear();
			all.mockClear();
			expect(report({ ...input, results: [{ ...observed, note: "ordinary report" }] }, actor)).toMatchObject({
				counts: { total: 1, pass: 1 },
			});
			expect(
				[...get.mock.calls, ...all.mock.calls].filter(
					([statement]) => /\bbatches\b/.test(statement.text) && /\bstaged\b/.test(statement.text),
				),
			).toHaveLength(0);
		} finally {
			get.mockRestore();
			all.mockRestore();
		}
		expect(
			h.raw("report", { ...input, results: [{ ...observed, corrects: reserved, note: "competing" }] }, actor),
		).toMatchObject({ ok: false, error: { code: "conflict" } });
	});

	test("a pending correction from another producer does not reserve somebody else's result", () => {
		seed();
		const target = { commit: "producer631" };
		const observed = { test: { key: "producer-correction" }, annotation: { case: "C-1", version: 1 } };
		const original = first(report({ target, results: [{ ...observed, outcome: "pass" }] }).results);
		const other = h.actor("another-producer", "ci", ["read", "record"]);
		const project = findProject(h.app.db, "scratch");
		if (!project) throw new Error("no project");
		h.app.db.transaction(() => {
			const ctx = makeCtx(h.app, project, other, true);
			acceptReport(ctx, { target, results: [{ ...observed, outcome: "pass", corrects: original }] });
			stampSeq(ctx);
		});
		const corrected = report({ target, results: [{ ...observed, outcome: "fail", corrects: original }] });
		expect(corrected).toMatchObject({ counts: { total: 1, fail: 1 }, declined: [], rejected: [] });
		expect(recoverAccepted(h.app)).toBe(1);
		expect(recoverAccepted(h.app)).toBe(0);
		expect(rows("SELECT id FROM results WHERE corrects IS NOT NULL")).toEqual([{ id: first(corrected.results) }]);
		expect(gate({ commit: target.commit }).verdict).toBe("blocked");
	});

	test("two corrections of one result in the same report refuse the whole report", () => {
		seed();
		const planned = plan({ name: "Duplicate corrections", select: {}, accepts: { commit: "dupe0611" } });
		const target = { commit: "dupe0611" };
		const original = first(report({ target, results: [{ test: { case: "C-1" }, outcome: "pass" }] }).results);
		expect(
			h.raw("report", {
				target,
				results: ["fail", "skip"].map((outcome) => ({ test: { case: "C-1" }, outcome, corrects: original })),
			}),
		).toMatchObject({ ok: false, error: { code: "conflict" } });
		expect(rows("SELECT outcome FROM results")).toEqual([{ outcome: "pass" }]);
		expect(rows("SELECT count(*) AS n FROM batches")).toEqual([{ n: 1 }]);
		expect(gate({ run: planned.run }).verdict).toBe("passed");
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
		const ci = h.actor("pipeline", "ci", ["read", "record"]);
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
		const ci = h.actor("pipeline", "ci", ["read", "record"]);
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
		// While the base fails, the loose policy records an inherited answer for the matching test.
		const during = report(
			one({ repo: "app", commit: "corrhead00", branch: "early", pr: 4, base: "corrbase01" }, "fail"),
			ci,
		);
		expect(during.gate?.verdict).toBe("passed");
		expect(during.questions[0]).toMatchObject({ how: "decided by rule", answer: "inherited" });
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
		const ci = h.actor("pipeline", "ci", ["read", "record"]);
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
		const ci = h.actor("pipeline", "ci", ["read", "record"]);
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
	const pipeline = () => h.actor("pipeline", "ci", ["read", "record"]);
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

	for (const outcome of ["skip", "blocked"] as const) {
		test(`correcting a required job's only pass to ${outcome} removes its evidence from existing and new runs`, () => {
			seed();
			const ci = pipeline();
			const target = { commit: "jobsfix1", branch: "main" };
			const input = {
				name: "Release",
				select: { cases: ["C-1"] },
				accepts: { commit: target.commit },
				require: [
					{ id: "manual", kind: "exercise", methods: ["human"], minActors: 1, basis: "exact" },
					{ id: "ci", kind: "jobs", jobs: ["e2e"] },
				],
			};
			const planned = plan(input);
			report({ run: planned.run, results: [{ test: { case: "C-1" }, outcome: "pass" }] });
			const pass = report({ target, job: "e2e", results: [{ test: { key: "auto-check" }, outcome: "pass" }] }, ci);
			const approval = open("signoff", "decided");
			expect(h.call<unknown[]>("get", { refs: [planned.run] })).toMatchObject([
				{ state: "closed", verdict: "passed", tally: { pass: 1, missing: 0 } },
			]);
			const correction = report(
				{ target, job: "e2e", results: [{ test: { key: "auto-check" }, outcome, corrects: first(pass.results) }] },
				ci,
			);
			expect(correction).toMatchObject({ rejected: [], declined: [], counts: { total: 1, pass: 0 } });
			expect(gate({ run: planned.run })).toMatchObject({ verdict: "pending", tally: { pass: 1, missing: 1 } });
			expect(h.call<unknown[]>("get", { refs: [planned.run] })).toMatchObject([
				{ state: "open", verdict: "pending", tally: { pass: 1, missing: 1 } },
			]);
			expect(h.call<InboxReply>("inbox", { kind: "signoff", state: "decided" }).items).toMatchObject([
				{ q: approval.q, decision: { answer: { is: "outdated" } } },
			]);
			expect(open("signoff").evidence).toMatchObject({ verdict: "pending", tally: { missing: 1 } });
			const next = plan(input);
			expect(gate({ run: next.run })).toMatchObject({ verdict: "pending", tally: { pass: 1, missing: 1 } });
		});
	}

	for (const outcome of ["fail", "error"] as const) {
		test(`a correction to ${outcome} still meets the required job and counts its failure`, () => {
			seed(1, ["human", "auto"]);
			const ci = pipeline();
			const target = { commit: "jobsfail1", branch: "main" };
			const input = {
				name: "Release",
				select: { cases: ["C-1"] },
				accepts: { commit: target.commit },
				require: [...exercise(), { id: "ci", kind: "jobs", jobs: ["e2e"] }],
			};
			const planned = plan(input);
			const pass = report({ target, job: "e2e", results: [linked("pass")] }, ci);
			expect(gate({ run: planned.run })).toMatchObject({ verdict: "passed", tally: { pass: 1, missing: 0 } });
			report({ target, job: "e2e", results: [{ ...linked(outcome), corrects: first(pass.results) }] }, ci);
			expect(gate({ run: planned.run })).toMatchObject({ verdict: "blocked", tally: { unexplained: 1, missing: 0 } });
			expect(gate({ commit: target.commit })).toMatchObject({
				verdict: "blocked",
				tally: { unexplained: 1, missing: 0 },
			});
			expect(h.call<unknown[]>("get", { refs: [planned.run] })).toMatchObject([{ state: "open", verdict: "blocked" }]);
			const next = plan(input);
			expect(gate({ run: next.run })).toMatchObject({ verdict: "blocked", tally: { unexplained: 1, missing: 0 } });
		});
	}

	test("a required job keeps its other decisive results but never revives corrected ancestors", () => {
		seed();
		const ci = pipeline();
		const target = { commit: "jobschain1", branch: "main" };
		const planned = plan({
			name: "Release",
			select: { cases: ["C-1"] },
			accepts: { commit: target.commit },
			require: [...exercise(["human"]), { id: "ci", kind: "jobs", jobs: ["e2e"] }],
		});
		report({ run: planned.run, results: [{ test: { case: "C-1" }, outcome: "pass" }] });
		const passes = report(
			{
				target,
				job: "e2e",
				results: [
					{ test: { key: "a" }, outcome: "pass" },
					{ test: { key: "b" }, outcome: "pass" },
				],
			},
			ci,
		);
		const skipped = report(
			{ target, job: "e2e", results: [{ test: { key: "a" }, outcome: "skip", corrects: first(passes.results) }] },
			ci,
		);
		expect(gate({ run: planned.run })).toMatchObject({ verdict: "passed", tally: { missing: 0 } });
		report(
			{ target, job: "corrections", results: [{ test: { key: "b" }, outcome: "skip", corrects: passes.results[1] }] },
			ci,
		);
		expect(gate({ run: planned.run })).toMatchObject({ verdict: "pending", tally: { pass: 1, missing: 1 } });
		const stillSkipped = report(
			{ target, job: "e2e", results: [{ test: { key: "a" }, outcome: "skip", corrects: first(skipped.results) }] },
			ci,
		);
		expect(gate({ run: planned.run })).toMatchObject({ verdict: "pending", tally: { pass: 1, missing: 1 } });
		report(
			{ target, job: "e2e", results: [{ test: { key: "a" }, outcome: "pass", corrects: first(stillSkipped.results) }] },
			ci,
		);
		expect(gate({ run: planned.run })).toMatchObject({ verdict: "passed", tally: { pass: 1, missing: 0 } });
		expect(h.call<unknown[]>("get", { refs: [planned.run] })).toMatchObject([{ state: "closed", verdict: "passed" }]);
	});

	test("a late correction reopens a commit run on its current evidence", () => {
		seed(1, ["human", "auto"]);
		const commit = "feedface00000000000000000000000000000001";
		const target = { commit, branch: "main" };
		const ci = pipeline();
		const planned = plan({ name: "Release", select: {}, accepts: { commit } });
		const pass = report({ target, job: "e2e", results: [linked("pass")] }, ci);
		const stored = () =>
			first(rows<{ state: string; verdict: string }>("SELECT state, verdict FROM runs WHERE origin = 'planned'"));
		expect(stored()).toEqual({ state: "closed", verdict: "passed" });
		// The pipeline withdraws its pass: the test failed, and the sign-off no longer holds.
		report({ target, job: "e2e", results: [{ ...linked("fail"), corrects: first(pass.results) }] }, ci);
		expect(gate({ commit }).verdict).toBe("blocked");
		expect(stored()).toEqual({ state: "open", verdict: "blocked" });
		expect(slots(planned.run).map((slot) => slot.state)).toEqual(["failing"]);
		expect(open("signoff").evidence).toMatchObject({ verdict: "blocked" });
		expect(open("failure").about).toContain(planned.run);
	});

	test("a late result in another environment reopens a closed commit run", () => {
		seed(1, ["human", "auto"]);
		const commit = "feedface00000000000000000000000000000002";
		const ci = pipeline();
		const planned = plan({ name: "Release", select: {}, accepts: { commit } });
		report({ target: { commit, branch: "main", env: "prod" }, results: [linked("pass")] }, ci);
		expect(first(rows<{ state: string }>("SELECT state FROM runs WHERE origin = 'planned'")).state).toBe("closed");
		// Another environment of the same commit fails after the run was closed.
		report({ target: { commit, branch: "main", env: "staging" }, results: [linked("fail")] }, ci);
		expect(first(rows<{ state: string }>("SELECT state FROM runs WHERE origin = 'planned'")).state).toBe("open");
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
		// The pipeline's first report of the pull request is for a commit Mainworthy saw before the agent's.
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
		// request's failure: it gets its own inherited decision, independent of trunk's flaky answer.
		const reported = report(
			{
				target: { repo: "acme/web", commit: "head00001", pr: 7, branch: "feature", base: "trunk0001" },
				results: [fail],
			},
			ci,
		);
		expect(reported.questions.map((q) => q.how)).toEqual(["decided by rule"]);
		expect(reported.questions[0]?.answer).toBe("inherited");
		expect(gate({ change: "pr:7" }).verdict).toBe("passed");
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

	test("a run that counted an agent's result is recomputed when the commit is put in its real place", () => {
		seed(2, ["human", "agent"]);
		const ci = pipeline();
		const commit = "moved0001";
		const planned = plan({
			name: "Exploration",
			select: {},
			accepts: { commit, env: "staging" },
			require: exercise(["human", "agent"]),
		});
		// An agent, admitted by this run, fails a case on what it calls a commit of main.
		report(
			{
				target: { commit, branch: "main", env: "staging" },
				results: [{ test: { case: "C-1" }, outcome: "fail", failure: { message: "found by the agent" } }],
			},
			explorer(),
		);
		const first = open("failure");
		expect(decide(first, { is: "flaky" }).status).toBe("decided");
		expect(gate({ run: planned.run }).tally).toMatchObject({ excused: 1, unexplained: 0 });
		// The pipeline reports another environment of that commit as the head of a pull request: that is where
		// the commit is. What was answered about trunk does not excuse a pull request's failure, so the run shows
		// it unexplained again, at once, and somebody is asked about it there.
		report(
			{ target: { commit, pr: 7, branch: "feature", env: "prod" }, results: [{ test: { key: "t" }, outcome: "pass" }] },
			ci,
		);
		expect(rows("SELECT DISTINCT line FROM targets WHERE commit_sha = ?", commit)).toEqual([{ line: "change" }]);
		const now = gate({ run: planned.run });
		expect(now.tally).toMatchObject({ excused: 0, unexplained: 1 });
		const asked = open("failure");
		expect(asked.q).not.toBe(first.q);
		expect(now.open).toEqual([asked.q]);
	});

	test("until a pipeline or a person reports a commit, what an agent says about where it is counts for nothing", () => {
		const ci = pipeline();
		const fail = { test: { key: "t0" }, outcome: "fail", failure: { message: "agent found it" } };
		// An agent reports two commits nobody has: one as a commit of main, one as the head of pr:9 in a repository.
		report({ target: { repo: "app", commit: "lone00001", branch: "main" }, results: [fail] }, explorer());
		report({ target: { repo: "app", commit: "lone00002", pr: 9, branch: "feature" }, results: [fail] }, explorer());
		// Neither is on trunk or in a pull request: each is on its own, as a commit reported by its hash alone is.
		// No pull request exists because an agent named one, so the name stays free for whoever really reports it.
		expect(
			rows(
				"SELECT t.commit_sha, t.line, t.branch, c.key FROM targets t JOIN changes c ON c.id = t.change ORDER BY t.id",
			),
		).toEqual([
			{ commit_sha: "lone00001", line: "change", branch: null, key: "commit:lone00001" },
			{ commit_sha: "lone00002", line: "change", branch: null, key: "commit:lone00002" },
		]);
		expect(rows("SELECT key FROM changes WHERE key LIKE 'pr:%'")).toEqual([]);
		// Its failures are asked about there, so an answer to one is an answer about that commit and no line.
		const asked = h.call<InboxReply>("inbox", { kind: "failure", limit: 50 }).items;
		expect(asked).toHaveLength(2);
		expect(decide(first(asked), { is: "flaky" }).status).toBe("decided");
		report({ target: { repo: "app", commit: "trunk0009", branch: "main" }, results: [fail] }, ci);
		expect(gate({ commit: "trunk0009", repo: "app" }).verdict).toBe("blocked");
		// On a commit a pipeline has placed, an agent's naming of a pull request makes none either.
		report({ target: { repo: "app", commit: "trunk0009", pr: 12, branch: "x" }, results: [fail] }, explorer());
		expect(rows("SELECT key FROM changes WHERE key LIKE 'pr:%'")).toEqual([]);
	});

	test("what an agent found on a commit is asked about where the commit is, once a pipeline says where that is", () => {
		seed(1, ["human", "agent"]);
		const ci = pipeline();
		const commit = "found0002";
		// An agent reviews a pull request before its pipeline has reported: a case fails.
		report(
			{
				target: { repo: "app", commit, pr: 482, branch: "feature" },
				results: [{ test: { case: "C-1" }, outcome: "fail", failure: { message: "total is wrong" } }],
			},
			explorer(),
		);
		const early = open("failure");
		expect(early.about).not.toContain("pr:482");
		// The pipeline reports the commit as the head of pr:482. The agent's finding is the pull request's now:
		// asked about there, with the pull request and the case named, and no longer where it was first put.
		report(
			{
				target: { repo: "app", commit, pr: 482, branch: "feature" },
				results: [{ test: { key: "t" }, outcome: "pass" }],
			},
			ci,
		);
		const asked = h.call<InboxReply>("inbox", { kind: "failure", limit: 50 }).items;
		expect(asked).toHaveLength(1);
		const moved = first(asked);
		expect(moved.q).not.toBe(early.q);
		expect(moved.about).toEqual(expect.arrayContaining(["pr:482", "C-1"]));
		expect(moved.evidence).toMatchObject({ message: "total is wrong", scope: "pr:482" });
		// It still holds no gate: no gate counts an agent's result.
		expect(moved.blocks).toEqual([]);
		expect(gate({ change: "pr:482" }).verdict).toBe("passed");
		const impact = h.call<{ cases: { id: string; why: string[] }[] }>("impact", { change: "pr:482" });
		expect(impact.cases).toEqual([expect.objectContaining({ id: "C-1", why: ["question"] })]);
	});

	test("a run whose commit a report is about to put elsewhere reads pending while that report is being applied", () => {
		seed(2, ["human", "agent"]);
		const ci = pipeline();
		const commit = "moving001";
		const planned = plan({
			name: "Exploration",
			select: { cases: ["C-1"] },
			accepts: { commit, env: "agent-env" },
			require: exercise(["human", "agent"]),
		});
		report(
			{
				target: { commit, branch: "main", env: "agent-env" },
				results: [{ test: { case: "C-1" }, outcome: "fail", failure: { message: "found by the agent" } }],
			},
			explorer(),
		);
		expect(decide(open("failure"), { is: "flaky" }).status).toBe("decided");
		// The run passes on that answer (under `loose` the rule signs it off; either way it reads passed).
		expect(gate({ run: planned.run }).verdict).toBe("passed");
		// The pipeline's first report of the commit, for another environment, is accepted and not yet applied:
		// the commit is already where the pipeline says, so the run's failure is no longer covered. Until the
		// report is applied and the run recomputed, the run must not go on saying passed.
		const project = findProject(h.app.db, "scratch");
		if (!project) throw new Error("no project");
		h.app.db.transaction(() => {
			const ctx = makeCtx(h.app, project, ci, true);
			acceptReport(ctx, {
				target: { commit, pr: 7, branch: "feature", env: "pipeline-env" },
				results: [{ test: { key: "t" }, outcome: "pass" }],
			});
			stampSeq(ctx);
		});
		expect(gate({ run: planned.run })).toMatchObject({ verdict: "pending", stale: true });
		recoverAccepted(h.app);
		const after = gate({ run: planned.run });
		expect(after).toMatchObject({ verdict: "blocked", stale: false });
		expect(after.tally).toMatchObject({ unexplained: 1, excused: 0 });
		expect(
			first(rows<{ outstanding: number }>("SELECT outstanding FROM runs WHERE origin = 'planned'")).outstanding,
		).toBe(0);
	});

	test("an answer given before a commit had its place ends when the commit is placed, and the runs that rested on it are asked about again", () => {
		seed(1, ["human", "agent"]);
		const ci = pipeline();
		const commit = "closed0001";
		const planned = plan({
			name: "Exploration",
			select: {},
			accepts: { commit },
			require: exercise(["human", "agent"]),
		});
		// An agent, admitted by the run, fails the case before any pipeline has reported the commit. A person
		// explains it; the run passes on that answer and the rule closes it.
		report(
			{
				target: { commit, branch: "main" },
				results: [
					{ test: { case: "C-1" }, outcome: "fail", failure: { message: "found by the agent" } },
					...Array.from({ length: 60 }, (_, i) => ({
						test: { key: `agent::t${i}` },
						outcome: "fail",
						failure: { message: "found by the agent" },
					})),
				],
			},
			explorer(),
		);
		const early = open("failure");
		expect(early.evidence).toMatchObject({ count: 61 });
		expect(decide(early, { is: "flaky" }).status).toBe("decided");
		const stored = () =>
			first(rows<{ state: string; verdict: string }>("SELECT state, verdict FROM runs WHERE origin = 'planned'"));
		expect(stored()).toEqual({ state: "closed", verdict: "passed" });
		// The pipeline reports the commit as the head of a pull request. The answer was given about the commit on
		// its own; the failure is the pull request's now. The answer ends, in the ledger, and the failure is asked
		// about where the commit is, naming the run that rested on the answer although it has closed.
		report({ target: { commit, pr: 7, branch: "feature" }, results: [{ test: { key: "t" }, outcome: "pass" }] }, ci);
		expect(
			rows<{ answer: string }>("SELECT answer FROM decisions WHERE kind = 'failure' ORDER BY id").map(
				(row) => JSON.parse(row.answer).is,
			),
		).toEqual(["flaky", "outdated"]);
		const asked = open("failure");
		expect(asked.q).not.toBe(early.q);
		expect(asked.about).toEqual(expect.arrayContaining(["pr:7", planned.run]));
		expect(asked.evidence).toMatchObject({ scope: "pr:7", count: 61 });
		expect(gate({ run: planned.run })).toMatchObject({ verdict: "blocked", open: [asked.q] });
		// Answered there, the run reads passed again.
		expect(decide(asked, { is: "flaky" }).status).toBe("decided");
		expect(gate({ run: planned.run }).verdict).toBe("passed");
	});

	test("two commits that begin alike are each on their own, and placing one leaves the other's question alone", () => {
		seed(1, ["human", "agent"]);
		const ci = pipeline();
		const one = "abcdef123456aaaaaaaaaaaaaaaaaaaaaaaaaaaa";
		const two = "abcdef123456bbbbbbbbbbbbbbbbbbbbbbbbbbbb";
		const fail = { test: { case: "C-1" }, outcome: "fail", failure: { message: "found by the agent" } };
		const runs = [one, two].map((commit) =>
			plan({
				name: commit.slice(-4),
				select: {},
				accepts: { repo: "app", commit },
				require: exercise(["human", "agent"]),
			}),
		);
		report({ target: { repo: "app", commit: one }, results: [fail] }, explorer());
		report({ target: { repo: "app", commit: two }, results: [fail] }, explorer());
		// Two commits, two places, two questions.
		expect(rows("SELECT count(DISTINCT change) AS n FROM targets")).toEqual([{ n: 2 }]);
		expect(h.call<InboxReply>("inbox", { kind: "failure", limit: 50 }).items).toHaveLength(2);
		// The pipeline places the first. The second is where it was, asked about as before, by a question that
		// is still there to answer.
		report(
			{
				target: { repo: "app", commit: one, pr: 7, branch: "feature" },
				results: [{ test: { key: "t" }, outcome: "pass" }],
			},
			ci,
		);
		const second = gate({ run: (runs[1] as PlanReply).run });
		expect(second.verdict).toBe("blocked");
		const asked = h.call<InboxReply>("inbox", { kind: "failure", limit: 50 }).items;
		expect(asked.map((item) => item.q)).toEqual(expect.arrayContaining(second.open));
		expect(second.open).toHaveLength(1);
		expect(asked).toHaveLength(2);
		expect(gate({ run: (runs[0] as PlanReply).run }).verdict).toBe("blocked");
	});

	test("a run planned while a report for its commit waits to be applied waits for it too", () => {
		seed(1, ["human", "auto"]);
		const ci = pipeline();
		const commit = "waiting001";
		const target = { commit, branch: "main" };
		report({ target, results: [linked("pass")] }, ci);
		// The pipeline's next attempt fails. It is accepted and, for whatever reason, not applied yet.
		const project = findProject(h.app.db, "scratch");
		if (!project) throw new Error("no project");
		h.app.db.transaction(() => {
			const ctx = makeCtx(h.app, project, ci, true);
			acceptReport(ctx, {
				target,
				attempt: 2,
				results: [
					{
						test: { key: "t1" },
						annotation: { case: "C-1", version: 1 },
						outcome: "fail",
						failure: { message: "boom" },
					},
				],
			});
			stampSeq(ctx);
		});
		expect(gate({ commit }).verdict).toBe("pending");
		// A run planned over that commit now sees the older pass. It must not pass on it, let alone be closed.
		const planned = plan({ name: "Release", select: {}, accepts: { commit } });
		expect(gate({ run: planned.run }).verdict).toBe("pending");
		expect(first(rows<{ state: string }>("SELECT state FROM runs WHERE origin = 'planned'")).state).toBe("open");
		recoverAccepted(h.app);
		expect(gate({ run: planned.run })).toMatchObject({ verdict: "blocked", stale: false });
		expect(
			first(rows<{ outstanding: number }>("SELECT outstanding FROM runs WHERE origin = 'planned'")).outstanding,
		).toBe(0);
	});

	test("a dispute that is asked about again where its commit now is, is still a dispute there", () => {
		usePolicy("standard");
		h.call("propose", { edits: [{ op: "create", body: { title: "Agent exercise", methods: ["agent"] } }] });
		const agentA = h.actor("agent-a", "agent", ["read", "produce"]);
		const agentB = h.actor("agent-b", "agent", ["read", "produce"]);
		const ci = pipeline();
		const target = { repo: "app", commit: "movingdispute", env: "agents" };
		const planned = plan({
			name: "Disputed exploration",
			select: {},
			accepts: { repo: "app", commit: target.commit, env: "agents" },
			require: exercise(["agent"]),
		});
		const result = (outcome: string) => ({
			test: { key: "one" },
			annotation: { case: "C-1", version: 1 },
			outcome,
			...(outcome === "fail" ? { failure: { message: "same cause" } } : {}),
		});
		// Two agents disagree before any pipeline has reported the commit. A person settles it; the run closes.
		report({ target, results: [result("fail")] }, agentA);
		report({ target, results: [result("pass")] }, agentB);
		expect(decide(open("failure"), { is: "infra" }).status).toBe("decided");
		expect(first(rows<{ state: string }>("SELECT state FROM runs WHERE origin = 'planned'")).state).toBe("closed");
		// The project then lets a rule answer plain failures; disputes stay a person's who reported neither result.
		const clauses = structuredClone(PRESETS.standard.clauses).map((clause) =>
			clause.kind === "failure" && clause.id !== "failure-disputed"
				? {
						...clause,
						ask: { who: "rule" as const, notProducer: false, agents: "none" as const, reason: "optional" as const },
						answer: { is: "flaky" },
					}
				: clause,
		);
		h.call("propose", {
			edits: [
				{
					op: "policy",
					base: h.call<{ version: number }>("admin", { do: "policy.show", project: "scratch" }).version,
					clauses,
				},
			],
		});
		expect(decide(open("adopt"), { is: "accept" }, h.owner, { reason: "rules for plain failures" }).status).toBe(
			"decided",
		);
		// The pipeline places the commit. The dispute is asked about there, as a dispute: the rule for plain
		// failures does not answer it, and the run that rested on the old answer waits for a person.
		report(
			{
				target: { repo: "app", commit: target.commit, env: "ci", pr: 7 },
				results: [{ test: { key: "t" }, outcome: "pass" }],
			},
			ci,
		);
		const asked = open("failure");
		expect(asked.evidence).toMatchObject({ scope: "pr:7" });
		expect((asked.evidence as { hints: string[] }).hints).toContain("disputed");
		expect(asked.needs).toContain("did not produce");
		expect(first(slots(planned.run)).state).toBe("disputed");
		expect(gate({ run: planned.run })).toMatchObject({ verdict: "blocked", open: [asked.q] });
		expect(
			rows<{ answer: string }>("SELECT answer FROM decisions WHERE kind = 'failure' ORDER BY id").map(
				(row) => JSON.parse(row.answer).is,
			),
		).toEqual(["infra", "outdated", "flaky"]);
	});

	test("placing a commit whose failure was answered in sixty environments asks about each of them once", () => {
		const ci = pipeline();
		const commit = "manyenvs01";
		const fail = { test: { key: "one" }, outcome: "fail", failure: { message: "same cause" } };
		const envs = Array.from({ length: 60 }, (_, i) => `env-${i}`);
		// The agent reports all of them, and then a person answers each in turn: an answer for one environment
		// leaves the others asked about, in a question that still lists what it had seen.
		for (const env of envs) report({ target: { repo: "app", commit, env }, results: [fail] }, explorer());
		for (const _ of envs) expect(decide(open("failure"), { is: "infra" }).status).toBe("decided");
		expect(h.call<InboxReply>("inbox", { kind: "failure", limit: 500 }).items).toEqual([]);
		// The pipeline's first report of the commit is applied: every answer given about the commit on its own
		// ends, and the failure is asked about where the commit is, once for each environment.
		const placed = report(
			{ target: { repo: "app", commit, env: "ci", pr: 7 }, results: [{ test: { key: "t" }, outcome: "pass" }] },
			ci,
		);
		expect(placed.counts.total).toBe(1);
		expect(gate({ commit, repo: "app" }).verdict).toBe("passed");
		const asked = h.call<InboxReply>("inbox", { kind: "failure", limit: 500 }).items;
		expect(asked).toHaveLength(1);
		expect((first(asked).evidence as { targets: number[]; scope: string }).scope).toBe("pr:7");
		expect((first(asked).evidence as { targets: number[] }).targets).toHaveLength(60);
		// The two tests name no file, so the pipeline's test joins the agent's in one question about tests with no
		// case, and the rule's answer to that question ends too. It is not one of the sixty.
		expect(
			rows(
				"SELECT kind, count(*) AS n FROM decisions WHERE json_extract(answer, '$.is') = 'outdated' GROUP BY kind ORDER BY kind",
			),
		).toEqual([
			{ kind: "failure", n: 60 },
			{ kind: "map", n: 1 },
		]);
	});

	test("a run that only waited for a commit to be placed has its stored verdict back when the report is applied", () => {
		seed(1);
		const planned = plan({ name: "App only", select: {}, accepts: { commit: "waitstale1", repo: "app" } });
		report({ run: planned.run, results: [{ test: { case: "C-1" }, outcome: "fail", note: "app failure" }] });
		expect(gate({ run: planned.run }).verdict).toBe("blocked");
		// The same commit in another repository: an agent's failure first, then a person passing on a results
		// file with the same failure. That report places the fork's commit; the run over `app` only waits for it.
		const fork = { commit: "waitstale1", repo: "fork" };
		report(
			{ target: fork, results: [{ test: { key: "agent" }, outcome: "fail", failure: { message: "fork failure" } }] },
			explorer(),
		);
		report({
			target: { ...fork, branch: "main" },
			results: [{ test: { key: "pipeline" }, outcome: "fail", failure: { message: "fork failure" } }],
		});
		expect(rows("SELECT verdict, outstanding FROM runs WHERE no = ?", Number(planned.run.slice(2)))).toEqual([
			{ verdict: "blocked", outstanding: 0 },
		]);
		expect(gate({ run: planned.run })).toMatchObject({ verdict: "blocked", stale: false });
	});

	test("placing a commit reaches every question about it, however many there are, and keeps every test they named", () => {
		const ci = pipeline();
		const commit = "manyq00001";
		const fail = (key: string, message: string) => ({ test: { key }, outcome: "fail", failure: { message } });
		// One cause in one environment, asked about first. Then a second cause in 205 environments, each answered
		// on its own: far more than two hundred questions about this commit, the first one the oldest.
		report({ target: { repo: "app", commit, env: "first" }, results: [fail("a", "first cause")] }, explorer());
		expect(decide(open("failure"), { is: "infra" }).status).toBe("decided");
		const envs = Array.from({ length: 205 }, (_, i) => `env-${i}`);
		for (const [i, env] of envs.entries())
			report(
				{ target: { repo: "app", commit, env }, results: [fail(i % 2 === 0 ? "b" : "c", "second cause")] },
				explorer(),
			);
		for (const _ of envs) expect(decide(open("failure"), { is: "infra" }).status).toBe("decided");
		report(
			{ target: { repo: "app", commit, env: "ci", pr: 7 }, results: [{ test: { key: "t" }, outcome: "pass" }] },
			ci,
		);
		// Every answer about the commit on its own has ended, the oldest included, and both causes are asked
		// about where the commit is, the second with both of the tests it was seen on.
		expect(
			rows(
				"SELECT count(*) AS n FROM questions q JOIN decisions d ON d.id = q.decision WHERE q.kind = 'failure' AND json_extract(d.answer, '$.is') = 'infra'",
			),
		).toEqual([{ n: 0 }]);
		const asked = h.call<InboxReply>("inbox", { kind: "failure", limit: 500 }).items;
		expect(asked.map((item) => item.title).sort()).toEqual(["first cause", "second cause"]);
		const second = asked.find((item) => item.title === "second cause")?.evidence as {
			count: number;
			tests: { name: string }[];
			targets: number[];
		};
		expect(second.targets).toHaveLength(envs.length);
		expect(second.count).toBe(2);
		expect(second.tests.map((test) => test.name).sort()).toEqual(["b", "c"]);
	}, 60_000);

	test("a question asked again where its commit is placed names the tests of every question it replaces", () => {
		const commit = "unionq0001";
		// One cause, a different test in each environment, each answered before the next is reported: two
		// questions that each name one test. (Reported together, the first would already name both.)
		for (const [env, key] of [
			["one", "a"],
			["two", "b"],
		]) {
			report(
				{
					target: { repo: "app", commit, env },
					results: [{ test: { key }, outcome: "fail", failure: { message: "same cause" } }],
				},
				explorer(),
			);
			expect(decide(open("failure"), { is: "infra" }).status).toBe("decided");
		}
		report(
			{ target: { repo: "app", commit, env: "ci", pr: 7 }, results: [{ test: { key: "t" }, outcome: "pass" }] },
			pipeline(),
		);
		const asked = open("failure").evidence as { count: number; tests: { name: string }[]; targets: number[] };
		expect(asked.targets).toHaveLength(2);
		expect(asked.tests.map((test) => test.name).sort()).toEqual(["a", "b"]);
		expect(asked.count).toBe(2);
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
		usePolicy("standard", "ask");
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
		usePolicy("standard", "ask");
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
		report({ target, results: [result("fail")] }, h.actor("pipeline", "ci", ["read", "record"]));
		report({ target, results: [result("pass")] });
		const dispute = open("failure");
		expect((dispute.evidence as { hints: string[] }).hints).toContain("disputed");
		expect(decide(dispute, { is: "flaky" }).status).toBe("decided");
		expect(decide(open("failure"), { is: "flaky" }).status).toBe("decided");
		expect(gate({ commit: "head0012", repo: "app" }).verdict).toBe("passed");
		// An agent reports the same failure. No run asked for agents and the case does not admit them.
		const later = report({ target, results: [result("fail")] }, h.actor("explorer", "agent", ["read", "produce"]));
		expect(later.questions.map((q) => q.how)).toEqual(["already decided"]);
		expect(gate({ commit: "head0012", repo: "app" }).verdict).toBe("passed");
		expect(
			rows<{ answer: string }>("SELECT answer FROM decisions WHERE kind = 'failure'").map(
				(d) => JSON.parse(d.answer).is,
			),
		).toEqual(["flaky", "flaky"]);
	});

	test("an agent's failure is asked about even where a pipeline passes the same test", () => {
		const pipeline = h.actor("pipeline", "ci", ["read", "record"]);
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
		const pipeline = h.actor("pipeline", "ci", ["read", "record"]);
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

	test("an answer whose failure went away ends, and nobody is asked", () => {
		const pipeline = h.actor("pipeline", "ci", ["read", "record"]);
		report(
			{
				target: { commit: "gone0001", branch: "main" },
				results: [{ test: { key: "one" }, outcome: "fail", failure: { message: "old bug" } }],
			},
			pipeline,
		);
		const asked = open("failure");
		decide(asked, { is: "test" });
		// The next commit passes the test: the failure is gone, and so is the answer (decision 0102). There is nothing
		// left to withdraw.
		report(
			{ target: { commit: "gone0002", branch: "main" }, results: [{ test: { key: "one" }, outcome: "pass" }] },
			pipeline,
		);
		expect(h.call<{ status: string }[]>("decide", { undo: asked.q, reason: "wrong answer" })[0]?.status).toBe(
			"invalid",
		);
		// That puts no question about a failure that no longer exists in front of anybody, and the older commit's gate
		// does not name a question nobody can find.
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
		report({ target, results: [result("fail")] }, h.actor("pipeline", "ci", ["read", "record"]));
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
		const pipeline = h.actor("pipeline", "ci", ["read", "record"]);
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
		// The pipeline's result cannot fill a slot that asked for an agent, so the run still shows the failure. (It
		// is the first report of the commit that a gate counts, so the question is asked where the commit is.)
		report({ target, results: [{ ...one, outcome: "pass" }] }, pipeline);
		const still = open("failure");
		expect(h.call<InboxReply>("inbox", { kind: "failure", limit: 50 }).items).toHaveLength(1);
		expect(gate({ run: planned.run })).toMatchObject({ verdict: "blocked", open: [still.q] });
		// A second report by the pipeline changes nothing about it: the same question stays.
		report({ target, job: "again", results: [{ ...one, outcome: "pass" }] }, pipeline);
		expect(open("failure").q).toBe(still.q);
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
		expect(dispute.q).not.toBe(before.q);
		expect((dispute.evidence as { hints: string[] }).hints).toContain("disputed");
		// The owner reported the failure, the other member the pass: neither may say which of them was wrong.
		expect(decide(dispute, { is: "mistaken" }).status).toBe("forbidden");
		expect(decide(dispute, { is: "mistaken" }, other).status).toBe("forbidden");
		expect(rows("SELECT count(*) AS n FROM slot_results WHERE discounted_by IS NOT NULL")).toEqual([{ n: 0 }]);
		expect(decide(dispute, { is: "mistaken" }, third).status).toBe("decided");
	});

	test.each(["answer-then-pass", "pass-then-answer"])("a disputed slot needs its own answer: %s", (order) => {
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
		const cause = open("failure");
		if (order === "answer-then-pass") expect(decide(cause, { is: "flaky" }).status).toBe("decided");
		report({ run: planned.run, results: [{ test: { case: "C-1" }, outcome: "pass" }] }, other);
		if (order === "pass-then-answer") expect(decide(cause, { is: "flaky" }).status).toBe("decided");
		expect(rows<{ answer: string }>("SELECT answer FROM decisions WHERE kind = 'failure'")).toHaveLength(1);
		expect(first(slots(planned.run)).state).toBe("disputed");
		expect(gate({ run: planned.run })).toMatchObject({
			verdict: "blocked",
			tally: { pass: 0, disputed: 1, unexplained: 0, missing: 1 },
		});
		const dispute = open("failure");
		expect(dispute.q).not.toBe(cause.q);
		expect(decide(dispute, { is: "flaky" }).status).toBe("forbidden");
		expect(decide(dispute, { is: "flaky" }, other).status).toBe("forbidden");
		expect(decide(dispute, { is: "flaky" }, third).status).toBe("decided");
		expect(gate({ run: planned.run }).tally).toMatchObject({ pass: 1, disputed: 0, unexplained: 0 });
	});

	test("an agent dispute leaves cause answers standing on the commit, other runs and other scopes", () => {
		usePolicy("standard");
		seed(2, ["auto", "agent", "human"]);
		const ci = h.actor("pipeline", "ci", ["read", "record"]);
		const agent = h.actor("explorer", "agent", ["read", "produce"]);
		const target = { commit: "slotcause01", branch: "main" };
		const plain = plan({
			name: "Pipeline only",
			select: {},
			accepts: { commit: target.commit },
			require: exercise(["auto"]),
		});
		const explored = plan({
			name: "Exploration",
			select: {},
			accepts: { commit: target.commit },
			require: exercise(["auto", "agent"]),
		});
		const result = (outcome: string) => ({
			test: { key: "one" },
			annotation: { case: "C-1", version: 1 },
			outcome,
			...(outcome === "fail" ? { failure: { message: "shared cause" } } : {}),
		});
		report({ target, results: [result("fail")] }, ci);
		const cause = open("failure");
		expect(decide(cause, { is: "infra" }).status).toBe("decided");
		report({ target: { commit: "otherscope1", pr: 7 }, results: [result("fail")] }, ci);
		expect(decide(open("failure"), { is: "infra" }).status).toBe("decided");
		report({ target, results: [result("pass")] }, agent);
		expect(gate({ run: explored.run })).toMatchObject({ verdict: "blocked", tally: { disputed: 1 } });
		expect(gate({ run: plain.run }).tally).toMatchObject({ excused: 1, disputed: 0 });
		for (const commit of [target.commit, "otherscope1"])
			expect(gate({ commit })).toMatchObject({ verdict: "passed", tally: { excused: 1, unexplained: 0 } });
		const dispute = open("failure");
		expect(decide(dispute, { is: "flaky" }).status).toBe("decided");
		expect(decide(cause, { is: "defect" }).status).toBe("decided");
		expect(gate({ commit: target.commit }).verdict).toBe("failed");
		expect(gate({ run: plain.run }).tally).toMatchObject({ attributed: 1 });
		expect(gate({ run: explored.run }).tally).toMatchObject({ pass: 1, disputed: 0 });
		expect(first(h.call<DecideReply[]>("decide", { undo: dispute.q })).status).toBe("reopened");
		expect(gate({ run: explored.run })).toMatchObject({ verdict: "blocked", tally: { disputed: 1, attributed: 0 } });
		expect(gate({ commit: "otherscope1" }).verdict).toBe("passed");
	});

	test.each(["pass", "fail"])("agent %s reports never end a person's slot settlement", (agentOutcome) => {
		usePolicy("standard");
		seed(1, ["auto", "agent", "human"]);
		const ci = h.actor("pipeline", "ci", ["read", "record"]);
		const agent = h.actor("explorer", "agent", ["read", "produce"]);
		const target = { commit: "agentslot2", branch: "main" };
		const planned = plan({
			name: "Exploration",
			select: {},
			accepts: { commit: target.commit },
			require: exercise(["auto", "agent"]),
		});
		const result = (outcome: string) => ({
			test: { key: "one" },
			annotation: { case: "C-1", version: 1 },
			outcome,
			...(outcome === "fail" ? { failure: { message: "shared cause" } } : {}),
		});
		report({ target, results: [result(agentOutcome === "pass" ? "fail" : "pass")] }, ci);
		if (agentOutcome === "pass") expect(decide(open("failure"), { is: "infra" }).status).toBe("decided");
		report({ target, results: [result(agentOutcome)] }, agent);
		const dispute = open("failure");
		expect(dispute.title).toStartWith("Disputed C-1");
		const settled = decide(dispute, { is: "flaky" });
		expect(settled.status).toBe("decided");
		const ledger = rows("SELECT * FROM decisions WHERE kind = 'failure'");
		const standing = rows("SELECT * FROM result_excuses");
		for (const [index, outcome] of [agentOutcome, "pass", "fail"].entries()) {
			report({ target, attempt: index + 2, results: [result(outcome)] }, agent);
			expect(rows("SELECT * FROM decisions WHERE kind = 'failure'")).toEqual(ledger);
			expect(rows("SELECT * FROM result_excuses")).toEqual(standing);
			expect(h.call<{ state: string; decision: { id: number } }[]>("get", { refs: [dispute.q] })).toMatchObject([
				{ state: "decided", decision: { id: settled.decision } },
			]);
			expect(gate({ run: planned.run })).toMatchObject({ verdict: "passed", tally: { disputed: 0 } });
			expect(gate({ commit: target.commit }).verdict).toBe("passed");
		}
		// Replacing the classification recomputes the slot against the latest agent results too.
		expect(decide(dispute, { is: "infra" }).status).toBe("decided");
		expect(gate({ run: planned.run }).verdict).toBe("passed");
	});

	test("an agent's new failure after a mistaken settlement needs its own answer", () => {
		usePolicy("standard");
		seed(1, ["auto", "agent"]);
		const ci = h.actor("pipeline", "ci", ["read", "record"]);
		const agent = h.actor("explorer", "agent", ["read", "produce"]);
		const target = { commit: "agentwrong2", branch: "main" };
		const planned = plan({
			name: "Exploration",
			select: {},
			accepts: { commit: target.commit },
			require: exercise(["auto", "agent"]),
		});
		const result = (outcome: string) => ({
			test: { key: "one" },
			annotation: { case: "C-1", version: 1 },
			outcome,
			...(outcome === "fail" ? { failure: { message: "shared cause" } } : {}),
		});
		report({ target, results: [result("pass")] }, ci);
		report({ target, results: [result("fail")] }, agent);
		const prior = open("failure");
		expect(decide(prior, { is: "mistaken" }).status).toBe("decided");
		const ledger = rows("SELECT * FROM decisions WHERE kind = 'failure'");
		expect(gate({ run: planned.run }).verdict).toBe("passed");
		report({ target, attempt: 2, results: [result("fail")] }, agent);
		const asked = open("failure");
		expect(asked.title).toStartWith("Disputed C-1");
		expect(asked.q).not.toBe(prior.q);
		expect(rows("SELECT * FROM decisions WHERE kind = 'failure'")).toEqual(ledger);
		expect(gate({ run: planned.run })).toMatchObject({ verdict: "blocked", tally: { disputed: 1 } });
		expect(decide(asked, { is: "flaky" }).status).toBe("decided");
		expect(gate({ run: planned.run }).verdict).toBe("passed");
	});

	test("two slots sharing results require independent settlements and expiry leaves the cause answer intact", () => {
		usePolicy("standard");
		seed(2, ["human", "auto"]);
		const ci = h.actor("pipeline", "ci", ["read", "record"]);
		const passer = h.actor("passer", "human", ["read", "produce"]);
		const target = { commit: "sharedslot1", branch: "main" };
		const runs = ["One", "Two"].map((name) => plan({ name, select: {}, accepts: { commit: target.commit } }));
		const result = (outcome: string) => ({
			test: { key: "one" },
			annotation: { case: "C-1", version: 1 },
			outcome,
			...(outcome === "fail" ? { failure: { message: "same failure" } } : {}),
		});
		report({ target, results: [result("fail")] }, ci);
		expect(decide(open("failure"), { is: "infra" }).status).toBe("decided");
		report({ target, results: [result("pass")] }, passer);
		const disputes = h.call<InboxReply>("inbox", { kind: "failure", limit: 50 }).items;
		expect(disputes).toHaveLength(2);
		const settled = first(disputes);
		const settledRun = (settled.evidence as { run: string }).run;
		const unsettledRun = first(runs.filter((run) => run.run !== settledRun)).run;
		expect(decide(settled, { is: "flaky" }).status).toBe("decided");
		expect(gate({ run: settledRun }).tally).toMatchObject({ pass: 1, disputed: 0 });
		expect(gate({ run: unsettledRun })).toMatchObject({ verdict: "blocked", tally: { disputed: 1 } });
		h.advance(15 * 86_400_000);
		const rule = first(rows<{ id: number }>("SELECT id FROM actors WHERE kind = 'rule'")).id;
		expect(sweep(h.app, rule)).toBe(1);
		expect(gate({ run: settledRun })).toMatchObject({ verdict: "blocked", tally: { disputed: 1 } });
		expect(gate({ commit: target.commit })).toMatchObject({ verdict: "passed", tally: { excused: 1 } });
	});

	test("the slot migration preserves an existing inherited result excuse as global standing", () => {
		report(ciReport({ commit: "basefor70", n: 1, fail: { 0: "same cause" } }));
		report(ciReport({ commit: "headfor70", pr: 70, base: "basefor70", n: 1, fail: { 0: "same cause" } }));
		const before = rows<{ result: number; decision: number; class: string; expires_at: number | null }>(
			"SELECT result, decision, class, expires_at FROM result_excuses",
		);
		expect(before).toHaveLength(1);
		const earlier = MIGRATIONS.find((migration) => migration.name === "result_excuses");
		const slots = MIGRATIONS.find((migration) => migration.name === "slot_excuses");
		if (!earlier || !slots) throw new Error("missing the result or slot excuse migration");
		h.app.db.exec("DROP TABLE result_excuses; DROP INDEX changes_base;");
		h.app.db.exec(earlier.sql);
		for (const row of before)
			h.app.db.raw
				.query("INSERT INTO result_excuses (result, decision, class, expires_at) VALUES (?, ?, ?, ?)")
				.run(row.result, row.decision, row.class, row.expires_at);
		// Only the slot migration runs, in one transaction as migrate applies it: the tables of every other migration
		// are already here, so rewinding the version would run later migrations a second time.
		h.app.db.transaction(() => h.app.db.exec(slots.sql));
		expect(rows("SELECT result, decision, class, expires_at, slot FROM result_excuses")).toEqual(
			before.map((row) => ({ ...row, slot: null })),
		);
		expect(gate({ commit: "headfor70" })).toMatchObject({ verdict: "passed", tally: { excused: 1 } });
	});

	test("startup gives an earlier cause-settled dispute its own question without ending its cause answer", () => {
		usePolicy("standard");
		seed(2);
		const passer = h.actor("passer", "human", ["read", "produce", "answer"]);
		const planned = plan({ name: "Earlier dispute", select: {} });
		report({ run: planned.run, results: [{ test: { case: "C-1" }, outcome: "fail", note: "same cause" }] });
		expect(decide(open("failure"), { is: "flaky" }).status).toBe("decided");
		report({ run: planned.run, results: [{ test: { case: "C-1" }, outcome: "pass" }] }, passer);
		const dispute = open("failure");
		const id = first(rows<{ id: number }>("SELECT id FROM questions WHERE no = ?", Number(dispute.q.slice(2)))).id;
		h.app.db.raw.query("DELETE FROM question_refs WHERE question = ?").run(id);
		h.app.db.raw.query("DELETE FROM questions WHERE id = ?").run(id);
		h.app.db.raw
			.query("UPDATE runs SET verdict = 'pending', tally = ? WHERE origin = 'planned'")
			.run(JSON.stringify({ pass: 1, excused: 0, attributed: 0, unexplained: 0, disputed: 0, missing: 1, skipped: 0 }));
		expect(recoverDisputes(h.app)).toBe(1);
		expect(gate({ run: planned.run })).toMatchObject({ verdict: "blocked", tally: { disputed: 1, pass: 0 } });
		expect(open("failure").title).toStartWith("Disputed C-1");
		expect(
			rows<{ answer: string }>("SELECT answer FROM decisions WHERE kind = 'failure'").map(
				(row) => JSON.parse(row.answer).is,
			),
		).toEqual(["flaky"]);
		expect(recoverDisputes(h.app)).toBe(0);
	});

	test.each(["ci", "human"] as const)(
		"a late %s result renews only its slot settlement and a correcting pass closes the dispute",
		(kind) => {
			usePolicy("standard");
			seed(2, ["human", "auto"]);
			const ci = h.actor("producer", kind, kind === "ci" ? ["read", "record"] : ["read", "produce"]);
			const passer = h.actor("passer", "human", ["read", "produce"]);
			const target = { commit: "lateslot01", branch: "main" };
			const planned = plan({ name: "Late results", select: {}, accepts: { commit: target.commit } });
			const result = (outcome: string) => ({
				test: { key: "one" },
				annotation: { case: "C-1", version: 1 },
				outcome,
				...(outcome === "fail" ? { failure: { message: "same cause" } } : {}),
			});
			report({ target, results: [result("fail")] }, ci);
			expect(decide(open("failure"), { is: "infra" }).status).toBe("decided");
			report({ target, results: [result("pass")] }, passer);
			const prior = open("failure");
			expect(decide(prior, { is: "infra" }).status).toBe("decided");
			report({ target, attempt: 2, results: [result("fail")] }, ci);
			const renewed = open("failure");
			expect(renewed.q).not.toBe(prior.q);
			expect(decide(prior, { is: "flaky" }).status).toBe("conflict");
			expect(gate({ run: planned.run })).toMatchObject({ verdict: "blocked", tally: { disputed: 1 } });
			expect(gate({ commit: target.commit })).toMatchObject({ verdict: "passed", tally: { excused: 1 } });
			report({ target, attempt: 3, results: [result("pass")] }, ci);
			expect(first(slots(planned.run)).state).toBe("satisfied");
			expect(gate({ run: planned.run })).toMatchObject({ tally: { pass: 1, disputed: 0 }, open: [] });
			expect(decide(renewed, { is: "flaky" }).status).toBe("conflict");
		},
	);

	test("an attributed cause cannot conceal another unsettled cause in the same disputed slot", () => {
		usePolicy("standard");
		seed(2, ["human", "auto"]);
		const producer = h.actor("producer", "human", ["read", "produce"]);
		const planned = plan({ name: "Several causes", select: {} });
		report(
			{
				run: planned.run,
				results: ["first cause", "second cause"].map((message) => ({
					test: { key: message },
					annotation: { case: "C-1", version: 1 },
					outcome: "fail",
					failure: { message },
				})),
			},
			producer,
		);
		report({ run: planned.run, results: [{ test: { case: "C-1" }, outcome: "pass" }] }, producer);
		const disputes = h
			.call<InboxReply>("inbox", { kind: "failure", limit: 50 })
			.items.filter((item) => item.title.startsWith("Disputed "));
		expect(disputes).toHaveLength(2);
		expect(decide(first(disputes), { is: "defect" }).status).toBe("decided");
		expect(gate({ run: planned.run })).toMatchObject({ verdict: "blocked", tally: { disputed: 1, attributed: 0 } });
		expect(decide(first(disputes.slice(1)), { is: "flaky" }).status).toBe("decided");
		expect(gate({ run: planned.run })).toMatchObject({ verdict: "failed", tally: { disputed: 0, attributed: 1 } });
	});

	test("changing or withdrawing a slot settlement is kept from its producers while its cause answer stays separate", () => {
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
		const cause = open("failure");
		expect(decide(cause, { is: "flaky" }).status).toBe("decided");
		report(typed("pass"), bob);
		expect(first(slots(planned.run)).state).toBe("disputed");
		const disputed = open("failure");
		expect(disputed.answers).toContain("mistaken");
		expect(disputed.needs).toContain("did not produce");
		expect((disputed.evidence as { hints: string[] }).hints).toContain("disputed");
		expect(decide(disputed, { is: "infra" }).status).toBe("forbidden");
		expect(decide(disputed, { is: "infra" }, bob).status).toBe("forbidden");
		expect(decide(disputed, { is: "infra" }, carol).status).toBe("decided");
		expect(first(h.call<DecideReply[]>("decide", { undo: disputed.q, reason: "take it back" })).status).toBe(
			"forbidden",
		);
		expect(first(h.call<DecideReply[]>("decide", { undo: disputed.q, reason: "take it back" }, bob)).status).toBe(
			"forbidden",
		);
		expect(decide(cause, { is: "expected" }).status).toBe("decided");
		expect(gate({ run: planned.run }).tally).toMatchObject({ pass: 1, disputed: 0 });
		expect(decide(disputed, { is: "flaky" }, carol).status).toBe("decided");
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

	test("everybody a dispute was kept from stays kept from its answer: whoever passed as well as whoever failed", () => {
		usePolicy("standard");
		seed(2, ["human", "auto"]);
		const alice = h.actor("alice", "human", ["read", "produce", "answer", "plan"]);
		const bob = h.actor("bob", "human", ["read", "produce", "answer", "plan"]);
		const carol = h.actor("carol", "human", ["read", "produce", "answer", "plan"]);
		let n = 0;
		for (const shape of ["plan after the reports", "an answer before the dispute"])
			for (const select of [{}, { cases: ["C-1"] }])
				for (const given of ["mistaken", "flaky"])
					for (const mode of ["undo", "replace"]) {
						const label = `${shape}, ${"cases" in select ? "run closes" : "run stays open"}, ${given}, ${mode}`;
						const target = { repo: "app", commit: `parties${String(n++).padStart(3, "0")}`, branch: "main" };
						const result = (outcome: string) => ({
							test: { key: `one-${n}` },
							annotation: { case: "C-1", version: 1 },
							outcome,
							...(outcome === "fail" ? { failure: { message: `cause ${n}` } } : {}),
						});
						const planNow = () => plan({ name: label, select, accepts: { repo: "app", commit: target.commit } });
						// The question about this cause as it stands: open, or decided and still in force.
						const latest = () => {
							const about = ["open", "decided"]
								.flatMap((state) => h.call<InboxReply>("inbox", { kind: "failure", state, limit: 500 }).items)
								.filter((item) => item.title === `cause ${n}` || item.title.endsWith(`: cause ${n}`))
								.sort((a, b) => Number(b.q.slice(2)) - Number(a.q.slice(2)));
							return first(about);
						};
						if (shape !== "plan after the reports") planNow();
						report({ target, results: [result("fail")] }, alice);
						if (shape !== "plan after the reports")
							expect(decide(latest(), { is: "expected" }, alice).status).toBe("decided");
						report({ target, results: [result("pass")] }, bob);
						if (shape === "plan after the reports") planNow();
						// Bob passed what Alice failed: neither may settle it. Carol, who reported neither, does.
						expect(decide(latest(), { is: "infra" }, bob).status).toBe("forbidden");
						expect(["decided", "already"]).toContain(decide(latest(), { is: given }, carol).status);
						// It stays out of Bob's hands afterwards, whatever the slot and the run look like now.
						const reply =
							mode === "undo"
								? first(h.call<DecideReply[]>("decide", { undo: latest().q, reason: "no" }, bob))
								: decide(latest(), { is: given === "flaky" ? "infra" : "flaky" }, bob);
						expect(`${label}: ${reply.status}`).toBe(`${label}: forbidden`);
					}
	});

	test("a run closing does not hand a dispute back to the people it is kept from", () => {
		usePolicy("standard");
		seed(2);
		const alice = h.actor("alice", "human", ["read", "produce", "answer", "plan"]);
		const bob = h.actor("bob", "human", ["read", "produce", "answer", "plan"]);
		const carol = h.actor("carol", "human", ["read", "produce", "answer", "plan"]);
		const planned = h.call<PlanReply>("plan", { name: "Review", select: {} }, alice);
		const typed = (ref: string, outcome: string) => ({
			run: planned.run,
			results: [{ test: { case: ref }, outcome, ...(outcome === "fail" ? { note: "same cause" } : {}) }],
		});
		// Alice fails C-1 and answers it herself (nothing disputes it yet); Bob then passes it: a dispute.
		report(typed("C-1", "fail"), alice);
		expect(decide(open("failure"), { is: "flaky" }, alice).status).toBe("decided");
		report(typed("C-1", "pass"), bob);
		const dispute = open("failure");
		expect(decide(dispute, { is: "flaky" }, alice).status).toBe("forbidden");
		expect(decide(dispute, { is: "flaky" }, carol).status).toBe("decided");
		const standing = () => open("failure", "decided");
		expect(decide(standing(), { is: "infra" }, alice).status).toBe("forbidden");
		// Bob passes the other case: the run passes on Carol's slot settlement and the rule closes it.
		report(typed("C-2", "pass"), bob);
		expect(first(rows<{ state: string }>("SELECT state FROM runs WHERE origin = 'planned'")).state).toBe("closed");
		expect(first(slots(planned.run)).state).toBe("disputed");
		// The slot still disputes the failure, so it is still a dispute: for Alice, for Bob, for the question shown.
		expect((standing().evidence as { hints: string[] }).hints).toContain("disputed");
		expect(standing().needs).toContain("did not produce");
		expect(decide(standing(), { is: "infra" }, alice).status).toBe("forbidden");
		expect(first(h.call<DecideReply[]>("decide", { undo: standing().q, reason: "no" }, alice)).status).toBe(
			"forbidden",
		);
		expect(decide(standing(), { is: "infra" }, bob).status).toBe("forbidden");
		expect(first(h.call<DecideReply[]>("decide", { undo: standing().q, reason: "no" }, bob)).status).toBe("forbidden");
		expect(decide(standing(), { is: "infra" }, carol).status).toBe("decided");
	});

	test("a dispute settled for one build does not make a later failure with the same cause a dispute", () => {
		usePolicy("standard");
		seed(1, ["human", "auto"]);
		const alice = h.actor("alice", "human", ["read", "produce", "answer", "plan"]);
		const bob = h.actor("bob", "human", ["read", "produce", "answer", "plan"]);
		const carol = h.actor("carol", "human", ["read", "produce", "answer", "plan"]);
		const ci = h.actor("pipeline", "ci", ["read", "record"]);
		const result = (outcome: string) => ({
			test: { key: "one" },
			annotation: { case: "C-1", version: 1 },
			outcome,
			...(outcome === "fail" ? { failure: { message: "same cause" } } : {}),
		});
		// Alice fails and Bob passes one case in a run over the first build; Carol settles it for that build
		// (an infrastructure failure there), and the run closes on her answer.
		const old = { repo: "app", commit: "shadow001", branch: "main" };
		h.call<PlanReply>("plan", { name: "Release", select: {}, accepts: { repo: "app", commit: old.commit } }, alice);
		report({ target: old, results: [result("fail")] }, alice);
		report({ target: old, results: [result("pass")] }, bob);
		expect(decide(open("failure"), { is: "infra" }, carol).status).toBe("decided");
		expect(first(rows<{ state: string }>("SELECT state FROM runs WHERE origin = 'planned'")).state).toBe("closed");
		// The pipeline fails the next build with the same cause. Nothing disputes that failure: it is a plain
		// failure, with a plain failure's answers, and anybody who may answer one may answer it, Bob included.
		report({ target: { repo: "app", commit: "shadow002", branch: "main" }, results: [result("fail")] }, ci);
		const next = open("failure");
		expect((next.evidence as { hints: string[] }).hints).not.toContain("disputed");
		expect(next.answers).not.toContain("mistaken");
		expect(decide(next, { is: "flaky" }, bob).status).toBe("decided");
		// Bob's answer is about the cause from here on. It does not take the place of Carol's judgement of the
		// dispute he was a party to: hers is still the answer for the first build, and the run still rests on it.
		expect(
			rows<{ answer: string }>(
				`SELECT d.answer FROM depends_on dep JOIN decisions d ON d.id = dep.decision
				 JOIN runs r ON r.id = dep.run WHERE r.origin = 'planned'`,
			).map((row) => JSON.parse(row.answer).is),
		).toEqual(["infra"]);
		// And Alice cannot take it back.
		const settled = h
			.call<InboxReply>("inbox", { kind: "failure", state: "decided", limit: 50 })
			.items.filter((item) => (item.decision?.answer as { is?: string } | undefined)?.is === "infra");
		expect(first(h.call<DecideReply[]>("decide", { undo: first(settled).q, reason: "no" }, alice)).status).toBe(
			"forbidden",
		);
	});

	test("an answer to a later failure does not replace a dispute's answer that its author may not settle, whatever the clause asks", () => {
		// A policy of the project's own: disputes are an administrator's to settle. The people who reported the
		// results are not shut out as producers; it is the role that is asked.
		const clauses = structuredClone(PRESETS.standard.clauses).map((clause) =>
			clause.id === "failure-disputed"
				? { ...clause, ask: { ...clause.ask, who: "admin" as const, notProducer: false } }
				: clause,
		);
		h.call("propose", {
			edits: [
				{
					op: "policy",
					base: h.call<{ version: number }>("admin", { do: "policy.show", project: "scratch" }).version,
					clauses,
				},
			],
		});
		expect(decide(open("adopt"), { is: "accept" }, h.owner, { reason: "our own rules" }).status).toBe("decided");
		seed(1, ["human", "auto"]);
		const alice = h.actor("alice", "human", ["read", "produce", "answer", "plan"]);
		const bob = h.actor("bob", "human", ["read", "produce", "answer", "plan"]);
		const ci = h.actor("pipeline", "ci", ["read", "record"]);
		const result = (outcome: string) => ({
			test: { key: "one" },
			annotation: { case: "C-1", version: 1 },
			outcome,
			...(outcome === "fail" ? { failure: { message: "same cause" } } : {}),
		});
		const old = { repo: "app", commit: "overlap01", branch: "main" };
		const planned = plan({ name: "Closed dispute", select: {}, accepts: { repo: "app", commit: old.commit } });
		report({ target: old, results: [result("fail")] }, alice);
		report({ target: old, results: [result("pass")] }, bob);
		// Bob is a member, not an administrator: the dispute is not his. The owner settles it for that build.
		expect(decide(open("failure"), { is: "infra" }, bob).status).toBe("forbidden");
		expect(decide(open("failure"), { is: "infra" }).status).toBe("decided");
		expect(gate({ run: planned.run }).verdict).toBe("passed");
		// The next build fails with the same cause: a plain failure, which a member may answer. Bob does, for the
		// whole cause. The administrator's judgement of the dispute stays the answer for the first build.
		report({ target: { ...old, commit: "overlap02" }, results: [result("fail")] }, ci);
		expect(decide(open("failure"), { is: "expected" }, bob).status).toBe("decided");
		expect(gate({ run: planned.run }).verdict).toBe("passed");
		expect(
			rows<{ answer: string }>("SELECT answer FROM decisions WHERE kind = 'failure' ORDER BY id").map(
				(row) => JSON.parse(row.answer).is,
			),
		).toEqual(["infra", "expected"]);
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

	for (const scenario of [
		"some targets",
		"expired",
		"at expiry",
		"results only",
		"intersecting targets",
		"disjoint targets",
		"basis changed",
	] as const) {
		test(`answering leaves exactly the targets a neighbouring hold does not cover: ${scenario}`, () => {
			const failing = { test: { key: "one" }, outcome: "fail", failure: { message: "same cause" } };
			for (const env of ["one", "two", "three", "four"])
				report({ target: { commit: "holdsets01", branch: "main", env }, results: [failing] });
			const neighbour = open("failure");
			const seen = neighbour.evidence as { targets: number[]; targetId: number };
			const [one, two, three, four] = seen.targets;
			if (one === undefined || two === undefined || three === undefined || four === undefined)
				throw new Error("expected four environments");
			expect(seen.targetId).toBe(four);
			// The handler currently emits one target term. Supply compound terms here to exercise the stored
			// hold contract through decide, including combinations that no answer preset currently emits.
			const original = HANDLERS.failure.holds;
			const held = spyOn(HANDLERS.failure, "holds").mockImplementation((input) => {
				if (input.question.no !== Number(neighbour.q.slice(2))) return original(input);
				const terms: HoldTerm[] = [
					{ until: "this-target", targets: [four, two] },
					{ until: "basis-changes", basis: input.question.basis },
				];
				switch (scenario) {
					case "expired":
						terms.push({ until: "time", at: input.now - 1 });
						break;
					case "at expiry":
						terms.push({ until: "time", at: input.now + 2 });
						break;
					case "results only":
						terms.push({ until: "results-named" });
						break;
					case "intersecting targets":
						terms.push({ until: "this-target", targets: [four, one] });
						break;
					case "disjoint targets":
						terms.push({ until: "this-target", targets: [one] });
						break;
					case "basis changed":
						terms.push({ until: "basis-changes", basis: "earlier basis" });
						break;
				}
				return terms;
			});
			try {
				expect(decide(neighbour, { is: "infra" }).status).toBe("decided");
			} finally {
				held.mockRestore();
			}
			const next = open("failure");
			expect(next.evidence).toMatchObject({ targets: [one, two, three], targetId: three });
			expect(decide(next, { is: "infra" }).status).toBe("decided");
			const pending = h.call<InboxReply>("inbox", { kind: "failure" }).items;
			expect(pending).toHaveLength(1);
			expect(first(pending).evidence).toMatchObject({
				targets: scenario === "some targets" ? [one] : [one, two],
				targetId: scenario === "some targets" ? one : two,
			});
		});
	}

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

	test("a closed commit run keeps its pinned failure question after the commit passes on a newer case version", () => {
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
		expect(first(rows<{ state: string }>("SELECT state FROM runs WHERE origin = 'planned'")).state).toBe("closed");
		h.call("decide", { undo: question.q });
		// The case is edited and the commit passes on a newer attempt, proving the new version. The run is pinned
		// to the version it was planned on, so that pass is not its evidence: it still shows the failure.
		h.call("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Case 1, reworded" } }] });
		report({
			target: { commit: "reopen01", branch: "main" },
			attempt: 2,
			results: [{ test: { key: "one" }, annotation: { case: "C-1", version: 2 }, outcome: "pass" }],
		});
		expect(gate({ commit: "reopen01" }).verdict).toBe("passed");
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
		const cause = first(
			h.call<InboxReply>("inbox", { kind: "failure", limit: 50 }).items.filter((item) => item.q !== dispute.q),
		);
		expect(gate({ commit: "rc300005" })).toMatchObject({ verdict: "blocked", open: [cause.q] });
		expect(gate({ run: planned.run }).open).toContain(dispute.q);
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
		expect(gate({ run: planned.run }).verdict).toBe("blocked");
		expect(gate({ run: planned.run }).open).toContain(asked.q);
		expect(gate({ run: planned.run }).open).toHaveLength(2);
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
		const productionOnly = plan({
			name: "Production only",
			select: {},
			accepts: { commit: "build001", env: "prod" },
		});
		const everywhere = plan({ name: "All environments", select: {}, accepts: { commit: "build001" } });
		// A failure and another person's pass dispute the case in production. It is called infrastructure there.
		on("prod", "fail");
		on("prod", "pass", other);
		const production = first(
			h
				.call<InboxReply>("inbox", { kind: "failure", limit: 50 })
				.items.filter((item) => (item.evidence as { run?: string }).run === productionOnly.run),
		);
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
		expect(gate({ run: staging.run }).open).toHaveLength(2);
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
	test("a throwing subscriber cannot change a committed reply or hide the event from other subscribers", () => {
		const logged = spyOn(console, "error").mockImplementation(() => {});
		const stopBroken = h.app.subscribe(() => {
			throw new Error("subscriber-private-detail");
		});
		const events: { op: string; seq: number; touched: string[] }[] = [];
		const stopHealthy = h.app.subscribe((event) => events.push(event));
		try {
			const input = { cmd: "publish-failed-01", edits: [{ op: "create", outline: "Durable case" }] };
			const reply = h.raw("propose", input);
			expect(h.call("command", { cmd: input.cmd })).toMatchObject({ state: "done", op: "propose", seq: 2 });
			expect(h.call("find", { in: "cases" })).toMatchObject({
				count: 1,
				items: [{ ref: "C-1", title: "Durable case" }],
			});
			expect(reply).toMatchObject({
				ok: true,
				seq: 2,
				result: { status: "adopted", cases: [{ ref: "C-1", version: 1 }] },
			});
			expect(events).toMatchObject([{ op: "propose", seq: 2, touched: expect.arrayContaining(["C-1"]) }]);
			expect(logged.mock.calls).toEqual([["[mainworthy] change subscriber failed:", { seq: 2 }]]);
			expect(h.raw("propose", input)).toEqual(reply);
			expect(h.call("find", { in: "cases" })).toMatchObject({ count: 1 });
			expect(events).toHaveLength(1);
			// A subscriber that missed the hint can recover the durable change without another write or event.
			expect(h.call("since", { cursor: "s:1" })).toMatchObject({
				changed: [{ ref: "C-1", title: "Durable case", version: 1, changed: "created" }],
				cursor: "s:2",
				more: false,
			});
		} finally {
			stopBroken();
			stopHealthy();
			logged.mockRestore();
		}
	});

	test.each([2, 3])("a subscriber throwing at report sequence %i cannot interrupt either commit", async (failedSeq) => {
		const logged = spyOn(console, "error").mockImplementation(() => {});
		const stopBroken = h.app.subscribe((event) => {
			if (event.seq === failedSeq) throw new Error("subscriber-private-detail");
		});
		const events: { op: string; seq: number }[] = [];
		const stopHealthy = h.app.subscribe(({ op, seq }) => events.push({ op, seq }));
		try {
			const input = { ...ciReport({ commit: "c0ffee03", n: 1 }), cmd: "publish-report-01" };
			const reply = await invokeAsync(h.app, OPS, {
				op: "report",
				project: "scratch",
				actor: () => h.owner,
				input,
			});
			expect(reply).toMatchObject({ ok: true, seq: 3, result: { fresh: true, counts: { total: 1, pass: 1 } } });
			expect(events).toEqual([
				{ op: "report", seq: 2 },
				{ op: "report", seq: 3 },
			]);
			expect(h.call("command", { cmd: input.cmd })).toMatchObject({ state: "done", op: "report", seq: 3 });
			expect(h.raw("report", input)).toEqual(reply);
			expect(logged.mock.calls).toEqual([["[mainworthy] change subscriber failed:", { seq: failedSeq }]]);
		} finally {
			stopBroken();
			stopHealthy();
			logged.mockRestore();
		}
	});

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

	test("the caller of a command can ask what became of it, and nobody else is told", async () => {
		const fate = (cmd: string, as = h.owner, project = "scratch") =>
			invoke(h.app, OPS, { op: "command", project, input: { cmd }, actor: () => as });
		expect(fate("never-sent-01")).toMatchObject({ ok: true, result: { state: "none" } });
		const made = h.raw("propose", { cmd: "asked-about-01", edits: [{ op: "create", outline: "Once" }] });
		if (!made.ok) throw new Error(made.error.message);
		expect(fate("asked-about-01")).toMatchObject({
			ok: true,
			result: { state: "done", op: "propose", seq: made.seq, reply: made.result },
		});
		// A command that was refused wrote nothing, its id included.
		const refused = { cmd: "refused-cmd-01", edits: [{ op: "edit", case: "C-99", base: 1, body: { title: "No" } }] };
		expect(h.raw("propose", refused)).toMatchObject({ ok: false, error: { code: "not_found" } });
		expect(fate("refused-cmd-01")).toMatchObject({ result: { state: "none" } });
		// A reply that settled nothing is still the reply the command was given.
		h.call("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Theirs" } }] });
		h.call("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Mine" } }] });
		const question = open("adopt");
		const merge = (cmd: string, title: string, onEvidence = question.evidenceHash) =>
			h.raw("decide", {
				cmd,
				q: question.q,
				onEvidence,
				answer: { is: "merge", body: emptyBody(title) },
			});
		const stale = merge("merge-stale-01", "Merged", "0000");
		expect(stale).toMatchObject({ ok: true, result: [{ status: "conflict" }] });
		expect(fate("merge-stale-01")).toMatchObject({
			result: { state: "done", op: "decide", reply: stale.ok && stale.result },
		});
		// A merge names the version it made: what a page whose reply was lost needs to know.
		const merged = merge("merge-made-01", "Merged");
		expect(fate("merge-made-01")).toMatchObject({
			result: {
				state: "done",
				reply: [{ status: "decided", effects: { status: "adopted", cases: [{ ref: "C-1", version: 3 }] } }],
			},
		});
		expect(fate("merge-made-01")).toMatchObject({ result: { reply: merged.ok && merged.result } });
		// Another caller is told nothing, in this project or another.
		const member = h.actor("member", "human", ["read", "produce"]);
		expect(fate("asked-about-01", member)).toMatchObject({ ok: true, result: { state: "none" } });
		h.call("admin", { do: "project.create", key: "other" });
		expect(fate("asked-about-01", h.owner, "other")).toMatchObject({ ok: true, result: { state: "none" } });
		// A command on the instance is in no project. Its stored reply can stand for a secret and is never read here.
		h.call("admin", { do: "token.create", actor: "ci-bot", kind: "ci", can: ["read"], cmd: "admin-command-09" });
		expect(rows("SELECT project FROM commands WHERE id = 'admin-command-09'")).toEqual([{ project: 0 }]);
		expect(fate("admin-command-09")).toMatchObject({ ok: true, result: { state: "none" } });
		expect(fate("short")).toMatchObject({ ok: false, error: { code: "invalid" } });
		// A caller who may not read is refused.
		const writer = h.actor("writer", "ci", ["record"]);
		expect(fate("asked-about-01", writer)).toMatchObject({ ok: false, error: { code: "forbidden" } });
	});

	test("a report that is accepted and not yet applied is a command that has begun", async () => {
		let onAccepted = (): void => {};
		const accepted = new Promise<void>((resolve) => {
			onAccepted = resolve;
		});
		const unsubscribe = h.app.subscribe((event) => {
			if (event.op === "report") onAccepted();
		});
		const fate = () =>
			invoke(h.app, OPS, { op: "command", project: "scratch", input: { cmd: "report-cmd-01" }, actor: () => h.owner });
		const pending = invokeAsync(h.app, OPS, {
			op: "report",
			project: "scratch",
			actor: () => h.owner,
			input: { ...ciReport({ commit: "c0ffee01", n: 3 }), cmd: "report-cmd-01" },
		});
		try {
			await accepted;
			expect(fate()).toMatchObject({ ok: true, result: { state: "begun", op: "report" } });
			const receipt = await pending;
			if (!receipt.ok) throw new Error(receipt.error.message);
			expect(fate()).toMatchObject({ ok: true, result: { state: "done", op: "report", reply: receipt.result } });
		} finally {
			unsubscribe();
			await pending;
		}
	});

	// Issue #377. The process stops after the first transaction of a report committed, with a command id bound to it.
	test("a report that recovery applies finishes its command with the receipt, as the request would have", () => {
		const fate = (cmd: string) =>
			invoke(h.app, OPS, { op: "command", project: "scratch", input: { cmd }, actor: () => h.owner });
		const begin = h.app.db.begin.bind(h.app.db);
		let transactions = 0;
		const interrupted = spyOn(h.app.db, "begin").mockImplementation(() => {
			if (++transactions === 2) throw new Error("the process stopped before applying the report");
			begin();
		});
		const logged = spyOn(console, "error").mockImplementation(() => {});
		const stopped = invoke(h.app, OPS, {
			op: "report",
			project: "scratch",
			actor: () => h.owner,
			input: { ...ciReport({ commit: "c0ffee02", n: 3 }), cmd: "report-cmd-02" },
		});
		interrupted.mockRestore();
		logged.mockRestore();
		expect(stopped.ok).toBe(false);
		expect(fate("report-cmd-02")).toMatchObject({ ok: true, result: { state: "begun", op: "report" } });
		const seqBefore = rows<{ seq: number }>("SELECT seq FROM projects WHERE key = 'scratch'")[0]?.seq ?? 0;

		expect(recoverAccepted(h.app)).toBe(1);

		const receipt = rows<{ receipt: string }>("SELECT receipt FROM batches")[0]?.receipt;
		expect(receipt).toBeDefined();
		expect(fate("report-cmd-02")).toMatchObject({
			ok: true,
			result: { state: "done", op: "report", seq: seqBefore + 1, reply: JSON.parse(receipt ?? "null") },
		});
		// The same request sent again gets that reply and takes no number.
		const again = invoke(h.app, OPS, {
			op: "report",
			project: "scratch",
			actor: () => h.owner,
			input: { ...ciReport({ commit: "c0ffee02", n: 3 }), cmd: "report-cmd-02" },
		});
		expect(again).toMatchObject({ ok: true, result: JSON.parse(receipt ?? "null"), seq: seqBefore + 1 });
		expect(rows<{ seq: number }>("SELECT seq FROM projects WHERE key = 'scratch'")[0]?.seq).toBe(seqBefore + 1);
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
			h.actor("pipeline", "ci", ["read", "record"]),
		);
		const now = open("failure");
		expect((now.evidence as { hints: string[] }).hints).toContain("disputed");
		expect(now.evidence).toMatchObject({ message: asked.message, sample: asked.sample });
		expect((now.evidence as { tests: unknown[] }).tests).toHaveLength(1);
	});

	test("the number of tests a question has seen does not fall when a later report adds one", () => {
		const ci = h.actor("pipeline", "ci", ["read", "record"]);
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
		report(ciReport({ commit: "policy001", n: 1, fail: { 0: "bug" } }), h.actor("pipeline", "ci", ["read", "record"]));
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
			can: ["read", "record"],
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
