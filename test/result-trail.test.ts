import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import type { ResultStep } from "../src/core/results.ts";
import { dropResetIndexes } from "./demo-removal-fixture.ts";
import { dropReceiptSchema, type Harness, harness } from "./helpers.ts";

let h: Harness;
afterEach(() => h?.close());
const trail: ResultStep[] = [
	{ step: "s1", outcome: "pass", durationMs: 0, actions: [{ text: "Open the cart", outcome: "pass", durationMs: 0 }] },
	{
		step: "s2",
		outcome: "error",
		durationMs: 2400,
		actions: [
			{ text: 'send_keys("ENTER")', durationMs: 2300 },
			{ text: "Observe timeout", outcome: "error" },
		],
	},
];

test("get returns every action and time unchanged, derives the failed step, and replays once", async () => {
	h = await harness();
	const input = {
		target: { session: "trail" },
		results: [
			{ test: { key: "checkout" }, outcome: "error", failure: { message: "Timeout", at: "wrong" }, steps: trail },
		],
	};
	await h.call("report", input);
	const [read] = await h.call<{ last: { steps: unknown; atStep: string }[] }[]>("get", { refs: ["T-1"] });
	expect(read?.last[0]?.steps).toEqual(trail);
	expect(read?.last[0]?.atStep).toBe("s2");
	expect((await h.call("report", input)).fresh).toBe(false);
});

test.each([
	["100 steps per result", Array.from({ length: 101 }, () => ({ step: "s1", outcome: "pass", actions: [] }))],
	[
		"100 actions per step",
		[{ step: "s1", outcome: "pass", actions: Array.from({ length: 101 }, () => ({ text: "Click" })) }],
	],
	["2000 characters per action", [{ step: "s1", outcome: "pass", actions: [{ text: "x".repeat(2001) }] }]],
	["160 characters per step", [{ step: "x".repeat(161), outcome: "pass", actions: [] }]],
	[
		"65536 bytes per result trail",
		[{ step: "s1", outcome: "pass", actions: Array.from({ length: 40 }, () => ({ text: "x".repeat(2000) })) }],
	],
])("a report exceeding %s is refused before acceptance", async (limit, steps) => {
	h = await harness();
	const reply = await h.raw("report", {
		target: { session: "limit" },
		results: [{ test: { key: "checkout" }, outcome: "pass", steps }],
	});
	expect(reply).toMatchObject({ ok: false, error: { code: "invalid", message: expect.stringContaining(limit) } });
	expect(h.app.db.raw.query("SELECT count(*) AS n FROM batches").get()).toEqual({ n: 0 });
});

test("a screenshot index must name one of this result's attachments", async () => {
	h = await harness();
	expect(
		await h.raw("report", {
			target: { session: "shot" },
			results: [
				{
					test: { key: "checkout" },
					outcome: "pass",
					steps: [{ step: "s1", outcome: "pass", actions: [], attachment: 0 }],
				},
			],
		}),
	).toMatchObject({ ok: false, error: { code: "invalid", message: expect.stringContaining("attachment index") } });
});

test("an empty trail has no failed step; an absent trail keeps a runner's failure location", async () => {
	h = await harness();
	await h.call("report", {
		target: { session: "empty" },
		results: [
			{ test: { key: "empty" }, outcome: "fail", failure: { message: "Oops", at: "s1" }, steps: [] },
			{ test: { key: "absent" }, outcome: "fail", failure: { message: "Oops", at: "s1" } },
		],
	});
	const rows = await h.call<{ last: { steps: unknown; atStep: string | null }[] }[]>("get", { refs: ["T-1", "T-2"] });
	expect(rows.map((row) => ({ steps: row.last[0]?.steps, atStep: row.last[0]?.atStep }))).toEqual([
		{ steps: [], atStep: null },
		{ steps: null, atStep: "s1" },
	]);
});

test("a rich trail survives a real HTTP report and CLI get JSON unchanged", async () => {
	const { withInstance } = await import("../src/cli/test-support.ts");
	await withInstance(async ({ client, cli }) => {
		const receipt = await client.call("report", {
			target: { session: "wire-trail" },
			results: [{ test: { key: "wire-trail" }, outcome: "error", steps: trail }],
		});
		expect(receipt.counts.total).toBe(1);
		const http = await client.call("get", { refs: ["T-1"] });
		expect(
			z.array(z.object({ last: z.array(z.object({ steps: z.unknown() })) })).parse(http)[0]?.last[0]?.steps,
		).toEqual(trail);
		const read = await cli(["get", "T-1", "--project", "scratch", "--json"]);
		expect(read.code).toBe(0);
		expect(JSON.parse(read.stdout)[0].last[0].steps).toEqual(trail);
		await expect(
			client.call("report", {
				target: { session: "over" },
				results: [
					{
						test: { key: "too-large" },
						outcome: "pass",
						steps: Array.from({ length: 101 }, () => ({ step: "s1", outcome: "pass" })),
					},
				],
			}),
		).rejects.toThrow("100 steps per result");
	});
});

test("trail limits include UTF-8 bytes and the whole report", async () => {
	h = await harness();
	const steps = [
		{ step: "s1", outcome: "pass", actions: Array.from({ length: 30 }, () => ({ text: "界".repeat(1000) })) },
	];
	expect(
		await h.raw("report", {
			target: { session: "utf8" },
			results: [{ test: { key: "utf8" }, outcome: "pass", steps }],
		}),
	).toMatchObject({ ok: false, error: { message: expect.stringContaining("65536 bytes per result trail") } });
	const bounded = [
		{ step: "s1", outcome: "pass", actions: Array.from({ length: 30 }, () => ({ text: "x".repeat(2000) })) },
	];
	expect(
		await h.raw("report", {
			target: { session: "total" },
			results: Array.from({ length: 18 }, (_, i) => ({ test: { key: `test-${i}` }, outcome: "pass", steps: bounded })),
		}),
	).toMatchObject({ ok: false, error: { message: expect.stringContaining("1048576 bytes of trails per report") } });
});

test("migration preserves old simple trails and recovery preserves accepted rich ones", async () => {
	h = await harness();
	await h.call("report", {
		target: { session: "old" },
		results: [{ test: { key: "old" }, outcome: "fail", steps: [{ step: "a1.b2", outcome: "fail" }] }],
	});
	dropResetIndexes(h.app.db);
	dropReceiptSchema(h.app.db);
	h.app.db.exec(
		"DROP TABLE assertion_seen; DROP TABLE assertion_spreads; DROP TABLE assertion_roots; DROP TABLE assertion_index; DROP INDEX results_assertion_rebuild; DROP INDEX flips_first_try; DROP INDEX flips_second_try; ALTER TABLE flips DROP COLUMN first_try; ALTER TABLE flips DROP COLUMN second_try; DROP TABLE result_tries; DROP TABLE handoffs; DROP INDEX change_ends_landing; ALTER TABLE change_ends DROP COLUMN landing_branch; ALTER TABLE change_ends DROP COLUMN landing_repo; ALTER TABLE change_ends DROP COLUMN landing_commit; DROP INDEX projects_identity; ALTER TABLE projects DROP COLUMN identity; ALTER TABLE results RENAME COLUMN trail TO steps; UPDATE meta SET value = '33' WHERE key = 'schema_version'",
	);
	const { migrate } = await import("../src/server/kernel/migrate.ts");
	migrate(h.app.db, ":memory:");
	expect(
		(await h.call<{ last: { steps: unknown; atStep: string }[] }[]>("get", { refs: ["T-1"] }))[0]?.last[0],
	).toMatchObject({
		steps: [{ step: "a1.b2", outcome: "fail" }],
		atStep: "a1.b2",
	});
	const { acceptReport } = await import("../src/server/ops/writes.ts");
	const { findProject, makeCtx, stampSeq } = await import("../src/server/kernel/ctx.ts");
	const { recoverAccepted } = await import("../src/server/ops/jobs.ts");
	h.app.db.transaction(() => {
		const project = findProject(h.app.db, "scratch");
		if (!project) throw new Error("missing project");
		const ctx = makeCtx(h.app, project, h.owner, true);
		acceptReport(ctx, {
			target: { session: "accepted" },
			results: [{ test: { key: "rich" }, outcome: "error", steps: trail }],
		});
		stampSeq(ctx);
	});
	expect(recoverAccepted(h.app)).toBe(1);
	expect((await h.call<{ last: { steps: unknown }[] }[]>("get", { refs: ["T-2"] }))[0]?.last[0]?.steps).toEqual(trail);
	expect(recoverAccepted(h.app)).toBe(0);
});

test("screenshots keep their input index after later files append, and non-images are refused", async () => {
	h = await harness();
	const png = {
		name: "cart.png",
		data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWhoAAAAASUVORK5CYII=",
	};
	const input = {
		target: { session: "image" },
		results: [
			{
				test: { key: "image" },
				outcome: "pass",
				attachments: [{ name: "trace.txt", data: "bG9n" }, png],
				steps: [{ step: "a1.b2", outcome: "pass", attachment: 1 }],
			},
		],
	};
	const receipt = await h.call<{ results: number[] }>("report", input);
	const result = receipt.results[0];
	await h.call("attach", { result, attachment: { name: "later.txt", data: "bGF0ZXI=" } });
	const listed = await h.call<{ items: { name: string }[] }>("attachment", { result });
	expect(listed.items.map((file) => file.name)).toEqual(["trace.txt", "cart.png", "later.txt"]);
	expect((await h.call<{ last: { steps: unknown }[] }[]>("get", { refs: ["T-1"] }))[0]?.last[0]?.steps).toEqual([
		{ step: "a1.b2", outcome: "pass", attachment: 1 },
	]);
	expect(
		await h.raw("report", {
			...input,
			results: [{ ...input.results[0], steps: [{ step: "s1", outcome: "pass", attachment: 0 }] }],
		}),
	).toMatchObject({ ok: false, error: { code: "invalid", message: "A step screenshot attachment must be an image" } });
});

test.each([-1, 0.5, Number.POSITIVE_INFINITY, Number.NaN])(
	"step and action durations refuse %s",
	async (durationMs) => {
		h = await harness();
		for (const steps of [
			[{ step: "s1", outcome: "pass", durationMs }],
			[{ step: "s1", outcome: "pass", actions: [{ text: "Click", durationMs }] }],
		]) {
			expect(
				await h.raw("report", {
					target: { session: "bad-time" },
					results: [{ test: { key: "bad-time" }, outcome: "pass", steps }],
				}),
			).toMatchObject({ ok: false, error: { code: "invalid" } });
		}
	},
);
