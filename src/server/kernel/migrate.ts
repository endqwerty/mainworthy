import { createHash } from "node:crypto";
import { type Database, migrationLock, type Outside, type ReadDb, sql, type WriteDb } from "./db.ts";
import projectLocks from "./migrations/0002-project-locks.sql" with { type: "text" };
import sharedIdentity from "./migrations/0003-shared-identity.sql" with { type: "text" };
import jobs from "./migrations/0004-jobs.sql" with { type: "text" };
import reportSpans from "./migrations/0005-report-spans.sql" with { type: "text" };
import projectRemovalIndexes from "./migrations/0006-project-removal-indexes.sql" with { type: "text" };
import reportMapPages from "./migrations/0007-report-map-pages.sql" with { type: "text" };
import baseline from "./schema.sql" with { type: "text" };

// PostgreSQL starts a new schema lineage; archive 43 follows the final SQLite archive format (42).
export const SCHEMA_VERSION = 7;
export const ARCHIVE_VERSION = 44;
export const migrationHash = createHash("sha256")
	.update(projectLocks)
	.update(sharedIdentity)
	.update(jobs)
	.update(reportSpans)
	.update(projectRemovalIndexes)
	.update(reportMapPages)
	.digest("hex");
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

/**
 * The indexes of migration 6, one statement each: `CREATE INDEX <name> ON <table> ...`. An upgrade builds them
 * concurrently, one at a time; a new database, empty, builds them in its one transaction.
 */
const CONCURRENT = projectRemovalIndexes
	.split("\n")
	.filter((line) => line.startsWith("CREATE INDEX "))
	.map((line) => {
		const name = /^CREATE INDEX ([a-z_]+) ON /.exec(line)?.[1];
		if (!name) throw new Error(`migration 6 holds an index statement this runner cannot read: ${line}`);
		return { name, text: line.replace(/^CREATE INDEX /, "CREATE INDEX CONCURRENTLY IF NOT EXISTS ") };
	});

const indexState = async (db: WriteDb, name: string): Promise<{ valid: boolean } | null> =>
	(
		await db.allDynamic<{ valid: boolean }>(
			`SELECT x.indisvalid AS valid FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
			 JOIN pg_namespace n ON n.oid = i.relnamespace WHERE n.nspname = current_schema() AND i.relname = $1`,
			[name],
		)
	)[0] ?? null;

/**
 * Builds migration 6's indexes with `CREATE INDEX CONCURRENTLY`, outside a transaction: each build lets writes to its
 * table go on, and each finished index stays built if the process stops, so a start cut off by Cloud Run's startup
 * probe resumes rather than repeats. An index left invalid by a build that was cut off is dropped and built again. The
 * schema ledger moves to 6 only once every index is valid. The migration's session lock keeps a second instance out.
 */
async function buildConcurrently(db: WriteDb, outside: Outside): Promise<void> {
	for (const index of CONCURRENT) {
		if ((await indexState(db, index.name))?.valid === false)
			await outside(`DROP INDEX CONCURRENTLY IF EXISTS ${index.name}`);
		await outside(index.text);
	}
	const invalid = [];
	for (const index of CONCURRENT) if ((await indexState(db, index.name))?.valid !== true) invalid.push(index.name);
	if (invalid.length) throw new Error(`migration 6 left these indexes unbuilt or invalid: ${invalid.join(", ")}`);
	await db.transaction(async () => {
		if ((await schemaVersion(db)) === 5) await db.exec("UPDATE meta SET value = '6' WHERE key = 'schema_version'");
	});
}

/** The migration lease holds its own session lock from before the ledger read through COMMIT. */
export async function migrate(database: Database): Promise<void> {
	await migrationLock(database, async (db, outside) => {
		const concurrent = await db.transaction(async () => {
			const version = await schemaVersion(db);
			if (version > SCHEMA_VERSION) {
				throw new Error(`Database schema ${version} is newer than this build (${SCHEMA_VERSION}); upgrade Mainworthy`);
			}
			if (version !== 0) {
				const ledger = new Map((await db.all(Q.ledger)).map((row) => [row.key, row.value]));
				if (
					ledger.get("baseline_hash") !== hash ||
					ledger.get("archive_version") !== String(version < 7 ? 43 : ARCHIVE_VERSION)
				) {
					throw new Error("Database baseline does not match this build");
				}
				if (version < 2) {
					await db.exec(projectLocks);
					await db.exec("UPDATE meta SET value = '2' WHERE key = 'schema_version'");
				}
				if (version < 3) {
					await db.exec(sharedIdentity);
					await db.exec("UPDATE meta SET value = '3' WHERE key = 'schema_version'");
				}
				if (version < 4) {
					await db.exec(jobs);
					await db.exec("UPDATE meta SET value = '4' WHERE key = 'schema_version'");
				}
				if (version < 5) {
					await db.exec(reportSpans);
					await db.exec("UPDATE meta SET value = '5' WHERE key = 'schema_version'");
				}
				return version < 6;
			}
			await db.exec(baseline);
			await db.exec(projectLocks);
			await db.exec(sharedIdentity);
			await db.exec(jobs);
			await db.exec(reportSpans);
			await db.exec(projectRemovalIndexes);
			await db.exec(reportMapPages);
			for (const [key, value] of Object.entries({
				schema_version: String(SCHEMA_VERSION),
				baseline_hash: hash,
				archive_version: String(ARCHIVE_VERSION),
			})) {
				await db.run(Q.put, { key, value });
			}
			return false;
		});
		if (concurrent) await buildConcurrently(db, outside);
		await db.transaction(async () => {
			if ((await schemaVersion(db)) < 7) {
				await db.exec(reportMapPages);
				await db.exec("UPDATE meta SET value = '7' WHERE key = 'schema_version'");
				await db.exec("UPDATE meta SET value = '44' WHERE key = 'archive_version'");
			}
		});
	});
}
