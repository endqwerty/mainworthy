import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { bootstrap } from "../src/server/identity/identity.ts";
import { defaultConfig, openApp } from "../src/server/kernel/app.ts";
import { findProject } from "../src/server/kernel/ctx.ts";
import { OpError } from "../src/server/kernel/errors.ts";
import { OPS } from "../src/server/ops/index.ts";
import { COMMIT, defineInstanceOp, defineOp, invoke } from "../src/server/ops/registry.ts";
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
				actor: () => h.owner,
			};
			expect(await invoke(h.app, ops, call)).toMatchObject({ ok: true, result: "finished" });
			expect(await invoke(h.app, ops, call)).toMatchObject({ ok: true, result: "finished" });
		}
	} finally {
		h.close();
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
		h.close();
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
	const call = { op: "probe", project: "scratch", input: { cmd: "async-steps" }, actor: () => h.owner };
	const pending = await invoke(h.app, { probe: op }, call);
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
		h.close();
	}
});

test("an awaited read keeps its snapshot while another connection commits", async () => {
	const dir = mkdtempSync(join(tmpdir(), "mainworthy-async-read-"));
	const app = await openApp({ ...defaultConfig({}), dataDir: dir, mode: "local", owner: "robin" });
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
				return [before ?? -1, findProject(ctx.db, "scratch")?.seq ?? -1];
			},
		});
		pending = await invoke(
			app,
			{ probe: op },
			{ op: "probe", project: "scratch", input: {}, actor: async () => owner },
		);
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
		expect((await findProject(app.reader, "scratch"))?.seq).toBe(2);
	} finally {
		resume.resolve();
		await pending;
		app.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an in-memory read and write can start together without sharing an unfinished snapshot", async () => {
	const h = await harness();
	try {
		const replies = await Promise.all([
			h.raw("find", { in: "cases" }),
			h.raw("propose", { edits: [{ op: "create", body: { title: "Concurrent write" } }] }),
		]);
		expect(replies.map((reply) => reply.ok)).toEqual([true, true]);
		expect(await h.call("find", { in: "cases" })).toMatchObject({ count: 1 });
	} finally {
		h.close();
	}
});
