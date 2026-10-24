import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { type TestDatabase, testDatabase } from "../../test/db.ts";
import { type Instance, start, startServing } from "../app/start.ts";
import { API_VERSION, VERSION } from "../core/version.ts";
import { defaultConfig } from "../server/kernel/app.ts";
import { contentSecurityPolicy } from "../surfaces/headers.ts";
import { PATIENCE } from "../surfaces/http.ts";
import { Client } from "./client.ts";
import { verifyLockdownStatus } from "./lockdown.ts";
import { CLI_ENTRY, COMMIT, inThisProcess, withInstance } from "./test-support.ts";

/**
 * What a start in server mode says when the environment names no proxy: one line on stderr, once. A start in
 * local mode does not say it, and neither does one with the two variables set (`BEHIND_PROXY`).
 */
const NO_PROXY_NAMED =
	"mainworthy: MAINWORTHY_TRUSTED_PROXY and MAINWORTHY_CLIENT_ADDRESS_HEADER are not set: a failed sign-in from a loopback or private address, which behind a proxy is every visitor's, is not counted against that address, only against the first 8 characters of the token it tried. docs/deploy.md says how to set the two.\n";
/** The two variables, for a start that is about something else and should have nothing to say about the limit. */
const BEHIND_PROXY = { MAINWORTHY_TRUSTED_PROXY: "10.0.0.1", MAINWORTHY_CLIENT_ADDRESS_HEADER: "x-real-ip" };

const databases: TestDatabase[] = [];
async function fixtureUrl(): Promise<string> {
	const db = await testDatabase();
	databases.push(db);
	return db.url;
}
afterEach(async () => {
	for (const db of databases.splice(0)) await db.close();
});

test("startup requires a database URL and names compose.yaml", async () => {
	await expect(start(defaultConfig({ MAINWORTHY_PORT: "0" }), () => ({ ui: null }))).rejects.toThrow(
		"MAINWORTHY_DATABASE_URL is required; see compose.yaml",
	);
});

test("startup migrates an empty PostgreSQL database before creating its first project", async () => {
	const db = await testDatabase({ schema: "empty" });
	databases.push(db);
	const directory = await mkdtemp(join(tmpdir(), "mainworthy-pg-start-"));
	const instance = await startServing(
		defaultConfig({
			MAINWORTHY_DATABASE_URL: db.url,
			MAINWORTHY_DATA: directory,
			MAINWORTHY_PORT: "0",
			MAINWORTHY_OWNER: "robin",
		}),
		() => ({ ui: null }),
	);
	try {
		expect((await fetch(`${instance.url}/healthz`)).status).toBe(200);
		expect(
			await new Client({ url: instance.url, token: undefined, project: "scratch" }).call("find", {}),
		).toMatchObject({ items: [] });
	} finally {
		await instance.stop();
		await rm(directory, { recursive: true, force: true });
	}
});

test.each([
	{ form: "trailing space", replacement: "replacement-owner-secret-0123456789 " },
	{ form: "emoji", replacement: "replacement-owner-secret-0123456789🔑" },
])(
	"an owner token rotation to $form refuses startup and preserves the previous token and session",
	async ({ replacement }) => {
		const token = "original-owner-secret-0123456789";
		await withInstance(
			async ({ instance, cli, run }) => {
				const login = await fetch(`${instance.url}/api/login`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ token }),
				});
				expect(login.status).toBe(200);
				const cookie = login.headers.get("set-cookie")?.split(";")[0];
				if (!cookie) throw new Error("the sign-in returned no session cookie");
				const before = await cli(["find", "--compact"], { env: { MAINWORTHY_TOKEN: token } });
				expect([before.code, before.stderr, JSON.parse(before.stdout).items]).toEqual([0, "", []]);
				const config = { ...instance.app.config };
				await instance.stop();
				const attempted: Instance[] = [];
				try {
					await expect(async () => {
						attempted.push(await start({ ...config, ownerToken: replacement }, () => ({ ui: null })));
					}).toThrow("MAINWORTHY_OWNER_TOKEN must contain only visible ASCII characters without spaces");
				} finally {
					for (const started of attempted) await started.stop();
				}
				const restarted = await start(config, () => ({ ui: null }));
				try {
					for (const headers of [{ authorization: `Bearer ${token}` }, { cookie }]) {
						const session = await fetch(`${restarted.url}/api/session`, { headers });
						expect(session.status).toBe(200);
						expect(await session.json()).toMatchObject({ ok: true, result: { actor: "robin" } });
					}
					const after = await run(["find", "--compact"], {
						env: { MAINWORTHY_URL: restarted.url, MAINWORTHY_TOKEN: token },
					});
					expect([after.code, after.stderr, JSON.parse(after.stdout).items]).toEqual([0, "", []]);
					const refused = await fetch(`${restarted.url}/api/login`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ token: replacement }),
					});
					expect(refused.status).toBe(401);
				} finally {
					await restarted.stop();
				}
			},
			{ mode: "server", env: { MAINWORTHY_OWNER_TOKEN: token } },
		);
	},
);

test("every visible ASCII character in a configured owner token works at login, as a bearer and through the CLI", async () => {
	const token = Array.from({ length: 94 }, (_, index) => String.fromCharCode(index + 33)).join("");
	await withInstance(
		async ({ instance, cli }) => {
			const login = await fetch(`${instance.url}/api/login`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ token }),
			});
			expect(login.status).toBe(200);
			const session = await fetch(`${instance.url}/api/session`, { headers: { authorization: `Bearer ${token}` } });
			expect(session.status).toBe(200);
			expect(await session.json()).toMatchObject({ ok: true, result: { actor: "robin" } });
			const found = await cli(["find", "--compact"], { env: { MAINWORTHY_TOKEN: token } });
			expect([found.code, found.stderr, JSON.parse(found.stdout).items]).toEqual([0, "", []]);
		},
		{ mode: "server", env: { MAINWORTHY_OWNER_TOKEN: token } },
	);
});

test("version loads its adapter without starting other command implementations", async () => {
	const child = Bun.spawn(
		[
			process.execPath,
			"--eval",
			`const { runCli } = await import(${JSON.stringify(new URL("./dispatch.ts", import.meta.url).href)});
			const code = await runCli(["version"], undefined);
			const loaded = Object.keys(require.cache);
			process.stdout.write(JSON.stringify({ code, adapters: loaded
				.filter(path => path.includes("/cli/commands/") && path.endsWith(".ts"))
				.map(path => path.split("/").at(-1)).sort(),
				runtimes: loaded.filter(path => path.includes("/@modelcontextprotocol/")
					|| path.endsWith("/surfaces/http.ts") || path.endsWith("/cli/demo.ts")) }) + "\\n");`,
		],
		{ env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe", timeout: 4000 },
	);
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect({ stdout, stderr, code }).toEqual({
		stdout: `Mainworthy ${VERSION} (API ${API_VERSION})\n{"code":0,"adapters":["version.ts"],"runtimes":[]}\n`,
		stderr: "",
		code: 0,
	});
});

for (const options of [
	{ argv: [], mode: "local", signal: "SIGTERM" },
	{ argv: ["serve"], mode: "local", signal: "SIGINT" },
	{ argv: ["serve"], mode: "server", signal: "SIGTERM" },
] satisfies { argv: string[]; mode: string; signal: "SIGTERM" | "SIGINT" }[]) {
	test(`${options.argv.length ? "serve" : "no arguments"} starts ${options.mode}, serves UI/routes, and stops on ${options.signal}`, async () => {
		await withInstance(async ({ directory }) => {
			const child = Bun.spawn([process.execPath, CLI_ENTRY, ...options.argv], {
				cwd: directory,
				env: {
					PATH: process.env.PATH ?? "",
					MAINWORTHY_DATABASE_URL: await fixtureUrl(),
					HOME: directory,
					USER: "robin",
					MAINWORTHY_PORT: "0",
					MAINWORTHY_MODE: options.mode,
				},
				stdout: "pipe",
				stderr: "pipe",
				stdin: "ignore",
			});
			const timeout = setTimeout(() => child.kill("SIGKILL"), 4000);
			const reader = child.stdout.getReader();
			const decoder = new TextDecoder();
			let stdout = "";
			try {
				while (stdout.trim().split("\n").length < (options.mode === "server" ? 3 : 2)) {
					const chunk = await reader.read();
					if (chunk.done) break;
					stdout += decoder.decode(chunk.value, { stream: true });
				}
				expect(stdout).toMatch(
					/^Mainworthy 0\.1\.0 · (local|server) · data in ~\/\.mainworthy · http:\/\/127\.0\.0\.1:\d+\n/,
				);
				expect(stdout).toContain(
					options.mode === "server"
						? 'project "scratch" · owner robin · sign in with a token, a password or a passkey · policy: loose'
						: 'project "scratch" · you are robin@this-machine · policy: loose',
				);
				const url = /http:\/\/127\.0\.0\.1:\d+/.exec(stdout)?.[0];
				if (!url) throw new Error("startup did not print the server URL");
				const token = /owner token \(shown once\): (\S+)/.exec(stdout)?.[1];
				expect(Boolean(token)).toBe(options.mode === "server");
				const headers = token ? { authorization: `Bearer ${token}` } : {};
				expect((await fetch(`${url}/`)).status).toBe(200);
				const archive = await fetch(`${url}/api/export`, { headers });
				expect(archive.status).toBe(200);
				expect(await archive.text()).toContain('"mainworthy":"archive"');
				const mcp = await fetch(`${url}/mcp`, {
					method: "POST",
					headers: { ...headers, "content-type": "application/json", accept: "application/json, text/event-stream" },
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: 1,
						method: "initialize",
						params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "cli-test", version: "1" } },
					}),
				});
				expect(mcp.status).toBe(200);
				expect(await mcp.text()).toContain("protocolVersion");
				child.kill(options.signal);
				expect(await child.exited).toBe(0);
				while (true) {
					const chunk = await reader.read();
					if (chunk.done) break;
					stdout += decoder.decode(chunk.value, { stream: true });
				}
				expect(stdout.trim().split("\n")).toHaveLength(options.mode === "server" ? 3 : 2);
				const stderr = await new Response(child.stderr).text();
				expect(stderr.replace(/^Bundled page in [\d.]+(?:ms|s): .+\n/gm, "")).toBe(
					options.mode === "server" ? NO_PROXY_NAMED : "",
				);
			} finally {
				clearTimeout(timeout);
				child.kill("SIGKILL");
				await child.exited;
				reader.releaseLock();
			}
		});
	});
}

// Issue #120. `bun run start` is what the README's first lines tell a reader to run and leave running. Without
// `NODE_ENV=production` it served Bun's development bundle: an inline script, a reload socket, the looser policy.
test("bun run start serves the built bundle under the strict page policy, as the executable does", async () => {
	const home = await mkdtemp(join(tmpdir(), "mainworthy-start-"));
	// Nothing of this process's environment but the path: the script itself has to say which bundle it wants.
	const child = Bun.spawn([process.execPath, "run", "start"], {
		cwd: join(import.meta.dir, "../.."),
		env: {
			PATH: process.env.PATH ?? "",
			MAINWORTHY_DATABASE_URL: await fixtureUrl(),
			HOME: home,
			USER: "robin",
			MAINWORTHY_PORT: "0",
		},
		stdout: "pipe",
		stderr: "ignore",
		stdin: "ignore",
	});
	const timeout = setTimeout(() => child.kill("SIGKILL"), 8000);
	const reader = child.stdout.getReader();
	const decoder = new TextDecoder();
	let stdout = "";
	try {
		while (stdout.trim().split("\n").length < 2) {
			const chunk = await reader.read();
			if (chunk.done) break;
			stdout += decoder.decode(chunk.value, { stream: true });
		}
		const url = /http:\/\/127\.0\.0\.1:\d+/.exec(stdout)?.[0];
		if (!url) throw new Error(`bun run start did not print the server URL: ${stdout}`);
		const page = await fetch(`${url}/`);
		expect(page.status).toBe(200);
		expect(page.headers.get("content-security-policy")).toBe(contentSecurityPolicy({ kind: "page" }));
		// Every script of the built page is a file. The development page has one written into it, and names its socket.
		const html = await page.text();
		expect(html).toMatch(/<script\b[^>]*\bsrc="/);
		expect(html).not.toMatch(/<script\b(?![^>]*\bsrc=)/);
		expect(html).not.toContain("/_bun/hmr");
	} finally {
		// `bun run` passes the signal on to the server it started, which a kill would leave running.
		child.kill("SIGTERM");
		const code = await child.exited;
		clearTimeout(timeout);
		reader.releaseLock();
		await rm(home, { recursive: true, force: true });
		expect(code).toBe(0);
	}
}, 10_000);

// What `bun run dev` runs. Under `--watch` Bun's file watcher keeps the process alive after the server has stopped, so a
// command that only waits for its event loop to empty never exits (SIGTERM or SIGINT alike).
for (const signal of ["SIGTERM", "SIGINT"] as const) {
	test(`serve under bun --watch exits on ${signal}, with an event stream open`, async () => {
		const home = await mkdtemp(join(tmpdir(), "mainworthy-watch-"));
		const child = Bun.spawn([process.execPath, "--watch", CLI_ENTRY, "serve"], {
			cwd: home,
			env: {
				PATH: process.env.PATH ?? "",
				MAINWORTHY_DATABASE_URL: await fixtureUrl(),
				HOME: home,
				USER: "robin",
				MAINWORTHY_PORT: "0",
			},
			stdout: "pipe",
			stderr: "ignore",
			stdin: "ignore",
		});
		const reader = child.stdout.getReader();
		const decoder = new TextDecoder();
		let stdout = "";
		try {
			while (!stdout.includes("policy:")) {
				const chunk = await reader.read();
				if (chunk.done) break;
				stdout += decoder.decode(chunk.value, { stream: true });
			}
			const url = /http:\/\/127\.0\.0\.1:\d+/.exec(stdout)?.[0];
			if (!url) throw new Error(`startup did not print the server URL: ${stdout}`);
			// An answered request proves the signal handlers are installed. The stream is left open: a stop that waits
			// for open streams would never come.
			const events = await fetch(`${url}/api/p/scratch/events`);
			expect(events.status).toBe(200);
			child.kill(signal);
			const outcome = await Promise.race([child.exited, Bun.sleep(5000).then(() => "still running after 5 s")]);
			expect(outcome).toBe(0);
			await events.body?.cancel().catch(() => undefined);
		} finally {
			child.kill("SIGKILL");
			await child.exited;
			reader.releaseLock();
			await rm(home, { recursive: true, force: true });
		}
	}, 15_000);
}

test("a start says when the configured owner token is not the owner's, and refuses an owner name that is not a person's", async () => {
	const databaseUrl = await fixtureUrl();
	const home = await mkdtemp(join(tmpdir(), "mainworthy-owner-cli-"));
	// Long enough that the start has nothing to say about its length (32 characters or more).
	const OWNER = "owner-secret-0123456789abcdef-012345";
	/** Starts the server with these variables. If it comes up, runs `during` against it and stops it. */
	const serve = async (
		env: Record<string, string>,
		during: (url: string) => Promise<void> = async () => {},
	): Promise<{ code: number; stdout: string; stderr: string }> => {
		const child = Bun.spawn([process.execPath, CLI_ENTRY, "serve"], {
			cwd: home,
			env: {
				PATH: process.env.PATH ?? "",
				MAINWORTHY_DATABASE_URL: databaseUrl,
				HOME: home,
				USER: "robin",
				MAINWORTHY_PORT: "0",
				MAINWORTHY_MODE: "server",
				...BEHIND_PROXY,
				...env,
			},
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
		});
		const timeout = setTimeout(() => child.kill("SIGKILL"), 8000);
		const reader = child.stdout.getReader();
		const decoder = new TextDecoder();
		let stdout = "";
		const read = async (until: () => boolean): Promise<void> => {
			while (!until()) {
				const chunk = await reader.read();
				if (chunk.done) break;
				stdout += decoder.decode(chunk.value, { stream: true });
			}
		};
		try {
			await read(() => stdout.includes("policy:"));
			const url = /http:\/\/127\.0\.0\.1:\d+/.exec(stdout)?.[0];
			if (url) {
				// An answered request proves the signal handlers are installed (see the test above).
				expect((await fetch(`${url}/healthz`)).status).toBe(200);
				await during(url);
				child.kill("SIGTERM");
			}
			const code = await child.exited;
			await read(() => false);
			const stderr = await new Response(child.stderr).text();
			return { code, stdout, stderr: stderr.replace(/^Bundled page in [\d.]+(?:ms|s): .+\n/gm, "") };
		} finally {
			clearTimeout(timeout);
			child.kill("SIGKILL");
			await child.exited;
			reader.releaseLock();
		}
	};
	try {
		const config = defaultConfig({
			MAINWORTHY_DATABASE_URL: databaseUrl,
			HOME: home,
			MAINWORTHY_OWNER: "robin",
			MAINWORTHY_OWNER_TOKEN: OWNER,
			MAINWORTHY_PORT: "0",
			MAINWORTHY_MODE: "server",
			...BEHIND_PROXY,
		});
		const initial = await start(config, () => ({ ui: null }));
		let helper: string;
		try {
			const client = new Client({ url: initial.url, token: OWNER, project: "scratch" });
			helper = z
				.object({ token: z.string() })
				.parse(await client.call("admin", { do: "token.create", actor: "helper", kind: "agent" })).token;
		} finally {
			await initial.stop();
		}
		// The variable now holds a token that is the agent's. The server starts, and says what is wrong with it.
		let owner = 0;
		const second = await serve({ MAINWORTHY_OWNER_TOKEN: helper }, async (url) => {
			owner = (await fetch(`${url}/api/session`, { headers: { authorization: `Bearer ${OWNER}` } })).status;
		});
		expect([second.code, owner]).toEqual([0, 200]);
		expect(second.stdout).not.toContain("owner token");
		expect(second.stderr).toBe(
			"mainworthy: MAINWORTHY_OWNER_TOKEN is the token of helper, not of the owner robin: it does not sign robin in, and it was left as it is. Set MAINWORTHY_OWNER_TOKEN to a new value and start again.\n",
		);
		expect(second.stderr).not.toContain(helper);

		// The owner's name now names the agent. Nothing is granted and nothing listens.
		const third = await inThisProcess(
			"invalid owner",
			async () => {
				const invalid = await start({ ...config, owner: "helper" }, () => ({ ui: null }));
				await invalid.stop();
				return 0;
			},
			{ environment: { PATH: process.env.PATH ?? "" }, cwd: home, input: "" },
		);
		expect([third.code, third.stdout]).toEqual([4, ""]);
		expect(third.stderr).toBe(
			"invalid: MAINWORTHY_OWNER names helper, which is an agent on this instance and not a person. Set MAINWORTHY_OWNER to the owner's name and start again; no actor and no token was changed (the database may have been brought to this build's schema first)\n",
		);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("an occupied port exits 4 without keeping the failed server alive", async () => {
	await withInstance(async ({ directory, instance }) => {
		const child = Bun.spawn([process.execPath, CLI_ENTRY, "serve"], {
			cwd: directory,
			env: {
				PATH: process.env.PATH ?? "",
				MAINWORTHY_DATABASE_URL: await fixtureUrl(),
				HOME: directory,
				USER: "robin",
				MAINWORTHY_PORT: new URL(instance.url).port,
				MAINWORTHY_DATA: join(directory, "failed-start"),
			},
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
			// Only stop a hung command; refusing a port is not a startup latency budget.
			timeout: 30_000,
			killSignal: "SIGKILL",
		});
		try {
			const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
			expect(code).toBe(4);
			expect(stderr).toContain("port");
			expect(stderr.trim().split("\n")).toHaveLength(1);
		} finally {
			child.kill("SIGKILL");
			await child.exited;
		}
	});
}, 35_000);

test("a session lifetime that is not a duration stops the start with one line that names the variable", async () => {
	const directory = await mkdtemp(join(tmpdir(), "mainworthy-lifetime-"));
	const child = Bun.spawn([process.execPath, CLI_ENTRY, "serve"], {
		cwd: directory,
		env: {
			PATH: process.env.PATH ?? "",
			MAINWORTHY_DATABASE_URL: await fixtureUrl(),
			HOME: directory,
			USER: "robin",
			MAINWORTHY_PORT: "0",
			MAINWORTHY_SESSION_IDLE: "two weeks",
		},
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
	});
	const timeout = setTimeout(() => child.kill("SIGKILL"), 4000);
	try {
		const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		expect(code).toBe(4);
		expect(stderr.trim()).toBe(
			'invalid: MAINWORTHY_SESSION_IDLE is "two weeks", which is not a duration: write a whole number from 1 to 9999 and h, d or w, like 12h, 14d or 2w',
		);
		// It stopped before it opened anything: no instance was made to run with a lifetime nobody chose.
		expect(existsSync(join(directory, ".mainworthy"))).toBe(false);
	} finally {
		clearTimeout(timeout);
		child.kill("SIGKILL");
		await child.exited;
		await rm(directory, { recursive: true, force: true });
	}
});

test("a consumer closing stdout produces no stack trace or failed-gate exit", async () => {
	await withInstance(async ({ directory, instance, client }) => {
		await client.call("propose", {
			edits: Array.from({ length: 180 }, (_, index) => ({
				op: "create",
				outline: `Case ${index}\nAn action > Expected`,
			})),
		});
		const child = Bun.spawn(
			[
				"bash",
				"-o",
				"pipefail",
				"-c",
				'"$1" "$2" find --limit 500 | head -3',
				"pipe-test",
				process.execPath,
				CLI_ENTRY,
			],
			{
				cwd: directory,
				env: {
					PATH: process.env.PATH ?? "",
					MAINWORTHY_DATABASE_URL: await fixtureUrl(),
					HOME: directory,
					MAINWORTHY_URL: instance.url,
				},
				stdout: "pipe",
				stderr: "pipe",
				stdin: "ignore",
			},
		);
		const [code, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(code).toBe(0);
		expect(stdout.trim().split("\n")).toHaveLength(3);
		expect(stderr).toBe("");
	});
});

test("the source entry runs directly through its shebang", async () => {
	await withInstance(async ({ directory, instance }) => {
		const child = Bun.spawn([CLI_ENTRY, "open"], {
			cwd: directory,
			env: {
				PATH: process.env.PATH ?? "",
				MAINWORTHY_DATABASE_URL: await fixtureUrl(),
				HOME: directory,
				MAINWORTHY_URL: instance.url,
			},
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
		});
		expect(await child.exited).toBe(0);
		expect(await new Response(child.stdout).text()).toBe(`${instance.url}\n`);
	});
});

test("closing a gate's stdout preserves pending, blocked, failed and passed exits", async () => {
	await withInstance(async ({ directory, instance, client }) => {
		const pipeGate = async (commit: string): Promise<number> => {
			// `true` reads nothing and ends, which closes the pipe before the gate writes. It was `head -0`, which
			// GNU head takes and BSD head refuses ("illegal line count -- 0"), so the test failed on macOS (issue #103).
			const child = Bun.spawn(
				[
					"bash",
					"-o",
					"pipefail",
					"-c",
					'"$1" "$2" gate --commit "$3" | true',
					"pipe-test",
					process.execPath,
					CLI_ENTRY,
					commit,
				],
				{
					cwd: directory,
					env: {
						PATH: process.env.PATH ?? "",
						MAINWORTHY_DATABASE_URL: await fixtureUrl(),
						HOME: directory,
						MAINWORTHY_URL: instance.url,
					},
					stdout: "pipe",
					stderr: "pipe",
					stdin: "ignore",
				},
			);
			const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
			expect(stderr).toBe("");
			return code;
		};
		expect(await pipeGate(COMMIT)).toBe(3);
		await client.call("report", {
			target: { commit: COMMIT },
			results: [{ test: { key: "failing" }, outcome: "fail", failure: { message: "failed" } }],
		});
		expect(await pipeGate(COMMIT)).toBe(2);
		const question = (await client.call("inbox", { kind: "failure" })).items[0];
		if (!question) throw new Error("no failure question");
		await client.call("decide", { q: question.q, onEvidence: question.evidenceHash, answer: { is: "defect" } });
		expect(await pipeGate(COMMIT)).toBe(1);
		const passed = "abcdef0123456789012345678901234567890123456";
		await client.call("report", {
			target: { commit: passed },
			results: [{ test: { key: "passing" }, outcome: "pass" }],
		});
		expect(await pipeGate(passed)).toBe(0);
	});
});

const lockedStatus = [
	"Uid:\t10001\t10001\t10001\t10001",
	"Gid:\t10001\t10001\t10001\t10001",
	"Groups:\t ",
	...["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"].map((field) => `${field}:\t0000000000000000`),
	"NoNewPrivs:\t1",
].join("\n");

test("lockdown accepts only the unprivileged application identity", () => {
	expect(() => verifyLockdownStatus(lockedStatus)).not.toThrow();
	for (const field of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"]) {
		expect(() =>
			verifyLockdownStatus(lockedStatus.replace(`${field}:\t0000000000000000`, `${field}:\t0000000000000100`)),
		).toThrow(field);
		expect(() => verifyLockdownStatus(lockedStatus.replace(new RegExp(`^${field}:.*$`, "m"), ""))).toThrow(field);
	}
	for (const field of ["Uid", "Gid"]) {
		for (let slot = 0; slot < 4; slot++) {
			const ids = [10001, 10001, 10001, 10001];
			ids[slot] = 0;
			expect(() =>
				verifyLockdownStatus(lockedStatus.replace(new RegExp(`^${field}:.*$`, "m"), `${field}:\t${ids.join("\t")}`)),
			).toThrow(field);
		}
	}
	for (const replacement of ["Groups:\t10001", "NoNewPrivs:\t0"]) {
		const field = replacement.split(":")[0];
		expect(() => verifyLockdownStatus(lockedStatus.replace(new RegExp(`^${field}:.*$`, "m"), replacement))).toThrow();
	}
	expect(() => verifyLockdownStatus("")).toThrow();
});

test("the upgrading listener retains the caller's idle timeout after installing app routes", async () => {
	const directory = await mkdtemp(join(tmpdir(), "mainworthy-upgrading-idle-"));
	const instance = await startServing(
		defaultConfig({
			MAINWORTHY_DATABASE_URL: await fixtureUrl(),
			MAINWORTHY_DATA: directory,
			MAINWORTHY_PORT: "0",
			MAINWORTHY_OWNER: "robin",
		}),
		() => ({ ui: null }),
		{ patience: { ...PATIENCE, idleSeconds: 1 } },
	);
	const closed = Promise.withResolvers<void>();
	let received = "";
	const address = new URL(instance.url);
	const socket = connect(Number(address.port), "127.0.0.1");
	socket.on("connect", () => socket.write(`GET /healthz HTTP/1.1\r\nHost: ${address.host}\r\n\r\n`));
	socket.on("data", (data) => {
		received += data.toString();
	});
	socket.once("error", closed.reject);
	socket.once("close", () => closed.resolve());
	const deadline = setTimeout(() => closed.reject(new Error("the configured idle timeout was ignored")), 7000);
	try {
		await closed.promise;
		expect(received).toContain('"ok":true');
	} finally {
		clearTimeout(deadline);
		socket.destroy();
		await instance.stop();
		await rm(directory, { recursive: true, force: true });
	}
}, 12_000);

test("a failing listening callback closes liveness", async () => {
	const directory = await mkdtemp(join(tmpdir(), "mainworthy-listening-failed-"));
	let url = "";
	let opened: Instance | undefined;
	try {
		const starting = startServing(
			defaultConfig({ MAINWORTHY_DATABASE_URL: await fixtureUrl(), MAINWORTHY_DATA: directory, MAINWORTHY_PORT: "0" }),
			() => ({ ui: null }),
			{
				onListening: (bound) => {
					url = bound;
					throw new Error("listening callback failed");
				},
			},
		);
		await expect(
			starting.then((instance) => {
				opened = instance;
			}),
		).rejects.toThrow("listening callback failed");
		expect(Number(new URL(url).port)).toBeGreaterThan(0);
		await expect(fetch(`${url}/healthz`)).rejects.toThrow();
	} finally {
		await opened?.stop();
		await rm(directory, { recursive: true, force: true });
	}
});
