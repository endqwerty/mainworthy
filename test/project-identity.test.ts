import { expect, test } from "bun:test";
import { openApp } from "../src/server/kernel/app.ts";
import { allProjects } from "../src/server/kernel/ctx.ts";
import { OPS } from "../src/server/ops/index.ts";
import { invoke } from "../src/server/ops/registry.ts";
import { removeProject } from "../src/server/transfer/transfer.ts";
import { harness } from "./helpers.ts";

function one<T>(rows: T[]): T {
	const row = rows[0];
	if (rows.length !== 1 || row === undefined) throw new Error("expected exactly one row");
	return row;
}

test("a saved command cannot decide a replacement project, even after a fresh project-list read", async () => {
	const h = await harness({ preset: "standard" });
	try {
		const agent = await h.actor("author", "agent", ["read", "produce"]);
		const question = async () => {
			await h.call("propose", { edits: [{ op: "create", outline: "Saved case\n  Check > Pass" }] }, agent);
			return one((await h.call<{ items: { q: string; evidenceHash: string }[] }>("inbox")).items);
		};
		const oldQuestion = await question();
		const projects = async () => await h.call<{ key: string; identity: string }[]>("admin", { do: "project.list" });
		const identity = one(await projects()).identity;
		const input = {
			cmd: "saved-answer-385",
			projectIdentity: identity,
			q: oldQuestion.q,
			onEvidence: oldQuestion.evidenceHash,
			ifOpen: true,
			answer: { is: "accept" },
		};
		// Reading again cannot protect a command that is delayed past replacement.
		expect((await projects())[0]?.identity).toBe(identity);
		await h.app.database.write((db) => removeProject(db, "scratch"));
		await h.call("admin", { do: "project.create", key: "scratch", preset: "standard" });
		const replacement = await question();
		expect(replacement.q).toBe(oldQuestion.q);
		const reply = await h.raw("decide", input);
		expect(reply).toMatchObject({ ok: false, error: { code: "conflict", details: { projectIdentity: "obsolete" } } });
		expect((await h.call<{ items: { q: string }[] }>("inbox")).items.map((q) => q.q)).toEqual([replacement.q]);
		expect((await projects())[0]?.identity).not.toBe(identity);
		expect(await h.raw("decide", { ...input, projectIdentity: one(await projects()).identity })).toMatchObject({
			ok: true,
		});
	} finally {
		await h.close();
	}
});

test("the shared envelope guards project writes and command replay", async () => {
	const h = await harness();
	try {
		const project = one(await h.call<{ identity: string }[]>("admin", { do: "project.list" }));
		const input = {
			cmd: "project-write-385",
			projectIdentity: project.identity,
			edits: [{ op: "create", outline: "One case\n  Check > Pass" }],
		};
		const first = await h.raw("propose", input);
		expect(first).toMatchObject({ ok: true });
		expect(await h.raw("propose", input)).toEqual(first);
		expect(await h.raw("propose", { ...input, projectIdentity: "a-different-project" })).toMatchObject({
			ok: false,
			error: { code: "conflict", details: { projectIdentity: "obsolete" } },
		});
		expect((await h.call<{ count: number }>("find", { in: "cases" })).count).toBe(1);
		expect(
			await h.raw("propose", { ...input, cmd: "other-command-385", projectIdentity: "a-different-project" }),
		).toMatchObject({
			ok: false,
			error: { code: "conflict", details: { projectIdentity: "obsolete" } },
		});
	} finally {
		await h.close();
	}
});

test("a conditional read cannot follow a reused reference into a replacement project", async () => {
	const h = await harness();
	try {
		await h.call("propose", { edits: [{ op: "create", outline: "Original case" }] });
		const identity = one(await h.call<{ identity: string }[]>("admin", { do: "project.list" })).identity;
		const input = { refs: ["C-1"], projectIdentity: identity };
		expect(await h.raw("get", input)).toMatchObject({ ok: true });
		await h.app.database.write((db) => removeProject(db, "scratch"));
		await h.call("admin", { do: "project.create", key: "scratch" });
		await h.call("propose", { edits: [{ op: "create", outline: "Replacement case" }] });
		expect(await h.raw("get", input)).toMatchObject({
			ok: false,
			error: { code: "conflict", details: { projectIdentity: "obsolete" } },
		});
		const current = one(await h.call<{ identity: string }[]>("admin", { do: "project.list" })).identity;
		expect(await h.raw("get", { ...input, projectIdentity: current })).toMatchObject({ ok: true });
		expect((await h.call<{ title: string }[]>("get", { refs: ["C-1"] }))[0]?.title).toBe("Replacement case");
	} finally {
		await h.close();
	}
});

test("a command waiting at the write gate checks the replacement identity when it runs", async () => {
	const h = await harness();
	try {
		const identity = one(await h.call<{ identity: string }[]>("admin", { do: "project.list" })).identity;
		const release = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const blocking = h.app.database.write(() => {
			entered.resolve();
			return release.promise;
		});
		await entered.promise;
		const removed = h.app.database.write((db) => removeProject(db, "scratch"));
		const replaced = h.call("admin", { do: "project.create", key: "scratch" });
		const pending = invoke(h.app, OPS, {
			op: "propose",
			project: "scratch",
			actor: async () => h.owner,
			input: {
				cmd: "queued-command-385",
				projectIdentity: identity,
				edits: [{ op: "create", outline: "Must not appear\n  Check > Pass" }],
			},
		});
		release.resolve();
		await removed;
		await replaced;
		await blocking;
		expect(await pending).toMatchObject({
			ok: false,
			error: { code: "conflict", details: { projectIdentity: "obsolete" } },
		});
		expect((await h.call<{ count: number }>("find", { in: "cases" })).count).toBe(0);
	} finally {
		await h.close();
	}
});

test("projects have distinct identities which survive reopening the database", async () => {
	const h = await harness();
	await h.call("admin", { do: "project.create", key: "second" });
	const before = await h.app.database.read((db) => allProjects(db));
	expect(new Set(before.map((project) => project.identity)).size).toBe(2);
	const reopened = await openApp(h.app.config);
	try {
		expect(await reopened.database.read((db) => allProjects(db))).toEqual(before);
	} finally {
		await reopened.close();
		await h.close();
	}
});
