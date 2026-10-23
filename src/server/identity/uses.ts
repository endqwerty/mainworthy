// When a token and a session were last used, and from which address, noted in memory and written in batches.
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
/**
 * The latest use of one row that no committed write holds yet: when, and the address the request came from.
 * `addr` is null when no use noted so far had one (a request that never was on a connection). A note is never
 * changed in place: a newer use puts a new one in the map, which is how a flush knows what it wrote is still
 * what is noted.
 */
type Note = { readonly at: number; readonly addr: string | null };
type Notes = Record<Kind, Map<number, Note>>;

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
// than the row (the clock was set back) lowers nothing. The address goes with the time: it is written only when
// the note has one and is not older than the row, so a use with no address erases none, and an old use does not
// put its address over a newer one. (Every expression of an UPDATE reads the row as it was before the statement.)
const Q = {
	touchToken: sql<{ id: number; at: number; addr: string | null }>(
		`UPDATE tokens SET
			last_used_addr = CASE WHEN $addr IS NOT NULL AND $at >= coalesce(last_used_at, 0) THEN $addr ELSE last_used_addr END,
			last_used_at = max(coalesce(last_used_at, 0), $at)
		 WHERE id = $id`,
	),
	touchSession: sql<{ id: number; at: number; addr: string | null }>(
		`UPDATE sessions SET
			last_seen_addr = CASE WHEN $addr IS NOT NULL AND $at >= last_seen_at THEN $addr ELSE last_seen_addr END,
			last_seen_at = max(last_seen_at, $at)
		 WHERE id = $id AND ended_at IS NULL`,
	),
};

/**
 * Notes that a token or a session was used at `at`, from `addr` when the request had an address. A note is a
 * maximum: an earlier time never replaces a later one, and brings no address with it. A use that is not earlier
 * and has no address keeps the address noted before it. The caller notes a use only after it has let the request
 * in (`admit`), so a cookie that is past its idle time cannot renew itself by being sent.
 */
export function noteUse(app: App, kind: Kind, id: number, at: number, addr: string | null): void {
	const notes = notesOf(app)[kind];
	const held = notes.get(id);
	if (held && at < held.at) return;
	const from = addr ?? held?.addr ?? null;
	if (!held || held.at !== at || held.addr !== from) notes.set(id, { at, addr: from });
}

/** The latest use of a token or a session that is noted and not yet written, or null when there is none. */
export function notedUse(app: App, kind: Kind, id: number): number | null {
	return kept.get(app)?.[kind].get(id)?.at ?? null;
}

/**
 * Where a row was last used from: the newer of what the row says (`row`) and what is noted and not yet written.
 * The same rule the flush writes by, so a list shows today what the row will say in a minute.
 */
export function lastAddress(
	app: App,
	kind: Kind,
	id: number,
	row: { at: number | null; addr: string | null },
): string | null {
	const noted = kept.get(app)?.[kind].get(id);
	return noted && noted.addr !== null && noted.at >= (row.at ?? 0) ? noted.addr : row.addr;
}

/**
 * Takes the address out of what is noted for these rows and keeps the time. For an actor that is being
 * forgotten: where its tokens were used from goes from their rows, and must not come back with the next flush.
 */
export function forgetNotedAddresses(app: App, kind: Kind, ids: readonly number[]): void {
	const notes = kept.get(app)?.[kind];
	if (!notes) return;
	for (const id of ids) {
		const held = notes.get(id);
		if (held && held.addr !== null) notes.set(id, { at: held.at, addr: null });
	}
}

/**
 * Writes what is noted. Under the gate, like every other writer.
 *
 * What is noted is read here, when the writer's turn has come, and never before the wait at the gate. A note
 * names its row by id, and an import that ran while a flush waited has deleted the row and cleared the notes:
 * a copy taken before the wait would be written to whichever new row took the id.
 *
 * A note leaves memory only after the transaction that wrote it has committed, and only if it is still the note
 * that was written: a later use noted meanwhile stays for the next flush. When the write fails, every note
 * stays. A note for a row that is gone, or for a session that has ended, updates nothing and is dropped, which
 * is what keeps the maps as small as the tokens and sessions used since the last flush.
 */
export async function writeUses(app: App): Promise<void> {
	const notes = notesOf(app);
	const taken = { token: [...notes.token], session: [...notes.session] };
	if (taken.token.length + taken.session.length === 0) return;
	await app.db.transaction(async () => {
		for (const [id, note] of taken.token) await app.db.run(Q.touchToken, { id, ...note });
		for (const [id, note] of taken.session) await app.db.run(Q.touchSession, { id, ...note });
	});
	for (const kind of ["token", "session"] as const) {
		for (const [id, note] of taken[kind]) if (notes[kind].get(id) === note) notes[kind].delete(id);
	}
}

/** Writes what is noted, waiting its turn at the gate. Rejects when the write failed; nothing is lost then. */
export function flushUses(app: App): Promise<void> {
	return app.gate.run(async () => await writeUses(app));
}

/**
 * Forgets every note. Only an import does this, once it has committed: it replaced the rows, and a row made
 * afterwards takes an old id, which must not inherit what the row before it did.
 */
export function clearUses(app: App): void {
	kept.delete(app);
}
