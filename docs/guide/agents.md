# Let an agent in

Give an AI agent its own token and connect it over MCP to read cases, review changes,
and report results. The project's policy decides whether its edits and answers count
or need a person's decision.

[Diagram: an agent's session, from token to a person's decision](../diagrams/agent-access.html)

## Make a token for the agent

Create a token with the agent's own actor, so every record names the agent.

```
$ mainworthy token new --agent reviewer --can read,produce --project scratch
token for agent "reviewer" (read, record, produce)
<token>
Shown once. It will not be shown again.
```

`read` lets the agent read cases, questions, and gates. `produce` lets the agent
propose edits, record reviews and results, and send answers. The `produce` capability
includes `record`. Without `--can`, a new agent gets `read` and `produce`. The
agent does not hold `answer`, so its answer is advice or the policy refuses the
answer. Add `answer` only where you want an agent's answer to count.
[People, agents and pipelines](./access.md) covers grants and revocation.

> [!WARNING]
> In local mode, a client on the same machine that sends no token acts as the owner. An agent without its own token makes edits as a person, and the policy treats them that way. Always give the agent a token.

## Connect over MCP

Mainworthy supports MCP protocol 2026-07-28 with the v2 TypeScript SDK, and
retains support for 2025-11-25 clients. Choose either standard input and output
or HTTP to connect the agent.

For standard input and output, configure the MCP client as follows. The server
must be running because `mainworthy mcp` forwards each call to the server.

1. Set the client's command to `mainworthy`.
2. Set its argument to `mcp`.
3. Set the server address, agent token, and project in the client's environment:

```
MAINWORTHY_URL=http://127.0.0.1:7357
MAINWORTHY_TOKEN=<token>
MAINWORTHY_PROJECT=scratch
```

The configuration file depends on the MCP client.

For HTTP, send MCP requests to the server's `/mcp` address, such as
`http://127.0.0.1:7357/mcp`. Include the header `Authorization: Bearer <token>`.
The endpoint accepts only `POST`. Each request stands alone, with no session to
open or close. A request body can be up to 4 MiB. For a bigger report, use the
command line.

A 2026-07-28 client uses `server/discover` to learn the server's capabilities, without an initialization handshake. Its requests carry the protocol and client metadata in `_meta`. Over HTTP, a request must send `Mcp-Method` with its JSON-RPC method. Without it, the server returns HTTP 400 with error code `-32020`. The SDK sends this header, `MCP-Protocol-Version`, and `Mcp-Name` for a tool call. A 2025-11-25 client keeps its `initialize` handshake and the same tools and replies. Clients on 2025-06-18 or later receive output schemas and structured replies. A 2025-03-26 client receives text replies and tool definitions without output schemas.

To find this instance's `/mcp` address, open Connect in Settings.

If the agent can access more than one project, name one. Every tool takes a
`project` field. The standard input and output connection also reads `MAINWORTHY_PROJECT`
and `--project`.
With exactly one accessible project, the agent can leave it out.

## The tools and where to start

An agent gets ten tools. The following six tools read data.

- `impact` takes a change such as `pr:482` or a list of changed files. It returns affected cases, the reasons they are affected, prior reviews, open questions, and uncovered files.
- `inbox` lists the open questions with their evidence.
- `get` reads cases, questions, runs and tests by ref, and `find` searches.
- `since` returns what changed after a cursor.
- `gate` returns `passed`, `failed`, `blocked` or `pending` for a commit, change or run.

The other four tools write data. `propose` creates or changes cases, `claim`
records a review and its findings, `report` records results, and `decide` answers
a question.

Start with `impact` to find the relevant cases without reading the whole suite.
Keep the returned cursor. On the next `impact` call, pass that cursor as `since`.
[API and agent tools](./api.md#agent-tools) lists every tool's inputs.

To record a change review, follow these steps.

1. Before reading the patch, copy the commit from `impact`'s `change.head`.
2. Set `claim`'s `about` to the change key.
3. Set `patch` to the copied commit.
4. Set `reviewed` to the case refs and hashes you read.
5. Send the `claim` request.

For example, send `about: "pr:482"`, `patch: "cccc0001"`, and `reviewed: ["C-1@<hash>"]`.
Keep the original `patch` value if another commit arrives while you are reviewing.

`impact` marks a case reviewed only when this caller reviewed the same case version, change key, and commit.
A different change starts unreviewed, even at the same commit. A new commit needs another review, even if the case text is unchanged.
Passing `since` still returns those affected cases when the change moves. With an unchanged change, it returns only cases that moved or are failing.
Reviews without `about` and `patch` remain recorded but cannot cover a change. A files-only impact request has no known head and cannot reuse reviews.
An unchanged basis preserves the review. To request a review without prior review
filtering, use `ledger: false`.

## Install the skill

A skill is a short guide that an agent loads when it needs it. Mainworthy ships
one in a directory named `mainworthy`. It has a `SKILL.md` and a `references`
folder with pages on writing cases, reviewing a change, reporting results, and
tool inputs. The skill describes the case model and the order of work. The agent
starts with `impact`, reads the cases it needs, records findings in one `claim`,
and reports outcomes in one `report`. It answers a question using the evidence
hash it read.

The instance serves an archive of the `mainworthy` skill directory at
`/docs/skill/mainworthy.tar.gz`. The archive needs no token.

To install the skill for Claude Code, follow these steps.

1. Choose `~/.claude/skills` for every project, or `.claude/skills` inside one project.
2. Create the skills directory.
3. Download the archive.
4. Unpack the archive into that directory.

For example, these commands install the skill for every project:

```
$ mkdir -p ~/.claude/skills
$ curl -fsS "$MAINWORTHY_URL/docs/skill/mainworthy.tar.gz" | tar -xz -C ~/.claude/skills
```

The skill matches the instance version. After an upgrade, unpack the skill again.
For other agents, use the skills directory that the agent reads as the `tar`
destination. The same files are in the Mainworthy source tree at `skill/mainworthy`.

## What agent work is worth

The policy sets the value of an agent's work. See [policy](./policy.md) for the presets.

An ordinary case edit that an agent proposes takes effect at once under `loose`.
Under `standard` and `strict`, the reply is `open` and a person decides.
Policy edits and [quarantine proposals](./report-results.md#quarantine-an-unreliable-test)
need a person's decision under every preset. The agent that wrote an edit can always
withdraw its own conflicting proposal.

Mainworthy records and shows findings from a review. A person accepts, rejects,
defers, or marks each finding as a duplicate. In the web queue, accepting a
finding with a suggestion turns the suggestion into a proposed edit. The agent
is the edit's author, and the policy applies to the edit. A finding never
changes a gate by itself.

A finding can suggest a step edit with `suggest: { step, action, expected }`, or a new case with
`suggest: { case: { title, folder, steps } }`. For a new case, `folder` is optional and each step is
an outline line, such as `Remove the coupon > Total shows $100.00`. The claim keeps this content
for acceptance. Through the API, use `decide` with `answer: { is: "accept", apply: true }` to turn
the suggestion into a proposal.

Mainworthy records and shows an agent's result. A failure can raise a question,
but the result does not move a commit's gate. The next section explains why.

The reply to `decide` gives the status of the agent's answer. `decided` means
the answer counts. `advised` means Mainworthy records the answer as advice and
a person decides. `forbidden` means the policy refuses the answer. With the
default grant of `read` and `produce`, an agent's failure answer is advised under
`loose` and `standard` and forbidden under `strict`:

```
[{"q":"Q-19","status":"advised","needs":"one member who is not an agent","decision":null}]
```

An answer counts only if the clause lets agents answer and the agent holds `answer`.
The presets allow agents to settle duplicate findings under `loose` and unlinked-test
questions under `loose` and `standard`. The latter applies only when the project asks
about tests with no case. An agent may also withdraw its own conflicting proposal
without holding `answer`.

## Why an agent's report never moves a gate

A commit gate counts results from people and pipelines. If only an agent has
reported a commit, its gate reads `pending` with nothing counted:

```
$ mainworthy gate --commit 3333333333333333333333333333333333333333
mainworthy gate    pending: nothing a gate counts has been reported for this commit
```

The agent's failure still raises a question for a person, who can read the evidence and answer it. An agent's report also cannot name a branch or a pull request for a commit, and it cannot move a change's head. A pipeline's later pass does not close a failure that only an agent showed. That question stays open until a person answers it.

## Runs that ask for agents

An agent's result counts in a planned run that asks for agents, on a case that
admits them. To enable agent results, follow these steps.

1. Open the case.
2. Under "Can be exercised by", tick Agent. The Markdown equivalent is `methods: [human, agent]`.
3. Plan the run with a requirement that names the agent method.

```
$ mainworthy plan --json '{"name":"Agent smoke","select":{"cases":["C-2"]},"require":[{"id":"exercise","kind":"exercise","methods":["human","agent"],"minActors":1,"basis":"exact-or-assumed"}]}'
{
  "run": "R-2",
  "slots": 1,
  "already": 0
}
```

The web planner does not offer this requirement yet, so use the command line or
the API. After planning the run, have the agent report to it with `run` set to `R-2`. Its pass
fills the slot, and `mainworthy gate --run R-2` reads `passed`. A run that does
not name the agent method ignores agent results, even on a case that admits agents.

## See also

- [Policy](./policy.md) for who answers each question.
- [People, agents and pipelines](./access.md) for tokens and grants.
- [Planned runs](./runs.md) for planned runs.
