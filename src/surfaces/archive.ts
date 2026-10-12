import { closeSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { App } from "../server/kernel/app.ts";
import { HTTP_STATUS, OpError } from "../server/kernel/errors.ts";
import { exportArchive, importArchive, linesOf } from "../server/transfer/transfer.ts";
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
	const directory = mkdtempSync(join(tmpdir(), "casebook-archive-"));
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

/** start() creates scratch before listening. Only that untouched project may be replaced by the archive. */
function removeBootstrapProject(app: App): void {
	const projects = z
		.array(z.object({ key: z.string(), name: z.string(), seq: z.number() }))
		.parse(app.db.raw.query("SELECT key, name, seq FROM projects").all());
	if (projects.length === 0) return;
	const first = projects[0];
	const count = (query: string): number => z.object({ n: z.number() }).parse(app.db.raw.query(query).get()).n;
	if (
		projects.length !== 1 ||
		!first ||
		first.key !== "scratch" ||
		first.name !== "scratch" ||
		first.seq !== 1 ||
		count("SELECT count(*) AS n FROM commands") !== 0 ||
		count("SELECT count(*) AS n FROM actors") !== 2 ||
		count("SELECT count(*) AS n FROM policies WHERE version <> 1 OR preset <> 'loose'") !== 0
	) {
		throw new OpError("conflict", "import needs a fresh instance; existing projects or user data will not be replaced");
	}
	app.db.raw.exec("DELETE FROM policies; DELETE FROM folders; DELETE FROM projects");
}

/** Admin-only instance transfer routes. Imports replace bootstrap identity rows and may invalidate the caller's session. */
export function archiveRoutes(
	app: App,
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
			try {
				await stageBody(req, file.path);
				const result = await app.gate.run(() =>
					app.db.savepoint(() => {
						removeBootstrapProject(app);
						return importArchive(app.db, fileLines(file.path));
					}),
				);
				return json({
					ok: true,
					result: {
						...result,
						note: "Import replaced the bootstrap rows. Your previous session may no longer exist; restart the instance to sign in again.",
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
