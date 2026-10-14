import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { contentSecurityPolicy } from "../surfaces/headers.ts";
import { CLI_ENTRY, COMMIT, withInstance } from "./test-support.ts";

/**
 * What a start in server mode says when the environment names no proxy: one line on stderr, once. A start in
 * local mode does not say it, and neither does one with the two variables set (`BEHIND_PROXY`).
 */
const NO_PROXY_NAMED =
	"mainworthy: MAINWORTHY_TRUSTED_PROXY and MAINWORTHY_CLIENT_ADDRESS_HEADER are not set: a failed sign-in from a loopback or private address, which behind a proxy is every visitor's, is not counted against that address, only against the first 8 characters of the token it tried. docs/deploy.md says how to set the two.\n";
/** The two variables, for a start that is about something else and should have nothing to say about the limit. */
const BEHIND_PROXY = { MAINWORTHY_TRUSTED_PROXY: "10.0.0.1", MAINWORTHY_CLIENT_ADDRESS_HEADER: "x-real-ip" };

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
		env: { PATH: process.env.PATH ?? "", HOME: home, USER: "robin", MAINWORTHY_PORT: "0" },
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

test("an install under the former name is carried over on the next start, and its owner token still works", async () => {
	const home = await mkdtemp(join(tmpdir(), "mainworthy-former-cli-"));
	/** Starts the server in `home`, waits for its two start lines, and returns how to stop it and read its output. */
	const serve = async (): Promise<{
		url: string;
		stop: () => Promise<{ code: number; stdout: string; stderr: string }>;
	}> => {
		const child = Bun.spawn([process.execPath, CLI_ENTRY, "serve"], {
			cwd: home,
			env: {
				PATH: process.env.PATH ?? "",
				HOME: home,
				USER: "robin",
				MAINWORTHY_PORT: "0",
				MAINWORTHY_MODE: "server",
				...BEHIND_PROXY,
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
		await read(() => stdout.includes("policy:"));
		const url = /http:\/\/127\.0\.0\.1:\d+/.exec(stdout)?.[0];
		if (!url) throw new Error(`startup did not print the server URL: ${stdout}`);
		// The command installs its signal handlers after it prints these lines. An answered request proves it has
		// returned to the event loop, so a SIGTERM from here on is handled, not fatal (exit 143).
		expect((await fetch(`${url}/healthz`)).status).toBe(200);
		return {
			url,
			async stop() {
				child.kill("SIGTERM");
				const code = await child.exited;
				clearTimeout(timeout);
				await read(() => false);
				const stderr = await new Response(child.stderr).text();
				return { code, stdout, stderr: stderr.replace(/^Bundled page in [\d.]+(?:ms|s): .+\n/gm, "") };
			},
		};
	};
	try {
		const first = await (await serve()).stop();
		expect(first.code).toBe(0);
		const token = /owner token \(shown once\): (\S+)/.exec(first.stdout)?.[1];
		if (!token) throw new Error(`the first start printed no owner token: ${first.stdout}`);
		// The same files under the names the project used before 2026-10-13.
		await rename(join(home, ".mainworthy", "mainworthy.db"), join(home, ".mainworthy", "casebook.db"));
		await rename(join(home, ".mainworthy"), join(home, ".casebook"));

		const running = await serve();
		const session = await fetch(`${running.url}/api/session`, { headers: { authorization: `Bearer ${token}` } });
		const second = await running.stop();
		expect(second.code).toBe(0);
		expect(session.status).toBe(200);
		expect(second.stdout).not.toContain("owner token");
		expect(second.stderr.trim().split("\n")).toEqual([
			`mainworthy: moved ${join(home, ".casebook")} to ${join(home, ".mainworthy")}`,
			`mainworthy: moved ${join(home, ".mainworthy", "casebook.db")} to ${join(home, ".mainworthy", "mainworthy.db")}`,
		]);
		expect(existsSync(join(home, ".casebook"))).toBe(false);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("a start says when the configured owner token is not the owner's, and refuses an owner name that is not a person's", async () => {
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
		let helper = "";
		const first = await serve({ MAINWORTHY_OWNER_TOKEN: OWNER }, async (url) => {
			const made = await fetch(`${url}/api/admin`, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${OWNER}` },
				body: JSON.stringify({ do: "token.create", actor: "helper", kind: "agent" }),
			});
			helper = z.object({ result: z.object({ token: z.string() }) }).parse(await made.json()).result.token;
		});
		expect([first.code, first.stderr]).toEqual([0, ""]);

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
		const third = await serve({ MAINWORTHY_OWNER_TOKEN: OWNER, MAINWORTHY_OWNER: "helper" });
		expect([third.code, third.stdout]).toEqual([4, ""]);
		expect(third.stderr).toBe(
			"invalid: MAINWORTHY_OWNER names helper, which is an agent on this instance and not a person. Set MAINWORTHY_OWNER to the owner's name and start again; no actor and no token was changed (the database may have been brought to this build's schema first, with a copy of it as it was beside it)\n",
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
				HOME: directory,
				USER: "robin",
				MAINWORTHY_PORT: new URL(instance.url).port,
				MAINWORTHY_DATA: join(directory, "failed-start"),
			},
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
		});
		const timeout = setTimeout(() => child.kill("SIGKILL"), 1200);
		try {
			const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
			expect(code).toBe(4);
			expect(stderr).toContain("port");
			expect(stderr.trim().split("\n")).toHaveLength(1);
		} finally {
			clearTimeout(timeout);
			child.kill("SIGKILL");
			await child.exited;
		}
	});
});

test("a session lifetime that is not a duration stops the start with one line that names the variable", async () => {
	const directory = await mkdtemp(join(tmpdir(), "mainworthy-lifetime-"));
	const child = Bun.spawn([process.execPath, CLI_ENTRY, "serve"], {
		cwd: directory,
		env: {
			PATH: process.env.PATH ?? "",
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
				env: { PATH: process.env.PATH ?? "", HOME: directory, MAINWORTHY_URL: instance.url },
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
			env: { PATH: process.env.PATH ?? "", HOME: directory, MAINWORTHY_URL: instance.url },
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
					env: { PATH: process.env.PATH ?? "", HOME: directory, MAINWORTHY_URL: instance.url },
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
