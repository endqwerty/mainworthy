// Sign-in replies and shared rules used by the browser, server and CLI.
import { z } from "zod";
import {
	flag as schemaFlag,
	nullableNumber as schemaNullableNumber,
	nullableText as schemaNullableText,
	number as schemaNumber,
	text as schemaText,
	texts as schemaTexts,
	whole as schemaWhole,
} from "./schema.ts";

export const FORGET_NOTICE =
	"A pseudonym replaces the name in attribution, question evidence and saved replies. Linked provider identities and recovery email addresses are erased. So are password hashes, passkey public keys, authenticator secrets and recovery-code hashes, token network addresses, and token and credential labels. Team memberships are removed. Passwords, passkeys, authenticators, tokens and invitations stop working, and sessions end. History, attachments and text the person typed in cases and notes stay. Some sign-in records and request fingerprints stay. This cannot be undone.";

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

/** One browser session that is alive. Never the cookie, nor its hash. */
export const SessionRow = z.object({
	id: schemaNumber,
	/** What proved who the person was when it was opened. */
	openedWith: z.enum(["token", "password", "passkey", "oidc"]),
	/** The label of that token or credential. */
	label: schemaText,
	/** What the browser called itself at sign-in, cut to 256 characters. Not verified. */
	userAgent: schemaNullableText,
	createdAt: schemaNumber,
	/** The address it was opened from, as the server determined it; null when nothing said. */
	createdFrom: schemaNullableText,
	lastUsedAt: schemaNumber,
	/** The address of the last request that used it. */
	lastUsedFrom: schemaNullableText,
	/** When it ends however much it is used. */
	expiresAt: schemaNumber,
	/** True for the session this very request came by. */
	current: schemaFlag,
});
export type SessionRow = z.infer<typeof SessionRow>;

export const PERSONAL_TOKEN_LASTS = { default: "30d", mostMs: 365 * 86_400_000 } as const;

export const PersonalTokenCreated = z.object({
	id: schemaWhole,
	actor: schemaText,
	token: schemaText,
	expiresAt: schemaNumber,
});
export type PersonalTokenCreated = z.infer<typeof PersonalTokenCreated>;

export const PersonalTokenRow = z.object({
	id: schemaWhole,
	label: schemaText,
	createdAt: schemaNumber,
	expiresAt: schemaNullableNumber,
	expired: schemaFlag,
	lastUsedAt: schemaNullableNumber,
	revoked: schemaFlag,
});
export type PersonalTokenRow = z.infer<typeof PersonalTokenRow>;

/** One way a person signs in. Never the hash, the key or the passkey's credential id. */
export const CredentialRow = z.object({
	id: schemaNumber,
	kind: z.enum(["password", "passkey", "oidc", "totp"]),
	label: schemaText,
	createdAt: schemaNumber,
	lastUsedAt: schemaNullableNumber,
});
export type CredentialRow = z.infer<typeof CredentialRow>;

/** The longest an invitation may last, and how long one lasts when nobody says. */
export const INVITATION_LASTS = { default: "3d", mostMs: 30 * 86_400_000 } as const;

/** What `invitation create` replies. The one reply that holds the code; it is not stored and not repeated. */
export const InvitationCreated = z.object({
	id: schemaNumber,
	name: schemaText,
	purpose: z.enum(["join", "recover"]),
	/** What the person may do on `project` (`*`: every project), as they will hold it. */
	can: schemaTexts,
	project: schemaText,
	expiresAt: schemaNumber,
	code: schemaText,
	/** `<public address>/invite#<code>`, or `/invite#<code>` on an instance that was given no public address. */
	link: schemaText,
	note: schemaText,
});
export type InvitationCreated = z.infer<typeof InvitationCreated>;

export const InvitationRow = z.object({
	id: schemaNumber,
	name: schemaText,
	purpose: z.enum(["join", "recover"]),
	createdBy: schemaText,
	createdAt: schemaNumber,
	expiresAt: schemaNumber,
	state: z.enum(["open", "used", "revoked", "expired"]),
	/**
	 * What the person holds now, as `actor.list` shows it: each grant with its project's key, or `*` for every
	 * project. It is the person's and not the link's: a grant changed after the invitation was made shows here.
	 */
	grants: z.array(
		z.object({
			project: schemaText,
			can: schemaTexts,
			roles: schemaTexts.default([]),
		}),
	),
});
export type InvitationRow = z.infer<typeof InvitationRow>;

/**
 * What a signed-in page is told about how its person signs in: whether they have a password, and how many
 * passkeys. Null for a caller that is not a person.
 */
export const CredentialSummary = z.object({
	password: schemaFlag,
	passkeys: schemaNumber,
});
export type CredentialSummary = z.infer<typeof CredentialSummary>;

export const TotpEnrolment = z.object({
	challenge: schemaText,
	expiresAt: schemaNumber,
	secret: schemaText,
	uri: schemaText,
	qr: z.object({ size: schemaWhole.positive(), path: schemaText }),
});
export type TotpEnrolment = z.infer<typeof TotpEnrolment>;
export const TotpConfirmed = z.object({
	id: schemaWhole,
	recoveryCodes: schemaTexts,
	sessionsEnded: schemaWhole,
});
export type TotpConfirmed = z.infer<typeof TotpConfirmed>;
export const PasswordEntry = z.union([
	z.object({ signedIn: z.literal(true) }),
	z.object({ signedIn: z.literal(false), secondFactor: z.object({ challenge: schemaText, expiresAt: schemaNumber }) }),
]);
export type PasswordEntry = z.infer<typeof PasswordEntry>;
