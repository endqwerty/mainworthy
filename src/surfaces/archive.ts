import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { HTTP_STATUS } from "../core/api.ts";
import { runArchive } from "../server/archives.ts";
import { clearChallenges, clearUses, type Session } from "../server/identity/identity.ts";
import type { App } from "../server/kernel/app.ts";
import type { Actor } from "../server/kernel/ctx.ts";
import { OpError } from "../server/kernel/errors.ts";

const CHUNK_BYTES = 64 * 1024;
const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", "cache-control": "no-store" },
	});

function failure(error: unknown): Response {
	const known = error instanceof OpError ? error : new OpError("internal", "archive transfer failed");
	return json({ ok: false, error: { code: known.code, message: known.message } }, HTTP_STATUS[known.code]);
}

function scratch(dataDir: string): { path: string; remove: () => void } {
	const spool = join(dataDir, "spool");
	mkdirSync(spool, { recursive: true, mode: 0o700 });
	const directory = mkdtempSync(join(spool, "mainworthy-archive-"));
	return { path: join(directory, "archive.ndjson"), remove: () => rmSync(directory, { recursive: true, force: true }) };
}

/** Spooling keeps download backpressure separate from the worker's snapshot. File I/O also leaves HTTP free. */
async function fileStream(file: { path: string; remove: () => void }): Promise<ReadableStream<Uint8Array>> {
	const fd = await open(file.path, "r");
	let closing: Promise<void> | undefined;
	let cancelled = false;
	const close = (): Promise<void> => {
		closing ??= fd.close().finally(file.remove);
		return closing;
	};
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const buffer = new Uint8Array(CHUNK_BYTES);
				const { bytesRead } = await fd.read(buffer);
				if (cancelled) return;
				if (bytesRead === 0) {
					await close();
					controller.close();
				} else controller.enqueue(buffer.subarray(0, bytesRead));
			} catch (error) {
				if (cancelled) return;
				await close().catch(() => undefined);
				controller.error(error);
			}
		},
		cancel() {
			cancelled = true;
			return close();
		},
	});
}

async function stageBody(req: Request, path: string): Promise<void> {
	if (!req.body) throw new OpError("invalid", "an archive body is required");
	const fd = await open(path, "w", 0o600);
	try {
		await fd.writeFile(req.body);
	} finally {
		await fd.close();
	}
}

/** Admin-only transfer. The optional owner is Local's captured identity, refreshed after replacing bootstrap rows. */
export function archiveRoutes(
	app: App,
	owner?: Actor,
): Record<string, (req: Request, session: Session) => Response | Promise<Response>> {
	const allowed = (session: Session): boolean => session.actor(0)?.can.includes("admin") ?? false;
	return {
		"/api/export": async (req, session) => {
			if (!allowed(session)) return failure(new OpError("forbidden", "export needs the admin capability"));
			if (req.method !== "GET")
				return json({ ok: false, error: { code: "invalid", message: "export requires GET" } }, 405);
			const file = scratch(app.config.dataDir);
			try {
				await runArchive(app, { op: "export", path: file.path, now: app.now() });
				const stream = await fileStream(file);
				if (!allowed(session)) {
					await stream.cancel();
					throw new OpError(
						"forbidden",
						"export needs the admin capability; the token or grant changed while exporting",
					);
				}
				return new Response(stream, {
					headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" },
				});
			} catch (error) {
				file.remove();
				return failure(error);
			}
		},
		"/api/import": async (req, session) => {
			if (!allowed(session)) return failure(new OpError("forbidden", "import needs the admin capability"));
			if (req.method !== "POST")
				return json({ ok: false, error: { code: "invalid", message: "import requires POST" } }, 405);
			const file = scratch(app.config.dataDir);
			const localOwner = owner ?? (session.via === "local" ? session.actor(0) : null);
			try {
				await stageBody(req, file.path);
				const result = await app.gate.run(async () => {
					if (!allowed(session))
						throw new OpError(
							"forbidden",
							"import needs the admin capability; the token or grant changed while uploading",
						);
					const restored = await runArchive(app, {
						op: "import",
						path: file.path,
						...(app.now === Date.now ? {} : { now: app.now() }),
						mode: app.config.mode,
						owner: app.config.owner,
						ownerToken: app.config.ownerToken,
						...(app.config.ownerWas ? { ownerWas: app.config.ownerWas } : {}),
					});
					// The import is committed: every token and session row is gone, and the next ones made take
					// their ids. What was noted of the old rows' use must not become the new rows' use.
					clearUses(app);
					// The same for a passkey ceremony that was under way: its challenge was issued for a person who
					// may not be there any more, and must not be answered for whoever is.
					clearChallenges(app);
					if (localOwner && restored.owner) Object.assign(localOwner, restored.owner);
					// An export taken while a report was between its two transactions holds that report accepted and
					// not applied. The original applied it a moment later; so does this instance, now, and not only
					// at its next start.
					for (const event of restored.events) app.publish(event);
					return restored.counts;
				});
				return json({
					ok: true,
					result: {
						...result,
						note: `Import replaced the bootstrap rows. Your previous session may no longer exist. ${app.config.mode === "server" ? "No token works now and every browser is signed out. Restart the server to reconnect: it takes the owner's token from MAINWORTHY_OWNER_TOKEN, or prints a new one when that is not set." : "The configured local owner was refreshed."}`,
						callerSessionMayHaveChanged: true,
					},
					seq: null,
				});
			} catch (error) {
				return failure(error);
			} finally {
				file.remove();
			}
		},
	};
}
