# Command line

Every command of `mainworthy`, with its flags and exit codes. The tables on this page are read from the program, so they match the version you are running.

`mainworthy` is one executable. With no arguments it starts the server. Almost every other command talks to a running server over HTTP, on this machine or another one. `mainworthy fmt` and `mainworthy help` need no server.

## Reach a server

A command finds its server in this order: the flag, then the environment variable, then the default.

| What | Flag | Variable | Default |
| --- | --- | --- | --- |
| Server address | `--url` | `MAINWORTHY_URL` | `http://127.0.0.1:7357` |
| Token | `--token` | `MAINWORTHY_TOKEN` | none: a server in local mode on this machine asks for none |
| Project | `--project` | `MAINWORTHY_PROJECT` | the only project, when there is one |

[Configuration](./configuration.md) explains local and server mode. [People, agents and pipelines](./access.md) explains tokens.

## Ask a command what it takes

```
$ mainworthy help
$ mainworthy gate --help
```

`mainworthy help` lists every command. `--help` after a command prints its flags.

## Commands

<!-- generated:cli-commands -->

### Commands for people

Each prints text made to be read, and `--json` where it is listed prints the same as JSON.

| Command | What it does |
| --- | --- |
| `mainworthy serve` | Start the server and web UI. Also the default with no arguments. |
| `mainworthy report <files...> [--session <name>] [--run R-4] [--json]` | Upload JUnit files, detect the CI build, and print the receipt. Use gate to check the verdict. |
| `mainworthy gate [--commit <sha> \| --run R-4 \| --change pr:482] [--wait <seconds>] [--json]` | Check a commit, change or run. Exit 0 passed, 1 failed, 2 blocked, 3 pending. |
| `mainworthy token new --agent <name> \| --ci <name> \| --human <name> [--can read,produce] [--project <key>] [--expires 90d] \| token list \| token revoke <id>` | Issue, list and revoke actor tokens. A new secret is shown once. |
| `mainworthy actor list \| actor grant <name> --can read,record [--project <key>] \| actor ungrant <name> [--project <key>]` | List who may do what on which project, and change or take away a grant. |
| `mainworthy policy show \| policy use <loose\|standard\|strict> [--json]` | Show policy clauses or propose and record an admin's choice of preset. |
| `mainworthy new [file\|-] [--json]` | Create a case from a canonical Markdown file or an outline on stdin. |
| `mainworthy get <ref> [--md] [--json]` | Read a ref, or print a case's canonical Markdown with --md. |
| `mainworthy fmt <file> [--json]` | Print canonical case Markdown. Parse errors include source line numbers. |
| `mainworthy check [--limit <number>] [--json]` | Print suite problems grouped by rule. Exit 0 with none, 1 with problems. |
| `mainworthy export --out <file> [--json]` | Stream the instance's lossless archive to a file. A .gz suffix enables gzip. |
| `mainworthy import <file> [--json]` | Stream an archive into a fresh instance, replacing its bootstrap rows. Supports gzip. |
| `mainworthy mcp` | Serve MCP on stdin/stdout, forwarding tools to the running HTTP server. |
| `mainworthy open [--json]` | Print the web UI URL of the running instance. |
| `mainworthy health [--url <url>] [--json]` | Check that the server answers. Exit 0 when it does, 1 when it does not. |
| `mainworthy help` | List every operation and adapter. |

Flags of `mainworthy report`:

- `--commit <string>`: Commit tested. Overrides CI/Git detection.
- `--branch <string>`: Branch tested.
- `--pr <number>`: Pull request number.
- `--base <string>`: Base commit of the change.
- `--env <string>`: Test environment.
- `--session <string>`: Named test session with no build identity.
- `--run <string>`: Planned run these results are for.
- `--job <string>`: CI job name. Overrides detection.
- `--attempt <number>`: Build attempt. Overrides detection.

Flags of `mainworthy gate`:

- `--commit <string>`: Commit to check. Defaults to CI/Git detection.
- `--run <string>`: Run to check.
- `--change <string>`: Change to check, for example pr:482.
- `--repo <string>`: Repository, when the commit was reported for more than one.
- `--wait <number>`: Poll pending evidence for at most this many seconds.

Flags of `mainworthy token`:

- `--agent <string>`: Issue a token for this agent.
- `--ci <string>`: Issue a token for this pipeline: it records results and reads the gate.
- `--human <string>`: Issue a token for this person.
- `--can <a,b,...>`: What a new actor may do, comma-separated or repeated. Not for one that exists.
- `--expires <string>`: How long the new token works: 90d, 12h, 2w. Without it the token has no end.

Flags of `mainworthy actor`:

- `--can <a,b,...>`: Capabilities, comma-separated or repeated.

Flags of `mainworthy get`:

- `--md`: Print canonical case Markdown.

Flags of `mainworthy check`:

- `--limit <number>`: Maximum problems to print.

Flags of `mainworthy export`:

- `--out <string>`: Archive destination. Use .gz for gzip.

### One command per operation

Every operation of the API is also a command with the same name. Give its input as flags, or whole as `--json '<input JSON>'`. Where a command for people has the same name, the operation form is the one that runs when you pass `--json` input.

| Command | What it does |
| --- | --- |
| `mainworthy propose` | Create or change cases, folders, links or the policy. Saving and proposing are the same call; policy decides what happens next. |
| `mainworthy report` | Record results: a parsed CI report, one manual result, or an agent's batch. The producer is the token's actor. |
| `mainworthy claim` | Record a review and what it found. A review with no findings is still recorded. |
| `mainworthy plan` | Start a run: choose cases, say which results count and what completes it. Evidence already recorded fills it at once. |
| `mainworthy decide` | Answer a question, or withdraw a decision. Policy says whether your answer settles it, is advice, or is refused. |
| `mainworthy inbox` | The queue: every question that needs an answer, most blocking first. With state=decided: the ledger. |
| `mainworthy get` | Read cases, questions, runs, tests or proposals by ref. |
| `mainworthy find` | Search and list: cases (by text, folder, tag), tests, runs, slots of a run, folders, requirements, changes. |
| `mainworthy impact` | The cases a change touches and why, with what was already reviewed or decided. Where to look, instead of the whole suite. |
| `mainworthy since` | What changed since a cursor: cases with what changed in each, and questions that were settled. |
| `mainworthy gate` | The verdict for a commit, a change or a run: passed, failed (needs a fix), blocked (needs a decision), pending (needs evidence). |
| `mainworthy history` | The versions of a case, or the step-level diff between two of them. |
| `mainworthy timeline` | One timeline for a case: versions, moves, results from every producer, findings, reviews and its questions. |
| `mainworthy check` | Check the suite for structural problems: cases with no steps or no expected result, duplicate titles, dangling links. |
| `mainworthy command` | What became of a command you sent under an idempotency key: not recorded, begun, or done with its reply. |
| `mainworthy admin` | Projects, actors, grants and tokens. There are no seats: an actor is free, and a token carries what its actor may do. |

### Flags every command takes

- `--url <string>`: Server URL. Defaults to MAINWORTHY_URL or http://127.0.0.1:7357.
- `--token <string>`: Bearer token. Defaults to MAINWORTHY_TOKEN.
- `--project <string>`: Project key. Defaults to MAINWORTHY_PROJECT or the only project.
- `--compact`: Print JSON on one line.
- `--help`: Show command help.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | `mainworthy gate`: the verdict is `passed` |
| 1 | `mainworthy gate`: the verdict is `failed` |
| 2 | `mainworthy gate`: the verdict is `blocked` |
| 3 | `mainworthy gate`: the verdict is `pending` |
| 1 | `mainworthy check` found problems in the suite; `mainworthy health` got no answer |
| 4 | The command could not run: the server refused it, could not be reached, or the input was wrong |

<!-- /generated -->

A command that could not run prints one line to standard error, the error code and then the message, for example `forbidden: ...`, and exits with 4. [Troubleshooting](./troubleshooting.md) lists the codes. A command that ran and has bad news, such as a gate that is blocked or a suite with problems, prints its result and uses the exit code in the table above.

## See also

- [Report results](./report-results.md) for `mainworthy report` in a pipeline.
- [Changes and the gate](./changes.md) for `mainworthy gate` and what each verdict needs.
- [API and agent tools](./api.md) for the input of each operation.
