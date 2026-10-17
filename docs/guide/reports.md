# Reports

Open **Reports** in the sidebar, or press `g a`. Select a report with `j` and `k`. On a desktop, its detail appears immediately. On a phone, press Enter or tap a report to open its detail.

The web screen reads the last 30 UTC calendar days, including today. The command `mainworthy reports --days 90` reads up to 366 days. The API operation is `reports`. It needs read access and changes no data. Each report belongs to the selected project.

## Pass rate over time

Each row is a UTC day with results. The pass rate is passes divided by all outcomes, including skip, blocked, and error. Every uncorrected attempt counts. A corrected result is replaced by its correction. Decisions that excuse failures and quarantine coverage do not change these observations, including after an answer ends or quarantine exits. Shards contribute results as they arrive. Missing shards are not counted, so these rates do not prove a commit is complete. Days without results are omitted, so an empty period has no pass rate.

## Automation and backlog

Automation rate is the share of active cases that have at least one linked automated test. Multiple tests linked to one case count once. Archived cases do not count. This measures a link, not passing evidence or whether a case permits automated results.

The backlog counts active cases with **Automation** set to **Wanted** that have no linked automated test. It lists the first 50 by case number, with links to those cases. These are current suite counts, independent of the result period.

## Coverage by requirement

Coverage counts recorded requirements with at least one active case linked to them. It does not measure passing evidence or requirements that have never been recorded. The report lists the first 100 requirements in natural key order, such as WEB-2 before WEB-10, and gives totals over all recorded requirements. Archived cases do not provide coverage. These are current counts.

## Top flaky tests

A test appears when its automated results include both pass and fail for the same target, producer, and job within the period. The target includes the environment. Results from different commits, environments, producers, or jobs do not combine into a flaky signal. Shards of one job share its history. A flaky answer is not required, and quarantine does not hide the signal. Corrected results do not contribute.

The list shows up to 50 tests ordered by the number of affected combinations, called lanes, then test number. This signal does not decide that a failure is flaky or change its gate.

## Time spent on reruns

A rerun is an automated result after an earlier execution for the same test, target, producer, and job. The earlier execution can precede the period. A correction replaces an observation rather than adding an execution. It keeps the original execution position, including through a chain of corrections. If two live corrections replace the same result, both observations count toward daily rates and flaky signals, but their shared execution counts once for reruns. Its duration comes from the latest live correction within the period.

The report sums recorded durations of reruns within the period. It also gives the count with no recorded duration. Parallel tests can overlap: the sum measures test execution time, not elapsed build time or staff time lost.
