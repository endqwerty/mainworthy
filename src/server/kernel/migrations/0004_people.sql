-- People sign in as themselves: a password or a passkey, given to a person through an invitation. None of
-- these tables travels in an archive: each holds what lets somebody in.

-- A way a person proves who they are. A row is never changed into another secret: a new password is a new row
-- and the old one is revoked, so a session can say which one it rests on.
CREATE TABLE credentials (
	id INTEGER PRIMARY KEY,
	actor INTEGER NOT NULL REFERENCES actors (id),
	-- oidc and totp are not built. They are named because SQLite cannot widen a CHECK afterwards.
	kind TEXT NOT NULL CHECK (kind IN ('password', 'passkey', 'oidc', 'totp')),
	-- A passkey's credential id, base64url. Null for a password.
	handle TEXT,
	-- A password: the argon2id string, which holds its own salt and cost. A passkey: JSON with the public key
	-- (SPKI, base64url), its algorithm, the counter of its last sign-in, its transports and its backup flags.
	data TEXT NOT NULL,
	label TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	last_used_at INTEGER,
	revoked_at INTEGER
) STRICT;
-- A credential id belongs to one row for good, a revoked row included: it is never registered again and
-- never moved to another person.
CREATE UNIQUE INDEX credentials_handle ON credentials (kind, handle) WHERE handle IS NOT NULL;
-- One password that works for each person.
CREATE UNIQUE INDEX credentials_password ON credentials (actor) WHERE kind = 'password' AND revoked_at IS NULL;
CREATE INDEX credentials_actor ON credentials (actor, revoked_at);

-- A link an admin hands to a person, since there is no mail. The link carries 32 random bytes; only their
-- SHA-256 is stored. join: a new person's first way in. recover: accepted, it revokes every credential the
-- person had and ends every session of theirs.
CREATE TABLE invitations (
	id INTEGER PRIMARY KEY,
	actor INTEGER NOT NULL REFERENCES actors (id),
	hash TEXT NOT NULL UNIQUE,
	purpose TEXT NOT NULL CHECK (purpose IN ('join', 'recover')),
	created_by INTEGER NOT NULL REFERENCES actors (id),
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	used_at INTEGER,
	revoked_at INTEGER
) STRICT;
CREATE INDEX invitations_actor ON invitations (actor);

-- The handle an authenticator files a person's passkeys under and gives back at sign-in: 16 random bytes,
-- base64url, the same for all of a person's passkeys. It is not a column of `actors` because an archive holds
-- `actors`, and this must not change what an archive holds.
CREATE TABLE passkey_users (
	actor INTEGER PRIMARY KEY REFERENCES actors (id),
	handle TEXT NOT NULL UNIQUE,
	created_at INTEGER NOT NULL
) STRICT;

-- The credential that opened a session. A session rests on its token or on its credential, never on both,
-- and lives only as long as that one works. One with neither is nobody's session.
ALTER TABLE sessions ADD COLUMN credential INTEGER REFERENCES credentials (id) CHECK (credential IS NULL OR token IS NULL);
CREATE INDEX sessions_credential ON sessions (credential) WHERE credential IS NOT NULL;
