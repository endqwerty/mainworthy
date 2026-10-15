# 0036: Split broad assertion causes by file

Date: 2026-10-14. Status: accepted.

## Problem

A generic assertion message can describe unrelated failures. Giving them one signature lets one answer
classify all of them. The design's deferred guard is tracked in [issue #58](https://github.com/endqwerty/mainworthy/issues/58).

## Decision

Apply the design's thresholds to each report after its results have been accepted and their tests resolved.
For each assertion signature, count distinct test ids and distinct non-null stored file names.
More than 50 tests and more than five files means a separate signature for each file, including a separate
null-file group. A file literally named `no file reported` remains a different cause from the null-file group.
Timeouts and infrastructure failures remain grouped across files.

The evidence module assigns these signatures before the report reaches runs or decisions, within the same
transaction that inserts its results. Its internal helper has the shape
`splitBroadAssertions(ctx: Ctx, results: Applied[]): Generator<undefined, void, void>`.
It changes only results inserted by this report. Each split signature hashes the original signature hash
and the file name. Its text starts with `Split by file (FILE):`, which the queue, CLI and API already show.
The original failure message and detail stay unchanged.

Later reports reuse a file's split signature even below the thresholds. Detection still counts the original
normalised signature, including files already split. A generic answer given before the split does not cover
new file signatures. Historical results and their decisions keep their earlier meaning.

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

Detection is per report, as in the design's `detectFailures(tx, batch, failing)`.
Several small shards that together cross the thresholds do not trigger a new split. An unseen file in a
later small report retains the original cause until a report crosses the thresholds for it.
There is no new operation, schema or policy setting. An archive preserves file signatures with the other
signatures. No historical result is regrouped.
