// Administering the instance: projects, actors, tokens, and reading a project's policy.
import { AdminInput } from "../../core/ops.ts";
import {
	ALL_CAPABILITIES,
	createToken,
	forgetActor,
	listActors,
	listTokens,
	orgId,
	revokeToken,
} from "../identity/identity.ts";
import { findProject, makeCtx, stampSeq } from "../kernel/ctx.ts";
import { type Db, sql } from "../kernel/db.ts";
import { conflict, invalid, notFound } from "../kernel/errors.ts";
import { currentPolicy, isPreset, seedPolicy } from "../policy/policy.ts";
import { defineInstanceOp, type InstanceCtx } from "./registry.ts";

const Q = {
	insertProject: sql<{ org: number; key: string; name: string; at: number }>(
		"INSERT INTO projects (org, key, name, created_at) VALUES ($org, $key, $name, $at)",
	),
	projects: sql<readonly [], { key: string; name: string; seq: number; created_at: number }>(
		"SELECT key, name, seq, created_at FROM projects ORDER BY id",
	),
};

/** Every project with the policy in force. A plain read, so the session endpoint can call it during a long write. */
export function listProjects(db: Db): { key: string; name: string; seq: number; createdAt: number; policy: string }[] {
	return db.all(Q.projects).map((row) => {
		const project = findProject(db, row.key);
		return {
			key: row.key,
			name: row.name,
			seq: row.seq,
			createdAt: row.created_at,
			policy: project ? currentPolicy(db, project.id).preset : "",
		};
	});
}

/** Creates a project with its first policy. Used by the admin operation and by first start. */
export function createProject(
	env: InstanceCtx,
	input: { key: string; name?: string | undefined; preset?: string | undefined },
) {
	const preset = input.preset ?? "loose";
	if (!isPreset(preset)) throw invalid(`unknown preset ${preset}`);
	if (findProject(env.app.db, input.key)) throw conflict(`a project named ${input.key} exists`);
	env.app.db.run(Q.insertProject, {
		org: orgId(env.app.db),
		key: input.key,
		name: input.name ?? input.key,
		at: env.now,
	});
	const project = findProject(env.app.db, input.key);
	if (!project) throw new Error("project was not stored");
	const ctx = makeCtx(env.app, project, env.actor, true);
	seedPolicy(ctx, preset);
	stampSeq(ctx);
	return { key: project.key, name: project.name, policy: preset };
}

export function admin(env: InstanceCtx, input: AdminInput): unknown {
	const db = env.app.db;
	switch (input.do) {
		case "project.create":
			return createProject(env, input);
		case "project.list":
			return listProjects(db);
		case "token.create": {
			const project = input.project ? findProject(db, input.project) : null;
			if (input.project && !project) throw notFound(`project ${input.project}`);
			const can =
				input.can.length > 0 ? input.can : input.kind === "human" ? ALL_CAPABILITIES : (["read", "produce"] as const);
			const created = createToken(env.app, {
				actor: input.actor,
				kind: input.kind,
				can,
				project: project?.id ?? 0,
				label: input.label ?? `${input.kind} token`,
			});
			return { actor: created.actor, token: created.secret, can, note: "This token is shown once. Store it now." };
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
		case "actor.list":
			return listActors(db);
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
	summary: "Projects, actors and tokens. There are no seats: an actor is free, and a token carries its capabilities.",
	input: AdminInput,
	needs: "admin",
	scope: "instance",
	effect: "write",
	mcp: null,
	run: admin,
});
