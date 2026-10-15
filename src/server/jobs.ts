// Work the server does without being asked: finishing reports a crash interrupted, and reopening questions
// whose decisions ran out of time. Both are idempotent and run inside ordinary write transactions.
import { recoverDisputes as reconcileDisputes, sweepExpired } from "./decisions/decisions.ts";
import { expiredDecisions } from "./decisions/questions.ts";
import { acceptedBatches } from "./evidence/evidence.ts";
import { actorById, ruleActor } from "./identity/identity.ts";
import type { App } from "./kernel/app.ts";
import { allProjects, makeCtx, projectById, stampSeq } from "./kernel/ctx.ts";
import { processBatch } from "./ops/writes.ts";

/**
 * Applies every batch that was accepted but not applied. A report is stored durably before it is applied, so a
 * crash between the two loses nothing: the gate reads `pending` until this runs. Returns the number applied.
 *
 * One report that cannot be applied does not stop the others, and does not stop the server from starting: it
 * stays accepted, its gate keeps reading `pending`, and the reason is written to the log. An instance that
 * will not start because of one stored report would be worse than one honest `pending`.
 */
export function recoverAccepted(app: App): number {
	let applied = 0;
	for (const batch of acceptedBatches(app.db)) {
		let done: { key: string; seq: number; touched: string[]; actor: string } | null = null;
		try {
			done = app.db.transaction(() => {
				const project = projectById(app.db, batch.project);
				if (!project) return null;
				// A report applied here keeps the time it was accepted at, as one applied by its own request does:
				// its results are not dated by the restart, and a demo's history stays where the seed put it.
				const ctx = makeCtx(app, project, actorById(app.db, batch.actor, project.id), true, batch.at);
				processBatch(ctx, batch.id);
				stampSeq(ctx);
				return { key: project.key, seq: ctx.seq, touched: [...ctx.touched], actor: ctx.actor.name };
			});
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
export function recoverDisputes(app: App): number {
	let repaired = 0;
	for (const { id } of allProjects(app.db)) {
		repaired += app.db.transaction(() => {
			const project = projectById(app.db, id);
			if (!project) return 0;
			const ctx = makeCtx(app, project, actorById(app.db, ruleActor(app.db).id, id), true);
			const n = reconcileDisputes(ctx);
			if (n > 0) stampSeq(ctx);
			return n;
		});
	}
	return repaired;
}

/** Reopens questions whose decisions have expired, in every project. Returns the number reopened. */
export function sweep(app: App, as: number): number {
	let reopened = 0;
	for (const { id } of allProjects(app.db)) {
		const expired = expiredDecisions(app.db, id, app.now());
		if (expired.length === 0) continue;
		const done = app.db.transaction(() => {
			const project = projectById(app.db, id);
			if (!project) return null;
			const ctx = makeCtx(app, project, actorById(app.db, as, project.id), true);
			const n = sweepExpired(ctx, expired);
			if (n === 0) return null;
			stampSeq(ctx);
			return { n, key: project.key, seq: ctx.seq, touched: [...ctx.touched], actor: ctx.actor.name };
		});
		if (!done) continue;
		reopened += done.n;
		app.publish({ project: done.key, seq: done.seq, op: "sweep", actor: done.actor, touched: done.touched });
	}
	return reopened;
}
