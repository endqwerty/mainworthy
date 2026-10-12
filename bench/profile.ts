import type { App } from "../src/server/kernel/app.ts";
import { type Params, type SqlValue, type Statement, sql } from "../src/server/kernel/db.ts";
import type { Workload } from "./measure.ts";

type Query = { sql: string; calls: number; ms: number; max: number; params: Params };
function positional(params: Params): params is readonly SqlValue[] {
	return Array.isArray(params);
}
export type Profile = {
	name: string;
	wallMs: number;
	cpuMs: number;
	queries: { sql: string; calls: number; ms: number; max: number; plan: string[] }[];
};

/** An unreported diagnostic run attributes the actual operation to SQL calls and CPU; it never supplies benchmark latency samples. */
export async function profile(app: App, workload: Workload): Promise<Profile> {
	const queries = new Map<string, Query>();
	const get = app.db.get.bind(app.db);
	const all = app.db.all.bind(app.db);
	const run = app.db.run.bind(app.db);
	const dynamic = app.db.allDynamic.bind(app.db);
	const timed = <T>(text: string, params: Params, work: () => T): T => {
		const start = performance.now();
		try {
			return work();
		} finally {
			const elapsed = performance.now() - start;
			const query = queries.get(text) ?? { sql: text, params, calls: 0, ms: 0, max: 0 };
			query.calls++;
			query.ms += elapsed;
			query.max = Math.max(query.max, elapsed);
			queries.set(text, query);
		}
	};
	app.db.get = <P extends Params, R>(statement: Statement<P, R>, ...args: P extends readonly [] ? [] : [P]): R | null =>
		timed(statement.text, args[0] ?? [], () => get(statement, ...args));
	app.db.all = <P extends Params, R>(statement: Statement<P, R>, ...args: P extends readonly [] ? [] : [P]): R[] =>
		timed(statement.text, args[0] ?? [], () => all(statement, ...args));
	app.db.run = <P extends Params>(statement: Statement<P, unknown>, ...args: P extends readonly [] ? [] : [P]) =>
		timed(statement.text, args[0] ?? [], () => run(statement, ...args));
	app.db.allDynamic = <R>(text: string, params: Parameters<App["db"]["allDynamic"]>[1]): R[] =>
		timed(text, params, () => dynamic<R>(text, params));
	const work = workload.prepare(0);
	const started = performance.now();
	const usage = process.cpuUsage();
	try {
		await work();
	} finally {
		app.db.get = get;
		app.db.all = all;
		app.db.run = run;
		app.db.allDynamic = dynamic;
	}
	const cpu = process.cpuUsage(usage);
	return {
		name: workload.name,
		wallMs: performance.now() - started,
		cpuMs: (cpu.user + cpu.system) / 1_000,
		queries: [...queries.values()]
			.sort((a, b) => b.ms - a.ms)
			.slice(0, 8)
			.map((query) => {
				let plan: string[] = [];
				if (/^\s*SELECT\b/i.test(query.sql)) {
					const text = `EXPLAIN QUERY PLAN ${query.sql}`;
					plan = positional(query.params)
						? app.db.all(sql<readonly SqlValue[], { detail: string }>(text), query.params).map((row) => row.detail)
						: app.db
								.all(sql<Record<string, SqlValue>, { detail: string }>(text), query.params)
								.map((row) => row.detail);
				}
				return { sql: query.sql, calls: query.calls, ms: query.ms, max: query.max, plan };
			}),
	};
}
