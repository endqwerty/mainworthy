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

**A failed try's cause follows the same file split as a result's** (decision 0036, issue #734).
Failed tries and results count together toward the distinct-test and reported-file thresholds across applied
reports of one repository and commit. Each current report's assertion causes are assigned before runs and
decisions read them, including when the final result passed or failed with a different cause. Later reports reuse
stored file causes. Earlier reports keep their original causes; no history is regrouped.

**Parsers fill `tries`.** Playwright's executions before the one it ended on, judged as the result is (an expected
failure passes). Surefire's flaky and rerun elements, as failed tries with their message, in the order they ran:
Surefire writes an exhausted test's first run as the testcase's `failure` and the later runs after it, so the last
rerun is the result and the `failure` the oldest try. Their causes differ, and a flip from an earlier attempt is to
the first.

**A result keeps at most a hundred tries.** The Playwright parser refuses a test with more rather than dropping the
oldest, because the try it dropped could be the only pass, and the flip with it. Every Surefire try failed, so its
parser keeps the first run and the last 99, which decide every flip and the cause a flip from an earlier attempt names,
and says so in a warning.

**"Passed on attempt N" needs that attempt's result to pass.** A failure is recovered by a later attempt that ended
passing, whether its flip from the failure ends at a try or at the result: one that failed inside the runner and then
passed, or one that passed on its first try. It is not recovered by an attempt that passed on a try and ended
failing.

## Turned down

- **Tries as results with a `try` number.** Every place that orders or compares attempts, about fifty, including the
  gate's lanes and the reports' ranking, would need the new order. A try is not something a gate counts.
- **A count and the first failure's cause on the result.** It could not tell a pass followed by a failure from the
  reverse, which a Playwright serial group produces when its members run again together, nor keep a cause that changes.
- **Two flips for a recovery across attempts and tries.** It would let one recovery meet the detector's threshold of two.

## JUnit suffix sequences, 2026-10-22

[Issue #733](https://github.com/endqwerty/mainworthy/issues/733) extends the same shape to separate JUnit testcases.
One unsuffixed testcase followed in document order by consecutive retry numbers from 1, within the same suite
instance and structural test identity, becomes the last testcase's result with earlier tries. Grouping compares the
full prefix and stable name separately, because rendered keys joined with `::` can collide. Parsed file metadata must
also match, including its presence or absence. Matching annotations and no
mixed Surefire retry elements keep the sequence unambiguous. The original name identifies the test, the duration
sums the executions, and the last testcase supplies attachments. Ambiguous duplicates keep decision 0045's
worse-outcome rule. More than 100 earlier tries is refused, as for Playwright. XML damage is applied before grouping.

## Follow-up status

JUnit suffix testcases are handled above by issue #733, which closes with this change. A try's cause split by file
(issue #734) and the runner-duration reruns report (issue #735) are now implemented.

Jest, Vitest and pytest reports still do not export their retries (issue #736, open).

The iPhone test page reads tries and the later passing attempt through its generated contract, labels flaky
results and lists the runner's outcomes like the web page (issue #737).
