// Administering the instance: projects, actors, tokens, and reading a project's policy.
import { durationMs } from "../../core/duration.ts";
import { type ActorKind, defaultCapabilities } from "../../core/kinds.ts";
import { AdminInput } from "../../core/ops.ts";
import {
	actorByName,
	createToken,
	forgetActor,
	KIND_NOUN,
	lastTokenOf,
	listActors,
	listTokens,
	orgId,
	removeGrant,
	revokeToken,
	setGrant,
} from "../identity/identity.ts";
import { type Actor, allProjects, findProject, insertProject, makeCtx, stampSeq } from "../kernel/ctx.ts";
import type { Db } from "../kernel/db.ts";
import { conflict, forbidden, invalid, notFound } from "../kernel/errors.ts";
import { currentPolicy, isPreset, policyName, seedPolicy } from "../policy/policy.ts";
import { defineInstanceOp, type InstanceCtx } from "./registry.ts";

/** Every project with the policy in force. A plain read, so the session endpoint can call it during a long write. */
export function listProjects(db: Db): { key: string; name: string; seq: number; createdAt: number; policy: string }[] {
	return allProjects(db).map((row) => ({
		key: row.key,
		name: row.name,
		seq: row.seq,
		createdAt: row.created_at,
		policy: policyName(currentPolicy(db, row.id)),
	}));
}

/** Creates a project with its first policy. Used by the admin operation and by first start. */
export function createProject(
	env: InstanceCtx,
	input: { key: string; name?: string | undefined; preset?: string | undefined },
) {
	const preset = input.preset ?? "loose";
	if (!isPreset(preset)) throw invalid(`unknown preset ${preset}`);
	if (findProject(env.app.db, input.key)) throw conflict(`a project named ${input.key} exists`);
	const project = insertProject(env.app.db, {
		org: orgId(env.app.db),
		key: input.key,
		name: input.name ?? input.key,
		at: env.now,
	});
	const ctx = makeCtx(env.app, project, env.actor, true);
	seedPolicy(ctx, preset);
	stampSeq(ctx);
	return { key: project.key, name: project.name, policy: preset };
}

/** The id of the project a grant names, or 0 when it names none: every project. */
function projectOf(db: Db, key: string | undefined): number {
	if (key === undefined) return 0;
	const project = findProject(db, key);
	if (!project) throw notFound(`project ${key}`);
	return project.id;
}

/**
 * Who a person is, what a person may do and whether a person is remembered are for a person to change. An agent
 * may hold `admin` and do the rest of it (projects, its own kind's tokens, the lists); with a person's token it
 * would be a person to every policy clause that says "not an agent", and with a grant of its choosing it would be
 * whatever it liked.
 */
function personOnly(env: InstanceCtx, what: string): void {
	if (env.actor.kind !== "human")
		throw forbidden(
			`${env.actor.name} is ${KIND_NOUN[env.actor.kind]}: ${what} by a person who administers this instance`,
		);
}

/**
 * Who may make a token for whom. Whoever holds a token for a name acts under that name, and the record says that
 * what was decided or typed is that person's. So a token for a person who exists is made by that person or by
 * the owner of the instance, and one for the owner by the owner alone: an admin's word is not enough to become
 * somebody else. A new person is anybody's to add who administers and is a person; agents' and pipelines' tokens
 * are made by whoever administers.
 */
function refuseToken(env: InstanceCtx, input: { kind: ActorKind }, existing: Actor | null): void {
	// What the actor is decides, not what the request calls it: naming another kind for a person does not help.
	const forPerson = existing ? existing.kind === "human" : input.kind === "human";
	if (!forPerson) return;
	personOnly(env, "a person's token is made");
	const owner = env.app.config.owner;
	if (!existing || existing.id === env.actor.id || env.actor.name === owner) return;
	throw forbidden(
		existing.name === owner
			? `only ${owner}, who owns this instance, makes a token for ${owner}`
			: `a token for ${existing.name} is made by ${existing.name} or by ${owner}, who owns this instance`,
	);
}

export function admin(env: InstanceCtx, input: AdminInput): unknown {
	const db = env.app.db;
	const owner = env.app.config.owner;
	switch (input.do) {
		case "project.create":
			return createProject(env, input);
		case "project.list":
			return listProjects(db);
		case "token.create": {
			const project = projectOf(db, input.project);
			const existing = actorByName(db, input.actor, project);
			refuseToken(env, input, existing);
			// A new actor is given what was asked, or its kind's default. One that exists keeps its grants, and
			// `createToken` refuses a list for it.
			const isNew = existing === null;
			// The schema lets through only what `durationMs` reads, so a null here is an `expires` that was absent.
			const lastsMs = input.expires === undefined ? null : durationMs(input.expires);
			const created = createToken(env.app, {
				actor: input.actor,
				kind: input.kind,
				can: isNew && input.can.length === 0 ? defaultCapabilities(input.kind) : input.can,
				project,
				label: input.label ?? `${input.kind} token`,
				...(lastsMs === null ? {} : { lastsMs }),
				madeBy: env.actor.id,
			});
			return {
				actor: created.actor,
				token: created.secret,
				// What the token's holder may do on the project asked about, as the registry will see it.
				can: actorByName(db, created.actor, project)?.can ?? [],
				expiresAt: created.expiresAt,
				note: "This token is shown once. Store it now.",
			};
		}
		case "token.list":
			return listTokens(env.app).map((row) => ({
				id: row.id,
				actor: row.actor,
				kind: row.kind,
				label: row.label,
				createdAt: row.created_at,
				createdBy: row.created_by,
				expiresAt: row.expires_at,
				expired: row.expired,
				lastUsedAt: row.last_used_at,
				lastUsedFrom: row.last_used_addr,
				revoked: row.revoked_at !== null,
			}));
		case "token.revoke": {
			// In server mode a token is the owner's one way in, and the owner is who repairs the instance when
			// everything else is wrong. The last one that works is kept whoever asks, the owner included: the
			// button is one click. A token past its end is not another way in. (In local mode the owner is whoever
			// sits at the machine, and holds a token only for a script.)
			if (env.app.config.mode === "server" && lastTokenOf(db, input.id, env.now) === owner) {
				throw invalid(
					`token ${input.id} is the last one ${owner} can sign in with, and ${owner} owns this instance. As ${owner}, make ${owner} another token first (mainworthy token new --human ${owner}), then revoke this one`,
				);
			}
			return { revoked: revokeToken(env.app, input.id) };
		}
		case "actor.list": {
			const keys = new Map(allProjects(db).map((project) => [project.id, project.key]));
			return listActors(db).map((actor) => ({
				...actor,
				// `*` is every project. A grant on a project that no longer exists is not shown: it gives nothing.
				grants: actor.grants.flatMap((grant) => {
					const project = grant.project === 0 ? "*" : keys.get(grant.project);
					return project === undefined ? [] : [{ project, can: grant.can }];
				}),
			}));
		}
		case "grant.set":
		case "grant.remove": {
			personOnly(env, "a grant is changed");
			// An admin's own grant is another admin's to change: a slip here would lock the instance. The owner's is
			// nobody's: it is written again on every start, and until then nobody might be left to administer.
			if (input.actor === env.actor.name)
				throw invalid("you cannot change what you yourself may do; another admin must do it");
			if (input.actor === owner)
				throw invalid(`${input.actor} owns this instance and may do everything; that is not changed here`);
			const project = projectOf(db, input.project);
			if (input.do === "grant.remove") return { removed: removeGrant(env.app, { actor: input.actor, project }) };
			setGrant(env.app, { actor: input.actor, project, can: input.can });
			return { actor: input.actor, project: input.project ?? "*", can: input.can };
		}
		case "actor.forget": {
			personOnly(env, "an actor is forgotten");
			if (input.name === env.actor.name) throw invalid("you cannot forget yourself; another admin must do it");
			// Forgetting disables the actor and revokes its tokens. The start would make a new owner of the same
			// name, with every capability and no token that works: nobody could sign in as the owner again.
			if (input.name === owner) {
				throw invalid(
					`${owner} owns this instance and is not forgotten: nobody would be left who can always repair it. To hand the instance to somebody else, start it with MAINWORTHY_OWNER set to their name; ${owner} can be forgotten after that`,
				);
			}
			return forgetActor(env.app, input.name);
		}
		case "policy.show": {
			const project = findProject(db, input.project);
			if (!project) throw notFound(`project ${input.project}`);
			return currentPolicy(db, project.id);
		}
		default: {
			const _exhaustive: never = input;
			throw invalid(`unknown admin action ${JSON.stringify(_exhaustive)}`);
		}
	}
}

export const adminOp = defineInstanceOp({
	name: "admin",
	summary:
		"Projects, actors, grants and tokens. There are no seats: an actor is free, and a token carries what its actor may do.",
	input: AdminInput,
	needs: "admin",
	scope: "instance",
	effect: "write",
	mcp: null,
	run: admin,
	secret: (input) => input.do === "token.create",
});
