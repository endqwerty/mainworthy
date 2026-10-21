# 0129: A test runner's tries are evidence beside its result

- Date: 2026-10-21
- Status: accepted (the owner asked for it in the thread that built it, 2026-10-21)

## Problem

The owner: "Playwright has auto retry. Are we not handling that? We should be able to handle auto retries by test
runners."

A runner that retries a failed test inside one run reports one result per test. Mainworthy's parsers read the retries
(Playwright's `results[]`, Surefire's `flakyFailure` and `rerunFailure`) and kept only the outcome the runner ended on,
with a note "passed after N retries". Flips are recorded between attempts of the pipeline (decision 0045), so a test
that failed and then passed on the runner's own retry left no flip. The results, the test's page, the flaky report and
the detector all read it as a clean pass.

## Decision

**The result stays the runner's last word; its earlier tries are kept beside it.** A result in a report may carry
`tries`, oldest first, each with an outcome, a duration and a failure. They are stored in `result_tries`, owned by the
evidence module. The result is what the gate, the tallies, the lanes and every comparison of attempts count, so none of
those change. A runner-retried pass still passes the gate, as it did.

**A try that disagrees with the next is a flip.** At ingest, the decisive tries and the result are walked in order,
and each change between pass and failure is a row in `flips` with the same result at both ends and `first_try` and
`second_try` naming the tries (null for the result itself). Between attempts, the earlier result meets the new
attempt's first decisive try, not its result: a test that failed on attempt 1, then failed and passed inside attempt 2,
recovered once, and records one flip. Tries that only failed, or were skipped, add none.

Every reader that counts flips counts these with no change, because it reads the flip's results and their corrections:
the test's flip count, a run's flaky tests, the flipped rows of a commit's results (pull request #730) and the
flaky report. The detector (decision 0045) takes each end's outcome and cause from its try when it has one, and a sample
names the try. A correction of a result withdraws the flips of its tries, as it withdraws a flip of the result.

**Parsers fill `tries`.** Playwright's executions before the one it ended on, judged as the result is (an expected
failure passes). Surefire's flaky and rerun elements, as failed tries with their message, in the order they ran:
Surefire writes an exhausted test's first run as the testcase's `failure` and the later runs after it, so the last
rerun is the result and the `failure` the oldest try. Their causes differ, and a flip from an earlier attempt is to
the first.

**A result keeps at most a hundred tries, whole.** A parser refuses a test with more rather than dropping the oldest,
because the try it dropped could be the only pass, and the flip with it.

## Turned down

- **Tries as results with a `try` number.** Every place that orders or compares attempts, about fifty, including the
  gate's lanes and the reports' ranking, would need the new order. A try is not something a gate counts.
- **A count and the first failure's cause on the result.** It could not tell a pass followed by a failure from the
  reverse, which a Playwright serial group produces when its members run again together, nor keep a cause that changes.
- **Two flips for a recovery across attempts and tries.** It would let one recovery meet the detector's threshold of two.

## Not done

- JUnit testcases repeated with `(retry #1)` in their names are read as the same test's results, with the worse of one
  attempt counting, not as tries.
- A try's cause goes through the signature's normalization but not the split of broad assertions by file.
- The reruns report ("time lost to reruns") counts the pipeline's attempts, not a runner's tries.
- Jest, Vitest and pytest reports do not export their retries, and the iPhone app does not show tries.

These are issues #733 (`(retry #n)` testcases), #734 (a try's cause by file), #735 (the reruns report), #736
(Jest, Vitest and pytest) and #737 (the iPhone).
