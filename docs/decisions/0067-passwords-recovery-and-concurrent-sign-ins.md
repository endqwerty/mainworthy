# 0067: Passwords, recovery and concurrent sign-ins

Date: 2026-10-15

Resolves [issue #133](https://github.com/endqwerty/mainworthy/issues/133), the three open points from
[0017](0017-sign-in-sessions-and-credentials.md).

## Normalize passwords to NFC and preserve old passwords

Normalize a password to Unicode NFC before hashing or checking it. Canonical equivalents such as composed
and decomposed accents then match across keyboards, including an iPhone keyboard. Choose NFC over NFKC
because it preserves compatibility distinctions such as full-width letters and ligatures. NFC is also the
password normalization form recommended by [NIST SP 800-63B-4, section 3.1.1.2](https://pages.nist.gov/800-63-4/sp800-63b.html#passwordver).
Passkeys, their signed bytes, keys and handles, and a device's local PIN or biometric check do not change.

Try the normalized password first. If it fails and differs from what was typed, check the exact original
text against the old hash. On that match, compute a normalized hash outside the write gate and replace the
hash on the existing credential inside the sign-in transaction. Recheck the actor and credential there,
and write only if the hash still matches the proof checked before the wait. A password change or recovery
that wins the gate cannot be overwritten by a delayed sign-in. Existing sessions keep their credential id.
Changing a password also accepts the exact original spelling of an older password.

An old decomposed password needs its original spelling once before other canonical spellings work.
Wrong passwords do not migrate it. No schema migration or normalization marker is needed: a legacy match
identifies the hash that needs refreshing. Replacing the credential row instead would end existing sessions.
The existing length limits still count the submitted Unicode code points.

Tests use real Argon2 hashes, invitation acceptance, password changes, recovery and a held write gate.
They check canonical equivalents, distinct compatibility characters, original-password fallback, retained
sessions and refusal after a concurrent password replacement.

## Recovery revokes all of that person's tokens

Accepting recovery revokes every password, passkey and token belonging to the person and ends their existing
sessions in the same transaction that stores the new credentials and opens the recovery session. Creating,
viewing or failing to accept a link revokes nothing. Grants and other actors' tokens stay as they are.

Choose revocation over a separate list and button because recovery can follow an account takeover. A token
created during that takeover must stop with the other credentials. Personal CLI tokens and admin-issued
tokens both stop. Scripts using them need replacements. Recovering the owner also revokes the token held in
`MAINWORTHY_OWNER_TOKEN`, even when it is their last token. Their new password or passkey remains usable.
A restart with the same configured token leaves it revoked. To restore the environment token, the operator
sets `MAINWORTHY_OWNER_TOKEN` to a new value and restarts the server, under the existing bootstrap rule.
With no value configured and no working owner token, bootstrap generates one.

CI and scripts using the old owner token fail authentication after recovery. Updating the server environment
alone does not update their secrets: they need the replacement value too. CI using a separate pipeline actor's
token is unaffected.

The link's CLI note, the invitation page and the recovery confirmation state that tokens stop working.
Tests cover refusal without revocation, personal and admin-issued tokens, token-backed sessions, another
actor's token, a personal token's proposal queued behind recovery, and recovery of the owner with their last
token. Bootstrap tests cover refusal to revive the old configured value and restoration with a new value.

## Accept the session whose cookie a concurrent response replaces

Two sign-ins can overlap. An invitation request carries the old cookie while another tab signs somebody
in. If the invitation response arrives last, its cookie replaces the other sign-in's cookie. The server
cannot end that unseen session from a request that never carried it. This is accepted and documented.

The replaced cookie is no longer held by that browser, but its session can still authenticate a copy until
ended or expired. It remains in that person's session list and can be ended there. It expires after the
configured idle or absolute lifetime, by default 14 days without use or 90 days in any case. It is not an
extra grant and does not extend those lifetimes. A copied cookie has the same risk as any other live session.

Ending all sessions of the person would also sign out unrelated devices. Browser coordination alone could
not cover scripts, closed pages or responses already in flight. Keep the server's rule: replace only the
session identified by the request cookie, after consent about the person it identifies. Do not claim the
server sees whichever cookie a browser holds when the response arrives.

A deterministic test holds invitation password hashing, finishes a second sign-in, and then releases the
invitation response. The unseen session remains usable and listed. Separate cases prove manual termination
and idle expiry. These pass before the implementation changes because this decision accepts existing behavior.
