// The HTTP surface on a real listener: who gets in, in each mode, and that every operation is there.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Worker } from "node:worker_threads";
import type { Envelope, SessionInfo } from "../src/core/api.ts";
import type { Config } from "../src/server/kernel/app.ts";
import { OP_LIST, OPS } from "../src/server/ops/index.ts";
import { invoke } from "../src/server/ops/registry.ts";
import { Readers } from "../src/server/readers.ts";
import { type Instance, start } from "../src/server/start.ts";

const dirs: string[] = [];
const running: Instance[] = [];
afterEach(async () => {
	for (const instance of running.splice(0)) await instance.stop();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function boot(mode: Config["mode"], ownerToken: string | null = null, existing?: string): Instance {
	const dataDir = existing ?? mkdtempSync(join(tmpdir(), "mainworthy-http-"));
	if (!existing) dirs.push(dataDir);
	const instance = start({ dataDir, host: "127.0.0.1", port: 0, mode, owner: "robin", ownerToken }, () => ({
		ui: null,
	}));
	running.push(instance);
	return instance;
}

async function post<T>(
	instance: Instance,
	path: string,
	body: unknown,
	headers: Record<string, string> = {},
): Promise<{ status: number; body: Envelope<T>; cookie: string | null }> {
	const response = await fetch(`${instance.url}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
	return {
		status: response.status,
		body: (await response.json()) as Envelope<T>,
		cookie: response.headers.get("set-cookie"),
	};
}
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

function bootReaders(count: number): Instance {
	const dataDir = mkdtempSync(join(tmpdir(), "mainworthy-http-readers-"));
	dirs.push(dataDir);
	const instance = start(
		{ dataDir, host: "127.0.0.1", port: 0, mode: "local", owner: "robin", ownerToken: null },
		() => ({ ui: null }),
		{ readers: count },
	);
	running.push(instance);
	return instance;
}

function readersOf(instance: Instance): Readers {
	if (!(instance.app.readers instanceof Readers)) throw new Error("reader pool did not start");
	return instance.app.readers;
}

describe("reads on other cores through HTTP", () => {
	test("every registered read has the same reply as inline, including refusals", async () => {
		const instance = bootReaders(2);
		const pool = readersOf(instance);
		await pool.ready();
		await post(instance, "/api/p/scratch/propose", {
			edits: [
				{ op: "create", outline: "Checkout #checkout", folder: "checkout" },
				{ op: "create", outline: "Payment #payments", folder: "checkout" },
			],
		});
		await post(instance, "/api/p/scratch/propose", {
			cmd: "edit-0001",
			edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Checkout revised" } }],
		});
		await post(instance, "/api/p/scratch/report", {
			target: { commit: "feedc0de1", branch: "main", files: ["checkout.spec.ts"] },
			results: [
				{ test: { key: "checkout.spec.ts::checkout", file: "checkout.spec.ts" }, outcome: "pass" },
				{
					test: { key: "checkout.spec.ts::payment", file: "checkout.spec.ts" },
					outcome: "fail",
					failure: { message: "payment failed" },
				},
			],
		});
		const inputs: Record<string, unknown[]> = {
			get: [{ refs: ["C-1", "T-1", "R-1", "P-1"] }, { refs: ["C-1"], as: "md" }, { refs: [] }],
			find: [{}, { in: "folders" }, { in: "tests" }, { folder: "checkout" }, { text: "revised" }],
			inbox: [{}, { state: "decided" }],
			impact: [{ files: ["checkout.spec.ts"] }],
			since: [{ cursor: "s:0" }],
			gate: [{ commit: "feedc0de1" }],
			history: [{ ref: "C-1" }, { ref: "C-1", from: 1, to: 2 }],
			timeline: [{ ref: "C-1" }],
			check: [{}],
			command: [{ cmd: "edit-0001" }, { cmd: "never-sent" }],
		};
		const reads = OP_LIST.filter((op) => op.effect === "read");
		expect(Object.keys(inputs).sort()).toEqual(reads.map((op) => op.name).sort());
		const before = pool.completed;
		let checked = 0;
		for (const op of reads) {
			for (const input of inputs[op.name] ?? []) {
				const expected = invoke(instance.app, OPS, {
					op: op.name,
					project: "scratch",
					input,
					actor: () => instance.owner,
				});
				const reply = await post(instance, `/api/p/scratch/${op.name}`, input);
				expect(reply.body).toEqual(JSON.parse(JSON.stringify(expected)));
				checked++;
			}
		}
		expect(pool.completed - before).toBe(checked);
		expect(pool.fallbacks).toBe(0);
	});

	test("sixteen clients see every committed case immediately after their write while a report is applied", async () => {
		const instance = bootReaders(4);
		const pool = readersOf(instance);
		await pool.ready();
		await post(instance, "/api/p/scratch/propose", {
			edits: Array.from({ length: 16 }, (_, i) => ({ op: "create", outline: `Reader ${i}` })),
		});
		const upload = post(instance, "/api/p/scratch/report", {
			target: { commit: "abcdef0123", branch: "main" },
			results: Array.from({ length: 10_000 }, (_, i) => ({ test: { key: `tests::${i}` }, outcome: "pass" })),
		});
		await Promise.all(
			Array.from({ length: 16 }, async (_, client) => {
				const ref = `C-${client + 1}`;
				for (let version = 2; version <= 9; version++) {
					const title = `Client ${client} version ${version}`;
					const written = await post(instance, "/api/p/scratch/propose", {
						edits: [{ op: "edit", case: ref, base: version - 1, body: { title } }],
					});
					expect(written.body.ok).toBe(true);
					const read = await post<{ ref: string; title: string; version: number }[]>(instance, "/api/p/scratch/get", {
						refs: [ref],
					});
					expect(read.body.ok && read.body.result[0]).toMatchObject({ ref, title, version });
					if (read.body.ok && written.body.ok) expect(read.body.seq).toBeGreaterThanOrEqual(written.body.seq ?? 0);
				}
			}),
		);
		expect((await upload).body.ok).toBe(true);
		expect(pool.completed).toBeGreaterThanOrEqual(128);
		expect(pool.fallbacks).toBe(0);
	}, 15_000);

	test("killing a worker with HTTP reads in flight loses no requests and the replacement serves reads", async () => {
		const instance = bootReaders(1);
		const pool = readersOf(instance);
		await pool.ready();
		const worker = pool.threads[0];
		if (!worker) throw new Error("no reader thread");
		await post(instance, "/api/p/scratch/propose", {
			edits: Array.from({ length: 1000 }, (_, i) => ({ op: "create", outline: `Case ${i}` })),
		});
		const requests = Array.from({ length: 32 }, () => post(instance, "/api/p/scratch/find", { limit: 500 }));
		const queued = new Promise<void>((resolve) => {
			const send = worker.postMessage.bind(worker);
			worker.postMessage = (...args: Parameters<Worker["postMessage"]>) => {
				send(...args);
				resolve();
			};
		});
		await queued;
		await worker.terminate();
		expect((await Promise.all(requests)).every((reply) => reply.status === 200 && reply.body.ok)).toBe(true);
		expect(pool.fallbacks).toBeGreaterThan(0);
		await pool.ready();
		const before = pool.completed;
		expect((await post(instance, "/api/p/scratch/find", {})).status).toBe(200);
		expect(pool.completed).toBe(before + 1);
	});

	test("a read its caller may not make is refused before any worker sees it", async () => {
		const instance = bootReaders(2);
		const owner = bearer(instance.generatedToken ?? "");
		const made = await post<{ token: string }>(
			instance,
			"/api/admin",
			{ do: "token.create", actor: "writer-only", kind: "ci", can: ["record"], project: "scratch" },
			owner,
		);
		const readers = readersOf(instance);
		await readers.ready();
		const before = readers.completed;
		const refused = await post(instance, "/api/p/scratch/find", {}, bearer(made.body.ok ? made.body.result.token : ""));
		expect(refused.status).toBe(403);
		expect((await post(instance, "/api/p/scratch/find", {}, bearer("no-such-token-0123456789"))).status).toBe(401);
		expect(readers.completed).toBe(before);
		expect((await post(instance, "/api/p/scratch/find", {}, owner)).status).toBe(200);
		expect(readers.completed).toBe(before + 1);
	});

	test("a worker refuses write operations even when handed the owner's actor", async () => {
		const instance = bootReaders(1);
		const pool = readersOf(instance);
		await pool.ready();
		const refused = await pool.run(
			{
				op: "propose",
				project: "scratch",
				input: { edits: [{ op: "create", outline: "Must not be written" }] },
				actor: instance.owner,
			},
			() => {
				throw new Error("the worker must refuse the write itself");
			},
		);
		expect(refused).toMatchObject({ ok: false, error: { code: "forbidden" } });
		expect((await post<{ count: number }>(instance, "/api/p/scratch/find", {})).body).toMatchObject({
			ok: true,
			result: { count: 0 },
		});
	});

	// With reader threads the workers answer; without them the main thread answers from its own read connection.
	// Both keep the names they have shown, and both must drop a forgotten one at once.
	test.each([2, 0])(
		"forgetting an actor clears the name from every read at once (%d reader threads)",
		async (count) => {
			const instance = bootReaders(count);
			if (count > 0) await readersOf(instance).ready();
			const created = await post<{ token: string }>(instance, "/api/admin", {
				do: "token.create",
				actor: "case-author",
				kind: "human",
				can: ["read", "produce"],
			});
			if (!created.body.ok) throw new Error("could not create the case author");
			await post(
				instance,
				"/api/p/scratch/propose",
				{
					edits: [{ op: "create", outline: "Authored case" }],
				},
				bearer(created.body.result.token),
			);
			const history = async () => (await post(instance, "/api/p/scratch/history", { ref: "C-1" })).body;
			for (let i = 0; i < 8; i++) expect(JSON.stringify(await history())).toContain("case-author");
			expect((await post(instance, "/api/admin", { do: "actor.forget", name: "case-author" })).body.ok).toBe(true);
			for (let i = 0; i < 8; i++) {
				const reply = JSON.stringify(await history());
				expect(reply).not.toContain("case-author");
				expect(reply).toContain("forgotten-");
			}
		},
	);

	test("MAINWORTHY_READERS=0 uses the inline reader and stop awaits all worker exits", async () => {
		const previous = process.env.MAINWORTHY_READERS;
		let inline: Instance;
		try {
			process.env.MAINWORTHY_READERS = "0";
			inline = boot("local");
		} finally {
			if (previous === undefined) delete process.env.MAINWORTHY_READERS;
			else process.env.MAINWORTHY_READERS = previous;
		}
		expect(inline.app.readers).toBeNull();
		expect((await post(inline, "/api/p/scratch/find", {})).body).toMatchObject({ ok: true, result: { items: [] } });
		const pooled = bootReaders(2);
		const pool = readersOf(pooled);
		await pool.ready();
		const exits = pool.threads.map((worker) => new Promise<void>((resolve) => worker.once("exit", () => resolve())));
		await pooled.stop();
		await Promise.all(exits);
		expect(pool.threads).toHaveLength(0);
		await pooled.stop();
	});
});

describe("local mode", () => {
	test("the browser on this machine is the owner with no step, and a first project exists", async () => {
		const instance = boot("local");
		const session = (await (await fetch(`${instance.url}/api/session`)).json()) as Envelope<SessionInfo>;
		expect(session.ok && session.result).toMatchObject({ actor: "robin", kind: "human", mode: "local", via: "local" });
		expect(session.ok && session.result.projects.map((p) => p.key)).toEqual(["scratch"]);
		const created = await post(instance, "/api/p/scratch/propose", {
			edits: [{ op: "create", outline: "First case" }],
		});
		expect(created.body).toMatchObject({ ok: true, result: { status: "adopted" }, seq: 2 });
	});

	test("a page on another site cannot act as the owner: a foreign Origin or Host is refused", async () => {
		const instance = boot("local");
		const body = { edits: [{ op: "create", outline: "Planted" }] };
		expect((await post(instance, "/api/p/scratch/propose", body, { origin: "http://evil.example" })).status).toBe(401);
		expect((await post(instance, "/api/p/scratch/propose", body, { origin: "null" })).status).toBe(401);
		expect((await post(instance, "/api/p/scratch/propose", body, { host: "evil.example" })).status).toBe(401);
		const found = await post<{ items: unknown[] }>(instance, "/api/p/scratch/find", {});
		expect(found.body.ok && found.body.result.items).toEqual([]);
	});
});

describe("server mode", () => {
	test("a request that names who it believes it is, is refused when the session is somebody else's", async () => {
		const instance = boot("server", "owner-secret-0123456789");
		const owner = bearer("owner-secret-0123456789");
		const made = await post<{ token: string }>(
			instance,
			"/api/admin",
			{ do: "token.create", actor: "bob", kind: "human", can: ["read", "produce"], project: "scratch" },
			owner,
		);
		const bob = bearer(made.body.ok ? made.body.result.token : "");
		const create = { edits: [{ op: "create", outline: "Typed by Alice" }] };
		// A page that was opened as Alice sends her text; the browser's session has become Bob's since.
		const wrong = await post(instance, "/api/p/scratch/propose", create, { ...bob, "x-mainworthy-as": "alice" });
		expect(wrong.status).toBe(401);
		expect(wrong.body).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
		const found = await post<{ count: number }>(instance, "/api/p/scratch/find", {}, bob);
		expect(found.body.ok && found.body.result.count).toBe(0);
		// Reads are refused the same way: the page would otherwise show Bob's view as Alice's.
		expect((await post(instance, "/api/p/scratch/find", {}, { ...bob, "x-mainworthy-as": "alice" })).status).toBe(401);
		// So is every other route that takes a session (who am I, the change stream), and a name that cannot be read.
		const as = (name: string) => ({ headers: { ...bob, "x-mainworthy-as": name } });
		expect((await fetch(`${instance.url}/api/session`, as("alice"))).status).toBe(401);
		expect((await fetch(`${instance.url}/api/p/scratch/events`, as("alice"))).status).toBe(401);
		expect((await fetch(`${instance.url}/api/session`, as("%E0%A4%A"))).status).toBe(401);
		expect((await post(instance, "/api/p/scratch/find", {}, { ...bob, "x-mainworthy-as": "%E0%A4%A" })).status).toBe(
			401,
		);
		expect((await fetch(`${instance.url}/api/session`, as("bob"))).status).toBe(200);
		// The right name, and no name at all (a script, the CLI), go through. The name is percent-encoded, so one
		// that a header could not carry as it is still matches.
		expect((await post(instance, "/api/p/scratch/propose", create, { ...bob, "x-mainworthy-as": "bob" })).status).toBe(
			200,
		);
		expect((await post(instance, "/api/p/scratch/find", {}, bob)).status).toBe(200);
		const zoe = await post<{ token: string }>(
			instance,
			"/api/admin",
			{ do: "token.create", actor: "zoe@qa", kind: "human", can: ["read"], project: "scratch" },
			owner,
		);
		expect(zoe.body).toMatchObject({ ok: true });
		const named = {
			...bearer(zoe.body.ok ? zoe.body.result.token : ""),
			"x-mainworthy-as": encodeURIComponent("zoe@qa"),
		};
		expect((await post(instance, "/api/p/scratch/find", {}, named)).status).toBe(200);
	});

	test("nothing works without a token; the owner token signs in; a wrong one does not", async () => {
		const instance = boot("server", "owner-secret-0123456789");
		expect((await fetch(`${instance.url}/api/session`)).status).toBe(401);
		expect((await post(instance, "/api/p/scratch/find", {})).status).toBe(401);
		expect((await post(instance, "/api/p/scratch/find", {}, bearer("wrong-token-0123456789"))).status).toBe(401);
		expect((await post(instance, "/api/p/scratch/find", {}, bearer("owner-secret-0123456789"))).status).toBe(200);

		expect((await post(instance, "/api/login", { token: "wrong-token-0123456789" })).status).toBe(401);
		const login = await post(instance, "/api/login", { token: "owner-secret-0123456789" });
		expect(login.status).toBe(200);
		expect(login.cookie).toContain("HttpOnly");
		expect(login.cookie).toContain("SameSite=Strict");
		const cookie = (login.cookie ?? "").split(";")[0] ?? "";
		const session = (await (
			await fetch(`${instance.url}/api/session`, { headers: { cookie } })
		).json()) as Envelope<SessionInfo>;
		expect(session.ok && session.result).toMatchObject({ actor: "robin", via: "cookie", mode: "server" });
		// the cookie does not travel with a request another site makes
		expect((await post(instance, "/api/p/scratch/find", {}, { cookie, origin: "http://evil.example" })).status).toBe(
			401,
		);
	});

	test("with no token configured, one is generated on first start and only then", async () => {
		const instance = boot("server");
		const token = instance.generatedToken ?? "";
		expect(token).toMatch(/^cb_[0-9A-Za-z]{32}$/);
		expect((await post(instance, "/api/p/scratch/find", {}, bearer(token))).status).toBe(200);
		// The same data directory started again: no second token, and the first one still opens the door.
		await instance.stop();
		const again = boot("server", null, instance.app.config.dataDir);
		expect(again.generatedToken).toBeNull();
		expect((await post(again, "/api/p/scratch/find", {}, bearer(token))).status).toBe(200);
		expect(again.app.db.raw.query("SELECT count(*) AS n FROM tokens").get()).toEqual({ n: 1 });
	});

	test("a token carries its actor's capabilities and nothing more", async () => {
		const instance = boot("server", "owner-secret-0123456789");
		const owner = bearer("owner-secret-0123456789");
		await post(instance, "/api/admin", { do: "project.create", key: "other" }, owner);
		const made = await post<{ token: string }>(
			instance,
			"/api/admin",
			{ do: "token.create", actor: "github-actions", kind: "ci", can: ["read", "record"], project: "scratch" },
			owner,
		);
		const ci = bearer(made.body.ok ? made.body.result.token : "");
		const report = {
			target: { commit: "abc1234", branch: "main" },
			results: [{ test: { key: "a::b" }, outcome: "pass" }],
		};
		expect((await post(instance, "/api/p/scratch/report", report, ci)).status).toBe(200);
		expect((await post(instance, "/api/p/other/report", report, ci)).body).toMatchObject({
			ok: false,
			error: { code: "forbidden" },
		});
		expect((await post(instance, "/api/p/scratch/plan", { name: "x", select: {} }, ci)).body).toMatchObject({
			ok: false,
			error: { code: "forbidden" },
		});
		expect((await post(instance, "/api/admin", { do: "token.list" }, ci)).body).toMatchObject({
			ok: false,
			error: { code: "forbidden" },
		});

		const listed = await post<{ id: number; actor: string }[]>(instance, "/api/admin", { do: "token.list" }, owner);
		const id = listed.body.ok ? listed.body.result.find((t) => t.actor === "github-actions")?.id : undefined;
		await post(instance, "/api/admin", { do: "token.revoke", id }, owner);
		expect((await post(instance, "/api/p/scratch/report", report, ci)).status).toBe(401);
	});
});

describe("a pipeline's token", () => {
	const OWNER = "owner-secret-0123456789";
	const owner = bearer(OWNER);
	const report = {
		target: { commit: "abc1234", branch: "main" },
		job: "unit",
		results: [{ test: { key: "a::b" }, outcome: "fail", failure: { message: "boom" } }],
	};
	const create = { edits: [{ op: "create", outline: "Planted by a pipeline" }] };
	const forbidden = { ok: false, error: { code: "forbidden" } };
	const invalid = { ok: false, error: { code: "invalid" } };
	const admin = <T>(instance: Instance, input: unknown, headers: Record<string, string> = owner) =>
		post<T>(instance, "/api/admin", input, headers);
	async function token(instance: Instance, input: Record<string, unknown>): Promise<Record<string, string>> {
		const made = await admin<{ token: string }>(instance, { do: "token.create", ...input });
		if (!made.body.ok) throw new Error(`token.create: ${made.body.error.message}`);
		return bearer(made.body.result.token);
	}
	const cases = (instance: Instance, project: string) =>
		instance.app.db.raw
			.query("SELECT count(*) AS n FROM cases c JOIN projects p ON p.id = c.project WHERE p.key = ?")
			.get(project);

	test("issued with no list of capabilities, it records and reads the gate, and nothing else, under every preset", async () => {
		const instance = boot("server", OWNER);
		for (const preset of ["loose", "standard", "strict"]) {
			await admin(instance, { do: "project.create", key: preset, preset });
			const made = await admin<{ can: string[] }>(instance, {
				do: "token.create",
				actor: `pipeline-${preset}`,
				kind: "ci",
				project: preset,
			});
			expect(made.body).toMatchObject({ ok: true, result: { can: ["record"] } });
			const ci = bearer(made.body.ok ? (made.body.result as unknown as { token: string }).token : "");
			expect((await post(instance, `/api/p/${preset}/report`, report, ci)).body).toMatchObject({ ok: true });
			expect((await post(instance, `/api/p/${preset}/gate`, { commit: "abc1234" }, ci)).body).toMatchObject({
				ok: true,
				result: { verdict: "blocked" },
			});
			// Every other operation of the registry, whatever it is: one added later is refused here too.
			for (const op of OP_LIST) {
				if (op.name === "report" || op.name === "gate") continue;
				const path = op.scope === "project" ? `/api/p/${preset}/${op.name}` : `/api/${op.name}`;
				const reply = await post(instance, path, op.name === "propose" ? create : {}, ci);
				expect(`${preset} ${op.name}: ${reply.status}`).toBe(`${preset} ${op.name}: 403`);
			}
			expect(cases(instance, preset)).toEqual({ n: 0 });
			// Its grant is on one project: the same token is nobody on another.
			expect((await post(instance, "/api/p/scratch/report", report, ci)).body).toMatchObject(forbidden);
		}
	});

	test("a pipeline is not given more than recording and reading, and a stored grant that says more does not count", async () => {
		const instance = boot("server", OWNER);
		for (const can of [["produce"], ["read", "answer"], ["plan"], ["admin"]]) {
			const refused = await admin(instance, { do: "token.create", actor: "wide", kind: "ci", can, project: "scratch" });
			expect(refused.body).toMatchObject(invalid);
		}
		expect(instance.app.db.raw.query("SELECT count(*) AS n FROM actors WHERE name = 'wide'").get()).toEqual({ n: 0 });
		// A grant from before this rule, or from an archive: the row holds everything, the actor does not.
		const old = await token(instance, {
			actor: "old-pipeline",
			kind: "ci",
			can: ["read", "record"],
			project: "scratch",
		});
		instance.app.db.raw
			.query("UPDATE grants SET can = ? WHERE actor = (SELECT id FROM actors WHERE name = 'old-pipeline')")
			.run(JSON.stringify(["read", "produce", "answer", "plan", "admin"]));
		expect((await post(instance, "/api/p/scratch/report", report, old)).body).toMatchObject({ ok: true });
		expect((await post(instance, "/api/p/scratch/find", {}, old)).body).toMatchObject({ ok: true });
		expect((await post(instance, "/api/p/scratch/propose", create, old)).body).toMatchObject(forbidden);
		expect((await post(instance, "/api/p/scratch/plan", { name: "x", select: {} }, old)).body).toMatchObject(forbidden);
		expect((await admin(instance, { do: "token.list" }, old)).body).toMatchObject(forbidden);
		expect(cases(instance, "scratch")).toEqual({ n: 0 });
	});

	test("whoever may produce may record, and reading alone records nothing", async () => {
		const instance = boot("server", OWNER);
		const agent = await token(instance, {
			actor: "reviewer",
			kind: "agent",
			can: ["read", "produce"],
			project: "scratch",
		});
		expect((await post(instance, "/api/p/scratch/report", report, agent)).body).toMatchObject({ ok: true });
		const reader = await token(instance, { actor: "zoe", kind: "human", can: ["read"], project: "scratch" });
		expect((await post(instance, "/api/p/scratch/report", report, reader)).body).toMatchObject(forbidden);
		expect((await post(instance, "/api/p/scratch/gate", { commit: "abc1234" }, reader)).body).toMatchObject({
			ok: true,
		});
	});

	test("what each actor may do is listed for each project, and a grant is changed or taken away by name", async () => {
		const instance = boot("server", OWNER);
		await admin(instance, { do: "project.create", key: "other" });
		const ci = await token(instance, { actor: "github-actions", kind: "ci", project: "scratch" });
		const listed = async () => {
			const reply = await admin<{ name: string; kind: string; grants: { project: string; can: string[] }[] }[]>(
				instance,
				{ do: "actor.list" },
			);
			if (!reply.body.ok) throw new Error(`actor.list: ${reply.body.error.message}`);
			return reply.body.result.map((actor) => [actor.name, actor.kind, actor.grants]);
		};
		expect(await listed()).toEqual([
			["policy", "rule", []],
			["robin", "human", [{ project: "*", can: ["read", "record", "produce", "answer", "plan", "admin"] }]],
			["github-actions", "ci", [{ project: "scratch", can: ["record"] }]],
		]);

		const set = { do: "grant.set", actor: "github-actions", project: "scratch" };
		expect((await admin(instance, { ...set, can: ["record", "read"] })).body).toMatchObject({ ok: true });
		expect((await post(instance, "/api/p/scratch/find", {}, ci)).body).toMatchObject({ ok: true });
		expect((await admin(instance, { ...set, can: ["record", "produce"] })).body).toMatchObject(invalid);
		expect((await admin(instance, { ...set, actor: "nobody", can: ["read"] })).body).toMatchObject({
			ok: false,
			error: { code: "not_found" },
		});
		expect((await admin(instance, { ...set, project: "other", can: ["record"] })).body).toMatchObject({ ok: true });
		expect((await post(instance, "/api/p/other/report", report, ci)).body).toMatchObject({ ok: true });

		const remove = { do: "grant.remove", actor: "github-actions", project: "scratch" };
		expect((await admin(instance, remove)).body).toMatchObject({ ok: true, result: { removed: true } });
		expect((await post(instance, "/api/p/scratch/report", report, ci)).body).toMatchObject(forbidden);
		expect((await post(instance, "/api/p/other/report", report, ci)).body).toMatchObject({ ok: true });
		expect((await admin(instance, remove)).body).toMatchObject({ ok: true, result: { removed: false } });
		expect((await listed())[2]).toEqual(["github-actions", "ci", [{ project: "other", can: ["record"] }]]);

		// An admin does not change or drop their own grant: a slip there locks the instance.
		expect((await admin(instance, { do: "grant.remove", actor: "robin" })).body).toMatchObject(invalid);
		expect((await admin(instance, { do: "grant.set", actor: "robin", can: ["read"] })).body).toMatchObject(invalid);
		// Nor does another admin change the owner's: it is written again on every start, and until then the
		// instance could be left with nobody to administer it.
		const second = await token(instance, { actor: "ops", kind: "human" });
		expect((await admin(instance, { do: "grant.remove", actor: "robin" }, second)).body).toMatchObject(invalid);
		expect((await admin(instance, { do: "grant.set", actor: "robin", can: ["read"] }, second)).body).toMatchObject(
			invalid,
		);
		expect((await admin(instance, { do: "grant.set", actor: "ops", can: ["read"] })).body).toMatchObject({ ok: true });
		expect((await admin(instance, { do: "token.list" }, second)).body).toMatchObject(forbidden);
		expect((await admin(instance, { do: "token.list" })).body).toMatchObject({ ok: true });
	});

	test("a second token for an actor changes nothing the actor may do", async () => {
		const instance = boot("server", OWNER);
		const first = await token(instance, { actor: "reviewer", kind: "agent", can: ["read"], project: "scratch" });
		const second = await token(instance, { actor: "reviewer", kind: "agent" });
		// Naming the grant the actor already holds asks for no change, and is the same request.
		const third = await token(instance, { actor: "reviewer", kind: "agent", can: ["read"], project: "scratch" });
		for (const held of [first, second, third]) {
			expect((await post(instance, "/api/p/scratch/find", {}, held)).body).toMatchObject({ ok: true });
			expect((await post(instance, "/api/p/scratch/propose", create, held)).body).toMatchObject(forbidden);
		}
		const widened = await admin(instance, {
			do: "token.create",
			actor: "reviewer",
			kind: "agent",
			can: ["read", "produce"],
			project: "scratch",
		});
		expect(widened.body).toMatchObject({
			ok: false,
			error: { code: "invalid", message: expect.stringContaining("grant") },
		});
		// An actor that was forgotten gets no new token: its name is a pseudonym and it can do nothing.
		const forgotten = await admin<{ forgotten: string }>(instance, { do: "actor.forget", name: "reviewer" });
		const pseudonym = forgotten.body.ok ? forgotten.body.result.forgotten : "";
		expect((await admin(instance, { do: "token.create", actor: pseudonym, kind: "agent" })).body).toMatchObject(
			invalid,
		);
		// The owner's own grant is not rewritten by a token made for the owner.
		expect(
			(await admin(instance, { do: "token.create", actor: "robin", kind: "human", can: ["read"] })).body,
		).toMatchObject(invalid);
		expect((await admin(instance, { do: "token.list" })).body).toMatchObject({ ok: true });
	});

	test("the session names the project a pipeline records for, with what it may do there", async () => {
		const instance = boot("server", OWNER);
		await admin(instance, { do: "project.create", key: "other" });
		const ci = await token(instance, { actor: "github-actions", kind: "ci", project: "scratch" });
		const session = (await (
			await fetch(`${instance.url}/api/session`, { headers: ci })
		).json()) as Envelope<SessionInfo>;
		expect(session.ok && session.result).toMatchObject({ actor: "github-actions", kind: "ci", can: [] });
		expect(session.ok && session.result.projects.map((project) => [project.key, project.can])).toEqual([
			["scratch", ["record"]],
		]);
		expect((await fetch(`${instance.url}/api/p/scratch/events`, { headers: ci })).status).toBe(403);
	});
});

describe("what a session may see", () => {
	test("a token for one project gets neither another project's change stream nor its name", async () => {
		const instance = boot("server", "owner-secret-0123456789");
		const owner = bearer("owner-secret-0123456789");
		await post(instance, "/api/admin", { do: "project.create", key: "private-other" }, owner);
		const made = await post<{ token: string }>(
			instance,
			"/api/admin",
			{ do: "token.create", actor: "reader", kind: "human", can: ["read"], project: "scratch" },
			owner,
		);
		const reader = bearer(made.body.ok ? made.body.result.token : "");
		expect((await fetch(`${instance.url}/api/p/private-other/events`, { headers: reader })).status).toBe(403);
		expect((await fetch(`${instance.url}/api/p/no-such-project/events`, { headers: reader })).status).toBe(404);
		const own = await fetch(`${instance.url}/api/p/scratch/events`, { headers: reader });
		expect(own.status).toBe(200);
		await own.body?.cancel();
		const session = (await (
			await fetch(`${instance.url}/api/session`, { headers: reader })
		).json()) as Envelope<SessionInfo>;
		expect(session.ok && session.result.projects.map((project) => project.key)).toEqual(["scratch"]);
		const all = (await (
			await fetch(`${instance.url}/api/session`, { headers: owner })
		).json()) as Envelope<SessionInfo>;
		expect(all.ok && all.result.projects.map((project) => project.key).sort()).toEqual(["private-other", "scratch"]);
	});

	test("an open change stream stops when its actor is forgotten", async () => {
		const instance = boot("server", "owner-secret-0123456789");
		const owner = bearer("owner-secret-0123456789");
		const made = await post<{ token: string }>(
			instance,
			"/api/admin",
			{ do: "token.create", actor: "watcher", kind: "human", can: ["read"], project: "scratch" },
			owner,
		);
		const watcher = bearer(made.body.ok ? made.body.result.token : "");
		const stream = await fetch(`${instance.url}/api/p/scratch/events`, { headers: watcher });
		expect(stream.status).toBe(200);
		const reader = stream.body?.getReader();
		if (!reader) throw new Error("no stream");
		const decoder = new TextDecoder();
		await post(instance, "/api/p/scratch/propose", { edits: [{ op: "create", outline: "Seen" }] }, owner);
		let text = "";
		while (!text.includes("data:")) text += decoder.decode((await reader.read()).value);
		await post(instance, "/api/admin", { do: "actor.forget", name: "watcher" }, owner);
		await post(
			instance,
			"/api/p/scratch/propose",
			{ edits: [{ op: "create", outline: "Not for the forgotten" }] },
			owner,
		);
		let after = "";
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			after += decoder.decode(value);
		}
		expect(after).not.toContain("data:");
	});

	test("an Origin with this host and another scheme is another site", async () => {
		const instance = boot("local");
		const host = new URL(instance.url).host;
		const body = { edits: [{ op: "create", outline: "Planted" }] };
		expect((await post(instance, "/api/p/scratch/propose", body, { origin: `https://${host}` })).status).toBe(401);
		expect((await post(instance, "/api/p/scratch/propose", body, { origin: `http://${host}` })).status).toBe(200);
		// Behind a proxy that ends TLS, the proxy says which scheme the browser used.
		const forwarded = { origin: `https://${host}`, "x-forwarded-proto": "https" };
		expect((await post(instance, "/api/p/scratch/find", {}, forwarded)).status).toBe(200);
	});

	test("another site cannot sign a browser out", async () => {
		const instance = boot("server", "owner-secret-0123456789");
		const refused = await post(instance, "/api/logout", {}, { origin: "http://evil.example" });
		expect(refused.status).toBe(401);
		expect(refused.cookie).toBeNull();
		expect((await post(instance, "/api/logout", {})).cookie).toContain("Max-Age=0");
	});
});

describe("the surface", () => {
	test("every operation in the registry is a route and is in the generated API description", async () => {
		const instance = boot("local");
		const api = (await (await fetch(`${instance.url}/api/openapi.json`)).json()) as {
			paths: Record<string, { post: { operationId: string; requestBody: unknown } }>;
		};
		expect(
			Object.values(api.paths)
				.map((path) => path.post.operationId)
				.sort(),
		).toEqual(OP_LIST.map((op) => op.name).sort());
		for (const op of OP_LIST) {
			const path = op.scope === "project" ? `/api/p/scratch/${op.name}` : `/api/${op.name}`;
			const reply = await post(instance, path, { definitely: "not valid input for anything", refs: 7 });
			expect([200, 400]).toContain(reply.status); // reached the operation: it ran or refused the input; never 404
		}
		expect((await post(instance, "/api/p/scratch/nope", {})).body).toMatchObject({
			ok: false,
			error: { code: "not_found" },
		});
		expect((await post(instance, "/api/p/missing/find", {})).body).toMatchObject({
			ok: false,
			error: { code: "not_found" },
		});
	});

	test("a body that is not JSON and an input that is not valid are refused with the field named", async () => {
		const instance = boot("local");
		const raw = await fetch(`${instance.url}/api/p/scratch/propose`, { method: "POST", body: "{not json" });
		expect(raw.status).toBe(400);
		const invalid = await post(instance, "/api/p/scratch/propose", { edits: [{ op: "edit", case: "C-1" }] });
		expect(invalid.body).toMatchObject({ ok: false, error: { code: "invalid" } });
		expect(invalid.body.ok === false && invalid.body.error.message).toContain("base");
	});

	test("a committed write is pushed on the project's change stream", async () => {
		const instance = boot("local");
		const response = await fetch(`${instance.url}/api/p/scratch/events`);
		const reader = response.body?.getReader();
		if (!reader) throw new Error("no stream");
		await post(instance, "/api/p/scratch/propose", { edits: [{ op: "create", outline: "Streamed" }] });
		const decoder = new TextDecoder();
		let text = "";
		while (!text.includes("data:")) {
			const { value, done } = await reader.read();
			if (done) break;
			text += decoder.decode(value);
		}
		await reader.cancel();
		const event = JSON.parse(text.slice(text.indexOf("data:") + 5).split("\n")[0] ?? "{}") as {
			op: string;
			touched: string[];
			seq: number;
		};
		expect(event).toMatchObject({ op: "propose", seq: 2 });
		expect(event.touched).toContain("C-1");
	});
});

describe("a large report on a live server", () => {
	test("C5 and E2: from the moment it is accepted the gate reads pending, reads are answered while it is applied, and no stale green is served", async () => {
		const instance = boot("local");
		const results = (n: number, failing: boolean) =>
			Array.from({ length: n }, (_, i) => ({
				test: { key: `tests/f${i % 40}.spec.ts::test ${i}`, file: `tests/f${i % 40}.spec.ts` },
				outcome: failing && i % 500 === 0 ? "fail" : "pass",
				...(failing && i % 500 === 0 ? { failure: { message: "expected 1, got 2" } } : {}),
			}));
		const target = { commit: "feedc0de1", branch: "main" };
		await post(instance, "/api/p/scratch/report", { target, results: results(4000, false) });
		const gate = async () => {
			const reply = await post<{ verdict: string; stale: boolean }>(instance, "/api/p/scratch/gate", {
				commit: "feedc0de1",
			});
			if (!reply.body.ok) throw new Error("the gate read failed during the report");
			return reply.body.result;
		};
		expect((await gate()).verdict).toBe("passed");

		// The same commit, attempt 2, now with failures: applied in slices on the server.
		const upload = post<{ gate: { verdict: string } }>(instance, "/api/p/scratch/report", {
			target,
			attempt: 2,
			results: results(4000, true),
		});
		const seen: string[] = [];
		let reads = 0;
		let done = false;
		void upload.then(() => {
			done = true;
		});
		while (!done) {
			seen.push((await gate()).verdict);
			reads++;
		}
		const receipt = await upload;
		expect(receipt.body.ok && receipt.body.result.gate.verdict).toBe("blocked");
		expect(reads).toBeGreaterThan(3); // reads were answered while the report was being applied
		const firstPending = seen.indexOf("pending");
		expect(firstPending).toBeGreaterThanOrEqual(0);
		// once the upload was accepted, the old green never came back
		expect(seen.slice(firstPending).includes("passed")).toBe(false);
		expect((await gate()).verdict).toBe("blocked");
	});

	test("writes that arrive during a large report wait their turn and all land", async () => {
		const instance = boot("local");
		const big = Array.from({ length: 6000 }, (_, i) => ({ test: { key: `tests/a.spec.ts::t${i}` }, outcome: "pass" }));
		const upload = post(instance, "/api/p/scratch/report", {
			target: { commit: "0123abcd9", branch: "main" },
			results: big,
		});
		const saves = Array.from({ length: 5 }, (_, i) =>
			post<{ status: string }>(instance, "/api/p/scratch/propose", {
				edits: [{ op: "create", outline: `Saved during ingest ${i}` }],
			}),
		);
		const [uploaded, ...saved] = await Promise.all([upload, ...saves]);
		expect(uploaded.body.ok).toBe(true);
		expect(saved.map((s) => s.body.ok && s.body.result.status)).toEqual(Array(5).fill("adopted"));
		const found = await post<{ count: number }>(instance, "/api/p/scratch/find", {});
		expect(found.body.ok && found.body.result.count).toBe(5);
		const seqs = [uploaded, ...saved].map((r) => (r.body.ok ? r.body.seq : null));
		expect(new Set(seqs).size).toBe(6); // every command has its own place on the clock
	});
});

describe("request size", () => {
	test("an operation body over the limit is refused without being held in memory; sign-in takes a few kilobytes at most", async () => {
		const instance = boot("server", "owner-secret-0123456789");
		const headers = { "content-type": "application/json", authorization: "Bearer owner-secret-0123456789" };
		// 65 MB with an honest Content-Length
		const big = new Uint8Array(65 * 1024 * 1024).fill(32);
		const declared = await fetch(`${instance.url}/api/p/scratch/find`, { method: "POST", headers, body: big });
		expect(declared.status).toBe(413);
		// The same size streamed with no Content-Length: counted while reading. Sent over a plain socket, so the
		// status is the one the server wrote and not a guess made when a client library gives up on the upload.
		const { hostname, port } = new URL(instance.url);
		const stream = (): Promise<string> =>
			new Promise<string>((resolve) => {
				const socket = connect(Number(port), hostname);
				let reply = "";
				// One megabyte as one chunk of a chunked body, written whole so the framing survives backpressure.
				const megabyte = Buffer.alloc(1024 * 1024, 32);
				const chunk = Buffer.concat([
					Buffer.from(`${megabyte.length.toString(16)}\r\n`),
					megabyte,
					Buffer.from("\r\n"),
				]);
				let sent = 0;
				const send = (): void => {
					while (sent < 65 && !socket.destroyed) {
						sent++;
						if (!socket.write(chunk)) return void socket.once("drain", send);
					}
					if (!socket.destroyed) socket.write("0\r\n\r\n");
				};
				socket.on("error", () => {}); // the server may reset the connection once it has answered
				socket.on("data", (chunk) => {
					reply += chunk.toString("latin1");
				});
				socket.on("close", () => resolve(reply.split("\r\n")[0] ?? ""));
				socket.on("connect", () => {
					socket.write(
						`POST /api/p/scratch/find HTTP/1.1\r\nHost: ${hostname}:${port}\r\nContent-Type: application/json\r\n` +
							"Authorization: Bearer owner-secret-0123456789\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
					);
					send();
				});
			});
		// The server answers and closes while the client is still sending, so on a busy machine the reset can
		// reach the client before it has read the answer. An empty reply is that, not a status: ask again.
		let streamed = await stream();
		for (let tries = 1; streamed === "" && tries < 5; tries++) streamed = await stream();
		expect(streamed).toBe("HTTP/1.1 413 Payload Too Large");
		const login = await fetch(`${instance.url}/api/login`, {
			method: "POST",
			body: JSON.stringify({ token: "x".repeat(10_000) }),
		});
		expect(login.status).toBe(401);
		// an ordinary request still works afterwards
		expect(
			(await post(instance, "/api/p/scratch/find", {}, { authorization: "Bearer owner-secret-0123456789" })).status,
		).toBe(200);
	});
});
