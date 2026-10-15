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
The migration changes indexes only, so `archive` is false.

Run provenance checks and the reset on a dedicated worker connection while the parent holds its write gate.
Keep removal, recreation, the demo mark, and retained grants in one transaction, using `savepointSteps` to
pause before recreation. Only a marked demo or a legacy demo whose seed command was its first write may be
emptied, as in decision 0020. A failed or interrupted transaction preserves the old demo and grants. After
commit, an interrupted start leaves the empty marked demo and its grants for the next seed.

Reads use separate connections and see the old committed state until commit. Health checks keep answering.
Other writes wait at the gate, then run between the seed's ordinary API requests. Seed preflight still happens
before anything is removed. Revoke its token before reset, and make a separate fifteen-minute seed token
after reset, revoked when seeding ends. Reset cannot consume that token's lifetime.

Stop a reset worker after ten minutes. Log the elapsed time for provenance, grants, table discovery, every
count and delete, the foreign-key check, recreation, the whole reset transaction, and seeding. No credential
or row contents enter those logs. Include the worker in both executable builds and licence discovery.

## Alternatives

Yielding between row or table slices on the HTTP thread keeps a transaction atomic, but one synchronous
SQLite statement, ownership scan, or foreign-key check can still prevent HTTP from answering. A worker
isolates that cost even when an index is lost again. Committing table deletions separately would expose a
partly removed project and require a durable recovery state. The existing transaction avoids that state.
