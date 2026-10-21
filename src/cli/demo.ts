// A demo that is new on every start: `MAINWORTHY_DEMO=<project>` has `mainworthy serve` empty that project and
// seed it again once it listens, so an instance that follows `main` always shows the demo of the code it runs.
import { Worker } from "node:worker_threads";
import { z } from "zod";
import type { Instance } from "../app/start.ts";
import { Capability, type Role } from "../core/kinds.ts";
import { createToken, manageTeams, orgId, revokeToken, setGrant } from "../server/identity/identity.ts";
import type { App, Config } from "../server/kernel/app.ts";
import { type Actor, demoSince, findProject, markDemo } from "../server/kernel/ctx.ts";
import { actorsWithGrants, createProject } from "../server/ops/admin.ts";
import { OPS } from "../server/ops/index.ts";
import { invokeAsync } from "../server/ops/registry.ts";
import { firstWrite, removeProject } from "../server/transfer/transfer.ts";
import { Client } from "./client.ts";
import { DEMO_WORK } from "./demo/work.ts";
import { CliError } from "./errors.ts";
import { warning } from "./output.ts";
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

export type DemoResetData = {
	config: Config;
	owner: string;
	project: string;
	legacySeq: number | null;
	clockOffset: number;
};

/**
 * Empties `project` and seeds the demo there again, as the owner, through the instance's own HTTP surface. Only a
 * demo project is emptied (decision 0100): one is made a demo while nothing was written to it, so nothing in it is
 * older than the demo, and the setting's name slipping onto somebody's work empties nothing. Any other project is
 * left as it is and refused. One that does not exist yet is made. The grants on the project, a team's included, are
 * kept: whoever could use the demo still can.
 *
 * The preflight and seed each get their own token, valid for fifteen minutes and revoked when that step ends.
 * The reset runs on its own thread without a token, so it cannot consume the seed token's lifetime.
 */
export async function refreshDemo(
	instance: Instance,
	project: string,
	size: { cases: number; unlinkedFiles: number; days?: number } = { cases: DEFAULT_SEED_CASES, unlinkedFiles: 60 },
	options: { step?: (name: string) => Promise<void>; preflight?: () => Promise<void>; signal?: AbortSignal } = {},
): Promise<SeedResult> {
	const { app, owner } = instance;
	const token = (label: string) =>
		app.gate.run(() =>
			app.db.transaction(() => {
				options.signal?.throwIfAborted();
				return createToken(app, {
					actor: owner.name,
					kind: "human",
					can: [],
					project: 0,
					label,
					lastsMs: LASTS_MS,
					madeBy: owner.id,
				});
			}),
		);
	const revoke = (id: number) => app.gate.run(() => revokeToken(app, id));
	const preflight = await token(`demo preflight of ${project}`);
	let exists = false;
	let legacySeq: number | null = null;
	const began = performance.now();
	try {
		const client = new Client({ url: instance.url, token: preflight.secret, project });
		await refuseProducers(client);
		exists = Projects.parse(await client.call("admin", { do: "project.list" })).some((row) => row.key === project);
		if (exists) {
			const legacy = await client.call("command", { cmd: `demo-${project}-folders-v1` });
			if (legacy.state === "done") legacySeq = legacy.seq;
		}
	} finally {
		await revoke(preflight.id);
		logStep(project, "preflight", performance.now() - began);
	}
	if (exists) await resetInWorker(instance, project, legacySeq, options);
	// Emptying can take longer than a token's lifetime. Make the seed's token only once it has ended.
	const seeding = await token(`demo seed of ${project}`);
	const since = performance.now();
	try {
		return await seed(new Client({ url: instance.url, token: seeding.secret, project }), { project, ...size });
	} finally {
		await revoke(seeding.id);
		logStep(project, "seed", performance.now() - since);
	}
}

const DemoMessage = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("progress"), step: z.string(), ms: z.number() }),
	z.object({ kind: z.literal("pause"), step: z.literal("removed") }),
	z.object({ kind: z.literal("done") }),
	z.object({ kind: z.literal("ready") }),
	z.object({ kind: z.literal("retry") }),
]);

function logStep(project: string, step: string, ms: number): void {
	warning(`[mainworthy] demo ${JSON.stringify(project)}: ${step} took ${ms.toFixed(1)} ms`);
}

async function resetInWorker(
	instance: Instance,
	project: string,
	legacySeq: number | null,
	options: { step?: (name: string) => Promise<void>; preflight?: () => Promise<void>; signal?: AbortSignal },
): Promise<void> {
	const worker = new Worker(
		new URL(Bun.isStandaloneExecutable ? "./cli/demo-worker.js" : "./demo-worker.ts", import.meta.url),
		{
			workerData: {
				// The proxy matcher is a function used only by HTTP requests; it cannot cross a worker channel.
				config: { ...instance.app.config, proxy: null },
				owner: instance.owner.name,
				project,
				legacySeq,
				clockOffset: instance.app.now() - Date.now(),
			} satisfies DemoResetData,
			name: "mainworthy-demo-reset",
		},
	);
	const began = performance.now();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let unlock: (() => void) | undefined;
	let gateWork: Promise<void> | undefined;
	let stopped = false;
	try {
		await new Promise<void>((resolve, reject) => {
			timer = setTimeout(() => reject(new Error("demo reset exceeded ten minutes; worker stopped")), 10 * 60_000);
			worker.on("message", (message: unknown) => {
				const parsed = DemoMessage.safeParse(message);
				if (!parsed.success) return reject(new Error("invalid demo reset worker reply"));
				const reply = parsed.data;
				if (reply.kind === "done") {
					unlock?.();
					return resolve();
				}
				if (reply.kind === "retry") {
					unlock?.();
					return;
				}
				if (reply.kind === "ready") {
					gateWork = Promise.resolve()
						.then(() => options.preflight?.())
						.then(() =>
							instance.app.gate.run(async () => {
								if (stopped) return;
								options.signal?.throwIfAborted();
								await new Promise<void>((release) => {
									unlock = release;
									worker.postMessage("continue");
								});
							}),
						);
					void gateWork.catch(reject);
					return;
				}
				if (reply.kind === "progress") return logStep(project, reply.step, reply.ms);
				void Promise.resolve()
					.then(() => options.step?.(reply.step))
					.then(() => worker.postMessage("continue"))
					.catch(reject);
			});
			worker.once("error", reject);
			worker.once("messageerror", reject);
			worker.once("exit", (code) => reject(new Error(`demo reset worker exited with code ${code}`)));
		});
	} finally {
		stopped = true;
		clearTimeout(timer);
		await worker.terminate();
		unlock?.();
		await gateWork;
		logStep(project, "reset transaction", performance.now() - began);
	}
}

/** The worker holds the write gate and one transaction across removal, recreation and grant restoration. */
export function* resetDemoSteps(
	app: App,
	owner: Actor,
	project: string,
	legacySeq: number | null,
	progress: (step: string, ms: number) => void,
	checkedVersion?: number,
): Generator<undefined, "stale" | undefined, void> {
	const checking = performance.now();
	const version = checkedVersion ?? app.db.foreignKeySnapshot();
	if (checkedVersion === undefined) progress("check foreign keys under the gate", performance.now() - checking);
	const starting = performance.now();
	let finishing = starting;
	try {
		return yield* app.db.deferredSteps(function* () {
			if (!app.db.foreignKeySnapshotMatches(version)) return "stale";
			progress("begin reset transaction", performance.now() - starting);
			try {
				const began = performance.now();
				const found = findProject(app.db, project);
				const marked = found !== null && demoSince(app.db, found.id) !== null;
				// Only an unmarked legacy demo needs the expensive provenance scan.
				const seededBefore = !marked && legacySeq !== null && firstWrite(app.db, project) === legacySeq;
				progress("check demo provenance", performance.now() - began);
				if (!marked && !seededBefore)
					throw new CliError(
						"conflict",
						`MAINWORTHY_DEMO names project ${project}, which is not a demo; it is left as it is`,
					);
				const grantsSince = performance.now();
				const held = grantsOn(app, owner, project);
				progress("save grants", performance.now() - grantsSince);
				const deferring = performance.now();
				// This bulk transaction has made no changes yet; keep deferral on until its final check and commit.
				app.db.exec("PRAGMA defer_foreign_keys = ON");
				progress("defer reset foreign keys", performance.now() - deferring);
				removeProject(app.db, project, progress, "deferred");
				yield;
				const recreating = performance.now();
				// A start stopped before commit keeps the old demo and grants. After commit it keeps an empty demo
				// and those same grants, so the next start can fill it again.
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
				progress("recreate demo and grants", performance.now() - recreating);
				return undefined;
			} finally {
				finishing = performance.now();
			}
		});
	} finally {
		progress("finish reset transaction", performance.now() - finishing);
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

/** Renews only the configured demo's featured slot, through the same registry as a producer. */
export async function renewDemoWork(
	instance: Instance,
	project: string,
	seeded: Pick<SeedResult, "run" | "workSlot">,
): Promise<void> {
	if (seeded.workSlot === null) return;
	const read = await invokeAsync(instance.app, OPS, {
		op: "find",
		project,
		input: { in: "slots", run: seeded.run, limit: 200 },
		actor: () => instance.owner,
	});
	if (!read.ok) return;
	const slots = z.object({ items: z.array(z.object({ id: z.number(), state: z.string() })) }).parse(read.result).items;
	const slot = slots.find((slot) => slot.id === seeded.workSlot);
	if (!slot || !["missing", "skipped"].includes(slot.state)) return;
	await invokeAsync(instance.app, OPS, {
		op: "work",
		project,
		input: { do: "take", run: seeded.run, slot: seeded.workSlot, seconds: DEMO_WORK.seconds },
		actor: () => instance.owner,
	});
}
