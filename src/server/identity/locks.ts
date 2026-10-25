// Actor locks protect authority across a writer's transaction. Changes take an exclusive lock;
// ordinary writes share the row, so one caller can write to independent projects concurrently.
import { z } from "zod";
import { mayRun } from "../../core/kinds.ts";
import type { App } from "../kernel/app.ts";
import { CallerReference } from "../kernel/caller.ts";
import { type Actor, type Ctx, lockProject, lockProjectKey, projectById } from "../kernel/ctx.ts";
import { Busy, type ReadDb, sql, type WriteDb } from "../kernel/db.ts";
import { actorById, resolveCaller } from "./identity.ts";

const Q = {
	identity: sql<readonly []>("SELECT pg_advisory_xact_lock(821, 1)"),
	share: sql<{ ids: readonly number[] }, { id: number; auth_version: number }>(
		"SELECT id, auth_version FROM actors WHERE id = ANY($ids::bigint[]) ORDER BY id FOR SHARE",
	),
	exclusive: sql<{ ids: readonly number[] }, { id: number; auth_version: number }>(
		"SELECT id, auth_version FROM actors WHERE id = ANY($ids::bigint[]) ORDER BY id FOR UPDATE",
	),
	named: sql<{ names: readonly string[] }, { id: number; name: string }>(
		"SELECT id, name FROM actors WHERE name = ANY($names::text[]) ORDER BY id",
	),
	tokenHash: sql<{ hash: string }, { id: number }>("SELECT actor AS id FROM tokens WHERE hash = $hash"),
	sessionHash: sql<{ hash: string }, { id: number }>("SELECT actor AS id FROM sessions WHERE hash = $hash"),
	token: sql<{ id: number }, { id: number }>("SELECT actor AS id FROM tokens WHERE id = $id"),
	session: sql<{ id: number }, { id: number }>("SELECT actor AS id FROM sessions WHERE id = $id"),
	credential: sql<{ id: number }, { id: number }>("SELECT actor AS id FROM credentials WHERE id = $id"),
	guard: sql<{ name: string }, { id: number }>("SELECT id FROM teams WHERE name = $name ORDER BY id FOR NO KEY UPDATE"),
	team: sql<{ name: string }, { id: number }>(
		"SELECT m.actor AS id FROM team_members m JOIN teams t ON t.id = m.team WHERE t.name = $name ORDER BY m.actor",
	),
	guards: sql<{ ids: readonly number[] }>(
		"SELECT id FROM teams WHERE id = ANY($ids::bigint[]) ORDER BY id FOR NO KEY UPDATE",
	),
	actorTeams: sql<{ ids: readonly number[] }, { id: number }>(
		"SELECT DISTINCT team AS id FROM team_members WHERE actor = ANY($ids::bigint[]) ORDER BY team",
	),
	projectActors: sql<{ project: number }, { id: number }>(
		`SELECT actor AS id FROM grants WHERE project = $project UNION SELECT m.actor AS id FROM team_members m JOIN team_grants g ON g.team = m.team WHERE g.project = $project ORDER BY id`,
	),
	projectTeams: sql<{ project: number }, { id: number }>(
		"SELECT team AS id FROM team_grants WHERE project = $project ORDER BY team",
	),
	all: sql<readonly [], { id: number }>("SELECT id FROM actors ORDER BY id"),
	version: sql<{ id: number }, { auth_version: number; disabled_at: number | null }>(
		"SELECT auth_version, disabled_at FROM actors WHERE id = $id",
	),
	keep: sql<{ batch: number; actor: number; version: number; reference: string }>(
		"INSERT INTO batch_admissions (batch, actor, auth_version, reference) VALUES ($batch, $actor, $version, $reference)",
	),
	admission: sql<{ batch: number }, { actor: number; auth_version: number; reference: string }>(
		"SELECT actor, auth_version, reference FROM batch_admissions WHERE batch = $batch",
	),
	forget: sql<{ batch: number }>("DELETE FROM batch_admissions WHERE batch = $batch"),
};
/** Identity discovery and mutation share one transaction lock, before any actor or project lock. */
export async function lockIdentity(db: WriteDb): Promise<void> {
	if (!db.inTransaction) throw new Error("identity locks need a transaction");
	await db.all(Q.identity);
}
export async function lockActors(db: WriteDb, ids: readonly number[], exclusive = false): Promise<void> {
	if (exclusive) await lockIdentity(db);
	await db.all(exclusive ? Q.exclusive : Q.share, { ids: [...new Set(ids)].sort((a, b) => a - b) });
}
export async function lockAllActors(db: WriteDb): Promise<void> {
	await lockIdentity(db);
	await lockActors(
		db,
		(await db.all(Q.all)).map((row) => row.id),
		true,
	);
}
/** Identity writers serialize before discovery, then take their complete actor footprint before project rows. */
export async function lockCallActors(
	db: WriteDb,
	caller: Pick<Actor, "id">,
	op: string,
	input: unknown,
): Promise<void> {
	if (!["admin", "session", "credential", "invitation"].includes(op)) {
		await lockActors(db, [caller.id]);
		return;
	}
	await lockIdentity(db);
	const parsed = z.record(z.string(), z.unknown()).safeParse(input);
	const data = parsed.success ? parsed.data : {};
	const names = [
		data.actor,
		...(op === "invitation" || data.do === "actor.forget" ? [data.name] : []),
		...(typeof data.do === "string" && data.do.startsWith("team.member.") ? [data.person] : []),
	].filter((value): value is string => typeof value === "string");
	const named = await db.all(Q.named, { names });
	const affected = named.map((row) => row.id);
	if (op === "credential" && data.actor === undefined) affected.push(caller.id);
	const idQuery =
		op === "session" ? Q.session : data.do === "token.revoke" ? Q.token : op === "credential" ? Q.credential : null;
	if (typeof data.id === "number") {
		if (idQuery) affected.push(...(await db.all(idQuery, { id: data.id })).map((row) => row.id));
	}
	const teamGrant = typeof data.do === "string" && data.do.startsWith("team.grant.") && typeof data.team === "string";
	if (teamGrant && typeof data.team === "string")
		affected.push(...(await db.all(Q.team, { name: data.team })).map((row) => row.id));
	const ids = [...new Set([caller.id, ...affected])].sort((a, b) => a - b);
	for (const id of ids) await lockActors(db, [id], affected.includes(id));
	if (typeof data.team === "string") await db.all(Q.guard, { name: data.team });
	if (data.do === "actor.forget")
		await db.all(Q.guards, { ids: (await db.all(Q.actorTeams, { ids: affected })).map((row) => row.id) });
}

export async function keepBatchAdmission(ctx: Ctx, batch: number): Promise<void> {
	const version = await ctx.db.one(Q.version, { id: ctx.actor.id });
	// Direct domain callers have no credential. Their trusted actor still undergoes the same authority check.
	const reference = ctx.reference ?? { via: "actor", id: ctx.actor.id };
	await ctx.db.run(Q.keep, {
		batch,
		actor: ctx.actor.id,
		version: version.auth_version,
		reference: JSON.stringify(reference),
	});
}
export const forgetBatchAdmission = async (db: WriteDb, batch: number): Promise<void> => {
	await db.run(Q.forget, { batch });
};
export async function batchAllowed(
	app: App,
	db: ReadDb,
	batch: number,
	actor: number,
	project: number,
): Promise<boolean> {
	const admission = await db.get(Q.admission, { batch });
	if (!admission || admission.actor !== actor) return false;
	const current = await db.get(Q.version, { id: actor });
	if (!current || current.disabled_at !== null || current.auth_version < admission.auth_version) return false;
	const reference: unknown = JSON.parse(admission.reference);
	const trusted = z.object({ via: z.literal("actor"), id: z.number().int() }).safeParse(reference);
	const parsed = CallerReference.safeParse(reference);
	const allowed =
		trusted.success && trusted.data.id === actor
			? await actorById(db, actor, project)
			: parsed.success
				? (await resolveCaller(app, db, parsed.data, project))?.actor
				: null;
	// Always read current authority, including when a version changed while acceptance was durable.
	return !!allowed && allowed.id === actor && mayRun(allowed, "record");
}

export async function lockTokenHash(db: WriteDb, hash: string): Promise<void> {
	await lockIdentity(db);
	const row = await db.get(Q.tokenHash, { hash });
	if (row) {
		await lockActors(db, [row.id]);
		if ((await db.get(Q.tokenHash, { hash }))?.id !== row.id) throw new Busy();
	}
}
export async function lockSessionHash(db: WriteDb, hash: string): Promise<void> {
	await lockIdentity(db);
	const row = await db.get(Q.sessionHash, { hash });
	if (row) {
		await lockActors(db, [row.id], true);
		if ((await db.get(Q.sessionHash, { hash }))?.id !== row.id) throw new Busy();
	}
}
export async function lockCredential(db: WriteDb, id: number): Promise<void> {
	await lockIdentity(db);
	const row = await db.get(Q.credential, { id });
	if (row) {
		await lockActors(db, [row.id], true);
		if ((await db.get(Q.credential, { id }))?.id !== row.id) throw new Busy();
	}
}

export async function lockIdentityRoster(db: WriteDb): Promise<void> {
	await lockIdentity(db);
	await db.exec("LOCK TABLE actors IN ACCESS EXCLUSIVE MODE");
}

/** A project reset removes grants too, so its whole authority footprint precedes its project row. */
export async function lockProjectAuthority(
	db: WriteDb,
	projects: number | readonly number[],
	caller?: number,
): Promise<void> {
	await lockIdentity(db);
	const ids = [...new Set(typeof projects === "number" ? [projects] : projects)].sort((a, b) => a - b);
	const hints = [];
	const affected = new Set<number>();
	const teams = new Set<number>();
	for (const project of ids) {
		const hint = await projectById(db, project);
		if (!hint) throw new Busy();
		hints.push(hint);
		for (const row of await db.all(Q.projectActors, { project })) affected.add(row.id);
		for (const row of await db.all(Q.projectTeams, { project })) teams.add(row.id);
	}
	for (const id of [...new Set([...(caller === undefined ? [] : [caller]), ...affected])].sort((a, b) => a - b))
		await lockActors(db, [id], affected.has(id));
	await db.all(Q.guards, { ids: [...teams].sort((a, b) => a - b) });
	for (const hint of hints) await lockProjectKey(db, hint.key);
	for (const hint of hints) {
		const locked = await lockProject(db, hint.id);
		if (locked?.identity !== hint.identity || locked.key !== hint.key) throw new Busy();
	}
	for (const project of ids) {
		if ((await db.all(Q.projectActors, { project })).some((row) => !affected.has(row.id))) throw new Busy();
		if ((await db.all(Q.projectTeams, { project })).some((row) => !teams.has(row.id))) throw new Busy();
	}
}
