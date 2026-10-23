import type { App } from "../src/server/kernel/app.ts";
import { type Params, sql, type WriteDb } from "../src/server/kernel/db.ts";
import { testDatabase } from "./db.ts";

function positional(text: string): string {
	let n = 0;
	return text.replaceAll("?", () => `$${++n}`);
}
export async function pgRows<R = Record<string, unknown>>(
	app: App,
	text: string,
	values: readonly import("../src/server/kernel/db.ts").SqlValue[] = [],
): Promise<R[]> {
	return await app.database.read(async (db) => await db.all(sql<Params, R>(positional(text)), values));
}
export async function pgRow<R = Record<string, unknown>>(
	app: App,
	text: string,
	values: readonly import("../src/server/kernel/db.ts").SqlValue[] = [],
): Promise<R | null> {
	return await app.database.read(async (db) => await db.get(sql<Params, R>(positional(text)), values));
}
export async function pgRun(
	app: App,
	text: string,
	values: readonly import("../src/server/kernel/db.ts").SqlValue[] = [],
	writer?: WriteDb,
) {
	const run = async (db: WriteDb) => await db.run(sql<Params>(positional(text)), values);
	return writer
		? await run(writer)
		: await app.database.write(async (db) => await db.transaction(async () => await run(db)));
}
export async function withWrite<T>(app: App, fn: (db: WriteDb) => T | Promise<T>): Promise<T> {
	return await app.database.write(async (db) => await db.transaction(async () => await fn(db)));
}

const fixtures = new Map<string, Awaited<ReturnType<typeof testDatabase>>>();
export async function identityDatabaseUrl(key: string): Promise<string> {
	let fixture = fixtures.get(key);
	if (!fixture) {
		fixture = await testDatabase();
		fixtures.set(key, fixture);
	}
	return fixture.url;
}

import { afterAll } from "bun:test";

afterAll(async () => {
	for (const f of fixtures.values()) await f.close();
	fixtures.clear();
});
export function holdWriter(app: App) {
	const released = Promise.withResolvers<void>();
	const ready = Promise.withResolvers<WriteDb>();
	const held = app.database.write(async (db) => {
		ready.resolve(db);
		await released.promise;
	});
	return {
		release: async () => {
			released.resolve();
			await held;
		},
		run: async <T>(fn: (db: WriteDb) => Promise<T>): Promise<T> => await (await ready.promise).transaction(fn),
	};
}

export async function databaseContents(app: App): Promise<Buffer> {
	return await app.database.read(async (db) => {
		const tables = await db.catalog();
		const rows: Record<string, unknown> = {};
		for (const table of tables)
			rows[table.name] = (
				await db.allDynamic<{ row: string }>(
					`SELECT row_to_json(t)::text AS row FROM "${table.name.replaceAll('"', '""')}" t`,
					[],
				)
			)
				.map((r) => r.row)
				.sort();
		return Buffer.from(JSON.stringify(rows));
	});
}

export function pauseRead(app: App, phase: "before" | "after", ordinal = 2) {
	const reached = Promise.withResolvers<void>();
	const resume = Promise.withResolvers<void>();
	const read = app.database.read.bind(app.database);
	let n = 0;
	app.database.read = async (fn) => {
		if (++n !== ordinal) return await read(fn);
		app.database.read = read;
		if (phase === "before") {
			reached.resolve();
			await resume.promise;
			return await read(fn);
		}
		const result = await read(fn);
		reached.resolve();
		await resume.promise;
		return result;
	};
	return {
		reached: reached.promise,
		release: () => resume.resolve(),
		restore: () => {
			app.database.read = read;
			resume.resolve();
		},
	};
}

export function watchQueries(app: App) {
	const observed: { text: string; value: unknown }[] = [];
	const read = app.database.read.bind(app.database);
	app.database.read = async (fn) =>
		await read(async (db) => {
			const all = db.all.bind(db);
			const observedDb: import("../src/server/kernel/db.ts").ReadDb = {
				get: db.get.bind(db),
				one: db.one.bind(db),
				allDynamic: db.allDynamic.bind(db),
				catalog: db.catalog.bind(db),
				all: async (statement, ...args) => {
					const value = await all(statement, ...args);
					observed.push({ text: statement.text, value });
					return value;
				},
			};
			return await fn(observedDb);
		});
	return {
		observed,
		restore: () => {
			app.database.read = read;
		},
	};
}
