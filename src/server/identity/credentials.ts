// What a person signs in with: a password, a passkey, an identity at the identity provider, or a TOTP second factor. Owns the tables `credentials` and `passkey_users`.
//
// A row is one secret and is never changed into another. A new password is a new row and the old one is
// revoked, which erases what it held. A password's hash may be refreshed after a legacy sign-in, and a
// passkey's row is given a later counter. A session rests on the row that opened it
// (`sessions.ts`), so revoking a row ends those sessions. A passkey's credential id (`handle`) belongs to its
// row for good, a revoked row included: an index of the database holds that, and nothing here works around it.
// An identity at the provider is the exception: its handle (issuer and subject) says who somebody is elsewhere,
// so revoking the row erases it, and the same identity can be linked again later.
import { z } from "zod";
import { type ReadDb, sql, type WriteDb } from "../kernel/db.ts";
import { lockActors, lockCredential, lockIdentity, lockSignInActor } from "./locks.ts";
import { ALGORITHMS, type Passkey } from "./webauthn.ts";

export type CredentialKind = "password" | "passkey" | "oidc" | "totp";
export type CredentialRow = {
	id: number;
	actor: number;
	kind: CredentialKind;
	/** A passkey's credential id, or an identity's issuer and subject (`oidcHandle`). Null for a password. */
	handle: string | null;
	/**
	 * A password's argon2id string, a passkey's JSON (`StoredPasskey`), or a TOTP secret, replay counter and recovery hashes. Empty once revoked. It
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

/** A revoked row keeps a passkey's credential id and drops an identity's issuer and subject. */
const HANDLE_KEPT = "handle = CASE WHEN kind = 'oidc' THEN NULL ELSE handle END";

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
	oidc: sql<{ handle: string }, CredentialRow>(
		"SELECT * FROM credentials WHERE kind = 'oidc' AND handle = $handle AND revoked_at IS NULL",
	),
	insert: sql<
		{ actor: number; kind: CredentialKind; handle: string | null; data: string; label: string; at: number },
		{ id: number }
	>(
		`INSERT INTO credentials (actor, kind, handle, data, label, created_at)
		 VALUES ($actor, $kind, $handle, $data, $label, $at) RETURNING id`,
	),
	// What a revoked row held is erased with it. An old password's hash is of use to nobody but whoever steals
	// the database, and a key nothing signs in with any more is not worth keeping. The row and its credential
	// id stay: the id is never registered again. An identity's handle goes with what it held.
	revoke: sql<{ id: number; at: number }>(
		`UPDATE credentials SET revoked_at = $at, data = '', ${HANDLE_KEPT}
		 WHERE id = $id AND revoked_at IS NULL`,
	),
	revokeOf: sql<{ actor: number; at: number }>(
		`UPDATE credentials SET revoked_at = $at, data = '', ${HANDLE_KEPT}
		 WHERE actor = $actor AND revoked_at IS NULL`,
	),
	forgetOf: sql<{ actor: number; at: number }>(
		`UPDATE credentials SET revoked_at = coalesce(revoked_at, $at), data = '', label = '', ${HANDLE_KEPT}
		 WHERE actor = $actor`,
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
export const credentialById = async (db: ReadDb, id: number): Promise<CredentialRow | null> =>
	await db.get(Q.byId, { id });

/** The credentials a person signs in with now: every row of theirs that is not revoked. */
export const liveCredentials = async (db: ReadDb, actor: number): Promise<CredentialRow[]> =>
	await db.all(Q.live, { actor });

/** The password a person signs in with now, or null when they have none. The database allows one. */
export const livePassword = async (db: ReadDb, actor: number): Promise<CredentialRow | null> =>
	await db.get(Q.livePassword, { actor });

/** Stores a password's hash as a new row. Throws when the person already has a password that works. */
export async function insertPassword(db: WriteDb, input: { actor: number; hash: string; at: number }): Promise<number> {
	await lockIdentity(db);
	return (
		await db.one(Q.insert, {
			actor: input.actor,
			kind: "password",
			handle: null,
			data: input.hash,
			label: "password",
			at: input.at,
		})
	).id;
}

export async function insertTotp(db: WriteDb, input: { actor: number; data: string; at: number }): Promise<number> {
	await lockIdentity(db);
	return (await db.one(Q.insert, { ...input, kind: "totp", handle: null, label: "Authenticator" })).id;
}

export async function updateTotp(db: WriteDb, row: CredentialRow, data: string, at: number): Promise<boolean> {
	await lockSignInActor(db, row.actor);
	return row.kind === "totp" && (await db.run(Q.counted, { id: row.id, was: row.data, data, at })).changes === 1;
}

export const liveTotp = async (db: ReadDb, actor: number): Promise<CredentialRow | null> =>
	(await liveCredentials(db, actor)).find((row) => row.kind === "totp") ?? null;

/** The row a credential id was registered under, at any time and whether or not it still works; else null. */
export const passkeyByCredentialId = async (db: ReadDb, credentialId: string): Promise<CredentialRow | null> =>
	await db.get(Q.passkey, { handle: credentialId });

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
		kind: "oidc",
		handle: input.handle,
		data: JSON.stringify({ linked: input.at }),
		label: input.label,
		at: input.at,
	});
	const row = await db.get(Q.byId, { id });
	if (!row) throw new Error("the identity was not stored");
	return row;
}

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
export async function insertPasskey(
	db: WriteDb,
	input: { actor: number; passkey: Passkey; label: string; at: number },
): Promise<CredentialRow> {
	await lockIdentity(db);
	const { id } = await db.one(Q.insert, {
		actor: input.actor,
		kind: "passkey",
		handle: input.passkey.credentialId,
		data: dataOf(input.passkey),
		label: input.label,
		at: input.at,
	});
	const row = await db.get(Q.byId, { id });
	if (!row) throw new Error("the passkey was not stored");
	return row;
}

/**
 * Writes what a sign-in showed into a passkey's row: its counter, its backup flags and when it was used. False,
 * with nothing written, when the row no longer holds what the sign-in was checked against (`row.data`).
 */
export async function countPasskeyUse(
	db: WriteDb,
	row: CredentialRow,
	shown: { signCount: number; backupEligible: boolean; backedUp: boolean },
	at: number,
): Promise<boolean> {
	await lockSignInActor(db, row.actor);
	const stored = storedPasskey(row);
	if (!stored) return false;
	const data = dataOf({ ...stored, publicKey: stored.key, ...shown });
	return (await db.run(Q.counted, { id: row.id, was: row.data, data, at })).changes === 1;
}

/** Refreshes a legacy password's hash without changing the credential its existing sessions rest on. */
export async function rehashPassword(db: WriteDb, row: CredentialRow, hash: string, at: number): Promise<boolean> {
	await lockSignInActor(db, row.actor);
	return (
		row.kind === "password" && (await db.run(Q.counted, { id: row.id, was: row.data, data: hash, at })).changes === 1
	);
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

/** Erases every credential's label and data, including revoked rows, while retaining credential ids. */
export async function forgetCredentialsOf(db: WriteDb, actor: number, at: number): Promise<void> {
	await lockIdentity(db);
	await db.run(Q.forgetOf, { actor, at });
}

/** What a person signs in with, in two numbers: for a page that decides what to offer. */
export async function credentialSummary(db: ReadDb, actor: number): Promise<{ password: boolean; passkeys: number }> {
	const live = await liveCredentials(db, actor);
	return {
		password: live.some((row) => row.kind === "password"),
		passkeys: live.filter((row) => row.kind === "passkey").length,
	};
}

/**
 * The handle a person's passkeys are filed under by an authenticator, which gives it back at sign-in: sixteen
 * random bytes, base64url, the same for all of the person's passkeys. Null when the person has none yet.
 */
export const userHandleOf = async (db: ReadDb, actor: number): Promise<string | null> =>
	(await db.get(Q.userHandle, { actor }))?.handle ?? null;

/** The person's handle, made now if they had none. In a write transaction. */
export async function ensureUserHandle(db: WriteDb, actor: number, at: number): Promise<string> {
	await lockIdentity(db);
	const held = await userHandleOf(db, actor);
	if (held !== null) return held;
	const handle = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
	await db.run(Q.insertUserHandle, { actor, handle, at });
	return handle;
}

/** Removes a person's handle, when the person is forgotten: no passkey is filed under it any more. */
export async function dropUserHandle(db: WriteDb, actor: number): Promise<void> {
	await lockIdentity(db);
	await db.run(Q.dropUserHandle, { actor });
}
