// The HTTP surface on a real listener: who gets in, in each mode, and that every operation is there.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import type { Worker } from "node:worker_threads";
import type { Envelope, SessionInfo } from "../src/core/api.ts";
import { type Config, defaultConfig, SESSION_LIFETIMES } from "../src/server/kernel/app.ts";
import { OP_LIST, OPS } from "../src/server/ops/index.ts";
import { invoke } from "../src/server/ops/registry.ts";
import { Readers } from "../src/server/readers.ts";
import { type Instance, start } from "../src/server/start.ts";
import { type Patience, sessionOf } from "../src/surfaces/http.ts";

const dirs: string[] = [];
const running: Instance[] = [];
afterEach(async () => {
	for (const instance of running.splice(0)) await instance.stop();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function boot(
	mode: Config["mode"],
	ownerToken: string | null = null,
	existing?: string,
	options: { owner?: string; host?: string; patience?: Patience } = {},
): Instance {
	const dataDir = existing ?? mkdtempSync(join(tmpdir(), "mainworthy-http-"));
	if (!existing) dirs.push(dataDir);
	const instance = start(
		{
			dataDir,
			host: options.host ?? "127.0.0.1",
			port: 0,
			mode,
			owner: options.owner ?? "robin",
			ownerToken,
			commit: null,
			...SESSION_LIFETIMES,
			proxy: null,
		},
		() => ({ ui: null }),
		options.patience ? { patience: options.patience } : {},
	);
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

/** A plain socket to the instance: what the server sent on it, and whether the server has closed it. */
function wire(instance: Instance, payload: string) {
	const { hostname, port } = new URL(instance.url);
	const socket = connect(Number(port), hostname);
	const state = { received: "", closed: false };
	const closed = new Promise<void>((resolve) => {
		socket.on("close", () => {
			state.closed = true;
			resolve();
		});
	});
	socket.on("error", () => {});
	socket.on("data", (chunk) => {
		state.received += chunk.toString("latin1");
	});
	socket.on("connect", () => socket.write(payload));
	return {
		state,
		/** Whether the server closes the connection within this many milliseconds. */
		within: (ms: number): Promise<"closed" | "open"> =>
			Promise.race([closed.then(() => "closed" as const), Bun.sleep(ms).then(() => "open" as const)]),
		end: () => socket.destroy(),
	};
}

/** An address of this machine that is not the loopback, when it has one: a peer that is not local, with nothing leaving the machine. */
const lanAddress = Object.values(networkInterfaces())
	.flat()
	.find((entry) => entry?.family === "IPv4" && !entry.internal)?.address;

function bootReaders(count: number): Instance {
	const dataDir = mkdtempSync(join(tmpdir(), "mainworthy-http-readers-"));
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

	test("a request that came through a forwarder is not the owner, whatever Host the forwarder wrote", async () => {
		// A proxy that does not keep the client's Host (nginx and Apache by default), or a forwarded port, presents
		// a loopback Host for a visitor from anywhere. Each of these headers says the request did not start here.
		const instance = boot("local");
		const body = { edits: [{ op: "create", outline: "Planted through a proxy" }] };
		expect((await fetch(`${instance.url}/api/session`)).status).toBe(200);
		for (const [header, value] of [
			["forwarded", "for=203.0.113.9;proto=https"],
			["x-forwarded-for", "203.0.113.9"],
			["x-forwarded-host", "mainworthy.example"],
			["x-real-ip", "203.0.113.9"],
			["via", "1.1 proxy"],
			["cf-connecting-ip", "203.0.113.9"],
		] as const) {
			const read = await fetch(`${instance.url}/api/session`, { headers: { [header]: value } });
			const write = await post(instance, "/api/p/scratch/propose", body, { [header]: value });
			expect(`${header}: ${read.status} ${write.status}`).toBe(`${header}: 401 401`);
		}
		const found = await post<{ items: unknown[] }>(instance, "/api/p/scratch/find", {});
		expect(found.body.ok && found.body.result.items).toEqual([]);
	});

	test("a GET another site's page makes is refused: the browser says so where it sends no Origin", async () => {
		// An image or a script on any page the owner visits can ask for `/api/session` or the change stream, and a
		// browser sends no Origin on such a GET. It does send Sec-Fetch-Site.
		const instance = boot("local");
		const session = (site: string) => fetch(`${instance.url}/api/session`, { headers: { "sec-fetch-site": site } });
		const seen: string[] = [];
		for (const site of ["cross-site", "same-site", "same-origin", "none"])
			seen.push(`${site}: ${(await session(site)).status}`);
		expect(seen).toEqual(["cross-site: 401", "same-site: 401", "same-origin: 200", "none: 200"]);
		const stream = await fetch(`${instance.url}/api/p/scratch/events`, { headers: { "sec-fetch-site": "cross-site" } });
		expect(stream.status).toBe(401);
		await stream.body?.cancel();
	});

	test("the owner with no step is a connection from this machine: any other peer address is refused", () => {
		const instance = boot("local");
		const request = new Request(`${instance.url}/api/session`, { headers: { host: new URL(instance.url).host } });
		const via = (peer: string | null) => sessionOf(instance.app, request, instance.owner, peer)?.via ?? "refused";
		expect(["127.0.0.1", "127.0.0.53", "::1", "::ffff:127.0.0.1"].map(via)).toEqual(Array(4).fill("local"));
		expect(["192.168.1.20", "203.0.113.9", "::ffff:10.0.0.7", "fe80::1", "", null].map(via)).toEqual(
			Array(6).fill("refused"),
		);
	});

	// The same over a real connection, on a machine that has an address besides the loopback. The server listens
	// on every address for the length of this test, as a forwarded port makes it do.
	test.skipIf(!lanAddress)(
		"a connection from another address is not the owner, though its Host says loopback",
		async () => {
			const instance = boot("local", null, undefined, { host: "0.0.0.0" });
			const port = new URL(instance.url).port;
			const session = (address: string) =>
				fetch(`http://${address}:${port}/api/session`, { headers: { host: `127.0.0.1:${port}` } });
			expect((await session("127.0.0.1")).status).toBe(200);
			expect((await session(lanAddress ?? "")).status).toBe(401);
		},
	);
});

describe("server mode", () => {
	test("a session cookie that cannot be decoded is no session: 401, and nothing in the log", async () => {
		const instance = boot("server", "owner-secret-0123456789");
		const logged = spyOn(console, "error").mockImplementation(() => {});
		try {
			const cookie = { cookie: "mainworthy_sid=%" };
			const seen = [
				(await fetch(`${instance.url}/api/session`, { headers: cookie })).status,
				(await fetch(`${instance.url}/api/p/scratch/events`, { headers: cookie })).status,
				(await post(instance, "/api/p/scratch/find", {}, cookie)).status,
			];
			expect(seen).toEqual([401, 401, 401]);
			expect(logged.mock.calls).toEqual([]);
		} finally {
			logged.mockRestore();
		}
	});

	test("the forwarded scheme is read one way: a list or upper case is still https, signs in, and the cookie is Secure", async () => {
		// A second proxy appends its own scheme to the header, so the first element is the browser's. Before, the
		// Origin check took the first element and the cookie wanted the whole header to be exactly `https`.
		const instance = boot("server", "owner-secret-0123456789");
		const origin = `https://${new URL(instance.url).host}`;
		const seen: string[] = [];
		for (const proto of ["https", "https,http", "https, https", "HTTPS"]) {
			const login = await post(
				instance,
				"/api/login",
				{ token: "owner-secret-0123456789" },
				{ origin, "x-forwarded-proto": proto },
			);
			seen.push(`${proto}: ${login.status}${login.cookie?.includes("; Secure") ? " Secure" : ""}`);
		}
		expect(seen).toEqual([
			"https: 200 Secure",
			"https,http: 200 Secure",
			"https, https: 200 Secure",
			"HTTPS: 200 Secure",
		]);
		// Plain HTTP, as on a published port, is still plain: the cookie could not come back otherwise.
		const plain = await post(instance, "/api/login", { token: "owner-secret-0123456789" });
		expect(`${plain.status}${plain.cookie?.includes("Secure") ? " Secure" : ""}`).toBe("200");
		const downgraded = await post(
			instance,
			"/api/login",
			{ token: "owner-secret-0123456789" },
			{ origin, "x-forwarded-proto": "http,https" },
		);
		expect(downgraded.status).toBe(401);
	});

	test("the cookie does not travel with a GET the browser says another site made", async () => {
		const instance = boot("server", "owner-secret-0123456789");
		const login = await post(instance, "/api/login", { token: "owner-secret-0123456789" });
		const cookie = (login.cookie ?? "").split(";")[0] ?? "";
		const session = (site: string) =>
			fetch(`${instance.url}/api/session`, { headers: { cookie, "sec-fetch-site": site } });
		const seen: string[] = [];
		for (const site of ["cross-site", "same-site", "same-origin", "none"])
			seen.push(`${site}: ${(await session(site)).status}`);
		expect(seen).toEqual(["cross-site: 401", "same-site: 401", "same-origin: 200", "none: 200"]);
		// A token is not something a browser attaches by itself, so it is not held to the rule.
		const script = { ...bearer("owner-secret-0123456789"), "sec-fetch-site": "cross-site" };
		expect((await fetch(`${instance.url}/api/session`, { headers: script })).status).toBe(200);
	});

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
		// It holds no grant on `other`, so to this token there is no such project (see "what a session may see").
		expect((await post(instance, "/api/p/other/report", report, ci)).body).toMatchObject({
			ok: false,
			error: { code: "not_found" },
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
	const missing = { ok: false, error: { code: "not_found" } };
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
			// Its grant is on one project: the same token is nobody on another, and is told there is no such project.
			expect((await post(instance, "/api/p/scratch/report", report, ci)).body).toMatchObject(missing);
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
		// With its grant on scratch gone, scratch is to this token a project that does not exist.
		expect((await post(instance, "/api/p/scratch/report", report, ci)).body).toMatchObject(missing);
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

describe("who may make a token for whom", () => {
	const OWNER = "owner-secret-0123456789";
	const owner = bearer(OWNER);
	const admin = <T>(instance: Instance, input: unknown, headers: Record<string, string> = owner) =>
		post<T>(instance, "/api/admin", input, headers);
	async function token(instance: Instance, input: Record<string, unknown>): Promise<Record<string, string>> {
		const made = await admin<{ token: string }>(instance, { do: "token.create", ...input });
		if (!made.body.ok) throw new Error(`token.create: ${made.body.error.message}`);
		return bearer(made.body.result.token);
	}
	/** A refusal whose sentence says who may. */
	const refusal = (who: string): Envelope<unknown> => ({
		ok: false,
		error: { code: "forbidden", message: expect.stringContaining(who) },
	});
	const actors = (instance: Instance) =>
		instance.app.db.raw
			.query<{ name: string }, []>("SELECT name FROM actors ORDER BY id")
			.all()
			.map((row) => row.name);
	const tokensOf = (instance: Instance, name: string) =>
		instance.app.db.raw
			.query("SELECT count(*) AS n FROM tokens t JOIN actors a ON a.id = t.actor WHERE a.name = ?")
			.get(name);

	test("a person's token is made by that person or by the owner, and the owner's by the owner alone", async () => {
		// Whoever holds a token for a name acts under that name: the record says a decision or a typed text is
		// that person's. So an admin does not make one for somebody else, and nobody makes one for the owner.
		const instance = boot("server", OWNER);
		const dana = await token(instance, { actor: "dana", kind: "human" });
		await token(instance, { actor: "eve", kind: "human", can: ["read"], project: "scratch" });
		const forOwner = await admin(instance, { do: "token.create", actor: "robin", kind: "human" }, dana);
		expect([forOwner.status, forOwner.body]).toEqual([403, refusal("only robin")]);
		const forEve = await admin(instance, { do: "token.create", actor: "eve", kind: "human" }, dana);
		expect([forEve.status, forEve.body]).toEqual([403, refusal("by eve or by robin")]);
		// Naming another kind for a person who exists does not get round it.
		expect((await admin(instance, { do: "token.create", actor: "robin", kind: "agent" }, dana)).status).toBe(403);
		expect([tokensOf(instance, "robin"), tokensOf(instance, "eve")]).toEqual([{ n: 1 }, { n: 1 }]);
		// Their own, the owner for anybody, and an admin for somebody new, as before.
		const second = await admin<{ actor: string }>(instance, { do: "token.create", actor: "dana", kind: "human" }, dana);
		expect(second.body).toMatchObject({ ok: true, result: { actor: "dana" } });
		expect((await admin(instance, { do: "token.create", actor: "eve", kind: "human" })).body).toMatchObject({
			ok: true,
		});
		expect((await admin(instance, { do: "token.create", actor: "robin", kind: "human" })).body).toMatchObject({
			ok: true,
		});
		expect((await admin(instance, { do: "token.create", actor: "frank", kind: "human" }, dana)).body).toMatchObject({
			ok: true,
		});
		expect((await admin(instance, { do: "token.create", actor: "helper", kind: "agent" }, dana)).body).toMatchObject({
			ok: true,
		});
	});

	test("an agent that administers makes no person, no person's token, no grant and forgets nobody", async () => {
		// An agent with a person's token is a person to every policy clause that says "not an agent".
		const instance = boot("server", OWNER);
		const bot = await token(instance, { actor: "rootbot", kind: "agent", can: ["admin"] });
		await token(instance, { actor: "eve", kind: "human", can: ["read"], project: "scratch" });
		const before = actors(instance);
		const person = refusal("a person");
		for (const input of [
			{ do: "token.create", actor: "robin", kind: "human" },
			{ do: "token.create", actor: "eve", kind: "human" },
			{ do: "token.create", actor: "newcomer", kind: "human" },
			{ do: "grant.set", actor: "eve", can: ["read", "admin"] },
			{ do: "grant.set", actor: "rootbot", project: "scratch", can: ["answer"] },
			{ do: "grant.remove", actor: "eve", project: "scratch" },
			{ do: "actor.forget", name: "eve" },
		]) {
			const reply = await admin(instance, input, bot);
			expect([JSON.stringify(input), reply.status, reply.body]).toEqual([JSON.stringify(input), 403, person]);
		}
		expect(actors(instance)).toEqual(before);
		expect([tokensOf(instance, "robin"), tokensOf(instance, "eve")]).toEqual([{ n: 1 }, { n: 1 }]);
		const eve = await admin<{ name: string; grants: unknown[] }[]>(instance, { do: "actor.list" });
		expect(eve.body.ok && eve.body.result.find((actor) => actor.name === "eve")?.grants).toEqual([
			{ project: "scratch", can: ["read"] },
		]);
		// Everything else an agent that administers could do, it still can.
		expect((await admin(instance, { do: "project.create", key: "made-by-bot" }, bot)).body).toMatchObject({ ok: true });
		expect((await admin(instance, { do: "token.create", actor: "worker", kind: "agent" }, bot)).body).toMatchObject({
			ok: true,
		});
		expect(
			(await admin(instance, { do: "token.create", actor: "pipeline", kind: "ci", project: "scratch" }, bot)).body,
		).toMatchObject({ ok: true });
		expect((await admin(instance, { do: "token.create", actor: "rootbot", kind: "agent" }, bot)).body).toMatchObject({
			ok: true,
		});
		const listed = await admin<{ id: number; actor: string }[]>(instance, { do: "token.list" }, bot);
		const worker = listed.body.ok ? listed.body.result.find((row) => row.actor === "worker")?.id : undefined;
		expect((await admin(instance, { do: "token.revoke", id: worker }, bot)).body).toMatchObject({
			ok: true,
			result: { revoked: true },
		});
		expect((await admin(instance, { do: "actor.list" }, bot)).body).toMatchObject({ ok: true });
	});
});

describe("the owner always has a way in", () => {
	// Long enough that the start has nothing to say about its length (32 characters or more).
	const OWNER = "owner-secret-0123456789abcdef-012345";
	const owner = bearer(OWNER);
	/** What every start in server mode says when it names no proxy, as these do (`test/limit.test.ts`). */
	const NO_PROXY_NAMED = expect.stringMatching(
		/^MAINWORTHY_TRUSTED_PROXY and MAINWORTHY_CLIENT_ADDRESS_HEADER are not set: /,
	);
	const admin = <T>(instance: Instance, input: unknown, headers: Record<string, string> = owner) =>
		post<T>(instance, "/api/admin", input, headers);
	async function token(instance: Instance, input: Record<string, unknown>): Promise<string> {
		const made = await admin<{ token: string }>(instance, { do: "token.create", ...input });
		if (!made.body.ok) throw new Error(`token.create: ${made.body.error.message}`);
		return made.body.result.token;
	}
	const whoIs = async (instance: Instance, secret: string): Promise<string> => {
		const reply = await fetch(`${instance.url}/api/session`, { headers: bearer(secret) });
		const session = (await reply.json()) as Envelope<SessionInfo>;
		return session.ok ? session.result.actor : String(reply.status);
	};
	const ownTokens = async (instance: Instance, headers = owner) => {
		const listed = await admin<{ id: number; actor: string; revoked: boolean }[]>(
			instance,
			{ do: "token.list" },
			headers,
		);
		if (!listed.body.ok) throw new Error(`token.list: ${listed.body.error.message}`);
		return listed.body.result.filter((row) => row.actor === "robin" && !row.revoked).map((row) => row.id);
	};

	test("the owner's last token is not revoked and the owner is not forgotten, by the owner or by another admin", async () => {
		const instance = boot("server", OWNER);
		const dana = bearer(await token(instance, { actor: "dana", kind: "human" }));
		const [only] = await ownTokens(instance);
		for (const caller of [owner, dana]) {
			const revoked = await admin(instance, { do: "token.revoke", id: only }, caller);
			expect([revoked.status, revoked.body]).toEqual([
				400,
				{ ok: false, error: { code: "invalid", message: expect.stringContaining("make robin another token first") } },
			]);
		}
		const forgotten = await admin(instance, { do: "actor.forget", name: "robin" }, dana);
		expect([forgotten.status, forgotten.body]).toEqual([
			400,
			{ ok: false, error: { code: "invalid", message: expect.stringContaining("MAINWORTHY_OWNER") } },
		]);
		expect((await admin(instance, { do: "actor.forget", name: "robin" })).body).toMatchObject({
			ok: false,
			error: { code: "invalid" },
		});
		expect(await whoIs(instance, OWNER)).toBe("robin");
		// With a second token the first can go: what is kept is a way in, not this token.
		const spare = await token(instance, { actor: "robin", kind: "human" });
		expect((await admin(instance, { do: "token.revoke", id: only })).body).toMatchObject({
			ok: true,
			result: { revoked: true },
		});
		expect([await whoIs(instance, OWNER), await whoIs(instance, spare)]).toEqual(["401", "robin"]);
		const [last] = await ownTokens(instance, bearer(spare));
		expect((await admin(instance, { do: "token.revoke", id: last }, bearer(spare))).body).toMatchObject({
			ok: false,
			error: { code: "invalid" },
		});
		// Anybody else's last token is theirs to lose.
		const listed = await admin<{ id: number; actor: string }[]>(instance, { do: "token.list" }, bearer(spare));
		const danas = listed.body.ok ? listed.body.result.find((row) => row.actor === "dana")?.id : undefined;
		expect((await admin(instance, { do: "token.revoke", id: danas }, bearer(spare))).body).toMatchObject({
			ok: true,
			result: { revoked: true },
		});
	});

	test("in local mode the owner needs no token, so the last one can be revoked", async () => {
		const instance = boot("local");
		const made = await post<{ token: string }>(instance, "/api/admin", {
			do: "token.create",
			actor: "robin",
			kind: "human",
		});
		expect(made.body.ok).toBe(true);
		const listed = await post<{ id: number }[]>(instance, "/api/admin", { do: "token.list" });
		const id = listed.body.ok ? listed.body.result[0]?.id : undefined;
		expect((await post(instance, "/api/admin", { do: "token.revoke", id })).body).toMatchObject({
			ok: true,
			result: { revoked: true },
		});
	});

	test("a configured owner token that was revoked, or is somebody else's, is not revived: the start says so and names the variable", async () => {
		const first = boot("server", OWNER);
		const dana = await token(first, { actor: "dana", kind: "human" });
		expect(first.warnings).toEqual([NO_PROXY_NAMED]);
		// Revoked before this rule existed, or in the database by hand.
		first.app.db.raw.query("UPDATE tokens SET revoked_at = 1 WHERE label LIKE 'owner %'").run();
		await first.stop();

		const revoked = boot("server", OWNER, first.app.config.dataDir);
		expect(revoked.warnings).toEqual([
			expect.stringMatching(/^MAINWORTHY_OWNER_TOKEN .*revoked.* Set MAINWORTHY_OWNER_TOKEN to a new value/),
			NO_PROXY_NAMED,
		]);
		expect(revoked.warnings.join("")).not.toContain("\n");
		expect([await whoIs(revoked, OWNER), revoked.generatedToken]).toEqual(["401", null]);
		await revoked.stop();

		const borrowed = boot("server", dana, first.app.config.dataDir);
		expect(borrowed.warnings).toEqual([
			expect.stringMatching(/^MAINWORTHY_OWNER_TOKEN .*dana.* Set MAINWORTHY_OWNER_TOKEN to a new value/),
			NO_PROXY_NAMED,
		]);
		expect([await whoIs(borrowed, dana), borrowed.generatedToken]).toEqual(["dana", null]);
		expect(borrowed.warnings.join("")).not.toContain(dana);
		await borrowed.stop();

		// A new value is a new token for the owner, and the start has nothing to say about it.
		const renewed = boot("server", "another-owner-secret-0123456789abcdef", first.app.config.dataDir);
		expect([renewed.warnings, await whoIs(renewed, "another-owner-secret-0123456789abcdef")]).toEqual([
			[NO_PROXY_NAMED],
			"robin",
		]);
	});

	test("with no token configured and none left for the owner, as after an import, the start makes one and shows it", async () => {
		const first = boot("server");
		const original = first.generatedToken ?? "";
		expect(await whoIs(first, original)).toBe("robin");
		// What an import does to the tokens of the instance it replaces.
		first.app.db.raw.query("DELETE FROM tokens").run();
		await first.stop();

		const again = boot("server", null, first.app.config.dataDir);
		const generated = again.generatedToken ?? "";
		expect(generated).toMatch(/^cb_[0-9A-Za-z]{32}$/);
		expect(generated).not.toBe(original);
		expect([await whoIs(again, generated), again.warnings]).toEqual(["robin", [NO_PROXY_NAMED]]);
		await again.stop();

		// Once the owner holds one, the next start makes no other.
		const third = boot("server", null, first.app.config.dataDir);
		expect([third.generatedToken, await whoIs(third, generated)]).toEqual([null, "robin"]);
	});

	test("the start gives everything to a person only: an owner name that is an agent's or a pipeline's stops it", async () => {
		// The owner's name comes from a variable, and the compose files default it to `owner`. A token issued to
		// read one project must not administer the instance after a restart in which that variable was lost.
		const first = boot("server", OWNER);
		const reader = await token(first, { actor: "owner", kind: "agent", can: ["read"], project: "scratch" });
		await token(first, { actor: "github-actions", kind: "ci", project: "scratch" });
		await first.stop();
		const dataDir = first.app.config.dataDir;
		for (const name of ["owner", "github-actions", "policy"]) {
			let message = "started";
			try {
				await boot("server", OWNER, dataDir, { owner: name }).stop();
			} catch (error) {
				message = error instanceof Error ? error.message : String(error);
			}
			expect(message).toContain("MAINWORTHY_OWNER ");
			expect(message).toContain(name);
		}
		// Nothing was granted on the way to the refusal.
		const again = boot("server", OWNER, dataDir);
		const session = (await (
			await fetch(`${again.url}/api/session`, { headers: bearer(reader) })
		).json()) as Envelope<SessionInfo>;
		expect(session.ok && [session.result.actor, session.result.kind, session.result.can]).toEqual([
			"owner",
			"agent",
			[],
		]);
		expect((await admin(again, { do: "token.list" }, bearer(reader))).status).toBe(403);
	});
});

describe("names and failures", () => {
	test("the owner is not given a forgotten actor's name either: a start with such an owner name is refused", async () => {
		// `token.create` refuses the name, and the start is the other place an actor is made. An owner called
		// `forgotten-3` would stop the third actor from ever being forgotten.
		for (const name of ["forgotten-3", "Forgotten-robin"]) {
			let message = "started";
			try {
				await boot("server", OWNER, undefined, { owner: name }).stop();
			} catch (error) {
				message = error instanceof Error ? error.message : String(error);
			}
			expect(message).toContain("MAINWORTHY_OWNER ");
			expect(message).toContain(name);
		}
	});

	const OWNER = "owner-secret-0123456789";
	const owner = bearer(OWNER);

	test("nobody is given the name a forgotten actor is known by", async () => {
		const instance = boot("server", OWNER);
		for (const actor of ["forgotten-3", "forgotten-", "Forgotten-12", "forgotten-robin"]) {
			const made = await post(
				instance,
				"/api/admin",
				{ do: "token.create", actor, kind: "human", can: ["read"] },
				owner,
			);
			expect([actor, made.status, made.body]).toEqual([
				actor,
				400,
				{ ok: false, error: { code: "invalid", message: expect.stringContaining("forgotten") } },
			]);
		}
		expect(instance.app.db.raw.query("SELECT count(*) AS n FROM actors WHERE name LIKE 'forgotten%'").get()).toEqual({
			n: 0,
		});
		// A name that only contains the word is a name.
		expect(
			(await post(instance, "/api/admin", { do: "token.create", actor: "not-forgotten-3", kind: "human" }, owner)).body,
		).toMatchObject({ ok: true });
	});

	test("a failure nobody foresaw is answered with one fixed sentence, and what failed goes to the log", async () => {
		const instance = boot("server", OWNER);
		await post(instance, "/api/admin", { do: "token.create", actor: "dana", kind: "human", can: ["read"] }, owner);
		await post(instance, "/api/admin", { do: "token.create", actor: "squatter", kind: "human", can: ["read"] }, owner);
		// An archive from before the rule above can hold the pseudonym as somebody's name. Forgetting dana then
		// runs into the database's own constraint, which is not an answer for a caller.
		instance.app.db.raw
			.query(
				"UPDATE actors SET name = 'forgotten-' || (SELECT id FROM actors WHERE name = 'dana') WHERE name = 'squatter'",
			)
			.run();
		const logged = spyOn(console, "error").mockImplementation(() => {});
		try {
			const reply = await post(instance, "/api/admin", { do: "actor.forget", name: "dana" }, owner);
			expect([reply.status, reply.body]).toEqual([
				500,
				{ ok: false, error: { code: "internal", message: "internal error" } },
			]);
			expect(logged.mock.calls.map((call) => call.map(String).join(" ")).join("\n")).toContain(
				"UNIQUE constraint failed",
			);
		} finally {
			logged.mockRestore();
		}
		// The command was rolled back whole: dana is still dana.
		const listed = await post<{ name: string; disabled: boolean }[]>(
			instance,
			"/api/admin",
			{ do: "actor.list" },
			owner,
		);
		expect(listed.body.ok && listed.body.result.find((actor) => actor.name === "dana")?.disabled).toBe(false);
	});
});

describe("what a session may see", () => {
	// This test used to assert 403 for the other project and 404 for one that does not exist, under a title that
	// said the token does not get the other project's name. The two statuses were the name: any token, a
	// pipeline's included, could ask for a key and learn whether a project has it (review F4, 2026-10-13).
	test("a token for one project is told the same of another project as of one that does not exist", async () => {
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
		const pipeline = await post<{ token: string }>(
			instance,
			"/api/admin",
			{ do: "token.create", actor: "github-actions", kind: "ci", project: "scratch" },
			owner,
		);
		const ci = bearer(pipeline.body.ok ? pipeline.body.result.token : "");
		/** The status and the body, with the key that was asked for taken out: the caller wrote that itself. */
		const told = async (reply: Response | Promise<Response>, key: string): Promise<string> => {
			const response = await reply;
			return `${response.status} ${(await response.text()).replaceAll(key, "<key>")}`;
		};
		const asks: [string, (key: string, headers: Record<string, string>) => Promise<Response>][] = [
			["the change stream", (key, headers) => fetch(`${instance.url}/api/p/${key}/events`, { headers })],
			...["find", "gate", "report", "propose", "no-such-operation"].map(
				(op): [string, (key: string, headers: Record<string, string>) => Promise<Response>] => [
					op,
					(key, headers) =>
						fetch(`${instance.url}/api/p/${key}/${op}`, {
							method: "POST",
							headers: { "content-type": "application/json", ...headers },
							body: "{}",
						}),
				],
			),
		];
		for (const caller of [reader, ci]) {
			for (const [what, ask] of asks) {
				const other = await told(ask("private-other", caller), "private-other");
				const missing = await told(ask("no-such-project", caller), "no-such-project");
				expect(`${what}: ${other}`).toBe(`${what}: ${missing}`);
				expect(other).toStartWith("404 ");
			}
		}
		const stream = await fetch(`${instance.url}/api/p/private-other/events`, { headers: reader });
		expect(await stream.text()).toBe(
			'{"ok":false,"error":{"code":"not_found","message":"no project named private-other, or no grant on it"}}',
		);
		// Where a caller holds a grant and lacks the capability, it is told which one it lacks, as before.
		expect((await fetch(`${instance.url}/api/p/scratch/events`, { headers: ci })).status).toBe(403);
		expect((await post(instance, "/api/p/scratch/find", {}, ci)).body).toMatchObject({
			ok: false,
			error: { code: "forbidden", message: "find needs the read capability on scratch" },
		});
		expect((await post(instance, "/api/p/scratch/propose", { edits: [] }, reader)).body).toMatchObject({
			ok: false,
			error: { code: "forbidden" },
		});
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

describe("/healthz and the commit", () => {
	const SHA = "2f6b67e1ac063e6ac29c9fe45fdae07137b81c76";

	/** Asks `/healthz` of a server whose configuration was read from `env`, as `mainworthy serve` reads it. */
	async function healthz(env: Record<string, string>): Promise<unknown> {
		const dataDir = mkdtempSync(join(tmpdir(), "mainworthy-http-healthz-"));
		dirs.push(dataDir);
		const config = defaultConfig({ MAINWORTHY_DATA: dataDir, MAINWORTHY_PORT: "0", MAINWORTHY_OWNER: "robin", ...env });
		// No reader threads: this route does not read a project, and the loop below starts one server per value.
		const instance = start(config, () => ({ ui: null }), { readers: 0 });
		try {
			const response = await fetch(`${instance.url}/healthz`);
			expect(response.status).toBe(200);
			return await response.json();
		} finally {
			await instance.stop();
		}
	}

	test("it names the commit the process was told, with no sign-in", async () => {
		expect(await healthz({ MAINWORTHY_COMMIT: SHA })).toEqual({ ok: true, version: "0.1.0", commit: SHA });
	});

	test("it says null when no commit is known", async () => {
		expect(await healthz({})).toEqual({ ok: true, version: "0.1.0", commit: null });
		expect(await healthz({ MAINWORTHY_COMMIT: "" })).toEqual({ ok: true, version: "0.1.0", commit: null });
	});

	test("MAINWORTHY_COMMIT wins over SOURCE_COMMIT, which Coolify sets, and an unusable first value falls through", async () => {
		const other = "0123456789abcdef0123456789abcdef01234567";
		expect(await healthz({ MAINWORTHY_COMMIT: SHA, SOURCE_COMMIT: other })).toMatchObject({ commit: SHA });
		expect(await healthz({ SOURCE_COMMIT: other })).toMatchObject({ commit: other });
		// The image bakes an empty MAINWORTHY_COMMIT when it was built without the argument.
		expect(await healthz({ MAINWORTHY_COMMIT: "", SOURCE_COMMIT: other })).toMatchObject({ commit: other });
	});

	test("it never echoes a value that is not exactly 40 lower-case hexadecimal characters", async () => {
		const refused = [
			"HEAD",
			"unknown",
			SHA.toUpperCase(),
			`${SHA.slice(0, 39)}F`,
			`${SHA.slice(0, 39)}g`,
			`${SHA}0`,
			SHA.slice(0, 39),
			SHA.slice(0, 12),
			` ${SHA}`,
			`${SHA}\n`,
			"<script>alert(1)</script>",
		];
		for (const value of refused) {
			expect(await healthz({ MAINWORTHY_COMMIT: value })).toEqual({ ok: true, version: "0.1.0", commit: null });
			expect(await healthz({ SOURCE_COMMIT: value })).toEqual({ ok: true, version: "0.1.0", commit: null });
		}
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

describe("a connection that sends nothing", () => {
	test("is closed after the idle time, and a change stream outlives it", async () => {
		// One second here; three minutes on a server nobody configured. Bun counts idle time in steps of four seconds, so
		// one second is over within five.
		const instance = boot("local", null, undefined, { patience: { idleSeconds: 1, signInBodyMs: 5000 } });
		const host = `Host: ${new URL(instance.url).host}\r\n`;
		const idle = wire(instance, `GET /healthz HTTP/1.1\r\n${host}\r\n`);
		const stream = wire(instance, `GET /api/p/scratch/events HTTP/1.1\r\n${host}\r\n`);
		try {
			expect(await idle.within(7000)).toBe("closed");
			// It had been answered: a connection kept open after its request, not one that was refused.
			expect(idle.state.received).toContain('{"ok":true,"version":');
			// The stream sent its first line when it opened and nothing since: its next heartbeat is 20 s away.
			await Bun.sleep(200);
			expect([stream.state.closed, stream.state.received.includes("retry: 2000")]).toEqual([false, true]);
			await post(instance, "/api/p/scratch/propose", { edits: [{ op: "create", outline: "After the idle time" }] });
			for (let waited = 0; !stream.state.received.includes("data:") && waited < 2000; waited += 20) await Bun.sleep(20);
			expect(stream.state.received).toContain('"op":"propose"');
		} finally {
			idle.end();
			stream.end();
		}
	}, 15_000);

	test("the idle time is for a connection nobody has vouched for: an authenticated request's reply may take longer, and a wrong token's connection is closed", async () => {
		// The idle time counts the server's own silence too. A write that waits at the gate behind a long report, a
		// large report on a slow machine, a tool call: each may answer after it, and must not lose its reply.
		const instance = boot("server", "owner-secret-0123456789", undefined, {
			patience: { idleSeconds: 1, signInBodyMs: 5000 },
		});
		const host = `Host: ${new URL(instance.url).host}\r\n`;
		const refused = wire(
			instance,
			`POST /api/p/scratch/find HTTP/1.1\r\n${host}Authorization: Bearer wrong-token-0123456789\r\n` +
				"Content-Type: application/json\r\nContent-Length: 2\r\n\r\n{}",
		);
		// The gate is held until the idle time has provably passed: until the refused connection, silent since the
		// same moment as the write below, has been closed for it.
		const held = instance.app.gate.run(async () => {
			const silent = await refused.within(7000);
			await Bun.sleep(300);
			return silent;
		});
		// Two writes that wait at that gate, on plain sockets: what comes back is what the server sent, where a
		// client library may send a request again when its connection is closed. One has a body and one has none
		// (`curl -X POST` with no data): Bun 1.4.3 holds only a request with no body to the idle time while its
		// handler works, and the rule must not rest on that.
		const owner = `${host}Authorization: Bearer owner-secret-0123456789\r\n`;
		const create = JSON.stringify({ edits: [{ op: "create", outline: "Answered after the idle time" }] });
		const write = wire(
			instance,
			`POST /api/p/scratch/propose HTTP/1.1\r\n${owner}Content-Type: application/json\r\n` +
				`Content-Length: ${Buffer.byteLength(create)}\r\n\r\n${create}`,
		);
		const bare = wire(instance, `POST /api/p/scratch/propose HTTP/1.1\r\n${owner}Content-Length: 0\r\n\r\n`);
		/** The status line of the reply on this socket, once its body has begun; or that there is none. */
		const reply = async (socket: ReturnType<typeof wire>): Promise<string> => {
			const answered = () => socket.state.received.includes("\r\n\r\n{");
			for (let waited = 0; waited < 3000 && !answered() && !socket.state.closed; waited += 20) await Bun.sleep(20);
			return answered() ? (socket.state.received.split("\r\n")[0] ?? "") : "closed with no reply";
		};
		try {
			expect(await held).toBe("closed");
			// It had been answered, and refused: no session, so nothing took the idle time off its connection.
			expect(refused.state.received.split("\r\n")[0]).toBe("HTTP/1.1 401 Unauthorized");
			// The write with no body is refused for its input, after the wait: a reply, which is the point.
			expect([await reply(write), await reply(bare)]).toEqual(["HTTP/1.1 200 OK", "HTTP/1.1 400 Bad Request"]);
			expect(write.state.received).toContain('"status":"adopted"');
			expect(bare.state.received).toContain('"code":"invalid"');
		} finally {
			refused.end();
			write.end();
			bare.end();
			await held;
		}
	}, 15_000);

	test("the body of a sign-in has a few seconds to arrive, then the request is answered and the connection closed", async () => {
		// 300 ms here; five seconds on a server nobody configured. The body is ten bytes of the 4000 it announced.
		const instance = boot("server", "owner-secret-0123456789", undefined, {
			patience: { idleSeconds: 30, signInBodyMs: 300 },
		});
		const host = `Host: ${new URL(instance.url).host}\r\n`;
		const stalled = wire(
			instance,
			`POST /api/login HTTP/1.1\r\n${host}Content-Type: application/json\r\nContent-Length: 4000\r\n\r\n{"token":"`,
		);
		try {
			expect(await stalled.within(3000)).toBe("closed");
			expect(stalled.state.received.split("\r\n")[0]).toBe("HTTP/1.1 408 Request Timeout");
			expect(stalled.state.received).not.toContain("set-cookie");
		} finally {
			stalled.end();
		}
		// A sign-in that arrives whole is not held to anything new.
		expect((await post(instance, "/api/login", { token: "owner-secret-0123456789" })).status).toBe(200);
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
