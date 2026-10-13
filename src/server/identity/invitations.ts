// An invitation: the link an admin hands a person, since there is no mail. Owns the table `invitations`.
//
// The link carries a code of 32 random bytes and this file never sees it: it is given the code's SHA-256 and
// stores that, as `sessions.ts` does for a cookie. An invitation is good once, until it runs out or is revoked.
import { type Db, sql } from "../kernel/db.ts";

/** `join`: a new person's first way in. `recover`: accepted, it replaces every way the person signed in. */
export type InvitationPurpose = "join" | "recover";
export type InvitationRow = {
	id: number;
	actor: number;
	hash: string;
	purpose: InvitationPurpose;
	created_by: number;
	created_at: number;
	expires_at: number;
	used_at: number | null;
	revoked_at: number | null;
};

const Q = {
	byHash: sql<{ hash: string }, InvitationRow>("SELECT * FROM invitations WHERE hash = $hash"),
	insert: sql<{ actor: number; hash: string; purpose: InvitationPurpose; by: number; at: number; expires: number }>(
		`INSERT INTO invitations (actor, hash, purpose, created_by, created_at, expires_at)
		 VALUES ($actor, $hash, $purpose, $by, $at, $expires)`,
	),
	// Spent only while it is still good, so of two acceptances of one code the second changes no row.
	use: sql<{ hash: string; at: number }>(
		`UPDATE invitations SET used_at = $at
		 WHERE hash = $hash AND used_at IS NULL AND revoked_at IS NULL AND expires_at > $at`,
	),
	revoke: sql<{ id: number; at: number }>(
		"UPDATE invitations SET revoked_at = $at WHERE id = $id AND used_at IS NULL AND revoked_at IS NULL",
	),
	revokeOf: sql<{ actor: number; at: number }>(
		"UPDATE invitations SET revoked_at = $at WHERE actor = $actor AND used_at IS NULL AND revoked_at IS NULL",
	),
	list: sql<readonly [], Omit<InvitationRow, "hash" | "actor" | "created_by"> & { name: string; inviter: string }>(
		`SELECT i.id, i.purpose, i.created_at, i.expires_at, i.used_at, i.revoked_at, a.name, b.name AS inviter
		 FROM invitations i JOIN actors a ON a.id = i.actor JOIN actors b ON b.id = i.created_by
		 ORDER BY i.id`,
	),
};

/** Whether an invitation can still be accepted at `now`: not used, not revoked, not past its end. */
export const isOpen = (row: Pick<InvitationRow, "used_at" | "revoked_at" | "expires_at">, now: number): boolean =>
	row.used_at === null && row.revoked_at === null && now < row.expires_at;

/** The invitation whose code has this hash, in whatever state it is, or null. */
export const invitationByHash = (db: Db, hash: string): InvitationRow | null => db.get(Q.byHash, { hash });

/** Stores an invitation for a person. `hash` is the SHA-256 of the code the link will carry. */
export function insertInvitation(
	db: Db,
	input: { actor: number; hash: string; purpose: InvitationPurpose; by: number; at: number; expiresAt: number },
): number {
	return db.run(Q.insert, {
		actor: input.actor,
		hash: input.hash,
		purpose: input.purpose,
		by: input.by,
		at: input.at,
		expires: input.expiresAt,
	}).lastId;
}

/** Spends an invitation. False, with nothing written, when it is not good any more: used, revoked or run out. */
export const spendInvitation = (db: Db, hash: string, at: number): boolean => db.run(Q.use, { hash, at }).changes === 1;

/** Revokes an invitation nobody has accepted. False when it was used or revoked, or does not exist. */
export const revokeInvitation = (db: Db, id: number, at: number): boolean => db.run(Q.revoke, { id, at }).changes > 0;

/** Revokes every invitation of a person that nobody has accepted. Returns how many. */
export const revokeInvitationsOf = (db: Db, actor: number, at: number): number =>
	db.run(Q.revokeOf, { actor, at }).changes;

/** Every invitation, with who it is for and who made it. Never the hash: nothing outside this file needs it. */
export function listInvitations(db: Db, now: number) {
	return db.all(Q.list).map((row) => ({
		id: row.id,
		name: row.name,
		purpose: row.purpose,
		createdBy: row.inviter,
		createdAt: row.created_at,
		expiresAt: row.expires_at,
		state:
			row.used_at !== null
				? ("used" as const)
				: row.revoked_at !== null
					? ("revoked" as const)
					: now >= row.expires_at
						? ("expired" as const)
						: ("open" as const),
	}));
}
