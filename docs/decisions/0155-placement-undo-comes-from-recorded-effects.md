# 0155: Placement Undo comes from recorded effects

2026-10-23. Fixes the concurrent-placement audit finding on [pull request #830](https://github.com/endqwerty/mainworthy/pull/830).

A browser can archive a case from an old read after another client already archived it. The server adopts
that request as a no-op. The browser used to report one changed case and retain its own restore edit.
Undo then reversed the other client's archive, although this request changed nothing. A partly stale
selection had the same problem for the cases the server skipped.

The witnessed placement writer now returns inverse edits only when it records a placement. State changes
name their actual prior state. Folder moves name their actual prior folder by id. Tag changes return
addition/removal deltas from the values at the write, so Undo preserves unrelated tags. Adjacent identical
inverses share a case list, keeping bulk replies compact. Adoption puts those edits in undo order and keeps
them in the decision effects.

`propose` replies include required `placements`, ready-to-submit inverse placement edits. No-ops, pending
proposals, rejections and body-only edits return an empty array. Body-version stamps remain in `cases`.
The web's shared placement path counts unique case refs in `placements` and uses those edits for Undo.
A cached inverse is only an optimistic preview while the original request is pending. A queued Undo waits
for the actual effects; an adopted no-op produces no inverse request. This applies to archive, restore,
folder moves, and tag addition/removal through the same path.

Expected-state guards were the alternative. Covering all these actions would require browser snapshots of
folder and tag values as well as state, with atomic validation at sealing and adoption. Returning effects
uses the writer that already knows exactly what it changed and also describes partial no-ops.

There is no new operation, decision kind, migration or alternate writer. The iPhone does not decode the
new field; its existing decoded reply fields are unchanged. Existing demo cases already exercise
placements, tags and archived state, so this correctness fix needs no new seed data or random draws.

Principles: Fix Root Causes (record effects where placement is written); Model the Domain (actual effects
and optimistic previews are separate); Make Operations Idempotent (a no-op contributes no inverse).
