# Your data

Find your data, export it to a text file, back it up and move it to another machine. Your cases, results and decisions are yours, and you can take them out at any time.

## Where the data lives

Mainworthy keeps structured records in PostgreSQL 18, selected by `MAINWORTHY_DATABASE_URL`.
`compose.yaml` starts that database with its own named volume. Running elsewhere is possible but not yet supported.
Attachment bytes live in `blobs/` and archive transfers use `spool/` in the app data directory.
That directory defaults to `~/.mainworthy`, or `/data` in the container. Set `MAINWORTHY_DATA` to change it.

PostgreSQL controls database storage, access and write-ahead logging. Mainworthy no longer opens a SQLite file,
creates upgrade copies, runs reader or checkpoint threads, or locks a local database directory.
A copied app volume alone is not a database backup. Secure and back up both PostgreSQL and local attachments.

Startup installs the PostgreSQL baseline under a migration advisory lock, then recovers pending work.
During startup, `/healthz` answers HTTP 200 with `ok: false` and `state: "upgrading"`.
Other requests receive HTTP 503 with `Retry-After: 5` until ready. Readiness requires `ok: true`.

The PostgreSQL conversion starts with an empty database. Existing SQLite records do not move automatically into PostgreSQL.
The old SQLite file remains untouched on its volume. Its identities, tokens and sessions do not sign in to
the new database. There is no automatic data conversion or upgrade-copy rollback.

On `SIGTERM` or `SIGINT`, the server stops accepting connections and closes change streams. Requests in flight
have five seconds to send their replies before remaining connections close. The server then closes its database
pools. If a write loses its reply, retry with the same command id, `cmd`, so it is not applied twice.

Exports stage the whole archive before sending it. Imports stage the upload before reading it.
Leave space for concurrent transfers. Temporary directories and archive files are private to the server user.
Completed, cancelled and rejected transfers remove their files. A killed process can leave files in `spool/`;
after stopping the server, you can remove that directory.

The database holds every project, case and version, every result, decision and policy, and the actors, grants and a hash of each token. Treat it like the data of any private system. What it keeps about people, and for how long, is on the [privacy](./privacy.md) page.

Attachment files use their SHA-256 hash as the file name. Identical content shares
one disk file, even across results. Back up `blobs/` with the database. A database
copy alone cannot restore attachments. Archives include the file bytes as base64
on attachment rows, covered by the archive checksum. Import validates each file's
hash, size and content type. An export refuses missing or damaged files rather
than writing an incomplete backup.

There is no automatic evidence expiry or total disk quota. Monitor free space and
include retained attachments and archive staging files in storage planning. A
failed write or import can leave unreferenced blob files. Startup removes these
before recovering accepted reports. Referenced evidence is kept when a producer
is forgotten. File contents and file names may contain personal information and
are not scanned or redacted.

## Recover from an unverifiable assertion cause

If startup prints `invalid: cannot reconstruct assertion root <id>` and exits, a stored
assertion cause's hash matches neither its normalized text nor a verified file-split cause.
The server stops before serving requests because it cannot rebuild the assertion index
from that evidence. Import refuses an archive with the same inconsistency and rolls back.

1. Stop the app and preserve PostgreSQL plus the attachment directory. Follow [Back up](#back-up).
2. Keep the exact error, signature id and image commit that refused to start.
3. Restore a tested database backup and its attachments to an isolated instance, or import a matching archive
   into a fresh PostgreSQL database. Check its evidence before directing traffic to it.

Without a tested backup, keep the preserved data and request a repair of the named
signature. There is no automatic repair command for this error. Changing hashes or
deleting evidence to force startup bypasses the consistency check rather than repairing
the recorded cause.

## Export everything

To export the whole instance, run the following command as an instance admin. In server mode, supply an admin token with `--token` or `MAINWORTHY_TOKEN`. The export works while the server runs, and the archive is one consistent snapshot. Other requests keep running while Mainworthy prepares the archive. A whole-instance export is refused while retired demo cleanup is pending. Retry after cleanup. Exporting an active project remains available. This prevents a restore from bringing back retired data without its local cleanup mark.

```
$ mainworthy export --out mainworthy.ndjson.gz
exported to mainworthy.ndjson.gz
```

A file name that ends in `.gz` is compressed, and any other name is plain text. Mainworthy makes the file readable only by you. It builds the file beside the destination and renames it when the export is complete. A failed export therefore leaves an earlier backup alone. The web UI has no export button.

The archive is text, one JSON object per line. The first line describes the archive. Each row of data follows on a line of its own. The last line holds a row count and a SHA-256 checksum of everything before it.

```
$ head -n 1 mainworthy.ndjson | cut -c 1-80
{"mainworthy":"archive","format":1,"schema":43,"exportedAt":1791875678677,"tables
$ tail -n 1 mainworthy.ndjson
{"end":true,"rows":67,"sha256":"ca0a5d4d76fe0de47415d595159393df3fad4fc517e4227325a4e5b5ca6b9cf7"}
```

You can read the archive with any tool that reads text or search it with `grep`. If the data is suitable for version control, you can keep the archive there.

The archive holds attachment bytes along with the database records, and actors, personal and team grants, memberships, team history, recovery addresses and their verification status. It leaves out tokens, sessions, passwords, passkeys, authenticators, passkey handles and invitations. It also leaves out the search and assertion-presence indexes. Mainworthy rebuilds both on import. Tracker delivery requests are excluded, so restoring an archive never sends an issue again.

The archive leaves out which changes have ended. After an import every change is open. Questions that were closed when a change ended stay closed. If a failure on such a change is reported again, use `mainworthy change` to record again that the change ended.

The archive also leaves out which project is a [demo](./customize.md#a-project-of-demo-data). An imported demo keeps its data and its dates, and accepts no more writes dated in the past. Anyone who reads the archive reads your cases and decisions, so store it as you would the data itself.

## Export one project

To export one project, run the following command as an instance admin with the project's key:

```
$ mainworthy export --project shop --out shop.ndjson.gz
exported to shop.ndjson.gz
```

The archive keeps that project's cases and versions, results and their attachment bytes, runs, questions, decisions, policies and command history.
Case aliases and custom field definitions in the policy are included in the archive.
The archive preserves IDs, head hashes and verdicts. It includes actors who acted in the project, signed its decisions,
or have a grant on it. The archive also includes the people those actors act on behalf of. The policy's rule actor travels too. Their organisations, project grants and global
grants travel with them. Other projects, their grants, instance metadata and commands outside the project stay out.
Relevant teams, their memberships, grants on this project or every project, and history for that scope travel too. Other project team grants and their events stay out.
Recovery addresses and their verification status travel for the included people. Pending verification and reset links never travel. Tokens and other sign-in credentials never travel.

The HTTP equivalent is `GET /api/export?project=shop`, with the same instance admin requirement as a full export.
An unknown key is an error. Without `--project`, the command exports the whole instance, even when
`MAINWORTHY_PROJECT` is set. Import either archive into a fresh instance with the command below.
Import refuses an instance that already has data.

Archives preserve structured proposal-conflict addresses and recorded project command replies.
A matching imported command can still be retried with its original command id.
The archive must match this build's archive schema; older archive schemas are refused.

## Export and verify an audit

A project admin can export retained decision history for a time range. Run the export command, then verify the saved file:

```sh
mainworthy audit export --project shop --from 2026-10-01T00:00:00Z --to 2026-10-15T00:00:00Z --out shop-audit.ndjson
mainworthy audit verify shop-audit.ndjson
```

`--from` includes the start and `--to` excludes the end. Dates are nonnegative Unix
milliseconds or ISO timestamps with a timezone. Omit both for all retained history
through the server's current snapshot. An end later than the snapshot time plus one
millisecond is refused. The export uses the selected project's admin capability and
writes a private file atomically. The file is plain NDJSON. The operation buffers
the reply in memory. For large histories, select a smaller period.

The registry equivalent is `audit { from, to }` at `POST /api/p/<project>/audit`.
Its JSON reply contains `format`, `project`, `records`, `sha256`, and `ndjson`.
The operation reads one consistent snapshot and records no write. The web UI has
no audit export control. `mainworthy audit verify <file>` needs neither a running
server nor a token. Exit code 0 means the file passed the structural checks. Invalid
files exit 4. `--json` prints the record count, checksum, number of before-range
references, and number of decisions without a recorded historical evidence hash.

Quarantine decisions retain the test ref, prior quarantine decision and exit rule
in their immutable effects, including manual exits and replaced entries. Their
signers retain the person's reason. The current quarantine row is not a historical
audit record.

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
English collation uses JavaScript's `a.localeCompare(b, "en")` rather than character order.
It compares the digit runs in an id as text but puts `:` before digits.
For example, `version:1:2` comes before `version:12:1`.
A verifier in another language needs the same Unicode collation, using ICU with locale `en` and default strength.
This file order does not imply that timestamps follow reference dependencies.
Each record has a `type` and a unique `id`:

| Type | Content |
| --- | --- |
| `question` | `question:<id>`, public `ref`, kind, fingerprint, `openedAt`, `openedSeq`, and prior question reference. Only referenced questions and their predecessors are included. |
| `evidence` | `evidence:<question-id>:<hash>`, question reference, and the recorded hash. This is a digest record, without the original input payload. |
| `result` | `result:<id>`, immutable test, target, commit, repository, environment, job, method, producer, outcome, signature, time and sequence for inherited head and base results. These context records can precede `from`. |
| `team` | `team:<id>`, name, creation time, current members and current grants on this project or every project. This is state at export time, including for a historical range. |
| `team-event` | `team-event:<id>`, time, team reference, actor, action, affected person, project and capabilities. Includes scoped grant changes and membership history in the range. These instance events have no project sequence. |
| `change-end` | `change-end:<change-id>`, change id, key, repository, ending time, and state, either `merged` or `closed`. Includes the retained ending for this project's changes when its time is in the range. No ending actor or sequence is retained. Reopening deletes the ending, and a later close replaces it. This is not a full change-state history. |
| `merge-receipt` | `merge-receipt:<id>`, change id and key, reporting actor, server report time and sequence, and the frozen head gate. The receipt is a bounded manifest with its gate summary, result and evidence counts, and content hash. Frozen results and gate collections are exported in separate bounded pages; supporting decision ids refer to the immutable decision ledger. All retained receipts in range are included, even after a corrected head, reopening or closing clears their active selection. The time is when the merge was reported, not when it happened. |
| `decision` | `decision:<id>`, time, sequence, kind, answer, basis hash, holds, effects, expiry, question, prior decision, evidence, signers, and typed `inherited` result and base references. Each signer retains its actor, clause, policy version, and reason. Withdrawals, expirations, and outdated decisions are included. |
| `answer` | `answer:<id>`, time, sequence, actor, question, answer, reason, whether it counted, and the exact evidence hash seen. Advice is included. |
| `policy` | `policy:<version>`, time, sequence, actor, preset, clauses, settings, previous policy, and adopting decision. The initial policy has no adopting decision. |
| `case-version` | `version:<case-id>:<version>`, public case ref, time, sequence, author, reason, full body, body and claim hashes, parent version, and adopting decision. |

A range export contains receipt manifests, not their result payloads. For every receipt you
need, export evidence pages separately. The full-history decision export retains the immutable
answers, signers, holds, basis and expiry that result standings reference; a narrow time range
may omit an earlier decision, so keep that earlier history too.

```sh
mainworthy audit export --out receipt-12-page-1.ndjson --receipt 12 --limit 50 --json
mainworthy audit export --out receipt-12-page-2.ndjson --receipt 12 --cursor 12.evidence.49 --limit 50 --json
```

Use each reply's cursor until it is null; do not construct it from the example. Each file is
independently verifiable with `audit verify`. The API reply also names `snapshot` and
`evidenceCount`. A page has at most 50 members and 64 KiB of source evidence. Each
`merge-evidence` record carries receipt id, ordinal, kind (`result` or `gate`), body and
full SHA-256 of its UTF-8 body. Order all members by ordinal; require exactly
`evidenceCount` contiguous ordinals starting at zero, with gate records first and result records ordered
by numeric result id. The unpublished flat-list hash has been replaced by this v2 canonical tree hash:

- Recompute each body's SHA-256 and require it to match the record's `hash`.
- Build separate radix-32 trees for results and gate records. Result keys are their frozen numeric `result`
  ids; gate keys are zero-based positions among gate records. Keys must be unique nonnegative safe integers.
- A leaf, level 0, groups keys by `floor(key / 32)`. Its entries, ordered by `key % 32`, are
  `[slot, bodyHash, 1]`. Hash the UTF-8 JSON array `["mainworthy.receipt.node.v2",0,entries]`, without spaces.
- Group the resulting nodes by the same rule for levels 1 through 10. Each entry is
  `[childKey % 32, childHash, childMemberCount]`; its parent key is `floor(childKey / 32)`.
  Hash `["mainworthy.receipt.node.v2",level,entries]`. Missing children have no entry; omit empty nodes.
  The count of a branch is the sum of its child counts. After level 10 there is one root per nonempty tree.
- An empty tree has a null root hash. Hash `["mainworthy.receipt.snapshot.v2",resultRootHash,gateRootHash]`
  with the same JSON encoding and require it to equal `snapshot`.

This reconstructs roots from exported bytes, independently of database node ids or edit history. All
numbers and slots use numeric order. Completeness requires both the counts and root hash to match.
Verifying one page alone does not establish bundle completeness. The `result` body is JSON with frozen result fields and its
supporting decision id and displayed answer. Gate bodies are JSON frames: `collection: open`
contains numbered `part` text chunks which join to the original blocking-ref JSON array;
`collection: waiting` contains one complete shard-wait `item`. Exports and reads never
recompute historical standings. A manifest alone is not a complete receipt evidence export.

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
including LFs. Verification refuses a leading byte-order mark. It also rejects the following:

- Unsupported formats.
- Unknown keys.
- Noncanonical lines.
- Records out of order.
- Duplicate ids.
- Unresolved or wrongly typed references.
- Invalid range markers.
- Reference cycles.
- Skipped case or policy predecessors.
- Decisions or answers before their question's opening sequence.
- Inconsistent evidence hashes.
- Changed case body hashes.

Record errors name the line and record id when it can be read.
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
Mainworthy has no signatures with re-authentication and meaning, retention, legal hold, or recorded text redaction.
A passing file check is not a regulated conformance claim.

Migration 16 adds nullable decision evidence hashes to instance archives. It
preserves the current archive version because a missing hash imports as NULL and
exports as `not-recorded`. Older archive versions still need their matching build.

## Bring cases from another tool

Use `mainworthy import` with `--format csv`, `--format testrail`, or `--format qase`
to propose cases in the selected project. Unlike an archive import, this adds cases
to an existing project. Each file becomes one proposal under the project's policy.
Exit code 0 means adopted. Exit code 2 means the proposal needs attention. The reply
names the proposal and question. Accept it through the queue when the policy asks.

For custom column mappings and a server-side dry run, use
[Import cases from a mapped CSV](./import-cases.md). The commands below
use fixed column mappings.

```sh
mainworthy import cases.csv --format csv --project checkout
mainworthy import testrail.csv --format testrail --project checkout
mainworthy import qase.csv --format qase --case-prefix PAY --project checkout
```

The file must use UTF-8, comma separators and a header row. Quoted cells may contain
commas, doubled quotes and line breaks. Each file is limited to 32 MB and 5,000 cases.
Mainworthy parses the whole file before sending it. It refuses the entire proposal
if the file is malformed or an alias is already in use. Imports create cases. They do not update
cases with matching foreign ids. If a connection fails, keep the proposal receipt.
Before sending a file again, check the project, especially if the file has no ids.

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
`to-be-automated` keeps `human` and sets automation intent to `wanted`.
`not-applicable` keeps `human` and sets intent to `not-applicable`.

TestRail CSV must include `ID` and `Title`. `C1234` remains an alias, so
`mainworthy get C1234` reads the imported case. Include `Section` and `Section Depth`
to recreate nested folders, including their parents. A section that holds no case of its own has no row in TestRail's export.
If a parent section has no row, the importer places its child under the preceding section. Check the folders after an import.
Text steps use `Steps` and `Expected Result`. Separated steps use `Steps (Step)` and `Steps (Expected Result)`.
A following row with an empty id and title, or the same id and title, adds a step.
`Automation Type` uses the execution values above. If it is empty or absent,
`Type` equal to `Automated` selects `auto`. Other testing types keep `human`.
`References` entries that are requirement keys become coverage links.

Qase CSV supports the older `id` header and the current `v2.id` header, with `title`.
Numeric ids become `QASE-123` by default. Pass the source project key with
`--case-prefix PAY` to keep an alias such as `PAY-123`. Suite definition rows and
`suite_id`, `suite_parent_id`, and `suite` become folder paths. The `automation`
slugs `is-not-automated`, `to-be-automated`, and `automated` map to the methods and
intent above. `steps_actions`, `steps_result`, and `steps_data` must have matching
numbered entries. Step data follows its action under `Data:`. Current v2 classic
steps decode their quoted JSON strings. Gherkin actions stay plain text. Child
steps become flat steps with paths such as `[1.1]` in their actions. Use v2 when
an older export has multiline step content that cannot be read as numbered lines.

Aliases are unique within a project and case-sensitive. They contain at most 120
ASCII letters, digits, `_`, `.`, `:`, `/`, or `-`, and start with a letter or digit.
An alias cannot be a bare number or start with `C-`, `Q-`, `R-`, `T-`, or `P-`,
in either letter case, because those names belong to Mainworthy.

An alias names the case to `get`, `history` and a typed result sent through `report` with `test: {case: "C1234"}`.
Report annotations and properties accept it too. For example, a JUnit test named
`signs in @C1234` or with the property `mainworthy=C1234` identifies the imported case.
Aliases keep their original letter case and resolve within the report's project.
See [Link tests to cases](./report-results.md#link-tests-to-cases) for the other formats and version claims.

Every source case column, including dates, descriptions, custom fields and any history
column, stays in the case body's `fields` as JSON under `import.<format>.row.<record>`.
Read it with `mainworthy get C1234 --md` or export the instance. Tags outside
Mainworthy's grammar stay there but do not become tags. The imported case starts
at version 1 with the importing actor and time. Source metadata does not create
native revisions, results, actors, or decisions. The checked vendor CSV examples
contain snapshots, not revision history. XML, JSON, XLSX, attachments and replay
of earlier revisions or results are not supported by these case importers.

Parser diagnostics from `mainworthy import --format csv|testrail|qase` quote external values and escape terminal
control characters. Long suite and step-type identifiers are shortened; invalid execution-type diagnostics keep
the full value and correction guidance. A CSV read failure shows the quoted filename and filesystem error code.
All CLI errors fold CR/LF runs into `; ` and escape other controls. Imported case content stays unchanged.
Human-readable CSV previews also escape controls in case titles, folders, aliases
and refusal messages. CLI warnings, receipts and Markdown output apply the same
terminal protection. Canonical Markdown keeps its line breaks and encodes controls
and command prefixes reversibly, so parsing `get --md` or `fmt` output recovers the
original values.

## Import into a new instance

Build bindings, artifact provenance and deployment history travel in archives.
Archives exported before those tables were added cannot import into this build.
Restore such an archive with the build that exported it. An archive must use format 1 and schema 43 and pass the current table, column and evidence checks.

An import loads an archive into a new instance. A full archive restores every project, and a project archive restores only its selected project. Import does not merge data. The server keeps answering reads during the import. Writes wait until the import finishes.

Browser-initiated imports require recent proof of the caller's own credential in
that session, checked again after upload before import begins. An expired proof
returns `recent_proof_required`; prove again and retry. Bearer-token CLI and local
imports keep their existing operator authority.

To import an archive, follow these steps:

1. Start a new instance, and make no changes before importing, apart from the sign-in a browser import needs (step 2).
2. Run `mainworthy import` with the archive. The CLI imports with a bearer token or in local mode, so it needs no recent proof. To import from a browser session instead, first set the owner's password and prove it with `POST /api/account/proof`.

```
$ mainworthy import mainworthy.ndjson.gz
imported 67 rows across 36 tables
Import replaced the bootstrap rows. Your previous session may no longer exist. The configured local owner was refreshed.
```

A `.gz` suffix tells the command to decompress. Before keeping anything, the import checks every row count, the checksum, each column and each link between records in the archive. If any check fails, nothing changes.

Import refuses result and runner-try durations outside the report input range of zero through 30 days (2,592,000,000 ms), inclusive. The error names the table, row, archive line and permitted range. Missing or NULL stored durations remain unknown. Pending reports must pass the per-result input checks, including each runner try, before import can recover them. Import does not check report-level batch limits. Import refuses the whole archive rather than changing its evidence; this also applies when importing an archive backup.

Import also refuses a failure question whose stored subject cannot be read by the inbox. The error names `questions.subject`, the row and the archive line. The whole import rolls back.

**A successful export can produce a backup that this build refuses to import.** Before the report limit added on 2026-10-22, reports could store durations above 30 days. Export preserves those values. When exported duration columns contain invalid values, the CLI warns on stderr after saving the file. HTTP export returns the warning in `X-Mainworthy-Archive-Warning`. Neither changes the archive's evidence.

Keep the original archive. To retain every timing measurement, restore an isolated PostgreSQL backup as described under [Back up](#back-up). To make an importable archive by discarding invalid timings, first stop the app and back up PostgreSQL and its attachments. Restore into an isolated database, keeping the original unchanged. Open the restored database with `psql` and inspect the affected rows:

```sql
SELECT 'results' AS table_name, id, duration_ms FROM results
WHERE duration_ms IS NOT NULL AND
  duration_ms NOT BETWEEN 0 AND 2592000000
UNION ALL
SELECT 'result_tries', id, duration_ms FROM result_tries
WHERE duration_ms IS NOT NULL AND
  duration_ms NOT BETWEEN 0 AND 2592000000;
```

If you accept losing these timing measurements, set only those values to NULL on the copy. Their durations become unknown; the results and tries remain:

```sql
BEGIN;
UPDATE results SET duration_ms = NULL
WHERE duration_ms IS NOT NULL AND
  duration_ms NOT BETWEEN 0 AND 2592000000;
UPDATE result_tries SET duration_ms = NULL
WHERE duration_ms IS NOT NULL AND
  duration_ms NOT BETWEEN 0 AND 2592000000;
COMMIT;
```

Start the isolated app with `MAINWORTHY_DATABASE_URL` pointing at the restored database and its own attachment directory, export again and test import into a throwaway instance. These queries change only the two stored duration columns. A pending report can still fail its per-result checks; its error names the offending field.

An instance that already has data refuses an import and keeps what it has:

```
$ mainworthy import mainworthy.ndjson.gz
conflict: import needs a fresh instance; existing projects or user data will not be replaced
```

A fresh instance has only its first project, `scratch`, and its owner. That project has no edits and no policy change. Making a token for a new person, agent or pipeline adds an actor, and that is enough to make the instance non-fresh. There is no merge yet. To bring an archive into an instance that has data, start a new instance.

An archive imports into a build with the same archive version as the one that wrote it. The database schema may be newer. An added nullable column can stay compatible. Import fills a missing nullable, non-key column with NULL, even if the column has a default. Import refuses missing required columns and unknown columns.

A migration changes the archive version if it adds or removes exported tables, removes or renames exported columns, or adds a column with a non-NULL default. Writes to exported data also change the archive version, including backfills and transforms that leave the table shape unchanged.

An archive with a newer version is refused with a message to upgrade. An archive with an older version is refused because Mainworthy cannot yet transform it. Use matching archive versions on both sides.

This build uses archive format 1 and schema 43. Import validates the table and column shapes and the evidence
before committing. It does not open or convert a SQLite database file. Preserve the original database and a
matching executable for archives whose older schema this build refuses.

After an import in server mode, the tokens are gone, because the archive carries none. It carries no password, passkey, authenticator or invitation either. The people, agents and pipelines are still there with their grants. Verified recovery addresses stay verified; with configured mail, they can authorize a password reset.

To restore access in server mode, follow these steps:

1. Restart the server. With no owner token configured, the server prints a new one. With `MAINWORTHY_OWNER_TOKEN` set, the server uses that value.
2. Make new tokens for the others with `mainworthy token new`.
3. As the owner, invite each person again with `mainworthy invite new <name>`. For an existing person, the command prints a recovery link.

In local mode, Mainworthy refreshes the owner and you can carry on.

## Back up

Run an export on a schedule, from any machine that can reach the server. Keep the files somewhere other than the server.

```
$ MAINWORTHY_URL=https://mainworthy.example.com MAINWORTHY_TOKEN=<token> \
	mainworthy export --out backup-2026-10-13.ndjson.gz
exported to backup-2026-10-13.ndjson.gz
```

Test a backup by importing it into a throwaway instance before you rely on it.

To preserve tokens, sessions and credentials too, back up PostgreSQL and attachment bytes together.

1. Stop the app while leaving PostgreSQL running, so attachment files match the database snapshot.
2. Dump PostgreSQL with `pg_dump` and copy the app's `blobs/` directory. In Compose, use
   `docker compose exec -T postgres pg_dump -U mainworthy -d mainworthy -Fc > mainworthy.dump`.
3. Restore the dump into an isolated PostgreSQL 18 database with `pg_restore`, restore its matching `blobs/`,
   and start the same app version with that database URL and attachment directory.
4. Check the restored cases, tokens and attachments before using the backup for recovery.

Do not copy a running PostgreSQL data directory as if it were an ordinary file. Use PostgreSQL backup tools.

## Move to another machine

To move your data, export on the old machine and import on the new one:

1. On the old machine, run `mainworthy export --out mainworthy.ndjson.gz`.
2. Copy the file to the new machine.
3. On the new machine, install the same version of Mainworthy.
4. In server mode, set `MAINWORTHY_OWNER_TOKEN`.
5. Start a server with an empty PostgreSQL database and a separate attachment directory.
6. Run `mainworthy import mainworthy.ndjson.gz`.
7. Restart the server, so the owner token you set becomes a token.
8. Make new tokens for agents and pipelines.
9. Put the tokens into your CI secrets and agent settings.
10. Point `MAINWORTHY_URL` at the new address.
11. When everything reports to the new server, stop the old server.

To keep tokens, restore a PostgreSQL backup and its matching attachment directory, as described under backups.

## See also

- [Configuration](./configuration.md) for `MAINWORTHY_DATA` and the owner token.
- [People, agents and pipelines](./access.md) for making tokens again.
- [Command line](./cli.md) for the flags of `export` and `import`.
