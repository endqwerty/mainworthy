import { z } from "zod";
import { ActorKind, Capability } from "../../core/kinds.ts";
import { AdminInput } from "../../core/ops.ts";
import { FORGET_NOTICE } from "../../core/people.ts";
import { TeamSource } from "../../core/teams.ts";
import { assertPositionals } from "../args.ts";
import { CliError } from "../errors.ts";
import { line, printJson } from "../output.ts";
import type { AdapterCommand } from "./types.ts";

const Actors = z.array(
	z.object({
		name: z.string(),
		kind: ActorKind,
		disabled: z.boolean(),
		teams: z.array(TeamSource).default([]),
		grants: z.array(z.object({ project: z.string(), can: z.array(Capability) })),
	}),
);

export const actorCommand: AdapterCommand = {
	name: "actor",
	summary: "List who may do what, change grants, and forget an actor's identity while keeping history.",
	usage:
		"actor list | actor grant <name> --can read,record [--project <key>] | actor ungrant <name> [--project <key>] | actor forget <name> --confirm <name>",
	flags: [
		{ name: "can", kind: "strings", description: "Capabilities, comma-separated or repeated." },
		{ name: "confirm", kind: "string", description: `Repeat the name to confirm forgetting. ${FORGET_NOTICE}` },
	],
	async run(args, client) {
		const action = args.positionals[0];
		// With no project named, a grant is the one on every project, shown as `*`.
		const project = client.options.project;
		if (action === "forget") {
			assertPositionals(args, 2, 2, actorCommand.usage);
			const name = z.string().parse(args.positionals[1]);
			const input = AdminInput.parse({ do: "actor.forget", name });
			if (args.value("confirm") !== name) {
				throw new CliError("invalid", `${FORGET_NOTICE} To confirm, repeat the name with --confirm ${name}`);
			}
			const result = z
				.object({ forgotten: z.string(), tokensRevoked: z.number() })
				.parse(await client.call("admin", input));
			if (args.has("json")) printJson(result, args.bool("compact"));
			else
				line(
					`Forgotten as ${result.forgotten}. ${result.tokensRevoked} ${result.tokensRevoked === 1 ? "token" : "tokens"} revoked. History and typed text stay.`,
				);
			return 0;
		}
		if (action === "list") {
			assertPositionals(args, 1, 1, actorCommand.usage);
			const actors = Actors.parse(await client.call("admin", { do: "actor.list" }));
			if (args.has("json")) printJson(actors, args.bool("compact"));
			else
				for (const actor of actors) {
					const who = `${actor.kind.padEnd(5)}  ${actor.name}${actor.disabled ? " (forgotten)" : ""}`;
					if (actor.grants.length === 0 && actor.teams.every((team) => team.grants.length === 0))
						line(`${who}  no grant`);
					for (const grant of actor.grants) line(`${who}  ${grant.project}  ${grant.can.join(", ")}`);
					for (const team of actor.teams)
						for (const grant of team.grants)
							line(`${who}  ${grant.project}  ${grant.can.join(", ")}  from team ${team.name}`);
				}
			return 0;
		}
		if (action === "grant") {
			assertPositionals(args, 2, 2, actorCommand.usage);
			const input = AdminInput.parse({
				do: "grant.set",
				actor: args.positionals[1],
				can: args.strings("can"),
				...(project ? { project } : {}),
			});
			const result = z
				.object({ actor: z.string(), project: z.string(), can: z.array(Capability) })
				.parse(await client.call("admin", input));
			if (args.has("json")) printJson(result, args.bool("compact"));
			else line(`${result.actor} on ${result.project}: ${result.can.join(", ")}`);
			return 0;
		}
		if (action === "ungrant") {
			assertPositionals(args, 2, 2, actorCommand.usage);
			const input = AdminInput.parse({
				do: "grant.remove",
				actor: args.positionals[1],
				...(project ? { project } : {}),
			});
			const result = z.object({ removed: z.boolean() }).parse(await client.call("admin", input));
			if (args.has("json")) printJson(result, args.bool("compact"));
			else
				line(
					result.removed
						? `${args.positionals[1]} holds no grant on ${project ?? "*"} any more`
						: `${args.positionals[1]} held no grant on ${project ?? "*"}`,
				);
			return 0;
		}
		throw new CliError("invalid", `usage: mainworthy ${actorCommand.usage}`);
	},
};
