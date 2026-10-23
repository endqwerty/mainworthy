// Deterministic disk progress and native blocking in the same worker contract as production startup.
import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import type { prepareStartup, StartupData } from "../src/app/start.ts";

if (!parentPort) throw new Error("the startup fixture needs its parent");
const port = parentPort;
const data: StartupData & {
	mode: "progress" | "failure" | "stall" | "recovery" | "published-stall";
	pause?: SharedArrayBuffer;
	prepared?: ReturnType<typeof prepareStartup>;
} = workerData;
const file = join(data.workspace, "mainworthy.db.v1.bak");
if (data.mode === "progress") {
	for (let step = 0; step < 24; step++) {
		appendFileSync(file, Buffer.alloc(4096));
		await Bun.sleep(50);
	}
	rmSync(file);
	const { Db, databasePath } = await import("../src/server/kernel/db.ts");
	const { SCHEMA_VERSION } = await import("../src/server/kernel/migrate.ts");
	const path = databasePath(data.config.dataDir);
	const db = new Db(path);
	try {
		db.copyTo(`${path}.v${SCHEMA_VERSION}.bak`, data.workspace);
	} finally {
		db.close();
	}
	if (!data.prepared) throw new Error("a progressing-copy fixture needs its prepared instance");
	port.postMessage({ kind: "prepared", prepared: data.prepared });
} else if (data.mode === "failure" || data.mode === "stall") {
	writeFileSync(file, "partial copy");
	if (data.mode === "failure") throw new Error("injected startup failure");
	await new Promise(() => setInterval(() => {}, 1000));
}

if (data.mode === "published-stall") {
	const { Db, databasePath } = await import("../src/server/kernel/db.ts");
	const path = databasePath(data.config.dataDir);
	const db = new Db(path);
	try {
		db.copyTo(`${path}.v1.bak`, data.workspace);
	} finally {
		db.close();
	}
	port.postMessage({ kind: "progress" });
	await new Promise(() => setInterval(() => {}, 1000));
}

if (data.mode !== "progress") {
	const { prepareStartup, startupConfig } = await import("../src/app/start.ts");
	let paused = false;
	const prepared = await prepareStartup(startupConfig(data), { copyWorkspace: data.workspace }, (phase) => {
		port.postMessage({ kind: "progress" });
		if (data.mode === "recovery" && phase === "assertions" && !paused && data.pause) {
			paused = true;
			Atomics.store(new Int32Array(data.pause), 0, 1);
			Atomics.notify(new Int32Array(data.pause), 0);
			Atomics.wait(new Int32Array(data.pause), 0, 1);
		}
	});
	port.postMessage({ kind: "prepared", prepared });
}
