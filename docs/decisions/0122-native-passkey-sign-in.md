# 0122: native passkey sign-in

Date: 2026-10-20

## Context

[Issue #205](https://github.com/endqwerty/mainworthy/issues/205) asks the iPhone app to sign in with an existing
passkey. Password AutoFill already uses associated domains, but does not perform a passkey assertion.
The server verifies a web assertion against the configured public origin, including its port.
AuthenticationServices supplies `https://<rp-id>` as the native assertion's origin, without that port.

## Decision

The app asks `POST /api/login/challenge` for `{ "native": true }`. The server requires an HTTPS public
address and records `https://<rp-id>` in this challenge. A web challenge, requested with `{}`, keeps the
configured web origin. Completion never chooses or relaxes the expected origin.

The native attempt holds the ceremony cookie returned with the challenge. It sends the cookie and the
assertion's base64url-encoded byte fields to the existing `POST /api/login` passkey completion. Signature,
RP hash, user verification, user handle, cookie binding, expiry and one-use checks remain the same.
A successful completion opens and stores the same session as password sign-in. The app stores no passkey,
assertion or ceremony cookie. A retry obtains a fresh challenge. Cancel and failure leave password entry intact.

`PasskeyAuthorizing` separates the package's request and reply handling from Apple's
`ASAuthorizationPlatformPublicKeyCredentialProvider`. The app adapter requests an assertion with required
user verification and passes the returned bytes to the client. Package tests substitute authorization only.

## Associated domains and self-hosted instances

Each signed app must declare `webcredentials:<rp-id>`. The existing entitlement uses
`MAINWORTHY_WEBCREDENTIALS_DOMAIN`, defaulting to `mainworthy.com`. Each instance serves its list of
`MAINWORTHY_APPLE_APPS` under `webcredentials.apps` in `/.well-known/apple-app-site-association`.
Each value is the signing team's application identifier, a team ID followed by the app's bundle ID.
The install command prints it. No actual team identifier belongs in the repository.

For another instance, build from source with its address in `MAINWORTHY_INSTANCE` and its bare host in
`MAINWORTHY_WEBCREDENTIALS_DOMAIN`. Enable `CODE_SIGN_ENTITLEMENTS = App/Mainworthy.entitlements`, sign with
an eligible paid team, and have that instance list the printed application identifier. Configure
`MAINWORTHY_PUBLIC_URL` with its HTTPS address. Serve the association file over public HTTPS at the domain's
standard port without authentication or redirects so Apple can fetch it. An app connecting on a non-default
port still uses that host's standard HTTPS association endpoint and the portless native origin.
When the web address includes a port, a native challenge accepts an assertion made at `https://<host>` on port 443.
Whoever serves that origin could relay a person's assertion. The instance's owner controls that origin because
the association file must be served there.
Rebuild and reinstall when the entitlement changes. Selecting a server address cannot add an associated
domain at runtime. A distributed build supports only domains included in its signed entitlement.
A free-team build or an unassociated instance retains password sign-in.

## Alternatives

Reusing the web challenge would work only when its origin already equals the native RP origin.
Accepting both origins for every assertion would weaken the existing web ceremony unnecessarily.
A native challenge records the expected origin before proof arrives and reuses all other verification.
No new login route, persisted challenge type, or session format is needed.

## Verification limits

The iOS test server uses HTTP loopback with no public RP address, where the native challenge returns 400.
A server configured for HTTP localhost also refuses native challenges. The unsigned simulator
build has no signed associated-domain entitlement. Package tests use fake authorization and real request
and reply handling. Server tests exercise signed assertions, port-specific origins, replay, expiry and
cookie binding on a real listener. They do not prove Apple's credential picker or domain association works.
Physical supported-device testing and an external credential provider remain open in issue #205.

Apple's [Supporting passkeys](https://developer.apple.com/documentation/authenticationservices/supporting-passkeys)
and [Meet passkeys](https://developer.apple.com/videos/play/wwdc2022/10092/) describe the assertion API and
`webcredentials` association.
