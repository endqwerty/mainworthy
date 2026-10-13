import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_ENTRY, COMMIT, withInstance } from "./test-support.ts";

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
				expect(stdout).toContain('project "scratch" · you are robin@this-machine · policy: loose');
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
				expect(stderr.replace(/^Bundled page in [\d.]+(?:ms|s): .+\n/gm, "")).toBe("");
			} finally {
				clearTimeout(timeout);
				child.kill("SIGKILL");
				await child.exited;
				reader.releaseLock();
			}
		});
	});
}

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
			const child = Bun.spawn(
				[
					"bash",
					"-o",
					"pipefail",
					"-c",
					'"$1" "$2" gate --commit "$3" | head -0',
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
