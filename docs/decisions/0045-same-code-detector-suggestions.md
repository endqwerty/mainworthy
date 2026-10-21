# 0045: Same-code detector suggestions reuse recorded flips

Date: 2026-10-14. Status: accepted for the first slice of issue #38.

## Context

A `flaky` answer already records a decision, excuses its cause, and carries forward
for the project's `holds.flakyDays`. Policy presets and per-project settings
already exist. Ingest also records same-target outcome flips. The missing first
step is useful, explainable detector evidence without giving it decision authority.

## Decision

Reuse the incrementally recorded `flips` and their immutable results. A flip now
compares higher decisive attempts within one producer, job, test, method, and
target. Skips do not erase the previous decisive result. Same-attempt disagreement
keeps the worse outcome and creates no retry flip. Older attempts create none.

`sameCodeEvidence(db, {project, test, now, settings})` reads these observations in
the evidence module. It returns counts per test and final failure signature,
with the assertion, timeout or infrastructure class, whether each meets the
threshold, and at most three recent result pairs per cause. Each signal names
its signature id and normalized text. File-split signatures from decision 0036
are distinct causes. Earlier flips of the original cause remain in that cause's
history and never help a split cause meet its threshold.

Both observations must fall inside the window. Corrected
observations and passes contradicted by a failure at the same attempt are excluded.
Only automated results on targets with a commit are detector evidence.

The policy's `flakyDetection` holds `enabled`, `windowDays`, and `minFlips`.
Defaults are true, 14, and 2 in every preset. Stored policies missing the setting
read with these defaults. A witnessed policy adoption changes them, as it changes
other settings. Changing a suggestion threshold never changes an excuse.

`get` on a test returns current evidence. Failure questions attach a snapshot to
their bounded test list, filtered to the question's cause and outside the material
on which an answer stands. The queue shows those examples and Settings shows the configured values. A suggestion makes
no decision, writes no excuse, and moves no gate.

## Alternatives

A new detector projection, table, and question kind could own scoring and quarantine
standing together. That would duplicate stored observations before entry and exit
rules are ready, and would expand the question vocabulary across every client.
Reading the existing facts is the smaller complete first step. It keeps SQL in the
evidence module and the existing witness requirement at every standing writer.

Decision 0129 adds flips between a test runner's tries inside one result. The detector reads an end's outcome and
cause from its try, and a sample names the try.

## Limits and follow-up

This slice does not detect alternation across different trunk commits, create a
`flaky` question kind, or implement quarantine entry, exit, or a quarantine list.
Those remain under issue #38. Reporting under issue #56 can use `get`'s `sameCode`
cause counts and concrete samples, but must not call these a quarantine state or
a probability. Counts measure observed outcome changes, not independent failures.
The window is based on report arrival time because ingest has no execution clock.
The detector does not reinterpret old flips that were never stored before this fix.
