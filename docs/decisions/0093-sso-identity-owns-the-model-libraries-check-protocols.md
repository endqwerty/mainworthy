# 0093. SSO: the identity module owns the model, libraries check the protocols

Date: 2026-10-17. Asked by the owner in a thread on 2026-10-16. Issue #114. Builds on decisions 0017 and 0072.

## Problem

The owner asked whether Mainworthy should keep its own sign-in code or move to an auth framework such as Better
Auth, and decided that it needs single sign-on built in, not added later. Sign-in is about 7,200 lines of our own
in `src/server/identity` (sessions, passwords, passkeys, TOTP, invitations, teams, the failed-attempt limit), and
some of it parses hostile input by hand: the passkey verifier (`webauthn.ts`) and TOTP (`totp.ts`). SSO adds two
protocols. Writing SAML, which means checking signed XML, ourselves would be the wrong call.

## Decision

The identity module keeps **the model and the policy**: who a person is, credentials, sessions, `admit`, the write
gate, invitations, which credentials a person may remove, admin MFA, and what an archive leaves out. **Protocol
checkers** come from maintained libraries, behind one file each, and decide only "this is subject X at issuer Y" or
"refused".

| Protocol | Who checks it |
| --- | --- |
| Passwords | `Bun.password` (argon2id), as before |
| TOTP | our RFC 6238 code, which is small and fully specified |
| Passkeys | our verifier, compared answer by answer with `@simplewebauthn/server` in `test/webauthn-comparison.test.ts` (#419) |
| OpenID Connect | `openid-client` (this decision, `src/server/identity/oidc.ts`) |
| SAML 2.0 | a library chosen by the spike in #418 |

An identity at a provider is a **credential of kind `oidc`**. The `credentials` table already allowed the kind
(migration 0004), so no migration was needed. The handle is the issuer and the subject joined by `#`. A session
rests on it as on a password. It reaches a person in two ways, an invitation or the person linking it from
their settings, and never through an email or name the provider sends. Creating people from the provider (by
email domain, or SCIM) is an owner decision and has its own issue (#420).

## Why not Better Auth

It would take over the model rather than the protocols. Better Auth brings its own user, session and organisation
tables, its own migrations and its own `/api/auth/*` handler. That breaks three rules in `AGENTS.md`: one registry,
module-owned SQL, and standing changes that only a decision makes. It also runs its writes outside the single
write gate. We would keep two records of who people and teams are, and still write the policy ourselves. The policy
is where a framework's defaults are written for somebody else's app. The SSO plugin of Better Auth let any
organisation member register a provider until 1.6.11 (CVE-2026-53515).

## How OpenID Connect works here

- **Configuration.** One provider per instance, from `MAINWORTHY_OIDC_ISSUER`, `_CLIENT_ID`, `_CLIENT_SECRET` and
  `_NAME`, set together, with `MAINWORTHY_PUBLIC_URL`. The issuer must be `https`, or plain `http` on the loopback
  address. More than one provider waits for a need.
- **The flow.** Authorization code with PKCE (S256), a state and a nonce. `openid-client` checks the ID token's
  issuer, audience, nonce and times. **Its signature check is switched on** (`enableNonRepudiationChecks`). The
  library otherwise trusts TLS to the token endpoint, which OIDC Core 3.1.3.7 allows. A probe on 2026-10-17
  showed a token signed with the wrong key being accepted that way, and `test/oidc.test.ts` now holds that it is
  refused. The client authenticates with `client_secret_basic` unless the provider lists only
  `client_secret_post`.
- **The browser's return.** The provider sends the browser to a page of the web UI, `/signin/oidc`. That page posts
  the query to `POST /api/login` from our own origin. So the session and ceremony cookies stay `SameSite=Strict`,
  and the provider's answer goes through the one sign-in exchange. The other design was a server route that took
  the redirect itself. It needs a `Lax` cookie for the cross-site return and an HTML reply that sends the browser
  on with a second, same-site navigation. That is a second way in and a second cookie policy, so it was turned down.
- **Ceremonies** live in memory, keyed by state and tied to the ceremony cookie, as passkey challenges are. A
  ceremony is spent when it is found for its browser, before the code is exchanged. An import clears them.
- **Removing and forgetting.** A revoked `oidc` row drops its handle. A passkey's credential id is random and stays
  on its row for good, but a subject identifies a person at the provider, and the same identity must be linkable
  again.
- **Admins.** With `MAINWORTHY_REQUIRE_ADMIN_MFA`, an admin signs in through the provider only when
  `MAINWORTHY_OIDC_MFA=true`, which is the operator's word that the provider asks everybody for a second factor.
  Mainworthy does not read `amr` or `acr`, because providers fill them inconsistently.
  Without that word, a start with the rule, and becoming an admin, end an admin's sessions opened through the
  provider, as they end password sessions (`endSessionsWithoutFactor`). The independent review found the first
  build ending only password sessions.
- **A way in is a way in now.** When removing a credential, an `oidc` row counts only if its issuer is the
  provider configured now. With the provider gone or replaced, the last password or passkey stays.

## Not done here

SAML (#418), creating people from the provider (#420), the iPhone app (#421), single logout, and a provider's
groups mapped to teams.
