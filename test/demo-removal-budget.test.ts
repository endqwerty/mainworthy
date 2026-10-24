import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { budget } from "../scripts/budget.ts";
import { Db } from "../src/server/kernel/db.ts";
import { migrate } from "../src/server/kernel/migrate.ts";
import { removeProject } from "../src/server/transfer/transfer.ts";
import { removalFixture } from "./demo-removal-fixture.ts";

test("deferred demo removal does not scan another project's excuses for every result", () => {
	mkdirSync(join(homedir(), ".cache"), { recursive: true });
	const directory = mkdtempSync(join(homedir(), ".cache", "mainworthy-removal-"));
	const db = new Db(join(directory, "mainworthy.db"));
	try {
		migrate(db, ":memory:");
		removalFixture(db, 5_000);
		// The fixture plus removal crosses SQLite's auto-checkpoint threshold. Finish the fixture's disk writes
		// here so the budget includes removal and its commit, without also syncing the setup's WAL pages.
		db.checkpoint();
		const start = performance.now();
		// The enforced transfer path: one transaction, foreign keys checked at commit.
		// The standalone path turns foreign keys off and would pass without the indexes this budget guards.
		const removed = db.transaction(() => {
			db.raw.exec("PRAGMA defer_foreign_keys = ON");
			return removeProject(db, "removing", undefined, "deferred");
		});
		const ms = performance.now() - start;
		console.log(`removeProject: ${ms.toFixed(1)} ms, ${removed.tables.results} results removed`);
		expect(removed.tables.results).toBe(5_000);
		expect(db.raw.query("SELECT count(*) AS n FROM result_excuses").get()).toEqual({ n: 5_000 });
		expect(db.raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
		budget("deferred removal of 5000 results: transaction and commit elapsed", ms, 250, "ms");
	} finally {
		db.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
