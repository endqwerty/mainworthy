// The context an operation runs in: who, on which project, at what time and with which sequence number.
import type { ActorKind, Capability, Role } from "../../core/kinds.ts";
import type { App } from "./app.ts";
import { type Db, sql } from "./db.ts";

export type Actor = { id: number; kind: ActorKind; name: string; can: readonly Capability[]; roles?: readonly Role[] };

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
	/**
	 * Runs whose counted results a step of this command changed outside a report (a result judged a mistake, or
	 * put back). Whatever recomputes runs next takes them along, so none is left with the tally from before.
	 */
	recompute: Set<number>;
	/** Nested decisions enqueue folds for the active pass instead of entering it again. */
	folding: boolean;
	dissolveStale: boolean;
	/** Changes whose base moved while accepting target metadata, including a duplicate report. */
	changedBases: Set<number>;
	/**
	 * How often this command has raised each question for each target. No command has a reason to raise one
	 * question for one target more than a handful of times; one that does is going round in circles, and is
	 * stopped with an error instead of holding the server's one writer for ever.
	 */
	raised: Map<string, number>;
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
	projects: sql<readonly [], ProjectRow>("SELECT * FROM projects ORDER BY id"),
	insertProject: sql<{ org: number; key: string; name: string; at: number }>(
		"INSERT INTO projects (org, key, name, created_at) VALUES ($org, $key, $name, $at)",
	),
	demoSince: sql<{ project: number }, { since: number }>("SELECT since FROM demo_projects WHERE project = $project"),
	markDemo: sql<{ project: number; since: number }>(
		"INSERT INTO demo_projects (project, since) VALUES ($project, $since)",
	),
	command: sql<
		{ id: string },
		{ outcome: string; op: string; actor: number; project: number; seq: number; request: string }
	>("SELECT outcome, op, actor, project, seq, request FROM commands WHERE id = $id"),
	insertCommand: sql<{
		id: string;
		project: number;
		op: string;
		actor: number;
		at: number;
		seq: number;
		touched: string;
		outcome: string;
		request: string;
	}>(
		`INSERT INTO commands (id, project, op, actor, at, seq, touched, outcome, request)
		 VALUES ($id, $project, $op, $actor, $at, $seq, $touched, $outcome, $request)`,
	),
	begunCommand: sql<{ project: number; actor: number; op: string; seq: number; unfinished: string }, { id: string }>(
		"SELECT id FROM commands WHERE project = $project AND actor = $actor AND op = $op AND seq = $seq AND outcome = $unfinished",
	),
	finishCommand: sql<{ id: string; seq: number; touched: string; outcome: string }>(
		"UPDATE commands SET seq = $seq, touched = $touched, outcome = $outcome WHERE id = $id",
	),
	replies: sql<readonly [], { id: string; op: string; outcome: string }>(
		"SELECT id, op, outcome FROM commands WHERE outcome <> ''",
	),
	rewriteReply: sql<{ id: string; outcome: string }>("UPDATE commands SET outcome = $outcome WHERE id = $id"),
};

export const findProject = (db: Db, key: string): ProjectRow | null => db.get(Q.project, { key });
export const projectById = (db: Db, id: number): ProjectRow | null => db.get(Q.projectById, { id });
export const allProjects = (db: Db): ProjectRow[] => db.all(Q.projects);

export function insertProject(db: Db, input: { org: number; key: string; name: string; at: number }): ProjectRow {
	db.run(Q.insertProject, input);
	const row = db.get(Q.project, { key: input.key });
	if (!row) throw new Error("project was not stored");
	return row;
}

/** The sequence number a project has when nothing was written to it since it was made (`createProject`). */
const UNTOUCHED_SEQ = 1;

/**
 * When the project became a demo, or null when it is none. A write to a demo may say when it happened
 * (`makeCtx`); no other project takes a time from a caller.
 */
export const demoSince = (db: Db, project: number): number | null => db.get(Q.demoSince, { project })?.since ?? null;

/**
 * Makes a project a demo and returns when it became one. Only a project nothing was written to: one that holds
 * work keeps the server's clock for good, so what it records is never dated by a caller. Null when it is refused.
 * A project that is a demo already keeps the moment it has.
 */
export function markDemo(db: Db, project: ProjectRow, at: number): number | null {
	const since = demoSince(db, project.id);
	if (since !== null) return since;
	if (project.seq !== UNTOUCHED_SEQ) return null;
	db.run(Q.markDemo, { project: project.id, since: at });
	return at;
}

/**
 * The stored request and reply of a command that already ran, or null. A retry of the same request returns the
 * reply and writes nothing; the same id with other content is refused.
 */
export const findCommand = (db: Db, id: string) => db.get(Q.command, { id });

/** Rewrites stored replies without changing which request each command id names, or an unfinished command. */
export function rewriteCommandReplies(db: Db, rewrite: (op: string, reply: string) => string): void {
	for (const row of db.all(Q.replies)) {
		const outcome = rewrite(row.op, row.outcome);
		if (outcome !== row.outcome) db.run(Q.rewriteReply, { id: row.id, outcome });
	}
}

/**
 * Records that an instance command ran (project 0: projects, actors, tokens). `outcome` is null when the reply held
 * a secret: a secret is shown once and never stored, so a repeat of that command is refused instead of replayed.
 */
export function recordInstanceCommand(
	db: Db,
	input: { id: string; op: string; actor: number; at: number; outcome: unknown; request: string },
): void {
	db.run(Q.insertCommand, {
		id: input.id,
		project: 0,
		op: input.op,
		actor: input.actor,
		at: input.at,
		seq: 0,
		touched: "[]",
		outcome: JSON.stringify(input.outcome ?? null),
		request: input.request,
	});
}

/** The stored outcome of a command whose first transaction is committed and whose reply does not exist yet. */
export const UNFINISHED = "";

/**
 * Binds a command id to its request when the operation's first transaction commits (a report: accepted, not yet
 * applied). If the server stops before the operation ends, the id still names that request: other content under
 * it is refused, and the same content runs the rest and gets the reply.
 */
export function beginCommand(ctx: Ctx, input: { id: string; op: string; request: string }): void {
	ctx.db.run(Q.insertCommand, {
		id: input.id,
		project: ctx.project.id,
		op: input.op,
		actor: ctx.actor.id,
		at: ctx.now,
		seq: ctx.seq,
		touched: "[]",
		outcome: UNFINISHED,
		request: input.request,
	});
}

/**
 * The command that `beginCommand` bound in the transaction that committed at `seq`, when it is still unfinished.
 * A report's batch is accepted in that transaction, so a batch that recovery applies finds its command here.
 */
export function begunCommand(ctx: Ctx, input: { op: string; seq: number }): string | null {
	const row = ctx.db.get(Q.begunCommand, {
		project: ctx.project.id,
		actor: ctx.actor.id,
		op: input.op,
		seq: input.seq,
		unfinished: UNFINISHED,
	});
	return row?.id ?? null;
}

/** Gives a command bound by `beginCommand` its reply. */
export function finishCommand(ctx: Ctx, input: { id: string; outcome: unknown }): void {
	ctx.db.run(Q.finishCommand, {
		id: input.id,
		seq: ctx.seq,
		touched: JSON.stringify([...ctx.touched]),
		outcome: JSON.stringify(input.outcome ?? null),
	});
}

/** Records that a command ran, with its request and its reply, so a retry of the same request is a no-op. */
export function recordCommand(ctx: Ctx, input: { id: string; op: string; outcome: unknown; request: string }): void {
	ctx.db.run(Q.insertCommand, {
		id: input.id,
		project: ctx.project.id,
		op: input.op,
		actor: ctx.actor.id,
		at: ctx.now,
		seq: ctx.seq,
		touched: JSON.stringify([...ctx.touched]),
		outcome: JSON.stringify(input.outcome ?? null),
		request: input.request,
	});
}

/**
 * `at` is the time the command's rows carry, when it is not the clock's: a write to a demo project that says
 * when it happened, and a report applied after a restart, which keeps the time it was accepted at.
 */
export function makeCtx(app: App, project: ProjectRow, actor: Actor, write: boolean, at?: number): Ctx {
	let ord = 0;
	return {
		app,
		// A write runs on the writing connection; a read on the reader, which sees only what is committed.
		db: write ? app.db : app.reader,
		project,
		actor,
		now: at ?? app.now(),
		seq: write ? project.seq + 1 : project.seq,
		write,
		touched: new Set(),
		recompute: new Set(),
		folding: false,
		dissolveStale: false,
		changedBases: new Set(),
		raised: new Map(),
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
