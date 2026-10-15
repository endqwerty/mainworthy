# Command line

Every command of `mainworthy`, with its flags and exit codes. The tables on this page are read from the program, so they match the version you are running.

`mainworthy` is one executable. With no arguments it starts the server. Almost every other command talks to a running server over HTTP, on this machine or another one. `mainworthy fmt` and `mainworthy help` need no server.

## Reach a server

A command finds its server in this order: the flag, then the environment variable, then the default.

| What | Flag | Variable | Default |
| --- | --- | --- | --- |
| Server address | `--url` | `MAINWORTHY_URL` | `http://127.0.0.1:7357` |
| Token | `--token`, or `--token-file` | `MAINWORTHY_TOKEN`, or `MAINWORTHY_TOKEN_FILE` | none: a server in local mode on this machine asks for none |
| Project | `--project` | `MAINWORTHY_PROJECT` | the only project, when there is one |

### Give the token in the environment or in a file

Prefer `MAINWORTHY_TOKEN` to `--token`: an argument is in the process list of the machine while the command runs, and in the shell's history afterwards. `--token-file <path>` (or `MAINWORTHY_TOKEN_FILE`) reads the token from a file instead, which suits a pipeline that mounts a secret as a file. The file holds the token and nothing else; the whitespace around it, a final newline included, is dropped. The token may have at most 512 characters, the server's limit. The whole file, including whitespace, may have at most 4096 bytes. An empty, unreadable or oversized file, or one with more than a token, stops the command locally with exit code 4. The error names the file and never quotes its contents. Giving the token two ways at once (`--token` with `--token-file`, or both variables) is refused. A flag wins over a variable.

`health`, `fmt`, `help` and a command's `--help` need no token. They ignore token flags and variables, including unreadable token files and conflicting token options. `serve` uses the [server configuration](./configuration.md#variables-the-server-reads), not the client token options.

A command that is about to send a token to a plain `http://` address on another machine says so once on standard error, before the first request, and goes on: the token travels unencrypted, so use an `https://` address. The addresses of this machine (`localhost`, `127.0.0.1` and the rest of `127.0.0.0/8`, `[::1]`) and `https://` addresses get no warning, and neither does a command that sends no token. Standard output is not touched, so `--json` output stays clean.

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
| `mainworthy report <files...> [--format <format>] [--session <name>] [--run R-4] [--json]` | Upload test reports, detect the CI build, and print the receipt. Use gate to check the verdict. |
| `mainworthy gate [--commit <sha> \| --run R-4 \| --change pr:482] [--wait <seconds>] [--json]` | Check a commit, change or run. Exit 0 passed, 1 failed, 2 blocked, 3 pending. |
| `mainworthy token new --agent <name> \| --ci <name> \| --human <name> [--can read,produce] [--project <key>] [--expires 90d] \| token list \| token revoke <id>` | Issue, list and revoke actor tokens. A new secret is shown once. |
| `mainworthy invite new <name> [--can read,answer] [--project <key>] [--expires 3d] \| invite list \| invite revoke <id>` | Invite a person with a link that is shown once, list invitations, and revoke one. |
| `mainworthy actor list \| actor grant <name> --can read,record [--project <key>] \| actor ungrant <name> [--project <key>] \| actor forget <name> --confirm <name>` | List who may do what, change grants, and forget an actor's identity while keeping history. |
| `mainworthy policy show \| policy use <loose\|standard\|strict> \| policy tests <ask\|track\|create> [--json]` | Show policy clauses, or propose and record an admin's choice of preset or of what happens to a test with no case. |
| `mainworthy new [file\|-] [--json]` | Create a case from a canonical Markdown file or an outline on stdin. |
| `mainworthy seed <project> [--cases 2000] [--unlinked-files 60] [--json]` | Fill a new or empty project with demo data: a shop's cases, results, a run and questions to answer. |
| `mainworthy get <ref> [--md] [--json]` | Read a ref, or print a case's canonical Markdown with --md. |
| `mainworthy fmt <file> [--json]` | Print canonical case Markdown. Parse errors include source line numbers. |
| `mainworthy check [--limit <number>] [--json]` | Print suite problems grouped by rule. Exit 0 with none, 1 with problems. |
| `mainworthy export --out <file> [--json]` | Stream the instance's lossless archive to a file. A .gz suffix enables gzip. |
| `mainworthy import <file> [--format csv\|testrail\|qase] [--case-prefix QASE] [--json]` | Import an archive into a fresh instance, or propose cases from CSV, TestRail or Qase. |
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
- `--format <string>`: Report format: auto (default), junit, playwright, jest, vitest, pytest (pytest-json-report), trx.
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

Flags of `mainworthy invite`:

- `--can <a,b,...>`: What a new person may do, comma-separated or repeated. Not for one who exists.
- `--expires <string>`: How long the link works: 12h, 3d, 2w. At most 30d.

Flags of `mainworthy actor`:

- `--can <a,b,...>`: Capabilities, comma-separated or repeated.
- `--confirm <string>`: Repeat the name to confirm forgetting. A pseudonym replaces the name in attribution, question evidence and saved replies. Password hashes, passkey public keys, and token and credential labels are erased. Passwords, passkeys, tokens and invitations stop working, and sessions end. History and text the person typed in cases and notes stay. Some sign-in records and request fingerprints stay. This cannot be undone.

Flags of `mainworthy seed`:

- `--cases <number>`: How many cases to write. Defaults to 2000.
- `--unlinked-files <number>`: How many files of unit tests with no case the pipeline reports: one open question each. Defaults to 60; 0 for none.

Flags of `mainworthy get`:

- `--md`: Print canonical case Markdown.

Flags of `mainworthy check`:

- `--limit <number>`: Maximum problems to print.

Flags of `mainworthy export`:

- `--out <string>`: Archive destination. Use .gz for gzip.

Flags of `mainworthy import`:

- `--format <string>`: Case CSV format: csv, testrail or qase. Omit for a Mainworthy archive.
- `--case-prefix <string>`: Qase source project key for foreign aliases. Defaults to QASE.

### One command per operation

Every operation of the API is also a command with the same name. Give its input as flags, or whole as `--json '<input JSON>'`. Where a command for people has the same name, the operation form is the one that runs when you pass `--json` input.

| Command | What it does |
| --- | --- |
| `mainworthy propose` | Create or change cases, folders, links or the policy. Saving and proposing are the same call; policy decides what happens next. |
| `mainworthy report` | Record results: a parsed CI report, one manual result, or an agent's batch. The producer is the token's actor. |
| `mainworthy claim` | Record a review and what it found. A review with no findings is still recorded. |
| `mainworthy change` | Say that a change ended (merged, or closed without merging) or is open again. An ended change is not asked about. |
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
| `mainworthy session` | Your browser sessions: list them, and end one. An admin who is a person lists and ends anyone's. |
| `mainworthy credential` | How a person signs in: list your password and passkeys, register a passkey, remove one. An agent is refused: it signs in with a token only. A password is set in the web UI, never here. |
| `mainworthy invitation` | Invite a person with a link, since there is no mail: make one, list them, revoke one. The link is shown once. |

### Flags every command takes

- `--url <string>`: Server URL. Defaults to MAINWORTHY_URL or http://127.0.0.1:7357.
- `--token <string>`: Bearer token. Defaults to MAINWORTHY_TOKEN, which is safer: an argument is in the process list and the shell's history.
- `--token-file <string>`: Read the bearer token from this file, so no argument holds it. Defaults to MAINWORTHY_TOKEN_FILE. Not with --token.
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
