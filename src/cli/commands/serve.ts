import { startServing, VERSION } from "../../app/start.ts";
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

/** Starts Local or Server with the UI, MCP and archive routes, and releases the listener/database on either signal. */
export async function serveCommand(args: Args, ui: unknown): Promise<void> {
	assertPositionals(args, 0, 0, "serve");
	const config = defaultConfig(process.env);
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
	).finally(() => {
		process.removeListener("SIGINT", abortStartup);
		process.removeListener("SIGTERM", abortStartup);
	});
	const data = config.dataDir === defaultDataDir(process.env) ? "~/.mainworthy" : config.dataDir;
	// Local mode signs the owner in with no step, so the line says who you are. A server signs nobody in on its own.
	const who =
		config.mode === "server"
			? `owner ${instance.owner.name} · sign in with a token, a password or a passkey`
			: `you are ${instance.owner.name.includes("@") ? instance.owner.name : `${instance.owner.name}@this-machine`}`;
	line(`Mainworthy ${VERSION} · ${config.mode} · data in ${data} · ${instance.url}`);
	const policy = await instance.app.database.read(async (db) => {
		const project = await findProject(db, instance.project);
		return project ? policyName(await currentPolicy(db, project.id)) : "unknown";
	});
	line(`project "${instance.project}" · ${who} · policy: ${policy}`);
	if (config.mode === "server" && instance.generatedToken) line(`owner token (shown once): ${instance.generatedToken}`);
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
							.then(() => renewDemoWork(instance, demo, seeded))
							.catch((error: unknown) =>
								warning(`demo work renewal failed: ${error instanceof Error ? error.message : String(error)}`),
							);
					};
					renew();
					workTimer = setInterval(renew, DEMO_WORK.renewEveryMs);
					line(
						`demo "${demo}" ready for revision ${config.commit} in ${((performance.now() - began) / 1000).toFixed(1)} s: ${seeded.cases.length} cases, ${seeded.questions.length} questions`,
					);
				},
				(error: unknown) =>
					warning(
						`mainworthy: demo "${demo}" is not ready for this revision: ${error instanceof Error ? error.message : String(error)}`,
					),
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
		// The process ends here and not when its event loop empties: under `bun --watch` (`bun run dev`) the file
		// watcher keeps the loop alive for good, and a server that had stopped would sit there ignoring the signal.
		void refreshing
			.then(async () => {
				clearInterval(workTimer);
				await renewing;
				await cleaning;
				await instance.stop();
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
