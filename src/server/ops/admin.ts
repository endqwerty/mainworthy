// Administering the instance: projects, actors, tokens, and reading a project's policy.
import { defaultCapabilities } from "../../core/kinds.ts";
import { AdminInput } from "../../core/ops.ts";
import {
	actorByName,
	createToken,
	forgetActor,
	listActors,
	listTokens,
	orgId,
	removeGrant,
	revokeToken,
	setGrant,
} from "../identity/identity.ts";
import { allProjects, findProject, insertProject, makeCtx, stampSeq } from "../kernel/ctx.ts";
import type { Db } from "../kernel/db.ts";
import { conflict, invalid, notFound } from "../kernel/errors.ts";
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

export function admin(env: InstanceCtx, input: AdminInput): unknown {
	const db = env.app.db;
	switch (input.do) {
		case "project.create":
			return createProject(env, input);
		case "project.list":
			return listProjects(db);
		case "token.create": {
			const project = projectOf(db, input.project);
			// A new actor is given what was asked, or its kind's default. One that exists keeps its grants, and
			// `createToken` refuses a list for it.
			const isNew = actorByName(db, input.actor, project) === null;
			const created = createToken(env.app, {
				actor: input.actor,
				kind: input.kind,
				can: isNew && input.can.length === 0 ? defaultCapabilities(input.kind) : input.can,
				project,
				label: input.label ?? `${input.kind} token`,
			});
			return {
				actor: created.actor,
				token: created.secret,
				// What the token's holder may do on the project asked about, as the registry will see it.
				can: actorByName(db, created.actor, project)?.can ?? [],
				note: "This token is shown once. Store it now.",
			};
		}
		case "token.list":
			return listTokens(db).map((row) => ({
				id: row.id,
				actor: row.actor,
				kind: row.kind,
				label: row.label,
				createdAt: row.created_at,
				lastUsedAt: row.last_used_at,
				revoked: row.revoked_at !== null,
			}));
		case "token.revoke":
			return { revoked: revokeToken(env.app, input.id) };
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
			// An admin's own grant is another admin's to change: a slip here would lock the instance. The owner's is
			// nobody's: it is written again on every start, and until then nobody might be left to administer.
			if (input.actor === env.actor.name)
				throw invalid("you cannot change what you yourself may do; another admin must do it");
			if (input.actor === env.app.config.owner)
				throw invalid(`${input.actor} owns this instance and may do everything; that is not changed here`);
			const project = projectOf(db, input.project);
			if (input.do === "grant.remove") return { removed: removeGrant(env.app, { actor: input.actor, project }) };
			setGrant(env.app, { actor: input.actor, project, can: input.can });
			return { actor: input.actor, project: input.project ?? "*", can: input.can };
		}
		case "actor.forget": {
			if (input.name === env.actor.name) throw invalid("you cannot forget yourself; another admin must do it");
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
