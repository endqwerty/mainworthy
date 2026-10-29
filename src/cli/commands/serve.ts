import { startServing, VERSION } from "../../app/start.ts";
import { startTelemetry, telemetrySettings } from "../../app/telemetry.ts";
import { defaultConfig, defaultDataDir } from "../../server/kernel/app.ts";
import { findProject } from "../../server/kernel/ctx.ts";
import { currentPolicy, policyName } from "../../server/policy/policy.ts";
import { archiveRoutes } from "../../surfaces/archive.ts";
import { docsRoutes } from "../../surfaces/docs/site.ts";
import { mcpRoute } from "../../surfaces/mcp.ts";
import { type Args, assertPositionals } from "../args.ts";
import { DEMO_WORK } from "../demo/work.ts";
import { drainRetiredDemos, refreshDemo, renewDemoWork } from "../demo.ts";
import { printError } from "../errors.ts";
import { line, warning } from "../output.ts";

/** How long a stopping server waits for its work before it exits anyway: well inside Cloud Run's ten seconds. */
const STOP_DEADLINE_MS = 7_000;
/** How long a stopping server tries to send its last traces: a collector that does not answer costs no more. */
const TELEMETRY_STOP_MS = 2_000;

/** Starts Local or Server with the UI, MCP and archive routes, and releases the listener/database on either signal. */
export async function serveCommand(args: Args, ui: unknown): Promise<void> {
	assertPositionals(args, 0, 0, "serve");
	const config = defaultConfig(process.env);
	const telemetry = startTelemetry(telemetrySettings(process.env), config.commit);
	const startup = new AbortController();
	const abortStartup = () => startup.abort(new Error("startup stopped"));
	process.once("SIGINT", abortStartup);
	process.once("SIGTERM", abortStartup);
	const instance = await startServing(
		config,
		(app, owner) => ({
			ui,
			routes: { "/mcp": mcpRoute(app), ...archiveRoutes(app, owner) },
			open: docsRoutes(VERSION),
		}),
		{ signal: startup.signal },
	)
		.catch(async (error: unknown) => {
			await telemetry?.stop(TELEMETRY_STOP_MS);
			throw error;
		})
		.finally(() => {
			process.removeListener("SIGINT", abortStartup);
			process.removeListener("SIGTERM", abortStartup);
		});
	const data = config.dataDir === defaultDataDir(process.env) ? "~/.mainworthy" : config.dataDir;
	// Local mode signs the owner in with no step, so the line says who you are. A server signs nobody in on its own.
	const who =
		config.mode === "server"
			? `owner ${instance.owner.name} · sign in with a token${config.oidc ? ` or through ${config.oidc.name}` : ""}`
			: `you are ${instance.owner.name.includes("@") ? instance.owner.name : `${instance.owner.name}@this-machine`}`;
	line(`Mainworthy ${VERSION} · ${config.mode} · data in ${data} · ${instance.url}`);
	const policy = await instance.app.database.read(async (db) => {
		const project = await findProject(db, instance.project);
		return project ? policyName(await currentPolicy(db, project.id)) : "unknown";
	});
	line(`project "${instance.project}" · ${who} · policy: ${policy}`);
	if (config.mode === "server" && instance.generatedToken) line(`owner token (shown once): ${instance.generatedToken}`);
	if (telemetry) line(`traces go to ${telemetry.origin}`);
	for (const text of instance.warnings) warning(`mainworthy: ${text}`);
	// Deployment work starts after listening. Durable revision state makes a same-build restart a no-op. Each cleanup
	// slice is bounded by the retired project's own rows, whatever the other projects hold (#914).
	const demo = process.env.MAINWORTHY_DEMO || undefined;
	const refreshController = new AbortController();
	const cleanup = () =>
		drainRetiredDemos(instance, { signal: refreshController.signal }).catch((error: unknown) => {
			if (!refreshController.signal.aborted)
				warning(`retired demo cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
		});
	let cleaning = cleanup();
	let refreshing: Promise<void> = Promise.resolve();
	let workTimer: ReturnType<typeof setInterval> | undefined;
	let renewing: Promise<void> = Promise.resolve();
	if (demo) {
		const began = performance.now();
		refreshing = refreshDemo(instance, demo, undefined, { signal: refreshController.signal })
			.then(
				(seeded) => {
					const renew = () => {
						renewing = renewing
							.then(() => renewDemoWork(instance, demo, seeded, refreshController.signal))
							.catch((error: unknown) => {
								if (!refreshController.signal.aborted)
									warning(`demo work renewal failed: ${error instanceof Error ? error.message : String(error)}`);
							});
					};
					renew();
					workTimer = setInterval(renew, DEMO_WORK.renewEveryMs);
					line(
						`demo "${demo}" ready for revision ${config.commit} in ${((performance.now() - began) / 1000).toFixed(1)} s: ${seeded.cases.length} cases, ${seeded.questions.length} questions`,
					);
				},
				(error: unknown) => {
					if (!refreshController.signal.aborted)
						warning(
							`mainworthy: demo "${demo}" is not ready for this revision: ${error instanceof Error ? error.message : String(error)}`,
						);
				},
			)
			.finally(() => {
				cleaning = cleanup();
			});
	}
	let stopping = false;
	const stop = (): void => {
		if (stopping) return;
		stopping = true;
		refreshController.abort(new Error("server stopping"));
		clearInterval(workTimer);
		// The abort cancels the demo work's statements, also one waiting for a lock, so it ends at once. The deadline is
		// for what the abort does not reach, such as a request still being served, before Cloud Run's SIGKILL ten
		// seconds after SIGTERM. What runs then is left to the database, which rolls back the open transactions when the
		// connections close; demo state is disposable (#914).
		let running = "the demo refresh";
		setTimeout(() => {
			warning(
				`mainworthy: stopping took longer than ${STOP_DEADLINE_MS / 1000} s; exiting with ${running} still running`,
			);
			process.exit(4);
		}, STOP_DEADLINE_MS);
		// The process ends here and not when its event loop empties: under `bun --watch` (`bun run dev`) the file
		// watcher keeps the loop alive for good, and a server that had stopped would sit there ignoring the signal.
		void refreshing
			.then(async () => {
				clearInterval(workTimer);
				running = "demo work renewal";
				await renewing;
				running = "retired demo cleanup";
				await cleaning;
				running = "the server's own shutdown";
				await instance.stop();
				running = "sending the last traces";
				await telemetry?.stop(TELEMETRY_STOP_MS);
			})
			.then(
				() => process.exit(0),
				(error: unknown) => {
					printError(error);
					process.exit(4);
				},
			);
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
}
