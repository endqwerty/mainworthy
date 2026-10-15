import { Worker } from "node:worker_threads";
import { z } from "zod";
import { ERROR_CODES } from "../core/api.ts";
import { ActorKind, Capability, Role } from "../core/kinds.ts";
import type { App } from "./kernel/app.ts";
import { OpError } from "./kernel/errors.ts";

export const ArchiveTask = z.discriminatedUnion("op", [
	z.object({ op: z.literal("export"), path: z.string(), now: z.number(), project: z.string().min(1).optional() }),
	z.object({
		op: z.literal("import"),
		path: z.string(),
		now: z.number().optional(),
		mode: z.enum(["local", "server"]),
		owner: z.string(),
		ownerToken: z.string().nullable(),
		ownerWas: z.string().optional(),
	}),
]);

export const ArchiveReply = z.discriminatedUnion("ok", [
	z.object({
		ok: z.literal(true),
		counts: z.object({
			rows: z.number().int().nonnegative(),
			tables: z.record(z.string(), z.number().int().nonnegative()),
		}),
		owner: z
			.object({
				id: z.number().int(),
				kind: ActorKind,
				name: z.string(),
				can: z.array(Capability),
				roles: z.array(Role).default([]),
			})
			.nullable(),
		events: z.array(
			z.object({
				project: z.string(),
				seq: z.number(),
				op: z.string(),
				actor: z.string(),
				touched: z.array(z.string()),
			}),
		),
	}),
	z.object({ ok: z.literal(false), error: z.object({ code: z.enum(ERROR_CODES), message: z.string() }) }),
]);

/** Runs a transfer on its own connection. A failed worker never replays archive work on the HTTP thread. */
export async function runArchive(app: App, task: z.infer<typeof ArchiveTask>) {
	const worker = new Worker(
		new URL(Bun.isStandaloneExecutable ? "./server/read-worker.js" : "./read-worker.ts", import.meta.url),
		{ workerData: { dataDir: app.config.dataDir, role: "archive", task }, name: "mainworthy-archive" },
	);
	try {
		return await new Promise<Extract<z.infer<typeof ArchiveReply>, { ok: true }>>((resolve, reject) => {
			worker.once("message", (message: unknown) => {
				const parsed = ArchiveReply.safeParse(message);
				if (!parsed.success) return reject(new Error("invalid archive worker reply"));
				const reply = parsed.data;
				if (!reply.ok) return reject(new OpError(reply.error.code, reply.error.message));
				resolve(reply);
			});
			worker.once("error", reject);
			worker.once("messageerror", reject);
			worker.once("exit", (code) => reject(new Error(`archive worker exited with code ${code}`)));
		});
	} finally {
		await worker.terminate();
	}
}
