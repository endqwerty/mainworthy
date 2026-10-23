import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Verdict } from "../../core/runs.ts";
import { changeById, type TargetRow, targetByCommit } from "../evidence/evidence.ts";
import type { App } from "../kernel/app.ts";
import { type Ctx, findProject, makeCtx } from "../kernel/ctx.ts";
import { json, sql } from "../kernel/db.ts";
import { gate } from "../runs/runs.ts";
import { githubStatusesPort } from "./github.ts";
import { type StatusDraft, type StatusPort, StatusRateLimit } from "./port.ts";

const MAX_ATTEMPTS = 16;
const MAX_HEADER_PAUSE = 86_400_000;
const RETRY_DIAGNOSTIC =
	"GitHub commit status delivery failed; check connectivity, repository access and Commit statuses write permission. Will retry with back-off.";
const STOP_DIAGNOSTIC =
	"GitHub commit status delivery stopped after 16 unsuccessful attempts; check repository access and Commit statuses write permission, then send a new counted report.";
const Posts = z.array(z.number());
type DeliveryRow = { posts: string; pause_until: number; failures: number };

function retryDelay(attempts: number): number {
	return Math.min(60_000 * 2 ** Math.min(attempts - 1, 6), 3_600_000);
}

const Content = z.object({ verdict: Verdict, reason: z.string(), url: z.string() });
type StatusRow = {
	project: number;
	repository: string;
	commit_sha: string;
	nonce: string;
	desired: string;
	sent: string | null;
	state: "queued" | "sending" | "complete" | "stopped";
	attempts: number;
	next_at: number;
	watch_until: number;
	error: string | null;
};
const Q = {
	all: sql<{ project: number; repository: string; now: number }, StatusRow>(
		`SELECT * FROM commit_statuses WHERE project = $project AND repository = $repository
		 AND state <> 'stopped' AND (state <> 'complete' OR watch_until > $now)`,
	),
	one: sql<{ project: number; repository: string; commit: string }, StatusRow>(
		"SELECT * FROM commit_statuses WHERE project = $project AND repository = $repository AND commit_sha = $commit",
	),
	queue: sql<StatusRow & { reported: boolean }>(`INSERT INTO commit_statuses
		(project, repository, commit_sha, nonce, desired, sent, state, attempts, next_at, watch_until, error)
		VALUES ($project, $repository, $commit_sha, $nonce, $desired, $sent, $state, $attempts, $next_at, $watch_until, $error)
		ON CONFLICT (project, repository, commit_sha) DO UPDATE SET desired = excluded.desired,
		watch_until = excluded.watch_until,
		attempts = CASE WHEN $reported AND commit_statuses.state = 'stopped' THEN 0 ELSE commit_statuses.attempts END,
		error = CASE WHEN $reported AND commit_statuses.state = 'stopped' THEN NULL
		 WHEN commit_statuses.sent = excluded.desired THEN NULL ELSE commit_statuses.error END,
		state = CASE
		 WHEN commit_statuses.state = 'stopped' THEN CASE WHEN $reported THEN 'queued' ELSE 'stopped' END
		 WHEN commit_statuses.state IN ('queued', 'complete') AND commit_statuses.sent = excluded.desired THEN 'complete'
		 WHEN commit_statuses.state = 'complete' THEN 'queued' ELSE commit_statuses.state END`),
	next: sql<{ project: number; repository: string; now: number }, StatusRow>(
		`SELECT * FROM commit_statuses WHERE project = $project AND repository = $repository
		 AND state IN ('queued', 'sending') AND next_at <= $now ORDER BY next_at, commit_sha LIMIT 1`,
	),
	claim: sql<{ nonce: string; next: number }>(
		"UPDATE commit_statuses SET state = 'sending', sent = NULL, attempts = attempts + 1, next_at = $next WHERE nonce = $nonce",
	),
	finish: sql<{ nonce: string; sent: string; next: number }>(
		`UPDATE commit_statuses SET sent = $sent, error = NULL, attempts = 0, next_at = $next,
		 state = CASE WHEN desired = $sent THEN 'complete' ELSE 'queued' END WHERE nonce = $nonce AND state = 'sending'`,
	),
	fail: sql<{ nonce: string; error: string; next: number; stopped: boolean }>(
		`UPDATE commit_statuses SET state = CASE WHEN $stopped THEN 'stopped' ELSE 'queued' END,
		 error = $error, next_at = MAX(next_at, $next) WHERE nonce = $nonce AND state = 'sending'`,
	),
	halt: sql<{ nonce: string; error: string }>(
		"UPDATE commit_statuses SET state = 'stopped', error = $error WHERE nonce = $nonce",
	),
	delivery: sql<readonly [], DeliveryRow>("SELECT * FROM commit_status_delivery WHERE id = 1"),
	saveDelivery: sql<DeliveryRow>(`INSERT INTO commit_status_delivery (id, posts, pause_until, failures)
		VALUES (1, $posts, $pause_until, $failures) ON CONFLICT (id) DO UPDATE SET
		posts = excluded.posts, pause_until = excluded.pause_until, failures = excluded.failures`),
	defer: sql<{ project: number; repository: string; commit: string; next: number }>(
		`UPDATE commit_statuses SET next_at = MAX(next_at, $next)
		 WHERE project = $project AND repository = $repository AND commit_sha = $commit`,
	),
};

export async function enrollCommitStatus(ctx: Ctx, target: TargetRow): Promise<void> {
	if (ctx.actor.kind !== "agent") await queue(ctx, target, true);
}

async function queue(ctx: Ctx, target: TargetRow, reported = false): Promise<void> {
	const { app, project } = ctx;
	const config = app.config.github;
	if (
		!app.config.githubStatuses ||
		!config ||
		!app.config.publicUrl ||
		config.project !== project.key ||
		target.repo !== config.repository ||
		target.commit_sha === null ||
		!/^[0-9a-f]{40}$/.test(target.commit_sha)
	)
		return;
	const status = await gate(ctx, { commit: target.commit_sha, repo: config.repository });
	if (status.run === null) return;
	const change = target.change === null ? null : await changeById(app.db, target.change);
	const path = change ? `changes/${encodeURIComponent(change.key)}` : `runs/${status.run.replace(/^R-/, "")}`;
	const desired = JSON.stringify({
		verdict: status.verdict,
		reason: status.reason,
		url: `${app.config.publicUrl.replace(/\/$/, "")}/p/${encodeURIComponent(project.key)}/${path}`,
	});
	const existing = await app.db.get(Q.one, {
		project: project.id,
		repository: config.repository,
		commit: target.commit_sha,
	});
	if (!reported && existing?.desired === desired) return;
	await app.db.run(Q.queue, {
		project: project.id,
		repository: config.repository,
		commit_sha: target.commit_sha,
		nonce: existing?.nonce ?? randomUUID(),
		desired,
		sent: null,
		state: "queued",
		attempts: 0,
		reported,
		next_at: 0,
		watch_until: app.now() + 30 * 86_400_000,
		error: null,
	});
}

async function refresh(app: App): Promise<void> {
	const config = app.config.github;
	if (!app.config.githubStatuses || !config || !app.config.publicUrl) return;
	const project = await findProject(app.db, config.project);
	if (!project) return;
	const ctx = makeCtx(app, project, { id: 0, kind: "rule", name: "rule", can: [] }, true);
	for (const row of await app.db.all(Q.all, { project: project.id, repository: config.repository, now: app.now() })) {
		const target = await targetByCommit(app.db, project.id, row.commit_sha, config.repository);
		if (target) await queue(ctx, target);
	}
}

const active = new WeakMap<App, Promise<number>>();
const stopping = new WeakSet<App>();

export function deliverCommitStatuses(app: App, port?: StatusPort): Promise<number> {
	const running = active.get(app);
	if (running) return running;
	if (stopping.has(app)) return Promise.resolve(0);
	const work = deliver(app, port).finally(() => active.delete(app));
	active.set(app, work);
	return work;
}

export function stopCommitStatuses(app: App): void {
	stopping.add(app);
}

export async function waitCommitStatuses(app: App): Promise<void> {
	await active.get(app)?.catch(() => undefined);
}

async function deliver(app: App, supplied?: StatusPort): Promise<number> {
	await app.gate.run(async () => {
		if (!stopping.has(app)) await app.db.transaction(async () => await refresh(app));
	});
	let delivered = 0;
	for (let n = 0; n < 20; n++) {
		const claimed = await app.gate.run(
			async () =>
				await app.db.transaction(async () => {
					const config = app.config.github;
					if (stopping.has(app) || !app.config.githubStatuses || !config || !app.config.publicUrl) return null;
					const project = await findProject(app.db, config.project);
					if (!project) return null;
					const now = app.now();
					const delivery = app.db.get(Q.delivery) ?? { posts: "[]", pause_until: 0, failures: 0 };
					const posts = Posts.parse(json<unknown>(delivery.posts)).filter((at) => at > now - 3_600_000);
					if (delivery.pause_until > now || posts.length >= 240 || posts.filter((at) => at > now - 60_000).length >= 20)
						return null;
					while (true) {
						const next = await app.db.get(Q.next, {
							project: project.id,
							repository: config.repository,
							now: app.now(),
						});
						if (!next) return null;
						const target = await targetByCommit(app.db, project.id, next.commit_sha, config.repository);
						if (target)
							await queue(makeCtx(app, project, { id: 0, kind: "rule", name: "rule", can: [] }, true), target);
						const row = await app.db.get(Q.one, {
							project: project.id,
							repository: config.repository,
							commit: next.commit_sha,
						});
						if (!row) return null;
						if (row.state === "complete" || row.state === "stopped") continue;
						if (row.attempts >= MAX_ATTEMPTS) {
							await app.db.run(Q.halt, { nonce: row.nonce, error: STOP_DIAGNOSTIC });
							console.error(`[mainworthy] commit status ${row.commit_sha}: ${STOP_DIAGNOSTIC}`);
							continue;
						}
						const nextAt = now + retryDelay(row.attempts + 1);
						await app.db.run(Q.saveDelivery, { ...delivery, posts: JSON.stringify([...posts, now]) });
						await app.db.run(Q.claim, { nonce: row.nonce, next: nextAt });
						return { row, config, nextAt };
					}
				}),
		);
		if (!claimed) break;
		const { row, config } = claimed;
		let nextAt = claimed.nextAt;
		const draft: StatusDraft = {
			...Content.parse(json<unknown>(row.desired)),
			commit: row.commit_sha,
		};
		try {
			const port = supplied ?? githubStatusesPort(config);
			await port.post(draft);
			nextAt = app.now() + 60_000;
			await app.gate.run(
				async () =>
					await app.db.transaction(async () => {
						await app.db.run(Q.finish, { nonce: row.nonce, sent: row.desired, next: nextAt });
						const delivery = await app.db.get(Q.delivery);
						if (delivery) await app.db.run(Q.saveDelivery, { ...delivery, failures: 0 });
					}),
			);
		} catch (error) {
			const exhausted = row.attempts + 1 >= MAX_ATTEMPTS;
			const message = exhausted ? STOP_DIAGNOSTIC : RETRY_DIAGNOSTIC;
			await app.gate.run(
				async () =>
					await app.db.transaction(async () => {
						let next = app.now() + retryDelay(row.attempts + 1);
						if (error instanceof StatusRateLimit) {
							const delivery = app.db.get(Q.delivery) ?? { posts: "[]", pause_until: 0, failures: 0 };
							const failures = Math.min(delivery.failures + 1, MAX_ATTEMPTS);
							const headerDeadline = Math.min(
								app.now() + MAX_HEADER_PAUSE,
								Math.max(app.now() + error.retryAfterMs, error.retryAt),
							);
							next = Math.max(next, app.now() + retryDelay(failures), headerDeadline);
							await app.db.run(Q.saveDelivery, {
								...delivery,
								failures,
								pause_until: Math.max(delivery.pause_until, next),
							});
						}
						nextAt = next;
						await app.db.run(Q.fail, { nonce: row.nonce, error: message, next, stopped: exhausted });
					}),
			);
			console.error(`[mainworthy] commit status ${row.commit_sha}: ${message}`);
		}
		await app.gate.run(
			async () =>
				await app.db.run(Q.defer, {
					project: row.project,
					repository: row.repository,
					commit: row.commit_sha,
					next: nextAt,
				}),
		);
		delivered++;
	}
	return delivered;
}
