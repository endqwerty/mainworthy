import { expect, test } from "bun:test";
import type { App } from "../server/kernel/app.ts";

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
import { drainRetiredDemos, refreshDemo } from "./demo.ts";
import { seed } from "./seed.ts";
import { withInstance } from "./test-support.ts";

const small = { cases: 30, unlinkedFiles: 2, days: 1 };
const A = "a".repeat(40),
	B = "b".repeat(40);

test("the same revision preserves edits; a new revision swaps grants and drains only its retired demo", async () => {
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
	});
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

async function waitingForLock(app: App): Promise<void> {
	const end = performance.now() + 1000;
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
