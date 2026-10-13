// When a token and a session were last used, noted in memory and written in batches.
//
// Every request is a use, and a read must not wait for the writer, so a use is noted here and written later:
// once a minute and when the server stops (`start.ts`). Until a note is written it is still known: the idle
// check of a session and the list of tokens read the newer of the row and the note. What a crash loses is
// what was noted since the last flush that committed, normally a minute and longer behind a long write. That
// can make a session look idle earlier than it was, so somebody signs in again a little early; it can never
// make one live longer.
//
// The notes belong to one `App`. A reader thread has an `App` of its own and notes nothing: nobody is admitted
// there.
import type { App } from "../kernel/app.ts";
import { sql } from "../kernel/db.ts";

type Kind = "token" | "session";
/** For each row's id, the latest time it was used that no committed write holds yet. */
type Notes = Record<Kind, Map<number, number>>;

const kept = new WeakMap<App, Notes>();
function notesOf(app: App): Notes {
	let notes = kept.get(app);
	if (!notes) {
		notes = { token: new Map(), session: new Map() };
		kept.set(app, notes);
	}
	return notes;
}

// Updates and nothing else: a flush never makes a row and never touches how a session ended, so one that runs
// after a sign-out cannot bring the session back. Each keeps the later of the two times, so a note that is older
// than the row (the clock was set back) lowers nothing.
const Q = {
	touchToken: sql<{ id: number; at: number }>(
		"UPDATE tokens SET last_used_at = max(coalesce(last_used_at, 0), $at) WHERE id = $id",
	),
	touchSession: sql<{ id: number; at: number }>(
		"UPDATE sessions SET last_seen_at = max(last_seen_at, $at) WHERE id = $id AND ended_at IS NULL",
	),
};

/**
 * Notes that a token or a session was used at `at`. A note is a maximum: an earlier time never replaces a later
 * one. The caller notes a use only after it has let the request in (`admit`), so a cookie that is past its idle
 * time cannot renew itself by being sent.
 */
export function noteUse(app: App, kind: Kind, id: number, at: number): void {
	const notes = notesOf(app)[kind];
	if ((notes.get(id) ?? Number.NEGATIVE_INFINITY) < at) notes.set(id, at);
}

/** The latest use of a token or a session that is noted and not yet written, or null when there is none. */
export function notedUse(app: App, kind: Kind, id: number): number | null {
	return kept.get(app)?.[kind].get(id) ?? null;
}

/**
 * Writes what is noted. Under the gate, like every other writer.
 *
 * What is noted is read here, when the writer's turn has come, and never before the wait at the gate. A note
 * names its row by id, and an import that ran while a flush waited has deleted the row and cleared the notes:
 * a copy taken before the wait would be written to whichever new row took the id.
 *
 * A note leaves memory only after the transaction that wrote it has committed, and only if it still holds the
 * time that was written: a later use noted meanwhile stays for the next flush. When the write fails, every note
 * stays. A note for a row that is gone, or for a session that has ended, updates nothing and is dropped, which
 * is what keeps the maps as small as the tokens and sessions used since the last flush.
 */
export function writeUses(app: App): void {
	const notes = notesOf(app);
	const taken = { token: [...notes.token], session: [...notes.session] };
	if (taken.token.length + taken.session.length === 0) return;
	app.db.transaction(() => {
		for (const [id, at] of taken.token) app.db.run(Q.touchToken, { id, at });
		for (const [id, at] of taken.session) app.db.run(Q.touchSession, { id, at });
	});
	for (const kind of ["token", "session"] as const) {
		for (const [id, at] of taken[kind]) if (notes[kind].get(id) === at) notes[kind].delete(id);
	}
}

/** Writes what is noted, waiting its turn at the gate. Rejects when the write failed; nothing is lost then. */
export function flushUses(app: App): Promise<void> {
	return app.gate.run(() => writeUses(app));
}

/**
 * Forgets every note. Only an import does this, once it has committed: it replaced the rows, and a row made
 * afterwards takes an old id, which must not inherit what the row before it did.
 */
export function clearUses(app: App): void {
	kept.delete(app);
}
