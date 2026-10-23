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
import { REPLIES } from "../../core/replies.ts";
import {
	actorByName,
	addPasskey,
	beginPasskey,
	beginTotp,
	confirmTotp,
	createInvitation,
	createPersonalToken,
	credentialOwner,
	endSessionById,
	getEmail,
	invitedPerson,
	KIND_NOUN,
	listCredentials,
	listInvitations,
	listPersonalTokens,
	listSessions,
	mayActFor,
	queueMail,
	removeCredential,
	requireMail,
	revokeInvitation,
	revokeToken,
	sessionOwner,
	setEmail,
	tokenOwner,
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
async function subject(env: InstanceCtx, named: string | undefined, what: string): Promise<Actor> {
	const found = named === undefined || named === env.actor.name ? env.actor : await actorByName(env.app.db, named, 0);
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

/** Where the caller is signed in, for a passkey registration; a caller with a token is refused. */
function signedInAt(env: InstanceCtx, what = "a passkey"): string {
	if (env.context === null) throw forbidden(`${what} is registered from a browser that is signed in, not with a token`);
	return env.context;
}

export const sessionOp = defineInstanceOp({
	name: "session",
	output: REPLIES.session,
	summary: "Your browser sessions: list them, and end one. An admin who is a person lists and ends anyone's.",
	input: SessionInput,
	needs: "self",
	scope: "instance",
	// A write also when it lists: the list reads what is noted of each session's use, which the thread that
	// admits requests keeps, so it runs there and not on a reader thread.
	effect: "write",
	mcp: null,
	async run(env, input) {
		const db = env.app.db;
		switch (input.do) {
			case "list": {
				const who = await subject(env, input.actor, "the sessions");
				return (await listSessions(env.app, db, who.id)).map((row) => ({ ...row, current: row.id === env.session }));
			}
			case "end": {
				own(env, await sessionOwner(db, input.id), `session ${input.id}`);
				await endSessionById(db, input.id, env.now);
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
	output: REPLIES.credential,
	summary:
		"Your password, passkeys, authenticator, recovery email and CLI tokens: list, add or remove them. Only a person may call. Sign-in changes and personal token creation require recent credential proof in the caller's browser session. A password is set in the web UI. A personal token is shown once and expires after 30d by default.",
	input: CredentialInput,
	needs: "self",
	scope: "instance",
	effect: "write",
	mcp: null,
	async run(env, input) {
		// An agent and a pipeline sign in with a token and nothing else.
		if (env.actor.kind !== "human")
			throw forbidden(`${env.actor.name} is ${KIND_NOUN[env.actor.kind]}: only a person has a password or a passkey`);
		const db = env.app.db;
		switch (input.do) {
			case "email.get":
				return await getEmail(db, (await subject(env, input.actor, "the email address")).id);
			case "email.set": {
				const person = await subject(env, input.actor, "the email address");
				return await setEmail(env.app, { caller: env.actor, person, context: env.context, email: input.email });
			}
			case "list":
				return await listCredentials(db, (await subject(env, input.actor, "the passwords and passkeys")).id);
			// A passkey is registered by the person it is for, signed in, and for nobody else: an admin who could
			// add one to another person's account could sign in as them.
			// It is registered where the person is signed in, and finished there: the challenge keeps the caller's
			// context, and another session of the same person does not complete it. A token is no place to sign in
			// from, so it begins and finishes none, as it sets no password: a way in that a script could add would
			// outlive the token.
			case "totp.begin":
				return await beginTotp(env.app, { actor: env.actor.id, context: signedInAt(env, "an authenticator") });
			case "totp.confirm":
				return await confirmTotp(env.app, {
					actor: env.actor.id,
					session: env.session,
					context: signedInAt(env, "an authenticator"),
					challenge: input.challenge,
					code: input.code,
				});
			case "passkey.begin":
				return await beginPasskey(env.app, { actor: env.actor.id, context: signedInAt(env) });
			case "passkey.add":
				return await addPasskey(env.app, {
					actor: env.actor.id,
					context: signedInAt(env),
					answer: input.passkey,
					label: input.label,
				});
			case "remove":
				own(env, await credentialOwner(db, input.id), `credential ${input.id}`);
				return await removeCredential(env.app, input.id, { actor: env.actor.id, context: env.context });
			case "token.create": {
				const lastsMs = durationMs(input.expires);
				if (lastsMs === null) throw invalid("expires: invalid duration");
				return await createPersonalToken(env.app, {
					actor: env.actor,
					session: env.session,
					context: env.context,
					label: input.label,
					lastsMs,
				});
			}
			case "token.list":
				return await listPersonalTokens(env.app, env.actor.id);
			case "token.revoke":
				own(env, await tokenOwner(db, input.id), `token ${input.id}`);
				return { revoked: await revokeToken(env.app, input.id) };
			default: {
				const _exhaustive: never = input;
				throw invalid(`unknown credential action ${JSON.stringify(_exhaustive)}`);
			}
		}
	},
	secret: (input) => input.do === "token.create" || input.do === "totp.begin" || input.do === "totp.confirm",
});

export const invitationOp = defineInstanceOp({
	name: "invitation",
	output: REPLIES.invitation,
	summary:
		"Invite a person with a link: make one, list them, revoke one. Optionally send it by mail. The link is shown once. Issuing any invitation from a browser needs the caller's recent credential proof; token and local authority remain.",
	input: InvitationInput,
	needs: "admin",
	scope: "instance",
	effect: "write",
	mcp: null,
	async run(env, input) {
		// Who a person is, is for a person to say (`personOnly` in `admin.ts`): an agent that could invite could
		// accept, and would then be a person to every rule that says "not an agent".
		personOnly(env, "an invitation is made, listed or revoked");
		const db = env.app.db;
		switch (input.do) {
			case "create": {
				if (input.email !== undefined) requireMail(env.app);
				const lastsMs = durationMs(input.expires);
				if (lastsMs === null || lastsMs > INVITATION_LASTS.mostMs)
					throw invalid(
						"expires: an invitation lasts at most 30d; a link that is still good in a year is a key left out",
					);
				const project = await projectOf(db, input.project);
				const existing = await actorByName(db, input.name, project);
				// For a person who exists the invitation is a recovery: whoever accepts it is that person from
				// then on. So it is theirs or the owner's to make, as a token for them is.
				refuseToken(env, { kind: "human" }, existing, "invitation");
				const person = await invitedPerson(env.app, {
					name: input.name,
					can: existing === null && input.can.length === 0 ? defaultCapabilities("human") : input.can,
					project,
				});
				const purpose = person.isNew ? "join" : "recover";
				const made = await createInvitation(env.app, {
					actor: person.id,
					by: env.actor.id,
					purpose,
					lastsMs,
					context: env.context,
				});
				if (input.email !== undefined)
					queueMail(env.app, {
						to: input.email,
						subject: "Your Mainworthy invitation",
						text: `You have been invited as ${person.name}:\n${made.link}\n\nThis link works once, until ${new Date(made.expiresAt).toISOString()}.${purpose === "recover" ? " Accepting it replaces your passwords, passkeys and tokens and ends your sessions." : ""}`,
					});
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
					note: `${input.email === undefined ? "" : "Mail delivery requested. "}This link is shown once. Hand it to ${person.name}: it works once.${
						purpose === "recover"
							? ` When it is accepted, every password, passkey and token ${person.name} had stops working and every session of theirs ends.`
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
				const held = new Map((await actorsWithGrants(db)).map((actor) => [actor.name, actor.grants]));
				return (await listInvitations(db, env.now)).map((row) => ({ ...row, grants: held.get(row.name) ?? [] }));
			}
			case "revoke":
				return { revoked: await revokeInvitation(db, input.id, env.now) };
			default: {
				const _exhaustive: never = input;
				throw invalid(`unknown invitation action ${JSON.stringify(_exhaustive)}`);
			}
		}
	},
	secret: (input) => input.do === "create",
});
