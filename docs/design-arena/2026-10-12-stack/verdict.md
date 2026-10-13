# The stack arena: the cross-judge's verdict

Written by GPT 6 Astra on 2026-10-12, unedited apart from this heading and the last paragraph's file locations. The lead's decision, and where it departs from this verdict, is [decision 0010](../../decisions/0010-stack.md).

**Recommendation: TypeScript on Bun; store option 2, SQLite and PostgreSQL supported behind one store interface from the first usable release.** SQLite can serve Local and the first single-instance Server deployment; PostgreSQL provides the tested route to Cloud. Scores: TypeScript **26/30**, Rust **23/30**, Go **22/30**. No alternative demonstrated a product advantage large enough to offset the cost of sharing the browser's pure logic. This selects a stack; it does not approve any spike as production code.

**Evidence and repeatability**

I read the shared specification, private rubric and requested product context before comparing candidates, inspected source and drivers, and ran the unmodified candidate scripts serially. Initial mtimes showed ongoing author work. TS's first judge run was interrupted when its author rewrote the running shell script; Go's first stopped on a real skip-tally selfcheck failure, subsequently fixed by its author. I therefore froze exact source copies under `frozen/`, preserved before/after results and SHA-256 manifests, and judged those revisions. I changed no candidate source or repository file.

The initial TS report was explicitly interim, and Rust's initially said work in progress. Their old report numbers are not the numbers below. Primary evidence is the judge-generated `after/results.json`: TS `run3` plus `repeat2`–`repeat5`, Go `run2` plus `repeat2`–`repeat5`, Rust `run1` plus `repeat2`–`repeat5`. These are five complete runs per frozen candidate, alternating Go → Rust → TS. The earlier complete TS `run2` is separate evidence, not a sixth same-revision observation. Every run directory contains `metadata.json`, `load.jsonl`, `run.log`, and preserved before/after files.

| Candidate | Run count | Start PDT | Seconds | Start load 1/5/15 | Observed 1-min range |
| --- | --- | --- | --- | --- | --- |
| Go | 1/5 (`run2`) | 10-11 23:08:22 | 195.4 | 8.00, 10.45, 10.83 | 6.70–12.22 |
| Go | 2/5 (`repeat2`) | 10-11 23:32:08 | 175.4 | 4.27, 4.86, 6.98 | 3.90–12.67 |
| Go | 3/5 (`repeat3`) | 10-11 23:41:54 | 195.4 | 5.74, 6.44, 7.01 | 5.21–13.04 |
| Go | 4/5 (`repeat4`) | 10-11 23:52:11 | 195.5 | 8.65, 8.17, 7.80 | 7.21–14.35 |
| Go | 5/5 (`repeat5`) | 10-12 00:02:57 | 205.5 | 10.42, 9.61, 8.81 | 10.42–21.88 |
| Rust | 1/5 (`run1`) | 10-11 23:12:13 | 270.6 | 7.89, 9.50, 10.38 | 7.01–11.90 |
| Rust | 2/5 (`repeat2`) | 10-11 23:35:03 | 195.4 | 11.89, 7.21, 7.47 | 5.01–11.89 |
| Rust | 3/5 (`repeat3`) | 10-11 23:45:10 | 200.4 | 11.59, 8.31, 7.59 | 6.70–11.98 |
| Rust | 4/5 (`repeat4`) | 10-11 23:55:26 | 210.5 | 14.58, 10.07, 8.54 | 7.50–14.58 |
| Rust | 5/5 (`repeat5`) | 10-12 00:06:23 | 200.5 | 21.41, 14.87, 11.02 | 7.14–21.41 |
| TypeScript/Bun | 1/5 (`run3`) | 10-11 23:19:33 | 215.5 | 7.85, 8.68, 9.67 | 6.48–9.11 |
| TypeScript/Bun | 2/5 (`repeat2`) | 10-11 23:38:19 | 215.5 | 7.75, 6.86, 7.25 | 5.60–8.35 |
| TypeScript/Bun | 3/5 (`repeat3`) | 10-11 23:48:30 | 220.5 | 11.98, 9.01, 7.94 | 5.49–11.98 |
| TypeScript/Bun | 4/5 (`repeat4`) | 10-11 23:58:57 | 240.6 | 12.63, 9.81, 8.65 | 7.98–12.63 |
| TypeScript/Bun | 5/5 (`repeat5`) | 10-12 00:09:43 | 235.6 | 10.86, 12.11, 10.65 | 7.87–11.13 |

Times above are local PDT; load columns are `uptime`'s 1/5/15-minute averages, not CPU percentages. The machine has 16 logical CPUs and was shared with agents, builds and database activity. Earlier TS `run2` saw 1-minute load 8.04–20.90, external candidate activity, and CPU/I/O/memory pressure; it produced PostgreSQL search p95 98.96 ms and mixed-read p95 40.23 ms. That near-budget result triggered the repeat. No other candidate benchmark was detected during the 15 included runs. Do not interpret small differences as intrinsic language speed or extrapolate reads/s to a saturation ceiling.

**Measured latency**

Each cell is **median run p95 [minimum–maximum run p95]**, milliseconds, across five runs; E = embedded SQLite, S = PostgreSQL 18.4. Sequential workloads use 100 warmups followed by the specified 500–2,000 reads, 1,000 saves or 20 ingests/parses; W9 uses 16 readers, one ingest writer and one save writer for 20 seconds. All required data starts at 100,000 cases and 1,000,000 results, then grows during writes.

| Workload | Budget ms | TS E | TS S | Go E | Go S | Rust E | Rust S |
| --- | --- | --- | --- | --- | --- | --- | --- |
| W1 Read case | p95 <20 | 0.76 [0.64–1.28] | 0.59 [0.41–2.55] | 0.22 [0.19–0.25] | 0.22 [0.20–0.23] | 4.33 [2.58–4.40] | 0.27 [0.25–0.30] |
| W2 Folder page | p95 <50 | 3.70 [3.27–9.75] | 8.04 [6.45–8.58] | 3.18 [2.50–3.35] | 6.65 [5.25–7.84] | 7.11 [5.18–8.78] | 8.27 [6.66–8.72] |
| W3 Search | p95 <100 | 42.19 [29.81–51.18] | 61.59 [53.29–68.29] | 30.12 [26.45–39.76] | 29.47 [27.53–34.17] | 53.52 [49.92–57.37] | 51.13 [46.12–53.74] |
| W4 Seal-save | p95 <50 | 16.11 [16.01–16.40] | 19.08 [18.63–22.05] | 14.93 [8.66–15.32] | 19.05 [16.33–19.82] | 15.58 [15.48–15.89] | 19.07 [18.54–23.77] |
| W5 10k ingest | each <2,000 | 369.93 [331.75–486.87] | 233.74 [214.60–260.75] | 491.29 [387.99–650.46] | 300.03 [243.37–367.60] | 436.18 [390.71–474.05] | 357.34 [345.80–425.61] |
| W5a JUnit parse only | report only | 38.73 [34.42–42.19] | 48.53 [35.12–55.22] | 30.52 [24.60–33.14] | 25.27 [24.54–33.56] | 6.20 [4.90–6.49] | 4.79 [4.00–7.14] |
| W6 Recent results | p95 <20 | 0.43 [0.35–2.24] | 0.32 [0.30–0.43] | 0.33 [0.30–0.41] | 0.32 [0.31–0.37] | 0.41 [0.40–0.59] | 0.45 [0.43–0.64] |
| W7 Gate read | p95 <20 | 0.28 [0.23–0.30] | 0.25 [0.22–0.28] | 0.12 [0.11–0.15] | 0.17 [0.16–0.21] | 0.17 [0.17–0.32] | 0.23 [0.22–0.24] |
| W8 Queue page | p95 <50 | 4.67 [4.39–5.95] | 9.60 [7.63–10.70] | 2.71 [2.47–3.27] | 7.57 [5.93–7.68] | 2.98 [2.59–3.90] | 7.67 [6.76–8.46] |
| W9 Mixed reads | p95 <50 | 17.76 [17.02–23.09] | 31.55 [29.25–32.29] | 6.21 [6.13–10.15] | 12.61 [12.09–16.14] | 10.35 [9.83–11.73] | 15.05 [14.65–17.40] |

W5 and W9 ingest have an **every-request** budget, so a passing p95 alone is insufficient. Across all five runs, their worst measured request durations were:

| Metric | Budget | TS E | TS S | Go E | Go S | Rust E | Rust S |
| --- | --- | --- | --- | --- | --- | --- | --- |
| W5 maximum ms | <2,000 ms | 933.84 | 617.84 | 859.25 | 557.06 | 513.34 | 479.53 |
| W9 ingest maximum ms | <2,000 ms | 1148.30 | 698.30 | 1350.08 | 653.30 | 913.09 | 897.00 |

All 300 required budget checks across 15 runs pass; all measured, warmup and mixed-writer error counts are zero. W5a is report-only. Its table entries are in-process parse times; Rust's additional HTTP parse p95 medians are 7.25/5.79 ms (E/S). Other HTTP timings include request/response processing, but Rust excludes client JSON encoding while TS and Go include it. Independent drivers and different read pools prevent a controlled language-speed claim.

| W9 candidate | Mode | Read p50 ms | Read p95 ms | Read p99 ms | Reads/s | Ingest p95 ms | Save p95 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| TypeScript/Bun | embedded | 5.40 | 17.76 | 25.24 | 2337 | 633.89 | 586.07 |
| TypeScript/Bun | server | 11.79 | 31.55 | 38.73 | 1172 | 409.39 | 398.62 |
| Go | embedded | 1.71 | 6.21 | 10.00 | 6445 | 884.85 | 505.30 |
| Go | server | 1.84 | 12.61 | 15.45 | 3297 | 557.65 | 350.86 |
| Rust | embedded | 4.63 | 10.35 | 14.57 | 3037 | 675.72 | 588.23 |
| Rust | server | 4.85 | 15.05 | 19.57 | 2289 | 635.79 | 622.95 |

The W9 table gives medians across runs. Save p95 has no W9 budget; it remains relevant to editing. These are closed-loop client rates, not maximum server throughput. Rust's initial embedded driver used 21.45 CPU-seconds in 20.23 seconds of wall time, so its Python client materially contributes to the result.

**Correctness, tuning and the store boundary**

I traced failure accounting and awaited HTTP response decoding in all drivers. Failed status codes, malformed or incorrect responses, warmup failures and mixed writer failures are counted; a failing correctness assertion stops the script. Row deltas prove W4's 1,100 versions/commands/decided questions/decisions and sequence increments, and W5's 120 transactions adding 1,200,000 results, 12,000 tests and 1,200 signatures per mode before W9. Twenty command replays return stored outcomes without writes; batch replay also preserves counts. Search validates AND matching, area scope and relevance order, rather than merely accepting nonempty results.

My additional [HTTP/SQL oracle](audit.py) used private SQLite seed copies and independent queries for all three final sources: 50 folder rows with 31 latest-result glyphs, 20 history rows, 50 queue rows, AND search, explicit stale-base rejection with no writes, concurrent identical-command replay, competing edits on the same base, 10,000 persisted results with 200 failures/20 signatures and correct 9,900 assumed versus 100 unresolved bases, concurrent batch replay, and invalid-outcome rejection. Evidence: [TS](audit/ts-latest/audit.json), [Go](audit/go-final/audit.json), [Rust](audit/rust-final/audit.json). Go's separately clean-built binary passed the same [audit](audit/go-clean-build/audit.json).

**Product correctness gap:** TS and Rust accept an omitted save base and each append a new adopted version (HTTP 200); Go rejects the omission (400, zero writes). Explicit stale bases and two concurrent writes with one supplied base are protected in all three. Omission does not violate W4's literal performance exercise, but it violates ADR0001's version-checked-write requirement. Make the base mandatory before using either prototype as the product's starting point. The benchmark's seed has owner 0 on every open question, so Go's owner-0 queue is equivalent here; general multi-owner behavior was not established.

All three use SQLite WAL with `synchronous=NORMAL`, prepared queries, one writer, and separate readers; no in-memory database. TS uses four reader workers and a writer worker (64 MiB connection caches), Go up to 16 readers plus a writer, Rust eight readers with 8 MiB caches and a 64 MiB writer cache. PostgreSQL uses prepared statements with pools of 8 (TS), 20 (Go), or 16 readers plus 2 writers (Rust). I checked PostgreSQL `fsync=on`, `synchronous_commit=on`, and 1 GiB shared buffers. No shared schema/index/server settings were changed by this judge.

TS's `Db` interface owns transactions, bulk writes, ID allocation, full-text replacement/search and project locking; SQLite runs off the HTTP thread. Go uses `Backend`/`Queries`/`Transaction`; Rust uses a `Db` enum and pool helpers. Each has one workload implementation with dialect details inside its store module. PostgreSQL locks the project sequence row; adding API instances cannot remove this per-project serialization. Async calls require a transaction-owned connection in all PostgreSQL implementations; the current TS SQLite worker boundary is also asynchronous. A synchronous pure core can still be shared with the browser because it must not contain store I/O.

The close TS search was database-bound: earlier HTTP p95 98.96 ms versus summed-query p95 97.57 ms (distribution summaries, not matched request subtraction). My separate [diagnostic](search-diagnostic.json) alternated five rounds of the first 50 fixed queries, including area filters, on Bun's selected PostgreSQL driver. Candidate `ts_rank_cd` median round p95 was 50.73 ms [49.25–51.70]; the same query using `ts_rank` was 32.44 [31.16–32.92]. An untimed `EXPLAIN ANALYZE` put the common-token candidate query at 38.20 ms, sorting/ranking 20,622 matches before 50 indexed case joins. This locates a SQL/relevance cost, not a TypeScript ceiling; changing relevance formulas is a product decision, not a proven semantics-preserving optimization. A queue count used an Index Only Scan with 1,920 heap visibility fetches over 51,920 entries, not a full table scan. No candidate was edited for this probe.

TS `run.sh` re-evaluates its prepared PostgreSQL client with five alternating driver probes each run; the judged selection was bun: 2/5 runs, postgres: 3/5 runs. The tables measure this unchanged selection policy. Author-selected driver numbers and the earlier unprepared postgres.js path are not used to rank runtimes.

**Registry proof and the fourth operation**

All reruns execute real MCP stdio `initialize`, `tools/list` and a `get` call, as well as HTTP/OpenAPI and generated CLI checks. All expose `get`, `propose`, `report`; all generate OpenAPI 3.1. Compact `tools/list` **result payload** sizes are TS 5,209 bytes, Go 4,309, Rust 4,426 (Rust's reported 4,460 includes its JSON-RPC envelope). These are bytes, not token counts. All judged sessions negotiated protocol 2025-11-25. Installed SDKs are official TS SDK 1.32.1, Go SDK 1.8.0 and Rust rmcp 3.5.1. The [official SDK catalog](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/docs/2026-07-28/sdk.mdx) lists all three; the [TS SDK documentation](https://ts.sdk.modelcontextprotocol.io/) identifies v1 as a maintained older line, not current v2.

| Candidate | Source inspected and cost of operation four |
| --- | --- |
| TS | `src/schemas.ts`: input/output schemas; `src/workloads.ts`: handler; one `operation(...)` row in `src/registry.ts`. Generic invocation validates input/output; all adapters and SQLite read/write dispatch derive from the registry. Help shows schema plus generic JSON/file input, not individually named flags. |
| Go | `models.go`: input/output structs with schema tags; `operations.go`: handler; one `addOperation(...)` line in `registry.go`. Generic/reflection builders derive schemas, adapters and individual CLI flags. MCP uses SDK validation while HTTP/CLI use the common validator; both call the same typed handler. |
| Rust | `src/ops.rs`: derived input/output DTOs and handler; one row in the `registry!` macro in `src/registry.rs`. The macro generates typed dispatch; shared builders generate all surfaces and JSON-schema help. |

There is no per-surface edit for a fourth operation in any candidate. The registration cost is one line plus imports/types and business logic; exact total lines depend on the operation. This is source inspection, not a fourth-operation implementation experiment. None proves the full product registry's authorization, decision witness, token budgets or exhaustive operation map.

**Deployment measurements**

| Candidate | Cold process median ms E/S | Application RSS MiB E/S | Artifact MiB |
| --- | --- | --- | --- |
| TypeScript/Bun | 219.63 / 61.91 | 329.24 / 169.73 | 87.17 (compiled); 0.58 bundle + runtime |
| Go | 4.12 / 4.27 | 345.58 / 41.39 | 16.13 static binary |
| Rust | 5.68 / 26.57 | 412.57 / 142.40 | 7.87 binary + glibc |

Cold starts are medians of five launches per run with warm OS caches; the table takes their median across five runs (TS runs its source/bundle with Bun; Go/Rust launch native binaries). RSS is the application process after each mode, not peak system or PostgreSQL memory. Build measurements exclude already-downloaded dependencies: TS rebuilds an empty `dist` in 0.229 seconds (typecheck runs separately); Go used my empty compiler cache, 55.83 seconds; Rust's first frozen run had an empty target directory, 72.71 seconds. These are one clean build each, not repeatable comparative build-speed evidence. TS's 0.58 MiB bundle excludes the Bun runtime; its 87.17 MiB compiled artifact includes it. Go's 16.13 MiB binary is static; Rust's 7.87 MiB binary requires its normal glibc runtime. No container image sizes were measured.

Physical source counts reported from the executed trees are TS 1,102, Go 2,810, Rust 1,998, with different formatting and harness inclusion; I do not rank maintainability by these counts. Direct dependencies are TS 4 runtime plus 3 build/experimental, Go 4 active (5 declared with the alternate SQLite driver), Rust 11 (162 locked packages including the app). Smaller native artifacts and faster process starts favor Go, but a container is acceptable and none of these starts threatens the Local starts-in-seconds requirement. Multi-instance operation, migrations and recovery remain work in every stack.

**Scores (unweighted, 1 = poor fit, 3 = viable with gaps, 5 = strong fit)**

| Criterion | TypeScript / Bun | Go | Rust |
| --- | --- | --- | --- |
| 1. Budgets, honestly measured | **4** — Both full-data modes meet the budgets in the judge runs, with error and durable-work checks. Shared load, client differences and the earlier near-budget SQL query limit stronger performance claims. | **4** — Both modes pass with durable COPY/SQLite writes, complete failure counts and strong replay checks. Closed-loop rates and differing pools do not prove language superiority. | **4** — Both modes pass and persisted deltas are explicit. Python client CPU and excluded client serialization qualify throughput comparisons. |
| 2. One operation layer | **5** — Three schema/handler declarations generate the four required surfaces; real SDK calls pass. Operation four adds schemas, one handler and one registry row. | **5** — Typed registration plus reflection generates schemas and CLI flags; the real MCP proof passes. No per-surface fourth-operation glue. | **5** — The three-row macro supplies typed dispatch and all required surfaces; real MCP proof passes. Operation four has no adapter duplication. |
| 3. Shared browser logic | **5** — Schema-derived types and a browser-safe pure package can be imported directly by both sides. No generator or language bridge is required per logic change; the actual editor algorithms remain unbuilt. | **2** — Generated TS types solve wire contracts, not shared outline/parser/diff/merge/verdict behavior. A Go WASM boundary or duplicate implementation adds per-change build, bridge or drift costs; neither is demonstrated. | **3** — A pure Rust crate compiled to WASM can share the algorithms and generated types. It adds bindings, browser artifact/init and ownership/serialization decisions, none demonstrated by this spike. |
| 4. Agents write the code | **3** — Zod and inferred unions help, but primitive IDs, open string states, optional bases and structural typing permit the wrong shortcuts. Private branded constructors, exhaustive maps and import/type-assertion enforcement are still needed. | **3** — Required bases and explicit transaction/error paths worked in my checks; defined types and private packages help. Zero values and string enums do not enforce exhaustive question handling or a sealed decision witness. | **4** — Private newtypes and exhaustive enums offer the strongest compiler-enforced ownership boundary. This candidate still uses raw integers/strings/JSON and accepts missing bases, so that potential is not an implemented defect-elimination proof. |
| 5. Deploy and operate | **4** — Both stores and self-contained build run; PostgreSQL-mode app memory and binary cost exceed Go. Containers are accepted, and direct browser sharing reduces the build/release split. | **5** — Small static binary, low measured PostgreSQL-mode RSS and short cold starts; both stores work. SQLite cgo is confined to the build, though actual Coolify/cloud operations are untested. | **4** — Small binary, short cold starts and both stores; release build/crate and WASM work add maintenance. Mixed SQLite RSS/WAL and glibc packaging need operational checks. |
| 6. Decidedly better for Mainworthy? | **5** — Meets the measured budgets and removes a required browser/server language boundary in the owner's strongest language. No other candidate proves a missing budget or an already-enforced domain guarantee that offsets that advantage. | **3** — Clear deployment strengths, but lower sub-budget latencies do not remove the shared-core cost. Missing-base rejection is valuable implementation discipline that TS can adopt. | **3** — The strongest reason to switch would be an enforced decision/type model shared through WASM. Neither that model nor its browser cost is demonstrated, so it is not yet decidedly better. |
| **Total / 30** | **26** | **22** | **23** |

**A. Stack: TypeScript on Bun.** Put runtime-free outline grammar, canonical Markdown parse/print, step diff, three-way merge and verdict logic in a shared core; infer operation types from the same schemas. Keep SQL, workers and HTTP outside that package. The decisive result is that backend budgets do not force a second language, while the specified keyboard UI requires identical algorithms on both sides. Rust's stronger type-system potential deserves respect but has not yet removed a demonstrated product defect in this spike. I would change this choice for a repeatable TS-only budget failure after equivalent SQL/tuning, or a Rust/WASM editor slice that enforces the actual decision witness and exhaustive domain while meeting browser latency and maintenance requirements. Mandatory version bases and negative architecture/type checks are prerequisites for the TS implementation.

**B. Stores: option 2; support SQLite and PostgreSQL from the first usable version.** Use SQLite for Local and permit it for the initial single-process Server installation; do not require an owner to operate PostgreSQL merely because the adapter exists. Keep both migrations and the transaction/replay/sequence contract exercised. This pays for two migration/search dialects and async transaction orchestration; ADR0002's substantive rules require Server/Cloud proof before the first usable release. The repository was edited during this review: its 0002 header now mentions SQLite Server and a later 0010 decision, while the body still requires server-database proof. I did not use that later arena decision as evidence for my independent selection. SQLite Server and an early tested PostgreSQL adapter are compatible.

SQLite-only is sufficient for the measured single-process load; database latency is not a reason to mandate PostgreSQL for the first owner. Its strongest advantage is a synchronous local transaction model, but the passing TS spike already uses an asynchronous worker boundary to preserve concurrent reads. PostgreSQL does not make pure domain calculations asynchronous; it makes the I/O shell asynchronous. I would choose option 1 if Cloud proof is explicitly deferred beyond the first usable version and the dual-engine contract/migration cost becomes material. I would choose option 3 only after full-scale PGlite W1–W9 and recovery/durability evidence match native PostgreSQL while preserving zero-configuration Local operation.

**C. Runtime: Bun, provisionally.** It has complete full-data, both-store, concurrency and registry evidence. In my explicit TS `run2` extras pass, Node 26.11.1 also passed embedded W1–W8 with zero errors: search p95 55.37 ms, ingest p95 499.99/max 551.40 ms, cold-start median 285.01 ms and RSS 891.21 MiB. That noisier, unpaired Node run omits PostgreSQL and W9; it does not establish that Node is inherently slower or less reliable. Choose Bun because this implementation is proven further. I would switch for a required dependency incompatibility, worker lifecycle/recovery defect, or a paired Node both-store W9/soak comparison showing a meaningful operational advantage. [Bun documents Worker lifecycle caveats](https://bun.sh/docs/runtime/workers), so a process/worker failure soak is still required.

My PGlite extra ran W1–W5 and parsing at only 10,000 cases/100,000 results, 5,000 open questions and 10–20-row folder pages; it retained 10,000 tests so reports still resolve 9,900 keys. It passed those subset checks, but reported `fsync=off` despite `synchronous_commit=on` and `relaxedDurability=false` on NodeFS. The [PGlite durability option](https://pglite.dev/docs/api) and [filesystem modes](https://pglite.dev/docs/filesystems) do not replace a measured crash/recovery proof. This is insufficient evidence for option 3, not evidence that PGlite can never work. Optional data copied into TS `run3`/repeat results was not remeasured there; only the explicit `run2` extras are used here.

**D. Biggest risk: CI ingestion makes editing wait behind the per-project writer.** TS's median mixed-load save p95 was 586.07/398.62 ms (SQLite/PostgreSQL), despite green read budgets; Go and Rust show the same contention mechanism. The cheapest revealing test is one real editor slice, two tabs editing the same case with required bases, and the existing 16-reader/back-to-back 10k-report harness for several minutes. Measure keypress-to-paint separately from durable save acknowledgment, pending-draft survival, writer queue growth and replay/conflict correctness. Keep the specified one-transaction report semantics. I would reduce this concern only after the UI meets its input budget, pending saves remain intelligible and recoverable, and queue/latency tails stay bounded at the intended CI load in both stores. More API instances alone will not fix a project-row lock.

**What I could not establish**

- No actual editor, browser input-to-paint measurement, shared Markdown/outline/diff/merge/verdict package, generated Go/Rust web binding or decision-witness implementation exists in these spikes. Compiler-safety scores distinguish language facilities from demonstrated code.
- The extra independent SQL-oracle audit is SQLite-only. PostgreSQL correctness was exercised by each rerun's driver/selfchecks and inspected shared transaction implementation, not an additional judge-written PostgreSQL oracle. No physical power-loss, kill-during-commit, multi-instance commit-order or long WAL/checkpoint test was run.
- No 10M+ historical-result dataset, varied tenant/project sizes, production authorization, real nested JUnit corpus, migrations, export/import, consistent backup/restore, event delivery or durable job recovery was tested. The growing 1M seed is not proof of unbounded users/teams.
- No real Coolify/Unraid/AWS/GCP deployment, other operating system, target home-server hardware or container-image build was tested. Native packaging/cold-process starts are local evidence only. Optional Go/Rust alternative-driver numbers and historical clean-build values copied by their aggregators were not treated as my measurements.
- I preserved failed/interrupted and superseded runs, rather than treating report claims as current evidence. Five alternating runs reduce load drift; they cannot remove shared-host interference or make different harnesses, pools and relevance functions identical.

Evidence: the judge's audit code and results, the SQL diagnostic and `summary.json` (every run's numbers) are beside this file. The frozen candidate sources are under `candidates/`. The raw per-run logs stayed on the build machine and were not kept. This verdict changes no repository decision.
