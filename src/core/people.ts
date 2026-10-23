// What a signed-in caller does about signing in: their sessions, their passwords and passkeys, and the
// invitations an admin hands out. The inputs of the three operations and what each replies, declared once for
// the server, the CLI and the web client.
//
// No input here carries a password or an invitation's code. Those go through the sign-in routes
// (`src/surfaces/signin.ts`), never through an operation: the registry keeps a digest of a request that
// carries a command id, and the CLI takes an operation's input as flags.
import { z } from "zod";
import { cmd } from "./commands.ts";
import { DURATION_FORMAT, durationMs } from "./duration.ts";
import { Capability } from "./kinds.ts";
import { INVITATION_LASTS, PERSONAL_TOKEN_LASTS } from "./people-replies.ts";

export {
	CredentialRow,
	CredentialSummary,
	FORGET_NOTICE,
	INVITATION_LASTS,
	InvitationCreated,
	InvitationRow,
	PASSWORD_LENGTH,
	PasswordEntry,
	PERSONAL_TOKEN_LASTS,
	PersonalTokenCreated,
	PersonalTokenRow,
	SessionRow,
	TotpConfirmed,
	TotpEnrolment,
	whyNotPassword,
} from "./people-replies.ts";

const actor = z.string().max(64);
export const EmailAddress = z
	.string()
	.trim()
	.max(254)
	.email()
	.transform((text) => text.toLowerCase());

export const SessionInput = z.discriminatedUnion("do", [
	z.object({
		do: z.literal("list"),
		actor: actor
			.optional()
			.describe("Whose sessions. Absent: your own. Somebody else's is for an admin who is a person."),
	}),
	z.object({
		do: z.literal("end"),
		id: z.number().int().describe("The session, from the list. Your own, or anyone's for an admin who is a person."),
	}),
]);
export type SessionInput = z.infer<typeof SessionInput>;

export const CredentialInput = z.discriminatedUnion("do", [
	z.strictObject({ do: z.literal("email.get"), actor: actor.optional() }),
	z.strictObject({ do: z.literal("email.set"), actor: actor.optional(), email: EmailAddress.nullable() }),
	z.object({
		do: z.literal("list"),
		actor: actor.optional().describe("Whose. Absent: your own. Somebody else's is for an admin who is a person."),
	}),
	z.object({ do: z.literal("passkey.begin") }),
	z.strictObject({ do: z.literal("totp.begin") }),
	z.strictObject({
		do: z.literal("totp.confirm"),
		challenge: z.string().min(1).max(128),
		code: z.string().regex(/^\d{6}$/),
	}),
	z.object({
		do: z.literal("passkey.add"),
		passkey: z
			.record(z.string(), z.unknown())
			.describe(
				"What the browser returned for the options of passkey.begin: id, clientDataJSON, authenticatorData, publicKey, publicKeyAlgorithm, transports.",
			),
		label: z.string().trim().min(1).max(60).describe("What you call this passkey: the device it is on."),
	}),
	z.object({
		do: z.literal("remove"),
		id: z.number().int().describe("The credential, from the list. The last one a person has is not removed."),
		cmd,
	}),
	z.strictObject({
		do: z.literal("token.create"),
		label: z.string().trim().min(1).max(60).describe("What you use this token for."),
		expires: z
			.string()
			.default(PERSONAL_TOKEN_LASTS.default)
			.refine(
				(text) => {
					const ms = durationMs(text);
					return ms !== null && ms <= PERSONAL_TOKEN_LASTS.mostMs;
				},
				{ error: `how long it lasts: ${DURATION_FORMAT}; at most 365d` },
			)
			.describe("Default: 30d. At most 365d. A password or passkey session creates your own token, shown once."),
		cmd,
	}),
	z.strictObject({ do: z.literal("token.list") }),
	z.strictObject({ do: z.literal("token.revoke"), id: z.number().int(), cmd }),
]);
export type CredentialInput = z.infer<typeof CredentialInput>;

export const InvitationInput = z.discriminatedUnion("do", [
	z.object({
		do: z.literal("create"),
		email: EmailAddress.optional().describe("Send the link to this address when mail is enabled."),
		name: actor.describe(
			"The person. A new name: an invitation to join. A person who exists: a recovery, which replaces every way they sign in once it is accepted.",
		),
		can: z
			.array(Capability)
			.default([])
			.describe("What a new person may do. Absent: everything. Not for a person who exists: use grant.set."),
		project: z.string().optional().describe("Limit the grant to one project. Absent: every project."),
		expires: z
			.string()
			.default(INVITATION_LASTS.default)
			.refine((text) => durationMs(text) !== null, { error: `how long it lasts: ${DURATION_FORMAT}` })
			.describe("How long the link works: 12h, 3d, 2w. At most 30d."),
		cmd,
	}),
	z.object({ do: z.literal("list") }),
	z.object({ do: z.literal("revoke"), id: z.number().int(), cmd }),
]);
export type InvitationInput = z.infer<typeof InvitationInput>;
