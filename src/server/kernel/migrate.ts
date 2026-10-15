// Versioned migrations, run on start in every layer (decision 0002, rule 8).
import { existsSync } from "node:fs";
import type { Db } from "./db.ts";
import init from "./migrations/0001_init.sql" with { type: "text" };
import sessions from "./migrations/0002_sessions.sql" with { type: "text" };
import tokenLimits from "./migrations/0003_token_limits.sql" with { type: "text" };
import people from "./migrations/0004_people.sql" with { type: "text" };
import changeEnds from "./migrations/0005_change_ends.sql" with { type: "text" };
import trackerRequests from "./migrations/0019_tracker_requests.sql" with { type: "text" };

/**
 * In order. A migration is never edited after it ships; a change is a new entry.
 * Versions are contiguous from 1, and a branch takes the next free number when it lands.
 *
 * `archive` says whether the migration changes what an archive holds: a table or a column of the tables an export
 * writes. One that only adds a table an archive leaves out (`sessions`), or columns to one (`tokens`), does not,
 * and an archive taken before it still imports after it.
 */
export const MIGRATIONS: readonly { version: number; name: string; sql: string; archive: boolean }[] = [
	{ version: 1, name: "init", sql: init, archive: true },
	{ version: 2, name: "sessions", sql: sessions, archive: false },
	{ version: 3, name: "token_limits", sql: tokenLimits, archive: false },
	{ version: 4, name: "people", sql: people, archive: false },
	{ version: 5, name: "change_ends", sql: changeEnds, archive: false },
	{ version: 19, name: "tracker_requests", sql: trackerRequests, archive: false },
];

export const SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0;

/**
 * The version of what an archive holds: the last migration that changed it. An export writes this number and an
 * import requires it, so the database's schema can move on without refusing every archive taken before.
 */
export const ARCHIVE_VERSION = MIGRATIONS.findLast((migration) => migration.archive)?.version ?? 0;

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
