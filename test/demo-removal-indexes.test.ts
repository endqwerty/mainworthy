import { expect, test } from "bun:test";
import { type ReadDb, declaredSql } from "../src/server/kernel/db.ts";
import { migrate } from "../src/server/kernel/migrate.ts";
import { exportArchive, removeProject } from "../src/server/transfer/transfer.ts";
import { removalFixture } from "./demo-removal-fixture.ts";
import "../src/server/ops/index.ts";
import "../src/server/ops/jobs.ts";

test("ordinary lookups use the existing non-null partial indexes after dropping their duplicates", async () => {
	const db = new Db(":memory:");
	try {
		await migrate(db, ":memory:");
		for (const [table, column, index] of [
			["results", "corrects", "results_corrects"],
			["results", "quarantine_exit", "results_quarantine_exit"],
			["result_excuses", "slot", "result_excuses_slot"],
		]) {
			const plan = db.raw
				.query<{ detail: string }, []>(`EXPLAIN QUERY PLAN SELECT 1 FROM ${table} WHERE ${column} = 1`)
				.all();
			expect(plan.some((row) => row.detail.startsWith("SEARCH ") && row.detail.includes(`INDEX ${index} (`))).toBe(
				true,
			);
			expect(db.raw.query<{ partial: number }, []>(`PRAGMA index_list(${table})`).all()).toContainEqual(
				expect.objectContaining({ name: index, partial: 1 }),
			);
		}
		await removalFixture(db, 1);
		expect((await removeProject(db, "removing")).tables.results).toBe(1);
		expect(db.raw.query("SELECT key FROM projects").all()).toEqual([{ key: "retained" }]);
		expect(db.raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
		expect(db.raw.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
	} finally {
		db.close();
	}
});

test("the retained migration-24 indexes support ordinary statements", async () => {
	const db = new Db(":memory:");
	try {
		await migrate(db, ":memory:");
		const plans = declaredSql().flatMap((text) => {
			const statement = db.raw.prepare<{ detail: string }, null[]>(`EXPLAIN QUERY PLAN ${text}`);
			try {
				return statement.all(...Array<null>(statement.paramsCount).fill(null)).map((row) => row.detail);
			} finally {
				statement.finalize();
			}
		});
		const indexes = db.raw
			.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index' AND name GLOB '*_fk'")
			.all();
		expect(indexes.filter(({ name }) => !plans.some((plan) => plan.includes(`INDEX ${name} (`)))).toEqual([]);
		for (const name of ["results_corrects_fk", "results_quarantine_exit_fk", "result_excuses_slot_fk"])
			expect(indexes.map((index) => index.name)).not.toContain(name);
	} finally {
		db.close();
	}
});

function snapshot(db: ReadDb): string {
	const chunks: string[] = [];
	exportArchive(db, (chunk) => chunks.push(chunk), { now: 1 });
	return chunks.join("");
}

for (const foreignKeys of [0, 1]) {
	for (const nested of [false, true]) {
		test(`a final removal violation rolls back with foreign_keys=${foreignKeys}, nested=${nested}`, async () => {
			const db = new Db(":memory:");
			try {
				await migrate(db, ":memory:");
				await removalFixture(db, 2);
				db.raw.exec("UPDATE results SET corrects = 1 WHERE project = 901");
				db.raw.exec(`PRAGMA foreign_keys = ${foreignKeys}`);
				const before = snapshot(db);
				const attempt = () => {
					expect(() => removeProject(db, "removing")).toThrow(/left rows in results that refer to results/);
					expect(snapshot(db)).toBe(before);
					expect(db.raw.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: foreignKeys });
				};
				if (nested) db.transaction(attempt);
				else attempt();
				expect(db.raw.inTransaction).toBe(false);
				expect(db.raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
			} finally {
				db.close();
			}
		});
	}
}

for (const action of ["finish", "cancel", "violate"] as const) {
	test(`the reset transaction checks later writes and restores enforcement on ${action}`, async () => {
		const db = new Db(":memory:");
		try {
			await migrate(db, ":memory:");
			await removalFixture(db, 2);
			const before = snapshot(db);
			const steps = db.checkedBulkSteps(async function* () {
				await removeProject(db, "removing");
				yield;
				if (action === "violate") db.raw.exec("UPDATE results SET corrects = 1 WHERE project = 901");
			});
			expect(steps.next()).toEqual({ value: undefined, done: false });
			expect(db.raw.query("SELECT key FROM projects").all()).toEqual([{ key: "retained" }]);
			expect(db.raw.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 0 });
			if (action === "violate") expect(() => steps.next()).toThrow(/bulk write foreign key violation/);
			else if (action === "cancel") steps.return();
			else expect(steps.next()).toEqual({ value: undefined, done: true });
			if (action !== "finish") expect(snapshot(db)).toBe(before);
			else expect(db.raw.query("SELECT count(*) AS n FROM results").get()).toEqual({ n: 2 });
			expect(db.raw.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
			expect(db.raw.inTransaction).toBe(false);
			expect(db.raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
		} finally {
			db.close();
		}
	});
}

test("every incoming reset reference uses an index, including SQLite's own DELETE checks", async () => {
	const db = new Db(":memory:");
	try {
		await migrate(db, ":memory:");
		await removalFixture(db, 2, 20_000);
		const parents = new Set<string>();
		await removeProject(db, "removing", (step) => {
			if (step.startsWith("delete ")) parents.add(step.slice(7));
		});
		const tables = db.raw
			.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
			.all();
		const probes = new Set<string>();
		for (const { name } of tables) {
			for (const fk of db.raw
				.query<{ table: string; from: string; to: string }, []>(`PRAGMA foreign_key_list("${name}")`)
				.all()) {
				if (!parents.has(fk.table)) continue;
				const indexes = db.raw.query<{ name: string }, []>(`PRAGMA index_list("${name}")`).all();
				const plan = db.raw
					.query<{ detail: string }, []>(`EXPLAIN QUERY PLAN SELECT 1 FROM "${name}" WHERE "${fk.from}" = -1`)
					.all();
				expect(
					plan.some((row) => row.detail.startsWith("SEARCH ")),
					`${name}.${fk.from} -> ${fk.table}: ${JSON.stringify(indexes)}`,
				).toBe(true);
				// Inspect the actual constraint program, not only an equivalent SELECT's planner.
				const program = db.raw
					.query<{ opcode: string; p1: number; p2: number }, []>(
						`EXPLAIN DELETE FROM "${fk.table}" WHERE "${fk.to}" = -1`,
					)
					.all();
				expect(
					program.filter((op) => op.opcode === "Rewind"),
					`${fk.table} DELETE must use key seeks`,
				).toEqual([]);
				probes.add(`${name}.${fk.from} -> ${fk.table}`);
			}
		}
		expect(probes.has("change_ends.receipt -> merge_receipts")).toBe(true);
	} finally {
		db.close();
	}
});
