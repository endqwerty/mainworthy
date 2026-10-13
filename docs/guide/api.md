# API and agent tools

Every operation Mainworthy has, with its address, the capability it needs and its input. The web UI, the command line and an agent's tools all call these same operations, so anything you can do in one you can do in the others.

## Call an operation

An operation is one `POST` with a JSON body. An operation on a project is at `/api/p/<project>/<operation>`. The one operation on the instance, `admin`, is at `/api/admin`.

```
$ curl -s -X POST http://127.0.0.1:7357/api/p/scratch/find \
    -H 'content-type: application/json' \
    -d '{"in":"cases","limit":2}'
{"ok":true,"result":{"count":0,"items":[],"cursor":null},"seq":1}
```

A reply that ran has `ok: true`, the `result`, and `seq`, the project's sequence number at that point. Pass `seq` back to `since` to ask what changed after it.

A reply that did not run has `ok: false` and an `error` with a `code` and a `message`:

```
{"ok":false,"error":{"code":"not_found","message":"no operation named nope"}}
```

| Code | HTTP status | Meaning |
| --- | --- | --- |
| `invalid` | 400 | The input is wrong. `details` says which field. |
| `unauthenticated` | 401 | No token, or one the server does not know. |
| `forbidden` | 403 | The caller lacks the capability, or the policy says no. |
| `not_found` | 404 | No such operation, project or ref. |
| `conflict` | 409 | The edit was made on an older version, or the command id was used for something else. |
| `internal` | 500 | The server failed. Nothing was written. |

## Authenticate

Send a token as `Authorization: Bearer <token>`. A server in local mode trusts requests from the same machine and needs none. [People, agents and pipelines](./access.md) explains how to make a token and what it may do.

## Send a write twice safely

A write takes `cmd`, an id you choose for that one request. Sent again unchanged, the server returns the first reply and writes nothing. Sent again with other content, it is refused with `conflict`. If you lost the reply, ask the `command` operation what became of the id.

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
| `edits[][policy].clauses[].when` | `array<"always" \| "author:human" \| "author:agent" \| "author:ci" \| "conflict" \| "policy" \| "scope:change" \| "scope:trunk" \| "scope:run" \| "hint:disputed" \| "category:defect" \| "verdict:passed" \| string>` | yes |  |
| `edits[][policy].clauses[].ask` | `object` | yes |  |
| `edits[][policy].clauses[].ask.who` | `"rule" \| "member" \| "admin" \| "author"` | yes |  |
| `edits[][policy].clauses[].ask.agents` | `"answer" \| "advise" \| "none"` | yes |  |
| `edits[][policy].clauses[].ask.notProducer` | `boolean` | yes |  |
| `edits[][policy].clauses[].ask.reason` | `"optional" \| "required"` | yes |  |
| `edits[][policy].clauses[].answer` | `unknown` | no |  |
| `edits[][policy].clauses[].blocks` | `"nothing" \| "change" \| "release" \| "all"` | yes |  |
| `edits[][policy].settings` | `object` | no |  |
| `edits[][policy].settings.basis` | `"exact" \| "exact-or-assumed"` | yes |  |
| `edits[][policy].settings.holds` | `object` | yes |  |
| `edits[][policy].settings.holds.flakyDays` | `integer` | yes |  |
| `edits[][policy].settings.holds.infraThisTargetOnly` | `boolean` | yes |  |
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
| `reviewed` | `array<string>` | no | Cases read, each as C-311@<hash>. Recorded even with no findings. |
| `findings` | `array<object>` | no |  Default: `[]`. |
| `findings[].on` | `string` | yes | Where: a case (C-311), a step (C-311#b7), a requirement (req:WEB-290) or a change (pr:482). |
| `findings[].category` | `"cannot-fail" \| "ambiguous" \| "missing-expected" \| "uncovered-path" \| "duplicate" \| "outdated" \| "defect" \| "other"` | yes |  |
| `findings[].note` | `string` | yes |  |
| `findings[].repro` | `string` | no |  |
| `findings[].suggest` | `object` | no |  |
| `findings[].suggest[1].step` | `string` | no |  |
| `findings[].suggest[1].action` | `string` | no |  |
| `findings[].suggest[1].expected` | `string` | no |  |
| `findings[].suggest[2].case` | `object` | yes |  |
| `findings[].suggest[2].case.title` | `string` | yes |  |
| `findings[].suggest[2].case.folder` | `string` | no |  |
| `findings[].suggest[2].case.steps` | `array<string>` | yes |  |

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
| `[2].do` | `"project.list"` | yes |  |
| `[3].do` | `"token.create"` | yes |  |
| `[3].actor` | `string` | yes |  |
| `[3].kind` | `"human" \| "agent" \| "ci"` | yes |  |
| `[3].can` | `array<"read" \| "record" \| "produce" \| "answer" \| "plan" \| "admin">` | no | What a new actor may do. Absent: a person everything, an agent read and produce, a pipeline record. Not for an actor that exists: use grant.set. Default: `[]`. |
| `[3].project` | `string` | no | Limit the grant to one project. Absent: every project. |
| `[3].label` | `string` | no |  |
| `[4].do` | `"token.list"` | yes |  |
| `[5].do` | `"token.revoke"` | yes |  |
| `[5].id` | `integer` | yes |  |
| `[6].do` | `"actor.list"` | yes |  |
| `[7].do` | `"grant.set"` | yes |  |
| `[7].actor` | `string` | yes |  |
| `[7].project` | `string` | no | The project the grant is for. Absent: every project. |
| `[7].can` | `array<"read" \| "record" \| "produce" \| "answer" \| "plan" \| "admin">` | yes | What the actor may do there from now on, in place of what it could. |
| `[8].do` | `"grant.remove"` | yes |  |
| `[8].actor` | `string` | yes |  |
| `[8].project` | `string` | no | The project the grant is for. Absent: the grant on every project. |
| `[9].do` | `"actor.forget"` | yes |  |
| `[9].name` | `string` | yes | Removes who this actor was: a pseudonym replaces the name and its tokens stop working. History keeps what was done. |
| `[10].do` | `"policy.show"` | yes |  |
| `[10].project` | `string` | yes |  |

</details>

<!-- /generated -->

## Agent tools

An agent that connects over MCP gets these operations as tools, with the same inputs. [Let an agent in](./agents.md) explains how to connect one.

<!-- generated:agent-tools -->

| Tool | What the agent is told it is for |
| --- | --- |
| `propose` | Create or change test cases. Each edit of an existing case names the version it was made on (`base`). Reply: adopted (it is current), open (a person must accept it) or conflict. |
| `report` | Record test results in one batch. Give `target` (the commit tested) or `run` (a planned run). Each result names a test by `key` or a case by ref. Reply: counts, the questions raised per cause of failure, and the gate. |
| `claim` | Record a review: the cases you read (`reviewed`, as C-311@hash) and your findings. A finding already raised comes back under `known` with its answer, so you do not raise it twice. |
| `decide` | Answer a question from `inbox`. Pass the `evidenceHash` you saw as `onEvidence`. Reply status: decided, advised (recorded; a person decides), conflict (evidence changed) or forbidden. Failure answers: defect, test, expected, flaky, infra, and where the question's `answers` lists them, inherited and mistaken. |
| `inbox` | List open questions (failures, proposals, findings, unlinked tests) with their evidence and `evidenceHash`, counts first. `on` narrows to one case, run or change. |
| `get` | Read things by ref (C-, Q-, R-, T-, P-). For cases use `as: "md"` and `fields` to read less, and `unless: {ref: hash}` to skip what you already hold. |
| `find` | Search cases by text, folder or tag (rows carry ref, title, hash, proof), or list tests (`unlinked: true`), runs, or the slots of a run. Paged by `cursor`. |
| `impact` | Start here for a review. Given a change (`pr:482`) or changed `files`, returns the cases it touches, why, their hashes, what you already reviewed, open questions and uncovered files. Pass the returned `cursor` as `since` next time. |
| `since` | What changed since an earlier `cursor`: changed cases (one-line diff, no bodies) and settled questions. If `more`, call again with the new cursor. |
| `gate` | Is this commit, change or run tested? Returns passed, failed, blocked or pending with the reason and the open questions. |

<!-- /generated -->
