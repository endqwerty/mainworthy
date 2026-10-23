// Three producers, one run: planned runs, slots and what may fill them (fixtures E1, E3, E5, E7 in the design).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AnnounceReply, DecideReply, GateStatus, InboxReply, PlanReply, ReportReceipt } from "../src/core/ops.ts";
import { mustTarget, uncorrectedResults } from "../src/server/evidence/evidence.ts";
import { findProject, makeCtx, stampSeq } from "../src/server/kernel/ctx.ts";
import { Db, declaredSql } from "../src/server/kernel/db.ts";
import { migrate } from "../src/server/kernel/migrate.ts";
import { recoverAccepted } from "../src/server/ops/jobs.ts";
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

const seed = async (n = 3) =>
	await h.call("propose", {
		edits: Array.from({ length: n }, (_, i) => ({
			op: "create",
			outline: `Case ${i + 1}\n  Do thing ${i + 1} > It works`,
			folder: "checkout",
			tags: ["regression"],
		})),
	});
const run = async (ref: string) => {
	const view = (await h.call<RunView[]>("get", { refs: [ref] }))[0];
	if (!view) throw new Error("no run");
	return view;
};
const slots = async (ref: string) => (await h.call<{ items: Slot[] }>("find", { in: "slots", run: ref })).items;
const record = async (
	runRef: string,
	caseRef: string,
	outcome: string,
	extra: Record<string, unknown> = {},
	as = h.owner,
) =>
	await h.call<ReportReceipt>("report", { run: runRef, results: [{ test: { case: caseRef }, outcome, ...extra }] }, as);
const queue = async () => await h.call<InboxReply>("inbox");
const first = <T>(items: T[]): T => {
	const item = items[0];
	if (item === undefined) throw new Error("expected at least one item");
	return item;
};
/** Links the automated test `key` to a case by answering the `map` question of a project that asks about tests with no case. */
async function link(key: string, caseRef: string, commit: string) {
	await h.call("report", {
		target: { commit, branch: "main" },
		results: [{ test: { key, file: key.split("::")[0] }, outcome: "pass" }],
	});
	const map = first((await h.call<InboxReply>("inbox", { kind: "map" })).items);
	const test = first((map.evidence as { tests: { t: string }[] }).tests).t;
	await h.call("decide", { q: map.q, onEvidence: map.evidenceHash, answer: { is: "link", pairs: [[test, caseRef]] } });
}

describe("a run typed by hand", () => {
	beforeEach(async () => {
		h = await harness();
		await seed();
	});

	test("pins each case's version, starts pending, and closes by a recorded rule once every slot passes", async () => {
		const planned = await h.call<PlanReply>("plan", {
			name: "1.4.0 rc3 regression",
			select: { folders: ["checkout"], tags: ["regression"] },
		});
		expect(planned).toEqual({ run: "R-1", slots: 3, already: 0 });
		expect(await run("R-1")).toMatchObject({ state: "open", verdict: "pending", reason: "pending: 3 results missing" });

		const receipt = await record("R-1", "C-1", "pass");
		expect(receipt.basis).toEqual({ exact: 1, assumed: 0, unresolved: 0 }); // the slot pinned the version
		await record("R-1", "C-2", "pass");
		expect((await run("R-1")).tally).toMatchObject({ pass: 2, missing: 1 });
		await record("R-1", "C-3", "pass");

		expect(await run("R-1")).toMatchObject({ state: "closed", verdict: "passed" });
		const ledger = await h.call<InboxReply>("inbox", { state: "decided", kind: "signoff" });
		expect(first(ledger.items).decision).toMatchObject({
			answer: { is: "approve" },
			rule: "signoff-passed",
			by: ["policy"],
		});
	});

	test("planning repeated case names makes one slot per case in first-appearance order", async () => {
		const planned = await h.call<PlanReply>("plan", { name: "Repeated case", select: { cases: ["C-2", "C-2"] } });
		expect(planned).toEqual({ run: "R-1", slots: 1, already: 0 });
		expect((await slots(planned.run)).map((slot) => slot.case)).toEqual(["C-2"]);

		const ordered = await h.call<PlanReply>("plan", {
			name: "Repeated references",
			select: { cases: ["C-2", "C-1", "C-2", "2", "C-3", "C-1"] },
		});
		expect(ordered).toEqual({ run: "R-2", slots: 3, already: 0 });
		expect((await slots(ordered.run)).map((slot) => slot.case)).toEqual(["C-2", "C-1", "C-3"]);
	});

	test("previewing repeated case names counts each case once in first-appearance order", async () => {
		expect(await h.call("find", { in: "cases", select: { cases: ["C-2", "C-2"] } })).toMatchObject({
			count: 1,
			items: [{ ref: "C-2" }],
			cursor: null,
		});
		const select = { cases: ["C-2", "C-1", "C-2", "2", "C-3", "C-1"] };
		expect(await h.call("find", { in: "cases", select, limit: 2 })).toMatchObject({
			count: 3,
			items: [{ ref: "C-2" }, { ref: "C-1" }],
			cursor: "2",
		});
		expect(await h.call("find", { in: "cases", select, limit: 2, cursor: "2" })).toMatchObject({
			count: 3,
			items: [{ ref: "C-3" }],
			cursor: null,
		});
	});

	test("a failure opens a question in the run's own scope; the run is blocked until it is answered", async () => {
		await h.call("plan", { name: "smoke", select: { folders: ["checkout"] } });
		await record("R-1", "C-1", "pass");
		await record("R-1", "C-2", "fail", {
			note: "Total shows $100.00 after SAVE10",
			steps: [{ step: "x1", outcome: "fail" }],
		});
		expect(await run("R-1")).toMatchObject({ verdict: "blocked" });
		expect((await slots("R-1")).map((slot) => slot.fills.map((fill) => fill.atStep))).toEqual([[null], ["x1"], []]);
		const q = first((await queue()).items);
		expect(q).toMatchObject({ kind: "failure", producer: "human", title: "Total shows $100.00 after SAVE10" });
		expect(q.blocks).toEqual(["R-1"]);
		await h.call("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "defect", ref: "WEB-301" } });
		expect(await run("R-1")).toMatchObject({ verdict: "failed" });
	});

	test("recording again replaces your own earlier result for that case; both stay in the history", async () => {
		await h.call("plan", { name: "smoke", select: { cases: ["C-1"] } });
		const failed = await record("R-1", "C-1", "fail", { note: "wrong total" });
		expect(first(await slots("R-1")).state).toBe("failing");
		await record("R-1", "C-1", "pass", { corrects: first(failed.results) });
		expect(first(await slots("R-1")).state).toBe("satisfied");
		expect(await run("R-1")).toMatchObject({ verdict: "passed", state: "closed" });
		expect(h.app.db.raw.query<{ n: number }, []>("SELECT count(*) AS n FROM results").get()?.n).toBe(2);
	});

	test("blocked and skipped are not proof: the run stays pending", async () => {
		await h.call("plan", { name: "smoke", select: { cases: ["C-1", "C-2"] } });
		await record("R-1", "C-1", "pass");
		await record("R-1", "C-2", "blocked", { note: "env down" });
		expect(await run("R-1")).toMatchObject({ verdict: "pending", state: "open" });
		expect((await run("R-1")).tally).toMatchObject({ pass: 1, missing: 1, skipped: 1 });
	});

	test("E7: a case edited or moved after the run started keeps its slot and its pinned version", async () => {
		await h.call("plan", { name: "smoke", select: { cases: ["C-1"] } });
		await h.call("propose", {
			edits: [
				{ op: "edit", case: "C-1", base: 1, body: { title: "Renamed" } },
				{ op: "place", cases: ["C-1"], folder: "elsewhere" },
			],
		});
		expect(first(await slots("R-1"))).toMatchObject({ case: "C-1", version: 1 });
		const receipt = await record("R-1", "C-1", "pass");
		expect(receipt.basis.exact).toBe(1);
		expect(h.app.db.raw.query<{ v: number }, []>("SELECT basis_version AS v FROM results").get()?.v).toBe(1);
	});

	test("a closed run takes no more results until its sign-off is withdrawn", async () => {
		await h.call("plan", { name: "smoke", select: { cases: ["C-1"] } });
		await record("R-1", "C-1", "pass");
		const refused = await h.raw("report", { run: "R-1", results: [{ test: { case: "C-1" }, outcome: "fail" }] });
		expect(refused).toMatchObject({ ok: false, error: { code: "conflict" } });
		const signoff = first((await h.call<InboxReply>("inbox", { state: "decided", kind: "signoff" })).items);
		expect((await h.call<{ status: string }[]>("decide", { undo: signoff.q }))[0]?.status).toBe("reopened");
		expect((await run("R-1")).state).toBe("open");
	});

	test("the list of runs holds planned and change runs, newest first, and filters by kind and state", async () => {
		await h.call("plan", { name: "smoke", select: { cases: ["C-1"] } });
		await record("R-1", "C-1", "pass");
		await h.call("report", ciReport({ commit: "feat0001", branch: "feature", pr: 7, n: 1 }));
		await h.call("plan", { name: "regression", select: { cases: ["C-2"] } });
		type Listed = { ref: string; origin: string; state: string; change: { key: string } | null };
		const listed = async (input: Record<string, unknown> = {}) =>
			(await h.call<{ items: Listed[] }>("find", { in: "runs", ...input })).items.map((item) => [
				item.ref,
				item.origin,
				item.state,
				item.change?.key ?? null,
			]);
		expect(await listed()).toEqual([
			["R-3", "planned", "open", null],
			["R-2", "change", "open", "pr:7"],
			["R-1", "planned", "closed", null],
		]);
		expect(await listed({ origin: "change" })).toEqual([["R-2", "change", "open", "pr:7"]]);
		expect(await listed({ origin: "planned", state: "open" })).toEqual([["R-3", "planned", "open", null]]);
		expect(await listed({ state: "closed" })).toEqual([["R-1", "planned", "closed", null]]);
		expect(await h.raw("find", { in: "runs", state: "change" })).toMatchObject({
			ok: false,
			error: { code: "invalid", message: 'a run is "open" or "closed", not "change"' },
		});
		const page = await h.call<{ items: Listed[]; cursor: string | null }>("find", { in: "runs", limit: 2 });
		expect(page.items.map((item) => item.ref)).toEqual(["R-3", "R-2"]);
		const rest = await h.call<{ items: Listed[]; cursor: string | null }>("find", {
			in: "runs",
			limit: 2,
			cursor: page.cursor,
		});
		expect([rest.items.map((item) => item.ref), rest.cursor]).toEqual([["R-1"], null]);
	});

	test("the runs of one change are its pushed commits, newest first", async () => {
		await h.call("report", ciReport({ commit: "feat0001", branch: "feature", pr: 7, n: 1 }));
		await h.call("report", ciReport({ commit: "other001", branch: "other", pr: 8, n: 1 }));
		await h.call("report", ciReport({ commit: "feat0002", branch: "feature", pr: 7, n: 1, fail: { 0: "broke" } }));
		await h.call("plan", { name: "smoke", select: { cases: ["C-1"] } });
		type Listed = { ref: string; name: string; verdict: string; accepts: { commit: string } };
		const of = async (change: string) =>
			(await h.call<{ items: Listed[] }>("find", { in: "runs", change })).items.map((item) => [
				item.ref,
				item.name,
				item.accepts.commit,
				item.verdict,
			]);
		expect(await of("pr:7")).toEqual([
			["R-3", "feat000 on pr:7", "feat0002", "blocked"],
			["R-1", "feat000 on pr:7", "feat0001", "passed"],
		]);
		expect(await of("pr:8")).toEqual([["R-2", "other00 on pr:8", "other001", "passed"]]);
		expect(await h.raw("find", { in: "runs", change: "pr:9" })).toMatchObject({
			ok: false,
			error: { code: "not_found", message: "change pr:9 not found" },
		});
	});
});

describe("planned lookups beside change history", () => {
	beforeEach(async () => {
		h = await harness({ preset: "standard", unlinked: "ask" });
		await seed();
		await link("tests/a.spec.ts::case one", "C-1", "seed0001");
	});

	test("planned lookups preserve mixed-history membership, processing order and closed horizons", async () => {
		const plan = async (name: string, commit?: string, caseRef = "C-1") =>
			await h.call<PlanReply>("plan", {
				name,
				select: { cases: [caseRef] },
				...(commit ? { accepts: { commit } } : {}),
			});
		await plan("first z", "zzzz0001");
		await plan("other commit", "aaaa0001");
		await plan("typed only");
		const report = (commit: string, job: string) => ({
			target: { commit, branch: "main" },
			job,
			results: [{ test: { key: "tests/a.spec.ts::case one" }, outcome: "pass" as const }],
		});
		await h.call("report", report("zzzz0001", "first"));
		await plan("second z", "zzzz0001");
		await plan("open z", "zzzz0001", "C-2");
		await h.call("report", report("aaaa0001", "first"));
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
			expect(await run(ref)).toMatchObject({ state: "closed", verdict: "passed", tally: { pass: 1, missing: 0 } });
		for (const ref of ["R-4", "R-7"])
			expect(await run(ref)).toMatchObject({ state: "open", verdict: "pending", tally: { pass: 0, missing: 1 } });
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

	test("checking one result for corrections uses its index without a temporary index", () => {
		const query = `SELECT count(*) FROM results r WHERE ${uncorrectedResults("r.id")}`;
		const details = h.app.db.raw
			.query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${query}`)
			.all()
			.map((row) => row.detail);
		expect(details).toContain("SEARCH correction USING COVERING INDEX results_corrects (corrects=?)");
		const opcodes = h.app.db.raw
			.query<{ opcode: string }, []>(`EXPLAIN ${query}`)
			.all()
			.map((row) => row.opcode);
		expect(opcodes).not.toContain("OpenEphemeral");
	});
});

describe("a run that accepts a build", () => {
	beforeEach(async () => {
		h = await harness({ preset: "standard", unlinked: "ask" });
		await seed();
		await link("tests/a.spec.ts::case one", "C-1", "seed0001");
	});

	test("results a pipeline already reported on that commit fill the slots, so nobody repeats them by hand", async () => {
		await h.call("report", {
			target: { commit: "rc300001", branch: "main" },
			results: [{ test: { key: "tests/a.spec.ts::case one" }, outcome: "pass" }],
		});
		const planned = await h.call<PlanReply>("plan", {
			name: "rc3",
			select: { folders: ["checkout"] },
			accepts: { commit: "rc300001" },
		});
		expect(planned).toEqual({ run: "R-3", slots: 3, already: 1 });
		const filled = (await slots("R-3")).find((slot) => slot.case === "C-1");
		expect(filled).toMatchObject({ state: "satisfied" });
		expect(filled?.fills[0]).toMatchObject({ method: "auto", outcome: "pass", admitted: "assumed" });
		expect((await run("R-3")).tally).toMatchObject({ pass: 1, missing: 2 });
	});

	test("a report that arrives after the run started fills it too", async () => {
		await h.call("report", {
			target: { commit: "rc300002", branch: "main" },
			results: [{ test: { key: "tests/other.spec.ts::x" }, outcome: "pass" }],
		});
		await h.call("plan", { name: "rc3", select: { cases: ["C-1"] }, accepts: { commit: "rc300002" } });
		expect(first(await slots("R-3")).state).toBe("missing");
		await h.call("report", {
			target: { commit: "rc300002", branch: "main" },
			job: "late",
			results: [{ test: { key: "tests/a.spec.ts::case one" }, outcome: "pass" }],
		});
		expect(first(await slots("R-3")).state).toBe("satisfied");
		expect(await run("R-3")).toMatchObject({ verdict: "passed", state: "closed" });
	});

	test("E5: late batches supersede a closed commit run's sign-off, including a late failure", async () => {
		const planned = await h.call<PlanReply>("plan", {
			name: "late evidence",
			select: { cases: ["C-1"] },
			accepts: { commit: "late0001" },
		});
		const report = async (outcome: string, job: string, named = false) =>
			await h.call<ReportReceipt>("report", {
				...(named ? { run: planned.run } : {}),
				target: { commit: "late0001", branch: "main" },
				job,
				results: [{ test: { key: "tests/a.spec.ts::case one" }, outcome }],
			});
		const signoffs = async () => (await h.call<InboxReply>("inbox", { kind: "signoff", state: "decided" })).items;
		await report("pass", "first");
		const original = first(await signoffs());
		expect(await run(planned.run)).toMatchObject({ state: "closed", verdict: "passed" });

		await report("pass", "late", true);
		const replacement = first(await signoffs());
		expect(await signoffs()).toHaveLength(2);
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
				supersedes: (await signoffs()).find((q) => q.q === original.q)?.decision?.id ?? -1,
				approval: original.decision?.id ?? -1,
			},
		]);
		expect(replacement.decision?.answer).toEqual({ is: "approve" });
		expect((await signoffs()).find((q) => q.q === original.q)?.decision?.answer).toEqual({ is: "outdated" });
		expect(await run(planned.run)).toMatchObject({ state: "closed", verdict: "passed" });

		await report("fail", "late failure");
		const asked = first((await h.call<InboxReply>("inbox", { kind: "signoff" })).items);
		expect((await signoffs()).find((q) => q.q === replacement.q)?.decision?.answer).toEqual({ is: "outdated" });
		expect(asked.evidence).toMatchObject({ verdict: "blocked" });
		expect(await run(planned.run)).toMatchObject({ state: "open", verdict: "blocked" });
		expect(first(await slots(planned.run)).state).toBe("failing");
		expect(
			first(
				await h.call<DecideReply[]>("decide", {
					q: asked.q,
					onEvidence: asked.evidenceHash,
					answer: { is: "approve" },
				}),
			),
		).toMatchObject({ status: "conflict", decision: null });
	});

	test("a strict commit run asks a person again after a late pass, and an older approval cannot reopen it", async () => {
		await h.call("propose", { edits: [{ op: "policy", preset: "strict" }] });
		const policy = first((await h.call<InboxReply>("inbox", { kind: "adopt" })).items);
		await h.call("decide", {
			q: policy.q,
			onEvidence: policy.evidenceHash,
			answer: { is: "accept" },
			reason: "require sign-off",
		});
		const planned = await h.call<PlanReply>("plan", {
			name: "human sign-off",
			select: { cases: ["C-1"] },
			accepts: { commit: "late0003" },
		});
		const approve = async (q: InboxReply["items"][number]) =>
			first(
				await h.call<DecideReply[]>("decide", {
					q: q.q,
					onEvidence: q.evidenceHash,
					answer: { is: "approve" },
					reason: "checked the evidence",
				}),
			);
		await record(planned.run, "C-1", "pass");
		const original = first((await h.call<InboxReply>("inbox", { kind: "signoff" })).items);
		expect((await approve(original)).status).toBe("decided");
		expect((await run(planned.run)).state).toBe("closed");
		const lateInput = {
			cmd: "late-human-pass",
			run: planned.run,
			results: [{ test: { case: "C-1" }, outcome: "pass" }],
		};
		const late = await h.call<ReportReceipt>("report", lateInput);
		const asked = first((await h.call<InboxReply>("inbox", { kind: "signoff" })).items);
		expect(asked.q).not.toBe(original.q);
		expect(asked.evidence).toMatchObject({ verdict: "passed" });
		expect(await run(planned.run)).toMatchObject({ state: "open", verdict: "passed" });
		expect((await approve(asked)).status).toBe("decided");
		await h.call("decide", { undo: original.q, reason: "withdraw the older approval" });
		expect(await run(planned.run)).toMatchObject({ state: "closed", verdict: "passed" });
		const retried = await h.call<ReportReceipt>("report", lateInput);
		expect(retried).toEqual(late);
		expect(await run(planned.run)).toMatchObject({ state: "closed", verdict: "passed" });
	});

	for (const preset of ["standard", "strict"] as const) {
		for (const reportKind of [
			"other repository",
			"other environment",
			"unrelated case",
			"unqualified result",
		] as const) {
			test(`${preset}: a closed run keeps its approval after a report for ${reportKind}`, async () => {
				if (preset === "strict") {
					await h.call("propose", { edits: [{ op: "policy", preset }] });
					const policy = first((await h.call<InboxReply>("inbox", { kind: "adopt" })).items);
					await h.call("decide", {
						q: policy.q,
						onEvidence: policy.evidenceHash,
						answer: { is: "accept" },
						reason: "require sign-off",
					});
				}
				const target = { commit: "same0001", repo: "acme/app", env: "prod" };
				const planned = await h.call<PlanReply>("plan", {
					name: "only counted evidence",
					select: { cases: ["C-2"] },
					accepts: target,
					require: [{ id: "exercise", kind: "exercise", methods: ["human"], minActors: 1, basis: "exact" }],
				});
				await record(planned.run, "C-2", "pass");
				if (preset === "strict") {
					const signoff = first((await h.call<InboxReply>("inbox", { kind: "signoff" })).items);
					await h.call("decide", {
						q: signoff.q,
						onEvidence: signoff.evidenceHash,
						answer: { is: "approve" },
						reason: "checked",
					});
				}
				const signoffs = async () => (await h.call<InboxReply>("inbox", { kind: "signoff", state: "decided" })).items;
				const original = await signoffs();
				const horizon = () =>
					h.app.db.raw
						.query<{ applied_seq: number; outstanding: number }, [number]>(
							"SELECT applied_seq, outstanding FROM runs WHERE no = ?",
						)
						.get(Number(planned.run.slice(2)));
				const before = horizon();
				expect(await run(planned.run)).toMatchObject({ state: "closed", verdict: "passed" });
				expect(first(original).decision?.answer).toEqual({ is: "approve" });
				const receipt = await h.call<ReportReceipt>("report", {
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
				expect(await run(planned.run)).toMatchObject({
					state: "closed",
					verdict: "passed",
					tally: { pass: 1, missing: 0 },
				});
				expect(await signoffs()).toEqual(original);
				expect((await h.call<InboxReply>("inbox", { kind: "signoff" })).items).toEqual([]);
				expect(horizon()).toEqual(before);
				expect(await h.call<GateStatus>("gate", { run: planned.run })).toMatchObject({
					verdict: "passed",
					stale: false,
				});
			});
		}
	}

	test("a never-closed strict run dissolves a repeated sign-off when a failure arrives", async () => {
		await h.call("propose", { edits: [{ op: "policy", preset: "strict" }] });
		const policy = first((await h.call<InboxReply>("inbox", { kind: "adopt" })).items);
		await h.call("decide", {
			q: policy.q,
			onEvidence: policy.evidenceHash,
			answer: { is: "accept" },
			reason: "require sign-off",
		});
		const planned = await h.call<PlanReply>("plan", {
			name: "never approved",
			select: { cases: ["C-1", "C-2"] },
			accepts: { commit: "never001" },
		});
		await record(planned.run, "C-1", "pass");
		await record(planned.run, "C-2", "pass");
		const original = first((await h.call<InboxReply>("inbox", { kind: "signoff" })).items);
		await h.call("decide", {
			q: original.q,
			onEvidence: original.evidenceHash,
			answer: { is: "reject" },
			reason: "not yet",
		});
		await record(planned.run, "C-1", "pass");
		const repeated = first((await h.call<InboxReply>("inbox", { kind: "signoff" })).items);
		expect(repeated.q).not.toBe(original.q);
		expect(repeated.evidence).toMatchObject({ verdict: "passed" });
		await record(planned.run, "C-2", "fail", { failure: { message: "new failure" } });
		expect(await run(planned.run)).toMatchObject({ state: "open", verdict: "blocked" });
		expect((await h.call<InboxReply>("inbox", { kind: "signoff" })).items).toEqual([]);
		expect(
			h.app.db.raw
				.query<{ state: string }, [number]>("SELECT state FROM questions WHERE no = ?")
				.get(Number(repeated.q.slice(2))),
		).toEqual({ state: "dissolved" });
		expect(first((await h.call<InboxReply>("inbox", { kind: "failure" })).items).title).toBe("new failure");
	});

	test.each([false, true])(
		"E5: a closed run waits for both accepted batches, reversed processing: %s",
		async (reverse) => {
			const planned = await h.call<PlanReply>("plan", {
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
			await h.call("report", input(1));
			const original = first((await h.call<InboxReply>("inbox", { state: "decided", kind: "signoff" })).items);
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
			expect(await h.call<GateStatus>("gate", { run: planned.run })).toMatchObject({
				verdict: "pending",
				stale: true,
				reason: "pending: 2 reports accepted and not yet applied",
			});
			inTx((ctx) => processBatch(ctx, first(batches).id));
			expect(await h.call<GateStatus>("gate", { run: planned.run })).toMatchObject({
				verdict: "pending",
				reason: "pending: 1 report accepted and not yet applied",
			});
			expect(first((await h.call<InboxReply>("inbox", { state: "decided", kind: "signoff" })).items).q).toBe(
				original.q,
			);
			inTx((ctx) => processBatch(ctx, first(batches.slice(1)).id));
			expect(await h.call<GateStatus>("gate", { run: planned.run })).toMatchObject({ verdict: "passed", stale: false });
			expect((await run(planned.run)).state).toBe("closed");
			const signoffs = (await h.call<InboxReply>("inbox", { state: "decided", kind: "signoff" })).items;
			expect(signoffs).toHaveLength(2);
			expect(first(signoffs).decision?.answer).toEqual({ is: "approve" });
			expect(signoffs.find((q) => q.q === original.q)?.decision?.answer).toEqual({ is: "outdated" });
		},
	);

	test("E3: an assumed result does not count when the run asks for an exact basis", async () => {
		await h.call("report", {
			target: { commit: "rc300003", branch: "main" },
			results: [{ test: { key: "tests/a.spec.ts::case one" }, outcome: "pass" }],
		});
		const exact = [{ id: "exercise", kind: "exercise", methods: ["human", "auto"], minActors: 1, basis: "exact" }];
		const planned = await h.call<PlanReply>("plan", {
			name: "strict rc3",
			select: { cases: ["C-1"] },
			accepts: { commit: "rc300003" },
			require: exact,
		});
		expect(planned.already).toBe(0);
		expect(await run(planned.run)).toMatchObject({ verdict: "pending" });
		// the same test, annotated with the version it exercised, is exact and counts
		await h.call("report", {
			target: { commit: "rc300003", branch: "main" },
			job: "annotated",
			results: [
				{ test: { key: "tests/a.spec.ts::case one" }, annotation: { case: "C-1", version: 1 }, outcome: "pass" },
			],
		});
		expect(first(await slots(planned.run)).fills[0]).toMatchObject({ admitted: "exact" });
		expect(await run(planned.run)).toMatchObject({ verdict: "passed" });
	});

	test("a slot that asks for a person is not filled by a linked test", async () => {
		const humanOnly = [
			{ id: "by-hand", kind: "exercise", methods: ["human"], minActors: 1, basis: "exact-or-assumed" },
		];
		await h.call("report", {
			target: { commit: "rc300004", branch: "main" },
			results: [{ test: { key: "tests/a.spec.ts::case one" }, outcome: "pass" }],
		});
		const planned = await h.call<PlanReply>("plan", {
			name: "a11y",
			select: { cases: ["C-1"] },
			accepts: { commit: "rc300004" },
			require: humanOnly,
		});
		expect(planned.already).toBe(0);
		expect(first(await slots(planned.run)).state).toBe("missing");
	});

	test("E1: a manual fail beside a pipeline pass is disputed until a person decides; a later write never hides it", async () => {
		await h.call("report", {
			target: { commit: "rc300005", branch: "main" },
			results: [{ test: { key: "tests/a.spec.ts::case one" }, outcome: "pass" }],
		});
		const planned = await h.call<PlanReply>("plan", {
			name: "rc3",
			select: { cases: ["C-1"] },
			accepts: { commit: "rc300005" },
		});
		// the run closed by rule on the pipeline's pass; reopen it to test by hand
		const signoff = first((await h.call<InboxReply>("inbox", { state: "decided", kind: "signoff" })).items);
		await h.call("decide", { undo: signoff.q });
		await record(planned.run, "C-1", "fail", { note: "Total is wrong on a real device" });
		expect(first(await slots(planned.run)).state).toBe("disputed");
		expect(await run(planned.run)).toMatchObject({ verdict: "blocked" });
		const q = first((await queue()).items);
		expect((q.evidence as { hints: string[] }).hints).toContain("disputed");
		// the producer of the failing result may not settle the dispute under the standard preset
		const own = await h.call<{ status: string }[]>("decide", {
			q: q.q,
			onEvidence: q.evidenceHash,
			answer: { is: "mistaken" },
		});
		expect(own[0]?.status).toBe("forbidden");
		const lead = h.actor("mira", "human", ["read", "produce", "answer", "plan"]);
		const settled = await h.call<{ status: string }[]>(
			"decide",
			{ q: q.q, onEvidence: q.evidenceHash, answer: { is: "mistaken" } },
			lead,
		);
		expect(settled[0]?.status).toBe("decided");
		expect(first(await slots(planned.run)).state).toBe("satisfied");
	});
});

describe("an agent's evidence", () => {
	beforeEach(async () => {
		h = await harness();
		await seed(1);
	});

	test("is recorded and visible, and does not fill a slot unless the run asks for it and the case declares it", async () => {
		const agent = h.actor("explorer", "agent", ["read", "produce"]);
		await h.call("plan", { name: "default", select: { cases: ["C-1"] } });
		await record("R-1", "C-1", "pass", {}, agent);
		expect(first(await slots("R-1")).state).toBe("missing");
		const timeline = await h.call<{ entries: { t: string; method?: string; by?: string }[] }>("timeline", {
			ref: "C-1",
		});
		expect(timeline.entries.find((e) => e.t === "result")).toMatchObject({ method: "agent", by: "explorer" });

		// opt in: the case declares an agent method, and the run names agent
		await h.call("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { methods: ["human", "agent"] } }] });
		const withAgents = [
			{ id: "exercise", kind: "exercise", methods: ["human", "agent"], minActors: 1, basis: "exact-or-assumed" },
		];
		const planned = await h.call<PlanReply>("plan", {
			name: "agents welcome",
			select: { cases: ["C-1"] },
			require: withAgents,
		});
		await record(planned.run, "C-1", "pass", {}, agent);
		expect(first(await slots(planned.run))).toMatchObject({ state: "satisfied" });
	});

	test("a review is recorded but is never a runtime pass", async () => {
		const agent = h.actor("reviewer", "agent", ["read", "produce"]);
		await h.call("plan", { name: "default", select: { cases: ["C-1"] } });
		const hash = (await h.call<{ hash: string }[]>("get", { refs: ["C-1"] }))[0]?.hash;
		const claimed = await h.call<{ reviewed: number; opened: string[] }>(
			"claim",
			{ lens: "adversarial-review", reviewed: [`C-1@${hash}`], findings: [] },
			agent,
		);
		expect(claimed).toMatchObject({ reviewed: 1, opened: [] });
		expect(first(await slots("R-1")).state).toBe("missing");
		expect((await h.call<GateStatus>("gate", { run: "R-1" })).verdict).toBe("pending");
	});
});

describe("deploy announcements and release runs", () => {
	const digest = `sha256:${"a".repeat(64)}`;
	const code = [{ repo: "acme/web", commit: "1".repeat(40) }];
	beforeEach(async () => {
		h = await harness();
		await seed(1);
	});

	test("a pipeline binds a build to attested code and records each deployment; a command retry writes nothing", async () => {
		const ci = h.actor("deploy", "ci", ["record"]);
		const input = { deploy: "1.4-rc3", env: "staging", digest, code, cmd: "deploy-rc3-1" };
		const announced = await h.call<AnnounceReply>("announce", input, ci);
		expect(announced).toMatchObject({ build: "1.4-rc3", digest, env: "staging", code, by: "deploy" });
		expect(await h.call<AnnounceReply>("announce", input, ci)).toEqual(announced);
		await h.call("announce", { deploy: "1.4-rc3", env: "production" }, ci);
		const deployments = await h.call<{ items: { env: string; build: string }[] }>("find", { in: "deployments" });
		expect(deployments.items.map(({ env, build }) => [env, build])).toEqual([
			["production", "1.4-rc3"],
			["staging", "1.4-rc3"],
		]);
		const page = await h.call<{ items: { env: string }[]; cursor: string }>("find", { in: "deployments", limit: 1 });
		expect(page.items.map((event) => event.env)).toEqual(["production"]);
		expect(
			await h.call<{ items: { env: string }[]; cursor: null }>("find", {
				in: "deployments",
				cursor: page.cursor,
				limit: 1,
			}),
		).toMatchObject({ items: [{ env: "staging" }], cursor: null });
		expect(
			await h.raw("announce", { deploy: "1.4-rc3", env: "staging", digest: `sha256:${"b".repeat(64)}`, code }, ci),
		).toMatchObject({ ok: false, error: { code: "conflict" } });
		expect(
			await h.raw(
				"announce",
				{ deploy: "alias", env: "staging", digest, code: [{ ...code[0], commit: "2".repeat(40) }] },
				ci,
			),
		).toMatchObject({ ok: false, error: { code: "conflict" } });
		expect((await h.call<{ items: unknown[] }>("find", { in: "deployments" })).items.length).toBe(2);
	});

	test("only pipelines and admins attest artifacts; an unknown build or incomplete attestation is refused", async () => {
		const member = h.actor("tester", "human", ["record"]);
		const agent = h.actor("reviewer", "agent", ["record", "produce"]);
		for (const actor of [member, agent]) {
			expect(await h.raw("announce", { deploy: "rc3", env: "staging", digest, code }, actor)).toMatchObject({
				ok: false,
				error: { code: "forbidden" },
			});
		}
		expect(await h.raw("announce", { deploy: "unknown", env: "staging" })).toMatchObject({
			ok: false,
			error: { code: "invalid" },
		});
		expect(await h.raw("announce", { deploy: "rc3", env: "staging", digest })).toMatchObject({
			ok: false,
			error: { code: "invalid" },
		});
		expect(
			await h.raw("plan", { name: "release", select: { cases: ["C-1"] }, accepts: { build: "unknown" } }),
		).toMatchObject({ ok: false, error: { code: "not_found" } });
	});

	test.each(["report", "plan"] as const)(
		"P1: %s refuses an environment the build was never deployed to",
		async (op) => {
			await h.call("announce", { deploy: "rc3", env: "staging", digest, code });
			const target = { build: "rc3", env: "prodution" };
			const reply =
				op === "report"
					? await h.raw("report", { target, results: [{ test: { case: "C-1" }, outcome: "pass" }] })
					: await h.raw("plan", { name: "Typo release", select: { cases: ["C-1"] }, accepts: target });
			expect(reply).toMatchObject({
				ok: false,
				error: {
					code: "invalid",
					message: 'build rc3 has not been deployed to "prodution"; deployed environments: "staging"',
				},
			});
			expect((await h.call<{ items: unknown[] }>("find", { in: "runs" })).items).toEqual([]);
			const planned = await h.call<PlanReply>("plan", {
				name: "Staging",
				select: { cases: ["C-1"] },
				accepts: { build: "rc3", env: "staging" },
			});
			expect(planned).toMatchObject({ run: "R-1", already: 0 });
			expect((await h.call<GateStatus>("gate", { run: planned.run })).verdict).toBe("pending");
			await h.call("announce", { deploy: "rc3", env: "prodution" });
			const later = await h.call<PlanReply>("plan", {
				name: "Later deployment",
				select: { cases: ["C-1"] },
				accepts: target,
			});
			expect(later.already).toBe(0);
			await h.call("report", { target, results: [{ test: { case: "C-1" }, outcome: "pass" }] });
			expect((await h.call<GateStatus>("gate", { run: later.run })).verdict).toBe("passed");
		},
	);

	test("a later deployment can count earlier results for the same artifact under another label", async () => {
		await h.call("announce", { deploy: "rc3", env: "staging", digest, code });
		await h.call("announce", { deploy: "alias", env: "production", digest, code });
		await h.call("report", {
			target: { build: "alias", env: "production" },
			results: [{ test: { case: "C-1" }, outcome: "pass" }],
		});
		const plan = { name: "Production", select: { cases: ["C-1"] }, accepts: { build: "rc3", env: "production" } };
		expect(await h.raw("plan", plan)).toMatchObject({ ok: false, error: { code: "invalid" } });
		await h.call("announce", { deploy: "rc3", env: "production" });
		const planned = await h.call<PlanReply>("plan", plan);
		expect(planned.already).toBe(1);
		expect((await h.call<GateStatus>("gate", { run: planned.run })).verdict).toBe("passed");
	});

	test("release slots count the exact artifact and environment, including earlier evidence, and gate by run", async () => {
		await h.call("announce", { deploy: "rc3", env: "staging", digest, code });
		await h.call("announce", { deploy: "rc3", env: "production" });
		const planned = await h.call<PlanReply>("plan", {
			name: "Release smoke",
			select: { cases: ["C-1"] },
			accepts: { build: "rc3", env: "staging" },
		});
		const ci = h.actor("tests", "ci", ["record"]);
		// A pass on the attested commit proves no execution of the artifact.
		await h.call(
			"report",
			{
				target: { ...code[0], branch: "main" },
				results: [{ test: { key: "checkout" }, annotation: { case: "C-1", version: 1 }, outcome: "pass" }],
			},
			ci,
		);
		await h.call("report", {
			target: { build: "rc3", env: "production" },
			results: [{ test: { case: "C-1" }, outcome: "pass" }],
		});
		expect(await h.call<GateStatus>("gate", { run: planned.run })).toMatchObject({
			verdict: "pending",
			tally: { missing: 1 },
		});
		// Recording by run alone must use its artifact, never a session or the attested commit.
		await h.call("report", { run: planned.run, results: [{ test: { case: "C-1" }, outcome: "pass" }] });
		expect(await h.call<GateStatus>("gate", { run: planned.run })).toMatchObject({
			verdict: "passed",
			tally: { pass: 1, missing: 0 },
		});
		await h.call("announce", { deploy: "same-artifact", env: "staging", digest, code });
		const reuse = await h.call<PlanReply>("plan", {
			name: "Same artifact",
			select: { cases: ["C-1"] },
			accepts: { build: "same-artifact", env: "staging" },
		});
		expect(reuse.already).toBe(1);
		expect((await h.call<GateStatus>("gate", { run: reuse.run })).verdict).toBe("passed");
		const other = await h.call<PlanReply>("plan", {
			name: "Production",
			select: { cases: ["C-1"] },
			accepts: { build: "rc3", env: "production" },
		});
		expect(other.already).toBe(1);
	});

	test("a release planned during an accepted upload stays pending, then counts the recovered failure", async () => {
		await h.call("announce", { deploy: "rc3", env: "staging", digest, code });
		const ci = h.actor("tests", "ci", ["record"]);
		const target = { build: "rc3", env: "staging" };
		const result = { test: { key: "checkout" }, annotation: { case: "C-1", version: 1 } };
		await h.call("report", { target, results: [{ ...result, outcome: "pass" }] }, ci);
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
		const planned = await h.call<PlanReply>("plan", {
			name: "Release during upload",
			select: { cases: ["C-1"] },
			accepts: target,
		});
		expect(await h.call<GateStatus>("gate", { run: planned.run })).toMatchObject({
			verdict: "pending",
			reason: "pending: 1 report accepted and not yet applied",
		});
		expect((await run(planned.run)).state).toBe("open");
		recoverAccepted(h.app);
		expect(await h.call<GateStatus>("gate", { run: planned.run })).toMatchObject({
			verdict: "blocked",
			tally: { unexplained: 1 },
		});
		const failure = first((await h.call<InboxReply>("inbox", { kind: "failure", on: planned.run })).items);
		await h.call("decide", { q: failure.q, onEvidence: failure.evidenceHash, answer: { is: "defect" } });
		expect((await h.call<GateStatus>("gate", { run: planned.run })).verdict).toBe("failed");
	});

	test("release jobs must report on the artifact in the selected environment", async () => {
		await h.call("announce", { deploy: "rc3", env: "staging", digest, code });
		await h.call("announce", { deploy: "rc3", env: "production" });
		const planned = await h.call<PlanReply>("plan", {
			name: "Release jobs",
			select: { cases: ["C-1"] },
			accepts: { build: "rc3", env: "staging" },
			require: [
				{ id: "exercise", kind: "exercise", methods: ["human", "auto"], minActors: 1, basis: "exact" },
				{ id: "ci", kind: "jobs", jobs: ["smoke"] },
			],
		});
		await h.call("report", { run: planned.run, results: [{ test: { case: "C-1" }, outcome: "pass" }] });
		const ci = h.actor("smoke", "ci", ["record"]);
		const results = [{ test: { key: "health" }, outcome: "pass" }];
		await h.call("report", { target: { build: "rc3", env: "production" }, job: "smoke", results }, ci);
		expect(await h.call<GateStatus>("gate", { run: planned.run })).toMatchObject({
			verdict: "pending",
			tally: { pass: 1, missing: 1 },
		});
		await h.call("report", { target: { build: "rc3", env: "staging" }, job: "smoke", results }, ci);
		expect(await h.call<GateStatus>("gate", { run: planned.run })).toMatchObject({
			verdict: "passed",
			tally: { missing: 0 },
		});
	});

	test("forgetting an announcer removes its display name from saved replies and resolves provenance by id", async () => {
		const ci = h.actor("retired-deployer", "ci", ["record"]);
		await h.call("announce", { deploy: "rc3", env: "staging", digest, code, cmd: "forgotten-deploy-1" }, ci);
		const forgotten = await h.call<{ forgotten: string }>("admin", { do: "actor.forget", name: "retired-deployer" });
		const saved = h.app.db.raw
			.query<{ outcome: string }, []>("SELECT outcome FROM commands WHERE id = 'forgotten-deploy-1'")
			.get();
		expect(JSON.parse(saved?.outcome ?? "{}")).toMatchObject({ by: forgotten.forgotten });
		expect((await h.call<{ items: unknown[] }>("find", { in: "deployments" })).items).toMatchObject([
			{ by: forgotten.forgotten, attestation: { by: forgotten.forgotten } },
		]);
	});

	test("an archive preserves the immutable build, its attestation and deployment history", async () => {
		await h.call("announce", { deploy: "rc3", env: "staging", digest, code });
		await h.call("announce", { deploy: "rc3", env: "production" });
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
	beforeEach(async () => {
		h = await harness();
		await seed(1);
	});

	test("holds however many questions the rule was not asked in between", async () => {
		const planned = await h.call<PlanReply>("plan", {
			name: "refused",
			select: { cases: ["C-1"] },
			accepts: { commit: "refuse01" },
		});
		const report = async (attempt: number, outcome: "pass" | "fail") =>
			await h.call("report", {
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
		await report(1, "pass");
		const approved = first((await h.call<InboxReply>("inbox", { state: "decided", kind: "signoff" })).items);
		await h.call("decide", { undo: approved.q, reason: "withdraw the automatic approval" });
		const asked = first((await h.call<InboxReply>("inbox", { kind: "signoff" })).items);
		await h.call("decide", { q: asked.q, onEvidence: asked.evidenceHash, answer: { is: "reject" }, reason: "not yet" });
		// The walk back through earlier questions stopped after 100 (issue #369): the rule approved at cycle 101.
		for (let cycle = 1; cycle <= 101; cycle++) {
			await report(2 * cycle, "fail");
			await report(2 * cycle + 1, "pass");
		}
		expect((await run(planned.run)).state).toBe("open");
		const decided = (await h.call<InboxReply>("inbox", { state: "decided", kind: "signoff" })).items;
		expect(decided.map((q) => q.decision?.answer)).not.toContainEqual({ is: "approve" });
		expect(first((await h.call<InboxReply>("inbox", { kind: "signoff" })).items).evidence).toMatchObject({
			verdict: "passed",
		});
	}, 30_000);
});
