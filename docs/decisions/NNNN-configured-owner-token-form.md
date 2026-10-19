# NNNN: A configured owner token must survive HTTP transport unchanged

Date: 2026-10-18

Fixes [issue #558](https://github.com/endqwerty/mainworthy/issues/558).

Decision 0017 requires a configured token to work for browser sign-in and bearer requests. Its length checks
already refuse values longer than a sign-in can read. Startup also needs to refuse a form that an HTTP
header cannot carry unchanged. A trailing space previously signed a browser in but failed as a bearer;
an emoji signed a browser in but could not be sent by the CLI. Rotation to either value revoked the
previous token even though scripts could not use its replacement.

A nonempty `MAINWORTHY_OWNER_TOKEN` must contain 20 to 512 visible ASCII characters, from `!` through `~`.
Spaces, tabs, line breaks, other control characters and non-ASCII characters stop startup. Empty still
means unset. Keep the value exact, without trimming, normalization or encoding. Punctuation remains
accepted because the HTTP and CLI paths preserve it. `openssl rand -hex 32` makes a suitable value.

`validateBootstrap` owns the check. It runs before startup creates or locks data, and before bootstrap
creates a token or retires the previous configured token and its sessions. Local mode follows the same
rule because it also stores configured tokens. An invalid rotation leaves the old token and its sessions
usable when the operator restores the previous configuration.

Changing clients to encode arbitrary secrets would require a different authentication contract for the
CLI, HTTP integrations and mobile clients. Rejecting values that cannot use the existing contract keeps
one exact secret shared by browser sign-in and bearer requests. No schema, operation or iPhone contract
changes. Existing configurations outside this form must choose a replacement before starting this build.
