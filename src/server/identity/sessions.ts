// A browser's session: the row behind the cookie. Owns the table `sessions`.
//
// The cookie carries 32 random bytes and this file never sees them: it is given their SHA-256 and stores that.
// A session is opened by a token and lives only while that token works and its actor stands. That is read each
// time, by a join, so revoking a token ends the sessions it opened without a second write.
import type { ActorKind } from "../../core/kinds.ts";
import type { App } from "../kernel/app.ts";
import { type Db, sql } from "../kernel/db.ts";
import { notedUse } from "./uses.ts";

/** Why a session ended. `ended` is for a person ending one from a list, which nothing does yet. */
type EndedWhy = "signed-out" | "ended" | "forgotten" | "expired";

/** How long the row of an ended session is kept, for whoever asks what happened to it. */
const KEPT_MS = 30 * 86_400_000;

/** The times that decide whether a session is still inside its two lifetimes. */
type Times = { id: number; last_seen_at: number; expires_at: number };
/** A session with the actor it signs in, read in one statement. */
type Standing = Times & { actor: number; org: number; kind: ActorKind; name: string };

const Q = {
	// A session of a token that was revoked, or names another actor, or is gone, has no row here: both joins are
	// inner, so a session with no token at all is nobody's. So is one whose actor was forgotten.
	standing: sql<{ hash: string }, Standing>(
		`SELECT s.id, s.last_seen_at, s.expires_at, a.id AS actor, a.org, a.kind, a.name
		 FROM sessions s
		 JOIN tokens t ON t.id = s.token AND t.actor = s.actor AND t.revoked_at IS NULL
		 JOIN actors a ON a.id = s.actor AND a.disabled_at IS NULL
		 WHERE s.hash = $hash AND s.ended_at IS NULL`,
	),
	// The row is made only if, in the statement that makes it, a token with the presented hash exists and works
	// and its actor stands. The token's id and its actor are read here, from that row, and are never parameters:
	// an id says which row, not which token, and after an import another token holds it.
	insert: sql<{ tokenHash: string; sessionHash: string; at: number; expires: number; agent: string | null }>(
		`INSERT INTO sessions (actor, hash, token, created_at, last_seen_at, expires_at, user_agent)
		 SELECT a.id, $sessionHash, t.id, $at, $at, $expires, $agent
		 FROM tokens t JOIN actors a ON a.id = t.actor AND a.disabled_at IS NULL
		 WHERE t.hash = $tokenHash AND t.revoked_at IS NULL`,
	),
	unended: sql<{ hash: string }, { id: number }>("SELECT id FROM sessions WHERE hash = $hash AND ended_at IS NULL"),
	end: sql<{ hash: string; at: number; why: EndedWhy }>(
		"UPDATE sessions SET ended_at = $at, ended_why = $why WHERE hash = $hash AND ended_at IS NULL",
	),
	endById: sql<{ id: number; at: number; why: EndedWhy }>(
		"UPDATE sessions SET ended_at = $at, ended_why = $why WHERE id = $id AND ended_at IS NULL",
	),
	endOf: sql<{ actor: number; at: number; why: EndedWhy }>(
		"UPDATE sessions SET ended_at = $at, ended_why = $why WHERE actor = $actor AND ended_at IS NULL",
	),
	overdue: sql<{ now: number; idleBefore: number }, Times>(
		`SELECT id, last_seen_at, expires_at FROM sessions
		 WHERE ended_at IS NULL AND (expires_at <= $now OR last_seen_at <= $idleBefore)`,
	),
	drop: sql<{ before: number }>("DELETE FROM sessions WHERE ended_at IS NOT NULL AND ended_at <= $before"),
};

/**
 * Whether a session is inside both lifetimes at `now`: before its absolute end, and used less than the idle
 * lifetime ago. "Used" is the newer of the row and what is noted in memory and not yet written (`uses.ts`). A
 * use dated after `now` (the clock was set back) counts as a use now, not as time still to come.
 */
function inLifetime(app: App, session: Times, now: number): boolean {
	if (now >= session.expires_at) return false;
	const seen = Math.min(now, Math.max(session.last_seen_at, notedUse(app, "session", session.id) ?? 0));
	return now - seen < app.config.sessionIdleMs;
}

/**
 * Opens a session for whoever presented a token, named by the token's hash. Under the gate. The session is the
 * token's actor's and depends on that token's row, both as they are when this writes. Null when no token has
 * that hash any more, when it was revoked, or when its actor was forgotten: a session has a working token under
 * it or it is not made.
 *
 * It takes the hash and no id, on purpose. Its caller read the token before it waited at the gate, and what it
 * read may be gone by now: an import deletes every token, and the next token made takes the first id again, for
 * an actor that may hold the same id too. The hash is the one thing that still says which token was presented.
 * `sessionHash` is the SHA-256 of the secret the browser will hold.
 */
export function openSession(
	app: App,
	input: { tokenHash: string; sessionHash: string; userAgent: string | null },
): { id: number; expiresAt: number } | null {
	const at = app.now();
	const expiresAt = at + app.config.sessionMaxMs;
	const made = app.db.run(Q.insert, {
		tokenHash: input.tokenHash,
		sessionHash: input.sessionHash,
		at,
		expires: expiresAt,
		agent: input.userAgent,
	});
	return made.changes === 1 ? { id: made.lastId, expiresAt } : null;
}

/**
 * The session a cookie names, with its actor's row, when it is alive now: not ended, inside both lifetimes, its
 * token still working and its actor still standing. Null for anything else. Reads committed rows on the reader
 * and writes nothing, so it is asked on every request and again by a change stream before each event.
 */
export function findSession(
	app: App,
	hash: string,
): { id: number; actor: { id: number; org: number; kind: ActorKind; name: string; disabled_at: null } } | null {
	const row = app.reader.get(Q.standing, { hash });
	if (!row || !inLifetime(app, row, app.now())) return null;
	return { id: row.id, actor: { id: row.actor, org: row.org, kind: row.kind, name: row.name, disabled_at: null } };
}

/** Whether a cookie names a session that was not ended. A plain read, so a sign-out with nothing to end stops here. */
export function hasUnendedSession(db: Db, hash: string): boolean {
	return db.get(Q.unended, { hash }) !== null;
}

/** Ends the session a cookie names. Under the gate. False when there is none, or it had ended: the first end stands. */
export function endSession(app: App, hash: string, why: EndedWhy): boolean {
	return app.db.run(Q.end, { hash, at: app.now(), why }).changes > 0;
}

/** Ends every session of an actor that is being forgotten. Inside the caller's transaction. Returns how many. */
export function endSessionsOf(db: Db, actor: number, at: number): number {
	return db.run(Q.endOf, { actor, at, why: "forgotten" }).changes;
}

/**
 * What the minute timer does to sessions. Under the gate, after what was noted has been written.
 *
 * It ends, in the database, every session that is past its idle or its absolute lifetime. Until then such a
 * session is refused because the clock says so; afterwards it is refused whatever the clock says, so one that
 * is set back does not revive a session that had expired. Rows that ended more than thirty days ago are deleted.
 */
export function sweepSessions(app: App): { expired: number; deleted: number } {
	const now = app.now();
	return app.db.transaction(() => {
		let expired = 0;
		for (const row of app.db.all(Q.overdue, { now, idleBefore: now - app.config.sessionIdleMs })) {
			// The row says idle, and a use noted since the last flush says otherwise.
			if (inLifetime(app, row, now)) continue;
			expired += app.db.run(Q.endById, { id: row.id, at: now, why: "expired" }).changes;
		}
		return { expired, deleted: app.db.run(Q.drop, { before: now - KEPT_MS }).changes };
	});
}
