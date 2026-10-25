import { stopHandoffs, waitHandoffs } from "../server/handoffs/handoffs.ts";
import {
	bootstrap,
	flushUses,
	lockActors,
	stopMail,
	validateBootstrap,
	waitMail,
} from "../server/identity/identity.ts";
import { type App, type Config, openApp } from "../server/kernel/app.ts";
import { type Actor, allProjects, lockProjectKey } from "../server/kernel/ctx.ts";
import { createProject } from "../server/ops/admin.ts";
import { enqueueStartupJobs, jobOperation } from "../server/ops/jobs.ts";
import { invokeService } from "../server/ops/registry.ts";
import { stopTrackerPolls, waitTrackerPolls } from "../server/ops/tracker-holds.ts";
import type { StatusPort } from "../server/statuses/port.ts";
import { stopCommitStatuses, waitCommitStatuses } from "../server/statuses/statuses.ts";
import type { TrackerPort } from "../server/trackers/port.ts";
import { stopTrackerRequests, waitTrackerRequests } from "../server/trackers/requests.ts";
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
				await lockActors(db, [owner.id]);
				const key = options.firstProject ?? "scratch";
				await lockProjectKey(db, key);
				const existing = (await allProjects(db))[0]?.key;
				if (existing) return existing;
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
		await enqueueStartupJobs(app);
		signal?.throwIfAborted();
		server = serve(app, owner, extra(app, owner), options.patience, listener);
	} catch (error) {
		await app.close();
		throw error;
	}
	const runner = new AbortController();
	const operation = jobOperation({ ...options, signal: runner.signal });
	let stopping: Promise<void> | null = null;
	let minuteWork: Promise<void> = Promise.resolve();
	const run = (periodic: boolean): Promise<void> => {
		minuteWork = minuteWork
			.then(async () => {
				if (runner.signal.aborted) return;
				const reply = await invokeService(app, operation, { do: periodic ? "tick" : "drain" });
				if (!reply.ok) console.error("[mainworthy] background jobs failed", { code: reply.error.code });
			})
			.catch((error: unknown) => console.error("[mainworthy] background jobs failed", error));
		return minuteWork;
	};
	const minute = (): Promise<void> => run(true);
	const timer = !config.jobService && config.jobRunner !== false ? setInterval(() => void minute(), 60_000) : null;
	const poller = !config.jobService && config.jobRunner !== false ? setInterval(() => void run(false), 1000) : null;
	timer?.unref();
	poller?.unref();
	const url = `http://${config.host === "0.0.0.0" || config.host === "::" ? "localhost" : config.host}:${server.port}`;
	return {
		...opened,
		url,
		minute,
		stop() {
			stopping ??= (async () => {
				runner.abort();
				if (timer) clearInterval(timer);
				if (poller) clearInterval(poller);
				stopTrackerRequests(app);
				stopHandoffs(app);
				stopTrackerPolls(app);
				stopCommitStatuses(app);
				const stoppedServer = server.stop();
				await minuteWork;
				await stoppedServer;
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
