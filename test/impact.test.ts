import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { z } from "zod";
import { budget } from "../scripts/budget.ts";
import type { InboxReply } from "../src/core/ops.ts";
import { type Harness, harness } from "./helpers.ts";

let h: Harness;
beforeEach(async () => {
	h = await harness({ unlinked: "ask" });
});
afterEach(() => h.close());

type Impact = {
	counts: { cases: number; unreviewed: number; failing: number; uncovered: number };
	cases: {
		id: string;
		hash: string;
		reviewed?: boolean;
		last: string | null;
		open?: { q: string; evidence: string }[];
	}[];
	uncovered: string[];
	cursor: string;
	next: string | null;
};

async function databaseWork<T>(read: () => Promise<T>) {
	const gets = spyOn(h.app.db, "get");
	const alls = spyOn(h.app.db, "all");
	const dynamic = spyOn(h.app.db, "allDynamic");
	const fullCase = z.object({ id: z.number(), title: z.string(), head: z.number(), head_hash: z.string() });
	const reasonLink = z.union([
		z.strictObject({ case_id: z.number(), file: z.string() }),
		z.strictObject({ id: z.number(), key: z.string() }),
	]);
	try {
		const reply = await read();
		const loaded = [...gets.mock.results, ...alls.mock.results, ...dynamic.mock.results].flatMap((result) => {
			if (result.type !== "return") return [];
			const value: unknown = result.value;
			const rows: unknown[] = Array.isArray(value) ? value : [value];
			return rows;
		});
		return {
			reply,
			queries: gets.mock.calls.length + alls.mock.calls.length + dynamic.mock.calls.length,
			fullCases: loaded.filter((row) => fullCase.safeParse(row).success).length,
			reasonLinks: loaded.filter((row) => reasonLink.safeParse(row).success).length,
			testLookups: gets.mock.calls.filter(([statement]) => statement.text === "SELECT * FROM tests WHERE id = $id")
				.length,
		};
	} finally {
		gets.mockRestore();
		alls.mockRestore();
		dynamic.mockRestore();
	}
}

test("continuation queries and hydrated case rows stay bounded from 450 to 4500 selected cases", async () => {
	const measure = async (count: number) => {
		h.close();
		h = await harness();
		const reader = h.actor("bounded-reader", "agent", ["read"]);
		await h.call("propose", {
			edits: Array.from({ length: count }, (_, i) => ({
				op: "create",
				outline: `Bounded impact ${i + 1}\n  Check > Works`,
				covers: ["BOUND-396"],
			})),
		});
		await h.call("report", {
			target: { commit: "bounded396", pr: 396, title: "BOUND-396: review" },
			results: [{ test: { case: "C-1" }, outcome: "pass" }],
		});
		const input = { change: "pr:396" };
		const first = await h.call<Impact>("impact", input, reader);
		const measured = await databaseWork(
			async () => await h.call<Impact>("impact", { ...input, cursor: first.next }, reader),
		);
		expect(measured.reply.counts).toMatchObject({ cases: count, unreviewed: count, failing: 0 });
		expect(measured.reply.cases).toHaveLength(200);
		expect(measured.reply.cases[0]?.id).toBe("C-201");
		return measured;
	};
	const small = await measure(450);
	const large = await measure(4500);
	console.log(
		`impact continuation SQL: 450=${small.queries}, 4500=${large.queries}; full case rows=${small.fullCases}/${large.fullCases}; reason links=${small.reasonLinks}/${large.reasonLinks}`,
	);
	budget("impact continuation SQL at 4500 cases over 450", large.queries, small.queries + 2, "queries");
	budget("impact continuation SQL at 4500 cases", large.queries, 50, "queries");
	budget("impact full case rows at 450 cases", small.fullCases, 200, "rows");
	budget("impact full case rows at 4500 cases", large.fullCases, 200, "rows");
	budget("impact reason links at 450 cases", small.reasonLinks, 200, "rows");
	budget("impact reason links at 4500 cases", large.reasonLinks, 200, "rows");
});

test("5000 duplicate paths do the same database work as one path without changing cursor identity", async () => {
	await fixture();
	const single = await databaseWork(async () => await h.call<Impact>("impact", { files: ["linked.ts"] }));
	const files = Array.from({ length: 5000 }, () => "linked.ts");
	const repeated = await databaseWork(async () => await h.call<Impact>("impact", { files }));
	expect(repeated.reply.cases).toEqual(single.reply.cases);
	expect(repeated.reply.counts).toEqual(single.reply.counts);
	console.log(`impact duplicate-path SQL: one=${single.queries}, 5000=${repeated.queries}`);
	budget("impact SQL for 5000 duplicate paths over one", repeated.queries, single.queries + 1, "queries");
	budget("impact reason links for 5000 duplicate paths", repeated.reasonLinks, 200, "rows");
	expect(await h.raw("impact", { files, cursor: single.reply.next })).toMatchObject({
		ok: false,
		error: { code: "conflict" },
	});
});

test("a continuation page keeps the newest result across methods and each case's question evidence", async () => {
	await fixture();
	await h.call("report", {
		target: { commit: "impact396", pr: 396 },
		results: [
			{ test: { case: "C-201" }, outcome: "skip" },
			{ test: { key: "impact-203" }, annotation: { case: "C-203", version: 1 }, outcome: "pass" },
		],
	});
	const agent = h.actor("page-agent", "agent", ["read", "produce"]);
	await h.call(
		"report",
		{
			target: { commit: "impact396", pr: 396 },
			results: [{ test: { case: "C-202" }, outcome: "blocked" }],
		},
		agent,
	);
	await h.call("claim", {
		about: "pr:396",
		lens: "review",
		findings: [
			{ on: "C-201", category: "ambiguous", note: "The expected message needs its text" },
			{ on: "C-202", category: "cannot-fail", note: "The result accepts both outcomes" },
		],
	});
	const input = { change: "pr:396" };
	const first = await h.call<Impact>("impact", input);
	const page = await h.call<Impact>("impact", { ...input, cursor: first.next });
	for (const [id, last] of [
		["C-201", "skip@v1"],
		["C-202", "blocked@v1"],
	]) {
		const questions = (await h.call<InboxReply>("inbox", { on: id })).items;
		expect(questions.length).toBeGreaterThan(0);
		expect(page.cases.find((row) => row.id === id)).toMatchObject({
			last,
			open: questions.map((q) => ({ q: q.q, evidence: q.evidenceHash })),
		});
	}
	expect(page.cases.find((row) => row.id === "C-203")?.last).toBe("pass@v1");
});

async function fixture(count = 450) {
	const before = (await h.call<{ cursor: string }>("since", { cursor: "s:0" })).cursor;
	await h.call("propose", {
		edits: Array.from({ length: count }, (_, i) => ({
			op: "create",
			outline: `Impact case ${i + 1}\n  Check > Works`,
		})),
	});
	await h.call("report", {
		target: { commit: "impact396", pr: 396, files: ["linked.ts"] },
		results: Array.from({ length: count }, (_, i) => ({
			test: { key: `impact-${count - i}`, file: "linked.ts" },
			outcome: "pass",
		})),
	});
	const map = (await h.call<InboxReply>("inbox", { kind: "map" })).items[0];
	if (!map) throw new Error("Expected mapping question");
	await h.call("decide", {
		q: map.q,
		onEvidence: map.evidenceHash,
		answer: { is: "link", pairs: Array.from({ length: count }, (_, i) => [`T-${i + 1}`, `C-${count - i}`]) },
	});
	return before;
}

test("450 impacted cases are reachable once, in case order, for files and changes", async () => {
	await fixture();
	for (const input of [{ files: ["linked.ts"] }, { change: "pr:396" }]) {
		const first = await h.call<Impact>("impact", input);
		expect(first.counts.cases).toBe(450);
		expect(first.cases).toHaveLength(200);
		expect(typeof first.next).toBe("string");
		expect(await h.call<Impact>("impact", input)).toEqual(first);
		const second = await h.call<Impact>("impact", { ...input, cursor: first.next });
		expect(second.cases).toHaveLength(200);
		expect(typeof second.next).toBe("string");
		expect(await h.call<Impact>("impact", { ...input, cursor: first.next })).toEqual(second);
		const last = await h.call<Impact>("impact", { ...input, cursor: second.next });
		expect(last.cases).toHaveLength(50);
		expect(last.next).toBeNull();
		const ids = [...first.cases, ...second.cases, ...last.cases].map((row) => row.id);
		expect(ids).toEqual(Array.from({ length: 450 }, (_, i) => `C-${i + 1}`));
		expect(new Set(ids).size).toBe(450);
	}
});

test("partial pages retain the previous watermark, and only completion advances it", async () => {
	const before = await fixture();
	for (const input of [{ files: ["linked.ts"] }, { change: "pr:396" }]) {
		const query = { ...input, since: before };
		const first = await h.call<Impact>("impact", query);
		expect(first.cursor).toBe(before);
		expect((await h.call<Impact>("impact", { ...input, since: first.cursor })).counts.cases).toBe(450);
		expect((await h.call<{ changed: unknown[] }>("since", { cursor: first.cursor, limit: 500 })).changed).toHaveLength(
			450,
		);
		const second = await h.call<Impact>("impact", { ...query, cursor: first.next });
		expect(second.cursor).toBe(before);
		const last = await h.call<Impact>("impact", { ...query, cursor: second.next });
		expect(last.next).toBeNull();
		expect(last.cursor).not.toBe(before);
		expect((await h.call<Impact>("impact", { ...input, since: last.cursor })).counts.cases).toBe(0);
		expect((await h.call<{ changed: unknown[] }>("since", { cursor: last.cursor })).changed).toEqual([]);
	}
	expect((await h.call<Impact>("impact", { files: ["linked.ts"] })).cursor).toBe("s:0");
});

test("all 5000 accepted paths are processed, including coverage past path 2000", async () => {
	await fixture(1);
	const files = [...Array.from({ length: 4999 }, (_, i) => `uncovered-${i}.ts`), "linked.ts"];
	const impact = await h.call<Impact>("impact", { files });
	expect(impact.counts).toMatchObject({ cases: 1, uncovered: 4999 });
	expect(impact.uncovered).toHaveLength(50);
	expect(impact.next).toBeNull();
});

test("impact selection includes more than 500 links in one file and more than 200 failures", async () => {
	await fixture(650);
	const first = await h.call<Impact>("impact", { files: ["linked.ts"] });
	expect(first.counts.cases).toBe(650);
	const ids = first.cases.map((row) => row.id);
	let next = first.next;
	while (next) {
		const page = await h.call<Impact>("impact", { files: ["linked.ts"], cursor: next });
		ids.push(...page.cases.map((row) => row.id));
		next = page.next;
	}
	expect(ids).toEqual(Array.from({ length: 650 }, (_, i) => `C-${i + 1}`));
	await h.call("report", {
		target: { commit: "failed396", pr: 396, files: [] },
		results: Array.from({ length: 450 }, (_, i) => ({
			test: { key: `impact-${i + 1}` },
			outcome: "fail",
			failure: { message: "Expected correct result" },
		})),
	});
	const failed = await databaseWork(async () => await h.call<Impact>("impact", { change: "pr:396" }));
	expect(failed.reply.counts).toMatchObject({ cases: 450, failing: 450 });
	expect(failed.testLookups).toBe(0);
	budget("impact SQL of a failing change", failed.queries, 50, "queries");
	budget("impact full case rows of a failing change", failed.fullCases, 200, "rows");
});

test("continuations reject another selection, caller, malformed position, or changed project", async () => {
	await fixture(201);
	const input = { change: "pr:396" };
	const first = await h.call<Impact>("impact", input);
	expect(typeof first.next).toBe("string");
	for (const extra of [{ files: ["other.ts"] }, { ledger: false }, { since: "s:0" }])
		expect(await h.raw("impact", { ...input, ...extra, cursor: first.next })).toMatchObject({
			ok: false,
			error: { code: "conflict" },
		});
	const other = h.actor("other-reader", "agent", ["read"]);
	expect(await h.raw("impact", { ...input, cursor: first.next }, other)).toMatchObject({
		ok: false,
		error: { code: "conflict" },
	});
	for (const cursor of ["garbage", "1.0.nope", "1.9007199254740992.abcdefabcdef"])
		expect(await h.raw("impact", { ...input, cursor })).toMatchObject({ ok: false, error: { code: "invalid" } });
	await h.call("report", {
		target: { commit: "newhead396", pr: 396, files: ["linked.ts"] },
		results: [{ test: { key: "impact-1" }, outcome: "pass" }],
	});
	expect(await h.raw("impact", { ...input, cursor: first.next })).toMatchObject({
		ok: false,
		error: { code: "conflict" },
	});
	const restarted = await h.call<Impact>("impact", { ...input, since: first.cursor });
	expect(restarted.counts.cases).toBe(201);
	const row = restarted.cases[0];
	if (!row) throw new Error("Expected selected case");
	await h.call("claim", { about: "pr:396", patch: "newhead396", lens: "review", reviewed: [`${row.id}@${row.hash}`] });
	expect(await h.raw("impact", { ...input, since: first.cursor, cursor: restarted.next })).toMatchObject({
		ok: false,
		error: { code: "conflict" },
	});
	const reviewed = await h.call<Impact>("impact", input);
	expect(reviewed.cases[0]?.id).toBe("C-2");
	const page2 = await h.call<Impact>("impact", { ...input, cursor: reviewed.next });
	expect(page2.cases.at(-1)).toMatchObject({ id: "C-1", reviewed: true });
	await h.call("propose", {
		edits: [{ op: "edit", case: "C-201", base: 1, outline: "Changed case\n  Check > Works" }],
	});
	expect(await h.raw("impact", { ...input, cursor: reviewed.next })).toMatchObject({
		ok: false,
		error: { code: "conflict" },
	});
});
