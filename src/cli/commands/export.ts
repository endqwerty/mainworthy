import { writeFileStream } from "../archive-stream.ts";
import { assertPositionals } from "../args.ts";
import { readEnvelope, unwrap } from "../client.ts";
import { CliError } from "../errors.ts";
import { line, printJson } from "../output.ts";
import type { AdapterCommand } from "./types.ts";

export const exportCommand: AdapterCommand = {
	name: "export",
	summary: "Stream an instance or project archive to a file. A .gz suffix enables gzip.",
	usage: "export --out <file> [--project <key>] [--json]",
	flags: [{ name: "out", kind: "string", description: "Archive destination. Use .gz for gzip." }],
	async run(args, client) {
		assertPositionals(args, 0, 0, exportCommand.usage);
		const out = args.value("out");
		if (!out) throw new CliError("invalid", "export needs --out <file>");
		const project = args.value("project");
		if (project === "") throw new CliError("invalid", "export needs a nonempty project key");
		const response = await client.request(
			project === undefined ? "/api/export" : `/api/export?project=${encodeURIComponent(project)}`,
		);
		if (!response.ok) unwrap(await readEnvelope(response));
		if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/x-ndjson") {
			await response.body?.cancel();
			throw new CliError("internal", "the server did not return a Mainworthy archive (application/x-ndjson)");
		}
		if (!response.body) throw new CliError("internal", "the server returned no archive stream");
		const stream = out.endsWith(".gz") ? response.body.pipeThrough(new CompressionStream("gzip")) : response.body;
		await writeFileStream(out, stream);
		if (args.has("json")) printJson({ out }, args.bool("compact"));
		else line(`exported to ${out}`);
		return 0;
	},
};
