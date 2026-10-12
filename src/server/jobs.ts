// Work the server does without being asked: finishing reports a crash interrupted, and reopening questions
// whose decisions ran out of time. Both are idempotent and run inside ordinary write transactions.
import { sweepExpired } from "./decisions/decisions.ts";
import { expiredDecisions } from "./decisions/questions.ts";
import { acceptedBatches } from "./evidence/evidence.ts";
import { actorById } from "./identity/identity.ts";
import type { App } from "./kernel/app.ts";
import { makeCtx, projectById, stampSeq } from "./kernel/ctx.ts";
import { sql } from "./kernel/db.ts";
import { processBatch } from "./ops/writes.ts";

const Q = { projects: sql<readonly [], { id: number }>("SELECT id FROM projects ORDER BY id") };

/**
 * Applies every batch that was accepted but not applied. A report is stored durably before it is applied, so a
 * crash between the two loses nothing: the gate reads `pending` until this runs. Returns the number applied.
 */
export function recoverAccepted(app: App): number {
	let applied = 0;
	for (const batch of acceptedBatches(app.db)) {
		const done = app.db.transaction(() => {
			const project = projectById(app.db, batch.project);
			if (!project) return null;
			const ctx = makeCtx(app, project, actorById(app.db, batch.actor, project.id), true);
			processBatch(ctx, batch.id);
			stampSeq(ctx);
			return { key: project.key, seq: ctx.seq, touched: [...ctx.touched], actor: ctx.actor.name };
		});
		if (!done) continue;
		applied++;
		app.publish({ project: done.key, seq: done.seq, op: "report", actor: done.actor, touched: done.touched });
	}
	return applied;
}

/** Reopens questions whose decisions have expired, in every project. Returns the number reopened. */
export function sweep(app: App, as: number): number {
	let reopened = 0;
	for (const { id } of app.db.all(Q.projects)) {
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
