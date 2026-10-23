# 0142: Archive import refuses out-of-range durations

Date: 2026-10-22

Status: accepted

## Context

Reports accept result and runner-try durations from zero through 30 days,
inclusive. Archive import still accepts signed 64-bit durations outside that
range. Readers already bound their totals so historical data remains readable.
[Issue #771](https://github.com/endqwerty/mainworthy/issues/771) asks how import
handles these values.

## Decision

Refuse the entire archive if `results.duration_ms` or
`result_tries.duration_ms` falls outside the report input range. Reuse the
report input validator. Name the table, row, archive line and permitted range
in the error. Keep missing or NULL durations unknown.

Pending results in `batches.staged` must pass the existing result input schema
too. Import recovery applies those reports after loading the archive, so checking
only the stored duration columns would let a pending report bypass the limit.
These are per-result checks, including runner tries, rather than report-level
batch limits. Errors say "pending results fail result input" and list each issue
on one line as `path: message`.

Validate in the shared archive reader so HTTP import, CLI import and archive
backup restoration agree. A failed import rolls back the destination.

## Consequences

Some archives accepted by earlier builds are now refused. Mainworthy is
pre-1.0 and provides no compatibility conversion for them. Clamping was
rejected because it would silently change imported evidence.

Existing databases, including directory backups opened as databases, are
unchanged. Readers retain their bounded totals for historical values.

Reports accepted non-negative durations above 30 days before the limit added on
2026-10-22. Export preserves these values, so a successful export can create a
backup this build refuses to import. Export returns a warning for each affected
duration table in its reply metadata. HTTP carries it in
`X-Mainworthy-Archive-Warning`, and the CLI prints it on stderr after saving the
file. A warning preserves the backup and its evidence; refusing export would
prevent the operator from saving that evidence.

Keep the original archive. An operator can restore a stopped data-directory copy
to retain every value. To create an importable archive, they can inspect and
deliberately set invalid stored durations to NULL on a stopped copy, then start
that copy and export again. The [data guide](../guide/data.md#import-into-a-new-instance)
provides the SELECT and UPDATE statements. This discards those timings; it does
not repair pending report payloads.
