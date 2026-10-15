import { expect, test } from "bun:test";
import { Db } from "../src/server/kernel/db.ts";
import { migrate } from "../src/server/kernel/migrate.ts";
import { removeProject } from "../src/server/transfer/transfer.ts";
import { removalFixture } from "./demo-removal-fixture.ts";

test("every foreign key into a removed table has a plain leading-column index and a search plan", () => {
	const db = new Db(":memory:");
	const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
	try {
		migrate(db, ":memory:");
		removalFixture(db, 1);
		const parents = new Set(Object.keys(removeProject(db, "removing").tables));
		const missing: string[] = [];
		const scans: string[] = [];
		for (const { name } of db.raw
			.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
			.all()) {
			const keys = db.raw.query<{ table: string; from: string }, []>(`PRAGMA foreign_key_list(${quote(name)})`).all();
			for (const key of keys.filter((key) => parents.has(key.table))) {
				const columns = db.raw
					.query<{ name: string; pk: number; type: string }, []>(`PRAGMA table_info(${quote(name)})`)
					.all();
				const integerKey = columns.filter((column) => column.pk > 0);
				const rowid = integerKey.length === 1 && integerKey[0]?.name === key.from && integerKey[0]?.type === "INTEGER";
				const indexes = db.raw.query<{ name: string; partial: number }, []>(`PRAGMA index_list(${quote(name)})`).all();
				if (
					!rowid &&
					!indexes.some(
						(index) =>
							index.partial === 0 &&
							db.raw.query<{ name: string }, []>(`PRAGMA index_info(${quote(index.name)})`).all()[0]?.name === key.from,
					)
				)
					missing.push(`${name}.${key.from} -> ${key.table}`);
				const plan = db.raw
					.query<{ detail: string }, []>(`EXPLAIN QUERY PLAN SELECT 1 FROM ${quote(name)} WHERE ${quote(key.from)} = 1`)
					.all();
				if (!plan.some((row) => row.detail.startsWith("SEARCH "))) scans.push(`${name}.${key.from}`);
			}
		}
		expect(missing).toEqual([]);
		expect(scans).toEqual([]);
	} finally {
		db.close();
	}
});
