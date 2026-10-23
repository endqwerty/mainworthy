# PostgreSQL on Cloud Run and Cloud SQL

- Date: 2026-10-23
- Status: proposed
- Issue: https://github.com/endqwerty/mainworthy/issues/821

Step 1 of [issue #821](https://github.com/endqwerty/mainworthy/issues/821), as the owner set it on 2026-10-23.
It replaces [PostgreSQL and a stateless app](2026-10-23-postgresql-and-a-stateless-app.md), which was accepted the
same morning with Railway as the host. Railway was dropped a few hours later (#821, "Decisions"), and the owner
chose Google Cloud. This record repeats that record's store design, so a reader needs only this one, and says
under "What changed since the Railway record" where it differs. Until step 2 lands, the code runs on SQLite as
[0010](0010-stack.md) describes.

It replaces [0010](0010-stack.md)'s store choice and its PostgreSQL trigger, and amends
[0002](0002-layered-self-hosting.md) (the layers), [0026](0026-the-apps-offer-one-instance.md) (one instance),
[0130](0130-production-network-lockdown.md) (the production network boundary), and
[0131](0131-a-deploy-holds-requests-outside-the-stack.md) and [0132](0132-the-hold-waits-until-nginx-answers.md)
(the request hold). "What this amends" gives each change.

## Problem

The app keeps its data in one SQLite file on its own volume and admits one server to that directory, so two
versions cannot run side by side. A deploy stops the old server, then starts the new one. A proxy on the host
holds requests for up to 90 seconds meanwhile and still cannot close every gap (0131, 0132). A schema upgrade
first copies the whole file: about 14 minutes for the 880 MB file on 2026-10-21 (#695). The deploy job polls
`main`, waits ten minutes, builds the commit on the server, and does not wait for CI (#90). A rollback rebuilds
an older commit.

The owner wants deploys that start the new version beside the old one, wait for CI, and roll back by moving
traffic. Mainworthy has no users before 1.0, so starting with an empty database is acceptable.

## Decision

### The store

PostgreSQL is the only store. The app is its image plus PostgreSQL, with no durable local volume. TypeScript,
Bun, React, the operation registry, the module map and the decision witness stay. SQL stays in the module that
owns its tables, declared with `sql()` and run through the kernel's database API, which becomes asynchronous.
There is no second engine, no ORM and no dialect layer.

The major version is PostgreSQL 18, the default for new Cloud SQL instances on 2026-10-23
([Google's version list](https://docs.cloud.google.com/sql/docs/postgres/db-versions)). Compose and CI run the
same major version.

The Local layer ends. Local development runs PostgreSQL through Compose and signs in through the authenticated
bootstrap. Running the image elsewhere stays possible, but supported self-host packaging is not part of this
work (#821, "Not in this issue").

There is no data migration. The new instance starts empty and the demo fills it. The SQLite migration chain is
replaced by one PostgreSQL baseline. Existing data, identities and tokens do not carry over. Going back to
SQLite after the new instance has accepted writes is not a rollback, and step 7 says how the cutover is undone
before then.

### One writer per project, without a single writer

Every ordinary write is one transaction on one connection. A project writer locks the project's row
(`SELECT ... FOR UPDATE`) before it reads mutable state or allocates the project's sequence, and holds the lock
through commit. This covers requests, jobs, recovery and administrative writes. So the sequence still advances
in commit order within a project, as the single writer guarantees today, and different projects write at the
same time. Standing state still changes only through a decision witness.

Authority uses a lock per actor and an `auth_version` column. A writer locks its caller's actor row and reads
current authority after any wait. A change of authority takes a conflicting lock on every affected actor and
increments that actor's version in the same transaction. So a revocation waits only for that actor's admitted
writes, and nobody else's. There is no instance-wide authority lock. A change stream still checks current
authority before each event and on each heartbeat.

Reports keep their two durable phases, the one exception to one operation per transaction
(`src/server/ops/writes.ts`, `registry.ts`):

1. Acceptance stores the batch, binds its command id, and marks affected runs pending, in one transaction. A
   pending batch cannot leave a stale green gate.
2. Application takes a fresh project lock, applies the whole batch, and commits its receipt and the command's
   completion together, with its own sequence number and witness. A crash rolls the application back and the
   accepted batch can be applied again. Pausing between slices of a large batch commits nothing partial.

Lock waits are bounded. Step 2 measures the largest supported report and the pauses between its slices before
it sets the statement, transaction and idle timeouts. The lock wait is about as long as the transaction
timeout, and a write that waits longer gets a retryable `busy`. A `busy` that rolls back an unaccepted command
rolls back its command id too, so a retry with the same id starts again. Accepted work stays pending, and a
commit whose reply was lost stays uncertain to the client. These are changes to the client contract that step 2
documents. No number in this record is a measurement, and no product budget goes up.

### State shared by every instance

Cloud Run starts a second instance under load, and during a deploy the old and new revisions run together. So
nothing that decides behaviour may live in one process:

- **Failed sign-in counts** move to PostgreSQL in step 2, with the same windows and limits as
  `src/server/identity/limiter.ts` has in memory today. The Railway record deferred this. It is not deferred
  here, because a Cloud Run service can have several instances whenever its scaling allows it.
- **Sign-in ceremonies and passkey challenges** (`oidc.ts`, `challenges.ts`) move to PostgreSQL, each consumed
  at most once, atomically. A sign-in that starts on one instance can then finish on another.
- **Last-use notes** (`uses.ts`) stay in each instance's memory between writes, because a write per request
  would add a round trip to every request. A throttled instance cannot rely on a timer, so it writes its notes
  during a request once the last write is a minute old, and again on SIGTERM. A written time never moves
  backwards. A crash loses up to a minute of notes, as it does today.
- **The change stream** works across instances. Each write records its change event in the same transaction, and
  `LISTEN`/`NOTIFY` only wakes the instances that hold streams, which then read what was recorded. One table is
  the history; a retention job trims it. Each instance holds one connection for `LISTEN`.

Read snapshots stay consistent, a command id is replayed only once across all instances, the demo keeps its own
times (decision 0100), and tests keep their injected clocks.

Attachments stay behind `BlobStore` (0002 rule 5), whose methods become asynchronous. Local development and CI
keep the disk store. In production the bucket holds them. Step 3 first tries mounting the bucket as a Cloud
Storage volume on the service, so the disk store runs unchanged; a store that calls Cloud Storage replaces it
only if a check fails (an atomic rename, read-after-write, or the time to save an attachment). Full-text search
moves from FTS5 to PostgreSQL's `tsvector` with `ts_rank`, as the stack arena measured (0010).

### Background work

With request-based billing, Cloud Run slows an instance's CPU to almost nothing between requests. Work the
server does on its own timer would then barely run: today that is the minute job in `src/app/start.ts` (expired
decisions, last uses, expired sessions, old sign-in records, tracker requests, hand-offs, defect holds, commit
statuses), the outgoing mail, and the slices of a large report after its request has answered.

So background work becomes jobs behind one job interface (0002 rule 6):

- A job is a row in PostgreSQL, written in the transaction that makes it necessary. A worker claims it with
  `FOR UPDATE SKIP LOCKED`, then waits as usual, within the bound above, for its project's lock. Every job is
  idempotent and keeps the actor and time it was accepted with; none replays a bearer token.
- The job interface has two ways to start work. The in-process runner polls the table and runs jobs; local
  development, CI and the tests use it, as would any host whose CPU runs between requests. On Cloud Run, a job
  is started by an HTTP request to the service's job endpoint, so the CPU is allocated while it runs: Cloud
  Tasks sends one request per job, and Cloud Scheduler sends the periodic work once a minute.
- The job endpoint accepts only a request with an OIDC token that Google signed for the service's address and
  the job service account. The app checks its signature against Google's published keys with `jose`, which it
  already depends on, and its issuer, audience and account against configuration. It holds no shared secret.
- A job whose request never arrived is still a row. The minute run starts every job that is due and not
  claimed, so a lost task delays work by at most a minute and loses nothing.

Cloud Scheduler is the one service this adds to the owner's list in #821; it has no other way to start the
periodic work on a throttled instance. Three jobs are free for each billing account, and Mainworthy needs one.

### The host

Google Cloud, region `us-west1`, in one organisation on the project's domain. The services are Cloud Run for
the app, Cloud SQL for PostgreSQL, Artifact Registry for images, Cloud Storage for attachments, Cloud Tasks and
Cloud Scheduler for background work, and Secret Manager for the few secrets.

Google-specific services stay in the infrastructure, not in the app. The app speaks plain PostgreSQL over one
connection URL, reads and writes attachments through `BlobStore`, sends traces through OpenTelemetry, and runs
background work through its job interface. The one piece of app code that calls a Google API is the Cloud Tasks
dispatcher behind that interface, in one module, chosen by configuration. Leaving Google Cloud means rewriting
the Terraform and choosing the in-process runner, not changing the domain code.

The lean setup from #821, which steps 3 to 7 build:

| Part | Setting |
| --- | --- |
| App | Cloud Run, 1 vCPU, 512 MiB, request-based billing, one minimum instance |
| Production database | Cloud SQL `db-f1-micro`, 10 GiB SSD, automatic backups and point-in-time recovery |
| Preview databases | a second `db-f1-micro` with one database per open pull request (#894) |
| Previews | Cloud Run, scaling to zero |

#821 gives the monthly costs, priced in `us-central1`: about $31 to $37 with previews. Step 3 reads the
`us-west1` prices before its first apply and records them in its pull request. Cloud Run needs at least 1 vCPU to
serve more than one request at a time. Moving to CPU that is always allocated, or to a dedicated database with an
SLA, waits until outside users arrive.

A `db-f1-micro` instance allows 25 connections
([Cloud SQL's `max_connections` defaults](https://docs.cloud.google.com/sql/docs/postgres/flags)), and Cloud SQL
keeps some of them for itself. So the service's maximum instance count, times each instance's pool plus its
`LISTEN` connection, plus a migration and an operator's session, must stay under that limit. Step 2 makes the pool
size a setting with a small default; step 3 sets the maximum instance count from that sum.

### What the organisation enforces

The owner applies the organisation's foundation once, from the owner's private infrastructure notes, because it
holds the organisation and billing account ids. That covers folders, projects, organisation policies, the audit
log sink, the GitHub sign-in pool for Workload Identity Federation, CI's deploy service account and the agents'
read-only one. No organisation id, billing account id or project id is written in this public repository: the
Terraform here reads them from CI's configuration. Four of the organisation's rules shape the design:

- **Domain-restricted sharing.** `allUsers` cannot be granted a role, so a public Cloud Run service cannot be made
  public by IAM. The service turns off its invoker IAM check instead (`invoker_iam_disabled` in Terraform). Google
  then authenticates no request to it, and every path, the job endpoint included, is reachable by anyone who has
  the address. The app already authenticates every request itself; the job endpoint checks its OIDC token.
- **No public IP on Cloud SQL, and no default network in a new project.** Step 3 makes a VPC with one subnet in
  `us-west1` and private services access for Cloud SQL. The app reaches Cloud SQL's private address through
  Direct VPC egress, for private ranges only, so its other outbound requests (GitHub, mail, sign-in providers)
  leave without a NAT gateway.
- **IAM database authentication.** The app connects as its own service account, so there is no database
  password. The Cloud SQL Auth Proxy runs as a sidecar container of the service with automatic IAM
  authentication over the private address, and the app connects to it on loopback with a plain PostgreSQL URL.
  Step 3 replaces the sidecar with a token fetched by the app only if the sidecar fails a measured check (start
  time or memory), and records why.
- **No service-account keys.** CI signs in to Google Cloud through Workload Identity Federation from GitHub
  Actions, with no stored key. Nothing in the app or CI holds a key file.

Agents never hold write access to production. They change infrastructure by editing the Terraform in a pull
request; CI shows the plan, and after the merge CI applies it as its own service account. Agents get the
read-only identity for logs, metrics and configuration. A budget alert exists from the first day.

### Deployment and rollback

After `gate` passes on `main`, CI builds the image once with a layer cache, labels it with the commit, smoke-tests
that image, and pushes it to Artifact Registry. The Dockerfile pins its base images by digest and its OS packages
to fixed versions, so a rebuild cannot quietly change what a tested commit contains. CI then deploys that image by
digest as a new Cloud Run revision, signed in through Workload Identity Federation from a GitHub environment that
only `main` can use; pull requests cannot reach it.

`/healthz` reports ready only when the database answers and the migrations are done, and names the image's
commit. Cloud Run's startup probe reads it, and traffic moves to the new revision only once it is ready. A
revision that never becomes ready never takes traffic. A rollback moves traffic back to the previous revision.

Migrations run when a new revision starts, under a PostgreSQL advisory lock, so two starting instances do not run
them twice. After the baseline, a migration adds before it removes: the previous release must still read and write
the new schema, and the new release must accept the previous one's writes. A CI job proves it by running the
previous release's smoke checks against the new schema. There are no down migrations.

When a revision stops serving, Cloud Run sends SIGTERM and allows ten seconds before it stops the instance.
Requests in flight finish within that time, and browser and iPhone change streams reconnect to the new revision,
which they already do after an error. #893 closes a hidden page's stream, which also keeps an idle tab from
billing the instance as active.

### The network boundary and client addresses

Cloudflare stays in front of `mainworthy.com`. The client address and scheme come from Cloudflare's headers, as in
0130. Because the service accepts unauthenticated requests on its own `run.app` address as well, a request can
skip Cloudflare and carry a forged `CF-Connecting-IP`. Step 7 therefore makes the app trust Cloudflare's header
only for a request that came through Cloudflare, either by turning off the `run.app` address or by checking the
address Google's front end recorded against Cloudflare's published ranges. Its check is that a direct request
cannot supply a trusted client address, so it cannot reset the sign-in limits.

0130's lockdown (an nft table in the app's network namespace, root setup and a `setpriv` drop) and its loopback
origin have no counterpart on Cloud Run, which runs the container without root and without a network namespace of
its own. The container still runs as a non-root user. No outbound deny policy is claimed on Cloud Run;
Direct VPC egress for all traffic with egress firewall rules and a NAT gateway could restore one, and that is its
own issue if it is wanted.

### Backups

Cloud SQL's automatic backups and point-in-time recovery cover the database. The attachments bucket keeps object
versions for at least as long as the database's recovery window. Step 6 restores both into a scratch instance and
checks that the copy answers with the same data (#59).

## Order

The steps are #821's. Each ends in a check that passes before the next starts.

1. This record. The owner accepts it in its pull request, and nothing is built on it before that.
2. The store on PostgreSQL, as a stack of pull requests. Each passes `bun run check` against PostgreSQL in CI and
   keeps the `bench/` budgets. The bottom request moves the engine: the kernel's database API on `Bun.sql`, the
   baseline schema, every module's SQL, every caller awaited, search on `tsvector`, the project and actor locks in
   place of the write gate, a database for each test file, and PostgreSQL in Compose and CI. No smaller first
   request can pass against PostgreSQL, because synchronous domain code cannot call it, so this one is large. To
   keep it reviewable, a committed codemod adds the `async` and `await` (a reviewer runs it again and compares),
   the SQL changes are separate commits by module, and a test prepares every declared statement against the
   baseline. The SQLite-only machinery goes in the same request, because nothing can call it afterwards: the
   upgrade copy, the reader and checkpoint threads, the instance lock and the database-file checks (#659).
   The requests above it move the state shared by every instance (sign-in counts, ceremonies, last uses, the
   change stream), make background work into jobs with the in-process runner and the job endpoint, and add the
   two-instance checks: a crash, a replayed command, a revocation, a sign-in and a stream reconnect, each with two
   servers on one database. The last request measures the timeouts and looks for requests that make many small
   queries, since each query is now a round trip.
3. The app's Google Cloud infrastructure in Terraform, in this repository, applied by CI inside the Mainworthy
   projects only: Artifact Registry, both Cloud SQL instances, the bucket, the Cloud Tasks queue, the Cloud
   Scheduler job, Secret Manager, the VPC, its subnet and private services access. The Cloud Tasks dispatcher
   lands here, where a real queue can check it. Check: `terraform plan` in CI shows no change after the first
   apply, and the read-only identity cannot change anything.
4. Build once in CI and push to Artifact Registry. Check: `/healthz` reports the commit of the deployed image.
5. Deploys triggered by CI. Check: a deploy under a continuous request loop fails no request, a rollback works,
   and the time from push to `/healthz` naming the commit, over several deploys with its spread.
6. Backups and a restore drill (#59).
7. The cutover: `mainworthy.com` points at Cloud Run, with the client-address check above. Until the first write
   to the new instance, undoing it means pointing Cloudflare back at the owner's server. Check: public
   `/healthz` names the deployed commit, and the iPhone app's TestFlight job still uploads.

Steps 3 to 7 wait for the organisation's foundation. That replaces the Railway record's plan of async slices on
SQLite landing on `main` before the flip: only its first slice landed
([#846](https://github.com/endqwerty/mainworthy/pull/846)), and the owner asked for a stack that runs on
PostgreSQL throughout.

## What this amends

- [0010](0010-stack.md): its store choice, its PostgreSQL trigger and "One process, one writer, readers on their
  own threads" are replaced. TypeScript, Bun, React, Zod, the MCP SDK and the tools stay.
- [0002](0002-layered-self-hosting.md): one layer remains, the image with PostgreSQL. Rule 3 (layer is
  configuration) becomes one database URL. Rule 4 (Local first) and rule 7 (Local's security) end with the Local
  layer; local development still binds to loopback. Rules 1, 2, 5 and 6 stay, with jobs as above. Rule 8 stays,
  except that the path back from a failed upgrade is the previous image on a schema that still serves it, not a
  copy of the file.
- [0026](0026-the-apps-offer-one-instance.md): the apps still offer one instance, `mainworthy.com`. The guide's
  pages for whoever runs an instance (configuration, quickstart, your data) change in step 2 to say that an
  instance needs PostgreSQL, and that running one elsewhere is possible but not yet supported.
- [0130](0130-production-network-lockdown.md): the lockdown and the loopback origin do not move to Cloud Run;
  trusting Cloudflare's headers only for requests that came through Cloudflare does, as above. Its code stays
  until the cutover, because the owner's server runs it until then.
- [0131](0131-a-deploy-holds-requests-outside-the-stack.md) and
  [0132](0132-the-hold-waits-until-nginx-answers.md): the hold is retired at the cutover, once step 5's
  continuous-request and rollback checks pass. Until then it stays.
- [PostgreSQL and a stateless app](2026-10-23-postgresql-and-a-stateless-app.md): superseded by this record.
- #57 is superseded and is closed when this record is accepted.

## What changed since the Railway record

- The host is Google Cloud, not Railway, with the organisation's four rules above. Images go to Artifact Registry,
  not public GHCR. CI signs in through Workload Identity Federation, not with a Railway token.
- Failed sign-in counts move to PostgreSQL in step 2 instead of being deferred.
- Background work runs as jobs started by HTTP requests (Cloud Tasks, Cloud Scheduler) in production, because
  request-based billing throttles the CPU between requests. The Railway record had a pool of workers in the
  process.
- Attachments go to a Cloud Storage bucket in production, not into PostgreSQL.
- Step 2 is a stack that runs on PostgreSQL throughout, not async slices on SQLite landing on `main`.
- Backups are Cloud SQL's own, not `pg_dump` to Cloudflare R2.

The store design (one PostgreSQL, the project and actor locks, the two phases of a report, the empty start, one
baseline, add-before-remove migrations) is unchanged.

## Consequences

- Each query is a round trip to another machine instead of a call into the process. A request that makes many
  small queries gets slower in proportion; step 2's last request finds them, and `bench/` holds the budgets.
- A `db-f1-micro` has a shared CPU, 0.6 GiB of memory, no SLA and 25 connections. It is enough for an instance with
  no outside users, and it is the first thing to change when they arrive.
- Local development needs Docker for PostgreSQL. `scripts/preflight.ts` says so when it is missing, and each
  worktree's tests use their own databases, which `bun scripts/work.ts release` removes.
- The iPhone app and the web client are unchanged by the move, apart from the client-contract changes for `busy`
  above and a stream that reconnects during a deploy.

## Alternatives

**Railway**, the choice for a few hours on 2026-10-23: it had paused sign-ups after an outage of more than 40
hours, and every preview costs money while it exists.

**SQLite with [Litestream](https://litestream.io/how-it-works/)** gives an off-site backup but keeps the local
writer and its handover. **[LiteFS](https://docs.fly.io/litefs/how-it-works)** hands over a primary, but keeps
database replicas on local disks and adds primary leases and write routing, which is a different deployment
system to run. Neither gives an app with no volume and a separate database.

**Both SQLite and PostgreSQL** keeps two query and migration paths and the Local machinery. **Moving only the
host** keeps the database file and the handover.

**CPU always allocated** (instance-based billing) would let the in-process runner do the background work with no
Cloud Tasks or Scheduler, for about $45 a month instead of $10 for the app (#821). It is the simpler design and the
first fallback if the job endpoint proves fragile.

**A load balancer with Cloud Armor** in front of Cloud Run would let only Cloudflare reach the service, at about
$18 a month more. Checking the front end's recorded address, or turning off the `run.app` address, does the same
job for the client address at no cost.

**Async slices on SQLite first**, the Railway record's plan, give smaller pull requests before the flip, but each
needs temporary transaction helpers that the flip throws away, and none of them runs on PostgreSQL.

Principles: Separate Before Serializing Shared State (locks cover only the project and actor invariants, so
unrelated projects and actors stay independent); Boundary Discipline (Google services stay in the
infrastructure, behind the store URL, `BlobStore` and the job interface); Make Operations Idempotent (a job is a
row, so a lost task delays work and loses nothing); Outcome-Oriented Execution (the stack goes straight to
PostgreSQL instead of keeping temporary SQLite compatibility).
