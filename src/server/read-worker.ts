// A worker thread of the server.
//
// `read` (the default): answers read operations on its own read-only connection, so a read never waits for the
// thread that writes. It is handed a call only after the main thread has decided the caller may make it.
//
// `checkpoint`: copies committed pages from the write-ahead log into the database file, so that no commit on the
// main thread has to. SQLite otherwise checkpoints inside the commit that fills the log, and the server answers
// nobody while it does.
//
// `archive`: exports a read snapshot or restores an archive under the parent's write gate, on its own connection.
import { parentPort, workerData } from "node:worker_threads";
import { z } from "zod";
import { type ArchiveReply, ArchiveTask } from "./archives.ts";
import { databasePath, openApp } from "./kernel/app.ts";
import { Db } from "./kernel/db.ts";
import type { Reply } from "./ops/registry.ts";

const data = z
	.discriminatedUnion("role", [
		z.object({ dataDir: z.string(), role: z.literal("archive"), task: ArchiveTask }),
		z.object({ dataDir: z.string(), role: z.literal("read") }),
		z.object({ dataDir: z.string(), role: z.literal("checkpoint") }),
	])
	.parse({ role: "read", ...workerData });
if (!parentPort) throw new Error("a worker needs its parent thread");
const port = parentPort;

if (data.role === "archive") await archive(data.task);
else if (data.role === "checkpoint") checkpoints();
else await reads();

async function archive(task: z.infer<typeof ArchiveTask>): Promise<void> {
	const [
		{ exportArchive, importArchive, removeBootstrap },
		{ fileLines, writeBytes },
		{ closeSync, openSync },
		{ OpError },
	] = await Promise.all([
		import("./transfer/transfer.ts"),
		import("./transfer/spool.ts"),
		import("node:fs"),
		import("./kernel/errors.ts"),
	]);
	let app: ReturnType<typeof openApp> | undefined;
	let reply: z.infer<typeof ArchiveReply>;
	try {
		if (task.op === "export") {
			const db = new Db(databasePath(data.dataDir), { reader: true });
			try {
				const fd = openSync(task.path, "w", 0o600);
				try {
					const encoder = new TextEncoder();
					const counts = exportArchive(db, (chunk) => writeBytes(fd, encoder.encode(chunk)), {
						now: task.now,
						...(task.project === undefined ? {} : { project: task.project }),
					});
					reply = { ok: true, counts, owner: null, events: [] };
				} finally {
					closeSync(fd);
				}
			} finally {
				db.close();
			}
		} else {
			const { defaultConfig } = await import("./kernel/app.ts");
			const { bootstrap } = await import("./identity/identity.ts");
			const { recoverAccepted } = await import("./jobs.ts");
			const now = task.now;
			app = openApp(
				defaultConfig({
					MAINWORTHY_DATA: data.dataDir,
					MAINWORTHY_OWNER: task.owner,
					MAINWORTHY_MODE: task.mode,
					MAINWORTHY_OWNER_TOKEN: task.ownerToken ?? undefined,
					MAINWORTHY_OWNER_WAS: task.ownerWas,
				}),
				now === undefined ? {} : { now: () => now },
			);
			const target = app;
			const restored = target.db.savepoint(() => {
				removeBootstrap(target.db);
				const counts = importArchive(target.db, fileLines(task.path));
				return { counts, owner: task.mode === "local" ? bootstrap(target).owner : null };
			});
			const events: Extract<z.infer<typeof ArchiveReply>, { ok: true }>["events"] = [];
			target.subscribe((event) => events.push(event));
			recoverAccepted(target);
			reply = {
				ok: true,
				...restored,
				owner: restored.owner ? { ...restored.owner, can: [...restored.owner.can] } : null,
				events,
			};
		}
	} catch (error) {
		const known = error instanceof OpError ? error : new OpError("internal", "archive transfer failed");
		reply = { ok: false, error: { code: known.code, message: known.message } };
	} finally {
		app?.close();
	}
	port.postMessage(reply);
}

function checkpoints(): void {
	// An ordinary connection that never writes a row. A passive checkpoint makes nobody wait: it copies what no
	// reader still needs and leaves the rest for the next round.
	const db = new Db(databasePath(data.dataDir));
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

async function reads(): Promise<void> {
	// Loaded here and not at the top: the checkpoint thread reads no operation and has no use for them, and the
	// registry is most of what a thread costs to start (about 100 ms of CPU).
	const [{ ActorKind, Capability }, { OPS }, { invoke }] = await Promise.all([
		import("../core/kinds.ts"),
		import("./ops/index.ts"),
		import("./ops/registry.ts"),
	]);
	const config = {
		dataDir: data.dataDir,
		host: "127.0.0.1",
		port: 0,
		mode: "server",
		owner: "",
		ownerToken: null,
		commit: null,
		// A reader admits nobody: the main thread decides who may read, before the call and again before the reply
		// leaves (`invokeAsync`). Zero, so that a reader which ever did look at a session would find it ended.
		sessionIdleMs: 0,
		sessionMaxMs: 0,
		// Nor does it ask where a request came from: no request reaches a reader.
		proxy: null,
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
