// Things that must never happen, each found by an independent review of the engine and reproduced here first.
// One test per promise: what a result may prove, what a decision may change, and what a caller may see.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { emptyBody } from "../src/core/model.ts";
import type { DecideReply, GateStatus, InboxReply, PlanReply, ProposeReply, ReportReceipt } from "../src/core/ops.ts";
import { setExcuse } from "../src/server/evidence/evidence.ts";
import { sweep } from "../src/server/jobs.ts";
import { findProject, makeCtx } from "../src/server/kernel/ctx.ts";
import { claimMint, decisionOf, type Witness } from "../src/server/kernel/witness.ts";
import { OPS } from "../src/server/ops/index.ts";
import { invoke } from "../src/server/ops/registry.ts";
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

	test("an excuse held for one target does not excuse another", () => {
		const push = (commit: string) =>
			ciReport({ commit, branch: "feature", pr: 91, n: 1, fail: { 0: "environment unavailable" } });
		report(push("hold0001"));
		report(push("hold0002"));
		expect(decide(open("failure"), { is: "infra" }).status).toBe("decided");
		expect(gate({ commit: "hold0002" }).verdict).toBe("passed");
		expect(gate({ commit: "hold0001" }).verdict).toBe("blocked");
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

describe("what a decision may change", () => {
	test("standing cannot cite a decision that is not in the ledger", () => {
		report(ciReport({ commit: "witness1", n: 1, fail: { 0: "bug" } }));
		const project = findProject(h.app.db, "scratch");
		if (!project) throw new Error("no project");
		const ctx = makeCtx(h.app, project, h.owner, true);
		const signature = first(rows<{ id: number }>("SELECT id FROM signatures")).id;
		const plain = { decision: 999_999, kind: "failure", signers: [h.owner.id], expiresAt: null } as unknown as Witness;
		expect(() => setExcuse(ctx, plain, { signature, scope: "line:trunk", class: "excused", target: null })).toThrow();
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

	test("only the decision machinery can make a witness", () => {
		// A plain object does not type-check as a witness: the class has a private field.
		// @ts-expect-error
		const forged: Witness = { kind: "adopt", signers: [1], expiresAt: null };
		expect(() => decisionOf(forged)).toThrow("not a witness");
		// The mint is handed out once, to the decision machinery, when it loads.
		expect(() => claimMint()).toThrow("already held");
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
		expect(rows("SELECT count(*) AS n FROM tokens WHERE label <> 'test'").length).toBe(1);
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
