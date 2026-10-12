# 0002: Self-hostable in layers

- Date: 2026-10-10
- Status: accepted (requirement set by Daniel). Amended 2026-10-12: a container is
  acceptable for every layer (decision 0009, answer 14), and the Server layer runs
  on SQLite; a server database is added for the Cloud layer (decision 0010).

## Decision

Casebook runs in three deployment layers from one codebase. A user picks the
layer that fits them; the product behaves the same in every layer.

| Layer | Who | Shape | Storage |
| --- | --- | --- | --- |
| **Local** | one person, a laptop | one process, zero configuration, starts in seconds, needs no network for its own features | embedded database and local files |
| **Server** | a team, a home server or small VPS | one container or binary plus a database | server database, local or object storage for attachments |
| **Cloud** | one organisation with many teams or heavy CI load | several API instances behind a load balancer, optional cache, background workers | server database, object storage, optional cache (for example Redis-compatible) |

Cloud means one organisation scaled out, not isolated tenants. Multi-tenant
hosting for unrelated customers is a non-goal (product vision) and would need
its own decision.

## Rules

1. **Correctness never depends on a cache.** Every cache is an optional
   accelerator with a fallback to the database. Turning it off changes
   latency, never behaviour. Invalidation follows writes through the single
   operation layer (product vision, "Backend").
2. **One operation layer, one feature set.** No feature exists only in a
   layer. Data semantics, authorisation and the MCP server, API and UI are
   identical in all three. Integrations that need the outside world (CI
   status callbacks, tracker links) work in Local only when it can reach
   those services; that is a prerequisite, not a feature difference.
   Offline browser editing with later synchronisation is a separate question
   (open question 9, answered in decision 0004: online-first, no sync promised).
3. **Layer is configuration, not a fork.** The same build reads its layer from
   configuration (database URL, cache URL, storage location). Moving up a
   layer is export plus import, preserving identities, versions, history,
   links and attachments, or pointing the server at the same database.
   Export and import are therefore part of the first usable version, not an
   extra.
4. **Local is the first layer built**, because it is the simplest surface for
   the UX research prototypes and for benchmarks, and because it forces the
   zero-configuration start. Server and Cloud are proven by running the same
   artifact against the server database before the first usable version.
5. **Attachments are behind a storage interface** from day one (local disk
   first, object storage later), so the Cloud layer does not need a rewrite.
6. **Background work** (flaky detection, report aggregation, ingest parsing)
   runs in-process in Local and Server, and may move to separate workers in
   Cloud. Jobs are persisted and crash-safe, retried idempotently, and
   coordinated across instances in Cloud. The job interface must allow both
   placements.
7. **Local is still secured.** Local binds to loopback by default, protects
   browser requests against cross-site calls, and gives local agents an
   identity and a token like any other layer, so history still says who did
   what. Exposing Local on a network is an explicit opt-in that requires
   authentication to be set up.
8. **Upgrades, backups and restore are designed in.** Schema migrations are
   versioned and run on start in every layer, with a tested path back when
   an upgrade fails. A backup is the database plus attachments taken
   consistently, and restore is checked, not assumed. These are part of the
   check command once the stack exists.

## Consequences for the stack decision (0001)

These are requirements for the benchmark to test, not a stack choice.

- The data store must work embedded for Local and as a server database for
  Server and Cloud. The working hypothesis is one schema and one query layer:
  either one engine that does both, or two engines behind an abstraction.
  The benchmark judges this on transactional semantics, concurrent writes,
  search and portability as well as latency, and runs in both modes.
- The runtime should ship as one self-contained artifact with no build step
  for the user. A native single binary is the hypothesis for Local, because a
  container does not prove a five-minute install on a machine without a
  container runtime (open question 14).
- Any cache layer is chosen only after the benchmark shows the database alone
  misses a budget. When one is added, its invalidation across instances and
  its respect for authorisation are tested, not assumed.

## Alternatives rejected

- **Cloud-only with a local dev mode.** Fails the requirement that a person
  can run it on their own machine as a real deployment.
- **Separate local and cloud products.** Two feature sets would drift and
  double the test surface; it contradicts the one-operation-layer principle.
