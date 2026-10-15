import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/server/kernel/db.ts";
import { migrate } from "../src/server/kernel/migrate.ts";
import { removeProject } from "../src/server/transfer/transfer.ts";
import { removalFixture } from "./demo-removal-fixture.ts";

test("removing a demo does not scan another project's excuses for every result", () => {
	mkdirSync(join(homedir(), ".cache"), { recursive: true });
	const directory = mkdtempSync(join(homedir(), ".cache", "mainworthy-removal-"));
	const db = new Db(join(directory, "mainworthy.db"));
	try {
		migrate(db, ":memory:");
		removalFixture(db, 5_000);
		const start = performance.now();
		const removed = removeProject(db, "removing");
		const ms = performance.now() - start;
		console.log(`removeProject: ${ms.toFixed(1)} ms, ${removed.tables.results} results removed`);
		expect(removed.tables.results).toBe(5_000);
		expect(db.raw.query("SELECT count(*) AS n FROM result_excuses").get()).toEqual({ n: 5_000 });
		expect(db.raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
		expect(ms).toBeLessThan(250);
	} finally {
		db.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
