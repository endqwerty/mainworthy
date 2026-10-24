import { createHash } from "node:crypto";
import { type Database, migrationLock, type ReadDb, sql } from "./db.ts";
import projectLocks from "./migrations/0002-project-locks.sql" with { type: "text" };
import baseline from "./schema.sql" with { type: "text" };

// PostgreSQL starts a new schema lineage; archive 43 follows the final SQLite archive format (42).
export const SCHEMA_VERSION = 2;
export const ARCHIVE_VERSION = 43;
export const migrationHash = createHash("sha256").update(projectLocks).digest("hex");
const hash = createHash("sha256").update(baseline).digest("hex");

export function baselineSchema(): { sql: string; hash: string } {
	return { sql: baseline, hash };
}

const Q = {
	ledgerExists: sql<readonly [], { present: boolean }>("SELECT to_regclass('meta') IS NOT NULL AS present"),
	ledger: sql<readonly [], { key: string; value: string }>(
		"SELECT key, value FROM meta WHERE key IN ('schema_version', 'baseline_hash', 'archive_version')",
	),
	put: sql<{ key: string; value: string }>("INSERT INTO meta (key, value) VALUES ($key, $value)"),
};

export async function schemaVersion(db: ReadDb): Promise<number> {
	if (!(await db.one(Q.ledgerExists)).present) return 0;
	const rows = await db.all(Q.ledger);
	const version = rows.find((row) => row.key === "schema_version")?.value;
	if (version === undefined) throw new Error("Database has a meta table but no schema ledger");
	if (!/^[1-9]\d*$/.test(version)) throw new Error("Invalid database schema version");
	const parsed = Number(version);
	if (!Number.isSafeInteger(parsed)) throw new Error("Invalid database schema version");
	return parsed;
}

/** The migration lease holds its own session lock from before the ledger read through COMMIT. */
export async function migrate(database: Database): Promise<void> {
	await migrationLock(database, async (db) => {
		await db.transaction(async () => {
			const version = await schemaVersion(db);
			if (version > SCHEMA_VERSION) {
				throw new Error(`Database schema ${version} is newer than this build (${SCHEMA_VERSION}); upgrade Mainworthy`);
			}
			if (version !== 0) {
				const ledger = new Map((await db.all(Q.ledger)).map((row) => [row.key, row.value]));
				if (ledger.get("baseline_hash") !== hash || ledger.get("archive_version") !== String(ARCHIVE_VERSION)) {
					throw new Error("Database baseline does not match this build");
				}
				if (version < 2) {
					await db.exec(projectLocks);
					await db.exec("UPDATE meta SET value = '2' WHERE key = 'schema_version'");
				}
				return;
			}
			await db.exec(baseline);
			await db.exec(projectLocks);
			for (const [key, value] of Object.entries({
				schema_version: String(SCHEMA_VERSION),
				baseline_hash: hash,
				archive_version: String(ARCHIVE_VERSION),
			})) {
				await db.run(Q.put, { key, value });
			}
		});
	});
}
