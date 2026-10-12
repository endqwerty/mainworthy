import { ReportInput, type ReportReceipt, type TargetIn } from "../../core/ops.ts";
import { parseJUnit } from "../../surfaces/formats/junit.ts";
import { assertPositionals } from "../args.ts";
import { line, printJson, warning } from "../output.ts";
import { detectedTarget, reportTarget, TARGET_FLAGS } from "../target.ts";
import type { AdapterCommand } from "./types.ts";

const count = (value: number): string => value.toLocaleString("en-US");

function identity(target: TargetIn | undefined, receipt: ReportReceipt): string {
	if (!target) return receipt.target;
	if ("session" in target) return `session "${target.session}" (no build identity)`;
	return `${target.commit.slice(0, 7)}${target.pr !== undefined ? `  pr #${target.pr}` : target.branch ? `  (${target.branch})` : ""}`;
}

/** Prints an immutable upload receipt, including each cause's recorded disposition and the evidence basis. */
export function printReceipt(input: {
	project: string;
	report: ReportInput;
	receipt: ReportReceipt;
	url: string;
}): void {
	const { report, receipt } = input;
	line(
		`casebook report  ${input.project} @ ${identity(report.target, receipt)}${report.attempt !== undefined ? `  attempt ${report.attempt}` : ""}${report.job ? `  job ${report.job}` : ""}`,
	);
	const counts = receipt.counts;
	line(
		`  ${count(counts.total)} results   ${count(counts.pass)} pass   ${count(counts.fail)} fail   ${count(counts.skip)} skip${counts.error ? `   ${count(counts.error)} error` : ""}${counts.blocked ? `   ${count(counts.blocked)} blocked` : ""}${receipt.gate?.run ? `  (${receipt.gate.run})` : ""}`,
	);
	for (const cause of receipt.questions) {
		const disposition =
			cause.how === "already decided"
				? `already decided by ${cause.by ?? "unknown"}: ${cause.answer ?? "unknown"}`
				: cause.how === "decided by rule"
					? `decided by rule ${cause.by ?? "policy"}: ${cause.answer ?? "unknown"}`
					: cause.how;
		line(
			`  ${count(cause.tests)} ${disposition}   ${cause.q} ${JSON.stringify(cause.title)}   (${count(cause.tests)} ${cause.tests === 1 ? "test" : "tests"})`,
		);
	}
	line(`  ${count(receipt.unlinked)} tests have no case (tracked)`);
	const basis =
		Object.entries(receipt.basis)
			.filter(([, value]) => value > 0)
			.map(([kind, value]) => `${kind} ${count(value)}`)
			.join(", ") || "none";
	line(
		`  basis: ${basis}${receipt.basis.assumed ? " (cases at their current version; add a version manifest for exact)" : ""}${receipt.basis.unresolved ? " (tests without a case or version)" : ""}`,
	);
	if (receipt.rejected.length > 0) {
		line(`  ${receipt.rejected.length} results rejected`);
		for (const rejected of receipt.rejected) warning(`result ${rejected.index + 1}: ${rejected.reason}`);
	}
	if (receipt.declined.length > 0) {
		line(`  ${receipt.declined.length} case/version claims declined; results kept without a case`);
		for (const declined of receipt.declined) warning(`result ${declined.index + 1}: ${declined.reason}`);
	}
	if (receipt.declined.length > 0) {
		line(`  ${receipt.declined.length} results recorded with no case`);
		for (const declined of receipt.declined) warning(`result ${declined.index + 1}: ${declined.reason}`);
	}
	const gate = receipt.gate;
	const reason = gate?.reason.replace(new RegExp(`^${gate.verdict}:\\s*`), "");
	line(
		gate
			? `casebook gate    ${gate.verdict}: ${reason}${gate.url ? `  ${new URL(gate.url, `${input.url}/`).href}` : ""}`
			: "casebook gate    pending: this session proves nothing about a build",
	);
	if (!receipt.fresh) line("  already received; nothing was written");
}

export const reportCommand: AdapterCommand = {
	name: "report",
	summary: "Upload JUnit files, detect the CI build, and print the receipt. Use gate to check the verdict.",
	usage: "report <files...> [--session <name>] [--run R-4] [--json]",
	flags: [
		...TARGET_FLAGS,
		{ name: "session", kind: "string", description: "Named test session with no build identity." },
		{ name: "run", kind: "string", description: "Planned run these results are for." },
		{ name: "job", kind: "string", description: "CI job name. Overrides detection." },
		{ name: "attempt", kind: "number", description: "Build attempt. Overrides detection." },
	],
	async run(args, client) {
		assertPositionals(args, 1, Number.POSITIVE_INFINITY, reportCommand.usage);
		const detected = detectedTarget();
		const target = reportTarget(args, detected);
		const results: ReportInput["results"] = [];
		for (const file of args.positionals) {
			const parsed = parseJUnit(await Bun.file(file).text(), { file });
			results.push(...parsed.results);
			for (const message of parsed.warnings) warning(message);
		}
		const job = args.value("job") ?? detected.job;
		const attempt = args.number("attempt") ?? detected.attempt;
		const report = ReportInput.parse({
			...(target ? { target } : {}),
			...(args.has("run") ? { run: args.value("run") } : {}),
			...(job !== null ? { job } : {}),
			...(attempt !== null ? { attempt } : {}),
			...(detected.buildUrl ? { buildUrl: detected.buildUrl } : {}),
			results,
		});
		const receipt = await client.call("report", report);
		if (args.has("json")) printJson(receipt, args.bool("compact"));
		else printReceipt({ project: await client.project(), report, receipt, url: client.url });
		return 0;
	},
};
