import { expect, test } from "bun:test";
import { budget } from "../scripts/budget.ts";
import { removeProject } from "../src/server/transfer/transfer.ts";
import { removalFixture } from "./demo-removal-fixture.ts";
import { writerDatabase } from "./pg-scopes.ts";

test("deferred demo removal does not scan another project's excuses for every result", async () => {
	await using db = await writerDatabase();
	await removalFixture(db, 5_000);
	const start = performance.now();
	const removed = await db.transaction(() =>
		db.checkedBulk(() => removeProject(db, "removing", undefined, "deferred")),
	);
	const ms = performance.now() - start;
	console.log(`removeProject: ${ms.toFixed(1)} ms, ${removed.tables.results} results removed`);
	expect(removed.tables.results).toBe(5_000);
	expect(await db.allDynamic("SELECT count(*) AS n FROM result_excuses")).toEqual([{ n: 5_000 }]);
	budget("deferred removal of 5000 results: transaction and commit elapsed", ms, 250, "ms");
});
