// What a person signs in with: a password or a passkey. Owns the tables `credentials` and `passkey_users`.
//
// A row is one secret and is never changed into another. A new password is a new row and the old one is
// revoked, which erases what it held. A password's hash may be refreshed after a legacy sign-in, and a
// passkey's row is given a later counter. A session rests on the row that opened it
// (`sessions.ts`), so revoking a row ends those sessions. A passkey's credential id (`handle`) belongs to its
// row for good, a revoked row included: an index of the database holds that, and nothing here works around it.
import { z } from "zod";
import { type Db, sql } from "../kernel/db.ts";
import { ALGORITHMS, type Passkey } from "./webauthn.ts";

export type CredentialKind = "password" | "passkey";
export type CredentialRow = {
	id: number;
	actor: number;
	kind: CredentialKind;
	/** A passkey's credential id. Null for a password. */
	handle: string | null;
	/**
	 * A password's argon2id string, or a passkey's JSON (`StoredPasskey`). Empty once the row is revoked. It
	 * goes to the code that checks a sign-in and to nothing a caller of the server sees.
	 */
	data: string;
	label: string;
	created_at: number;
	last_used_at: number | null;
	revoked_at: number | null;
};

/** What a passkey's row keeps in `data`: what the verifier needs to check a sign-in, and what describes the key. */
const StoredPasskey = z.object({
	key: z.string(),
	algorithm: z.union(ALGORITHMS.map((algorithm) => z.literal(algorithm))),
	counter: z.number().int().nonnegative(),
	transports: z.array(z.string()),
	backupEligible: z.boolean(),
	backedUp: z.boolean(),
});
type StoredPasskey = z.infer<typeof StoredPasskey>;

const Q = {
	byId: sql<{ id: number }, CredentialRow>("SELECT * FROM credentials WHERE id = $id"),
	live: sql<{ actor: number }, CredentialRow>(
		"SELECT * FROM credentials WHERE actor = $actor AND revoked_at IS NULL ORDER BY id",
	),
	livePassword: sql<{ actor: number }, CredentialRow>(
		"SELECT * FROM credentials WHERE actor = $actor AND kind = 'password' AND revoked_at IS NULL",
	),
	// Live or revoked: whether a credential id was ever registered here is asked of every row.
	passkey: sql<{ handle: string }, CredentialRow>(
		"SELECT * FROM credentials WHERE kind = 'passkey' AND handle = $handle",
	),
	insert: sql<{ actor: number; kind: CredentialKind; handle: string | null; data: string; label: string; at: number }>(
		`INSERT INTO credentials (actor, kind, handle, data, label, created_at)
		 VALUES ($actor, $kind, $handle, $data, $label, $at)`,
	),
	// What a revoked row held is erased with it. An old password's hash is of use to nobody but whoever steals
	// the database, and a key nothing signs in with any more is not worth keeping. The row and its credential
	// id stay: the id is never registered again.
	revoke: sql<{ id: number; at: number }>(
		"UPDATE credentials SET revoked_at = $at, data = '' WHERE id = $id AND revoked_at IS NULL",
	),
	revokeOf: sql<{ actor: number; at: number }>(
		"UPDATE credentials SET revoked_at = $at, data = '' WHERE actor = $actor AND revoked_at IS NULL",
	),
	forgetOf: sql<{ actor: number; at: number }>(
		"UPDATE credentials SET revoked_at = coalesce(revoked_at, $at), data = '', label = '' WHERE actor = $actor",
	),
	used: sql<{ id: number; at: number }>("UPDATE credentials SET last_used_at = $at WHERE id = $id"),
	// A refreshed password hash or passkey counter replaces only what the sign-in was checked against.
	counted: sql<{ id: number; was: string; data: string; at: number }>(
		`UPDATE credentials SET data = $data, last_used_at = $at
		 WHERE id = $id AND data = $was AND revoked_at IS NULL`,
	),
	userHandle: sql<{ actor: number }, { handle: string }>("SELECT handle FROM passkey_users WHERE actor = $actor"),
	insertUserHandle: sql<{ actor: number; handle: string; at: number }>(
		"INSERT INTO passkey_users (actor, handle, created_at) VALUES ($actor, $handle, $at)",
	),
	dropUserHandle: sql<{ actor: number }>("DELETE FROM passkey_users WHERE actor = $actor"),
};

/** A credential by its row id, live or revoked, or null. */
export const credentialById = (db: Db, id: number): CredentialRow | null => db.get(Q.byId, { id });

/** The credentials a person signs in with now: every row of theirs that is not revoked. */
export const liveCredentials = (db: Db, actor: number): CredentialRow[] => db.all(Q.live, { actor });

/** The password a person signs in with now, or null when they have none. The database allows one. */
export const livePassword = (db: Db, actor: number): CredentialRow | null => db.get(Q.livePassword, { actor });

/** Stores a password's hash as a new row. Throws when the person already has a password that works. */
export function insertPassword(db: Db, input: { actor: number; hash: string; at: number }): number {
	return db.run(Q.insert, {
		actor: input.actor,
		kind: "password",
		handle: null,
		data: input.hash,
		label: "password",
		at: input.at,
	}).lastId;
}

/** The row a credential id was registered under, at any time and whether or not it still works; else null. */
export const passkeyByCredentialId = (db: Db, credentialId: string): CredentialRow | null =>
	db.get(Q.passkey, { handle: credentialId });

/** What the verifier checks a sign-in against, read from a passkey's row. Null when the row holds no passkey. */
export function storedPasskey(row: CredentialRow): (StoredPasskey & { credentialId: string }) | null {
	if (row.kind !== "passkey" || row.handle === null) return null;
	let data: unknown;
	try {
		data = JSON.parse(row.data);
	} catch {
		return null;
	}
	const parsed = StoredPasskey.safeParse(data);
	return parsed.success ? { ...parsed.data, credentialId: row.handle } : null;
}

const dataOf = (passkey: Omit<Passkey, "credentialId">): string =>
	JSON.stringify({
		key: passkey.publicKey,
		algorithm: passkey.algorithm,
		counter: passkey.signCount,
		transports: [...passkey.transports],
		backupEligible: passkey.backupEligible,
		backedUp: passkey.backedUp,
	} satisfies StoredPasskey);

/**
 * Stores a passkey the verifier accepted, as a new row of this person, and returns the row. Throws when the
 * credential id is on any row already: the caller looks first and says so in words, and the index is what
 * holds when two registrations of one id arrive together.
 */
export function insertPasskey(
	db: Db,
	input: { actor: number; passkey: Passkey; label: string; at: number },
): CredentialRow {
	const { lastId } = db.run(Q.insert, {
		actor: input.actor,
		kind: "passkey",
		handle: input.passkey.credentialId,
		data: dataOf(input.passkey),
		label: input.label,
		at: input.at,
	});
	const row = db.get(Q.byId, { id: lastId });
	if (!row) throw new Error("the passkey was not stored");
	return row;
}

/**
 * Writes what a sign-in showed into a passkey's row: its counter, its backup flags and when it was used. False,
 * with nothing written, when the row no longer holds what the sign-in was checked against (`row.data`).
 */
export function countPasskeyUse(
	db: Db,
	row: CredentialRow,
	shown: { signCount: number; backupEligible: boolean; backedUp: boolean },
	at: number,
): boolean {
	const stored = storedPasskey(row);
	if (!stored) return false;
	const data = dataOf({ ...stored, publicKey: stored.key, ...shown });
	return db.run(Q.counted, { id: row.id, was: row.data, data, at }).changes === 1;
}

/** Refreshes a legacy password's hash without changing the credential its existing sessions rest on. */
export function rehashPassword(db: Db, row: CredentialRow, hash: string, at: number): boolean {
	return row.kind === "password" && db.run(Q.counted, { id: row.id, was: row.data, data: hash, at }).changes === 1;
}

/** Notes that a credential signed its person in. */
export function noteCredentialUse(db: Db, id: number, at: number): void {
	db.run(Q.used, { id, at });
}

/** Revokes one credential and erases what it held. False when it was revoked already or does not exist. */
export const revokeCredential = (db: Db, id: number, at: number): boolean => db.run(Q.revoke, { id, at }).changes > 0;

/** Revokes every credential of a person and erases what each held. Returns how many. */
export const revokeCredentialsOf = (db: Db, actor: number, at: number): number =>
	db.run(Q.revokeOf, { actor, at }).changes;

/** Erases every credential's label and data, including revoked rows, while retaining credential ids. */
export function forgetCredentialsOf(db: Db, actor: number, at: number): void {
	db.run(Q.forgetOf, { actor, at });
}

/** What a person signs in with, in two numbers: for a page that decides what to offer. */
export function credentialSummary(db: Db, actor: number): { password: boolean; passkeys: number } {
	const live = liveCredentials(db, actor);
	return {
		password: live.some((row) => row.kind === "password"),
		passkeys: live.filter((row) => row.kind === "passkey").length,
	};
}

/**
 * The handle a person's passkeys are filed under by an authenticator, which gives it back at sign-in: sixteen
 * random bytes, base64url, the same for all of the person's passkeys. Null when the person has none yet.
 */
export const userHandleOf = (db: Db, actor: number): string | null => db.get(Q.userHandle, { actor })?.handle ?? null;

/** The person's handle, made now if they had none. In a write transaction. */
export function ensureUserHandle(db: Db, actor: number, at: number): string {
	const held = userHandleOf(db, actor);
	if (held !== null) return held;
	const handle = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
	db.run(Q.insertUserHandle, { actor, handle, at });
	return handle;
}

/** Removes a person's handle, when the person is forgotten: no passkey is filed under it any more. */
export function dropUserHandle(db: Db, actor: number): void {
	db.run(Q.dropUserHandle, { actor });
}
