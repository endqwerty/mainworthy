import { runStdio } from "../../surfaces/mcp.ts";
import { assertPositionals } from "../args.ts";
import type { AdapterCommand } from "./types.ts";

export const mcpCommand: AdapterCommand = {
	name: "mcp",
	summary: "Serve MCP on stdin/stdout, forwarding tools to the running HTTP server.",
	usage: "mcp",
	flags: [],
	async run(args, client) {
		assertPositionals(args, 0, 0, mcpCommand.usage);
		await runStdio(
			(op, project, input) => client.forward(op, project ?? client.options.project ?? null, input),
			async () =>
				client.options.project
					? [client.options.project]
					: (await client.session()).projects.map((project) => project.key),
		);
		return 0;
	},
};
