// A deployment swaps the visible demo once per revision. Retired data drains in separate gate turns.
import { z } from "zod";
import type { Instance } from "../app/start.ts";
import {
	createToken,
	lockActors,
	lockProjectAuthority,
	moveProjectGrants,
	revokeToken,
} from "../server/identity/identity.ts";
import type { App } from "../server/kernel/app.ts";
import {
	demoDeployment,
	demoSince,
	findProject,
	lockNamedProject,
	lockProject,
	lockProjectKey,
	markDemo,
	projectById,
	retireDemo,
	retiredDemos,
	setDemoDeployment,
} from "../server/kernel/ctx.ts";
import { Busy } from "../server/kernel/db.ts";
import { createProject } from "../server/ops/admin.ts";
import { OPS } from "../server/ops/index.ts";
import { invoke } from "../server/ops/registry.ts";
import { type RemovalPlan, removalPlan, removeProjectSlice } from "../server/transfer/transfer.ts";
import { Client } from "./client.ts";
import { DEMO_WORK } from "./demo/work.ts";
import { CliError } from "./errors.ts";
import { warning } from "./output.ts";
import {
	DEFAULT_SEED_CASES,
	DEFAULT_SEED_DAYS,
	MAX_SEED_CASES,
	MAX_SEED_DAYS,
	MAX_SEED_UNLINKED_FILES,
	refuseProducers,
	type SeedResult,
	seed,
} from "./seed.ts";

const LASTS_MS = 15 * 60_000;
const refreshing = new WeakMap<App, Promise<unknown>>();
const draining = new WeakMap<App, Promise<void>>();
type Options = {
	signal?: AbortSignal;
	step?: (name: string) => Promise<void>;
	held?: (kind: "swap", ms: number) => void;
};

/** Same-revision ready demos are returned untouched; partial seeds resume against the marked project. */
export function refreshDemo(
	instance: Instance,
	project: string,
	size: { cases: number; unlinkedFiles: number; days?: number } = { cases: DEFAULT_SEED_CASES, unlinkedFiles: 60 },
	options: Options = {},
): Promise<SeedResult> {
	const previous = refreshing.get(instance.app) ?? Promise.resolve();
	const next = previous.catch(() => undefined).then(() => refresh(instance, project, size, options));
	refreshing.set(instance.app, next);
	return next;
}

async function refresh(
	instance: Instance,
	project: string,
	size: { cases: number; unlinkedFiles: number; days?: number },
	options: Options,
): Promise<SeedResult> {
	const { app } = instance;
	const revision = app.config.commit;
	if (revision === null)
		throw new CliError("invalid", "demo refresh requires a known MAINWORTHY_COMMIT or SOURCE_COMMIT");
	options.signal?.throwIfAborted();
	const requested = { ...size, days: size.days ?? DEFAULT_SEED_DAYS };
	if (
		!Number.isInteger(requested.cases) ||
		requested.cases < 1 ||
		requested.cases > MAX_SEED_CASES ||
		!Number.isInteger(requested.days) ||
		requested.days < 0 ||
		requested.days > MAX_SEED_DAYS ||
		!Number.isInteger(requested.unlinkedFiles) ||
		requested.unlinkedFiles < 0 ||
		requested.unlinkedFiles > MAX_SEED_UNLINKED_FILES
	)
		throw new CliError("invalid", "invalid demo seed size");
	// Every instance on the database refreshes under one lock, so a second one, during a rollout, reads the first's
	// finished seed below and keeps it instead of swapping it out (#914).
	return await app.database.exclusive(
		`demo refresh ${project}`,
		() => refreshAlone(instance, project, revision, requested, options),
		options.signal,
	);
}

async function refreshAlone(
	instance: Instance,
	project: string,
	revision: string,
	requested: { cases: number; unlinkedFiles: number; days: number },
	options: Options,
): Promise<SeedResult> {
	const { app, owner } = instance;
	const state = await app.database.read(async (db) => {
		const found = await findProject(db, project);
		return found ? await demoDeployment(db, found.id) : null;
	});
	if (state?.kind === "ready" && state.revision === revision) return state.seeded;
	await options.step?.("checked");
	// Finish earlier retirements before another seed, so the heavy stages never overlap. A cleanup that fails still
	// leaves this revision its demo: the retired project waits for the next drain, at the next start or swap.
	await drainRetiredDemos(instance, { signal: options.signal }).catch((error: unknown) => {
		options.signal?.throwIfAborted();
		warning(`retired demo cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
	});
	const issued = await app.database.write((db) =>
		db.transaction(async () => {
			options.signal?.throwIfAborted();
			return createToken(
				app,
				{
					actor: owner.name,
					kind: "human",
					can: [],
					project: 0,
					label: `demo seed of ${project}`,
					lastsMs: LASTS_MS,
					madeBy: owner.id,
				},
				null,
				db,
			);
		}),
	);
	let seeded: SeedResult;
	let target: number;
	try {
		const client = new Client({ url: instance.url, token: issued.secret, project });
		await refuseProducers(client);
		const chosen = await app.database.write(async (db) => {
			const began = performance.now();
			try {
				return await db.transaction(async () => {
					options.signal?.throwIfAborted();
					const hint = await findProject(db, project);
					if (hint) await lockProjectAuthority(db, hint.id, owner.id);
					else {
						await lockActors(db, [owner.id]);
						await lockProjectKey(db, project);
						if (await findProject(db, project)) throw new Busy();
					}
					const old = await lockNamedProject(db, project);
					const current = old ? await demoDeployment(db, old.id) : null;
					if (old && current?.kind === "seeding" && current.revision === revision)
						return { id: old.id, size: current.size };
					if (old && (await demoSince(db, old.id)) === null)
						throw new CliError(
							"conflict",
							`MAINWORTHY_DEMO names project ${project}, which is not a demo; it is left as it is`,
						);
					if (old) await retireDemo(db, old);
					await createProject(
						{ app, db, actor: owner, now: app.now(), session: null, context: null },
						{ key: project },
					);
					const fresh = await findProject(db, project);
					if (!fresh || (await markDemo(db, fresh, app.now())) === null)
						throw new Error("the fresh demo could not be marked");
					await setDemoDeployment(db, fresh.id, { kind: "seeding", revision, size: requested });
					if (old) await moveProjectGrants(db, old.id, fresh.id);
					return { id: fresh.id, size: requested };
				});
			} finally {
				options.held?.("swap", performance.now() - began);
			}
		});
		target = chosen.id;
		await options.step?.("swapped");
		options.signal?.throwIfAborted();
		seeded = await seed(client, { project, ...chosen.size });
		await options.step?.("seeded");
	} finally {
		await app.database.write((db) => db.transaction(() => revokeToken(app, db, issued.id)));
	}
	await app.database.write((db) =>
		db.transaction(async () => {
			options.signal?.throwIfAborted();
			await lockActors(db, [owner.id]);
			if (!(await lockProject(db, target))) throw new CliError("conflict", "demo project changed while seeding");
			const current = await demoDeployment(db, target);
			if (current?.kind !== "seeding" || current.revision !== revision)
				throw new CliError("conflict", "demo deployment changed while seeding");
			await setDemoDeployment(db, target, { kind: "ready", revision, seeded });
		}),
	);
	return seeded;
}

/** Each slice commits and releases the writer before yielding, including after a process restart. */
export function drainRetiredDemos(
	instance: Instance,
	options: {
		signal?: AbortSignal | undefined;
		onSlice?: (slice: { table: string | null; rows: number; ms: number }) => void | Promise<void>;
	} = {},
): Promise<void> {
	const active = draining.get(instance.app);
	if (active !== undefined) return active;
	const work = (async () => {
		const { app } = instance;
		let plan: RemovalPlan | undefined;
		for (;;) {
			options.signal?.throwIfAborted();
			const slice = await app.database.write((db) =>
				db.transaction(async () => {
					options.signal?.throwIfAborted();
					const retired = (await retiredDemos(db))[0];
					if (!retired) return null;
					try {
						await lockProjectAuthority(db, retired.id, instance.owner.id);
					} catch (error) {
						// Another instance removed it between the read and the lock: nothing of it is left to remove.
						if (error instanceof Busy && !(await projectById(db, retired.id))) return "gone";
						throw error;
					}
					plan ??= await removalPlan(db);
					const began = performance.now();
					const result = await removeProjectSlice(db, retired.key, 32, plan);
					return { ...result, ms: performance.now() - began };
				}),
			);
			if (slice === null) return;
			if (slice === "gone") continue;
			await options.onSlice?.(slice);
			if (slice.ms > 100)
				warning(`[mainworthy] retired demo: ${slice.table} removed ${slice.rows} rows in ${slice.ms.toFixed(1)} ms`);
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
		}
	})();
	draining.set(instance.app, work);
	void work
		.finally(() => {
			if (draining.get(instance.app) === work) draining.delete(instance.app);
		})
		.catch(() => {});
	return work;
}

/** Renews only the configured demo's featured slot, through the same registry as a producer. */
export async function renewDemoWork(
	instance: Instance,
	project: string,
	seeded: Pick<SeedResult, "run" | "workSlot">,
): Promise<void> {
	if (seeded.workSlot === null) return;
	const read = await invoke(instance.app, OPS, {
		op: "find",
		project,
		input: { in: "slots", run: seeded.run, limit: 200 },
		actor: async () => instance.owner,
	});
	if (!read.ok) return;
	const slots = z.object({ items: z.array(z.object({ id: z.number(), state: z.string() })) }).parse(read.result).items;
	const slot = slots.find((slot) => slot.id === seeded.workSlot);
	if (!slot || !["missing", "skipped"].includes(slot.state)) return;
	await invoke(instance.app, OPS, {
		op: "work",
		project,
		input: { do: "take", run: seeded.run, slot: seeded.workSlot, seconds: DEMO_WORK.seconds },
		actor: async () => instance.owner,
	});
}
