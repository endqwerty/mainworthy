// Three producers, one run: planned runs, slots and what may fill them (fixtures E1, E3, E5, E7 in the design).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { verifyAudit } from "../src/core/audit.ts";
import { versionHash } from "../src/core/hash.ts";
import { emptyBody, type MethodKind } from "../src/core/model.ts";
import type { AnnounceReply, DecideReply, GateStatus, InboxReply, PlanReply, ReportReceipt } from "../src/core/ops.ts";
import { REPLIES } from "../src/core/replies.ts";
import type { ResultStep } from "../src/core/results.ts";
import { type Obligation, obligationMethods } from "../src/core/runs.ts";
import {
	batchById,
	excuseForResult,
	excusesForResults,
	mustTarget,
	resultById,
} from "../src/server/evidence/evidence.ts";
import { type Ctx, findProject, makeCtx, stampSeq } from "../src/server/kernel/ctx.ts";
import { Database, declaredSql, type SqlValue, sql } from "../src/server/kernel/db.ts";
import { recoverAccepted } from "../src/server/ops/jobs.ts";
import { acceptReport, processBatch } from "../src/server/ops/writes.ts";
import {
	countedTests,
	fillsOf,
	mustRun,
	plannedCounting,
	type RunTestWrite,
	retally,
	runsFor,
	upsertRunTests,
} from "../src/server/runs/runs.ts";
import { exportArchive, importArchive, linesOf } from "../src/server/transfer/transfer.ts";
import { testDatabase } from "./db.ts";
import { ciReport, type Harness, harness } from "./helpers.ts";

let h: Harness;
afterEach(async () => await h?.close());

for (const preset of ["loose", "standard"] as const) {
	for (const correctFailure of [false, true]) {
		test(`${preset}: excused disputes need distinct passing actors, correction=${correctFailure}`, async () => {
			h = await harness({ preset });
			await h.call("propose", { edits: [{ op: "create", outline: "Checkout\n  Buy > Works" }] });
			const producer = await h.actor("tester", "human", ["read", "produce", "record"]);
			const second = await h.actor("second", "human", ["read", "produce"]);
			const planned = await h.call<PlanReply>("plan", {
				name: "Two independent passes",
				select: { cases: ["C-1"] },
				accepts: { commit: "abc12345" },
				require: [{ id: "exercise", kind: "exercise", methods: ["human", "auto"], minActors: 2, basis: "exact" }],
			});
			const target = { commit: "abc12345", branch: "main" };
			const failed = await h.call<ReportReceipt>(
				"report",
				{
					target,
					results: [
						{
							test: { key: "checkout" },
							annotation: { case: "C-1", version: 1 },
							outcome: "fail",
							failure: { message: "Network offline" },
						},
					],
				},
				producer,
			);
			await h.call("report", { run: planned.run, results: [{ test: { case: "C-1" }, outcome: "pass" }] }, producer);
			const settle = async () => {
				const questions = (await h.call<InboxReply>("inbox", { kind: "failure" })).items;
				for (const q of questions) {
					const replies = await h.call<DecideReply[]>("decide", {
						q: q.q,
						onEvidence: q.evidenceHash,
						answer: { is: "infra" },
					});
					expect(replies[0]?.status).toBe("decided");
				}
			};
			await settle();
			expect(await h.call<GateStatus>("gate", { run: planned.run })).toMatchObject({
				verdict: "pending",
				tally: { pass: 0, missing: 1, disputed: 0 },
			});
			if (correctFailure) {
				await h.call(
					"report",
					{
						target,
						results: [
							{
								test: { key: "checkout" },
								annotation: { case: "C-1", version: 1 },
								outcome: "pass",
								corrects: failed.results[0],
							},
						],
					},
					producer,
				);
				expect(await h.call<GateStatus>("gate", { run: planned.run })).toMatchObject({
					verdict: "pending",
					tally: { pass: 0, missing: 1 },
				});
			}
			await h.call("report", { run: planned.run, results: [{ test: { case: "C-1" }, outcome: "pass" }] }, second);
			await settle();
			expect(await h.call<GateStatus>("gate", { run: planned.run })).toMatchObject({
				verdict: "passed",
				tally: { pass: 1, missing: 0, disputed: 0 },
			});
		});
	}
}

for (const invalidObligation of ["missing", "jobs"] as const) {
	test(`invalid ${invalidObligation} obligation never passes tally or refresh`, async () => {
		h = await harness();
		await h.call("propose", { edits: [{ op: "create", outline: "Checkout\n  Buy > Works" }] });
		const producer = await h.actor("tester", "human", ["read", "produce", "record"]);
		const second = await h.actor("second", "human", ["read", "produce"]);
		const planned = await h.call<PlanReply>("plan", {
			name: "Two independent passes",
			select: { cases: ["C-1"] },
			accepts: { commit: "abc12345" },
			require: [{ id: "exercise", kind: "exercise", methods: ["human", "auto"], minActors: 2, basis: "exact" }],
		});
		const target = { commit: "abc12345", branch: "main" };
		const failed = await h.call<ReportReceipt>(
			"report",
			{
				target,
				results: [
					{
						test: { key: "checkout" },
						annotation: { case: "C-1", version: 1 },
						outcome: "fail",
						failure: { message: "Network offline" },
					},
				],
			},
			producer,
		);
		await h.call("report", { run: planned.run, results: [{ test: { case: "C-1" }, outcome: "pass" }] }, producer);
		const settle = async () => {
			const questions = (await h.call<InboxReply>("inbox", { kind: "failure" })).items;
			for (const q of questions) {
				const replies = await h.call<DecideReply[]>("decide", {
					q: q.q,
					onEvidence: q.evidenceHash,
					answer: { is: "infra" },
				});
				expect(replies[0]?.status).toBe("decided");
			}
		};
		// Imported archives can contain a slot whose obligation is absent or names a jobs requirement.
		await h.app.database.write((db) =>
			db.transaction(async () => {
				await db.run(sql<{ require: string }>("UPDATE runs SET require = $require WHERE origin = 'planned'"), {
					require: JSON.stringify([
						{ id: "other", kind: "exercise", methods: ["human", "auto"], minActors: 2, basis: "exact" },
						...(invalidObligation === "jobs" ? [{ id: "exercise", kind: "jobs", jobs: [] }] : []),
					]),
				});
			}),
		);
		await settle();
		expect(await h.call<GateStatus>("gate", { run: planned.run })).toMatchObject({
			verdict: "pending",
			tally: { pass: 0, missing: 1, disputed: 0 },
		});
		await h.call(
			"report",
			{
				target,
				results: [
					{
						test: { key: "checkout" },
						annotation: { case: "C-1", version: 1 },
						outcome: "pass",
						corrects: failed.results[0],
					},
				],
			},
			producer,
		);
		expect(await h.call<GateStatus>("gate", { run: planned.run })).toMatchObject({
			verdict: "pending",
			tally: { pass: 0, missing: 1 },
		});
		expect(first(await slots(planned.run)).state).toBe("missing");
		// Cached states from an archive must not bypass obligation checking during a retally.
		for (const state of ["satisfied", "waived", "failing"]) {
			await h.app.database.write((db) =>
				db.transaction(async () => {
					await db.run(sql<{ state: string }>("UPDATE slots SET state = $state"), { state });
					const project = await findProject(db, "scratch");
					if (!project) throw new Error("no project");
					const ctx = makeCtx(h.app, db, project, h.owner, true);
					await retally(ctx, (await mustRun(db, project.id, planned.run)).id, []);
					await stampSeq(ctx);
				}),
			);
			expect(await h.call<GateStatus>("gate", { run: planned.run })).toMatchObject({
				verdict: "pending",
				tally: { pass: 0, missing: 1 },
			});
		}

		await h.call("report", { run: planned.run, results: [{ test: { case: "C-1" }, outcome: "pass" }] }, second);
		await settle();
		expect(await h.call<GateStatus>("gate", { run: planned.run })).toMatchObject({
			verdict: "pending",
			tally: { pass: 0, missing: 1, disputed: 0 },
		});
	});
}
test("slot replies carry pinned case methods across pages after the case head changes (987)", async () => {
	h = await harness();
	await h.call("propose", {
		edits: [
			{ op: "create", body: { title: "Human case", methods: ["human"] } },
			{ op: "create", body: { title: "Agent case", methods: ["agent"] } },
		],
	});
	await h.call("plan", { name: "Pinned methods", select: {} });
	await h.call("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { methods: ["agent"] } }] });
	const firstPage = await h.call<{ items: unknown[]; cursor: string }>("find", { in: "slots", run: "R-1", limit: 1 });
	expect(firstPage.items).toMatchObject([{ case: "C-1", version: 1, head: 2, methods: ["human"] }]);
	const secondPage = await h.call<{ items: unknown[] }>("find", {
		in: "slots",
		run: "R-1",
		limit: 1,
		cursor: firstPage.cursor,
	});
	expect(secondPage.items).toMatchObject([{ case: "C-2", methods: ["agent"] }]);
});

test("stored duplicate case and obligation methods still read and round-trip", async () => {
	h = await harness();
	await h.call("propose", { edits: [{ op: "create", body: { title: "Legacy", methods: ["human"] } }] });
	await h.call("plan", { name: "Legacy", select: {} });
	const methods = ["human", "human", "agent", "human"];
	const body = { ...emptyBody("Legacy"), methods: ["human", "human", "agent", "human"] as const };
	const hash = versionHash({ ...body, methods: [...body.methods] });
	await h.app.database.write((db) =>
		db.transaction(async () => {
			await db.run(
				sql<readonly SqlValue[]>('UPDATE versions SET body = $1, methods = \'["human","agent"]\', hash = $2'),
				[JSON.stringify(body), hash],
			);
			await db.run(sql<readonly SqlValue[]>("UPDATE cases SET methods = $1, head_hash = $2"), [
				JSON.stringify(methods),
				hash,
			]);
			await db.run(
				sql<readonly SqlValue[]>(
					"UPDATE runs SET require = jsonb_set(require::jsonb, '{0,methods}', $1::text::jsonb)::text",
				),
				[JSON.stringify(methods)],
			);
		}),
	);
	await h.call("get", { refs: ["C-1"] });
	REPLIES.get.parse(await h.call("get", { refs: ["R-1"] }));
	REPLIES.find.parse(await h.call("find", { in: "runs" }));
	const audit = await h.call<{ ndjson: string }>("audit", {});
	expect(verifyAudit(audit.ndjson).project).toBe("scratch");
	const expected = [{ methods: ["human", "agent"], admittedMethods: ["human", "agent"] }];
	expect((await h.call<{ items: unknown[] }>("find", { in: "slots", run: "R-1" })).items).toMatchObject(expected);
	expect(await h.call("work", { do: "take", run: "R-1" })).toMatchObject({ slot: 1, work: { kind: "held" } });
	const chunks: string[] = [];
	await h.app.database.write((db) => db.transaction(() => exportArchive(db, (chunk) => chunks.push(chunk))));
	const fixture = await testDatabase();
	const restored = await Database.open({ url: fixture.url });
	try {
		await restored.write((db) => importArchive(db, linesOf(chunks.join(""))));
		const rows = await restored.read((db) => db.all(sql<readonly [], { body: string }>("SELECT body FROM versions")));
		expect(JSON.parse(rows[0]?.body ?? "{}").methods).toEqual(methods);
		const runs = await restored.read((db) => db.all(sql<readonly [], { require: string }>("SELECT require FROM runs")));
		expect(JSON.parse(runs[0]?.require ?? "[]")[0].methods).toEqual(methods);
	} finally {
		await restored.close();
		await fixture.close();
	}
	REPLIES.get.parse(await h.call("get", { refs: ["R-1"] }));
	expect((await h.call<{ items: unknown[] }>("find", { in: "slots", run: "R-1" })).items).toMatchObject(expected);
	await h.call("propose", { edits: [{ op: "create", body: { title: "Duplicates accepted", methods } }] });
	await h.call("plan", {
		name: "Duplicates accepted",
		select: {},
		require: [{ id: "exercise", kind: "exercise", methods, minActors: 1, basis: "exact" }],
	});
});

test("exercise method index visits a legacy duplicate list only once for a page", () => {
	const methods: MethodKind[] = Array.from({ length: 250_000 }, () => "auto");
	methods.push("human");
	let visited = 0;
	methods[Symbol.iterator] = function* (): Generator<MethodKind, undefined> {
		for (let i = 0; i < this.length; i++) {
			visited++;
			const method = this[i];
			if (method !== undefined) yield method;
		}
		return undefined;
	};
	const index = obligationMethods(
		[
			{ id: "exercise", kind: "exercise", methods, minActors: 1, basis: "exact" },
			{ id: "agent", kind: "exercise", methods: ["agent"], minActors: 1, basis: "exact" },
			{ id: "jobs", kind: "jobs", jobs: ["tests"] },
		],
		new Set(["exercise", "jobs"]),
	);
	for (let slot = 0; slot < 500; slot++) {
		expect(index.get("exercise")?.has("human")).toBe(true);
		expect(index.get("exercise")?.has("agent")).toBe(false);
	}
	expect([...(index.get("exercise") ?? [])]).toEqual(["auto", "human"]);
	// Only an exercise obligation a slot on the page names is indexed: not jobs, and not one no slot asks for.
	expect(index.has("jobs")).toBe(false);
	expect(index.has("agent")).toBe(false);
	expect(visited).toBe(methods.length);
	// Stored data with a repeated id: the first obligation with it decides, so a jobs one admits nothing.
	const repeated = obligationMethods(
		[
			{ id: "x", kind: "jobs", jobs: ["tests"] },
			{ id: "x", kind: "exercise", methods: ["human"], minActors: 1, basis: "exact" },
		],
		new Set(["x"]),
	);
	expect(repeated.has("x")).toBe(false);
});

test("a full slot page reads a stored large duplicate obligation", async () => {
	h = await harness();
	await h.call("propose", {
		edits: Array.from({ length: 500 }, (_, i) => ({
			op: "create",
			body: { title: `Legacy ${i}`, methods: ["human"] },
		})),
	});
	await h.call("plan", { name: "Legacy page", select: {} });
	const methods = [...Array.from({ length: 250_000 }, () => "auto"), "human"];
	await h.app.database.write((db) =>
		db.transaction(() =>
			db.run(
				sql<readonly SqlValue[]>(
					"UPDATE runs SET require = jsonb_set(require::jsonb, '{0,methods}', $1::text::jsonb)::text",
				),
				[JSON.stringify(methods)],
			),
		),
	);
	const page = await h.call<{ items: { methods: string[]; admittedMethods: string[] }[] }>("find", {
		in: "slots",
		run: "R-1",
		limit: 500,
	});
	expect(page.items).toHaveLength(500);
	expect(
		page.items.every(
			(slot) => JSON.stringify(slot.methods) === '["human"]' && JSON.stringify(slot.admittedMethods) === '["human"]',
		),
	).toBe(true);
});

test("new plans and case proposals store each method once", async () => {
	h = await harness();
	const methods = ["auto", "auto", "human", "auto", "agent", "human"];
	await h.call("propose", { edits: [{ op: "create", body: { title: "Compact", methods } }] });
	await h.call("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Updated", methods } }] });
	await h.call("plan", {
		name: "Compact",
		select: {},
		require: [{ id: "exercise", kind: "exercise", methods, minActors: 1, basis: "exact" }],
	});
	const stored = await h.app.database.read(async (db) => ({
		runs: await db.all(sql<readonly [], { require: string }>("SELECT require FROM runs")),
		proposals: await db.all(sql<readonly [], { edits: string }>("SELECT edits FROM proposals")),
		versions: await db.all(sql<readonly [], { body: string }>("SELECT body FROM versions")),
	}));
	expect(JSON.parse(stored.runs[0]?.require ?? "[]")[0].methods).toEqual(["auto", "human", "agent"]);
	for (const proposal of stored.proposals)
		expect(JSON.parse(proposal.edits)[0].body.methods).toEqual(["auto", "human", "agent"]);
	for (const version of stored.versions) expect(JSON.parse(version.body).methods).toEqual(["auto", "human", "agent"]);
});

for (const order of [
	["human", "agent"],
	["agent", "human"],
])
	test(`slot admitted methods follow their own obligation: ${order.join(",")}`, async () => {
		h = await harness();
		await h.call("propose", { edits: [{ op: "create", body: { title: "Both", methods: ["human", "agent"] } }] });
		await h.call("plan", {
			name: "Separate obligations",
			select: {},
			require: order.map((method) => ({
				id: method,
				kind: "exercise",
				methods: [method],
				minActors: 1,
				basis: "exact",
			})),
		});
		expect((await h.call<{ items: unknown[] }>("find", { in: "slots", run: "R-1" })).items).toMatchObject(
			order.map((method) => ({ case: "C-1", methods: ["human", "agent"], admittedMethods: [method] })),
		);
	});

test("large pinned bodies stay out of a 500-slot page", async () => {
	h = await harness();
	await h.call("propose", {
		edits: Array.from({ length: 500 }, (_, i) => ({ op: "create", body: { title: `Large ${i}`, methods: ["human"] } })),
	});
	await h.call("plan", {
		name: "Many obligations",
		select: {},
		require: Array.from({ length: 1 }, (_, i) => ({
			id: `exercise-${i}`,
			kind: "exercise",
			methods: ["human"],
			minActors: 1,
			basis: "exact",
		})),
	});
	await h.app.database.write((db) =>
		db.transaction(() =>
			db.run(
				sql<readonly SqlValue[]>(
					"UPDATE versions SET body = jsonb_set(jsonb_set(body::jsonb, '{methods}', $1::text::jsonb), '{pre}', to_jsonb(repeat('x', 4000000)))::text",
				),
				[JSON.stringify(Array.from({ length: 10000 }, () => "human"))],
			),
		),
	);
	const reply = await h.call<{ items: { methods: string[]; admittedMethods: string[] }[] }>("find", {
		in: "slots",
		run: "R-1",
		limit: 500,
	});
	const projection = declaredSql().find((q) => /AS pinned_(body|methods)/.test(q.text));
	expect(projection).toBeDefined();
	expect(projection?.text).not.toMatch(/SELECT c\.\*|\bbody\b/);
	expect(projection?.text).toContain("unnest");
	expect(reply.items).toHaveLength(500);
	expect(reply.items[0]).toMatchObject({ methods: ["human"], admittedMethods: ["human"] });
	expect(
		reply.items.every(
			(slot) => JSON.stringify(slot.methods) === '["human"]' && JSON.stringify(slot.admittedMethods) === '["human"]',
		),
	).toBe(true);
});

for (const corruption of ["missing", "json", "shape"])
	test(`slot metadata survives a ${corruption} pinned version`, async () => {
		h = await harness();
		await h.call("propose", { edits: [{ op: "create", body: { title: "Keep title", methods: ["human"] } }] });
		await h.call("plan", { name: "Damaged history", select: {} });
		await h.app.database.write((db) =>
			db.transaction(() =>
				corruption === "missing"
					? db.run(sql("UPDATE slots SET version = 999"))
					: db.run(sql<readonly SqlValue[]>("UPDATE versions SET body = $1, methods = '[]'"), [
							corruption === "json" ? "{" : JSON.stringify({ title: "Wrong shape", methods: "human" }),
						]),
			),
		);
		expect((await h.call<{ items: unknown[] }>("find", { in: "slots", run: "R-1" })).items).toMatchObject([
			{ case: "C-1", title: "Keep title", methods: [], admittedMethods: [] },
		]);
	});

test("counting sibling failures reads their standing in batches", async () => {
	h = await harness();
	const ci = await h.actor("pipeline", "ci", ["read", "record"]);
	await h.call(
		"report",
		{
			target: { commit: "sibling-standing", branch: "main" },
			results: Array.from({ length: 100 }, (_, index) => ({
				test: { key: `sibling-${index}` },
				outcome: "fail",
				failure: { message: "same cause" },
			})),
		},
		ci,
	);
	const project = await h.app.database.read((db) => findProject(db, "scratch"));
	if (!project) throw new Error("no project");
	const run = await h.app.database.read((db) => mustRun(db, project.id, "R-1"));
	h.app.database.resetStatementCount();
	const counted = await h.app.database.read((db) => countedTests(db, run));
	expect(counted).toHaveLength(100);
	expect(counted.every((row) => row.standing === "unexplained")).toBe(true);
	expect(h.app.database.statementCount).toBeLessThanOrEqual(12);
});

test("a large planned report rebuilds complete slot evidence in bounded reads", async () => {
	h = await harness();
	await seed(101);
	await h.call("plan", {
		name: "Two checks per case",
		select: { folders: ["checkout"] },
		require: ["first", "second"].map((id) => ({
			id,
			kind: "exercise",
			methods: ["human"],
			minActors: 1,
			basis: "exact",
		})),
	});
	h.app.database.resetStatementCount();
	await h.call("report", {
		run: "R-1",
		results: Array.from({ length: 101 }, (_, index) => ({
			test: { case: `C-${index + 1}` },
			outcome: index % 2 === 0 ? "pass" : "skip",
			steps: [{ step: "x1", outcome: index % 2 === 0 ? "pass" : "skip" }],
		})),
	});
	const statements = h.app.database.statementCount;
	const rows = (await h.call<{ items: Slot[] }>("find", { in: "slots", run: "R-1", limit: 300 })).items;
	expect(rows).toHaveLength(202);
	expect(rows.filter((slot) => slot.state === "satisfied")).toHaveLength(102);
	expect(rows.filter((slot) => slot.state === "skipped")).toHaveLength(100);
	expect(rows.every((slot) => slot.fills.length === 1 && slot.fills[0]?.admitted === "exact")).toBe(true);
	expect((await run("R-1")).tally).toMatchObject({ pass: 102, skipped: 100, missing: 100 });
	expect(statements).toBeLessThanOrEqual(1150);
});

test("slot batches retain complete trails, job lanes and fresh corrections across evidence slices", async () => {
	h = await harness();
	await seed(1);
	await h.call("plan", {
		name: "Two producers",
		select: { cases: ["C-1"] },
		require: [{ id: "exercise", kind: "exercise", methods: ["auto"], minActors: 2, basis: "exact" }],
	});
	const ci = await h.actor("pipeline", "ci", ["read", "record"]);
	const trail: ResultStep[] = [
		{ step: "x1", outcome: "pass", durationMs: 8, actions: [{ text: "Full trail", durationMs: 3 }] },
	];
	await h.call(
		"report",
		{
			run: "R-1",
			job: "alpha",
			results: Array.from({ length: 201 }, (_, index) => ({
				test: { key: `many-${index}` },
				annotation: { case: "C-1", version: 1 },
				outcome: "pass",
				steps: trail,
			})),
		},
		ci,
	);
	const slot = first(await slots("R-1"));
	expect(slot.state).toBe("missing");
	const before = await h.app.database.read((db) => fillsOf(db, slot.id));
	expect(before).toHaveLength(201);
	expect(before.every((fill) => fill.job === "alpha" && fill.admitted === "exact" && fill.atStep === null)).toBe(true);
	expect(before.map((fill) => fill.steps)).toEqual(Array.from({ length: 201 }, () => trail));
	expect(before.map((fill) => fill.ord)).toEqual(Array.from({ length: 201 }, (_, index) => index));
	const failureTrail: ResultStep[] = [
		{ step: "x1", outcome: "fail", actions: [{ text: "Retained failure detail", outcome: "fail" }] },
	];
	const failed = await h.call<ReportReceipt>(
		"report",
		{
			run: "R-1",
			job: "beta",
			results: [
				{ test: { key: "many-0" }, annotation: { case: "C-1", version: 1 }, outcome: "fail", steps: failureTrail },
			],
		},
		ci,
	);
	expect(first(await slots("R-1")).state).toBe("failing");
	await h.call(
		"report",
		{
			run: "R-1",
			job: "alpha",
			results: [{ test: { key: "many-0" }, annotation: { case: "C-1", version: 1 }, outcome: "pass" }],
		},
		ci,
	);
	expect(first(await slots("R-1")).state).toBe("failing");
	const held = await h.app.database.read((db) => fillsOf(db, slot.id));
	expect(held).toHaveLength(203);
	expect(held.find((fill) => fill.id === first(failed.results))).toMatchObject({
		job: "beta",
		outcome: "fail",
		atStep: "x1",
		steps: failureTrail,
	});
	await h.call(
		"report",
		{
			run: "R-1",
			job: "beta",
			results: [
				{
					test: { key: "many-0" },
					annotation: { case: "C-1", version: 1 },
					outcome: "pass",
					corrects: first(failed.results),
				},
			],
		},
		ci,
	);
	expect(first(await slots("R-1")).state).toBe("missing");
	const corrected = await h.app.database.read((db) => fillsOf(db, slot.id));
	expect(corrected).toHaveLength(203);
	expect(corrected.some((fill) => fill.id === first(failed.results))).toBe(false);
	expect((await run("R-1")).tally).toMatchObject({ missing: 1, unexplained: 0, disputed: 0 });
});

test("batched result standing preserves target priority, exact ties, null expiry and slot isolation", async () => {
	const fixture = await testDatabase({ schema: "empty" });
	const database = await Database.open({ url: fixture.url });
	try {
		await database.write((db) =>
			db.transaction(() =>
				db.exec(`
 CREATE TABLE excuses(project bigint,signature bigint,scope text,target bigint,decision bigint,class text,expires_at bigint);
 CREATE TABLE result_excuses(result bigint,slot bigint,decision bigint,class text,expires_at bigint);
 INSERT INTO excuses VALUES (1,1,'line:main',0,2,'excused',200),(1,1,'line:main',10,1,'attributed',NULL);
 INSERT INTO result_excuses VALUES (1,NULL,1,'excused',400),(2,NULL,3,'attributed',NULL),
 (3,NULL,3,'excused',300),(4,NULL,4,'excused',NULL),(5,NULL,5,'attributed',500),(6,3,999,'attributed',NULL);
 `),
			),
		);
		const requests = [
			{ id: 1, signature: 1, target: 10, scope: "line:main" },
			{ id: 2, signature: 1, target: 11, scope: "line:main" },
			{ id: 3, signature: 1, target: 10, scope: "line:main" },
			{ id: 4, signature: 2, target: 10, scope: "line:main" },
			{ id: 5, signature: null, target: 10, scope: "line:main" },
			{ id: 6, signature: 1, target: 10, scope: "line:elsewhere" },
			{ id: 7, signature: 1, target: 0, scope: "line:main" },
		];
		await database.read(async (db) => {
			const batch = await excusesForResults(db, 1, requests);
			expect([...batch].sort(([left], [right]) => left - right)).toEqual([
				[1, { decision: 1, class: "attributed", expires_at: null }],
				[2, { decision: 3, class: "attributed", expires_at: null }],
				[3, { decision: 3, class: "excused", expires_at: 300 }],
				[4, { decision: 4, class: "excused", expires_at: null }],
				[5, { decision: 5, class: "attributed", expires_at: 500 }],
				[7, { decision: 2, class: "excused", expires_at: 200 }],
			]);
			for (const row of requests)
				expect(batch.get(row.id) ?? null).toEqual(await excuseForResult(db, { ...row, project: 1 }, row.scope));
			expect(await excusesForResults(db, 1, [])).toEqual(new Map());
		});
	} finally {
		await database.close();
		await fixture.close();
	}
});

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
		expect(
			(
				await h.app.database.read(
					async (db) => await db.get(sql<readonly [], { n: number }>("SELECT count(*) AS n FROM results")),
				)
			)?.n,
		).toBe(2);
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
		expect(
			(
				await h.app.database.read(
					async (db) => await db.get(sql<readonly [], { v: number }>("SELECT basis_version AS v FROM results")),
				)
			)?.v,
		).toBe(1);
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
		const project = await h.app.database.read(async (db) => await findProject(db, "scratch"));
		if (!project) throw new Error("no project");
		const refs = async (ids: number[]) =>
			await mapAsync(
				ids,
				async (id) =>
					`R-${(await h.app.database.read(async (db) => await db.get(sql<readonly SqlValue[], { no: number }>("SELECT no FROM runs WHERE id = $1"), [id])))?.no}`,
			);
		expect(
			await refs(await h.app.database.read(async (db) => await plannedCounting(db, project.id, "zzzz0001"))),
		).toEqual(["R-6", "R-2", "R-7"]);
		expect(
			await refs(await h.app.database.read(async (db) => await plannedCounting(db, project.id, "aaaa0001"))),
		).toEqual(["R-3"]);
		expect(await h.app.database.read(async (db) => await plannedCounting(db, project.id, "absent01"))).toEqual([]);
		const horizons = async () =>
			await h.app.database.read(
				async (db) =>
					await db.all(
						sql<readonly [], { no: number; accepted_seq: number; applied_seq: number; outstanding: number }>(
							"SELECT no, accepted_seq, applied_seq, outstanding FROM runs WHERE origin = 'planned' ORDER BY no",
						),
					),
			);
		const before = await horizons();
		const inTx = async <T>(fn: (ctx: Ctx) => T): Promise<T> =>
			await h.app.database.write(
				async (db) =>
					await db.transaction(async () => {
						const ctx = makeCtx(h.app, db, project, h.owner, true);
						const result = await fn(ctx);
						await stampSeq(ctx);
						return result;
					}),
			);
		const batch = (await inTx(async (ctx) => await acceptReport(ctx, report("zzzz0001", "late")))).batch;
		const target = await h.app.database.read(async (db) => await mustTarget(db, batch.target));
		expect(
			(await inTx(async (ctx) => await runsFor(ctx, target, null, h.owner.kind))).map((row) => `R-${row.no}`),
		).toEqual(["R-5", "R-6", "R-2", "R-7"]);
		const waiting = await horizons();
		for (const no of [2, 6, 7])
			expect(waiting.find((row) => row.no === no)).toEqual({
				no,
				accepted_seq: batch.seq,
				applied_seq: first(before.filter((row) => row.no === no)).applied_seq,
				outstanding: 1,
			});
		for (const no of [3, 4]) expect(waiting.find((row) => row.no === no)).toEqual(before.find((row) => row.no === no));
		await inTx(async (ctx) => await processBatch(ctx, batch.id));
		const after = await horizons();
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
			await h.app.database.read(
				async (db) =>
					await db.all(
						sql<
							readonly SqlValue[],
							{ prior: number; supersedes: number; approval: number }
						>(`SELECT prior.no AS prior, next.supersedes, ended.supersedes AS approval FROM questions q
			 JOIN questions prior ON prior.id = q.prior JOIN decisions next ON next.id = q.decision
			 JOIN decisions ended ON ended.id = prior.decision WHERE q.no = $1`),
						[Number(replacement.q.slice(2))],
					),
			),
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
				const horizon = async () =>
					await h.app.database.read(
						async (db) =>
							await db.get(
								sql<readonly SqlValue[], { applied_seq: number; outstanding: number }>(
									"SELECT applied_seq, outstanding FROM runs WHERE no = $1",
								),
								[Number(planned.run.slice(2))],
							),
					);
				const before = await horizon();
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
				expect(await horizon()).toEqual(before);
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
			await h.app.database.read(
				async (db) =>
					await db.get(sql<readonly SqlValue[], { state: string }>("SELECT state FROM questions WHERE no = $1"), [
						Number(repeated.q.slice(2)),
					]),
			),
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
			const inTx = async <T>(fn: (ctx: Ctx) => T): Promise<T> =>
				await h.app.database.write(
					async (db) =>
						await db.transaction(async () => {
							const project = await findProject(db, "scratch");
							if (!project) throw new Error("no project");
							const ctx = makeCtx(h.app, db, project, h.owner, true);
							const result = await fn(ctx);
							await stampSeq(ctx);
							return result;
						}),
				);
			const batches = await mapAsync(
				[2, 3],
				async (attempt) => (await inTx(async (ctx) => await acceptReport(ctx, input(attempt)))).batch,
			);
			if (reverse) batches.reverse();
			expect(await h.call<GateStatus>("gate", { run: planned.run })).toMatchObject({
				verdict: "pending",
				stale: true,
				reason: "pending: 2 reports accepted and not yet applied",
			});
			await inTx(async (ctx) => await processBatch(ctx, first(batches).id));
			expect(await h.call<GateStatus>("gate", { run: planned.run })).toMatchObject({
				verdict: "pending",
				reason: "pending: 1 report accepted and not yet applied",
			});
			expect(first((await h.call<InboxReply>("inbox", { state: "decided", kind: "signoff" })).items).q).toBe(
				original.q,
			);
			await inTx(async (ctx) => await processBatch(ctx, first(batches.slice(1)).id));
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
		const lead = await h.actor("mira", "human", ["read", "produce", "answer", "plan"]);
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
		const agent = await h.actor("explorer", "agent", ["read", "produce"]);
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
		const agent = await h.actor("reviewer", "agent", ["read", "produce"]);
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
		const ci = await h.actor("deploy", "ci", ["record"]);
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
		const member = await h.actor("tester", "human", ["record"]);
		const agent = await h.actor("reviewer", "agent", ["record", "produce"]);
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
		const ci = await h.actor("tests", "ci", ["record"]);
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
		const ci = await h.actor("tests", "ci", ["record"]);
		const target = { build: "rc3", env: "staging" };
		const result = { test: { key: "checkout" }, annotation: { case: "C-1", version: 1 } };
		await h.call("report", { target, results: [{ ...result, outcome: "pass" }] }, ci);
		const project = await h.app.database.read(async (db) => await findProject(db, "scratch"));
		if (!project) throw new Error("no project");
		await h.app.database.write(
			async (db) =>
				await db.transaction(async () => {
					const ctx = makeCtx(h.app, db, project, ci, true);
					await acceptReport(ctx, {
						target,
						attempt: 2,
						results: [{ ...result, outcome: "fail", failure: { message: "artifact smoke failed" } }],
					});
					await stampSeq(ctx);
				}),
		);
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
		await recoverAccepted(h.app);
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
		const ci = await h.actor("smoke", "ci", ["record"]);
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
		const ci = await h.actor("retired-deployer", "ci", ["record"]);
		await h.call("announce", { deploy: "rc3", env: "staging", digest, code, cmd: "forgotten-deploy-1" }, ci);
		const forgotten = await h.call<{ forgotten: string }>("admin", { do: "actor.forget", name: "retired-deployer" });
		const saved = await h.app.database.read(
			async (db) =>
				await db.get(
					sql<readonly [], { outcome: string }>("SELECT outcome FROM commands WHERE id = 'forgotten-deploy-1'"),
				),
		);
		expect(JSON.parse(saved?.outcome ?? "{}")).toMatchObject({ by: forgotten.forgotten });
		expect((await h.call<{ items: unknown[] }>("find", { in: "deployments" })).items).toMatchObject([
			{ by: forgotten.forgotten, attestation: { by: forgotten.forgotten } },
		]);
	});

	test("an archive preserves the immutable build, its attestation and deployment history", async () => {
		await h.call("announce", { deploy: "rc3", env: "staging", digest, code });
		await h.call("announce", { deploy: "rc3", env: "production" });
		const chunks: string[] = [];
		await h.app.database.write(
			async (db) => await db.transaction(async () => await exportArchive(db, (chunk) => chunks.push(chunk))),
		);
		const restoredFixture = await testDatabase();
		const restored = await Database.open({ url: restoredFixture.url });
		try {
			await restored.write(async (db) => await importArchive(db, linesOf(chunks.join(""))));
			expect(
				await restored.read(
					async (db) =>
						await db.all(
							sql<readonly [], Record<string, unknown>>(
								"SELECT b.label, a.digest, a.code, d.env FROM deployments d JOIN builds b ON b.id = d.build JOIN artifacts a ON a.id = b.artifact ORDER BY d.id",
							),
						),
				),
			).toEqual([
				{ label: "rc3", digest, code: JSON.stringify(code), env: "staging" },
				{ label: "rc3", digest, code: JSON.stringify(code), env: "production" },
			]);
		} finally {
			await restored.close();
			await restoredFixture.close();
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
		let lastReportStatements = 0;
		for (let cycle = 1; cycle <= 101; cycle++) {
			await report(2 * cycle, "fail");
			const before = h.app.database.statementCount;
			await report(2 * cycle + 1, "pass");
			lastReportStatements = h.app.database.statementCount - before;
		}
		expect(lastReportStatements).toBeLessThan(500);
		expect((await run(planned.run)).state).toBe("open");
		const decided = (await h.call<InboxReply>("inbox", { state: "decided", kind: "signoff" })).items;
		expect(decided.map((q) => q.decision?.answer)).not.toContainEqual({ is: "approve" });
		expect(first((await h.call<InboxReply>("inbox", { kind: "signoff" })).items).evidence).toMatchObject({
			verdict: "passed",
		});
	}, 30_000);
});

async function mapAsync<T, R>(rows: readonly T[], callback: (value: T, index: number) => Promise<R>) {
	const out: R[] = [];
	for (const [index, row] of rows.entries()) out.push(await callback(row, index));
	return out;
}

test("batched run lanes leave the same rows as ordered scalar upserts", async () => {
	h = await harness();
	const outcomes = ["fail", "skip", "pass", "error", "blocked", "fail", "pass", "skip", "error"] as const;
	const attempts = [1, 2, 2, 2, 3, 3, 1, 4, 4];
	const writes: RunTestWrite[] = [];
	for (const [index, outcome] of outcomes.entries()) {
		const input = ciReport({ commit: "batch-lane-parity", n: 2, attempt: attempts[index] ?? 1 });
		const receipt = await h.call<ReportReceipt>("report", {
			...input,
			results: input.results.map((row) => ({
				...row,
				outcome,
				note: `observation ${index}`,
				...(outcome === "fail" || outcome === "error" ? { failure: { message: "same cause" } } : {}),
			})),
		});
		for (const id of receipt.results) {
			const result = await h.app.database.read(async (db) => await resultById(db, id));
			if (!result) throw new Error("missing parity result");
			const batch = await h.app.database.read(async (db) => await batchById(db, result.batch));
			if (!batch) throw new Error("missing parity batch");
			writes.push({
				run: 1,
				test: result.test,
				result: result.id,
				outcome: result.outcome,
				signature: result.signature,
				attempt: result.attempt,
				flipped: index % 2,
				lane: `${result.target}:${batch.job}:${result.actor}`,
				target: result.target,
			});
		}
	}
	const scalar = declaredSql().find(
		(statement) => statement.text.startsWith("INSERT INTO run_tests") && statement.text.includes("VALUES"),
	);
	if (!scalar?.names) throw new Error("missing scalar lane statement");
	const names = scalar.names;
	await h.app.database.write(
		async (db) =>
			await db.transaction(async () => {
				const clear = sql("DELETE FROM run_tests");
				const snapshot = sql<readonly [], RunTestWrite>("SELECT * FROM run_tests ORDER BY run, test, lane");
				await db.run(clear);
				for (const row of writes) {
					const params: Record<string, SqlValue> = { ...row };
					const values = names.map((name) => {
						const value = params[name];
						if (value === undefined) throw new Error(`missing ${name}`);
						return value;
					});
					await db.run(sql<readonly SqlValue[]>(scalar.text), values);
				}
				const expected = await db.all(snapshot);
				await db.run(clear);
				await upsertRunTests(db, writes);
				expect(await db.all(snapshot)).toEqual(expected);
				// The same replacement rules apply when a caller delivers several slices.
				await db.run(clear);
				for (let start = 0; start < writes.length; start += 5) await upsertRunTests(db, writes.slice(start, start + 5));
				expect(await db.all(snapshot)).toEqual(expected);
			}),
	);
});

test("obligation index stops once page ids resolve, including a jobs first match", () => {
	const obligations: Obligation[] = [
		{ id: "slot", kind: "jobs", jobs: ["ci"] },
		{ id: "slot", kind: "exercise", methods: ["human"], minActors: 1, basis: "exact" },
		...Array.from({ length: 100000 }, (_, i): Obligation => ({ id: `job-${i}`, kind: "jobs", jobs: ["ci"] })),
	];
	let visits = 0;
	obligations[Symbol.iterator] = function* (): Generator<Obligation, undefined> {
		for (let i = 0; i < this.length; i++) {
			visits++;
			const obligation = this[i];
			if (obligation) yield obligation;
		}
		return undefined;
	};
	expect(obligationMethods(obligations, new Set(["slot"])).size).toBe(0);
	expect(visits).toBe(1);
	visits = 0;
	expect(obligationMethods(obligations, new Set()).size).toBe(0);
	expect(visits).toBe(0);
});

test("new plans bound obligation and job counts", async () => {
	const { PlanInput } = await import("../src/core/selection.ts");
	const job = { id: "ci", kind: "jobs", jobs: ["test"] };
	expect(PlanInput.safeParse({ name: "bounded", select: {}, require: Array(1025).fill(job) }).success).toBe(false);
	expect(
		PlanInput.safeParse({ name: "bounded", select: {}, require: [{ ...job, jobs: Array(1025).fill("test") }] }).success,
	).toBe(false);
});
