// What a signed-in caller does about signing in: their sessions, their passwords and passkeys, and the
// invitations an admin hands out. Signing in itself is not here. It is an exchange of the HTTP surface
// (`src/surfaces/signin.ts`), because nobody is signed in yet and a password never enters the registry.
import { durationMs } from "../../core/duration.ts";
import { defaultCapabilities } from "../../core/kinds.ts";
import {
	CredentialInput,
	INVITATION_LASTS,
	type InvitationCreated,
	InvitationInput,
	SessionInput,
} from "../../core/people.ts";
import {
	actorByName,
	addPasskey,
	beginPasskey,
	createInvitation,
	credentialOwner,
	endSessionById,
	invitedPerson,
	KIND_NOUN,
	listCredentials,
	listInvitations,
	listSessions,
	mayActFor,
	removeCredential,
	revokeInvitation,
	sessionOwner,
} from "../identity/identity.ts";
import type { Actor } from "../kernel/ctx.ts";
import { forbidden, invalid, notFound } from "../kernel/errors.ts";
import { actorsWithGrants, personOnly, projectOf, refuseToken } from "./admin.ts";
import { defineInstanceOp, type InstanceCtx } from "./registry.ts";

/**
 * The actor a list is about: the caller, or the one named when the caller may act for them (`mayActFor`).
 * Whether the caller may look is settled before saying whether there is such an actor, so somebody who may not
 * is told that and learns no name.
 */
function subject(env: InstanceCtx, named: string | undefined, what: string): Actor {
	const found = named === undefined || named === env.actor.name ? env.actor : actorByName(env.app.db, named, 0);
	// No actor has the id 0, so for a name that is nobody's this asks whether the caller may look at anyone's.
	if (!mayActFor(env.actor, found?.id ?? 0))
		throw forbidden(`${what} of somebody else are for a person who administers this instance`);
	if (!found) throw notFound(`actor ${named}`);
	return found;
}

/**
 * Refuses unless the thing named by an id is the caller's to end or remove: `owner` is whose it is, or null
 * when there is none. One answer for a thing that is not there and for one that is somebody else's, so an id
 * tells nobody what exists.
 */
function own(env: InstanceCtx, owner: number | null, what: string): void {
	if (owner === null || !mayActFor(env.actor, owner)) throw notFound(what);
}

export const sessionOp = defineInstanceOp({
	name: "session",
	summary: "Your browser sessions: list them, and end one. An admin who is a person lists and ends anyone's.",
	input: SessionInput,
	needs: "self",
	scope: "instance",
	// A write also when it lists: the list reads what is noted of each session's use, which the thread that
	// admits requests keeps, so it runs there and not on a reader thread.
	effect: "write",
	mcp: null,
	run(env, input) {
		const db = env.app.db;
		switch (input.do) {
			case "list": {
				const who = subject(env, input.actor, "the sessions");
				return listSessions(env.app, db, who.id).map((row) => ({ ...row, current: row.id === env.session }));
			}
			case "end": {
				own(env, sessionOwner(db, input.id), `session ${input.id}`);
				endSessionById(db, input.id, env.now);
				// Ending the session the request came by is allowed: it is how a person signs this browser out
				// from the list, and the page then finds itself signed out.
				return { ended: true, current: input.id === env.session };
			}
			default: {
				const _exhaustive: never = input;
				throw invalid(`unknown session action ${JSON.stringify(_exhaustive)}`);
			}
		}
	},
});

export const credentialOp = defineInstanceOp({
	name: "credential",
	summary:
		"How you sign in: list your password and passkeys, register a passkey, remove one. A password is set in the web UI, never here.",
	input: CredentialInput,
	needs: "self",
	scope: "instance",
	effect: "write",
	mcp: null,
	run(env, input) {
		// An agent and a pipeline sign in with a token and nothing else.
		if (env.actor.kind !== "human")
			throw forbidden(`${env.actor.name} is ${KIND_NOUN[env.actor.kind]}: only a person has a password or a passkey`);
		const db = env.app.db;
		switch (input.do) {
			case "list":
				return listCredentials(db, subject(env, input.actor, "the passwords and passkeys").id);
			// A passkey is registered by the person it is for, signed in, and for nobody else: an admin who could
			// add one to another person's account could sign in as them.
			case "passkey.begin":
				return beginPasskey(env.app, env.actor.id);
			case "passkey.add":
				return addPasskey(env.app, { actor: env.actor.id, answer: input.passkey, label: input.label });
			case "remove":
				own(env, credentialOwner(db, input.id), `credential ${input.id}`);
				return removeCredential(env.app, input.id);
			default: {
				const _exhaustive: never = input;
				throw invalid(`unknown credential action ${JSON.stringify(_exhaustive)}`);
			}
		}
	},
});

export const invitationOp = defineInstanceOp({
	name: "invitation",
	summary:
		"Invite a person with a link, since there is no mail: make one, list them, revoke one. The link is shown once.",
	input: InvitationInput,
	needs: "admin",
	scope: "instance",
	effect: "write",
	mcp: null,
	run(env, input) {
		// Who a person is, is for a person to say (`personOnly` in `admin.ts`): an agent that could invite could
		// accept, and would then be a person to every rule that says "not an agent".
		personOnly(env, "an invitation is made, listed or revoked");
		const db = env.app.db;
		switch (input.do) {
			case "create": {
				const lastsMs = durationMs(input.expires);
				if (lastsMs === null || lastsMs > INVITATION_LASTS.mostMs)
					throw invalid(
						"expires: an invitation lasts at most 30d; a link that is still good in a year is a key left out",
					);
				const project = projectOf(db, input.project);
				const existing = actorByName(db, input.name, project);
				// For a person who exists the invitation is a recovery: whoever accepts it is that person from
				// then on. So it is theirs or the owner's to make, as a token for them is.
				refuseToken(env, { kind: "human" }, existing, "invitation");
				const person = invitedPerson(env.app, {
					name: input.name,
					can: existing === null && input.can.length === 0 ? defaultCapabilities("human") : input.can,
					project,
				});
				const purpose = person.isNew ? "join" : "recover";
				const made = createInvitation(env.app, { actor: person.id, by: env.actor.id, purpose, lastsMs });
				const relative = made.link.startsWith("/");
				return {
					id: made.id,
					name: person.name,
					purpose,
					// What the person may do on the project asked about, as the registry will see it.
					can: [...(actorByName(db, person.name, project)?.can ?? [])],
					project: input.project ?? "*",
					expiresAt: made.expiresAt,
					code: made.code,
					link: made.link,
					note: `This link is shown once. Hand it to ${person.name}: it works once.${
						purpose === "recover"
							? ` When it is accepted, every password and passkey ${person.name} had stops working and every session of theirs ends.`
							: ""
					}${
						relative
							? " This instance was given no public address (MAINWORTHY_PUBLIC_URL): put the address people open it at before the link."
							: ""
					}`,
				} satisfies InvitationCreated;
			}
			case "list": {
				// What an invitation gives is what its person holds, on which project: the grant is the person's and
				// not the link's, so it is read as `actor.list` reads it, now.
				const held = new Map(actorsWithGrants(db).map((actor) => [actor.name, actor.grants]));
				return listInvitations(db, env.now).map((row) => ({ ...row, grants: held.get(row.name) ?? [] }));
			}
			case "revoke":
				return { revoked: revokeInvitation(db, input.id, env.now) };
			default: {
				const _exhaustive: never = input;
				throw invalid(`unknown invitation action ${JSON.stringify(_exhaustive)}`);
			}
		}
	},
	secret: (input) => input.do === "create",
});
