# Project writes and authority

The operation registry opens a write transaction on a reserved PostgreSQL connection. It locks the caller's
actor row with `FOR SHARE` and then the project's row with `FOR UPDATE`. It rereads the credential and
capability after waiting. The project lock precedes project state reads and sequence allocation, and lasts
through commit. Writers in different projects can overlap, including writes by the same actor. Recovery,
sweeps, delivery bookkeeping, and project administration take the same project row lock.
If the row discovered before a lock wait was replaced, the writer returns `busy` before running its operation.
A missing project name is guarded through the transaction so a new project cannot appear behind the check.

Identity writers take the transaction advisory lock `pg_advisory_xact_lock(821, 1)` before discovery or any
actor, roster, team, project, or command lock. This covers every instance write in the registry, sign-out,
credential and contact changes, bootstrap, identity sweeps, archive import, and project authority
maintenance. Exclusive actor locking joins that same identity lock. Identity mutation lookups and creation
join it before resolving names or ids, including when no row exists. The two-integer advisory key has a
separate namespace from the one-integer project-key and command-id locks.

Within an identity transaction, lock affected actors by ascending id at their final strength. Authority
changes use `FOR NO KEY UPDATE`: it conflicts with another authority change and with a writer's `FOR SHARE`,
so writers reread committed authority after waiting. It permits the `FOR KEY SHARE` checks that inserts into
slots, cases, versions, placements and other project tables take through their foreign keys to actors.
Using `FOR UPDATE` here would deadlock a project writer referencing another actor with an authority change
that holds that actor and waits for the project. After actor locking, take organisation roster guards,
team membership guards by id, project rows by id, and job rows. A team grant
change discovers and locks its members before its project. Another identity transaction cannot create,
rename, remove, or change the owner of a discovered row until commit or rollback. The registry no longer
reserves missing names with the organisation row or repeats footprint checks after later waits.
Actor-before-project ordering still matters: an ordinary project writer may hold an actor while waiting
for that project. Database triggers increment `actors.auth_version` inside the transaction that changes
grants, memberships, organisation authority, credentials, tokens, or sessions.

Ordinary project data writes, report acceptance/application, recovery, and delivery bookkeeping never take
the identity lock. They take shared actor locks followed by their project row. Token activity also stays
outside the identity lock: it takes a shared actor lock before updating the exact token hash, then checks
that its owner is unchanged. Session activity uses the session hash resolver, which takes the identity lock
and its actor before updating the exact hash. Both paths recheck that the credential remains live, so they
cannot restore an address after erasure or follow a replaced owner. None of these transactions changes
identity or upgrades an actor lock. Their foreign-key checks can lock other actors after their project,
but `FOR KEY SHARE` is compatible with authority's `FOR NO KEY UPDATE`. Different projects still write
concurrently. An identity writer waiting for a busy actor or project holds the identity lock and queues
other identity writers, including token creation.

Sign-in does not join the identity lock or lock projects. Token session creation takes `FOR SHARE` on the
existing token owner and refuses an absent or replaced owner. OIDC sign-in commits lock their one discovered
actor with `FOR NO KEY UPDATE` before rereading the identity or noting its use. They never acquire another actor or the identity lock afterwards. Proof that resolves to another
actor returns `busy`. Session insertion does not change authority. Since sign-in can insert a session while
an identity transaction holds the mutex, session ending rejects an id absent at discovery as `not_found`
before the operation can discover a late owner. An existing session's owner stays stable: moving or ending
it still takes the identity lock. Sign-in can wait for a change or writer involving its own actor; an
unrelated actor's waiting grant change does not queue it.

No application writer changes `actors.id`. Forgetting preserves the actor row and pseudonymizes its name;
bootstrap can rename the owner. PostgreSQL may strengthen these name updates to `FOR UPDATE` because of
`UNIQUE (org, name)`. Registry forgetting locks every project before the rename; bootstrap and direct
forgetting take no project locks after it. They therefore cannot hold a stronger actor lock while waiting
back on a project's foreign-key writer. Whole-instance import deletes actor rows under the actor roster's
`ACCESS EXCLUSIVE` table lock, acquired before any project locks. That stronger exclusion remains necessary.

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
Proof discovery can happen before the commit transaction. Sign-in and invitation acceptance return `busy`
if a person, credential, or browser session resolves to an actor they did not lock.

Run `bun bench/identity-contention.ts 5` for two 5,000-result scenarios: identity requests directly beside a
report, and identity requests behind a project grant change already waiting for that report. Each sample
verifies the committed result count, token hash, and session count, and records which request finished
before releasing the report's project barrier.

On 2026-10-25, five alternating before/after samples per scenario compared commit `841e93e3` (serialized
sign-in) with the actor-only sign-in change. Behind the waiting grant change, token sign-in fell from
median 471.648 ms (334.151–815.154 ms) to 5.993 ms (3.277–7.902 ms). It committed before report release in all
five changed samples and none of the five baseline samples. Token creation still waited for the report in
every queued sample: before median 469.359 ms (332.531–813.211 ms), after 341.248 ms (271.457–457.571 ms).
Direct sign-in measured before 5.521 ms (3.714–5.839 ms), after 4.114 ms (2.875–4.933 ms); token creation
measured before 2.865 ms (1.965–4.058 ms), after 2.549 ms (1.685–3.470 ms). Both finished before report
release in every direct sample. All twenty reports committed exactly 5,000 results and each identity
request's stored rows were checked. The 10-core machine had another whole check and a focused test run
active. These are shared-machine contention observations, not isolated throughput comparisons or a
production latency bound. The queued baseline's limiter was the identity advisory lock held by the grant
change, itself waiting for the report's project row. Changed sign-in no longer joins that queue.

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
failure, and statement or transaction timeout map to the shared `busy` error with HTTP 503 before acceptance.
A report's durable checkpoint carries a pending receipt. After that commit, the registry rolls back a busy
application and returns the successful pending receipt with the acceptance sequence. It leaves the command
unfinished and the final batch receipt unset, so recovery can finish both atomically. This also covers waits
while reacquiring actors and the project. CLI and MCP forwarding assign a command id before transport retries
so a lost successful response cannot duplicate a logical report. A lost connection
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

## Shared admission and stream state

Sign-in accounting uses keyed PostgreSQL rows and a separate two-connection admission pool. Failing a proof
locks its sorted keys, rechecks their block, then counts it atomically. A success clears only failures no newer
than the sequence version it observed. Anonymous ceremony starts have a local source ceiling before shared
accounting. Ceremony allocation shares this pool, with one capacity lock per ceremony kind; it holds no connection while
waiting for a provider. Authenticated ceremony consumption uses the domain transaction,
so spending a challenge and opening its session commit or roll back together. Import invalidates a shared
random generation in its transaction; an OIDC exchange rechecks it after the provider answers.

Credential uses update their rows during the request, conditional on the stored time being more than a minute
old and the exact secret hash still being live. No App keeps unwritten activity or supplies an idle grace period.

Project writes record `change_events` and call PostgreSQL `pg_notify` before commit. PostgreSQL delivers the
notification only after commit. Each App keeps one dedicated native Bun SQL listener; a notification wakes
streams, which read ordered events by project sequence. A stream also catches up on every heartbeat, so a lost
notification delays delivery but loses no committed state. Missing history or a replaced project prompts a full
refresh. The stream checks authority again after its snapshot closes before sending anything.

## Shared-state maintenance

Periodic identity-state retention deletes expired ceremonies, failure counters and one-minute start windows
through their owning modules on the admission pool. Periodic change-event retention deletes hints at least
24 hours old under each project's row lock, preserving archive import's project-before-job order; the stream's
existing missing-history path refreshes the full project. Both cleanup jobs fence
their claim in the same transaction as deletion, after their data locks, so losing a claim rolls deletion back.
Report/dispute recovery and decision expiry record durable change hints before their domain transaction commits.

Startup snapshots the reports already accepted and queues immediately due recovery jobs for those batch ids.
The ordinary report job retains its grace period, so reports accepted after startup keep their normal request
application path. A restart does not delay its recovered work behind the grace period of the dead request.

Session expiry and sign-in-record retention take the identity lock and affected actor locks before fencing
their job claim in the same transaction. They then read the clock again for expiry and retention writes.
A worker that loses its lease during either lock wait cannot commit over its successor.
