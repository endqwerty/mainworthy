import type { App } from "../src/server/kernel/app.ts";
import type { Args, Database, Params, ReadDb, SqlValue, Statement, WriteDb } from "../src/server/kernel/db.ts";
import type { Workload } from "./measure.ts";

function positional(params: Params): params is readonly SqlValue[] {
	return Array.isArray(params);
}

type Query = { sql: string; calls: number; ms: number; max: number; params: readonly SqlValue[] };
export type Profile = {
	name: string;
	wallMs: number;
	cpuMs: number;
	fileInputs: number;
	majorFaults: number;
	queries: { sql: string; calls: number; ms: number; max: number; plan: string[] }[];
};

/** Observes leased handles, including handles obtained by subsequent operation scopes. */
export function observeDatabase(database: Database, observe: (text: string) => void): () => void {
	const read = database.read.bind(database);
	const write = database.write.bind(database);
	const observed = new WeakSet<ReadDb>();
	const wrap = <T extends ReadDb>(db: T): T => {
		if (observed.has(db)) return db;
		observed.add(db);
		const all = db.all.bind(db);
		db.all = <P extends Params, R>(statement: Statement<P, R>, ...args: Args<P>) => {
			observe(statement.text);
			return all(statement, ...args);
		};

		return db;
	};
	database.read = (fn, options) => read((db) => fn(wrap(db)), options);
	database.write = (fn, options) => write((db) => fn(wrap(db)), options);
	return () => {
		database.read = read;
		database.write = write;
	};
}

/** A diagnostic run measures awaited SQL on the actual leased connection, outside latency samples. */
export async function profile(app: App, workload: Workload): Promise<Profile> {
	const queries = new Map<string, Query>();
	const read = app.database.read.bind(app.database);
	const write = app.database.write.bind(app.database);
	const observed = new WeakSet<ReadDb>();
	const wrap = <T extends ReadDb>(db: T): T => {
		if (observed.has(db)) return db;
		observed.add(db);
		const timed = async <R>(
			statement: Statement<Params, unknown>,
			args: Params,
			work: () => Promise<R>,
		): Promise<R> => {
			const start = performance.now();
			try {
				return await work();
			} finally {
				const ms = performance.now() - start;
				const params = positional(args)
					? args
					: (statement.names?.map((name) => {
							const value = args[name];
							if (value === undefined) throw new Error("profile parameter is missing: " + name);
							return value;
						}) ?? []);
				const query = queries.get(statement.text) ?? { sql: statement.text, params, calls: 0, ms: 0, max: 0 };
				query.calls++;
				query.ms += ms;
				query.max = Math.max(query.max, ms);
				queries.set(statement.text, query);
			}
		};
		const all = db.all.bind(db);
		db.all = <P extends Params, R>(statement: Statement<P, R>, ...args: Args<P>) =>
			timed(statement, args[0] ?? [], () => all(statement, ...args));

		const dynamic = db.allDynamic.bind(db);
		db.allDynamic = async <R>(text: string, params: readonly SqlValue[] = []): Promise<R[]> => {
			const start = performance.now();
			try {
				return await dynamic<R>(text, params);
			} finally {
				const ms = performance.now() - start;
				const query = queries.get(text) ?? { sql: text, params, calls: 0, ms: 0, max: 0 };
				query.calls++;
				query.ms += ms;
				query.max = Math.max(query.max, ms);
				queries.set(text, query);
			}
		};

		return db;
	};
	const wrapWriter = (db: WriteDb): WriteDb => {
		wrap(db);
		const run = db.run.bind(db);
		db.run = async <P extends Params>(statement: Statement<P, unknown>, ...args: Args<P>) => {
			const start = performance.now();
			try {
				return await run(statement, ...args);
			} finally {
				const ms = performance.now() - start;
				const values: Params = args[0] ?? [];
				const params = positional(values)
					? values
					: (statement.names?.map((name) => {
							const value = values[name];
							if (value === undefined) throw new Error("profile parameter is missing: " + name);
							return value;
						}) ?? []);
				const query = queries.get(statement.text) ?? { sql: statement.text, params, calls: 0, ms: 0, max: 0 };
				query.calls++;
				query.ms += ms;
				query.max = Math.max(query.max, ms);
				queries.set(statement.text, query);
			}
		};
		return db;
	};
	app.database.read = (fn, options) => read((db) => fn(wrap(db)), options);
	app.database.write = (fn, options) => write((db) => fn(wrapWriter(db)), options);
	const work = workload.prepare(0);
	const started = performance.now();
	const usage = process.cpuUsage();
	const io = process.resourceUsage();
	let value: unknown;
	try {
		value = await work();
	} finally {
		app.database.read = read;
		app.database.write = write;
	}
	const wallMs = performance.now() - started;
	const cpu = process.cpuUsage(usage);
	const after = process.resourceUsage();
	await workload.check(value, 0);
	const hottest = [...queries.values()].sort((a, b) => b.ms - a.ms).slice(0, 8);
	const plans: Profile["queries"] = [];
	for (const query of hottest) {
		const plan = /^\s*(?:SELECT|WITH)\b/i.test(query.sql)
			? await read(async (db) =>
					(await db.allDynamic<{ "QUERY PLAN": string }>("EXPLAIN " + query.sql, query.params)).map(
						(row) => row["QUERY PLAN"],
					),
				)
			: [];
		plans.push({ sql: query.sql, calls: query.calls, ms: query.ms, max: query.max, plan });
	}
	return {
		name: workload.name,
		wallMs,
		cpuMs: (cpu.user + cpu.system) / 1000,
		fileInputs: after.fsRead - io.fsRead,
		majorFaults: after.majorPageFault - io.majorPageFault,
		queries: plans,
	};
}
