# Go stack arena

The Go spike runs all required workloads through HTTP in both store modes. The final complete run passed every budget with zero
errors in 208 seconds. It includes the PostgreSQL search tuning described below. All timings are provisional because other arena
candidates share this machine.

## Versions and deployment

- Go 1.27.2, official linux-amd64 archive, SHA256 verified against [go.dev](https://go.dev/dl/).
- Selected embedded driver `github.com/mattn/go-sqlite3` 1.14.52, SQLite 3.53.4, FTS5 enabled.
- Alternative `modernc.org/sqlite` 1.60.1, SQLite 3.53.4, FTS5 included in its build.
- PostgreSQL 18.4, `github.com/jackc/pgx/v5` 5.11.0, pgxpool and binary COPY.
- Official [Go MCP SDK](https://github.com/modelcontextprotocol/go-sdk) 1.8.0.
- `github.com/google/jsonschema-go` 0.4.3 supplies the schemas used by every operation entry point.
- The selected binary includes embedded mode, server mode, HTTP, CLI and MCP.
  It needs no runtime shared libraries. Both driver builds are static ELF executables.

Run `./run.sh` from this directory. It builds when necessary, copies the fixed SQLite seed, resets only `cb_go`, runs real HTTP
checks and every workload, proves the registry and writes `results.json`. No root or Docker is needed. `env.sh` keeps Go's
compiler, module and temporary caches under the requested toolchain directory.

## Workload results

<!-- RESULTS_START -->
| Workload | Budget | Embedded ms | Server ms | Verdict |
|---|---|---:|---:|---|
| W1 | < 20 ms | 0.278 | 0.242 | pass |
| W2 | < 50 ms | 3.658 | 7.534 | pass |
| W3 | < 100 ms | 41.994 | 31.082 | pass |
| W4 | < 50 ms | 12.548 | 18.919 | pass |
| W5 max | < 2000 ms | 560.236 | 297.236 | pass |
| W5a | report | 26.746 | 27.298 | report |
| W6 | < 20 ms | 0.325 | 0.314 | pass |
| W7 | < 20 ms | 0.130 | 0.180 | pass |
| W8 | < 50 ms | 2.541 | 6.877 | pass |
| W9 | < 50 ms | 7.892 | 15.326 | pass |

Values are HTTP p95, except W5, whose budget applies to every request.
Embedded W9 had 5284 reads/s, ingest max 1054.00 ms and save p95 494.44 ms.
Server W9 had 2807 reads/s, ingest max 653.81 ms and save p95 341.47 ms.
There were zero measured and warmup errors, including both mixed writers.
Cold-start medians were 4.12 ms embedded and 4.25 ms server.
Server RSS after W9 was 328.5 MiB embedded and 42.7 MiB server.
The complete run took 208 seconds. There are 2810 authored source/script lines and four active direct dependencies, five including the alternative driver.
<!-- RESULTS_END -->

Each workload has 100 warmups and the specified measured iterations. W5 therefore writes 1.2 million results per mode before W9.
HTTP includes client JSON encoding, loopback keep-alive, server input decoding, the operation, output encoding and client output
decoding. `inProcess` measures the typed operation and store work after input validation. It excludes HTTP and JSON wire encoding.
All reported quantiles use nearest rank. Cold start is process launch to the first successful HTTP response, five runs. The OS
file cache is already warm. RSS is the server process after W9, not the load generator.

## SQLite driver comparison and binary cost

<!-- DRIVERS_START -->
| Driver | Search p95 median, range ms | Ingest p50 median, range ms | Static artifact MiB | Clean build s |
|---|---:|---:|---:|---:|
| cgo | 39.80, 36.61 to 46.11 | 284.72, 259.77 to 306.18 | 16.13 | 62.88 |
| pure | 107.80, 99.70 to 125.13 | 317.39, 305.31 to 420.31 | 17.14 | 17.10 |

These are independent measurements of current source. Clean builds used empty compiler caches and cached modules; they overlapped the verifier benchmark. Driver timings used five alternating fresh-seed HTTP runs with no simultaneous verifier compilation, but host load was 7.9 to 10.7.
<!-- DRIVERS_END -->

Cgo wins the search comparison in every paired round, with substantially more headroom under 100 ms. The ingest run ranges
overlap, so the comparison does not establish an ingest throughput advantage. Both drivers retain FTS5 and WAL durability. Cgo
requires GCC and static C libraries to build. Cross compilation requires a C compiler for each target. Modernc builds and cross
compiles with Go alone, but includes translated SQLite C code and its libc support packages. The chosen driver adds no dynamic
dependency to the shipped binary.

## Tuning and measured limits

The schema and indexes are unchanged. No server settings changed. SQLite uses WAL, `synchronous=NORMAL`, a 30-second busy timeout,
immediate write transactions, 64 MiB of page cache per connection, 16 reader connections and one separate writer connection.
PostgreSQL uses 20 pooled connections, 256 cached statements per connection and `synchronous_commit=on` per session. SQLite caches
prepared reads and prepares transaction statements once per transaction, including the result insert. Pgx caches statements and
inserts the report's 10,000 results with COPY inside the same transaction.

SQLite search originally sorted all matches through a temporary B-tree. FTS5's optimized `ORDER BY rank` removes that sort. On the
`token` diagnostic, the original query's p50 was 32.60 ms and the ranked query's p50 was 14.14 ms. These are diagnostic SQL
timings, not a full HTTP speedup claim. The [FTS5
documentation](https://www.sqlite.org/fts5.html#sorting_by_auxiliary_function_results) describes its ranked-order optimization.
`diagnostics-embedded-sqlite3.json` retains the plans.

The initial PostgreSQL search p95 was 91.09 ms, close to the 100 ms budget. Its plan joined and hashed all 100,000 cases before
taking the top 50. The final query ranks and limits search documents in a materialized CTE first, then performs 50 keyed case
reads. Five alternating `EXPLAIN ANALYZE` runs of `confirmation` took a median 36.008 ms before and 20.981 ms after. Ranges were
35.320 to 36.552 ms and 20.686 to 21.575 ms. The remaining work is ranking matching search documents, sometimes through a parallel
scan on common words. `tuning-postgres-plans.txt` and `postgres-query- comparison.json` contain the evidence.

The queue count is the dominant part of W2 and W8. SQLite's plan uses the covering `question_open` index. PostgreSQL uses an
index-only scan, with heap fetches on recently written pages. Diagnostic count p50s were 1.22 ms and 4.56 ms, while fetching the
50 SQLite queue rows took about 0.025 ms. Mixed saves wait behind report transactions. A project sequence update holds the commit-
order lock until commit. API instances cannot remove that per-project ceiling. The first mixed run's save p95s were 367.76 ms and
237.42 ms.

Two optional CPU-profile attempts ended with SIGKILL. Cgroup counters recorded zero OOM kills and the observed process RSS was
about 70 MiB. The cause is unconfirmed. Profiler output is not used as evidence. Query timings and plans identify the database
work, but do not attribute CPU time to individual Go or C functions.

## Correctness and registry proof

`CHECKS.md` was written before implementation. `selfcheck` sends real HTTP requests and proves rollback for a missing case and
stale base, concurrent command replay, atomic save records, report replay, 9,900 assumed bases, 100 unresolved bases, 200
failures, a run tally and JUnit parsing of 10,000 tests. It also checks compound AND search, relevance order and area restriction.
The workload runner counts every error, checks response invariants and verifies persisted row deltas. Twenty save replays return
identical receipts without writes. Replaying a report leaves row counts and the project sequence unchanged.

Seed signature hashes are synthetic SHA256 prefixes of `sig1`, `sig2`, and so on. The report fixture uses those normalized
messages for ten existing signatures and ten unique 400-byte message groups per batch for the new signatures. New failure
fingerprints use `failure:<signature hash>` and deduplicate that namespace. The benchmark does not interpret or migrate the seed's
opaque question fingerprints.

The registry uses Go generics and reflection over struct tags, with no code generation. `models.go` defines inputs and outputs.
Three calls in `NewRegistry` name and bind the operations once. Generic adapters generate routes, OpenAPI 3.1, MCP schemas and CLI
flags. HTTP and CLI validate the same schema that the SDK uses for MCP. `registry-proof.json` retains `initialize`, `tools/list`,
`tools/call get`, and generated help. `proof.py` asserts that input and output schemas agree byte-for-byte as JSON values across
OpenAPI and MCP, and that CLI and MCP return reference 1.

<!-- REGISTRY_START -->
SDK 1.8.0 implements MCP through 2026-07-28. The stdio proof uses legacy initialize and negotiated MCP 2025-11-25. The tools/list result is 4309 bytes, 4344 bytes including the JSON-RPC envelope and newline.
<!-- REGISTRY_END -->

A fourth operation adds input and output types in `models.go`, its shared implementation in `operations.go`, and one registration
line in `registry.go`. A small operation usually needs 8 to 20 type lines plus its implementation. No per-operation HTTP, MCP,
OpenAPI or CLI code changes. The cost is shared adapter code, reflection and runtime schema validation rather than generated
files.

## Product assessment

Go fits the fast backend and deployment requirements. Context cancellation, explicit transactions, pgx COPY, the maintained MCP
SDK and a static binary give this candidate a workable Local-to-Cloud path. The code is verbose: SQL row scans, nullable values,
transaction errors and dual dialects need care. An agent can forget to check affected rows, leave a result cursor open, return an
error without rollback, accidentally serialize reads or multiply SQLite's cache allowance by the pool size. The checks here cover
the transaction and retry risks. The type system does not prove a query matches the schema. Sqlc or generated query bindings would
add a generation step but catch column and scan drift.

Server can run this binary in one container with PostgreSQL and durable attachment storage. Cloud can run several stateless API
instances for one organisation against PostgreSQL, with object storage and persisted jobs. Use transactional job claims,
idempotent receipts and a sequence change feed for workers and notifications. An optional cache accelerates reads and counts,
while PostgreSQL keeps correctness. Multiple projects can write independently. One very busy project's commit-order row is still a
throughput ceiling.

I would choose cgo SQLite and pgx for a Go implementation of Mainworthy. Go has demonstrated the backend budgets, but this candidate
alone cannot show that Go is better than the other languages. The overall choice needs the lead's serial reruns and a browser-
editor probe that accounts for shared pure logic.

## Limits and verification

This is a bounded spike. It does not implement authentication, a web editor, attachments, export and import, migrations,
notifications, durable worker jobs, full run-policy evaluation or a canonical Markdown parser. Run tally is the current report's
tally, not a complete multi-batch policy fold. Source seed history has one million results. Warmups and mixed writes exercise a
larger history, but a dedicated tens-of-millions test is still needed. Search ranking differs between BM25 and PostgreSQL ts_rank.
The browser logic-sharing extra below is a design sample, not a measured UI.

<!-- VERIFICATION_START -->
Claude Opus 5.5 independently passed source 4cac9a7f468c with no blockers. It ran run.sh in 217 seconds, checked every workload and challenged races, rollback, glyphs, skips, orphan links, references and the CLI/MCP/HTTP contract. The source rebuild was byte-identical. Its contended W9 ingest reached 2,119.6 ms during a clean build, missing 2,000 ms; its rerun was 1,354.9 ms. Keep that miss in the comparison. Full verdicts are in verification-r1.md and verification-r2.md. The supplemental review passed the current-source driver comparison and confirmed WAL with synchronous=1 on both drivers' writer and all 16 reader connections. Three pgx connections confirmed synchronous_commit=on and fsync=on. Its scope was these probes; it did not reread the earlier specifications or reviews. See verification-r3.md.
<!-- VERIFICATION_END -->

This candidate did not change Mainworthy repository files. No commit or pull request is part of this spike.

## TypeScript UI sharing extra

Generate TypeScript operation types from the emitted OpenAPI using openapi-typescript. Extract Body, Step and the pure functions
into a Go core package. Compile that same package natively for the server and to WebAssembly for the browser, with a small JSON
bridge.

```go
func PrepareEdit(before Body, md string) (Body, []StepChange, error) {
	after, err := ParseCanonical(md)
	if err != nil { return Body{}, nil, err }
	return after, DiffSteps(before, after), nil
}
// SplitOutline(text) lives in the same portable core package.
```

```ts
import type { paths } from "./api.generated";
type Propose = paths["/ops/propose"]["post"]["requestBody"]["content"]["application/json"];
const after: Propose["body"] = coreWasm.parseCanonical(markdown);
const diff = coreWasm.diffSteps(before, after);
const steps = coreWasm.splitOutline(pasted);
```

Each operation-type change edits Go types and regenerates one TypeScript file. Each grammar or diff change edits one Go
implementation, rebuilds native and WASM artifacts, and runs shared fixtures on both. There is no second parser to update, but the
WASM loader, JSON copies and startup cost need a browser latency check. A TypeScript port instead requires two implementations and
fixture updates per logic change. No UI or WASM build was attempted.
