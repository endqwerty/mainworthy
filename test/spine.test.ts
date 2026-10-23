import { expect, test } from "bun:test";
import { z } from "zod";
import { sql } from "../src/server/kernel/db.ts";
import { COMMIT, defineOp, invoke } from "../src/server/ops/registry.ts";
import { harness } from "./helpers.ts";

test("the PostgreSQL spine creates a project and proposes and reads a case", async () => {
	const h = await harness();
	try {
		await h.call("admin", { do: "project.create", key: "another", preset: "loose" });
		await h.call("propose", { edits: [{ op: "create", outline: "One" }] });
		const cases = await h.call<{ title: string }[]>("get", { refs: ["C-1"] });
		expect(cases).toHaveLength(1);
		expect(cases[0]?.title).toBe("One");
	} finally {
		await h.close();
	}
});

function barrier() {
	let release = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

for (const change of ["credential", "capability", "project identity"] as const) {
	test(`a read rechecks ${change} after its snapshot closes`, async () => {
		const h = await harness();
		const entered = barrier();
		const finish = barrier();
		let runs = 0;
		const operation = defineOp({
			name: "probe",
			summary: "Read scope probe",
			input: z.object({}),
			output: z.string(),
			needs: "read",
			scope: "project",
			effect: "read",
			mcp: null,
			async run(ctx) {
				runs++;
				entered.release();
				await finish.promise;
				// This is still the original snapshot, even after the concurrent change.
				expect(
					await ctx.db.get(sql<readonly [], { name: string }>("SELECT name FROM actors WHERE kind = 'human'")),
				).toEqual({ name: "robin" });
				return ctx.project.identity;
			},
		});
		const pending = invoke(
			h.app,
			{ probe: operation },
			{
				op: "probe",
				project: "scratch",
				input: {},
				reference: { via: "local", owner: "robin" },
				actor: async () => h.owner,
			},
		);
		try {
			await entered.promise;
			await h.app.database.write(
				async (db) =>
					await db.transaction(async () => {
						if (change === "credential")
							await db.run(sql<readonly []>("UPDATE actors SET disabled_at = 1 WHERE kind = 'human'"));
						else if (change === "capability") await db.run(sql<readonly []>("UPDATE grants SET can = '[]'"));
						else await db.run(sql<readonly []>("UPDATE projects SET identity = 'replacement' WHERE key = 'scratch'"));
					}),
			);
			finish.release();
			const reply = await pending;
			if (change === "project identity") {
				expect(reply.ok).toBe(true);
				if (reply.ok) expect(reply.result).toBe("replacement");
				expect(runs).toBe(2);
			} else {
				expect(reply.ok).toBe(false);
				if (!reply.ok) expect(reply.error.code).toBe(change === "credential" ? "unauthenticated" : "not_found");
			}
		} finally {
			finish.release();
			await pending;
			await h.close();
		}
	});
}

test("a sliced write commits twice on the same lease while its successor waits", async () => {
	const h = await harness();
	const gap = barrier();
	const finish = barrier();
	const pid = sql<readonly [], { pid: number }>("SELECT pg_backend_pid() AS pid");
	const operation = defineOp({
		name: "slice",
		summary: "Two-phase scope probe",
		input: z.object({}),
		output: z.array(z.number()),
		needs: "produce",
		scope: "project",
		effect: "write",
		mcp: null,
		async *steps(ctx) {
			const first = (await ctx.db.one(pid)).pid;
			yield COMMIT;
			gap.release();
			await finish.promise;
			return [first, (await ctx.db.one(pid)).pid];
		},
	});
	const pending = invoke(
		h.app,
		{ slice: operation },
		{ op: "slice", project: "scratch", input: {}, actor: async () => h.owner },
	);
	let successorRan = false;
	let successor: Promise<unknown> | undefined;
	try {
		await gap.promise;
		successor = h.app.database.write(async () => {
			successorRan = true;
		});
		const projects = await h.app.database.read(
			async (db) => await db.one(sql<readonly [], { seq: number }>("SELECT seq FROM projects WHERE key = 'scratch'")),
		);
		expect(projects.seq).toBe(2);
		expect(successorRan).toBe(false);
		finish.release();
		const reply = await pending;
		expect(reply.ok).toBe(true);
		if (reply.ok) {
			const pids = z.array(z.number()).parse(reply.result);
			expect(pids[0]).toBe(pids[1]);
			expect(reply.seq).toBe(3);
		}
		await successor;
		expect(successorRan).toBe(true);
	} finally {
		finish.release();
		await pending;
		await successor;
		await h.close();
	}
});

test("a write resolves authority after waiting for the exclusive lease", async () => {
	const h = await harness();
	const entered = barrier();
	const finish = barrier();
	const holder = h.app.database.write(
		async (db) =>
			await db.transaction(async () => {
				await db.run(sql<readonly []>("UPDATE actors SET disabled_at = 1 WHERE kind = 'human'"));
				entered.release();
				await finish.promise;
			}),
	);
	await entered.promise;
	let ran = false;
	const operation = defineOp({
		name: "write-probe",
		summary: "Write authority probe",
		input: z.object({}),
		output: z.boolean(),
		needs: "produce",
		scope: "project",
		effect: "write",
		mcp: null,
		run() {
			ran = true;
			return true;
		},
	});
	const pending = invoke(
		h.app,
		{ "write-probe": operation },
		{
			op: "write-probe",
			project: "scratch",
			input: {},
			reference: { via: "local", owner: "robin" },
			actor: async () => h.owner,
		},
	);
	try {
		finish.release();
		await holder;
		const reply = await pending;
		expect(reply.ok).toBe(false);
		if (!reply.ok) expect(reply.error.code).toBe("unauthenticated");
		expect(ran).toBe(false);
	} finally {
		finish.release();
		await holder;
		await pending;
		await h.close();
	}
});
