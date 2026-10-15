// Administering the instance: projects, actors, tokens, and reading a project's policy.
import { durationMs } from "../../core/duration.ts";
import { type ActorKind, defaultCapabilities, type Unlinked } from "../../core/kinds.ts";
import { AdminInput } from "../../core/ops.ts";
import { REPLIES } from "../../core/replies.ts";
import { forgetQuestionNames } from "../decisions/questions.ts";
import { rewriteReportReceipts } from "../evidence/evidence.ts";
import {
	actorByName,
	createToken,
	forgetActor,
	KIND_NOUN,
	listActors,
	listTokens,
	orgId,
	removeGrant,
	revokeToken,
	setGrant,
} from "../identity/identity.ts";
import {
	type Actor,
	allProjects,
	demoSince,
	findProject,
	insertProject,
	makeCtx,
	markDemo,
	rewriteCommandReplies,
	stampSeq,
} from "../kernel/ctx.ts";
import type { Db } from "../kernel/db.ts";
import { conflict, forbidden, invalid, notFound } from "../kernel/errors.ts";
import { currentPolicy, isPreset, policySummary, seedPolicy } from "../policy/policy.ts";
import { defineInstanceOp, type InstanceCtx } from "./registry.ts";

/** Every project with the policy in force. A plain read, so the session endpoint can call it during a long write. */
export function listProjects(
	db: Db,
): { key: string; name: string; seq: number; createdAt: number; policy: string; unlinked: Unlinked; demo: boolean }[] {
	return allProjects(db).map((row) => ({
		key: row.key,
		name: row.name,
		seq: row.seq,
		createdAt: row.created_at,
		...policySummary(currentPolicy(db, row.id)),
		demo: demoSince(db, row.id) !== null,
	}));
}

/** Creates a project with its first policy. Used by the admin operation and by first start. */
export function createProject(
	env: InstanceCtx,
	input: { key: string; name?: string | undefined; preset?: string | undefined; unlinked?: Unlinked | undefined },
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
	seedPolicy(ctx, preset, input.unlinked);
	stampSeq(ctx);
	return { key: project.key, name: project.name, policy: preset };
}

/** The id of the project a grant names, or 0 when it names none: every project. */
export function projectOf(db: Db, key: string | undefined): number {
	if (key === undefined) return 0;
	const project = findProject(db, key);
	if (!project) throw notFound(`project ${key}`);
	return project.id;
}

/** Every actor with its grants as a person reads them: each names its project by key, and every project as `*`. */
export function actorsWithGrants(db: Db) {
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

/**
 * Who a person is, what a person may do and whether a person is remembered are for a person to change. An agent
 * may hold `admin` and do the rest of it (projects, its own kind's tokens, the lists); with a person's token it
 * would be a person to every policy clause that says "not an agent", and with a grant of its choosing it would be
 * whatever it liked.
 */
export function personOnly(env: InstanceCtx, what: string): void {
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
 *
 * An invitation is held to the same rule (`what`): whoever accepts one for a name signs in under that name.
 */
export function refuseToken(
	env: InstanceCtx,
	input: { kind: ActorKind },
	existing: Actor | null,
	what: "token" | "invitation" = "token",
): void {
	// What the actor is decides, not what the request calls it: naming another kind for a person does not help.
	const forPerson = existing ? existing.kind === "human" : input.kind === "human";
	if (!forPerson) return;
	personOnly(env, `a person's ${what} is made`);
	const owner = env.app.config.owner;
	if (!existing || existing.id === env.actor.id || env.actor.name === owner) return;
	const one = what === "token" ? "a token" : "an invitation";
	throw forbidden(
		existing.name === owner
			? `only ${owner}, who owns this instance, makes ${one} for ${owner}`
			: `${one} for ${existing.name} is made by ${existing.name} or by ${owner}, who owns this instance`,
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
		case "project.demo": {
			const project = findProject(db, input.key);
			if (!project) throw notFound(`project ${input.key}`);
			const since = markDemo(db, project, env.now);
			if (since === null)
				throw conflict(
					`project ${input.key} holds work, and what it records keeps the server's clock; a demo is a project nothing was written to`,
				);
			return { key: project.key, since };
		}
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
		case "token.revoke":
			return { revoked: revokeToken(env.app, input.id) };
		case "actor.list":
			return actorsWithGrants(db);
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
			const forgotten = forgetActor(env.app, input.name);
			forgetQuestionNames(db, input.name, forgotten.forgotten);
			// These write replies name people in grant.actor, report.questions[].by and claim.known[].by.
			// Requests are digests; their binding to a command id must survive forgetting, as must free text.
			const rewrite = (op: string, reply: string): string => {
				const field = op === "admin" ? "actor" : op === "report" || op === "claim" ? "by" : null;
				if (field === null || !reply.includes(JSON.stringify(input.name))) return reply;
				return JSON.stringify(
					JSON.parse(reply, (key, value: unknown) =>
						key === field && value === input.name ? forgotten.forgotten : value,
					),
				);
			};
			rewriteCommandReplies(db, rewrite);
			rewriteReportReceipts(db, (receipt) => rewrite("report", receipt));
			return forgotten;
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
	output: REPLIES.admin,
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
