// Three producers, one run: planned runs, slots and what may fill them (fixtures E1, E3, E5, E7 in the design).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AnnounceReply, DecideReply, GateStatus, InboxReply, PlanReply, ReportReceipt } from "../src/core/ops.ts";
import { mustTarget } from "../src/server/evidence/evidence.ts";
import { recoverAccepted } from "../src/server/jobs.ts";
import { findProject, makeCtx, stampSeq } from "../src/server/kernel/ctx.ts";
import { Db, declaredSql } from "../src/server/kernel/db.ts";
import { migrate } from "../src/server/kernel/migrate.ts";
import { acceptReport, processBatch } from "../src/server/ops/writes.ts";
import { plannedCounting, runsFor } from "../src/server/runs/runs.ts";
import { exportArchive, importArchive, linesOf } from "../src/server/transfer/transfer.ts";
import { ciReport, type Harness, harness } from "./helpers.ts";

let h: Harness;
afterEach(() => h.close());

type Slot = {
	id: number;
	case: string;
	version: number;
	state: string;
	fills: { by: string; method: string; outcome: string; admitted: string; result: number; atStep: string | null }[];
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
/** Links the automated test `key` to a case by answering the `map` question of a project that asks about tests with no case. */
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
		expect(slots("R-1").map((slot) => slot.fills.map((fill) => fill.atStep))).toEqual([[null], ["x1"], []]);
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

	test("the list of runs holds planned and change runs, newest first, and filters by kind and state", () => {
		h.call("plan", { name: "smoke", select: { cases: ["C-1"] } });
		record("R-1", "C-1", "pass");
		h.call("report", ciReport({ commit: "feat0001", branch: "feature", pr: 7, n: 1 }));
		h.call("plan", { name: "regression", select: { cases: ["C-2"] } });
		type Listed = { ref: string; origin: string; state: string; change: { key: string } | null };
		const listed = (input: Record<string, unknown> = {}) =>
			h
				.call<{ items: Listed[] }>("find", { in: "runs", ...input })
				.items.map((item) => [item.ref, item.origin, item.state, item.change?.key ?? null]);
		expect(listed()).toEqual([
			["R-3", "planned", "open", null],
			["R-2", "change", "open", "pr:7"],
			["R-1", "planned", "closed", null],
		]);
		expect(listed({ origin: "change" })).toEqual([["R-2", "change", "open", "pr:7"]]);
		expect(listed({ origin: "planned", state: "open" })).toEqual([["R-3", "planned", "open", null]]);
		expect(listed({ state: "closed" })).toEqual([["R-1", "planned", "closed", null]]);
		expect(h.raw("find", { in: "runs", state: "change" })).toMatchObject({
			ok: false,
			error: { code: "invalid", message: 'a run is "open" or "closed", not "change"' },
		});
		const page = h.call<{ items: Listed[]; cursor: string | null }>("find", { in: "runs", limit: 2 });
		expect(page.items.map((item) => item.ref)).toEqual(["R-3", "R-2"]);
		const rest = h.call<{ items: Listed[]; cursor: string | null }>("find", {
			in: "runs",
			limit: 2,
			cursor: page.cursor,
		});
		expect([rest.items.map((item) => item.ref), rest.cursor]).toEqual([["R-1"], null]);
	});

	test("the runs of one change are its pushed commits, newest first", () => {
		h.call("report", ciReport({ commit: "feat0001", branch: "feature", pr: 7, n: 1 }));
		h.call("report", ciReport({ commit: "other001", branch: "other", pr: 8, n: 1 }));
		h.call("report", ciReport({ commit: "feat0002", branch: "feature", pr: 7, n: 1, fail: { 0: "broke" } }));
		h.call("plan", { name: "smoke", select: { cases: ["C-1"] } });
		type Listed = { ref: string; name: string; verdict: string; accepts: { commit: string } };
		const of = (change: string) =>
			h
				.call<{ items: Listed[] }>("find", { in: "runs", change })
				.items.map((item) => [item.ref, item.name, item.accepts.commit, item.verdict]);
		expect(of("pr:7")).toEqual([
			["R-3", "feat000 on pr:7", "feat0002", "blocked"],
			["R-1", "feat000 on pr:7", "feat0001", "passed"],
		]);
		expect(of("pr:8")).toEqual([["R-2", "other00 on pr:8", "other001", "passed"]]);
		expect(h.raw("find", { in: "runs", change: "pr:9" })).toMatchObject({
			ok: false,
			error: { code: "not_found", message: "change pr:9 not found" },
		});
	});
});

describe("planned lookups beside change history", () => {
	beforeEach(() => {
		h = harness({ preset: "standard", unlinked: "ask" });
		seed();
		link("tests/a.spec.ts::case one", "C-1", "seed0001");
	});

	test("planned lookups preserve mixed-history membership, processing order and closed horizons", () => {
		const plan = (name: string, commit?: string, caseRef = "C-1") =>
			h.call<PlanReply>("plan", { name, select: { cases: [caseRef] }, ...(commit ? { accepts: { commit } } : {}) });
		plan("first z", "zzzz0001");
		plan("other commit", "aaaa0001");
		plan("typed only");
		const report = (commit: string, job: string) => ({
			target: { commit, branch: "main" },
			job,
			results: [{ test: { key: "tests/a.spec.ts::case one" }, outcome: "pass" as const }],
		});
		h.call("report", report("zzzz0001", "first"));
		plan("second z", "zzzz0001");
		plan("open z", "zzzz0001", "C-2");
		h.call("report", report("aaaa0001", "first"));
		const project = findProject(h.app.db, "scratch");
		if (!project) throw new Error("no project");
		const refs = (ids: number[]) =>
			ids.map(
				(id) => `R-${h.app.db.raw.query<{ no: number }, [number]>("SELECT no FROM runs WHERE id = ?").get(id)?.no}`,
			);
		expect(refs(plannedCounting(h.app.db, project.id, "zzzz0001"))).toEqual(["R-6", "R-2", "R-7"]);
		expect(refs(plannedCounting(h.app.db, project.id, "aaaa0001"))).toEqual(["R-3"]);
		expect(plannedCounting(h.app.db, project.id, "absent01")).toEqual([]);
		const horizons = () =>
			h.app.db.raw
				.query<{ no: number; accepted_seq: number; applied_seq: number; outstanding: number }, []>(
					"SELECT no, accepted_seq, applied_seq, outstanding FROM runs WHERE origin = 'planned' ORDER BY no",
				)
				.all();
		const before = horizons();
		const inTx = <T>(fn: (ctx: ReturnType<typeof makeCtx>) => T): T =>
			h.app.db.transaction(() => {
				const ctx = makeCtx(h.app, project, h.owner, true);
				const result = fn(ctx);
				stampSeq(ctx);
				return result;
			});
		const batch = inTx((ctx) => acceptReport(ctx, report("zzzz0001", "late"))).batch;
		const target = mustTarget(h.app.db, batch.target);
		expect(inTx((ctx) => runsFor(ctx, target, null, h.owner.kind)).map((row) => `R-${row.no}`)).toEqual([
			"R-5",
			"R-6",
			"R-2",
			"R-7",
		]);
		const waiting = horizons();
		for (const no of [2, 6, 7])
			expect(waiting.find((row) => row.no === no)).toEqual({
				no,
				accepted_seq: batch.seq,
				applied_seq: first(before.filter((row) => row.no === no)).applied_seq,
				outstanding: 1,
			});
		for (const no of [3, 4]) expect(waiting.find((row) => row.no === no)).toEqual(before.find((row) => row.no === no));
		inTx((ctx) => processBatch(ctx, batch.id));
		const after = horizons();
		for (const no of [2, 6, 7])
			expect(after.find((row) => row.no === no)).toEqual({
				no,
				accepted_seq: batch.seq,
				applied_seq: batch.seq,
				outstanding: 0,
			});
		for (const no of [3, 4]) expect(after.find((row) => row.no === no)).toEqual(before.find((row) => row.no === no));
		for (const ref of ["R-2", "R-3", "R-6"])
			expect(run(ref)).toMatchObject({ state: "closed", verdict: "passed", tally: { pass: 1, missing: 0 } });
		for (const ref of ["R-4", "R-7"])
			expect(run(ref)).toMatchObject({ state: "open", verdict: "pending", tally: { pass: 0, missing: 1 } });
	});

	test("planned lookups exclude change history in their query plans", () => {
		const queries = declaredSql().filter(
			(text) => text.startsWith("SELECT") && text.includes("FROM runs WHERE project = $project AND origin = 'planned'"),
		);
		expect(queries).toHaveLength(2);
		for (const text of queries) {
			const details = h.app.db.raw
				.query<{ detail: string }, [{ project: number; commit: string }]>(`EXPLAIN QUERY PLAN ${text}`)
				.all({ project: 1, commit: "zzzz0001" })
				.map((row) => row.detail);
			expect(
				details.some((detail) =>
					detail.includes(
						text.startsWith("SELECT id")
							? "USING INDEX runs_planned_commit (project=? AND <expr>=?)"
							: "USING INDEX runs_planned_receiving (project=?)",
					),
				),
				text,
			).toBe(true);
		}
	});
});

describe("a run that accepts a build", () => {
	beforeEach(() => {
		h = harness({ preset: "standard", unlinked: "ask" });
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

	test("E5: late batches supersede a closed commit run's sign-off, including a late failure", () => {
		const planned = h.call<PlanReply>("plan", {
			name: "late evidence",
			select: { cases: ["C-1"] },
			accepts: { commit: "late0001" },
		});
		const report = (outcome: string, job: string, named = false) =>
			h.call<ReportReceipt>("report", {
				...(named ? { run: planned.run } : {}),
				target: { commit: "late0001", branch: "main" },
				job,
				results: [{ test: { key: "tests/a.spec.ts::case one" }, outcome }],
			});
		const signoffs = () => h.call<InboxReply>("inbox", { kind: "signoff", state: "decided" }).items;
		report("pass", "first");
		const original = first(signoffs());
		expect(run(planned.run)).toMatchObject({ state: "closed", verdict: "passed" });

		report("pass", "late", true);
		const replacement = first(signoffs());
		expect(signoffs()).toHaveLength(2);
		expect(replacement.q).not.toBe(original.q);
		expect(
			h.app.db.raw
				.query<{ prior: number; supersedes: number; approval: number }, [number]>(
					`SELECT prior.no AS prior, next.supersedes, ended.supersedes AS approval FROM questions q
			 JOIN questions prior ON prior.id = q.prior JOIN decisions next ON next.id = q.decision
			 JOIN decisions ended ON ended.id = prior.decision WHERE q.no = ?`,
				)
				.all(Number(replacement.q.slice(2))),
		).toEqual([
			{
				prior: Number(original.q.slice(2)),
				supersedes: signoffs().find((q) => q.q === original.q)?.decision?.id ?? -1,
				approval: original.decision?.id ?? -1,
			},
		]);
		expect(replacement.decision?.answer).toEqual({ is: "approve" });
		expect(signoffs().find((q) => q.q === original.q)?.decision?.answer).toEqual({ is: "outdated" });
		expect(run(planned.run)).toMatchObject({ state: "closed", verdict: "passed" });

		report("fail", "late failure");
		const asked = first(h.call<InboxReply>("inbox", { kind: "signoff" }).items);
		expect(signoffs().find((q) => q.q === replacement.q)?.decision?.answer).toEqual({ is: "outdated" });
		expect(asked.evidence).toMatchObject({ verdict: "blocked" });
		expect(run(planned.run)).toMatchObject({ state: "open", verdict: "blocked" });
		expect(first(slots(planned.run)).state).toBe("failing");
		expect(
			first(h.call<DecideReply[]>("decide", { q: asked.q, onEvidence: asked.evidenceHash, answer: { is: "approve" } })),
		).toMatchObject({ status: "conflict", decision: null });
	});

	test("a strict commit run asks a person again after a late pass, and an older approval cannot reopen it", () => {
		h.call("propose", { edits: [{ op: "policy", preset: "strict" }] });
		const policy = first(h.call<InboxReply>("inbox", { kind: "adopt" }).items);
		h.call("decide", {
			q: policy.q,
			onEvidence: policy.evidenceHash,
			answer: { is: "accept" },
			reason: "require sign-off",
		});
		const planned = h.call<PlanReply>("plan", {
			name: "human sign-off",
			select: { cases: ["C-1"] },
			accepts: { commit: "late0003" },
		});
		const approve = (q: InboxReply["items"][number]) =>
			first(
				h.call<DecideReply[]>("decide", {
					q: q.q,
					onEvidence: q.evidenceHash,
					answer: { is: "approve" },
					reason: "checked the evidence",
				}),
			);
		record(planned.run, "C-1", "pass");
		const original = first(h.call<InboxReply>("inbox", { kind: "signoff" }).items);
		expect(approve(original).status).toBe("decided");
		expect(run(planned.run).state).toBe("closed");
		const lateInput = {
			cmd: "late-human-pass",
			run: planned.run,
			results: [{ test: { case: "C-1" }, outcome: "pass" }],
		};
		const late = h.call<ReportReceipt>("report", lateInput);
		const asked = first(h.call<InboxReply>("inbox", { kind: "signoff" }).items);
		expect(asked.q).not.toBe(original.q);
		expect(asked.evidence).toMatchObject({ verdict: "passed" });
		expect(run(planned.run)).toMatchObject({ state: "open", verdict: "passed" });
		expect(approve(asked).status).toBe("decided");
		h.call("decide", { undo: original.q, reason: "withdraw the older approval" });
		expect(run(planned.run)).toMatchObject({ state: "closed", verdict: "passed" });
		const retried = h.call<ReportReceipt>("report", lateInput);
		expect(retried).toEqual(late);
		expect(run(planned.run)).toMatchObject({ state: "closed", verdict: "passed" });
	});

	for (const preset of ["standard", "strict"] as const) {
		for (const reportKind of [
			"other repository",
			"other environment",
			"unrelated case",
			"unqualified result",
		] as const) {
			test(`${preset}: a closed run keeps its approval after a report for ${reportKind}`, () => {
				if (preset === "strict") {
					h.call("propose", { edits: [{ op: "policy", preset }] });
					const policy = first(h.call<InboxReply>("inbox", { kind: "adopt" }).items);
					h.call("decide", {
						q: policy.q,
						onEvidence: policy.evidenceHash,
						answer: { is: "accept" },
						reason: "require sign-off",
					});
				}
				const target = { commit: "same0001", repo: "acme/app", env: "prod" };
				const planned = h.call<PlanReply>("plan", {
					name: "only counted evidence",
					select: { cases: ["C-2"] },
					accepts: target,
					require: [{ id: "exercise", kind: "exercise", methods: ["human"], minActors: 1, basis: "exact" }],
				});
				record(planned.run, "C-2", "pass");
				if (preset === "strict") {
					const signoff = first(h.call<InboxReply>("inbox", { kind: "signoff" }).items);
					h.call("decide", {
						q: signoff.q,
						onEvidence: signoff.evidenceHash,
						answer: { is: "approve" },
						reason: "checked",
					});
				}
				const signoffs = () => h.call<InboxReply>("inbox", { kind: "signoff", state: "decided" }).items;
				const original = signoffs();
				const horizon = () =>
					h.app.db.raw
						.query<{ applied_seq: number; outstanding: number }, [number]>(
							"SELECT applied_seq, outstanding FROM runs WHERE no = ?",
						)
						.get(Number(planned.run.slice(2)));
				const before = horizon();
				expect(run(planned.run)).toMatchObject({ state: "closed", verdict: "passed" });
				expect(first(original).decision?.answer).toEqual({ is: "approve" });
				const receipt = h.call<ReportReceipt>("report", {
					target: {
						...target,
						...(reportKind === "other repository" ? { repo: "acme/other" } : {}),
						...(reportKind === "other environment" ? { env: "staging" } : {}),
					},
					job: "unrelated",
					results: [
						{
							test: { key: "tests/z.spec.ts::unrelated" },
							outcome: "pass",
							...(reportKind === "unqualified result" ? { annotation: { case: "C-2", version: 1 } } : {}),
							...(reportKind === "unrelated case" ? { annotation: { case: "C-3", version: 1 } } : {}),
						},
					],
				});
				if (reportKind === "unqualified result" || reportKind === "unrelated case")
					expect(receipt.basis).toEqual({ exact: 1, assumed: 0, unresolved: 0 });
				expect(run(planned.run)).toMatchObject({ state: "closed", verdict: "passed", tally: { pass: 1, missing: 0 } });
				expect(signoffs()).toEqual(original);
				expect(h.call<InboxReply>("inbox", { kind: "signoff" }).items).toEqual([]);
				expect(horizon()).toEqual(before);
				expect(h.call<GateStatus>("gate", { run: planned.run })).toMatchObject({ verdict: "passed", stale: false });
			});
		}
	}

	test("a never-closed strict run dissolves a repeated sign-off when a failure arrives", () => {
		h.call("propose", { edits: [{ op: "policy", preset: "strict" }] });
		const policy = first(h.call<InboxReply>("inbox", { kind: "adopt" }).items);
		h.call("decide", {
			q: policy.q,
			onEvidence: policy.evidenceHash,
			answer: { is: "accept" },
			reason: "require sign-off",
		});
		const planned = h.call<PlanReply>("plan", {
			name: "never approved",
			select: { cases: ["C-1", "C-2"] },
			accepts: { commit: "never001" },
		});
		record(planned.run, "C-1", "pass");
		record(planned.run, "C-2", "pass");
		const original = first(h.call<InboxReply>("inbox", { kind: "signoff" }).items);
		h.call("decide", { q: original.q, onEvidence: original.evidenceHash, answer: { is: "reject" }, reason: "not yet" });
		record(planned.run, "C-1", "pass");
		const repeated = first(h.call<InboxReply>("inbox", { kind: "signoff" }).items);
		expect(repeated.q).not.toBe(original.q);
		expect(repeated.evidence).toMatchObject({ verdict: "passed" });
		record(planned.run, "C-2", "fail", { failure: { message: "new failure" } });
		expect(run(planned.run)).toMatchObject({ state: "open", verdict: "blocked" });
		expect(h.call<InboxReply>("inbox", { kind: "signoff" }).items).toEqual([]);
		expect(
			h.app.db.raw
				.query<{ state: string }, [number]>("SELECT state FROM questions WHERE no = ?")
				.get(Number(repeated.q.slice(2))),
		).toEqual({ state: "dissolved" });
		expect(first(h.call<InboxReply>("inbox", { kind: "failure" }).items).title).toBe("new failure");
	});

	test.each([false, true])("E5: a closed run waits for both accepted batches, reversed processing: %s", (reverse) => {
		const planned = h.call<PlanReply>("plan", {
			name: "two late batches",
			select: { cases: ["C-1"] },
			accepts: { commit: "late0002" },
		});
		const input = (attempt: number) => ({
			run: planned.run,
			target: { commit: "late0002", branch: "main" },
			job: "tests",
			attempt,
			results: [{ test: { key: "tests/a.spec.ts::case one" }, outcome: "pass" as const }],
		});
		h.call("report", input(1));
		const original = first(h.call<InboxReply>("inbox", { state: "decided", kind: "signoff" }).items);
		const inTx = <T>(fn: (ctx: ReturnType<typeof makeCtx>) => T): T =>
			h.app.db.transaction(() => {
				const project = findProject(h.app.db, "scratch");
				if (!project) throw new Error("no project");
				const ctx = makeCtx(h.app, project, h.owner, true);
				const result = fn(ctx);
				stampSeq(ctx);
				return result;
			});
		const batches = [2, 3].map((attempt) => inTx((ctx) => acceptReport(ctx, input(attempt))).batch);
		if (reverse) batches.reverse();
		expect(h.call<GateStatus>("gate", { run: planned.run })).toMatchObject({
			verdict: "pending",
			stale: true,
			reason: "pending: 2 reports accepted and not yet applied",
		});
		inTx((ctx) => processBatch(ctx, first(batches).id));
		expect(h.call<GateStatus>("gate", { run: planned.run })).toMatchObject({
			verdict: "pending",
			reason: "pending: 1 report accepted and not yet applied",
		});
		expect(first(h.call<InboxReply>("inbox", { state: "decided", kind: "signoff" }).items).q).toBe(original.q);
		inTx((ctx) => processBatch(ctx, first(batches.slice(1)).id));
		expect(h.call<GateStatus>("gate", { run: planned.run })).toMatchObject({ verdict: "passed", stale: false });
		expect(run(planned.run).state).toBe("closed");
		const signoffs = h.call<InboxReply>("inbox", { state: "decided", kind: "signoff" }).items;
		expect(signoffs).toHaveLength(2);
		expect(first(signoffs).decision?.answer).toEqual({ is: "approve" });
		expect(signoffs.find((q) => q.q === original.q)?.decision?.answer).toEqual({ is: "outdated" });
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

describe("deploy announcements and release runs", () => {
	const digest = `sha256:${"a".repeat(64)}`;
	const code = [{ repo: "acme/web", commit: "1".repeat(40) }];
	beforeEach(() => {
		h = harness();
		seed(1);
	});

	test("a pipeline binds a build to attested code and records each deployment; a command retry writes nothing", () => {
		const ci = h.actor("deploy", "ci", ["record"]);
		const input = { deploy: "1.4-rc3", env: "staging", digest, code, cmd: "deploy-rc3-1" };
		const announced = h.call<AnnounceReply>("announce", input, ci);
		expect(announced).toMatchObject({ build: "1.4-rc3", digest, env: "staging", code, by: "deploy" });
		expect(h.call<AnnounceReply>("announce", input, ci)).toEqual(announced);
		h.call("announce", { deploy: "1.4-rc3", env: "production" }, ci);
		const deployments = h.call<{ items: { env: string; build: string }[] }>("find", { in: "deployments" });
		expect(deployments.items.map(({ env, build }) => [env, build])).toEqual([
			["production", "1.4-rc3"],
			["staging", "1.4-rc3"],
		]);
		const page = h.call<{ items: { env: string }[]; cursor: string }>("find", { in: "deployments", limit: 1 });
		expect(page.items.map((event) => event.env)).toEqual(["production"]);
		expect(
			h.call<{ items: { env: string }[]; cursor: null }>("find", { in: "deployments", cursor: page.cursor, limit: 1 }),
		).toMatchObject({ items: [{ env: "staging" }], cursor: null });
		expect(
			h.raw("announce", { deploy: "1.4-rc3", env: "staging", digest: `sha256:${"b".repeat(64)}`, code }, ci),
		).toMatchObject({ ok: false, error: { code: "conflict" } });
		expect(
			h.raw(
				"announce",
				{ deploy: "alias", env: "staging", digest, code: [{ ...code[0], commit: "2".repeat(40) }] },
				ci,
			),
		).toMatchObject({ ok: false, error: { code: "conflict" } });
		expect(h.call<{ items: unknown[] }>("find", { in: "deployments" }).items.length).toBe(2);
	});

	test("only pipelines and admins attest artifacts; an unknown build or incomplete attestation is refused", () => {
		const member = h.actor("tester", "human", ["record"]);
		const agent = h.actor("reviewer", "agent", ["record", "produce"]);
		for (const actor of [member, agent]) {
			expect(h.raw("announce", { deploy: "rc3", env: "staging", digest, code }, actor)).toMatchObject({
				ok: false,
				error: { code: "forbidden" },
			});
		}
		expect(h.raw("announce", { deploy: "unknown", env: "staging" })).toMatchObject({
			ok: false,
			error: { code: "invalid" },
		});
		expect(h.raw("announce", { deploy: "rc3", env: "staging", digest })).toMatchObject({
			ok: false,
			error: { code: "invalid" },
		});
		expect(h.raw("plan", { name: "release", select: { cases: ["C-1"] }, accepts: { build: "unknown" } })).toMatchObject(
			{ ok: false, error: { code: "not_found" } },
		);
	});

	test.each(["report", "plan"] as const)("P1: %s refuses an environment the build was never deployed to", (op) => {
		h.call("announce", { deploy: "rc3", env: "staging", digest, code });
		const target = { build: "rc3", env: "prodution" };
		const reply =
			op === "report"
				? h.raw("report", { target, results: [{ test: { case: "C-1" }, outcome: "pass" }] })
				: h.raw("plan", { name: "Typo release", select: { cases: ["C-1"] }, accepts: target });
		expect(reply).toMatchObject({
			ok: false,
			error: {
				code: "invalid",
				message: 'build rc3 has not been deployed to "prodution"; deployed environments: "staging"',
			},
		});
		expect(h.call<{ items: unknown[] }>("find", { in: "runs" }).items).toEqual([]);
		const planned = h.call<PlanReply>("plan", {
			name: "Staging",
			select: { cases: ["C-1"] },
			accepts: { build: "rc3", env: "staging" },
		});
		expect(planned).toMatchObject({ run: "R-1", already: 0 });
		expect(h.call<GateStatus>("gate", { run: planned.run }).verdict).toBe("pending");
		h.call("announce", { deploy: "rc3", env: "prodution" });
		const later = h.call<PlanReply>("plan", { name: "Later deployment", select: { cases: ["C-1"] }, accepts: target });
		expect(later.already).toBe(0);
		h.call("report", { target, results: [{ test: { case: "C-1" }, outcome: "pass" }] });
		expect(h.call<GateStatus>("gate", { run: later.run }).verdict).toBe("passed");
	});

	test("a later deployment can count earlier results for the same artifact under another label", () => {
		h.call("announce", { deploy: "rc3", env: "staging", digest, code });
		h.call("announce", { deploy: "alias", env: "production", digest, code });
		h.call("report", {
			target: { build: "alias", env: "production" },
			results: [{ test: { case: "C-1" }, outcome: "pass" }],
		});
		const plan = { name: "Production", select: { cases: ["C-1"] }, accepts: { build: "rc3", env: "production" } };
		expect(h.raw("plan", plan)).toMatchObject({ ok: false, error: { code: "invalid" } });
		h.call("announce", { deploy: "rc3", env: "production" });
		const planned = h.call<PlanReply>("plan", plan);
		expect(planned.already).toBe(1);
		expect(h.call<GateStatus>("gate", { run: planned.run }).verdict).toBe("passed");
	});

	test("release slots count the exact artifact and environment, including earlier evidence, and gate by run", () => {
		h.call("announce", { deploy: "rc3", env: "staging", digest, code });
		h.call("announce", { deploy: "rc3", env: "production" });
		const planned = h.call<PlanReply>("plan", {
			name: "Release smoke",
			select: { cases: ["C-1"] },
			accepts: { build: "rc3", env: "staging" },
		});
		const ci = h.actor("tests", "ci", ["record"]);
		// A pass on the attested commit proves no execution of the artifact.
		h.call(
			"report",
			{
				target: { ...code[0], branch: "main" },
				results: [{ test: { key: "checkout" }, annotation: { case: "C-1", version: 1 }, outcome: "pass" }],
			},
			ci,
		);
		h.call("report", {
			target: { build: "rc3", env: "production" },
			results: [{ test: { case: "C-1" }, outcome: "pass" }],
		});
		expect(h.call<GateStatus>("gate", { run: planned.run })).toMatchObject({
			verdict: "pending",
			tally: { missing: 1 },
		});
		// Recording by run alone must use its artifact, never a session or the attested commit.
		h.call("report", { run: planned.run, results: [{ test: { case: "C-1" }, outcome: "pass" }] });
		expect(h.call<GateStatus>("gate", { run: planned.run })).toMatchObject({
			verdict: "passed",
			tally: { pass: 1, missing: 0 },
		});
		h.call("announce", { deploy: "same-artifact", env: "staging", digest, code });
		const reuse = h.call<PlanReply>("plan", {
			name: "Same artifact",
			select: { cases: ["C-1"] },
			accepts: { build: "same-artifact", env: "staging" },
		});
		expect(reuse.already).toBe(1);
		expect(h.call<GateStatus>("gate", { run: reuse.run }).verdict).toBe("passed");
		const other = h.call<PlanReply>("plan", {
			name: "Production",
			select: { cases: ["C-1"] },
			accepts: { build: "rc3", env: "production" },
		});
		expect(other.already).toBe(1);
	});

	test("a release planned during an accepted upload stays pending, then counts the recovered failure", () => {
		h.call("announce", { deploy: "rc3", env: "staging", digest, code });
		const ci = h.actor("tests", "ci", ["record"]);
		const target = { build: "rc3", env: "staging" };
		const result = { test: { key: "checkout" }, annotation: { case: "C-1", version: 1 } };
		h.call("report", { target, results: [{ ...result, outcome: "pass" }] }, ci);
		const project = findProject(h.app.db, "scratch");
		if (!project) throw new Error("no project");
		h.app.db.transaction(() => {
			const ctx = makeCtx(h.app, project, ci, true);
			acceptReport(ctx, {
				target,
				attempt: 2,
				results: [{ ...result, outcome: "fail", failure: { message: "artifact smoke failed" } }],
			});
			stampSeq(ctx);
		});
		const planned = h.call<PlanReply>("plan", {
			name: "Release during upload",
			select: { cases: ["C-1"] },
			accepts: target,
		});
		expect(h.call<GateStatus>("gate", { run: planned.run })).toMatchObject({
			verdict: "pending",
			reason: "pending: 1 report accepted and not yet applied",
		});
		expect(run(planned.run).state).toBe("open");
		recoverAccepted(h.app);
		expect(h.call<GateStatus>("gate", { run: planned.run })).toMatchObject({
			verdict: "blocked",
			tally: { unexplained: 1 },
		});
		const failure = first(h.call<InboxReply>("inbox", { kind: "failure", on: planned.run }).items);
		h.call("decide", { q: failure.q, onEvidence: failure.evidenceHash, answer: { is: "defect" } });
		expect(h.call<GateStatus>("gate", { run: planned.run }).verdict).toBe("failed");
	});

	test("release jobs must report on the artifact in the selected environment", () => {
		h.call("announce", { deploy: "rc3", env: "staging", digest, code });
		h.call("announce", { deploy: "rc3", env: "production" });
		const planned = h.call<PlanReply>("plan", {
			name: "Release jobs",
			select: { cases: ["C-1"] },
			accepts: { build: "rc3", env: "staging" },
			require: [
				{ id: "exercise", kind: "exercise", methods: ["human", "auto"], minActors: 1, basis: "exact" },
				{ id: "ci", kind: "jobs", jobs: ["smoke"] },
			],
		});
		h.call("report", { run: planned.run, results: [{ test: { case: "C-1" }, outcome: "pass" }] });
		const ci = h.actor("smoke", "ci", ["record"]);
		const results = [{ test: { key: "health" }, outcome: "pass" }];
		h.call("report", { target: { build: "rc3", env: "production" }, job: "smoke", results }, ci);
		expect(h.call<GateStatus>("gate", { run: planned.run })).toMatchObject({
			verdict: "pending",
			tally: { pass: 1, missing: 1 },
		});
		h.call("report", { target: { build: "rc3", env: "staging" }, job: "smoke", results }, ci);
		expect(h.call<GateStatus>("gate", { run: planned.run })).toMatchObject({
			verdict: "passed",
			tally: { missing: 0 },
		});
	});

	test("forgetting an announcer removes its display name from saved replies and resolves provenance by id", () => {
		const ci = h.actor("retired-deployer", "ci", ["record"]);
		h.call("announce", { deploy: "rc3", env: "staging", digest, code, cmd: "forgotten-deploy-1" }, ci);
		const forgotten = h.call<{ forgotten: string }>("admin", { do: "actor.forget", name: "retired-deployer" });
		const saved = h.app.db.raw
			.query<{ outcome: string }, []>("SELECT outcome FROM commands WHERE id = 'forgotten-deploy-1'")
			.get();
		expect(JSON.parse(saved?.outcome ?? "{}")).toMatchObject({ by: forgotten.forgotten });
		expect(h.call<{ items: unknown[] }>("find", { in: "deployments" }).items).toMatchObject([
			{ by: forgotten.forgotten, attestation: { by: forgotten.forgotten } },
		]);
	});

	test("an archive preserves the immutable build, its attestation and deployment history", () => {
		h.call("announce", { deploy: "rc3", env: "staging", digest, code });
		h.call("announce", { deploy: "rc3", env: "production" });
		const chunks: string[] = [];
		exportArchive(h.app.db, (chunk) => chunks.push(chunk));
		const restored = new Db(":memory:");
		try {
			migrate(restored, ":memory:");
			importArchive(restored, linesOf(chunks.join("")));
			expect(
				restored.raw
					.query(
						"SELECT b.label, a.digest, a.code, d.env FROM deployments d JOIN builds b ON b.id = d.build JOIN artifacts a ON a.id = b.artifact ORDER BY d.id",
					)
					.all(),
			).toEqual([
				{ label: "rc3", digest, code: JSON.stringify(code), env: "staging" },
				{ label: "rc3", digest, code: JSON.stringify(code), env: "production" },
			]);
		} finally {
			restored.close();
		}
	});
});

describe("a person's refusal of a rule's answer", () => {
	beforeEach(() => {
		h = harness();
		seed(1);
	});

	test("holds however many questions the rule was not asked in between", () => {
		const planned = h.call<PlanReply>("plan", {
			name: "refused",
			select: { cases: ["C-1"] },
			accepts: { commit: "refuse01" },
		});
		const report = (attempt: number, outcome: "pass" | "fail") =>
			h.call("report", {
				run: planned.run,
				target: { commit: "refuse01", branch: "main" },
				job: "tests",
				attempt,
				results: [
					{
						test: { key: "tests/a.spec.ts::case one" },
						outcome,
						annotation: { case: "C-1", version: 1 },
						...(outcome === "fail" ? { failure: { message: `failed at attempt ${attempt}` } } : {}),
					},
				],
			});
		report(1, "pass");
		const approved = first(h.call<InboxReply>("inbox", { state: "decided", kind: "signoff" }).items);
		h.call("decide", { undo: approved.q, reason: "withdraw the automatic approval" });
		const asked = first(h.call<InboxReply>("inbox", { kind: "signoff" }).items);
		h.call("decide", { q: asked.q, onEvidence: asked.evidenceHash, answer: { is: "reject" }, reason: "not yet" });
		// The walk back through earlier questions stopped after 100 (issue #369): the rule approved at cycle 101.
		for (let cycle = 1; cycle <= 101; cycle++) {
			report(2 * cycle, "fail");
			report(2 * cycle + 1, "pass");
		}
		expect(run(planned.run).state).toBe("open");
		const decided = h.call<InboxReply>("inbox", { state: "decided", kind: "signoff" }).items;
		expect(decided.map((q) => q.decision?.answer)).not.toContainEqual({ is: "approve" });
		expect(first(h.call<InboxReply>("inbox", { kind: "signoff" }).items).evidence).toMatchObject({ verdict: "passed" });
	}, 30_000);
});
