# 0033. A report can carry the code host's current head

Date: 2026-10-14. Issue #62. Decision 0127 replaces the paragraph on landings: a landing no longer sets the head.

## Problem

First-reported commit order protects a change from an old job finishing late. It cannot
distinguish that job from a branch reset to a commit already reported.

## Usage and contract

A producer reads the code host at report time and sends `target.head` alongside the tested
`target.commit`, with a pull request or non-trunk branch. On the CLI this is `report --head`.
The hashes may differ. Results and the receipt belong to the tested commit. The change's
gate follows the reported head, in either direction, and waits for evidence if needed.

The same head supplies the change's evidence for clearing failure questions and ending
answers whose cause passed, as decision 0091 defines. A discarded commit's passing retry
cannot clear the current head's question or answer. An unreported head supplies no proof
that a cause passed. Issue #534 fixes the scope selector to follow this head, like the gate.

Only a pipeline or person can say where the head is. Agent evidence stays advisory.
CI detection supplies no head observation because an old event can name an old head.
This does not add a code host watcher.

A landing (decision 0038) sets the change's head to the landing commit and places that
commit on trunk, even if no results have arrived or it is older than the recorded head.
Its gate is pending until evidence arrives. While a change is merged, ordinary reports
and explicit head observations leave its head and metadata alone (issue #302). Without
landing metadata, it keeps the head recorded when it ended. Late evidence for the head
still changes its gate. Landing metadata received later can select the head and place
that commit on trunk.

A closed, unmerged change continues to follow reports and head observations. It can
be reopened on its latest head. Explicitly reopening a merged change permits head
updates again without moving a landed commit back from trunk.

## Alternatives and choice

A force flag that makes the tested commit the head cannot report results from an old job
while identifying another current head. Use a separate head hash instead.

Reusing `changes.rev` to order observations would couple head movement to title edits and
change closure. Keep `head_observed_seq` on the change instead. Ordinary reports retain
first-reported ordering and cannot replace a head observed after their commit was reported.
A report for a commit never reported before can still advance the head. Without a code
host observation, Mainworthy cannot know whether that job belongs to an old push.

The evidence module keeps ownership of change updates. Existing changes receive an
explicit observation only after batch deduplication. The batch key includes the head,
change identity, build URL, and optional command id. An identical retry cannot restore
an old reset. A new build URL, command id or attempt distinguishes a fresh observation
with identical results. GitHub Actions build URLs contain the run ID, so a new run
remains distinct even when its job and attempt are unchanged.
Distinct observations of the same head update its sequence too.

Migration 0009 stores the observation sequence durably. Its nullable column preserves
the earlier ordering when NULL, so it does not advance the archive version. Import fills
missing nullable, non-key columns with NULL; required and unknown columns still fail.
The migration declaration test permits these additions generally. Marking one compatible
also requires checking that NULL preserves the earlier behavior; a schema comparison
cannot prove that. A migration that needs to transform older data still advances the
archive version. Older readers may refuse archives that include the new column.
No new operation, writer outside evidence, or decision witness is needed. A head is a
reported fact, like a change ending.

## Checks

Regression tests cover reset and forward movement, late jobs, retries, repeated observations,
repository scope, agent reports, unreported heads, and ordinary metadata updates.
A CLI test starts the executable against a local server and checks both commit and change gates.
