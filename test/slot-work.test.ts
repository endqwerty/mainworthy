import { afterEach, beforeEach, expect, test } from "bun:test";
import type { InboxReply } from "../src/core/ops.ts";
import { openApp } from "../src/server/kernel/app.ts";
import { OPS } from "../src/server/ops/index.ts";
import { invoke } from "../src/server/ops/registry.ts";
import { exportArchive, importArchive, linesOf } from "../src/server/transfer/transfer.ts";
import { testDatabase } from "./db.ts";
import { type Harness, harness } from "./helpers.ts";

let h: Harness;
beforeEach(async () => {
	h = await harness();
	await h.call("propose", {
		edits: [1, 2].map((n) => ({ op: "create", body: { title: `Case ${n}`, methods: ["human", "agent"] } })),
	});
	await h.call("plan", {
		name: "Shared run",
		select: { cases: ["C-1", "C-2"] },
		require: [{ id: "exercise", kind: "exercise", methods: ["human", "agent"], minActors: 1, basis: "exact" }],
	});
});
afterEach(async () => await h?.close());
type Work = { kind: "free" } | { kind: "held"; actor: string; since: number; until: number };
type Taken = { run: string; slot: number | null; case: string | null; work: Work };
const take = async (input: Record<string, unknown> = {}, actor = h.owner) =>
	await h.call<Taken>("work", { do: "take", run: "R-1", ...input }, actor);
const slots = async () =>
	(await h.call<{ items: { id: number; work: Work; fills: { by: string }[] }[] }>("find", { in: "slots", run: "R-1" }))
		.items;
const run = async () => (await h.call<{ inProgress: number }[]>("get", { refs: ["R-1"] }))[0];

test("two agents asking together take different next slots", async () => {
	const a = await h.actor("one", "agent", ["read", "produce"]);
	const b = await h.actor("two", "agent", ["read", "produce"]);
	const release = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const held = h.app.database.write(
		async (db) =>
			await db.transaction(async () => {
				entered.resolve();
				await release.promise;
			}),
	);
	await entered.promise;
	const asking = [a, b].map((actor) =>
		invoke(h.app, OPS, { op: "work", project: "scratch", input: { do: "take", run: "R-1" }, actor: async () => actor }),
	);
	try {
		expect((await slots()).map((slot) => slot.work.kind)).toEqual(["free", "free"]);
	} finally {
		release.resolve();
		await held;
	}
	const replies = await Promise.all(asking);
	const [one, two] = replies.map((reply) => {
		if (!reply.ok) throw new Error(JSON.stringify(reply.error));
		return reply.result as Taken;
	});
	expect([one?.case, two?.case]).toEqual(["C-1", "C-2"]);
	expect((await slots()).map((s) => (s.work.kind === "held" ? s.work.actor : "free"))).toEqual(["one", "two"]);
	expect(await run()).toMatchObject({ inProgress: 2 });
	expect(await take({}, a)).toEqual({ run: "R-1", slot: null, case: null, work: { kind: "free" } });
});

test("named take refuses another holder, renews with server time, and gives back", async () => {
	const first = await take({ slot: 1, seconds: 60 });
	const agent = await h.actor("other", "agent", ["read", "produce"]);
	expect(await h.raw("work", { do: "take", run: "R-1", slot: 1 }, agent)).toMatchObject({
		ok: false,
		error: { code: "conflict", details: { actor: "robin", until: first.work.kind === "held" ? first.work.until : 0 } },
	});
	h.advance(10_000);
	const renewed = await take({ slot: 1, seconds: 120 });
	expect(renewed.work).toEqual({
		kind: "held",
		actor: "robin",
		since: first.work.kind === "held" ? first.work.since : 0,
		until: h.app.now() + 120_000,
	});
	expect(await h.raw("work", { do: "give-back", run: "R-1", slot: 1 }, agent)).toMatchObject({
		ok: false,
		error: { code: "conflict" },
	});
	expect(await h.call<Taken>("work", { do: "give-back", run: "R-1", slot: 1 })).toEqual({
		run: "R-1",
		slot: first.slot,
		case: "C-1",
		work: { kind: "free" },
	});
	expect((await take({ slot: 1 }, agent)).work).toMatchObject({ kind: "held", actor: "other" });
});

test("an expired lease neither shows nor blocks at its exact deadline", async () => {
	const first = await take({ slot: 1, seconds: 30 });
	if (first.work.kind !== "held") throw new Error("no lease");
	h.advance(first.work.until - h.app.now() - 1);
	expect((await slots())[0]?.work).toEqual({ kind: "free" });
	expect(await run()).toMatchObject({ inProgress: 0 });
	const other = await h.actor("next", "agent", ["read", "produce"]);
	expect(await take({}, other)).toMatchObject({ case: "C-1", work: { kind: "held", actor: "next" } });
});

for (const by of ["holder", "another"])
	test(`a qualifying result from ${by} counts and ends the lease`, async () => {
		await take({ slot: 1 });
		const actor = by === "holder" ? h.owner : await h.actor("another", "agent", ["read", "produce"]);
		await h.call("report", { run: "R-1", results: [{ test: { case: "C-1" }, outcome: "pass" }] }, actor);
		expect((await slots())[0]).toMatchObject({ work: { kind: "free" }, fills: [{ by: actor.name }] });
		expect((await take()).case).toBe("C-2");
	});

test("taking requires a method admitted by both the run and pinned case", async () => {
	const ci = await h.actor("pipeline", "ci", ["read", "record"]);
	expect(await h.raw("work", { do: "take", run: "R-1", slot: 1 }, ci)).toMatchObject({
		ok: false,
		error: { code: "forbidden" },
	});
	await h.call("propose", { edits: [{ op: "create", body: { title: "Human only" } }] });
	await h.call("plan", {
		name: "Human case",
		select: { cases: ["C-3"] },
		require: [{ id: "exercise", kind: "exercise", methods: ["agent"], minActors: 1, basis: "exact" }],
	});
	const agent = await h.actor("agent", "agent", ["read", "produce"]);
	expect(await h.raw("work", { do: "take", run: "R-2", slot: 3 }, agent)).toMatchObject({
		ok: false,
		error: { code: "forbidden" },
	});
	expect(await h.call("work", { do: "take", run: "R-2" }, agent)).toMatchObject({ slot: null, work: { kind: "free" } });
});

test("lease lengths are bounded and caller timestamps are rejected", async () => {
	for (const input of [{ seconds: 29 }, { seconds: 86401 }, { seconds: 1.5 }, { since: 42 }, { until: 99 }])
		expect(await h.raw("work", { do: "take", run: "R-1", ...input })).toMatchObject({
			ok: false,
			error: { code: "invalid" },
		});
	expect((await take({ seconds: 86400 })).work).toMatchObject({ kind: "held", until: h.app.now() + 86_400_000 });
});

test("closing a run ends live leases and reopening does not restore them", async () => {
	await h.call("report", { run: "R-1", results: [1, 2].map((n) => ({ test: { case: `C-${n}` }, outcome: "pass" })) });
	const closed = (await h.call<InboxReply>("inbox", { kind: "signoff", state: "decided" })).items[0];
	if (!closed) throw new Error("no approval");
	await h.call("decide", { undo: closed.q });
	await take({ slot: 1 });
	const q = (await h.call<InboxReply>("inbox", { kind: "signoff" })).items[0];
	if (!q) throw new Error("no signoff");
	await h.call("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "approve" }, reason: "Complete" });
	expect((await h.call<{ state: string; inProgress: number }[]>("get", { refs: ["R-1"] }))[0]).toMatchObject({
		state: "closed",
		inProgress: 0,
	});
	expect((await slots())[0]?.work).toEqual({ kind: "free" });
	expect(await h.raw("work", { do: "take", run: "R-1", slot: 1 })).toMatchObject({
		ok: false,
		error: { code: "invalid" },
	});
	await h.call("decide", { undo: q.q, reason: "Recheck" });
	expect((await slots())[0]?.work).toEqual({ kind: "free" });
});

test("archives preserve the run and its slots but do not revive work leases", async () => {
	await take({ slot: 1 });
	const chunks: string[] = [];
	await h.app.database.write(
		async (db) => await db.transaction(async () => await exportArchive(db, (chunk) => chunks.push(chunk))),
	);
	const archive = chunks.join("");
	expect(archive).not.toContain("slot_leases");
	const restoredFixture = await testDatabase();
	const restored = await openApp(
		{ ...h.app.config, dataDir: ":memory:", databaseUrl: restoredFixture.url },
		{ memory: true, now: h.app.now },
	);
	try {
		await restored.database.write(async (db) => await importArchive(db, linesOf(archive)));
		const read = async (op: string, input: unknown) =>
			await invoke(restored, OPS, { op, project: "scratch", input, actor: async () => h.owner });
		expect(await read("get", { refs: ["R-1"] })).toMatchObject({
			ok: true,
			result: [{ ref: "R-1", slots: 2, inProgress: 0 }],
		});
		expect(await read("find", { in: "slots", run: "R-1" })).toMatchObject({
			ok: true,
			result: {
				items: [
					{ case: "C-1", work: { kind: "free" } },
					{ case: "C-2", work: { kind: "free" } },
				],
			},
		});
	} finally {
		await restored.close();
		await restoredFixture.close();
	}
});
