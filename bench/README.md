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
JUnit loads dynamically and skips explicitly if absent. The small check catches large
regressions, not the full-scale promise. CLI/binary wiring for B6 belongs to the CLI.
