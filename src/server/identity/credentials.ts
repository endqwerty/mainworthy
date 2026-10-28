// What a person signs in with: an identity at the identity provider. Owns the table `credentials`.
//
// A row is one identity and is never changed into another. A session rests on the row that opened it
// (`sessions.ts`), so revoking a row ends those sessions. The handle (issuer and subject) says who somebody is
// elsewhere, so revoking the row erases it, and the same identity can be linked again later.
import { type ReadDb, sql, type WriteDb } from "../kernel/db.ts";
import { lockActors, lockCredential, lockIdentity } from "./locks.ts";

export type CredentialKind = "oidc";
export type CredentialRow = {
	id: number;
	actor: number;
	kind: CredentialKind;
	/** The identity's issuer and subject (`oidcHandle`). Null once revoked. */
	handle: string | null;
	/** When it was linked, as JSON. Empty once revoked. It goes to nothing a caller of the server sees. */
	data: string;
	label: string;
	created_at: number;
	last_used_at: number | null;
	revoked_at: number | null;
};

const Q = {
	byId: sql<{ id: number }, CredentialRow>("SELECT * FROM credentials WHERE id = $id"),
	live: sql<{ actor: number }, CredentialRow>(
		"SELECT * FROM credentials WHERE actor = $actor AND revoked_at IS NULL ORDER BY id",
	),
	oidc: sql<{ handle: string }, CredentialRow>(
		"SELECT * FROM credentials WHERE kind = 'oidc' AND handle = $handle AND revoked_at IS NULL",
	),
	insert: sql<{ actor: number; handle: string; data: string; label: string; at: number }, { id: number }>(
		`INSERT INTO credentials (actor, kind, handle, data, label, created_at)
		 VALUES ($actor, 'oidc', $handle, $data, $label, $at) RETURNING id`,
	),
	// What a revoked row held is erased with it, its handle too.
	revoke: sql<{ id: number; at: number }>(
		"UPDATE credentials SET revoked_at = $at, data = '', handle = NULL WHERE id = $id AND revoked_at IS NULL",
	),
	revokeOf: sql<{ actor: number; at: number }>(
		"UPDATE credentials SET revoked_at = $at, data = '', handle = NULL WHERE actor = $actor AND revoked_at IS NULL",
	),
	forgetOf: sql<{ actor: number; at: number }>(
		`UPDATE credentials SET revoked_at = coalesce(revoked_at, $at), data = '', label = '', handle = NULL
		 WHERE actor = $actor`,
	),
	used: sql<{ id: number; at: number }>("UPDATE credentials SET last_used_at = $at WHERE id = $id"),
};

/** A credential by its row id, live or revoked, or null. */
export const credentialById = async (db: ReadDb, id: number): Promise<CredentialRow | null> =>
	await db.get(Q.byId, { id });

/** The identities a person signs in with now: every row of theirs that is not revoked. */
export const liveCredentials = async (db: ReadDb, actor: number): Promise<CredentialRow[]> =>
	await db.all(Q.live, { actor });

/** The handle of an identity at a provider: its issuer and subject. An issuer has no `#` (it has no fragment). */
export const oidcHandle = (identity: { issuer: string; subject: string }): string =>
	`${identity.issuer}#${identity.subject}`;

/** The row an identity is linked under now, or null. */
export const oidcByHandle = async (db: ReadDb, handle: string): Promise<CredentialRow | null> =>
	await db.get(Q.oidc, { handle });

/**
 * Stores an identity a provider vouched for, as a new row of this person. Throws when the identity is linked
 * already: the caller looks first, and the index holds when two links of one identity arrive together.
 */
export async function insertOidc(
	db: WriteDb,
	input: { actor: number; handle: string; label: string; at: number },
): Promise<CredentialRow> {
	await lockIdentity(db);
	const { id } = await db.one(Q.insert, {
		actor: input.actor,
		handle: input.handle,
		data: JSON.stringify({ linked: input.at }),
		label: input.label,
		at: input.at,
	});
	const row = await db.get(Q.byId, { id });
	if (!row) throw new Error("the identity was not stored");
	return row;
}

/** Notes that a credential signed its person in. */
export async function noteCredentialUse(db: WriteDb, id: number, at: number): Promise<void> {
	await db.run(Q.used, { id, at });
}

/** Revokes one credential and erases what it held. False when it was revoked already or does not exist. */
export const revokeCredential = async (db: WriteDb, id: number, at: number): Promise<boolean> => {
	await lockCredential(db, id);
	return (await db.run(Q.revoke, { id, at })).changes > 0;
};

/** Revokes every credential of a person and erases what each held. Returns how many. */
export const revokeCredentialsOf = async (db: WriteDb, actor: number, at: number): Promise<number> => {
	await lockActors(db, [actor], true);
	return (await db.run(Q.revokeOf, { actor, at })).changes;
};

/** Erases every credential's label and data, including revoked rows. */
export async function forgetCredentialsOf(db: WriteDb, actor: number, at: number): Promise<void> {
	await lockIdentity(db);
	await db.run(Q.forgetOf, { actor, at });
}

/** How many identities a person signs in with: for a page that decides what to offer. */
export async function credentialSummary(db: ReadDb, actor: number): Promise<{ identities: number }> {
	return { identities: (await liveCredentials(db, actor)).length };
}
