import { CheckInput } from "../../core/ops.ts";
import { assertPositionals } from "../args.ts";
import { line, printJson } from "../output.ts";
import type { AdapterCommand } from "./types.ts";

export const checkCommand: AdapterCommand = {
	name: "check",
	summary: "Print suite problems grouped by rule. Exit 0 with none, 1 with problems.",
	usage: "check [--limit <number>] [--json]",
	flags: [{ name: "limit", kind: "number", description: "Maximum problems to print." }],
	async run(args, client) {
		assertPositionals(args, 0, 0, checkCommand.usage);
		const result = await client.call(
			"check",
			CheckInput.parse({ ...(args.has("limit") ? { limit: args.number("limit") } : {}) }),
		);
		if (args.has("json")) printJson(result, args.bool("compact"));
		else if (result.problems.length === 0) line("No problems.");
		else {
			const rules = new Set(result.problems.map((problem) => problem.rule));
			for (const rule of rules) {
				line(`${rule} (${result.counts[rule] ?? 0})`);
				for (const problem of result.problems.filter((problem) => problem.rule === rule))
					line(`  ${problem.ref}: ${problem.message}`);
			}
		}
		return result.problems.length > 0 ? 1 : 0;
	},
};
