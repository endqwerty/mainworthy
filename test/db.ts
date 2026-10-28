// One immutable baseline template per cluster; each caller gets a disposable clone.
import { afterAll } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { FAIL_MULTIPLE } from "../scripts/budget.ts";
import { cluster } from "../scripts/pg.ts";
import {
	databaseCreated,
	databaseDropped,
	dropRecordedDatabase,
	recordDatabase,
	releaseDatabase,
} from "../scripts/work/test-databases.ts";
import { Database, type DatabaseAdmin, databaseAdmin } from "../src/server/kernel/db.ts";

export type TestDatabase = {
	url: string;
	/** Schedules the drop; returns whether a live run owner received the release. */
	close(): Promise<boolean>;
	readonly timings: { cloneMs: number; dropMs: number | null };
};
const fixtures = new Set<TestDatabase>();
const pendingDrops = new Set<Promise<void>>();
const deferredDrops = new Set<() => Promise<void>>();
const managed = process.env.MAINWORTHY_TEST_DATABASES;
const dropErrors: unknown[] = [];
const identifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const databaseUrl = (adminUrl: string, name: string): string => {
	const url = new URL(adminUrl);
	url.pathname = `/${name}`;
	return url.toString();
};
async function ensureTemplate(admin: DatabaseAdmin, adminUrl: string, schema: "baseline" | "empty"): Promise<string> {
	// Dynamic import lets kernel-only tests use an empty template while the baseline unit is being built.
	const baseline =
		schema === "baseline"
			? (await import("../src/server/kernel/migrate.ts")).baselineSchema()
			: { sql: "", hash: createHash("sha256").update("empty-v1").digest("hex") };
	const name = `mainworthy_template_${createHash("sha256")
		.update(
			baseline.hash + (schema === "baseline" ? (await import("../src/server/kernel/migrate.ts")).migrationHash : ""),
		)
		.digest("hex")
		.slice(0, 20)}`;
	await admin.all("SELECT pg_advisory_lock(hashtextextended($1::text, 0))", [name]);
	try {
		const existing = await admin.all<{ ready: boolean }>(
			"SELECT datistemplate AS ready FROM pg_database WHERE datname = $1::text",
			[name],
		);
		if (existing[0]?.ready) return name;
		if (existing.length) await admin.exec(`DROP DATABASE ${identifier(name)} WITH (FORCE)`);
		await admin.exec(`CREATE DATABASE ${identifier(name)} LOCALE 'C' TEMPLATE template0`);
		if (schema === "baseline") {
			const database = await Database.open({ url: databaseUrl(adminUrl, name) });
			try {
				await (await import("../src/server/kernel/migrate.ts")).migrate(database);
			} finally {
				await database.close();
			}
		}
		await admin.exec(`ALTER DATABASE ${identifier(name)} IS_TEMPLATE true`);
		return name;
	} finally {
		await admin.all("SELECT pg_advisory_unlock(hashtextextended($1::text, 0))", [name]);
	}
}
export async function testDatabase(input: { schema?: "baseline" | "empty" } = {}): Promise<TestDatabase> {
	const { adminUrl, owned } = await cluster();
	const name = `mw_test_${process.pid}_${randomUUID().replaceAll("-", "")}`;
	const record = recordDatabase(managed, { adminUrl, owned, name });
	const cloneMs = await databaseAdmin(adminUrl, async (admin) => {
		const template = await ensureTemplate(admin, adminUrl, input.schema ?? "baseline");
		const start = performance.now();
		await admin.exec(`CREATE DATABASE ${identifier(name)} TEMPLATE ${identifier(template)}`);
		return performance.now() - start;
	});
	databaseCreated(record);
	const timings = { cloneMs, dropMs: null as number | null };
	let closed = false;
	let released = false;
	const fixture: TestDatabase = {
		url: databaseUrl(adminUrl, name),
		timings,
		async close() {
			if (closed) return released;
			closed = true;
			fixtures.delete(fixture);
			const drop = async () => {
				if (record) {
					timings.dropMs = (await dropRecordedDatabase(record)).ms;
					return;
				}
				await databaseAdmin(adminUrl, async (admin) => {
					const start = performance.now();
					await admin.exec(`DROP DATABASE IF EXISTS ${identifier(name)} WITH (FORCE)`);
					timings.dropMs = performance.now() - start;
				});
				databaseDropped(record);
			};
			if (managed) {
				released = releaseDatabase(record);
				deferredDrops.add(drop);
			} else scheduleDrop(drop);
			return released;
		},
	};
	fixtures.add(fixture);
	return fixture;
}
function scheduleDrop(drop: () => Promise<void>): void {
	const dropping = drop();
	pendingDrops.add(dropping);
	void dropping
		.catch((error: unknown) => {
			dropErrors.push(error);
		})
		.finally(() => pendingDrops.delete(dropping));
}
export async function drainDatabaseDrops(): Promise<void> {
	for (const drop of deferredDrops) {
		deferredDrops.delete(drop);
		scheduleDrop(drop);
	}
	await Promise.allSettled([...pendingDrops]);
	if (dropErrors.length) throw new AggregateError(dropErrors.splice(0), "test database cleanup failed");
}
const databaseCleanups = new Set<() => Promise<void>>();
/** Starts alongside fixture cleanup, so a slow or failed drain cannot skip another database owner. */
export function onDatabaseCleanup(cleanup: () => Promise<void>): void {
	databaseCleanups.add(cleanup);
}
onDatabaseCleanup(async () => {
	if (!managed) {
		await Promise.all([...fixtures].map((fixture) => fixture.close()));
		await drainDatabaseDrops();
	}
});
try {
	afterAll(async () => {
		const results = await Promise.allSettled([...databaseCleanups].map(async (cleanup) => await cleanup()));
		const errors: unknown[] = [];
		for (const result of results) if (result.status === "rejected") errors.push(result.reason);
		if (errors.length) throw new AggregateError(errors, "test database cleanup failed");
	}, FAIL_MULTIPLE * 20_000);
} catch {}
