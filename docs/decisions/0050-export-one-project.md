# 0050: Export one project without changing its IDs

- Date: 2026-10-14
- Status: accepted
- Issue: [#50](https://github.com/endqwerty/mainworthy/issues/50), first slice only

## Decision

`mainworthy export --project <key> --out <file>` selects one project from the same read snapshot used by a full
export. The existing HTTP archive route accepts the same selection as `?project=<key>` and still requires an
instance admin. Without an explicit selection, the command continues to export the whole instance.

The transfer module owns the selection. Rows with a project column select that project directly. Versions,
placements, answers, coverage and run projections select through their owning case, question, requirement or run.
A new table without a project column needs an explicit ownership rule before a project export can include it.

Actors come from declared actor references, the schema's actor columns without foreign keys, decision signers,
and grants that apply to the selected project. Its organisation's rule actor travels even before any rule has
answered a question, so the first automatic decision after restore can run. The selection follows `on_behalf_of` recursively and includes the
organisations those actors belong to. It keeps their grants on this project and their global grants, which also
apply here. Instance metadata and commands with project zero do not travel. `UNEXPORTED` still excludes all
sign-in material and change-ending records. Exported rows retain every original value and ID.

A project archive uses the existing format and restores through the existing atomic fresh-instance importer.
No new operation, table, migration, import mode or writer of standing is added.

## Why this is a separate slice

Issue #50 also asks to import into an instance that already has projects. That part remains open. Copying IDs
would collide with existing rows. Relabelling only primary and foreign keys would leave IDs in JSON, scopes,
manual-test keys, producer lanes, slot aggregates and question hashes pointing at the original rows.

More importantly, not all historical hash inputs remain available. `raiseMap` in `src/server/ops/writes.ts` hashes
all the unlinked test IDs as its material but retains only fifty in the question's evidence. The question's
historical test set cannot always be reconstructed from today's rows. `batchKey` in
`src/server/evidence/evidence.ts` also hashes report input that processed batches no longer retain in full.
A transplant that looks correct immediately after import could therefore lose decision carry-forward or
report deduplication on its next write.

Two broader designs remain possible: preserve an origin ID namespace for future hashing while mapping stored
references, or replace ID-dependent hashes with stable project-local identities and account for legacy history.
Neither is a transfer-only change. This slice keeps exact IDs and the existing refusal to import over user data.
It does not resolve the additive-import part of the issue.

## Checks

The archive test compares every retained column across a round trip, including head hashes, decisions, verdicts
and 64-bit integers. It excludes another project's rows and identity, then reverses the selection to check child
tables without project columns. A command-line gzip export is imported over the real HTTP server, with the case
list and gate unchanged. Unknown and empty selections fail. Existing archive tests continue to cover checksum,
constraint and credential-table refusals, and rollback before replacing user data. An untouched-project round
trip also makes its first case through the real operation registry after restore.
