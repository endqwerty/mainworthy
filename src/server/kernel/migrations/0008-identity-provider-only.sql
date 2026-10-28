-- People sign in through the identity provider only (decision 2026-10-27, people sign in through an identity
-- provider). What the other ways kept goes: passwords, passkeys, authenticators and their recovery codes, the
-- handles passkeys were filed under, recovery email addresses and mail waiting to be sent. A session that rested
-- on one of them goes too: nothing it rested on is left. The archive format changes with it (45): it carried
-- recovery email addresses.
DELETE FROM sessions WHERE credential IN (SELECT id FROM credentials WHERE kind <> 'oidc');
DELETE FROM credentials WHERE kind <> 'oidc';
DROP INDEX credentials_password;
ALTER TABLE credentials DROP CONSTRAINT credentials_kind_check;
ALTER TABLE credentials ADD CONSTRAINT credentials_kind_check CHECK (kind = 'oidc');
DROP TABLE passkey_users;
DROP TABLE mail_contacts;
DELETE FROM background_jobs WHERE kind = 'mail';
DELETE FROM identity_ceremonies WHERE kind NOT IN ('oidc');
DELETE FROM identity_limits WHERE key LIKE 'account:%' OR key LIKE 'totp:%' OR key LIKE 'totp-enrol:%' OR key LIKE 'mail-reset:%';
UPDATE meta SET value = '45' WHERE key = 'archive_version';
