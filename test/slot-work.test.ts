import { afterEach, beforeEach, expect, test } from "bun:test";
import type { InboxReply } from "../src/core/ops.ts";
import { openApp } from "../src/server/kernel/app.ts";
import { OPS } from "../src/server/ops/index.ts";
import { invoke } from "../src/server/ops/registry.ts";
import { exportArchive, importArchive, linesOf } from "../src/server/transfer/transfer.ts";
import { type Harness, harness } from "./helpers.ts";

let h: Harness;
beforeEach(() => {
	h = harness();
	h.call("propose", {
		edits: [1, 2].map((n) => ({ op: "create", body: { title: `Case ${n}`, methods: ["human", "agent"] } })),
	});
	h.call("plan", {
		name: "Shared run",
		select: { cases: ["C-1", "C-2"] },
		require: [{ id: "exercise", kind: "exercise", methods: ["human", "agent"], minActors: 1, basis: "exact" }],
	});
});
afterEach(() => h.close());
type Work = { kind: "free" } | { kind: "held"; actor: string; since: number; until: number };
type Taken = { run: string; slot: number | null; case: string | null; work: Work };
const take = (input: Record<string, unknown> = {}, actor = h.owner) =>
	h.call<Taken>("work", { do: "take", run: "R-1", ...input }, actor);
const slots = () =>
	h.call<{ items: { id: number; work: Work; fills: { by: string }[] }[] }>("find", { in: "slots", run: "R-1" }).items;
const run = () => h.call<{ inProgress: number }[]>("get", { refs: ["R-1"] })[0];

test("two agents asking together take different next slots", async () => {
	const a = h.actor("one", "agent", ["read", "produce"]);
	const b = h.actor("two", "agent", ["read", "produce"]);
	const [one, two] = await Promise.all([
		Promise.resolve().then(() => take({}, a)),
		Promise.resolve().then(() => take({}, b)),
	]);
	expect([one.case, two.case]).toEqual(["C-1", "C-2"]);
	expect(slots().map((s) => (s.work.kind === "held" ? s.work.actor : "free"))).toEqual(["one", "two"]);
	expect(run()).toMatchObject({ inProgress: 2 });
	expect(take({}, a)).toEqual({ run: "R-1", slot: null, case: null, work: { kind: "free" } });
});

test("named take refuses another holder, renews with server time, and gives back", () => {
	const first = take({ slot: 1, seconds: 60 });
	const agent = h.actor("other", "agent", ["read", "produce"]);
	expect(h.raw("work", { do: "take", run: "R-1", slot: 1 }, agent)).toMatchObject({
		ok: false,
		error: { code: "conflict", details: { actor: "robin", until: first.work.kind === "held" ? first.work.until : 0 } },
	});
	h.advance(10_000);
	const renewed = take({ slot: 1, seconds: 120 });
	expect(renewed.work).toEqual({
		kind: "held",
		actor: "robin",
		since: first.work.kind === "held" ? first.work.since : 0,
		until: h.app.now() + 120_000,
	});
	expect(h.raw("work", { do: "give-back", run: "R-1", slot: 1 }, agent)).toMatchObject({
		ok: false,
		error: { code: "conflict" },
	});
	expect(h.call<Taken>("work", { do: "give-back", run: "R-1", slot: 1 })).toEqual({
		run: "R-1",
		slot: first.slot,
		case: "C-1",
		work: { kind: "free" },
	});
	expect(take({ slot: 1 }, agent).work).toMatchObject({ kind: "held", actor: "other" });
});

test("an expired lease neither shows nor blocks at its exact deadline", () => {
	const first = take({ slot: 1, seconds: 30 });
	if (first.work.kind !== "held") throw new Error("no lease");
	h.advance(first.work.until - h.app.now() - 1);
	expect(slots()[0]?.work).toEqual({ kind: "free" });
	expect(run()).toMatchObject({ inProgress: 0 });
	const other = h.actor("next", "agent", ["read", "produce"]);
	expect(take({}, other)).toMatchObject({ case: "C-1", work: { kind: "held", actor: "next" } });
});

for (const by of ["holder", "another"])
	test(`a qualifying result from ${by} counts and ends the lease`, () => {
		take({ slot: 1 });
		const actor = by === "holder" ? h.owner : h.actor("another", "agent", ["read", "produce"]);
		h.call("report", { run: "R-1", results: [{ test: { case: "C-1" }, outcome: "pass" }] }, actor);
		expect(slots()[0]).toMatchObject({ work: { kind: "free" }, fills: [{ by: actor.name }] });
		expect(take().case).toBe("C-2");
	});

test("taking requires a method admitted by both the run and pinned case", () => {
	const ci = h.actor("pipeline", "ci", ["read", "record"]);
	expect(h.raw("work", { do: "take", run: "R-1", slot: 1 }, ci)).toMatchObject({
		ok: false,
		error: { code: "forbidden" },
	});
	h.call("propose", { edits: [{ op: "create", body: { title: "Human only" } }] });
	h.call("plan", {
		name: "Human case",
		select: { cases: ["C-3"] },
		require: [{ id: "exercise", kind: "exercise", methods: ["agent"], minActors: 1, basis: "exact" }],
	});
	const agent = h.actor("agent", "agent", ["read", "produce"]);
	expect(h.raw("work", { do: "take", run: "R-2", slot: 3 }, agent)).toMatchObject({
		ok: false,
		error: { code: "forbidden" },
	});
	expect(h.call("work", { do: "take", run: "R-2" }, agent)).toMatchObject({ slot: null, work: { kind: "free" } });
});

test("lease lengths are bounded and caller timestamps are rejected", () => {
	for (const input of [{ seconds: 29 }, { seconds: 86401 }, { seconds: 1.5 }, { since: 42 }, { until: 99 }])
		expect(h.raw("work", { do: "take", run: "R-1", ...input })).toMatchObject({
			ok: false,
			error: { code: "invalid" },
		});
	expect(take({ seconds: 86400 }).work).toMatchObject({ kind: "held", until: h.app.now() + 86_400_000 });
});

test("closing a run ends live leases and reopening does not restore them", () => {
	h.call("report", { run: "R-1", results: [1, 2].map((n) => ({ test: { case: `C-${n}` }, outcome: "pass" })) });
	const closed = h.call<InboxReply>("inbox", { kind: "signoff", state: "decided" }).items[0];
	if (!closed) throw new Error("no approval");
	h.call("decide", { undo: closed.q });
	take({ slot: 1 });
	const q = h.call<InboxReply>("inbox", { kind: "signoff" }).items[0];
	if (!q) throw new Error("no signoff");
	h.call("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "approve" }, reason: "Complete" });
	expect(h.call<{ state: string; inProgress: number }[]>("get", { refs: ["R-1"] })[0]).toMatchObject({
		state: "closed",
		inProgress: 0,
	});
	expect(slots()[0]?.work).toEqual({ kind: "free" });
	expect(h.raw("work", { do: "take", run: "R-1", slot: 1 })).toMatchObject({ ok: false, error: { code: "invalid" } });
	h.call("decide", { undo: q.q, reason: "Recheck" });
	expect(slots()[0]?.work).toEqual({ kind: "free" });
});

test("archives preserve the run and its slots but do not revive work leases", () => {
	take({ slot: 1 });
	const chunks: string[] = [];
	exportArchive(h.app.db, (chunk) => chunks.push(chunk));
	const archive = chunks.join("");
	expect(archive).not.toContain("slot_leases");
	const restored = openApp({ ...h.app.config, dataDir: ":memory:" }, { memory: true, now: h.app.now });
	try {
		importArchive(restored.db, linesOf(archive));
		const read = (op: string, input: unknown) =>
			invoke(restored, OPS, { op, project: "scratch", input, actor: () => h.owner });
		expect(read("get", { refs: ["R-1"] })).toMatchObject({
			ok: true,
			result: [{ ref: "R-1", slots: 2, inProgress: 0 }],
		});
		expect(read("find", { in: "slots", run: "R-1" })).toMatchObject({
			ok: true,
			result: {
				items: [
					{ case: "C-1", work: { kind: "free" } },
					{ case: "C-2", work: { kind: "free" } },
				],
			},
		});
	} finally {
		restored.close();
	}
});
