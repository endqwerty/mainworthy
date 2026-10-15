# 0031: Bound instance resources and admit one server per data directory

- Date: 2026-10-14
- Status: proposed, implementation for issue #67.

## Problem

Reader configuration accepted any nonnegative safe integer. Failed reader starts retried every 100 ms, and callers waiting for the full pool could wait forever. Archives occupied the system temporary filesystem, which can be memory. Two servers could open one data directory. With reader threads enabled, the writer uses a 20,000-page automatic checkpoint fallback while a background thread performs passive checkpoints. Active read snapshots can hold older pages and grow the log.

## Usage and ownership

`start(config, extra)` takes a directory lock before `open()` touches the application database. `Instance.stop()` drains requests and workers, closes the application, then releases the lock. An unsuccessful start releases it too. Direct offline commands and read workers do not acquire this server lock.

`Readers` validates its count through `readerCount`, keeps a failure count per replacement chain, and resets it when that worker reports readiness. `ready(timeoutMs = 5000): Promise<void>` rejects at its deadline. Reads go to ready workers, or use the caller's existing inline fallback. HTTP startup still does not await readiness.

The archive routes use `spool/` under `app.config.dataDir`. `Db` owns the 4 MiB journal retention setting. `start()` still calls `deferCheckpoints()` when reader threads are enabled, keeping the 20,000-page automatic checkpoint fallback. The checkpoint worker continues to perform passive checkpoints every 500 ms.

## Synthesis decision

Keep lifecycle policy inside the modules that already own it. A small `lockInstance(dataDir): () => void` function in the kernel hides lock acquisition, error translation and idempotent release. On contention it polls every 25 ms until `MAINWORTHY_LOCK_WAIT_SECONDS`, 30 seconds by default, and reports the wait once on stderr. It holds an exclusive transaction on a separate SQLite file, `server.lock`. It never writes application rows and never unlinks the lock file. SQLite's operating-system locks release when a process dies, so an existing file is safe to reuse after a crash.

The other design used a PID file, startup polling and a stale-file recovery protocol. That needs process identity, races between readers and removers, and rules for a crash between creating and filling the file. The SQLite lock has a smaller interface and uses the dependency already required by the server. Native file locking through FFI would add platform-specific library loading without improving that interface.

## Tradeoffs

- The instance uses Coolify's Docker Compose deployment, one application service and its data volume, as described in [deployment](../deploy.md) and `compose.coolify.yaml`. [Coolify's rolling-update documentation](https://coolify.io/docs/applications/deployments/rolling-updates) says Compose deployments use `docker compose up`, not its health-gated rolling replacement path. [Docker's Compose documentation](https://docs.docker.com/reference/cli/docker/compose/up/) says changed containers stop and are recreated with their volumes preserved. These sources indicate stop-before-replacement for this deployment, not overlapping healthy servers. No live redeploy was measured for this decision. The bounded wait still accommodates a lock held briefly by a stopping process. It cannot make a health-first deployment succeed if that deployment refuses to stop the old server until the new one is healthy. Such a deployment must stop the old server first.
- Eight is both the existing default ceiling and the configured maximum. Larger values now fail startup instead of allocating more workers.
- Retry delays double from 100 ms to a 30-second maximum. The cap limits repeated startup errors without permanently disabling recovery.
- A readiness timeout rejects its caller; it does not stop replacement attempts. Unready workers cannot hold reads in their input queues.
- Checkpoint timing stays as it was. Measurements on a loaded machine could not establish that lowering the reader-thread fallback from 20,000 to 1,000 pages preserves write latency, so that change is deferred. `journal_size_limit = 4194304` trims the file to at most 4 MiB when a write reuses the log after a completed checkpoint. Active snapshots and large transactions can still grow the log beyond that retention limit. See [SQLite's WAL documentation](https://www.sqlite.org/wal.html) and [journal_size_limit](https://www.sqlite.org/pragma.html#pragma_journal_size_limit).
- Spooling consumes space on the data filesystem, one whole archive per transfer. A process killed during a transfer can leave a private temporary directory; it can be removed while the server is stopped.
- A hard disk quota would require a separate policy for refusing writes or ending readers and is outside this change. No hard quota is claimed.

## Checks

Regressions cover configured counts, retry delays and the cap, bounded readiness after replacement startup failures, inline reads during startup, WAL growth under overlapping snapshots and trimming after readers finish, checkpoint and log reuse, import and export spooling and cleanup, duplicate servers through path aliases and separate processes, timed refusal while the owner stays running, lock handoff from a draining server, failed startup, and restart after SIGKILL.
