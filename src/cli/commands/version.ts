import { API_VERSION, VERSION } from "../../core/version.ts";
import { assertPositionals } from "../args.ts";
import { line, printJson } from "../output.ts";
import type { AdapterCommand } from "./types.ts";

export const versionCommand: AdapterCommand = {
	name: "version",
	summary: "Print the CLI version and the API version it requires. No server is contacted.",
	usage: "version [--json]",
	flags: [],
	async run(args) {
		assertPositionals(args, 0, 0, versionCommand.usage);
		if (args.has("json")) printJson({ version: VERSION, apiVersion: API_VERSION }, args.bool("compact"));
		else line(`Mainworthy ${VERSION} (API ${API_VERSION})`);
		return 0;
	},
};
