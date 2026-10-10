# 0002: Self-hostable in layers

- Date: 2026-10-10
- Status: accepted (requirement set by Daniel)

## Decision

Casebook runs in three deployment layers from one codebase. A user picks the
layer that fits them; the product behaves the same in every layer.

| Layer | Who | Shape | Storage |
| --- | --- | --- | --- |
| **Local** | one person, a laptop | one process, zero configuration, starts in seconds, works offline | embedded database and local files |
| **Server** | a team, a home server or small VPS | one container or binary plus a database | server database, local or object storage for attachments |
| **Cloud** | many teams or heavy CI load | several API instances behind a load balancer, optional cache, background workers | server database, object storage, optional cache (for example Redis-compatible) |

## Rules

1. **Correctness never depends on a cache.** Every cache is an optional
   accelerator with a fallback to the database. Turning it off changes
   latency, never behaviour. Invalidation follows writes through the single
   operation layer (product vision, "Backend").
2. **One operation layer, one feature set.** No feature exists only in a
   layer. The MCP server, API and UI are identical in all three.
3. **Layer is configuration, not a fork.** The same build reads its layer from
   configuration (database URL, cache URL, storage location). Moving up a
   layer is export plus import, or point the server at the same database.
4. **Local is the first layer built**, because it is the simplest surface for
   the UX research prototypes and for benchmarks, and because it forces the
   zero-configuration start. Server and Cloud are proven by running the same
   artifact against the server database before the first usable version.
5. **Attachments are behind a storage interface** from day one (local disk
   first, object storage later), so the Cloud layer does not need a rewrite.
6. **Background work** (flaky detection, report aggregation, ingest parsing)
   runs in-process in Local and Server, and may move to separate workers in
   Cloud. The job interface must allow both.

## Consequences for the stack decision (0001)

- The data store must work embedded for Local and as a server database for
  Server and Cloud, with one schema and one query layer. Either one engine
  that does both, or two engines behind an abstraction that the benchmark
  proves does not cost the latency budgets. The benchmark runs in both modes.
- The runtime must ship as one self-contained artifact (single binary or one
  container image) with no external build step for the user.
- Any cache layer is chosen only after the benchmark shows the database alone
  misses a budget. Do not add one speculatively.

## Alternatives rejected

- **Cloud-only with a local dev mode.** Fails the requirement that a person
  can run it on their own machine as a real deployment.
- **Separate local and cloud products.** Two feature sets would drift and
  double the test surface; it contradicts the one-operation-layer principle.
