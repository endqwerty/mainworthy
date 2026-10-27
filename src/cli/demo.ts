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
	// Every instance on the database refreshes under one lock, so a second one, during a rollout, finds the first's
	// finished seed and does not seed again. The lock ends with its connection, and the refresh does not notice, so the
	// swap transaction checks for itself that it never replaces a demo already ready for this revision (#914).
	return await app.database.exclusive(
		`demo refresh ${project}`,
		(signal) => refreshAlone(instance, project, revision, requested, { ...options, signal }),
		options.signal,
	);
}

/** How many retired demos may wait for cleanup before a new revision stops retiring another (#914). */
export const RETIRED_DEMOS_WAITING = 2;

/** Aborts `ms` after `signal` does: for the cleanup a stopping refresh still owes, but not for long. */
function grace(signal: AbortSignal, ms: number): AbortSignal {
	const controller = new AbortController();
	const fire = () => setTimeout(() => controller.abort(signal.reason), ms).unref();
	if (signal.aborted) fire();
	else signal.addEventListener("abort", fire, { once: true });
	return controller.signal;
}

async function refreshAlone(
	instance: Instance,
	project: string,
	revision: string,
	requested: { cases: number; unlinkedFiles: number; days: number },
	options: Options & { signal: AbortSignal },
): Promise<SeedResult> {
	const { app, owner } = instance;
	// Every wait below stops when `signal` aborts: a stopping server has ten seconds on Cloud Run (#914).
	const { signal } = options;
	const state = await app.database.read(
		async (db) => {
			const found = await findProject(db, project);
			return found ? await demoDeployment(db, found.id) : null;
		},
		{ signal },
	);
	if (state?.kind === "ready" && state.revision === revision) return state.seeded;
	await options.step?.("checked");
	// Finish earlier retirements before another seed, so the heavy stages never overlap. A cleanup that fails still
	// leaves this revision its demo, while fewer than RETIRED_DEMOS_WAITING wait: the retired project waits for the
	// next drain, at the next start or swap.
	await drainRetiredDemos(instance, { signal }).catch((error: unknown) => {
		signal.throwIfAborted();
		warning(`retired demo cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
	});
	const issued = await app.database.write(
		(db) =>
			db.transaction(async () => {
				signal.throwIfAborted();
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
		{ signal },
	);
	let seeded: SeedResult;
	let target: number;
	try {
		const client = new Client({
			url: instance.url,
			token: issued.secret,
			project,
			request: (url, init) =>
				fetch(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal }),
		});
		await refuseProducers(client);
		const chosen = await app.database.write(
			async (db) => {
				const began = performance.now();
				try {
					// The fence: deciding and swapping happen in one transaction, under the demo's key lock (in
					// lockProjectAuthority or lockProjectKey), whether or not this refresh still holds `exclusive`.
					return await db.transaction(async () => {
						signal.throwIfAborted();
						const hint = await findProject(db, project);
						if (hint) await lockProjectAuthority(db, hint.id, owner.id);
						else {
							await lockActors(db, [owner.id]);
							await lockProjectKey(db, project);
							if (await findProject(db, project)) throw new Busy();
						}
						const old = await lockNamedProject(db, project);
						const current = old ? await demoDeployment(db, old.id) : null;
						// Another instance finished this revision while this one had lost its lock: keep its demo.
						if (old && current?.kind === "ready" && current.revision === revision)
							return { kind: "ready" as const, seeded: current.seeded };
						if (old && current?.kind === "seeding" && current.revision === revision)
							return { kind: "seed" as const, id: old.id, size: current.size };
						if (old && (await demoSince(db, old.id)) === null)
							throw new CliError(
								"conflict",
								`MAINWORTHY_DEMO names project ${project}, which is not a demo; it is left as it is`,
							);
						if (old) {
							const waiting = (await retiredDemos(db)).length;
							if (waiting >= RETIRED_DEMOS_WAITING)
								throw new CliError(
									"conflict",
									`${waiting} retired demos are still waiting for cleanup, so the demo keeps its earlier revision until cleanup removes one`,
								);
							await retireDemo(db, old);
						}
						await createProject(
							{ app, db, actor: owner, now: app.now(), session: null, context: null },
							{ key: project },
						);
						const fresh = await findProject(db, project);
						if (!fresh || (await markDemo(db, fresh, app.now())) === null)
							throw new Error("the fresh demo could not be marked");
						await setDemoDeployment(db, fresh.id, { kind: "seeding", revision, size: requested });
						if (old) await moveProjectGrants(db, old.id, fresh.id);
						return { kind: "seed" as const, id: fresh.id, size: requested };
					});
				} finally {
					options.held?.("swap", performance.now() - began);
				}
			},
			{ signal },
		);
		if (chosen.kind === "ready") return chosen.seeded;
		target = chosen.id;
		await options.step?.("swapped");
		signal.throwIfAborted();
		seeded = await seed(client, { project, ...chosen.size });
		signal.throwIfAborted();
		await options.step?.("seeded");
	} finally {
		// A stopping server still revokes the seed's token, for a second at most: the token expires on its own.
		await app.database
			.write((db) => db.transaction(() => revokeToken(app, db, issued.id)), { signal: grace(signal, 1_000) })
			.catch((error: unknown) => {
				if (!signal.aborted) throw error;
			});
	}
	return await app.database.write(
		(db) =>
			db.transaction(async () => {
				signal.throwIfAborted();
				await lockActors(db, [owner.id]);
				if (!(await lockProject(db, target))) throw new CliError("conflict", "demo project changed while seeding");
				const current = await demoDeployment(db, target);
				// Two refreshes seed one project only after one lost its lock; the seed's command ids make that safe.
				if (current?.kind === "ready" && current.revision === revision) return current.seeded;
				if (current?.kind !== "seeding" || current.revision !== revision)
					throw new CliError("conflict", "demo deployment changed while seeding");
				await setDemoDeployment(db, target, { kind: "ready", revision, seeded });
				return seeded;
			}),
		{ signal },
	);
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
		// The signal also cancels a slice waiting for a project writer's lock, so a stopping server is not held.
		const signal = options.signal ? { signal: options.signal } : {};
		for (;;) {
			options.signal?.throwIfAborted();
			const slice = await app.database.write(
				(db) =>
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
				signal,
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
