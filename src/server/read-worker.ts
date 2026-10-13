// A worker thread of the server, in one of two roles.
//
// `read` (the default): answers read operations on its own read-only connection, so a read never waits for the
// thread that writes. It is handed a call only after the main thread has decided the caller may make it.
//
// `checkpoint`: copies committed pages from the write-ahead log into the database file, so that no commit on the
// main thread has to. SQLite otherwise checkpoints inside the commit that fills the log, and the server answers
// nobody while it does.
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { z } from "zod";
import { ActorKind, Capability } from "../core/kinds.ts";
import { openApp } from "./kernel/app.ts";
import { Db } from "./kernel/db.ts";
import { OPS } from "./ops/index.ts";
import { invoke, type Reply } from "./ops/registry.ts";

const data = z.object({ dataDir: z.string(), role: z.enum(["read", "checkpoint"]).default("read") }).parse(workerData);
if (!parentPort) throw new Error("a worker needs its parent thread");
const port = parentPort;

if (data.role === "checkpoint") checkpoints();
else reads();

function checkpoints(): void {
	// An ordinary connection that never writes a row. A passive checkpoint makes nobody wait: it copies what no
	// reader still needs and leaves the rest for the next round.
	const db = new Db(join(data.dataDir, "mainworthy.db"));
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

function reads(): void {
	const config = {
		dataDir: data.dataDir,
		host: "127.0.0.1",
		port: 0,
		mode: "server",
		owner: "",
		ownerToken: null,
	} as const;
	let app = openApp(config, { reader: true });
	const ReadMessage = z.object({
		type: z.literal("read"),
		id: z.number().int(),
		op: z.string(),
		project: z.string().nullable(),
		input: z.unknown(),
		actor: z.object({ id: z.number().int(), kind: ActorKind, name: z.string(), can: z.array(Capability) }).nullable(),
	});
	const Message = z.discriminatedUnion("type", [ReadMessage, z.object({ type: z.literal("refresh") })]);

	process.once("exit", () => app.close());
	port.on("message", (message: unknown) => {
		const call = Message.parse(message);
		if (call.type === "refresh") {
			app.close();
			app = openApp(config, { reader: true });
			return;
		}
		const reply: Reply =
			OPS[call.op]?.effect === "write"
				? { ok: false, error: { code: "forbidden", message: "reader threads cannot write" } }
				: invoke(app, OPS, { ...call, actor: () => call.actor });
		port.postMessage({ type: "reply", id: call.id, reply });
	});
	port.postMessage("ready");
}
