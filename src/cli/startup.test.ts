import { expect, test } from "bun:test";
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
