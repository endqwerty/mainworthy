// Starting an instance: migrate the data, make an owner and first project, and finish interrupted work before
// serving application routes. The CLI listens for health during migration. Local and Server differ only in
// configuration (decision 0002).

import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import { ActorKind, Capability, Role } from "../core/kinds.ts";
import { rebuildAssertionIndexes } from "../server/evidence/assertions.ts";
import { attachmentHashes } from "../server/evidence/attachments.ts";
import { deliverHandoffs, recoverHandoffs, stopHandoffs, waitHandoffs } from "../server/handoffs/handoffs.ts";
import {
	bootstrap,
	flushUses,
	ruleActor,
	stopMail,
	sweepSessions,
	sweepSignInRecords,
	validateBootstrap,
	waitMail,
} from "../server/identity/identity.ts";
import { parseAddressRanges } from "../server/kernel/address.ts";
import { type App, type Config, openApp } from "../server/kernel/app.ts";
import { type Actor, allProjects } from "../server/kernel/ctx.ts";
import { databasePath, holdPrivateDatabaseMask } from "../server/kernel/db.ts";
import { lockInstance } from "../server/kernel/instance-lock.ts";
import { createProject } from "../server/ops/admin.ts";
import { recoverAccepted, recoverDisputes, sweep } from "../server/ops/jobs.ts";
import { Readers, readerCount } from "../server/ops/readers.ts";
import { pollDefectHolds, stopTrackerPolls, waitTrackerPolls } from "../server/ops/tracker-holds.ts";
import type { StatusPort } from "../server/statuses/port.ts";
import { deliverCommitStatuses, stopCommitStatuses, waitCommitStatuses } from "../server/statuses/statuses.ts";
import type { TrackerPort } from "../server/trackers/port.ts";
import { deliverTrackerRequests, stopTrackerRequests, waitTrackerRequests } from "../server/trackers/requests.ts";
import { type Extra, type Patience, serve, upgradingListener, VERSION } from "../surfaces/http.ts";

export type Instance = {
	app: App;
	owner: Actor;
	url: string;
	project: string;
	generatedToken: string | null;
	/** What the operator must be told about this start, one line each (see `bootstrap`). */
	warnings: string[];
	/** What the server does by itself once a minute, run now. For a test, which cannot wait for the timer. */
	minute: () => Promise<void>;
	stop: () => Promise<void>;
};

/** Opens the instance without listening: for the CLI commands that work on the data directly, and for tests. */
type OpenOptions = { memory?: boolean; firstProject?: string; now?: () => number; copyWorkspace?: string };

export async function open(
	config: Config,
	options: OpenOptions = {},
): Promise<{ app: App; owner: Actor; project: string; generatedToken: string | null; warnings: string[] }> {
	validateBootstrap(config);
	const app = await openApp(config, {
		...(options.memory ? { memory: true } : {}),
		...(options.now ? { now: options.now } : {}),
		...(options.copyWorkspace ? { copyWorkspace: options.copyWorkspace } : {}),
	});
	try {
		const { owner, generatedToken, warnings } = await bootstrap(app);
		let project = (await allProjects(app.db))[0]?.key;
		if (!project) {
			// Zero configuration to first value: a project exists before the first case is typed.
			project = options.firstProject ?? "scratch";
			app.db.transaction(
				async () =>
					await createProject(
						{ app, actor: owner, now: app.now(), session: null, context: null },
						{ key: project ?? "scratch", preset: "loose" },
					),
			);
		}
		return { app, owner, project, generatedToken, warnings };
	} catch (error) {
		// A start that is refused (an owner name that is not a person's) leaves the database closed, not held.
		app.close();
		throw error;
	}
}

type StartOptions = {
	firstProject?: string;
	readers?: number;
	patience?: Patience;
	now?: () => number;
	trackerPort?: TrackerPort;
	statusPort?: StatusPort;
};

export type StartupData = {
	config: Omit<Config, "proxy"> & { proxy: { header: string; peers: string } | null };
	workspace: string;
	firstProject?: string;
	now?: number;
};

/** Config's proxy matcher is a function. Reconstruct it from validated range text across the worker boundary. */
export function startupConfig(data: StartupData): Config {
	const { proxy, ...config } = data.config;
	if (!proxy) return { ...config, proxy: null };
	const peers = parseAddressRanges(proxy.peers);
	if (peers.kind !== "ranges") throw new Error("invalid startup proxy ranges");
	return { ...config, proxy: { header: proxy.header, peers } };
}
type Prepared = Omit<ReturnType<typeof open>, "app">;
const Prepared: z.ZodType<Prepared> = z.object({
	owner: z
		.object({
			id: z.number().int(),
			kind: ActorKind,
			name: z.string(),
			can: z.array(Capability),
			roles: z.array(Role).optional(),
		})
		.transform(({ roles, ...actor }) => ({ ...actor, ...(roles === undefined ? {} : { roles }) })),
	project: z.string(),
	generatedToken: z.string().nullable(),
	warnings: z.array(z.string()),
});
const StartupMessage = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("progress") }),
	z.object({ kind: z.literal("prepared"), prepared: Prepared }),
]);

async function recoverStartup(app: App, progress: (phase: string) => void = () => {}): Promise<void> {
	progress("attachments");
	app.blobs.prune(await attachmentHashes(app.db));
	progress("assertions");
	await rebuildAssertionIndexes(app.db, false, () => progress("assertions"));
	progress("accepted reports");
	await recoverAccepted(app);
	progress("disputes");
	await recoverDisputes(app);
	progress("handoffs");
	await recoverHandoffs(app);
	progress("recovered");
}

/** The worker completes all data-dependent scans, closes its connections, then hands back bootstrap output. */
export async function prepareStartup(
	config: Config,
	options: OpenOptions,
	progress: (phase: string) => void,
): Promise<Prepared> {
	const { app, ...prepared } = await open(config, options);
	try {
		progress("opened");
		await recoverStartup(app, progress);
		return prepared;
	} finally {
		app.close();
	}
}

function validateStartup(config: Config, options: StartOptions): number {
	validateBootstrap(config);
	if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535)
		throw new Error("MAINWORTHY_PORT must be an integer between 0 and 65535");
	return readerCount({
		MAINWORTHY_READERS: options.readers === undefined ? process.env.MAINWORTHY_READERS : String(options.readers),
	});
}

/** stat does not open a descriptor and therefore cannot drop SQLite's process-wide file locks. */
function startupActivity(path: string, workspace: string): string {
	let copies: string[] = [];
	try {
		copies = readdirSync(workspace).map((name) => join(workspace, name));
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
	return JSON.stringify(
		[path, `${path}-wal`, ...copies.sort()].map((file) => {
			try {
				const stat = statSync(file);
				return [file, stat.size, stat.mtimeMs];
			} catch (error) {
				if (error instanceof Error && "code" in error && error.code === "ENOENT") return [file];
				throw error;
			}
		}),
	);
}

/** Starts liveness first; the instance lock covers the worker and the eventual server without a handoff gap. */
export async function startServing(
	config: Config,
	extra: (app: App, owner: Actor) => Extra,
	options: StartOptions & {
		signal?: AbortSignal;
		startupIdleMs?: number;
		onListening?: (url: string) => void;
		spawn?: (url: URL, data: StartupData) => Worker;
	} = {},
): Promise<Instance> {
	const count = validateStartup(config, options);
	const idleMs = options.startupIdleMs ?? 30 * 60_000;
	if (!Number.isFinite(idleMs) || idleMs <= 0) throw new Error("startupIdleMs must be a finite positive duration");
	options.signal?.throwIfAborted();
	const unlock = lockInstance(config.dataDir);
	let listener: ReturnType<typeof upgradingListener> | undefined;
	let worker: Worker | undefined;
	let workspace: string | undefined;
	const releaseMask = holdPrivateDatabaseMask();
	try {
		options.signal?.throwIfAborted();
		listener = upgradingListener(config, options.patience);
		options.onListening?.(listener.url.origin);
		const path = databasePath(config.dataDir);
		workspace = mkdtempSync(`${path}.mainworthy-start-`);
		const ownedWorkspace = workspace;
		const url = new URL(Bun.isStandaloneExecutable ? "./app/start-worker.js" : "./start-worker.ts", import.meta.url);
		const data: StartupData = {
			config: {
				...config,
				proxy: config.proxy ? { header: config.proxy.header, peers: config.proxy.peers.source } : null,
			},
			workspace,
			...(options.firstProject === undefined ? {} : { firstProject: options.firstProject }),
			...(options.now ? { now: options.now() } : {}),
		};
		worker = options.spawn ? options.spawn(url, data) : new Worker(url, { workerData: data });
		const migrating = worker;
		const prepared = await new Promise<Prepared>((resolve, reject) => {
			const abort = () => reject(options.signal?.reason ?? new Error("startup stopped"));
			let activity = startupActivity(path, ownedWorkspace);
			let lastProgress = performance.now();
			let result: Prepared | undefined;
			const timeout = setInterval(
				() => {
					try {
						const next = startupActivity(path, ownedWorkspace);
						if (next !== activity) {
							activity = next;
							lastProgress = performance.now();
						}
						if (performance.now() - lastProgress >= idleMs)
							reject(new Error("database startup made no progress before its idle deadline"));
					} catch (error) {
						reject(error);
					}
				},
				Math.max(1, Math.min(1000, idleMs / 4)),
			);
			options.signal?.addEventListener("abort", abort, { once: true });
			migrating.on("message", (message: unknown) => {
				const parsed = StartupMessage.safeParse(message);
				if (!parsed.success) {
					reject(new Error("invalid startup worker reply"));
					return;
				}
				lastProgress = performance.now();
				if (parsed.data.kind === "prepared") result = parsed.data.prepared;
			});
			migrating.once("error", reject);
			migrating.once("exit", (code) => {
				clearInterval(timeout);
				options.signal?.removeEventListener("abort", abort);
				if (code === 0 && result) resolve(result);
				else if (code === 0) reject(new Error("startup worker ended without its prepared instance"));
				else reject(new Error(`database upgrade worker exited ${code}`));
			});
		});
		options.signal?.throwIfAborted();
		releaseMask();
		return await startLocked(config, extra, options, count, unlock, listener, prepared);
	} catch (error) {
		try {
			await listener?.stop(true);
		} finally {
			try {
				await worker?.terminate();
			} finally {
				unlock();
			}
		}
		throw error;
	} finally {
		try {
			if (workspace) rmSync(workspace, { recursive: true, force: true });
		} finally {
			releaseMask();
		}
	}
}

export async function start(
	config: Config,
	extra: (app: App, owner: Actor) => Extra,
	options: StartOptions = {},
): Promise<Instance> {
	const count = validateStartup(config, options);
	return await startLocked(config, extra, options, count, lockInstance(config.dataDir));
}

async function startLocked(
	config: Config,
	extra: (app: App, owner: Actor) => Extra,
	options: StartOptions,
	count: number,
	unlock: () => void,
	listener?: ReturnType<typeof upgradingListener>,
	prepared?: Prepared,
): Promise<Instance> {
	let opened: ReturnType<typeof open>;
	try {
		opened = prepared ? { ...prepared, app: await openApp(config, options) } : await open(config, options);
	} catch (error) {
		unlock();
		throw error;
	}
	const { app, owner } = opened;
	let server: ReturnType<typeof serve>;
	try {
		if (!prepared) await recoverStartup(app);
		server = serve(app, owner, extra(app, owner), options.patience, listener);
	} catch (error) {
		app.close();
		unlock();
		throw error;
	}
	if (count > 0) {
		app.readers = new Readers({ dataDir: config.dataDir, count });
		// The pool brings a thread that checkpoints, so commits on this thread no longer do.
		app.db.deferCheckpoints();
	}
	// Through the gate, like every other writer, so it never lands inside another command's open transaction.
	// Each job has its own turn at the gate and runs in this order, so one that fails does not stop the next:
	// questions whose decisions ran out are reopened, what was noted of the use of tokens and sessions is written,
	// and then, with the rows current, sessions past a lifetime are ended and old sign-in records cleaned up.
	// The policy's own actor is looked up inside the gate, each time: an import replaces the actors, and the id
	// it had when the server started may then be somebody else's (issue #123).
	const minute = async (): Promise<void> => {
		const jobs = [
			["sweep", app.gate.run(async () => await sweep(app, (await ruleActor(app.db)).id))],
			["writing last uses", flushUses(app)],
			["ending expired sessions", app.gate.run(async () => await sweepSessions(app))],
			["deleting old sign-in records", app.gate.run(async () => await sweepSignInRecords(app))],
			["sending tracker requests", deliverTrackerRequests(app, options.trackerPort)],
			["sending hand-offs", deliverHandoffs(app)],
			["checking defect holds", pollDefectHolds(app, options.trackerPort)],
			["posting GitHub commit statuses", deliverCommitStatuses(app, options.statusPort)],
		] as const;
		for (const [name, job] of jobs) {
			await job.catch((error: unknown) => console.error(`[mainworthy] ${name} failed:`, error));
		}
	};
	const timer = setInterval(() => void minute(), 60_000);
	timer.unref();
	const url = `http://${config.host === "0.0.0.0" || config.host === "::" ? "localhost" : config.host}:${server.port}`;
	let stopping: Promise<void> | null = null;
	return {
		...opened,
		url,
		minute,
		stop() {
			stopping ??= (async () => {
				clearInterval(timer);
				stopTrackerRequests(app);
				stopHandoffs(app);
				stopTrackerPolls(app);
				stopCommitStatuses(app);
				await server.stop();
				stopMail(app);
				await waitMail(app);
				await waitTrackerRequests(app);
				await waitHandoffs(app);
				await waitTrackerPolls(app);
				await waitCommitStatuses(app);
				await app.readers?.stop();
				// No request is being served any more. What was noted since the last minute is written, so a
				// session used a moment ago is not found idle by the next start.
				await flushUses(app).catch((error: unknown) => console.error("[mainworthy] writing last uses failed:", error));
				await app.gate.run(() => undefined);
				app.close();
				unlock();
			})();
			return stopping;
		},
	};
}

export { VERSION };
