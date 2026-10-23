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
listener, runs migration in a worker and replaces that listener's routes after normal startup recovery.
The worker closes its connection before normal startup opens one. Because Bun workers cannot set umask,
the startup thread holds 077 until the worker has ended; nested holders restore the previous mask only
when the last holder releases it.

During migration, health is HTTP 200 with `ok: false, state: "upgrading"` and build identity. Every other
request gets 503 with an upgrading error and retry delay. Ready health retains `ok: true`. Docker's health
command treats upgrading as live, which allows Compose to start ingress. Deployment readiness still
requires `ok: true` and the pinned commit. HTTP 503 health with a long Docker start period was rejected:
the ingress would remain absent during the very state deployment tools need to inspect.

A worker error closes the listener and fails startup. A stalled worker has a 30-minute deadline; the
listener closes before termination is awaited, and the instance lock is released only after the worker
has ended. Interrupted copies are reconciled by the existing next-successful-upgrade cleanup. Signals
abort startup through the same cleanup path. The external autodeploy window must cover this state;
that scheduler is outside this repository and is not changed here.

## Checks and scope

The regression holds a real SQLite write lock after the pre-upgrade copy is published, checks live health,
CLI liveness and refusal of application requests, then releases the lock and checks readiness on the
same port. Failure and deadline checks require the listener to close and the instance lock to be reusable.
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
