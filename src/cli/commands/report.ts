import { ReportInput, type ReportReceipt, type TargetIn } from "../../core/ops.ts";
import { parseReport, ReportFormat } from "../../surfaces/formats/report.ts";
import { assertPositionals } from "../args.ts";
import { CliError } from "../errors.ts";
import { line, printJson, warning } from "../output.ts";
import { loadReportAttachments } from "../report-attachments.ts";
import { detectedTarget, reportRoot, reportTarget, TARGET_FLAGS } from "../target.ts";
import type { AdapterCommand } from "./types.ts";

const count = (value: number): string => value.toLocaleString("en-US");
const plural = (value: number, one: string, many = `${one}s`): string => `${count(value)} ${value === 1 ? one : many}`;

function identity(target: TargetIn | undefined, receipt: ReportReceipt): string {
	if (!target) return receipt.target;
	if ("session" in target) return `session "${target.session}" (no build identity)`;
	if ("build" in target) return `build "${target.build}"${target.env ? ` (${target.env})` : ""}`;
	return `${target.commit.slice(0, 7)}${target.pr !== undefined ? `  pr #${target.pr}` : target.branch ? `  (${target.branch})` : ""}`;
}

/** Prints an immutable upload receipt, including each cause's recorded disposition and the evidence basis. */
export function printReceipt(input: {
	project: string;
	report: ReportInput;
	receipt: ReportReceipt & { skippedAttachments?: number };
	url: string;
}): void {
	const { report, receipt } = input;
	line(
		`mainworthy report  ${input.project} @ ${identity(report.target, receipt)}${report.attempt !== undefined ? `  attempt ${report.attempt}` : ""}${report.job ? `  job ${report.job}` : ""}${report.shard ? `  shard ${report.shard.index}/${report.shard.of}` : ""}`,
	);
	const counts = receipt.counts;
	line(
		`  ${plural(counts.total, "result")}   ${count(counts.pass)} pass   ${count(counts.fail)} fail   ${count(counts.skip)} skip${counts.error ? `   ${count(counts.error)} error` : ""}${counts.blocked ? `   ${count(counts.blocked)} blocked` : ""}${receipt.gate?.run ? `  (${receipt.gate.run})` : ""}`,
	);
	for (const cause of receipt.questions) {
		const disposition =
			cause.how === "already decided"
				? `already decided by ${cause.by ?? "unknown"}: ${cause.answer ?? "unknown"}`
				: cause.how === "decided by rule"
					? `decided by rule ${cause.by ?? "policy"}: ${cause.answer ?? "unknown"}`
					: cause.how;
		line(
			`  ${count(cause.tests)} ${disposition}   ${cause.q} ${JSON.stringify(cause.title)}   (${plural(cause.tests, "test")})`,
		);
	}
	line(`  ${plural(receipt.unlinked, "result")} had no case or version when recorded`);
	const basis =
		Object.entries(receipt.basis)
			.filter(([, value]) => value > 0)
			.map(
				([kind, value]) =>
					`${kind} ${plural(value, "result")}${kind === "assumed" ? ` (case ${value === 1 ? "version" : "versions"} current when recorded; add a version manifest for exact)` : kind === "unresolved" ? " (no case or version when recorded)" : ""}`,
			)
			.join(", ") || "none";
	line(`  basis: ${basis}`);
	if (receipt.rejected.length > 0) {
		line(`  ${plural(receipt.rejected.length, "result")} rejected`);
		for (const rejected of receipt.rejected) warning(`result ${rejected.index + 1}: ${rejected.reason}`);
	}
	if (receipt.declined.length > 0) {
		line(
			`  ${plural(receipt.declined.length, "case/version claim")} declined; ${plural(receipt.declined.length, "result")} kept without a case`,
		);
		for (const declined of receipt.declined) warning(`result ${declined.index + 1}: ${declined.reason}`);
	}
	if (receipt.skippedAttachments)
		line(`  ${plural(receipt.skippedAttachments, "attachment")} skipped; ${plural(counts.total, "result")} kept`);
	const gate = receipt.gate;
	const reason = gate?.reason.replace(new RegExp(`^${gate.verdict}:\\s*`), "");
	line(
		gate
			? `mainworthy gate    ${gate.verdict}: ${reason}${gate.url ? `  ${new URL(gate.url, `${input.url}/`).href}` : ""}`
			: report.target && "build" in report.target
				? "mainworthy gate    pending: use gate --run with a planned release run"
				: "mainworthy gate    pending: this session proves nothing about a build",
	);
	if (!receipt.fresh) line("  already received; nothing was written");
}

export const reportCommand: AdapterCommand = {
	name: "report",
	summary:
		"Upload test reports or declare no tests required, detect the CI build, and print the receipt. Use gate to check the verdict.",
	usage:
		"report <files...> [--format <format>] [--session <name>] [--run R-4] | report --nothing-required [--commit <sha>] [--json]",
	flags: [
		...TARGET_FLAGS,
		{
			name: "format",
			kind: "string",
			description: "Report format: auto (default), junit, playwright, jest, vitest, pytest (pytest-json-report), trx.",
		},
		{
			name: "attachments",
			kind: "string",
			description:
				"Read JUnit attachment files inside this directory. Unavailable or disallowed files are skipped with a warning.",
		},
		{ name: "build", kind: "string", description: "Announced build label. Overrides CI/Git detection." },
		{ name: "session", kind: "string", description: "Named test session with no build identity." },
		{ name: "run", kind: "string", description: "Planned run these results are for." },
		{ name: "job", kind: "string", description: "CI job name. Overrides detection." },
		{ name: "attempt", kind: "number", description: "Build attempt. Overrides detection." },
		{
			name: "shard",
			kind: "string",
			description:
				"This report is one shard of its job, as index/count, for example 2/6. The commit's gate waits for every shard.",
		},
		{
			name: "nothing-required",
			kind: "boolean",
			description: "CI declares this commit requires no tests, if its policy allows. No files.",
		},
	],
	async run(args, client) {
		const nothingRequired = args.bool("nothing-required");
		assertPositionals(
			args,
			nothingRequired ? 0 : 1,
			nothingRequired ? 0 : Number.POSITIVE_INFINITY,
			reportCommand.usage,
		);
		if (nothingRequired && args.has("run"))
			throw new CliError("invalid", "nothing required is a declaration about a commit, not a planned run");
		const detected = detectedTarget();
		const target = reportTarget(args, detected);
		const results: ReportInput["results"] = [];
		const format = ReportFormat.parse(args.value("format") ?? "auto");
		const rootDir = reportRoot();
		const attachmentBudget = { bytes: 0, files: 0 };
		let skippedAttachments = 0;
		for (const file of args.positionals) {
			const parsed = parseReport(await Bun.file(file).text(), { file, format, rootDir });
			const loaded = loadReportAttachments(parsed, file, args.value("attachments"), attachmentBudget);
			results.push(...loaded.results);
			skippedAttachments += loaded.skipped;
			for (const message of loaded.warnings) warning(message);
			for (const message of parsed.warnings) warning(message);
		}
		if (skippedAttachments && !args.has("attachments"))
			warning(
				"Attachment markers ignored; use --attachments <directory> to permit reading local files. Results are kept.",
			);
		const job = args.value("job") ?? detected.job;
		const attempt = args.number("attempt") ?? detected.attempt;
		const shardText = args.value("shard");
		const shardMatch = shardText === undefined ? null : /^(\d+)\/(\d+)$/.exec(shardText);
		if (shardText !== undefined && !shardMatch)
			throw new CliError("invalid", `--shard takes index/count, for example 2/6, not "${shardText}"`);
		const report = ReportInput.parse({
			...(target ? { target } : {}),
			...(args.has("run") ? { run: args.value("run") } : {}),
			...(job !== null ? { job } : {}),
			...(attempt !== null ? { attempt } : {}),
			...(shardMatch ? { shard: { index: Number(shardMatch[1]), of: Number(shardMatch[2]) } } : {}),
			...(detected.buildUrl ? { buildUrl: detected.buildUrl } : {}),
			results,
			...(nothingRequired ? { nothingRequired: true } : {}),
		});
		const receipt = { ...(await client.call("report", report)), skippedAttachments };
		// A repeat is answered with the receipt of the first upload, gate line included. That is how a lost reply is
		// recovered; the gate may have moved since, and the receipt cannot know.
		if (!receipt.fresh) {
			warning(
				"mainworthy: this report was received before. Its receipt, and the gate line in it, are as they were then; `mainworthy gate` says what the verdict is now.",
			);
		}
		if (args.has("json")) printJson(receipt, args.bool("compact"));
		else printReceipt({ project: await client.project(), report, receipt, url: client.url });
		return 0;
	},
};
