// Work the server does without being asked: finishing reports a crash interrupted, and reopening questions
// whose decisions ran out of time. Both are idempotent and run inside ordinary write transactions.
import { recoverDisputes as reconcileDisputes, sweepExpired } from "../decisions/decisions.ts";
import { expiredDecisions } from "../decisions/questions.ts";
import { acceptedBatches, batchById } from "../evidence/evidence.ts";
import { actorById, ruleActor } from "../identity/identity.ts";
import type { App } from "../kernel/app.ts";
import { allProjects, makeCtx, projectById, stampSeq } from "../kernel/ctx.ts";
import { applyAccepted } from "./writes.ts";

/**
 * Applies every batch that was accepted but not applied. A report is stored durably before it is applied, so a
 * crash between the two loses nothing: the gate reads `pending` until this runs. Returns the number applied.
 *
 * One report that cannot be applied does not stop the others, and does not stop the server from starting: it
 * stays accepted, its gate keeps reading `pending`, and the reason is written to the log. An instance that
 * will not start because of one stored report would be worse than one honest `pending`.
 */
export async function recoverAccepted(app: App): Promise<number> {
	let applied = 0;
	for (const batch of await app.database.read(async (db) => acceptedBatches(db))) {
		let done: { key: string; seq: number; touched: string[]; actor: string } | null = null;
		try {
			done = await app.database.write(async (db) =>
				db.transaction(async () => {
					const current = await batchById(db, batch.id);
					if (current?.state !== "accepted") return null;
					const project = await projectById(db, current.project);
					if (!project) return null;
					// A report applied here keeps the time it was accepted at, as one applied by its own request does:
					// its results are not dated by the restart, and a demo's history stays where the seed put it.
					const ctx = makeCtx(app, db, project, await actorById(db, current.actor, project.id), true, current.at);
					await applyAccepted(ctx, current);
					await stampSeq(ctx);
					return { key: project.key, seq: ctx.seq, touched: [...ctx.touched], actor: ctx.actor.name };
				}),
			);
		} catch (error) {
			console.error(
				`mainworthy: report ${batch.id} could not be applied and stays pending: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (!done) continue;
		applied++;
		app.publish({ project: done.key, seq: done.seq, op: "report", actor: done.actor, touched: done.touched });
	}
	return applied;
}

/** Give disputes stored before slot settlements their own questions without ending cause answers. */
export async function recoverDisputes(app: App): Promise<number> {
	let repaired = 0;
	for (const { id } of await app.database.read(async (db) => allProjects(db))) {
		repaired += await app.database.write(async (db) =>
			db.transaction(async () => {
				const project = await projectById(db, id);
				if (!project) return 0;
				const ctx = makeCtx(app, db, project, await actorById(db, (await ruleActor(db)).id, id), true);
				const n = await reconcileDisputes(ctx);
				if (n > 0) await stampSeq(ctx);
				return n;
			}),
		);
	}
	return repaired;
}

/** Reopens questions whose decisions have expired, in every project. Returns the number reopened. */
export async function sweep(app: App, as?: number): Promise<number> {
	let reopened = 0;
	for (const { id } of await app.database.read(async (db) => allProjects(db))) {
		const done = await app.database.write(async (db) =>
			db.transaction(async () => {
				const expired = await expiredDecisions(db, id, app.now());
				if (expired.length === 0) return null;
				const project = await projectById(db, id);
				if (!project) return null;
				const ctx = makeCtx(app, db, project, await actorById(db, as ?? (await ruleActor(db)).id, project.id), true);
				const n = await sweepExpired(ctx, expired);
				if (n === 0) return null;
				await stampSeq(ctx);
				return { n, key: project.key, seq: ctx.seq, touched: [...ctx.touched], actor: ctx.actor.name };
			}),
		);
		if (!done) continue;
		reopened += done.n;
		app.publish({ project: done.key, seq: done.seq, op: "sweep", actor: done.actor, touched: done.touched });
	}
	return reopened;
}
