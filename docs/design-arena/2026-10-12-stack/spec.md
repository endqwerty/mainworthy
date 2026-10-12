# Stack arena: spike specification (every candidate gets this file plus one seed)

You are one of three independent candidates. Each builds the **same spike** on
a **different stack** so the lead can choose Casebook's language, runtime and
data store from measurements. Do not read other candidates' directories.

Casebook is a test case management system: versioned cases, results from
people, CI and agents in one stream, and a queue of decisions. Read (read-only)
in `/home/endqwerty/.t3/worktrees/casebook/t3-639b4b0f`:
`docs/decisions/0001-stack-open.md` (the selection criteria),
`docs/decisions/0002-layered-self-hosting.md`, and `docs/product-design.md`
sections 6.6 (access patterns and budgets) and 7.1 (the operation registry).
Do not write anything in that repository.

What the owner said on 2026-10-11: he knows TypeScript best, Python well and
Go a little, "but if another language is decidedly better, we want to use the
correct language rather than what I know". First deployment is one container
on his home server (Coolify on Unraid); later a hosted tier on AWS or GCP must
be viable and it must grow to any number of users and teams. A container is
acceptable for every layer; a native single binary is a bonus, not a
requirement. Agents will write most of the code.

## Shared, fixed inputs (do not regenerate; copy them)

Directory `/home/endqwerty/.cache/casebook-arena/stack/`:

- `schema.sqlite.sql`, `schema.pg.sql` + `schema.pg.indexes.sql`: the schema.
  You may add indexes or settings; list every change in your report.
- `seed.db`: SQLite database, 470 MB: 100,000 cases (149,766 versions), 500
  folders, 20,000 tests (ids 1 to 15,000 linked to the case with the same id),
  200 targets, batches and runs, 1,000,000 results, 40 signatures, 60,000
  questions (50,000 open), `project.seq` = 219,966. **Copy it** to your
  directory before every run that writes (`cp seed.db <yours>/work.db`).
- PostgreSQL 18.4 on `127.0.0.1:54329`, user `postgres`, no password, with the
  identical data in template database `cb_seed`. Reset your own database with
  `psql -h 127.0.0.1 -p 54329 -U postgres -c 'drop database if exists cb_<you>' -c 'create database cb_<you> template cb_seed'`
  (never connect to `cb_seed` itself; a template cannot be copied while in use).
  New ids on PostgreSQL: `nextval('ids')`. Server settings are production-like
  (`synchronous_commit=on`, `shared_buffers=1GB`). Do not change server
  settings; per-session settings are allowed and must be reported.
- `queries.txt`: 500 search queries (one per line; words in a line are ANDed).
- Body shape of a case version (`version.body`, JSON text):
  `{title, pre, steps:[{id, action, expected|null}], methods, intent, fields}`.

Machine: 16 cores, 31 GB RAM, btrfs on an encrypted NVMe. Other candidates are
running at the same time, so **your own timings are provisional**. The lead
re-runs every candidate serially with your `run.sh`. Keep durability honest:
SQLite in WAL mode with `synchronous=NORMAL` or stricter (say which);
PostgreSQL with `synchronous_commit=on`. No in-memory databases, no tmpfs.

## What to build

A small server in your stack with two store modes selected by configuration:
**embedded** (SQLite file, in process) and **server** (PostgreSQL). One code
path for the workloads; the store differences live behind one small interface.
Then a benchmark driver that runs the workloads below against a real HTTP
listener on loopback (keep-alive connections) and also reports the in-process
store time where your stack makes that easy.

### Workloads

Each one: warm up 100 iterations, then the stated iterations; report p50, p95,
p99 and max in milliseconds, the error count, and one correctness assertion
that proves the work happened (for example the row count returned or written).

| ID | Workload | Iterations | Budget |
| --- | --- | --- | --- |
| W1 | Read one case by `ref_no` (random): the `kase` row plus its head `version` body, as JSON | 2,000 | p95 < 20 ms |
| W2 | List a folder page (random leaf folder, ids 21 to 500): 50 `kase` rows by `(project, folder, rank)` after a random rank cursor, plus per-row glyph data in at most three batched reads: linked test count per case, open question count for the project (index only), last result outcome per linked test | 1,000 | p95 < 50 ms |
| W3 | Search: full-text match of one line of `queries.txt` scoped to project 1, top 50 by relevance, returning case id, ref, title, folder (20% of iterations also filter to one top-level area's 24 folders) | 500 | p95 < 100 ms |
| W4 | Seal-save one case in **one transaction**: insert a `command` row (primary key = client command id; a repeated id must return the stored outcome and write nothing), bump `project.seq`, insert a `question` (kind adopt, decided) and a `decision`, insert the new `version` (body about 600 bytes, new content), update `kase` head/title/hash/rev, replace the full-text document. Then prove idempotency by replaying 20 of the commands | 1,000 | p95 < 50 ms |
| W5 | Ingest a 10,000-result report in **one transaction**: input is an in-memory array of `{key, outcome, durationMs, message?}`; 9,900 keys exist and 100 are new tests (insert them); 200 results fail with 20 distinct messages (upsert `signature` by hash of the normalised message; 10 are new); insert a `target`, a `batch` (unique key; a replay of the same batch must be a no-op) and 10,000 `result` rows with basis `assumed` + the case's `head_no` when the test is linked, else `unresolved`; raise one `question` per signature not already open (lookup by fingerprint); upsert the `run` row for the commit with a tally; bump `project.seq` once | 20 (fresh keys each time) | < 2,000 ms each |
| W5a | Parse a JUnit XML file with 10,000 `<testcase>` elements (generate it once; 200 with `<failure>` bodies of about 400 bytes) into the W5 input array | 20 | report |
| W6 | Last 20 results for a random test (`(project, test, seq DESC)`) | 2,000 | p95 < 20 ms |
| W7 | Gate read: the `run` row by `(project, commit_sha)` (random of the 200) | 2,000 | p95 < 20 ms |
| W8 | Queue page: first 50 open questions by `(project, state, owner, rank)` with their evidence, plus the count of open questions | 1,000 | p95 < 50 ms |
| W9 | Mixed concurrency: 16 concurrent HTTP clients loop W1, W2, W6, W7, W8 (equal mix) for 20 s **while** one client runs W5 ingests back to back and one runs W4 saves back to back. Report read p50/p95/p99, reads/s, ingest ms and save p95 during the mix | 20 s | reads p95 < 50 ms, ingest < 2 s |

Also report: cold start (process start to first successful HTTP response, ms,
median of 5), resident memory after the run (MB), size of the deployable
artifact (single binary or container-ready bundle, MB), time for a clean
build, lines of code you wrote, number of direct dependencies.

Run W1 to W9 in **both** store modes. If time is short, the order of priority
is: embedded W1 to W8, server W1 to W8, W9 in both, the registry proof, then
the extras in your seed.

### Registry proof (the "one operation layer" criterion)

Declare three operations **once** in a registry with input and output
schemas: `get` (W1), `propose` (W4) and `report` (W5). From that single
declaration, with no hand-written per-surface code per operation, expose:

1. HTTP routes plus a generated OpenAPI 3.1 document;
2. an MCP server over stdio using the maintained MCP SDK for your language
   (name the SDK and the protocol revision it implements); show `tools/list`
   and one `tools/call`, and report the byte size of the `tools/list` result;
3. CLI subcommands with generated `--help`.

State what adding a fourth operation would touch (files and lines).

## Deliverables in your output directory

- The spike source.
- `run.sh`: one command that builds if needed, resets the working data, runs
  every workload in both modes and writes `results.json`
  (`{ stack, mode: { embedded: { W1: { p50, p95, p99, max, errors, check }, ... }, server: {...} }, extras: {...} }`).
  It must run unattended in under 10 minutes and must not need root or Docker.
- `REPORT.md` (at most 200 lines): the stack and exact versions; a results
  table against the budgets; for each budget missed or close, **what limits
  it** (measured, not guessed); what you tuned; errors seen; the registry
  proof; then an honest assessment for this product: strengths, weaknesses,
  what an agent writing most of the code gets wrong in this stack, the
  front-end story (how the web UI shares types and pure logic such as the
  canonical Markdown parser, the diff and the outline grammar with the
  server), how the Server and Cloud layers (several instances, one
  organisation) would work, and what you would choose if it were your product.

## Rules

- Toolchains go under `/home/endqwerty/.cache/casebook-arena/toolchains/<name>`
  (never system-wide; no sudo is available; Docker is not available).
- Use release builds and production settings. Prepared statements and sane
  connection pools on every stack: this compares stacks, not defaults.
- Check errors and row counts; a fast wrong answer is a failure.
- Time box: check `date`; stop coding and write `REPORT.md` and a working
  `run.sh` no later than the deadline in your seed. A smaller complete result
  beats a larger unfinished one. Say what you did not do.
- Final message: paths written, the results table, misses, what was not done.
