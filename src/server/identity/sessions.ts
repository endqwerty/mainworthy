// A browser's session: the row behind the cookie. Owns the table `sessions`.
//
// The cookie carries 32 random bytes and this file never sees them: it is given their SHA-256 and stores that.
// A session is opened by a token or by a credential (an identity at the provider) and lives only while that one works
// and its actor stands. That is read each time, by a join, so a revoked token or credential refuses the
// sessions it opened, and so does a token's own end (`expires_at`) when the clock reaches it. Revocation also
// records their end, so deletion need not wait for a session's lifetime. A session rests on exactly one of
// the two: the table refuses a row with both, nothing here makes
// a row with neither, and one with neither is alive to no reader.
import { randomBytes } from "@noble/hashes/utils.js";
import type { ActorKind } from "../../core/kinds.ts";
import type { App } from "../kernel/app.ts";
import { Busy, type ReadDb, sql, type WriteDb } from "../kernel/db.ts";
import { OpError } from "../kernel/errors.ts";
import { fenceJob, type JobClaim } from "../kernel/jobs.ts";
import { CONTEXT, sessionHash } from "./contexts.ts";
import { liveCredentials } from "./credentials.ts";
import { lockActors, lockIdentity, lockSessionHash, lockTokenHash } from "./locks.ts";

/**
 * Why a session ended. `ended`: somebody ended it, from a list or by taking away what it rested on (an identity
 * that was unlinked, a token that was revoked, a recovery).
 */
type EndedWhy = "signed-out" | "ended" | "forgotten" | "expired";

/** 32 random bytes as a cookie can carry them: 43 characters of base64url, with no padding. */
export const newSessionSecret = (): string => Buffer.from(randomBytes(32)).toString("base64url");

/** How long the row of an ended session is kept, for whoever asks what happened to it. */
const KEPT_MS = 30 * 86_400_000;

/** The times that decide whether a session is still inside its two lifetimes. */
type Times = { id: number; last_seen_at: number; expires_at: number };
/** A session with the actor it signs in, read in one statement. */
type Standing = Times & { actor: number; org: number; kind: ActorKind; name: string };

const Q = {
	proof: sql<{ hash: string }, { reauthenticated_at: number | null }>(
		"SELECT reauthenticated_at FROM sessions WHERE hash = $hash AND ended_at IS NULL",
	),
	prove: sql<{ hash: string; at: number }>(
		"UPDATE sessions SET reauthenticated_at = $at WHERE hash = $hash AND ended_at IS NULL",
	),
	// A session of a token that was revoked, or has passed its end, or names another actor, or is gone, has no
	// row here: both joins are inner, so a session with no token at all is nobody's. So is one whose actor was
	// forgotten.
	standing: sql<{ hash: string; now: number }, Standing>(
		`SELECT s.id, s.last_seen_at, s.expires_at, a.id AS actor, a.org, a.kind, a.name
		 FROM sessions s
		 JOIN tokens t ON t.id = s.token AND t.actor = s.actor AND t.revoked_at IS NULL
			AND (t.expires_at IS NULL OR t.expires_at > $now)
		 JOIN actors a ON a.id = s.actor AND a.disabled_at IS NULL
		 WHERE s.hash = $hash AND s.ended_at IS NULL`,
	),
	// The same for a session that rests on a credential: the credential's own row, not revoked and this actor's.
	standingOnCredential: sql<{ hash: string }, Standing>(
		`SELECT s.id, s.last_seen_at, s.expires_at, a.id AS actor, a.org, a.kind, a.name
		 FROM sessions s
		 JOIN credentials c ON c.id = s.credential AND c.actor = s.actor AND c.revoked_at IS NULL
		 JOIN actors a ON a.id = s.actor AND a.disabled_at IS NULL
		 WHERE s.hash = $hash AND s.ended_at IS NULL`,
	),
	// The row is made only if, in the statement that makes it, a token with the presented hash exists and works
	// and its actor stands. The token's id and its actor are read here, from that row, and are never parameters:
	// an id says which row, not which token, and after an import another token holds it.
	insert: sql<
		{
			tokenHash: string;
			sessionHash: string;
			at: number;
			expires: number;
			agent: string | null;
			addr: string | null;
		},
		{ id: number }
	>(
		`INSERT INTO sessions
			(actor, hash, token, created_at, last_seen_at, expires_at, user_agent, created_addr, last_seen_addr, reauthenticated_at)
		 SELECT a.id, $sessionHash, t.id, $at, $at, $expires, $agent, $addr, $addr, $at
		 FROM tokens t JOIN actors a ON a.id = t.actor AND a.disabled_at IS NULL
		 WHERE t.hash = $tokenHash AND t.revoked_at IS NULL
			AND (t.expires_at IS NULL OR t.expires_at > $at) RETURNING id`,
	),
	// The row is made only if, in the statement that makes it, the credential still holds what was verified
	// (`data`), works, and is this person's, who stands. The
	// credential's id alone would not say that: after an import a new row takes an old id.
	insertOnCredential: sql<
		{
			actor: number;
			credential: number;
			data: string;
			sessionHash: string;
			at: number;
			expires: number;
			agent: string | null;
			addr: string | null;
		},
		{ id: number }
	>(
		`INSERT INTO sessions
			(actor, hash, credential, created_at, last_seen_at, expires_at, user_agent, created_addr, last_seen_addr, reauthenticated_at)
		 SELECT a.id, $sessionHash, c.id, $at, $at, $expires, $agent, $addr, $addr, NULL
		 FROM credentials c JOIN actors a ON a.id = c.actor AND a.disabled_at IS NULL AND a.kind = 'human'
		 WHERE c.id = $credential AND c.actor = $actor AND c.revoked_at IS NULL AND c.data = $data RETURNING id`,
	),
	// Every session of an actor that is alive but for its lifetimes, which the caller judges (`inLifetime`):
	// what it rests on works at `now`, by the rules of the two statements above. What a session rests on is the
	// one of the two joins that found a row.
	aliveOf: sql<
		{ actor: number; now: number },
		Times & {
			created_at: number;
			user_agent: string | null;
			created_addr: string | null;
			last_seen_addr: string | null;
			via: "token" | "oidc";
			label: string;
		}
	>(
		`SELECT s.id, s.last_seen_at, s.expires_at, s.created_at, s.user_agent, s.created_addr, s.last_seen_addr,
		        CASE WHEN t.id IS NOT NULL THEN 'token' ELSE c.kind END AS via, coalesce(t.label, c.label) AS label
		 FROM sessions s
		 JOIN actors a ON a.id = s.actor AND a.disabled_at IS NULL
		 LEFT JOIN tokens t ON t.id = s.token AND t.actor = s.actor AND t.revoked_at IS NULL
			AND (t.expires_at IS NULL OR t.expires_at > $now)
		 LEFT JOIN credentials c ON c.id = s.credential AND c.actor = s.actor AND c.revoked_at IS NULL
		 WHERE s.actor = $actor AND s.ended_at IS NULL AND (t.id IS NOT NULL OR c.id IS NOT NULL)
		 ORDER BY s.id`,
	),
	owner: sql<{ id: number }, { actor: number }>("SELECT actor FROM sessions WHERE id = $id AND ended_at IS NULL"),
	unended: sql<{ hash: string }, { id: number }>("SELECT id FROM sessions WHERE hash = $hash AND ended_at IS NULL"),
	end: sql<{ hash: string; at: number; why: EndedWhy }>(
		"UPDATE sessions SET ended_at = $at, ended_why = $why WHERE hash = $hash AND ended_at IS NULL",
	),
	endById: sql<{ id: number; at: number; why: EndedWhy }>(
		"UPDATE sessions SET ended_at = $at, ended_why = $why WHERE id = $id AND ended_at IS NULL",
	),
	endOthers: sql<{ actor: number; keep: number; at: number }>(
		"UPDATE sessions SET ended_at = $at, ended_why = 'ended' WHERE actor = $actor AND id != $keep AND ended_at IS NULL",
	),
	endOf: sql<{ actor: number; at: number; why: EndedWhy }>(
		"UPDATE sessions SET ended_at = $at, ended_why = $why WHERE actor = $actor AND ended_at IS NULL",
	),
	endOnToken: sql<{ token: number; at: number }>(
		`UPDATE sessions SET ended_at = least($at, coalesce(t.expires_at, $at)),
			ended_why = CASE WHEN t.expires_at < $at THEN 'expired' ELSE 'ended' END
		 FROM tokens t WHERE t.id = $token AND sessions.token = t.id AND sessions.ended_at IS NULL`,
	),
	endOn: sql<{ credential: number; at: number; why: EndedWhy }>(
		"UPDATE sessions SET ended_at = $at, ended_why = $why WHERE credential = $credential AND ended_at IS NULL",
	),
	overdue: sql<{ now: number; idleBefore: number }, Times>(
		`SELECT id, last_seen_at, expires_at FROM sessions
		 WHERE ended_at IS NULL AND (expires_at <= $now OR last_seen_at <= $idleBefore)`,
	),
	retiredTokens: sql<{ now: number }, { id: number; at: number; why: EndedWhy }>(
		`SELECT s.id,
			CASE WHEN t.revoked_at IS NOT NULL AND (t.expires_at IS NULL OR t.revoked_at <= t.expires_at)
				THEN t.revoked_at ELSE t.expires_at END AS at,
			CASE WHEN t.revoked_at IS NOT NULL AND (t.expires_at IS NULL OR t.revoked_at <= t.expires_at)
				THEN 'ended' ELSE 'expired' END AS why
		 FROM sessions s JOIN tokens t ON t.id = s.token
		 WHERE s.ended_at IS NULL AND (t.revoked_at <= $now OR t.expires_at <= $now)`,
	),
	drop: sql<{ before: number }>("DELETE FROM sessions WHERE ended_at IS NOT NULL AND ended_at <= $before"),
};

export type ProofContext = { actor: number; context: string | null };
export const RECENT_PROOF_MESSAGE =
	"confirm it is you with your identity provider, or sign in with your token again, before changing sign-in details; the proof lasts ten minutes";
/**
 * How long a proof lasts. A session gets one when it is opened with a token (typing a token proves holding it,
 * and a token already speaks for its person over the API) and when its person signs in at the provider again
 * (`people.ts`, the ceremony of proof). A session opened through the provider has none until then.
 */
export const PROOF_MS = 10 * 60_000;

/** Rechecks the session by its hash on the connection that owns the current transaction. */
export async function proofSession(
	app: App,
	input: ProofContext,
	db: ReadDb,
): Promise<{ id: number; hash: string } | null> {
	const hash = sessionHash(input.context);
	const session = hash === null ? null : await findSession(app, hash, { db });
	return hash !== null && session?.actor.id === input.actor ? { id: session.id, hash } : null;
}

/** Called inside each sign-in-changing writer, before it changes a credential or contact. */
export async function requireRecentProof(app: App, db: ReadDb, input: ProofContext, initial = false): Promise<void> {
	if (app.config.mode === "local" && input.context === CONTEXT.local) return;
	const session = await proofSession(app, input, db);
	if (session) {
		const at = (await db.get(Q.proof, { hash: session.hash }))?.reauthenticated_at;
		const now = app.now();
		if (at != null && at <= now && now - at <= PROOF_MS) return;
		if (initial && (await liveCredentials(db, input.actor)).length === 0) return;
	}
	throw new OpError("recent_proof_required", RECENT_PROOF_MESSAGE);
}

/**
 * A verified credential and this exact session were checked in the writer's transaction: the session's proof is
 * dated `at`, the sign-in it rests on.
 */
export async function dateSessionProof(app: App, db: WriteDb, input: ProofContext, at = app.now()): Promise<boolean> {
	await lockIdentity(db);
	const session = await proofSession(app, input, db);
	return session !== null && (await db.run(Q.prove, { hash: session.hash, at })).changes === 1;
}

/**
 * Whether a session is inside both lifetimes at `now`: before its absolute end, and used less than the idle
 * lifetime ago. The stored use may lag real activity by at most a minute (`uses.ts`). A
 * use dated after `now` (the clock was set back) counts as a use now, not as time still to come.
 */
function inLifetime(app: App, session: Times, now: number, options: { idleMs?: number } = {}): boolean {
	if (now >= session.expires_at) return false;
	const seen = Math.min(now, session.last_seen_at);
	return now - seen < (options.idleMs ?? app.config.sessionIdleMs);
}

/**
 * Opens a session for whoever presented a token, named by the token's hash. Under the gate. The session is the
 * token's actor's and depends on that token's row, both as they are when this writes. Null when no token has
 * that hash any more, when it was revoked or has passed its end, or when its actor was forgotten: a session has a working token under
 * it or it is not made.
 *
 * It takes the hash and no id, on purpose. Its caller read the token before it waited at the gate, and what it
 * read may be gone by now: an import deletes every token, and the next token made takes the first id again, for
 * an actor that may hold the same id too. The hash is the one thing that still says which token was presented.
 * `sessionHash` is the SHA-256 of the secret the browser will hold. `address` is where the sign-in came from:
 * the session was opened there and, so far, last seen there.
 */
export async function openSession(
	app: App,
	db: WriteDb,
	input: { tokenHash: string; sessionHash: string; userAgent: string | null; address: string | null },
): Promise<{ id: number; expiresAt: number } | null> {
	if (!(await lockTokenHash(db, input.tokenHash))) return null;
	const at = app.now();
	const expiresAt = at + app.config.sessionMaxMs;
	const made = await db.get(Q.insert, {
		tokenHash: input.tokenHash,
		sessionHash: input.sessionHash,
		at,
		expires: expiresAt,
		agent: input.userAgent,
		addr: input.address,
	});
	return made ? { id: made.id, expiresAt } : null;
}

/**
 * Opens a session for a person who signed in through the provider, on the identity's row. Under the
 * gate. Null when that row is gone, was revoked, is another person's or no longer holds the `data` that was
 * verified, or when the person was forgotten: a session has a credential that works under it or it is not made.
 *
 * The id says which row and `data` says what it holds: after a wait at the gate, or an import, the row of that
 * id may hold another. This makes a
 * row with a credential and no token, as `openSession` makes one with a token and no credential, so no session
 * rests on both. `address` is where the sign-in came from, as for a token's session.
 */
export async function openSessionOnCredential(
	app: App,
	db: WriteDb,
	input: {
		credential: { id: number; actor: number; data: string };
		sessionHash: string;
		userAgent: string | null;
		address: string | null;
	},
): Promise<{ id: number; expiresAt: number } | null> {
	await lockActors(db, [input.credential.actor]);
	const at = app.now();
	const expiresAt = at + app.config.sessionMaxMs;
	const made = await db.get(Q.insertOnCredential, {
		actor: input.credential.actor,
		credential: input.credential.id,
		data: input.credential.data,
		sessionHash: input.sessionHash,
		at,
		expires: expiresAt,
		agent: input.userAgent,
		addr: input.address,
	});
	return made ? { id: made.id, expiresAt } : null;
}

/**
 * The session a cookie names, with its actor's row, when it is alive now: not ended, inside both lifetimes, its
 * token or its credential still working and its actor still standing. Null for anything else. Reads committed rows on the reader
 * and writes nothing, so it is asked on every request and again by a change stream before each event.
 */
export async function findSession(
	app: App,
	hash: string,
	options: { db?: ReadDb; idleMs?: number } = {},
): Promise<{
	id: number;
	actor: { id: number; org: number; kind: ActorKind; name: string; disabled_at: null };
} | null> {
	const now = app.now();
	if (!options.db) return await app.database.read(async (db) => await findSession(app, hash, { ...options, db }));
	const db = options.db;
	const row = (await db.get(Q.standing, { hash, now })) ?? (await db.get(Q.standingOnCredential, { hash }));
	if (!row || !inLifetime(app, row, now, options)) return null;
	return { id: row.id, actor: { id: row.actor, org: row.org, kind: row.kind, name: row.name, disabled_at: null } };
}

/** Whether a cookie names a session that was not ended. A plain read, so a sign-out with nothing to end stops here. */
export async function hasUnendedSession(db: ReadDb, hash: string): Promise<boolean> {
	return (await db.get(Q.unended, { hash })) !== null;
}

/** Ends the session a cookie names. Under the gate. False when there is none, or it had ended: the first end stands. */
export async function endSession(app: App, db: WriteDb, hash: string, why: EndedWhy): Promise<boolean> {
	await lockSessionHash(db, hash);
	return (await db.run(Q.end, { hash, at: app.now(), why })).changes > 0;
}

/**
 * Ends every session of an actor: one that is being forgotten, or (`ended`) one whose every way of signing in
 * is being replaced. Inside the caller's transaction. Returns how many.
 */
export async function endSessionsOf(
	db: WriteDb,
	actor: number,
	at: number,
	why: "forgotten" | "ended" = "forgotten",
): Promise<number> {
	await lockActors(db, [actor], true);
	return (await db.run(Q.endOf, { actor, at, why })).changes;
}

/**
 * Ends the sessions that rest on a credential which is being revoked. They would be refused anyway, since
 * being alive is read with the credential; ending them says why in each row. Inside the caller's transaction.
 * Returns how many.
 */
export async function endSessionsOn(db: WriteDb, credential: number, at: number): Promise<number> {
	await lockIdentity(db);
	return (await db.run(Q.endOn, { credential, at, why: "ended" })).changes;
}

/** Records a token's revocation in its sessions, inside the transaction that revokes it. */
export async function endSessionsOnToken(db: WriteDb, token: number, at: number): Promise<number> {
	await lockIdentity(db);
	return (await db.run(Q.endOnToken, { token, at })).changes;
}

/** The actor whose session this is, when it has not ended; else null. */
export const sessionOwner = async (db: ReadDb, id: number): Promise<number | null> =>
	(await db.get(Q.owner, { id }))?.actor ?? null;

/** Ends one session by its id, as a person does from a list. Under the gate. False when it had ended or is none. */
export async function endSessionById(db: WriteDb, id: number, at: number): Promise<boolean> {
	await lockIdentity(db);
	const actor = await sessionOwner(db, id);
	if (actor !== null) await lockActors(db, [actor], true);
	return (await db.run(Q.endById, { id, at, why: "ended" })).changes > 0;
}

/**
 * The sessions of an actor that are alive now, as `findSession` judges one: what each rests on still works and
 * it is inside both lifetimes. Last-use fields come from the shared row.
 */
export async function listSessions(app: App, db: ReadDb, actor: number) {
	const now = app.now();
	return (await db.all(Q.aliveOf, { actor, now }))
		.filter((row) => inLifetime(app, row, now))
		.map((row) => ({
			id: row.id,
			openedWith: row.via,
			label: row.label,
			userAgent: row.user_agent,
			createdAt: row.created_at,
			createdFrom: row.created_addr,
			lastUsedAt: Math.min(now, row.last_seen_at),
			lastUsedFrom: row.last_seen_addr,
			expiresAt: row.expires_at,
		}));
}

/**
 * What the periodic job does to sessions, under their actors' locks.
 *
 * It records the end of a token in its sessions, including revocations from earlier builds, at the token's
 * original end. It also ends every session that is past its idle or its absolute lifetime. Until then such a
 * session is refused because the clock says so; afterwards it is refused whatever the clock says, so one that
 * is set back does not revive a session that had expired. Rows that ended more than thirty days ago are deleted.
 */
export async function sweepSessions(app: App, claim?: JobClaim): Promise<{ expired: number; deleted: number }> {
	return await app.database.write(
		async (db) =>
			await db.transaction(async () => {
				await lockIdentity(db);
				const foundAt = app.now();
				const candidates = [
					...(await db.all(Q.retiredTokens, { now: foundAt })),
					...(await db.all(Q.overdue, { now: foundAt, idleBefore: foundAt - app.config.sessionIdleMs })),
				];
				const actors: number[] = [];
				for (const candidate of candidates) {
					const actor = await sessionOwner(db, candidate.id);
					if (actor !== null) actors.push(actor);
				}
				await lockActors(db, actors, true);
				if (claim) await fenceJob(db, claim, app.now());
				const now = app.now();
				const retired = await db.all(Q.retiredTokens, { now });
				const overdue = await db.all(Q.overdue, { now, idleBefore: now - app.config.sessionIdleMs });
				for (const candidate of [...retired, ...overdue]) {
					const actor = await sessionOwner(db, candidate.id);
					if (actor !== null && !actors.includes(actor)) throw new Busy();
				}
				let expired = 0;
				for (const row of retired) {
					const ended = (await db.run(Q.endById, row)).changes;
					if (row.why === "expired") expired += ended;
				}
				for (const row of overdue) {
					// Recheck the stored use after waiting for the actor lock.
					if (inLifetime(app, row, now)) continue;
					expired += (await db.run(Q.endById, { id: row.id, at: now, why: "expired" })).changes;
				}
				return { expired, deleted: (await db.run(Q.drop, { before: now - KEPT_MS })).changes };
			}),
	);
}

export async function endOtherSessions(db: WriteDb, actor: number, keep: number | null, at: number): Promise<number> {
	await lockActors(db, [actor], true);
	return (await db.run(Q.endOthers, { actor, keep: keep ?? 0, at })).changes;
}
