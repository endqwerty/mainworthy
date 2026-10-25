import { afterEach, expect, test } from "bun:test";
import { type App, openApp } from "../src/server/kernel/app.ts";
import { lockProject, makeCtx, stampSeq } from "../src/server/kernel/ctx.ts";
import { enqueuePeriodicJobs, enqueueStartupJobs, jobOp } from "../src/server/ops/jobs.ts";
import { invokeService } from "../src/server/ops/registry.ts";
import { acceptReport } from "../src/server/ops/writes.ts";
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
