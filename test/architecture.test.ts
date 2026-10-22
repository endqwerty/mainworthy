// The rules of the module map, as failing tests (principles P9 and P10). An agent that takes the shortest path that
// compiles, and reaches across a boundary to do it, fails here with a message that says which rule and why.
import { Statement as PreparedStatement } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Glob } from "bun";
import { z } from "zod";
import { ERROR_CODES, HTTP_STATUS } from "../src/core/api.ts";
import { needs } from "../src/core/kinds.ts";
import { REPLIES } from "../src/core/replies.ts";
import { mustTarget, resultLocation } from "../src/server/evidence/evidence.ts";
import { defaultConfig, openApp } from "../src/server/kernel/app.ts";
import { Db, databasePath, declaredSql, sql } from "../src/server/kernel/db.ts";
import { MIGRATIONS, migrate, openDatabase, SCHEMA_VERSION, schemaVersion } from "../src/server/kernel/migrate.ts";
import { MCP_OPS, OP_LIST } from "../src/server/ops/index.ts";
import { UNEXPORTED } from "../src/server/transfer/transfer.ts";
import { openApi } from "../src/surfaces/http.ts";
import "../src/server/ops/jobs.ts";

const files = [...new Glob("src/**/*.{ts,tsx}").scanSync(".")].filter(
	(file) => !file.endsWith(".test.ts") && !file.endsWith(".d.ts"),
);
const transpilers = { ts: new Bun.Transpiler({ loader: "ts" }), tsx: new Bun.Transpiler({ loader: "tsx" }) };
const imports = (file: string): string[] => {
	const source = readFileSync(file, "utf8").replace(/^#![^\n]*/, "");
	return [
		...new Set([
			...transpilers[file.endsWith(".tsx") ? "tsx" : "ts"].scanImports(source).map(({ path }) => path),
			// Bun erases type-only imports; keep checking the static imports the map already covered.
			...[
				...source.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gm),
			].map((m) => m[1] ?? m[2] ?? ""),
		]),
	];
};
const layerOf = (file: string): string => {
	const parts = file.split("/");
	return parts[1] === "server" ? `server/${parts[2]}` : (parts[1] ?? "");
};

describe("fresh schema image", () => {
	const contents = (db: Db) => {
		const schema = db.raw
			.query<{ type: string; name: string; tbl_name: string; sql: string | null }, []>(
				"SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name",
			)
			.all();
		return {
			schema,
			tables: schema
				.filter((entry) => entry.type === "table")
				.map(({ name }) => {
					const quoted = `"${name.replaceAll('"', '""')}"`;
					return {
						name,
						columns: db.raw.query(`PRAGMA table_xinfo(${quoted})`).all(),
						indexes: db.raw.query(`PRAGMA index_list(${quoted})`).all(),
						rows: db.raw.query(`SELECT * FROM ${quoted}`).all(),
					};
				}),
			pragmas: [
				"schema_version",
				"user_version",
				"application_id",
				"page_size",
				"auto_vacuum",
				"journal_mode",
				"synchronous",
				"foreign_keys",
				"busy_timeout",
				"cache_size",
				"temp_store",
				"mmap_size",
				"journal_size_limit",
				"wal_autocheckpoint",
				"query_only",
			].map((name) => ({ name, value: db.raw.query(`PRAGMA ${name}`).all() })),
		};
	};

	for (const memory of [true, false]) {
		test(`matches real migrations and isolates later databases on ${memory ? "memory" : "disk"}`, () => {
			const directory = mkdtempSync(join(tmpdir(), "mainworthy-schema-"));
			const config = defaultConfig({ MAINWORTHY_DATA: join(directory, "image"), USER: "robin" });
			const path = memory ? ":memory:" : join(directory, "migrated.db");
			const migrated = new Db(path);
			const app = openApp(config, { memory });
			try {
				expect(migrate(migrated, path)).toEqual({ from: 0, to: SCHEMA_VERSION, backup: null });
				expect(schemaVersion(app.db)).toBe(SCHEMA_VERSION);
				expect(app.db.raw.query("SELECT * FROM meta").all()).toEqual([
					{ key: "schema_version", value: String(SCHEMA_VERSION) },
				]);
				expect(contents(app.db)).toEqual(contents(migrated));
				expect(() => app.db.raw.query("SELECT $value").get({ wrong: 1 })).toThrow();
				app.db.exec("INSERT INTO meta VALUES ('private', 'first app'); CREATE TABLE private_rows (value TEXT)");
				const next = openApp({ ...config, dataDir: join(directory, "next") }, { memory });
				try {
					expect(contents(next.db)).toEqual(contents(migrated));
				} finally {
					next.close();
				}
			} finally {
				app.close();
				migrated.close();
				rmSync(directory, { recursive: true, force: true });
			}
		});
	}

	test("a stale write-ahead log beside a deleted database is not replayed onto the new one", () => {
		const directory = mkdtempSync(join(tmpdir(), "mainworthy-schema-stale-wal-"));
		const path = databasePath(directory);
		try {
			const old = openDatabase(path);
			old.exec("PRAGMA wal_autocheckpoint = 0; INSERT INTO meta VALUES ('late', 'from the old database')");
			const wal = fs.readFileSync(`${path}-wal`);
			old.close();
			rmSync(path);
			fs.writeFileSync(`${path}-wal`, wal);
			const fresh = openDatabase(path);
			try {
				expect(fresh.raw.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
				expect(fresh.raw.query("SELECT * FROM meta ORDER BY key").all()).toEqual([
					{ key: "schema_version", value: String(SCHEMA_VERSION) },
				]);
			} finally {
				fresh.close();
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("existing version-zero files keep their data and run the migrations", () => {
		const directory = mkdtempSync(join(tmpdir(), "mainworthy-schema-existing-"));
		const path = databasePath(directory);
		const original = new Db(path);
		original.exec("CREATE TABLE preserved (value TEXT); INSERT INTO preserved VALUES ('kept')");
		original.close();
		const db = openDatabase(path);
		try {
			expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
			expect(db.raw.query("SELECT value FROM preserved").all()).toEqual([{ value: "kept" }]);
		} finally {
			db.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	for (const failFirst of [false, true]) {
		test(`existing files retain upgrade backups ${failFirst ? "after a failed open" : "on the first open"}`, () => {
			const directory = mkdtempSync(join(tmpdir(), "mainworthy-schema-upgrade-"));
			const path = databasePath(directory);
			const migration = MIGRATIONS.at(-1);
			if (!migration) throw new Error("expected a shipped migration");
			const original = migration.sql;
			const previous = migration.version - 1;
			const db = new Db(path);
			const removed = spyOn(console, "error").mockImplementation(() => {});
			const older = [`${path}.v1.bak`, `${path}.v2.bak`];
			const similar = join(directory, "mainworthyXdb.v1.bak");
			const unrelatedDirectory = `${path}.v3.bak.dir`;
			const unrelatedLink = `${path}.v4.bak.link`;
			const unrelated = [
				similar,
				`${path}.other.v1.bak`,
				`${path}.v1.bak.extra`,
				`${path}.v01.bak`,
				`${path}.v0.bak`,
				`${path}.v-1.bak`,
				`${path}.v1.5.bak`,
				`${path}.v1.bak\n`,
				`${path}.v${SCHEMA_VERSION + 1}.bak`,
			];
			try {
				for (const file of [...older, ...unrelated]) fs.writeFileSync(file, "untouched");
				fs.mkdirSync(unrelatedDirectory);
				fs.symlinkSync(similar, unrelatedLink);
				for (const entry of MIGRATIONS.slice(0, -1)) db.exec(entry.sql);
				db.raw.query("INSERT INTO meta VALUES ('schema_version', ?)").run(String(previous));
				db.exec("INSERT INTO meta VALUES ('preserved', 'kept')");
				if (failFirst) {
					migration.sql = `INSERT INTO meta VALUES ('before', 'temporary');
				INSERT INTO meta VALUES ('preserved', 'duplicate');
				INSERT INTO meta VALUES ('after', 'must not run');`;
					expect(() => openDatabase(path)).toThrow("UNIQUE");
					for (const file of older) expect(readFileSync(file, "utf8")).toBe("untouched");
					expect(removed.mock.calls).toEqual([]);
					expect(db.raw.query("SELECT * FROM meta ORDER BY key").all()).toEqual([
						{ key: "preserved", value: "kept" },
						{ key: "schema_version", value: String(previous) },
					]);
					const backup = new Db(`${path}.v${previous}.bak`, { reader: true });
					try {
						expect(backup.raw.query("SELECT * FROM meta ORDER BY key").all()).toEqual([
							{ key: "preserved", value: "kept" },
							{ key: "schema_version", value: String(previous) },
						]);
					} finally {
						backup.close();
					}
				}
				migration.sql = original;
				const reopened = openDatabase(path);
				try {
					for (const file of older) expect(fs.existsSync(file)).toBe(failFirst);
					for (const file of unrelated) expect(readFileSync(file, "utf8")).toBe("untouched");
					expect(fs.lstatSync(unrelatedDirectory).isDirectory()).toBe(true);
					expect(fs.lstatSync(unrelatedLink).isSymbolicLink()).toBe(true);
					expect(removed.mock.calls.map((call) => call[0]).sort()).toEqual(
						failFirst ? [] : older.map((file) => `[mainworthy] removed upgrade copy ${JSON.stringify(file)}`).sort(),
					);
					const kept = new Db(`${path}.v${previous}.bak`, { reader: true });
					try {
						expect(schemaVersion(kept)).toBe(previous);
						expect(kept.raw.query("SELECT value FROM meta WHERE key = 'preserved'").get()).toEqual({ value: "kept" });
					} finally {
						kept.close();
					}
					expect(schemaVersion(reopened)).toBe(SCHEMA_VERSION);
					expect(reopened.raw.query("SELECT value FROM meta WHERE key = 'preserved'").get()).toEqual({ value: "kept" });
				} finally {
					reopened.close();
				}
				removed.mockClear();
				const restarted = openDatabase(path);
				try {
					expect(schemaVersion(restarted)).toBe(SCHEMA_VERSION);
					expect(fs.existsSync(`${path}.v${previous}.bak`)).toBe(true);
					expect(removed.mock.calls).toEqual([]);
				} finally {
					restarted.close();
				}
				db.raw.query("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION + 1));
				expect(() => openDatabase(path)).toThrow("is newer than this build");
				expect(schemaVersion(db)).toBe(SCHEMA_VERSION + 1);
			} finally {
				removed.mockRestore();
				migration.sql = original;
				db.close();
				rmSync(directory, { recursive: true, force: true });
			}
		});
	}

	test("a pre-existing garbage upgrade copy keeps older copies", () => {
		const directory = mkdtempSync(join(tmpdir(), "mainworthy-schema-garbage-copy-"));
		const path = databasePath(directory);
		const db = new Db(path);
		const log = spyOn(console, "error").mockImplementation(() => {});
		try {
			for (const migration of MIGRATIONS.slice(0, 19)) db.exec(migration.sql);
			db.exec("INSERT INTO meta VALUES ('schema_version', '19'), ('preserved', 'kept')");
			db.raw.query("VACUUM INTO ?").run(`${path}.v19.bak`);
			for (const migration of MIGRATIONS.slice(19, 20)) db.exec(migration.sql);
			db.exec("UPDATE meta SET value = '20' WHERE key = 'schema_version'");
			fs.writeFileSync(`${path}.v20.bak`, "partial garbage");
			const opened = openDatabase(path);
			try {
				expect(schemaVersion(opened)).toBe(SCHEMA_VERSION);
				expect(fs.existsSync(`${path}.v19.bak`)).toBe(true);
				expect(readFileSync(`${path}.v20.bak`, "utf8")).toBe("partial garbage");
				expect(log.mock.calls).toEqual([]);
				const older = new Db(`${path}.v19.bak`, { reader: true });
				try {
					expect(schemaVersion(older)).toBe(19);
					expect(older.raw.query("SELECT value FROM meta WHERE key = 'preserved'").get()).toEqual({ value: "kept" });
				} finally {
					older.close();
				}
			} finally {
				opened.close();
			}
		} finally {
			log.mockRestore();
			db.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("a later failed migration rolls back the whole upgrade before a retry", () => {
		const directory = mkdtempSync(join(tmpdir(), "mainworthy-schema-batch-rollback-"));
		const path = databasePath(directory);
		const db = new Db(path);
		const migration = MIGRATIONS.find((entry) => entry.version === 25);
		if (!migration) throw new Error("expected migration 25");
		const original = migration.sql;
		const log = spyOn(console, "error").mockImplementation(() => {});
		try {
			for (const entry of MIGRATIONS.slice(0, 20)) db.exec(entry.sql);
			db.exec("INSERT INTO meta VALUES ('schema_version', '20'), ('preserved', 'kept')");
			db.raw.query("VACUUM INTO ?").run(`${path}.v19.bak`);
			const before = contents(db);
			migration.sql = "INSERT INTO meta VALUES ('preserved', 'duplicate')";
			expect(() => openDatabase(path)).toThrow("UNIQUE");
			expect(schemaVersion(db)).toBe(20);
			expect(contents(db)).toEqual(before);
			expect(fs.existsSync(`${path}.v19.bak`)).toBe(true);
			expect(log.mock.calls).toEqual([]);
			migration.sql = original;
			const reopened = openDatabase(path);
			try {
				expect(schemaVersion(reopened)).toBe(SCHEMA_VERSION);
				expect(fs.existsSync(`${path}.v19.bak`)).toBe(true);
				expect(fs.existsSync(`${path}.v24.bak`)).toBe(false);
				expect(log.mock.calls).toEqual([]);
				const backup = new Db(`${path}.v20.bak`, { reader: true });
				try {
					expect(schemaVersion(backup)).toBe(20);
					expect(backup.raw.query("SELECT value FROM meta WHERE key = 'preserved'").get()).toEqual({ value: "kept" });
				} finally {
					backup.close();
				}
			} finally {
				reopened.close();
			}
		} finally {
			migration.sql = original;
			log.mockRestore();
			db.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("a failed copy sync publishes no final copy and preserves the starting database", () => {
		const directory = mkdtempSync(join(tmpdir(), "mainworthy-schema-copy-sync-"));
		const path = databasePath(directory);
		const db = new Db(path);
		const sync = spyOn(fs, "fsyncSync").mockImplementation(() => {
			throw new Error("copy sync failed");
		});
		try {
			for (const migration of MIGRATIONS.slice(0, 20)) db.exec(migration.sql);
			db.exec("INSERT INTO meta VALUES ('schema_version', '20'), ('preserved', 'kept')");
			fs.writeFileSync(`${path}.v19.bak`, "older copy");
			expect(() => openDatabase(path)).toThrow("copy sync failed");
			expect(schemaVersion(db)).toBe(20);
			expect(fs.existsSync(`${path}.v20.bak`)).toBe(false);
			expect(readFileSync(`${path}.v19.bak`, "utf8")).toBe("older copy");
			expect(readdirSync(directory).filter((file) => file.startsWith("mainworthy.db.v20.bak"))).toEqual([]);
			sync.mockRestore();
			const reopened = openDatabase(path);
			try {
				expect(schemaVersion(reopened)).toBe(SCHEMA_VERSION);
				expect(fs.existsSync(`${path}.v19.bak`)).toBe(false);
				const backup = new Db(`${path}.v20.bak`, { reader: true });
				try {
					expect(schemaVersion(backup)).toBe(20);
					expect(backup.raw.query("SELECT value FROM meta WHERE key = 'preserved'").get()).toEqual({ value: "kept" });
				} finally {
					backup.close();
				}
			} finally {
				reopened.close();
			}
		} finally {
			sync.mockRestore();
			db.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("a failed upgrade copy deletion logs and still opens the upgraded database", () => {
		const directory = mkdtempSync(join(tmpdir(), "mainworthy-schema-cleanup-failure-"));
		const path = databasePath(directory);
		const db = new Db(path);
		const older = `${path}.v1.bak`;
		const removable = `${path}.v2.bak`;
		const remove = fs.rmSync;
		const removal = spyOn(fs, "rmSync").mockImplementation((file, options) => {
			if (file === older) throw new Error("permission denied for upgrade copy");
			return remove(file, options);
		});
		const log = spyOn(console, "error").mockImplementation(() => {});
		try {
			for (const migration of MIGRATIONS.slice(0, 20)) db.exec(migration.sql);
			db.exec("INSERT INTO meta VALUES ('schema_version', '20'), ('preserved', 'kept')");
			fs.writeFileSync(older, "keep on removal failure");
			fs.writeFileSync(removable, "remove successfully");
			const opened = openDatabase(path);
			try {
				expect(schemaVersion(opened)).toBe(SCHEMA_VERSION);
				expect(opened.raw.query("SELECT value FROM meta WHERE key = 'preserved'").get()).toEqual({ value: "kept" });
				expect(readFileSync(older, "utf8")).toBe("keep on removal failure");
				expect(fs.existsSync(removable)).toBe(false);
				expect(log.mock.calls.map((call) => call[0]).sort()).toEqual(
					[
						`[mainworthy] could not remove upgrade copy ${JSON.stringify(older)}: permission denied for upgrade copy`,
						`[mainworthy] removed upgrade copy ${JSON.stringify(removable)}`,
					].sort(),
				);
				const backup = new Db(`${path}.v20.bak`, { reader: true });
				try {
					expect(schemaVersion(backup)).toBe(20);
				} finally {
					backup.close();
				}
			} finally {
				opened.close();
			}
		} finally {
			removal.mockRestore();
			log.mockRestore();
			db.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("declared statements", () => {
	const read = sql<{ key: string }, { value: string }>("SELECT value FROM meta WHERE key = $key");
	const write = sql<{ key: string; value: string }>(
		"INSERT INTO meta (key, value) VALUES ($key, $value) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
	);
	const tables = sql<readonly [], { name: string }>(
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'",
	);

	test("1000 bound reads and writes prepare once each despite dynamic SQL churn, and close finalizes them", () => {
		const db = new Db(":memory:");
		migrate(db, ":memory:");
		const prepare = spyOn(db.raw, "prepare");
		const query = spyOn(db.raw, "query");
		try {
			for (let i = 0; i < 1000; i++) {
				expect(db.run(write, { key: "cache-probe", value: String(i) }).changes).toBe(1);
				expect(db.get(read, { key: "cache-probe" })).toEqual({ value: String(i) });
				expect(db.all(read, { key: "cache-probe" })).toEqual([{ value: String(i) }]);
				expect(db.allDynamic(`SELECT ? AS value /* dynamic ${i} */`, [i])).toEqual([{ value: i }]);
				if (i === 0)
					for (let j = 0; j < 32; j++)
						expect(db.allDynamic(`SELECT ? AS value /* evict ${j} */`, [j])).toEqual([{ value: j }]);
			}
			const handles = new Set(
				[prepare, query].flatMap((call) =>
					call.mock.calls.flatMap(([text], index) => {
						if (text !== write.text && text !== read.text) return [];
						const result = call.mock.results[index];
						if (!(result?.value instanceof PreparedStatement)) throw new Error("expected a native prepared statement");
						return [result.value];
					}),
				),
			);
			expect(handles.size).toBe(2);
			expect(query.mock.calls.filter(([text]) => text.includes("/* dynamic") || text.includes("/* evict")).length).toBe(
				1032,
			);
			const finalize = [...handles].map((statement) => spyOn(statement, "finalize"));
			db.close();
			expect(finalize.map((call) => call.mock.calls.length)).toEqual([1, 1]);
			db.close();
			expect(finalize.map((call) => call.mock.calls.length)).toEqual([1, 1]);
			for (const call of finalize) call.mockRestore();
			for (const statement of handles) expect(() => statement.get()).toThrow("finalized");
			expect(() => db.get(read, { key: "cache-probe" })).toThrow("closed database");
			expect(() => db.all(read, { key: "cache-probe" })).toThrow("closed database");
			expect(() => db.run(write, { key: "cache-probe", value: "closed" })).toThrow("closed database");
			expect(() => db.allDynamic("SELECT 1", [])).toThrow("closed database");
			expect(() => db.all(tables)).toThrow("closed database");
		} finally {
			db.close();
			prepare.mockRestore();
			query.mockRestore();
		}
	});

	test("connections keep their own bindings, data and statement lifetimes", () => {
		const first = new Db(":memory:");
		const second = new Db(":memory:");
		try {
			for (const db of [first, second]) migrate(db, ":memory:");
			first.run(write, { key: "cache-probe", value: "first" });
			second.run(write, { key: "cache-probe", value: "second" });
			expect(first.get(read, { key: "cache-probe" })).toEqual({ value: "first" });
			expect(second.get(read, { key: "cache-probe" })).toEqual({ value: "second" });
			first.close();
			second.run(write, { key: "cache-probe", value: "still open" });
			expect(second.all(read, { key: "cache-probe" })).toEqual([{ value: "still open" }]);
		} finally {
			first.close();
			second.close();
		}
	});

	test("a statement prepared before migration reads the migrated schema on the same connection", () => {
		const db = new Db(":memory:");
		try {
			expect(db.all(tables)).toEqual([]);
			expect(() => db.get(read, { key: "schema_version" })).toThrow("no such table");
			expect(migrate(db, ":memory:")).toEqual({ from: 0, to: SCHEMA_VERSION, backup: null });
			expect(db.get(read, { key: "schema_version" })).toEqual({ value: String(SCHEMA_VERSION) });
			expect(db.all(tables)).toEqual([{ name: "meta" }]);
			db.run(write, { key: "cache-probe", value: "after migration" });
			expect(db.get(read, { key: "cache-probe" })).toEqual({ value: "after migration" });
		} finally {
			db.close();
		}
	});
});

describe("SQL batches", () => {
	test("a failed statement stops the batch before later writes", () => {
		const db = new Db(":memory:");
		try {
			db.exec("CREATE TABLE probe (value INTEGER CHECK (value > 0))");
			expect(() =>
				db.exec("INSERT INTO probe VALUES (1); INSERT INTO probe VALUES (-1); INSERT INTO probe VALUES (2)"),
			).toThrow("CHECK");
			expect(db.raw.query("SELECT value FROM probe").all()).toEqual([{ value: 1 }]);
		} finally {
			db.close();
		}
	});

	test("SQLite keeps quoted semicolons, comments and complete trigger bodies together", () => {
		const db = new Db(":memory:");
		try {
			db.exec(`; -- leading comment with ; and '
				/* ; */ CREATE TABLE "semi;""quoted" ([value;] TEXT, \`tick;\` TEXT);
				CREATE TABLE audit (value TEXT);
				CREATE TEMP TRIGGER "trigger;end" AFTER INSERT ON "semi;""quoted"
				BEGIN
					INSERT INTO audit VALUES (CASE WHEN NEW.[value;] = '雪;it''s' THEN 'BEGIN; END;' ELSE 'other' END);
					-- END; ignored inside a comment
					INSERT INTO audit VALUES (NEW.\`tick;\` || '/* ; */');
				END;
				/* between statements ; */ INSERT INTO "semi;""quoted" VALUES ('雪;it''s', '?;--');
				INSERT INTO "semi;""quoted" VALUES ('other', 'second;')
			`);
			expect(db.raw.query("SELECT value FROM audit ORDER BY rowid").all()).toEqual([
				{ value: "BEGIN; END;" },
				{ value: "?;--/* ; */" },
				{ value: "other" },
				{ value: "second;/* ; */" },
			]);
		} finally {
			db.close();
		}
	});

	test("empty statements and trailing comments do not prevent the next batch", () => {
		const db = new Db(":memory:");
		try {
			for (const text of [
				"",
				" ; ; \n",
				"-- comment;",
				"/* block; */",
				"/* unterminated;",
				"\uFEFF; -- comment\n /* ; */",
			])
				db.exec(text);
			db.exec("CREATE TABLE probe (value TEXT); INSERT INTO probe VALUES ('kept'); -- trailing;\n /* comment; */");
			expect(db.raw.query("SELECT value FROM probe").all()).toEqual([{ value: "kept" }]);
		} finally {
			db.close();
		}
	});

	test("unbound parameters cannot change a batch's statement boundaries", () => {
		const db = new Db(":memory:");
		try {
			db.exec("CREATE TABLE probe (value TEXT); INSERT INTO probe VALUES ('kept')");
			expect(() => db.exec("INSERT INTO probe VALUES ($value); DELETE FROM probe")).toThrow("unbound parameters");
			expect(db.raw.query("SELECT value FROM probe").all()).toEqual([{ value: "kept" }]);
		} finally {
			db.close();
		}
	});
});

function migrationArchiveMismatches(migrations: typeof MIGRATIONS): string[] {
	const mismatches: string[] = [];
	const db = new Db(":memory:");
	const exported = () =>
		new Map(
			db.raw
				.query<{ name: string }, []>(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'search_docs%' ORDER BY name",
				)
				.all()
				.filter((table) => !UNEXPORTED.includes(table.name))
				.map((table) => [
					table.name,
					db.raw
						.query<{ name: string; type: string; notnull: number; pk: number; dflt_value: string | null }, []>(
							`PRAGMA table_info(${table.name})`,
						)
						.all(),
				]),
		);
	let before = exported();
	for (const migration of migrations) {
		db.exec(migration.sql);
		const after = exported();
		const incompatible =
			before.size !== after.size ||
			[...before].some(([name, columns]) => {
				const next = after.get(name);
				if (!next) return true;
				return (
					columns.some(
						(column) => JSON.stringify(next.find((item) => item.name === column.name)) !== JSON.stringify(column),
					) ||
					next.some(
						(column) =>
							!columns.some((item) => item.name === column.name) &&
							(column.notnull !== 0 ||
								column.pk !== 0 ||
								(column.dflt_value !== null &&
									db.raw.query<{ nonnull: number }, []>(`SELECT (${column.dflt_value}) IS NOT NULL AS nonnull`).get()
										?.nonnull === 1)),
					)
				);
			});
		const sql = migration.sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'/g, " ");
		const writes = [
			...sql.matchAll(
				/\b(?:UPDATE(?:\s+OR\s+\w+)?|INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|DELETE\s+FROM)\s+(?:main\s*\.\s*)?(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|(\w+))/gi,
			),
		];
		const transforms = writes.some((write) =>
			[...before.keys(), ...after.keys()].some(
				(name) => name.toLowerCase() === (write[1] ?? write[2] ?? write[3] ?? write[4])?.toLowerCase(),
			),
		);
		const requiresArchive = incompatible || transforms;
		const unchanged = JSON.stringify([...after]) === JSON.stringify([...before]);
		// A nullable addition without a default can still change meaning; its behavior needs a separate test.
		if ((requiresArchive || unchanged) && migration.archive !== requiresArchive) mismatches.push(migration.name);
		before = after;
	}
	db.close();
	return mismatches;
}

describe("the module map", () => {
	test("only the decision machinery can mint a witness, so standing cannot change without a decision", () => {
		// The mint is claimed once, by the module that settles decisions; a second claim throws when it loads
		// (test/integrity.test.ts). This names the one place the claim is written.
		const claimers = files.filter(
			(file) =>
				/\bclaimMint\b|Witness\.claim\b/.test(readFileSync(file, "utf8")) && !file.endsWith("kernel/witness.ts"),
		);
		expect(claimers).toEqual(["src/server/decisions/decisions.ts"]);
	});

	test("every function that is handed a witness checks it", () => {
		// A standing writer must read its decision through `decisionOf`, which refuses anything the mint did not make,
		// or hand the witness on to a function that does. A parameter that is taken and ignored proves nothing.
		// (A kind handler in `decisions` may ignore the witness it is offered: one that writes no standing has no use
		// for it. The writers are in the modules below.)
		const offenders: string[] = [];
		for (const file of files.filter((file) => file.startsWith("src/server/") && !file.endsWith("kernel/witness.ts"))) {
			const text = readFileSync(file, "utf8");
			if (/\b_witness\b/.test(text) && !file.startsWith("src/server/decisions/"))
				offenders.push(`${file} ignores a witness`);
			for (const match of text.matchAll(
				/^(?:export )?function\*? (\w+)\([^)]*\bwitness: Witness\b[^)]*\)[^{]*\{\n([\s\S]*?)^\}/gm,
			)) {
				const [, name, body] = match;
				if (!/\bdecisionOf\(witness, "\w+"\)|\(ctx, witness\b/.test(body ?? ""))
					offenders.push(`${file}: ${name} never checks its witness`);
			}
		}
		expect(offenders).toEqual([]);
	});

	test("the raw database handle is used only by the kernel and by the archive, which reads every table by design", () => {
		// `db.raw` runs SQL that is neither declared nor prepared against the schema. Everything else goes through
		// `sql()` in the module that owns the table.
		const offenders = files.filter(
			(file) =>
				/\.raw\b/.test(readFileSync(file, "utf8")) &&
				!file.startsWith("src/server/kernel/") &&
				!file.startsWith("src/server/transfer/") &&
				!file.startsWith("src/web/"),
		);
		expect(offenders).toEqual([]);
	});

	test("only the kernel talks to SQLite", () => {
		const offenders = files.filter(
			(file) => imports(file).includes("bun:sqlite") && !file.startsWith("src/server/kernel/"),
		);
		expect(offenders).toEqual([]);
	});

	test("the pure core imports nothing from the server, the surfaces or the web", () => {
		const offenders = files
			.filter((file) => file.startsWith("src/core/"))
			.filter((file) =>
				imports(file).some((path) => path.startsWith("..") || path.startsWith("bun:") || path.startsWith("node:")),
			);
		expect(offenders).toEqual([]);
	});

	test("domain modules do not reach upward: imports go down the map, never up", () => {
		// Each layer may import the layers listed after it. `ops` composes everything; `decisions` sits above the
		// modules whose standing it writes; none of those may import `decisions` or `ops`.
		const domain: Record<string, string[]> = {
			"server/kernel": [],
			"server/identity": ["server/kernel"],
			"server/policy": ["server/kernel"],
			"server/suite": ["server/kernel", "server/policy"],
			"server/evidence": ["server/kernel", "server/suite"],
			"server/runs": ["server/kernel", "server/suite", "server/evidence"],
			"server/decisions": [
				"server/kernel",
				"server/identity",
				"server/policy",
				"server/suite",
				"server/evidence",
				"server/runs",
			],
			"server/transfer": ["server/kernel", "server/suite", "server/evidence"],
			"server/trackers": ["server/kernel", "server/evidence", "server/suite"],
			"server/statuses": ["server/kernel", "server/evidence", "server/runs"],
			"server/handoffs": ["server/kernel", "server/evidence", "server/decisions"],
		};
		const server = [...Object.keys(domain), "server/ops"];
		const allowed: Record<string, string[]> = {
			...domain,
			core: [],
			web: [],
			"server/ops": Object.keys(domain),
			surfaces: ["server/ops", "server/kernel", "server/identity", "web"],
			app: [...server, "surfaces"],
			cli: ["app", "surfaces", "server/ops", "server/kernel", "server/policy", "web"],
		};
		const exceptions: Record<string, string[]> = {
			// The HTTP client shares the sign-in token length bound.
			"src/cli/client.ts": ["server/identity"],
			// Demo refresh issues temporary tokens, resets demo storage and restores grants before HTTP seeding.
			"src/cli/demo.ts": ["server/identity", "server/transfer"],
			// The demo reset worker resolves the owner before running that same reset.
			"src/cli/demo-worker.ts": ["server/identity"],
		};
		const offenders: string[] = [];
		for (const file of files) {
			const layer = layerOf(file);
			const may = allowed[layer];
			if (!may) {
				offenders.push(`${file} belongs to an unlisted layer (${layer})`);
				continue;
			}
			for (const path of imports(file)) {
				if (!path.startsWith(".")) continue;
				const resolved = new URL(path, `file:///${file}`).pathname.slice(1);
				// Bundled documentation and licence text outside src are assets, not runtime layers.
				if (!resolved.startsWith("src/") && !/\.tsx?$/.test(resolved)) continue;
				const target = layerOf(resolved);
				if (target === layer || target === "core" || may.includes(target) || exceptions[file]?.includes(target))
					continue;
				offenders.push(`${file} imports ${path} (${layer} may not import ${target})`);
			}
		}
		expect(offenders).toEqual([]);
	});

	// The owner of each table. A read of another module's data goes through that module's functions, so the
	// rules about its rows live in one place and a join cannot quietly depend on another module's schema.
	const owners: Record<string, string[]> = {
		"server/kernel": ["meta", "projects", "counters", "commands", "demo_projects"],
		"server/identity": [
			"mail_contacts",
			"orgs",
			"actors",
			"grants",
			"teams",
			"team_members",
			"team_grants",
			"team_events",
			"tokens",
			"sessions",
			"credentials",
			"invitations",
			"passkey_users",
		],
		"server/policy": ["policies"],
		"server/suite": [
			"folders",
			"cases",
			"case_tags",
			"case_aliases",
			"versions",
			"placements",
			"proposals",
			"search_docs",
			"requirements",
			"covers",
		],
		"server/evidence": [
			"assertion_seen",
			"assertion_spreads",
			"assertion_roots",
			"assertion_index",
			"artifacts",
			"builds",
			"deployments",
			"tests",
			"targets",
			"changes",
			"change_ends",
			"scope_moves",
			"batches",
			"signatures",
			"results",
			"attachments",
			"flips",
			"result_tries",
			"findings",
			"reviews",
			"excuses",
			"result_excuses",
			"quarantines",
		],
		"server/runs": ["runs", "run_tests", "slots", "slot_results", "depends_on", "slot_leases"],
		"server/decisions": ["questions", "question_refs", "answers", "decisions"],
		"server/trackers": ["tracker_requests", "tracker_polls"],
		"server/statuses": ["commit_statuses", "commit_status_delivery"],
		"server/handoffs": ["handoffs"],
	};

	test("a module runs SQL only on the tables it owns", () => {
		const ownerOf = new Map(
			Object.entries(owners).flatMap(([layer, tables]) => tables.map((table) => [table, layer] as const)),
		);
		const offenders: string[] = [];
		for (const file of files) {
			// The archive reads every table by name from the database itself; it has no table of its own to confuse.
			if (!file.startsWith("src/server/") || file.startsWith("src/server/transfer/") || file.includes("/migrations/"))
				continue;
			const layer = layerOf(file);
			const source = readFileSync(file, "utf8");
			// SQL keywords are upper case in this codebase; prose in comments is not.
			for (const match of source.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+([a-z_]+)\b/g)) {
				const table = match[1] ?? "";
				const owner = ownerOf.get(table);
				if (owner && owner !== layer) offenders.push(`${file} runs SQL on ${table}, which ${owner} owns`);
			}
		}
		expect(offenders).toEqual([]);
		// Every table in the schema has an owner: a new table without one fails here.
		const db = new Db(":memory:");
		migrate(db, ":memory:");
		const tables = db.raw
			.query<{ name: string }, []>(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'search_docs_%'",
			)
			.all()
			.map((row) => row.name);
		db.close();
		expect(tables.filter((table) => !ownerOf.has(table))).toEqual([]);
		expect([...ownerOf.keys()].filter((table) => !tables.includes(table))).toEqual([]);
	});

	test("identity is entered through identity.ts: no other layer imports another file of it", () => {
		// Tokens, sessions and what is noted of their use are files of one module, and `identity.ts` is its
		// interface. A surface that imported `sessions.ts` could open a session without the proof that
		// `identity.ts` asks for first.
		const offenders = files
			.filter((file) => !file.startsWith("src/server/identity/"))
			.flatMap((file) =>
				imports(file)
					.filter((path) => path.startsWith("."))
					.map((path) => new URL(path, `file:///${file}`).pathname.slice(1))
					.filter((target) => target.startsWith("src/server/identity/") && target !== "src/server/identity/identity.ts")
					.map((target) => `${file} imports ${target}`),
			);
		expect(offenders).toEqual([]);
	});

	test("an archive holds who the actors are and what they may do, and no other table of identity", () => {
		// What lets somebody in never travels in an archive, and an import empties it: a token and a session (the
		// SHA-256 of a secret), a password's hash, a passkey's public key and the handle it is filed under, an
		// invitation's code. The tables named here are all of identity that an archive holds. A table that
		// is added later is unexported, or it is added to this list on purpose: until then this fails, before
		// an export carries what signs somebody in.
		const exported = [
			"orgs",
			"actors",
			"grants",
			"teams",
			"team_members",
			"team_grants",
			"team_events",
			"mail_contacts",
		];
		const identity = owners["server/identity"] ?? [];
		// Change endings, scope-move audit rows and demo marks preserve the old archive version (decisions 0022, 0038
		// and 0100). Tracker delivery and hand-offs must never replay after import. None of these tables holds credentials.
		const other = [
			"assertion_seen",
			"assertion_spreads",
			"assertion_roots",
			"assertion_index",
			"slot_leases",
			"change_ends",
			"tracker_requests",
			"tracker_polls",
			"scope_moves",
			"demo_projects",
			"commit_statuses",
			"commit_status_delivery",
			"handoffs",
		];
		expect(UNEXPORTED.filter((table) => !other.includes(table)).sort()).toEqual(
			identity.filter((table) => !exported.includes(table)).sort(),
		);
		expect(UNEXPORTED.filter((table) => other.includes(table))).toEqual(other);
	});

	test("migration versions are contiguous and in order, with exactly one matching file per entry", () => {
		expect(MIGRATIONS.map((migration) => migration.version)).toEqual(MIGRATIONS.map((_, index) => index + 1));
		const directory = "src/server/kernel/migrations";
		const filenames = MIGRATIONS.map(
			(migration) => `${String(migration.version).padStart(4, "0")}_${migration.name}.sql`,
		);
		expect(readdirSync(directory).sort()).toEqual([...filenames].sort());
		for (const [index, migration] of MIGRATIONS.entries()) {
			expect(readFileSync(`${directory}/${filenames[index]}`, "utf8")).toBe(migration.sql);
		}
	});

	test("migrations mark incompatible archive shapes and leave excluded changes unmarked", () => {
		expect(migrationArchiveMismatches(MIGRATIONS)).toEqual([]);
	});

	for (const [constraint, value] of [
		["CHECK", "''"],
		["NOT NULL", "NULL"],
		["UNIQUE", "'kept'"],
		["FOREIGN KEY", "'missing'"],
	]) {
		test(`a migration's second-statement ${constraint} failure rolls back its rows and version`, () => {
			const db = new Db(":memory:");
			const migration = MIGRATIONS.at(-1);
			if (!migration) throw new Error("expected a shipped migration");
			const original = migration.sql;
			try {
				for (const earlier of MIGRATIONS.slice(0, -1)) db.exec(earlier.sql);
				db.raw.query("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(String(migration.version - 1));
				db.exec(`
					CREATE TABLE migration_parent (value TEXT PRIMARY KEY);
					INSERT INTO migration_parent VALUES ('kept'), ('before'), ('after'), ('');
					CREATE TABLE migration_probe (
						value TEXT NOT NULL UNIQUE CHECK (length(value) > 0) REFERENCES migration_parent(value)
					);
					INSERT INTO migration_probe VALUES ('kept');
				`);
				migration.sql = `INSERT INTO migration_probe VALUES ('before');
					INSERT INTO migration_probe VALUES (${value});
					INSERT INTO migration_probe VALUES ('after');`;
				expect(() => migrate(db, ":memory:")).toThrow(constraint);
				expect(db.raw.query("SELECT value FROM migration_probe").all()).toEqual([{ value: "kept" }]);
				expect(schemaVersion(db)).toBe(migration.version - 1);
				expect(db.raw.inTransaction).toBe(false);
				migration.sql = original;
				expect(migrate(db, ":memory:").to).toBe(SCHEMA_VERSION);
			} finally {
				migration.sql = original;
				db.close();
			}
		});
	}

	test("change landing migration never guesses old heads and indexes only received exact landings", () => {
		const db = new Db(":memory:");
		try {
			const migration = MIGRATIONS.find((entry) => entry.name === "change_landings");
			if (!migration) throw new Error("missing landing migration");
			for (const earlier of MIGRATIONS.filter((entry) => entry.version < migration.version)) db.exec(earlier.sql);
			db.exec(`INSERT INTO meta VALUES ('schema_version', '${migration.version - 1}');
				INSERT INTO orgs VALUES (1, 'Example', 1);
				INSERT INTO projects (id, org, key, name, created_at, identity) VALUES (1, 1, 'shop', 'Shop', 1, 'shop-identity');
				INSERT INTO changes (id, project, key, repo, head_sha, title, rev) VALUES (1, 1, 'pr:8', 'acme/shop', 'landed123', 'Keep coupons', 1);
				INSERT INTO change_ends VALUES (1, 'merged', 1);
				INSERT INTO targets (id, project, what, repo, commit_sha, branch, line, first_seq)
				VALUES (1, 1, 'code:acme/shop@landed123', 'acme/shop', 'landed123', 'main', 'trunk', 1);`);
			expect(migrate(db, ":memory:").to).toBe(SCHEMA_VERSION);
			const location = () => resultLocation(db, mustTarget(db, 1));
			expect(location()).toEqual({ label: "main", commit: "landed123", change: null });
			expect(db.raw.query("SELECT landing_commit, landing_repo, landing_branch FROM change_ends").all()).toEqual([
				{ landing_commit: null, landing_repo: null, landing_branch: null },
			]);
			db.exec(
				"UPDATE change_ends SET landing_commit = 'landed123', landing_repo = 'acme/shop', landing_branch = 'master'",
			);
			expect(location()).toEqual({ label: "main", commit: "landed123", change: null });
			db.exec("UPDATE change_ends SET landing_branch = 'main'");
			expect(location()).toEqual({ label: "main · pr:8 Keep coupons", commit: "landed123", change: "pr:8" });
			const query = declaredSql().find(
				(text) => text.includes("json_each($targets)") && text.includes("e.landing_commit"),
			);
			if (!query) throw new Error("missing batched landing query");
			const plan = db.raw
				.query<{ detail: string }, { targets: string }>(`EXPLAIN QUERY PLAN ${query}`)
				.all({ targets: "[1]" });
			expect(
				plan.some((row) =>
					row.detail.includes("change_ends_landing (landing_commit=? AND landing_repo=? AND landing_branch=?)"),
				),
			).toBe(true);
			for (const update of [
				"landing_branch = NULL",
				"ended = 'closed'",
				"landing_commit = NULL",
				"landing_branch = 'release'",
			])
				expect(() => db.exec(`UPDATE change_ends SET ${update}`)).toThrow("CHECK");
		} finally {
			db.close();
		}
	});

	test("every older schema upgrades to the same fresh schema", () => {
		const fresh = new Db(":memory:");
		const schema = (db: Db) => db.raw.query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name").all();
		try {
			migrate(fresh, ":memory:");
			for (let version = 0; version < SCHEMA_VERSION; version++) {
				const db = new Db(":memory:");
				try {
					for (const migration of MIGRATIONS.slice(0, version)) db.exec(migration.sql);
					if (version > 0)
						db.raw.query("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(String(version));
					expect(migrate(db, ":memory:"), `upgrade from schema ${version}`).toEqual({
						from: version,
						to: SCHEMA_VERSION,
						backup: null,
					});
					expect(schema(db)).toEqual(schema(fresh));
				} finally {
					db.close();
				}
			}
		} finally {
			fresh.close();
		}
	});

	for (const [name, sql] of [
		["B: nullable column with a non-NULL default", "ALTER TABLE changes ADD COLUMN probe_flag INTEGER DEFAULT 1;"],
		[
			"C: nullable column with a backfill",
			"ALTER TABLE changes ADD COLUMN probe_ended INTEGER; UPDATE changes SET probe_ended = 0;",
		],
		["A: transform existing exported data", "UPDATE changes SET head_sha = lower(head_sha);"],
	] satisfies readonly [string, string][]) {
		for (const archive of [false, true]) {
			test(`archive marks require a version bump for ${name}, archive: ${archive}`, () => {
				const probe = { version: MIGRATIONS.length + 1, name: "probe", sql, archive };
				expect(migrationArchiveMismatches([...MIGRATIONS, probe])).toEqual(archive ? [] : ["probe"]);
			});
		}
	}

	test("archive marks keep NULL defaults and writes to excluded tables compatible", () => {
		const probe = {
			version: MIGRATIONS.length + 1,
			name: "probe",
			archive: false,
			sql: `ALTER TABLE changes ADD COLUMN probe_flag INTEGER DEFAULT (NULL);
				-- UPDATE changes SET probe_flag = 1;
				/* UPDATE changes SET probe_flag = 2; */
				UPDATE change_ends SET at = 3 WHERE 'UPDATE changes SET probe_flag = 3' IS NOT NULL;`,
		};
		expect(migrationArchiveMismatches([...MIGRATIONS, probe])).toEqual([]);
	});

	test("writers that undo a withdrawn decision are called only by the kind handlers", () => {
		// These change standing without a witness on purpose: they put back what a decision did when that decision
		// is withdrawn or stops holding, which is itself a recorded event. Nothing else may reach for them.
		const undo = /\b(restoreLink|dropExcuse|dropResultExcuses|reopenRun|restoreFailures)\(/;
		const callers = files.filter((file) => undo.test(readFileSync(file, "utf8")));
		expect(callers.sort()).toEqual([
			"src/server/decisions/kinds.ts",
			"src/server/evidence/evidence.ts",
			"src/server/runs/runs.ts",
		]);
	});

	test("the web UI imports only the pure core, never the server", () => {
		const offenders = files
			.filter((file) => file.startsWith("src/web/"))
			.flatMap((file) =>
				imports(file)
					.filter((path) => path.includes("/server/") || path.includes("/surfaces/") || path.startsWith("bun:"))
					.map((path) => `${file} imports ${path}`),
			);
		expect(offenders).toEqual([]);
	});
});

describe("the phone layout", () => {
	// Decision 0018: a phone gets a layout of its own, and no style of the desktop changes for it. The first three
	// hold that. The fourth holds what a phone may do while the detail is covered.
	const phone = ':root[data-layout="phone"]';
	const sheets = [...new Glob("src/web/**/*.css").scanSync(".")];

	test("a phone is a device whose first pointer is a finger: a mouse matches no part of the query", () => {
		const query = /export const PHONE\s*=\s*"([^"]+)"/.exec(readFileSync("src/web/lib/layout.ts", "utf8"))?.[1] ?? "";
		const alternatives = query.split(",").map((part) => part.trim());
		expect(alternatives.length).toBeGreaterThan(0);
		expect(alternatives.filter((part) => !part.startsWith("(pointer: coarse) and "))).toEqual([]);
	});

	test("every rule of phone.css applies on a phone only", () => {
		const css = readFileSync("src/web/phone.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
		const selectors = [...css.matchAll(/(?:^|[{}])\s*([^{}@]+?)\s*\{/g)].flatMap((rule) =>
			(rule[1] ?? "")
				// A comma inside :is(...) separates arguments, not selectors.
				.replace(/\([^()]*\)/g, "()")
				.split(",")
				.map((selector) => selector.trim()),
		);
		expect(selectors.length).toBeGreaterThan(20);
		expect(selectors.filter((selector) => !selector.startsWith(phone))).toEqual([]);
	});

	test("no other stylesheet has a rule for the phone, so the desktop's styles say nothing about it", () => {
		expect(sheets).toContain("src/web/phone.css");
		expect(
			sheets.filter((file) => file !== "src/web/phone.css" && readFileSync(file, "utf8").includes("data-layout")),
		).toEqual([]);
	});

	test("the columns of the app start with the sidebar's width, which one stylesheet says", () => {
		// Each screen has its own columns, and until decision 0020 each wrote the sidebar's width as a number.
		// The collapsed sidebar then had one set of columns for all of them: it took the room of Queue's and
		// Runs' right pane and of the whole of Settings. A screen that names the variable gets the collapsed
		// sidebar, and the width of a narrower window, without saying anything about either.
		const desktop = sheets.filter((file) => file !== "src/web/phone.css");
		// A rule is about the app's columns when `#app` is what its selector ends in, whatever stands before it
		// (`body #app:has(.pane)` as much as `#app.zoom`), and not when it is about something inside the app.
		const subject = (selector: string): string =>
			selector
				.replace(/\([^()]*\)|\[[^\]]*\]/g, "")
				.trim()
				.split(/[\s>+~]+/)
				.at(-1) ?? "";
		const columns = desktop.flatMap((file) =>
			[
				...readFileSync(file, "utf8")
					.replace(/\/\*[\s\S]*?\*\//g, "")
					.matchAll(/(?<=^|[{}])\s*([^{}@]+?)\s*\{([^{}]*)\}/g),
			].flatMap((rule) => {
				const selectors = (rule[1] ?? "").replace(/\([^()]*\)/g, "()").split(",");
				const found = /grid-template-columns:\s*([^;]+);/.exec(rule[2] ?? "");
				return found && selectors.some((selector) => subject(selector).startsWith("#app"))
					? [{ file, selector: (rule[1] ?? "").replace(/\s+/g, " "), columns: (found[1] ?? "").replace(/\s+/g, " ") }]
					: [];
			}),
		);
		// The five screens, at three widths of the window each, and the widened case pane.
		expect(columns.length).toBeGreaterThanOrEqual(16);
		expect(columns.filter((rule) => !rule.columns.startsWith("var(--side-width) "))).toEqual([]);
		expect(
			desktop.filter(
				(file) => file !== "src/web/base.css" && /--side-(width|open|freed)\s*:/.test(readFileSync(file, "utf8")),
			),
		).toEqual([]);
	});

	test("the bindings marked `list`, which run on a phone while the detail is covered, are the ones named here", () => {
		// `list: true` lets a key or the palette run a binding while the detail of the selected row is covered
		// (`Binding.list` in src/web/lib/keys.ts). An answer, a result, an archive or an accepted proposal marked
		// so would be recorded about something nobody had opened. Whoever adds a binding here says that it goes
		// somewhere or opens something new. The test reads the source as text: it shows a reviewer every mark
		// written as a literal, and cannot see one that is computed.
		const sources = files
			.filter((file) => file.startsWith("src/web/"))
			.map((file) => ({
				file,
				// Without comments, where "the list: ..." is prose.
				text: readFileSync(file, "utf8")
					.replace(/\/\*[\s\S]*?\*\//g, "")
					.replace(/^\s*\/\/.*$/gm, ""),
			}));
		const marked = sources
			.flatMap(({ file, text }) =>
				[...text.matchAll(/label:\s*(["`])([^"`]+)\1,[^{}]*?\blist\s*:\s*true\b/g)].map(
					(match) => `${file}: ${(match[2] ?? "").replace(/\$\{[^}]*\}/g, "…")}`,
				),
			)
			.sort();
		expect(marked).toEqual([
			"src/web/app.tsx: All keys",
			"src/web/app.tsx: Close palette / keys",
			"src/web/app.tsx: Docs for this screen",
			"src/web/app.tsx: Go home",
			// One binding for each of the five screens: the label is a template, and "…" stands for the screen.
			"src/web/app.tsx: Go to …",
			"src/web/app.tsx: Jump to or run",
			"src/web/app.tsx: Sign out",
			"src/web/app.tsx: Switch project",
			"src/web/runs/index.tsx: Plan run",
			// While its form is open: closing a form decides nothing, and a phone has no Escape key.
			"src/web/suite/bindings.ts: Cancel new folder",
			"src/web/suite/bindings.ts: Cancel tag",
			"src/web/suite/bindings.ts: Filter",
			"src/web/suite/bindings.ts: New case",
			// It makes a folder, whose form the shell shows by opening the sidebar, and decides nothing about a case.
			"src/web/suite/bindings.ts: New folder",
		]);
		// Every `list` property in the source is one of those: written `true`, and where the pattern above reads it.
		const values = sources.flatMap(({ file, text }) =>
			[...text.matchAll(/\blist\s*:\s*([^,}\n]+)/g)].map((match) => `${file}: ${(match[1] ?? "").trim()}`),
		);
		expect(values.filter((value) => !value.endsWith(": true"))).toEqual([]);
		expect(values.length).toBe(marked.length);
	});
});

describe("the registry", () => {
	test("every operation registers the reply contract used by clients", () => {
		expect(OP_LIST.map((op) => op.name).sort()).toEqual(Object.keys(REPLIES).sort());
		for (const [name, schema] of Object.entries(REPLIES))
			expect(OP_LIST.find((op) => op.name === name)?.output).toBe(schema);
	});

	test("every statement the server can run prepares against the schema", () => {
		const db = new Db(":memory:");
		migrate(db, ":memory:");
		const broken: string[] = [];
		for (const text of declaredSql()) {
			try {
				db.raw.prepare(text).finalize();
			} catch (error) {
				broken.push(
					`${error instanceof Error ? error.message : error}\n  in: ${text.replace(/\s+/g, " ").slice(0, 160)}`,
				);
			}
		}
		db.close();
		expect(broken).toEqual([]);
		expect(declaredSql().length).toBeGreaterThan(150);
	});

	test("every operation is declared once, with a summary; the agent surface is at most ten tools", () => {
		expect(new Set(OP_LIST.map((op) => op.name)).size).toBe(OP_LIST.length);
		for (const op of OP_LIST) expect(op.summary.length).toBeGreaterThan(20);
		expect(MCP_OPS.length).toBeLessThanOrEqual(10);
	});

	test("a pipeline's token reaches attach, report, change, announce, work and gate", () => {
		// `record` is all a pipeline's token holds by default, so an operation that accepts it is one more thing a
		// secret in a CI system can do. Adding to this list is a decision (docs/decisions/0014), not a copy of the
		// nearest operation: `change`, which says that a pull request ended, came with decision 0022, and `announce` with decision 0046.
		// `attach` appends only to the producer's own evidence (decision 0065). `gate` is
		// also the one operation that accepts either of two capabilities.
		const accepts = (capability: "record" | "read") =>
			OP_LIST.filter((op) => needs(op.needs).includes(capability)).map((op) => op.name);
		expect(accepts("record")).toEqual(["attach", "report", "change", "announce", "work", "gate"]);
		expect(OP_LIST.filter((op) => typeof op.needs !== "string").map((op) => op.name)).toEqual(["gate"]);
		// What a pipeline may be let do besides: the reads, and nothing that writes.
		expect(OP_LIST.filter((op) => accepts("read").includes(op.name) && op.effect !== "read")).toEqual([]);
	});

	test("the operations any signed-in caller may run are session and credential, and one function says whose things they touch", () => {
		// `self` asks for no capability: whoever is signed in runs the operation, on what is their own. Whether
		// something is the caller's own, or is anyone's because the caller is a person who administers, is
		// decided by `mayActFor` in `identity.ts` and nowhere else. An operation that compared ids itself, or
		// looked for `admin` itself, would be a second rule, and the two would drift.
		const self = OP_LIST.filter((op) => op.needs === "self");
		expect(self.map((op) => op.name)).toEqual(["session", "credential"]);
		for (const op of OP_LIST.filter((op) => ["session", "credential", "invitation"].includes(op.name)))
			expect(`${op.name}: ${op.mcp}`).toBe(`${op.name}: null`);
		const declaring = files.filter((file) => /needs: "self"/.test(readFileSync(file, "utf8")));
		expect(declaring).toEqual(["src/server/ops/people.ts"]);
		const source = readFileSync("src/server/ops/people.ts", "utf8");
		expect(source).toContain("mayActFor(");
		expect(source.match(/actor\.id\s*[!=]==|[!=]==\s*env\.actor\.id|includes\("admin"\)/g) ?? []).toEqual([]);
		const deciding = files.filter((file) => /function mayActFor\b/.test(readFileSync(file, "utf8")));
		expect(deciding).toEqual(["src/server/identity/identity.ts"]);
	});

	test("no operation takes a password: no field of any input schema is named like one", () => {
		// The registry keeps a digest of every request that carries a command id, and an operation's input is
		// what the CLI takes as flags, which a shell keeps in its history. A secret a person chose goes through
		// the sign-in routes (`src/surfaces/signin.ts`) and never through here.
		const named: string[] = [];
		const walk = (op: string, node: unknown): void => {
			if (Array.isArray(node)) for (const item of node) walk(op, item);
			else if (typeof node === "object" && node !== null) {
				for (const [key, value] of Object.entries(node)) {
					if (key === "properties" && typeof value === "object" && value !== null)
						for (const field of Object.keys(value))
							if (/password|passphrase|secret|pwd/i.test(field)) named.push(`${op}.${field}`);
					walk(op, value);
				}
			}
		};
		for (const op of OP_LIST) walk(op.name, z.toJSONSchema(op.input, { io: "input", unrepresentable: "any" }));
		expect(named).toEqual([]);
		// The check finds a field it is given, at any depth.
		walk("example", z.toJSONSchema(z.object({ nested: z.array(z.object({ newPassword: z.string() })) })));
		expect(named).toEqual(["example.newPassword"]);
	});

	test("there is no second way to do what propose, report, plan and decide do", () => {
		const forbidden = [
			"createCase",
			"updateCase",
			"moveCase",
			"linkTest",
			"quarantine",
			"createRun",
			"addResult",
			"closeRun",
			"approve",
		];
		expect(OP_LIST.map((op) => op.name).filter((name) => forbidden.includes(name))).toEqual([]);
	});
});

describe("the codes of a refusal", () => {
	test("the error codes are written once, in src/core/api.ts", () => {
		// A reply that did not run says why with one of `ERROR_CODES`. The status of each, the API description and
		// the schemas with which the CLI, the web client and the reader threads read a reply all take that list.
		// Each of them once had a copy of its own, and a code added to one and not to the others was a reply some
		// client could not read. Four of the codes written side by side, as a union or as an array, are a copy.
		// (Three are not: what became of a decision is `conflict`, `forbidden` or `invalid` among other words.)
		const code = `["'\`](?:${ERROR_CODES.join("|")})["'\`]`;
		const copy = new RegExp(`${code}(?:\\s*[,|]\\s*${code}){3,}`, "g");
		const copies = files.flatMap((file) => [...readFileSync(file, "utf8").matchAll(copy)].map(() => file));
		expect(copies).toEqual(["src/core/api.ts"]);
		// What is made from the list holds every code of it: a status for each, and each in the API description.
		expect(Object.keys(HTTP_STATUS).sort()).toEqual([...ERROR_CODES].sort());
		const described = z
			.object({
				components: z.object({
					schemas: z.object({
						Failed: z.object({
							properties: z.object({
								error: z.object({ properties: z.object({ code: z.object({ enum: z.array(z.string()) }) }) }),
							}),
						}),
					}),
				}),
			})
			.parse(openApi()).components.schemas.Failed.properties.error.properties.code.enum;
		expect(described).toEqual([...ERROR_CODES]);
	});
});

/** Files a machine makes and nobody commits; `.env.example` is committed and is read. */
export const LOCAL = /^(\.env(?!\.example$)|bench\/results-.*\.json$|\.[0-9a-f]+-[0-9a-f]+\.bun-build$)/;

/**
 * Every text file of the checkout, tracked or not: scratch left in the tree is read too. Bun writes an executable it
 * is building to `.<hash>-<number>.bun-build` in the directory it was started in, and does not always remove it. That
 * file holds the whole source: seen while `test/headers.test.ts` still built from here, it failed a test that read it
 * (2026-10-13, on macOS, in one check of two). The test now builds in its own directory (#401); `bun run build` still
 * makes one here.
 */
function wholeTree(): string[] {
	const outside = new Set([".git", "node_modules", "dist", ".mainworthy", ".casebook", "test-results"]);
	const binary = /\.(png|jpe?g|gif|ico|gz|db|db-wal|db-shm)$/;
	return readdirSync(".", { withFileTypes: true })
		.filter((entry) => !outside.has(entry.name))
		.flatMap((entry) =>
			entry.isDirectory() ? [...new Glob(`${entry.name}/**/*`).scanSync({ cwd: ".", dot: true })] : [entry.name],
		)
		.filter((file) => !binary.test(file) && !LOCAL.test(file));
}

/** The tailnet names in `text` that are not under `example.ts.net`, the one name this repository may carry. */
export function foreignTailnetNames(text: string): string[] {
	return (text.match(/\b(?:[\w-]+\.)+ts\.net\b/gi) ?? []).filter((name) => !/(?:^|\.)example\.ts\.net$/i.test(name));
}

describe("the project's name", () => {
	test("the former name appears only where an install or a deployment still carries it", () => {
		// The project was called Casebook until 2026-10-13 (decision 0015). Each file here says why it still
		// says so. A new mention anywhere else fails: use the current name, or add the file with its reason.
		const allowed: Record<string, string> = {
			".gitignore": "a checkout made before the rename keeps its `.casebook` directory",
			"CHANGELOG.md": "the entry for the rename",
			"README.md": "says what the project was called",
			"docs/decisions/0014-pipeline-token-and-ci-instance.md": "the address of the existing deployment",
			"docs/decisions/0015-the-project-is-called-mainworthy.md": "the decision",
			"docs/deploy.md": "the existing deployment's names, and how to move them",
			"src/cli/startup.test.ts": "starts the server on an install under the former name",
			"src/server/kernel/former-name.test.ts": "the carry-over of a former install",
			"src/server/kernel/former-name.ts": "the carry-over of a former install",
			"src/server/kernel/migrations/0001_init.sql": "a shipped migration is never edited",
			"src/server/transfer/transfer.test.ts": "an archive exported under the former name",
			"src/server/transfer/transfer.ts": "an archive exported under the former name",
			"src/surfaces/formats/junit.test.ts": "a report that names its case with the former property",
			"scripts/work/release.ts": "releases the `.casebook` of an older checkout",
			"src/surfaces/formats/junit.ts": "a report that names its case with the former property",
			"src/web/lib/former-name.test.ts": "what a browser kept under the former name",
			"src/web/lib/former-name.ts": "what a browser kept under the former name",
			"test/architecture.test.ts": "this list",
			"test/e2e/shell.test.ts": "what a browser kept under the former name",
		};
		const found = wholeTree().filter((file) => /casebook/i.test(readFileSync(file, "utf8")));
		expect(found.sort()).toEqual(Object.keys(allowed).sort());
	});
});

describe("a public repository", () => {
	test("no file names a tailnet: the owner's real one is written example.ts.net", () => {
		// The repository has been public since 2026-10-13 (the owner); commits before that day still carry the
		// real name, and the history was not rewritten.
		expect([".env", ".env.local", ".env.example"].map((name) => LOCAL.test(name))).toEqual([true, true, false]);
		expect(foreignTailnetNames("https://mainworthy.example.ts.net and example.ts.net")).toEqual([]);
		// Built in two parts: this file is read by the check it runs.
		const foreign = `casebook.tail1a2b3.${"ts"}.net`;
		expect(foreignTailnetNames(`curl https://${foreign}/healthz`)).toEqual([foreign]);
		const found = wholeTree().flatMap((file) =>
			foreignTailnetNames(readFileSync(file, "utf8")).map((name) => `${file}: ${name}`),
		);
		expect(found).toEqual([]);
	});
});

describe("the browser tests' deadlines", () => {
	// One deadline for every wait of a browser test, `SETTLES` in test/e2e/support.ts. A file's own, from 3 to 8 s,
	// measured how busy the machine was and was half of all the flaky-test issues (#672, 2026-10-20).
	const settles = Number(
		/export const SETTLES = ([\d_]+);/.exec(readFileSync("test/e2e/support.ts", "utf8"))?.[1]?.replaceAll("_", ""),
	);
	const ownDeadlines = (text: string): string[] =>
		[...text.matchAll(/setDefaultTimeout\(|setDefaultNavigationTimeout\(|timeout: ([\d_]+)/g)]
			.filter((match) => match[1] === undefined || Number(match[1].replaceAll("_", "")) < settles)
			.map((match) => match[0]);
	test("a browser test sets no deadline shorter than the suite's", () => {
		expect(ownDeadlines("page.setDefaultTimeout(5000); await x.waitFor({ timeout: 4000 });")).toEqual([
			"setDefaultTimeout(",
			"timeout: 4000",
		]);
		expect(ownDeadlines("await x.waitFor({ timeout: 30000 });")).toEqual([]);
		const found = [...new Glob("test/e2e/*.ts").scanSync(".")]
			.filter((file) => file !== "test/e2e/support.ts")
			.flatMap((file) => ownDeadlines(readFileSync(file, "utf8")).map((deadline) => `${file}: ${deadline}`));
		expect(found).toEqual([]);
	});
});
