# 0034: Archives run off the HTTP thread

- Date: 2026-10-14
- Status: accepted

Export and import walked every archive row synchronously on the HTTP thread. An export took a consistent
snapshot and an invalid import rolled back correctly, but neither let another request run while it worked
(issue #65).

## Decision

Each HTTP transfer starts a worker using the existing bundled worker entrypoint. An export uses its own
read-only connection and writes the snapshot to a private spool. The HTTP thread streams that spool with
backpressure and removes it when the reader finishes or cancels. It checks permission again before sending
the response, so a token revoked while the worker ran receives no archive.

An import stages its body before entering the existing write gate. Permission is checked again at the gate.
The worker removes bootstrap rows, imports the archive and refreshes the local owner in one transaction.
Invalid input rolls back that whole transaction. The worker also recovers accepted reports before returning,
so recovery cannot move a large synchronous write back onto the HTTP thread. The parent clears authentication
caches, refreshes its captured local owner and publishes the recovered reports' change events before releasing
the write gate. Reads use committed data while writes wait at the gate.

The worker closes its connections before returning its result. The caller waits for the worker to exit on
success and failure. A worker that fails returns a failure; it never repeats archive work on the HTTP thread.
The synchronous archive functions and archive format are unchanged.

## Turned down

- Slicing the transfer on the HTTP thread would require asynchronous transaction and snapshot lifetimes across
  the synchronous archive implementation. A shared reader connection could not safely hold a snapshot across
  those pauses. A worker keeps those lifetimes local and preserves the existing validation and rollback code.
- Sending archive chunks through worker messages would need another backpressure protocol. The existing disk
  spool bounds memory without holding a snapshot open for a slow download.
- Reusing a query reader would make reads behind a large export wait. An archive worker leaves the query
  readers available, even on an instance configured with one reader or with the reader pool disabled.

A transfer pays for starting a worker. Archives are infrequent, and keeping the HTTP thread available takes
priority over that startup cost. Concurrent exports each have a worker and a spool; imports remain serial.
