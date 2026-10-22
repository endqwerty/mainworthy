# 0138: Index assertion presence instead of rescanning reports

- Date: 2026-10-22
- Status: accepted

## Problem

The broad-assertion guard (0036) read every historical assertion result on the current repository and commit.
Adding runner tries (0129, issue #734) multiplied that work by up to a hundred. A later unrelated assertion
materialized the entire history before application could yield. Repeated valid reports could exhaust memory,
and an accepted report could repeat the same allocation during recovery.

## Decision

Evidence keeps a private index of distinct `(project, scope, original signature, test)` observations, including
its stored file. A commit's scope includes its repository and combines environments. A session's scope lasts
only for its batch. Repeated tries and repeated reports add no duplicate presence rows.

The test threshold reads at most 51 index entries. The file threshold uses at most six successor seeks on a
covering file index. A `DISTINCT file LIMIT 6` over raw history was rejected: it can scan arbitrarily many
repeated observations before finding another file. A saturated counter with bounded membership was considered,
but preserving legacy file activation would need another catalog. The complete deduplicated index is simpler.
Its storage grows with distinct root/test observations per commit, not every recorded try.

On a root's first broad occurrence, create children for every file already observed on that scope, with
cooperative yields. Record that activation, then create each newly observed file's child directly. Only the
current batch's results and tries receive final causes. Assignment reads at most a hundred tries per result,
and application yields every 200 observations. The original failure payload never enters the history index.

A separate private map identifies original signatures and their file children. Reconstruction first verifies
an original signature's normalized hash. A child's complete stored filename determines its prefix; verify both
the recovered original hash and the derived file hash. A filename containing `): ` and an original failure
whose text starts with `Split by file` remain unambiguous. Inconsistent signature hashes refuse reconstruction.

Migration 0040 adds only derived tables and indexes, so the archive version stays unchanged. Startup rebuilds
them before accepted-report recovery; import rebuilds them after validating its archive. Reconstruction pages
results and tries in groups of at most 200, without reading raw failure messages or details, and marks a project
complete only in the same transaction as its index. An interrupted rebuild rolls back. Imported state cannot
supply completion markers because these tables are excluded from archives.

Reconstruction never rewrites historical causes or creates missing file children. If legacy evidence already
crossed the threshold without creating every child, the next report touching that root and commit activates
all its files, as the previous guard did. This one-time activation may span many files, but uses index successor
seeks and yields. Ordinary reports do not rescan raw history.

## Boundaries

Reconstruction is one-time work proportional to stored observations. Startup drains it synchronously, before
serving requests; import runs on the archive worker. Result and try rowsets are bounded, but total maintenance time
is not constant. Product gates, detector counts, retained evidence and public operation shapes are unchanged.
