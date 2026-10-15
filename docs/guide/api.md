# API and agent tools

Every operation Mainworthy has, with its address, the capability it needs and its input. The web UI, the command line and an agent's tools all call these same operations. The command line and the HTTP API reach every operation. An agent's tools are ten of them.

## Call an operation

An operation is one `POST` with a JSON body. An operation on a project is at `/api/p/<project>/<operation>`. An operation on the instance (`admin`, `session`, `credential` and `invitation`) is at `/api/<operation>`, and only there: under a project's address it is answered `not_found`, with the address to use.

```
$ curl -s -X POST http://127.0.0.1:7357/api/p/scratch/find \
    -H 'content-type: application/json' \
    -d '{"in":"cases","limit":2}'
{"ok":true,"result":{"count":0,"items":[],"cursor":null},"seq":1}
```

The OpenAPI document at `/api/openapi.json` describes each operation's input and successful reply, including the fields inside `result`. The registry supplies both schemas. `seq` is required and is `null` for an instance operation. A field declared nullable may hold `null`; an optional field may be absent. Replies selected by an action or a ref are described as alternatives.

A reply that ran has `ok: true`, the `result`, and `seq`, the project's sequence number at that point. Pass `seq` back to `since` to ask what changed after it.

A reply that did not run has `ok: false` and an `error` with a `code` and a `message`:

```
{"ok":false,"error":{"code":"not_found","message":"no operation named nope"}}
```

| Code | HTTP status | Meaning |
| --- | --- | --- |
| `invalid` | 400 | The input is wrong. `details` says which field. |
| `unauthenticated` | 401 | No token, or one the server does not know. A name, a password, a passkey's answer or an invitation code that was looked at and refused, whatever was wrong with it. |
| `forbidden` | 403 | The caller holds a grant on the project and lacks the capability, or the policy says no. |
| `not_found` | 404 | No such operation, project or ref. A project the caller holds no grant on is answered the same way. |
| `conflict` | 409 | The edit was made on an older version, the command id was used for something else, or the client's API version differs from the server's. |
| `limited` | 429 | Too many failed attempts: wrong tokens from this address or for a token that starts as this one does, wrong passwords from this address or for this name, or refused passkeys or invitation codes from this address. The `Retry-After` header says how many seconds to wait. |
| `internal` | 500 | The server failed. Nothing was written. The message is `internal error`, and the detail is in the server's log. |

## Authenticate

Send a token as `Authorization: Bearer <token>`. A server in local mode trusts requests from the same machine and needs none. [People, agents and pipelines](./access.md) explains how to make a token and what it may do.

## Sign in as a person

A browser signs in with these requests and then holds a session cookie. They are not operations: nobody is signed in yet, and a password never passes through an operation. Each `POST` refuses a request that a browser makes from another site's page and accepts one that names no site (a script, `curl`); `GET /api/login/methods` answers anybody. Each takes JSON and answers with the same envelope as an operation, without `seq`. [People, agents and pipelines](./access.md#sign-in-as-yourself) says what they are for.

| Request | Body | What it does |
| --- | --- | --- |
| `GET /api/login/methods` | none | `{"password": true, "passkey": <boolean>}`: whether this instance has passkeys. |
| `POST /api/login` | `{"token"}` | Signs in with a token. |
| `POST /api/login` | `{"name", "password"}` | Signs in with a name and a password. |
| `POST /api/login/challenge` | `{}` | The options for `navigator.credentials.get`, with a challenge that is good once, for five minutes. The reply also sets a cookie (`mainworthy_ceremony`, `HttpOnly`) that ties the challenge to the browser that asked: the answer is taken only with it. A browser sends it by itself; a script has to keep it. |
| `POST /api/login` | `{"passkey"}` | Signs in with what the browser returned for those options: `id`, `clientDataJSON`, `authenticatorData`, `signature`, `userHandle`, each base64url. |
| `POST /api/login/challenge` | `{"invitation"}` | Who the invitation is for, what it does (`join` or `recover`) and when it runs out, with the options for `navigator.credentials.create`, or `null` for them on an instance without passkeys. It writes no row. On an instance with passkeys, each lookup that finds the invitation makes a challenge the server keeps in memory for five minutes. A code that accepts nothing is answered `not_found`. |
| `POST /api/login` | `{"invitation", "password"?, "passkey"?, "label"?, "replace"?}` | Accepts an invitation with a password, a passkey or both, and signs in. `passkey` is what the browser returned for the options above: `id`, `clientDataJSON`, `authenticatorData`, `publicKey`, `publicKeyAlgorithm`, `transports`. In a browser that is signed in as somebody else it is refused with `conflict`, with that person's name in `details.signedInAs`, until `replace` is that name (`"replace": "robin"`): the page asks about them first, and their session in this browser ends when the invitation is accepted. A name that is not the person the browser is signed in as now is refused the same way, with the name it would have had to be. `replace` that is not a name (`true`) is refused with `invalid`. |
| `POST /api/account/password` | `{"current"?, "next"}` | Sets or changes the password of the person whose browser session sends it. `current` is required when they have one. |
| `POST /api/logout` | none | Ends the browser's session and clears its cookie. |

A body holds one of these shapes and nothing beside it. `GET /api/session` says who is signed in, which session the request came by (`session`), whether the caller owns the instance (`owner`) and, for a person, what they sign in with (`credentials`: whether they have a password, and how many passkeys).

A signed-in person registers a further passkey with the `credential` operation: `passkey.begin` answers the options for `navigator.credentials.create`, and `passkey.add` takes what the browser returned and a label. Both are for a browser that is signed in, and the session that begins a registration is the one that finishes it. A token is refused with `forbidden`, as it is when it tries to set a password.

The same operation manages personal CLI tokens with `token.create`, `token.list`, and `token.revoke`. Creation requires a password or passkey session, or local-owner access, binds the caller as the token actor, and returns the secret once. It defaults to a 30-day expiry, with a 365-day maximum. A bearer token or a token-backed browser session cannot create one. [Make your own command-line token](./access.md#make-your-own-command-line-token) gives the inputs, replies, and CLI setup.

## Send a write twice safely

A write takes `cmd`, an id you choose for that one request. Sent again unchanged, the server returns the first reply and writes nothing. Sent again with other content, it is refused with `conflict`. If you lost the reply, ask the `command` operation what became of the id.

## Say when a write happened

Every write is recorded with the server's clock. A caller cannot give another time, with one exception: a demo project. `mainworthy seed` uses it to write the days before today.

`admin` with `{"do": "project.demo", "key": "<project>"}` makes a project a demo. It works only on a project nothing was written to since it was made, and it cannot be undone. The reply holds `key` and `since`, the moment the project became a demo. Both fields are required by the API reply schema. Asked again, it returns the same moment. `project.list` and the session name each project with `demo: true` or `false`, so a client can tell whose dates it is reading.

A write to a demo project may carry the header `X-Mainworthy-At` with a time in milliseconds since 1970. The server records the write at that time. It refuses a time in the future, a value that is not a whole number, the header on a read or on an operation of the instance, and the header on any project that is not a demo. The time is part of what `cmd` names: the same request at another time is another request.

Nothing checks that the times of a demo's writes are in order. Send them oldest first. Avoid the answer `flaky` in the past: it holds for a number of days from the time it was given, and one that has already run out reopens its question within a minute.

An archive does not say which project is a demo. After an import every project records the server's clock.

## The machine-readable description

`GET /api/openapi.json` returns an OpenAPI 3.1 document of every operation. The server builds it from the same list as this page on each call. It needs no token.

## Follow changes

`GET /api/p/<project>/events` is a stream of server-sent events, one for each write to the project. It needs the `read` capability. A client that misses an event loses nothing: it reads again, or asks `since`.

## Operations

<!-- generated:operations -->

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
| `edits[][create].op` | `"create"` | yes |  |
| `edits[][create].body` | `object` | no |  |
| `edits[][create].body.title` | `string` | no |  |
| `edits[][create].body.pre` | `string` | no |  |
| `edits[][create].body.steps` | `array<object>` | no |  |
| `edits[][create].body.steps[].id` | `string` | yes |  |
| `edits[][create].body.steps[].action` | `string` | yes |  |
| `edits[][create].body.steps[].expected` | `string \| null` | yes |  |
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
| `edits[][edit].body.steps[].id` | `string` | yes |  |
| `edits[][edit].body.steps[].action` | `string` | yes |  |
| `edits[][edit].body.steps[].expected` | `string \| null` | yes |  |
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
| `edits[][policy].preset` | `string` | no |  |
| `edits[][policy].clauses` | `array<object>` | no |  |
| `edits[][policy].clauses[].id` | `string` | yes |  |
| `edits[][policy].clauses[].kind` | `"adopt" \| "map" \| "failure" \| "finding" \| "signoff"` | yes |  |
| `edits[][policy].clauses[].when` | `array<"always" \| "author:human" \| "author:agent" \| "author:ci" \| "conflict" \| "policy" \| "scope:change" \| "scope:trunk" \| "scope:run" \| "hint:disputed" \| "category:defect" \| "verdict:passed" \| "unlinked:track" \| "unlinked:create" \| string>` | yes |  |
| `edits[][policy].clauses[].ask` | `object` | yes |  |
| `edits[][policy].clauses[].ask.who` | `"rule" \| "member" \| "admin" \| "author"` | yes |  |
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
| `target[1].commit` | `string` | yes |  |
| `target[1].repo` | `string` | no |  |
| `target[1].branch` | `string` | no |  |
| `target[1].env` | `string` | no |  |
| `target[1].pr` | `integer` | no |  |
| `target[1].base` | `string` | no | The commit this change is based on. |
| `target[1].title` | `string` | no |  |
| `target[1].url` | `string` | no |  |
| `target[1].files` | `array<string>` | no | Paths the change touches, for impact. |
| `target[2].session` | `string` | yes |  |
| `run` | `string` | no | A planned run these results are for, for example R-4. |
| `job` | `string` | no |  |
| `attempt` | `integer` | no |  |
| `buildUrl` | `string` | no |  |
| `results` | `array<object>` | yes |  |
| `results[].test` | `object` | yes |  |
| `results[].test[1].key` | `string` | yes |  |
| `results[].test[1].name` | `string` | no |  |
| `results[].test[1].file` | `string` | no |  |
| `results[].test[2].case` | `string` | yes | The case this manual or agent result is for. |
| `results[].outcome` | `"pass" \| "fail" \| "skip" \| "blocked" \| "error"` | yes |  |
| `results[].durationMs` | `integer` | no |  |
| `results[].failure` | `object` | no |  |
| `results[].failure.message` | `string` | yes |  |
| `results[].failure.detail` | `string` | no |  |
| `results[].failure.at` | `string` | no |  |
| `results[].steps` | `array<object>` | no |  |
| `results[].steps[].step` | `string` | yes |  |
| `results[].steps[].outcome` | `"pass" \| "fail" \| "skip" \| "blocked" \| "error"` | yes |  |
| `results[].note` | `string` | no |  |
| `results[].annotation` | `object` | no |  |
| `results[].annotation.case` | `string` | yes |  |
| `results[].annotation.version` | `integer` | no |  |
| `results[].corrects` | `integer` | no | The id of an earlier result of yours that this one replaces. |
| `nothingRequired` | `true` | no | CI-only empty declaration; requires policy permission. |

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

</details>

### change

Say that a change ended (merged, or closed without merging) or is open again. An ended change is not asked about.

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
| `state` | `"merged" \| "closed" \| "open"` | yes | How the change ended: merged, or closed without merging. open: it is open again. |
| `landing` | `object` | no | For merged: the exact commit that reached trunk and its branch. A matching head moves to trunk; its failures are judged there again. |
| `landing.commit` | `string` | yes |  |
| `landing.branch` | `"main" \| "master" \| "trunk"` | yes |  |

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
| `[2].do` | `"link"` | yes |  |
| `[2].result` | `integer` | yes |  |
| `[2].key` | `string` | yes |  |

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
| `accepts[1].commit` | `string` | yes |  |
| `accepts[1].repo` | `string` | no |  |
| `accepts[1].env` | `string` | no |  |
| `accepts[2].self` | `true` | yes |  |
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
| `[1].onEvidence` | `string` | yes | The evidence hash you saw. If the evidence changed since, the reply is a conflict with the new evidence. |
| `[1].answer` | `record<unknown>` | yes | The answer, for example {"is":"defect"}. The allowed answers depend on the question kind. |
| `[1].reason` | `string` | no |  |
| `[2].all` | `array<object>` | yes |  |
| `[2].all[].q` | `string` | yes | The question, for example Q-12. |
| `[2].all[].onEvidence` | `string` | yes | The evidence hash you saw. If the evidence changed since, the reply is a conflict with the new evidence. |
| `[2].all[].answer` | `record<unknown>` | yes | The answer, for example {"is":"defect"}. The allowed answers depend on the question kind. |
| `[2].all[].reason` | `string` | no |  |
| `[2].reason` | `string` | no |  |
| `[3].undo` | `string` | yes | The question whose decision to withdraw. |
| `[3].ifDecision` | `integer` | no |  |
| `[3].reason` | `string` | no |  |

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

Read cases, questions, runs, tests or proposals by ref.

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
| `refs` | `array<string>` | yes | Refs of cases (C-), questions (Q-), runs (R-), tests (T-) or proposals (P-). |
| `fields` | `array<string>` | no | For cases: any of title, pre, steps, methods, tags, covers, place, proof. Default: all. |
| `as` | `"data" \| "md"` | no | `md` returns a case as canonical Markdown: fewer tokens than JSON. Default: `"data"`. |
| `unless` | `record<string>` | no | Ref to the hash you already hold. An unchanged case comes back as {ref, unchanged: true}. |
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
| `in` | `"cases" \| "tests" \| "runs" \| "folders" \| "tags" \| "requirements" \| "slots" \| "changes"` | no |  Default: `"cases"`. |
| `text` | `string` | no |  |
| `folder` | `integer \| string` | no |  |
| `deep` | `boolean` | no | With `folder`: include its subfolders. |
| `tags` | `array<string>` | no |  |
| `state` | `string` | no |  |
| `run` | `string` | no | For slots: the run. |
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
| Agent tool | yes |

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

### admin

Projects, actors, grants and tokens. There are no seats: an actor is free, and a token carries what its actor may do.

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
| `[1].do` | `"project.create"` | yes |  |
| `[1].key` | `string` | yes |  |
| `[1].name` | `string` | no |  |
| `[1].preset` | `string` | no |  |
| `[1].unlinked` | `"ask" \| "track" \| "create"` | no | What happens to a test with no case: ask, track or create. Absent: what the preset starts with. |
| `[2].do` | `"project.list"` | yes |  |
| `[3].do` | `"project.demo"` | yes |  |
| `[3].key` | `string` | yes | Makes the project a demo: a write to it may say when it happened. Only a project nothing was written to, and it is not undone. |
| `[4].do` | `"token.create"` | yes |  |
| `[4].actor` | `string` | yes |  |
| `[4].kind` | `"human" \| "agent" \| "ci"` | yes |  |
| `[4].can` | `array<"read" \| "record" \| "produce" \| "answer" \| "plan" \| "admin">` | no | What a new actor may do. Absent: a person everything, an agent read and produce, a pipeline record. Not for an actor that exists: use grant.set. Default: `[]`. |
| `[4].project` | `string` | no | Limit the grant to one project. Absent: every project. |
| `[4].label` | `string` | no |  |
| `[4].expires` | `string` | no | How long the token works from now: 90d, 12h, 2w. After that it is refused as a revoked one is. Absent: it has no end. |
| `[5].do` | `"token.list"` | yes |  |
| `[6].do` | `"token.revoke"` | yes |  |
| `[6].id` | `integer` | yes |  |
| `[7].do` | `"actor.list"` | yes |  |
| `[8].do` | `"grant.set"` | yes |  |
| `[8].actor` | `string` | yes |  |
| `[8].project` | `string` | no | The project the grant is for. Absent: every project. |
| `[8].can` | `array<"read" \| "record" \| "produce" \| "answer" \| "plan" \| "admin">` | yes | What the actor may do there from now on, in place of what it could. |
| `[9].do` | `"grant.remove"` | yes |  |
| `[9].actor` | `string` | yes |  |
| `[9].project` | `string` | no | The project the grant is for. Absent: the grant on every project. |
| `[10].do` | `"actor.forget"` | yes |  |
| `[10].name` | `string` | yes | Removes who this actor was: a pseudonym replaces the name and its tokens stop working. History keeps what was done. |
| `[11].do` | `"policy.show"` | yes |  |
| `[11].project` | `string` | yes |  |

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

Your password, passkeys and CLI tokens: list, add or remove them. Only a person may call. A password is set in the web UI. A personal token is shown once and expires after 30d by default.

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
| `[1].do` | `"list"` | yes |  |
| `[1].actor` | `string` | no | Whose. Absent: your own. Somebody else's is for an admin who is a person. |
| `[2].do` | `"passkey.begin"` | yes |  |
| `[3].do` | `"passkey.add"` | yes |  |
| `[3].passkey` | `record<unknown>` | yes | What the browser returned for the options of passkey.begin: id, clientDataJSON, authenticatorData, publicKey, publicKeyAlgorithm, transports. |
| `[3].label` | `string` | yes | What you call this passkey: the device it is on. |
| `[4].do` | `"remove"` | yes |  |
| `[4].id` | `integer` | yes | The credential, from the list. The last one a person has is not removed. |
| `[5].do` | `"token.create"` | yes |  |
| `[5].label` | `string` | yes | What you use this token for. |
| `[5].expires` | `string` | no | Default: 30d. At most 365d. A password or passkey session creates your own token, shown once. Default: `"30d"`. |
| `[6].do` | `"token.list"` | yes |  |
| `[7].do` | `"token.revoke"` | yes |  |
| `[7].id` | `integer` | yes |  |

</details>

### invitation

Invite a person with a link, since there is no mail: make one, list them, revoke one. The link is shown once.

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

An agent that connects over MCP gets these operations as tools, with the same inputs. Each tool has a compact output schema for `{ result, seq }`, the result's top-level type and its required fields. Nested fields and alternative replies are described in full by the OpenAPI document. Most input-field descriptions are in the shipped skill reference; tool schemas retain guidance for commit reuse, question answers and review filtering. [Let an agent in](./agents.md) explains how to connect one.

<!-- generated:agent-tools -->

| Tool | What the agent is told it is for |
| --- | --- |
| `propose` | Propose cases at their base version. Status: adopted=current, open=needs acceptance, conflict=resolve, rejected. |
| `report` | Record test results in one batch. Give `target` (the commit tested) or `run` (a planned run). Each result names a test by `key` or a case by ref. |
| `claim` | Review cases (`reviewed`, C-311@hash) at change `about` and commit `patch`. Record findings; `known` returns prior findings and answers. |
| `decide` | Answer inbox using evidenceHash as onEvidence. Status: decided, advised=person decides, forbidden, invalid, already, reopened, conflict=evidence or decision changed. Choose from answers. Withdraw with undo and ifDecision=reply.decision. |
| `inbox` | Open questions and evidenceHash; filter with on. |
| `get` | Read refs. For cases: as, fields, unless. |
| `find` | Search cases by text, folder or tag; list tests (`unlinked: true`), runs or slots. Page with `cursor`. |
| `impact` | Start a review with a change (`pr:482`) or changed `files`. Returns affected cases, hashes, prior reviews, questions and uncovered files. Reuse `cursor` as `since`. |
| `since` | What changed since an earlier `cursor`: changed cases (one-line diff, no bodies) and settled questions. If `more`, call again with the new cursor. |
| `gate` | Is this commit, change or run tested? Returns passed, failed, blocked or pending with the reason and the open questions. |

<!-- /generated -->
