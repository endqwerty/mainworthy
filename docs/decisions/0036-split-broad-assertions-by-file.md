# 0036: Split broad assertion causes by file

Date: 2026-10-14. Status: accepted.

## Problem

A generic assertion message can describe unrelated failures. Giving them one signature lets one answer
classify all of them. The design's deferred guard is tracked in [issue #58](https://github.com/endqwerty/mainworthy/issues/58).

## Decision

Apply the design's thresholds across applied reports for one repository and commit, including all its environments
within the project. For each assertion signature, count distinct test ids and distinct non-null stored file names.
The current report counts after its results have been inserted and their tests resolved. Reports accepted but
not yet applied do not count. Session reports without a commit retain per-report detection.
More than 50 tests and more than five files means a separate signature for each file, including a separate
null-file group. A file literally named `no file reported` remains a different cause from the null-file group.
Timeouts and infrastructure failures remain grouped across files.

The evidence module assigns these signatures before the report reaches runs or decisions, within the same
transaction that inserts its results. Its internal helper has the shape
`splitBroadAssertions(ctx: Ctx, batch: BatchRow, results: Applied[]): Generator<undefined, void, void>`.
It changes only results inserted by this report. Each split signature hashes the original signature hash
and the file name. Its text starts with `Split by file (FILE):`, which the queue, CLI and API already show.
The original failure message and detail stay unchanged.

Later reports reuse a file's split signature even below the thresholds. Detection still counts the original
normalised signature, including files already split, from the preserved failure message and detail. Once a
commit crosses the thresholds, a small later report also splits previously unseen files. A generic answer
given before the split does not cover new file signatures. Historical results and their decisions keep their
earlier meaning. Replaying a report returns its saved receipt without applying it again.

We considered splitting only the questions. That would leave excuses keyed to the same signature and let
an answer still cover unrelated files. Changing decision scopes instead would require file filtering in
all run, excuse, dispute and withdrawal paths. Assigning the final cause in evidence keeps those paths intact.

## Calibration

Read the actual JUnit artifacts of two failed Mainworthy CI runs through `parseJUnit` and
`normaliseFailure`:

- [Run 38678345103](https://github.com/endqwerty/mainworthy/actions/runs/38678345103), commit
  `0f6f0e67355b2e991a1d24956b5b78d9b5d804e6`: 1,889 results, one assertion failure in one file.
- [Run 38514950503](https://github.com/endqwerty/mainworthy/actions/runs/38514950503), commit
  `d5623a3885600d24a5b704023b4c67a99291e469`: 1,829 results, two assertion failures sharing one normalised
  cause and one reported file.

Neither sample triggers the guard. This preserves grouping for these ordinary failures. Three failures
cannot establish a better threshold for a broad incident, so retain the specified 50-test and five-file
limits. Regression fixtures exercise both strict boundaries, a broad generic assertion, repeated results,
missing files, old answers and later small reports. This is a limited calibration sample, not evidence that
the thresholds are optimal for all runners.

## Limits

Detection originally counted only one report. [Issue #262](https://github.com/endqwerty/mainworthy/issues/262)
extends it across a commit's applied reports so small CI shards can trigger the split together. Different
commits and repositories do not combine. Distinct tests are counted across attempts, including earlier failures
later replaced by a pass.

Only the current report's results receive file signatures. Reports applied before the thresholds were crossed
keep their original causes, including an open generic question. Application order therefore determines which
earlier failures retain the generic cause. An earlier answer keeps its effects, and a later file answer does
not classify those earlier generic failures.
Files seen only in earlier shards, including the null-file group, keep their generic results on this commit
but receive stored split signatures that later reports and later commits reuse.
There is no new operation, schema or policy setting. An archive preserves file signatures with the other
signatures. No historical result is regrouped.
