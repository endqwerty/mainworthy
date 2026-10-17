# Reports

Date: 2026-10-17. Issue [#56](https://github.com/endqwerty/mainworthy/issues/56).

## Problem

The MVP showed counts on the queue and the tally of a run. The vision's basic reports were not built: pass rate
over time, coverage by requirement, automation rate and backlog, the flaky tests and the time reruns cost. Every
one of them is a question about the one stream of results, so each must count a result the way the gate does, or
a report and a gate would disagree about the same day.

## Decision

**One read, tagged by what it reports.** `stats` takes `of` (`pass-rate`, `flaky`, `reruns`, `automation`,
`coverage`) and a window of 1 to 90 days, and each kind has its own reply in `src/core/stats.ts`. The web screen
reads each report on its own, so a slow one does not hold the others, and the CLI prints one report, not five.
It is not an agent tool: the tools are at their token budget (decision 0087). Agents read it over HTTP or the CLI.

**The pass rate counts what a gate counts.** Each lane (a target, test, producer, method and job) counts the result
it ended with in the window, ranked in SQL by the order of `replacesInLane`: a decisive result before one that
decided nothing, a higher attempt before a lower, the worse outcome of one attempt, then the later. For results
that arrive in the order of their attempts this is what the fold gives, and `test/stats.test.ts` checks it against
`replacesInLane` on random reports. A corrected result is not counted, a quarantined failure is counted apart, and
skips and blocks are counted beside the rate and not in it.

**Days are the reader's.** The pass rate takes a time zone (`zone`, default UTC; the web page sends the browser's)
and splits the window at that zone's midnights (`src/core/days.ts`), so a day the clocks change is 23 or 25 hours.
SQL counts the results in quarters of an hour and each quarter is placed in its day; every zone's midnight is a
whole quarter of an hour in UTC. Joining each result to its day in SQL cost ten times as much.

**The other reports.**

- Flaky: the tests with a flip in the window (a pass and a failure on the same code, recorded on ingest), most flips
  first, against the automated tests that reported in it.
- Reruns: an attempt that a higher attempt of the same lane repeated. Its reported duration is time lost; an attempt
  with no duration is counted and said apart.
- Automation: a case is automated when an automated test is linked to it. The rate is automated cases over active
  cases, less those marked as cannot be automated that have no test. The backlog is the rest, the ones run by hand
  most often in the window first.
- Coverage: each requirement with its active cases, each case by the latest result of each of its tests in the window.

**An index on the time of a result.** Migration 27 adds `results_at (project, at)`, so a window reads its own rows,
not the project's history. It changes the plan of no earlier statement (compared statement by statement on a seeded
demo). One new statement has to keep away from it: a test's latest result reads `results_test` (`+r.at`), which
`results_at` made a scan of the whole window per test, 6.9 s on the demo.

**A budget.** `bench/workloads.ts` reads each report over 30 days, under 100 ms at p95 (`bench/contracts.ts`), so a
lost index fails the check.

## Turned down

- **One reply with all five reports.** One slow report would hold the screen, and the CLI would print all of them.
- **`find --in reports`.** `find` lists rows and pages; a report is an aggregate.
- **The fold in TypeScript.** Exact for any order of arrival, but it reads every result of a lane that has more than
  one. The benchmark reports most tests several times on one commit, and the fold took 450 ms for 20,000 results;
  the ranking in SQL takes 35 to 55 ms.
- **A bar chart of the daily rate from zero.** Rates sit near 100%, and every bar was the same height. The chart is a
  line whose scale starts at the lowest day's rate rounded down to a ten, with both ends labelled; a percentage near
  either end keeps a decimal, so one failure in a thousand does not read as 100%.

## Not done

- The automation rate over time, which needs the history of links, and tests that stopped reporting (stale).
- The requirements workflow, its coverage matrix and gap list: issue #41.
- Dashboards a person arranges. The five reports are fixed.
- A result that arrives after a higher attempt of its lane that decided nothing (a late attempt 1 after a skipped
  attempt 2) is counted by the gate as the skip and by the pass rate as the older result.
