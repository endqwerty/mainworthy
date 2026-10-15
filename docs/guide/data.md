# Your data

Find your data, export it to a text file, back it up and move it to another machine. Your cases, results and decisions are yours, and you can take them out at any time.

## Where the data lives

Mainworthy keeps structured records in one SQLite file, `mainworthy.db`, and attachment bytes in `blobs/` in the data directory. The directory is `~/.mainworthy` unless you set `MAINWORTHY_DATA`, and `/data` in the container. See [configuration](./configuration.md#variables-the-server-reads).

```
$ ls -F ~/.mainworthy  # after an archive transfer
mainworthy.db  mainworthy.db-shm  mainworthy.db-wal  blobs/  server.lock  spool/
```

While the server runs, it also keeps a `-wal` and a `-shm` file beside the database. The three belong together. After a clean stop the `-wal` file is empty.

An upgrade runs each database migration in its own transaction. If any statement fails, startup stops and rolls back that migration without advancing the schema version. Earlier successful migrations remain applied. Before upgrading existing data, Mainworthy saves a consistent copy beside the database as `mainworthy.db.v<N>.bak`, where `<N>` is the version before the upgrade.

On `SIGTERM` or `SIGINT`, the server stops accepting connections and closes its change streams. It gives requests already in flight five seconds to send their replies before closing the remaining connections, then stops the reader threads and closes the database. A request that outlasts this wait can lose its reply. If you retry a write, send the same command id, `cmd`, so it is not applied twice. The CLI and web UI send command ids.

With reader threads enabled, a background thread checkpoints every half second, and the writer keeps a 20,000-page automatic checkpoint fallback. Once read snapshots finish and a checkpoint completes, the next write can reuse the log and trim it to at most 4 MiB. The retention limit does not change when checkpoints happen. Active snapshots and large transactions can grow the log past 4 MiB, so keep room for them as well as the database.

Before this limit, Bun's own SQLite on Linux, including the container, defaulted to no retention limit, `-1`. On a Mac, Bun uses Apple's libsqlite3, whose default was `32768`, or 32 KiB. The 4 MiB limit is a new bound in the container and a looser one on a Mac.

The server also keeps `server.lock` (and `server.lock-journal` while it holds the lock; a clean stop removes the journal) and uses `spool/` for archive transfers, both inside the data directory. Exports stage the whole archive before sending it; imports stage the whole upload before reading it. Leave enough free space on that filesystem for every concurrent transfer. Each temporary directory is private, and each archive file is readable and writable by its owner only. Completed, cancelled and rejected transfers remove their temporary files. A killed process can leave files in `spool/`; after stopping the server, you can remove that directory.

The file holds every project, case and version, every result, decision and policy, and the actors, grants and a hash of each token. Treat it like the data of any private system. What it keeps about people, and for how long, is on the [privacy](./privacy.md) page.

Attachment files use their SHA-256 hash as the file name. Identical content shares
one disk file, even across results. Back up `blobs/` with the database; a database
copy alone cannot restore attachments. Archives include the file bytes as base64
on attachment rows, covered by the archive checksum. Import validates each file's
hash, size and content type. An export refuses missing or damaged files rather
than writing an incomplete backup.

There is no automatic evidence expiry or total disk quota. Monitor free space and
include retained attachments and archive staging files in storage planning. A
failed write or import can leave unreferenced blob files; startup removes these
before recovering accepted reports. Referenced evidence is kept when a producer
is forgotten. File contents and file names may contain personal information and
are not scanned or redacted.

## Export everything

An admin on every project exports the whole instance with one command. It works while the server runs, and the archive is one consistent snapshot. Other requests keep running while Mainworthy prepares the archive.

```
$ mainworthy export --out mainworthy.ndjson.gz
exported to mainworthy.ndjson.gz
```

A file name that ends in `.gz` is compressed, and any other name is plain text. Mainworthy writes the file readable by you only. It builds the file beside the destination and renames it when the export is complete, so a failed export leaves an earlier backup alone. In server mode the command needs an admin token. Give it with `--token` or `MAINWORTHY_TOKEN`. The web UI has no export button.

The archive is text, one JSON object per line. The first line describes the archive. Each row of data follows on a line of its own. The last line holds a row count and a SHA-256 checksum of everything before it.

```
$ head -n 1 mainworthy.ndjson | cut -c 1-80
{"mainworthy":"archive","format":1,"schema":20,"exportedAt":1791875678677,"tables
$ tail -n 1 mainworthy.ndjson
{"end":true,"rows":67,"sha256":"ca0a5d4d76fe0de47415d595159393df3fad4fc517e4227325a4e5b5ca6b9cf7"}
```

You can read it with any tool that reads text, search it with `grep`, and keep it in version control if the data suits that.

The archive holds attachment bytes along with the database records, and actors, personal and team grants, memberships, team history, recovery addresses and their verification status. It leaves out tokens, sessions, passwords, passkeys, passkey handles, invitations and the search index, which Mainworthy rebuilds on import. Tracker delivery requests do not travel, so restoring an archive never sends an issue again. It also leaves out which changes have ended: after an import every change is open, and the questions that were closed when one ended stay closed. If a failure on such a change is reported again, say once more that the change ended (`mainworthy change`). It also leaves out which project is a [demo](./customize.md#a-project-of-demo-data): an imported demo keeps its data and its dates, and accepts no more writes dated in the past. Anyone who reads the archive reads your cases and decisions, so store it as you would the data itself.

## Export one project

An instance admin can select a project by its key:

```
$ mainworthy export --project shop --out shop.ndjson.gz
exported to shop.ndjson.gz
```

The archive keeps that project's cases and versions, results and their attachment bytes, runs, questions, decisions, policies and command history.
Case aliases and custom field definitions in the policy travel with the project.
It preserves their IDs, head hashes and verdicts. It includes actors who acted in the project, signed its decisions,
or have a grant on it, and the people those actors act on behalf of. The policy's rule actor travels too. Their organisations, project grants and global
grants travel with them. Other projects, their grants, instance metadata and commands outside the project stay out.
Relevant teams, their memberships, grants on this project or every project, and history for that scope travel too. Other project team grants and their events stay out.
Tokens and other sign-in credentials never travel.

The HTTP equivalent is `GET /api/export?project=shop`, with the same instance admin requirement as a full export.
An unknown key is an error. Without `--project`, the command exports the whole instance, even when
`MAINWORTHY_PROJECT` is set. Import either archive into a fresh instance with the command below.
Import into an instance that already has data is still deferred.

## Export and verify an audit

A project admin can copy its retained decision history for a time range:

```sh
mainworthy audit export --project shop --from 2026-10-01T00:00:00Z --to 2026-10-15T00:00:00Z --out shop-audit.ndjson
mainworthy audit verify shop-audit.ndjson
```

`--from` includes the start and `--to` excludes the end. Dates are nonnegative Unix
milliseconds or ISO timestamps with a timezone. Omit both for all retained history
through the server's current snapshot. An end later than the snapshot time plus one
millisecond is refused. Export uses the selected project's admin capability and
writes a private file atomically. The file is plain NDJSON. The operation buffers
the reply in memory, so select a smaller period for large histories.

The registry equivalent is `audit { from, to }` at `POST /api/p/<project>/audit`.
Its JSON reply contains `format`, `project`, `records`, `sha256`, and `ndjson`.
The operation reads one consistent snapshot and records no write. The web UI has
no audit export control. `mainworthy audit verify <file>` needs neither a running
server nor a token. Exit code 0 means the file passed the structural checks. Invalid
files exit 4. `--json` prints the record count, checksum, number of before-range
references, and number of decisions without a recorded historical evidence hash.

### Audit format 1

Each line is canonical JSON with lexically sorted object keys and one LF. The file
uses UTF-8 without a byte-order mark and ends with an LF. The header has
`mainworthy: "audit"`, `format: 1`,
`project`, `from`, `to`, `exportedAt`, and the snapshot's project `seq`. It also
states `grantChanges: "team-history-only"`, `teamState: "at-export"`,
`evidencePayloads: "not-retained"`, and
`actorNames: "at-export"`.

Context records come first, sorted by id using English collation. Events follow,
ordered by time, sequence, and id using the same collation. Events without a
sequence sort as sequence zero. Verification refuses records outside this order.
English collation is JavaScript's `a.localeCompare(b, "en")`, not character order: it compares the digit runs
in an id as text but puts `:` before digits, so `version:1:2` comes before `version:12:1`. A verifier in
another language needs the same Unicode collation (ICU, locale `en`, default strength).
This file order does not imply that timestamps follow reference dependencies.
Each record has a `type` and a unique `id`:

| Type | Content |
| --- | --- |
| `question` | `question:<id>`, public `ref`, kind, fingerprint, `openedAt`, `openedSeq`, and prior question reference. Only referenced questions and their predecessors are included. |
| `evidence` | `evidence:<question-id>:<hash>`, question reference, and the recorded hash. This is a digest record, without the original input payload. |
| `result` | `result:<id>`, immutable test, target, commit, repository, environment, job, method, producer, outcome, signature, time and sequence for inherited head and base results. These context records can precede `from`. |
| `team` | `team:<id>`, name, creation time, current members and current grants on this project or every project. This is state at export time, including for a historical range. |
| `team-event` | `team-event:<id>`, time, team reference, actor, action, affected person, project and capabilities. Includes scoped grant changes and membership history in the range; these instance events have no project sequence. |
| `change-end` | `change-end:<change-id>`, change id, key, repository, ending time, and state, either `merged` or `closed`. Includes the retained ending for this project's changes when its time is in the range. No ending actor or sequence is retained. Reopening deletes the ending, and a later close replaces it. This is not a full change-state history. |
| `decision` | `decision:<id>`, time, sequence, kind, answer, basis hash, holds, effects, expiry, question, prior decision, evidence, signers, and typed `inherited` result and base references. Each signer retains its actor, clause, policy version, and reason. Withdrawals, expirations, and outdated decisions are included. |
| `answer` | `answer:<id>`, time, sequence, actor, question, answer, reason, whether it counted, and the exact evidence hash seen. Advice is included. |
| `policy` | `policy:<version>`, time, sequence, actor, preset, clauses, settings, previous policy, and adopting decision. The initial policy has no adopting decision. |
| `case-version` | `version:<case-id>:<version>`, public case ref, time, sequence, author, reason, full body, body and claim hashes, parent version, and adopting decision. |

An actor contains `id`, `name`, and `kind`. Names reflect the time of export and use
a pseudonym after forgetting. A reference is `{ scope: "included", id }` or
`{ scope: "before-range", id, at }`. Only event references can precede the range.
Their `at` must precede `from`. The exporter resolves the original event in the same
project before creating that marker. Question and evidence context always appear
inside the file.

Recorded evidence is `{ state: "recorded", hash, ref }`. A decision made before
migration 16 has `{ state: "not-recorded" }` because its exact seen-evidence hash was
not retained. Its material `basis` remains available. A policy change or case version
reaches its evidence through the adopting decision. The initial policy has none.

The footer is `{ end: true, records, sha256 }`. `records` counts context and event
records, excluding the header and footer. `sha256` covers every preceding UTF-8 byte,
including LFs. Verification refuses a leading byte-order mark and rejects unsupported
formats, unknown keys, noncanonical lines, records out of order, duplicate ids,
unresolved or wrongly typed references, invalid range markers,
reference cycles, skipped case or policy predecessors, decisions or answers before
their question's opening sequence, inconsistent evidence hashes, and changed case
body hashes. Record errors name the line and record id when it can be read.
Demo projects can date writes out of order, so a predecessor can appear later in
the event list. If a time range excludes a required demo predecessor that has a later
date, export fails and asks you to widen `--to`.

Verification checks the file's integrity and internal references. The checksum does
not authenticate its source or prove that every database record was exported. An
offline verifier cannot confirm old events outside the file or reconstruct original
evidence payloads. Team history covers teams with current or historical grants on
this project or every project. Other project grants and their events stay out.
Personal grant changes have no complete event history. An admin request sent with
a command id can leave a receipt with the actor, time, and outcome. These optional
receipts retain a request digest rather than the action and cannot reconstruct all
grant changes. They are not exported. Membership removal by forgetting has no
retained event history. Current team state cannot prove who was eligible to sign
in the past.
Signatures with
re-authentication and meaning, retention, legal hold, and recorded text redaction
remain absent. A passing file check is not a regulated conformance claim.

Migration 15 adds nullable decision evidence hashes to instance archives. It
preserves the current archive version because a missing hash imports as NULL and
exports as `not-recorded`. Older archive versions still need their matching build.

## Bring cases from another tool

Use `mainworthy import` with `--format csv`, `--format testrail`, or `--format qase`
to propose cases in the selected project. Unlike an archive import, this adds cases
to an existing project. Each file becomes one proposal under the project's policy.
Exit code 0 means adopted. Exit code 2 means the proposal needs attention; its reply
names the proposal and question. Accept it through the queue when the policy asks.

For custom column mappings and a server-side dry run, use
[Import cases from a mapped CSV](./import-cases.md). The snapshot commands below
keep their existing fixed-column behavior.

```sh
mainworthy import cases.csv --format csv --project checkout
mainworthy import testrail.csv --format testrail --project checkout
mainworthy import qase.csv --format qase --case-prefix PAY --project checkout
```

The file must use UTF-8, comma separators and a header row. Quoted cells may contain
commas, doubled quotes and line breaks. Each file is limited to 32 MB and 5,000 cases.
Mainworthy parses the whole file before sending it. A malformed file or an alias
already in use refuses the entire proposal. Imports create cases; they do not update
cases with matching foreign ids. Keep the proposal receipt if a connection fails,
and check the project before sending a file again, especially one without ids.

For a spreadsheet, use these exact headers. Only `title` is required.

| Header | Meaning |
| --- | --- |
| `id` | Foreign alias, such as `OLD123`. Leave empty if none exists. |
| `title` | Case title, from 1 to 300 characters. |
| `preconditions` | Preconditions as text. |
| `steps` | One action block, which may contain line breaks. |
| `expected` | Expected result for that action block. |
| `execution_type` | `manual`, `automated`, `to-be-automated`, or `not-applicable`. Empty means manual. |
| `folder` | Folder path, such as `Checkout/Coupons`. |
| `tags` | Comma-separated tags that follow Mainworthy's tag grammar. |

```csv
id,title,steps,expected,execution_type
OLD123,Apply coupon,Enter SAVE10,Total falls by 10%,to-be-automated
```

An automated case gets the `auto` method. A manual case gets `human`.
`to-be-automated` keeps `human` and sets automation intent to `wanted`;
`not-applicable` keeps `human` and sets intent to `not-applicable`.

TestRail CSV must include `ID` and `Title`. `C1234` remains an alias, so
`mainworthy get C1234` reads the imported case. Include `Section` and `Section Depth`
to recreate nested folders, including their parents. A section that holds no case of its own has no row in TestRail's export, so a section under it is placed under the section before it: check the folders after an import. Text steps use `Steps` and
`Expected Result`; separated steps use `Steps (Step)` and `Steps (Expected Result)`.
A following row with an empty id and title, or the same id and title, adds a step.
`Automation Type` uses the execution values above. If it is empty or absent,
`Type` equal to `Automated` selects `auto`; other testing types keep `human`.
`References` entries that are requirement keys become coverage links.

Qase CSV supports the older `id` header and the current `v2.id` header, with `title`.
Numeric ids become `QASE-123` by default. Pass the source project key with
`--case-prefix PAY` to keep an alias such as `PAY-123`. Suite definition rows and
`suite_id`, `suite_parent_id`, and `suite` become folder paths. The `automation`
slugs `is-not-automated`, `to-be-automated`, and `automated` map to the methods and
intent above. `steps_actions`, `steps_result`, and `steps_data` must have matching
numbered entries. Step data follows its action under `Data:`. Current v2 classic
steps decode their quoted JSON strings; Gherkin actions stay plain text. Child
steps become flat steps with paths such as `[1.1]` in their actions. Use v2 when
an older export has multiline step content that cannot be read as numbered lines.

Aliases are unique within a project and case-sensitive. They contain at most 120
ASCII letters, digits, `_`, `.`, `:`, `/`, or `-`, and start with a letter or digit.
An alias cannot be a bare number or start with `C-`, `Q-`, `R-`, `T-`, or `P-`,
in either letter case, because those names belong to Mainworthy.

An alias names the case to `get`, `history` and a typed result (`report` with `test: {case: "C1234"}`).
Report annotations and properties accept it too. For example, a JUnit test named
`signs in @C1234` or with the property `mainworthy=C1234` identifies the imported case.
Aliases keep their original letter case and resolve within the report's project.
See [Link tests to cases](./report-results.md#link-tests-to-cases) for the other formats and version claims.

Every source case column, including dates, descriptions, custom fields and any history
column, stays in the case body's `fields` as JSON under `import.<format>.row.<record>`.
Read it with `mainworthy get C1234 --md` or export the instance. Tags outside
Mainworthy's grammar stay there but do not become tags. The imported case starts
at version 1 with the importing actor and time; source metadata does not create
native revisions, results, actors, or decisions. The checked vendor CSV examples
contain snapshots, not revision history. XML, JSON, XLSX, attachments and replay
of earlier revisions or results are not supported by these case importers.

## Import into a new instance

Build bindings, artifact provenance and deployment history travel in archives.
Archives exported before those tables were added cannot import into this build.
Restore such an archive with the build that exported it. Existing databases
upgrade in place when the current server starts.

An import loads an archive into a new instance. A full archive restores every project, and a project archive restores only its selected project. It does not merge. The server keeps answering reads during the import; writes wait until it finishes.

1. Start a new instance and make nothing in it.
2. Run `mainworthy import` with the archive.

```
$ mainworthy import mainworthy.ndjson.gz
imported 67 rows across 36 tables
Import replaced the bootstrap rows. Your previous session may no longer exist. The configured local owner was refreshed.
```

A `.gz` suffix tells the command to decompress. The import checks the whole archive before it keeps anything: every row count, the checksum, each column and each link between records. If any check fails, nothing changes.

An instance that already has data refuses an import and keeps what it has:

```
$ mainworthy import mainworthy.ndjson.gz
conflict: import needs a fresh instance; existing projects or user data will not be replaced
```

A fresh instance is one that has only its first project, `scratch`, with no edits and no policy change, and only its owner. Making a token for a new person, agent or pipeline adds an actor, and that is enough to make the instance non-fresh. There is no merge yet, so to bring an archive into an instance that has data, start a new instance.

An archive imports into a build with the same archive version as the one that wrote it. The database schema may be newer: an added nullable column can stay compatible, and import fills a missing nullable, non-key column with NULL, even if it has a default. Missing required columns and unknown columns are refused. A migration that adds or removes exported tables, removes or renames exported columns, adds a column with a non-NULL default, or writes exported data changes the archive version. This includes backfills and transforms that leave the table shape unchanged. An archive with a newer version is refused with a message to upgrade; one with an older version is refused because Mainworthy cannot yet transform it. Use matching archive versions on both sides.

Attachments change the archive version to 11. Teams, memberships, team grants and their history change it to 12. Result-specific inherited excuses change it to 13, build bindings and deployments change it to 15, slot-specific dispute settlements change it to 17, and personal grant roles change it to 19. Migration 20 adds recovery contacts and changes the archive version to 20. Import preserves their addresses and verification status and clears pending mail links. To move older data forward, upgrade the original database and take a fresh export. If only an older archive remains, restore it with a matching older build first, then upgrade that database and export again.

Explicit empty-report declarations add a column to archived batches in schema 7. Import an older archive with the build that wrote it before upgrading that instance. Upgrading its SQLite database preserves existing records and adds the new tables and columns.

After an import in server mode, the tokens are gone, because the archive carries none. It carries no password, passkey or invitation either: an archive holds nothing that signs somebody in. The people, agents and pipelines are still there with their grants. Restart the server to sign in: with no owner token configured it prints a new one, and with `MAINWORTHY_OWNER_TOKEN` set it takes that value. Then make new tokens for the others with `mainworthy token new`, and as the owner invite each person again with `mainworthy invite new <name>`, which for a person who exists prints a recovery link. In local mode, Mainworthy refreshes the owner and you can carry on.

## Back up

Run an export on a schedule, from any machine that can reach the server, and keep the files somewhere other than the server.

```
$ MAINWORTHY_URL=https://mainworthy.example.com MAINWORTHY_TOKEN=<token> \
    mainworthy export --out backup-2026-10-13.ndjson.gz
exported to backup-2026-10-13.ndjson.gz
```

Test a backup now and then by importing it into a throwaway instance. A backup you never restored is a guess.

A second way is to copy the data directory. Stop the server first, then copy the whole directory, including the `-wal` and `-shm` files. A copy keeps the tokens, which an export does not. Start a server with `MAINWORTHY_DATA` pointing at the copy and it comes up with the same cases, tokens and decisions. In the container, back up the volume the same way, with the container stopped.

## Move to another machine

Moving is an export on the old machine and an import on the new one.

1. On the old machine, run `mainworthy export --out mainworthy.ndjson.gz`.
2. Copy the file to the new machine.
3. On the new machine, install the same version of Mainworthy. Start a server with an empty data directory. In server mode, set `MAINWORTHY_OWNER_TOKEN`.
4. Run `mainworthy import mainworthy.ndjson.gz`.
5. Restart the server, so the owner token you set becomes a token.
6. Make new tokens for agents and pipelines, put them into your CI secrets and agent settings, and point `MAINWORTHY_URL` at the new address.
7. Stop the old server when everything reports to the new one.

If you want to keep the tokens, stop the server and copy the data directory instead, as described under backups.

## See also

- [Configuration](./configuration.md) for `MAINWORTHY_DATA` and the owner token.
- [People, agents and pipelines](./access.md) for making tokens again.
- [Command line](./cli.md) for the flags of `export` and `import`.
