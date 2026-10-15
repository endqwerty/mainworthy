import { CsvImportInput } from "../../core/csv.ts";
import { assertPositionals } from "../args.ts";
import { CliError } from "../errors.ts";
import { line, printJson } from "../output.ts";
import type { AdapterCommand } from "./types.ts";

export const csvImportCommand: AdapterCommand = {
	name: "import-csv",
	summary: "Preview a mapped CSV file, then import it with the preview's confirmation.",
	usage:
		"import-csv <file> [--mapping '<column mapping JSON>'] [--preset testrail] [--confirm hash] [--cmd id] [--json]",
	flags: [
		{
			name: "mapping",
			kind: "string",
			description: "Column mapping JSON. Required unless --preset testrail is given.",
		},
		{ name: "preset", kind: "string", description: "testrail uses the documented TestRail column names." },
		{ name: "confirm", kind: "string", description: "The confirmation returned by the preview. Omit to preview." },
		{ name: "cmd", kind: "string", description: "An idempotency key for retrying this request." },
	],
	async run(args, client) {
		assertPositionals(args, 1, 1, csvImportCommand.usage);
		const file = Bun.file(args.positionals[0] ?? "");
		if (!(await file.exists())) throw new CliError("invalid", "CSV file does not exist");
		if (file.size > 8 * 1024 * 1024) throw new CliError("invalid", "CSV is larger than 8 MB");
		let csv: string;
		try {
			csv = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
		} catch {
			throw new CliError("invalid", "CSV file must be readable UTF-8 text");
		}
		let mapping: unknown;
		try {
			mapping = args.has("mapping") ? JSON.parse(args.value("mapping") ?? "") : undefined;
		} catch {
			throw new CliError("invalid", "--mapping needs a JSON column mapping");
		}
		const parsed = CsvImportInput.safeParse({
			csv,
			mapping,
			preset: args.value("preset"),
			confirm: args.value("confirm"),
			cmd: args.value("cmd"),
		});
		if (!parsed.success) throw new CliError("invalid", parsed.error.issues.map((issue) => issue.message).join("; "));
		const result = await client.call("import-csv", parsed.data);
		if (args.has("json")) printJson(result, args.bool("compact"));
		else {
			line(`${result.create} cases ready, ${result.refused} refused`);
			for (const row of result.rows) {
				line(`record ${row.record}: ${row.alias ?? "no id"} · ${row.body?.title ?? "refused"} · ${row.folder}`);
				for (const error of row.errors) line(`  ${error}`);
			}
			if (result.proposal)
				line(
					`${result.proposal.status}: ${result.proposal.proposal}${result.proposal.needs ? ` needs ${result.proposal.needs}` : ""}`,
				);
			else if (result.confirmation)
				line(`Preview only. Review the mapped cases with --json, then repeat with --confirm ${result.confirmation}`);
		}
		return result.refused || (result.proposal && result.proposal.status !== "adopted") ? 2 : 0;
	},
};
