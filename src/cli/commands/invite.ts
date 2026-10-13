import { z } from "zod";
import { InvitationInput } from "../../core/people.ts";
import { assertPositionals } from "../args.ts";
import { CliError } from "../errors.ts";
import { line, printJson } from "../output.ts";
import type { AdapterCommand } from "./types.ts";

const Purpose = z.enum(["join", "recover"]);
const Created = z.object({
	id: z.number(),
	name: z.string(),
	purpose: Purpose,
	can: z.array(z.string()),
	project: z.string(),
	expiresAt: z.number(),
	code: z.string(),
	link: z.string(),
	note: z.string(),
});
const Listed = z.array(
	z.object({
		id: z.number(),
		name: z.string(),
		purpose: Purpose,
		createdBy: z.string(),
		expiresAt: z.number(),
		state: z.enum(["open", "used", "revoked", "expired"]),
		grants: z.array(z.object({ project: z.string(), can: z.array(z.string()) })),
	}),
);

/** A time as a person reads it in a terminal: the day and the minute, in UTC. */
const when = (at: number): string => `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;

export const inviteCommand: AdapterCommand = {
	name: "invite",
	summary: "Invite a person with a link that is shown once, list invitations, and revoke one.",
	usage: "invite new <name> [--can read,answer] [--project <key>] [--expires 3d] | invite list | invite revoke <id>",
	flags: [
		{
			name: "can",
			kind: "strings",
			description: "What a new person may do, comma-separated or repeated. Not for one who exists.",
		},
		{ name: "expires", kind: "string", description: "How long the link works: 12h, 3d, 2w. At most 30d." },
	],
	async run(args, client) {
		const action = args.positionals[0];
		if (action === "new") {
			assertPositionals(args, 2, 2, inviteCommand.usage);
			const input = InvitationInput.parse({
				do: "create",
				name: args.positionals[1],
				can: args.strings("can"),
				...(args.has("expires") ? { expires: args.value("expires") } : {}),
				...(client.options.project ? { project: client.options.project } : {}),
			});
			const result = Created.parse(await client.call("invitation", input));
			if (args.has("json")) printJson(result, args.bool("compact"));
			else {
				const what =
					result.purpose === "join"
						? `may ${result.can.join(", ") || "do nothing yet"} on ${result.project}`
						: `a recovery: accepting it replaces every way ${result.name} signs in`;
				line(`invitation ${result.id} for "${result.name}" (${what}), until ${when(result.expiresAt)}`);
				line(result.link);
				line(result.note);
			}
			return 0;
		}
		if (action === "list") {
			assertPositionals(args, 1, 1, inviteCommand.usage);
			const result = Listed.parse(await client.call("invitation", { do: "list" }));
			if (args.has("json")) printJson(result, args.bool("compact"));
			else if (result.length === 0) line("No invitations.");
			else
				for (const row of result)
					line(
						`${row.id}  ${row.name}  ${row.purpose}  ${row.state}  until ${when(row.expiresAt)}  by ${row.createdBy}  ${
							row.grants.map((grant) => `may ${grant.can.join(", ")} on ${grant.project}`).join("; ") || "no grant"
						}`,
					);
			return 0;
		}
		if (action === "revoke") {
			assertPositionals(args, 2, 2, inviteCommand.usage);
			const id = Number(args.positionals[1]);
			if (!Number.isInteger(id)) throw new CliError("invalid", `usage: mainworthy ${inviteCommand.usage}`);
			const result = z.object({ revoked: z.boolean() }).parse(await client.call("invitation", { do: "revoke", id }));
			if (args.has("json")) printJson(result, args.bool("compact"));
			else
				line(
					result.revoked
						? `invitation ${id} revoked`
						: `invitation ${id} was already used or revoked, or does not exist`,
				);
			return 0;
		}
		throw new CliError("invalid", `usage: mainworthy ${inviteCommand.usage}`);
	},
};
