import type { AnnounceInput, AnnounceReply } from "../../core/ops.ts";
import type { Ctx } from "../kernel/ctx.ts";
import { type ReadDb, json, sql } from "../kernel/db.ts";
import { conflict, forbidden, invalid, notFound } from "../kernel/errors.ts";

type Artifact = {
	id: number;
	digest: string;
	code: string;
	actor: number;
	at: number;
};
type Build = Artifact & { build_id: number; label: string };
type Deployment = {
	id: number;
	build: string;
	digest: string;
	env: string;
	actor: number;
	at: number;
	code: string;
	attested_by: number;
	attested_at: number;
};

const Q = {
	build: sql<{ project: number; label: string }, Build>(
		`SELECT a.*, b.id AS build_id, b.label FROM builds b JOIN artifacts a ON a.id = b.artifact
		 WHERE b.project = $project AND b.label = $label`,
	),
	artifact: sql<{ project: number; digest: string }, Artifact>(
		"SELECT * FROM artifacts WHERE project = $project AND digest = $digest",
	),
	insertArtifact: sql<{ project: number; digest: string; code: string; actor: number; at: number; seq: number }>(
		`INSERT INTO artifacts (project, digest, code, actor, at, seq)
		 VALUES ($project, $digest, $code, $actor, $at, $seq)`,
	),
	insertBuild: sql<{ project: number; label: string; artifact: number; seq: number }>(
		"INSERT INTO builds (project, label, artifact, seq) VALUES ($project, $label, $artifact, $seq)",
	),
	deploy: sql<{ project: number; build: number; env: string; actor: number; at: number; seq: number }>(
		`INSERT INTO deployments (project, build, env, actor, at, seq)
		 VALUES ($project, $build, $env, $actor, $at, $seq)`,
	),
	environments: sql<{ project: number; build: number }, { env: string }>(
		"SELECT DISTINCT env FROM deployments WHERE project = $project AND build = $build ORDER BY env",
	),
	deployments: sql<{ project: number; before: number; limit: number }, Deployment>(
		`SELECT d.id, b.label AS build, a.digest, a.code, d.env, d.actor, d.at,
		 a.actor AS attested_by, a.at AS attested_at
		 FROM deployments d JOIN builds b ON b.id = d.build JOIN artifacts a ON a.id = b.artifact
		 WHERE d.project = $project AND d.id < $before ORDER BY d.id DESC LIMIT $limit`,
	),
};

/** Build labels are immutable and project-local. A digest is the target identity, shared by its labels. */
async function mustBuild(db: ReadDb, project: number, label: string): Promise<Build> {
	const build = await db.get(Q.build, { project, label });
	if (!build) throw notFound(`build ${label}`);
	return build;
}

export async function buildWhat(db: ReadDb, project: number, label: string, env?: string): Promise<string> {
	const build = await mustBuild(db, project, label);
	if (env !== undefined) {
		const environments = (await db.all(Q.environments, { project, build: build.build_id })).map((row) => row.env);
		if (!environments.includes(env))
			throw invalid(
				`build ${label} has not been deployed to ${JSON.stringify(env)}; deployed environments: ${environments.map((value) => JSON.stringify(value)).join(", ") || "none"}`,
			);
	}
	return `artifact:${build.digest}`;
}

/** The authenticated pipeline or admin attests the artifact's source, then records a deployment fact. */
export async function announce(ctx: Ctx, input: AnnounceInput): Promise<AnnounceReply> {
	if (ctx.actor.kind !== "ci" && !(ctx.actor.kind === "human" && ctx.actor.can.includes("admin")))
		throw forbidden("only a pipeline or a human admin may announce a deployment and attest its artifact");
	const project = ctx.project.id;
	const code = input.code
		? JSON.stringify(
				[...new Map(input.code.map((entry) => [`${entry.repo}@${entry.commit}`, entry])).values()].sort(
					(a, b) => a.repo.localeCompare(b.repo) || a.commit.localeCompare(b.commit),
				),
			)
		: null;
	let build = await ctx.db.get(Q.build, { project, label: input.deploy });
	if (build) {
		if (input.digest !== undefined && input.digest !== build.digest)
			throw conflict(`build ${input.deploy} is already bound to ${build.digest}`);
		if (code !== null && code !== build.code) throw conflict("the artifact's attested source cannot change");
	} else {
		if (!input.digest) throw invalid("a new build label needs its artifact digest");
		let artifact = await ctx.db.get(Q.artifact, { project, digest: input.digest });
		if (artifact) {
			if (code !== null && code !== artifact.code) throw conflict("the artifact's attested source cannot change");
		} else {
			if (code === null) throw invalid("a new artifact needs its source repositories and full commits in code");
			await ctx.db.run(Q.insertArtifact, {
				project,
				digest: input.digest,
				code,
				actor: ctx.actor.id,
				at: ctx.now,
				seq: ctx.seq,
			});
			artifact = await ctx.db.get(Q.artifact, { project, digest: input.digest });
			if (!artifact) throw new Error("artifact was not stored");
		}
		await ctx.db.run(Q.insertBuild, { project, label: input.deploy, artifact: artifact.id, seq: ctx.seq });
		build = await mustBuild(ctx.db, project, input.deploy);
	}
	const { lastId } = await ctx.db.run(Q.deploy, {
		project,
		build: build.build_id,
		env: input.env,
		actor: ctx.actor.id,
		at: ctx.now,
		seq: ctx.seq,
	});
	return {
		deployment: lastId,
		build: input.deploy,
		digest: build.digest,
		env: input.env,
		code: json<AnnounceReply["code"]>(build.code),
		by: ctx.actor.name,
		at: ctx.now,
	};
}

export const deployments = async (
	db: ReadDb,
	input: { project: number; before: number; limit: number },
): Promise<Deployment[]> => await db.all(Q.deployments, input);
