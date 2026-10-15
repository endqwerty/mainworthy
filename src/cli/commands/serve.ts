import { defaultConfig, defaultDataDir } from "../../server/kernel/app.ts";
import { findProject } from "../../server/kernel/ctx.ts";
import { adoptFormerInstall } from "../../server/kernel/former-name.ts";
import { currentPolicy, policyName } from "../../server/policy/policy.ts";
import { start, VERSION } from "../../server/start.ts";
import { archiveRoutes } from "../../surfaces/archive.ts";
import { docsRoutes } from "../../surfaces/docs/site.ts";
import { mcpRoute } from "../../surfaces/mcp.ts";
import { type Args, assertPositionals } from "../args.ts";
import { refreshDemo } from "../demo.ts";
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
		open: docsRoutes(VERSION),
	}));
	const data = config.dataDir === defaultDataDir(process.env) ? "~/.mainworthy" : config.dataDir;
	// Local mode signs the owner in with no step, so the line says who you are. A server signs nobody in on its own.
	const who =
		config.mode === "server"
			? `owner ${instance.owner.name} · sign in with a token, a password or a passkey`
			: `you are ${instance.owner.name.includes("@") ? instance.owner.name : `${instance.owner.name}@this-machine`}`;
	line(`Mainworthy ${VERSION} · ${config.mode} · data in ${data} · ${instance.url}`);
	const project = findProject(instance.app.db, instance.project);
	const policy = project ? policyName(currentPolicy(instance.app.db, project.id)) : "unknown";
	line(`project "${instance.project}" · ${who} · policy: ${policy}`);
	if (config.mode === "server" && instance.generatedToken) line(`owner token (shown once): ${instance.generatedToken}`);
	for (const text of instance.warnings) warning(`mainworthy: ${text}`);
	// The demo is seeded again after the server listens, so a start is not held up by it (`src/cli/demo.ts`).
	const demo = process.env.MAINWORTHY_DEMO || undefined;
	if (demo) {
		const began = performance.now();
		void refreshDemo(instance, demo).then(
			(seeded) =>
				line(
					`demo "${demo}" seeded again in ${((performance.now() - began) / 1000).toFixed(1)} s: ${seeded.cases.length} cases, ${seeded.questions.length} questions`,
				),
			(error: unknown) =>
				warning(
					`mainworthy: demo "${demo}" was not seeded again: ${error instanceof Error ? error.message : String(error)}`,
				),
		);
	}
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
