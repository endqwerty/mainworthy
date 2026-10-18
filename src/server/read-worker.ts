// A worker thread of the server.
//
// `read` (the default): answers read operations on its own read-only connection, so a read never waits for the
// thread that writes. It resolves the credential and grants inside the snapshot that answers the call.
//
// `archive`: exports a read snapshot or restores an archive under the parent's write gate, on its own connection.
import { parentPort, workerData } from "node:worker_threads";
import { z } from "zod";
import { type ArchiveReply, ArchiveTask } from "./archives.ts";
import { openApp } from "./kernel/app.ts";
import { diskBlobs } from "./kernel/blobs.ts";
import { CallerReference } from "./kernel/caller.ts";
import { Db, databasePath } from "./kernel/db.ts";
import type { Reply } from "./ops/registry.ts";

const data = z
	.discriminatedUnion("role", [
		z.object({ dataDir: z.string(), role: z.literal("archive"), task: ArchiveTask }),
		z.object({ dataDir: z.string(), role: z.literal("read") }),
	])
	.parse({ role: "read", ...workerData });
if (!parentPort) throw new Error("a worker needs its parent thread");
const port = parentPort;

if (data.role === "archive") await archive(data.task);
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
						blobs: diskBlobs(data.dataDir),
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
				const counts = importArchive(target.db, fileLines(task.path), { blobs: target.blobs });
				return { counts, owner: task.mode === "local" ? bootstrap(target).owner : null };
			});
			const events: Extract<z.infer<typeof ArchiveReply>, { ok: true }>["events"] = [];
			target.subscribe((event) => events.push(event));
			recoverAccepted(target);
			reply = {
				ok: true,
				...restored,
				owner: restored.owner
					? { ...restored.owner, can: [...restored.owner.can], roles: [...(restored.owner.roles ?? [])] }
					: null,
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

async function reads(): Promise<void> {
	// Archive work needs no operation registry.
	const [{ OPS }, { invoke }] = await Promise.all([import("./ops/index.ts"), import("./ops/registry.ts")]);
	const config = {
		dataDir: data.dataDir,
		host: "127.0.0.1",
		port: 0,
		mode: "server",
		owner: "",
		ownerToken: null,
		commit: null,
		// A cookie reference carries the instance's idle lifetime and latest admitted activity. Absolute expiry
		// is read from the session row. This worker admits no requests and notes no activity itself.
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
		caller: CallerReference,
		clockOffset: z.number().finite(),
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
		app.now = () => Date.now() + call.clockOffset;
		const reply: Reply =
			OPS[call.op]?.effect === "write"
				? { ok: false, error: { code: "forbidden", message: "reader threads cannot write" } }
				: invoke(app, OPS, { ...call, reference: call.caller, actor: () => null });
		port.postMessage({ type: "reply", id: call.id, reply });
	});
	port.postMessage("ready");
}
