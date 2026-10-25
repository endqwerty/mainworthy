# Project writes and authority

The operation registry opens a write transaction on a reserved PostgreSQL connection. It locks the caller's
actor row with `FOR SHARE` and then the project's row with `FOR UPDATE`. It rereads the credential and
capability after waiting. The project lock precedes project state reads and sequence allocation, and lasts
through commit. Writers in different projects can overlap, including writes by the same actor. Recovery,
sweeps, delivery bookkeeping, and project administration take the same project row lock.
If the row discovered before a lock wait was replaced, the writer returns `busy` before running its operation.
A missing project name is guarded through the transaction so a new project cannot appear behind the check.

Identity writers take the transaction advisory lock `pg_advisory_xact_lock(821, 1)` before discovery or any
actor, roster, team, project, or command lock. This covers every instance write in the registry, sign-in and
sign-out, credential and contact changes, bootstrap, identity sweeps, archive import, and project authority
maintenance. Exclusive actor locking joins that same identity lock. Token/session lookup and identity creation
join it before resolving names or ids, including when no row exists. The two-integer advisory key has a
separate namespace from the one-integer project-key and command-id locks.

Within an identity transaction, lock affected actors by ascending id at their final strength. Then take
organisation roster guards, team membership guards by id, project rows by id, and job rows. A team grant
change discovers and locks its members before its project. Another identity transaction cannot create,
rename, remove, or change the owner of a discovered row until commit or rollback. The registry no longer
reserves missing names with the organisation row or repeats footprint checks after later waits.
Actor-before-project ordering still matters: an ordinary project writer may hold an actor while waiting
for that project. Database triggers increment `actors.auth_version` inside the transaction that changes
grants, memberships, organisation authority, credentials, tokens, or sessions.

Ordinary project data writes, report acceptance/application, recovery, and delivery bookkeeping never take
the identity lock. They take shared actor locks followed by their project row. Last-use flushing also stays
outside the identity lock: it changes activity fields only, locks its actors before updating tokens or
sessions, and checks that their owners still belong to its locked set. None of these transactions changes
identity or upgrades an actor lock, so it cannot wait back on the identity lock. Different projects still
write concurrently. An identity writer waiting for a busy actor or project holds the identity lock and
queues all other identity writers, including unrelated sign-ins and token creation. Password hashing and
provider verification happen before the serialized sign-in commit.

Creating a project locks its key until commit, then its newly inserted row. Bootstrap locks only the owner,
policy actor, configured-token owners, and affected admins, then guards organisation creation.
Project-specific grants also lock that project after their affected actors and membership guards.
Instance settings come from server configuration. Project policy settings take their project's row lock and
a decision witness. The shared commit-status delivery allowance locks its singleton row after the project.

A whole-instance archive import takes the identity lock, then exclusively locks the actor roster, its actors,
the project roster, and project rows. That excludes even an insertion into an empty instance. A demo swap
and grant movement take the identity lock before discovering the affected authority and projects. They lock
the union of source and destination authority, reserve project keys, then lock projects in id order and
recheck project identities. Ready-state bookkeeping locks the project too. Each retired-demo cleanup slice
keeps its identity, authority, and project locks until the slice commits, then yields. Startup refresh and
cleanup remain paused.

Operation inputs are parsed before discovering lock keys, so stripped fields cannot change lock strength.
Sign-in proof discovery can happen before the identity transaction. Its commit still returns `busy` if a
person, credential, or browser session resolves to an actor it did not lock.

Run `bun bench/identity-contention.ts 5` for two 5,000-result scenarios: identity requests directly beside a
report, and identity requests behind a project grant change already waiting for that report. Each sample
verifies the committed result count, token hash, and session count. On 2026-10-24, five alternating baseline
and serialized runs per scenario measured token sign-in at median 6.702 ms, range 3.463 to 13.091 ms, directly
beside the report. Token creation measured 3.105 ms, range 1.780 to 7.894 ms. Both finished while the report
still held its project in every direct sample. Behind the grant change, sign-in measured 455.574 ms, range
348.125 to 1178.582 ms, and token creation measured 452.218 ms, range 345.971 to 1175.676 ms. Both waited for
the report in every queued sample. The corresponding baseline medians were 5.192/3.641 ms directly and
2.684/1.754 ms behind the grant change, for sign-in/token creation respectively. These shared-machine
samples included another whole check and a focused test run. They show the serialization cost when an
identity writer waits for a report, not an isolated speed comparison or a production latency bound.

A report commits acceptance separately from application. The private `batch_admissions` table holds the
exact admitted token or session reference and the actor's authority version. The actor and project locks
end at acceptance. Application and recovery lock the actor and project again, reread the proof, and check
current authority even when the version changed. They delete the proof after application. If the credential
is no longer live or authority refuses the report, one transaction cancels the batch, removes its pending
marks, and records refusal in its command reply. An imported accepted batch has no proof and is cancelled.
Admission proof never travels in an archive. Actor authority versions are private instance bookkeeping too.

`commands.id` remains an instance-wide primary key. A transaction lock keyed by command id serializes
concurrent claims of the same id even across projects. Rollback removes an unaccepted claim. Acceptance
binds the id durably, and application or cancellation completes it in the same transaction as the batch.

## Wait bounds

`LOCK_WAIT_MS` in `src/server/kernel/db.ts` bounds write connection acquisition and PostgreSQL lock,
statement, transaction, and idle-in-transaction waits. PostgreSQL lock timeout, deadlock, serialization
failure, and statement or transaction timeout map to the shared `busy` error with HTTP 503. A lost connection
without such a PostgreSQL error remains uncertain and is never retried on another connection inside the
operation. Migration locks use a dedicated connection and retain their checked unlock and disposal paths.

Run `bun bench/lock-waits.ts 5` to measure the maximum supported report
size of 100,000 results. Each of five rounds measures a report that creates its tests, then another report
over those same 100,000 tests. It drives the registry's real acceptance and application phases, measures all
application slices and their pauses, and verifies 100,000 committed result rows per batch after each sample. Run
`bun bench/lock-waits.ts --profile` separately for awaited statement timings and query plans. Setup
and row verification are outside the measured interval. The workload uses distinct passing automated tests
in one file with unlinked tests tracked. It measures the maximum result count, not every possible failure
or attachment payload. It is an engineering bound for this measured workload, not a production latency SLA.

Before taking latency samples, run `bun bench/lock-waits.ts --plans` separately. It applies a
real 100,000-result report, then captures `EXPLAIN (ANALYZE, BUFFERS)` for 200 existing and 200 missing test
keys. It records the existing indexes and table estimates, compares automatic, forced custom and forced
generic prepared plans, and repeats after `ANALYZE tests`. These are diagnostic executions, excluded from
the report latency samples. Automatic mode executes each lookup six times before its plan is captured.

The wait bound is 120 seconds. On 2026-10-24, five fresh/existing pairs each committed 100,000 results per
report. The largest application took 25.132 seconds, including its slice pauses; the largest individual pause
was 10.021 milliseconds. Four times that application duration, rounded up to 30-second increments, gives
120 seconds. This also exceeds four times the largest complete request duration of 26.679 seconds. The
headroom allows scheduling and payload variation beyond the passing-results workload.

These samples ran beside four unrelated whole checks after the coordinator's one-hour quiet-window wait
expired. They are shared-machine engineering measurements, not isolated latency or speed-comparison
evidence. Earlier attempts before that fallback authorization remain discarded. The separate quick benchmark
checks the existing product budgets; no product budget is raised.

The measurement driver detects active whole checks and benchmarks. Append `--allow-overlap` when other loops
run; it records their processes and labels the samples. Do not wait for those loops to stop. Such runs check
correctness under that load; CI's quiet job checks isolated performance and the product budgets.
