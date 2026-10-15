// Starting an instance: open the data, make sure an owner and a first project exist, finish interrupted work,
// then listen. The same function is the Local layer on a laptop and the Server layer in a container; only the
// configuration differs (decision 0002).
import { type Extra, type Patience, serve, VERSION } from "../surfaces/http.ts";
import {
	bootstrap,
	flushUses,
	publicAddress,
	ruleActor,
	sweepSessions,
	sweepSignInRecords,
} from "./identity/identity.ts";
import { recoverAccepted, sweep } from "./jobs.ts";
import { type App, type Config, openApp } from "./kernel/app.ts";
import { type Actor, allProjects } from "./kernel/ctx.ts";
import { createProject } from "./ops/admin.ts";
import { Readers, readerCount } from "./readers.ts";

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
export function open(
	config: Config,
	options: { memory?: boolean; firstProject?: string; now?: () => number } = {},
): { app: App; owner: Actor; project: string; generatedToken: string | null; warnings: string[] } {
	// A public address that no browser would make a passkey at, or that is not the root address of the instance,
	// stops the start here, before the data is opened.
	publicAddress(config);
	const app = openApp(config, {
		...(options.memory ? { memory: true } : {}),
		...(options.now ? { now: options.now } : {}),
	});
	try {
		const { owner, generatedToken, warnings } = bootstrap(app);
		let project = allProjects(app.db)[0]?.key;
		if (!project) {
			// Zero configuration to first value: a project exists before the first case is typed.
			project = options.firstProject ?? "scratch";
			app.db.transaction(() =>
				createProject(
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

export function start(
	config: Config,
	extra: (app: App, owner: Actor) => Extra,
	/** `now` is the instance's clock: a test passes its own, so nothing in it has to wait for time to pass. */
	options: { firstProject?: string; readers?: number; patience?: Patience; now?: () => number } = {},
): Instance {
	const count = readerCount({
		MAINWORTHY_READERS: options.readers === undefined ? process.env.MAINWORTHY_READERS : String(options.readers),
	});
	const opened = open(config, options);
	const { app, owner } = opened;
	recoverAccepted(app);
	let server: ReturnType<typeof serve>;
	try {
		server = serve(app, owner, extra(app, owner), options.patience);
	} catch (error) {
		app.close();
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
			["sweep", app.gate.run(() => sweep(app, ruleActor(app.db).id))],
			["writing last uses", flushUses(app)],
			["ending expired sessions", app.gate.run(() => sweepSessions(app))],
			["deleting old sign-in records", app.gate.run(() => sweepSignInRecords(app))],
		] as const;
		for (const [name, job] of jobs) {
			await job.catch((error: unknown) => console.error(`[mainworthy] ${name} failed:`, error));
		}
	};
	const timer = setInterval(() => void minute(), 60_000);
	const url = `http://${config.host === "0.0.0.0" || config.host === "::" ? "localhost" : config.host}:${server.port}`;
	let stopping: Promise<void> | null = null;
	return {
		...opened,
		url,
		minute,
		stop() {
			stopping ??= (async () => {
				clearInterval(timer);
				await server.stop(true);
				await app.readers?.stop();
				// No request is being served any more. What was noted since the last minute is written, so a
				// session used a moment ago is not found idle by the next start.
				await flushUses(app).catch((error: unknown) => console.error("[mainworthy] writing last uses failed:", error));
				await app.gate.run(() => undefined);
				app.close();
			})();
			return stopping;
		},
	};
}

export { VERSION };
