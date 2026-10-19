// Versioned migrations, run on start in every layer (decision 0002, rule 8).
import { closeSync, existsSync, fsyncSync, openSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Db } from "./db.ts";
import init from "./migrations/0001_init.sql" with { type: "text" };
import sessions from "./migrations/0002_sessions.sql" with { type: "text" };
import tokenLimits from "./migrations/0003_token_limits.sql" with { type: "text" };
import people from "./migrations/0004_people.sql" with { type: "text" };
import changeEnds from "./migrations/0005_change_ends.sql" with { type: "text" };
import trackerRequests from "./migrations/0006_tracker_requests.sql" with { type: "text" };
import nothingRequired from "./migrations/0007_nothing_required.sql" with { type: "text" };
import scopeMoves from "./migrations/0008_scope_moves.sql" with { type: "text" };
import demoProjects from "./migrations/0009_demo_projects.sql" with { type: "text" };
import changeHead from "./migrations/0010_change_head.sql" with { type: "text" };
import attachments from "./migrations/0011_attachments.sql" with { type: "text" };
import teams from "./migrations/0012_teams.sql" with { type: "text" };
import resultExcuses from "./migrations/0013_result_excuses.sql" with { type: "text" };
import commitStatuses from "./migrations/0014_commit_statuses.sql" with { type: "text" };
import releases from "./migrations/0015_releases.sql" with { type: "text" };
import decisionEvidence from "./migrations/0016_decision_evidence.sql" with { type: "text" };
import slotExcuses from "./migrations/0017_slot_excuses.sql" with { type: "text" };
import trackerPolls from "./migrations/0018_tracker_polls.sql" with { type: "text" };
import grantRoles from "./migrations/0019_grant_roles.sql" with { type: "text" };
import mailContacts from "./migrations/0020_mail_contacts.sql" with { type: "text" };
import quarantines from "./migrations/0021_quarantines.sql" with { type: "text" };

import fragments from "./migrations/0022_fragments.sql" with { type: "text" };
import quarantineObservations from "./migrations/0023_quarantine_observations.sql" with { type: "text" };
import projectRemovalIndexes from "./migrations/0024_project_removal_indexes.sql" with { type: "text" };
import removalIndexCost from "./migrations/0025_removal_index_cost.sql" with { type: "text" };
import reportShards from "./migrations/0026_report_shards.sql" with { type: "text" };
import resultsAt from "./migrations/0027_results_at.sql" with { type: "text" };
import plannedRunIndex from "./migrations/0028_planned_run_index.sql" with { type: "text" };
import excuseSignatureIndex from "./migrations/0029_excuse_signature_index.sql" with { type: "text" };
import pinnedSearch from "./migrations/0030_pinned_search.sql" with { type: "text" };

/**
 * In order. A migration is never edited after it ships; a change is a new entry.
 * Versions are contiguous from 1, and a branch takes the next free number when it lands.
 *
 * `archive` says whether the migration breaks archive replay. Changes only to excluded tables do not. Adding
 * nullable, non-key columns without a non-NULL default can stay compatible: import fills missing columns with NULL.
 * Mark such an addition false only when NULL preserves the earlier behavior. Backfills and other data writes to
 * exported tables require a new archive version, even when the table shape stays the same.
 */
export const MIGRATIONS: readonly { version: number; name: string; sql: string; archive: boolean }[] = [
	{ version: 1, name: "init", sql: init, archive: true },
	{ version: 2, name: "sessions", sql: sessions, archive: false },
	{ version: 3, name: "token_limits", sql: tokenLimits, archive: false },
	{ version: 4, name: "people", sql: people, archive: false },
	{ version: 5, name: "change_ends", sql: changeEnds, archive: false },
	{ version: 6, name: "tracker_requests", sql: trackerRequests, archive: false },
	{ version: 7, name: "nothing_required", sql: nothingRequired, archive: true },
	{ version: 8, name: "scope_moves", sql: scopeMoves, archive: false },
	{ version: 9, name: "demo_projects", sql: demoProjects, archive: false },
	{ version: 10, name: "change_head", sql: changeHead, archive: false },
	{ version: 11, name: "attachments", sql: attachments, archive: true },
	{ version: 12, name: "teams", sql: teams, archive: true },
	{ version: 13, name: "result_excuses", sql: resultExcuses, archive: true },
	{ version: 14, name: "commit_statuses", sql: commitStatuses, archive: false },
	{ version: 15, name: "releases", sql: releases, archive: true },
	{ version: 16, name: "decision_evidence", sql: decisionEvidence, archive: false },
	{ version: 17, name: "slot_excuses", sql: slotExcuses, archive: true },
	{ version: 18, name: "tracker_polls", sql: trackerPolls, archive: false },
	{ version: 19, name: "grant_roles", sql: grantRoles, archive: true },
	{ version: 20, name: "mail_contacts", sql: mailContacts, archive: true },
	{ version: 21, name: "quarantines", sql: quarantines, archive: true },
	{ version: 22, name: "fragments", sql: fragments, archive: true },
	{ version: 23, name: "quarantine_observations", sql: quarantineObservations, archive: true },
	{ version: 24, name: "project_removal_indexes", sql: projectRemovalIndexes, archive: false },
	{ version: 25, name: "removal_index_cost", sql: removalIndexCost, archive: false },
	{ version: 26, name: "report_shards", sql: reportShards, archive: false },
	{ version: 27, name: "results_at", sql: resultsAt, archive: false },
	{ version: 28, name: "planned_run_index", sql: plannedRunIndex, archive: false },
	{ version: 29, name: "excuse_signature_index", sql: excuseSignatureIndex, archive: false },
	{ version: 30, name: "pinned_search", sql: pinnedSearch, archive: false },
];

export const SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0;

/**
 * The archive version: the last migration that broke replay of earlier archives. An export writes this number and an
 * import requires it, so the database's schema can move on without refusing every archive taken before.
 */
export const ARCHIVE_VERSION = MIGRATIONS.findLast((migration) => migration.archive)?.version ?? 0;

let pristine: Buffer | null = null;

function schemaImage(): Buffer {
	if (pristine) return pristine;
	const db = new Db(":memory:");
	try {
		migrate(db, ":memory:");
		pristine = db.raw.serialize();
		return pristine;
	} finally {
		db.close();
	}
}

/**
 * Opens a database at the current schema. An in-memory one (tests) starts from a private image of the empty
 * schema, built once per process by the migrations themselves. A file always goes through the migrations: copying
 * the image into a new file would let a stale write-ahead log left beside a deleted database replay onto it.
 */
export function openDatabase(path: string): Db {
	const db = new Db(path === ":memory:" ? schemaImage() : path);
	try {
		migrate(db, path);
		return db;
	} catch (error) {
		db.close();
		throw error;
	}
}

export function schemaVersion(db: Db): number {
	const table = db.raw.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
	if (!table) return 0;
	const row = db.raw.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'").get();
	return row ? Number(row.value) : 0;
}

/**
 * Brings the database to the current schema in one transaction, so a failure leaves the starting version intact.
 * Before changing a database that already holds data, a consistent copy is synced and published next to it
 * (`<file>.v<N>.bak`). Older copies are removed only after all migrations commit and only when this call
 * completed the new copy itself. A pre-existing copy is left alone and never permits cleanup.
 */
export function migrate(db: Db, path: string): { from: number; to: number; backup: string | null } {
	const from = schemaVersion(db);
	if (from > SCHEMA_VERSION) {
		throw new Error(`database schema ${from} is newer than this build (${SCHEMA_VERSION}); upgrade Mainworthy`);
	}
	let backup: string | null = null;
	let wroteBackup = false;
	const pending = MIGRATIONS.filter((m) => m.version > from);
	if (pending.length > 0 && from > 0 && path !== ":memory:") {
		backup = `${path}.v${from}.bak`;
		if (!existsSync(backup)) {
			const temporary = `${backup}.${crypto.randomUUID()}.tmp`;
			try {
				db.raw.query("VACUUM INTO ?").run(temporary);
				const copy = openSync(temporary, "r+");
				try {
					fsyncSync(copy);
				} finally {
					closeSync(copy);
				}
				renameSync(temporary, backup);
				const directory = openSync(dirname(path), "r");
				try {
					fsyncSync(directory);
				} finally {
					closeSync(directory);
				}
				wroteBackup = true;
			} finally {
				rmSync(temporary, { force: true });
			}
		}
	}
	if (pending.length > 0)
		db.transaction(() => {
			for (const migration of pending) {
				db.exec(migration.sql);
				db.raw
					.query(
						"INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
					)
					.run(String(migration.version));
			}
		});
	if (wroteBackup) {
		const directory = dirname(path);
		const prefix = `${basename(path)}.v`;
		try {
			for (const file of readdirSync(directory, { withFileTypes: true })) {
				if (!file.isFile() || !file.name.startsWith(prefix)) continue;
				const version = /^([1-9]\d*)\.bak$/.exec(file.name.slice(prefix.length))?.[1];
				if (!version || Number(version) >= from) continue;
				const older = join(directory, file.name);
				try {
					rmSync(older, { force: true });
					console.error(`[mainworthy] removed upgrade copy ${JSON.stringify(older)}`);
				} catch (error) {
					console.error(
						`[mainworthy] could not remove upgrade copy ${JSON.stringify(older)}: ${error instanceof Error ? error.message : error}`,
					);
				}
			}
		} catch (error) {
			console.error(
				`[mainworthy] could not list upgrade copies in ${JSON.stringify(directory)}: ${error instanceof Error ? error.message : error}`,
			);
		}
	}
	return { from, to: SCHEMA_VERSION, backup };
}
