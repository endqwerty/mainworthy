# Policy adoption skips unused ended changes

- Date: 2026-10-27
- Status: accepted
- Issue: https://github.com/endqwerty/mainworthy/issues/597
- PR: https://github.com/endqwerty/mainworthy/pull/1043

An unused ended change keeps its last recalculated gate across policy adoption.
Open changes, all their commits, and evidence consumed by planned runs update
immediately, including closed planned runs. Reopening reconciles before returning.

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
