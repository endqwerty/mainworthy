# Policy adoption skips unused ended changes

- Date: 2026-10-27
- Status: accepted
- Issue: https://github.com/endqwerty/mainworthy/issues/597
- PR: https://github.com/endqwerty/mainworthy/pull/1043

An unused ended change keeps its last recalculated gate across policy adoption.
Open changes, all their commits, and evidence consumed by planned runs update
immediately, including closed planned runs. Reopening reconciles before returning.
Skipped history is reconciled before any later authoritative use. Planning reconciles matching ended source runs before importing
their evidence; a new merge receipt reconciles an ended change before freezing its
gate. Both use the full inherited-decision reconciliation in the project transaction,
including removal of exact result excuses forbidden by the current policy.

Decision 0022 stops ordinary questions when a change ends. This choice also removes
unused ended history from policy adoption's write transaction. It narrows decision
0098's immediate reconsideration; it does not freeze history or weaken decision
0042's dependence on current base evidence. Reports, base corrections and landing
still use the full affected-run graph and can change an ended gate.

Lifecycle selection belongs to evidence. Runs selects eligible commits and planned
consumers for the whole project. Adoption uses that complete selection without
expanding it through ended children. Keeping the ordinary expansion and filtering
afterwards would still read the historical graph inside the writer.

No schema change or migration is needed. Selection still reads project metadata;
this bounds reconciliation work for unused history, not database scan time or work
for open changes and retained plans. Keeping every historical gate aligned with
policy was rejected because it retains the history-dependent write delay.

Runs retain no last-reconciled policy version. Rather than add a marker, these entry
points conservatively reconcile matching ended runs on use. Ordinary gate reads do
not trigger reconciliation. An existing receipt stays frozen on a repeated merge.
Landing already reconciles a changed commit scope, including planned consumers.
Base comparisons under decision 0042 read effective raw results independently of
the base's excuses, so a new dependent change cannot import stale base standing.
Decision 0098's inherited-answer refresh remains part of the full fold.
