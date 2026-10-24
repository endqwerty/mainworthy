import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./support.ts";

test("the supervisor forwards the fixture's bound URL and removes its data on shutdown", async () => {
	const data = await mkdtemp(join(tmpdir(), "mainworthy-port-ready-"));
	const child = Bun.spawn(
		[
			process.execPath,
			"test/e2e/supervise.ts",
			JSON.stringify({
				data,
				command: [
					process.execPath,
					"-e",
					`
					import { watchLifetime } from ${JSON.stringify(join(import.meta.dir, "lifetime.ts"))};
					const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ready") });
					console.info(server.url.href);
					watchLifetime(() => server.stop(true));
				`,
				],
			}),
		],
		{ stdin: "pipe", stdout: "pipe", stderr: "pipe" },
	);
	const reader = child.stdout.getReader();
	const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
	try {
		let output = "";
		while (!output.includes("\n")) {
			const next = await reader.read();
			if (next.done) throw new Error(`supervisor exited before readiness: ${await new Response(child.stderr).text()}`);
			output += new TextDecoder().decode(next.value);
		}
		const url = new URL(output.trim());
		expect(Number(url.port)).toBeGreaterThan(0);
		expect(await (await fetch(url)).text()).toBe("ready");
		await child.stdin.end();
		expect(await child.exited).toBe(0);
		expect(existsSync(data)).toBe(false);
		await expect(fetch(url)).rejects.toThrow();
		const rebound = Bun.serve({ hostname: "127.0.0.1", port: Number(url.port), fetch: () => new Response() });
		await rebound.stop(true);
	} finally {
		clearTimeout(deadline);
		child.kill("SIGKILL");
		await child.exited;
		reader.releaseLock();
		await rm(data, { recursive: true, force: true });
	}
}, 15_000);

test("concurrent fixtures publish distinct live URLs and release only their own listener", async () => {
	const servers = await Promise.all([startServer({ source: true }), startServer({ source: true })]);
	try {
		expect(new Set(servers.map((server) => server.url)).size).toBe(servers.length);
		for (const server of servers) {
			expect(Number(new URL(server.url).port)).toBeGreaterThan(0);
			expect((await fetch(`${server.url}/healthz`)).ok).toBe(true);
		}
		const [first, second] = servers;
		if (!first || !second) throw new Error("missing concurrent fixture");
		await Promise.all([first.stop(), first.stop()]);
		await expect(fetch(`${first.url}/healthz`)).rejects.toThrow();
		expect((await fetch(`${second.url}/healthz`)).ok).toBe(true);
	} finally {
		await Promise.all(servers.map((server) => server.stop()));
	}
}, 30_000);
