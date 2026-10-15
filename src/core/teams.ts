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

export const TeamGrant = z.object({ project: z.string(), can: z.array(Capability) });
export const TeamSource = z.object({ name: z.string(), grants: z.array(TeamGrant) });
export const TeamRow = TeamSource.extend({ members: z.array(z.string()), createdAt: z.number() });
export const TeamEvent = z.object({
	id: z.number().int().positive(),
	at: z.number(),
	by: z.string(),
	action: z.enum(["created", "member.add", "member.remove", "grant.set", "grant.remove"]),
	person: z.string().nullable(),
	project: z.string().nullable(),
	can: z.array(Capability).nullable(),
});
export type TeamEvent = z.infer<typeof TeamEvent>;
export const TeamChanged = z.object({ team: z.string(), changed: z.boolean() });
export const TeamReply = z.union([z.array(TeamRow), z.array(TeamEvent), TeamChanged]);
