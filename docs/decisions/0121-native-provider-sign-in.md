# 0121. Native provider sign-in uses a verifier-bound handoff

Date: 2026-10-20. Issue [#421](https://github.com/endqwerty/mainworthy/issues/421). Builds on decisions 0023 and 0093.

## Decision

The iPhone app opens the instance's OIDC authorization URL in `ASWebAuthenticationSession`. It first makes a
random verifier and request state and sends the S256 challenge to `POST /api/login/oidc/native`. The provider
returns to `/api/login/oidc/native/callback` at `MAINWORTHY_PUBLIC_URL`. Operators register that additional
redirect URI at their provider. The app verifier protects the Mainworthy handoff. The server still makes its
own independent provider-facing PKCE verifier, state and nonce. The existing web callback and its Strict
ceremony cookie stay as they are.

The identity module checks the provider using the same library, PKCE, nonce, state and credential mapping as
web sign-in. Native ceremonies have a distinct purpose and cannot finish through the browser exchange. The
native callback redirects to the fixed `com.mainworthy.app://signin/oidc` with an opaque code and the app's
request state. It opens no session in the browser. The code expires after one minute. The app exchanges it
once through `POST /api/login`, with its verifier, instance and callback. The reply sets an ordinary session
cookie backed by the OIDC credential. Only that cookie enters the app's secret store.

Ceremonies and handoffs are bounded maps scoped to the running instance, like passkey ceremonies. Only a
code's hash is held. When the handoff map is full after expired entries are removed, issuing another code
evicts the oldest code, even if it belongs to another person. That person's sign-in fails and can be retried
by starting again. Restart or archive import ends pending ceremonies and handoffs. No persistent table or
migration is added, so no secret-bearing table needs adding to `UNEXPORTED`. The identity module owns these
maps and session creation. The HTTP sign-in routes remain outside the operation registry for the reasons in decision 0017. No surface
retains a session secret.

## Threat model

- Another app registers the same scheme and intercepts a code from an attempt the Mainworthy app began.
  It lacks the random verifier whose S256 hash the ceremony holds. The URL contains no cookie, provider token
  or verifier. TLS protects the begin and exchange requests, with plain HTTP allowed only for localhost development.
- An attacker starts an attempt with their own verifier and sends its authorization link to a victim. If
  the victim completes provider sign-in and a malicious app on their phone holds `com.mainworthy.app`, that
  app can receive the code and give it to the attacker, who knows the verifier and can exchange it for the
  victim's session. PKCE does not prove which app began an attempt. This is the custom-scheme public-client
  impersonation limit described in [RFC 8252 section 8.6](https://www.rfc-editor.org/rfc/rfc8252.html#section-8.6).
  The universal link described below would bind callback delivery to the associated app and close this
  scheme-registration path.
- A code is replayed or two requests exchange it together. The map removes it synchronously before opening a
  session, and expiry is checked on exchange. A lost exchange reply requires starting again.
- A code for one person is substituted into another sign-in. Each app attempt checks its random state and
  uses a fresh verifier. The handoff captures the verified credential id and actor, and exchange rechecks
  both, credential revocation, person status, provider configuration and admin MFA. The exchange accepts no
  name, actor, or identity claim from the caller. Existing browser cookies cannot change the recipient.
- A caller chooses an external callback to make an open redirect. The begin and exchange accept exactly
  `com.mainworthy.app://signin/oidc`, not arbitrary URLs or matching prefixes. The instance must exactly match
  its configured public origin at begin and exchange. Another instance has a separate map.
- A provider answer reaches the wrong callback or is injected into the web flow. Native and browser purposes
  are checked before consumption, and the OIDC library checks the redirect URI and provider proof. Provider
  errors and unknown identities create no handoff. Refused native callbacks count toward the same
  per-address sign-in limit as web refusals. A known native request returns to the app with `error=limited`
  and `retryAfter` in seconds from the same limiter result as the web's `Retry-After`; an unknown request
  keeps the HTTP 429 reply. A valid provider answer passes an address block, as on the web.

## Alternatives and limits

A reusable session in a callback URL exposes it to an intercepting app. Sharing a browser cookie with the app
would give the app the browser's session and depends on browser storage access. Both were rejected.

A universal link would need a paid signing team, an associated-domains entitlement for each instance, an
`apple-app-site-association` entry with `applinks` and the callback path, and matching HTTPS callback handling
in the app and server allowlist. The existing password AutoFill `webcredentials` association is insufficient.
The custom scheme works with a free signing team and in the simulator. Real-device checking remains open in
[#421](https://github.com/endqwerty/mainworthy/issues/421).

References: [OAuth for native apps, RFC 8252](https://www.rfc-editor.org/rfc/rfc8252.html),
[Apple's web authentication session](https://developer.apple.com/documentation/authenticationservices/authenticating-a-user-through-a-web-service).
