import { join } from "node:path";
import { defaultConfig } from "../../server/kernel/app.ts";
import { findProject } from "../../server/kernel/ctx.ts";
import { currentPolicy } from "../../server/policy/policy.ts";
import { start, VERSION } from "../../server/start.ts";
import { archiveRoutes } from "../../surfaces/archive.ts";
import { mcpRoute } from "../../surfaces/mcp.ts";
import { type Args, assertPositionals } from "../args.ts";
import { printError } from "../errors.ts";
import { line } from "../output.ts";

/** Starts Local or Server with the UI, MCP and archive routes, and releases the listener/database on either signal. */
export function serveCommand(args: Args, ui: unknown): void {
	assertPositionals(args, 0, 0, "serve");
	const config = defaultConfig(process.env);
	const instance = start(config, (app) => ({ ui, routes: { "/mcp": mcpRoute(app), ...archiveRoutes(app) } }));
	const data = config.dataDir === join(process.env.HOME ?? ".", ".casebook") ? "~/.casebook" : config.dataDir;
	const owner = instance.owner.name.includes("@") ? instance.owner.name : `${instance.owner.name}@this-machine`;
	line(`Casebook ${VERSION} · ${config.mode} · data in ${data} · ${instance.url}`);
	const project = findProject(instance.app.db, instance.project);
	const policy = project ? currentPolicy(instance.app.db, project.id).preset : "unknown";
	line(`project "${instance.project}" · you are ${owner} · policy: ${policy}`);
	if (config.mode === "server" && instance.generatedToken) line(`owner token (shown once): ${instance.generatedToken}`);
	let stopping = false;
	const stop = (): void => {
		if (stopping) return;
		stopping = true;
		void instance.stop().then(
			() => {
				process.exitCode = 0;
			},
			(error: unknown) => {
				printError(error);
				process.exitCode = 4;
			},
		);
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
}
