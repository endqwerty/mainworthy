import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { bootstrap } from "../src/server/identity/identity.ts";
import { defaultConfig, openApp } from "../src/server/kernel/app.ts";
import { findProject } from "../src/server/kernel/ctx.ts";
import { sql } from "../src/server/kernel/db.ts";
import { OpError } from "../src/server/kernel/errors.ts";
import { OPS } from "../src/server/ops/index.ts";
import { COMMIT, defineInstanceOp, defineOp, invoke } from "../src/server/ops/registry.ts";
import { testDatabase } from "./db.ts";
import { harness } from "./helpers.ts";

test("invoke waits for project and instance handlers before returning or recording their replies", async () => {
	const h = await harness();
	try {
		for (const scope of ["project", "instance"] as const) {
			const op = {
				name: "probe",
				summary: "Probe awaited replies",
				input: z.object({ cmd: z.string() }),
				output: z.string(),
				needs: "read" as const,
				mcp: null,
				effect: "write" as const,
				async run() {
					await Promise.resolve();
					return "finished";
				},
			};
			const ops = { probe: scope === "project" ? defineOp({ ...op, scope }) : defineInstanceOp({ ...op, scope }) };
			const call = {
				op: "probe",
				project: scope === "project" ? "scratch" : null,
				input: { cmd: `async-${scope}` },
				actor: async () => h.owner,
			};
			expect(await invoke(h.app, ops, call)).toMatchObject({ ok: true, result: "finished" });
			expect(await invoke(h.app, ops, call)).toMatchObject({ ok: true, result: "finished" });
		}
	} finally {
		await h.close();
	}
});

test("invoke waits for a rejected handler and rolls its writes back", async () => {
	const h = await harness();
	try {
		const propose = OPS.propose;
		if (propose?.scope !== "project" || !("steps" in propose)) throw new Error("propose must have steps");
		const { steps, ...base } = propose;
		const op = {
			...base,
			async run(ctx: Parameters<typeof steps>[0], input: Parameters<typeof steps>[1]) {
				const running = steps(ctx, input);
				while (!(await running.next()).done) {}
				throw new OpError("conflict", "probe refused");
			},
		};
		const reply = await invoke(
			h.app,
			{ propose: op },
			{
				op: "propose",
				project: "scratch",
				input: { edits: [{ op: "create", body: { title: "Rolled back" } }] },
				actor: async () => h.owner,
			},
		);
		expect(reply).toEqual({ ok: false, error: { code: "conflict", message: "probe refused" } });
		expect(await h.call("find", { in: "cases" })).toMatchObject({ items: [] });
	} finally {
		await h.close();
	}
});

test("invoke awaits async steps and keeps other writers behind the whole operation", async () => {
	const h = await harness();
	const accepted = Promise.withResolvers<void>();
	const resume = Promise.withResolvers<void>();
	const events: number[] = [];
	const unsubscribe = h.app.subscribe((event) => events.push(event.seq));
	const op = defineOp({
		name: "probe",
		summary: "Probe async steps",
		input: z.object({ cmd: z.string() }),
		output: z.string(),
		needs: "read",
		mcp: null,
		scope: "project",
		effect: "write",
		async *steps() {
			yield COMMIT;
			accepted.resolve();
			await resume.promise;
			yield;
			return "finished";
		},
	});
	const call = { op: "probe", project: "scratch", input: { cmd: "async-steps" }, actor: async () => h.owner };
	const pending = invoke(h.app, { probe: op }, call);
	let next: Promise<unknown> | undefined;
	try {
		await accepted.promise;
		expect(events).toEqual([2]);
		expect(await h.call<{ state: string; op: string }>("command", { cmd: "async-steps" })).toEqual({
			state: "begun",
			op: "probe",
		});
		next = h.call("propose", { edits: [{ op: "create", body: { title: "Next writer" } }] });
		await Promise.resolve();
		expect(events).toEqual([2]);
		resume.resolve();
		expect(await pending).toEqual({ ok: true, result: "finished", seq: 3 });
		await next;
		expect(events).toEqual([2, 3, 4]);
		expect(await invoke(h.app, { probe: op }, call)).toEqual({ ok: true, result: "finished", seq: 3 });
		expect(events).toEqual([2, 3, 4]);
	} finally {
		resume.resolve();
		await pending;
		await next;
		unsubscribe();
		await h.close();
	}
});

test("an awaited read keeps its snapshot while another connection commits", async () => {
	const dir = mkdtempSync(join(tmpdir(), "mainworthy-async-read-"));
	const app = await openApp({
		...defaultConfig({ MAINWORTHY_DATABASE_URL: (await testDatabase()).url }),
		dataDir: dir,
		mode: "local",
		owner: "robin",
	});
	const { owner } = await bootstrap(app);
	const started = Promise.withResolvers<void>();
	const resume = Promise.withResolvers<void>();
	let pending: ReturnType<typeof invoke> | undefined;
	try {
		expect(
			await invoke(app, OPS, {
				op: "admin",
				project: null,
				input: { do: "project.create", key: "scratch" },
				actor: async () => owner,
			}),
		).toMatchObject({ ok: true });
		const op = defineOp({
			name: "probe",
			summary: "Probe a read snapshot",
			scope: "project",
			effect: "read",
			input: z.object({}),
			output: z.array(z.number()),
			needs: "read",
			mcp: null,
			async run(ctx) {
				const before = (await findProject(ctx.db, "scratch"))?.seq;
				started.resolve();
				await resume.promise;
				return [before ?? -1, (await findProject(ctx.db, "scratch"))?.seq ?? -1];
			},
		});
		pending = invoke(app, { probe: op }, { op: "probe", project: "scratch", input: {}, actor: async () => owner });
		await started.promise;
		expect(
			await invoke(app, OPS, {
				op: "propose",
				project: "scratch",
				input: { edits: [{ op: "create", body: { title: "Committed during read" } }] },
				actor: async () => owner,
			}),
		).toMatchObject({ ok: true });
		resume.resolve();
		expect(await pending).toEqual({ ok: true, result: [1, 1], seq: 1 });
		expect((await app.database.read(async (readDb) => await findProject(readDb, "scratch")))?.seq).toBe(2);
	} finally {
		resume.resolve();
		await pending;
		await app.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a read and write can start together without sharing an unfinished snapshot", async () => {
	const h = await harness();
	try {
		const replies = await Promise.all([
			h.raw("find", { in: "cases" }),
			h.raw("propose", { edits: [{ op: "create", body: { title: "Concurrent write" } }] }),
		]);
		expect(replies.map((reply) => reply.ok)).toEqual([true, true]);
		expect(await h.call("find", { in: "cases" })).toMatchObject({ count: 1 });
	} finally {
		await h.close();
	}
});

test("a read SQL error is an internal reply and its connection remains usable", async () => {
	const h = await harness();
	const op = defineOp({
		name: "broken",
		summary: "Read failure",
		input: z.object({}),
		output: z.number(),
		needs: "read",
		scope: "project",
		effect: "read",
		mcp: null,
		async run(ctx) {
			return (await ctx.db.one(sql<readonly [], { n: number }>("SELECT 1 / 0 AS n"))).n;
		},
	});
	try {
		expect(
			await invoke(h.app, { broken: op }, { op: "broken", project: "scratch", input: {}, actor: async () => h.owner }),
		).toMatchObject({ ok: false, error: { code: "internal" } });
		expect(await h.call("find", { in: "cases" })).toMatchObject({ items: [] });
	} finally {
		await h.close();
	}
});

test("admin token creation joins the operation's write lease", async () => {
	const h = await harness();
	try {
		const reply = await h.call<{ actor: string; token: string }>("admin", {
			do: "token.create",
			actor: "worker",
			kind: "agent",
			can: ["read"],
			label: "scope probe",
			cmd: "scope-token-create",
		});
		expect(reply.actor).toBe("worker");
		expect(reply.token.length).toBeGreaterThan(20);
	} finally {
		await h.close();
	}
});
