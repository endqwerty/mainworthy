// The context an operation runs in: who, on which project, at what time and with which sequence number.
import type { ActorKind, Capability } from "../../core/kinds.ts";
import type { App } from "./app.ts";
import { type Db, sql } from "./db.ts";

export type Actor = { id: number; kind: ActorKind; name: string; can: readonly Capability[] };

export type ProjectRow = { id: number; org: number; key: string; name: string; seq: number; created_at: number };

/** The kinds of ref a project numbers. `C-311` is counter `case`, value 311. */
export type CounterName = "case" | "question" | "run" | "test" | "proposal";
export const REF_PREFIX: Record<CounterName, string> = { case: "C", question: "Q", run: "R", test: "T", proposal: "P" };

export type Ctx = {
	app: App;
	db: Db;
	project: ProjectRow;
	actor: Actor;
	now: number;
	/**
	 * In a write: the sequence number this command commits with. Every row the command writes carries it, so one
	 * command (a bulk edit of a thousand cases, a ten-thousand-result report) is one point on the project's clock.
	 * In a read: the project's sequence at the time of the read, returned as the cursor for "changed since".
	 */
	seq: number;
	write: boolean;
	/** Refs this command changed, for the change feed. */
	touched: Set<string>;
	/** The next number for a kind of ref. */
	nextNo: (name: CounterName) => number;
	/** A counter that grows within the command, to order rows that share a seq. */
	ord: () => number;
};

const Q = {
	project: sql<{ key: string }, ProjectRow>("SELECT * FROM projects WHERE key = $key"),
	projectById: sql<{ id: number }, ProjectRow>("SELECT * FROM projects WHERE id = $id"),
	bumpCounter: sql<{ project: number; name: string }, { value: number }>(
		`INSERT INTO counters (project, name, value) VALUES ($project, $name, 1)
		 ON CONFLICT (project, name) DO UPDATE SET value = value + 1 RETURNING value`,
	),
	setSeq: sql<{ id: number; seq: number }>("UPDATE projects SET seq = $seq WHERE id = $id"),
};

export const findProject = (db: Db, key: string): ProjectRow | null => db.get(Q.project, { key });
export const projectById = (db: Db, id: number): ProjectRow | null => db.get(Q.projectById, { id });

export function makeCtx(app: App, project: ProjectRow, actor: Actor, write: boolean): Ctx {
	let ord = 0;
	return {
		app,
		// A write runs on the writing connection; a read on the reader, which sees only what is committed.
		db: write ? app.db : app.reader,
		project,
		actor,
		now: app.now(),
		seq: write ? project.seq + 1 : project.seq,
		write,
		touched: new Set(),
		nextNo(name) {
			const row = app.db.get(Q.bumpCounter, { project: project.id, name });
			if (!row) throw new Error(`counter ${name} did not advance`);
			return row.value;
		},
		ord: () => ord++,
	};
}

/** Moves the project's clock to this command's sequence number. Called once, as the command's last write. */
export function stampSeq(ctx: Ctx): void {
	ctx.db.run(Q.setSeq, { id: ctx.project.id, seq: ctx.seq });
}

export const ref = (name: CounterName, no: number): string => `${REF_PREFIX[name]}-${no}`;

/** Splits `C-311` into its kind and number. Returns null for anything that is not a ref of that shape. */
export function parseRef(text: string): { name: CounterName; no: number } | null {
	const match = /^([CQRTP])-(\d{1,12})$/.exec(text.trim().toUpperCase());
	if (!match) return null;
	const names: Record<string, CounterName> = { C: "case", Q: "question", R: "run", T: "test", P: "proposal" };
	const name = names[match[1] ?? ""];
	return name ? { name, no: Number(match[2]) } : null;
}
