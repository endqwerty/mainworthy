# Project writes and authority

The operation registry opens a write transaction on a reserved PostgreSQL connection. It locks the caller's
actor row with `FOR SHARE` and then the project's row with `FOR UPDATE`. It rereads the credential and
capability after waiting. The project lock precedes project state reads and sequence allocation, and lasts
through commit. Writers in different projects can overlap, including writes by the same actor. Recovery,
sweeps, delivery bookkeeping, and project administration take the same project row lock.
If the row discovered before a lock wait was replaced, the writer returns `busy` before running its operation.
A missing project name is guarded through the transaction so a new project cannot appear behind the check.

Authority changes take `FOR UPDATE` on every affected actor. Lock actors by ascending id, at their final
strength. Then take organisation roster guards, team membership guards by id, project rows by id, and job
rows. Ordinary project writers skip the membership guards. A team grant change discovers members, locks those actors, locks the
team row with `FOR NO KEY UPDATE`, and checks membership again. A newly discovered member causes rollback
and `busy`, so a retry discovers the complete set. Membership changes use the same actor and team locks.
Organisation changes version every member. Database triggers increment `actors.auth_version` inside the
transaction that changes grants, memberships, organisation authority, credentials, tokens, or sessions.

Instance writes have no shared authority mutex. They lock their caller for admission and the actors whose
authority or credentials they change. Creating an actor guards its organisation's roster row. Creating a
project locks its key until commit, then its newly inserted row. Bootstrap locks only the owner, the policy
actor, configured-token owners, and affected admins, then guards organisation creation. Project-specific
personal and team grant changes also lock that project after their affected actors and membership guards.
Instance settings come from server configuration. Startup reconciliation takes those bootstrap locks when
it changes authority or configured tokens; there is no writable instance settings table. Project policy
settings take their project's row lock and a decision witness.
The shared commit-status delivery allowance locks its singleton row after the project, so its read and update
remain atomic across project workers. A whole-instance
archive import is maintenance affecting every identity and project. It exclusively locks the actor roster,
then its actors, then the project roster and project rows. That excludes even an insertion into an empty
instance. A demo swap locks the affected grant holders and teams, reserves the project's key, then locks its
row before reading deployment state. Grant movement locks the union of source and destination authority,
with projects in id order. It checks the complete grant footprint again after waiting and restarts if another
holder appeared or the project was renamed. Ready-state bookkeeping locks the project too. Each retired-demo
cleanup slice keeps its authority and project locks until the slice commits, then yields. Startup refresh and
cleanup remain paused.

Actor creation takes its organisation guard before any project row. A newly inserted actor is private to
that transaction until commit, and the roster guard excludes a competing insertion. Missing actor or team
names reserve the same guard so they cannot appear between a footprint check and its use. Team creation
also takes that guard. Operation inputs are parsed before discovering lock keys, so stripped fields cannot change lock strength. After project or command
waits, the registry checks the discovered actor and team footprint again and returns `busy` if it grew.
Sign-in commits also return `busy` if a person, credential or browser session resolves to an actor they did
not lock.

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
