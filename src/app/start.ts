import { rebuildAssertionIndexes } from "../server/evidence/assertions.ts";
import { attachmentHashes } from "../server/evidence/attachments.ts";
import { deliverHandoffs, recoverHandoffs, stopHandoffs, waitHandoffs } from "../server/handoffs/handoffs.ts";
import {
	bootstrap,
	flushUses,
	stopMail,
	sweepSessions,
	sweepSignInRecords,
	validateBootstrap,
	waitMail,
} from "../server/identity/identity.ts";
import { type App, type Config, openApp } from "../server/kernel/app.ts";
import { type Actor, allProjects } from "../server/kernel/ctx.ts";
import { createProject } from "../server/ops/admin.ts";
import { recoverAccepted, recoverDisputes, sweep } from "../server/ops/jobs.ts";
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
type OpenOptions = { firstProject?: string; now?: () => number };

export async function open(
	config: Config,
	options: OpenOptions = {},
): Promise<{
	app: App;
	owner: Actor;
	project: string;
	generatedToken: string | null;
	warnings: string[];
}> {
	validateBootstrap(config);
	const app = await openApp(config, options);
	try {
		const { owner, generatedToken, warnings } = await bootstrap(app);
		const project = await app.database.write((db) =>
			db.transaction(async () => {
				const existing = (await allProjects(db))[0]?.key;
				if (existing) return existing;
				const key = options.firstProject ?? "scratch";
				await createProject(
					{ app, db, actor: owner, now: app.now(), session: null, context: null },
					{ key, preset: "loose" },
				);
				return key;
			}),
		);
		return { app, owner, project, generatedToken, warnings };
	} catch (error) {
		await app.close();
		throw error;
	}
}

type StartOptions = OpenOptions & {
	patience?: Patience;
	trackerPort?: TrackerPort;
	statusPort?: StatusPort;
};

async function recoverStartup(app: App, progress: (phase: string) => void = () => {}): Promise<void> {
	progress("attachments");
	await app.database.write(async (db) => {
		app.blobs.prune(await attachmentHashes(db));
		await db.transaction(async () => rebuildAssertionIndexes(db, false, () => progress("assertions")));
	});
	progress("assertions");
	progress("accepted reports");
	await recoverAccepted(app);
	progress("disputes");
	await recoverDisputes(app);
	progress("handoffs");
	await recoverHandoffs(app);
	progress("recovered");
}

function validateStartup(config: Config): void {
	validateBootstrap(config);
	if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535)
		throw new Error("MAINWORTHY_PORT must be an integer between 0 and 65535");
	if (!config.databaseUrl) throw new Error("MAINWORTHY_DATABASE_URL is required; see compose.yaml");
}

/** Liveness listens while migrations run; application routes follow bootstrap and recovery. */
export async function startServing(
	config: Config,
	extra: (app: App, owner: Actor) => Extra,
	options: StartOptions & { signal?: AbortSignal; onListening?: (url: string) => void } = {},
): Promise<Instance> {
	validateStartup(config);
	options.signal?.throwIfAborted();
	const listener = upgradingListener(config, options.patience);
	try {
		options.onListening?.(listener.url.origin);
		return await startInstance(config, extra, options, listener, options.signal);
	} catch (error) {
		await listener.stop();
		throw error;
	}
}

export async function start(
	config: Config,
	extra: (app: App, owner: Actor) => Extra,
	options: StartOptions = {},
): Promise<Instance> {
	validateStartup(config);
	return startInstance(config, extra, options);
}

async function startInstance(
	config: Config,
	extra: (app: App, owner: Actor) => Extra,
	options: StartOptions,
	listener?: ReturnType<typeof upgradingListener>,
	signal?: AbortSignal,
): Promise<Instance> {
	const opened = await open(config, options);
	const { app, owner } = opened;
	let server: ReturnType<typeof serve>;
	try {
		await recoverStartup(app);
		signal?.throwIfAborted();
		server = serve(app, owner, extra(app, owner), options.patience, listener);
	} catch (error) {
		await app.close();
		throw error;
	}
	// Every writer gets its own database lease.
	// Each job has its own write lease and runs in this order, so one that fails does not stop the next:
	// questions whose decisions ran out are reopened, what was noted of the use of tokens and sessions is written,
	// and then, with the rows current, sessions past a lifetime are ended and old sign-in records cleaned up.
	// The policy's own actor is looked up inside the write lease, each time: an import replaces the actors, and the id
	// it had when the server started may then be somebody else's (issue #123).
	let minuteWork: Promise<void> = Promise.resolve();
	const runMinute = async (): Promise<void> => {
		const jobs = [
			["sweep", () => sweep(app)],
			["writing last uses", () => flushUses(app)],
			["ending expired sessions", () => sweepSessions(app)],
			["deleting old sign-in records", () => sweepSignInRecords(app)],
			["sending tracker requests", () => deliverTrackerRequests(app, options.trackerPort)],
			["sending hand-offs", () => deliverHandoffs(app)],
			["checking defect holds", () => pollDefectHolds(app, options.trackerPort)],
			["posting GitHub commit statuses", () => deliverCommitStatuses(app, options.statusPort)],
		] as const;
		for (const [name, job] of jobs) {
			await job().catch((error: unknown) => console.error(`[mainworthy] ${name} failed:`, error));
		}
	};
	const minute = (): Promise<void> => {
		minuteWork = minuteWork.then(runMinute);
		return minuteWork;
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
				await minuteWork;
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
				// No request is being served any more. What was noted since the last minute is written, so a
				// session used a moment ago is not found idle by the next start.
				await flushUses(app).catch((error: unknown) => console.error("[mainworthy] writing last uses failed:", error));
				await app.close();
			})();
			return stopping;
		},
	};
}

export { VERSION };
