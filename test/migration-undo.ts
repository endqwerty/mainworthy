// SQL that sets a fully migrated test database back across a migration, for upgrade tests.

/**
 * What migration 8 took away, put back as the baseline had it: the other kinds of credential, the handles passkeys
 * were filed under, recovery email addresses, and the archive format before it.
 */
export const BEFORE_EIGHT = `
UPDATE meta SET value = '44' WHERE key = 'archive_version';
ALTER TABLE credentials DROP CONSTRAINT credentials_kind_check;
ALTER TABLE credentials ADD CONSTRAINT credentials_kind_check CHECK (kind IN ('password', 'passkey', 'oidc', 'totp'));
CREATE UNIQUE INDEX credentials_password ON credentials (actor) WHERE kind = 'password' AND revoked_at IS NULL;
CREATE TABLE passkey_users (actor bigint PRIMARY KEY, handle TEXT NOT NULL UNIQUE, created_at bigint NOT NULL);
ALTER TABLE passkey_users ADD FOREIGN KEY (actor) REFERENCES actors (id) DEFERRABLE INITIALLY IMMEDIATE;
CREATE TABLE mail_contacts (actor bigint PRIMARY KEY, email TEXT NOT NULL UNIQUE, verified_at bigint, revision TEXT NOT NULL);
ALTER TABLE mail_contacts ADD FOREIGN KEY (actor) REFERENCES actors (id) DEFERRABLE INITIALLY IMMEDIATE;
`;
