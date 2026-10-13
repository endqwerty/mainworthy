import { defaultConfig, defaultDataDir } from "../../server/kernel/app.ts";
import { findProject } from "../../server/kernel/ctx.ts";
import { adoptFormerInstall } from "../../server/kernel/former-name.ts";
import { currentPolicy, policyName } from "../../server/policy/policy.ts";
import { start, VERSION } from "../../server/start.ts";
import { archiveRoutes } from "../../surfaces/archive.ts";
import { mcpRoute } from "../../surfaces/mcp.ts";
import { type Args, assertPositionals } from "../args.ts";
import { printError } from "../errors.ts";
import { line, warning } from "../output.ts";

/** Starts Local or Server with the UI, MCP and archive routes, and releases the listener/database on either signal. */
export function serveCommand(args: Args, ui: unknown): void {
	assertPositionals(args, 0, 0, "serve");
	const config = defaultConfig(process.env);
	for (const step of adoptFormerInstall(config, process.env)) warning(`mainworthy: ${step}`);
	const instance = start(config, (app, owner) => ({
		ui,
		routes: { "/mcp": mcpRoute(app), ...archiveRoutes(app, owner) },
	}));
	const data = config.dataDir === defaultDataDir(process.env) ? "~/.mainworthy" : config.dataDir;
	const owner = instance.owner.name.includes("@") ? instance.owner.name : `${instance.owner.name}@this-machine`;
	line(`Mainworthy ${VERSION} · ${config.mode} · data in ${data} · ${instance.url}`);
	const project = findProject(instance.app.db, instance.project);
	const policy = project ? policyName(currentPolicy(instance.app.db, project.id)) : "unknown";
	line(`project "${instance.project}" · you are ${owner} · policy: ${policy}`);
	if (config.mode === "server" && instance.generatedToken) line(`owner token (shown once): ${instance.generatedToken}`);
	for (const text of instance.warnings) warning(`mainworthy: ${text}`);
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
