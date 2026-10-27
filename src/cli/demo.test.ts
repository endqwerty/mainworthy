import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Instance, start } from "../app/start.ts";
import { lockIdentity } from "../server/identity/identity.ts";
import { type App, defaultConfig } from "../server/kernel/app.ts";
import { databaseAdmin, type WriteDb } from "../server/kernel/db.ts";
import { removeProjectSlice } from "../server/transfer/transfer.ts";

async function snapshot(app: App) {
	return app.database.read(async (db) => {
		const result: Record<string, unknown[]> = {};
		for (const table of await db.catalog())
			result[table.name] = await db.allDynamic(
				`SELECT row_to_json(t)::text AS row FROM "${table.name}" t ORDER BY to_jsonb(t)::text`,
			);
		return result;
	});
}

import { z } from "zod";
import {
	demoDeployment,
	demoSince,
	findProject,
	lockProject,
	retireDemo,
	retiredDemos,
	setDemoDeployment,
} from "../server/kernel/ctx.ts";
import { drainRetiredDemos, refreshDemo, renewDemoWork } from "./demo.ts";
import { seed } from "./seed.ts";
import { CLI_ENTRY, withInstance } from "./test-support.ts";

const small = { cases: 30, unlinkedFiles: 2, days: 1 };
const A = "a".repeat(40),
	B = "b".repeat(40),
	C = "c".repeat(40);

test("the same revision preserves edits; a new revision swaps grants and drains only its retired demo", async () => {
	const settings = { env: { MAINWORTHY_JOB_RUNNER: "0" } };
	await withInstance(async ({ instance, client }) => {
		const { app } = instance;
		app.config.commit = A;
		const first = await refreshDemo(instance, "demo", small);
		const old = await app.database.read((db) => findProject(db, "demo"));
		expect(old).not.toBeNull();
		await client.call("admin", {
			do: "token.create",
			actor: "helper",
			kind: "human",
			can: ["read", "produce"],
			project: "demo",
		});
		await client.call("admin", { do: "team.create", name: "testers" });
		await client.call("admin", { do: "team.grant.set", team: "testers", project: "demo", can: ["read"] });
		await client.call("admin", { do: "team.grant.remove", team: "testers", project: "demo" });
		await client.call("admin", { do: "team.grant.set", team: "testers", project: "demo", can: ["read"] });
		const teamHistory = await client.call("admin", { do: "team.history", team: "testers" });
		await client
			.with({ project: "demo" })
			.call("propose", { edits: [{ op: "create", body: { title: "An edit to preserve" } }] });
		const before = await snapshot(app);
		expect(await refreshDemo(instance, "demo", small)).toEqual(first);
		expect(await snapshot(app)).toEqual(before);
		expect((await app.database.read((db) => findProject(db, "demo")))?.identity).toBe(old?.identity);
		app.config.commit = B;
		const second = await refreshDemo(instance, "demo", small);
		expect(second.cases).toHaveLength(30);
		const fresh = await app.database.read((db) => findProject(db, "demo"));
		expect(fresh?.identity).not.toBe(old?.identity);
		const actors = z
			.array(z.object({ name: z.string(), grants: z.array(z.object({ project: z.string() })) }))
			.parse(await client.call("admin", { do: "actor.list" }));
		expect(actors.find((a) => a.name === "helper")?.grants).toContainEqual(
			expect.objectContaining({ project: "demo" }),
		);
		const teams = z
			.array(z.object({ name: z.string(), grants: z.array(z.object({ project: z.string() })) }))
			.parse(await client.call("admin", { do: "team.list" }));
		expect(teams.find((t) => t.name === "testers")?.grants).toContainEqual(
			expect.objectContaining({ project: "demo" }),
		);
		expect(await app.database.read(retiredDemos)).toHaveLength(1);
		expect(
			z
				.array(z.object({ key: z.string() }))
				.parse(await client.call("admin", { do: "project.list" }))
				.some((p) => p.key.startsWith("~demo-")),
		).toBe(false);
		await expect(
			drainRetiredDemos(instance, {
				onSlice: async () => {
					throw new Error("drain interrupted");
				},
			}),
		).rejects.toThrow("drain interrupted");
		expect(await app.database.read(retiredDemos)).toHaveLength(1);
		let slices = 0;
		await drainRetiredDemos(instance, {
			onSlice: async () => {
				slices++;
				// A real unrelated write must acquire the gate between committed slices.
				if (slices === 1)
					await client.call("propose", { edits: [{ op: "create", body: { title: "A foreground write" } }] });
			},
		});
		expect(slices).toBeGreaterThan(1);
		expect(await app.database.read(retiredDemos)).toEqual([]);
		expect(await client.call("admin", { do: "team.history", team: "testers" })).toEqual(teamHistory);
		expect(
			(
				await app.database.read((db) => db.allDynamic("SELECT count(*) AS n FROM projects WHERE key LIKE '~demo-%'"))
			)[0],
		).toEqual({ n: 0 });
		expect((await client.call("find", { text: "A foreground write" })).items).toHaveLength(1);
	}, settings);
}, 30_000);

test("interrupted swap/seed resumes its marked revision, duplicate actors do not swap twice, and drain resumes", async () => {
	await withInstance(async ({ instance, client }) => {
		const { app } = instance;
		app.config.commit = A;
		await refreshDemo(instance, "demo", small);
		app.config.commit = B;
		await expect(
			refreshDemo(instance, "demo", small, {
				step: async (step) => {
					if (step === "swapped") throw new Error("interrupted after swap");
				},
			}),
		).rejects.toThrow("interrupted after swap");
		const fresh = await app.database.read((db) => findProject(db, "demo"));
		expect((await app.database.read((db) => demoDeployment(db, fresh?.id ?? 0)))?.kind).toBe("seeding");
		const since = await app.database.read((db) => demoSince(db, fresh?.id ?? 0));
		const [left, right] = await Promise.all([
			refreshDemo(instance, "demo", { ...small, cases: 31 }),
			refreshDemo(instance, "demo", small),
		]);
		expect(left).toEqual(right);
		expect(left.cases).toHaveLength(30);
		expect((await app.database.read((db) => findProject(db, "demo")))?.id).toBe(fresh?.id);
		expect(await app.database.read((db) => demoSince(db, fresh?.id ?? 0))).toBe(since);
		expect(await app.database.read(retiredDemos)).toEqual([]);
		await drainRetiredDemos(instance);
		expect(await app.database.read(retiredDemos)).toEqual([]);
		expect((await client.with({ project: "demo" }).call("find", { limit: 100 })).items).toHaveLength(28);
	});
}, 30_000);

test("a seed interrupted after writing resumes command ids rather than duplicating data", async () => {
	await withInstance(
		async ({ instance }) => {
			const { app } = instance;
			const batched = { ...small, cases: 300, days: 0 };
			app.config.commit = A;
			await expect(
				refreshDemo(instance, "demo", batched, {
					step: async (step) => {
						if (step === "seeded") throw new Error("interrupted before completion");
					},
				}),
			).rejects.toThrow("interrupted before completion");
			const project = await app.database.read((db) => findProject(db, "demo"));
			expect((await app.database.read((db) => db.allDynamic("SELECT count(*) AS n FROM cases")))[0]).toEqual({
				n: 300,
			});
			const result = await refreshDemo(instance, "demo", batched);
			expect(result.cases).toHaveLength(300);
			expect((await app.database.read((db) => db.allDynamic("SELECT count(*) AS n FROM cases")))[0]).toEqual({
				n: 300,
			});
			expect((await app.database.read((db) => findProject(db, "demo")))?.id).toBe(project?.id);
			expect((await app.database.read((db) => demoDeployment(db, project?.id ?? 0)))?.kind).toBe("ready");
		},
		{ mode: "server" },
	);
}, 30_000);

test("unknown revisions and real projects are refused without changing their data", async () => {
	await withInstance(async ({ instance, client }) => {
		await expect(refreshDemo(instance, "demo", small)).rejects.toThrow("known MAINWORTHY_COMMIT");
		instance.app.config.commit = A;
		await client.call("propose", { edits: [{ op: "create", body: { title: "Real work" } }] });
		await expect(refreshDemo(instance, "scratch", small)).rejects.toThrow("which is not a demo");
		expect((await client.call("find", {})).items.map((row) => row.title)).toEqual(["Real work"]);
	});
});

test("a repeated demo seed renews one live slot and renewal keeps its start", async () => {
	await withInstance(async ({ instance, client }) => {
		const first = await seed(client, { project: "demo", cases: 30, days: 1 });
		const again = await seed(client, { project: "demo", cases: 30, days: 1 });
		expect(again.workSlot).toBe(first.workSlot);
		const demo = client.with({ project: "demo" });
		expect((await demo.call("get", { refs: [first.run] }))[0]).toMatchObject({ inProgress: 1 });
		const before = (await demo.call("find", { in: "slots", run: first.run })).items.find(
			(s) => s.id === first.workSlot,
		);
		const { renewDemoWork } = await import("./demo.ts");
		const now = instance.app.now();
		instance.app.now = () => now + 60_000;
		await renewDemoWork(instance, "demo", first);
		const after = (await demo.call("find", { in: "slots", run: first.run })).items.find((s) => s.id === first.workSlot);
		expect((await demo.call("get", { refs: [first.run] }))[0]).toMatchObject({ inProgress: 1 });
		expect(z.object({ until: z.number() }).parse(after?.work).until).toBeGreaterThan(
			z.object({ until: z.number() }).parse(before?.work).until,
		);
		expect(after?.work).toMatchObject({
			kind: "held",
			since: z.object({ since: z.number() }).parse(before?.work).since,
		});
	});
}, 20_000);

test("a stale read snapshot cannot make a completed revision refresh again", async () => {
	await withInstance(async ({ instance }) => {
		const { app } = instance;
		app.config.commit = A;
		const first = await refreshDemo(instance, "demo", small);
		const project = await app.database.read((db) => findProject(db, "demo"));
		if (!project) throw new Error("the seeded demo is missing");
		const completed = await app.database.read((db) => demoDeployment(db, project.id));
		if (completed?.kind !== "ready") throw new Error("the seed was not completed");
		await app.database.write((db) =>
			db.transaction(() =>
				setDemoDeployment(db, project.id, { kind: "seeding", revision: A, size: { ...small, days: 1 } }),
			),
		);
		const observed = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		const stale = app.database.read(async (db) => {
			expect((await demoDeployment(db, project.id))?.kind).toBe("seeding");
			observed.resolve();
			await released.promise;
			expect((await demoDeployment(db, project.id))?.kind).toBe("seeding");
		});
		await observed.promise;
		try {
			await app.database.write((db) => db.transaction(() => setDemoDeployment(db, project.id, completed)));
			expect(await refreshDemo(instance, "demo", small)).toEqual(first);
			expect((await app.database.read((db) => findProject(db, "demo")))?.identity).toBe(project.identity);
			expect(await app.database.read(retiredDemos)).toEqual([]);
		} finally {
			released.resolve();
			await stale;
		}
	});
}, 30_000);

async function waitingForLock(app: App, ms = 1000): Promise<void> {
	const end = performance.now() + ms;
	while (performance.now() < end) {
		const waiting = await app.database.read((db) =>
			db.allDynamic<{ n: number }>(
				"SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
			),
		);
		if ((waiting[0]?.n ?? 0) > 0) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error("demo maintenance never waited for its project lock");
}

for (const phase of ["swap", "ready", "drain"] as const)
	test(`demo ${phase} waits for the project writer before changing maintenance state`, async () => {
		await withInstance(async ({ instance }) => {
			const { app } = instance;
			const size = { cases: 1, unlinkedFiles: 0, days: 0 };
			app.config.commit = A;
			const seeded = Promise.withResolvers<void>();
			const finishSeed = Promise.withResolvers<void>();
			const seeding = refreshDemo(instance, "demo", size, {
				step: async (step) => {
					if (phase === "ready" && step === "seeded") {
						seeded.resolve();
						await finishSeed.promise;
					}
				},
			});
			if (phase === "ready") await seeded.promise;
			else await seeding;
			const project = await app.database.read((db) => findProject(db, "demo"));
			if (!project) throw new Error("missing demo");
			if (phase === "drain") await app.database.write((db) => db.transaction(() => retireDemo(db, project)));
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const holding = app.database.write((db) =>
				db.transaction(async () => {
					await lockProject(db, project.id);
					entered.resolve();
					await release.promise;
				}),
			);
			await entered.promise;
			app.config.commit = B;
			let completed = false;
			if (phase === "ready") finishSeed.resolve();
			const changing = (
				phase === "drain"
					? drainRetiredDemos(instance)
					: phase === "ready"
						? seeding
						: refreshDemo(instance, "demo", size)
			).then(() => {
				completed = true;
			});
			try {
				await waitingForLock(app);
				expect(completed).toBe(false);
				if (phase === "swap") expect((await app.database.read((db) => findProject(db, "demo")))?.id).toBe(project.id);
				if (phase === "ready")
					expect(await app.database.read((db) => demoDeployment(db, project.id))).toMatchObject({ kind: "seeding" });
			} finally {
				release.resolve();
				await Promise.all([holding, changing]);
			}
			if (phase === "swap") expect((await app.database.read((db) => findProject(db, "demo")))?.id).not.toBe(project.id);
			if (phase === "ready")
				expect(await app.database.read((db) => demoDeployment(db, project.id))).toMatchObject({ kind: "ready" });
			if (phase === "drain") expect(await app.database.read(retiredDemos)).toEqual([]);
		});
	});

/** A second server on the first one's database, as during a rollout with two instances. */
async function withSecond<T>(first: Instance, run: (second: Instance) => Promise<T>): Promise<T> {
	const directory = await mkdtemp(join(tmpdir(), "mainworthy-second-"));
	const second = await start(
		defaultConfig({
			MAINWORTHY_DATABASE_URL: first.app.config.databaseUrl,
			MAINWORTHY_DATA: directory,
			MAINWORTHY_PORT: "0",
			MAINWORTHY_OWNER: first.owner.name,
			MAINWORTHY_MODE: "local",
		}),
		() => ({ ui: null }),
	);
	try {
		return await run(second);
	} finally {
		await second.stop();
		await rm(directory, { recursive: true, force: true });
	}
}

test("a second instance refreshing the same revision keeps the first one's demo and an edit made in it", async () => {
	await withInstance(async ({ instance, client }) => {
		instance.app.config.commit = A;
		await withSecond(instance, async (second) => {
			second.app.config.commit = A;
			const swapped = Promise.withResolvers<void>();
			const first = refreshDemo(instance, "demo", small, {
				step: async (step) => {
					if (step === "swapped") swapped.resolve();
				},
			});
			await swapped.promise;
			// The second instance starts while the first seeds, and reaches its swap only after the first has finished.
			const edited = Promise.withResolvers<void>();
			const late = refreshDemo(second, "demo", small, {
				step: async (step) => {
					if (step === "checked") await edited.promise;
				},
			});
			try {
				const seeded = await first;
				const project = await instance.app.database.read((db) => findProject(db, "demo"));
				const demo = client.with({ project: "demo" });
				await demo.call("propose", { edits: [{ op: "create", body: { title: "An edit between two refreshes" } }] });
				edited.resolve();
				expect(await late).toEqual(seeded);
				expect((await instance.app.database.read((db) => findProject(db, "demo")))?.id).toBe(project?.id);
				expect(await instance.app.database.read(retiredDemos)).toEqual([]);
				expect((await demo.call("find", { text: "An edit between two refreshes" })).items).toHaveLength(1);
			} finally {
				edited.resolve();
				await late.catch(() => undefined);
			}
		});
	});
}, 60_000);

test("a retired demo another instance removed first does not stop the new revision's refresh", async () => {
	await withInstance(async ({ instance }) => {
		const { app } = instance;
		app.config.commit = A;
		await refreshDemo(instance, "demo", small);
		app.config.commit = B;
		// The swap retires the revision-A demo; nothing drains it until the second instance refreshes.
		await refreshDemo(instance, "demo", small);
		const [retired] = await app.database.read(retiredDemos);
		if (!retired) throw new Error("revision B left no retired demo");
		await withSecond(instance, async (second) => {
			second.app.config.commit = C;
			const holding = Promise.withResolvers<void>();
			const removed = Promise.withResolvers<void>();
			// The first instance takes the identity lock, so the second, having read the retired project, waits for it.
			const removing = app.database.write((db) =>
				db.transaction(async () => {
					await lockIdentity(db);
					holding.resolve();
					await removed.promise;
					while (!(await removeProjectSlice(db, retired.key, 10_000)).done);
				}),
			);
			await holding.promise;
			const refreshing = refreshDemo(second, "demo", small);
			try {
				await waitingForLock(app, 10_000);
			} finally {
				removed.resolve();
				await removing;
			}
			expect((await refreshing).cases).toHaveLength(30);
			const project = await app.database.read((db) => findProject(db, "demo"));
			expect(await app.database.read((db) => demoDeployment(db, project?.id ?? 0))).toMatchObject({
				kind: "ready",
				revision: C,
			});
			expect((await app.database.read(retiredDemos)).map((row) => row.id)).not.toContain(retired.id);
		});
	});
}, 60_000);

/**
 * Ends the session that holds the refresh lock, as a lost connection or a restarted database server would. Only this
 * test's database: other demo test files beside it hold a lock under the same key in theirs.
 */
async function endRefreshLock(app: App, project: string): Promise<boolean[]> {
	const rows = await app.database.read((db) =>
		db.allDynamic<{ ended: boolean }>(
			`SELECT pg_terminate_backend(pid) AS ended FROM pg_locks, hashtextextended($1::text, 914) AS k(key)
			 WHERE locktype = 'advisory' AND granted AND objsubid = 1
			   AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
			   AND classid::bigint = (key >> 32) & 4294967295 AND objid::bigint = key & 4294967295`,
			[`demo refresh ${project}`],
		),
	);
	return rows.map((row) => row.ended);
}

test("a refresh that lost its lock keeps the demo another instance made ready for the revision, and its edit", async () => {
	await withInstance(async ({ instance, client }) => {
		instance.app.config.commit = A;
		await withSecond(instance, async (second) => {
			second.app.config.commit = A;
			const checked = Promise.withResolvers<void>();
			const resume = Promise.withResolvers<void>();
			const late = refreshDemo(instance, "demo", small, {
				step: async (step) => {
					if (step !== "checked") return;
					checked.resolve();
					await resume.promise;
				},
			});
			try {
				await checked.promise;
				expect(await endRefreshLock(instance.app, "demo")).toEqual([true]);
				const seeded = await refreshDemo(second, "demo", small);
				const project = await instance.app.database.read((db) => findProject(db, "demo"));
				const demo = client.with({ project: "demo" });
				await demo.call("propose", { edits: [{ op: "create", body: { title: "An edit after the lock was lost" } }] });
				resume.resolve();
				expect(await late).toEqual(seeded);
				expect((await instance.app.database.read((db) => findProject(db, "demo")))?.id).toBe(project?.id);
				expect(await instance.app.database.read(retiredDemos)).toEqual([]);
				expect((await demo.call("find", { text: "An edit after the lock was lost" })).items).toHaveLength(1);
			} finally {
				resume.resolve();
				await late.catch(() => undefined);
			}
		});
	});
}, 60_000);

/** What a project holds, counted, to tell one seed's demo from two seeds' mixed. */
const holdings = (app: App, project: number) =>
	app.database.read((db) =>
		db.allDynamic<{ cases: number; results: number; questions: number; runs: number }>(
			`SELECT (SELECT count(*) FROM cases WHERE project = $1) AS cases, (SELECT count(*) FROM results WHERE project = $1) AS results,
			 (SELECT count(*) FROM questions WHERE project = $1) AS questions, (SELECT count(*) FROM runs WHERE project = $1) AS runs`,
			[project],
		),
	);

test("a refresh that lost its lock while another revision replaced the demo has its next write refused", async () => {
	await withInstance(async ({ instance }) => {
		const { app } = instance;
		app.config.commit = A;
		await withSecond(instance, async (second) => {
			second.app.config.commit = B;
			const paused = Promise.withResolvers<void>();
			const resume = Promise.withResolvers<void>();
			let proposals = 0;
			// Revision A stops before its seed's first cases, with its policy and folders written to its project.
			const late = refreshDemo(instance, "demo", small, {
				step: async (step) => {
					if (step !== "request propose" || ++proposals !== 4) return;
					paused.resolve();
					await resume.promise;
				},
			});
			try {
				await Promise.race([paused.promise, late]);
				expect(proposals).toBe(4);
				const replaced = await app.database.read((db) => findProject(db, "demo"));
				expect(await endRefreshLock(app, "demo")).toEqual([true]);
				const seeded = await refreshDemo(second, "demo", { cases: 20, unlinkedFiles: 1, days: 1 });
				const project = await app.database.read((db) => findProject(db, "demo"));
				if (!project) throw new Error("revision B left no demo");
				expect(project.id).not.toBe(replaced?.id);
				const held = await holdings(app, project.id);
				resume.resolve();
				const refused = await late.then(
					() => "ready",
					(error: unknown) => (error instanceof Error ? error.message : String(error)),
				);
				expect(await holdings(app, project.id)).toEqual(held);
				expect(refused).toContain("was replaced since this seed was started for it");
				expect(held[0]?.cases).toBe(seeded.cases.length);
				expect(await app.database.read((db) => demoDeployment(db, project.id))).toMatchObject({
					kind: "ready",
					revision: B,
				});
			} finally {
				resume.resolve();
				await late.catch(() => undefined);
			}
		});
	});
}, 60_000);

test("behind a proxy secret, a refresh seeds the demo in this process and sends no request", async () => {
	const settings = {
		mode: "server" as const,
		env: {
			MAINWORTHY_PROXY_SECRET: "a proxy secret of at least 32 characters",
			MAINWORTHY_CLIENT_ADDRESS_HEADER: "x-client-address",
			MAINWORTHY_JOB_RUNNER: "0",
		},
	};
	await withInstance(async ({ instance }) => {
		const { app } = instance;
		app.config.commit = A;
		// Every request that would leave the process goes through `fetch`; the server refuses one without the secret.
		const real = globalThis.fetch;
		const sent: { url: string; bearer: boolean }[] = [];
		globalThis.fetch = Object.assign(
			(input: string | URL | Request, init?: RequestInit) => {
				const request = new Request(input, init);
				sent.push({ url: request.url, bearer: request.headers.has("authorization") });
				return real(input, init);
			},
			{ preconnect: real.preconnect },
		);
		let seeded: Awaited<ReturnType<typeof refreshDemo>>;
		try {
			seeded = await refreshDemo(instance, "demo", small);
		} finally {
			globalThis.fetch = real;
		}
		expect(sent).toEqual([]);
		expect(seeded.cases).toHaveLength(30);
		const project = await app.database.read((db) => findProject(db, "demo"));
		expect(await app.database.read((db) => demoDeployment(db, project?.id ?? 0))).toMatchObject({
			kind: "ready",
			revision: A,
		});
		// No token was made for the seed to sign in with; its pipeline and reviewer tokens are revoked.
		const tokens = await app.database.read((db) =>
			db.allDynamic<{ label: string; revoked: boolean }>(
				"SELECT label, revoked_at IS NOT NULL AS revoked FROM tokens ORDER BY id",
			),
		);
		expect(tokens.filter((token) => token.label.startsWith("demo seed"))).toEqual([]);
		expect(tokens.filter((token) => token.label.startsWith("Demo ") && !token.revoked)).toEqual([]);
		expect((await real(`${instance.url}/api/session`)).status).toBe(403);
	}, settings);
}, 60_000);

test("retired demos that cannot be removed stop at two: later revisions keep the demo they have", async () => {
	await withInstance(async ({ instance }) => {
		const { app } = instance;
		const tiny = { cases: 1, unlinkedFiles: 0, days: 0 };
		// Every removal fails at its last step, deleting the project row, as a persistent fault would.
		await databaseAdmin(app.config.databaseUrl, (admin) =>
			admin.exec(`CREATE FUNCTION refuse_project_delete() RETURNS trigger LANGUAGE plpgsql
				AS $$ BEGIN RAISE EXCEPTION 'injected deletion failure'; END $$;
				CREATE TRIGGER refuse_project_delete BEFORE DELETE ON projects
				FOR EACH ROW EXECUTE FUNCTION refuse_project_delete()`),
		);
		const retired: number[] = [];
		const outcomes: string[] = [];
		for (const revision of [A, B, C, "d".repeat(40), "e".repeat(40)]) {
			app.config.commit = revision;
			outcomes.push(
				await refreshDemo(instance, "demo", tiny).then(
					() => "ready",
					(error: unknown) => (error instanceof Error ? error.message : String(error)),
				),
			);
			retired.push((await app.database.read(retiredDemos)).length);
		}
		expect(retired).toEqual([0, 1, 2, 2, 2]);
		expect(outcomes.slice(0, 3)).toEqual(["ready", "ready", "ready"]);
		expect(outcomes[3]).toContain("2 retired demos are still waiting for cleanup");
		const project = await app.database.read((db) => findProject(db, "demo"));
		expect(await app.database.read((db) => demoDeployment(db, project?.id ?? 0))).toMatchObject({
			kind: "ready",
			revision: C,
		});
	});
}, 60_000);

/** Holds a write transaction open with `take` done, as another writer would, until `release` is called. */
async function holdWriter(app: App, take: (db: WriteDb) => Promise<unknown>) {
	const entered = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	const holding = app.database.write((db) =>
		db.transaction(async () => {
			await take(db);
			entered.resolve();
			await released.promise;
		}),
	);
	await Promise.race([entered.promise, holding]);
	return {
		async release() {
			released.resolve();
			await holding;
		},
	};
}

/**
 * Starts `serve` on the instance's database and waits for the line it prints just before it handles SIGTERM, then
 * for `ready`. Then it sends SIGTERM and says how the process ended. Like Cloud Run, it sends SIGKILL ten seconds
 * after SIGTERM.
 */
async function stopServe(
	instance: Instance,
	env: Record<string, string>,
	ready: () => Promise<void>,
): Promise<{ killed: boolean; code: number; stderr: string; ms: number }> {
	const home = await mkdtemp(join(tmpdir(), "mainworthy-serve-stop-"));
	const child = Bun.spawn([process.execPath, CLI_ENTRY, "serve"], {
		cwd: home,
		env: {
			PATH: process.env.PATH ?? "",
			MAINWORTHY_DATABASE_URL: instance.app.config.databaseUrl,
			HOME: home,
			USER: instance.owner.name,
			MAINWORTHY_PORT: "0",
			MAINWORTHY_MODE: "local",
			...env,
		},
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
	});
	const stderr = new Response(child.stderr).text();
	let killed = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		// serve installs its SIGTERM handler in the same turn as it prints its project line, with no wait between.
		const reader = child.stdout.getReader();
		const decoder = new TextDecoder();
		let printed = "";
		while (!printed.includes(" · policy: ")) {
			const chunk = await reader.read();
			if (chunk.done) throw new Error(`serve stopped before it was ready: ${await stderr}`);
			printed += decoder.decode(chunk.value, { stream: true });
		}
		reader.releaseLock();
		void child.stdout.pipeTo(new WritableStream()).catch(() => {});
		await ready();
		const began = performance.now();
		child.kill("SIGTERM");
		timer = setTimeout(() => {
			killed = true;
			child.kill("SIGKILL");
		}, 10_000);
		const code = await child.exited;
		return { killed, code, stderr: await stderr, ms: Math.round(performance.now() - began) };
	} finally {
		clearTimeout(timer);
		child.kill("SIGKILL");
		await child.exited;
		await rm(home, { recursive: true, force: true });
	}
}

/** Waits until a statement containing `text` waits for a lock. */
async function waitingFor(app: App, text: string, ms: number): Promise<void> {
	const end = performance.now() + ms;
	while (performance.now() < end) {
		const rows = await app.database.read((db) =>
			db.allDynamic<{ query: string }>(
				"SELECT query FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
			),
		);
		if (rows.some((row) => row.query.includes(text))) return;
		await Bun.sleep(20);
	}
	throw new Error(`no statement with ${text} waited for a lock`);
}

/** Only taking demo work inserts into slot_leases: holding the table makes that insert, and nothing else, wait. */
const holdSlotLeases = (app: App) =>
	holdWriter(app, (db) => db.exec("LOCK TABLE slot_leases IN SHARE ROW EXCLUSIVE MODE"));

test("a demo work renewal aborted while it waits for a writer comes back as the abort and takes nothing", async () => {
	await withInstance(async ({ instance }) => {
		const { app } = instance;
		app.config.commit = A;
		const seeded = await refreshDemo(instance, "demo", small);
		const writer = await holdSlotLeases(app);
		const logged: string[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => {
			logged.push(args.map(String).join(" "));
		};
		const leases = async () =>
			Number(
				(
					await app.database.read((db) =>
						db.allDynamic<{ n: number }>("SELECT count(*) AS n FROM slot_leases WHERE slot = $1", [
							seeded.workSlot ?? 0,
						]),
					)
				)[0]?.n,
			);
		try {
			const before = await leases();
			const controller = new AbortController();
			const reason = new Error("renewal stopped by the test");
			const renewing = renewDemoWork(instance, "demo", seeded, controller.signal).then(
				() => "finished",
				(error: unknown) => error,
			);
			await waitingFor(app, "INSERT INTO slot_leases", 10_000);
			controller.abort(reason);
			// The insert already sent waits for the writer; once it has run, the operation stops before committing.
			await writer.release();
			expect(await renewing).toBe(reason);
			expect(await leases()).toBe(before);
			expect(logged).toEqual([]);
		} finally {
			console.error = original;
			await writer.release();
		}
	});
}, 30_000);

/** Waits until no statement containing `text` waits for a lock any more, and says whether that happened in time. */
async function stoppedWaiting(app: App, text: string, ms: number): Promise<boolean> {
	const end = performance.now() + ms;
	while (performance.now() < end) {
		const rows = await app.database.read((db) =>
			db.allDynamic<{ query: string }>(
				"SELECT query FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
			),
		);
		if (!rows.some((row) => row.query.includes(text))) return true;
		await Bun.sleep(50);
	}
	return false;
}

/** The line a stopping `serve` prints when its deadline cuts `step` off. */
const cutOff = (step: string) => `mainworthy: stopping took longer than 7 s; exiting with ${step} still running`;

test("serve exits at its deadline after SIGTERM while its cleanup waits for a project writer", async () => {
	await withInstance(async ({ instance }) => {
		const { app } = instance;
		const tiny = { cases: 1, unlinkedFiles: 0, days: 0 };
		app.config.commit = A;
		await refreshDemo(instance, "demo", tiny);
		app.config.commit = B;
		await refreshDemo(instance, "demo", tiny);
		const [retired] = await app.database.read(retiredDemos);
		if (!retired) throw new Error("revision B left no retired demo");
		const slice = "FROM projects WHERE id = $1 FOR UPDATE";
		const writer = await holdWriter(app, (db) => lockProject(db, retired.id));
		try {
			const ended = await stopServe(instance, {}, () => waitingFor(app, slice, 20_000));
			expect({ killed: ended.killed, code: ended.code }).toEqual({ killed: false, code: 4 });
			expect(ended.stderr).toContain(cutOff("retired demo cleanup"));
			// The writer still holds its lock, but the slice's backend sees that serve has gone, and rolls back.
			expect(await stoppedWaiting(app, slice, 5_000)).toBe(true);
		} finally {
			await writer.release();
		}
		expect((await app.database.read(retiredDemos)).map((row) => row.id)).toEqual([retired.id]);
	});
}, 60_000);

test("serve exits at its deadline after SIGTERM while renewing a same-revision demo's work waits for a writer", async () => {
	await withInstance(async ({ instance }) => {
		const { app } = instance;
		app.config.commit = A;
		const seeded = await refreshDemo(instance, "demo", small);
		expect(seeded.workSlot).not.toBeNull();
		const writer = await holdSlotLeases(app);
		try {
			const ended = await stopServe(instance, { MAINWORTHY_DEMO: "demo", MAINWORTHY_COMMIT: A }, () =>
				waitingFor(app, "INSERT INTO slot_leases", 20_000),
			);
			expect({ killed: ended.killed, code: ended.code }).toEqual({ killed: false, code: 4 });
			expect(ended.stderr).toContain(cutOff("demo work renewal"));
		} finally {
			await writer.release();
		}
	});
}, 60_000);

test("serve exits before Cloud Run's SIGKILL while a demo seed's request waits for a writer", async () => {
	await withInstance(async ({ instance }) => {
		const { app } = instance;
		app.config.commit = A;
		await refreshDemo(instance, "demo", { cases: 1, unlinkedFiles: 0, days: 0 });
		// Nothing but the seed writes cases: the swap and the drain go ahead, and the seed's write waits.
		const writer = await holdWriter(app, (db) => db.exec("LOCK TABLE cases IN SHARE ROW EXCLUSIVE MODE"));
		try {
			const ended = await stopServe(instance, { MAINWORTHY_DEMO: "demo", MAINWORTHY_COMMIT: B }, async () => {
				await waitingFor(app, "cases", 30_000);
				const project = await app.database.read((db) => findProject(db, "demo"));
				expect(await app.database.read((db) => demoDeployment(db, project?.id ?? 0))).toMatchObject({
					kind: "seeding",
					revision: B,
				});
			});
			expect({ killed: ended.killed, code: ended.code }).toEqual({ killed: false, code: 4 });
			// The seed's write, in the server's process, waits for the cases lock past the deadline.
			expect(ended.stderr).toContain(cutOff("the demo refresh"));
		} finally {
			await writer.release();
		}
	});
}, 60_000);
