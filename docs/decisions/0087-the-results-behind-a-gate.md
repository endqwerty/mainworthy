# The results behind a gate

Date: 2026-10-15. Issue [#343](https://github.com/endqwerty/mainworthy/issues/343).

## Problem

A change's gate gave a verdict and a tally ("1786 pass"), and nothing showed which tests those were. A test with
no case had no page at all. The server kept every result, but a reader of a passed gate had to trust the count.
The owner's goal is to test this project with its own tooling and see on the instance what each test did.

## Decision

**The rows come from the function that makes the tally.** A commit's gate counts one row of `run_tests` per test
and lane. `count` in `src/server/runs/runs.ts` now classifies each row with `standingOf`, which returns the tally
key the row adds to and the decision an excused or attributed failure rests on. `countedTests` returns those rows,
and `find --in results` lists them. A second classifier in the read would drift from the gate; one function cannot.

**One read in the registry.** `find --in results` takes a commit, a change (its head) or a commit's run, filters by
standing (`state`), by `unlinked` and by `text`, and pages. Its reply carries the whole tally beside the page, so a
client shows counts and rows from one reply. A planned run is refused with a pointer to its slots, which already
list its results. Rows are ordered problems first and then by result. A retry, a decision or a link moves a row
in that order or in and out of a filter, so the cursor also carries a hash of the query and of the list it gave,
and a page asked for after that list changed is refused with `conflict`: the reader starts again rather than miss
or repeat the row that moved (the verifier's findings of 2026-10-15; hashing every counted row missed a link
undone under `unlinked`). An order by test alone would not move, but it would scatter the failures
among thousands of passes.

**A row says why it counts as it does.** An excused or attributed failure names the question its decision answered;
an unexplained one names the open question the gate waits for (`openFailureQuestion`, which the code that raises
failure questions now uses too). A result's case is the one it claimed, else the one its test is linked to.

**Two places in the web UI.** The change's page gets "Results", where the tally's numbers choose the filter. A new
Tests screen (`g t`) lists every automated test and shows one test's latest results with their commit, change, job
and build. Each result in `get T-n` and in a case's timeline now names its commit, change, job and build.

## Turned down

- **Results in the `gate` reply.** A pipeline reads the gate and needs only the verdict; thousands of rows would
  cost every caller.
- **A Results screen of its own, with a commit picker.** The verdict is read on the change's page; the evidence
  belongs beside it.
- **Classifying in SQL.** Excuses, quarantines and scopes are already resolved in TypeScript for the tally;
  repeating that in SQL is the drift this avoids.

## Not done

- MCP's `find` does not offer `results`. Its tools/list was at its measured budget of 3,950 tokens before this
  change, and the smallest form of the new choice took it to 3,994. Whether agents get results at that cost is
  the owner's call; the HTTP API and the CLI have them, as they alone have `deployments`.
- The iPhone app shows neither the results nor the Tests screen yet.
- A test's page lists its last twenty results; older ones are read through the case's timeline or not at all.
