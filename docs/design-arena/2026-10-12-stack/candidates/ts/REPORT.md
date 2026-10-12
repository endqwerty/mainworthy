# TypeScript stack candidate

I would choose TypeScript on Bun, Zod 4, SQLite for Local and native PostgreSQL for Server and Cloud. This candidate meets every required latency budget. These are provisional measurements on the shared machine, not a verdict against Go or Rust, whose directories I did not read.

## Run and versions

Run `./run.sh` for both required store modes and the registry proof. It resets only its SQLite work file and `cb_ts`. The complete required-mode run with Bun.sql took 227.345 seconds, below ten minutes; the selected postgres.js mode was then run separately through W1–W9. The current selection has not had a second combined timed run. Run `CB_EXTRAS=1 ./run.sh` to repeat Node and then PGlite as well; that combined extras run is not timed or independently verified end to end.

TypeScript 7.0.2; Bun 1.4.3; Node 26.11.1; SQLite 3.53.4 in both runtimes; PostgreSQL server 18.4; Zod 4.6.6; official MCP SDK 1.32.1; postgres.js 3.4.9; fast-xml-parser 5.11.2; extra-only PGlite 0.5.8, PostgreSQL 18.3 compiled to WASM.

All latency units are milliseconds. Memory and artifact sizes below are MiB. Each numbered sequential workload has 100 actual warmups and the specified measured iterations. W9 uses 16 reading clients and one client each for ingest and save for 20 seconds. Requests use real loopback HTTP and persistent connections. The driver times serialization, network and response parsing. `operation` in results.json is the in-process operation duration, including transactions; `db` sums query calls and excludes automatic commit overhead. No in-memory database or tmpfs is used.

## Required results

| Workload | SQLite p95 ms | PostgreSQL p95 ms | Budget ms |
| --- | ---: | ---: | ---: |
| W1 | 1.10 | 0.44 | 20 |
| W2 | 4.24 | 7.83 | 50 |
| W3 | 43.84 | 56.12 | 100 |
| W4 | 16.90 | 19.14 | 50 |
| W5 | 388.60 | 223.91 | 2000 |
| W5a | 46.45 | 37.53 | report |
| W6 | 0.42 | 0.35 | 20 |
| W7 | 0.28 | 0.23 | 20 |
| W8 | 5.05 | 17.05 | 50 |
| W9 | 18.20 | 32.88 | 50 |

Every final workload and warmup had zero errors. W5 maximum was 493.91 SQLite and 243.54 PostgreSQL, below the per-ingest 2,000 ms limit.

W9 SQLite completed 2309.68 reads/s; ingest max 683.69; save p95 560.88. PostgreSQL completed 1104.81 reads/s; ingest max 525.64; save p95 426.69. Read p99 is 26.00 and 41.95, respectively.

Five-start medians: Bun bundle with SQLite 234.25; compiled binary 241.46; PostgreSQL bundle 64.53; Node 295.19. These are cold processes with warm OS file caches, not cold disks. Startup verifies the response PID matches the child it spawned.

Resident memory after workloads: SQLite 312.89, PostgreSQL 169.72, Node 911.20. SQLite includes one writer worker and four reader workers in the same process.

Compiled Linux x86-64 binary: 87.17 MiB, 91408352 bytes. Bun container-ready JS bundle plus worker: 0.58 MiB, requiring the Bun runtime. Clean build with installed dependencies: 308.94 ms. 1102 lines of TypeScript and shell; four direct runtime libraries, three build/type dependencies, and one extra-only PGlite dependency. Installation time is excluded from clean build time.

## Correctness and tuning

W1 validates reference, project, title and parsed head. W2 validates 50 ordered cases, exact seeded link counts and three batched SQL calls; latest outcomes were independently compared with SQL. W3 checks AND matches, relevance order and exactly 20% area filters. W6 checks 20 descending results, W7 the selected commit, W8 ordered questions, parsed evidence and an exact count.

W4 proves 1,100 extra versions, commands, decided adopt questions and decisions, one sequence increment each, current head/hash and full-text replacement. Twenty command replays return stored receipts with all counts unchanged. Failure injected after command/sequence/question/decision/version insertion rolls the entire save back.

W5 proves 120 transactions, 1,200,000 persisted results, 12,000 new tests and 1,200 new signatures. The audited report has 10,000 rows, 200 fails, 9,900 assumed case/head bases, 100 unresolved bases and zero bad bases or duplicate open fingerprints. Batch replay changes no table count or sequence. Run tally is checked. Fresh report keys and ten new messages per batch prevent timing no-ops.

SQLite uses WAL, synchronous=NORMAL, busy_timeout=5000 ms and cache_size=-65536 per connection. One writer and four reader workers permit WAL reads during ingestion. No index was added and no shared PostgreSQL setting changed. Native PostgreSQL retains synchronous_commit=on, with prepared queries and a pool of eight. Project-row locking preserves sequence commit order. SQLite IDs are reserved under BEGIN IMMEDIATE after checking indexed table maxima, so multiple processes do not reuse IDs.

The initial SQLite single-event-loop W9 missed the budget at 370 ms p95; its ingest operation p95 was 358 ms, with only 63 ms in measured SQL calls. Separate reader/writer workers remove that event-loop stall. Initial PostgreSQL search missed at 149 ms. EXPLAIN showed a large case-table join before ranking/limit. The revised SQL ranks and limits first, then joins 50 cases. Five alternating 50-query trials produced old p95 160.8–163.3 ms and new p95 67.4–69.5 ms. The measured limiter is text-match/ranking work inside PostgreSQL, not TypeScript validation. Plans and trials are in search-profile.json. Open counts use covering/index-only scans, independently confirmed.

I select postgres.js for server mode. Five alternating tuned trials give median ingest 205.42 ms, range 198.84–218.43, versus Bun.sql median 269.72 ms, range 254.78–303.81. Read ranges overlap, so no read winner is claimed. A late library-source audit found unsafe defaults to unprepared even when its pool enables prepare; both regular and transaction calls now explicitly set prepare:true. Earlier relative driver measurements are discarded. Round 4 independently proved named prepared statements and transaction rollback on the corrected client. The required table now uses the completed full postgres.js W1–W9 run, with zero errors; the earlier full Bun.sql data is retained as server-bun-sql.json. Parameterized queries are prepared; parameterless queries use the simple protocol.

Seed signature hashes are retained through a map of the 40 existing normalized samples; new signatures use SHA-256 of normalized messages. This is compatibility with the supplied seed, not a proposed production migration scheme.

Construction failures included eager MCP SDK initialization in Bun's bundled output and integer-only schema validation rejecting search relevance scores. Lazy SDK loading and finite numeric scores fixed these; final runs have zero errors. A later runner collided with the judge's frozen TS process on port 30452 and replayed its commands. The PID ownership check now fails that case before measurement, and the default port is configurable CB_HTTP_PORT=30462. The failed run is not reported as a benchmark result.

## Registry proof

schemas.ts owns runtime schemas and inferred TypeScript types. registry.ts declares get, propose and report once. Generic loops generate HTTP routes, OpenAPI 3.1, CLI subcommands/help and MCP registration, including effect-based SQLite worker routing. Database dialect differences are behind the Db interface.

The maintained official @modelcontextprotocol/sdk 1.32.1 implements protocol revision 2025-11-25 and also lists four older supported revisions. Actual stdio tools/list is 5,209 compact JSON bytes and contains get/propose/report. Actual tools/call get returns structured content identical to HTTP and CLI. Generated OpenAPI schemas have resource $id values so recursive JSON references resolve. See registry-proof.json, mcp-tools-list.json, mcp-tools-call.json, openapi.json and cli-help.txt.

A fourth operation touches schemas.ts for input/output schemas, one registry.ts entry, and its implementation in workloads.ts, roughly 10–20 lines for a small operation. It requires no per-operation HTTP, MCP, CLI or worker-routing code. Zod 4 is chosen for direct SDK support, inference and built-in JSON Schema conversion; no claim is made that it is the fastest schema library.

## Extras, in requested order

| Workload | Node p95 ms | PGlite subset p95 ms |
| --- | ---: | ---: |
| W1 | 0.78 | 1.52 |
| W2 | 5.48 | 3.51 |
| W3 | 43.87 | 9.19 |
| W4 | 6.39 | 5.08 |
| W5 | 329.10 | 653.18 |
| W6 | 0.45 | not run |
| W7 | 0.30 | not run |
| W8 | 9.96 | not run |

Node ran the same embedded W1–W8 operations, node:sqlite, durability and worker counts, with zero errors. Its preceding workload run used the Bun HTTP driver; run.sh now builds and runs the same benchmark driver under Node too. The earlier extra W5a field therefore measures the Bun parser, not Node, and is excluded from this runtime comparison. Both servers' Node and Bun write/rollback/replay behavior was independently checked. One concurrent-machine sample cannot establish a runtime speed winner. Bun's concrete operational advantage here is the tested standalone binary and native SQL client; Node also meets the budgets.

PGlite loaded 10,000 cases, 15,059 versions, 100,000 results, 6,000 questions and 10,000 tests; small parent tables and 40 signatures were retained. Loading took 5.71 seconds. It ran W1–W5 and W5a with zero errors, including the full 9,900-existing/100-new report and 120 ingest transactions. W2 returns 10–20 rows from the smaller folders, so its latency is not comparable to a full 50-row page. Cold-start median 263.75 ms; RSS 366.05 MiB. Settings and exact dimensions are in pglite-seed-info.json.

PGlite is viable for an in-process prototype with one SQL dialect, but I would not choose it as the product's Local store yet. It uses native disk files and relaxedDurability=false, but reports fsync=off; SET fsync=on is rejected and the tested startup override failed. Independent checks proved close/reopen persistence, immediate process-kill persistence and transaction rollback, not power-loss safety. These timings do not establish durability parity with native PostgreSQL. Full seed scale and mixed concurrency are untested.

## Product assessment

TypeScript lets the web UI share schema-derived operation inputs, outputs and case structures. A browser-safe package should hold the canonical Markdown parser/printer, structured diff and outline grammar; store and server dependencies should remain outside it. Those pure algorithms and a web UI were not implemented in this spike. Optimistic edits, virtualized lists and browser input-to-paint measurements still need proof.

For Server, use one Bun container or the binary with PostgreSQL and a storage interface for attachments. For Cloud, several stateless instances can share one organisation's PostgreSQL, external object storage and persisted idempotent jobs. An optional cache must fall back to the database. The project sequence lock serializes that project's writers, so multi-instance deployment does not remove this ceiling; the measured mixed saves already queue behind ingestion. More projects can execute independently. This spike does not prove an unlimited-user claim.

Agents most often get the boundaries wrong: hashes and bigint serialization, holding a transaction across interleaved async work, letting save bypass a decision, forgetting replay before sequence/ID allocation, and drifting CLI/MCP/HTTP validation. The registry and store interface help constrain those mistakes. Production must require version bases, define cumulative run tallies, handle larger reports without bind limits, validate real nested JUnit, and add capability authorization. The spike uses project 1 and a fixed actor, has debug benchmark endpoints and simple HTTP 400 errors. Auth, migrations, backups, restore and browser performance were not tested.

## Independent verification and remaining limits

Claude Opus 5.5, high effort, independently checked actual artifacts and SQL in four rounds. Round 3 passed the required core at manifest 3d2dcc80…0eab885a, including a separate 20-second PostgreSQL mix: 21,755 reads, p95 32.5 ms, 71 ingests and 71 saves, zero errors and exact durable deltas. VERIFICATION-r1.md, VERIFICATION-r2.md, VERIFICATION-r3.md and VERIFICATION-r4.md contain deciding values and review limits. Round 4 also passed the current two-line preparation correction, verifying real prepared statements and rollback. Its timing comparison was not independently reproduced; see VERIFICATION-r4.md.

The extras predate the last interface/routing refactor, though their write semantics and PGlite persistence were independently rechecked. CB_EXTRAS=1 was not successfully timed end to end. Full PGlite data/mixed load, power-loss recovery, UI and multi-instance operation remain untested. A transient FTS quick_check mismatch observed in round 1 was not reproduced in round 2; fresh checks and FTS integrity passed.

The shared seed hash remains 7df559361b6db2a22292f02b7d053a8f3baa204928b989a9425080a3ae3848b0. Deliverable files existed before 23:10 PDT, but the final report and the corrected client measurement were finalized after that deadline. Only this candidate output directory was written. PostgreSQL mutations target cb_ts. The final chosen-driver run reset it after the independent checks. No repository change or commit was made by this candidate.

Sources: [Bun SQL](https://bun.sh/docs/runtime/sql), [Bun executable workers](https://bun.sh/docs/bundler/executables), [official MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk), [Zod JSON Schema](https://zod.dev/json-schema), [PGlite API](https://pglite.dev/docs/api). Local installed source and run artifacts determine the exact versions and measurements above.
