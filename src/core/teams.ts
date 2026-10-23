import { z } from "zod";
import { Capability } from "./kinds.ts";

const name = z.string().trim().min(1).max(64);
const cmd = z.string().min(8).max(64).optional();
const team = name;
const project = z.string().optional().describe("The project key. Absent: every project.");

export const TeamInput = z.discriminatedUnion("do", [
	z.strictObject({ do: z.literal("team.create"), name, cmd }),
	z.strictObject({ do: z.literal("team.list") }),
	z.strictObject({ do: z.literal("team.member.add"), team, person: z.string(), cmd }),
	z.strictObject({ do: z.literal("team.member.remove"), team, person: z.string(), cmd }),
	z.strictObject({ do: z.literal("team.grant.set"), team, project, can: z.array(Capability).min(1), cmd }),
	z.strictObject({ do: z.literal("team.grant.remove"), team, project, cmd }),
	z.strictObject({ do: z.literal("team.history"), team }),
]);
export type TeamInput = z.infer<typeof TeamInput>;

export { TeamChanged, TeamEvent, TeamGrant, TeamReply, TeamRow, TeamSource } from "./team-replies.ts";
