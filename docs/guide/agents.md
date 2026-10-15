# Let an agent in

Give an AI agent its own token, connect it over MCP, and know what its edits, findings, results and answers are worth. An agent reads the suite, reviews a change, records what it found, and leaves the decisions to people.

[Diagram: an agent's session, from token to a person's decision](../diagrams/agent-access.html)

## Make a token for the agent

Give the agent its own actor, so every record names it.

```
$ mainworthy token new --agent reviewer --can read,produce --project scratch
token for agent "reviewer" (read, record, produce)
<token>
Shown once. It will not be shown again.
```

`read` lets it read cases, questions and gates. `produce` lets it propose edits, record reviews and results, and send answers, and it includes `record`. Leave out `--can` and a new agent gets exactly these two. The agent does not hold `answer`, so under the policy its answer is advice or is refused. Add `answer` only where you want an agent's answer to count. [People, agents and pipelines](./access.md) covers grants and revoking.

> [!WARNING]
> In local mode, a client on the same machine that sends no token acts as the owner. An agent without its own token makes edits as a person, and the policy treats them that way. Always give the agent a token.

## Connect over MCP

MCP is the protocol most agent tools use to call a server's tools. Mainworthy supports protocol 2026-07-28 with the v2 TypeScript SDK, and keeps the 2025-11-25 client path. Mainworthy speaks it two ways.

Over standard input and output, run `mainworthy mcp`. It forwards each call to the running server, so the server must be up. Point it at the server with the same variables the other commands use, and give the agent's token:

```
MAINWORTHY_URL=http://127.0.0.1:7357
MAINWORTHY_TOKEN=<token>
MAINWORTHY_PROJECT=scratch
```

Most MCP clients take a command, its arguments and a set of environment variables, so the client's entry runs `mainworthy` with the argument `mcp` and these three variables. The exact file depends on the client.

Over HTTP, send MCP requests to `/mcp` on the server, for example `http://127.0.0.1:7357/mcp`, with the header `Authorization: Bearer <token>`. The endpoint takes `POST` only. Each request stands alone, with no session to open or close, and a body can be up to 4 MiB. Use the command line for a bigger report.

A 2026-07-28 client uses `server/discover` to learn the server's capabilities, without an initialization handshake. Its requests carry the protocol and client metadata in `_meta`. Over HTTP, a request must send `Mcp-Method` with its JSON-RPC method. Without it, the server returns HTTP 400 with error code `-32020`. The SDK sends this header, `MCP-Protocol-Version`, and `Mcp-Name` for a tool call. A 2025-11-25 client keeps its `initialize` handshake and the same tools and replies. Clients on 2025-06-18 or later receive output schemas and structured replies. A 2025-03-26 client receives text replies and tool definitions without output schemas.

Settings, Connect, shows the `/mcp` address of this instance.

If the instance has more than one project, name one. Every tool takes a `project` field, and the stdio form also reads `MAINWORTHY_PROJECT` and `--project`. With one project, the agent can leave it out.

## The tools and where to start

An agent gets ten tools. Six read.

- `impact` takes a change such as `pr:482`, or a list of changed files, and returns the cases it touches, why, what was already reviewed, open questions and files nothing covers.
- `inbox` lists the open questions with their evidence.
- `get` reads cases, questions, runs and tests by ref, and `find` searches.
- `since` returns what changed after a cursor.
- `gate` returns `passed`, `failed`, `blocked` or `pending` for a commit, change or run.

Four write. `propose` creates or changes cases, `claim` records a review and its findings, `report` records results, and `decide` answers a question.

Start with `impact`. It tells the agent which few cases matter, so it does not read the whole suite. Keep the returned cursor and pass it back as `since` on the next call. [API and agent tools](./api.md#agent-tools) lists every tool's inputs.

When recording a change review with `claim`, set `about` to its change key and `patch` to the exact commit you reviewed.
Copy that commit from `impact`'s `change.head` before reading the patch. Set `reviewed` to the case refs and hashes you read.
For example, send `about: "pr:482"`, `patch: "cccc0001"`, and `reviewed: ["C-1@<hash>"]`.
Keep the original `patch` value if another commit arrives while you are reviewing.

`impact` marks a case reviewed only when this caller reviewed the same case version, change key, and commit.
A different change starts unreviewed, even at the same commit. A new commit needs another review, even if the case text is unchanged.
Passing `since` still returns those affected cases when the change moves. With an unchanged change, it returns only cases that moved or are failing.
Reviews without `about` and `patch` remain recorded but cannot cover a change. A files-only impact request has no known head and cannot reuse reviews.
An unchanged basis preserves the review. Use `ledger: false` to request fresh eyes.

## Install the skill

A skill is a short guide that an agent loads when it needs it. Mainworthy ships one, a directory named `mainworthy`. It has a `SKILL.md` and a `references` folder with pages on writing cases, reviewing a change, reporting results and the tool inputs. It teaches the case model and the order of work: start with `impact`, read only the cases you need, record findings in one `claim`, report outcomes in one `report`, and answer a question on the evidence hash it read.

The instance serves the skill, as one archive of the `mainworthy` directory, at `/docs/skill/mainworthy.tar.gz`. Like the rest of the documentation it needs no token. One command unpacks it into the skills directory your agent reads. For Claude Code, use `~/.claude/skills` for every project, or `.claude/skills` inside one:

```
$ mkdir -p ~/.claude/skills
$ curl -fsS "$MAINWORTHY_URL/docs/skill/mainworthy.tar.gz" | tar -xz -C ~/.claude/skills
```

The skill matches the version of the instance that served it, so unpack it again after an upgrade. Other agents keep skills in a directory of their own: give `tar` that one. The same files are in the Mainworthy source tree, as `skill/mainworthy`.

## What agent work is worth

The policy sets the value of an agent's work. See [policy](./policy.md) for the presets.

An edit that an agent proposes follows the policy for edits. Under `loose` it takes effect at once, and under `standard` and `strict` the reply is `open` and a person decides. The agent that wrote an edit can always withdraw its own conflicting proposal.

A finding from a review is recorded and shown. A person accepts, rejects, defers or marks it a duplicate. In the web queue, accepting a finding that carries a suggestion turns the suggestion into a proposed edit, with the agent as its author, and that edit follows the policy again. A finding never changes a gate by itself.

A finding can suggest a step edit with `suggest: { step, action, expected }`, or a new case with
`suggest: { case: { title, folder, steps } }`. For a new case, `folder` is optional and each step is
an outline line, such as `Remove the coupon > Total shows $100.00`. The claim keeps this content
for acceptance. Through the API, use `decide` with `answer: { is: "accept", apply: true }` to turn
the suggestion into a proposal.

A result is recorded, shown and asked about, and it does not move a commit's gate. The next section explains why.

An answer from an agent is one of three things, and the reply to `decide` says which. `decided` means the answer counts. `advised` means it is recorded as advice and a person decides. `forbidden` means the policy refuses it. With the default grant, `read` and `produce`, an agent's failure answer is advised under `loose` and `standard` and forbidden under `strict`:

```
[{"q":"Q-19","status":"advised","needs":"one member who is not an agent","decision":null}]
```

An answer counts only if the clause lets agents answer and the agent holds `answer`. Under the presets that is rare. Today it covers a duplicate finding under `loose`, and an unlinked-test answer under `loose` and `standard` where the project asks about tests with no case. There is one exception: an agent may withdraw its own conflicting proposal without holding `answer`.

## Why an agent's report never moves a gate

A gate says a commit is worthy of `main`, and an agent's word is not enough for that. A commit that only an agent has reported has no gate. It reads `pending` with nothing counted:

```
$ mainworthy gate --commit 3333333333333333333333333333333333333333
mainworthy gate    pending: nothing a gate counts has been reported for this commit
```

The agent's failure still raises a question for a person, who can read the evidence and answer it. An agent's report also cannot name a branch or a pull request for a commit, and it cannot move a change's head. A pipeline's later pass does not close a failure that only an agent showed. That question stays open until a person answers it.

## Runs that ask for agents

An agent's result counts in one place, a planned run that asks for agents, on a case that admits them. Both are choices you make.

1. Open the case and, under "Can be exercised by", tick Agent. In Markdown this is `methods: [human, agent]`.
2. Plan the run with a requirement that names the agent method.

```
$ mainworthy plan --json '{"name":"Agent smoke","select":{"cases":["C-2"]},"require":[{"id":"exercise","kind":"exercise","methods":["human","agent"],"minActors":1,"basis":"exact-or-assumed"}]}'
{
  "run": "R-2",
  "slots": 1,
  "already": 0
}
```

The agent then reports to the run, with `run` set to `R-2`. Its pass fills the slot, and `mainworthy gate --run R-2` reads `passed`. The web planner does not offer this requirement yet, so use the command line or the API. A run that does not name the agent method ignores agent results, even on a case that admits agents.

## See also

- [Policy](./policy.md) for who answers each question.
- [People, agents and pipelines](./access.md) for tokens and grants.
- [Planned runs](./runs.md) for planned runs.
