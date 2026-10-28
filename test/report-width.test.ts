import { expect, test } from "bun:test";
import { jobOp } from "../src/server/ops/jobs.ts";
import { invokeService } from "../src/server/ops/registry.ts";
import { ciReport, harness } from "./helpers.ts";

test("wide reports commit before mapping all files, then durable pages finish them", async () => {
	const h = await harness({ unlinked: "create" });
	try {
		const input = ciReport({ commit: "wide001", n: 205 });
		input.results = input.results.map((r, i) => ({ ...r, test: { ...r.test, file: `file-${i}.ts` } }));
		const receipt = await h.call("report", input);
		expect(receipt.counts).toMatchObject({ total: 205 });
		const count = async () => (await h.call<{ items: unknown[] }>("find", { in: "cases", limit: 500 })).items.length;
		expect(await count()).toBe(100);
		expect(await invokeService(h.app, jobOp, { do: "drain" })).toMatchObject({ ok: true });
		expect(await count()).toBe(205);
		await invokeService(h.app, jobOp, { do: "drain" });
		expect(await count()).toBe(205);
	} finally {
		await h.close();
	}
}, 60_000);

for (const unlinked of ["ask", "track"] as const) {
	test(`deferred files are still asked about under ${unlinked}, with atomic retry`, async () => {
		const h = await harness({ unlinked });
		try {
			const input = ciReport({ commit: "wide002", n: 205 });
			input.results = input.results.map((r, i) => ({ ...r, test: { ...r.test, file: `file-${i}.ts` } }));
			await h.call("report", input);
			const pages = await h.app.database.read((db) =>
				db.allDynamic<{ id: string; input: string }>(
					"SELECT id,input FROM background_jobs WHERE kind='report-maps' ORDER BY queue_order",
				),
			);
			expect(pages.map((p) => JSON.parse(p.input).files.length)).toEqual([100, 5]);
			const first = pages[0];
			if (!first) throw new Error("missing page");
			const count = () =>
				h.app.database.read((db) =>
					db.allDynamic<{ n: number }>("SELECT count(*)::int AS n FROM questions WHERE kind='map'"),
				);
			expect(await count()).toEqual([{ n: 100 }]);
			const original = h.app.recordChange;
			h.app.recordChange = async () => {
				throw new Error("interrupted page");
			};
			try {
				await invokeService(h.app, jobOp, { do: "run", id: first.id });
			} finally {
				h.app.recordChange = original;
			}
			expect(await count()).toEqual([{ n: 100 }]);
			h.advance(60_001);
			expect(await invokeService(h.app, jobOp, { do: "run", id: first.id })).toMatchObject({
				ok: true,
				result: { ran: 1 },
			});
			expect(await count()).toEqual([{ n: 200 }]);
			expect(await invokeService(h.app, jobOp, { do: "run", id: first.id })).toMatchObject({
				ok: true,
				result: { ran: 0 },
			});
			await invokeService(h.app, jobOp, { do: "drain" });
			expect(await count()).toEqual([{ n: 205 }]);
		} finally {
			await h.close();
		}
	}, 60_000);
}

test("deferred creation keeps the producer's adoption policy", async () => {
	const h = await harness({ preset: "standard", unlinked: "create" });
	try {
		const actor = await h.actor("reporter", "agent", ["record"]);
		const input = ciReport({ commit: "agent-wide", n: 101 });
		input.results = input.results.map((r, i) => ({ ...r, test: { ...r.test, file: `agent-${i}.ts` } }));
		await h.call("report", input, actor);
		await invokeService(h.app, jobOp, { do: "drain" });
		expect((await h.call<{ items: unknown[] }>("find", { in: "cases" })).items).toHaveLength(0);
		const questions = await h.app.database.read((db) =>
			db.allDynamic<{ n: number }>("SELECT count(*)::int AS n FROM questions WHERE kind='map' AND state='open'"),
		);
		expect(questions).toEqual([{ n: 101 }]);
	} finally {
		await h.close();
	}
}, 60_000);

test("a later report may finish a deferred file before its page arrives", async () => {
	const h = await harness({ unlinked: "create" });
	try {
		const input = ciReport({ commit: "race-wide", n: 101 });
		input.results = input.results.map((r, i) => ({ ...r, test: { ...r.test, file: `race-${i}.ts` } }));
		await h.call("report", input);
		await h.call("report", ciReport({ commit: "race-next", n: 1, file: "race-100.ts" }));
		const before = await h.app.database.read((db) => db.allDynamic("SELECT id,case_id FROM tests ORDER BY id"));
		await invokeService(h.app, jobOp, { do: "drain" });
		expect(await h.app.database.read((db) => db.allDynamic("SELECT id,case_id FROM tests ORDER BY id"))).toEqual(
			before,
		);
		expect((await h.call<{ items: unknown[] }>("find", { in: "cases", limit: 500 })).items).toHaveLength(102);
	} finally {
		await h.close();
	}
}, 60_000);
