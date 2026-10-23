# Command line

This page lists every `mainworthy` command, with its flags and exit codes. The program
generates the tables for the version that serves these docs.

`mainworthy` is one executable. With no arguments, it starts the server. Almost
every other command talks to a running server over HTTP, on this machine or
another one. `mainworthy fmt`, `mainworthy audit verify <file>`, and
`mainworthy help` need no server.

## Sign in with a password and a code

`login` exchanges your password for a personal CLI token. If you have an enrolled
authenticator, `login` also needs an authenticator or recovery code. The command
prints the token once and tries to end the temporary session. It reads the input
secrets from private files, as in this example:

```
mainworthy login --url https://mainworthy.example --name robin --password-file /private/password --code-file /private/code --label laptop --expires 30d
```

The password file holds the password, with one optional final newline. The code
file holds a current authenticator code or an unused recovery code. Each file is
limited to 4096 bytes. Neither secret appears as an argument or in an error.
`--code-file` is required only for an account with an enrolled authenticator. The
command refuses plain HTTP to another machine. It ignores existing token options
because the command starts a new sign-in.

The returned token works as `MAINWORTHY_TOKEN` or in a private token file.
`--json` returns `id`, `actor`, `token`, and `expiresAt`. The default token lifetime
is 30 days, and the maximum is 365 days. Delete the password and code files when
you no longer need them.

For the local owner, `mainworthy credential --do totp.begin` starts
[authenticator enrolment](./access.md#add-an-authenticator-for-password-sign-in).
`mainworthy credential --do totp.confirm --challenge <challenge> --code <code>`
confirms enrolment within five minutes and prints recovery codes once. Remote
bearer tokens cannot enrol an authenticator. Remote enrolment is available in
Settings in a signed-in browser.

## Reach a server

A command uses the flag first, then the environment variable, then the default
from this table.

| What | Flag | Variable | Default |
| --- | --- | --- | --- |
| Server address | `--url` | `MAINWORTHY_URL` | `http://127.0.0.1:7357` |
| Token | `--token`, or `--token-file` | `MAINWORTHY_TOKEN`, or `MAINWORTHY_TOKEN_FILE` | none: a server in local mode on this machine asks for none |
| Project | `--project` | `MAINWORTHY_PROJECT` | the only project the caller can access, when there is one |

When the CLI prints a server address from `--url` or `MAINWORTHY_URL`, it removes
the URL's username and password. This applies to diagnostics, links, and JSON
output. Requests still use the configured address.

### Give the token in the environment or in a file

`MAINWORTHY_TOKEN` avoids exposing the token as an argument. An argument appears
in the machine's process list while the command runs and in the shell's history
afterwards.
`--token-file <path>` or `MAINWORTHY_TOKEN_FILE` reads the token from a file, such as
a secret file mounted by a pipeline. The CLI removes surrounding whitespace,
including a final newline. The token may have at most 512 characters, the server's
limit. The whole file, including whitespace, may have at most 4096 bytes.

An empty, unreadable, or oversized file, or one with more than a token, stops the
command locally with exit code 4. The error names the file without quoting its
contents. The command refuses `--token` together with `--token-file`. If neither
flag is present, it refuses both token variables being set. A flag wins over a variable.

`health`, `version`, `fmt`, `help` and a command's `--help` need no token. They ignore token flags and variables, including unreadable token files and conflicting token options. `serve` uses the [server configuration](./configuration.md#variables-the-server-reads), not the client token options.

Before sending a token to a plain `http://` address on another machine, a command
warns once on standard error. The command then continues and sends the token
unencrypted. An `https://` address encrypts the token in transit. The warning
does not appear for loopback addresses, `https://` addresses, or commands that
send no token. Loopback addresses include `localhost`, `127.0.0.0/8`, and `[::1]`.
The warning does not affect standard output, so `--json` remains valid JSON.

[Configuration](./configuration.md) explains local and server mode. [People, agents and pipelines](./access.md) explains tokens.

## CLI and server versions

`mainworthy version` prints the CLI's software version and required API version without contacting a server.
`mainworthy version --json` prints `{"version":"0.1.0","apiVersion":1}`.
`mainworthy health --json` reports the server's `apiVersion` and whether it is `compatible` with this CLI.
Health still exits 0 for a healthy server with an incompatible or unknown API version. It checks availability.
While the database is upgrading, health also exits 0 and prints `upgrading`; its JSON includes `state: "upgrading"`. The process is alive but cannot accept application requests yet. Other commands report that the server is upgrading. A deployment must require `/healthz` to report `ok: true` and the expected commit before declaring it ready.

Before its first authenticated request, the CLI reads `/healthz` without sending a token.
If that probe redirects, the error gives the destination's origin for `--url`, without the `/healthz` path.
The server must advertise the same API version as the CLI. Software versions and build commits may differ.
An absent, malformed or different API version stops the command with `incompatible` and exit code 4, before it sends an operation.
A retry requires a CLI and server with the same API version. Servers from before
this contract need an upgrade.
Every subsequent request carries `X-Mainworthy-API-Version`. A server with a
different API version refuses the request with HTTP 409 and code `conflict`
before reading or writing project data.
The header check also catches a server upgrade after the first probe.

Before 1.0, adding or removing an operation, or an incompatible change to its inputs, replies, capabilities or meaning, increments the API version.
There is no promise to support the previous API version. Clients from before this check cannot detect a version mismatch.
The [API reference](./api.md) describes the operations themselves.

## Ask a command what it takes

```
$ mainworthy help
$ mainworthy gate --help
```

`mainworthy help` lists every command. `--help` after a command prints its flags.

Human-readable output escapes terminal controls, including embedded line breaks,
as visible `\uNNNN` text. This covers import previews, warnings, receipts and
lists. Non-ASCII text such as `é` and `雪` stays readable. Output also escapes
GitHub Actions command prefixes so imported text cannot create annotations.
`get --md` and `fmt` retain Markdown structure and encode controls and command
prefixes with reversible canonical Markdown escapes. Parsing that output recovers
the original values. Ordinary mid-line syntax such as `std::vector`, `a::before`
and `[::1]` stays literal; `::` is escaped only where it could start a workflow
command. Their JSON forms preserve the canonical document text.
Pretty and compact JSON preserve their values
and remain valid JSON; saved archives and audit exports retain their original bytes.

## Commands

<!-- generated:cli-commands -->

### Commands for people

Each prints text made to be read, and `--json` where it is listed prints the same as JSON.

| Command | What it does |
| --- | --- |
| `mainworthy serve` | Start the server and web UI. Also the default with no arguments. |
| `mainworthy announce --deploy <build> --env <env> [--digest sha256:<hash> --repo <repo> --commit <sha>]` | Announce a deployed build. A new artifact needs its digest, repository and full commit. |
| `mainworthy report <files...> [--format <format>] [--session <name>] [--run R-4] \| report --nothing-required [--commit <sha>] [--json]` | Upload test reports or declare no tests required, detect the CI build, and print the receipt. Use gate to check the verdict. |
| `mainworthy login --name <name> --password-file <path> [--code-file <path>] [--label <label>] [--expires 30d] [--json]` | Sign in with a password and, when enrolled, an authenticator or recovery code. Print a personal CLI token once. |
| `mainworthy gate [--commit <sha> \| --run R-4 \| --change pr:482] [--wait <seconds>] [--json]` | Check a commit, change or run. Exit 0 passed, 1 failed, 2 blocked, 3 pending. |
| `mainworthy token new --agent <name> \| --ci <name> \| --human <name> [--can read,produce] [--project <key>] [--expires 90d] \| token list \| token revoke <id>` | Issue, list and revoke actor tokens. Each carries its actor's current grants on every project. A new secret is shown once. |
| `mainworthy invite new <name> [--can read,answer] [--project <key>] [--expires 3d] [--email <address>] \| invite list \| invite revoke <id>` | Invite a person with a link that is shown once, list invitations, and revoke one. |
| `mainworthy actor list \| actor grant <name> --can read,record [--roles approver,lead] [--project <key>] \| actor ungrant <name> [--project <key>] \| actor forget <name> --confirm <name>` | List who may do what, change grants, and forget an actor's identity while keeping history. |
| `mainworthy audit export --out <file> [--from <time>] [--to <time>] [--receipt <id> --cursor <cursor> --limit <n>] \| audit verify <file>` | Export a project's audit history, or verify a saved audit file offline. |
| `mainworthy policy show \| policy use <loose\|standard\|strict> \| policy tests <ask\|track\|create> \| policy empty <pending\|nothing-required> [--json]` | Show policy clauses, or record an admin's choice of preset, tests with no case, or empty reports. |
| `mainworthy new [file\|-] [--json]` | Create a case from a canonical Markdown file or an outline on stdin. |
| `mainworthy seed <project> [--cases 2000] [--seed 1] [--days 14] [--unlinked-files 60] [--json]` | Fill a new or empty project with demo data: a shop's cases, two weeks of results and runs, and questions to answer. |
| `mainworthy get <ref> [--md] [--json]` | Read a ref, or print a case's canonical Markdown with --md. |
| `mainworthy fmt <file> [--json]` | Print canonical case Markdown. Parse errors include source line numbers. |
| `mainworthy check [--limit <number>] [--json]` | Print suite problems grouped by rule. Exit 0 with none, 1 with problems. |
| `mainworthy export --out <file> [--project <key>] [--json]` | Stream an instance or project archive to a file. A .gz suffix enables gzip. |
| `mainworthy import <file> [--format csv\|testrail\|qase] [--case-prefix QASE] [--json]` | Import an archive into a fresh instance, or propose cases from CSV, TestRail or Qase. |
| `mainworthy import-csv <file> [--mapping '<column mapping JSON>'] [--preset testrail] [--confirm hash] [--cmd id] [--json]` | Preview a mapped CSV file, then import it with the preview's confirmation. |
| `mainworthy mcp` | Serve MCP on stdin/stdout, forwarding tools to the running HTTP server. |
| `mainworthy open [--json]` | Print the web UI URL of the running instance. |
| `mainworthy health [--url <url>] [--json]` | Check that the server answers, including while upgrading. Exit 0 when it does, 1 when it does not. |
| `mainworthy version [--json]` | Print the CLI version and the API version it requires. No server is contacted. |
| `mainworthy help` | List every operation and adapter. |

Flags of `mainworthy announce`:

- `--deploy <string>`: Build label.
- `--env <string>`: Environment deployed to.
- `--digest <string>`: Artifact's SHA-256 digest.
- `--repo <string>`: Source repository.
- `--commit <string>`: Full source commit hash.
- `--cmd <string>`: Idempotency key for this deployment.

Flags of `mainworthy report`:

- `--commit <string>`: Commit tested. Overrides CI/Git detection.
- `--branch <string>`: Branch tested.
- `--pr <number>`: Pull request number.
- `--base <string>`: Base commit of the change.
- `--head <string>`: Current change head read from the code host. Never inferred from CI.
- `--env <string>`: Test environment.
- `--format <string>`: Report format: auto (default), junit, playwright, jest, vitest, pytest (pytest-json-report), trx.
- `--attachments <string>`: Read JUnit attachment files inside this directory. Unavailable or disallowed files are skipped with a warning.
- `--build <string>`: Announced build label. Overrides CI/Git detection.
- `--session <string>`: Named test session with no build identity.
- `--run <string>`: Planned run these results are for.
- `--job <string>`: CI job name. Overrides detection.
- `--attempt <number>`: Build attempt. Overrides detection.
- `--shard <string>`: This report is one shard of its job, as index/count, for example 2/6. The commit's gate waits for every shard.
- `--nothing-required`: CI declares this commit requires no tests, if its policy allows. No files.

Flags of `mainworthy login`:

- `--name <string>`: Your sign-in name.
- `--password-file <string>`: A private file holding your password. One final newline is ignored.
- `--code-file <string>`: A private file holding a current authenticator code or unused recovery code.
- `--label <string>`: The personal token label. Default: command line.
- `--expires <string>`: How long the personal token lasts. Default: 30d; at most 365d.

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

- `--email <string>`: Send the invitation to this address. Requires instance mail settings.
- `--can <a,b,...>`: What a new person may do, comma-separated or repeated. Not for one who exists.
- `--expires <string>`: How long the link works: 12h, 3d, 2w. At most 30d.

Flags of `mainworthy actor`:

- `--roles <a,b,...>`: Named roles, comma-separated or repeated. Omit to keep; an empty value clears.
- `--can <a,b,...>`: Capabilities, comma-separated or repeated.
- `--confirm <string>`: Repeat the name to confirm forgetting. A pseudonym replaces the name in attribution, question evidence and saved replies. Linked provider identities and recovery email addresses are erased. So are password hashes, passkey public keys, authenticator secrets and recovery-code hashes, token network addresses, and token and credential labels. Team memberships are removed. Passwords, passkeys, authenticators, tokens and invitations stop working, and sessions end. History, attachments and text the person typed in cases and notes stay. Some sign-in records and request fingerprints stay. This cannot be undone.

Flags of `mainworthy audit`:

- `--receipt <string>`: Export one bounded page of frozen receipt evidence.
- `--cursor <string>`: Continue a receipt evidence export.
- `--limit <string>`: Receipt evidence items per page (1–50).
- `--out <string>`: Audit NDJSON destination.
- `--from <string>`: Inclusive start: Unix milliseconds or ISO timestamp with a timezone.
- `--to <string>`: Exclusive end: Unix milliseconds or ISO timestamp with a timezone.

Flags of `mainworthy seed`:

- `--cases <number>`: How many cases to write. Defaults to 2000.
- `--seed <number>`: The number the demo is made from: the same seed gives the same demo. Defaults to 1.
- `--days <number>`: How many days of history to write before today, 0 for none. Defaults to 14.
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

Flags of `mainworthy import-csv`:

- `--mapping <string>`: Column mapping JSON. Required unless --preset testrail is given.
- `--preset <string>`: testrail uses the documented TestRail column names.
- `--confirm <string>`: The confirmation returned by the preview. Omit to preview.
- `--cmd <string>`: An idempotency key for retrying this request.

### One command per operation

Every operation of the API is also a command with the same name. Give its input as flags, or whole as `--json '<input JSON>'`. Where a command for people has the same name, the operation form is the one that runs when you pass `--json` input.

| Command | What it does |
| --- | --- |
| `mainworthy attach` | Append a screenshot or small file to a result you recorded. Supply the file as base64. |
| `mainworthy attachment` | List a result's attachments, or read one as base64 with its file name and safe content type. |
| `mainworthy propose` | Create or change cases, folders, links or the policy. Saving and proposing are the same call; policy decides what happens next. |
| `mainworthy import-csv` | Preview mapped CSV cases, then confirm one import proposal. Existing foreign aliases are refused. |
| `mainworthy report` | Record results: a parsed CI report, one manual result, or an agent's batch. The producer is the token's actor. |
| `mainworthy claim` | Record a review and what it found. A review with no findings is still recorded. |
| `mainworthy change` | Say that a change ended or is open again. A merge records the head gate when reported. An ended change is not asked about. |
| `mainworthy announce` | Announce a deployment and bind its build label to an attested artifact. Pipelines and human admins only. |
| `mainworthy tracker` | Queue a defect from a failed result: create a tracker issue or validate an existing issue for linking. |
| `mainworthy plan` | Start a run: choose cases, say which results count and what completes it. Evidence already recorded fills it at once. |
| `mainworthy work` | Take a named slot or the next free unfinished slot for a lease, renew it, or give it back. |
| `mainworthy decide` | Answer a question, or withdraw a decision. Policy says whether your answer settles it, is advice, or is refused. |
| `mainworthy handoff` | Hand a failure question to the coding agent this instance is configured to start, with its evidence. |
| `mainworthy inbox` | The queue: every question that needs an answer, most blocking first. With state=decided: the ledger. |
| `mainworthy get` | Read cases, questions, runs, tests, results or proposals by ref. |
| `mainworthy find` | Search and list: cases (by text, folder, tag), tests, runs, slots of a run, folders, requirements, changes. |
| `mainworthy impact` | The cases a change touches and why, with what was already reviewed or decided. Where to look, instead of the whole suite. |
| `mainworthy since` | What changed since a cursor: cases with what changed in each, and questions that were settled. |
| `mainworthy gate` | The verdict for a commit, a change or a run: passed, failed (needs a fix), blocked (needs a decision), pending (needs evidence). |
| `mainworthy history` | The versions of a case, or the step-level diff between two of them. |
| `mainworthy timeline` | One timeline for a case: versions, moves, results from every producer, findings, reviews and its questions. |
| `mainworthy check` | Check the suite for structural problems: cases with no steps or no expected result, duplicate titles, dangling links. |
| `mainworthy stats` | Reports over the last days: pass rate per day, flaky tests, time lost to reruns, automation and its backlog, coverage by requirement. |
| `mainworthy command` | What became of a command you sent under an idempotency key: not recorded, begun, or done with its reply. |
| `mainworthy tracker-status` | Read a tracker request's delivery state and its verified issue reference. |
| `mainworthy handoff-status` | Read whether a failure question's latest hand-off to an agent was sent, or why it failed. |
| `mainworthy audit` | Export a project's retained decisions, answers, policy changes and case versions as a verifiable audit file. |
| `mainworthy admin` | Projects, actors, teams, grants and tokens. There are no seats: an actor is free, and a token carries what its actor may do. Creating a token from a browser requires recent credential proof. |
| `mainworthy session` | Your browser sessions: list them, and end one. An admin who is a person lists and ends anyone's. |
| `mainworthy credential` | Your password, passkeys, authenticator, recovery email and CLI tokens: list, add or remove them. Only a person may call. Sign-in changes and personal token creation require recent credential proof in the caller's browser session. A password is set in the web UI. A personal token is shown once and expires after 30d by default. |
| `mainworthy invitation` | Invite a person with a link: make one, list them, revoke one. Optionally send it by mail. The link is shown once. Issuing a recovery link from a browser needs the caller's recent credential proof; token and local recovery authority remain. |

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

A command that could not run exits with code 4 and prints one line to standard
error. The line contains the error code followed by the message, for example
`forbidden: ...`. [Troubleshooting](./troubleshooting.md) lists the codes. A command
that ran and has bad news prints its result and uses the exit code in the table
above. Examples include a blocked gate or a suite with problems.

## See also

- [Report results](./report-results.md) for `mainworthy report` in a pipeline.
- [Changes and the gate](./changes.md) for `mainworthy gate` and what each verdict needs.
- [API and agent tools](./api.md) for the input of each operation.
