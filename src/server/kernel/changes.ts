import { z } from "zod";
import type { ChangeEvent } from "./app.ts";
import { type ReadDb, sql, type WriteDb } from "./db.ts";

export const CHANGE_CHANNEL = "mainworthy_changes";
const Touched = z.array(z.string());
type StoredChange = { seq: number; op: string; touched: string };
const Q = {
	record: sql<{ project: string; seq: number; op: string; touched: string; at: number }>(
		`INSERT INTO change_events (project, seq, op, touched, at)
		 SELECT id, $seq, $op, $touched, $at FROM projects WHERE key = $project
		 ON CONFLICT (project, seq) DO UPDATE SET op = excluded.op, touched = excluded.touched,
		 at = excluded.at, revision = gen_random_uuid()::text WHERE excluded.op = 'import'`,
	),
	notify: sql<{ channel: string; project: string }>("SELECT pg_notify($channel, $project)"),
	since: sql<{ project: number; seq: number }, StoredChange>(
		"SELECT seq, op, touched FROM change_events WHERE project = $project AND seq > $seq ORDER BY seq LIMIT 500",
	),
	revision: sql<{ project: number; seq: number }, { revision: string }>(
		"SELECT revision FROM change_events WHERE project = $project AND seq = $seq",
	),
};

/** A replacement at the same project identity and sequence, including import, has a different revision. */
export async function changeRevision(db: ReadDb, project: number, seq: number): Promise<string | null> {
	return (await db.get(Q.revision, { project, seq }))?.revision ?? null;
}

/** The row and its wakeup commit together. PostgreSQL discards the notification on rollback. */
export async function recordChange(db: WriteDb, event: ChangeEvent, at: number): Promise<void> {
	await db.run(Q.record, {
		project: event.project,
		seq: event.seq,
		op: event.op,
		touched: JSON.stringify(event.touched),
		at,
	});
	await db.run(Q.notify, { channel: CHANGE_CHANNEL, project: event.project });
}

export async function changesSince(
	db: ReadDb,
	project: { id: number; key: string },
	seq: number,
): Promise<ChangeEvent[]> {
	return (await db.all(Q.since, { project: project.id, seq })).map((row) => ({
		project: project.key,
		seq: row.seq,
		op: row.op,
		actor: "",
		touched: Touched.parse(JSON.parse(row.touched)),
	}));
}
