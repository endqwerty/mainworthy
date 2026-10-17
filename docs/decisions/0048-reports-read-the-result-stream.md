# 0048: Reports read the result stream

Issue #56 needs project reports without a separate ingestion pipeline or changes to hot detail reads.

## Usage and shape

The web screen calls `reports` with `{ days: 30 }`. The CLI accepts `mainworthy reports --days 90`. The reply has a UTC time range, daily pass counts and rates, current automation and requirement coverage, at most 50 flaky tests, and rerun counts and duration. Lists in the automation backlog and requirement coverage are capped at 50 and 100 with uncapped totals. The operation requires read access and is not an MCP tool.

Evidence owns result aggregation and automated-test links. Suite owns active-case and requirement counts. The operation combines their replies. The screen validates the reply through the core schema and uses the existing two-pane navigation and phone shell.

## Alternatives and decision

We considered composing `find`, `get` and `timeline` in the browser. Those bounded detail reads would require fetching each test and its history, and their limits could silently truncate totals. We chose one aggregate operation in the registry. SQL stays in each table's owning module, and the read needs no new ingestion logic. A covering project/day index bounds daily counts to the requested UTC days. An exact timestamp filter excludes results after the read time. SQL aggregates live automated results into lanes and then per-test metrics. It returns daily rows, at most 50 flaky tests, and one rerun total. JavaScript never receives or keys individual lanes. Suite also computes automation totals in SQL and returns only the first 50 backlog cases; it receives automated case ids from evidence without reading its tables.

The lane index groups by project, method, test, target and producer. It stores timestamps, outcomes and durations. The uncorrected-project query is covering. The correction-aware query also reads `corrects` from the result row, so that query is not covering. The read computes a fixed-width sequence and ordinal key to select the first execution and its duration without relying on timestamps or result ids. Corrections resolve this key through their original execution. Every window reads each test's lanes directly through the index. An existence check finds an earlier execution in the same lane when results lie outside the window. SQL computes this once per lane. Without corrections, it compares indexed sequence and ordinal values directly. The previous bounded variant materialized selected results and built an automatic index; it missed the 100,000-result budget when older history existed and has been removed. With one automated job in the project, grouping follows the lane index without a sort or batch join. Several jobs use the same per-test aggregation with a job grouping. The correction index identifies tests touched by corrections. Only those tests use the correction-aware grouping and per-result correction lookups; other tests keep the covering read. No stored report cache is needed.

We also considered maintaining counters when results arrive. That would add state to update for corrections and arbitrary time windows. Query-time SQL aggregation preserves the result stream as the source of truth. A seeded row-by-row reference checks both query variants.

## Definitions

Daily rates count uncorrected observations, including every attempt and every outcome. Corrections replace observations. Automation means an active case has a linked automated test. Backlog means automation is wanted and no such link exists. Requirement coverage counts active case links, not passing evidence.

Flaky signals require both pass and fail on the same test, target, producer and job within the period. Reruns repeat an earlier automated execution in that lane, even when the first execution preceded the period. Durations are summed test time, not elapsed or staff time. A result that corrects an earlier observation does not create a second execution. Chained and sibling corrections share the original execution position. Any observation with a correction is superseded, matching gate and latest-result reads. If two live corrections replace one result, both outcomes and observation times contribute to daily and flaky counts. Reruns count their shared execution once, using the latest live correction within the period for its duration. A correction outside the period contributes no rerun duration within it.

The web screen reads 30 UTC days. The operation accepts 1 to 366 days. Days without evidence have no rate and are omitted. Current suite counts do not depend on the chosen period. These reports make no decisions and do not change gates.


## Port to the current result model, 2026-10-17

Result excuses and per-observation quarantine coverage change the gate, not the observed outcome. Both stay in the daily denominator, flaky mixtures and rerun time, including after quarantine exits. A flaky answer is not required to appear in the flaky list. Ending an attributed answer on a pass changes no report metric. Automation and backlog depend on active case links to tests of kind `auto`. A case executed by hand does not count as automated, matching the Tests screen.

Each applied shard contributes its observations immediately. An absent shard creates no synthetic result and the report does not claim a complete commit or a passing gate. The lane uses the job, not the shard index: moving the same test between shards of a job does not reset execution history. Idempotent report retries add nothing. Corrections remove the replaced observations and do not add executions. Requirement coverage stays a current count of active case links.

The owner chose the analytics budget on 2026-10-17: **p95 below 100 ms at 100,000 results**. Reports are an analytics read, not a hot path. At one million results the 30-to-366-day read has no budget, like `impact`. The earlier branch measured about 0.7 to 1.1 seconds of CPU per call there. The benchmark records the read and correctness at that scale without applying the 100,000-result budget. No existing budget increases.

The demo re-sends its whole automated suite in a deterministic passing retry, including its quarantine example, so Reports shows a same-target pass/fail mixture and recorded rerun time. The added event uses no existing random stream.


## Index cost

Migration 0027 adds two read indexes and has `archive: false`, because indexes do not change archive rows. Shipped migrations stay unchanged. The original branch added a third index on project and time plus a fixed-width expression in its wide lane index. The day index can answer the outside-period existence checks too, so the time index is redundant. Computing the position during a read removes that expression from every ingested result. A narrow lane index avoids more write work but requires table lookups for outcomes, timestamps and durations. The wide lane index retains those columns to reduce table reads for the 100,000-result budget; correction-aware reads of `corrects` still require a result-row lookup.


On 2026-10-17, five alternating local runs of the `test/budgets.test.ts` ingestion workload, each with five measured 5,000-result reports, gave median round medians of 164.08 ms with no added indexes, 192.07 ms with the branch's three indexes, and 169.29 ms with the retained two. The fixture had 2,000 cases, 500 tests and 20,000 earlier results, with production WAL on disk. All 75 measured reports passed the workload's persisted-result and gate checks. Round maxima were 180.98 to 204.64 ms, 197.42 to 219.77 ms and 181.01 to 199.02 ms respectively, below the existing 1,000 ms limit. These local comparisons ran on Bun 1.4.3 and a ten-core Mac with other simulator activity.

The original retained-index measurement put all 100,000 results within one UTC day, with 10,000 cases and 2,000 tests, and read 366 days. It measured 45.34 ms at p95 across 25 reads with no correctness errors; it did not exercise the older-history path used by a 30-day screen window. The five block p95 values ranged from 43.45 to 45.35 ms. The narrower index trial took 59.35 to 88.08 ms at p95 across five blocks, so it left less room in the read budget. Extra index writes account for the ingestion tradeoff. The day query plan uses a covering range search.

The review fix measured a 30-day window on a file-backed WAL database with 10,000 cases, 2,000 tests, 100,000 stored results, 50 batches and 16 targets, without `ANALYZE`. Five alternating before/after runs measured 15 reads per shape per run. For one job, p95 was 36.65 to 39.30 ms with all results in the window and 144.09 to 50.22 ms with 10% of results at 40 days before the read. For four jobs it was 69.26 to 60.58 ms and 139.39 to 75.21 ms respectively. Adding one same-lane correction to the four-job older-history shape measured 162.41 to 76.61 ms. All 750 measured reads passed the daily, suite, flaky and rerun correctness checks. The budget regression retains these five shapes, using bulk SQL to build the read fixture instead of the full ingestion and suite-history generator. No index or ingestion code changed in this fix.
