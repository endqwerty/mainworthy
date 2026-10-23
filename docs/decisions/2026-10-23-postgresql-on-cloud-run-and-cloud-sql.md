# PostgreSQL on Cloud Run and Cloud SQL

- Date: 2026-10-23
- Status: accepted
- Issue: https://github.com/endqwerty/mainworthy/issues/821

Step 1 of [issue #821](https://github.com/endqwerty/mainworthy/issues/821), as the owner set it on 2026-10-23.
Accepted by the owner on 2026-10-23, with the proposals listed below. Acceptance permits step 2; it does not
certify its implementation.
It replaces [PostgreSQL and a stateless app](2026-10-23-postgresql-and-a-stateless-app.md), which was accepted the
same morning with Railway as the host. Railway was dropped a few hours later (#821, "Decisions"), and the owner
chose Google Cloud. This record repeats that record's store design, so a reader needs only this one. "What
changed since the Railway record" lists where it differs, and "Proposals for the owner" lists what neither #821
nor the Railway record decided. Until step 2 lands, the code runs on SQLite as [0010](0010-stack.md) describes.

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
current authority after any wait. A change of authority takes a conflicting lock on every affected actor, a
team's or an organisation's members included, and increments each one's version in the same transaction. So a
revocation waits only for those actors' admitted writes, and nobody else's. There is no instance-wide authority
lock. A change stream still checks current authority before each event and on each heartbeat.

Every transaction takes its locks in one order: actor rows by id, then the project row, then job rows. A deadlock
or serialization failure that PostgreSQL reports anyway becomes the retryable `busy` below, never an internal
error. A command id is unique across the instance, not only within a project, so a replay is recognised wherever
it arrives.

A read that spans several statements runs in one `REPEATABLE READ READ ONLY` transaction on one connection, so it
sees one snapshot, as `snapshotAsync` in `src/server/kernel/db.ts` gives it today. PostgreSQL's default,
`READ COMMITTED`, takes a new snapshot for each statement and is not enough. A snapshot can be older than a
revocation that committed while the read ran, so after the snapshot closes and before the result is returned,
every read checks the credential, the project and the capability again on a fresh view, as reads on the reader
threads do today (`registry.ts`). Tests pause a read, revoke the token, end the session or remove the grant from
another connection, and see the read refused.

Reports keep their two durable phases, the one exception to one operation per transaction
(`src/server/ops/writes.ts`, `registry.ts`):

1. Acceptance stores the batch, binds its command id, and marks affected runs pending, in one transaction. A
   pending batch cannot leave a stale green gate.
2. Application takes a fresh project lock, applies the whole batch, and commits its receipt and the command's
   completion together, with its own sequence number and witness. A crash rolls the application back and the
   accepted batch can be applied again. Pausing between slices of a large batch commits nothing partial.

The actor's lock ends with the acceptance commit, so a revocation can commit between the two phases. The accepted
batch therefore records the hash of the exact token or session it was admitted with and its actor's
`auth_version`, in a table of its own that is in `UNEXPORTED` and loses its row when the batch is applied or
cancelled, so no archive holds a credential's hash. An accepted batch that arrives by import has no such row and
is cancelled, not applied. A test checks that no token or session hash appears in an export. Application, and recovery after a crash, lock the actor row and check both again before they
apply anything: the credential must still be live, and if the version moved, current authority must still allow
the report. If not, application cancels the batch and removes its pending marks in one transaction, and the
command's reply says the report was refused. Tests revoke the token, end the session and remove the grant
between the phases, and before recovery.

Today both phases run inside the report's own request: the request yields between slices but replies only when
the batch is applied, and a batch whose request died is applied at the next startup. That stays. While the
request is open, Cloud Run allocates its CPU. Only the recovery of an accepted batch becomes a job. If step 2
measures a supported report that cannot be applied within its request, replying before application is a change
to the client contract, and it needs its own decision.

Lock waits are bounded. Step 2 measures the largest supported report and the pauses between its slices before
it sets the statement, transaction and idle timeouts. The lock wait is about as long as the transaction
timeout, and a write that waits longer gets a retryable `busy`. A `busy` that rolls back an unaccepted command
rolls back its command id too, so a retry with the same id starts again. Accepted work stays pending, and a
commit whose reply was lost stays uncertain to the client. These are changes to the client contract that step 2
documents. No number in this record is a measurement, and no product budget goes up.

### State shared by every instance

Cloud Run starts a second instance under load, and during a deploy the old and new revisions run together. So
nothing that decides behaviour may live in one process:

- **Failed sign-in counts** move to PostgreSQL, with the same windows and limits that
  `src/server/identity/limiter.ts` keeps in memory today. That limiter stays out of the write gate on purpose, so
  that an anonymous flood cannot stall every writer, and the move keeps that property. Sign-in work that needs no
  session (attempts, counts, starting a ceremony) runs on its own small pool of connections, which cannot use the
  pool of domain writes. Each instance keeps a cheap limit in memory in front of it that refuses before PostgreSQL
  is reached, a cap on the rows of each ceremony table refuses new ceremonies when it is full, and a Cloudflare
  rate-limiting rule limits sign-in paths at the edge. A test floods sign-in from many addresses and names and
  sees project writes, sign-out and revocation still finish within a bound.
- **Every sign-in ceremony** moves to PostgreSQL, each consumed at most once, atomically, so a ceremony that
  starts on one instance can finish on another. That covers OIDC ceremonies and native hand-offs and the import
  generation that invalidates them (`oidc.ts`), passkey challenges (`challenges.ts`), TOTP enrolment and
  second-factor sign-in (`totp.ts`), and email verification and password-reset links (`contacts.ts`). A pending
  TOTP sign-in holds the password credential's stored hash, to see whether the password changed between the two
  steps (`people.ts`); its row keeps a digest of that hash instead, and every ceremony table is in `UNEXPORTED`.
- **Last uses of tokens and sessions** (`uses.ts`) are written to PostgreSQL during the request that uses them,
  at most once a minute for each row: the update changes a row only when its stored time is more than a minute
  old. So the stored time is at most a minute behind the real one on every instance. The idle check of a session
  (`sessions.ts`) reads the stored time as it is, with no allowance, so an active session can end up to a minute
  early but never lives past its limit. Today's notes in memory end. An
  erasure or an import clears the rows in its transaction. A later update names the row by the hash of the secret
  the request was admitted with, not by its numeric id, and changes only a row that is still live. So it cannot
  write an address back to an erased actor or a revoked token, or onto another row that an import gave the same
  id (the hazard `uses.ts` describes).
- **The change stream** works across instances. Each write records its change event in the same transaction, and
  `LISTEN`/`NOTIFY` only wakes the instances that hold streams, which then read what was recorded. One table is
  the history; a retention job trims it. Each instance holds one connection for `LISTEN`.
- **Startup work** that assumes it is alone becomes a job or a migration, coordinated across instances: the
  attachment prune (`src/app/start.ts`), the recovery of accepted reports and of disputes, and the recovery of
  hand-offs, which today treats every row in `sending` as interrupted (`handoffs.ts`) and would otherwise
  include a live instance's work.
- **In-process guards** that keep one delivery of a kind running (hand-offs, commit statuses, tracker requests and
  polls) are replaced by job claims, not moved to another timer.

Read snapshots stay consistent, the demo keeps its own times (decision 0100), and tests keep their injected clocks.

### Attachments

Attachments stay behind `BlobStore` (0002 rule 5), whose methods become asynchronous. Local development and CI
keep the disk store. In production a Cloud Storage bucket holds them.

The prune changes first. Today it deletes every hash that no committed row references, and every pending file,
while an upload writes its object before the transaction that references it commits (`attachments.ts`), and an
upload of bytes that already exist reuses the object as it is (`blobs.ts`). With two instances, one instance's
prune could delete the other's upload, even an old object that an upload has just reused. So each object gets a
row keyed by its hash, with the time it was last put. An upload first commits that row, inserting it or moving its
time forward, then writes the object if it is missing. The prune is a job that, for each candidate, locks the row,
checks that no attachment references the hash and that the row's time is older than a bound longer than any upload
transaction can last, deletes the object, then deletes the row. An upload that meets the lock waits, then finds no
row and writes the object again. A pending file is deleted only past the same bound. Tests start a prune during an
upload, and during an upload that reuses an old unreferenced object.

Step 3 first tries mounting the bucket as a Cloud Storage volume, so the disk store runs unchanged. Cloud Storage
FUSE is not fully POSIX and caches file metadata for 60 seconds by default
([Google's mount page](https://docs.cloud.google.com/run/docs/configuring/services/cloud-storage-volume-mounts)),
so the mount turns that cache off. Its checks are an object written on one instance and read at once on another,
two instances writing the same hash at once, an instance stopped between writing a pending file and renaming it
(the disk store publishes by rename), a save's time, and a prune beside an upload. A reader checks every object's
hash, as `blobs.ts` does today. If any check fails, a store that calls Cloud Storage's API replaces the disk store
in production.

Full-text search moves from FTS5 to PostgreSQL's `tsvector` with `ts_rank`, as the stack arena measured (0010).

### Background work

With request-based billing, Cloud Run allocates CPU only while a request is being processed
([Google's runtime contract](https://docs.cloud.google.com/run/docs/container-contract)). Work the server starts
on its own timer cannot count on running. Today that is the minute job in `src/app/start.ts` (expired decisions,
last uses, expired sessions, old sign-in records, tracker requests, hand-offs, defect holds, commit statuses) and
the outgoing mail.

So background work becomes jobs behind one job interface (0002 rule 6):

- A job is a row in PostgreSQL, written in the transaction that makes it necessary.
- A worker claims a job in a committed transaction that records its owner, a claim token and a lease expiry. A
  claim whose lease has expired can be taken again. A job's final write checks the claim token, so an owner whose
  lease ran out cannot finish over its successor. A worker then waits as usual, within the bound above, for its
  project's lock.
- Jobs come in three kinds. A job that only writes the database runs again until it commits. A job whose outside
  effect is safe to repeat, such as setting a GitHub commit status, runs again after a lost claim. A job whose
  outside effect is uncertain once started, such as starting a hand-off, is marked uncertain when its claim is
  lost after the start, as `handoffs.ts` marks an interrupted hand-off failed today, unless the receiver accepts an
  idempotency key. Mail is at least once.
- A job keeps the actor and the time it was accepted with, and never replays a bearer token.
- The job interface has two ways to start work. The in-process runner polls the table and runs jobs; local
  development, CI and the tests use it, as would any host whose CPU runs between requests. On Cloud Run, a job
  runs inside an HTTP request to a second Cloud Run service, the job service, so its CPU is allocated: Cloud Tasks
  sends one request per job, and Cloud Scheduler sends the periodic work once a minute. The job service runs the
  same image, scales to zero, and serves only the job endpoint; the public service refuses that path. A job must
  finish within both its task's dispatch deadline (ten minutes by default, thirty at most) and the service's
  request timeout (five minutes by default), as step 3 sets them; the transaction timeouts above are far shorter. A job whose request was given up
  may still be running, and its claim token keeps its late final write from landing. A test finishes a job after
  its claim was taken again.
- The job service keeps Cloud Run's invoker IAM check on, and only the job service account may invoke it. That is
  allowed under domain-restricted sharing, which forbids only principals outside the organisation such as
  `allUsers`. So Google refuses every other caller before a request reaches the container, and a flood of forged
  tokens costs the app nothing. The app checks the OIDC token again (signature, issuer, audience, account and
  validity) with `jose`, which becomes a runtime dependency (today it is a development one). It holds no shared
  secret.
- A job whose request never arrived is still a row. The next successful periodic run starts every due job that is
  not claimed. Cloud Scheduler retries with backoff and gives no deadline, so the record claims no bound on that
  delay beyond "the next successful run".

### The host

Google Cloud, region `us-west1`, in one organisation on the project's domain. The services are Cloud Run for
the app, Cloud SQL for PostgreSQL, Artifact Registry for images, Cloud Storage for attachments, Cloud Tasks and
Cloud Scheduler for background work, and Secret Manager for the few secrets.

Google-specific services stay in the infrastructure, not in the app. The app speaks plain PostgreSQL over one
connection URL, reads and writes attachments through `BlobStore`, sends traces through OpenTelemetry, and runs
background work through its job interface. With the proposals below in place, app code calls a Google API in one
place, the Cloud Tasks dispatcher behind the job interface. A second appears only if the bucket mount fails its
check (a Cloud Storage store behind `BlobStore`), and a third only if the Auth Proxy sidecar fails its check (a
token for each new database connection). Each is one module chosen by configuration. Leaving Google Cloud means rewriting the Terraform and
choosing the in-process runner and the disk store, not changing the domain code.

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

A `db-f1-micro` instance starts with `max_connections` at 25, the default for its memory class
([Cloud SQL's flags](https://docs.cloud.google.com/sql/docs/postgres/flags)), and Cloud SQL keeps some of them for
itself. Cloud Run's maximum instance count is not a hard cap: it can be exceeded briefly, and during a deploy the
old and new revisions run together ([Google's page](https://docs.cloud.google.com/run/docs/configuring/max-instances-limits)).
So the budget counts both revisions of both services at their maximum, each instance's pool (and, on the public
service, its `LISTEN` connection), the
migration's connection and an operator's session, and leaves headroom under the limit. An instance that cannot
get a connection within a bound answers `busy`, rather than waiting without end. Step 2 makes the pool size a
setting with a small default; step 3 sets the maximum instance count from that sum. The preview instance has its
own budget, shared by every open preview.

### What the organisation enforces

The owner applies the organisation's foundation once, from the owner's private infrastructure notes, because it
holds the organisation and billing account ids. That covers folders, projects, organisation policies, the audit
log sink, the GitHub sign-in pool for Workload Identity Federation, CI's deploy service account and the agents'
read-only one. No organisation id, billing account id or project id is written in this public repository: the
Terraform here reads them from CI's configuration. Four of the organisation's rules shape the design:

- **Domain-restricted sharing.** `allUsers` cannot be granted a role, so a Cloud Run service cannot be made public
  through IAM. The service turns off its invoker IAM check instead (`invoker_iam_disabled` in Terraform,
  [Google's page](https://docs.cloud.google.com/run/docs/authenticating/public#disable)). Google then
  authenticates no request to it, and every path is reachable by anyone who has the address. The app already
  authenticates every request itself. The job service is not public, so it keeps the invoker check.
- **No public IP on Cloud SQL, and no default network in a new project.** Step 3 makes a VPC with one subnet in
  `us-west1` and private services access for Cloud SQL. The app reaches Cloud SQL's private address through
  Direct VPC egress, for private ranges only, so its other outbound requests (GitHub, mail, sign-in providers)
  leave without a NAT gateway.
- **No service-account keys.** CI signs in to Google Cloud through Workload Identity Federation from GitHub
  Actions, with no stored key. Nothing in the app or CI holds a key file.
- **IAM database authentication** follows from the last rule and #821: the app connects as its own service
  account, with no database password. How it does so is a proposal below.

Code from a pull request is untrusted until it is on `main`. A credentialed step that runs a pull request's code,
a preview deploy (#894) or a `terraform plan` signed in to Google Cloud, runs only for a pull request from a
branch of this repository, never a fork, and the plan signs in as the read-only identity. Each preview gets its own
service account and its own PostgreSQL role, owner of its database only, with `CONNECT` on every other database
revoked. A preview's identity has no access to production's network, secrets, bucket, queues or identities, and
its account, role and database are deleted with the preview. #894 builds this and proves it with a preview that
tries to reach another preview's database and production's secrets.

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
commit. It answers from the instance's own state and asks the database at most once every few seconds, one
question at a time, so a flood of public requests to it costs at most one query per interval for each instance.
Cloud Run's startup probe reads it, and traffic moves to the new revision only once it is ready. A
revision that never becomes ready never takes traffic. A rollback moves traffic back to the previous revision.

Migrations run when a new revision starts, under a PostgreSQL advisory lock held on one dedicated connection from
before the migration ledger is read until after it is written, error paths included, so two starting instances do
not run them twice. The wait for that lock fits inside the startup probe's deadline. After the baseline, a
migration adds before it removes: the previous release must still read and write the new schema, and the new
release must accept the previous one's writes. A CI job proves it by running the previous release's smoke checks,
reads and writes, against the new schema. There are no down migrations.

When a revision stops serving, Cloud Run sends SIGTERM and stops the instance ten seconds later. Draining is best
effort. The instance stops taking requests, and a request still running when it stops is cut: its transaction
commits or rolls back whole, and the client retries with the same command id. A job it had claimed is taken again
when its lease expires. Browser and iPhone change streams reconnect to the new revision, as they already do after
an error. #893 closes a hidden page's stream, which also keeps an idle tab from billing the instance as active. A
check sends SIGTERM during a long request.

### The network boundary and client addresses

Cloudflare stays in front of `mainworthy.com`. The client address and scheme come from Cloudflare's headers, as in
0130, and the sign-in limits count by that address. The service accepts unauthenticated requests on every address
Google gives it: the `run.app` address, and a custom domain mapping, which stays reachable when the `run.app`
address is turned off ([Google's ingress page](https://docs.cloud.google.com/run/docs/securing/ingress#disable-url)).
So a request can skip Cloudflare and carry a forged `CF-Connecting-IP`, whatever Cloudflare's DNS says.

The app therefore trusts Cloudflare's headers only for a request that proves it came through Cloudflare, on every
way in. Step 7 chooses how: a secret header that a Cloudflare rule sets, overwriting any the client sent, and that
the app checks, kept in Secret Manager; or a load balancer that admits only Cloudflare. Turning off the `run.app`
address is extra defence, not the proof. In production the public service refuses every request without the
proof, except the startup probe's `/healthz`. A request is never served with
no client address: today the sign-in limits give such a request no address key (`limiter.ts`), so serving it
would let it pass the address limits. The check sends direct requests, with and without a forged header, to the
`run.app` address and to Google's endpoint for the mapped hostname, and sees each refused.

0130's lockdown needs root and network administration inside a network namespace the operator sets up (an nft
table, then a `setpriv` drop), and a loopback origin on the owner's host. On Cloud Run, Google runs the network
and the sandbox, so none of it moves. The container still runs as a non-root user. No outbound deny policy is
claimed on Cloud Run; Direct VPC egress for all traffic, with egress firewall rules and a NAT gateway, could
restore one, and that is its own issue if it is wanted.

### Backups

Cloud SQL's automatic backups and point-in-time recovery cover the database. The attachments bucket keeps object
versions for at least as long as the database's recovery window. Step 6 restores both into a scratch instance and
checks that the copy answers with the same data (#59).

## Proposals for the owner

The owner's decisions are in #821 and the store design was accepted with the Railway record. These are this
record's own proposals, and acceptance covers them:

- **Cloud Scheduler** for the periodic work, the one service added to #821's list. It is free for three jobs a
  billing account, and Mainworthy needs one. A Cloud Tasks task that schedules the next one stops for good when
  one link is lost; CPU that is always allocated costs about $35 a month more (#821).
- **The Cloud SQL Auth Proxy as a sidecar container** for IAM database authentication. It refreshes the
  short-lived tokens and connects over the private address (`--auto-iam-authn --private-ip`), and the app reaches
  it on loopback with a plain URL. The alternative is the app fetching a token for each new connection over TLS,
  which is Google code in the kernel. Step 3 switches to that only if the sidecar fails a measured check (start
  time or memory), and records why.
- **The bucket mounted as a volume first**, with the checks above, before a store that calls Cloud Storage.
- **Last uses written during requests, at most once a minute a row**, instead of notes in memory.
- **Report application stays in its request**; only recovery becomes a job.
- **A temporary single PostgreSQL write lock** in step 2's bottom request, below.
- **A separate pool and an in-memory limit in front of anonymous sign-in work**, and a Cloudflare rate-limiting
  rule on the sign-in paths.
- **A second Cloud Run service for jobs**, with its invoker IAM check on, so only the job service account reaches
  the job endpoint.
- **Production refuses a request without the Cloudflare proof**, apart from the startup probe, rather than serving
  it with no client address. CI's smoke check of a deployed revision sends the
  proof from a GitHub secret.

## Order

The steps are #821's. Each ends in a check that passes before the next starts.

1. This record. The owner accepts it in its pull request, and nothing is built on it before that.
2. The store on PostgreSQL, as a stack of pull requests. Each passes `bun run check` against PostgreSQL in CI and
   keeps the `bench/` budgets.
   - The bottom request moves the engine and nothing else it can avoid. The kernel's database API runs on
     `Bun.sql`; the baseline schema replaces the migrations; every module's SQL is ported and every caller
     awaited; search uses `tsvector`; each test file gets its own database; Compose and CI run PostgreSQL. The
     async conversion and the SQL port land together, because synchronous code cannot call PostgreSQL. To keep
     the concurrency the same, every write operation holds one exclusive session-level advisory lock on its own
     connection for the whole operation, as the write gate in `registry.ts` does today, a report's two
     transactions included, and reads authority after taking it. A transaction-scoped lock would not do: it is
     released at the acceptance commit and would let another writer in between a report's two phases. A session
     lock outlives a rollback and the connection's return to the pool, so the operation rolls back and unlocks in
     `finally` before it returns the connection, closes the connection instead when the unlock cannot be
     confirmed, and fails if the connection is lost while it holds the lock (PostgreSQL then releases it). Tests
     cover a failure in each phase and a connection lost between a report's phases. A committed
     codemod adds the `async` and `await` (a reviewer runs it again and compares), the SQL changes are separate
     commits by module, and a test prepares every declared statement against the baseline. The SQLite-only
     machinery goes in the same request, because nothing can call it afterwards: the upgrade copy, the reader and
     checkpoint threads, the instance lock and the database-file checks (#659).
   - The next request replaces the single lock with the project and actor locks, their lock order and `busy`. It
     is the request that lets another writer in between a report's two phases, as the design above intends, so
     it also adds the check of the credential and `auth_version` before application. A test holds a report
     between its phases while another write to the same project commits, and another revokes the caller there.
   - Then the state shared by every instance (sign-in counts, ceremonies, last uses, the change stream), the
     prune and the other startup work, and background work as jobs with the in-process runner and the job
     endpoint.
   - Then the two-instance checks: a crash, a replayed command, a revocation, a sign-in, a ceremony finished on
     the other instance, an idle session, an erasure, an upload beside a prune and a stream reconnect, each with
     two servers on one database.
   - The last request measures the timeouts and looks for requests that make many small queries, since each query
     is now a round trip.
3. The app's Google Cloud infrastructure in Terraform, in this repository, applied by CI inside the Mainworthy
   projects only: Artifact Registry, both Cloud SQL instances, the bucket, the job service, the Cloud Tasks queue,
   the Cloud Scheduler job, Secret Manager, the VPC, its subnet and private services access. The Cloud Tasks dispatcher
   lands here, where a real queue can check it. Check: `terraform plan` in CI shows no change after the first
   apply, and the read-only identity cannot change anything.
4. Build once in CI and push to Artifact Registry. Check: `/healthz` reports the commit of the deployed image.
5. Deploys triggered by CI. Check: a deploy under a continuous request loop fails no request, a rollback works,
   and the time from push to `/healthz` naming the commit, over several deploys with its spread.
6. Backups and a restore drill (#59).
7. The cutover: `mainworthy.com` points at Cloud Run, with the client-address proof above. Until the first write
   to the new instance, undoing it means pointing Cloudflare back at the owner's server. Check: public
   `/healthz` names the deployed commit, and the iPhone app's TestFlight job still uploads.

Steps 3 to 7 wait for the organisation's foundation.

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

- The host is Google Cloud, not Railway, with the organisation's rules above. Images go to Artifact Registry, not
  public GHCR. CI signs in through Workload Identity Federation, not with a Railway token.
- Failed sign-in counts move to PostgreSQL in step 2 instead of being deferred, because a Cloud Run service can
  have several instances whenever its scaling allows it.
- The ceremonies that move to PostgreSQL include TOTP and email links, which the Railway record did not name.
- Last uses are written during requests at most once a minute a row. The Railway record moved the notes to
  PostgreSQL without saying when they are written.
- Background work runs as jobs with leases, started by HTTP requests (Cloud Tasks, Cloud Scheduler) in
  production, because request-based billing allocates no CPU between requests. The Railway record had a pool of
  workers in the process.
- Reports are applied inside their request, as today; the Railway record left that open.
- Attachments go to a Cloud Storage bucket in production, not into PostgreSQL, and the prune becomes an
  age-bounded job.
- Step 2 is a stack that runs on PostgreSQL throughout, with a temporary single write lock at the bottom, not
  async slices on SQLite landing on `main`. Only the first of those slices landed
  ([#846](https://github.com/endqwerty/mainworthy/pull/846)).
- Backups are Cloud SQL's own, not `pg_dump` to Cloudflare R2.

The rest of the store design is unchanged: one PostgreSQL, the project and actor locks, the two phases of a
report, coordinated startup work, the empty start, one baseline, and add-before-remove migrations.

## Consequences

- Each query is a round trip to another machine instead of a call into the process. A request that makes many
  small queries gets slower in proportion; step 2's last request finds them, and `bench/` holds the budgets.
- A `db-f1-micro` has a shared CPU, 0.6 GiB of memory, no SLA and few connections. It is enough for an instance
  with no outside users, and it is the first thing to change when they arrive.
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
first fallback if the job service proves fragile.

**Async slices on SQLite first**, the Railway record's plan, give smaller pull requests before the engine moves,
but each needs temporary transaction helpers that the move throws away, and none of them runs on PostgreSQL.

**The project and actor locks in the bottom request** would save one request, but would put a change of
concurrency into the same review as the engine port. The temporary single lock, held for the whole operation like
today's gate, keeps the bottom request's behaviour equal to today's, so its check compares like with like.

Principles: Separate Before Serializing Shared State (locks cover only the project and actor invariants, so
unrelated projects and actors stay independent); Boundary Discipline (Google services stay in the
infrastructure, behind the store URL, `BlobStore` and the job interface); Make Operations Idempotent (a job is a
row with a lease, so a lost task delays work and a stale owner cannot finish over its successor); Outcome-Oriented
Execution (the stack goes straight to PostgreSQL instead of keeping temporary SQLite compatibility).
