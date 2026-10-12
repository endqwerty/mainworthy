import { assertPositionals } from "../args.ts";
import { CliError } from "../errors.ts";
import { line, printJson } from "../output.ts";
import type { AdapterCommand } from "./types.ts";

export const newCommand: AdapterCommand = {
	name: "new",
	summary: "Create a case from a canonical Markdown file or an outline on stdin.",
	usage: "new [file|-] [--json]",
	flags: [],
	async run(args, client) {
		assertPositionals(args, 0, 1, newCommand.usage);
		const file = args.positionals[0];
		const text = await (file && file !== "-" ? Bun.file(file) : Bun.stdin).text();
		if (!text.trim()) throw new CliError("invalid", "new needs a Markdown case or an outline on stdin");
		const content = text.startsWith("---") ? { md: text } : { outline: text };
		const proposal = await client.call("propose", { edits: [{ op: "create", ...content }] });
		if (args.has("json")) printJson(proposal, args.bool("compact"));
		else if (proposal.cases.length > 0) for (const created of proposal.cases) line(created.ref);
		else
			line(
				`${proposal.proposal}: ${proposal.status}${proposal.question ? ` ${proposal.question}` : ""}${proposal.needs ? ` needs ${proposal.needs}` : ""}`,
			);
		return 0;
	},
};
