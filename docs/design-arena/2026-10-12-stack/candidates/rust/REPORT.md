# Rust stack candidate

All five complete runs on the frozen source passed every stated workload budget, with zero warm-up, measured or audit errors. Independent verification passed in both stores. The repeats alternate embedded and server modes. These timings are provisional because the other arena candidates share this machine. Raw runs are in `runs/run-1.json` through `run-5.json`; `repetition-summary.json` records their medians and ranges. `results.json.mode` is the actual fifth run, with the repetition summary in extras.

Run `./run.sh` from this directory. It builds the locked release binary if needed, copies the shared SQLite seed, recreates only `cb_rust` from `cb_seed`, and runs all workloads against persistent loopback HTTP connections. An exclusive flock prevents simultaneous candidate runs. The five complete driver runs took 161 to 199 s. A fresh release build adds about 71 s, within the 10-minute limit. Complete invocations with a cached build took 172 to 207 s.

Versions: Rust 1.99.0, axum 0.8.9, Tokio 1.53.2, rusqlite 0.40.2 with bundled SQLite 3.53.2/FTS5, PostgreSQL 18.4, tokio-postgres 0.7.18, rmcp 3.5.1, schemars 1.2.2, quick-xml 0.38.4. Cargo.lock pins all packages. The stripped Linux x86_64 binary is 7.87 MiB; glibc is the host runtime.

Each workload warms up for 100 iterations. Measured counts are exactly the specification counts. W5 writes 1.2 million rows per mode across warm-up and measurements, before the mixed run. All 500 search queries run once in the measured window; exactly 20% also have an area filter. W9 runs 16 readers, one ingest client and one save client for 20 seconds.

The table shows the median of five end-to-end HTTP p95 measurements in milliseconds, with each run's p95 range, with full JSON response decoding. Request generation and client encoding are excluded; server decoding is included. W5 shows the worst measured ingest across all five runs because every ingest has a 2,000 ms budget. W5a has no budget.

| Workload | SQLite median [range] | PostgreSQL median [range] | Budget ms |
| --- | ---: | ---: | ---: |
| W1 | 2.718 [1.276, 3.033] | 0.335 [0.246, 0.401] | 20 |
| W2 | 6.058 [4.430, 6.483] | 8.255 [5.391, 8.503] | 50 |
| W3 | 55.846 [46.637, 61.612] | 52.939 [45.813, 59.081] | 100 |
| W4 | 6.851 [3.989, 6.949] | 9.664 [7.393, 22.916] | 50 |
| W5 | 773.942 worst | 812.503 worst | 2,000 each |
| W5a | 5.928 [5.022, 7.069] | 7.440 [4.536, 8.393] | report |
| W6 | 0.439 [0.325, 0.500] | 0.490 [0.348, 0.543] | 20 |
| W7 | 0.192 [0.132, 0.225] | 0.280 [0.175, 0.335] | 20 |
| W8 | 3.483 [2.460, 3.509] | 8.152 [5.252, 8.793] | 50 |
| W9 | 11.296 [9.607, 11.893] | 17.599 [12.911, 21.136] | 50 reads |

No final-source budget was missed. The initial PostgreSQL search did miss its budget, at 114.86 ms p95. Its EXPLAIN plan scanned and joined all 100,000 cases before selecting the best 50. A MATERIALIZED top-50 search CTE now joins only 50 case rows. The diagnostic token query went from a parallel hash join to 50 indexed case lookups; the saved plans are `search-before.plan` and `search-after.plan`.

SQLite ingest had a bad planner choice in failure aggregation. The original query scanned all 10,000 staged rows once per stored signature; five diagnostic runs took 453 to 525 ms. Grouping the staged failures first returned exactly 20 groups and 200 failures in 0.4 to 1.4 ms. The shared ingest now uses that grouped query. `signature-group-profile.json` has the plans and assertions.

Store differences are in `src/db.rs`: native full-text search and replacement, id allocation, parameter/row conversion, JSON staging and project locking. `src/ops.rs` contains one workload implementation for both modes. Writes use one transaction, and PostgreSQL writes run in an owned task so cancellation of an HTTP request cannot return a half-open transaction to the pool.

SQLite settings are WAL, synchronous=NORMAL, mmap_size=0, foreign_keys=ON, busy_timeout=15 s, 8 MiB per read connection and 64 MiB for the writer. It has 8 read connections and one writer; SQLite work runs in spawn_blocking. mmap was disabled after the first run reported 882 MiB RSS. PostgreSQL has 16 read and 2 write connections, synchronous_commit=on, and the shared server settings remain untouched. Both drivers cache prepared statements. No shared schema or indexes were changed; the staging table is temporary.

Both stores serialize writes to a project. PostgreSQL locks its project sequence row before mutation, so sequence order is commit order and duplicate writes are checked under the same lock. SQLite has one writer connection. A second PostgreSQL write connection does not remove that per-project limit.

| Mixed-run metric, median across five | SQLite | PostgreSQL |
| --- | ---: | ---: |
| Read p50 ms | 4.876 | 5.864 |
| Read p99 ms | 16.180 | 22.274 |
| Reads/s | 2857.336 | 1993.954 |
| Ingest p95 ms | 768.723 | 617.780 |
| Save p95 ms | 672.537 | 588.637 |
| Driver CPU s | 20.486 | 16.334 |
| Ingest worst observed ms | 1008.782 | 971.019 |

Saves queue behind ingests in both stores. W9 only gives a budget for reads and ingests; the save tail is still relevant to the product. SQLite WAL reached 669.51 MiB during the 20-second mix. Long-running checkpoint behavior and a bounded disk policy are not proven. This candidate retains the normal automatic checkpoint setting. A production service needs tested checkpoint scheduling and bounded reader transactions.

The Python driver consumes roughly one CPU core during W9. Its throughput is therefore a client limit as well as a store measurement. In-process times include pool acquisition, scheduling and operation work, and are recorded in every workload's store_ms distribution. They exclude HTTP decoding and response encoding. No claim about a server throughput ceiling follows from this driver.

Cold start is process creation to HTTP /health success, median of five starts in the fifth run: SQLite 5.69 ms, PostgreSQL 37.48 ms. Both stores open before health is served. Median RSS after a run was 422.43 MiB SQLite, range 394.01 to 439.73, and 143.75 MiB PostgreSQL client, range 132.13 to 151.93. The PostgreSQL value excludes its database server and 1 GiB shared buffers. The SQLite value includes its engine and caches.

Clean release build on the final source took 71.20 s with six jobs and a populated registry download cache; a changed application module rebuilt in 10.28 s. The earlier clean build took 66.06 s. There are 11 direct dependencies and 162 locked crates including the application. Application, benchmark, builder and runner total 1,998 lines. These counts exclude verifier scripts and diagnostic experiments.

Driver choice was measured with five alternating, warmed prepared point-read rounds on the same PostgreSQL data and checked returned ids/bytes. With one connection leased throughout, sqlx 0.8.6 had median per-round p50 0.046 ms, tokio-postgres 0.7.18 0.053 ms. Their ranges overlap; the difference is negligible against 20 ms. Adding the sqlx comparison to the existing release cache took 25.94 s and introduced 75 crate/version pairs not in the application lockfile. I retained tokio-postgres for the smaller build and explicit SQL interface. This is not a claim that it has a faster read driver. Probe source and results are in `tmp/driver-choice` and `driver-choice-results.json`.

The registry is the three-row `registry!` declaration in `src/registry.rs`. Each row names its input/output Rust types, handler, description and effect. Deriving schemars JsonSchema on the types provides the schemas. The declarative macro generates typed dispatch; the common builders generate HTTP routes, OpenAPI 3.1, rmcp tool schemas and CLI help. No operation has separate HTTP, MCP or CLI glue. The cost is 82 lines of registry/builders plus JsonSchema derives, typed JSON conversion at the boundary, and the schemas in tools/list.

OpenAPI has exactly /op/get, /op/propose and /op/report, with all references resolved. The CLI accepts JSON as an argument or stdin and generates get --help and the other operation help from the same registry. MCP is the [official maintained Rust SDK](https://github.com/modelcontextprotocol/rust-sdk), rmcp 3.5.1, which implements MCP 2026-07-28 and older compatible revisions. The recorded stdio initialize negotiated 2025-11-25; tools/list and tools/call get both passed. tools/list is 4,426 bytes for the compact result payload, or 4,460 bytes including its JSON-RPC envelope and excluding the final newline. Proofs are in `tmp/driver`: `mcp-transcript.json`, `mcp-tools-list.json`, `openapi.json` and `cli-help.txt`.

Adding a fourth operation touches `src/ops.rs` for its two DTOs and one handler, and adds one registry row in `src/registry.rs`. For a small history operation this is about 20 implementation lines plus a check; all three encodings and schemas update automatically. It adds no per-operation code to main.rs.

Every measured response is validated. Untimed independent SQL probes check glyphs, basis versions, row deltas and queue ordering. W4 replays 20 commands and verifies identical receipts and unchanged durable counts; W5 replays a report and verifies no writes. Whole-workload deltas prove all warm-up and measured writes occurred. Parser checks count 10,000 cases, 200 failures and all 80,000 decoded message bytes.

Independent verification by Claude Opus 5.5, a different provider from the Codex author, passed the frozen revision. It checked both stores with its own SQL oracle, including successful writes, concurrent duplicates, stale bases, disconnected writes and kill -9 during writes. Every acknowledged write survived, no command or batch was torn, and sequence numbers were gapless. `verification-r2.md` names the exact source and binary hashes. The clean build produced the same binary hash. Power-loss durability was not tested.

Errors found and fixed: rmcp 3.x renamed Content to ContentBlock; the XML parser initially dropped entity characters; the PostgreSQL pool could return an abandoned transaction after a disconnected request; malformed XML was accepted; unlisted benchmark operations were callable through MCP/CLI; and informational pass messages could create failure signatures. One early repeat overlapped another and was stopped; its samples are excluded. The runner now rejects concurrent runs with exit 75 and checks that its port is free.

For Casebook, Rust gives a small native artifact, predictable concurrency, typed documents and fast pure logic without a separate local database process. SQLite and PostgreSQL can use the same transactional operation code. The costs are a second language beside a TypeScript UI, a roughly ten-second edit/build cycle here, database dialect work, and careful async transaction ownership. Raw SQL is not compiler-checked. Agents still make planner mistakes and cancellation mistakes; the measured checks caught those that the type checker did not.

A TypeScript UI can generate operation types from OpenAPI. Shared pure logic belongs in a small Rust crate with no store or runtime dependency, compiled natively for the server and to WebAssembly for the browser. The canonical Markdown parser/printer, step diff and outline grammar would run from that same crate. This spike does not implement those three functions or a UI; the [concrete bridge example](FRONTEND.md) shows the native/WASM split, TypeScript calls and costs per change.

Server runs this binary behind the home server reverse proxy with PostgreSQL and durable attachment storage. Cloud uses several identical API instances for one organisation, a shared PostgreSQL database, object storage and idempotent persisted jobs claimed by workers. Per-project row locks coordinate ordered writes across instances. More instances scale reads and different projects; they do not remove one busy project's commit-order bottleneck. A cache would accelerate reads only, with refetch after missed notifications. Authentication, migrations, backup/restore, attachment storage, notifications and job ownership are not implemented in this performance spike.

My product choice is a TypeScript web UI. I would choose this Rust server if serial arena measurements show a material latency, memory or deployment advantage; this candidate proves viability, not superiority over stacks I have not inspected. If the other candidates also meet the budgets, Rust's second-language and browser-build costs need to earn their place.

No required workload or registry proof is missing. Full 20-second W9 and the exact workload counts ran in both stores. Not done: a real web UI/WASM build, canonical Markdown/diff/outline implementations, long-duration WAL/reconnect testing, power-failure testing, or actual Server/Cloud deployment.
