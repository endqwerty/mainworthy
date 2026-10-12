import { parseCase, printCase } from "../../core/markdown.ts";
import { assertPositionals } from "../args.ts";
import { CliError } from "../errors.ts";
import { printJson } from "../output.ts";
import type { AdapterCommand } from "./types.ts";

export const fmtCommand: AdapterCommand = {
	name: "fmt",
	summary: "Print canonical case Markdown. Parse errors include source line numbers.",
	usage: "fmt <file> [--json]",
	flags: [],
	async run(args) {
		assertPositionals(args, 1, 1, fmtCommand.usage);
		const file = args.positionals[0] ?? "";
		const parsed = parseCase(await Bun.file(file).text());
		if (!parsed.ok)
			throw new CliError("invalid", parsed.errors.map((error) => `${file}:${error.line}: ${error.message}`).join("; "));
		const md = printCase(parsed.doc);
		if (args.has("json")) printJson({ md }, args.bool("compact"));
		else process.stdout.write(md);
		return 0;
	},
};
