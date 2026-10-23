import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { QuestionItem } from "../../core/ops.ts";
import { type ReadDb, type WriteDb, sql } from "../kernel/db.ts";
import { TRACKER_READ_FAILURES, TrackerReadFailure } from "./port.ts";

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

export async function trackerPoll(db: WriteDb, decision: number): Promise<Poll & { diagnosed: boolean }> {
	await db.run(Q.ensure, { decision, nonce: randomUUID() });
	const row = await db.get(Q.one, { decision });
	if (!row) throw new Error("tracker poll was not stored");
	return { ...row, diagnosed: failureOf(row.error) !== null };
}

const Failure = z.object({
	since: z.number().int().nonnegative().max(8_640_000_000_000_000),
	reason: TrackerReadFailure,
});

function failureOf(error: string | null): z.infer<typeof Failure> | null {
	if (error === null) return null;
	try {
		return Failure.safeParse(JSON.parse(error)).data ?? null;
	} catch {
		return null;
	}
}

export async function trackerPollError(db: ReadDb, decision: number): Promise<string | null> {
	const poll = await db.get(Q.one, { decision });
	if (!poll?.error) return null;
	const failure = failureOf(poll.error);
	return failure
		? `The tracker could not be read since ${new Date(failure.since).toISOString()}: ${TRACKER_READ_FAILURES[failure.reason]}`
		: "The tracker could not be read. Check the tracker connection and account permissions; the hold remains.";
}

export async function withTrackerPollError<T extends QuestionItem>(db: ReadDb, item: T): Promise<T> {
	if (item.decision?.answer.is !== "defect") return item;
	const trackerError = await trackerPollError(db, item.decision.id);
	return trackerError ? { ...item, decision: { ...item.decision, trackerError } } : item;
}

export async function finishTrackerPoll(
	db: WriteDb,
	poll: Poll,
	now: number,
	reason: TrackerReadFailure | null,
): Promise<boolean> {
	const failed = reason !== null;
	const attempts = failed ? Math.min(poll.attempts + 1, 16) : 0;
	const delay = failed ? Math.min(60_000 * 2 ** Math.min(attempts - 1, 6), 3_600_000) : 60_000;
	return (
		db.run(Q.finish, {
			nonce: poll.nonce,
			next: now + delay,
			attempts,
			error: reason === null ? null : JSON.stringify({ since: failureOf(poll.error)?.since ?? now, reason }),
		}).changes === 1
	);
}
