import { expect, test } from "bun:test";
import { join } from "node:path";
import { CLI_ENTRY, withInstance } from "./test-support.ts";

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
					USER: "daniel",
					CASEBOOK_PORT: "0",
					CASEBOOK_MODE: options.mode,
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
					/^Casebook 0\.1\.0 · (local|server) · data in ~\/\.casebook · http:\/\/127\.0\.0\.1:\d+\n/,
				);
				expect(stdout).toContain('project "scratch" · you are daniel@this-machine · policy: loose');
				const url = /http:\/\/127\.0\.0\.1:\d+/.exec(stdout)?.[0];
				if (!url) throw new Error("startup did not print the server URL");
				const token = /owner token \(shown once\): (\S+)/.exec(stdout)?.[1];
				expect(Boolean(token)).toBe(options.mode === "server");
				const headers = token ? { authorization: `Bearer ${token}` } : {};
				expect((await fetch(`${url}/`)).status).toBe(200);
				const archive = await fetch(`${url}/api/export`, { headers });
				expect(archive.status).toBe(200);
				expect(await archive.text()).toContain('"casebook":"archive"');
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

test("an occupied port exits 4 without keeping the failed server alive", async () => {
	await withInstance(async ({ directory, instance }) => {
		const child = Bun.spawn([process.execPath, CLI_ENTRY, "serve"], {
			cwd: directory,
			env: {
				PATH: process.env.PATH ?? "",
				HOME: directory,
				USER: "daniel",
				CASEBOOK_PORT: new URL(instance.url).port,
				CASEBOOK_DATA: join(directory, "failed-start"),
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
				env: { PATH: process.env.PATH ?? "", HOME: directory, CASEBOOK_URL: instance.url },
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
			env: { PATH: process.env.PATH ?? "", HOME: directory, CASEBOOK_URL: instance.url },
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
		});
		expect(await child.exited).toBe(0);
		expect(await new Response(child.stdout).text()).toBe(`${instance.url}\n`);
	});
});
