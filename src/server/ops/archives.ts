import { closeSync, openSync } from "node:fs";
import { z } from "zod";
import { ERROR_CODES } from "../../core/api.ts";
import { ActorKind, Capability, Role } from "../../core/kinds.ts";
import { bootstrap, clearChallenges, lockAllActors, lockIdentityRoster } from "../identity/identity.ts";
import type { App } from "../kernel/app.ts";
import { allProjects, lockAllProjects, lockProjectRoster } from "../kernel/ctx.ts";
import type { WriteDb } from "../kernel/db.ts";
import { fileLines, writeBytes } from "../transfer/spool.ts";
import { exportArchive, importArchive, removeBootstrap } from "../transfer/transfer.ts";
import { recoverAccepted } from "./jobs.ts";

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
			warnings: z.array(z.string()).optional(),
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

/** Transfers use explicit scopes; import admission is rechecked on the locked lease. */
export async function runArchive(
	app: App,
	task: z.infer<typeof ArchiveTask>,
	authorize?: (db: WriteDb) => Promise<void>,
): Promise<Extract<z.infer<typeof ArchiveReply>, { ok: true }>> {
	if (task.op === "export") {
		const fd = openSync(task.path, "w", 0o600);
		try {
			const encoder = new TextEncoder();
			const counts = await app.database.read(async (db) =>
				exportArchive(db, (chunk) => writeBytes(fd, encoder.encode(chunk)), {
					now: task.now,
					...(task.project === undefined ? {} : { project: task.project }),
					blobs: app.blobs,
				}),
			);
			return { ok: true, counts, owner: null, events: [] };
		} finally {
			closeSync(fd);
		}
	}
	const restored = await app.database.write(async (db) =>
		db.transaction(async () => {
			// Import replaces the instance. Table locks also exclude a concurrent insertion into an empty roster.
			await lockIdentityRoster(db);
			await lockAllActors(db);
			await lockProjectRoster(db);
			await lockAllProjects(db);
			await authorize?.(db);
			await clearChallenges(app, db);
			await removeBootstrap(db);
			const counts = await importArchive(db, fileLines(task.path), { blobs: app.blobs });
			const owner = task.mode === "local" ? (await bootstrap(app, db)).owner : null;
			for (const project of await allProjects(db))
				await app.recordChange(db, { project: project.key, seq: project.seq, op: "import", actor: "", touched: [] });
			return { counts, owner };
		}),
	);
	await recoverAccepted(app);
	return {
		ok: true,
		counts: restored.counts,
		owner: restored.owner
			? { ...restored.owner, can: [...restored.owner.can], roles: [...(restored.owner.roles ?? [])] }
			: null,
		events: [],
	};
}
