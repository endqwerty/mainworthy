# API and agent tools

This page lists every Mainworthy operation, with its address, required capability,
and input.
The web UI, command line, and agent tools call these operations. The command line
and HTTP API reach every operation. MCP exposes ten of them as agent tools.

## Call an operation

An operation is one `POST` with a JSON body. An operation on a project is at
`/api/p/<project>/<operation>`. The instance operations `admin`, `session`,
`credential`, and `invitation` are at `/api/<operation>`. Calling an instance operation at a project's address
returns `not_found` with the correct address.

```
$ curl -s -X POST http://127.0.0.1:7357/api/p/scratch/find \
    -H 'content-type: application/json' \
    -d '{"in":"cases","limit":2}'
{"ok":true,"result":{"count":0,"items":[],"cursor":null},"seq":1}
```

The OpenAPI document at `/api/openapi.json` describes each operation's input and
successful reply, including the fields inside `result`. The registry supplies
both schemas. `seq` is required and is `null` for an instance operation. A field
declared nullable may hold `null`. An optional field may be absent. Replies
selected by an action or a ref are described as alternatives.

A successful operation returns `ok: true`, `result`, and `seq`, the project's
sequence number at that point. The `since` operation with `{"cursor":"s:12"}`
returns changes after sequence 12. A reply with `more: true` has more changes
available through another call with the returned `cursor`.

When an operation does not run, its reply has `ok: false` and an `error` with a
`code` and a `message`:

```
{"ok":false,"error":{"code":"not_found","message":"no operation named nope"}}
```

| Code | HTTP status | Meaning |
| --- | --- | --- |
| `invalid` | 400 | The input is wrong. `details` says which field. |
| `unauthenticated` | 401 | The caller supplied no working credentials. Refused names, passwords, passkey answers, and invitation codes get the same reply, regardless of the reason. |
| `forbidden` | 403 | The caller lacks the required capability, or the operation or policy refuses the action. |
| `not_found` | 404 | No such operation, project, or ref. The server returns the same code for a project the caller has no grant on. |
| `conflict` | 409 | The edit was made on an older version, the command id was used for something else, or the client's API version differs from the server's. |
| `limited` | 429 | An authentication or anonymous-start allowance has been exhausted. Failed attempts can be wrong tokens from this address or for a token that starts as this one does, wrong passwords or authenticator codes from this address or for this name, or refused passkeys or invitation codes from this address. Anonymous starts have separate, non-escalating limits of 300 successful starts per public IPv4 address or IPv6 /56 per minute. The `Retry-After` header says how many seconds to wait. |
| `internal` | 500 | The server failed. The message is `internal error`, and the detail is in the server's log. A report can commit in stages, so a failure does not prove that nothing was written. |

## Authenticate

Token authentication uses `Authorization: Bearer <token>`. A server in local
mode trusts requests from the same machine and needs no token.
[People, agents and pipelines](./access.md) explains how to make a token and
what the token may do.

## Sign in as a person

These routes handle sign-in, recovery, and password changes outside the operation
registry. A successful sign-in sets a session cookie. Each `POST` refuses requests
from another site's page and allows scripts such as `curl` that send no site headers.
`GET /api/login/methods` answers anybody. The `POST` requests take JSON, except that
logout needs no body. Replies use the operation envelope without `seq`.
[People, agents and pipelines](./access.md#sign-in-as-yourself) describes the sign-in steps.

| Request | Body | What it does |
| --- | --- | --- |
| `GET /api/login/methods` | none | Returns `{"password": true, "passkey": <boolean>, "mail": <boolean>, "oidc": {"name"} or null}`. The booleans say whether the instance offers passkeys and mail. `oidc` names the identity provider, or is `null` when the instance has none. |
| `POST /api/login` | `{"token"}` | Signs in with a token. |
| `POST /api/login` | `{"name", "password"}` | Signs in with a name and a password, or returns `{"signedIn": false, "secondFactor": {"challenge", "expiresAt"}}` when an authenticator is enrolled. A second-factor reply creates no session. The next step requires the ceremony cookie from this response. |
| `POST /api/login` | `{"challenge", "code"}` | Completes the password sign-in with a fresh six-digit TOTP or unused recovery code, plus the ceremony cookie from the first step. The challenge lasts five minutes and works once. A successful reply is `{"signedIn": true}` and sets the session cookie. |
| `POST /api/login/challenge` | `{}` | Returns the options for `navigator.credentials.get` in `result.passkey`. The challenge works once for five minutes. The reply sets an `HttpOnly` cookie, `mainworthy_ceremony` over HTTP or `__Host-mainworthy_ceremony` over HTTPS. The answer must carry that cookie. A browser sends the cookie automatically. A script must retain the cookie. |
| `POST /api/login` | `{"passkey"}` | Signs in with what the browser returned for those options: `id`, `clientDataJSON`, `authenticatorData`, `signature`, `userHandle`, each base64url. |
| `POST /api/login/challenge` | `{"invitation"}` | Returns the invitation's recipient, purpose (`join` or `recover`), and expiry, with options for `navigator.credentials.create`. On an instance without passkeys, the options are `null`. The request writes no row. On an instance with passkeys, each lookup that finds the invitation makes a challenge the server keeps in memory for five minutes. A code that accepts nothing is answered `not_found`. |
| `POST /api/login` | `{"invitation", "password"?, "passkey"?, "label"?, "replace"?}` | Accepts an invitation with a password, a passkey, or both, and signs in. `passkey` holds `id`, `clientDataJSON`, `authenticatorData`, `publicKey`, `publicKeyAlgorithm`, and `transports` from the browser. If the browser is signed in as another person, the reply is `conflict` with their name in `details.signedInAs`. Sending that name as `replace` signs them out of this browser when the invitation is accepted. Any other name is refused the same way, with the name the browser is signed in as. A `replace` that is not a string, such as `true`, returns `invalid`. |
| `POST /api/login/oidc` | `{}`, `{"invitation", "replace"?}` or `{"link": true}` | Begins signing in through the identity provider, accepting an invitation that way, or linking the provider to the person whose browser session sends it. Returns `{"url"}`, the provider's address to send the browser to, and sets the ceremony cookie. The provider sends the browser back to `/signin/oidc` with a code and a state. A refused invitation is `not_found`. A browser signed in as somebody else is `conflict`, as when accepting with a password. `{"link": true}` with a token is `forbidden`. On an instance with no provider, every body is `invalid`. |
| `POST /api/login` | `{"oidc": "<query>"}` | Finishes what `/api/login/oidc` began, with the query the provider sent the browser back with, and the ceremony cookie. The ceremony works once, in the browser that began it, for five minutes. A sign-in or an accepted invitation returns `{"signedIn": true}` and sets the session cookie. A link returns `{"linked": true}`. An identity linked already, to anybody, is `conflict`. An identity nobody linked is refused like a wrong password. |
| `POST /api/login` | `{"resetRequest":"robin@example.com"}` | Requests a password-reset email for a verified address. Returns `{"requested":true}` whether or not the address matches an account. Requires mail. |
| `POST /api/login` | `{"emailVerification":"<code>"}` | Verifies a recovery email address. Returns `{"verified":true}` on success. The code works once for 24 hours. Requires mail. |
| `POST /api/login` | `{"reset":"<code>","password":"<new password>"}` | Replaces the password and ends existing sessions. Returns `{"changed":true}` without signing in. The code works once for 15 minutes. An enrolled authenticator remains required. Requires mail. |
| `POST /api/account/password` | `{"current"?, "next"}` | Sets or changes the password of the person whose browser session sends it. `current` is required when they have one. |
| `POST /api/account/proof` | `{"password"}`, `{"code"}` or `{"passkey"}` | Proves an existing credential for the current session for ten minutes. `code` is a six-digit TOTP, not a recovery code. Returns `{"proved":true}`. A wrong proof is `forbidden`; failed-attempt limits apply. |
| `POST /api/account/proof` | `{"begin":true}` | Returns `{"passkey":<assertion options>}` for a single-use passkey proof bound to this session and its person. Finish at the same endpoint with `{"passkey":<assertion>}`. |
| `POST /api/logout` | none | Ends the browser's session and clears its cookie. |

Credential changes, recovery-address changes, and provider linking return HTTP
403 with `recent_proof_required` when the caller's session has no proof within
ten minutes. Prove a credential in that session and retry the refused action.
This refusal leaves the session signed in and writes no command. When changing
another person's details, prove the admin's own credential. Bearer tokens do not
carry session proof. A first credential and invitation or recovery acceptance
need no prior proof. Replacing a password retains its current-password check.
Creating a token through `credential` or `admin`, and issuing a recovery
invitation from a browser also need the caller's recent proof. Bearer-token and
local issuance retain their existing recovery authority.

A body holds one of these shapes and no other fields. `GET /api/session` returns
who is signed in, their numeric actor id (`actorId`), the current session id
(`session`), and whether they own the instance (`owner`). For a person,
`credentials` says whether they have a password and how many passkeys they have.
An archive import can replace actor ids.

Passwords use Unicode NFC before hashing and checking. An older password also
accepts its original spelling. If that spelling is not NFC, successful sign-in
refreshes the password's hash without ending existing sessions. Accepting a
recovery invitation revokes the person's previous passwords, passkeys, and tokens,
and ends their existing sessions. Recovery does not change other actors' tokens. See
[passwords and recovery](./access.md#a-name-and-a-password-or-a-passkey) for the
legacy-password behavior and the limit when concurrent responses replace the
browser's cookie.

A signed-in person registers another passkey with the `credential` operation.
`passkey.begin` returns the options for `navigator.credentials.create`.
`passkey.add` takes the browser's answer and a label. The session that begins
registration must also finish it. A bearer token cannot register a passkey or
set a password. Both requests return `forbidden`.

The `credential` operation also enrols an authenticator in the caller's session
or as the local owner. `{"do": "totp.begin"}` returns `challenge`, `expiresAt`,
`secret`, `uri`, and `qr` with `size` and an SVG `path`. The QR path fits a white
square of that size with four modules of quiet space already included.
`{"do": "totp.confirm", "challenge", "code"}` confirms a six-digit code in the
same session and returns `id`, ten `recoveryCodes`, and `sessionsEnded`.
These inputs refuse command ids, and the server never caches or replays their
secret replies. Ordinary credential lists return kind `totp` and descriptive
fields only. `remove` removes the authenticator and ends all the person's sessions.

The same operation manages personal CLI tokens with `token.create`, `token.list`,
and `token.revoke`. Creation requires a password, passkey or identity-provider
session, or local-owner access. The new token belongs to the caller, and the reply returns the secret once.
The default expiry is 30 days, with a 365-day maximum. A bearer token or a
token-backed browser session cannot create a personal CLI token.
[Make your own command-line token](./access.md#make-your-own-command-line-token)
gives the inputs, replies, and CLI setup.

## Send a write twice safely

For a write whose input accepts `cmd`, that field identifies the request.
Repeating the same completed request with the same id returns its saved reply
and writes nothing. Reusing the id with different content returns `conflict`.
The `command` operation returns the request's status if the reply was lost.
A report that began but did not finish resumes when retried with the same id
and input.

Secret replies are an exception. Token and invitation creation keep the command's
record but do not save its secret reply. Retrying the same id returns `conflict`
without repeating the write. Authenticator enrolment refuses command ids.

## Say when a write happened

The server records every write with its own clock, except in a demo project.
`mainworthy seed` uses demo projects to write records dated before today.

`admin` with `{"do": "project.demo", "key": "<project>"}` makes a project a demo.
The operation works only on a project with no writes since its creation. The
demo status cannot be undone. The reply holds `key` and `since`, the moment
the project became a demo. Both fields are required by the API reply schema.
Repeating the call returns the same moment. Both `project.list` and the session
reply mark each project with `demo: true` or `false`. A client can use that flag
to identify projects whose writes accept caller-supplied times.

A write to a demo project may carry `X-Mainworthy-At` with a time in milliseconds
since 1970. The server records the write at that time. The server refuses a
future time or a value that is not a whole number. The header is invalid on
reads, instance operations, or projects that are not demos. The time is part
of the request identified by `cmd`. The same request at another time is a
different request.

The server does not check whether a demo's write times are in order. Writes sent
oldest first preserve that order. A `flaky` answer holds for a number of days
from the time the answer was given. An answer dated in the past may already
have expired, causing its question to reopen within a minute.

An archive does not say which project is a demo. After an import every project records the server's clock.

## The machine-readable description

`GET /api/openapi.json` returns an OpenAPI 3.1 document of every operation. The server builds it from the same list as this page on each call. It needs no token.

## Follow changes

`GET /api/p/<project>/events` is a stream of server-sent events about committed
writes to the project. The stream needs the `read` capability. Delivery is best
effort: a failed subscriber does not change a committed write's successful reply
or prevent delivery to other subscribers. The server logs the failure without
the subscriber's error text.

If the server cannot check an open stream's read permission, it closes that
stream so the client can reconnect and read again. Other streams keep receiving
changes. The web app and iPhone app reconnect and reload their project reads.

The stream does not replay missed events on reconnect. A client that misses an
event can read the data again or request changes through `since` with its last
cursor. The web app reads again when the stream opens and refreshes stale reads
when the window regains focus.

## Operations

Ordinary JSON case reads include custom field values in `fields`. Explicit `get` field selections such as
`fields: ["title", "fields"]` select those values without the remaining case content. Fragment users require
`fields: ["users"]`; that selection lists a fragment's current consumers and pins.
A `find --in cases` reply includes the project's `fieldDefinitions`, even when its list is empty.
Session project summaries include those definitions for callers with read access.
The default selection includes `tests` as well as the fields named below.
When `steps` is selected, `hasFragments` says whether that case version has pins.
Only a version with pins also returns `sourceSteps`, the editable references
behind its expanded `steps`.

<!-- generated:operations -->

### attach

Append a screenshot or small file to a result you recorded. Supply the file as base64.

|  |  |
| --- | --- |
| HTTP | `POST /api/p/<project>/attach` |
| Command | `mainworthy attach` |
| Needs | `record` |
| Effect | writes |
| Agent tool | no |

<details>
<summary>Input of <code>attach</code></summary>

| Property | Type | Required | Description |
| --- | --- | --- | --- |
| `result` | `integer` | yes |  |
| `attachment` | `object` | yes |  |
| `attachment.name` | `string` | yes |  |
| `attachment.data` | `string` | yes |  |
| `attachment.at` | `string` | no |  |
| `projectIdentity` | `string` | no | Only proceed if the project key still names this identity. |

</details>

### attachment

List a result's attachments, or read one as base64 with its file name and safe content type.

|  |  |
| --- | --- |
| HTTP | `POST /api/p/<project>/attachment` |
| Command | `mainworthy attachment` |
| Needs | `read` |
| Effect | reads |
| Agent tool | no |

<details>
<summary>Input of <code>attachment</code></summary>

| Property | Type | Required | Description |
| --- | --- | --- | --- |
| `result` | `integer` | yes |  |
| `id` | `integer` | no |  |

</details>

### propose

Create or change cases, folders, links or the policy. Saving and proposing are the same call; policy decides what happens next.

|  |  |
| --- | --- |
| HTTP | `POST /api/p/<project>/propose` |
| Command | `mainworthy propose` |
| Needs | `produce` |
| Effect | writes |
| Agent tool | yes |

<details>
<summary>Input of <code>propose</code></summary>

| Property | Type | Required | Description |
| --- | --- | --- | --- |
| `edits` | `array<object>` | yes |  |
| `edits[][quarantine].op` | `"quarantine"` | yes |  |
| `edits[][quarantine].test` | `string` | yes |  |
| `edits[][quarantine].base` | `integer \| null` | yes |  |
| `edits[][quarantine].exit` | `object \| null` | yes |  |
| `edits[][quarantine].exit[1][1].kind` | `"person"` | yes |  |
| `edits[][quarantine].exit[1][2].kind` | `"expiry"` | yes |  |
| `edits[][quarantine].exit[1][2].at` | `integer` | yes |  |
| `edits[][quarantine].exit[1][3].kind` | `"passes"` | yes |  |
| `edits[][quarantine].exit[1][3].count` | `integer` | yes |  |
| `edits[][fragment].op` | `"fragment"` | yes |  |
| `edits[][fragment].fragment` | `string` | yes |  |
| `edits[][fragment].from` | `integer` | yes |  |
| `edits[][fragment].to` | `integer` | yes |  |
| `edits[][fragment].cases` | `array<object>` | yes |  |
| `edits[][fragment].cases[].case` | `string` | yes |  |
| `edits[][fragment].cases[].base` | `integer` | yes |  |
| `edits[][create].op` | `"create"` | yes |  |
| `edits[][create].kind` | `"case" \| "fragment"` | no |  |
| `edits[][create].body` | `object` | no |  |
| `edits[][create].body.title` | `string` | no |  |
| `edits[][create].body.pre` | `string` | no |  |
| `edits[][create].body.steps` | `array<object>` | no |  |
| `edits[][create].body.steps[][inline].id` | `string` | yes |  |
| `edits[][create].body.steps[][inline].action` | `string` | yes |  |
| `edits[][create].body.steps[][inline].expected` | `string \| null` | yes |  |
| `edits[][create].body.steps[][inline].use` | `never` | no |  |
| `edits[][create].body.steps[][fragment].id` | `string` | yes |  |
| `edits[][create].body.steps[][fragment].use` | `object` | yes |  |
| `edits[][create].body.steps[][fragment].use.fragment` | `string` | yes |  |
| `edits[][create].body.steps[][fragment].use.version` | `integer` | yes |  |
| `edits[][create].body.steps[][fragment].action` | `string` | no |  Default: `""`. |
| `edits[][create].body.steps[][fragment].expected` | `string \| null` | no |  Default: `null`. |
| `edits[][create].body.methods` | `array<"human" \| "auto" \| "agent">` | no |  |
| `edits[][create].body.automate` | `"none" \| "wanted" \| "not-applicable"` | no |  |
| `edits[][create].body.fields` | `record<string>` | no |  |
| `edits[][create].md` | `string` | no |  |
| `edits[][create].outline` | `string` | no |  |
| `edits[][create].folder` | `integer \| string` | no |  |
| `edits[][create].tags` | `array<string>` | no |  |
| `edits[][create].covers` | `array<string>` | no |  |
| `edits[][create].aliases` | `array<string>` | no |  |
| `edits[][create].after` | `string` | no |  |
| `edits[][edit].op` | `"edit"` | yes |  |
| `edits[][edit].case` | `string` | yes | The case, for example C-311. |
| `edits[][edit].base` | `integer` | yes | The version this edit was made on. A stale base is merged or reported, never overwritten. |
| `edits[][edit].body` | `object` | no |  |
| `edits[][edit].body.title` | `string` | no |  |
| `edits[][edit].body.pre` | `string` | no |  |
| `edits[][edit].body.steps` | `array<object>` | no |  |
| `edits[][edit].body.steps[][inline].id` | `string` | yes |  |
| `edits[][edit].body.steps[][inline].action` | `string` | yes |  |
| `edits[][edit].body.steps[][inline].expected` | `string \| null` | yes |  |
| `edits[][edit].body.steps[][inline].use` | `never` | no |  |
| `edits[][edit].body.steps[][fragment].id` | `string` | yes |  |
| `edits[][edit].body.steps[][fragment].use` | `object` | yes |  |
| `edits[][edit].body.steps[][fragment].use.fragment` | `string` | yes |  |
| `edits[][edit].body.steps[][fragment].use.version` | `integer` | yes |  |
| `edits[][edit].body.steps[][fragment].action` | `string` | no |  Default: `""`. |
| `edits[][edit].body.steps[][fragment].expected` | `string \| null` | no |  Default: `null`. |
| `edits[][edit].body.methods` | `array<"human" \| "auto" \| "agent">` | no |  |
| `edits[][edit].body.automate` | `"none" \| "wanted" \| "not-applicable"` | no |  |
| `edits[][edit].body.fields` | `record<string>` | no |  |
| `edits[][edit].md` | `string` | no |  |
| `edits[][place].op` | `"place"` | yes |  |
| `edits[][place].cases` | `array<string>` | yes |  |
| `edits[][place].folder` | `integer \| string` | no |  |
| `edits[][place].after` | `string \| null` | no |  |
| `edits[][place].tags` | `object` | no |  |
| `edits[][place].tags.set` | `array<string>` | no |  |
| `edits[][place].tags.add` | `array<string>` | no |  |
| `edits[][place].tags.remove` | `array<string>` | no |  |
| `edits[][state].op` | `"state"` | yes |  |
| `edits[][state].cases` | `array<string>` | yes |  |
| `edits[][state].to` | `"active" \| "archived"` | yes |  |
| `edits[][restore].op` | `"restore"` | yes |  |
| `edits[][restore].case` | `string` | yes | The case. |
| `edits[][restore].to` | `integer` | yes | The version to restore. |
| `edits[][folder].op` | `"folder"` | yes |  |
| `edits[][folder].folder` | `integer \| string` | no | The folder to change. Absent when creating one. |
| `edits[][folder].name` | `string` | no |  |
| `edits[][folder].parent` | `integer \| string \| null` | no |  |
| `edits[][folder].archive` | `boolean` | no |  |
| `edits[][cover].op` | `"cover"` | yes |  |
| `edits[][cover].case` | `string` | yes | The case. |
| `edits[][cover].requirement` | `string` | yes |  |
| `edits[][cover].on` | `boolean` | yes |  |
| `edits[][cover].title` | `string` | no |  |
| `edits[][policy].op` | `"policy"` | yes |  |
| `edits[][policy].base` | `integer` | no | Required with clauses or settings. |
| `edits[][policy].preset` | `string` | no |  |
| `edits[][policy].clauses` | `array<object>` | no |  |
| `edits[][policy].clauses[].id` | `string` | yes |  |
| `edits[][policy].clauses[].kind` | `"adopt" \| "map" \| "failure" \| "finding" \| "signoff"` | yes |  |
| `edits[][policy].clauses[].when` | `array<"always" \| "author:human" \| "author:agent" \| "author:ci" \| "conflict" \| "policy" \| "scope:change" \| "scope:trunk" \| "scope:run" \| "hint:disputed" \| "inherited" \| "category:defect" \| "verdict:passed" \| "unlinked:track" \| "unlinked:create" \| string>` | yes |  |
| `edits[][policy].clauses[].ask` | `object` | yes |  |
| `edits[][policy].clauses[].ask.who` | `"rule" \| "member" \| "admin" \| "author" \| string` | yes |  |
| `edits[][policy].clauses[].ask.agents` | `"answer" \| "advise" \| "none"` | yes |  |
| `edits[][policy].clauses[].ask.notProducer` | `boolean` | yes |  |
| `edits[][policy].clauses[].ask.reason` | `"optional" \| "required"` | yes |  |
| `edits[][policy].clauses[].answer` | `unknown` | no |  |
| `edits[][policy].clauses[].blocks` | `"nothing" \| "change" \| "release" \| "all"` | yes |  |
| `edits[][policy].settings` | `object` | no |  |
| `edits[][policy].settings.fields` | `record<object>` | no |  |
| `edits[][policy].settings.flakyDetection` | `object` | no |  Default: `{"enabled":true,"windowDays":14,"minFlips":2}`. |
| `edits[][policy].settings.flakyDetection.enabled` | `boolean` | yes |  |
| `edits[][policy].settings.flakyDetection.windowDays` | `integer` | yes |  |
| `edits[][policy].settings.flakyDetection.minFlips` | `integer` | yes |  |
| `edits[][policy].settings.unlinked` | `"ask" \| "track" \| "create"` | yes |  |
| `edits[][policy].settings.emptyReports` | `"pending" \| "nothing-required"` | no |  Default: `"pending"`. |
| `edits[][policy].settings.basis` | `"exact" \| "exact-or-assumed"` | yes |  |
| `edits[][policy].settings.holds` | `object` | yes |  |
| `edits[][policy].settings.holds.flakyDays` | `integer` | yes |  |
| `edits[][policy].settings.holds.infraThisTargetOnly` | `boolean` | yes |  |
| `edits[][policy].unlinked` | `"ask" \| "track" \| "create"` | no |  |
| `edits[][policy].emptyReports` | `"pending" \| "nothing-required"` | no |  |
| `reason` | `string` | no | Why. Shown in the case history. |
| `projectIdentity` | `string` | no | Only proceed if the project key still names this identity. |

</details>

### import-csv

Preview mapped CSV cases, then confirm one import proposal. Existing foreign aliases are refused.

|  |  |
| --- | --- |
| HTTP | `POST /api/p/<project>/import-csv` |
| Command | `mainworthy import-csv` |
| Needs | `produce` |
| Effect | writes |
| Agent tool | no |

<details>
<summary>Input of <code>import-csv</code></summary>

| Property | Type | Required | Description |
| --- | --- | --- | --- |
| `csv` | `string` | yes | UTF-8 CSV file content, with headers. |
| `mapping` | `object` | no |  |
| `mapping.id` | `string` | yes |  |
| `mapping.title` | `string` | yes |  |
| `mapping.steps` | `string` | no |  |
| `mapping.expected` | `string` | no |  |
| `mapping.folder` | `string` | no |  |
| `mapping.pre` | `string` | no |  |
| `mapping.execution` | `string` | no |  |
| `mapping.fields` | `record<string>` | no |  |
| `preset` | `"testrail"` | no |  |
| `confirm` | `string` | no | The confirmation from the dry run. Omit to preview. |
| `projectIdentity` | `string` | no | Only proceed if the project key still names this identity. |

</details>

### report

Record results: a parsed CI report, one manual result, or an agent's batch. The producer is the token's actor.

|  |  |
| --- | --- |
| HTTP | `POST /api/p/<project>/report` |
| Command | `mainworthy report` |
| Needs | `record` |
| Effect | writes |
| Agent tool | yes |

<details>
<summary>Input of <code>report</code></summary>

| Property | Type | Required | Description |
| --- | --- | --- | --- |
| `target` | `object` | no | What was tested. Required unless `run` is given. |
| `target[1].build` | `string` | yes | For CLI and HTTP. MCP's report schema omits the build target; use a planned run. |
| `target[1].env` | `string` | no |  |
| `target[2].commit` | `string` | yes |  |
| `target[2].head` | `string` | no | Current code host head. |
| `target[2].repo` | `string` | no |  |
| `target[2].branch` | `string` | no |  |
| `target[2].env` | `string` | no |  |
| `target[2].pr` | `integer` | no |  |
| `target[2].base` | `string` | no | The commit this change is based on. |
| `target[2].title` | `string` | no |  |
| `target[2].url` | `string` | no |  |
| `target[2].files` | `array<string>` | no | Paths the change touches, for impact. |
| `target[3].session` | `string` | yes |  |
| `run` | `string` | no | A planned run these results are for, for example R-4. |
| `model` | `string` | no | The model that produced this report's results. Agent tokens only; 1 to 120 characters after trimming. |
| `job` | `string` | no |  |
| `attempt` | `integer` | no |  |
| `shard` | `object` | no | This report is one shard of its job: index of of. A commit's gate waits until every shard of the job has reported. |
| `shard.index` | `integer` | yes |  |
| `shard.of` | `integer` | yes |  |
| `buildUrl` | `string` | no |  |
| `results` | `array<object>` | yes |  |
| `results[].test` | `object` | yes |  |
| `results[].test[1].key` | `string` | yes |  |
| `results[].test[1].name` | `string` | no |  |
| `results[].test[1].file` | `string` | no |  |
| `results[].test[2].case` | `string` | yes | The case this manual or agent result is for. |
| `results[].outcome` | `"pass" \| "fail" \| "skip" \| "blocked" \| "error"` | yes |  |
| `results[].attachments` | `array<object>` | no |  |
| `results[].attachments[].name` | `string` | yes |  |
| `results[].attachments[].data` | `string` | yes |  |
| `results[].attachments[].at` | `string` | no |  |
| `results[].durationMs` | `integer` | no | Milliseconds; at most 30 days. |
| `results[].failure` | `object` | no |  |
| `results[].failure.message` | `string` | yes |  |
| `results[].failure.detail` | `string` | no |  |
| `results[].failure.at` | `string` | no |  |
| `results[].steps` | `array<object>` | no |  |
| `results[].steps[].step` | `string` | yes | Case step ID or runner label. |
| `results[].steps[].outcome` | `"pass" \| "fail" \| "skip" \| "blocked" \| "error"` | yes |  |
| `results[].steps[].durationMs` | `integer` | no |  |
| `results[].steps[].actions` | `array<object>` | no |  |
| `results[].steps[].actions[].text` | `string` | yes |  |
| `results[].steps[].actions[].outcome` | `"pass" \| "fail" \| "skip" \| "blocked" \| "error"` | no |  |
| `results[].steps[].actions[].durationMs` | `integer` | no |  |
| `results[].steps[].attachment` | `integer` | no | Screenshot's zero-based attachment index. |
| `results[].note` | `string` | no |  |
| `results[].annotation` | `object` | no |  |
| `results[].annotation.case` | `string` | yes |  |
| `results[].annotation.version` | `integer` | no |  |
| `results[].corrects` | `integer` | no | The id of an earlier result of yours that this one replaces. |
| `results[].tries` | `array<object>` | no |  |
| `results[].tries[].outcome` | `"pass" \| "fail" \| "skip" \| "blocked" \| "error"` | yes |  |
| `results[].tries[].durationMs` | `integer` | no | Milliseconds; at most 30 days. |
| `results[].tries[].failure` | `object` | no |  |
| `results[].tries[].failure.message` | `string` | yes |  |
| `results[].tries[].failure.detail` | `string` | no |  |
| `nothingRequired` | `true` | no | CI-only empty declaration; requires policy permission. |
| `projectIdentity` | `string` | no | Only proceed if the project key still names this identity. |

</details>

### claim

Record a review and what it found. A review with no findings is still recorded.

|  |  |
| --- | --- |
| HTTP | `POST /api/p/<project>/claim` |
| Command | `mainworthy claim` |
| Needs | `produce` |
| Effect | writes |
| Agent tool | yes |

<details>
<summary>Input of <code>claim</code></summary>

| Property | Type | Required | Description |
| --- | --- | --- | --- |
| `lens` | `string` | yes | The kind of review, for example adversarial-review. |
| `about` | `string` | no | The change reviewed, for example pr:482. |
| `patch` | `string` | no | Exact commit from impact's change.head; required for review reuse. |
| `reviewed` | `array<string>` | no | Cases read, each as C-311@<hash>. Recorded even with no findings. |
| `findings` | `array<object>` | no |  Default: `[]`. |
| `findings[].on` | `string` | yes | Where: a case (C-311), a step (C-311#b7), a requirement (req:WEB-290) or a change (pr:482). |
| `findings[].category` | `"cannot-fail" \| "ambiguous" \| "missing-expected" \| "uncovered-path" \| "duplicate" \| "outdated" \| "defect" \| "other"` | yes |  |
| `findings[].note` | `string` | yes |  |
| `findings[].repro` | `string` | no |  |
| `findings[].suggest` | `object` | no |  |
| `findings[].suggest[1].case` | `object` | yes |  |
| `findings[].suggest[1].case.title` | `string` | yes |  |
| `findings[].suggest[1].case.folder` | `string` | no |  |
| `findings[].suggest[1].case.steps` | `array<string>` | yes |  |
| `findings[].suggest[2].step` | `string` | no |  |
| `findings[].suggest[2].action` | `string` | no |  |
| `findings[].suggest[2].expected` | `string` | no |  |
| `projectIdentity` | `string` | no | Only proceed if the project key still names this identity. |

</details>

### change

Say that a change ended or is open again. A merge records the head gate when reported. An ended change is not asked about.

|  |  |
| --- | --- |
| HTTP | `POST /api/p/<project>/change` |
| Command | `mainworthy change` |
| Needs | `record` |
| Effect | writes |
| Agent tool | no |

<details>
<summary>Input of <code>change</code></summary>

| Property | Type | Required | Description |
| --- | --- | --- | --- |
| `change` | `string` | yes | The change, for example pr:482. |
| `state` | `"merged" \| "closed" \| "open"` | yes | How the change ended: merged records the head gate when reported; closed is without merging. open: it is open again. |
| `head` | `string` | no | The change's head commit as the code host says it is now: for merged, the head that merged. The change's gate is this commit's. |
| `landing` | `object` | no | For merged: the exact commit that reached trunk and its branch. It moves to trunk and its failures are judged there; it has a gate of its own, which is the change's only when it is the head. |
| `landing.commit` | `string` | yes |  |
| `landing.branch` | `"main" \| "master" \| "trunk"` | yes |  |
| `projectIdentity` | `string` | no | Only proceed if the project key still names this identity. |

</details>

### announce

Announce a deployment and bind its build label to an attested artifact. Pipelines and human admins only.

|  |  |
| --- | --- |
| HTTP | `POST /api/p/<project>/announce` |
| Command | `mainworthy announce` |
| Needs | `record` |
| Effect | writes |
| Agent tool | no |

<details>
<summary>Input of <code>announce</code></summary>

| Property | Type | Required | Description |
| --- | --- | --- | --- |
| `deploy` | `string` | yes | Build label. Its artifact binding cannot change. |
| `env` | `string` | yes | Environment deployed to. |
| `digest` | `string` | no | Artifact digest. Required for a new build label. |
| `code` | `array<object>` | no | Source repositories and full commits. Required with a new artifact. |
| `code[].repo` | `string` | yes |  |
| `code[].commit` | `string` | yes |  |
| `projectIdentity` | `string` | no | Only proceed if the project key still names this identity. |

</details>

### tracker

Queue a defect from a failed result: create a tracker issue or validate an existing issue for linking.

|  |  |
| --- | --- |
| HTTP | `POST /api/p/<project>/tracker` |
| Command | `mainworthy tracker` |
| Needs | `produce` |
| Effect | writes |
| Agent tool | no |

<details>
<summary>Input of <code>tracker</code></summary>

| Property | Type | Required | Description |
| --- | --- | --- | --- |
| `[1].do` | `"create"` | yes |  |
| `[1].result` | `integer` | yes |  |
| `[1].projectIdentity` | `string` | no | Only proceed if the project key still names this identity. |
| `[2].do` | `"link"` | yes |  |
| `[2].result` | `integer` | yes |  |
| `[2].key` | `string` | yes |  |
| `[2].projectIdentity` | `string` | no | Only proceed if the project key still names this identity. |

</details>

### plan

Start a run: choose cases, say which results count and what completes it. Evidence already recorded fills it at once.

|  |  |
| --- | --- |
| HTTP | `POST /api/p/<project>/plan` |
| Command | `mainworthy plan` |
| Needs | `plan` |
| Effect | writes |
| Agent tool | no |

<details>
<summary>Input of <code>plan</code></summary>

| Property | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | `string` | yes |  |
| `select` | `object` | yes |  |
| `select.cases` | `array<string>` | no |  |
| `select.folders` | `array<integer \| string>` | no |  |
| `select.tags` | `array<string>` | no |  |
| `select.text` | `string` | no |  |
| `accepts` | `object` | no | Which results count. Default: only results recorded in this run. |
| `accepts[1].build` | `string` | yes |  |
| `accepts[1].env` | `string` | no |  |
| `accepts[2].commit` | `string` | yes |  |
| `accepts[2].repo` | `string` | no |  |
| `accepts[2].env` | `string` | no |  |
| `accepts[3].self` | `true` | yes |  |
| `require` | `array<object>` | no |  |
| `require[][1].id` | `string` | yes |  |
| `require[][1].kind` | `"exercise"` | yes |  |
| `require[][1].methods` | `array<"human" \| "auto" \| "agent">` | yes |  |
| `require[][1].minActors` | `1 \| 2` | yes |  |
| `require[][1].basis` | `"exact" \| "exact-or-assumed" \| "same-claim"` | yes |  |
| `require[][2].id` | `string` | yes |  |
| `require[][2].kind` | `"jobs"` | yes |  |
| `require[][2].jobs` | `array<string>` | yes |  |
| `assign` | `array<string>` | no | Actor names to split the slots between. |
| `projectIdentity` | `string` | no | Only proceed if the project key still names this identity. |

</details>

### work

Take a named slot or the next free unfinished slot for a lease, renew it, or give it back.

|  |  |
| --- | --- |
| HTTP | `POST /api/p/<project>/work` |
| Command | `mainworthy work` |
| Needs | `record` |
| Effect | writes |
| Agent tool | yes |

<details>
<summary>Input of <code>work</code></summary>

| Property | Type | Required | Description |
| --- | --- | --- | --- |
| `do` | `"take" \| "give-back"` | yes |  |
| `run` | `string` | yes |  |
| `slot` | `integer` | no | Slot id from find slots. Omit to take the next free unfinished slot. |
| `seconds` | `integer` | no | Lease length in seconds, from 30 to 86400. Default: 900. Default: `900`. |
| `projectIdentity` | `string` | no | Only proceed if the project key still names this identity. |

</details>

### decide

Answer a question, or withdraw a decision. Policy says whether your answer settles it, is advice, or is refused.

|  |  |
| --- | --- |
| HTTP | `POST /api/p/<project>/decide` |
| Command | `mainworthy decide` |
| Needs | `produce` |
| Effect | writes |
| Agent tool | yes |

<details>
<summary>Input of <code>decide</code></summary>

| Property | Type | Required | Description |
| --- | --- | --- | --- |
| `[1].q` | `string` | yes | The question, for example Q-12. |
| `[1].ifOpen` | `boolean` | no | Refuse if the question is no longer open. |
| `[1].onEvidence` | `string` | yes | The evidence hash you saw. If the evidence changed since, the reply is a conflict with the new evidence. |
| `[1].answer` | `record<unknown>` | yes | The answer, for example {"is":"defect"}. The allowed answers depend on the question kind. |
| `[1].reason` | `string` | no |  |
| `[1].projectIdentity` | `string` | no | Only proceed if the project key still names this identity. |
| `[2].all` | `array<object>` | yes |  |
| `[2].all[].q` | `string` | yes | The question, for example Q-12. |
| `[2].all[].ifOpen` | `boolean` | no | Refuse if the question is no longer open. |
| `[2].all[].onEvidence` | `string` | yes | The evidence hash you saw. If the evidence changed since, the reply is a conflict with the new evidence. |
| `[2].all[].answer` | `record<unknown>` | yes | The answer, for example {"is":"defect"}. The allowed answers depend on the question kind. |
| `[2].all[].reason` | `string` | no |  |
| `[2].reason` | `string` | no |  |
| `[2].projectIdentity` | `string` | no | Only proceed if the project key still names this identity. |
| `[3].undo` | `string` | yes | The question whose decision to withdraw. |
| `[3].ifDecision` | `integer` | no |  |
| `[3].reason` | `string` | no |  |
| `[3].projectIdentity` | `string` | no | Only proceed if the project key still names this identity. |
| `[4].undo` | `array<object>` | yes |  |
| `[4].undo[].q` | `string` | yes | The question whose decision to withdraw. |
| `[4].undo[].ifDecision` | `integer` | yes |  |
| `[4].reason` | `string` | no |  |
| `[4].projectIdentity` | `string` | no | Only proceed if the project key still names this identity. |

</details>

### handoff

Hand a failure question to the coding agent this instance is configured to start, with its evidence.

|  |  |
| --- | --- |
| HTTP | `POST /api/p/<project>/handoff` |
| Command | `mainworthy handoff` |
| Needs | `answer` |
| Effect | writes |
| Agent tool | no |

<details>
<summary>Input of <code>handoff</code></summary>

| Property | Type | Required | Description |
| --- | --- | --- | --- |
| `question` | `string` | yes | The failure question, `Q-70` or `70`. |
| `projectIdentity` | `string` | no | Only proceed if the project key still names this identity. |

</details>

### inbox

The queue: every question that needs an answer, most blocking first. With state=decided: the ledger.

|  |  |
| --- | --- |
| HTTP | `POST /api/p/<project>/inbox` |
| Command | `mainworthy inbox` |
| Needs | `read` |
| Effect | reads |
| Agent tool | yes |

<details>
<summary>Input of <code>inbox</code></summary>

| Property | Type | Required | Description |
| --- | --- | --- | --- |
| `state` | `"open" \| "decided"` | no |  Default: `"open"`. |
| `kind` | `"adopt" \| "map" \| "failure" \| "finding" \| "signoff"` | no |  |
| `on` | `string` | no | Only questions about this case, run, test or change. |
| `limit` | `integer` | no |  |
| `cursor` | `string` | no | The cursor from the previous page. |

</details>

### get

Read cases, questions, runs, tests, results or proposals by ref.

|  |  |
| --- | --- |
| HTTP | `POST /api/p/<project>/get` |
| Command | `mainworthy get` |
| Needs | `read` |
| Effect | reads |
| Agent tool | yes |

<details>
<summary>Input of <code>get</code></summary>

| Property | Type | Required | Description |
| --- | --- | --- | --- |
| `projectIdentity` | `string` | no | Only proceed if the project key still names this identity. |
| `repo` | `string` | no | For commit refs: disambiguate repositories. |
| `cursor` | `string` | no | For one proposal: the cursor from its previous page of edits. Restart without it after a project change. |
| `refs` | `array<string>` | yes | C-, Q-, R-, T-, P-, result:id, commit:hash or change:key. |
| `fields` | `array<string>` | no | For cases: any of title, pre, steps, methods, fields, tags, covers, place, proof. Default: all. |
| `as` | `"data" \| "md"` | no | `md` returns a case as canonical Markdown: fewer tokens than JSON. Default: `"data"`. |
| `unless` | `record<string>` | no | Ref to the etag from get for the same as/fields. Unchanged: {ref, unchanged: true, etag}. |
| `version` | `integer` | no | For one case: this version instead of the current one. |

</details>

### find

Search and list: cases (by text, folder, tag), tests, runs, slots of a run, folders, requirements, changes.

|  |  |
| --- | --- |
| HTTP | `POST /api/p/<project>/find` |
| Command | `mainworthy find` |
| Needs | `read` |
| Effect | reads |
| Agent tool | yes |

<details>
<summary>Input of <code>find</code></summary>

| Property | Type | Required | Description |
| --- | --- | --- | --- |
| `receipt` | `integer` | no | For receipt-results: merge receipt id. |
| `in` | `"cases" \| "tests" \| "runs" \| "folders" \| "tags" \| "requirements" \| "slots" \| "changes" \| "receipt-results" \| "deployments" \| "results"` | no |  Default: `"cases"`. |
| `select` | `object` | no | For cases: preview a run selection instead of the listing filters. Excludes fragments. |
| `select.cases` | `array<string>` | no |  |
| `select.folders` | `array<integer \| string>` | no |  |
| `select.tags` | `array<string>` | no |  |
| `select.text` | `string` | no |  |
| `text` | `string` | no |  |
| `folder` | `integer \| string` | no |  |
| `deep` | `boolean` | no | With `folder`: include its subfolders. |
| `tags` | `array<string>` | no |  |
| `state` | `string` | no |  |
| `origin` | `"planned" \| "change"` | no | For runs: planned by hand, or one per reported commit. |
| `run` | `string` | no | For slots: the run. |
| `commit` | `string` | no | For results: the commit. |
| `change` | `string` | no | For results and runs: a change key (pr:482). |
| `repo` | `string` | no |  |
| `unlinked` | `boolean` | no | For tests: only those with no case. |
| `limit` | `integer` | no |  |
| `cursor` | `string` | no | The cursor from the previous page. |

</details>

### impact

The cases a change touches and why, with what was already reviewed or decided. Where to look, instead of the whole suite.

|  |  |
| --- | --- |
| HTTP | `POST /api/p/<project>/impact` |
| Command | `mainworthy impact` |
| Needs | `read` |
| Effect | reads |
| Agent tool | yes |

<details>
<summary>Input of <code>impact</code></summary>

| Property | Type | Required | Description |
| --- | --- | --- | --- |
| `change` | `string` | no | A change key, for example pr:482. |
| `files` | `array<string>` | no | Changed paths, when the change is not known to Mainworthy. |
| `since` | `string` | no | A cursor from an earlier call: only what moved since. |
| `cursor` | `string` | no | The previous impact next value. Keep the same inputs; restart after a project change. |
| `ledger` | `boolean` | no | False for fresh eyes: do not hide what was already reviewed. Default: `true`. |

</details>

### since

What changed since a cursor: cases with what changed in each, and questions that were settled.

|  |  |
| --- | --- |
| HTTP | `POST /api/p/<project>/since` |
| Command | `mainworthy since` |
| Needs | `read` |
| Effect | reads |
| Agent tool | yes |

<details>
<summary>Input of <code>since</code></summary>

| Property | Type | Required | Description |
| --- | --- | --- | --- |
| `cursor` | `string` | yes | A cursor from any earlier read. |
| `limit` | `integer` | no |  |

</details>

### gate

The verdict for a commit, a change or a run: passed, failed (needs a fix), blocked (needs a decision), pending (needs evidence).

|  |  |
| --- | --- |
| HTTP | `POST /api/p/<project>/gate` |
| Command | `mainworthy gate` |
| Needs | `read` or `record` |
| Effect | reads |
| Agent tool | no |

<details>
<summary>Input of <code>gate</code></summary>

| Property | Type | Required | Description |
| --- | --- | --- | --- |
| `commit` | `string` | no |  |
| `run` | `string` | no |  |
| `change` | `string` | no | A change key, for example pr:482: the gate of its latest commit. |
| `repo` | `string` | no |  |

</details>

### history

The versions of a case, or the step-level diff between two of them.

|  |  |
| --- | --- |
| HTTP | `POST /api/p/<project>/history` |
| Command | `mainworthy history` |
| Needs | `read` |
| Effect | reads |
| Agent tool | no |

<details>
<summary>Input of <code>history</code></summary>

| Property | Type | Required | Description |
| --- | --- | --- | --- |
| `ref` | `string` | yes | The case. |
| `from` | `integer` | no |  |
| `to` | `integer` | no | With `from`: the step-level diff between the two versions. |

</details>

### timeline

One timeline for a case: versions, moves, results from every producer, findings, reviews and its questions.

|  |  |
| --- | --- |
| HTTP | `POST /api/p/<project>/timeline` |
| Command | `mainworthy timeline` |
| Needs | `read` |
| Effect | reads |
| Agent tool | no |

<details>
<summary>Input of <code>timeline</code></summary>

| Property | Type | Required | Description |
| --- | --- | --- | --- |
| `ref` | `string` | yes | The case. |
| `limit` | `integer` | no |  |

</details>

### check

Check the suite for structural problems: cases with no steps or no expected result, duplicate titles, dangling links.

|  |  |
| --- | --- |
| HTTP | `POST /api/p/<project>/check` |
| Command | `mainworthy check` |
| Needs | `read` |
| Effect | reads |
| Agent tool | no |

<details>
<summary>Input of <code>check</code></summary>

| Property | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | `integer` | no |  |

</details>

### stats

Reports over the last days: pass rate per day, flaky tests, time lost to reruns, automation and its backlog, coverage by requirement.

|  |  |
| --- | --- |
| HTTP | `POST /api/p/<project>/stats` |
| Command | `mainworthy stats` |
| Needs | `read` |
| Effect | reads |
| Agent tool | no |

<details>
<summary>Input of <code>stats</code></summary>

| Property | Type | Required | Description |
| --- | --- | --- | --- |
| `[1].of` | `"pass-rate"` | yes | Per day: the results that passed, failed, were skipped or blocked. |
| `[1].days` | `integer` | no | How many days to read, today included: 1 to 90. Default: `30`. |
| `[1].zone` | `string` | no | Whose days: a time zone such as Europe/Berlin. Default: `"UTC"`. |
| `[1].method` | `"human" \| "auto" \| "agent"` | no | Only one producer's results: human, auto or agent. |
| `[2].of` | `"flaky"` | yes | The tests that passed and failed on the same code, most often first. |
| `[2].days` | `integer` | no | How many days to read, today included: 1 to 90. Default: `30`. |
| `[2].limit` | `integer` | no | How many rows to list. Default: `20`. |
| `[2].cursor` | `integer` | no | The cursor from the previous page, or 0 for the first page. Default: `0`. |
| `[3].of` | `"reruns"` | yes | Repeated pipeline attempts and earlier runner tries, with their time counted once. |
| `[3].days` | `integer` | no | How many days to read, today included: 1 to 90. Default: `30`. |
| `[3].limit` | `integer` | no | How many rows to list. Default: `20`. |
| `[3].cursor` | `integer` | no | The cursor from the previous page, or 0 for the first page. Default: `0`. |
| `[4].of` | `"automation"` | yes | How many cases have an automated test, and which to automate next. |
| `[4].days` | `integer` | no | How many days to read, today included: 1 to 90. Default: `30`. |
| `[4].limit` | `integer` | no | How many rows to list. Default: `20`. |
| `[4].cursor` | `integer` | no | The cursor from the previous page, or 0 for the first page. Default: `0`. |
| `[5].of` | `"coverage"` | yes | Each requirement's cases, by the latest result of their tests. |
| `[5].days` | `integer` | no | How many days to read, today included: 1 to 90. Default: `30`. |
| `[5].limit` | `integer` | no | How many requirements to list. Default: `100`. |
| `[5].cursor` | `integer` | no | The cursor from the previous page, or 0 for the first page. Default: `0`. |

</details>

### command

What became of a command you sent under an idempotency key: not recorded, begun, or done with its reply.

|  |  |
| --- | --- |
| HTTP | `POST /api/p/<project>/command` |
| Command | `mainworthy command` |
| Needs | `read` |
| Effect | reads |
| Agent tool | no |

### tracker-status

Read a tracker request's delivery state and its verified issue reference.

|  |  |
| --- | --- |
| HTTP | `POST /api/p/<project>/tracker-status` |
| Command | `mainworthy tracker-status` |
| Needs | `read` |
| Effect | reads |
| Agent tool | no |

<details>
<summary>Input of <code>tracker-status</code></summary>

| Property | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `string` | yes |  |

</details>

### handoff-status

Read whether a failure question's latest hand-off to an agent was sent, or why it failed.

|  |  |
| --- | --- |
| HTTP | `POST /api/p/<project>/handoff-status` |
| Command | `mainworthy handoff-status` |
| Needs | `read` |
| Effect | reads |
| Agent tool | no |

<details>
<summary>Input of <code>handoff-status</code></summary>

| Property | Type | Required | Description |
| --- | --- | --- | --- |
| `question` | `string` | yes | The failure question, `Q-70` or `70`. |

</details>

### audit

Export a project's retained decisions, answers, policy changes and case versions as a verifiable audit file.

|  |  |
| --- | --- |
| HTTP | `POST /api/p/<project>/audit` |
| Command | `mainworthy audit` |
| Needs | `admin` |
| Effect | reads |
| Agent tool | no |

<details>
<summary>Input of <code>audit</code></summary>

| Property | Type | Required | Description |
| --- | --- | --- | --- |
| `from` | `integer` | no |  Default: `0`. |
| `to` | `integer` | no |  |
| `receipt` | `integer` | no |  |
| `cursor` | `string` | no |  |
| `limit` | `integer` | no |  |

</details>

### admin

Projects, actors, teams, grants and tokens. There are no seats: an actor is free, and a token carries what its actor may do. Creating a token from a browser requires recent credential proof.

|  |  |
| --- | --- |
| HTTP | `POST /api/admin` |
| Command | `mainworthy admin` |
| Needs | `admin` |
| Effect | writes |
| Agent tool | no |

<details>
<summary>Input of <code>admin</code></summary>

| Property | Type | Required | Description |
| --- | --- | --- | --- |
| `[1].do` | `"team.create"` | yes |  |
| `[1].name` | `string` | yes |  |
| `[2].do` | `"team.list"` | yes |  |
| `[3].do` | `"team.member.add"` | yes |  |
| `[3].team` | `string` | yes |  |
| `[3].person` | `string` | yes |  |
| `[4].do` | `"team.member.remove"` | yes |  |
| `[4].team` | `string` | yes |  |
| `[4].person` | `string` | yes |  |
| `[5].do` | `"team.grant.set"` | yes |  |
| `[5].team` | `string` | yes |  |
| `[5].project` | `string` | no | The project key. Absent: every project. |
| `[5].can` | `array<"read" \| "record" \| "produce" \| "answer" \| "plan" \| "admin">` | yes |  |
| `[6].do` | `"team.grant.remove"` | yes |  |
| `[6].team` | `string` | yes |  |
| `[6].project` | `string` | no | The project key. Absent: every project. |
| `[7].do` | `"team.history"` | yes |  |
| `[7].team` | `string` | yes |  |
| `[8].do` | `"project.create"` | yes |  |
| `[8].key` | `string` | yes |  |
| `[8].name` | `string` | no |  |
| `[8].preset` | `string` | no |  |
| `[8].unlinked` | `"ask" \| "track" \| "create"` | no | What happens to a test with no case: ask, track or create. Absent: what the preset starts with. |
| `[9].do` | `"project.list"` | yes |  |
| `[10].do` | `"project.demo"` | yes |  |
| `[10].key` | `string` | yes | Makes the project a demo: a write to it may say when it happened. Only a project nothing was written to, and it is not undone. |
| `[11].do` | `"token.create"` | yes |  |
| `[11].actor` | `string` | yes |  |
| `[11].kind` | `"human" \| "agent" \| "ci"` | yes |  |
| `[11].can` | `array<"read" \| "record" \| "produce" \| "answer" \| "plan" \| "admin">` | no | What a new actor may do. Absent: a person everything, an agent read and produce, a pipeline record. Not for an actor that exists: use grant.set. Default: `[]`. |
| `[11].project` | `string` | no | Limit the grant to one project. Absent: every project. |
| `[11].label` | `string` | no |  |
| `[11].expires` | `string` | no | How long the token works from now: 90d, 12h, 2w. After that it is refused as a revoked one is. Absent: it has no end. |
| `[12].do` | `"token.list"` | yes |  |
| `[13].do` | `"token.revoke"` | yes |  |
| `[13].id` | `integer` | yes |  |
| `[14].do` | `"actor.list"` | yes |  |
| `[15].do` | `"grant.set"` | yes |  |
| `[15].actor` | `string` | yes |  |
| `[15].project` | `string` | no | The project the grant is for. Absent: every project. |
| `[15].can` | `array<"read" \| "record" \| "produce" \| "answer" \| "plan" \| "admin">` | yes | What the actor may do there from now on, in place of what it could. |
| `[15].roles` | `array<string>` | no | Named roles on this grant. Absent: keep its roles; []: clear them. |
| `[16].do` | `"grant.remove"` | yes |  |
| `[16].actor` | `string` | yes |  |
| `[16].project` | `string` | no | The project the grant is for. Absent: the grant on every project. |
| `[17].do` | `"actor.forget"` | yes |  |
| `[17].name` | `string` | yes | Removes who this actor was: a pseudonym replaces the name and its tokens stop working. History keeps what was done. |
| `[18].do` | `"policy.show"` | yes |  |
| `[18].project` | `string` | yes |  |

</details>

### session

Your browser sessions: list them, and end one. An admin who is a person lists and ends anyone's.

|  |  |
| --- | --- |
| HTTP | `POST /api/session` |
| Command | `mainworthy session` |
| Needs | no capability: any person or agent that is signed in, for what is their own |
| Effect | writes |
| Agent tool | no |

<details>
<summary>Input of <code>session</code></summary>

| Property | Type | Required | Description |
| --- | --- | --- | --- |
| `[1].do` | `"list"` | yes |  |
| `[1].actor` | `string` | no | Whose sessions. Absent: your own. Somebody else's is for an admin who is a person. |
| `[2].do` | `"end"` | yes |  |
| `[2].id` | `integer` | yes | The session, from the list. Your own, or anyone's for an admin who is a person. |

</details>

### credential

Your password, passkeys, authenticator, recovery email and CLI tokens: list, add or remove them. Only a person may call. Sign-in changes and personal token creation require recent credential proof in the caller's browser session. A password is set in the web UI. A personal token is shown once and expires after 30d by default.

|  |  |
| --- | --- |
| HTTP | `POST /api/credential` |
| Command | `mainworthy credential` |
| Needs | no capability: any person or agent that is signed in, for what is their own |
| Effect | writes |
| Agent tool | no |

<details>
<summary>Input of <code>credential</code></summary>

| Property | Type | Required | Description |
| --- | --- | --- | --- |
| `[1].do` | `"email.get"` | yes |  |
| `[1].actor` | `string` | no |  |
| `[2].do` | `"email.set"` | yes |  |
| `[2].actor` | `string` | no |  |
| `[2].email` | `string \| null` | yes |  |
| `[3].do` | `"list"` | yes |  |
| `[3].actor` | `string` | no | Whose. Absent: your own. Somebody else's is for an admin who is a person. |
| `[4].do` | `"passkey.begin"` | yes |  |
| `[5].do` | `"totp.begin"` | yes |  |
| `[6].do` | `"totp.confirm"` | yes |  |
| `[6].challenge` | `string` | yes |  |
| `[6].code` | `string` | yes |  |
| `[7].do` | `"passkey.add"` | yes |  |
| `[7].passkey` | `record<unknown>` | yes | What the browser returned for the options of passkey.begin: id, clientDataJSON, authenticatorData, publicKey, publicKeyAlgorithm, transports. |
| `[7].label` | `string` | yes | What you call this passkey: the device it is on. |
| `[8].do` | `"remove"` | yes |  |
| `[8].id` | `integer` | yes | The credential, from the list. The last one a person has is not removed. |
| `[9].do` | `"token.create"` | yes |  |
| `[9].label` | `string` | yes | What you use this token for. |
| `[9].expires` | `string` | no | Default: 30d. At most 365d. A password or passkey session creates your own token, shown once. Default: `"30d"`. |
| `[10].do` | `"token.list"` | yes |  |
| `[11].do` | `"token.revoke"` | yes |  |
| `[11].id` | `integer` | yes |  |

</details>

### invitation

Invite a person with a link: make one, list them, revoke one. Optionally send it by mail. The link is shown once. Issuing a recovery link from a browser needs the caller's recent credential proof; token and local recovery authority remain.

|  |  |
| --- | --- |
| HTTP | `POST /api/invitation` |
| Command | `mainworthy invitation` |
| Needs | `admin` |
| Effect | writes |
| Agent tool | no |

<details>
<summary>Input of <code>invitation</code></summary>

| Property | Type | Required | Description |
| --- | --- | --- | --- |
| `[1].do` | `"create"` | yes |  |
| `[1].email` | `string` | no | Send the link to this address when mail is enabled. |
| `[1].name` | `string` | yes | The person. A new name: an invitation to join. A person who exists: a recovery, which replaces every way they sign in once it is accepted. |
| `[1].can` | `array<"read" \| "record" \| "produce" \| "answer" \| "plan" \| "admin">` | no | What a new person may do. Absent: everything. Not for a person who exists: use grant.set. Default: `[]`. |
| `[1].project` | `string` | no | Limit the grant to one project. Absent: every project. |
| `[1].expires` | `string` | no | How long the link works: 12h, 3d, 2w. At most 30d. Default: `"3d"`. |
| `[2].do` | `"list"` | yes |  |
| `[3].do` | `"revoke"` | yes |  |
| `[3].id` | `integer` | yes |  |

</details>

<!-- /generated -->

## Agent tools

An agent that connects over MCP gets the tools below. Tool discovery omits some
API inputs, including attachments, quarantine edits, direct build targets, and
the CI declaration that no tests are required. Each tool has a compact output
schema for `{ result, seq }`, the result's top-level type, and its required fields.
The OpenAPI document describes nested fields and alternative replies in full.
The shipped skill reference describes most input fields. Tool schemas retain
guidance for commit reuse, question answers, and review filtering.
[Let an agent in](./agents.md) explains how to connect one.

<!-- generated:agent-tools -->

| Tool | What the agent is told it is for |
| --- | --- |
| `propose` | Propose cases at base: adopted=current, open=needs acceptance, conflict=resolve, rejected. |
| `report` | Report to target or run; tests by key or case. |
| `claim` | Review cases C-311@hash at about/patch; known reads prior findings. |
| `work` | Take next slot with run; renew with slot. Report or give-back releases. |
| `decide` | onEvidence=evidenceHash. decided, advised=person decides, forbidden, invalid, already, reopened, conflict=changed. undo requires ifDecision. |
| `inbox` | Open questions with evidenceHash; on filters. |
| `get` | Read refs including result:id; verdicts: commit:hash, change:key, R-n. unless=etag; cursor pages proposals. |
| `find` | Find cases/tests/runs/slots; cursor pages. |
| `impact` | Cases for change/files. Page next as cursor with the same inputs; only the final cursor becomes since. Restart after project writes. |
| `since` | Case changes and settled questions since cursor; repeat while more. |

<!-- /generated -->
