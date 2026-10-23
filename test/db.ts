// One immutable baseline template per cluster; each caller gets a disposable clone.
import { afterAll } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { cluster } from "../scripts/pg.ts";
import { Database, type DatabaseAdmin, databaseAdmin } from "../src/server/kernel/db.ts";

export type TestDatabase = {
	url: string;
	/** Schedules the drop. drainDatabaseDrops waits for its completion at file teardown. */
	close(): Promise<void>;
	readonly timings: { cloneMs: number; dropMs: number | null };
};
const fixtures = new Set<TestDatabase>();
const pendingDrops = new Set<Promise<void>>();
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
	const name = `mainworthy_template_${baseline.hash.slice(0, 20)}`;
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
	const { adminUrl } = await cluster();
	const name = `mw_test_${process.pid}_${randomUUID().replaceAll("-", "")}`;
	const cloneMs = await databaseAdmin(adminUrl, async (admin) => {
		const template = await ensureTemplate(admin, adminUrl, input.schema ?? "baseline");
		const start = performance.now();
		await admin.exec(`CREATE DATABASE ${identifier(name)} TEMPLATE ${identifier(template)}`);
		return performance.now() - start;
	});
	const timings = { cloneMs, dropMs: null as number | null };
	let closed = false;
	const fixture: TestDatabase = {
		url: databaseUrl(adminUrl, name),
		timings,
		async close() {
			if (closed) return;
			closed = true;
			fixtures.delete(fixture);
			const dropping = databaseAdmin(adminUrl, async (admin) => {
				const start = performance.now();
				await admin.exec(`DROP DATABASE IF EXISTS ${identifier(name)} WITH (FORCE)`);
				timings.dropMs = performance.now() - start;
			});
			pendingDrops.add(dropping);
			void dropping
				.catch((error: unknown) => {
					dropErrors.push(error);
				})
				.finally(() => pendingDrops.delete(dropping));
		},
	};
	fixtures.add(fixture);
	return fixture;
}
export async function drainDatabaseDrops(): Promise<void> {
	await Promise.allSettled([...pendingDrops]);
	if (dropErrors.length) throw new AggregateError(dropErrors.splice(0), "test database cleanup failed");
}
afterAll(async () => {
	await Promise.all([...fixtures].map((fixture) => fixture.close()));
	await drainDatabaseDrops();
});
