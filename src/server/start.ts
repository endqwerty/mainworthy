// Starting an instance: open the data, make sure an owner and a first project exist, finish interrupted work,
// then listen. The same function is the Local layer on a laptop and the Server layer in a container; only the
// configuration differs (decision 0002).
import { type Extra, type Patience, serve, VERSION } from "../surfaces/http.ts";
import { bootstrap, ruleActor } from "./identity/identity.ts";
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
	stop: () => Promise<void>;
};

/** Opens the instance without listening: for the CLI commands that work on the data directly, and for tests. */
export function open(
	config: Config,
	options: { memory?: boolean; firstProject?: string } = {},
): { app: App; owner: Actor; project: string; generatedToken: string | null; warnings: string[] } {
	const app = openApp(config, options.memory ? { memory: true } : {});
	try {
		const { owner, generatedToken, warnings } = bootstrap(app);
		let project = allProjects(app.db)[0]?.key;
		if (!project) {
			// Zero configuration to first value: a project exists before the first case is typed.
			project = options.firstProject ?? "scratch";
			app.db.transaction(() =>
				createProject({ app, actor: owner, now: app.now() }, { key: project ?? "scratch", preset: "loose" }),
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
	options: { firstProject?: string; readers?: number; patience?: Patience } = {},
): Instance {
	const count = readerCount({
		MAINWORTHY_READERS: options.readers === undefined ? process.env.MAINWORTHY_READERS : String(options.readers),
	});
	const opened = open(config, options);
	const { app, owner } = opened;
	recoverAccepted(app);
	const rule = ruleActor(app.db).id;
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
	const timer = setInterval(() => {
		app.gate.run(() => sweep(app, rule)).catch((error) => console.error("[mainworthy] sweep failed:", error));
	}, 60_000);
	const url = `http://${config.host === "0.0.0.0" || config.host === "::" ? "localhost" : config.host}:${server.port}`;
	let stopping: Promise<void> | null = null;
	return {
		...opened,
		url,
		stop() {
			stopping ??= (async () => {
				clearInterval(timer);
				await server.stop(true);
				await app.readers?.stop();
				await app.gate.run(() => undefined);
				app.close();
			})();
			return stopping;
		},
	};
}

export { VERSION };
