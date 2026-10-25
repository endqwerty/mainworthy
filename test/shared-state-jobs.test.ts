import { afterEach, expect, spyOn, test } from "bun:test";
import { createToken, signInWithToken } from "../src/server/identity/identity.ts";
import { lockIdentity } from "../src/server/identity/locks.ts";
import { type App, openApp } from "../src/server/kernel/app.ts";
import { lockProject, makeCtx, stampSeq } from "../src/server/kernel/ctx.ts";
import { Database } from "../src/server/kernel/db.ts";
import { claimJob, JOB_LEASE_MS, type JobClaim, jobById } from "../src/server/kernel/jobs.ts";
import { enqueuePeriodicJobs, enqueueStartupJobs, jobOp, recoverAccepted } from "../src/server/ops/jobs.ts";
import { invokeService } from "../src/server/ops/registry.ts";
import { acceptReport, reportOp } from "../src/server/ops/writes.ts";
import { serve } from "../src/surfaces/http.ts";
import { ciReport, type Harness, harness } from "./helpers.ts";

let h: Harness;
let peer: App | undefined;
afterEach(async () => {
	await peer?.close();
	peer = undefined;
	await h?.close();
});

test("two instances run periodic shared-state retention, preserving live rows and retrying the next tick", async () => {
	h = await harness();
	peer = await openApp(h.app.config, { memory: true, now: h.app.now });
	const now = h.app.now();
	await h.app.database.write((db) =>
		db.transaction(async () => {
			await db.runDynamic(
				`INSERT INTO identity_ceremonies(kind,key,owner,deadline,generation,payload)
			SELECT 'retention', key, 'owner', $1 + offset_ms, generation, '{}'
			FROM identity_ceremony_epoch CROSS JOIN (VALUES ('expired',-1),('boundary',0),('live',1)) rows(key,offset_ms)`,
				[now],
			);
			await db.runDynamic(
				"INSERT INTO identity_limits(key,entry,expires_at,version) VALUES ('expired','{}',$1 - 1,1),('boundary','{}',$1,1),('live','{}',$1 + 1,1)",
				[now],
			);
			await db.runDynamic(
				"INSERT INTO identity_starts(key,since,count) VALUES ('expired',$1 - 60001,1),('boundary',$1 - 60000,1),('live',$1 - 59999,1)",
				[now],
			);
			await db.runDynamic(
				"INSERT INTO change_events(project,seq,op,touched,at) VALUES (1,999,'retention','[]',$1 - 86400001),(1,1000,'retention','[]',$1 - 86400000),(1,1001,'retention','[]',$1 - 86399999)",
				[now],
			);
		}),
	);
	await enqueuePeriodicJobs(h.app);
	const jobs = await h.app.database.read((db) =>
		db.allDynamic<{ id: string; kind: string }>(
			"SELECT id,kind FROM background_jobs WHERE kind IN ('identity-state-retention','change-event-retention') ORDER BY kind",
		),
	);
	expect(jobs.map((job) => job.kind)).toEqual(["change-event-retention", "identity-state-retention"]);
	for (const job of jobs) {
		const replies = await Promise.all([h.app, peer].map((app) => invokeService(app, jobOp, { do: "run", id: job.id })));
		expect(replies).toContainEqual({ ok: true, result: { ran: 1 }, seq: null });
		expect(replies).toContainEqual({ ok: true, result: { ran: 0 }, seq: null });
	}
	for (const table of ["identity_ceremonies", "identity_limits", "identity_starts"])
		expect(await h.app.database.read((db) => db.allDynamic(`SELECT key FROM ${table} ORDER BY key`))).toEqual([
			{ key: "live" },
		]);
	expect(
		await h.app.database.read((db) => db.allDynamic("SELECT seq FROM change_events WHERE op='retention' ORDER BY seq")),
	).toEqual([{ seq: 1001 }]);
	h.advance(1);
	await enqueuePeriodicJobs(peer);
	for (const job of jobs)
		expect(await invokeService(peer, jobOp, { do: "run", id: job.id })).toEqual({
			ok: true,
			result: { ran: 1 },
			seq: null,
		});
	for (const table of ["identity_ceremonies", "identity_limits", "identity_starts"])
		expect(await h.app.database.read((db) => db.allDynamic(`SELECT key FROM ${table}`))).toEqual([]);
	expect(
		await h.app.database.read((db) => db.allDynamic("SELECT seq FROM change_events WHERE op='retention'")),
	).toEqual([]);
});

test("event retention locks projects before event rows and the job fence, like archive import", async () => {
	h = await harness();
	peer = await openApp(h.app.config, { memory: true, now: h.app.now });
	await h.app.database.write((db) =>
		db.transaction(() =>
			db.runDynamic("INSERT INTO change_events(project,seq,op,touched,at) VALUES (1,999,'retention','[]',0)"),
		),
	);
	await enqueuePeriodicJobs(h.app);
	const [job] = await h.app.database.read((db) =>
		db.allDynamic<{ id: string }>("SELECT id FROM background_jobs WHERE kind='change-event-retention'"),
	);
	if (!job) throw new Error("missing event retention job");
	const entered = Promise.withResolvers<void>();
	const resume = Promise.withResolvers<void>();
	const held = Promise.withResolvers<void>();
	const checked = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const write = peer.database.write.bind(peer.database);
	peer.database.write = (work, options) =>
		write(async (db) => {
			entered.resolve();
			await resume.promise;
			return work(db);
		}, options);
	const holding = h.app.database.write((db) =>
		db.transaction(async () => {
			await db.allDynamic("SELECT id FROM projects WHERE id=1 FOR UPDATE");
			held.resolve();
			await entered.promise;
			await db.allDynamic("SELECT id FROM background_jobs WHERE id=$1 FOR UPDATE", [job.id]);
			resume.resolve();
			const until = performance.now() + 1000;
			let waiting = false;
			while (performance.now() < until) {
				const [row] = await h.app.database.read((read) =>
					read.allDynamic<{ waiting: boolean }>(
						"SELECT EXISTS(SELECT FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock') AS waiting",
					),
				);
				if (row?.waiting) {
					waiting = true;
					break;
				}
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
			expect(waiting).toBe(true);
			await db.allDynamic("SELECT seq FROM change_events WHERE project=1 AND seq=999 FOR UPDATE NOWAIT");
			checked.resolve();
			await release.promise;
		}),
	);
	await held.promise;
	const running = invokeService(peer, jobOp, { do: "run", id: job.id });
	try {
		await Promise.race([
			checked.promise,
			holding,
			running.then(() => {
				throw new Error("retention skipped the project lock");
			}),
		]);
	} finally {
		release.resolve();
		resume.resolve();
		peer.database.write = write;
		await Promise.allSettled([holding, running]);
	}
	expect(await running).toEqual({ ok: true, result: { ran: 1 }, seq: null });
	expect(
		await h.app.database.read((db) => db.allDynamic("SELECT seq FROM change_events WHERE op='retention'")),
	).toEqual([]);
});

test("two startups recover already accepted reports once without advancing later reports", async () => {
	h = await harness();
	const accept = (commit: string) =>
		h.app.database.write((db) =>
			db.transaction(async () => {
				const project = await lockProject(db, 1);
				if (!project) throw new Error("missing project");
				const ctx = makeCtx(h.app, db, project, h.owner, true);
				const { batch } = await acceptReport(ctx, ciReport({ commit, n: 1 }));
				await stampSeq(ctx);
				return batch.id;
			}),
		);
	const existing = await accept("before-startup");
	peer = await openApp(h.app.config, { memory: true, now: h.app.now });
	const secondary = peer;
	await Promise.all([h.app, secondary].map((app) => enqueueStartupJobs(app)));
	const later = await accept("after-startup");
	const jobs = await h.app.database.read((db) =>
		db.allDynamic<{ id: string; input: string }>(
			"SELECT id,input FROM background_jobs WHERE kind='recover-report' AND next_at <= $1",
			[h.app.now()],
		),
	);
	expect(jobs.map((job) => JSON.parse(job.input))).toEqual([{ batch: existing }, { batch: existing }]);
	const replies = await Promise.all(
		jobs.map((job, index) => invokeService(index === 0 ? h.app : secondary, jobOp, { do: "run", id: job.id })),
	);
	for (const reply of replies) expect(reply).toEqual({ ok: true, result: { ran: 1 }, seq: null });
	expect(await h.app.database.read((db) => db.allDynamic("SELECT id,state FROM batches ORDER BY id"))).toEqual([
		{ id: existing, state: "processed" },
		{ id: later, state: "accepted" },
	]);
	expect(await h.app.database.read((db) => db.allDynamic("SELECT count(*)::integer AS n FROM results"))).toEqual([
		{ n: 1 },
	]);
	expect(
		await h.app.database.read((db) =>
			db.allDynamic("SELECT state FROM background_jobs WHERE id=ANY($1::text[]) ORDER BY id", [
				jobs.map((job) => job.id),
			]),
		),
	).toEqual([{ state: "succeeded" }, { state: "succeeded" }]);
});

for (const kind of ["expire-sessions", "sign-in-retention"]) {
	for (const replaced of [true, false]) {
		test(`${kind} ${replaced ? "refuses an expired worker after its successor claims" : "uses the time after waiting for its actor lock"}`, async () => {
			h = await harness();
			peer = await openApp(h.app.config, { memory: true, now: h.app.now });
			const secondary = peer;
			const token = await createToken(h.app, {
				actor: "reader",
				kind: "human",
				can: ["read"],
				project: 0,
				label: "retention",
			});
			const now = h.app.now();
			if (kind === "expire-sessions") {
				for (let i = 0; i < 2; i++) {
					const opening = await signInWithToken(h.app, token.secret, { userAgent: null, address: null });
					if (opening.kind !== "opening" || !(await opening.signedIn)) throw new Error("missing session");
				}
				await h.app.database.write((db) =>
					db.transaction(() =>
						db.runDynamic(
							"UPDATE sessions SET expires_at=$1 + CASE WHEN id=(SELECT min(id) FROM sessions) THEN -1 ELSE 1 END",
							[now],
						),
					),
				);
			} else {
				await h.app.database.write((db) =>
					db.transaction(async () => {
						await db.runDynamic(
							"UPDATE tokens SET revoked_at=$1 - 2592000001,last_used_addr='192.0.2.99' WHERE id=$2",
							[now, token.id],
						);
						await db.runDynamic(
							"INSERT INTO invitations(actor,hash,purpose,created_by,created_at,expires_at) SELECT actor,'retention','join',$1,$2,$2-2591999999 FROM tokens WHERE id=$3",
							[h.owner.id, now, token.id],
						);
					}),
				);
			}
			const rows = () =>
				h.app.database.read(async (db) => ({
					sessions: await db.allDynamic("SELECT id,ended_at,ended_why FROM sessions ORDER BY id"),
					tokens: await db.allDynamic("SELECT id,last_used_addr FROM tokens ORDER BY id"),
					invitations: await db.allDynamic("SELECT id FROM invitations ORDER BY id"),
				}));
			const before = await rows();
			await enqueuePeriodicJobs(h.app);
			const [job] = await h.app.database.read((db) =>
				db.allDynamic<{ id: string }>("SELECT id FROM background_jobs WHERE kind=$1", [kind]),
			);
			if (!job) throw new Error("missing maintenance job");
			const held = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const holding = h.app.database.write((db) =>
				db.transaction(async () => {
					if (replaced) await lockIdentity(db);
					else
						await db.allDynamic(
							"SELECT a.id FROM actors a JOIN tokens t ON t.actor=a.id WHERE t.id=$1 FOR SHARE OF a",
							[token.id],
						);
					held.resolve();
					await release.promise;
				}),
			);
			await held.promise;
			const running = invokeService(h.app, jobOp, { do: "run", id: job.id });
			let successor: JobClaim | null = null;
			try {
				const deadline = Date.now() + 5000;
				for (;;) {
					const [row] = await secondary.database.read((db) =>
						db.allDynamic<{ waiting: boolean }>(
							"SELECT EXISTS(SELECT FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock') AS waiting",
						),
					);
					if (row?.waiting) break;
					if (Date.now() >= deadline) throw new Error("maintenance never waited for its domain lock");
					await new Promise<void>((resolve) => setImmediate(resolve));
				}
				h.advance(replaced ? JOB_LEASE_MS + 1 : 1000);
				if (replaced) {
					successor = await claimJob(secondary, "successor", job.id);
					expect(successor?.attempts).toBe(2);
				}
			} finally {
				release.resolve();
				await Promise.allSettled([holding, running]);
			}
			expect(await running).toEqual({ ok: true, result: { ran: 1 }, seq: null });
			if (replaced) {
				expect(await rows()).toEqual(before);
				expect(await secondary.database.read((db) => jobById(db, job.id))).toMatchObject({
					state: "running",
					owner: "successor",
					token: successor?.token,
					attempts: 2,
				});
			} else {
				if (kind === "expire-sessions")
					expect((await rows()).sessions).toEqual([
						{ id: 1, ended_at: h.app.now(), ended_why: "expired" },
						{ id: 2, ended_at: h.app.now(), ended_why: "expired" },
					]);
				else {
					expect((await rows()).tokens).toContainEqual({ id: token.id, last_used_addr: null });
					expect((await rows()).invitations).toEqual([]);
				}
				expect(await secondary.database.read((db) => jobById(db, job.id))).toMatchObject({ state: "succeeded" });
			}
		});
	}
}

for (const replaced of [false, true]) {
	test(`a pending HTTP report is recovered once by two runners${replaced ? " after an expired claim" : ""}`, async () => {
		h = await harness();
		await h.call("propose", { edits: [{ op: "create", body: { title: "Accepted for recovery" } }] });
		await h.call("admin", { do: "project.create", key: "held" });
		const [other] = await h.app.database.read((db) =>
			db.allDynamic<{ id: number }>("SELECT id FROM projects WHERE key='held'"),
		);
		if (!other || !("steps" in reportOp)) throw new Error("missing report fixture");
		const acquired = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const holder = h.app.database.write((db) =>
			db.transaction(async () => {
				await lockProject(db, other.id);
				acquired.resolve();
				await release.promise;
			}),
		);
		await acquired.promise;
		const steps = reportOp.steps;
		const paused = spyOn(reportOp, "steps").mockImplementation(async function* (ctx, input) {
			const iterator = steps(ctx, input);
			const first = await iterator.next();
			if (first.done) return first.value;
			yield first.value;
			await lockProject(ctx.db, other.id);
			return yield* iterator;
		});
		const short = await Database.open({ url: h.app.config.databaseUrl, lockWaitMs: 30 });
		const listener = serve({ ...h.app, database: short }, h.owner);
		try {
			const response = await fetch(`http://127.0.0.1:${listener.port}/api/p/scratch/report`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					cmd: "pending-job-report",
					target: { commit: "pending-job-report" },
					results: [{ test: { case: "C-1" }, outcome: "pass" }],
				}),
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				ok: true,
				result: { batch: expect.any(Number), results: [], gate: { verdict: "pending" } },
			});
			expect(await h.app.database.read((db) => db.allDynamic("SELECT state,receipt FROM batches"))).toEqual([
				{ state: "accepted", receipt: null },
			]);
			expect(await h.app.database.read((db) => db.allDynamic("SELECT count(*) AS n FROM results"))).toEqual([{ n: 0 }]);
			expect(await h.app.database.read((db) => db.allDynamic("SELECT outcome FROM commands"))).toEqual([
				{ outcome: "" },
			]);
		} finally {
			paused.mockRestore();
			release.resolve();
			await holder;
			await listener.stop(true);
			await short.close();
		}
		peer = await openApp(h.app.config, { memory: true, now: h.app.now });
		const [job] = await h.app.database.read((db) =>
			db.allDynamic<{ id: string; next_at: number; batch: number }>(
				"SELECT id,next_at,(input::json->>'batch')::integer AS batch FROM background_jobs WHERE kind='recover-report'",
			),
		);
		if (!job) throw new Error("acceptance did not enqueue recovery");
		for (const app of [h.app, peer])
			expect(await invokeService(app, jobOp, { do: "run", id: job.id })).toEqual({
				ok: true,
				result: { ran: 0 },
				seq: null,
			});
		h.advance(job.next_at - h.app.now());
		if (replaced) {
			const stale = await claimJob(h.app, "old-instance", job.id);
			if (!stale) throw new Error("missing old claim");
			h.advance(JOB_LEASE_MS);
			const successor = await claimJob(peer, "new-instance", job.id);
			if (!successor) throw new Error("missing successor claim");
			await expect(recoverAccepted(h.app, stale, job.batch)).rejects.toThrow("claim expired");
			expect(await h.app.database.read((db) => db.allDynamic("SELECT state FROM batches"))).toEqual([
				{ state: "accepted" },
			]);
			expect(await h.app.database.read((db) => db.allDynamic("SELECT count(*) AS n FROM results"))).toEqual([{ n: 0 }]);
			h.advance(JOB_LEASE_MS);
		}
		const replies = await Promise.all([h.app, peer].map((app) => invokeService(app, jobOp, { do: "run", id: job.id })));
		expect(replies).toContainEqual({ ok: true, result: { ran: 1 }, seq: null });
		expect(replies).toContainEqual({ ok: true, result: { ran: 0 }, seq: null });
		expect(await h.app.database.read((db) => jobById(db, job.id))).toMatchObject({ state: "succeeded" });
		expect(await h.app.database.read((db) => db.allDynamic("SELECT state FROM batches"))).toEqual([
			{ state: "processed" },
		]);
		expect(await h.app.database.read((db) => db.allDynamic("SELECT count(*) AS n FROM results"))).toEqual([{ n: 1 }]);
		expect(await h.app.database.read((db) => db.allDynamic("SELECT * FROM batch_admissions"))).toEqual([]);
		const retry = await h.call("report", {
			cmd: "pending-job-report",
			target: { commit: "pending-job-report" },
			results: [{ test: { case: "C-1" }, outcome: "pass" }],
		});
		expect(retry).toMatchObject({ counts: { total: 1, pass: 1 }, results: [expect.any(Number)] });
		expect(await h.app.database.read((db) => db.allDynamic("SELECT count(*) AS n FROM results"))).toEqual([{ n: 1 }]);
	});
}
