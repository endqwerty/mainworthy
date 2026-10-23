import { type Capability, heldCapabilities } from "../../core/kinds.ts";
import type { TeamEvent, TeamInput } from "../../core/teams.ts";
import type { App } from "../kernel/app.ts";
import { type Actor, allProjects } from "../kernel/ctx.ts";
import { json, type ReadDb, sql, type WriteDb } from "../kernel/db.ts";
import { conflict, invalid, notFound } from "../kernel/errors.ts";
import { hasAdminGrant, providerVouches } from "./identity.ts";
import { endSessionsWithoutFactor, requireRecentProof } from "./sessions.ts";

type Team = { id: number; name: string; created_at: number };
type Grant = { project: number; can: string };
type Action = TeamEvent["action"];
const Q = {
	find: sql<{ org: number; name: string }, Team>("SELECT * FROM teams WHERE org = $org AND name = $name"),
	list: sql<{ org: number }, Team>("SELECT * FROM teams WHERE org = $org ORDER BY name"),
	create: sql<{ org: number; name: string; at: number }>(
		"INSERT INTO teams (org, name, created_at) VALUES ($org, $name, $at)",
	),
	person: sql<{ org: number; name: string }, { id: number; kind: string; disabled_at: number | null }>(
		"SELECT id, kind, disabled_at FROM actors WHERE org = $org AND name = $name",
	),
	members: sql<{ team: number }, { id: number; name: string }>(
		`SELECT a.id, a.name FROM team_members m JOIN actors a ON a.id = m.actor
		 WHERE m.team = $team AND a.disabled_at IS NULL ORDER BY a.name`,
	),
	add: sql<{ team: number; actor: number }>("INSERT OR IGNORE INTO team_members (team, actor) VALUES ($team, $actor)"),
	remove: sql<{ team: number; actor: number }>("DELETE FROM team_members WHERE team = $team AND actor = $actor"),
	forget: sql<{ actor: number }>("DELETE FROM team_members WHERE actor = $actor"),
	moveProjectGrants: sql<{ from: number; to: number }>("UPDATE team_grants SET project = $to WHERE project = $from"),
	moveProjectEvents: sql<{ from: number; to: number }>("UPDATE team_events SET project = $to WHERE project = $from"),
	grants: sql<{ team: number }, Grant>("SELECT project, can FROM team_grants WHERE team = $team ORDER BY project"),
	grant: sql<{ team: number; project: number; can: string }>(
		`INSERT INTO team_grants (team, project, can) VALUES ($team, $project, $can)
		 ON CONFLICT (team, project) DO UPDATE SET can = excluded.can`,
	),
	ungrant: sql<{ team: number; project: number }>("DELETE FROM team_grants WHERE team = $team AND project = $project"),
	sources: sql<{ actor: number }, Team>(
		"SELECT t.* FROM teams t JOIN team_members m ON m.team = t.id WHERE m.actor = $actor ORDER BY t.name",
	),
	effective: sql<{ actor: number; project: number | null }, Grant>(
		`SELECT g.project, g.can FROM team_grants g JOIN team_members m ON m.team = g.team
		 WHERE m.actor = $actor AND ($project::bigint IS NULL OR g.project = 0 OR g.project = $project)`,
	),
	event: sql<{
		team: number;
		by: number;
		at: number;
		action: Action;
		person: number | null;
		project: number | null;
		can: string | null;
	}>(
		`INSERT INTO team_events (team, by_actor, at, action, person, project, can)
		 VALUES ($team, $by, $at, $action, $person, $project, $can)`,
	),
	history: sql<
		{ team: number },
		{
			id: number;
			at: number;
			by: string;
			action: Action;
			person: string | null;
			project: number | null;
			can: string | null;
		}
	>(
		`SELECT e.id, e.at, b.name AS 'by', e.action, p.name AS person, e.project, e.can
		 FROM team_events e JOIN actors b ON b.id = e.by_actor LEFT JOIN actors p ON p.id = e.person
		 WHERE e.team = $team ORDER BY e.id`,
	),
};

export async function teamCapabilities(db: ReadDb, actor: number, project: number | null): Promise<Capability[]> {
	return (await db.all(Q.effective, { actor, project })).flatMap((grant) => json<Capability[]>(grant.can));
}

export async function teamsOf(db: ReadDb, actor: number) {
	return (await db.all(Q.sources, { actor })).map((team) => ({ name: team.name, grants: grantsOf(db, team.id) }));
}

export async function dropTeamMemberships(db: WriteDb, actor: number): Promise<void> {
	await db.run(Q.forget, { actor });
}

async function grantsOf(db: ReadDb, team: number) {
	return (await db.all(Q.grants, { team })).map((grant) => ({
		project: grant.project,
		can: heldCapabilities("human", json<Capability[]>(grant.can)),
	}));
}

export async function manageTeams(app: App, by: Actor, org: number, input: TeamInput, context: string | null = null) {
	const db = app.db;
	const keys = new Map((await allProjects(db)).map((project) => [project.id, project.key]));
	const projectKey = (id: number): string => (id === 0 ? "*" : (keys.get(id) ?? `project ${id}`));
	const displayGrants = async (team: number) =>
		(await grantsOf(db, team)).map((grant) => ({ ...grant, project: projectKey(grant.project) }));
	if (input.do === "team.list") {
		return db.all(Q.list, { org }).map((team) => ({
			name: team.name,
			createdAt: team.created_at,
			grants: displayGrants(team.id),
			members: db.all(Q.members, { team: team.id }).map((person) => person.name),
		}));
	}
	const name = input.do === "team.create" ? input.name : input.team;
	let team = db.get(Q.find, { org, name });
	if (input.do === "team.create") {
		if (team) throw conflict(`team ${name} exists`);
		db.run(Q.create, { org, name, at: app.now() });
		team = db.get(Q.find, { org, name });
		if (!team) throw new Error("team was not stored");
		db.run(Q.event, {
			team: team.id,
			by: by.id,
			at: app.now(),
			action: "created",
			person: null,
			project: null,
			can: null,
		});
		return { team: name, changed: true };
	}
	if (!team) throw notFound(`team ${name}`);
	if (input.do === "team.history") {
		return db.all(Q.history, { team: team.id }).map((event) => ({
			...event,
			project: event.project === null ? null : projectKey(event.project),
			can: event.can === null ? null : json<Capability[]>(event.can),
		}));
	}
	if (
		context !== null &&
		((input.do === "team.grant.set" && input.can.includes("admin")) ||
			(input.do === "team.member.add" && (await grantsOf(db, team.id)).some((grant) => grant.can.includes("admin"))))
	)
		await requireRecentProof(app, { actor: by.id, context });
	let person: number | null = null;
	let project: number | null = null;
	let can: string | null = null;
	let changed = false;
	let action: Action;
	const adminsBefore = new Map<number, boolean>();
	switch (input.do) {
		case "team.member.add":
		case "team.member.remove": {
			if (input.person === by.name)
				throw invalid("you cannot change your own team membership; another admin must do it");
			if (input.person === app.config.owner) throw invalid("the owner may do everything and is not a team member");
			const found = db.get(Q.person, { org, name: input.person });
			if (!found || found.disabled_at !== null) throw notFound(`person ${input.person}`);
			if (found.kind !== "human") throw invalid("only a person can join a team");
			person = found.id;
			action = input.do === "team.member.add" ? "member.add" : "member.remove";
			if (app.config.requireAdminMfa && action === "member.add")
				adminsBefore.set(person, await hasAdminGrant(db, person));
			changed = db.run(action === "member.add" ? Q.add : Q.remove, { team: team.id, actor: person }).changes > 0;
			break;
		}
		case "team.grant.set":
		case "team.grant.remove": {
			if (db.all(Q.members, { team: team.id }).some((person) => person.id === by.id))
				throw invalid("you cannot change grants of a team you belong to; another admin must do it");
			project =
				input.project === undefined ? 0 : ((await allProjects(db)).find((p) => p.key === input.project)?.id ?? null);
			if (project === null) throw notFound(`project ${input.project}`);
			if (input.do === "team.grant.remove") {
				action = "grant.remove";
				changed = db.run(Q.ungrant, { team: team.id, project }).changes > 0;
			} else {
				action = "grant.set";
				can = JSON.stringify([...new Set(input.can)].sort());
				const previous = db.all(Q.grants, { team: team.id }).find((grant) => grant.project === project);
				changed = previous?.can !== can;
				if (changed) {
					if (app.config.requireAdminMfa)
						for (const member of db.all(Q.members, { team: team.id }))
							adminsBefore.set(member.id, await hasAdminGrant(db, member.id));
					db.run(Q.grant, { team: team.id, project, can });
				}
			}
			break;
		}
		default: {
			const _exhaustive: never = input;
			throw invalid(`unknown team action ${JSON.stringify(_exhaustive)}`);
		}
	}
	for (const [actor, wasAdmin] of adminsBefore)
		if (changed && !wasAdmin && hasAdminGrant(db, actor))
			await endSessionsWithoutFactor(db, actor, app.now(), providerVouches(app));
	if (changed) db.run(Q.event, { team: team.id, by: by.id, at: app.now(), action, person, project, can });
	return { team: name, changed };
}

/** The caller holds the transaction that swaps demo projects. */
export function moveTeamProjectGrants(db: Db, from: number, to: number): void {
	db.run(Q.moveProjectGrants, { from, to });
	db.run(Q.moveProjectEvents, { from, to });
}
