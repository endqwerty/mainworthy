// Team replies shared by the browser and server.
import { z } from "zod";
import { Capability } from "./kinds.ts";
import {
	flag as schemaFlag,
	nullableText as schemaNullableText,
	number as schemaNumber,
	text as schemaText,
	texts as schemaTexts,
	whole as schemaWhole,
} from "./schema.ts";

export const TeamGrant = z.object({ project: schemaText, can: z.array(Capability) });
export const TeamSource = z.object({ name: schemaText, grants: z.array(TeamGrant) });
export const TeamRow = TeamSource.extend({ members: schemaTexts, createdAt: schemaNumber });
export const TeamEvent = z.object({
	id: schemaWhole.positive(),
	at: schemaNumber,
	by: schemaText,
	action: z.enum(["created", "member.add", "member.remove", "grant.set", "grant.remove"]),
	person: schemaNullableText,
	project: schemaNullableText,
	can: z.array(Capability).nullable(),
});
export type TeamEvent = z.infer<typeof TeamEvent>;
export const TeamChanged = z.object({ team: schemaText, changed: schemaFlag });
export const TeamReply = z.union([z.array(TeamRow), z.array(TeamEvent), TeamChanged]);
