# A password sign-in can need a second factor

Date: 2026-10-15. Issue #115. Builds on decision 0017.

## Runtime and ownership

The HTTP sign-in exchange validates one proof shape and asks identity to judge it. Password work runs outside the write gate. Identity re-reads the password inside the transaction that decides whether to open a session. Passkey sign-in requires user verification already and opens its session without TOTP. Signed-in account changes go through the `credential` registry operation. Only `identity.ts` exposes identity behavior to other modules.

## Usage and shape

A signed-in person calls `credential` with `totp.begin`, scans the returned QR code, and calls `totp.confirm` with its challenge and a six-digit code. Confirmation stores one `credentials` row of kind `totp`, returns ten recovery codes once, and ends the person's other sessions. The credential list shows descriptive fields only. The two enrolment actions are strict inputs without command ids, so neither a request fingerprint nor a saved reply carries their secrets.

`POST /api/login` with a correct password returns either a completed sign-in or `signedIn: false` and a second-factor challenge. The latter creates no session. The challenge is bound to a random ceremony cookie and remembers the name, verified password hash and TOTP credential. `{ challenge, code }` must come with that cookie within five minutes. A transaction re-reads all credentials, consumes the code, opens the password session and spends the challenge together. A password change, credential revocation, import, expiry or prior completion invalidates it.

TOTP uses HMAC-SHA-1, six digits, a random 160-bit secret, and 30-second steps per [RFC 6238](https://www.rfc-editor.org/rfc/rfc6238). The previous and next step tolerate clock differences. The row keeps the last accepted step, so a code cannot be replayed, including a confirmation code. Ten random 128-bit recovery codes are shown after confirmation. Only SHA-256 hashes persist, and consumption removes one hash in the same transaction as sign-in.

Pending enrolments and sign-ins are bounded in-memory maps, expiring in five minutes and cleared with passkey challenges on import. Persistent TOTP secrets live in `credentials.data`, already excluded from archives. No new migration or second secret table is needed. Revocation erases the secret and remaining recovery hashes. QR drawing data comes from `qrcode-generator` locally, and React renders it as SVG without changing the Content Security Policy. Its MIT licence is already allowed and included in the notices.

## Synthesis decision

The two whole-flow alternatives were a persistent pending-login table with session assurance columns, and bounded identity-owned challenges with the existing credential store. The latter follows the existing passkey ceremony, hides lifecycle checks behind identity and keeps the public caller sequence to begin, confirm, then sign in. A new table would expose a second persistence lifecycle, require a migration and archive exclusions, and retain proofs across restarts without a requirement to do so.

The selected design takes durable replay counters and recovery consumption from the persistent alternative. It uses short-lived memory only for proofs that should disappear on restart. Failed codes use the shared address limiter plus a separate account key, so correct passwords cannot reset that key. Proof checks run again after waiting at the gate.

## Admin requirement and accepted tradeoffs

`MAINWORTHY_REQUIRE_ADMIN_MFA=true` applies to every person with `admin` in any grant. A password sign-in without enrolled TOTP is refused. A join or recovery invitation for an admin must include a verified passkey. Existing sessions can enrol before the requirement is enabled. The owner token and local-owner access retain their bootstrap authority.

Rather than add assurance columns, every start with the setting ends all admin password sessions, even ones that completed TOTP. Granting admin ends existing password sessions too. Enrolment ends every other session, and removing TOTP ends all of that person's sessions. TOTP is never counted as an independent sign-in method when deciding whether a primary credential may be removed. Required admins must remove their password before removing TOTP and relying only on passkeys.

The CLI's `login` exchanges password and optional code files for a personal token through the same sign-in exchange and credential operation, then ends its temporary session. The iPhone client detects the second-step reply and explicitly asks the person to use the web app. It stores no cookie for an incomplete sign-in.

Recovery codes cannot be shown again after a lost confirmation reply. A person with a working session can remove TOTP and enrol again, or use a recovery invitation. TOTP secrets remain readable to an operator who can read the database. Encrypting them with a key stored beside the same database would not protect against that operator.
