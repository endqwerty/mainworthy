# 0087: A demo refresh keeps HTTP answering

Date: 2026-10-15. Addresses [issue #342](https://github.com/endqwerty/mainworthy/issues/342).

## Why

Migration 17 replaced the primary key on `result_excuses.result` with partial indexes. An unrestricted lookup
by result then scanned all excuses, including other projects'. With foreign keys enabled, deleting every demo
result repeated that scan. Reset ran synchronously on the HTTP thread, so even `/healthz` waited. Its token
could expire before the seed began.

## Decision

Add migration 24 with plain leading-column indexes for every foreign key into a table `removeProject` deletes.
The schema audit includes self references and columns whose existing partial indexes serve some queries.
The migration adds 36 indexes, including the two observation decision refs added by migration 23.
It changes indexes only, so `archive` is false and the archive version stays 23.

The indexes cost storage and maintenance on writes. In the reviewer's two-demo fixture with about
195,000 results, the original 34 indexes added 15.0 MB, about 25% of the compacted database. That measurement
excludes the two observation indexes added after migration 23 and is not a prediction for every instance.
Keep the quarantine history query's commit-target lookup first with `CROSS JOIN`, so the new test index cannot make each result scan all earlier results of that test.

Run provenance checks and the reset on a dedicated worker connection while the parent holds its write gate.
Keep removal, recreation, the demo mark, and retained grants in one transaction, using `savepointSteps` to
pause before recreation. Only a marked demo or a legacy demo whose seed command was its first write may be
emptied, as in decision 0100. A failed or interrupted transaction preserves the old demo and grants. After
commit, an interrupted start leaves the empty marked demo and its grants for the next seed.

Reads use separate connections and see the old committed state until commit. Health checks keep answering.
Administration lists and sign-in wait too, because they write. Other writes wait at the gate, then run between
the seed's ordinary API requests. The worker receives the server's configuration, including its admin MFA
requirement, so restoring grants applies the same session rules. Seed preflight still happens
before anything is removed. Revoke its token before reset, and make a separate fifteen-minute seed token
after reset, revoked when seeding ends. Reset cannot consume that token's lifetime. On a graceful stop, skip
making the seed token if reset is still running, and wait for refresh cleanup before closing the database.

After ten minutes, request that the reset worker stop. It can stop only between SQLite statements. A running
statement must return before the worker stops, its transaction rolls back, and waiting writes proceed.
Log the elapsed time for provenance, grants, table discovery, every
count and delete, the foreign-key check, recreation, the whole reset transaction, and seeding. No credential
or row contents enter those logs. Include the worker in both executable builds and licence discovery.

## Alternatives

Yielding between row or table slices on the HTTP thread keeps a transaction atomic, but one synchronous
SQLite statement, ownership scan, or foreign-key check can still prevent HTTP from answering. A worker
isolates that cost even when an index is lost again. Committing table deletions separately would expose a
partly removed project and require a durable recovery state. The existing transaction avoids that state.

## Amendment, 2026-10-16: removal does not charge each report for its indexes

[Issue #346](https://github.com/endqwerty/mainworthy/issues/346) began with three duplicate indexes.
Dropping only those indexes still made ingestion slower than before migration 24. Instead, keep the worker
and the atomic reset, but disable per-row foreign-key enforcement on its connection before the transaction.
Delete rows selected through a parent before that parent, then order children before parents within each
ownership group. Self references and cycles need the final check. `PRAGMA foreign_key_check` must find no
violation before commit, including after recreation and grant restoration. Any violation refuses and rolls
back the whole transaction.

`Db.checkedBulkSteps` owns that transaction and restores enforcement on success, failure, or cancellation.
The worker uses it through `resetDemoSteps`. Its synchronous form, `checkedBulk`, also backs the transfer
module's import transaction, so standalone removal and archive import use the same rule. A nested call
keeps its caller's enforcement and deferral settings; it cannot turn enforcement off inside a transaction.
The existing deferred-constraint checks still apply to such callers. The only production caller of
`removeProject` is the demo reset. There is no admin project removal operation. Archive import calls
`importArchive` and `removeBootstrap`, not `removeProject`.

Migration 25 drops 30 migration-24 indexes. Every one of the 353 declared statements was inspected with
`EXPLAIN QUERY PLAN`, with enforcement enabled and the same null bindings on each side. Only six plans
change, each replacing a duplicate index with the existing non-null partial index. No search becomes a scan.
Keep the six indexes ordinary queries use: `deployments_build_fk`, `excuses_decision_fk`,
`excuses_signature_fk`, `run_tests_target_fk`, `runs_change_fk`, and `slot_results_discounted_by_fk`.
The dropped duplicates are `results_corrects_fk`, `results_quarantine_exit_fk`, and `result_excuses_slot_fk`.
Their existing partial indexes cover equality lookups. The index test now checks those search plans and
refuses remaining removal indexes that no declared statement uses. Migration 25 changes indexes only,
so its `archive` flag is false and the archive version stays 23.

Migration 29 (2026-10-17) drops `excuses_signature_fk` too: the excuse lookup now reads the primary key, so no
declared statement uses it any more, and the index test refused it.

### Measurements

Bun 1.4.3 on the same ten-core Mac, without a concurrent test worker. For ingestion, every run executes the
unchanged `test/budgets.test.ts` from the same working directory, so baseline and candidate databases are
on the same SSD. `4afbb283` is the baseline before migration 24. There are five alternating pairs per
comparison. Each run warms up five reports and measures five more, each containing 5,000 results. Its
existing receipt, persisted-row, and gate checks pass, with zero measured or warmup errors. Values below
are the median and range of the five per-run p50 values, in milliseconds. Separate comparisons have their
own baselines because the machine's timing varies.

| Comparison | Version | Median p50 | Range |
| --- | --- | ---: | ---: |
| Duplicate-only | `4afbb283` | 166.44 | 160.44 to 171.93 |
| Duplicate-only | Migration 24 with just the three duplicates dropped | 179.75 | 176.28 to 182.35 |
| Chosen change | `4afbb283` | 171.30 | 169.77 to 179.57 |
| Chosen change | Migration 25 and checked bulk transactions | 170.92 | 168.28 to 185.06 |

The duplicate-only candidate has a 13.31 ms median gap, larger than its baseline's 11.49 ms spread.
The chosen change differs by 0.38 ms, within its baseline's 9.80 ms spread. Ingestion is back within
measurement variation. The duplicate-only experiment changes only the indexes, which isolates index
maintenance during report writes as the cost being removed; it does not change report processing.
A separate, unreported ingest profile samples `sqlite3_step`, `sqlite3BtreeInsert`, and `sqlite3BtreeIndexMoveto`
on the reporting thread. These calls maintain result indexes during `report`; profiling is excluded from the
paired timings. The remaining report processing is unchanged, so removing these indexes cannot double ingestion speed.

Removal uses the existing two-project fixture, with independent results and excuses in the retained
project. All variants use the same disk and connection settings. Five runs alternate the four variants,
first at 20,000 results per project, then through the unchanged 5,000-result budget test. The timer includes
removal's transaction, counts, deletions, and final key check; fixture creation and correctness assertions
are outside it. Each run verifies the removed result count, retained results and excuses, zero foreign-key
violations, and restored enforcement.

| Version | 20,000 results, median and range in ms | 5,000 results, median and range in ms |
| --- | ---: | ---: |
| `4afbb283`, before migration 24 | 5,144.22, 5,135.65 to 5,279.47 | 340.1, 335.4 to 343.6 |
| Current migration 24 | 71.43, 70.28 to 77.60 | 55.8, 51.4 to 64.8 |
| Only the three duplicates dropped | 67.38, 61.44 to 80.91 | 53.2, 39.2 to 62.4 |
| Chosen change | 39.31, 36.10 to 42.99 | 11.5, 11.4 to 12.2 |

The old baseline fails the existing 250 ms removal budget on all five runs. Every other variant passes;
no budget changes. These are synthetic local fixtures, not a measurement of production's database.
The worker and the read connections remain separate, so removing the indexes does not move reset work
onto the HTTP thread.

### Alternatives

Dropping only the duplicates is smaller but does not meet the ingestion goal. Keeping every child index
retains write and storage costs for a rare whole-project reset. A new public project-removal operation or
committed deletion stages would add scope or expose a partly removed project. Keep one checked bulk
transaction in the kernel so callers do not coordinate enforcement, rollback, and the final check themselves.
Archive import already deletes children before parents and validates its full result. It calls the same checked
transaction, but the server runs the import inside a savepoint, where SQLite cannot turn enforcement off: there it
keeps per-row checking and gains only the final check. Measured on a 477,722-row archive, it is no slower than with
the removal-only indexes, so import does not need them either.

A graceful stop during seeding waits for the seed to finish and then revokes its token. During reset it
still skips making that seed token. Both the deployment notes and the user guide now say this.

## Amendment, 2026-10-20: defer the reset before removal

[Issue #707](https://github.com/endqwerty/mainworthy/issues/707) found that `importTransaction` scanned all
foreign keys before removal inside the reset's fresh transaction. That scan protects callers with pending
deferred constraints when global deferral is off: restoring that setting can discard SQLite's pending checks.
The reset has made no changes yet, so it enables deferral before removal and retains it until commit.
Other transfer callers keep the pre-check and their original deferral setting.

Keep the full final checks after removal and after recreation with grants. Retained rows can reference removed
parents, so a project filter cannot prove safety. Limiting tables would also require accounting for every
referencing table and trigger effect. Log the pending-key check, even when skipped, and time transaction setup
and completion after removal and recreation. Completion includes each bulk validation and commit or rollback.


## Amendment, 2026-10-20: incremental reset constraints

[Issue #712](https://github.com/endqwerty/mainworthy/issues/712) measured 203 seconds for the first post-removal
whole-database audit on the instance's cold cache. Two more bulk audits followed under the write gate.
Table-scoped audits would still read millions of unrelated result and excuse rows.

The worker now audits the existing database before taking the gate. It captures `PRAGMA data_version` before
the audit and compares it after acquiring the gate and `BEGIN IMMEDIATE`. An intervening commit invalidates
the proof. The worker rolls back that empty transaction, releases the gate, and repeats the audit. This keeps
pre-existing dangling-reference detection without charging the write gate for a database scan. A busy instance
can require several audits; each runs without the gate. The ten-minute worker deadline still bounds the reset.

During the reset, keep `foreign_keys` enabled and defer constraints until commit. SQLite checks changed child
rows and probes incoming references to deleted parents through child indexes. This covers references from
other projects and trigger effects in removal and recreation. The deferred constraint counter decides commit,
so there is one proof across the whole replacement and no bulk audit inside its transaction. Other transfer
callers keep their original audits and restoration of caller settings.

Migration 37 restores 28 missing incoming indexes, with non-null partial indexes for nullable columns.
`PRAGMA index_list`, equality lookup plans, and the actual SQLite DELETE programs confirm indexed checks for
all 81 incoming references into tables removal touches. No incoming table falls back to a scan. The migration
changes indexes only, with `archive: false`. This revisits migration 25's choice: maintaining these indexes
costs report writes and storage, but whole-database audits under the gate held every write for minutes.
The ingestion budget remains unchanged and is checked with the reset budget.

A preflight goes stale whenever another connection commits during it, and on the instance a job commits every
minute while a token is in use, the reset's own included; the first, cold preflight takes minutes there. So the
worker audits beside the server's writes at most twice, then audits under the gate, where nothing can make it
stale and the cache is warm from the rounds before. That bounds the reset without a timeout deciding it.

Rejected: a project-filtered final audit misses other projects' references. Auditing only referencing tables
still scans unrelated rows. A preflight without the generation comparison can become stale before the gate.
Capturing deleted parent keys and changed child keys with temporary triggers would duplicate SQLite's
constraint engine and still require incoming indexes or a large temporary reverse-reference map.
