import { afterEach, expect, test } from "bun:test";
import { actorByName } from "../src/server/identity/identity.ts";
import { findProject } from "../src/server/kernel/ctx.ts";
import { Database, sql } from "../src/server/kernel/db.ts";
import { ARCHIVE_VERSION } from "../src/server/kernel/migrate.ts";
import { OPS } from "../src/server/ops/index.ts";
import { invoke } from "../src/server/ops/registry.ts";
import { exportArchive, importArchive, linesOf, removeBootstrap } from "../src/server/transfer/transfer.ts";
import { type Harness, harness } from "./helpers.ts";
import { closeIdentityDatabases, holdWriter, identityDatabaseUrl, pgRows, withWrite } from "./identity-db.ts";

let h: Harness;
afterEach(async () => {
	await h?.close();
	await closeIdentityDatabases();
});

test("team grants add to personal grants and removal takes away only that team's contribution", async () => {
	h = await harness();
	await h.actor("sam", "human", ["read"]);
	await h.call("admin", { do: "project.create", key: "other" });
	await h.call("admin", { do: "team.create", name: "Quality" });
	await h.call("admin", { do: "team.grant.set", team: "Quality", project: "scratch", can: ["produce", "answer"] });
	await h.call("admin", { do: "team.member.add", team: "Quality", person: "sam" });
	const scratch = (await h.app.database.read(async (db) => await findProject(db, "scratch")))?.id ?? -1;
	const other = (await h.app.database.read(async (db) => await findProject(db, "other")))?.id ?? -1;
	expect((await await h.app.database.read(async (db) => await actorByName(db, "sam", scratch)))?.can).toEqual([
		"read",
		"record",
		"produce",
		"answer",
	]);
	expect((await await h.app.database.read(async (db) => await actorByName(db, "sam", other)))?.can).toEqual(["read"]);
	expect(await h.call<unknown[]>("admin", { do: "actor.list" })).toContainEqual(
		expect.objectContaining({
			name: "sam",
			teams: [{ name: "Quality", grants: [{ project: "scratch", can: ["record", "produce", "answer"] }] }],
		}),
	);
	await h.call("admin", { do: "team.member.remove", team: "Quality", person: "sam" });
	expect((await await h.app.database.read(async (db) => await actorByName(db, "sam", scratch)))?.can).toEqual(["read"]);
});

test("team changes are attributed and command retries preserve one event", async () => {
	h = await harness();
	await h.actor("sam", "human", ["read"]);
	const input = { do: "team.create", name: "Quality", cmd: "teams-create-001" };
	await h.call("admin", input);
	await h.call("admin", input);
	await h.call("admin", { do: "team.grant.set", team: "Quality", can: ["plan"] });
	await h.call("admin", { do: "team.member.add", team: "Quality", person: "sam" });
	await h.call("admin", { do: "team.member.remove", team: "Quality", person: "sam" });
	const history = await h.call<Record<string, unknown>[]>("admin", { do: "team.history", team: "Quality" });
	expect(history.map((row) => [row.action, row.by, row.person, row.project, row.can])).toEqual([
		["created", "robin", null, null, null],
		["grant.set", "robin", null, "*", ["plan"]],
		["member.add", "robin", "sam", null, null],
		["member.remove", "robin", "sam", null, null],
	]);
});

test("overlapping teams and personal grants keep their independent contributions", async () => {
	h = await harness();
	await h.actor("sam", "human", ["read"]);
	for (const name of ["Quality", "Release"]) {
		await h.call("admin", { do: "team.create", name });
		await h.call("admin", { do: "team.grant.set", team: name, can: ["produce", "plan"] });
		await h.call("admin", { do: "team.member.add", team: name, person: "sam" });
	}
	await h.call("admin", { do: "team.grant.remove", team: "Quality" });
	expect((await await h.app.database.read(async (db) => await actorByName(db, "sam", 0)))?.can).toEqual([
		"read",
		"record",
		"produce",
		"plan",
	]);
	await h.call("admin", { do: "team.member.remove", team: "Release", person: "sam" });
	expect((await await h.app.database.read(async (db) => await actorByName(db, "sam", 0)))?.can).toEqual(["read"]);
});

test("teams require a person who administers the instance and cannot change their own authority", async () => {
	h = await harness();
	const admin = await h.actor("admin", "human", ["read", "admin"]);
	const agent = await h.actor("agent", "agent", ["read", "admin"]);
	const reader = await h.actor("reader", "human", ["read"]);
	await h.actor("pipeline", "ci", ["record"]);
	await h.actor("forgotten", "human", ["read"]);
	const forgotten = await h.call<{ forgotten: string }>("admin", { do: "actor.forget", name: "forgotten" });
	await h.call("admin", { do: "team.create", name: "Quality" });
	expect(await h.raw("admin", { do: "team.create", name: "Other" }, agent)).toMatchObject({
		ok: false,
		error: { code: "forbidden" },
	});
	expect(await h.raw("admin", { do: "team.list" }, reader)).toMatchObject({ ok: false, error: { code: "forbidden" } });
	for (const person of ["agent", "pipeline", "policy", forgotten.forgotten, "robin", "missing"]) {
		expect((await h.raw("admin", { do: "team.member.add", team: "Quality", person })).ok).toBe(false);
	}
	expect((await h.raw("admin", { do: "team.member.add", team: "Quality", person: "admin" }, admin)).ok).toBe(false);
	await h.call("admin", { do: "team.member.add", team: "Quality", person: "admin" });
	for (const action of [
		{ do: "team.member.remove", person: "admin" },
		{ do: "team.grant.set", can: ["produce"] },
		{ do: "team.grant.remove" },
	])
		expect((await h.raw("admin", { ...action, team: "Quality" }, admin)).ok).toBe(false);
	expect(await h.raw("admin", { do: "team.create", name: "Quality" })).toMatchObject({
		ok: false,
		error: { code: "conflict" },
	});
	expect(
		await h.raw("admin", { do: "team.grant.set", team: "Quality", project: "missing", can: ["read"] }),
	).toMatchObject({
		ok: false,
		error: { code: "not_found" },
	});
	expect(await h.call<unknown[]>("admin", { do: "team.history", team: "Quality" })).toHaveLength(2);
});

test("forgetting a member drops membership and the team audit uses their pseudonym", async () => {
	h = await harness();
	const person = await h.actor("sam", "human", ["read"]);
	await h.call("admin", { do: "team.create", name: "Quality" });
	await h.call("admin", { do: "team.member.add", team: "Quality", person: "sam" });
	const forgotten = await h.call<{ forgotten: string }>("admin", { do: "actor.forget", name: "sam" });
	expect(await h.call<unknown[]>("admin", { do: "team.list" })).toEqual([expect.objectContaining({ members: [] })]);
	expect(await pgRows<{ actor: number }>(h.app, "SELECT actor FROM team_members WHERE actor = ?", [person.id])).toEqual(
		[],
	);
	expect(await h.call<unknown[]>("admin", { do: "team.history", team: "Quality" })).toContainEqual(
		expect.objectContaining({ person: forgotten.forgotten }),
	);
});

test("a queued write resolves current permission after team removal", async () => {
	h = await harness();
	await h.actor("sam", "human", ["read"]);
	await h.call("admin", { do: "team.create", name: "Quality" });
	await h.call("admin", { do: "team.grant.set", team: "Quality", can: ["produce"] });
	await h.call("admin", { do: "team.member.add", team: "Quality", person: "sam" });
	const actor = async (id: number) => await await h.app.database.read(async (db) => await actorByName(db, "sam", id));
	const held = holdWriter(h.app);
	const release = held.release;
	const removed = h.call("admin", { do: "team.member.remove", team: "Quality", person: "sam" });
	const write = invoke(h.app, OPS, {
		op: "propose",
		project: "scratch",
		input: { edits: [{ op: "create", outline: "Must not be written" }] },
		actor,
	});
	await release();
	await removed;
	expect(await write).toMatchObject({ ok: false, error: { code: "forbidden" } });
	expect((await h.call<{ count: number }>("find", {})).count).toBe(0);
});

test("teams, grants, members and attribution survive an archive; its version changes", async () => {
	h = await harness();
	await h.actor("sam", "human", ["read"]);
	await h.call("admin", { do: "team.create", name: "Quality" });
	await h.call("admin", { do: "team.grant.set", team: "Quality", can: ["produce"] });
	await h.call("admin", { do: "team.member.add", team: "Quality", person: "sam" });
	const chunks: string[] = [];
	await h.app.database.read(
		async (db) =>
			await exportArchive(db, (chunk) => {
				chunks.push(chunk);
			}),
	);
	const archive = chunks.join("");
	// Teams raised the archive version to 12; later migrations may raise it further.
	expect(ARCHIVE_VERSION).toBeGreaterThanOrEqual(12);
	expect(archive.split("\n")[0]).toContain(`"schema":${ARCHIVE_VERSION}`);
	const target = await Database.open({ url: await identityDatabaseUrl(crypto.randomUUID()) });
	try {
		const restored = await target.write(
			async (db) => await db.transaction(async () => await importArchive(db, linesOf(archive))),
		);
		expect(restored.tables).toMatchObject({ teams: 1, team_members: 1, team_grants: 1, team_events: 3 });
		expect((await target.read(async (db) => await actorByName(db, "sam", 0)))?.can).toEqual([
			"read",
			"record",
			"produce",
		]);
		expect(
			await target.read(
				async (db) => await db.get(sql<readonly [], Record<string, unknown>>("SELECT count(*) AS n FROM tokens")),
			),
		).toEqual({ n: 0 });
	} finally {
		await target.close();
	}
	const empty = await Database.open({ url: await identityDatabaseUrl(crypto.randomUUID()) });
	try {
		await expect(
			empty.write(
				async (db) =>
					await db.transaction(
						async () => await importArchive(db, linesOf(archive.replace(`"schema":${ARCHIVE_VERSION}`, '"schema":7'))),
					),
			),
		).rejects.toThrow(`older than this build's archive schema ${ARCHIVE_VERSION}`);
	} finally {
		await empty.close();
	}
});

test("a project archive keeps relevant team authority and history without other project grants", async () => {
	h = await harness();
	await h.actor("team-only", "human", []);
	await h.call("admin", { do: "grant.remove", actor: "team-only" });
	await h.call("admin", { do: "project.create", key: "other" });
	for (const name of ["Shared", "Unrelated"]) await h.call("admin", { do: "team.create", name });
	await h.call("admin", { do: "team.grant.set", team: "Shared", can: ["read"] });
	await h.call("admin", { do: "team.grant.set", team: "Shared", project: "scratch", can: ["produce"] });
	await h.call("admin", { do: "team.grant.set", team: "Shared", project: "other", can: ["admin"] });
	await h.call("admin", { do: "team.member.add", team: "Shared", person: "team-only" });
	await h.call("admin", { do: "team.grant.set", team: "Unrelated", project: "other", can: ["produce"] });
	const chunks: string[] = [];
	await h.app.database.read(
		async (db) =>
			await exportArchive(
				db,
				(chunk) => {
					chunks.push(chunk);
				},
				{ project: "scratch" },
			),
	);
	const target = await Database.open({ url: await identityDatabaseUrl(crypto.randomUUID()) });
	try {
		await target.write(
			async (db) => await db.transaction(async () => await importArchive(db, linesOf(chunks.join("")))),
		);
		const project = await target.read(async (db) => await findProject(db, "scratch"));
		if (!project) throw new Error("no restored project");
		expect((await target.read(async (db) => await actorByName(db, "team-only", project.id)))?.can).toEqual([
			"read",
			"record",
			"produce",
		]);
		expect(
			await target.read(
				async (db) => await db.all(sql<readonly [], Record<string, unknown>>("SELECT name FROM teams ORDER BY name")),
			),
		).toEqual([{ name: "Shared" }]);
		expect(
			await target.read(
				async (db) =>
					await db.all(
						sql<readonly [], Record<string, unknown>>("SELECT project, can FROM team_grants ORDER BY project"),
					),
			),
		).toEqual([
			{ project: 0, can: '["read"]' },
			{ project: project.id, can: '["produce"]' },
		]);
		expect(
			await target.read(
				async (db) =>
					await db.all(sql<readonly [], Record<string, unknown>>("SELECT action FROM team_events ORDER BY id")),
			),
		).toEqual([{ action: "created" }, { action: "grant.set" }, { action: "grant.set" }, { action: "member.add" }]);
		await target.write(
			async (db) =>
				await db.transaction(async () => {
					await db.exec("SET CONSTRAINTS ALL IMMEDIATE");
				}),
		);
	} finally {
		await target.close();
	}
});

test("an unrecorded team still prevents bootstrap replacement during import", async () => {
	h = await harness();
	await h.call("admin", { do: "team.create", name: "Quality" });
	await expect(withWrite(h.app, async (db) => await removeBootstrap(db))).rejects.toThrow(
		"import needs a fresh instance",
	);
});

test("team grants reject roles without changing the team's permissions", async () => {
	h = await harness();
	await h.call("admin", { do: "team.create", name: "Reviewers" });
	await h.call("admin", { do: "team.grant.set", team: "Reviewers", can: ["read"] });
	expect(
		await h.raw("admin", { do: "team.grant.set", team: "Reviewers", can: ["answer"], roles: ["approver"] }),
	).toMatchObject({ ok: false, error: { code: "invalid" } });
	expect(await h.call<unknown[]>("admin", { do: "team.list" })).toMatchObject([
		{ name: "Reviewers", members: [], grants: [{ project: "*", can: ["read"] }] },
	]);
});
