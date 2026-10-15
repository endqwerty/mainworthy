// What the three operations about signing in reply (`session`, `credential`, `invitation`), read at the edge
// of the page. An operation's reply is typed as every shape its actions return, so each action's reply is
// parsed here into the one it is. The shapes are the core's (`src/core/people.ts`): each schema is held to its
// type by `satisfies`, so a field the core gains or renames fails the type-check here.
import { z } from "zod";
import type { Capability } from "../../core/kinds.ts";
import {
	type CredentialRow,
	type InvitationCreated,
	type InvitationRow,
	PersonalTokenCreated,
	PersonalTokenRow,
	type SessionRow,
} from "../../core/people.ts";
import { type CallOptions, call } from "./api.ts";
import { CreationOptions, type Registration } from "./passkey.ts";

const Purpose = z.enum(["join", "recover"]);

const SessionRows = z.array(
	z.object({
		id: z.number(),
		openedWith: z.enum(["token", "password", "passkey"]),
		label: z.string(),
		userAgent: z.string().nullable(),
		createdAt: z.number(),
		createdFrom: z.string().nullable(),
		lastUsedAt: z.number(),
		lastUsedFrom: z.string().nullable(),
		expiresAt: z.number(),
		current: z.boolean(),
	}),
) satisfies z.ZodType<SessionRow[]>;

const CredentialRows = z.array(
	z.object({
		id: z.number(),
		kind: z.enum(["password", "passkey"]),
		label: z.string(),
		createdAt: z.number(),
		lastUsedAt: z.number().nullable(),
	}),
) satisfies z.ZodType<CredentialRow[]>;

const InvitationRows = z.array(
	z.object({
		id: z.number(),
		name: z.string(),
		purpose: Purpose,
		createdBy: z.string(),
		createdAt: z.number(),
		expiresAt: z.number(),
		state: z.enum(["open", "used", "revoked", "expired"]),
		grants: z.array(z.object({ project: z.string(), can: z.array(z.string()) })),
	}),
) satisfies z.ZodType<InvitationRow[]>;

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
}) satisfies z.ZodType<InvitationCreated>;

type Options = Pick<CallOptions, "signal">;

/** The caller's own browser sessions that are alive, oldest first. */
export const listSessions = async (options: Options = {}): Promise<SessionRow[]> =>
	SessionRows.parse(await call("session", { do: "list" }, options));

/** Ends a session. `current` says it was this browser's own: every later request is then refused. */
export const endSession = async (id: number): Promise<{ current: boolean }> =>
	z.object({ current: z.boolean() }).parse(await call("session", { do: "end", id }));

/** The ways the caller signs in: at most one password, and their passkeys. */
export const listCredentials = async (options: Options = {}): Promise<CredentialRow[]> =>
	CredentialRows.parse(await call("credential", { do: "list" }, options));

/** The options to make a passkey for the caller, with a challenge good for five minutes and one registration. */
export const beginPasskey = async (): Promise<CreationOptions> =>
	CreationOptions.parse(await call("credential", { do: "passkey.begin" }));

export const addPasskey = async (input: { made: Registration; label: string }): Promise<void> => {
	await call("credential", { do: "passkey.add", passkey: input.made, label: input.label });
};

/** Removes a way of signing in. The sessions that rested on it end, this browser's own among them if it did. */
export const removeCredential = async (id: number): Promise<{ sessionsEnded: number }> =>
	z.object({ sessionsEnded: z.number() }).parse(await call("credential", { do: "remove", id }));

/** Every invitation, oldest first, with what became of each. Never a code. */
export const listInvitations = async (options: Options = {}): Promise<InvitationRow[]> =>
	InvitationRows.parse(await call("invitation", { do: "list" }, options));

/**
 * Invites a person. For a name nobody has it makes the person, with `can` on `project`. For a person who
 * exists it is a recovery, and `can` and `project` are left out: they hold what they hold. The reply is the
 * one place the link appears.
 */
export const createInvitation = async (input: {
	name: string;
	/** How long the link works: `12h`, `3d`, `2w`. */
	expires: string;
	/** What a new person may do, and on which project (null: every project). Null for a person who exists. */
	grant: { can: Capability[]; project: string | null } | null;
}): Promise<InvitationCreated> =>
	Created.parse(
		await call("invitation", {
			do: "create",
			name: input.name,
			expires: input.expires,
			...(input.grant
				? { can: input.grant.can, ...(input.grant.project === null ? {} : { project: input.grant.project }) }
				: {}),
		}),
	);

export const revokeInvitation = async (id: number): Promise<{ revoked: boolean }> =>
	z.object({ revoked: z.boolean() }).parse(await call("invitation", { do: "revoke", id }));

/** "3d", "5h", "20m": how long until a time, to the nearest of its unit. A time that has passed is "now". */
export function until(at: number, now = Date.now()): string {
	const minutes = Math.max(0, Math.round((at - now) / 60_000));
	if (minutes < 1) return "now";
	if (minutes < 60) return `${minutes}m`;
	return minutes < 1440 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / 1440)}d`;
}

/** A date and a time as this browser writes them, for when a link runs out. */
export const dateTime = (at: number): string =>
	new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export const listPersonalTokens = async (options: Options = {}): Promise<PersonalTokenRow[]> =>
	PersonalTokenRow.array().parse(await call("credential", { do: "token.list" }, options));

export const createPersonalToken = async (label: string, expires: string): Promise<PersonalTokenCreated> =>
	PersonalTokenCreated.parse(
		await call("credential", { do: "token.create", label, expires, cmd: crypto.randomUUID() }),
	);

export const revokePersonalToken = async (id: number): Promise<{ revoked: boolean }> =>
	z
		.object({ revoked: z.boolean() })
		.parse(await call("credential", { do: "token.revoke", id, cmd: crypto.randomUUID() }));
