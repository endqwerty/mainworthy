# People sign in through an identity provider

- Date: 2026-10-27
- Status: accepted
- PR: https://github.com/endqwerty/mainworthy/pull/1024

Narrows [0093](0093-sso-identity-owns-the-model-libraries-check-protocols.md) and replaces the password, passkey,
second-factor and recovery parts of 0017, 0067, 0072, 0122 and 0145. The owner worried about running our own
sign-in ("I honestly worry about security and really feel like using clerk (or some other sort of auth, like if
google has one) will be better") and on 2026-10-27 chose "auth changes to OIDC".

## Decision

A person signs in through the instance's OpenID Connect provider, and only that way. Mainworthy keeps no
password, passkey, authenticator secret, recovery code or recovery address, and sends no mail at all: mail
existed only for sign-in (resets, verification, notices) and for invitation links an admin can hand over
themselves. The provider owns credentials, a second factor and account recovery, so
`MAINWORTHY_REQUIRE_ADMIN_MFA` and `MAINWORTHY_OIDC_MFA` go too; the customer this is for already has one (Google Workspace,
Microsoft Entra, Okta, Keycloak). Tokens stay: the owner token, personal tokens for scripts, and the tokens of
agents and pipelines.

- **The first way in** is the owner token typed into the sign-in form, as today. The owner then links their
  provider identity in **Your sign-in**.
- **An instance without a provider** has one person, the owner, signed in with the owner token, plus agents and
  pipelines. Inviting a second person needs a provider; `mainworthy invite` says so. A developer's machine runs
  in local mode or against the test provider.
- **Joining.** An invitation is accepted by signing in at the provider (the `join` ceremony, as today).
  Recovery is a new invitation for the same person, which links the identity they sign in with next.
- **Recent proof** (0145) is a fresh sign-in at the provider: the server asks with `max_age=0` and asks for
  `auth_time` as an essential claim, and takes the proof only when the ID token says the person signed in there
  after the ceremony began, dating the proof from that sign-in. An answer without `auth_time` proves nothing: it would be a silent single sign-on
  from whoever sits at the browser (the security audit of #1048 found this; an earlier draft of this record
  accepted it), and so does a sign-in from before the ceremony, which a provider ignoring `max_age=0` would send (its second audit). Google gives `auth_time` only when a request asks for it and the client's settings enable it
  (read 2026-10-27), so the hosted instance's client must have it enabled. A browser session opened by typing a token has proof
  for ten minutes, unlike under 0145: a token already speaks for its person over the API, so the browser gains
  nothing the token lacked. Proof still guards linking any identity, the first included, and unlinking one, creating a token or
  an invitation from a browser, granting admin, team admin changes and archive import. Unlike first enrollment before, a first identity needs proof too (the security audit of #1048:
  it is a lasting way in, so an unattended token session must not be able to add one; signing in with the token
  gives that proof).
- **The hosted instance** uses Google accounts (`https://accounts.google.com`) until a customer needs its own
  provider. More than one provider per instance waits for a need, as in 0093.

## Why not a hosted auth service

Clerk, WorkOS or Auth0 would hold the sessions and people too. Decision 0093 turned Better Auth down for the
same reason: two records of who a person is, and writes outside the decision gate. OpenID Connect is what
those services and every enterprise provider speak, so the hosted instance can move to one later by changing
four variables, and a self-hosted instance points at the customer's own provider. The protocol stays
`openid-client`'s; only the model is ours.

## What it costs

Stored passwords, passkeys, authenticators and recovery codes are deleted by migration 8; before 1.0 there is
no path to keep them. On an existing instance the owner signs in with the owner token and links a provider
identity; anyone else gets a new invitation. Archive format 45 leaves out recovery email addresses; older archives
must be exported again before importing.
The native iPhone sign-in left with the app ([freeze](2026-10-27-freeze-what-the-customer-does-not-need.md)).
