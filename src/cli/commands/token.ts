import { z } from "zod";
import { AdminInput } from "../../core/ops.ts";
import { assertPositionals } from "../args.ts";
import { CliError } from "../errors.ts";
import { line, printJson } from "../output.ts";
import type { AdapterCommand } from "./types.ts";

const CreatedToken = z.object({ actor: z.string(), token: z.string(), can: z.array(z.string()) });
const TokenList = z.array(
	z.object({ id: z.number(), actor: z.string(), kind: z.string(), label: z.string(), revoked: z.boolean() }),
);

export const tokenCommand: AdapterCommand = {
	name: "token",
	summary: "Issue, list and revoke actor tokens. A new secret is shown once.",
	usage:
		"token new --agent <name> | --ci <name> | --human <name> [--can read,produce] [--project <key>] | token list | token revoke <id>",
	flags: [
		{ name: "agent", kind: "string", description: "Issue a token for this agent." },
		{ name: "ci", kind: "string", description: "Issue a token for this CI producer." },
		{ name: "human", kind: "string", description: "Issue a token for this person." },
		{ name: "can", kind: "strings", description: "Capabilities, comma-separated or repeated." },
	],
	async run(args, client) {
		const action = args.positionals[0];
		if (action === "new") {
			assertPositionals(args, 1, 1, tokenCommand.usage);
			const kinds = ["agent", "ci", "human"].filter((kind) => args.has(kind));
			const kind = kinds[0];
			if (kinds.length !== 1 || kind === undefined)
				throw new CliError("invalid", "token new needs exactly one of --agent, --ci or --human");
			const input = AdminInput.parse({
				do: "token.create",
				kind,
				actor: args.value(kind),
				can: args.strings("can"),
				...(client.options.project ? { project: client.options.project } : {}),
			});
			const result = CreatedToken.parse(await client.call("admin", input));
			if (args.has("json"))
				printJson({ ...result, note: "Shown once. It will not be shown again." }, args.bool("compact"));
			else {
				line(`token for ${kind} "${result.actor}" (${result.can.join(", ")})`);
				line(result.token);
				line("Shown once. It will not be shown again.");
			}
			return 0;
		}
		if (action === "list") {
			assertPositionals(args, 1, 1, tokenCommand.usage);
			const result = TokenList.parse(await client.call("admin", { do: "token.list" }));
			if (args.has("json")) printJson(result, args.bool("compact"));
			else if (result.length === 0) line("No tokens.");
			else
				for (const token of result)
					line(`${token.id}  ${token.kind} ${token.actor}  ${token.label}  ${token.revoked ? "revoked" : "active"}`);
			return 0;
		}
		if (action === "revoke") {
			assertPositionals(args, 2, 2, tokenCommand.usage);
			const input = AdminInput.parse({ do: "token.revoke", id: Number(args.positionals[1]) });
			const result = z.object({ revoked: z.boolean() }).parse(await client.call("admin", input));
			if (args.has("json")) printJson(result, args.bool("compact"));
			else
				line(
					result.revoked
						? `token ${args.positionals[1]} revoked`
						: `token ${args.positionals[1]} was already revoked or does not exist`,
				);
			return 0;
		}
		throw new CliError("invalid", `usage: casebook ${tokenCommand.usage}`);
	},
};
