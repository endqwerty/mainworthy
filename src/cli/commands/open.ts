import { assertPositionals } from "../args.ts";
import { line, printJson } from "../output.ts";
import type { AdapterCommand } from "./types.ts";

export const openCommand: AdapterCommand = {
	name: "open",
	summary: "Print the web UI URL of the running instance.",
	usage: "open [--json]",
	flags: [],
	async run(args, client) {
		assertPositionals(args, 0, 0, openCommand.usage);
		await client.session();
		if (args.has("json")) printJson({ url: client.url }, args.bool("compact"));
		else line(client.url);
		return 0;
	},
};
