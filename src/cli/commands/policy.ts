import { Policy, Unlinked } from "../../core/kinds.ts";
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
	line(
		`basis: ${policy.settings.basis}; flaky hold: ${policy.settings.holds.flakyDays} days; tests with no case: ${policy.settings.unlinked}`,
	);
}

export const policyCommand: AdapterCommand = {
	name: "policy",
	summary:
		"Show policy clauses, or propose and record an admin's choice of preset or of what happens to a test with no case.",
	usage: "policy show | policy use <loose|standard|strict> | policy tests <ask|track|create> [--json]",
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
		if (action !== "use" && action !== "tests")
			throw new CliError("invalid", `usage: mainworthy ${policyCommand.usage}`);
		assertPositionals(args, 2, 2, policyCommand.usage);
		const chosen = args.positionals[1];
		// What is proposed, why, and how the result is named in the line printed.
		let change: { edit: { preset: string } | { unlinked: Unlinked }; reason: string; name: string };
		if (action === "use") {
			if (!PRESET_NAMES.some((name) => name === chosen))
				throw new CliError("invalid", "policy use needs loose, standard or strict");
			change = { edit: { preset: chosen ?? "" }, reason: `Use the ${chosen} policy preset`, name: `policy: ${chosen}` };
		} else {
			const unlinked = Unlinked.safeParse(chosen);
			if (!unlinked.success) throw new CliError("invalid", "policy tests needs ask, track or create");
			change = {
				edit: { unlinked: unlinked.data },
				reason: `Tests with no case: ${unlinked.data}`,
				name: `tests with no case: ${unlinked.data}`,
			};
		}
		const proposal = await client.call("propose", {
			edits: [{ op: "policy", ...change.edit }],
			reason: change.reason,
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
					reason: change.reason,
				});
			}
		}
		if (args.has("json")) printJson({ proposal, decision }, args.bool("compact"));
		else if (decision?.some((reply) => reply.status === "decided" || reply.status === "already")) {
			const ruled = decision[0]?.effects?.ruled;
			line(
				`${change.name}; proposal ${proposal.proposal} and decision ${decision[0]?.decision} are both recorded${typeof ruled === "number" ? `; ${ruled} open question${ruled === 1 ? "" : "s"} answered by the rule` : ""}`,
			);
		} else if (proposal.status === "adopted") line(`${change.name}; proposal and decision are recorded`);
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
