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
password, passkey, authenticator secret or recovery code, and sends no sign-in mail. The provider owns
credentials, a second factor and account recovery; the customer this is for already has one (Google Workspace,
Microsoft Entra, Okta, Keycloak). Tokens stay: the owner token, personal tokens for scripts, and the tokens of
agents and pipelines.

- **The first way in** is the owner token typed into the sign-in form, as today. The owner then links their
  provider identity in **Your sign-in**.
- **An instance without a provider** has one person, the owner, signed in with the owner token, plus agents and
  pipelines. Inviting a second person needs a provider; `mainworthy invite` says so. A developer's machine runs
  in local mode or against the test provider.
- **Joining.** An invitation is accepted by signing in at the provider (the `join` ceremony, as today).
  Recovery is a new invitation for the same person, which links the identity they sign in with next.
- **Recent proof** (0145) is a fresh sign-in at the provider: the server asks with `max_age=0` and takes the
  proof only when the ID token's `auth_time` is inside the last ten minutes. It still guards linking and
  unlinking an identity, creating a token from a browser and issuing an invitation from a browser. A person
  linking their first identity needs no proof, as first enrollment did.
- **The hosted instance** uses Google accounts (`https://accounts.google.com`) until a customer needs its own
  provider. More than one provider per instance waits for a need, as in 0093.

## Why not a hosted auth service

Clerk, WorkOS or Auth0 would hold the sessions and people too. Decision 0093 turned Better Auth down for the
same reason: two records of who a person is, and writes outside the decision gate. OpenID Connect is what
those services and every enterprise provider speak, so the hosted instance can move to one later by changing
four variables, and a self-hosted instance points at the customer's own provider. The protocol stays
`openid-client`'s; only the model is ours.

## What it costs

Stored passwords, passkeys, authenticators and recovery codes are deleted by a migration; before 1.0 there is
no path to keep them. On an existing instance the owner signs in with the owner token and links a provider
identity; anyone else gets a new invitation.
The native iPhone sign-in left with the app ([freeze](2026-10-27-freeze-what-the-customer-does-not-need.md)).
