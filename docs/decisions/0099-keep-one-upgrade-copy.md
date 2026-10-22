# 0099: Keep one upgrade copy

- Date: 2026-10-18
- Status: accepted
- Issue: [#417](https://github.com/endqwerty/mainworthy/issues/417)

## Problem

Before upgrading a database, the server writes a consistent copy beside it. These copies accumulate with
each schema change and can fill the data volume.

## Decision

Keep the copy for the current upgrade. Normally one copy provides rollback to the database as the
previous build left it without retaining the cost of every earlier upgrade.

Write the copy with `VACUUM INTO` in a new private directory beside the database. Sync and close the file,
rename it to `<database>.v<N>.bak`, then sync the directory before migrating. A failed copy never publishes
partial bytes under the final name. If that name already exists, leave it unchecked and keep all older
copies. An existing copy does not establish that this start made a safe replacement for them.

Run all pending migrations in one transaction. Any failure rolls back the whole upgrade, including its
schema version, and removes no copies. This prevents a later start from copying an intermediate schema
and deleting the only copy a previous build can open. Migrations 1 through 30 contain only transactional
schema and data statements; future migrations must also support the transaction.

Remove older copies only after all migrations commit, and only when this start completed and published
the current copy itself. Log each removed filename. Cleanup matches only regular files with the exact
database basename, a canonical positive integer version lower than this upgrade's starting version, and
the `.bak` suffix. Other names, directories, symlinks and higher-version copies are left alone.

A start with no pending migration performs no cleanup. If interrupted during cleanup, the current copy
and any older copies not yet removed remain. Log a failure to list or delete copies and continue startup.
A later successful upgrade that writes a new copy removes remaining older copies. Removing a copy that
has already disappeared is harmless.

## Consequences

Only copies still present remain available for rollback. Operators who need an earlier rollback point
must save a separate backup before upgrading. A pre-existing final copy, cleanup failure, or interrupted
cleanup can leave more than one copy. A crash while writing can leave that private directory, which cleanup
ignores. Upgrade copies do not replace scheduled backups.

The retention rule belongs in the migration kernel shared by local and server starts. It adds no setting,
background job, operation or database migration. The demo has no upgrade housekeeping to seed.
