import { z } from "zod";
import { untilPhrase } from "../../core/duration.ts";
import { AdminInput } from "../../core/ops.ts";
import { assertPositionals } from "../args.ts";
import { CliError } from "../errors.ts";
import { line, printJson } from "../output.ts";
import type { AdapterCommand } from "./types.ts";

const CreatedToken = z.object({
	actor: z.string(),
	token: z.string(),
	can: z.array(z.string()),
	expiresAt: z.number().nullable(),
});
const ListedToken = z.object({
	id: z.number(),
	actor: z.string(),
	kind: z.string(),
	label: z.string(),
	revoked: z.boolean(),
	expired: z.boolean(),
	expiresAt: z.number().nullable(),
	createdBy: z.string().nullable(),
	lastUsedAt: z.number().nullable(),
	lastUsedFrom: z.string().nullable(),
});
type ListedToken = z.infer<typeof ListedToken>;

/**
 * Whether a token works, in a few words. `expired` is the server's word, by its own clock. How long is left is
 * counted on this machine's, so a clock that is off here changes the count and never the verdict.
 */
function standing(token: ListedToken): string {
	if (token.revoked) return "revoked";
	if (token.expired) return "expired";
	const left = token.expiresAt === null ? null : untilPhrase(token.expiresAt, Date.now());
	return left ? `active, expires ${left}` : "active";
}

/** One token as a line of the list: what it is, whether it works, who made it and where it was last used from. */
function listed(token: ListedToken): string {
	return [
		`${token.id}`,
		`${token.kind} ${token.actor}`,
		token.label,
		standing(token),
		...(token.createdBy === null ? [] : [`made by ${token.createdBy}`]),
		...(token.lastUsedFrom === null ? [] : [`last used from ${token.lastUsedFrom}`]),
	].join("  ");
}

export const tokenCommand: AdapterCommand = {
	name: "token",
	summary:
		"Issue, list and revoke actor tokens. Each carries its actor's current grants on every project. A new secret is shown once.",
	usage:
		"token new --agent <name> | --ci <name> | --human <name> [--can read,produce] [--project <key>] [--expires 90d] | token list | token revoke <id>",
	flags: [
		{ name: "agent", kind: "string", description: "Issue a token for this agent." },
		{
			name: "ci",
			kind: "string",
			description: "Issue a token for this pipeline: it records results and reads the gate.",
		},
		{ name: "human", kind: "string", description: "Issue a token for this person." },
		{
			name: "can",
			kind: "strings",
			description: "What a new actor may do, comma-separated or repeated. Not for one that exists.",
		},
		{
			name: "expires",
			kind: "string",
			description: "How long the new token works: 90d, 12h, 2w. Without it the token has no end.",
		},
	],
	async run(args, client) {
		const action = args.positionals[0];
		if (action === "new") {
			assertPositionals(args, 1, 1, tokenCommand.usage);
			const kinds = ["agent", "ci", "human"].filter((kind) => args.has(kind));
			const kind = kinds[0];
			if (kinds.length !== 1 || kind === undefined)
				throw new CliError("invalid", "token new needs exactly one of --agent, --ci or --human");
			const expires = args.value("expires");
			const input = AdminInput.parse({
				do: "token.create",
				kind,
				actor: args.value(kind),
				can: args.strings("can"),
				...(client.options.project ? { project: client.options.project } : {}),
				...(expires === undefined ? {} : { expires }),
			});
			const result = CreatedToken.parse(await client.call("admin", input));
			if (args.has("json"))
				printJson({ ...result, note: "Shown once. It will not be shown again." }, args.bool("compact"));
			else {
				const left = result.expiresAt === null ? null : untilPhrase(result.expiresAt, Date.now());
				line(`token for ${kind} "${result.actor}" (${result.can.join(", ")})${left ? `, expires ${left}` : ""}`);
				line(result.token);
				line("Shown once. It will not be shown again.");
			}
			return 0;
		}
		if (action === "list") {
			assertPositionals(args, 1, 1, tokenCommand.usage);
			const result = z.array(ListedToken).parse(await client.call("admin", { do: "token.list" }));
			if (args.has("json")) printJson(result, args.bool("compact"));
			else if (result.length === 0) line("No tokens.");
			else for (const token of result) line(listed(token));
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
		throw new CliError("invalid", `usage: mainworthy ${tokenCommand.usage}`);
	},
};
