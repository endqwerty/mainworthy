# Casebook budgets

Run `bun bench/run.ts --quick` for 5k cases / 2k tests / 50k results.
Run `bun bench/run.ts` for 100k cases / 20k tests / 1M results / 50k open questions.
Use `--cases N --tests N --results N` to change scale, and `--json bench/report.json`
to preserve samples, repeat ranges, hardware, load, correctness, and SQL profiles.
Numeric misses or correctness errors exit nonzero, including any repeat miss.
`bun test test/budgets.test.ts` runs small regression tripwires in the ordinary check.

| Workload | Budget in milliseconds |
| --- | --- |
| Full case read, last 20 results of a test, commit gate | p95 < 20 |
| Folder page of 50, with proof and question counts | p95 < 50 |
| Search: common word, two words, rare token, prefix | p95 < 100 each |
| Seal/adopt one case; record one manual result in a run | p95 < 50 |
| Move 1,000 cases and add a tag, five fresh proposals | every call < 1,000 |
| Ingest 10,000 results, ten fresh reports | every call < 2,000 |
| Gate readable from report start, with failure questions | every call < 5,000 |
| Queue: 50 rows and counts at the actual open population | p95 < 50 |
| Changed since, impact for 20 files, JUnit file read/parse | report only |
| HTTP reads during concurrent ingest and saves | p95 < 50 pooled |
| Small check: fresh ingest of 5,000 results | every call < 1,000 |

The seeded baseline lives on disk in `.casebook/bench`, with production WAL and
pragmas. Memory filesystems are refused. Parameters, generator hash and migration
hash must match for reuse. Every run clones the closed baseline and removes its
writes afterward. About 500 folders have two levels. Cases have 3–9 steps, about
60% expected results, tags and natural search terms; 20% have 1–5 history edits.
Owner proposals create and edit cases in batches of 1,000. An authenticated CI
actor registers tests and reports results in batches of 5,000 on trunk commits.
Standard-preset map questions get bulk link decisions for three quarters of tests.
Failure decisions carry while others stay open. Separate PR reports fill the queue,
capped at three minutes or five seconds in quick mode. Those results and 250 manual
results are additional to the requested history. A 500-case run is half filled.
Twenty untimed recent edits on each clone exercise real changed-since diffs.
Full cursors are 300 commands back; quick/small cursors precede the recent edits.

Each workload has warmup and five sample blocks. Assertions check real outputs
and committed writes outside operation/HTTP-response timers. Failed samples count.
Full workloads within 2x their budget repeat five times on fresh clones; the report
prints median and range, and any trial miss fails. First-run numbers stay visible.
Random case reads warm five requests; repeated identical list/search queries are
warm-cache measurements. Diagnostic cold calls are separate and never timing samples.

HTTP uses 16 keep-alive readers, one ingest client and one save client for 15 s,
after a 5 s readers-only control. Default uses five independent windows; quick one.
Per-operation control/mixed statistics reveal reader saturation. Clients share the
server process/thread, so this is an end-to-end saturation test, not isolated write
stall attribution. The longest read overlapping an ingest and accept/apply spans
are printed; apply spans include reads served between the product's current slices.
Ingest timings cover acceptance plus apply, stricter than C7's acceptance alone.
SQL/CPU/I/O diagnostics identify the limiter and EXPLAIN plans. A miss needs a
product fix and a repeat under comparable load; changing a budget hides the problem.
## Under load, from another process

`bun bench/external.ts <dataset directory> [seconds] [reader threads]` starts the server as its own process and
drives it from this one: sixteen readers (a case, a folder page, a test's history, a gate, the queue, a search),
one client sending 10,000-result reports back to back and one saving a case. This is the measurement to trust for
reads under load: `run.ts` keeps its clients on the server's thread.

On the full dataset (100,000 cases, 1,050,120 results, 50,000 open questions), 20 s windows, 2026-10-12, a
16-thread desktop shared with other work:

| Reader threads | Reads alone p95 | Reads under load p50 / p95 / p99 | Reads/s under load | One report p50 / slowest | Save p50 / p95 |
| --- | --- | --- | --- | --- | --- |
| 0 (inline) | 106 ms | 49 / 78 / 115 ms | 309 | 5,237 / 5,415 ms | 4,992 / 5,156 ms |
| 4 | 33 ms | 18 / 54 / 77 ms | 690 | 476 / 1,185 ms | 280 / 393 ms |
| 8 (the default on this machine) | 37 ms | 15 / 48 / 75 ms | 831 | 653 / 1,321 ms | 457 / 570 ms |

The read budget (p95 under 50 ms) is met with eight reader threads and narrowly missed with four. Before
checkpoints moved to their own thread and the apply slice went from 500 to 200 results, four threads gave a p95
of 108 ms. **A save waits behind a report** at every setting: there is one writer, and the save's acknowledgement
comes after the report in front of it (issue #60). Search is the slowest read in the mix (p95 about 63 ms under
load).

JUnit loads dynamically and skips explicitly if absent. The small check catches large
regressions, not the full-scale promise. CLI/binary wiring for B6 belongs to the CLI.
