import { parentPort, workerData } from "node:worker_threads";
import { z } from "zod";
import { ActorKind, Capability } from "../core/kinds.ts";
import { openApp } from "./kernel/app.ts";
import { OPS } from "./ops/index.ts";
import { invoke, type Reply } from "./ops/registry.ts";

const data = z.object({ dataDir: z.string() }).parse(workerData);
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
if (!parentPort) throw new Error("a reader needs its parent thread");
const port = parentPort;
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
