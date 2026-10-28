---
id: oidc-only-sign-in
category: Breaks
date: 2026-10-27
pr: https://github.com/endqwerty/mainworthy/pull/1048
---

People sign in only through the instance's OpenID Connect identity provider, or with a token. Passwords, passkeys, the authenticator and its recovery codes, recovery email addresses and all mail are gone, and so are `mainworthy login`, `mainworthy invite --email`, `MAINWORTHY_SMTP_*`, `MAINWORTHY_MAIL_FROM`, `MAINWORTHY_REQUIRE_ADMIN_MFA` and `MAINWORTHY_OIDC_MFA`; the first start deletes what they stored and signs out browsers that used them. An operator removes those variables, [sets up a provider](../docs/guide/configuration.md#sign-in-through-an-identity-provider) (`MAINWORTHY_OIDC_ISSUER`, `_CLIENT_ID`, `_CLIENT_SECRET`, `_NAME` and `MAINWORTHY_PUBLIC_URL`, with the redirect address `<public URL>/signin/oidc`), signs in with the owner token, links their identity in Settings, **Your sign-in**, and makes a recovery link for everybody else, who accepts it at the provider. Without a provider only the owner signs in, and `mainworthy invite` refuses. Changing sign-in details, making a token or an invitation in a browser, granting `admin` and importing an archive need a sign-in at the provider (**Confirm with**) or with a token from the last ten minutes. Archives are now format 45; export again, because formats 43 and 44 are refused on import.
