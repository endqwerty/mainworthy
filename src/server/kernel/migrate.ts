// Versioned migrations, run on start in every layer (decision 0002, rule 8).
import { existsSync } from "node:fs";
import type { Db } from "./db.ts";
import init from "./migrations/0001_init.sql" with { type: "text" };

/** In order. A migration is never edited after it ships; a change is a new entry. */
export const MIGRATIONS: readonly { version: number; name: string; sql: string }[] = [
	{ version: 1, name: "init", sql: init },
];

export const SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0;

export function schemaVersion(db: Db): number {
	const table = db.raw.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
	if (!table) return 0;
	const row = db.raw.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'").get();
	return row ? Number(row.value) : 0;
}

/**
 * Brings the database to the current schema. Each migration runs in its own transaction, so a failure leaves
 * the previous version intact. Before changing a database that already holds data, a consistent copy is written
 * next to it (`<file>.v<N>.bak`): that copy is the way back when an upgrade goes wrong.
 */
export function migrate(db: Db, path: string): { from: number; to: number; backup: string | null } {
	const from = schemaVersion(db);
	if (from > SCHEMA_VERSION) {
		throw new Error(`database schema ${from} is newer than this build (${SCHEMA_VERSION}); upgrade Mainworthy`);
	}
	let backup: string | null = null;
	const pending = MIGRATIONS.filter((m) => m.version > from);
	if (pending.length > 0 && from > 0 && path !== ":memory:") {
		backup = `${path}.v${from}.bak`;
		if (!existsSync(backup)) db.raw.query("VACUUM INTO ?").run(backup);
	}
	for (const migration of pending) {
		db.transaction(() => {
			db.exec(migration.sql);
			db.raw
				.query(
					"INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
				)
				.run(String(migration.version));
		});
	}
	return { from, to: SCHEMA_VERSION, backup };
}
