// A demo project takes the time of a write from its caller, and no other project does (decision 0020).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Envelope } from "../src/core/api.ts";
import { actorByName } from "../src/server/identity/identity.ts";
import { recoverAccepted } from "../src/server/jobs.ts";
import { SESSION_LIFETIMES } from "../src/server/kernel/app.ts";
import { findProject, makeCtx, stampSeq } from "../src/server/kernel/ctx.ts";
import { OPS } from "../src/server/ops/index.ts";
import { invoke, type Reply } from "../src/server/ops/registry.ts";
import { acceptReport } from "../src/server/ops/writes.ts";
import { type Instance, start } from "../src/server/start.ts";
import { exportArchive, importArchive, linesOf, removeBootstrap } from "../src/server/transfer/transfer.ts";
import { AT_HEADER } from "../src/surfaces/http.ts";
import { type Harness, harness } from "./helpers.ts";

const DAY = 86_400_000;

let h: Harness;
afterEach(() => h?.close());

/** One call as a surface makes it, with the time the caller gives. */
const at = (time: number | undefined, op: string, input: unknown, project: string | null = "demo"): Reply =>
	invoke(h.app, OPS, { op, project, input, actor: () => h.owner, ...(time === undefined ? {} : { at: time }) });
const rows = <T>(query: string): T[] => h.app.db.raw.query<T, []>(query).all();
const newCase = (title: string, cmd?: string) => ({
	edits: [{ op: "create", body: { title } }],
	...(cmd ? { cmd } : {}),
});

function demo(): number {
	h = harness();
	h.call("admin", { do: "project.create", key: "demo" });
	return h.call<{ since: number }>("admin", { do: "project.demo", key: "demo" }).since;
}

describe("which project is a demo", () => {
	test("a project nothing was written to becomes a demo, and keeps the moment it became one", () => {
		const since = demo();
		expect(since).toBe(h.app.now());
		h.advance(DAY);
		expect(at(undefined, "propose", newCase("One")).ok).toBe(true);
		// Asked again, after a day and a write, it answers with the first moment: a seed sent again counts its
		// days back from where the first one did.
		expect(h.call<unknown>("admin", { do: "project.demo", key: "demo" })).toEqual({ key: "demo", since });
		// The list of projects says which one it is, so nobody takes a demo's dates for the server's.
		const listed = h.call<{ key: string; demo: boolean }[]>("admin", { do: "project.list" });
		expect(listed.map((row) => [row.key, row.demo])).toEqual([
			["scratch", false],
			["demo", true],
		]);
	});

	test("a project that holds work is refused, and so is a project that does not exist", () => {
		h = harness();
		h.call("propose", newCase("Real work"));
		expect(h.raw("admin", { do: "project.demo", key: "scratch" })).toMatchObject({
			ok: false,
			error: { code: "conflict", message: expect.stringContaining("scratch holds work") },
		});
		expect(h.raw("admin", { do: "project.demo", key: "nowhere" })).toMatchObject({
			ok: false,
			error: { code: "not_found" },
		});
		expect(rows("SELECT * FROM demo_projects")).toEqual([]);
	});

	test("only a caller who administers the instance makes one", () => {
		h = harness();
		h.call("admin", { do: "project.create", key: "demo" });
		const member = h.actor("mira", "human", ["read", "produce", "answer", "plan"]);
		expect(h.raw("admin", { do: "project.demo", key: "demo" }, member)).toMatchObject({
			ok: false,
			error: { code: "forbidden" },
		});
	});
});

describe("when a write happened", () => {
	test("a write to a demo is recorded at the time its caller gives", () => {
		const since = demo();
		const then = since - 10 * DAY;
		const made = at(then, "propose", newCase("Ten days ago", "demo-time-case-1"));
		expect(made.ok).toBe(true);
		expect(rows<{ at: number }>("SELECT at FROM versions")).toEqual([{ at: then }]);
		expect(rows<{ at: number }>("SELECT at FROM commands WHERE id = 'demo-time-case-1'")).toEqual([{ at: then }]);
		// A report, which commits twice, carries the time through both transactions.
		const reported = at(then + DAY, "report", {
			target: { commit: "aaaaaaa1", branch: "main" },
			results: [{ test: { key: "t1" }, outcome: "fail", failure: { message: "boom" } }],
		});
		expect(reported.ok).toBe(true);
		expect(rows<{ at: number }>("SELECT at FROM batches")).toEqual([{ at: then + DAY }]);
		expect(rows<{ at: number }>("SELECT at FROM results")).toEqual([{ at: then + DAY }]);
		expect(rows<{ opened_at: number }>("SELECT opened_at FROM questions WHERE kind = 'failure'")).toEqual([
			{ opened_at: then + DAY },
		]);
	});

	test("a write with no time takes the server's clock, on a demo as anywhere", () => {
		demo();
		h.advance(5_000);
		expect(at(undefined, "propose", newCase("Now")).ok).toBe(true);
		expect(rows<{ at: number }>("SELECT at FROM versions")).toEqual([{ at: h.app.now() }]);
	});

	test("a project that is no demo refuses a time and writes nothing", () => {
		demo();
		const refused = at(h.app.now() - DAY, "propose", newCase("Backdated"), "scratch");
		expect(refused).toMatchObject({
			ok: false,
			error: { code: "invalid", message: expect.stringContaining("scratch is not a demo project") },
		});
		expect(rows("SELECT id FROM cases")).toEqual([]);
	});

	test("a time in the future, a time that is no number, a read and an instance operation are refused", () => {
		demo();
		expect(at(h.app.now() + 60_000, "propose", newCase("Tomorrow"))).toMatchObject({
			ok: false,
			error: { code: "invalid", message: "the time is in the future" },
		});
		for (const bad of [1.5, -1, Number.NaN, Number.MAX_SAFE_INTEGER + 2])
			expect(at(bad, "propose", newCase("Bad"))).toMatchObject({ ok: false, error: { code: "invalid" } });
		expect(at(0, "find", { in: "cases" })).toMatchObject({
			ok: false,
			error: { code: "invalid", message: expect.stringContaining("find takes no time") },
		});
		expect(at(0, "admin", { do: "project.list" }, null)).toMatchObject({
			ok: false,
			error: { code: "invalid", message: expect.stringContaining("admin takes no time") },
		});
		expect(rows("SELECT id FROM cases")).toEqual([]);
	});

	test("a command id names the time too: the same request at another time is refused, at the same time it is a retry", () => {
		const since = demo();
		const then = since - 3 * DAY;
		const first = at(then, "propose", newCase("Once", "demo-time-retry-1"));
		expect(first.ok).toBe(true);
		expect(at(then, "propose", newCase("Once", "demo-time-retry-1"))).toEqual(first);
		for (const other of [then + 1, undefined])
			expect(at(other, "propose", newCase("Once", "demo-time-retry-1"))).toMatchObject({
				ok: false,
				error: { code: "conflict" },
			});
		expect(rows("SELECT id FROM cases")).toHaveLength(1);
	});

	test("a report accepted before a restart is applied with the time it was accepted at", () => {
		const since = demo();
		const then = since - 4 * DAY;
		const project = findProject(h.app.db, "demo");
		if (!project) throw new Error("no project");
		h.app.db.transaction(() => {
			const ctx = makeCtx(h.app, project, h.owner, true, then);
			acceptReport(ctx, {
				target: { commit: "bbbbbbb2", branch: "main" },
				results: [{ test: { key: "t1" }, outcome: "pass" }],
			});
			stampSeq(ctx);
		});
		expect(recoverAccepted(h.app)).toBe(1);
		expect(rows<{ at: number }>("SELECT at FROM results")).toEqual([{ at: then }]);
	});
});

describe("a demo and an archive", () => {
	test("an archive does not say which project was a demo, and an imported project takes the server's clock", () => {
		// The archive is of an instance whose first project is real work.
		h = harness();
		h.call("propose", newCase("Real work"));
		const chunks: string[] = [];
		exportArchive(h.app.db, (chunk) => chunks.push(chunk));
		const archive = chunks.join("");
		expect(archive).not.toContain("demo_projects");
		h.close();

		// It goes into a fresh instance whose untouched first project was made a demo: the same id, another project.
		h = harness();
		h.call("admin", { do: "project.demo", key: "scratch" });
		expect(rows<{ project: number }>("SELECT project FROM demo_projects")).toEqual([{ project: 1 }]);
		removeBootstrap(h.app.db);
		importArchive(h.app.db, linesOf(archive));
		expect(rows<{ id: number }>("SELECT id FROM projects")).toEqual([{ id: 1 }]);
		expect(rows("SELECT project FROM demo_projects")).toEqual([]);
		const owner = actorByName(h.app.db, "robin", 0);
		if (!owner) throw new Error("the archive holds no owner");
		const refused = invoke(h.app, OPS, {
			op: "propose",
			project: "scratch",
			input: newCase("Backdated after import"),
			actor: () => owner,
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
		const instance = start(
			{
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
