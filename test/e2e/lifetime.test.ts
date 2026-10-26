import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { cluster } from "../../scripts/pg.ts";
import { lineage, ownedChildren, processTable, registerOwnedChild } from "../../scripts/work/processes.ts";
import { databaseAdmin } from "../../src/server/kernel/db.ts";
import { FORWARD_STDIN } from "./support.ts";

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
async function until(check: () => boolean | Promise<boolean>, ms = 4_000): Promise<boolean> {
	const deadline = Date.now() + ms;
	do {
		if (await check()) return true;
		await Bun.sleep(25);
	} while (Date.now() < deadline);
	return false;
}

async function fixtureDatabases(supervisor: number): Promise<string[]> {
	const { adminUrl } = await cluster();
	return await databaseAdmin(adminUrl, async (admin) =>
		(
			await admin.all<{ name: string }>(
				"SELECT datname AS name FROM pg_database WHERE starts_with(datname, $1::text)",
				[`mw_test_${supervisor}_`],
			)
		).map((row) => row.name),
	);
}
async function worker(executable?: string) {
	const owner = Bun.spawn(
		[
			process.execPath,
			"-e",
			`
			import { startServer } from "./test/e2e/support.ts";
			const server = await startServer({ source: ${executable === undefined} });
			console.log(JSON.stringify({ url: server.url, token: server.token }));
			process.stdin.once("data", async () => { await server.stop(); process.exit(0); });
			process.stdin.resume();
		`,
		],
		{
			stdin: "pipe",
			stdout: "pipe",
			stderr: "inherit",
			env: {
				...process.env,
				MAINWORTHY_TEST_DATABASES: "",
				BUN_FEATURE_FLAG_NO_ORPHANS: "1",
				...(executable ? { MAINWORTHY_E2E_SERVER: executable } : {}),
			},
		},
	);
	try {
		const reader = owner.stdout.getReader();
		let output = "";
		while (!output.includes("\n")) {
			const next = await reader.read();
			if (next.done) throw new Error(`worker exited before ready: ${output}`);
			output += new TextDecoder().decode(next.value);
		}
		const ready = z.object({ url: z.string().url(), token: z.string() }).parse(JSON.parse(output.trim()));
		const procs = await processTable();
		const supervisor = procs.find(
			(proc) =>
				proc.command.startsWith(process.execPath) &&
				proc.command.includes("test/e2e/supervise.ts") &&
				lineage(procs, proc.pid).has(owner.pid),
		);
		// Before the fix the fixture was the worker's direct child. Keep that path for the red regression.
		const direct = (await processTable()).find(
			(proc) => proc.ppid === owner.pid && proc.command.includes("test/e2e/serve.ts"),
		);
		if (supervisor) expect(await fixtureDatabases(supervisor.pid)).toHaveLength(1);
		const data = /"data":"([^"]+)"/.exec(supervisor?.command ?? "")?.[1];
		const pid = data ? Number(await readFile(join(data, "fixture-pid"), "utf8")) : (direct?.pid ?? 0);
		if (!pid) throw new Error("worker did not start a fixture");
		return {
			...ready,
			owner,
			pid,
			data,
			supervisor: supervisor?.pid,
			async dispose() {
				owner.kill("SIGKILL");
				await owner.exited;
				await until(() => !alive(pid));
				// Assertions run before this fallback. If a Bun upgrade breaks ownership handling, fail
				// with diagnostics and then stop the captured private group, including its descendants.
				try {
					process.kill(-pid, "SIGKILL");
				} catch (error) {
					if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
				}
				if (supervisor && alive(supervisor.pid)) {
					process.kill(supervisor.pid, "SIGTERM");
					if (!(await until(() => !alive(supervisor.pid)))) process.kill(supervisor.pid, "SIGKILL");
				}
				if (!(await until(() => !alive(pid) && (!supervisor || !alive(supervisor.pid)))))
					throw new Error(`Bun ${Bun.version} on ${process.platform}: test cleanup could not stop fixture ${pid}`);
				if (data) await rm(data, { recursive: true, force: true });
			},
		};
	} catch (error) {
		owner.kill("SIGKILL");
		await owner.exited;
		throw error;
	}
}
const compatibility = (server: Awaited<ReturnType<typeof worker>>, action: string): string =>
	`Bun ${Bun.version} on ${process.platform}: no-orphans compatibility failed: ${action} (worker ${server.owner.pid}, fixture ${server.pid}, supervisor ${server.supervisor ?? "missing"})`;

async function released(server: Awaited<ReturnType<typeof worker>>) {
	expect(
		await until(() => !alive(server.pid)),
		compatibility(server, "fixture did not exit after ownership loss"),
	).toBe(true);
	if (server.data)
		expect(
			await until(() => !existsSync(server.data ?? "")),
			compatibility(server, "supervisor did not remove its data directory"),
		).toBe(true);
	if (server.supervisor)
		expect(
			await until(() => !alive(server.supervisor ?? 0)),
			compatibility(server, "supervisor did not exit after cleanup"),
		).toBe(true);
	if (server.supervisor) expect(await fixtureDatabases(server.supervisor)).toEqual([]);
	const port = Number(new URL(server.url).port);
	const probe = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response() });
	await probe.stop(true);
}

for (const shell of ["/bin/sh", "/bin/dash", "/bin/bash"]) {
	test.skipIf(!existsSync(shell))(
		`the supervisor's shell wrapper keeps the lifetime pipe as stdin under ${shell}`,
		async () => {
			const child = Bun.spawn(
				[shell, "-c", FORWARD_STDIN, "wrapper", "/bin/sh", "-c", 'read -r line; echo "[$line]"'],
				{
					stdin: "pipe",
					stdout: "pipe",
				},
			);
			child.stdin.write("lifetime\n");
			await child.stdin.end();
			expect((await new Response(child.stdout).text()).trim()).toBe("[lifetime]");
			expect(await child.exited).toBe(0);
		},
	);
}

test("a SIGKILLed worker's server exits and frees its port without stopping an unrelated server", async () => {
	const unrelated = await worker();
	try {
		const server = await worker();
		try {
			server.owner.kill("SIGKILL");
			await server.owner.exited;
			await released(server);
			expect(alive(unrelated.pid)).toBe(true);
			expect((await fetch(`${unrelated.url}/health`)).ok).toBe(true);
		} finally {
			await server.dispose();
		}
	} finally {
		await unrelated.dispose();
	}
}, 20_000);

test("shutdown reaps descendants in the fixture's private process group", async () => {
	const directory = await mkdtemp(join(tmpdir(), "mainworthy-lifetime-group-"));
	const fixture = join(directory, "fixture");
	const pidFile = join(directory, "descendant");
	await writeFile(
		fixture,
		`#!${process.execPath}
		import { watchLifetime } from ${JSON.stringify(join(import.meta.dir, "lifetime.ts"))};
		const child = Bun.spawn([process.execPath, "-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
			stdin: "inherit", stdout: "ignore", stderr: "ignore"
		});
		await Bun.write(${JSON.stringify(pidFile)}, String(child.pid));
		const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
		console.info(listener.url.href);
		watchLifetime(async () => {});
	`,
		{ mode: 0o700 },
	);
	const server = await worker(fixture);
	const descendant = Number(await readFile(pidFile, "utf8"));
	try {
		server.owner.stdin.write("stop");
		expect(await until(() => server.owner.exitCode !== null)).toBe(true);
		expect(await server.owner.exited).toBe(0);
		expect(await until(() => !alive(descendant))).toBe(true);
		await released(server);
	} finally {
		if (alive(descendant)) process.kill(descendant, "SIGKILL");
		await server.dispose();
		await rm(directory, { recursive: true, force: true });
	}
}, 20_000);

test("the supervisor bounds stop even when the fixture event loop cannot handle shutdown", async () => {
	const server = await worker();
	try {
		process.kill(server.pid, "SIGSTOP");
		server.owner.stdin.write("stop");
		expect(await until(() => server.owner.exitCode !== null)).toBe(true);
		expect(await server.owner.exited).toBe(0);
		await released(server);
	} finally {
		await server.dispose();
	}
}, 20_000);

test("Bun no-orphans compatibility bounds a SIGSTOPped fixture after owner SIGKILL", async () => {
	const server = await worker();
	try {
		process.kill(server.pid, "SIGSTOP");
		server.owner.kill("SIGKILL");
		await server.owner.exited;
		await released(server);
	} finally {
		await server.dispose();
	}
}, 20_000);

test("shutdown completes with an open SSE connection", async () => {
	const server = await worker(process.env.MAINWORTHY_E2E_SERVER);
	const abort = new AbortController();
	try {
		const stream = await fetch(`${server.url}/api/p/scratch/events`, {
			headers: { authorization: `Bearer ${server.token}` },
			signal: abort.signal,
		});
		expect(stream.status).toBe(200);
		expect(stream.headers.get("content-type")).toBe("text/event-stream");
		const reader = stream.body?.getReader();
		expect((await reader?.read())?.done).toBe(false);
		server.owner.stdin.write("stop");
		expect(await until(() => server.owner.exitCode !== null)).toBe(true);
		expect(await server.owner.exited).toBe(0);
		await released(server);
	} finally {
		abort.abort();
		await server.dispose();
	}
}, 20_000);

test("the fixture watchdog force-exits a hanging stop and a grandchild cannot hold its lifetime pipe open", async () => {
	const directory = await mkdtemp(join(tmpdir(), "mainworthy-lifetime-"));
	const grandchildFile = join(directory, "grandchild");
	const fixture = join(directory, "fixture");
	await writeFile(
		fixture,
		`#!${process.execPath}
		import { watchLifetime } from ${JSON.stringify(join(import.meta.dir, "lifetime.ts"))};
		import { writeFileSync } from "node:fs";
		const grandchild = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
			detached: true, stdin: "inherit", stdout: "ignore", stderr: "ignore"
		});
		writeFileSync(${JSON.stringify(grandchildFile)}, String(grandchild.pid));
		const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
		console.info(listener.url.href);
		watchLifetime(() => new Promise(() => {}));
	`,
		{ mode: 0o700 },
	);
	const server = await worker(fixture);
	const grandchild = Number(await readFile(grandchildFile, "utf8"));
	try {
		// Stop the supervisor so EOF alone exercises the fixture's watchdog, without its external deadline.
		if (!server.supervisor) throw new Error("missing supervisor");
		process.kill(server.supervisor, "SIGKILL");
		expect(await until(() => !alive(server.pid)), compatibility(server, "fixture watchdog did not exit on EOF")).toBe(
			true,
		);
		expect(alive(grandchild)).toBe(true);
		const probe = Bun.serve({
			hostname: "127.0.0.1",
			port: Number(new URL(server.url).port),
			fetch: () => new Response(),
		});
		await probe.stop(true);
	} finally {
		if (alive(grandchild)) process.kill(grandchild, "SIGKILL");
		await server.dispose();
		await rm(directory, { recursive: true, force: true });
	}
}, 20_000);

test("owned-child accounting ignores another run and removes completed registrations", async () => {
	const directory = await mkdtemp(join(tmpdir(), "mainworthy-owned-"));
	const other = await mkdtemp(join(tmpdir(), "mainworthy-owned-other-"));
	const prior = process.env.MAINWORTHY_TEST_CHILDREN;
	try {
		process.env.MAINWORTHY_TEST_CHILDREN = directory;
		const unregister = await registerOwnedChild(process.pid);
		process.env.MAINWORTHY_TEST_CHILDREN = other;
		const unregisterOther = await registerOwnedChild(process.ppid);
		expect(await ownedChildren(directory)).toEqual([process.pid]);
		expect(await ownedChildren(other)).toEqual([process.ppid]);
		await unregister();
		await unregisterOther();
		expect(await ownedChildren(directory)).toEqual([]);
	} finally {
		if (prior === undefined) delete process.env.MAINWORTHY_TEST_CHILDREN;
		else process.env.MAINWORTHY_TEST_CHILDREN = prior;
		await rm(directory, { recursive: true, force: true });
		await rm(other, { recursive: true, force: true });
	}
});

test("check reports an owned child left alive and fails an otherwise passing run", async () => {
	const directory = await mkdtemp(join(tmpdir(), "mainworthy-check-leak-"));
	const leaked = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
		detached: true,
	});
	await mkdir(join(directory, "test"));
	await writeFile(
		join(directory, "test/probe.test.ts"),
		`
		import { test } from "bun:test";
		import { registerOwnedChild } from ${JSON.stringify(join(import.meta.dir, "../../scripts/work/processes.ts"))};
		test("otherwise passing", async () => {
			await registerOwnedChild(${leaked.pid});
		});
	`,
	);
	const check = Bun.spawn(
		[
			process.execPath,
			join(import.meta.dir, "../../scripts/check.ts"),
			"test",
			"--only=parallel",
			"--workers=1",
			`--junit=${join(directory, "probe.xml")}`,
			"test/probe.test.ts",
		],
		{ cwd: directory, stdout: "pipe", stderr: "pipe" },
	);
	try {
		const [code, out, err] = await Promise.all([
			check.exited,
			new Response(check.stdout).text(),
			new Response(check.stderr).text(),
		]);
		expect(code).toBe(1);
		expect(out).toContain(`check: 1 owned child still alive (pids: ${leaked.pid})`);
		expect(err).toContain("1 pass");
		expect(err).toContain("0 fail");
		expect(JSON.parse(await readFile(join(directory, "probe.json"), "utf8"))).toMatchObject({ exit: 1 });
	} finally {
		check.kill("SIGKILL");
		await check.exited;
		leaked.kill("SIGKILL");
		await leaked.exited;
		await rm(directory, { recursive: true, force: true });
	}
}, 40_000);
