import { randomUUID } from "node:crypto";
import { z } from "zod";
import { JobReply } from "../../core/replies.ts";
// Work the server does without being asked: finishing reports a crash interrupted, and reopening questions
// whose decisions ran out of time. Both are idempotent and run inside ordinary write transactions.
import { recoverDisputes as reconcileDisputes, sweepExpired } from "../decisions/decisions.ts";
import { expiredDecisions } from "../decisions/questions.ts";
import { ensureAssertionIndex } from "../evidence/assertions.ts";
import { acceptedBatches, batchById } from "../evidence/evidence.ts";
import { executeHandoff, recoverHandoffs } from "../handoffs/handoffs.ts";
import {
	actorById,
	lockActors,
	ruleActorId,
	sweepAttempts,
	sweepCeremonies,
	sweepSessions,
	sweepSignInRecords,
} from "../identity/identity.ts";
import type { App } from "../kernel/app.ts";
import { sweepChanges } from "../kernel/changes.ts";
import { allProjects, demoDeployment, lockProject, makeCtx, projectById, stampSeq } from "../kernel/ctx.ts";
import { AcceptedRefusal } from "../kernel/errors.ts";
import { enqueueJob, fenceJob, type JobClaim, runJob } from "../kernel/jobs.ts";
import { executeMail } from "../kernel/smtp.ts";
import type { StatusPort } from "../statuses/port.ts";
import { executeCommitStatuses } from "../statuses/statuses.ts";
import type { TrackerPort } from "../trackers/port.ts";
import { executeTrackerRequest } from "../trackers/requests.ts";
import { pruneBlobs } from "./blob-prune.ts";
import { defineServiceOp } from "./registry.ts";
import { executeReportMaps } from "./report-maps.ts";
import { executeTrackerPolls } from "./tracker-holds.ts";
import { applyAccepted } from "./writes.ts";

/**
 * Applies every batch that was accepted but not applied. A report is stored durably before it is applied, so a
 * crash between the two loses nothing: the gate reads `pending` until this runs. Returns the number applied.
 *
 * One report that cannot be applied does not stop the others, and does not stop the server from starting: it
 * stays accepted, its gate keeps reading `pending`, and the reason is written to the log. An instance that
 * will not start because of one stored report would be worse than one honest `pending`.
 */
export async function recoverAccepted(app: App, claim?: JobClaim, batchId?: number): Promise<number> {
	let applied = 0;
	for (const batch of await app.database.read(async (db) => acceptedBatches(db))) {
		if (batchId !== undefined && batch.id !== batchId) continue;
		let done: { key: string; seq: number; touched: string[]; actor: string } | null = null;
		try {
			done = await app.database.write(async (db) =>
				db.transaction(async () => {
					await lockActors(db, [batch.actor]);
					await lockProject(db, batch.project);
					if (claim) await fenceJob(db, claim, app.now());
					const current = await batchById(db, batch.id);
					if (current?.state !== "accepted") return null;
					const project = await projectById(db, current.project);
					// A retired demo takes no writes: its removal drains each table once (#914).
					if (!project || (await demoDeployment(db, project.id))?.kind === "retired") return null;
					// A report applied here keeps the time it was accepted at, as one applied by its own request does:
					// its results are not dated by the restart, and a demo's history stays where the seed put it.
					const ctx = makeCtx(app, db, project, await actorById(db, current.actor, project.id), true, current.at);
					try {
						await applyAccepted(ctx, current);
					} catch (error) {
						if (error instanceof AcceptedRefusal) return null;
						throw error;
					}
					await stampSeq(ctx);
					await app.recordChange(db, {
						project: project.key,
						seq: ctx.seq,
						op: "report",
						actor: ctx.actor.name,
						touched: [...ctx.touched],
					});
					return { key: project.key, seq: ctx.seq, touched: [...ctx.touched], actor: ctx.actor.name };
				}),
			);
		} catch (error) {
			console.error(
				`mainworthy: report ${batch.id} could not be applied and stays pending: ${error instanceof Error ? error.message : String(error)}`,
			);
			if (claim) throw error;
		}
		if (!done) continue;
		applied++;
	}
	return applied;
}

/** Give disputes stored before slot settlements their own questions without ending cause answers. */
export async function recoverDisputes(app: App, claim?: JobClaim): Promise<number> {
	let repaired = 0;
	for (const { id } of await app.database.read(async (db) => allProjects(db))) {
		repaired += await app.database.write(async (db) =>
			db.transaction(async () => {
				await lockActors(db, [await ruleActorId(db)]);
				const project = await lockProject(db, id);
				if (!project) return 0;
				if (claim) await fenceJob(db, claim, app.now());
				const ctx = makeCtx(app, db, project, await actorById(db, await ruleActorId(db), id), true);
				const n = await reconcileDisputes(ctx);
				if (n > 0) {
					await stampSeq(ctx);
					await app.recordChange(db, {
						project: project.key,
						seq: ctx.seq,
						op: "recover-disputes",
						actor: ctx.actor.name,
						touched: [...ctx.touched],
					});
				}
				return n;
			}),
		);
	}
	return repaired;
}

/** Reopens questions whose decisions have expired, in every project. Returns the number reopened. */
export async function sweep(app: App, as?: number, claim?: JobClaim): Promise<number> {
	let reopened = 0;
	for (const { id } of await app.database.read(async (db) => allProjects(db))) {
		const done = await app.database.write(async (db) =>
			db.transaction(async () => {
				await lockActors(db, [as ?? (await ruleActorId(db))]);
				const project = await lockProject(db, id);
				if (!project) return null;
				if (claim) await fenceJob(db, claim, app.now());
				const expired = await expiredDecisions(db, id, app.now());
				if (expired.length === 0) return null;
				const ctx = makeCtx(app, db, project, await actorById(db, as ?? (await ruleActorId(db)), project.id), true);
				const n = await sweepExpired(ctx, expired);
				if (n === 0) return null;
				await stampSeq(ctx);
				await app.recordChange(db, {
					project: project.key,
					seq: ctx.seq,
					op: "sweep",
					actor: ctx.actor.name,
					touched: [...ctx.touched],
				});
				return { n, key: project.key, seq: ctx.seq, touched: [...ctx.touched], actor: ctx.actor.name };
			}),
		);
		if (!done) continue;
		reopened += done.n;
	}
	return reopened;
}

const JobRequest = z.discriminatedUnion("do", [
	z.object({ do: z.literal("run"), id: z.string().min(1).max(2048) }),
	z.object({ do: z.literal("tick") }),
	z.object({ do: z.literal("drain") }),
]);
export function jobOperation(ports: { trackerPort?: TrackerPort; statusPort?: StatusPort; signal?: AbortSignal } = {}) {
	return defineServiceOp({
		name: "job",
		scope: "instance",
		effect: "service",
		needs: "admin",
		mcp: null,
		summary: "Run durable background work. Only the authenticated job service may call.",
		input: JobRequest,
		output: JobReply,
		async run(app, input) {
			if (input.do === "tick") await enqueuePeriodicJobs(app);
			let ran = 0;
			const owner = randomUUID();
			while (
				!ports.signal?.aborted &&
				ran < (input.do === "run" ? 1 : 20) &&
				(await runJob(
					app,
					owner,
					async (claim, payload) => {
						switch (claim.kind) {
							case "commit-statuses":
								await executeCommitStatuses(app, claim, ports.statusPort);
								break;
							case "tracker-polls":
								await executeTrackerPolls(app, claim, ports.trackerPort);
								break;
							case "handoff":
								await executeHandoff(app, claim, payload);
								break;
							case "tracker-request":
								await executeTrackerRequest(app, claim, payload, ports.trackerPort);
								break;
							case "mail":
								await executeMail(app, claim, payload);
								break;
							case "blob-prune":
								await pruneBlobs(app, claim);
								break;
							case "identity-state-retention":
								await app.database.admission((db) =>
									db.transaction(async () => {
										await sweepCeremonies(db, app.now());
										await sweepAttempts(db, app.now());
										await fenceJob(db, claim, app.now());
									}),
								);
								break;
							case "change-event-retention":
								for (const project of await app.database.read(allProjects))
									await app.database.write((db) =>
										db.transaction(async () => {
											if (!(await lockProject(db, project.id))) return;
											await sweepChanges(db, project.id, app.now());
											await fenceJob(db, claim, app.now());
										}),
									);
								break;
							case "expire-sessions":
								await sweepSessions(app, claim);
								break;
							case "sign-in-retention":
								await sweepSignInRecords(app, claim);
								break;
							case "assertion-indexes":
								await rebuildIndexes(app, claim);
								break;
							case "report-maps":
								await executeReportMaps(app, claim, payload);
								break;
							case "recover-report":
								await recoverAccepted(app, claim, z.object({ batch: z.number().int() }).parse(payload).batch);
								break;
							case "recover-reports":
								await recoverAccepted(app, claim);
								break;
							case "recover-disputes":
								await recoverDisputes(app, claim);
								break;
							case "expire-decisions":
								await sweep(app, undefined, claim);
								break;
							default:
								throw new Error(`unknown job kind ${claim.kind}`);
						}
					},
					input.do === "run" ? input.id : null,
				))
			)
				ran++;
			await recoverHandoffs(app);
			return { ran };
		},
	});
}
export const jobOp = jobOperation();

export async function enqueuePeriodicJobs(app: App): Promise<void> {
	await app.database.write((db) =>
		db.transaction(async () => {
			const actor = await ruleActorId(db);
			for (const batch of await acceptedBatches(db))
				await enqueueJob(db, {
					kind: "recover-report",
					key: String(batch.id),
					input: { batch: batch.id },
					actor: batch.actor,
					acceptedAt: batch.at,
				});
			for (const kind of [
				"recover-disputes",
				"expire-decisions",
				"commit-statuses",
				"tracker-polls",
				"identity-state-retention",
				"change-event-retention",
				"expire-sessions",
				"sign-in-retention",
				"blob-prune",
			])
				await enqueueJob(db, {
					kind,
					key: "periodic",
					recurring: true,
					input: {},
					actor,
					acceptedAt: app.now(),
				});
		}),
	);
}

export async function enqueueStartupJobs(app: App): Promise<void> {
	await enqueuePeriodicJobs(app);
	await app.database.write((db) =>
		db.transaction(async () => {
			for (const batch of await acceptedBatches(db))
				await enqueueJob(db, {
					kind: "recover-report",
					key: `startup:${randomUUID()}`,
					input: { batch: batch.id },
					actor: batch.actor,
					acceptedAt: batch.at,
					dueAt: app.now(),
				});
			await enqueueJob(db, {
				kind: "assertion-indexes",
				key: "startup",
				input: {},
				actor: null,
				acceptedAt: app.now(),
				recurring: true,
			});
		}),
	);
}
async function rebuildIndexes(app: App, claim: JobClaim): Promise<void> {
	for (const project of await app.database.read(allProjects))
		await app.database.write((db) =>
			db.transaction(async () => {
				if (!(await lockProject(db, project.id))) return;
				await fenceJob(db, claim, app.now());
				for await (const _ of ensureAssertionIndex(db, project.id)) {
					/* Each query yields to other requests. */
				}
			}),
		);
}
