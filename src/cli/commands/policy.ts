import { Policy } from "../../core/kinds.ts";
import { PRESET_NAMES, presetOf } from "../../core/presets.ts";
import { assertPositionals } from "../args.ts";
import { CliError } from "../errors.ts";
import { line, printJson } from "../output.ts";
import type { AdapterCommand } from "./types.ts";

/** Policy is printed as its clause table, preserving order because the first matching clause wins. */
export function printPolicy(policy: Policy): void {
	line(`policy: ${presetOf(policy) ?? "custom"}`);
	const rows = [
		["kind", "when", "who answers", "agent's answer", "blocks", "rule's answer"],
		...policy.clauses.map((clause) => [
			clause.kind,
			clause.when.join(" & "),
			`${clause.ask.who}${clause.ask.notProducer ? ", not producer" : ""}${clause.ask.reason === "required" ? ", reason required" : ""}`,
			clause.ask.agents === "answer" ? "counts" : clause.ask.agents === "advise" ? "advice" : "refused",
			clause.blocks,
			clause.answer === undefined ? "" : JSON.stringify(clause.answer),
		]),
	];
	const widths = (rows[0] ?? []).map((_, index) => Math.max(...rows.map((row) => row[index]?.length ?? 0)));
	for (const row of rows)
		line(
			row
				.map((cell, index) => cell.padEnd(widths[index] ?? 0))
				.join("  ")
				.trimEnd(),
		);
	line(`basis: ${policy.settings.basis}; flaky hold: ${policy.settings.holds.flakyDays} days`);
}

export const policyCommand: AdapterCommand = {
	name: "policy",
	summary: "Show policy clauses or propose and record an admin's choice of preset.",
	usage: "policy show | policy use <loose|standard|strict> [--json]",
	flags: [],
	async run(args, client) {
		const action = args.positionals[0];
		if (action === "show") {
			assertPositionals(args, 1, 1, policyCommand.usage);
			const policy = Policy.parse(await client.call("admin", { do: "policy.show", project: await client.project() }));
			if (args.has("json")) printJson(policy, args.bool("compact"));
			else printPolicy(policy);
			return 0;
		}
		if (action !== "use") throw new CliError("invalid", `usage: casebook ${policyCommand.usage}`);
		assertPositionals(args, 2, 2, policyCommand.usage);
		const preset = args.positionals[1];
		if (!PRESET_NAMES.some((name) => name === preset))
			throw new CliError("invalid", "policy use needs loose, standard or strict");
		const proposal = await client.call("propose", {
			edits: [{ op: "policy", preset }],
			reason: `Use the ${preset} policy preset`,
		});
		let decision = null;
		if (proposal.status === "open" && proposal.question && proposal.proposal) {
			const question = (await client.call("inbox", { kind: "adopt", on: proposal.proposal })).items.find(
				(item) => item.q === proposal.question,
			);
			if (!question) throw new CliError("conflict", `${proposal.question} is no longer open`);
			if (question.you === "counts") {
				decision = await client.call("decide", {
					q: question.q,
					onEvidence: question.evidenceHash,
					answer: { is: "accept" },
					reason: `Use the ${preset} policy preset`,
				});
			}
		}
		if (args.has("json")) printJson({ proposal, decision }, args.bool("compact"));
		else if (decision?.some((reply) => reply.status === "decided" || reply.status === "already")) {
			line(`policy: ${preset}; proposal ${proposal.proposal} and decision ${decision[0]?.decision} are both recorded`);
		} else if (proposal.status === "adopted") line(`policy: ${preset}; proposal and decision are recorded`);
		else
			line(
				`policy proposal ${proposal.proposal}: ${proposal.status}${proposal.question ? ` ${proposal.question}` : ""}${proposal.needs ? ` needs ${proposal.needs}` : ""}`,
			);
		if (
			decision?.some(
				(reply) => reply.status === "forbidden" || reply.status === "invalid" || reply.status === "conflict",
			)
		) {
			throw new CliError("conflict", `${proposal.question} could not be decided; read it again before answering`);
		}
		return 0;
	},
};
