# 0030: A review covers one case version, change and commit

- Date: 2026-10-14
- Status: proposed
- Issue: [#49](https://github.com/endqwerty/mainworthy/issues/49)

`claim` recorded a hash of the case version and change key. `impact` ignored that hash and counted any review
by the caller at the case version. A review could therefore cover another change, or a pushed fix that nobody reviewed.

## Usage

The caller reads `impact({ change: "pr:482" })` and keeps `change.head`. After reading the patch, it sends
`claim({ about: "pr:482", patch: "cccc0001", lens: "review", reviewed: ["C-1@<hash>"] })`.
The commit stays the one actually read, even if the change moves before the claim arrives.

## Basis and lookup

The evidence module owns `reviewBasis({ version, about, patch })`, a hash of those three values. Both the claim
writer and the impact reader use it. A claim without a patch still records evidence, but cannot complete a change review.
The impact reader requires a known change head and a matching basis by the caller. It accepts any review lens,
as before. The change key participates even when two changes share a commit.

The existing opaque `reviews.basis` column stores the hash. Its uniqueness constraint continues to deduplicate
the same case, basis, lens and reviewer. Old rows stay in history, but their hashes cannot match the new basis.
No schema migration is needed. A review is still evidence of reading, never a runtime result or a gate input.
Finding decisions retain their existing basis and are separate from review completion.

With `since`, a newer change revision includes all affected cases, even if the case versions did not move.
This also includes cases after a title or file-list change, and after the change is closed or reopened; those come back still marked reviewed when the head is the same. With an unchanged change, the existing case revision
and failing-case filters apply. A files-only request cannot reuse reviews because it has no known commit basis.

## Alternatives and limits

Separate review columns for the change and commit would make the original commit readable without its hash,
but require a schema and archive change. Matching the existing basis column is enough for this lookup.
Reading the current head inside `claim` would be smaller for callers, but could credit a patch that arrived
after the review. The explicit patch prevents that race.

We use the exact commit supplied by the caller and the head reported by a person or pipeline. Mainworthy
does not fetch Git objects, resolve abbreviated commits, or calculate patch trees. Identical patches at different
commits therefore need another review. The caller copies `change.head` exactly to avoid false mismatches.
