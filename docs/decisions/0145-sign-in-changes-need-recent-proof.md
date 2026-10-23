# 0145: Sign-in changes need recent proof in this session

Date: 2026-10-22

Status: accepted

## Problem

A signed-in browser could add a passkey, remove another credential or replace a
recovery address without proving that its person was present. The owner decided
to require recent proof for sign-in changes in [issue #337](https://github.com/endqwerty/mainworthy/issues/337).

## Rule

Adding or removing a password, passkey or authenticator, setting or removing a
recovery address, and linking or unlinking an identity provider require proof of
the caller's own existing password, passkey or six-digit authenticator code within
the previous ten minutes. The proof belongs to one live session, including when
an admin changes somebody else's credentials or the owner changes their address.
The boundary includes exactly ten minutes. A future proof timestamp is refused.

Password and passkey sign-in establish proof for the new session. Password
sign-in with an authenticator or recovery code also proves the password. Replacing
a password retains the current-password check and refreshes this session's proof.
Recovery codes alone, bearer tokens, and ordinary identity-provider sign-in do
not establish recent proof. A person with only a provider identity must use an
admin recovery link to establish a password or passkey before changing sign-in
details. We do not infer provider reauthentication from its redirect.

Accepting an invitation, accepting an admin recovery link, and using a valid
mailed password-reset link use their existing recovery authority. Adding one's
first password or passkey from a live session needs no prior credential. This
exception applies only when no live credential exists, at password creation and
both passkey-registration stages. Setting or removing a recovery address and
both authenticator-enrollment stages always require proof, even for an owner
without credentials signed in with the owner token. The local-mode owner keeps
the machine's existing authority, since local mode has no sign-in session. A token cannot borrow this exception for an admin action on another person.
Removing the last usable way to sign in remains refused. Removing the credential
just proved is allowed when another usable way remains; existing session-ending
rules still apply, including ending this session if it rests on that credential.

Every browser-issued invitation, for joining or recovery, needs the admin's
recent proof. Otherwise
an old admin session could issue a link and accept it under the recovery
exception. Bearer-token and local issuance retain the operator's recovery
authority, including through the CLI. Agent tokens retain their existing
restriction: they cannot issue a person's invitation or recovery link.

Creating any token from a browser, through either the personal or admin operation,
also requires the caller's recent proof. Otherwise a stale browser could mint a
token and use its operator authority to issue and accept a recovery link. The
shared token writer checks the admitted caller before writing the token. Token
and local callers retain issuance authority. Restricting recovery to the configured
owner token alone would unnecessarily remove existing operator recovery paths.
An admin-made human token can have no expiry and retains recovery-issuing
authority while unrevoked and its actor remains authorized.

First enrollment does not establish recent proof: it creates a credential rather
than verifying an existing one. A token-only owner enrolls in **Your sign-in**,
then retries the browser action and proves the new credential. The shared prompt
links to enrollment when the credential list is empty; the password/passkey
session summary alone cannot rule out an authenticator or provider identity.
A nonempty list of only provider identities needs an owner recovery link accepted
with a password or passkey; adding a local credential is not first enrollment.

## Guidance checked

[OWASP ASVS 5.0, V7.5.1 and V7.5.3](https://raw.githubusercontent.com/OWASP/ASVS/v5.0.0/5.0/en/0x16-V7-Session-Management.md)
require reauthentication for sensitive account attributes and further verification
for sensitive operations. V7.5.1 calls for full reauthentication. Our approved
single-existing-factor rule is narrower when the account uses MFA; this change
does not claim ASVS Level 2 compliance.

[NIST SP 800-63B-4, sections 4.1.2.1 and 5.2](https://pages.nist.gov/800-63-4/sp800-63b.html)
tie reauthentication to a session and require authentication at the appropriate
assurance level when binding authenticators. NIST distinguishes recovery from
authentication and does not treat an access token as evidence of a person's
presence. The ten-minute window is this product's decision, not a NIST timeout.
Its one-factor policy does not claim NIST AAL2 authenticator-binding compliance.

## Design

Store a nullable `reauthenticated_at` on the session row. Upgraded sessions start
without proof. Every affected identity writer checks that row against the server
clock inside its transaction, before writing. Credential verification starts
outside the write gate and rechecks the exact credential data and session hash
under the gate. A passkey proof has a single-use challenge bound to the session
and person. TOTP proof consumes its replay counter with the timestamp. Subsequent
writers recheck the session and timestamp, not whether the proving credential
still exists; removing it does not erase proof on a surviving session.

`POST /api/account/proof` exchanges secrets outside the operation registry, as
password replacement does (decision 0017). No proof secret reaches the command
ledger. Refused operations return `recent_proof_required` with HTTP 403. The web
keeps the action in its component, asks inline, and retries after proof. A changed
session or unmounted component cancels the pending action. CLI callers read the
same refusal; MCP exposes no credential operations. The iPhone recognizes the
code and points to web settings, which this iPhone build does not expose.

## Alternatives and synthesis

We compared a session column with separately stored grants keyed by session
hash, including an in-memory grant shaped like passkey ceremonies. Separate
grants add expiry, import cleanup and another owner of session authority. The
column shares the session's lifetime and is read with the writer's transaction.
Passing a password to each registry mutation would put proof secrets into the
command path and make each enrollment repeat the protocol. One proof exchange
and one writer guard keep those responsibilities in identity.

The demo has no sign-in ceremony or private credentials, so this feature adds no
demo event. HTTP and browser tests exercise the real sign-in flow instead.

Principles: Model the Domain (one session timestamp); Boundary Discipline (secrets
stay outside the command ledger); Foundational Thinking (recheck shared state at
commit); Exhaust the Design Space (session state instead of separate grants);
Test Behavior, Not Implementation (HTTP refusals and browser retry).

## Administrative authority

Browser invitations require proof regardless of requested grant: omitted human
grants include admin, and a non-admin invitation could be elevated later. A
browser setting a direct or team grant that contains admin also proves its own
credential. Adding a member to a team holding admin on any project requires the
same proof, with the team's current grants read inside the writer. Both orders
of team grant and membership changes are covered. Bearer-token and local
operators retain their existing authority for these operations.

Other identity creation is through guarded token/invitation writers; bootstrap
actor creation is private. Empty team creation and non-admin grants do not
create admin authority. Grant/membership removal, revocation and forgetting only
remove authority. Archive import discards credentials, tokens and sessions, but
restores verified recovery addresses that can authorize a mailed password reset. Browser imports
therefore require the caller's recent proof before the upload is read and again
under the write gate before import. Authorized bearer-token and local imports
remain available without proof. Authorized restores keep recovery-address verification;
clearing it would change backup semantics and address only the mail-reset path.
