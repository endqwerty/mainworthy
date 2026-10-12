# Casebook budgets

Run `bun bench/run.ts --quick` for 5k cases / 2k tests / 50k results.
Run `bun bench/run.ts` for 100k cases / 20k tests / 1M results / 50k open questions.
Use `--cases N --tests N --results N` to change scale, and `--json bench/report.json`
to preserve samples, five repeat-block ranges, hardware, load, correctness, and SQL profiles.
The command exits nonzero on a numeric budget miss or an operation/correctness error.
`bun test test/budgets.test.ts` runs the small regression tripwires in the ordinary check.

| Workload | Budget in milliseconds |
| --- | --- |
| Full case read, last 20 results of a test, commit gate | p95 < 20 |
| Folder page of 50, including proof and question counts | p95 < 50 |
| Search: common word, two words, rare token, prefix | p95 < 100 each |
| Case save through seal and adopt; one manual result into a run | p95 < 50 |
| Move 1,000 cases and add a tag, five fresh proposals | every call < 1,000 |
| Ingest 10,000 results, ten fresh reports | every call < 2,000 |
| Gate readable from report start, with failure questions | every call < 5,000 |
| Queue: 50 rows and counts at the actual open population | p95 < 50 |
| Changed since, impact for 20 files, JUnit file read and parse | report only |
| HTTP reads during concurrent ingest and saves | p95 < 50 |
| Small check: fresh ingest of 5,000 results | every call < 1,000 |

The seeded baseline lives in `.casebook/bench`, on disk, using production WAL and
pragmas. Memory filesystems are refused. Matching parameters reuse a completed
baseline; each measurement run clones it and removes its own changes afterward.
About 500 folders have two levels. Cases have 3–9 steps, expected results on
about 60% of steps, tags, natural search terms, and 20% have 1–5 history edits.
Owner proposals create and edit cases in batches of 1,000. An authenticated CI
actor registers tests and reports results in batches of 5,000 on trunk commits.
The standard preset's map questions are answered with bulk link decisions for
three quarters of tests. Some failure decisions carry; others stay open.
Separate failure reports across PR scopes fill the queue, capped at three minutes
or five seconds in quick mode. Their results and 250 manual results are additional
to the requested history. The planned run pins 500 cases and is half filled.

Every operation has warmup and timed repetitions. Assertions verify real returned
content and persisted writes outside isolated timers. Errors stay in the samples.
Near-budget full workloads repeat five complete runs; HTTP uses five independent
15-second windows with 16 keep-alive readers, one ingest client and one save client.
Quick mode uses one HTTP window. JUnit parsing loads the adapter dynamically and
skips explicitly when its file is absent. No network service or new dependency is needed.

A MISS is evidence about this checkout on this machine, not an excuse to relax a
promise. Check errors first, then load and repeat ranges. Untimed profiles report
CPU/wall time, SQL calls and EXPLAIN plans. Writes are synchronous on one thread:
the mixed report prints the longest read overlapping a 10k ingest and the ingest
transaction durations. Moving apply to a worker with its own SQLite connection,
or slicing apply while retaining the pending gate horizon, is the smallest likely
fix for write-induced read stalls. Product fixes belong outside this benchmark.

The small test catches large regressions; it does not prove the full-scale promise.
CLI/binary wiring for B6 is owned by the CLI implementation, outside these files.
