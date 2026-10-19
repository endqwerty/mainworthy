# 0107: Update projected folder paths by subtree

- Date: 2026-10-18
- Status: proposed

Sealing replays folder edits to check final collisions and collect every intermediate path for policy review.
Rebuilding the whole tree after each edit made large batches quadratic.
[Issue #581](https://github.com/endqwerty/mainworthy/issues/581) records the slowdown.

Keep canonical path buckets, cached paths, and a parent-to-child index for one replay. A creation adds one
folder. A rename or move removes the affected subtree's old paths and indexes its new paths. Record both
sets for policy review. Retain multiple ids in a path bucket so temporary collisions remain ambiguous
until later edits resolve them. Check final collisions with the same validation as before.

This removes the full rebuild, the scan of every folder to find descendants, and the repeated scan of
previously touched folders. Unrelated sibling edits now cost linear work in the batch and initial tree
sizes. Repeated ancestor edits still visit their affected descendants and record intermediate paths.
The cost includes those paths, which policy review requires.

A sibling-name trie would avoid full-path updates but would complicate canonical full-path collisions,
including existing names containing slashes. The incremental path index keeps those semantics in the
suite's existing projection. Sealing, adoption, and pending-proposal scope checks all use it. There is no
new client contract, stored format, or migration.

The demo needs no new feature data. Its existing folder proposals use the shared replay. A mixed registry
batch checks nested moves, repeated renames, a swap, implicit folders, and case placement. The benchmark
in `bench/folder-seal.ts` compares complete sealing calls on fresh fixtures, alternating revisions.
