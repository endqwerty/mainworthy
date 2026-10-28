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

// A drain reads each table once: a retired demo takes no writes (the registry refuses them), so a table the drain has
// emptied stays empty and nothing reads it again (#914). A row that appears anyway, here by hand, stops the project's
// own deletion through its foreign key, which rolls that slice back, and a new drain, which reads every table afresh,
// removes it.
test("a row written to a table after the drain emptied it stops the project's deletion until a new drain", async () => {
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
	const drain = async (each: typeof plan) => {
		while (!(await removeProjectSlice(db, "removing", 4, each)).done);
	};
	await expect(drain(plan)).rejects.toThrow(/foreign key/i);
	expect(await db.allDynamic("SELECT id FROM a_note")).toEqual([{ id: 2 }]);
	await drain(await removalPlan(db));
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
 * The most a drain's slice of one of `tables` (or of any table, `every`) examines, removing a demo that `fill` adds to
 * the removal fixture. Autovacuum is off for every table, so what the drain removes stays behind in the indexes, as it
 * does when maintenance lags.
 */
async function largestSlice(
	fill: (db: WriteDb) => Promise<void>,
	tables: readonly string[] | "every",
	batch?: number,
): Promise<{ largest: number; slices: number; total: number; last: number }> {
	await using db = await writerDatabase();
	await removalFixture(db, 1, 10);
	await db.transaction(async () => {
		for (const table of await db.catalog())
			await db.exec(`ALTER TABLE ${identifier(table.name)} SET (autovacuum_enabled = false)`);
		await fill(db);
		await db.exec("ANALYZE");
	});
	const plan = await removalPlan(db, batch);
	let largest = 0;
	let total = 0;
	let last = 0;
	let slices = 0;
	for (let done = false; !done; )
		await db.transaction(async () => {
			const before = await examined(db);
			const slice = await removeProjectSlice(db, "removing", 32, plan);
			done = slice.done;
			if (tables !== "every" && !tables.includes(slice.table ?? "")) return;
			slices++;
			const read = (await examined(db)) - before;
			largest = Math.max(largest, read);
			total += read;
			last = read;
		});
	expect(await db.allDynamic("SELECT key FROM projects")).toEqual([{ key: "retained" }]);
	expect(await db.allDynamic("SELECT count(*) AS n FROM result_excuses")).toEqual([{ n: 10 }]);
	return { largest, slices, total, last };
}

/** `parents` more results of the demo, each with an excuse. */
const excusedResults = (parents: number) => async (db: WriteDb) => {
	await db.exec(`
		INSERT INTO questions (id, project, no, kind, subject, fingerprint, title, producer, evidence,
			evidence_hash, basis, seen_first, seen_last, ask, blocks, rank, state, opened_at, rev)
			VALUES (901, 900, 1, 'failure', '{}', 'failure', 'Failure', 'ci', '{}', 'hash', '{}',
			1, 1, '{}', '[]', 1, 'decided', 1, 1);
		INSERT INTO decisions (id, project, question, kind, answer, signers, basis, holds, at, seq)
			VALUES (901, 900, 901, 'failure', '{}', '[]', '{}', '{}', 1, 1);`);
	await db.runDynamic(
		`INSERT INTO results (id, project, test, seq, ord, batch, target, method, actor, basis, outcome, at)
		 SELECT 100000 + n, 900, 900, 1, n, 900, 900, 'auto', 900, 'unresolved', 'fail', 1 FROM generate_series(1, $1::bigint) n`,
		[parents],
	);
	await db.runDynamic(
		"INSERT INTO result_excuses (result, decision, class) SELECT 100000 + n, 901, 'excused' FROM generate_series(1, $1::bigint) n",
		[parents],
	);
};

/**
 * Four planned runs of the demo with `slots` slots between them, each slot leased, as `plan` and `work take` leave
 * them: a lease is owned through its slot, and the slot through its run.
 */
const leasedSlots = (slots: number) => async (db: WriteDb) => {
	await db.exec(`
		INSERT INTO folders (id, project, name, rank, rev) VALUES (900, 900, 'Suite', 'a', 1);
		INSERT INTO cases (id, project, no, head, head_hash, claim_hash, title, methods, automate, step_count, folder,
			rank, created_by, created_at, updated_by, updated_at, rev)
			VALUES (900, 900, 1, 1, 'h', 'c', 'A case', '[]', 'no', 0, 900, 'a', 900, 1, 900, 1, 1);
		INSERT INTO runs (id, project, no, name, origin, accepts, require, tally, verdict, created_by, created_at, rev)
			SELECT 900 + n, 900, n, 'Run ' || n, 'planned', '{}', '[]', '{}', 'pending', 900, 1, 1 FROM generate_series(1, 4) n;`);
	await db.runDynamic(
		`INSERT INTO slots (id, run, case_id, version, claim, obligation, rank, rev)
		 SELECT n, 901 + n % 4, 900, 1, 'c', 'o' || n, n, 1 FROM generate_series(1, $1::bigint) n`,
		[slots],
	);
	await db.runDynamic(
		"INSERT INTO slot_leases (slot, actor, since, until) SELECT n, 900, 1, 2 FROM generate_series(1, $1::bigint) n",
		[slots],
	);
};

// Every level of a longer chain is read in batches too: a lease is owned through its slot, and the slot through its
// run. Batching only the runs gathered every slot of the batch's runs again on every slice.
/**
 * One chain of `length` folders in the demo, each the parent of the next, with ids rising from the root to the leaf,
 * as `propose` can make with folder edits: only the leaf has no folder under it.
 */
const folderChain = (length: number) => async (db: WriteDb) => {
	await db.runDynamic(
		`INSERT INTO folders (id, project, parent, name, rank, rev)
		 SELECT 1000 + n, 900, CASE WHEN n = 1 THEN NULL ELSE 999 + n END, 'f' || n, 'a', 1 FROM generate_series(1, $1::bigint) n`,
		[length],
	);
};

// A row another row of its own table refers to (a folder's parent) waited until nothing referred to it. In a chain only
// the leaf qualified, and a slice read the whole chain to find it, then the whole chain less one, and so on (#914).
test("a slice of a table that refers to itself examines a bounded number of rows however long the chain", async () => {
	const small = await largestSlice(folderChain(500), ["folders"]);
	const large = await largestSlice(folderChain(5_000), ["folders"]);
	console.log(
		`folder chain: largest slice ${small.largest} and total ${small.total} rows and index entries for 500 folders (${small.slices} slices), ${large.largest} and ${large.total} for 5000 (${large.slices} slices)`,
	);
	expect(large.largest).toBeLessThan(small.largest * 1.5);
	expect(large.largest).toBeLessThan(5_000);
	expect(large.total).toBeLessThan(small.total * 15);
}, 300_000);

// The unlinking pass covers a reference only when it can: a nullable column of a project's own table. A reference of
// any other kind, from a table a project owns to itself, would bring the chain back; this names what there is.
test("every reference from a project's table to itself is one a drain clears before deleting", async () => {
	await using db = await writerDatabase();
	const plan = await removalPlan(db);
	const cleared = plan.tables.flatMap((table) => table.selfReferences.map((column) => `${table.name}.${column}`));
	const all = (await db.catalog()).flatMap((table) =>
		plan.tables.find((each) => each.name === table.name)?.owner
			? table.foreignKeys
					.filter((reference) => reference.parent === table.name)
					.map((reference) => `${table.name}.${reference.columns.join(",")}`)
			: [],
	);
	expect(all.sort()).toEqual(["decisions.supersedes", "folders.parent", "questions.prior", "results.corrects"]);
	expect(cleared.sort()).toEqual(all.sort());
	expect(
		plan.tables.filter((table) => table.selfReferences.length > 0 && table.owner?.by !== "project").map((t) => t.name),
	).toEqual([]);
});

// The last slice deleted the project after reading every table again from its first row, past the index entries of
// everything the drain had removed: one transaction that grew with the whole demo, under the project's locks (#914).
test("a whole removal reads no table again in its last slice, with what it removed left in the indexes", async () => {
	// `size` rows each of results, excuses, folders (one chain), slots and leases, in groups of 10 that share a test,
	// target, batch, decision, case and run: what grows is the demo, not how many rows refer to one row.
	const demo = (size: number) => async (db: WriteDb) => {
		const groups = [Math.ceil(size / 10)];
		const each = (text: string, params: number[]) => db.runDynamic(text, params);
		await folderChain(size)(db);
		const g = "FROM generate_series(1, $1::bigint) g";
		await each(
			`INSERT INTO tests (id, project, no, kind, key, name, first_seq, last_seq) SELECT 2000 + g, 900, 100 + g, 'auto', 'k' || g, 'T', 1, 1 ${g}`,
			groups,
		);
		await each(
			`INSERT INTO targets (id, project, what, line, first_seq) SELECT 2000 + g, 900, 'session:' || g, 'session', 1 ${g}`,
			groups,
		);
		await each(
			`INSERT INTO batches (id, project, key, target, method, actor, state, counts, at, seq)
			 SELECT 2000 + g, 900, 'b' || g, 2000 + g, 'auto', 900, 'processed', '{}', 1, 1 ${g}`,
			groups,
		);
		await each(
			`INSERT INTO questions (id, project, no, kind, subject, fingerprint, title, producer, evidence, evidence_hash, basis,
				seen_first, seen_last, ask, blocks, rank, state, opened_at, rev)
			 SELECT 2000 + g, 900, 100 + g, 'failure', '{}', 'f' || g, 'Failure', 'ci', '{}', 'hash', '{}', 1, 1, '{}', '[]', 1,
				'decided', 1, 1 ${g}`,
			groups,
		);
		await each(
			`INSERT INTO decisions (id, project, question, kind, answer, signers, basis, holds, at, seq)
			 SELECT 2000 + g, 900, 2000 + g, 'failure', '{}', '[]', '{}', '{}', 1, 1 ${g}`,
			groups,
		);
		await each(
			`INSERT INTO cases (id, project, no, head, head_hash, claim_hash, title, methods, automate, step_count, folder, rank,
				created_by, created_at, updated_by, updated_at, rev)
			 SELECT 2000 + g, 900, 100 + g, 1, 'h', 'c', 'A case', '[]', 'no', 0, 1000 + g, 'a', 900, 1, 900, 1, 1 ${g}`,
			groups,
		);
		await each(
			`INSERT INTO runs (id, project, no, name, origin, accepts, require, tally, verdict, created_by, created_at, rev)
			 SELECT 2000 + g, 900, g, 'Run', 'planned', '{}', '[]', '{}', 'pending', 900, 1, 1 ${g}`,
			groups,
		);
		const n = "FROM generate_series(1, $1::bigint) n";
		const group = "(2000 + (n - 1) / 10 + 1)";
		await each(
			`INSERT INTO results (id, project, test, seq, ord, batch, target, method, actor, basis, outcome, at)
			 SELECT 100000 + n, 900, ${group}, 1, n, ${group}, ${group}, 'auto', 900, 'unresolved', 'fail', 1 ${n}`,
			[size],
		);
		await each(`INSERT INTO result_excuses (result, decision, class) SELECT 100000 + n, ${group}, 'excused' ${n}`, [
			size,
		]);
		await each(
			`INSERT INTO slots (id, run, case_id, version, claim, obligation, rank, rev)
			 SELECT n, ${group}, ${group}, 1, 'c', 'o' || n, n, 1 ${n}`,
			[size],
		);
		await each(`INSERT INTO slot_leases (slot, actor, since, until) SELECT n, 900, 1, 2 ${n}`, [size]);
	};
	// Batches of 16 rows a level, so that both sizes fill whole batches at every level.
	const small = await largestSlice(demo(400), "every", 16);
	const large = await largestSlice(demo(4_000), "every", 16);
	console.log(
		`whole removal: largest slice ${small.largest}, last ${small.last} rows and index entries for 400 of each (${small.slices} slices); largest ${large.largest}, last ${large.last} for 4000 (${large.slices} slices)`,
	);
	expect(large.slices).toBeGreaterThan(small.slices * 5);
	// Before, the last slice read 21,950 for 4000 of each, and was the largest. It still checks the foreign keys of
	// every table that refers to the project, past the index entries the drain left in indexes it did not read by.
	expect(large.last).toBeLessThan(2_000);
	expect(large.largest).toBeLessThan(10_000);
}, 300_000);

test("a slice of a table owned through two levels of parents examines a bounded number of rows however many there are", async () => {
	const tables = ["slot_leases"];
	const small = await largestSlice(leasedSlots(1_600), tables);
	const large = await largestSlice(leasedSlots(16_000), tables);
	console.log(
		`largest slice of slot_leases: ${small.largest} rows and index entries for 1600 slots (${small.slices} slices), ${large.largest} for 16000 (${large.slices} slices)`,
	);
	expect(large.slices).toBeGreaterThan(small.slices * 5);
	expect(large.largest).toBeLessThan(small.largest * 1.5);
	expect(large.largest).toBeLessThan(2_000);
}, 120_000);

// A table owned through a parent (an excuse through its result) was read as `result = ANY(ARRAY(SELECT id FROM results
// WHERE project = $1))`: every slice gathered all the demo's parents again, so the work grew with their square.
test("a slice of a table owned through its parents examines a bounded number of rows however many parents there are", async () => {
	const tables = ["result_excuses", "attachments"];
	const small = await largestSlice(excusedResults(400), tables);
	const large = await largestSlice(excusedResults(4_000), tables);
	console.log(
		`largest slice of a parent-owned table: ${small.largest} rows and index entries for 400 parents (${small.slices} slices), ${large.largest} for 4000 (${large.slices} slices)`,
	);
	expect(large.slices).toBeGreaterThan(small.slices * 5);
	expect(large.largest).toBeLessThan(small.largest * 1.5);
	expect(large.largest).toBeLessThan(2_000);
}, 120_000);

// Each batch a slice reads comes from an index in the order it is read: the top ancestor's rows in (project, id) order,
// and a lower parent's in (parent column, id) order, so the read stops at the batch's end. Otherwise it sorts every one
// of the project's rows at that level, or walks a primary key past every other project's rows.
test("every level of parents a slice reads in batches has an index in that order", async () => {
	await using db = await writerDatabase();
	const plan = await removalPlan(db);
	const levels = new Set<string>();
	// A parent-owned table walks its parents; a table that refers to itself walks its own rows.
	for (const table of plan.tables)
		for (const level of table.walk?.levels ?? []) levels.add(`${level.table}:${level.column}`);
	expect([...levels]).toEqual(expect.arrayContaining(["runs:project", "slots:run", "folders:project"]));
	const unordered: string[] = [];
	await db.transaction(async () => {
		await db.exec(
			"SET LOCAL enable_seqscan = off; SET LOCAL enable_bitmapscan = off; SET LOCAL enable_sort = off; SET LOCAL enable_incremental_sort = off",
		);
		for (const level of [...levels].sort()) {
			const [table = "", column = ""] = level.split(":");
			const lines = (
				await db.allDynamic<{ "QUERY PLAN": string }>(
					`EXPLAIN SELECT id FROM ${identifier(table)} WHERE (${identifier(column)}, id) > (1, 0) AND ${identifier(column)} <= 1 ORDER BY ${identifier(column)}, id LIMIT 256`,
				)
			).map((row) => row["QUERY PLAN"]);
			if (lines.some((line) => /Sort/.test(line)) || !lines.some((line) => /Index Cond: .*= /.test(line)))
				unordered.push(`${level}: ${lines.join(" / ")}`);
		}
	});
	expect(unordered).toEqual([]);
});
