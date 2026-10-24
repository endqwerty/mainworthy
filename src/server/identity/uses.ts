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
import { Busy, sql, type WriteDb } from "../kernel/db.ts";
import { lockActors } from "./locks.ts";

type Kind = "token" | "session";
/**
 * The latest use of one row that no committed write holds yet: when, and the address the request came from.
 * `addr` is null when no use noted so far had one (a request that never was on a connection). A note is never
 * changed in place: a newer use puts a new one in the map, which is how a flush knows what it wrote is still
 * what is noted.
 */
type Note = { readonly at: number; readonly addr: string | null; readonly hash: string | null };
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
	owners: sql<
		{ tokens: readonly number[]; sessions: readonly number[] },
		{ kind: "token" | "session"; id: number; actor: number; hash: string }
	>(
		`SELECT 'token' AS kind,id,actor,hash FROM tokens WHERE id = ANY($tokens::bigint[]) UNION ALL SELECT 'session' AS kind,id,actor,hash FROM sessions WHERE id = ANY($sessions::bigint[])`,
	),
	touchToken: sql<{
		ids: readonly number[];
		times: readonly number[];
		addresses: readonly string[];
		hasAddresses: readonly number[];
		hashes: readonly string[];
	}>(`
 UPDATE tokens t SET
 last_used_addr = CASE WHEN n.has_addr = 1 AND n.at >= coalesce(t.last_used_at, 0)
 AND EXISTS (SELECT FROM actors a WHERE a.id = t.actor AND a.disabled_at IS NULL) THEN n.addr ELSE t.last_used_addr END,
 last_used_at = greatest(coalesce(t.last_used_at, 0), n.at)
 FROM unnest($ids::bigint[], $times::bigint[], $addresses::text[], $hasAddresses::bigint[], $hashes::text[]) AS n(id, at, addr, has_addr, hash) WHERE t.id = n.id AND t.hash = n.hash`),
	touchSession: sql<{
		ids: readonly number[];
		times: readonly number[];
		addresses: readonly string[];
		hasAddresses: readonly number[];
		hashes: readonly string[];
	}>(`
 UPDATE sessions s SET
 last_seen_addr = CASE WHEN n.has_addr = 1 AND n.at >= s.last_seen_at THEN n.addr ELSE s.last_seen_addr END,
 last_seen_at = greatest(s.last_seen_at, n.at)
 FROM unnest($ids::bigint[], $times::bigint[], $addresses::text[], $hasAddresses::bigint[], $hashes::text[]) AS n(id, at, addr, has_addr, hash) WHERE s.id = n.id AND s.hash = n.hash AND s.ended_at IS NULL`),
};

/**
 * Notes that a token or a session was used at `at`, from `addr` when the request had an address. A note is a
 * maximum: an earlier time never replaces a later one, and brings no address with it. A use that is not earlier
 * and has no address keeps the address noted before it. The caller notes a use only after it has let the request
 * in (`admit`), so a cookie that is past its idle time cannot renew itself by being sent.
 */
export function noteUse(
	app: App,
	kind: Kind,
	id: number,
	at: number,
	addr: string | null,
	hash: string | null = null,
): void {
	const notes = notesOf(app)[kind];
	const held = notes.get(id);
	if (held && at < held.at) return;
	const from = addr ?? held?.addr ?? null;
	const credential = hash ?? held?.hash ?? null;
	if (!held || held.at !== at || held.addr !== from || held.hash !== credential)
		notes.set(id, { at, addr: from, hash: credential });
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
		if (held && held.addr !== null) notes.set(id, { ...held, addr: null });
	}
}

/**
 * Writes what is noted under the affected actors' locks.
 *
 * Owner ids are hints for locking only. Notes are reread after the wait, and their original credential hashes
 * guard updates even if import replaced a numeric id before the actor locks were acquired.
 *
 * A note leaves memory only after the transaction that wrote it has committed, and only if it is still the note
 * that was written: a later use noted meanwhile stays for the next flush. When the write fails, every note
 * stays. A note for a row that is gone, or for a session that has ended, updates nothing and is dropped, which
 * is what keeps the maps as small as the tokens and sessions used since the last flush.
 */
export async function writeUses(app: App, db: WriteDb): Promise<void> {
	const hints = notesOf(app);
	const requested = { token: [...hints.token], session: [...hints.session] };
	if (requested.token.length + requested.session.length === 0) return;
	await db.transaction(async () => {
		const owners = await db.all(Q.owners, {
			tokens: requested.token.map(([id]) => id),
			sessions: requested.session.map(([id]) => id),
		});
		await lockActors(
			db,
			owners.map((row) => row.actor),
		);
		const locked = new Set(owners.map((row) => row.actor));
		const current = await db.all(Q.owners, {
			tokens: requested.token.map(([id]) => id),
			sessions: requested.session.map(([id]) => id),
		});
		if (current.some((row) => !locked.has(row.actor))) throw new Busy();
		const notes = notesOf(app);
		const tokenIds = new Set(owners.filter((row) => row.kind === "token").map((row) => row.id));
		const sessionIds = new Set(owners.filter((row) => row.kind === "session").map((row) => row.id));
		const hashes = {
			token: new Map(owners.filter((row) => row.kind === "token").map((row) => [row.id, row.hash])),
			session: new Map(owners.filter((row) => row.kind === "session").map((row) => [row.id, row.hash])),
		};
		const taken = {
			token: [...notes.token].filter(([id]) => tokenIds.has(id)),
			session: [...notes.session].filter(([id]) => sessionIds.has(id)),
		};

		for (const kind of ["token", "session"] as const) {
			const entries = taken[kind];
			if (entries.length)
				await db.run(kind === "token" ? Q.touchToken : Q.touchSession, {
					ids: entries.map(([id]) => id),
					times: entries.map(([, note]) => note.at),
					addresses: entries.map(([, note]) => note.addr ?? ""),
					hasAddresses: entries.map(([, note]) => (note.addr === null ? 0 : 1)),
					hashes: entries.map(([id, note]) => note.hash ?? hashes[kind].get(id) ?? ""),
				});
		}
		db.afterCommit(() => {
			for (const kind of ["token", "session"] as const) {
				for (const [id, note] of [...taken[kind], ...requested[kind].filter(([id]) => !hashes[kind].has(id))])
					if (notes[kind].get(id) === note) notes[kind].delete(id);
			}
		});
	});
}

/** Writes what is noted after locking the affected actors. Rejects when the write failed; nothing is lost then. */
export async function flushUses(app: App): Promise<void> {
	return await app.database.write(async (db) => await writeUses(app, db));
}

/**
 * Forgets every note. Only an import does this, once it has committed: it replaced the rows, and a row made
 * afterwards takes an old id, which must not inherit what the row before it did.
 */
export function clearUses(app: App): void {
	kept.delete(app);
}
