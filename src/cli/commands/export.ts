import { writeFileStream } from "../archive-stream.ts";
import { assertPositionals } from "../args.ts";
import { readEnvelope, unwrap } from "../client.ts";
import { CliError } from "../errors.ts";
import { line, printJson } from "../output.ts";
import type { AdapterCommand } from "./types.ts";

export const exportCommand: AdapterCommand = {
	name: "export",
	summary: "Stream the instance's lossless archive to a file. A .gz suffix enables gzip.",
	usage: "export --out <file> [--json]",
	flags: [{ name: "out", kind: "string", description: "Archive destination. Use .gz for gzip." }],
	async run(args, client) {
		assertPositionals(args, 0, 0, exportCommand.usage);
		const out = args.value("out");
		if (!out) throw new CliError("invalid", "export needs --out <file>");
		const response = await client.request("/api/export");
		if (!response.ok) unwrap(await readEnvelope(response));
		if (!response.body) throw new CliError("internal", "the server returned no archive stream");
		const stream = out.endsWith(".gz") ? response.body.pipeThrough(new CompressionStream("gzip")) : response.body;
		await writeFileStream(out, stream);
		if (args.has("json")) printJson({ out }, args.bool("compact"));
		else line(`exported to ${out}`);
		return 0;
	},
};
