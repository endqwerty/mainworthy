import { afterEach, expect, test } from "bun:test";
import { actorByName } from "../src/server/identity/identity.ts";
import { findProject } from "../src/server/kernel/ctx.ts";
import { Db } from "../src/server/kernel/db.ts";
import { ARCHIVE_VERSION, migrate } from "../src/server/kernel/migrate.ts";
import { OPS } from "../src/server/ops/index.ts";
import { invoke } from "../src/server/ops/registry.ts";
import { exportArchive, importArchive, linesOf, removeBootstrap } from "../src/server/transfer/transfer.ts";
import { type Harness, harness } from "./helpers.ts";

let h: Harness;
afterEach(() => h?.close());

test("team grants add to personal grants and removal takes away only that team's contribution", async () => {
	h = await harness();
	h.actor("sam", "human", ["read"]);
	await h.call("admin", { do: "project.create", key: "other" });
	await h.call("admin", { do: "team.create", name: "Quality" });
	await h.call("admin", { do: "team.grant.set", team: "Quality", project: "scratch", can: ["produce", "answer"] });
	await h.call("admin", { do: "team.member.add", team: "Quality", person: "sam" });
	const scratch = findProject(h.app.reader, "scratch")?.id ?? -1;
	const other = findProject(h.app.reader, "other")?.id ?? -1;
	expect((await actorByName(h.app.reader, "sam", scratch))?.can).toEqual(["read", "record", "produce", "answer"]);
	expect((await actorByName(h.app.reader, "sam", other))?.can).toEqual(["read"]);
	expect(await h.call<unknown[]>("admin", { do: "actor.list" })).toContainEqual(
		expect.objectContaining({
			name: "sam",
			teams: [{ name: "Quality", grants: [{ project: "scratch", can: ["record", "produce", "answer"] }] }],
		}),
	);
	await h.call("admin", { do: "team.member.remove", team: "Quality", person: "sam" });
	expect((await actorByName(h.app.reader, "sam", scratch))?.can).toEqual(["read"]);
});

test("team changes are attributed and command retries preserve one event", async () => {
	h = await harness();
	h.actor("sam", "human", ["read"]);
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
	h.actor("sam", "human", ["read"]);
	for (const name of ["Quality", "Release"]) {
		await h.call("admin", { do: "team.create", name });
		await h.call("admin", { do: "team.grant.set", team: name, can: ["produce", "plan"] });
		await h.call("admin", { do: "team.member.add", team: name, person: "sam" });
	}
	await h.call("admin", { do: "team.grant.remove", team: "Quality" });
	expect((await actorByName(h.app.reader, "sam", 0))?.can).toEqual(["read", "record", "produce", "plan"]);
	await h.call("admin", { do: "team.member.remove", team: "Release", person: "sam" });
	expect((await actorByName(h.app.reader, "sam", 0))?.can).toEqual(["read"]);
});

test("teams require a person who administers the instance and cannot change their own authority", async () => {
	h = await harness();
	const admin = h.actor("admin", "human", ["read", "admin"]);
	const agent = h.actor("agent", "agent", ["read", "admin"]);
	const reader = h.actor("reader", "human", ["read"]);
	h.actor("pipeline", "ci", ["record"]);
	h.actor("forgotten", "human", ["read"]);
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
	const person = h.actor("sam", "human", ["read"]);
	await h.call("admin", { do: "team.create", name: "Quality" });
	await h.call("admin", { do: "team.member.add", team: "Quality", person: "sam" });
	const forgotten = await h.call<{ forgotten: string }>("admin", { do: "actor.forget", name: "sam" });
	expect(await h.call<unknown[]>("admin", { do: "team.list" })).toEqual([expect.objectContaining({ members: [] })]);
	expect(
		h.app.db.raw.query<{ actor: number }, [number]>("SELECT actor FROM team_members WHERE actor = ?").all(person.id),
	).toEqual([]);
	expect(await h.call<unknown[]>("admin", { do: "team.history", team: "Quality" })).toContainEqual(
		expect.objectContaining({ person: forgotten.forgotten }),
	);
});

test("a queued write resolves current permission after team removal", async () => {
	h = await harness();
	h.actor("sam", "human", ["read"]);
	await h.call("admin", { do: "team.create", name: "Quality" });
	await h.call("admin", { do: "team.grant.set", team: "Quality", can: ["produce"] });
	await h.call("admin", { do: "team.member.add", team: "Quality", person: "sam" });
	const actor = async (id: number) => await actorByName(h.app.reader, "sam", id);
	let release = () => {};
	const blocker = h.app.gate.run(
		() =>
			new Promise<void>((resolve) => {
				release = resolve;
			}),
	);
	await Promise.resolve();
	const removed = h.call("admin", { do: "team.member.remove", team: "Quality", person: "sam" });
	const write = await invoke(h.app, OPS, {
		op: "propose",
		project: "scratch",
		input: { edits: [{ op: "create", outline: "Must not be written" }] },
		actor,
	});
	release();
	await removed;
	await blocker;
	expect(await write).toMatchObject({ ok: false, error: { code: "forbidden" } });
	expect((await h.call<{ count: number }>("find", {})).count).toBe(0);
});

test("teams, grants, members and attribution survive an archive; its version changes", async () => {
	h = await harness();
	h.actor("sam", "human", ["read"]);
	await h.call("admin", { do: "team.create", name: "Quality" });
	await h.call("admin", { do: "team.grant.set", team: "Quality", can: ["produce"] });
	await h.call("admin", { do: "team.member.add", team: "Quality", person: "sam" });
	const chunks: string[] = [];
	exportArchive(h.app.db, (chunk) => chunks.push(chunk));
	const archive = chunks.join("");
	// Teams raised the archive version to 12; later migrations may raise it further.
	expect(ARCHIVE_VERSION).toBeGreaterThanOrEqual(12);
	expect(archive.split("\n")[0]).toContain(`"schema":${ARCHIVE_VERSION}`);
	const target = new Db(":memory:");
	try {
		await migrate(target, ":memory:");
		const restored = await importArchive(target, linesOf(archive));
		expect(restored.tables).toMatchObject({ teams: 1, team_members: 1, team_grants: 1, team_events: 3 });
		expect((await actorByName(target, "sam", 0))?.can).toEqual(["read", "record", "produce"]);
		expect(target.raw.query("SELECT count(*) AS n FROM tokens").get()).toEqual({ n: 0 });
	} finally {
		target.close();
	}
	const empty = new Db(":memory:");
	try {
		await migrate(empty, ":memory:");
		expect(() => importArchive(empty, linesOf(archive.replace(`"schema":${ARCHIVE_VERSION}`, '"schema":7')))).toThrow(
			`older than this build's archive schema ${ARCHIVE_VERSION}`,
		);
	} finally {
		empty.close();
	}
});

test("a project archive keeps relevant team authority and history without other project grants", async () => {
	h = await harness();
	h.actor("team-only", "human", []);
	await h.call("admin", { do: "grant.remove", actor: "team-only" });
	await h.call("admin", { do: "project.create", key: "other" });
	for (const name of ["Shared", "Unrelated"]) await h.call("admin", { do: "team.create", name });
	await h.call("admin", { do: "team.grant.set", team: "Shared", can: ["read"] });
	await h.call("admin", { do: "team.grant.set", team: "Shared", project: "scratch", can: ["produce"] });
	await h.call("admin", { do: "team.grant.set", team: "Shared", project: "other", can: ["admin"] });
	await h.call("admin", { do: "team.member.add", team: "Shared", person: "team-only" });
	await h.call("admin", { do: "team.grant.set", team: "Unrelated", project: "other", can: ["produce"] });
	const chunks: string[] = [];
	exportArchive(h.app.db, (chunk) => chunks.push(chunk), { project: "scratch" });
	const target = new Db(":memory:");
	try {
		await migrate(target, ":memory:");
		await importArchive(target, linesOf(chunks.join("")));
		const project = await findProject(target, "scratch");
		if (!project) throw new Error("no restored project");
		expect((await actorByName(target, "team-only", project.id))?.can).toEqual(["read", "record", "produce"]);
		expect(target.raw.query("SELECT name FROM teams ORDER BY name").all()).toEqual([{ name: "Shared" }]);
		expect(target.raw.query("SELECT project, can FROM team_grants ORDER BY project").all()).toEqual([
			{ project: 0, can: '["read"]' },
			{ project: project.id, can: '["produce"]' },
		]);
		expect(target.raw.query("SELECT action FROM team_events ORDER BY id").all()).toEqual([
			{ action: "created" },
			{ action: "grant.set" },
			{ action: "grant.set" },
			{ action: "member.add" },
		]);
		expect(target.raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
	} finally {
		target.close();
	}
});

test("an unrecorded team still prevents bootstrap replacement during import", async () => {
	h = await harness();
	await h.call("admin", { do: "team.create", name: "Quality" });
	expect(() => removeBootstrap(h.app.db)).toThrow("import needs a fresh instance");
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
