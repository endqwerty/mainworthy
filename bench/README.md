# Mainworthy budgets

For folder sealing, export a baseline revision into a directory made by
`bun scripts/work.ts scratch new folder-seal-base`, link its `node_modules` to the
current checkout's installed dependencies, and run
`bun bench/folder-seal.ts /path/to/baseline/export`. It alternates five fresh
in-memory registry calls per revision for creation and rename batches of 100, 1,000, and
5,000. Each fixture starts with as many sibling folders as edits. Setup is outside
the timer. Standard policy keeps the agent's proposal pending, so the timer covers
sealing without adoption. Assertions check its status, stored edits, and unchanged
folder count. JSON lines contain every sample, CPU time, medians, and ranges.
The final check requires less than tenfold growth for five times the edits.

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
| Each report of `stats` over 30 days (pass rate, flaky, reruns, automation, coverage) | p95 < 100 each |
| Changed since, impact for 20 files, JUnit file read/parse | report only |
| HTTP reads while reports and saves arrive (server in its own process) | p95 < 50 pooled |
| Small check: fresh ingest of 5,000 results | every call < 1,000 |

The seeded baseline lives on disk in `.mainworthy/bench`, with production WAL and
pragmas. Memory filesystems are refused. Parameters, generator hash and migration
hash must match for reuse. Every run clones the closed baseline and removes its
writes afterward. About 500 folders have two levels. Cases have 3–9 steps, about
60% expected results, tags and natural search terms; 20% have 1–5 history edits.
Every case covers one of 100 requirements, assigned by its index without drawing
from the case generator's random stream.
Owner proposals create and edit cases in batches of 1,000. An authenticated CI
actor registers tests and reports results in batches of 5,000 on trunk commits.
Standard-preset map questions get bulk link decisions for three quarters of tests.
The first test fails a 120 ms attempt, then passes attempt 2 on the same commit
and job, so the flaky and rerun reports have rows to read.
Failure decisions carry while others stay open. Separate PR reports fill the queue,
capped at three minutes or five seconds in quick mode. Those results and 250 manual
results, plus both retry attempts, are additional to the requested history.
A 500-case run is half filled.
Twenty untimed recent edits on each clone exercise real changed-since diffs.
Full cursors are 300 commands back; quick/small cursors precede the recent edits.

Each workload has warmup and five sample blocks. Assertions check real outputs
and committed writes outside operation/HTTP-response timers. Failed samples count.
Report checks require populated results: coverage lists all 100 requirements and
their cases' latest outcomes; flaky lists flips; reruns identifies the first test
and its repeated 120 ms attempt. Automation counts both linked and manual cases.
Full workloads within 2x their budget repeat five times on fresh clones; the report
prints median and range, and any trial miss fails. First-run numbers stay visible.
Random case reads warm five requests; repeated identical list/search queries are
warm-cache measurements. Diagnostic cold calls are separate and never timing samples.

The last three rows are measured under load with the server in its own process and
its reader threads on, driven from the benchmark's process (see "Under load, from
another process" below): sixteen readers, one client sending 10,000-result reports
back to back and one saving a case, for 15 s after a warm-up and 5 s of readers
alone. Default: three windows; quick: one. Reads have a budget (p95 under 50 ms) and
so does each report (under 2 s); a save under load is reported without a budget,
because with one writer it waits behind the report in front of it (issue #60).
SQL/CPU/I/O diagnostics identify the limiter and EXPLAIN plans. A miss needs a
product fix and a repeat under comparable load; changing a budget hides the problem.
## The last full run

`bun bench/run.ts` on 2026-10-12 (snapshot `3cd05f8` on the branch `mvp/history`; a 16-thread desktop shared with
other work, load 2.9 at the start): exit 0, no miss in the first run or in any repeat. The whole output is `bench/results-full.log`; `bench/results-quick.log` is the
`--quick` run of the same commit.

| Workload | p50 ms | p95 ms | max ms | Budget |
| --- | ---: | ---: | ---: | --- |
| Case read | 2.29 | 17.01 | 23.34 | p95 < 20 |
| Folder page (50) | 1.62 | 1.86 | 2.84 | p95 < 50 |
| Search, four kinds | 11.90 to 21.15 | 14.02 to 25.44 | 27.55 | p95 < 100 |
| Test history (20) | 0.13 | 0.16 | 0.17 | p95 < 20 |
| Gate read | 0.03 | 0.05 | 0.07 | p95 < 20 |
| Queue (50 of 50,000) | 6.10 | 7.29 | 9.30 | p95 < 50 |
| Case save | 2.01 | 15.42 | 30.94 | p95 < 50 |
| Bulk move (1,000) | 258 | 502 | 502 | max < 1,000 |
| Ingest (10,000) | 711 | 803 | 803 | max < 2,000 |
| Gate visible after a report starts | 711 | 803 | 803 | max < 5,000 |
| Record one result in a run | 2.27 | 3.53 | 44.32 | p95 < 50 |
| Reads under load | 17.69 | 47.40 | 581.57 | p95 < 50 |
| One report under load | 765 | 1,428 | 1,441 | max < 2,000 |
| Save under load | 569 | 1,361 | 1,376 | none (#60) |

Reads under load sit just under their budget, as before (#60). Two things this run's first attempt caught, both
from the last engine fixes and both fixed before it: the queue read had tripled, because the question of whether
a failure is disputed was asked of every open run for each row (it now starts from the disputed slots, of which
there are few); and a report that closed thousands of questions recomputed the run that waited for them once per
question (now once per run; `test/budgets.test.ts` counts it).

## Under load, from another process

`bun bench/external.ts <dataset directory> [seconds] [reader threads]` starts the server as its own process and
drives it from this one: sixteen readers (a case, a folder page, a test's history, a gate, the queue, a search),
one client sending 10,000-result reports back to back and one saving a case. This is the measurement to trust for
reads under load: `run.ts` keeps its clients on the server's thread.

Add `bulk 5000` after the reader count to replace the report writer with back-to-back bulk creation,
agent proposals that edit those cases, and a person's acceptance. For example:

```sh
bun bench/external.ts <dataset directory> 20 8 bulk 5000
```

The sixteen readers and short-save client stay the same. The output includes the create, propose, and adopt
sample counts and latencies, read p95, and save acknowledgement p50 and p95. Every accepted batch must name
all cases at version 2. After the load window, the client reads back every case to check its version and title,
and checks each batch's folder count. A rejection, incomplete batch, or incorrect saved version fails the run.
The server uses production mode and a free port. Its disposable database copy stays beside the source dataset
and is removed when the server stops. Use the same benchmark script and dataset for both revisions, alternate
at least five runs per revision, and report each median and range. See
[decision 0082](../docs/decisions/0082-atomic-bulk-proposal-slices.md) for the bulk comparison and remaining save limit.

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
