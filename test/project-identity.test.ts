import { expect, test } from "bun:test";
import { Db } from "../src/server/kernel/db.ts";
import { MIGRATIONS, migrate } from "../src/server/kernel/migrate.ts";
import { OPS } from "../src/server/ops/index.ts";
import { invokeAsync } from "../src/server/ops/registry.ts";
import { removeProject } from "../src/server/transfer/transfer.ts";
import { harness } from "./helpers.ts";

function one<T>(rows: T[]): T {
	const row = rows[0];
	if (rows.length !== 1 || row === undefined) throw new Error("expected exactly one row");
	return row;
}

test("a saved command cannot decide a replacement project, even after a fresh project-list read", () => {
	const h = harness({ preset: "standard" });
	try {
		const agent = h.actor("author", "agent", ["read", "produce"]);
		const question = () => {
			h.call("propose", { edits: [{ op: "create", outline: "Saved case\n  Check > Pass" }] }, agent);
			return one(h.call<{ items: { q: string; evidenceHash: string }[] }>("inbox").items);
		};
		const oldQuestion = question();
		const projects = () => h.call<{ key: string; identity: string }[]>("admin", { do: "project.list" });
		const identity = one(projects()).identity;
		const input = {
			cmd: "saved-answer-385",
			projectIdentity: identity,
			q: oldQuestion.q,
			onEvidence: oldQuestion.evidenceHash,
			ifOpen: true,
			answer: { is: "accept" },
		};
		// Reading again cannot protect a command that is delayed past replacement.
		expect(projects()[0]?.identity).toBe(identity);
		removeProject(h.app.db, "scratch");
		h.call("admin", { do: "project.create", key: "scratch", preset: "standard" });
		const replacement = question();
		expect(replacement.q).toBe(oldQuestion.q);
		expect(replacement.evidenceHash).toBe(oldQuestion.evidenceHash);
		const reply = h.raw("decide", input);
		expect(reply).toMatchObject({ ok: false, error: { code: "conflict", details: { projectIdentity: "obsolete" } } });
		expect(h.call<{ items: { q: string }[] }>("inbox").items.map((q) => q.q)).toEqual([replacement.q]);
		expect(projects()[0]?.identity).not.toBe(identity);
		expect(h.raw("decide", { ...input, projectIdentity: one(projects()).identity })).toMatchObject({ ok: true });
	} finally {
		h.close();
	}
});

test("the shared envelope guards project writes and command replay", () => {
	const h = harness();
	try {
		const project = one(h.call<{ identity: string }[]>("admin", { do: "project.list" }));
		const input = {
			cmd: "project-write-385",
			projectIdentity: project.identity,
			edits: [{ op: "create", outline: "One case\n  Check > Pass" }],
		};
		const first = h.raw("propose", input);
		expect(first).toMatchObject({ ok: true });
		expect(h.raw("propose", input)).toEqual(first);
		expect(h.raw("propose", { ...input, projectIdentity: "a-different-project" })).toMatchObject({
			ok: false,
			error: { code: "conflict", details: { projectIdentity: "obsolete" } },
		});
		expect(h.call<{ count: number }>("find", { in: "cases" }).count).toBe(1);
		expect(
			h.raw("propose", { ...input, cmd: "other-command-385", projectIdentity: "a-different-project" }),
		).toMatchObject({
			ok: false,
			error: { code: "conflict", details: { projectIdentity: "obsolete" } },
		});
	} finally {
		h.close();
	}
});

test("a conditional read cannot follow a reused reference into a replacement project", () => {
	const h = harness();
	try {
		h.call("propose", { edits: [{ op: "create", outline: "Original case" }] });
		const identity = one(h.call<{ identity: string }[]>("admin", { do: "project.list" })).identity;
		const input = { refs: ["C-1"], projectIdentity: identity };
		expect(h.raw("get", input)).toMatchObject({ ok: true });
		removeProject(h.app.db, "scratch");
		h.call("admin", { do: "project.create", key: "scratch" });
		h.call("propose", { edits: [{ op: "create", outline: "Replacement case" }] });
		expect(h.raw("get", input)).toMatchObject({
			ok: false,
			error: { code: "conflict", details: { projectIdentity: "obsolete" } },
		});
		const current = one(h.call<{ identity: string }[]>("admin", { do: "project.list" })).identity;
		expect(h.raw("get", { ...input, projectIdentity: current })).toMatchObject({ ok: true });
		expect(h.call<{ title: string }[]>("get", { refs: ["C-1"] })[0]?.title).toBe("Replacement case");
	} finally {
		h.close();
	}
});

test("a command waiting at the write gate checks the replacement identity when it runs", async () => {
	const h = harness();
	try {
		const identity = one(h.call<{ identity: string }[]>("admin", { do: "project.list" })).identity;
		const release = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const blocking = h.app.gate.run(() => {
			entered.resolve();
			return release.promise;
		});
		await entered.promise;
		const pending = invokeAsync(h.app, OPS, {
			op: "propose",
			project: "scratch",
			actor: () => h.owner,
			input: {
				cmd: "queued-command-385",
				projectIdentity: identity,
				edits: [{ op: "create", outline: "Must not appear\n  Check > Pass" }],
			},
		});
		removeProject(h.app.db, "scratch");
		h.call("admin", { do: "project.create", key: "scratch" });
		release.resolve();
		await blocking;
		expect(await pending).toMatchObject({
			ok: false,
			error: { code: "conflict", details: { projectIdentity: "obsolete" } },
		});
		expect(h.call<{ count: number }>("find", { in: "cases" }).count).toBe(0);
	} finally {
		h.close();
	}
});

test("upgrading existing projects assigns distinct identities and preserves them on restart", () => {
	const db = new Db(":memory:");
	try {
		for (const migration of MIGRATIONS.filter((entry) => entry.version < 35)) db.exec(migration.sql);
		db.exec(`INSERT INTO meta VALUES ('schema_version', '34');
			INSERT INTO orgs (id, name, created_at) VALUES (1, 'Example', 1);
			INSERT INTO projects (org, key, name, created_at) VALUES (1, 'first', 'First', 1), (1, 'second', 'Second', 1);`);
		migrate(db, ":memory:");
		const rows = () =>
			db.raw.query<{ key: string; identity: string }, []>("SELECT key, identity FROM projects ORDER BY key").all();
		const upgraded = rows();
		expect(upgraded.map((row) => row.key)).toEqual(["first", "second"]);
		expect(new Set(upgraded.map((row) => row.identity)).size).toBe(2);
		for (const row of upgraded) expect(row.identity).toMatch(/^[a-f0-9]{32}$/);
		migrate(db, ":memory:");
		expect(rows()).toEqual(upgraded);
	} finally {
		db.close();
	}
});
