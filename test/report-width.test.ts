import { expect, test } from "bun:test";
import { jobOp } from "../src/server/ops/jobs.ts";
import { invokeService } from "../src/server/ops/registry.ts";
import { exportArchive, importArchive, linesOf, removeBootstrap } from "../src/server/transfer/transfer.ts";
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
					"SELECT j.id,p.files AS input FROM background_jobs j JOIN report_map_pages p ON p.id=j.input::jsonb->>'page' WHERE j.kind='report-maps' ORDER BY j.queue_order",
				),
			);
			expect(pages.map((p) => JSON.parse(p.input).length)).toEqual([100, 5]);
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

for (const project of [undefined, "scratch"]) {
	for (const unlinked of ["create", "ask", "track"] as const) {
		test(`restore deferred report maps: ${project ?? "instance"}, ${unlinked}`, async () => {
			const from = await harness({ unlinked });
			const to = await harness();
			try {
				const input = ciReport({ commit: "restore-wide", n: 101 });
				input.results = input.results.map((r, i) => ({ ...r, test: { ...r.test, file: `restore-${i}.ts` } }));
				await from.call("report", input);
				const chunks: string[] = [];
				await from.app.database.read((db) =>
					exportArchive(
						db,
						(chunk) => {
							chunks.push(chunk);
						},
						project === undefined ? {} : { project },
					),
				);
				await to.app.database.write((db) =>
					db.transaction(async () => {
						await db.exec("DELETE FROM commands");
						await removeBootstrap(db);
						await importArchive(db, linesOf(chunks.join("")));
					}),
				);
				await invokeService(to.app, jobOp, { do: "drain" });
				const counts = () =>
					to.app.database.read((db) =>
						db.allDynamic<{ n: number }>("SELECT count(*)::int AS n FROM questions WHERE kind='map'"),
					);
				expect(await counts()).toEqual([{ n: 101 }]);
				if (unlinked === "create")
					expect(
						await to.app.database.read((db) =>
							db.allDynamic("SELECT count(DISTINCT case_id)::int AS n FROM tests WHERE case_id IS NOT NULL"),
						),
					).toEqual([{ n: 101 }]);
				await invokeService(to.app, jobOp, { do: "drain" });
				expect(await counts()).toEqual([{ n: 101 }]);
				expect(
					await to.app.database.read((db) => db.allDynamic("SELECT count(*)::int AS n FROM report_map_pages")),
				).toEqual([{ n: 0 }]);
			} finally {
				await from.close();
				await to.close();
			}
		}, 60_000);
	}
}

test("migration 7 preserves unfinished mapping jobs from schema 6", async () => {
	const h = await harness({ unlinked: "create" });
	try {
		const input = ciReport({ commit: "upgrade-wide", n: 101 });
		input.results = input.results.map((r, i) => ({ ...r, test: { ...r.test, file: `upgrade-${i}.ts` } }));
		await h.call("report", input);
		await h.app.database.write((db) =>
			db.transaction(async () => {
				await db.exec(`UPDATE background_jobs j SET input=jsonb_build_object('project',p.project,'producer',p.producer,'files',p.files::jsonb)::text FROM report_map_pages p WHERE j.input::jsonb->>'page'=p.id;
    DROP TABLE report_map_pages;
    UPDATE meta SET value='6' WHERE key='schema_version';
    UPDATE meta SET value='43' WHERE key='archive_version';`);
			}),
		);
		await (await import("../src/server/kernel/migrate.ts")).migrate(h.app.database);
		await invokeService(h.app, jobOp, { do: "drain" });
		expect(
			await h.app.database.read((db) =>
				db.allDynamic("SELECT count(DISTINCT case_id)::int AS n FROM tests WHERE case_id IS NOT NULL"),
			),
		).toEqual([{ n: 101 }]);
	} finally {
		await h.close();
	}
}, 60_000);
