import { closeSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap } from "../server/identity/identity.ts";
import { recoverAccepted } from "../server/jobs.ts";
import type { App } from "../server/kernel/app.ts";
import type { Actor } from "../server/kernel/ctx.ts";
import { HTTP_STATUS, OpError } from "../server/kernel/errors.ts";
import { exportArchive, importArchive, linesOf, removeBootstrap } from "../server/transfer/transfer.ts";
import type { Session } from "./http.ts";

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

function scratch(): { path: string; remove: () => void } {
	const directory = mkdtempSync(join(tmpdir(), "mainworthy-archive-"));
	return { path: join(directory, "archive.ndjson"), remove: () => rmSync(directory, { recursive: true, force: true }) };
}

function writeBytes(fd: number, bytes: Uint8Array): void {
	let offset = 0;
	while (offset < bytes.byteLength) {
		const written = writeSync(fd, bytes, offset, bytes.byteLength - offset);
		if (written === 0) throw new Error("archive spool could not be written");
		offset += written;
	}
}

/** The synchronous transfer contract needs a disk spool to preserve HTTP backpressure without queueing the archive. */
function fileStream(file: { path: string; remove: () => void }): ReadableStream<Uint8Array> {
	const fd = openSync(file.path, "r");
	let closed = false;
	const close = (): void => {
		if (closed) return;
		closed = true;
		closeSync(fd);
		file.remove();
	};
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			try {
				const buffer = new Uint8Array(CHUNK_BYTES);
				const bytes = readSync(fd, buffer);
				if (bytes === 0) {
					close();
					controller.close();
				} else controller.enqueue(buffer.subarray(0, bytes));
			} catch (error) {
				close();
				controller.error(error);
			}
		},
		cancel: close,
	});
}

/** The importer receives a lazy synchronous iterator; only its current row and one 64 KiB chunk are in memory. */
function* fileLines(path: string): Iterable<string> {
	const fd = openSync(path, "r");
	const buffer = new Uint8Array(CHUNK_BYTES);
	const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
	let pending = "";
	try {
		while (true) {
			const size = readSync(fd, buffer);
			if (size === 0) break;
			pending += decoder.decode(buffer.subarray(0, size), { stream: true });
			const end = pending.lastIndexOf("\n");
			if (end >= 0) {
				yield* linesOf(pending.slice(0, end + 1));
				pending = pending.slice(end + 1);
			}
		}
		pending += decoder.decode();
		if (pending.length > 0) yield pending;
	} catch (error) {
		if (error instanceof TypeError) throw new OpError("invalid", "the archive is not valid UTF-8");
		throw error;
	} finally {
		closeSync(fd);
	}
}

async function stageBody(req: Request, path: string): Promise<void> {
	if (!req.body) throw new OpError("invalid", "an archive body is required");
	const fd = openSync(path, "w", 0o600);
	const reader = req.body.getReader();
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) return;
			writeBytes(fd, chunk.value);
		}
	} finally {
		reader.releaseLock();
		closeSync(fd);
	}
}

/** Admin-only transfer. The optional owner is Local's captured identity, refreshed after replacing bootstrap rows. */
export function archiveRoutes(
	app: App,
	owner?: Actor,
): Record<string, (req: Request, session: Session) => Response | Promise<Response>> {
	const allowed = (session: Session): boolean => session.actor(0)?.can.includes("admin") ?? false;
	return {
		"/api/export": (req, session) => {
			if (!allowed(session)) return failure(new OpError("forbidden", "export needs the admin capability"));
			if (req.method !== "GET")
				return json({ ok: false, error: { code: "invalid", message: "export requires GET" } }, 405);
			const file = scratch();
			try {
				const fd = openSync(file.path, "w", 0o600);
				try {
					exportArchive(app.reader, (chunk) => writeBytes(fd, new TextEncoder().encode(chunk)), { now: app.now() });
				} finally {
					closeSync(fd);
				}
				return new Response(fileStream(file), {
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
			const file = scratch();
			const localOwner = owner ?? (session.via === "local" ? session.actor(0) : null);
			try {
				await stageBody(req, file.path);
				const result = await app.gate.run(() => {
					if (!allowed(session))
						throw new OpError(
							"forbidden",
							"import needs the admin capability; the token or grant changed while uploading",
						);
					const restored = app.db.savepoint(() => {
						removeBootstrap(app.db);
						const counts = importArchive(app.db, fileLines(file.path));
						return { counts, owner: app.config.mode === "local" ? bootstrap(app).owner : null };
					});
					if (localOwner && restored.owner) Object.assign(localOwner, restored.owner);
					// An export taken while a report was between its two transactions holds that report accepted and
					// not applied. The original applied it a moment later; so does this instance, now, and not only
					// at its next start.
					recoverAccepted(app);
					return restored.counts;
				});
				return json({
					ok: true,
					result: {
						...result,
						note: `Import replaced the bootstrap rows. Your previous session may no longer exist. ${app.config.mode === "server" ? "No token works now. Restart the server to reconnect: it takes the owner's token from MAINWORTHY_OWNER_TOKEN, or prints a new one when that is not set." : "The configured local owner was refreshed."}`,
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
