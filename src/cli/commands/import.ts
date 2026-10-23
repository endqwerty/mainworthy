import { z } from "zod";
import { CaseImportFormat, parseCaseImport } from "../../surfaces/formats/cases.ts";
import { reportIdentifier } from "../../surfaces/formats/native.ts";
import { guardedInput } from "../archive-stream.ts";
import { assertPositionals } from "../args.ts";
import { readEnvelope, unwrap } from "../client.ts";
import { CliError, fileReadError } from "../errors.ts";
import { line, printJson } from "../output.ts";
import type { AdapterCommand } from "./types.ts";

const ImportResult = z.object({ rows: z.number(), tables: z.record(z.string(), z.number()), note: z.string() });

export const importCommand: AdapterCommand = {
	name: "import",
	summary: "Import an archive into a fresh instance, or propose cases from CSV, TestRail or Qase.",
	usage: "import <file> [--format csv|testrail|qase] [--case-prefix QASE] [--json]",
	flags: [
		{
			name: "format",
			kind: "string",
			description: "Case CSV format: csv, testrail or qase. Omit for a Mainworthy archive.",
		},
		{
			name: "case-prefix",
			kind: "string",
			description: "Qase source project key for foreign aliases. Defaults to QASE.",
		},
	],
	async run(args, client) {
		assertPositionals(args, 1, 1, importCommand.usage);
		const file = args.positionals[0] ?? "";
		if (args.has("format")) {
			const format = CaseImportFormat.safeParse(args.value("format"));
			if (!format.success) throw new CliError("invalid", "--format must be csv, testrail or qase");
			if (args.has("case-prefix") && format.data !== "qase")
				throw new CliError("invalid", "--case-prefix is for Qase CSV only");
			if (Bun.file(file).size > 32 * 1024 * 1024) throw new CliError("invalid", "case CSV is larger than 32 MB");
			let bytes: ArrayBuffer;
			try {
				bytes = await Bun.file(file).arrayBuffer();
			} catch (error) {
				throw fileReadError(reportIdentifier(file), error);
			}
			let edits: ReturnType<typeof parseCaseImport>;
			try {
				edits = parseCaseImport(
					new TextDecoder("utf-8", { fatal: true }).decode(bytes),
					format.data,
					args.value("case-prefix"),
				);
			} catch (error) {
				throw new CliError("invalid", error instanceof Error ? error.message : String(error));
			}
			const result = await client.call("propose", { edits, reason: `Import ${format.data} CSV` });
			if (args.has("json")) printJson(result, args.bool("compact"));
			else
				line(
					`${edits.length} cases: ${result.status}${result.proposal ? ` ${result.proposal}` : ""}${result.question ? ` ${result.question}` : ""}${result.needs ? ` needs ${result.needs}` : ""}`,
				);
			return result.status === "adopted" ? 0 : 2;
		}
		if (args.has("case-prefix")) throw new CliError("invalid", "--case-prefix needs --format qase");
		if (!(await Bun.file(file).exists())) throw new CliError("invalid", `archive file ${file} does not exist`);
		const input = Bun.file(file).stream();
		const body = file.endsWith(".gz") ? input.pipeThrough(new DecompressionStream("gzip")) : input;
		const upload = guardedInput(
			body,
			`${file.endsWith(".gz") ? "invalid gzip archive" : "cannot read archive"}: ${file}`,
		);
		let response: Response;
		try {
			response = await client.request("/api/import", {
				method: "POST",
				headers: { "content-type": "application/x-ndjson" },
				body: upload.body,
			});
		} catch (error) {
			throw upload.failure() ?? error;
		}
		if (!response.ok) unwrap(await readEnvelope(response));
		const failure = upload.failure();
		if (failure) throw failure;
		const result = ImportResult.parse(unwrap(await readEnvelope(response)));
		if (args.has("json")) printJson(result, args.bool("compact"));
		else {
			line(`imported ${result.rows.toLocaleString("en-US")} rows across ${Object.keys(result.tables).length} tables`);
			line(result.note);
		}
		return 0;
	},
};
