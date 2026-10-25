import type { App, ChangeEvent } from "../server/kernel/app.ts";
import { changeRevision, changesSince } from "../server/kernel/changes.ts";
import { findProject } from "../server/kernel/ctx.ts";
import type { ReadDb } from "../server/kernel/db.ts";

type Cursor = { identity: string; seq: number; revision: string | null };

/** Notifications only wake the stream. Its cursor advances through committed database history. */
export function changeStream(
	app: App,
	req: Request,
	project: string,
	closing: AbortSignal,
	authorize: (db: ReadDb, project: number) => Promise<boolean>,
	heartbeatMs = 20_000,
): Response {
	const encoder = new TextEncoder();
	let cursor: Cursor | null = null;
	let closed = false;
	let requested = false;
	let running = false;
	let unsubscribe = (): void => {};
	let beat: ReturnType<typeof setInterval> | undefined;
	let close = (): void => {};
	const cleanup = () => {
		closed = true;
		unsubscribe();
		clearInterval(beat);
		req.signal.removeEventListener("abort", close);
		closing.removeEventListener("abort", close);
	};
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			close = () => {
				if (closed) return;
				cleanup();
				try {
					controller.close();
				} catch {}
			};
			const send = (text: string) => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(text));
				} catch {
					cleanup();
				}
			};
			const event = (change: ChangeEvent) => send(`data: ${JSON.stringify(change)}\n\n`);
			const flush = async () => {
				const after = cursor;
				const snapshot = await app.database.read(async (db) => {
					const found = await findProject(db, project);
					if (!found || !(await authorize(db, found.id))) return null;
					return {
						project: found,
						revision: await changeRevision(db, found.id, found.seq),
						changes: after?.identity === found.identity ? await changesSince(db, found, after.seq) : [],
					};
				});
				if (closed) return;
				if (!snapshot) return close();
				const { project: found, changes } = snapshot;
				// A revocation can commit after the history snapshot. Ask current authority before sending its hints.
				const currentView = () =>
					app.database.read(async (db) => {
						const latest = await findProject(db, project);
						if (!latest || !(await authorize(db, latest.id))) return null;
						return { project: latest, revision: await changeRevision(db, latest.id, found.seq) };
					});
				const current = await currentView();
				if (closed) return;
				if (!current) return close();
				if (current.project.identity !== found.identity || current.revision !== snapshot.revision) {
					requested = true;
					return;
				}
				if (current.project.seq !== found.seq) requested = true;
				if (after === null) {
					cursor = { identity: found.identity, seq: found.seq, revision: snapshot.revision };
					send("retry: 2000\n\n");
					return;
				}
				// Import can replace a project's identity and reset its clock. Retention can remove part of history.
				// Both require a full refetch rather than silently advancing past a missing event.
				const gap = changes.some((change, index) => change.seq !== (changes[index - 1]?.seq ?? after.seq) + 1);
				if (
					after.identity !== found.identity ||
					(after.seq === found.seq && after.revision !== snapshot.revision) ||
					gap ||
					(changes.length < 500 && (changes.at(-1)?.seq ?? after.seq) !== found.seq)
				) {
					event({ project, seq: found.seq, op: "refresh", actor: "", touched: [] });
					cursor = { identity: found.identity, seq: found.seq, revision: snapshot.revision };
					return;
				}
				for (const [index, change] of changes.entries()) {
					if (index > 0) {
						const permission = await currentView();
						if (closed) return;
						if (!permission) return close();
						if (permission.project.identity !== found.identity || permission.revision !== snapshot.revision) {
							requested = true;
							return;
						}
						if (permission.project.seq !== found.seq) requested = true;
					}
					event(change);
					cursor = {
						identity: found.identity,
						seq: change.seq,
						revision: change.seq === found.seq ? snapshot.revision : null,
					};
				}
				if (changes.length === 500) requested = true;
				if (changes.length === 0) send(": keep-alive\n\n");
			};
			const tick = async (): Promise<void> => {
				if (closed) return;
				requested = true;
				if (running) return;
				running = true;
				try {
					while (requested && !closed) {
						requested = false;
						await flush();
					}
				} catch {
					console.error("[mainworthy] change stream authorization failed");
					close();
				} finally {
					running = false;
				}
			};
			const wake = () => void tick().catch(close);
			unsubscribe = app.subscribeChanges(wake);
			beat = setInterval(wake, heartbeatMs);
			req.signal.addEventListener("abort", close, { once: true });
			closing.addEventListener("abort", close, { once: true });
			if (req.signal.aborted || closing.aborted) close();
			else wake();
		},
		cancel: cleanup,
	});
	return new Response(stream, {
		headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" },
	});
}
