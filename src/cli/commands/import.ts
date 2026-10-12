import { z } from "zod";
import { guardedInput } from "../archive-stream.ts";
import { assertPositionals } from "../args.ts";
import { readEnvelope, unwrap } from "../client.ts";
import { CliError } from "../errors.ts";
import { line, printJson } from "../output.ts";
import type { AdapterCommand } from "./types.ts";

const ImportResult = z.object({ rows: z.number(), tables: z.record(z.string(), z.number()), note: z.string() });

export const importCommand: AdapterCommand = {
	name: "import",
	summary: "Stream an archive into a fresh instance, replacing its bootstrap rows. Supports gzip.",
	usage: "import <file> [--json]",
	flags: [],
	async run(args, client) {
		assertPositionals(args, 1, 1, importCommand.usage);
		const file = args.positionals[0] ?? "";
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
