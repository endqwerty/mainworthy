# 0144: Upgrades answer health before copying

- Date: 2026-10-22
- Status: accepted

## Problem

An upgrade made its rollback copy before binding HTTP. Docker could mark the app unhealthy and Compose
could abandon its dependent ingress even though migration later succeeded ([issue #695](https://github.com/endqwerty/mainworthy/issues/695)).

## Decision

Keep SQLite's consistent `VACUUM INTO` snapshot and the private, marked workspace from decision 0120.
For the copy alone, temporarily set the source connection's synchronous mode to OFF. SQLite applies that
setting to the output pager. Restore it before any migration writes. The existing publication helper
syncs the completed file once, renames it atomically and syncs the containing directory. No live database
journal mode changes. Completed-copy retention and exact interrupted-workspace cleanup remain unchanged.
The alternative backup API is not exposed by `bun:sqlite`; serializing the database would allocate its
whole size. Neither is needed to remove intermediate output syncs.

Production startup holds the instance lock from before migration until shutdown. It starts one HTTP
listener, runs migration, bootstrap and recovery in a worker, and replaces that listener's routes after
the worker closes its connections. Configuration that can be checked without data, including the reader
count and port, is validated before taking the instance lock or starting that worker. Because Bun workers cannot set umask,
the startup thread holds 077 until the worker has ended; nested holders restore the previous mask only
when the last holder releases it.

During migration, health is HTTP 200 with `ok: false, state: "upgrading"` and build identity. Every other
request gets 503 with an upgrading error and retry delay. Ready health retains `ok: true`. Docker's health
command treats upgrading as live, which allows Compose to start ingress. Deployment readiness still
requires `ok: true` and the pinned commit. HTTP 503 health with a long Docker start period was rejected:
the ingress would remain absent during the very state deployment tools need to inspect.

A worker error closes the listener and fails startup. The watchdog targets **30 minutes without observable
startup progress**, not 30 minutes since startup. Each change in size or modification time of the live database,
its WAL or a file in this attempt's copy workspace resets it. Worker messages at recovery phase boundaries
and bounded assertion-rebuild pages also reset it. A copy that keeps writing can run longer than 30 minutes.
The test-only `startupIdleMs` option changes this inactivity allowance, not a wall-clock budget. Merely
answering health on the parent thread does not count as worker progress.

Before spawning the worker, the parent creates a private `<database>.mainworthy-start-<six-character suffix>`
workspace and lends it to the copy helper. On every handled startup failure, including error, cancellation
and inactivity, the listener closes, the worker is terminated and awaited, and that exact owned workspace is
removed. No directory-difference scan decides ownership. A completed, synced and published `.v<N>.bak` stays
and the next start reuses it. The instance lock is released only after the worker has ended. A whole-process
crash cannot run this cleanup; the next successful upgrade removes only exact copy and journal regular files
inside marked startup workspaces, then removes those workspaces only if empty, as it does for older copy
workspaces. Symlinks and unrelated contents stay.

Assertion reconstruction and accepted-report recovery have no fixed bound: they depend on all stored
observations and pending batches. Attachment pruning, bootstrap and all recovery therefore run in the worker,
where a long native statement cannot block health. The parent then opens its serving connections at an already
current schema and installs routes; it performs no evidence scan or recovery replay. The worker sends the
generated token and warnings back once, so bootstrap is not repeated. Proxy matchers cross that worker boundary
as their original validated range text and are reconstructed there. The early listener is created with the
caller's idle timeout because Bun's route reload does not update it.

The external autodeploy has a separate total deployment budget. It must keep the pinned attempt in flight
through upgrading, rather than treating the application's inactivity watchdog as a total duration guarantee.
That scheduler is outside this repository.

## Checks and scope

The regression holds a real SQLite write lock after the pre-upgrade copy is published, checks live health,
CLI liveness and refusal of application requests, then releases the lock and checks readiness on the
same port. Failure and inactivity checks require the listener to close, the owned workspace to disappear and
the instance lock to be reusable. A progressing-copy fixture writes actual bytes beyond its inactivity
allowance; a stalled fixture is stopped. A restart retains the inode and bytes of an already published copy.
Configuration tests compare the original old database bytes and its directory before and after refusal. A
native blocking barrier inside assertion recovery proves health keeps answering and application routes return 503.
Existing upgrade-copy, private-file, rollback and crash-cleanup checks continue to apply.

The benchmark alternates the old and new durable-copy paths and the complete HTTP-ready startup path
on generated data. It checks every payload byte and SQLite integrity outside the timer. It is a Mac,
warm-cache comparison, not a prediction for production's disk. There is no demo addition because startup
availability is outside a project's recorded workflow. The implementation stays in one workstream because
the listener, worker lifetime and copy privacy share one startup sequence.

Principles: Fix Root Causes (serve health while migration runs, rather than extending Docker's blind delay);
Model the Domain (upgrading is live but not ready, represented by a distinct health reply);
Type System Discipline (the listener cannot reach an App before startup has built it);
Test Behavior, Not Implementation (hold a real writer and check HTTP and CLI results);
Explain the Number (alternate revisions, verify the entire copy and report noisy results without a speed claim).
