// A demo project takes the time of a write from its caller, and no other project does (decision 0100).
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Instance, start } from "../src/app/start.ts";
import type { Envelope } from "../src/core/api.ts";
import { AT_HEADER } from "../src/core/version.ts";
import { actorByName } from "../src/server/identity/identity.ts";
import { SESSION_LIFETIMES } from "../src/server/kernel/app.ts";
import { findProject, makeCtx, stampSeq } from "../src/server/kernel/ctx.ts";
import { OPS } from "../src/server/ops/index.ts";
import { recoverAccepted } from "../src/server/ops/jobs.ts";
import { invoke, type Reply } from "../src/server/ops/registry.ts";
import { acceptReport } from "../src/server/ops/writes.ts";
import { exportArchive, importArchive, linesOf, removeBootstrap } from "../src/server/transfer/transfer.ts";
import { type TestDatabase, testDatabase } from "./db.ts";
import { type Harness, harness } from "./helpers.ts";

const httpDatabases: TestDatabase[] = [];
afterAll(async () => {
	for (const db of httpDatabases.splice(0)) await db.close();
});

const DAY = 86_400_000;

let h: Harness;
afterEach(() => h?.close());

/** One call as a surface makes it, with the time the caller gives. */
const at = async (
	time: number | undefined,
	op: string,
	input: unknown,
	project: string | null = "demo",
): Promise<Reply> =>
	await invoke(h.app, OPS, {
		op,
		project,
		input,
		actor: async () => h.owner,
		...(time === undefined ? {} : { at: time }),
	});
const rows = <T>(query: string): Promise<T[]> => h.app.database.read((db) => db.allDynamic<T>(query));
const newCase = (title: string, cmd?: string) => ({
	edits: [{ op: "create", body: { title } }],
	...(cmd ? { cmd } : {}),
});

async function demo(): Promise<number> {
	h = await harness();
	await h.call("admin", { do: "project.create", key: "demo" });
	return (await h.call<{ since: number }>("admin", { do: "project.demo", key: "demo" })).since;
}

describe("which project is a demo", () => {
	test("a project nothing was written to becomes a demo, and keeps the moment it became one", async () => {
		const since = await demo();
		expect(since).toBe(h.app.now());
		h.advance(DAY);
		expect((await at(undefined, "propose", newCase("One"))).ok).toBe(true);
		// Asked again, after a day and a write, it answers with the first moment: a seed sent again counts its
		// days back from where the first one did.
		expect(await h.call<unknown>("admin", { do: "project.demo", key: "demo" })).toEqual({ key: "demo", since });
		// The list of projects says which one it is, so nobody takes a demo's dates for the server's.
		const listed = await h.call<{ key: string; demo: boolean }[]>("admin", { do: "project.list" });
		expect(listed.map((row) => [row.key, row.demo])).toEqual([
			["scratch", false],
			["demo", true],
		]);
	});

	test("a project that holds work is refused, and so is a project that does not exist", async () => {
		h = await harness();
		await h.call("propose", newCase("Real work"));
		expect(await h.raw("admin", { do: "project.demo", key: "scratch" })).toMatchObject({
			ok: false,
			error: { code: "conflict", message: expect.stringContaining("scratch holds work") },
		});
		expect(await h.raw("admin", { do: "project.demo", key: "nowhere" })).toMatchObject({
			ok: false,
			error: { code: "not_found" },
		});
		expect(await rows("SELECT * FROM demo_projects")).toEqual([]);
	});

	test("only a caller who administers the instance makes one", async () => {
		h = await harness();
		await h.call("admin", { do: "project.create", key: "demo" });
		const member = await h.actor("mira", "human", ["read", "produce", "answer", "plan"]);
		expect(await h.raw("admin", { do: "project.demo", key: "demo" }, member)).toMatchObject({
			ok: false,
			error: { code: "forbidden" },
		});
	});
});

describe("when a write happened", () => {
	test("a write to a demo is recorded at the time its caller gives", async () => {
		const since = await demo();
		const then = since - 10 * DAY;
		const made = await at(then, "propose", newCase("Ten days ago", "demo-time-case-1"));
		expect(made.ok).toBe(true);
		expect(await rows<{ at: number }>("SELECT at FROM versions")).toEqual([{ at: then }]);
		expect(await rows<{ at: number }>("SELECT at FROM commands WHERE id = 'demo-time-case-1'")).toEqual([{ at: then }]);
		// A report, which commits twice, carries the time through both transactions.
		const reported = await at(then + DAY, "report", {
			target: { commit: "aaaaaaa1", branch: "main" },
			results: [{ test: { key: "t1" }, outcome: "fail", failure: { message: "boom" } }],
		});
		expect(reported.ok).toBe(true);
		expect(await rows<{ at: number }>("SELECT at FROM batches")).toEqual([{ at: then + DAY }]);
		expect(await rows<{ at: number }>("SELECT at FROM results")).toEqual([{ at: then + DAY }]);
		expect(await rows<{ opened_at: number }>("SELECT opened_at FROM questions WHERE kind = 'failure'")).toEqual([
			{ opened_at: then + DAY },
		]);
	});

	test("a write with no time takes the server's clock, on a demo as anywhere", async () => {
		await demo();
		h.advance(5_000);
		expect((await at(undefined, "propose", newCase("Now"))).ok).toBe(true);
		expect(await rows<{ at: number }>("SELECT at FROM versions")).toEqual([{ at: h.app.now() }]);
	});

	test("a project that is no demo refuses a time and writes nothing", async () => {
		await demo();
		const refused = await at(h.app.now() - DAY, "propose", newCase("Backdated"), "scratch");
		expect(refused).toMatchObject({
			ok: false,
			error: { code: "invalid", message: expect.stringContaining("scratch is not a demo project") },
		});
		expect(await rows("SELECT id FROM cases")).toEqual([]);
	});

	test("a time in the future, a time that is no number, a read and an instance operation are refused", async () => {
		await demo();
		expect(await at(h.app.now() + 60_000, "propose", newCase("Tomorrow"))).toMatchObject({
			ok: false,
			error: { code: "invalid", message: "the time is in the future" },
		});
		for (const bad of [1.5, -1, Number.NaN, Number.MAX_SAFE_INTEGER + 2])
			expect(await at(bad, "propose", newCase("Bad"))).toMatchObject({ ok: false, error: { code: "invalid" } });
		expect(await at(0, "find", { in: "cases" })).toMatchObject({
			ok: false,
			error: { code: "invalid", message: expect.stringContaining("find takes no time") },
		});
		expect(await at(0, "admin", { do: "project.list" }, null)).toMatchObject({
			ok: false,
			error: { code: "invalid", message: expect.stringContaining("admin takes no time") },
		});
		expect(await rows("SELECT id FROM cases")).toEqual([]);
	});

	test("a command id names the time too: the same request at another time is refused, at the same time it is a retry", async () => {
		const since = await demo();
		const then = since - 3 * DAY;
		const first = await at(then, "propose", newCase("Once", "demo-time-retry-1"));
		expect(first.ok).toBe(true);
		expect(await at(then, "propose", newCase("Once", "demo-time-retry-1"))).toEqual(first);
		for (const other of [then + 1, undefined])
			expect(await at(other, "propose", newCase("Once", "demo-time-retry-1"))).toMatchObject({
				ok: false,
				error: { code: "conflict" },
			});
		expect(await rows("SELECT id FROM cases")).toHaveLength(1);
	});

	test("a report accepted before a restart is applied with the time it was accepted at", async () => {
		const since = await demo();
		const then = since - 4 * DAY;
		const project = await h.app.database.read((db) => findProject(db, "demo"));
		if (!project) throw new Error("no project");
		await h.app.database.write((db) =>
			db.transaction(async () => {
				const ctx = makeCtx(h.app, db, project, h.owner, true, then);
				await acceptReport(ctx, {
					target: { commit: "bbbbbbb2", branch: "main" },
					results: [{ test: { key: "t1" }, outcome: "pass" }],
				});
				await stampSeq(ctx);
			}),
		);
		expect(await recoverAccepted(h.app)).toBe(1);
		expect(await rows<{ at: number }>("SELECT at FROM results")).toEqual([{ at: then }]);
	});
});

describe("a demo and an archive", () => {
	test("an archive does not say which project was a demo, and an imported project takes the server's clock", async () => {
		// The archive is of an instance whose first project is real work.
		h = await harness();
		await h.call("propose", newCase("Real work"));
		const chunks: string[] = [];
		await h.app.database.read((db) => exportArchive(db, (chunk) => chunks.push(chunk)));
		const archive = chunks.join("");
		expect(archive).not.toContain("demo_projects");
		await h.close();

		// It goes into a fresh instance whose untouched first project was made a demo: the same id, another project.
		h = await harness();
		await h.call("admin", { do: "project.demo", key: "scratch" });
		expect(await rows<{ project: number }>("SELECT project FROM demo_projects")).toEqual([{ project: 1 }]);
		await h.app.database.write((db) =>
			db.transaction(async () => {
				await removeBootstrap(db);
				await importArchive(db, linesOf(archive));
			}),
		);
		expect(await rows<{ id: number }>("SELECT id FROM projects")).toEqual([{ id: 1 }]);
		expect(await rows("SELECT project FROM demo_projects")).toEqual([]);
		const owner = await h.app.database.read((db) => actorByName(db, "robin", 0));
		if (!owner) throw new Error("the archive holds no owner");
		const refused = await invoke(h.app, OPS, {
			op: "propose",
			project: "scratch",
			input: newCase("Backdated after import"),
			actor: async () => owner,
			at: h.app.now() - DAY,
		});
		expect(refused).toMatchObject({
			ok: false,
			error: { code: "invalid", message: expect.stringContaining("scratch is not a demo project") },
		});
	});
});

describe("the time over HTTP", () => {
	const dirs: string[] = [];
	const running: Instance[] = [];
	afterEach(async () => {
		for (const instance of running.splice(0)) await instance.stop();
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	test("the header carries the time to a demo's write, and one that is not a number is refused", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "mainworthy-demo-time-"));
		dirs.push(dataDir);
		const database = await testDatabase();
		httpDatabases.push(database);
		const instance = await start(
			{
				databaseUrl: database.url,
				dataDir,
				host: "127.0.0.1",
				port: 0,
				mode: "local",
				owner: "robin",
				ownerToken: null,
				commit: null,
				...SESSION_LIFETIMES,
				proxy: null,
			},
			() => ({ ui: null }),
		);
		running.push(instance);
		const post = async <T>(path: string, body: unknown, headers: Record<string, string> = {}) => {
			const response = await fetch(`${instance.url}${path}`, {
				method: "POST",
				headers: { "content-type": "application/json", ...headers },
				body: JSON.stringify(body),
			});
			return { status: response.status, body: (await response.json()) as Envelope<T> };
		};
		await post("/api/admin", { do: "project.create", key: "demo" });
		const marked = await post<{ since: number }>("/api/admin", { do: "project.demo", key: "demo" });
		if (!marked.body.ok) throw new Error("the project was not made a demo");
		const then = marked.body.result.since - 2 * DAY;

		const made = await post("/api/p/demo/propose", newCase("Two days ago"), { [AT_HEADER]: String(then) });
		expect(made.status).toBe(200);
		const timeline = await post<{ entries: { at: number }[] }>("/api/p/demo/timeline", { ref: "C-1" });
		if (!timeline.body.ok) throw new Error("no timeline");
		expect(timeline.body.result.entries.map((entry) => entry.at)).toEqual([then]);

		for (const bad of ["yesterday", "1.5", "-5", ""]) {
			const refused = await post("/api/p/demo/propose", newCase("Bad"), { [AT_HEADER]: bad });
			expect([bad, refused.status, refused.body.ok]).toEqual([bad, 400, false]);
		}
		// A read sent with the header is refused too, on the thread that would have handed it to a reader.
		const read = await post("/api/p/demo/find", { in: "cases" }, { [AT_HEADER]: String(then) });
		expect(read.status).toBe(400);
		const scratch = await post("/api/p/scratch/propose", newCase("Real"), { [AT_HEADER]: String(then) });
		expect(scratch.status).toBe(400);
	});
});
