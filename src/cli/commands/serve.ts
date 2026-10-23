import { startServing, VERSION } from "../../app/start.ts";
import { defaultConfig, defaultDataDir } from "../../server/kernel/app.ts";
import { findProject } from "../../server/kernel/ctx.ts";
import { adoptFormerInstall } from "../../server/kernel/former-name.ts";
import { currentPolicy, policyName } from "../../server/policy/policy.ts";
import { archiveRoutes } from "../../surfaces/archive.ts";
import { docsRoutes } from "../../surfaces/docs/site.ts";
import { mcpRoute } from "../../surfaces/mcp.ts";
import { type Args, assertPositionals } from "../args.ts";
import { printError } from "../errors.ts";
import { line, warning } from "../output.ts";

/** Starts Local or Server with the UI, MCP and archive routes, and releases the listener/database on either signal. */
export async function serveCommand(args: Args, ui: unknown): Promise<void> {
	assertPositionals(args, 0, 0, "serve");
	const config = defaultConfig(process.env);
	for (const step of adoptFormerInstall(config, process.env)) warning(`mainworthy: ${step}`);
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
	const project = await findProject(instance.app.db, instance.project);
	const policy = project ? policyName(await currentPolicy(instance.app.db, project.id)) : "unknown";
	line(`project "${instance.project}" · ${who} · policy: ${policy}`);
	if (config.mode === "server" && instance.generatedToken) line(`owner token (shown once): ${instance.generatedToken}`);
	for (const text of instance.warnings) warning(`mainworthy: ${text}`);
	// The demo refresh and the retired-demo cleanup are paused: on the instance's data one cleanup slice held the
	// server's thread for hours (#914). The demo stays as it is until they run off that thread.
	if (process.env.MAINWORTHY_DEMO)
		line(`demo "${process.env.MAINWORTHY_DEMO}" refresh is paused; the demo stays as it is (#914)`);
	let stopping = false;
	const stop = (): void => {
		if (stopping) return;
		stopping = true;
		// The process ends here and not when its event loop empties: under `bun --watch` (`bun run dev`) the file
		// watcher keeps the loop alive for good, and a server that had stopped would sit there ignoring the signal.
		void instance.stop().then(
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
