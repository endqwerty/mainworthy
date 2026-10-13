# People, agents and pipelines

Decide who may do what in each project, give a person, an agent or a pipeline a token, and take it away again. Making tokens and changing grants needs an instance admin, who holds `admin` on every project. Some of it only a person may do, and a token for a person who already exists is made by that person or by the owner.

## Kinds of actor

Everything in Mainworthy is done by an actor, and every record names the actor that made it. There are four kinds.

- A person. Someone who reads, writes and answers. The queue and the web UI are built for people.
- An agent. An AI tool that reviews changes, proposes edits and reports results. [Let an agent in](./agents.md) covers it.
- A pipeline. A CI job that reports results and reads the gate.
- The policy. A rule that answers a question on a project's behalf. It holds no grant and no token, and you do not create it.

An actor has a name, a kind and grants. There are no seats and no accounts, so an actor costs nothing, and a token proves who is calling. A name uses letters, digits, `.`, `_`, `@` and `-`, starts with a letter or digit, and runs up to 64 characters.

## Capabilities

A grant lists capabilities, and a capability is permission to call a group of operations.

<!-- generated:capabilities -->

| Capability | Operations it allows | Held by default by |
| --- | --- | --- |
| `read` | `inbox`, `get`, `find`, `impact`, `since`, `gate`, `history`, `timeline`, `check`, `command` | a person, an agent |
| `record` | `report`, `gate` | a person, a pipeline |
| `produce` | `propose`, `claim`, `decide` | a person, an agent |
| `answer` | none by itself; it makes an answer count where the policy asks a member | a person |
| `plan` | `plan` | a person |
| `admin` | `admin` | a person |

A pipeline holds `read` and `record` at most, whatever its grant lists.

<!-- /generated -->

`produce` includes `record`. To answer a question you need two things: `produce` to send the answer, and `answer` for the policy to count it. A new person gets all six, a new agent gets `read` and `produce`, and a new pipeline gets `record`. These defaults apply only when you make a token for a name that does not exist yet and give no `--can`.

## Grants

A grant says what an actor may do on one project, or on every project. A grant on every project shows as `*`. An actor can hold both, and the two add up.

```
$ mainworthy actor list
rule   policy  no grant
human  robin  *  read, record, produce, answer, plan, admin
agent  reviewer  scratch  read, record, produce, answer
ci     github-actions  scratch  read, record
```

Change a grant with `grant`. It replaces what the actor could do there, so list everything you want it to keep.

```
$ mainworthy actor grant reviewer --can read,produce --project checkout
reviewer on checkout: read, produce
$ mainworthy actor ungrant reviewer --project checkout
reviewer holds no grant on checkout any more
```

Leave out `--project` to change the grant on every project. Only a person changes a grant: an agent that holds `admin` is refused. You cannot change your own grant, because a slip could lock the instance. Another admin does it. Nobody changes the owner's grant, which Mainworthy writes again at every start.

The owner is the person named by `MAINWORTHY_OWNER`. See [configuration](./configuration.md).

## Make a token

A token is a secret that stands for one actor. An agent or a pipeline sends it with each request, and a person types it to sign in.

In Settings, open Tokens (<kbd>g</kbd> <kbd>,</kbd>, then <kbd>j</kbd> to move down). Press <kbd>n</kbd>, then fill in "Token actor", pick a "Producer" (Agent, Pipeline or Person), tick the "Permissions" and choose "Create token". The new secret appears once, with "Copy token" and "Dismiss secret". A token made here is limited to the project you are in.

From the command line:

```
$ mainworthy token new --agent reviewer --can read,produce
token for agent "reviewer" (read, record, produce)
<token>
Shown once. It will not be shown again.
```

Use `--human` for a person and `--ci` for a pipeline. Add `--project <key>` to limit the grant to one project. Without it the grant covers every project.

Mainworthy shows a token once and keeps only a hash, so it cannot show it again. If you lose one, revoke it and make another.

Who may make a token depends on whose it is. Anyone who administers makes a token for an agent or a pipeline. A person who administers adds a new person. A token for a person who already exists is made by that person or by the owner, and a token for the owner by the owner alone, because whoever holds a person's token acts under that person's name. A name that starts with `forgotten-` is refused.

Making a token for a name that exists adds a token to that actor and does not change its grants. Naming a different `--can` for an existing actor is refused. Use `actor grant` for that.

## See and revoke tokens

Settings, Tokens, lists "Issued tokens" with each token's actor, when it was made and when it was last used. "Revoke" next to a token stops it at once. In server mode the last token the owner can sign in with is not revoked: make the owner another one first.

```
$ mainworthy token list
1  agent reviewer  agent token  active
2  ci github-actions  ci token  active
$ mainworthy token revoke 2
token 2 revoked
```

A token never expires on its own, so revoke one you no longer use. Revoking a token leaves the actor and its grants in place. To stop an actor on one project, use `actor ungrant`. To remove who a person was, forget the actor. Only a person who administers forgets an actor, and the owner is not forgotten. The name becomes a pseudonym, the tokens stop working, and the history keeps what the actor did.

```
$ mainworthy admin --json '{"do":"actor.forget","name":"dana"}'
{"forgotten":"forgotten-5","tokensRevoked":0}
```

There is no shorter command for it. See [API](./api.md).

## Sign in to the web UI

In local mode you sign in as the owner, with no step. See [configuration](./configuration.md#local-mode-and-server-mode) for what local mode means.

In server mode the page asks "Sign in with your token". Paste a token and choose "Sign in". The server opens a session for that browser, and the browser keeps a cookie that names the session. The cookie is not the token: the browser does not hold the token after that.

A session ends after 14 days without use and after 90 days in any case. It also ends when the token you signed in with is revoked, and when your actor is forgotten. Each of these sends you back to the sign-in page. [Configuration](./configuration.md#variables-the-server-reads) says how to change the two lifetimes. The web UI has no sign-out button yet; `POST /api/logout` from the page's own origin ends the session.

The owner's token comes from the server. If you set `MAINWORTHY_OWNER_TOKEN`, that value is the token. If you did not, the server prints one on its first start:

```
Mainworthy 0.1.0 · server · data in /data · http://localhost:7357
project "scratch" · you are robin@this-machine · policy: loose
owner token (shown once): <token>
```

Copy it then. If you miss it, set `MAINWORTHY_OWNER_TOKEN` to a new value and restart, and that value becomes a token too. A value that was revoked, or that is somebody else's token, is not accepted: the server says so in one line when it starts and leaves the token as it is. With no value set, a start on which the owner holds no token that works prints a new one, as the first start does. In the container, `docker compose logs` has the line.

The command line needs no token in local mode on the same machine. In server mode, give it one with `--token` or `MAINWORTHY_TOKEN`.

## What a pipeline can never do

A pipeline can hold `read` and `record`, and nothing more, under every grant and every policy. It reports results and reads a commit's gate. It cannot answer a question, edit a case, plan a run or administer the instance. A grant for a pipeline that lists more is refused:

```
$ mainworthy actor grant github-actions --can produce --project scratch
invalid: a pipeline may hold read and record, not produce; give an agent or a person the rest
```

A pipeline with only `record` cannot read cases or the queue either. Add `read` if its job needs them. The token for a pipeline is in [report results](./report-results.md#give-a-pipeline-its-own-token).

## Where it is in Settings

- Policy shows who answers under the current policy. See [policy](./policy.md).
- Tokens makes, lists and revokes tokens. An admin sees the form, and anyone else sees "An admin creates and revokes tokens."
- Projects lists the projects you can reach and creates a new one.
- Connect shows the pipeline and agent connection lines, with the address of this instance.

Settings does not show grants. Use `mainworthy actor list` and `actor grant`.

## See also

- [Let an agent in](./agents.md) for an agent's token and what its work counts for.
- [Policy](./policy.md) for who answers each question.
- [Command line](./cli.md) for every `token` and `actor` flag.
