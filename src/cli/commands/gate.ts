import { GateInput, type GateStatus } from "../../core/ops.ts";
import { EXIT_CODE } from "../../core/runs.ts";
import { assertPositionals } from "../args.ts";
import { CliError } from "../errors.ts";
import { line, printJson } from "../output.ts";
import { detectedTarget } from "../target.ts";
import type { AdapterCommand } from "./types.ts";

/** Gate output names what is missing and every blocking question; its verdict always determines exit 0–3. */
export function printGate(gate: GateStatus, url: string): void {
	const reason = gate.reason.replace(new RegExp(`^${gate.verdict}:\\s*`), "");
	line(`casebook gate    ${gate.verdict}: ${reason}${gate.url ? `  ${new URL(gate.url, `${url}/`).href}` : ""}`);
	for (const q of gate.open) line(`  ${q} needs an answer`);
}

export const gateCommand: AdapterCommand = {
	name: "gate",
	summary: "Check a commit, change or run. Exit 0 passed, 1 failed, 2 blocked, 3 pending.",
	usage: "gate [--commit <sha> | --run R-4 | --change pr:482] [--wait <seconds>] [--json]",
	flags: [
		{ name: "commit", kind: "string", description: "Commit to check. Defaults to CI/Git detection." },
		{ name: "run", kind: "string", description: "Run to check." },
		{ name: "change", kind: "string", description: "Change to check, for example pr:482." },
		{ name: "repo", kind: "string", description: "Repository, when the commit was reported for more than one." },
		{ name: "wait", kind: "number", description: "Poll pending evidence for at most this many seconds." },
	],
	async run(args, client) {
		assertPositionals(args, 0, 0, gateCommand.usage);
		if (["commit", "run", "change"].filter((name) => args.has(name)).length > 1)
			throw new CliError("invalid", "choose one of --commit, --run or --change");
		const wait = args.number("wait") ?? 0;
		if (wait < 0) throw new CliError("invalid", "--wait must be zero or a positive number of seconds");
		let commit = args.value("commit");
		// The same commit can exist in two repositories (a fork). When the commit is the one detected here, so is
		// the repository it was reported for; `--repo` names it otherwise.
		let repo = args.value("repo");
		if (!commit && !args.has("run") && !args.has("change")) {
			const detected = detectedTarget();
			commit = detected.target && "commit" in detected.target ? detected.target.commit : undefined;
			repo ??= detected.target && "commit" in detected.target ? detected.target.repo : undefined;
			if (!commit)
				throw new CliError(
					"invalid",
					`missing ${detected.missing.join(", ") || "commit"}; provide --commit <sha>, --run R-4 or --change pr:482`,
				);
		}
		const input = GateInput.parse({
			...(commit ? { commit } : {}),
			...(args.has("run") ? { run: args.value("run") } : {}),
			...(args.has("change") ? { change: args.value("change") } : {}),
			...(repo ? { repo } : {}),
		});
		const deadline = Date.now() + wait * 1000;
		let gate = await client.call("gate", input);
		while (gate.verdict === "pending" && Date.now() < deadline) {
			await Bun.sleep(Math.min(1000, Math.max(0, deadline - Date.now())));
			gate = await client.call("gate", input);
		}
		if (args.has("json")) printJson(gate, args.bool("compact"));
		else {
			printGate(gate, client.url);
			if (gate.verdict === "blocked" && gate.run) {
				let cursor: string | undefined;
				do {
					// The queue is the project's to read. A pipeline's token may not, and has what it needs above:
					// the verdict, the questions that are open, and the address where a person answers them.
					const questions = await client
						.call("inbox", { on: gate.run, kind: "failure", limit: 500, ...(cursor ? { cursor } : {}) })
						.catch((error: unknown) => {
							if (error instanceof CliError && error.code === "forbidden") return null;
							throw error;
						});
					if (questions === null) break;
					for (const question of questions.items)
						if (!gate.open.includes(question.q))
							line(`  ${question.q} ${JSON.stringify(question.title)} needs an answer`);
					cursor = questions.cursor ?? undefined;
				} while (cursor);
			}
		}
		return EXIT_CODE[gate.verdict];
	},
};
