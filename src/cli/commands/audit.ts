import { z } from "zod";
import { verifyAudit } from "../../core/audit.ts";
import { writeFileStream } from "../archive-stream.ts";
import { assertPositionals } from "../args.ts";
import { CliError } from "../errors.ts";
import { line, printJson } from "../output.ts";
import type { AdapterCommand } from "./types.ts";

function time(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const number = /^\d+$/.test(value)
		? Number(value)
		: z.iso.datetime({ offset: true }).safeParse(value).success
			? Date.parse(value)
			: NaN;
	if (!Number.isSafeInteger(number) || number < 0)
		throw new CliError(
			"invalid",
			"audit dates must be nonnegative Unix milliseconds or ISO timestamps with a timezone",
		);
	return number;
}

export const auditCommand: AdapterCommand = {
	name: "audit",
	summary: "Export a project's audit history, or verify a saved audit file offline.",
	usage: "audit export --out <file> [--from <time>] [--to <time>] | audit verify <file>",
	flags: [
		{ name: "out", kind: "string", description: "Audit NDJSON destination." },
		{
			name: "from",
			kind: "string",
			description: "Inclusive start: Unix milliseconds or ISO timestamp with a timezone.",
		},
		{ name: "to", kind: "string", description: "Exclusive end: Unix milliseconds or ISO timestamp with a timezone." },
	],
	async run(args, client) {
		const action = args.positionals[0];
		if (action === "verify") {
			assertPositionals(args, 2, 2, auditCommand.usage);
			if (["out", "from", "to"].some((flag) => args.has(flag)))
				throw new CliError("invalid", "audit verify takes only a file and output flags");
			const file = Bun.file(args.positionals[1] ?? "");
			try {
				const bytes = await file.bytes();
				const summary = verifyAudit(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
				if (args.has("json")) printJson(summary, args.bool("compact"));
				else
					line(
						`verified ${summary.records} records for ${summary.project}; ${summary.unavailableDecisionEvidence} decisions lack a historical evidence hash; ${summary.beforeRangeReferences} references precede the range`,
					);
				return 0;
			} catch (error) {
				throw new CliError("invalid", error instanceof Error ? error.message : "cannot verify audit file");
			}
		}
		if (action !== "export") throw new CliError("invalid", auditCommand.usage);
		assertPositionals(args, 1, 1, auditCommand.usage);
		const out = args.value("out");
		if (!out) throw new CliError("invalid", "audit export needs --out <file>");
		const from = time(args.value("from"));
		const to = time(args.value("to"));
		const reply = await client.call("audit", {
			...(from === undefined ? {} : { from }),
			...(to === undefined ? {} : { to }),
		});
		try {
			const summary = verifyAudit(reply.ndjson);
			if (summary.project !== reply.project || summary.records !== reply.records || summary.sha256 !== reply.sha256)
				throw new Error("audit reply does not match its file");
		} catch (error) {
			throw new CliError("invalid", error instanceof Error ? error.message : "invalid audit reply");
		}
		await writeFileStream(out, new Blob([reply.ndjson]).stream());
		if (args.has("json")) printJson({ out, records: reply.records, sha256: reply.sha256 }, args.bool("compact"));
		else line(`exported ${reply.records} audit records to ${out}`);
		return 0;
	},
};
