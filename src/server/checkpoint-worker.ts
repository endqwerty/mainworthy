// Copies committed pages from the write-ahead log into the database file, so the writer's commits do not
// have to. Keep this entry independent of the read and archive workers' application and schema imports.
import { parentPort, workerData } from "node:worker_threads";
import { Db, databasePath } from "./kernel/db.ts";

if (!parentPort) throw new Error("a worker needs its parent thread");
const port = parentPort;
const data: unknown = workerData;
if (!data || typeof data !== "object" || !("dataDir" in data) || typeof data.dataDir !== "string")
	throw new Error("a checkpoint worker needs its data directory");
checkpoints(data.dataDir);

function checkpoints(dataDir: string): void {
	// An ordinary connection that never writes a row. A passive checkpoint makes nobody wait: it copies what no
	// reader still needs and leaves the rest for the next round.
	const db = new Db(databasePath(dataDir));
	const timer = setInterval(() => {
		try {
			db.checkpoint();
		} catch (error) {
			console.error("[mainworthy] checkpoint failed:", error);
		}
	}, 500);
	process.once("exit", () => {
		clearInterval(timer);
		db.close();
	});
	port.postMessage("ready");
}
