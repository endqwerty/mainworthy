import { z } from "zod";
import { assertPositionals } from "../args.ts";
import { printJson, printMarkdown } from "../output.ts";
import type { AdapterCommand } from "./types.ts";

export const getCommand: AdapterCommand = {
	name: "get",
	summary: "Read a ref, or print a case's canonical Markdown with --md.",
	usage: "get <ref> [--md] [--json]",
	flags: [{ name: "md", kind: "boolean", description: "Print canonical case Markdown." }],
	async run(args, client) {
		assertPositionals(args, 1, 1, getCommand.usage);
		const result = await client.call("get", { refs: args.positionals, as: args.bool("md") ? "md" : "data" });
		if (args.bool("md") && !args.has("json")) {
			for (const row of z.array(z.object({ md: z.string() })).parse(result)) printMarkdown(row.md);
		} else printJson(result, args.bool("compact"));
		return 0;
	},
};
