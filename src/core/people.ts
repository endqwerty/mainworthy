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

export const FORGET_NOTICE =
	"A pseudonym replaces the name in attribution, question evidence and saved replies. Password hashes, passkey public keys, and token and credential labels are erased. Passwords, passkeys, tokens and invitations stop working, and sessions end. History and text the person typed in cases and notes stay. Some sign-in records and request fingerprints stay. This cannot be undone.";

/**
 * How long a password is, in characters. Twelve, because nothing else is asked of it: no digit, no capital
 * and no sign, which make passwords harder to remember and no harder to guess. The upper end only bounds the
 * work of hashing what a stranger sends. Said here once, for the server that refuses and the page that warns.
 */
export const PASSWORD_LENGTH = { min: 12, max: 256 } as const;

/** Why this text cannot be a password, as a sentence for the person who typed it, or null when it can. */
export function whyNotPassword(text: string): string | null {
	// Characters as a person counts them, not UTF-16 units.
	const length = [...text].length;
	return length >= PASSWORD_LENGTH.min && length <= PASSWORD_LENGTH.max
		? null
		: `a password is ${PASSWORD_LENGTH.min} to ${PASSWORD_LENGTH.max} characters`;
}

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
export const SessionRow = z.object({
	id: z.number(),
	/** What proved who the person was when it was opened. */
	openedWith: z.enum(["token", "password", "passkey"]),
	/** The label of that token or credential. */
	label: z.string(),
	/** What the browser called itself at sign-in, cut to 256 characters. Not verified. */
	userAgent: z.string().nullable(),
	createdAt: z.number(),
	/** The address it was opened from, as the server determined it; null when nothing said. */
	createdFrom: z.string().nullable(),
	lastUsedAt: z.number(),
	/** The address of the last request that used it. */
	lastUsedFrom: z.string().nullable(),
	/** When it ends however much it is used. */
	expiresAt: z.number(),
	/** True for the session this very request came by. */
	current: z.boolean(),
});
export type SessionRow = z.infer<typeof SessionRow>;

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
export const CredentialRow = z.object({
	id: z.number(),
	kind: z.enum(["password", "passkey"]),
	label: z.string(),
	createdAt: z.number(),
	lastUsedAt: z.number().nullable(),
});
export type CredentialRow = z.infer<typeof CredentialRow>;

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
export const InvitationCreated = z.object({
	id: z.number(),
	name: z.string(),
	purpose: z.enum(["join", "recover"]),
	/** What the person may do on `project` (`*`: every project), as they will hold it. */
	can: z.array(z.string()),
	project: z.string(),
	expiresAt: z.number(),
	code: z.string(),
	/** `<public address>/invite#<code>`, or `/invite#<code>` on an instance that was given no public address. */
	link: z.string(),
	note: z.string(),
});
export type InvitationCreated = z.infer<typeof InvitationCreated>;

export const InvitationRow = z.object({
	id: z.number(),
	name: z.string(),
	purpose: z.enum(["join", "recover"]),
	createdBy: z.string(),
	createdAt: z.number(),
	expiresAt: z.number(),
	state: z.enum(["open", "used", "revoked", "expired"]),
	/**
	 * What the person holds now, as `actor.list` shows it: each grant with its project's key, or `*` for every
	 * project. It is the person's and not the link's: a grant changed after the invitation was made shows here.
	 */
	grants: z.array(
		z.object({
			project: z.string(),
			can: z.array(z.string()),
		}),
	),
});
export type InvitationRow = z.infer<typeof InvitationRow>;

/**
 * What a signed-in page is told about how its person signs in: whether they have a password, and how many
 * passkeys. Null for a caller that is not a person.
 */
export const CredentialSummary = z.object({
	password: z.boolean(),
	passkeys: z.number(),
});
export type CredentialSummary = z.infer<typeof CredentialSummary>;
