// What a signed-in caller does about signing in: their sessions, their passwords and passkeys, and the
// invitations an admin hands out. The inputs of the three operations and what each replies, declared once for
// the server, the CLI and the web client.
//
// No input here carries a password or an invitation's code. Those go through the sign-in routes
// (`src/surfaces/signin.ts`), never through an operation: the registry keeps a digest of a request that
// carries a command id, and the CLI takes an operation's input as flags.
import { z } from "zod";
import { DURATION_FORMAT, durationMs } from "./duration.ts";
import { Capability } from "./kinds.ts";
import { cmd } from "./ops.ts";

const actor = z.string().max(64);

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

/** One browser session that is alive. Never the cookie, nor its hash. */
export type SessionRow = {
	id: number;
	/** What proved who the person was when it was opened. */
	openedWith: "token" | "password" | "passkey";
	/** The label of that token or credential. */
	label: string;
	/** What the browser called itself at sign-in, cut to 256 characters. Not verified. */
	userAgent: string | null;
	createdAt: number;
	lastUsedAt: number;
	/** When it ends however much it is used. */
	expiresAt: number;
	/** True for the session this very request came by. */
	current: boolean;
};

export const CredentialInput = z.discriminatedUnion("do", [
	z.object({
		do: z.literal("list"),
		actor: actor.optional().describe("Whose. Absent: your own. Somebody else's is for an admin who is a person."),
	}),
	z.object({ do: z.literal("passkey.begin") }),
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
]);
export type CredentialInput = z.infer<typeof CredentialInput>;

/** One way a person signs in. Never the hash, the key or the passkey's credential id. */
export type CredentialRow = {
	id: number;
	kind: "password" | "passkey";
	label: string;
	createdAt: number;
	lastUsedAt: number | null;
};

/** The longest an invitation may last, and how long one lasts when nobody says. */
export const INVITATION_LASTS = { default: "3d", mostMs: 30 * 86_400_000 } as const;

export const InvitationInput = z.discriminatedUnion("do", [
	z.object({
		do: z.literal("create"),
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

/** What `invitation create` replies. The one reply that holds the code; it is not stored and not repeated. */
export type InvitationCreated = {
	id: number;
	name: string;
	purpose: "join" | "recover";
	/** What the person may do on `project` (`*`: every project), as they will hold it. */
	can: string[];
	project: string;
	expiresAt: number;
	code: string;
	/** `<public address>/invite#<code>`, or `/invite#<code>` on an instance that was given no public address. */
	link: string;
	note: string;
};

export type InvitationRow = {
	id: number;
	name: string;
	purpose: "join" | "recover";
	createdBy: string;
	createdAt: number;
	expiresAt: number;
	state: "open" | "used" | "revoked" | "expired";
};

/**
 * What a signed-in page is told about how its person signs in: whether they have a password, and how many
 * passkeys. Null for a caller that is not a person.
 */
export type CredentialSummary = { password: boolean; passkeys: number };
