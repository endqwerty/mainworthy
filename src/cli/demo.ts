// A demo that is new on every start: `MAINWORTHY_DEMO=<project>` has `mainworthy serve` empty that project and
// seed it again once it listens, so an instance that follows `main` always shows the demo of the code it runs.
import { z } from "zod";
import { Capability, type Role } from "../core/kinds.ts";
import { createToken, manageTeams, orgId, revokeToken, setGrant } from "../server/identity/identity.ts";
import type { App } from "../server/kernel/app.ts";
import { type Actor, demoSince, findProject, markDemo } from "../server/kernel/ctx.ts";
import { actorsWithGrants, createProject } from "../server/ops/admin.ts";
import type { Instance } from "../server/start.ts";
import { firstWrite, removeProject } from "../server/transfer/transfer.ts";
import { Client } from "./client.ts";
import { CliError } from "./errors.ts";
import { DEFAULT_SEED_CASES, DEMO_ACTORS, refuseProducers, type SeedResult, seed } from "./seed.ts";

const Projects = z.array(z.object({ key: z.string() }));
const Capabilities = z.array(Capability).min(1);
const Teams = z.array(
	z.object({ name: z.string(), grants: z.array(z.object({ project: z.string(), can: z.array(z.string()) })) }),
);
/** A grant on the demo, of a person, an agent or a pipeline, or of a team. */
type Grant = { holder: "actor" | "team"; name: string; can: readonly string[]; roles?: readonly Role[] };

/** How long the token the demo is seeded with works, at most. It is revoked when the seed ends. */
const LASTS_MS = 15 * 60_000;

/**
 * Empties `project` and seeds the demo there again, as the owner, through the instance's own HTTP surface. Only a
 * demo project is emptied (decision 0020): one is made a demo while nothing was written to it, so nothing in it is
 * older than the demo, and the setting's name slipping onto somebody's work empties nothing. Any other project is
 * left as it is and refused. One that does not exist yet is made. The grants on the project, a team's included, are
 * kept: whoever could use the demo still can.
 *
 * The owner is given a token for this alone, which ends after a quarter of an hour and is revoked at the end.
 */
export async function refreshDemo(
	instance: Instance,
	project: string,
	size: { cases: number; unlinkedFiles: number; days?: number } = { cases: DEFAULT_SEED_CASES, unlinkedFiles: 60 },
): Promise<SeedResult> {
	const { app, owner } = instance;
	const label = `demo seed of ${project}`;
	const { id, secret } = await app.gate.run(() =>
		app.db.transaction(() =>
			createToken(app, {
				actor: owner.name,
				kind: "human",
				can: [],
				project: 0,
				label,
				lastsMs: LASTS_MS,
				madeBy: owner.id,
			}),
		),
	);
	const client = new Client({ url: instance.url, token: secret, project });
	try {
		// What would stop the seed is asked first, so a start that cannot seed empties nothing.
		await refuseProducers(client);
		const projects = Projects.parse(await client.call("admin", { do: "project.list" }));
		if (projects.some((row) => row.key === project)) {
			// A demo seeded before projects were marked demos carries no mark. Its first write is that seed's.
			const legacy = await client.call("command", { cmd: `demo-${project}-folders-v1` });
			const emptied = await app.gate.run(() =>
				app.db.transaction(() => {
					// Only a demo is emptied. A project became one while nothing was written to it (decision 0020), so
					// nothing in it is older than the demo. One from before the mark counts when the first thing
					// written to it was its seed's (`firstWrite`); a command id alone proves nothing, anybody sends one.
					const found = findProject(app.db, project);
					const marked = found !== null && demoSince(app.db, found.id) !== null;
					const seededBefore = legacy.state === "done" && firstWrite(app.db, project) === legacy.seq;
					if (!marked && !seededBefore) return false;
					const held = grantsOn(app, owner, project);
					removeProject(app.db, project);
					// In the same transaction the project is made again, a demo and empty, with the grants it had: who
					// may use the demo is not part of it, and a start stopped after this keeps both. The seed fills it.
					createProject({ app, actor: owner, now: app.now(), session: null, context: null }, { key: project });
					const made = findProject(app.db, project);
					if (!made || markDemo(app.db, made, app.now()) === null)
						throw new CliError("internal", `project ${project} was made again and could not be marked a demo`);
					for (const grant of held) {
						const can = Capabilities.parse(grant.can);
						if (grant.holder === "team")
							manageTeams(app, owner, orgId(app.db), { do: "team.grant.set", team: grant.name, project, can });
						else
							setGrant(app, {
								actor: grant.name,
								project: made.id,
								can,
								...(grant.roles ? { roles: grant.roles } : {}),
							});
					}
					return true;
				}),
			);
			if (!emptied)
				throw new CliError(
					"conflict",
					`MAINWORTHY_DEMO names project ${project}, which is not a demo; it is left as it is`,
				);
		}
		return await seed(client, { project, ...size });
	} finally {
		// The token this start made, by its id: no other token is touched.
		await app.gate.run(() => revokeToken(app, id)).catch(() => undefined);
	}
}

/**
 * The grants on `project`, of actors and of teams: what the demo is given back once it is made again. The owner
 * holds every project, and an actor that was forgotten holds nothing: neither is given anything back. The demo's own
 * pipeline and agent are given theirs by the seed (`DEMO_ACTORS`).
 */
function grantsOn(app: App, owner: Actor, project: string): Grant[] {
	const held: Grant[] = actorsWithGrants(app.db)
		.filter((actor) => actor.name !== owner.name && !actor.disabled && !DEMO_ACTORS.includes(actor.name))
		.flatMap((actor) =>
			actor.grants
				.filter((grant) => grant.project === project)
				.map((grant) => ({ holder: "actor" as const, name: actor.name, can: grant.can, roles: grant.roles })),
		);
	for (const team of Teams.parse(manageTeams(app, owner, orgId(app.db), { do: "team.list" })))
		for (const grant of team.grants.filter((grant) => grant.project === project))
			held.push({ holder: "team", name: team.name, can: grant.can });
	return held;
}
