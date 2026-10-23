# 0155: PostgreSQL and a stateless app

- Date: 2026-10-23
- Status: proposed; step 1 of [issue #821](https://github.com/endqwerty/mainworthy/issues/821), for the owner's acceptance in its pull request.

Replaces [0010](0010-stack.md)'s store choice and PostgreSQL trigger. Amends
[0002](0002-layered-self-hosting.md)'s layers and
[0131](0131-a-deploy-holds-requests-outside-the-stack.md) and
[0132](0132-the-hold-waits-until-nginx-answers.md)'s request hold. The production boundary from
[0130](0130-production-network-lockdown.md) changes as described below.

## Problem

The app owns one SQLite file and admits one server to its data directory. The old server must stop before
its replacement can use that directory. A proxy outside the stack holds requests during deployment, but
cannot eliminate every failed request. The deployer polls for changes and builds on the server without
waiting for that commit's CI gate.

The owner wants the hosted instance to roll between checked images and roll back by image. Before 1.0,
starting with an empty database is acceptable. Keeping the embedded store would preserve the deployment
constraint that this work exists to remove.

## Decision

PostgreSQL is the only store. The app needs its image and PostgreSQL, with no durable local volume.
TypeScript, Bun, React, the operation registry, module ownership and the decision witness remain.
SQL stays in the module that owns its tables, behind the asynchronous kernel database API. There is no
second engine, ORM or dialect layer. Pin the PostgreSQL version selected for Railway's service and use
the same version in CI and local Compose.

The Local product layer ends. Local development runs PostgreSQL through Compose and uses authenticated
bootstrap. Running the same image elsewhere remains possible; supported self-host packaging is deferred.
This replaces 0002's embedded-store and zero-configuration promises. Its common feature set, cache
independence, attachment interface, crash-safe jobs and backup obligations remain.

Every ordinary write is one transaction on one connection. Each project writer locks the project's row
before reading mutable state or allocating its sequence, and holds it through commit. This includes jobs,
recovery and administrative writes. The sequence advances transactionally in commit order. Different
projects may write concurrently. Standing still changes only through a decision witness.

Authority uses a per-actor row lock and an `auth_version` bump. A writer locks its caller's actor row and
resolves current authority after waiting. An authority change takes a conflicting lock on every affected
actor and increments that actor's version in the same transaction. Successful revocation waits for that
actor's admitted writes, without holding unrelated actors across the instance. There is no global
shared/exclusive authority lock or instance authorization watermark. Change streams continue to check
current authority before each event and on their heartbeat.

Reports keep two explicit durable phases, the existing exception to one operation per transaction in
`src/server/ops/writes.ts` and `registry.ts`:

1. Acceptance stores the immutable batch, binds its command id, and makes affected runs pending in one
   transaction. A pending batch cannot leave a stale green gate.
2. Application takes a fresh project lock and context, applies the whole batch, and commits its receipt
   and command completion together. It gets its own sequence and witness. A crash rolls back application;
   the accepted batch remains retryable. Yielding between slices does not commit partial results.

Workers claim jobs with `FOR UPDATE SKIP LOCKED`, then wait normally, within a bound, for the project row.
Use a small worker pool and the same application path for recovery and request processing. No aged-candidate
or project-lock sampling protocol is needed. Accepted work retains its producer attribution and accepted
time; it does not depend on replaying a bearer token.

There is no data migration. Start an empty PostgreSQL instance and fill it through the demo. Replace the
SQLite migration chain with one PostgreSQL baseline. Existing data, identities and tokens do not carry
over. The initial reset has its own cutover and abort check; returning to SQLite after accepting new
writes is not an image rollback.

Railway hosts one project with a volume-free app service and a separate Railway PostgreSQL service.
Cloud Run with Cloud SQL is the fallback. No application module depends on Railway, a provider queue or
Redis. Steps 1 to 3 do not wait for Railway account availability.

## Deployment and rollback

CI builds each commit's image once, smoke-tests that exact image, and after `gate` passes on `main`
publishes the same image to public GHCR without rebuilding it. CI tells Railway to deploy that image by
immutable digest, so what runs is what was tested. Pin the Dockerfile's base images by digest and its OS
packages to fixed versions, so that no rebuild can quietly change what a tested commit contains. The Railway project token
is scoped to production and stored in a GitHub environment restricted to `main`; pull requests cannot
read it. Railway's GitHub integration with "wait for CI" is rejected here because it rebuilds the commit.

Commit Railway's service configuration to the repository. Configure `/healthz` to report ready only when
the database answers and migrations are complete, and to name the image's commit. Set
`RAILWAY_DEPLOYMENT_OVERLAP_SECONDS` and `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` from deployment checks so
in-flight requests finish and browser and iPhone change streams reconnect.
[Railway documents both intervals](https://docs.railway.com/deployments/deployment-teardown).

After the baseline, migrations add before they remove. The previous PostgreSQL release must still read
and write the new schema, and the new release must accept its writes. CI runs the previous release's
smoke checks against the new schema. Rollback selects the previous image without a down migration.
Retire 0131 and 0132's hold only after rolling replacement passes the continuous-request and rollback checks.

Preserve 0130's requirement to normalize client and scheme headers at a trusted Cloudflare ingress.
Step 4 must prove that a direct origin request cannot supply a trusted client address. The owner's server's
namespace egress lockdown, privileged setup and loopback origin do not transfer to Railway. Retain nonroot
execution and document the replacement network boundary without claiming the old outbound deny policy.

Step 6 combines Railway backups with scheduled `pg_dump` backups to Cloudflare R2 from GitHub Actions,
plus a restore into a fresh database. Step 7 points `mainworthy.com`, still on Cloudflare DNS, at Railway's
custom domain. Check public health and TestFlight before retiring the old Coolify application, tunnel route,
polling deploy job, request hold and tailnet node. Their removal instructions belong in the private
infrastructure notes, not this public repository.

## Order

Start the async shape work before acceptance of this record: it changes no store, schema or public
contract. Convert callers before callees, from the registry down, on SQLite in ordinary independently
verified pull requests that land on `main`. Keep SQLite's writer gate until the engine changes. The first
slice updates the witness scan for async functions and compares the quick benchmark before and after.
No long-lived conversion branch is needed.

Steps 3 and 5, the CI image and CI-triggered deployment, are store-independent and may go first. Railway
deployment still needs the account and service. Acceptance gates the PostgreSQL flip, not the async
preparation. Prepare the baseline, fixtures and SQL checks before a one-to-two-day freeze of SQL-bearing
files and migrations for the flip only. Each module's declared statements must prepare against that
baseline. Unrelated web, iPhone, documentation and process work continues.

## Consequences

- Durable state crosses instances. Move sign-in ceremonies and last-use notes to PostgreSQL, with atomic
  single consumption and monotonic use times. Persist change history with each write; `LISTEN`/`NOTIFY`
  only wakes readers. Keep one history source and a retention job. Preserve coherent read snapshots,
  global command-id replay checks, the demo's time exception and injected test clocks.
- Step 2 deliberately defers #821's "failed sign-in count" move. Keep the in-memory limiter to limit the
  identity conversion's scope. It resets on restart and permits separate budgets during overlap. Run one
  steady app replica; shared limiting is required before a second steady replica. This is a known limit
  of the first stateless deployment, not a claim that all request state is shared.
- Keep attachments behind `BlobStore`, initially as PostgreSQL bytes with reference foreign keys and
  bounded cleanup. Replace FTS5 with PostgreSQL full-text search. Remove SQLite's reader and checkpoint
  threads, instance lock, file checks and upgrade-copy machinery. Move startup-only rebuilds and cleanup
  to coordinated jobs or migrations.
- Step 2 measures the largest supported report and its slice pauses before setting statement, transaction
  and idle ceilings. Set the lock wait on the order of the transaction ceiling; return retryable `busy`
  for the tail. If `busy` rolls back an unaccepted command, its reservation rolls back too and a same-id
  retry starts afresh.
  Already-accepted work stays pending; a lost commit reply remains uncertain. These are client contract
  changes for step 2. No timeout number here is a measurement, and no product budget increases.
- Local and CI fixtures need isolated databases, bounded pools and a connection budget for concurrent
  worktrees. Step 2 includes preflight and release cleanup, handwritten deployment and guide updates,
  and generated client contracts. The implementation must pass `bun run check` on PostgreSQL, existing
  benchmarks and two-instance crash, replay, revocation, sign-in and stream-reconnect checks.

## Alternatives

SQLite with [Litestream](https://litestream.io/how-it-works/) can provide an off-site backup before cutover.
Backup replication alone leaves the local writer and its handover problem in the app deployment.
[LiteFS](https://docs.fly.io/litefs/how-it-works) can hand over a primary, but keeps local database replicas
and adds primary leases and write routing. That is a different deployment system to operate and does not
deliver the chosen volume-free app with a separate database. Neither is the destination for this rollover.

Keeping both SQLite and PostgreSQL retains two query and migration paths and the Local machinery. Moving
only the host leaves the database-file constraint. CI images and CI triggers can improve independently,
but overlapping writers require the store change.

Principles: Separate Before Serializing Shared State limits locks to project and actor invariants.
Sequence Work into Verifiable Units puts the async shape on checked SQLite slices before the engine flip.
