import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/** A separate SQLite file supplies a process lock that the OS releases even after a killed server. Never unlink it. */
export function lockInstance(dataDir: string): () => void {
	const seconds = Number(process.env.MAINWORTHY_LOCK_WAIT_SECONDS?.trim() || "30");
	if (!Number.isFinite(seconds * 1000) || seconds < 0) {
		throw new Error("MAINWORTHY_LOCK_WAIT_SECONDS must be a finite nonnegative number of seconds");
	}
	const deadline = performance.now() + seconds * 1000;
	mkdirSync(dataDir, { recursive: true, mode: 0o700 });
	const lock = new Database(join(dataDir, "server.lock"), { create: true, strict: true });
	try {
		lock.exec("PRAGMA busy_timeout = 0");
		let waiting = false;
		for (;;) {
			try {
				lock.exec("BEGIN EXCLUSIVE");
				break;
			} catch (error) {
				if (
					!(
						error instanceof Error &&
						"code" in error &&
						(error.code === "SQLITE_BUSY" || error.code === "SQLITE_LOCKED")
					)
				) {
					throw error;
				}
				const remaining = deadline - performance.now();
				if (remaining <= 0) {
					throw new Error(
						"another server is already using this data directory; stop it or choose another MAINWORTHY_DATA",
					);
				}
				if (!waiting) {
					console.error("[mainworthy] waiting for another server on the data directory");
					waiting = true;
				}
				Bun.sleepSync(Math.min(25, remaining));
			}
		}
	} catch (error) {
		lock.close();
		throw error;
	}
	let closed = false;
	return () => {
		if (closed) return;
		closed = true;
		lock.close();
	};
}
