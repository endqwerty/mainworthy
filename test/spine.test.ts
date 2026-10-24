import { expect, spyOn, test } from "bun:test";
import { z } from "zod";
import { API_VERSION, API_VERSION_HEADER } from "../src/core/version.ts";
import { createToken, signInWithToken } from "../src/server/identity/identity.ts";
import { sql } from "../src/server/kernel/db.ts";
import { OpError } from "../src/server/kernel/errors.ts";
import { runArchive } from "../src/server/ops/archives.ts";
import { COMMIT, defineInstanceOp, defineOp, invoke } from "../src/server/ops/registry.ts";
import { reportOp } from "../src/server/ops/writes.ts";
import { removeProject } from "../src/server/transfer/transfer.ts";
import { grantedProjects, serve } from "../src/surfaces/http.ts";
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

test("HTTP report replay waits for its pending command and recovers the identical receipt", async () => {
	if (!("steps" in reportOp)) throw new Error("report must be a sliced operation");
	const h = await harness();
	const held = barrier();
	const release = barrier();
	const queued = barrier();
	await h.call("propose", { edits: [{ op: "create", outline: "Recover this report" }] });
	await h.call("plan", { name: "Recovery", select: { cases: ["C-1"] } });
	const server = serve(h.app, h.owner);
	const origin = `http://127.0.0.1:${server.port}`;
	let cookie = "";
	const steps = reportOp.steps;
	const report = spyOn(reportOp, "steps").mockImplementation(async function* (ctx, input) {
		const iterator = steps(ctx, input);
		for (let step = await iterator.next(); ; step = await iterator.next()) {
			if (step.done) return step.value;
			yield step.value;
			if (step.value === COMMIT) {
				held.release();
				await release.promise;
			}
		}
	});
	const send = async (op: string, input: unknown) => {
		const response = await fetch(`${origin}/api/p/scratch/${op}`, {
			method: "POST",
			headers: { "content-type": "application/json", origin, cookie, [API_VERSION_HEADER]: String(API_VERSION) },
			body: JSON.stringify(input),
		});
		return response.json();
	};
	let writes: ReturnType<typeof spyOn> | undefined;
	let first: Promise<unknown> | undefined;
	let replay: Promise<unknown> | undefined;
	try {
		const { secret } = await createToken(h.app, {
			actor: "phone",
			kind: "human",
			can: ["read", "record"],
			project: 0,
			label: "phone",
		});
		const opening = await signInWithToken(h.app, secret, { userAgent: null, address: null });
		if (opening.kind !== "opening") throw new Error("no session");
		const signedIn = await opening.signedIn;
		if (!signedIn) throw new Error("no cookie");
		cookie = `mainworthy_sid=${signedIn.cookie}`;
		const input = {
			cmd: "pending-http-report",
			run: "R-1",
			results: [{ test: { case: "C-1" }, outcome: "fail", note: "Original note" }],
		};
		first = send("report", input);
		await Promise.race([
			held.promise,
			first.then((reply) => {
				throw new Error(`report answered before its first commit: ${JSON.stringify(reply)}`);
			}),
		]);
		const write = h.app.database.write.bind(h.app.database);
		writes = spyOn(h.app.database, "write").mockImplementation((fn, options) => {
			queued.release();
			return write(fn, options);
		});
		let answered = false;
		replay = send("report", input).then((reply) => {
			answered = true;
			return reply;
		});
		await queued.promise;
		expect(await send("command", { cmd: input.cmd })).toMatchObject({ ok: true, result: { state: "begun" } });
		expect(answered).toBe(false);
		release.release();
		const receipt = await first;
		expect(receipt).toMatchObject({ ok: true });
		expect(await replay).toEqual(receipt);
		expect(await send("command", { cmd: input.cmd })).toMatchObject({ ok: true, result: { state: "done" } });
		const timeline = await h.call<{ entries: { t: string; note?: string }[] }>("timeline", { ref: "C-1" });
		expect(timeline.entries.filter((entry) => entry.t === "result")).toEqual([
			expect.objectContaining({ note: "Original note" }),
		]);
	} finally {
		release.release();
		await Promise.allSettled([first, replay]);
		writes?.mockRestore();
		report.mockRestore();
		await server.stop(true);
		await h.close();
	}
});

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
		successor = h.app.database.write((db) =>
			db.transaction(async () => {
				await db.all(sql("SELECT id FROM projects WHERE key = 'scratch' FOR UPDATE"));
				successorRan = true;
			}),
		);
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

test("ref reservations in one command are contiguous and do not overlap", async () => {
	const h = await harness();
	const operation = defineOp({
		name: "reserve",
		summary: "Reserve ref ranges",
		input: z.object({}),
		output: z.array(z.number()),
		needs: "produce",
		scope: "project",
		effect: "write",
		mcp: null,
		async run(ctx) {
			const first = await ctx.nextNo("test", 3);
			const second = await ctx.nextNo("test", 2);
			const single = await ctx.nextNo("test");
			const explicitSingle = await ctx.nextNo("test", 1);
			return [first, second, single, explicitSingle];
		},
	});
	try {
		expect(
			await invoke(
				h.app,
				{ reserve: operation },
				{ op: "reserve", project: "scratch", input: {}, actor: async () => h.owner },
			),
		).toMatchObject({ ok: true, result: [3, 5, 6, 7] });
	} finally {
		await h.close();
	}
});

test("archive authorization waits for the write lease and refuses before replacing bootstrap", async () => {
	const h = await harness();
	const entered = barrier();
	const finish = barrier();
	let authorized = false;
	const holder = h.app.database.write(
		async (db) =>
			await db.transaction(async () => {
				entered.release();
				await finish.promise;
			}),
	);
	await entered.promise;
	const importing = runArchive(
		h.app,
		{ op: "import", path: "/nonexistent-u7-archive", mode: "server", owner: "robin", ownerToken: null },
		async (db) => {
			authorized = true;
			expect(
				await db.one(sql<readonly [], { name: string }>("SELECT name FROM projects WHERE key = 'scratch'")),
			).toEqual({ name: "scratch" });
			await db.run(sql<readonly []>("UPDATE projects SET name = 'authorization transaction' WHERE key = 'scratch'"));
			throw new OpError("forbidden", "import admission changed");
		},
	);
	try {
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(authorized).toBe(false);
		finish.release();
		await holder;
		await expect(importing).rejects.toThrow("import admission changed");
		expect(authorized).toBe(true);
		expect(
			await h.app.database.read(
				async (db) =>
					await db.one(sql<readonly [], { name: string }>("SELECT name FROM projects WHERE key = 'scratch'")),
			),
		).toEqual({ name: "scratch" });
	} finally {
		finish.release();
		await holder;
		await importing.catch(() => undefined);
		await h.close();
	}
});

test("a cookie operation resolves its session in the operation scope without discarded reads", async () => {
	const h = await harness();
	const server = serve(h.app, h.owner);
	const origin = `http://127.0.0.1:${server.port}`;
	try {
		const { secret } = await createToken(h.app, {
			actor: "browser",
			kind: "human",
			can: ["read"],
			project: 0,
			label: "browser",
		});
		const opening = await signInWithToken(h.app, secret, { userAgent: null, address: null });
		if (opening.kind !== "opening") throw new Error("no session");
		const signedIn = await opening.signedIn;
		if (!signedIn) throw new Error("no cookie");
		const reads = spyOn(h.app.database, "read");
		try {
			const response = await fetch(`${origin}/api/p/scratch/find`, {
				method: "POST",
				headers: { cookie: `mainworthy_sid=${signedIn.cookie}`, origin, [API_VERSION_HEADER]: String(API_VERSION) },
				body: JSON.stringify({ in: "tests" }),
			});
			expect(await response.json()).toMatchObject({ ok: true });
			// Admission, operation snapshot, fresh authority recheck.
			expect(reads).toHaveBeenCalledTimes(3);
		} finally {
			reads.mockRestore();
		}
	} finally {
		await server.stop(true);
		await h.close();
	}
});

test("session projects replay a project recreated after the snapshot closes", async () => {
	const h = await harness();
	const entered = barrier();
	const finish = barrier();
	const read = h.app.database.read.bind(h.app.database);
	let reads = 0;
	const spy = spyOn(h.app.database, "read").mockImplementation(async (fn, options) => {
		const result = await read(fn, options);
		if (++reads === 1) {
			entered.release();
			await finish.promise;
		}
		return result;
	});
	const pending = grantedProjects(h.app, {
		via: "local",
		reference: () => ({ via: "local", owner: "robin" }),
		actor: async () => h.owner,
	});
	try {
		await entered.promise;
		await h.app.database.write((db) => db.transaction(() => removeProject(db, "scratch")));
		await h.call("admin", { do: "project.create", key: "scratch", name: "Recreated", preset: "loose" });
		finish.release();
		expect(await pending).toMatchObject([{ key: "scratch", name: "Recreated", can: expect.arrayContaining(["read"]) }]);
	} finally {
		finish.release();
		await pending;
		spy.mockRestore();
		await h.close();
	}
});

test("async session and context callbacks resolve after the write lease is admitted", async () => {
	const h = await harness();
	const entered = barrier();
	const finish = barrier();
	let released = false;
	const holder = h.app.database.write(async () => {
		entered.release();
		await finish.promise;
		released = true;
	});
	await entered.promise;
	const operation = defineInstanceOp({
		name: "session-probe",
		summary: "Resolve instance session",
		input: z.object({}),
		output: z.object({ session: z.number().nullable(), context: z.string().nullable() }),
		needs: "produce",
		scope: "instance",
		effect: "write",
		mcp: null,
		run: (ctx) => ({ session: ctx.session ?? null, context: ctx.context ?? null }),
	});
	const pending = invoke(
		h.app,
		{ probe: operation },
		{
			op: "probe",
			project: null,
			input: {},
			actor: async () => h.owner,
			session: async () => {
				expect(released).toBe(true);
				return 99;
			},
			context: async () => {
				expect(released).toBe(true);
				return "current-context";
			},
		},
	);
	try {
		finish.release();
		await holder;
		expect(await pending).toMatchObject({ ok: true, result: { session: 99, context: "current-context" } });
	} finally {
		finish.release();
		await holder;
		await pending;
		await h.close();
	}
});

for (const path of ["operation", "session"] as const) {
	test(`${path} reads stop after three project identity replays`, async () => {
		const h = await harness();
		const read = h.app.database.read.bind(h.app.database);
		let reads = 0;
		const spy = spyOn(h.app.database, "read").mockImplementation(async (fn, options) => {
			if (reads > 8) throw new Error("read retries did not stop");
			const result = await read(fn, options);
			if (++reads % 2 === 1)
				await h.app.database.write((db) =>
					db.transaction(() =>
						db.run(sql<{ identity: string }>("UPDATE projects SET identity = $identity WHERE key = 'scratch'"), {
							identity: `replacement-${reads}`,
						}),
					),
				);
			return result;
		});
		try {
			if (path === "session") {
				await expect(
					grantedProjects(h.app, {
						via: "local",
						reference: () => ({ via: "local", owner: "robin" }),
						actor: async () => h.owner,
					}),
				).rejects.toThrow("projects changed during all read attempts");
			} else {
				const op = defineOp({
					name: "probe",
					summary: "Read identity",
					input: z.object({}),
					output: z.string(),
					needs: "read",
					scope: "project",
					effect: "read",
					mcp: null,
					run: (ctx) => ctx.project.identity,
				});
				expect(
					await invoke(
						h.app,
						{ probe: op },
						{
							op: "probe",
							project: "scratch",
							input: {},
							reference: { via: "local", owner: "robin" },
							actor: async () => h.owner,
						},
					),
				).toMatchObject({ ok: false, error: { code: "conflict" } });
			}
			expect(reads).toBe(6);
		} finally {
			spy.mockRestore();
			await h.close();
		}
	});
}
