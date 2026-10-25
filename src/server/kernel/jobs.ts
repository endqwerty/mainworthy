import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { App } from "./app.ts";
import { json, type ReadDb, sql, type WriteDb } from "./db.ts";
import { openJobInput, PrivateJobInputError, sealJobInput } from "./job-input.ts";

export type JobInput = z.infer<ReturnType<typeof z.json>>;
export type Job = {
	id: string;
	queue_order: number;
	kind: string;
	input: string;
	private_input: boolean;
	actor: number | null;
	accepted_at: number;
	effect: "repeatable" | "uncertain";
	state: "ready" | "running" | "succeeded" | "failed" | "uncertain";
	attempts: number;
	max_attempts: number;
	next_at: number;
	owner: string | null;
	token: string | null;
	lease_until: number | null;
	started: boolean;
	error: string | null;
};
export type JobClaim = Job & { state: "running"; owner: string; token: string; lease_until: number };
// Longer than the 120-second transaction bound. The HTTP dispatcher will set its request deadline above this.
export const JOB_LEASE_MS = 300_000;
export const jobBackoff = (attempt: number): number => Math.min(60_000 * 2 ** (attempt - 1), 3_600_000);
export const jobId = (kind: string, key: string): string => JSON.stringify([kind, key]);
const Q = {
	enqueue: sql<{
		id: string;
		kind: string;
		input: string;
		actor: number | null;
		at: number;
		effect: string;
		max: number;
		due: number;
		privateInput: boolean;
	}>(`
 INSERT INTO background_jobs(id,kind,input,actor,accepted_at,effect,max_attempts,next_at,private_input)
 VALUES($id,$kind,$input,$actor,$at,$effect,$max,$due,$privateInput) ON CONFLICT(id) DO NOTHING`),
	rearm: sql<{ id: string; at: number; actor: number | null; due: number; input: string; privateInput: boolean }>(`
 UPDATE background_jobs SET state='ready',attempts=0,next_at=$due,actor=$actor,accepted_at=$at,input=$input,private_input=$privateInput,started=false,error=NULL
 WHERE id IN (SELECT id FROM background_jobs WHERE id=$id AND state='succeeded' FOR UPDATE SKIP LOCKED)`),
	pending: sql<{ kind: string; now: number }, { present: boolean }>(
		`SELECT EXISTS(SELECT 1 FROM background_jobs WHERE kind=$kind AND (state='ready' AND next_at <= $now OR state='running' AND lease_until > $now)) AS present`,
	),
	one: sql<{ id: string }, Job>("SELECT * FROM background_jobs WHERE id=$id"),
	next: sql<{ now: number; id: string | null; kind: string | null }, Job>(`
 SELECT * FROM background_jobs WHERE (state='ready' AND next_at <= $now OR state='running' AND lease_until <= $now)
 AND ($id::text IS NULL OR id=$id) AND ($kind::text IS NULL OR kind=$kind) ORDER BY next_at,accepted_at,queue_order FOR UPDATE SKIP LOCKED LIMIT 1`),
	claim: sql<{ id: string; owner: string; token: string; until: number }, JobClaim>(`
 UPDATE background_jobs SET state='running',owner=$owner,token=$token,lease_until=$until,attempts=attempts+1,started=false
 WHERE id=$id RETURNING *`),
	terminal: sql<{ id: string; state: string }>(`
 UPDATE background_jobs SET state=$state,input=CASE WHEN private_input THEN 'null' ELSE input END,owner=NULL,token=NULL,lease_until=NULL WHERE id=$id`),
	fence: sql<{ id: string; token: string; now: number }, { id: string }>(`
 SELECT id FROM background_jobs WHERE id=$id AND token=$token AND state='running' AND lease_until > $now FOR UPDATE`),
	start: sql<{ id: string; token: string }>("UPDATE background_jobs SET started=true WHERE id=$id AND token=$token"),
	finish: sql<{ id: string; token: string; now: number; state: string; next: number; error: string | null }>(`
 UPDATE background_jobs SET state=$state,input=CASE WHEN private_input AND $state <> 'ready' THEN 'null' ELSE input END,next_at=$next,error=$error,owner=NULL,token=NULL,lease_until=NULL
 WHERE id=$id AND token=$token AND state='running' AND lease_until > $now`),
};

/** Enqueue on the writer's lease. Savepoint or transaction rollback discards the job as well. */
export async function enqueueJob(
	db: WriteDb,
	job: {
		kind: string;
		key: string;
		input: JobInput;
		actor: number | null;
		acceptedAt: number;
		effect?: Job["effect"];
		maxAttempts?: number;
		dueAt?: number;
		recurring?: boolean;
		privateInput?: boolean;
		privateKey?: string | undefined;
	},
): Promise<string> {
	const id = jobId(job.kind, job.key);
	const plain = JSON.stringify(job.input);
	const input = job.privateInput ? await sealJobInput(job.privateKey, id, job.kind, plain) : plain;
	await db.run(Q.enqueue, {
		id,
		kind: job.kind,
		input,
		actor: job.actor,
		at: job.acceptedAt,
		effect: job.effect ?? "repeatable",
		max: job.maxAttempts ?? 5,
		due: job.dueAt ?? job.acceptedAt,
		privateInput: job.privateInput ?? false,
	});
	if (job.recurring)
		await db.run(Q.rearm, {
			id,
			at: job.acceptedAt,
			actor: job.actor,
			due: job.dueAt ?? job.acceptedAt,
			input,
			privateInput: job.privateInput ?? false,
		});
	return id;
}
export const jobsPending = async (db: ReadDb, kind: string, now: number): Promise<boolean> =>
	(await db.one(Q.pending, { kind, now })).present;
export const jobById = (db: ReadDb, id: string): Promise<Job | null> => db.get(Q.one, { id });

/** Takes only job locks. No actor or project lock may be taken on this transaction afterwards. */
export async function claimJob(
	app: App,
	owner: string,
	id: string | null = null,
	kind: string | null = null,
): Promise<JobClaim | null> {
	return app.database.jobWrite((db) =>
		db.transaction(async () => {
			for (;;) {
				const row = await db.get(Q.next, { now: app.now(), id, kind });
				if (!row) return null;
				if (
					(row.state === "running" && row.effect === "uncertain" && row.started) ||
					row.attempts >= row.max_attempts
				) {
					await db.run(Q.terminal, {
						id: row.id,
						state: row.effect === "uncertain" && row.started ? "uncertain" : "failed",
					});
					continue;
				}
				return db.one(Q.claim, { id: row.id, owner, token: randomUUID(), until: app.now() + JOB_LEASE_MS });
			}
		}),
	);
}
export class LostJobClaim extends Error {
	constructor() {
		super("job claim expired or was replaced");
	}
}
/** Call after actor/project locks, before the handler's final write. The row lock lasts through commit. */
export async function fenceJob(db: WriteDb, claim: JobClaim, now: number): Promise<void> {
	if (!(await db.get(Q.fence, { id: claim.id, token: claim.token, now }))) throw new LostJobClaim();
}
export async function finishJob(app: App, claim: JobClaim, error: boolean, detail?: string): Promise<boolean> {
	return app.database.jobWrite((db) =>
		db.transaction(
			async () =>
				(
					await db.run(Q.finish, {
						id: claim.id,
						token: claim.token,
						now: app.now(),
						state: error
							? claim.effect === "uncertain"
								? "uncertain"
								: claim.attempts >= claim.max_attempts
									? "failed"
									: "ready"
							: "succeeded",
						next: error ? app.now() + jobBackoff(claim.attempts) : app.now(),
						error: error ? (detail ?? "Job failed; inspect the server log and retry policy.") : null,
					})
				).changes > 0,
		),
	);
}
export type JobHandler = (claim: JobClaim, input: JobInput) => Promise<void>;
/** Both runners and the HTTP operation enter here. A duplicate dispatch of a live/completed job does nothing. */
export async function runJob(
	app: App,
	owner: string,
	handler: JobHandler,
	id: string | null = null,
	kind: string | null = null,
): Promise<boolean> {
	const claim = await claimJob(app, owner, id, kind);
	if (!claim) return false;
	try {
		await app.database.jobWrite((db) =>
			db.transaction(async () => {
				await fenceJob(db, claim, app.now());
				await db.run(Q.start, { id: claim.id, token: claim.token });
			}),
		);
		const input = claim.private_input
			? await openJobInput(app.config.jobKey, claim.id, claim.kind, claim.input)
			: claim.input;
		await handler(claim, z.json().parse(json<unknown>(input)));
		await finishJob(app, claim, false);
	} catch (error) {
		if (!(error instanceof LostJobClaim)) console.error("[mainworthy] job failed", { id: claim.id, kind: claim.kind });
		await finishJob(app, claim, true, error instanceof PrivateJobInputError ? error.message : undefined);
	}
	return true;
}

const running = new WeakMap<App, Map<string, Set<Promise<number>>>>();
const stopped = new WeakMap<App, Set<string>>();
/** Local bookkeeping is only for shutdown. PostgreSQL, never this map, decides ownership. */
export function runKindJobs(app: App, kind: string, handler: JobHandler): Promise<number> {
	const kinds = running.get(app) ?? new Map<string, Set<Promise<number>>>();
	running.set(app, kinds);
	const pending = kinds.get(kind) ?? new Set<Promise<number>>();
	kinds.set(kind, pending);
	const work = (async () => {
		let n = 0;
		const owner = randomUUID();
		while (!stopped.get(app)?.has(kind) && n < 20 && (await runJob(app, owner, handler, null, kind))) n++;
		return n;
	})();
	pending.add(work);
	void work.finally(() => pending.delete(work)).catch(() => undefined);
	return work;
}
export const kindJobsStopped = (app: App, kind: string): boolean => stopped.get(app)?.has(kind) ?? false;
export function stopKindJobs(app: App, kind: string): void {
	const kinds = stopped.get(app) ?? new Set<string>();
	kinds.add(kind);
	stopped.set(app, kinds);
}
export async function waitKindJobs(app: App, kind: string): Promise<void> {
	await Promise.allSettled(running.get(app)?.get(kind) ?? []);
}

export async function runPeriodicJob(
	app: App,
	kind: string,
	handler: (claim: JobClaim) => Promise<number>,
): Promise<number> {
	const id = await app.database.jobWrite((db) =>
		db.transaction(() =>
			enqueueJob(db, { kind, key: "periodic", input: {}, actor: null, acceptedAt: app.now(), recurring: true }),
		),
	);
	let result = 0;
	await runKindJobs(app, kind, async (claim) => {
		if (claim.id === id) result += await handler(claim);
	});
	return result;
}
