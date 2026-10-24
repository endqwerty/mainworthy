import { expect, test } from "bun:test";
import { z } from "zod";
import { demoDeployment, demoSince, findProject, retiredDemos, setDemoDeployment } from "../server/kernel/ctx.ts";
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
		const old = findProject(app.db, "demo");
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
		await client
			.with({ project: "demo" })
			.call("propose", { edits: [{ op: "create", body: { title: "An edit to preserve" } }] });
		const before = app.db.raw.serialize();
		expect(await refreshDemo(instance, "demo", small)).toEqual(first);
		expect(app.db.raw.serialize()).toEqual(before);
		expect(findProject(app.db, "demo")?.identity).toBe(old?.identity);
		app.config.commit = B;
		const second = await refreshDemo(instance, "demo", small);
		expect(second.cases).toHaveLength(30);
		const fresh = findProject(app.db, "demo");
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
		expect(retiredDemos(app.db)).toHaveLength(1);
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
		expect(retiredDemos(app.db)).toHaveLength(1);
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
		expect(retiredDemos(app.db)).toEqual([]);
		expect(app.db.raw.query("SELECT count(*) AS n FROM projects WHERE key LIKE '~demo-%'").get()).toEqual({ n: 0 });
		expect(app.db.raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
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
		const fresh = findProject(app.db, "demo");
		expect(demoDeployment(app.db, fresh?.id ?? 0)?.kind).toBe("seeding");
		const since = demoSince(app.db, fresh?.id ?? 0);
		const [left, right] = await Promise.all([
			refreshDemo(instance, "demo", { ...small, cases: 31 }),
			refreshDemo(instance, "demo", small),
		]);
		expect(left).toEqual(right);
		expect(left.cases).toHaveLength(30);
		expect(findProject(app.db, "demo")?.id).toBe(fresh?.id);
		expect(demoSince(app.db, fresh?.id ?? 0)).toBe(since);
		expect(retiredDemos(app.db)).toEqual([]);
		await drainRetiredDemos(instance);
		expect(retiredDemos(app.db)).toEqual([]);
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
			const project = findProject(app.db, "demo");
			expect(app.db.raw.query("SELECT count(*) AS n FROM cases").get()).toEqual({ n: 300 });
			const result = await refreshDemo(instance, "demo", batched);
			expect(result.cases).toHaveLength(300);
			expect(app.db.raw.query("SELECT count(*) AS n FROM cases").get()).toEqual({ n: 300 });
			expect(findProject(app.db, "demo")?.id).toBe(project?.id);
			expect(demoDeployment(app.db, project?.id ?? 0)?.kind).toBe("ready");
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
		const project = findProject(app.db, "demo");
		if (!project) throw new Error("the seeded demo is missing");
		const completed = demoDeployment(app.db, project.id);
		if (completed?.kind !== "ready") throw new Error("the seed was not completed");
		await app.gate.run(() =>
			app.db.transaction(() =>
				setDemoDeployment(app.db, project.id, { kind: "seeding", revision: A, size: { ...small, days: 1 } }),
			),
		);
		app.reader.raw.exec("BEGIN");
		try {
			expect(demoDeployment(app.reader, project.id)?.kind).toBe("seeding");
			await app.gate.run(() => app.db.transaction(() => setDemoDeployment(app.db, project.id, completed)));
			expect(await refreshDemo(instance, "demo", small)).toEqual(first);
			expect(findProject(app.db, "demo")?.identity).toBe(project.identity);
			expect(retiredDemos(app.db)).toEqual([]);
		} finally {
			app.reader.raw.exec("ROLLBACK");
		}
	});
}, 30_000);
