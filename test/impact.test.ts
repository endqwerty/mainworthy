import { afterEach, beforeEach, expect, test } from "bun:test";
import type { InboxReply } from "../src/core/ops.ts";
import { type Harness, harness } from "./helpers.ts";

let h: Harness;
beforeEach(() => {
	h = harness({ unlinked: "ask" });
});
afterEach(() => h.close());

type Impact = {
	counts: { cases: number; unreviewed: number; failing: number; uncovered: number };
	cases: { id: string; hash: string; reviewed?: boolean }[];
	uncovered: string[];
	cursor: string;
	next: string | null;
};

function fixture(count = 450) {
	const before = h.call<{ cursor: string }>("since", { cursor: "s:0" }).cursor;
	h.call("propose", {
		edits: Array.from({ length: count }, (_, i) => ({
			op: "create",
			outline: `Impact case ${i + 1}\n  Check > Works`,
		})),
	});
	h.call("report", {
		target: { commit: "impact396", pr: 396, files: ["linked.ts"] },
		results: Array.from({ length: count }, (_, i) => ({
			test: { key: `impact-${count - i}`, file: "linked.ts" },
			outcome: "pass",
		})),
	});
	const map = h.call<InboxReply>("inbox", { kind: "map" }).items[0];
	if (!map) throw new Error("Expected mapping question");
	h.call("decide", {
		q: map.q,
		onEvidence: map.evidenceHash,
		answer: { is: "link", pairs: Array.from({ length: count }, (_, i) => [`T-${i + 1}`, `C-${count - i}`]) },
	});
	return before;
}

test("450 impacted cases are reachable once, in case order, for files and changes", () => {
	fixture();
	for (const input of [{ files: ["linked.ts"] }, { change: "pr:396" }]) {
		const first = h.call<Impact>("impact", input);
		expect(first.counts.cases).toBe(450);
		expect(first.cases).toHaveLength(200);
		expect(typeof first.next).toBe("string");
		expect(h.call<Impact>("impact", input)).toEqual(first);
		const second = h.call<Impact>("impact", { ...input, cursor: first.next });
		expect(second.cases).toHaveLength(200);
		expect(typeof second.next).toBe("string");
		expect(h.call<Impact>("impact", { ...input, cursor: first.next })).toEqual(second);
		const last = h.call<Impact>("impact", { ...input, cursor: second.next });
		expect(last.cases).toHaveLength(50);
		expect(last.next).toBeNull();
		const ids = [...first.cases, ...second.cases, ...last.cases].map((row) => row.id);
		expect(ids).toEqual(Array.from({ length: 450 }, (_, i) => `C-${i + 1}`));
		expect(new Set(ids).size).toBe(450);
	}
});

test("partial pages retain the previous watermark, and only completion advances it", () => {
	const before = fixture();
	for (const input of [{ files: ["linked.ts"] }, { change: "pr:396" }]) {
		const query = { ...input, since: before };
		const first = h.call<Impact>("impact", query);
		expect(first.cursor).toBe(before);
		expect(h.call<Impact>("impact", { ...input, since: first.cursor }).counts.cases).toBe(450);
		expect(h.call<{ changed: unknown[] }>("since", { cursor: first.cursor, limit: 500 }).changed).toHaveLength(450);
		const second = h.call<Impact>("impact", { ...query, cursor: first.next });
		expect(second.cursor).toBe(before);
		const last = h.call<Impact>("impact", { ...query, cursor: second.next });
		expect(last.next).toBeNull();
		expect(last.cursor).not.toBe(before);
		expect(h.call<Impact>("impact", { ...input, since: last.cursor }).counts.cases).toBe(0);
		expect(h.call<{ changed: unknown[] }>("since", { cursor: last.cursor }).changed).toEqual([]);
	}
	expect(h.call<Impact>("impact", { files: ["linked.ts"] }).cursor).toBe("s:0");
});

test("all 5000 accepted paths are processed, including coverage past path 2000", () => {
	fixture(1);
	const files = [...Array.from({ length: 4999 }, (_, i) => `uncovered-${i}.ts`), "linked.ts"];
	const impact = h.call<Impact>("impact", { files });
	expect(impact.counts).toMatchObject({ cases: 1, uncovered: 4999 });
	expect(impact.uncovered).toHaveLength(50);
	expect(impact.next).toBeNull();
});

test("impact selection includes more than 500 links in one file and more than 200 failures", () => {
	fixture(650);
	const first = h.call<Impact>("impact", { files: ["linked.ts"] });
	expect(first.counts.cases).toBe(650);
	const ids = first.cases.map((row) => row.id);
	let next = first.next;
	while (next) {
		const page = h.call<Impact>("impact", { files: ["linked.ts"], cursor: next });
		ids.push(...page.cases.map((row) => row.id));
		next = page.next;
	}
	expect(ids).toEqual(Array.from({ length: 650 }, (_, i) => `C-${i + 1}`));
	h.call("report", {
		target: { commit: "failed396", pr: 396, files: [] },
		results: Array.from({ length: 450 }, (_, i) => ({
			test: { key: `impact-${i + 1}` },
			outcome: "fail",
			failure: { message: "Expected correct result" },
		})),
	});
	const failed = h.call<Impact>("impact", { change: "pr:396" });
	expect(failed.counts).toMatchObject({ cases: 450, failing: 450 });
});

test("continuations reject another selection, caller, malformed position, or changed project", () => {
	fixture(201);
	const input = { change: "pr:396" };
	const first = h.call<Impact>("impact", input);
	expect(typeof first.next).toBe("string");
	for (const extra of [{ files: ["other.ts"] }, { ledger: false }, { since: "s:0" }])
		expect(h.raw("impact", { ...input, ...extra, cursor: first.next })).toMatchObject({
			ok: false,
			error: { code: "conflict" },
		});
	const other = h.actor("other-reader", "agent", ["read"]);
	expect(h.raw("impact", { ...input, cursor: first.next }, other)).toMatchObject({
		ok: false,
		error: { code: "conflict" },
	});
	for (const cursor of ["garbage", "1.0.nope", "1.9007199254740992.abcdefabcdef"])
		expect(h.raw("impact", { ...input, cursor })).toMatchObject({ ok: false, error: { code: "invalid" } });
	h.call("report", {
		target: { commit: "newhead396", pr: 396, files: ["linked.ts"] },
		results: [{ test: { key: "impact-1" }, outcome: "pass" }],
	});
	expect(h.raw("impact", { ...input, cursor: first.next })).toMatchObject({
		ok: false,
		error: { code: "conflict" },
	});
	const restarted = h.call<Impact>("impact", { ...input, since: first.cursor });
	expect(restarted.counts.cases).toBe(201);
	const row = restarted.cases[0];
	if (!row) throw new Error("Expected selected case");
	h.call("claim", { about: "pr:396", patch: "newhead396", lens: "review", reviewed: [`${row.id}@${row.hash}`] });
	expect(h.raw("impact", { ...input, since: first.cursor, cursor: restarted.next })).toMatchObject({
		ok: false,
		error: { code: "conflict" },
	});
	const reviewed = h.call<Impact>("impact", input);
	expect(reviewed.cases[0]?.id).toBe("C-2");
	const page2 = h.call<Impact>("impact", { ...input, cursor: reviewed.next });
	expect(page2.cases.at(-1)).toMatchObject({ id: "C-1", reviewed: true });
	h.call("propose", { edits: [{ op: "edit", case: "C-201", base: 1, outline: "Changed case\n  Check > Works" }] });
	expect(h.raw("impact", { ...input, cursor: reviewed.next })).toMatchObject({
		ok: false,
		error: { code: "conflict" },
	});
});
