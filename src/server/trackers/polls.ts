import { randomUUID } from "node:crypto";
import { type Db, sql } from "../kernel/db.ts";

type Poll = { decision: number; nonce: string; next_at: number; attempts: number; error: string | null };
const Q = {
	ensure: sql<{ decision: number; nonce: string }>(
		"INSERT OR IGNORE INTO tracker_polls (decision, nonce, next_at, attempts) VALUES ($decision, $nonce, 0, 0)",
	),
	one: sql<{ decision: number }, Poll>("SELECT * FROM tracker_polls WHERE decision = $decision"),
	finish: sql<{ nonce: string; next: number; attempts: number; error: string | null }>(
		"UPDATE tracker_polls SET next_at = $next, attempts = $attempts, error = $error WHERE nonce = $nonce",
	),
};

export function trackerPoll(db: Db, decision: number): Poll {
	db.run(Q.ensure, { decision, nonce: randomUUID() });
	const row = db.get(Q.one, { decision });
	if (!row) throw new Error("tracker poll was not stored");
	return row;
}

export function finishTrackerPoll(db: Db, poll: Poll, now: number, failed: boolean): boolean {
	const attempts = failed ? Math.min(poll.attempts + 1, 16) : 0;
	const delay = failed ? Math.min(60_000 * 2 ** Math.min(attempts - 1, 6), 3_600_000) : 60_000;
	return (
		db.run(Q.finish, {
			nonce: poll.nonce,
			next: now + delay,
			attempts,
			error: failed
				? "Tracker status could not be read; the defect hold remains and will be checked again with back-off."
				: null,
		}).changes === 1
	);
}
