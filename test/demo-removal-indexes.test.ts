import { expect, test } from "bun:test";
import type { SqlValue, WriteDb } from "../src/server/kernel/db.ts";
import { removalPlan, removeProject, removeProjectSlice } from "../src/server/transfer/transfer.ts";
import { removalFixture } from "./demo-removal-fixture.ts";
import { writerDatabase } from "./pg-scopes.ts";

const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
test("ordinary nullable reference lookups use the retained partial indexes", async () => {
	await using db = await writerDatabase();
	await db.transaction(async () => {
		await db.exec("SET LOCAL enable_seqscan = off");
		for (const [table, column, index] of [
			["results", "corrects", "results_corrects"],
			["results", "quarantine_exit", "results_quarantine_exit"],
			["result_excuses", "slot", "result_excuses_slot"],
		]) {
			const plan = await db.allDynamic<{ "QUERY PLAN": string }>(`EXPLAIN SELECT 1 FROM ${table} WHERE ${column} = 1`);
			expect(plan.some((row) => row["QUERY PLAN"].includes(index ?? "missing"))).toBe(true);
			expect(
				await db.allDynamic(
					"SELECT indexname FROM pg_indexes WHERE indexname = $1 AND indexdef LIKE '%WHERE%IS NOT NULL%'",
					[index ?? ""],
				),
			).toHaveLength(1);
		}
	});
	await removalFixture(db, 1);
	expect((await removeProject(db, "removing")).tables.results).toBe(1);
	expect(await db.allDynamic("SELECT key FROM projects")).toEqual([{ key: "retained" }]);
});

for (const nested of [false, true])
	test(`removal rolls back a cross-project reference, nested=${nested}`, async () => {
		await using db = await writerDatabase();
		await removalFixture(db, 2);
		await db.transaction(() => db.exec("UPDATE results SET corrects = 1 WHERE project = 901"));
		const attempt = async () => {
			await expect(removeProject(db, "removing")).rejects.toThrow(/foreign key/i);
			expect(
				await db.allDynamic("SELECT project, count(*) AS n FROM results GROUP BY project ORDER BY project"),
			).toEqual([
				{ project: 900, n: 2 },
				{ project: 901, n: 2 },
			]);
		};
		if (nested) await db.transaction(attempt);
		else await attempt();
		expect(db.inTransaction).toBe(false);
	});

for (const action of ["finish", "cancel", "violate"] as const)
	test(`the reset checks later writes and restores data on ${action}`, async () => {
		await using db = await writerDatabase();
		await removalFixture(db, 2);
		const run = () =>
			db.transaction(async () => {
				const steps = db.checkedBulkSteps(async function* () {
					await removeProject(db, "removing", undefined, "deferred");
					yield;
					if (action === "violate") await db.exec("UPDATE results SET corrects = 1 WHERE project = 901");
				});
				expect(await steps.next()).toEqual({ value: undefined, done: false });
				expect(await db.allDynamic("SELECT key FROM projects")).toEqual([{ key: "retained" }]);
				if (action === "cancel") await steps.return(undefined);
				else expect(await steps.next()).toEqual({ value: undefined, done: true });
			});
		if (action === "violate") await expect(run()).rejects.toThrow(/foreign key/i);
		else await run();
		expect(await db.allDynamic("SELECT count(*) AS n FROM results")).toEqual([{ n: action === "finish" ? 2 : 4 }]);
		expect(db.inTransaction).toBe(false);
	});

test("every incoming reset reference has an index for its foreign key lookup", async () => {
	await using db = await writerDatabase();
	await removalFixture(db, 2, 20_000);
	const parents = new Set<string>();
	await removeProject(db, "removing", (step) => {
		if (step.startsWith("delete ")) parents.add(step.slice(7));
	});
	const probes = new Set<string>();
	await db.transaction(async () => {
		await db.exec("SET LOCAL enable_seqscan = off");
		for (const table of await db.catalog())
			for (const key of table.foreignKeys) {
				if (!parents.has(key.parent)) continue;
				const plan = await db.allDynamic<{ "QUERY PLAN": string }>(
					`EXPLAIN SELECT 1 FROM ${identifier(table.name)} WHERE ${key.columns.map((column) => `${identifier(column)} = -1`).join(" AND ")}`,
				);
				expect(
					plan.some((row) => /Index|Bitmap/.test(row["QUERY PLAN"])),
					`${table.name}.${key.columns.join(",")} -> ${key.parent}`,
				).toBe(true);
				probes.add(`${table.name}.${key.columns.join(",")} -> ${key.parent}`);
			}
	});
	expect(probes.has("change_ends.receipt -> merge_receipts")).toBe(true);
});

// A slice that scans a whole table reads every other project's rows too, on every later slice (#914).
test("every statement a removal slice issues reads by index, never by a scan of the whole table", async () => {
	await using db = await writerDatabase();
	await removalFixture(db, 40);
	const plan = await removalPlan(db);
	const scans = new Set<string>();
	let explained = 0;
	const explain = async (text: string, params: readonly SqlValue[] = []) => {
		// The slice's own reads and deletes, under its planner settings; not the settings it sets and restores.
		if (!/^\s*(SELECT|DELETE)\b/.test(text) || /current_setting|set_config/.test(text)) return;
		explained++;
		for (const { "QUERY PLAN": line } of await db.allDynamic<{ "QUERY PLAN": string }>(`EXPLAIN ${text}`, params))
			if (line.includes("Seq Scan")) scans.add(`${line.trim()}: ${text.slice(0, 160)}`);
	};
	const traced = new Proxy(db, {
		get(target, name, receiver) {
			if (name === "allDynamic")
				return async (text: string, params?: readonly SqlValue[]) => {
					await explain(text, params);
					return target.allDynamic(text, params);
				};
			if (name === "runDynamic")
				return async (text: string, params?: readonly SqlValue[]) => {
					await explain(text, params);
					return target.runDynamic(text, params);
				};
			const value: unknown = Reflect.get(target, name, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	let slices = 0;
	while (!(await removeProjectSlice(traced, "removing", 16, plan)).done) slices++;
	expect(slices).toBeGreaterThan(3);
	expect(explained).toBeGreaterThan(100);
	expect([...scans]).toEqual([]);
	expect(await db.allDynamic("SELECT key FROM projects")).toEqual([{ key: "retained" }]);
});

// A drain skips tables it has emptied. A row written to one meanwhile would stop the project's own deletion, or, in a
// table no foreign key ties to the project (as `search_docs`), outlive it, if nothing read that table again.
test("a drain that skips emptied tables still removes a row written to one before the project goes", async () => {
	await using db = await writerDatabase();
	await removalFixture(db, 8);
	await db.transaction(() =>
		db.exec(`CREATE TABLE a_note (id bigint PRIMARY KEY, project bigint NOT NULL REFERENCES projects (id) DEFERRABLE);
			CREATE INDEX a_note_project ON a_note (project);
			INSERT INTO a_note VALUES (1, 900)`),
	);
	const plan = await removalPlan(db);
	while (!plan.empty.has("a_note")) expect((await removeProjectSlice(db, "removing", 4, plan)).done).toBe(false);
	await db.transaction(() => db.exec("INSERT INTO a_note VALUES (2, 900)"));
	let slices = 0;
	while (!(await removeProjectSlice(db, "removing", 4, plan)).done) slices++;
	expect(slices).toBeGreaterThan(0);
	expect(await db.allDynamic("SELECT id FROM a_note")).toEqual([]);
	expect(await db.allDynamic("SELECT key FROM projects")).toEqual([{ key: "retained" }]);
});

/**
 * The index entries and rows the current transaction has read from the database's own tables, by PostgreSQL's
 * counters for the transaction: what a statement examined, whatever plan it took.
 */
async function examined(db: WriteDb): Promise<number> {
	const [row] = await db.allDynamic<{ n: string }>(
		`SELECT coalesce(sum(pg_stat_get_xact_tuples_returned(c.oid) + pg_stat_get_xact_tuples_fetched(c.oid)), 0)::text AS n
		 FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
		 WHERE c.relkind IN ('r', 'i') AND s.nspname NOT IN ('pg_catalog', 'information_schema') AND s.nspname NOT LIKE 'pg_toast%'`,
	);
	return Number(row?.n ?? 0);
}

/**
 * The most a drain's slice of a table owned through `results` examines, removing a demo whose `parents` results each
 * have an excuse. The slices of other tables are not counted: removing the results themselves, and the first look past
 * their removed index entries, are work in proportion to the demo's own rows, once.
 */
async function largestSlice(parents: number): Promise<{ largest: number; slices: number }> {
	await using db = await writerDatabase();
	await removalFixture(db, parents, 10);
	await db.transaction(async () => {
		await db.exec(`
			INSERT INTO questions (id, project, no, kind, subject, fingerprint, title, producer, evidence,
				evidence_hash, basis, seen_first, seen_last, ask, blocks, rank, state, opened_at, rev)
				VALUES (901, 900, 1, 'failure', '{}', 'failure', 'Failure', 'ci', '{}', 'hash', '{}',
				1, 1, '{}', '[]', 1, 'decided', 1, 1);
			INSERT INTO decisions (id, project, question, kind, answer, signers, basis, holds, at, seq)
				VALUES (901, 900, 901, 'failure', '{}', '[]', '{}', '{}', 1, 1);`);
		await db.runDynamic(
			"INSERT INTO result_excuses (result, decision, class) SELECT n, 901, 'excused' FROM generate_series(1, $1::bigint) n",
			[parents],
		);
		await db.exec("ANALYZE");
	});
	const plan = await removalPlan(db);
	let largest = 0;
	let slices = 0;
	for (let done = false; !done; )
		await db.transaction(async () => {
			const before = await examined(db);
			const slice = await removeProjectSlice(db, "removing", 32, plan);
			done = slice.done;
			if (slice.table !== "result_excuses" && slice.table !== "attachments") return;
			slices++;
			largest = Math.max(largest, (await examined(db)) - before);
		});
	expect(await db.allDynamic("SELECT key FROM projects")).toEqual([{ key: "retained" }]);
	expect(await db.allDynamic("SELECT count(*) AS n FROM result_excuses")).toEqual([{ n: 10 }]);
	return { largest, slices };
}

// A table owned through a parent (an excuse through its result) was read as `result = ANY(ARRAY(SELECT id FROM results
// WHERE project = $1))`: every slice gathered all the demo's parents again, so the work grew with their square.
test("a slice of a table owned through its parents examines a bounded number of rows however many parents there are", async () => {
	const small = await largestSlice(400);
	const large = await largestSlice(4_000);
	console.log(
		`largest slice of a parent-owned table: ${small.largest} rows and index entries for 400 parents (${small.slices} slices), ${large.largest} for 4000 (${large.slices} slices)`,
	);
	expect(large.slices).toBeGreaterThan(small.slices * 5);
	expect(large.largest).toBeLessThan(small.largest * 1.5);
	expect(large.largest).toBeLessThan(2_000);
}, 120_000);

// The batch of ancestors a slice reads must come from an index in (project, id) order, so it stops at the batch's end:
// otherwise it sorts every one of the project's ancestors, or walks the primary key past every other project's rows.
test("every ancestor a slice reads in batches has an index in project and id order", async () => {
	await using db = await writerDatabase();
	const plan = await removalPlan(db);
	const ancestors = [
		...new Set(plan.tables.flatMap((table) => (table.owner?.by === "parents" ? [table.owner.ancestor] : []))),
	].sort();
	expect(ancestors).toContain("runs");
	const unordered: string[] = [];
	await db.transaction(async () => {
		await db.exec("SET LOCAL enable_seqscan = off; SET LOCAL enable_bitmapscan = off");
		for (const ancestor of ancestors) {
			const lines = (
				await db.allDynamic<{ "QUERY PLAN": string }>(
					`EXPLAIN SELECT id FROM ${identifier(ancestor)} WHERE project = 1 AND id > 0 ORDER BY project, id LIMIT 256`,
				)
			).map((row) => row["QUERY PLAN"]);
			if (lines.some((line) => /Sort/.test(line)) || !lines.some((line) => /Index Cond: .*project = /.test(line)))
				unordered.push(`${ancestor}: ${lines.join(" / ")}`);
		}
	});
	expect(unordered).toEqual([]);
});
