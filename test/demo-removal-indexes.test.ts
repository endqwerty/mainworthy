import { expect, test } from "bun:test";
import { removeProject } from "../src/server/transfer/transfer.ts";
import { removalFixture } from "./demo-removal-fixture.ts";
import { writerDatabase } from "./pg-scopes.ts";

const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
test("ordinary nullable reference lookups use the retained partial indexes", async () => {
	await using db = await writerDatabase();
	await db.transaction(async () => {
		await db.exec("SET LOCAL enable_seqscan = off");
		for (const [table, column, index] of [
			["results", "corrects", "results_corrects"],
			["results", "quarantine_exit", "results_quarantine_exit"],
			["result_excuses", "slot", "result_excuses_slot"],
		]) {
			const plan = await db.allDynamic<{ "QUERY PLAN": string }>(`EXPLAIN SELECT 1 FROM ${table} WHERE ${column} = 1`);
			expect(plan.some((row) => row["QUERY PLAN"].includes(index ?? "missing"))).toBe(true);
			expect(
				await db.allDynamic(
					"SELECT indexname FROM pg_indexes WHERE indexname = $1 AND indexdef LIKE '%WHERE%IS NOT NULL%'",
					[index ?? ""],
				),
			).toHaveLength(1);
		}
	});
	await removalFixture(db, 1);
	expect((await removeProject(db, "removing")).tables.results).toBe(1);
	expect(await db.allDynamic("SELECT key FROM projects")).toEqual([{ key: "retained" }]);
});

for (const nested of [false, true])
	test(`removal rolls back a cross-project reference, nested=${nested}`, async () => {
		await using db = await writerDatabase();
		await removalFixture(db, 2);
		await db.transaction(() => db.exec("UPDATE results SET corrects = 1 WHERE project = 901"));
		const attempt = async () => {
			await expect(removeProject(db, "removing")).rejects.toThrow(/foreign key/i);
			expect(
				await db.allDynamic("SELECT project, count(*) AS n FROM results GROUP BY project ORDER BY project"),
			).toEqual([
				{ project: 900, n: 2 },
				{ project: 901, n: 2 },
			]);
		};
		if (nested) await db.transaction(attempt);
		else await attempt();
		expect(db.inTransaction).toBe(false);
	});

for (const action of ["finish", "cancel", "violate"] as const)
	test(`the reset checks later writes and restores data on ${action}`, async () => {
		await using db = await writerDatabase();
		await removalFixture(db, 2);
		const run = () =>
			db.transaction(async () => {
				const steps = db.checkedBulkSteps(async function* () {
					await removeProject(db, "removing", undefined, "deferred");
					yield;
					if (action === "violate") await db.exec("UPDATE results SET corrects = 1 WHERE project = 901");
				});
				expect(await steps.next()).toEqual({ value: undefined, done: false });
				expect(await db.allDynamic("SELECT key FROM projects")).toEqual([{ key: "retained" }]);
				if (action === "cancel") await steps.return(undefined);
				else expect(await steps.next()).toEqual({ value: undefined, done: true });
			});
		if (action === "violate") await expect(run()).rejects.toThrow(/foreign key/i);
		else await run();
		expect(await db.allDynamic("SELECT count(*) AS n FROM results")).toEqual([{ n: action === "finish" ? 2 : 4 }]);
		expect(db.inTransaction).toBe(false);
	});

test("every incoming reset reference has an index for its foreign key lookup", async () => {
	await using db = await writerDatabase();
	await removalFixture(db, 2, 20_000);
	const parents = new Set<string>();
	await removeProject(db, "removing", (step) => {
		if (step.startsWith("delete ")) parents.add(step.slice(7));
	});
	const probes = new Set<string>();
	await db.transaction(async () => {
		await db.exec("SET LOCAL enable_seqscan = off");
		for (const table of await db.catalog())
			for (const key of table.foreignKeys) {
				if (!parents.has(key.parent)) continue;
				const plan = await db.allDynamic<{ "QUERY PLAN": string }>(
					`EXPLAIN SELECT 1 FROM ${identifier(table.name)} WHERE ${key.columns.map((column) => `${identifier(column)} = -1`).join(" AND ")}`,
				);
				expect(
					plan.some((row) => /Index|Bitmap/.test(row["QUERY PLAN"])),
					`${table.name}.${key.columns.join(",")} -> ${key.parent}`,
				).toBe(true);
				probes.add(`${table.name}.${key.columns.join(",")} -> ${key.parent}`);
			}
	});
	expect(probes.has("change_ends.receipt -> merge_receipts")).toBe(true);
});
