// Real worker exits, signals and PostgreSQL drops belong to the serial process checks.
import { expect, onTestFinished, test } from "bun:test";
import {
	chmodSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { make, markOwned, remove, sweepOwned } from "../scripts/work/scratch.ts";
import { processIdentity, startTicks } from "../scripts/work/test-databases.ts";

for (const managed of [false, true])
	test(`database cleanup preserves ${managed ? "runner ownership" : "direct-file behavior"}`, async () => {
		const root = make("database-cleanup-test");
		const records = join(root, "records");
		mkdirSync(records);
		const probe = join(root, "probe.test.ts");
		writeFileSync(
			probe,
			`
 import {test} from "bun:test";
 import {testDatabase} from ${JSON.stringify(join(process.cwd(), "test/db.ts"))};
 test("close schedules runner cleanup", async () => {
  const database = await testDatabase({schema:"empty"});
  await Bun.write(${JSON.stringify(join(root, "database.url"))},database.url);
 await database.close();
 });
 `,
		);
		try {
			const child = Bun.spawn([process.execPath, "test", probe], {
				env: { ...process.env, MAINWORTHY_TEST_DATABASES: managed ? records : "" },
				stdout: "pipe",
				stderr: "pipe",
			});
			const [out, err, rc] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect(rc, out + err).toBe(0);
			expect(readdirSync(records).filter((name) => name.endsWith(".database.json"))).toHaveLength(managed ? 1 : 0);
			const { drainRecordedDatabases } = await import("../scripts/work/test-databases.ts");
			expect(await drainRecordedDatabases(records)).toBe(managed ? 1 : 0);
			const url = new URL(readFileSync(join(root, "database.url"), "utf8"));
			const name = url.pathname.slice(1);
			url.pathname = "/postgres";
			const { databaseAdmin } = await import("../src/server/kernel/db.ts");
			expect(
				await databaseAdmin(
					url.toString(),
					async (admin) => await admin.all("SELECT datname FROM pg_database WHERE datname = $1::text", [name]),
				),
			).toEqual([]);
			expect(readdirSync(records).filter((name) => name.endsWith(".database.json"))).toEqual([]);
		} finally {
			remove(root);
		}
	});

test("gate databases are dropped even when direct fixture cleanup exceeds the default hook timeout", async () => {
	const root = make("gate-slow-database-cleanup");
	symlinkSync(join(process.cwd(), "scripts"), join(root, "scripts"), "dir");
	const { recoverTestDatabases } = await import("../scripts/work/test-databases.ts");
	writeFileSync(
		join(root, "bunfig.toml"),
		`[test]\npreload = [${JSON.stringify(join(process.cwd(), "test/preflight.ts"))}]\n`,
	);
	writeFileSync(
		join(root, "probe.test.ts"),
		`
 import {test} from "bun:test";
 import ${JSON.stringify(join(process.cwd(), "test/ci-gate.test.ts"))};
 import {testDatabase} from ${JSON.stringify(join(process.cwd(), "test/db.ts"))};
 test("slow direct fixture cleanup",async()=>{
  const database=await testDatabase({schema:"empty"});
  await Bun.write(${JSON.stringify(join(root, "database.url"))},database.url);
  const close=database.close;
  database.close=async()=>{await Bun.sleep(21_000);await close();};
 });
 `,
	);
	try {
		const child = Bun.spawn(
			[
				process.execPath,
				"test",
				"probe.test.ts",
				"--test-name-pattern",
				"slow direct fixture cleanup|a shard that left no report",
			],
			{
				cwd: root,
				env: { ...process.env, MAINWORTHY_TEST_DATABASES: "", MAINWORTHY_TEST_CHILDREN: "" },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [out, err, rc] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		const remaining = await recoverTestDatabases(root);
		expect(remaining, out + err).toBe(0);
		expect(rc, out + err).toBe(0);
		expect(err).toContain("2 pass");
	} finally {
		await recoverTestDatabases(root);
		const fixtureUrl = join(root, "database.url");
		if (existsSync(fixtureUrl)) {
			const url = new URL(readFileSync(fixtureUrl, "utf8"));
			const name = url.pathname.slice(1);
			url.pathname = "/postgres";
			const { databaseAdmin } = await import("../src/server/kernel/db.ts");
			await databaseAdmin(url.toString(), (admin) =>
				admin.exec(`DROP DATABASE IF EXISTS "${name.replaceAll('"', '""')}" WITH (FORCE)`),
			);
		}
		remove(root);
	}
}, 200_000);

test("a browser supervisor leaves its database cleanup to the managed runner", async () => {
	const root = make("browser-database-cleanup");
	const records = join(root, "records");
	mkdirSync(records);
	const { drainRecordedDatabases } = await import("../scripts/work/test-databases.ts");
	try {
		const child = Bun.spawn(
			[
				process.execPath,
				"-e",
				`
 import {startServer} from "./test/e2e/support.ts";
 const server = await startServer();
 await server.stop();
 `,
			],
			{
				env: { ...process.env, MAINWORTHY_TEST_DATABASES: records },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [out, err, rc] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(rc, out + err).toBe(0);
		expect(readdirSync(records).filter((name) => name.endsWith(".database.json"))).toHaveLength(1);
		expect(await drainRecordedDatabases(records)).toBe(1);
	} finally {
		await drainRecordedDatabases(records);
		remove(root);
	}
});

test("the runner reaps a released database while an open fixture and its worker remain alive", async () => {
	const root = make("database-runner-reaping");
	const readyFile = join(root, "ready.json");
	const proceed = join(root, "proceed");
	mkdirSync(join(root, "test"));
	writeFileSync(
		join(root, "bunfig.toml"),
		`[test]\npreload = [${JSON.stringify(join(process.cwd(), "test/preflight.ts"))}]\n`,
	);
	writeFileSync(
		join(root, "test/probe.test.ts"),
		`
 import {test} from "bun:test";
 import {existsSync} from "node:fs";
 import {testDatabase,drainDatabaseDrops} from ${JSON.stringify(join(process.cwd(), "test/db.ts"))};
 test("release only the closed fixture",async()=>{
  const closed=await testDatabase({schema:"empty"}), open=await testDatabase({schema:"empty"});
  await closed.close();
  await Bun.write(${JSON.stringify(readyFile)},JSON.stringify({directory:process.env.MAINWORTHY_TEST_DATABASES,closed:closed.url,open:open.url}));
  while(!existsSync(${JSON.stringify(proceed)})) await Bun.sleep(10);
  await drainDatabaseDrops();
  if(!Number.isFinite(closed.timings.dropMs) || !(closed.timings.dropMs > 0)) throw new Error("explicit drain lost the completed drop timing");
 });
 `,
	);
	const child = Bun.spawn(
		[
			process.execPath,
			join(process.cwd(), "scripts/check.ts"),
			"test",
			"--only=parallel",
			"--workers=1",
			"test/probe.test.ts",
		],
		{ cwd: root, stdout: "pipe", stderr: "pipe" },
	);
	const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
	const { recoverTestDatabases } = await import("../scripts/work/test-databases.ts");
	const abort = new AbortController();
	let cleaning: Promise<void> | undefined;
	const cleanup = () =>
		(cleaning ??= (async () => {
			abort.abort();
			writeFileSync(proceed, "");
			child.kill("SIGTERM");
			await child.exited;
			await output;
			await recoverTestDatabases(root);
			remove(root);
		})());
	onTestFinished(cleanup);
	try {
		while (!existsSync(readyFile) && child.exitCode === null) {
			abort.signal.throwIfAborted();
			await Bun.sleep(10);
		}
		expect(existsSync(readyFile)).toBe(true);
		const ready = z
			.object({ directory: z.string(), closed: z.string(), open: z.string() })
			.parse(JSON.parse(readFileSync(readyFile, "utf8")));
		const closedName = new URL(ready.closed).pathname.slice(1),
			openName = new URL(ready.open).pathname.slice(1);
		const manifest = join(ready.directory, `${closedName}.database.json`);
		while (existsSync(manifest) && child.exitCode === null) {
			abort.signal.throwIfAborted();
			await Bun.sleep(10);
		}
		expect(existsSync(manifest)).toBe(false);
		expect(child.exitCode).toBeNull();
		const { databaseAdmin } = await import("../src/server/kernel/db.ts");
		const url = new URL(ready.open);
		url.pathname = "/postgres";
		expect(
			await databaseAdmin(url.toString(), (admin) =>
				admin.all("SELECT datname FROM pg_database WHERE datname = ANY($1::text[])", [[closedName, openName]]),
			),
		).toEqual([{ datname: openName }]);
		writeFileSync(proceed, "");
		const rc = await child.exited;
		const [out, err] = await output;
		expect(rc, out + err).toBe(0);
		expect(out).toContain("2 test databases removed; peak live 2");
		expect(existsSync(ready.directory)).toBe(false);
	} finally {
		await cleanup();
	}
});

test("a killed runner's exact manifest is recovered while a live runner and an unrelated database stay intact", async () => {
	const root = make("database-run-recovery");
	const { recoverTestDatabases } = await import("../scripts/work/test-databases.ts");
	const { testDatabase, drainDatabaseDrops } = await import("./db.ts");
	const { Database, sql, databaseAdmin } = await import("../src/server/kernel/db.ts");
	const unrelated = await testDatabase({ schema: "empty" });
	const producer = Bun.spawn(
		[
			process.execPath,
			"-e",
			`
 import {beginDatabaseRun} from ${JSON.stringify(join(process.cwd(), "scripts/work/test-databases.ts"))};
 const run = beginDatabaseRun(${JSON.stringify(root)});
 process.env.MAINWORTHY_TEST_DATABASES = run.directory;
 const {testDatabase} = await import(${JSON.stringify(join(process.cwd(), "test/db.ts"))});
 const database = await testDatabase({schema:"empty"});
 await database.close();
 console.log(JSON.stringify({directory:run.directory,url:database.url}));
 process.stdin.resume();
 `,
		],
		{ env: { ...process.env, MAINWORTHY_TEST_CHILDREN: "" }, stdin: "pipe", stdout: "pipe", stderr: "inherit" },
	);
	try {
		const reader = producer.stdout.getReader();
		let text = "";
		while (!text.includes("\n")) {
			const part = await reader.read();
			if (part.done) throw new Error("runner ended before recording its database");
			text += new TextDecoder().decode(part.value);
		}
		reader.releaseLock();
		const ready = z.object({ directory: z.string(), url: z.string() }).parse(JSON.parse(text));
		expect(await recoverTestDatabases(root)).toBe(0);
		expect(existsSync(ready.directory)).toBe(true);
		const { registerOwnedChild } = await import("../scripts/work/processes.ts");
		const unregister = await registerOwnedChild(process.pid, join(ready.directory, "children"));
		producer.kill("SIGKILL");
		await producer.exited;
		const recovering = recoverTestDatabases(root);
		try {
			expect(await Promise.race([recovering.then(() => "dropped"), Bun.sleep(40).then(() => "waiting")])).toBe(
				"waiting",
			);
			expect(existsSync(ready.directory)).toBe(true);
		} finally {
			await unregister();
		}
		expect(await recovering).toBe(1);
		expect(existsSync(ready.directory)).toBe(false);
		const alive = await Database.open({ url: unrelated.url });
		try {
			expect(
				await alive.read(async (db) => await db.one(sql<readonly [], { n: number }>("SELECT 1::bigint AS n"))),
			).toEqual({ n: 1 });
		} finally {
			await alive.close();
		}
		const adminUrl = new URL(ready.url);
		const name = adminUrl.pathname.slice(1);
		adminUrl.pathname = "/postgres";
		expect(
			await databaseAdmin(
				adminUrl.toString(),
				async (admin) => await admin.all("SELECT datname FROM pg_database WHERE datname = $1::text", [name]),
			),
		).toEqual([]);
	} finally {
		producer.kill("SIGKILL");
		await producer.exited;
		await recoverTestDatabases(root);
		await unrelated.close();
		await drainDatabaseDrops();
		remove(root);
	}
});

for (const ending of ["success", "failure", "SIGINT", "SIGTERM", "SIGKILL"] as const)
	test(`the check cleans up recorded databases after ${ending}`, async () => {
		const root = make("database-runner-exit");
		const readyFile = join(root, "ready.json");
		mkdirSync(join(root, "test"));
		writeFileSync(
			join(root, "bunfig.toml"),
			`[test]\npreload = [${JSON.stringify(join(process.cwd(), "test/preflight.ts"))}]\n`,
		);
		writeFileSync(
			join(root, "test/probe.test.ts"),
			`
   import {test} from "bun:test";
   import {testDatabase} from ${JSON.stringify(join(process.cwd(), "test/db.ts"))};
   test("a managed fixture",async()=> {
    const database = await testDatabase({schema:"empty"});
    await database.close();
    await Bun.write(${JSON.stringify(readyFile)},JSON.stringify({directory:process.env.MAINWORTHY_TEST_DATABASES,scratch:process.env.MAINWORTHY_BUDGET_REPORTS}));
    ${ending === "failure" ? 'throw new Error("expected probe failure");' : ending.startsWith("SIG") ? "await new Promise(() => {});" : ""}
   });
  `,
		);
		const args = [
			process.execPath,
			join(process.cwd(), "scripts/check.ts"),
			"test",
			"--only=parallel",
			"--workers=1",
			"test/probe.test.ts",
		];
		const child = Bun.spawn(args, { cwd: root, stdout: "pipe", stderr: "pipe" });
		const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
		const { recoverTestDatabases } = await import("../scripts/work/test-databases.ts");
		try {
			const deadline = Date.now() + 8000;
			while (!existsSync(readyFile) && child.exitCode === null && Date.now() < deadline) await Bun.sleep(10);
			expect(existsSync(readyFile)).toBe(true);
			const ready = z
				.object({ directory: z.string(), scratch: z.string() })
				.parse(JSON.parse(readFileSync(readyFile, "utf8")));
			if (ending !== "success" && ending !== "failure") child.kill(ending);
			const rc = await child.exited;
			const [out, err] = await output;
			if (ending === "SIGKILL") {
				expect(existsSync(ready.directory)).toBe(true);
				writeFileSync(join(root, "test/probe.test.ts"), 'import {test} from "bun:test"; test("next run",()=>{});');
				const next = Bun.spawn(args, { cwd: root, stdout: "pipe", stderr: "pipe" });
				const [nextOut, nextErr, nextRc] = await Promise.all([
					new Response(next.stdout).text(),
					new Response(next.stderr).text(),
					next.exited,
				]);
				expect(nextRc, nextOut + nextErr).toBe(0);
			} else {
				expect(rc, out + err).toBe(ending === "success" ? 0 : ending === "failure" ? 1 : 130);
				expect(out).toContain("1 test databases removed; peak live 1");
			}
			expect(existsSync(ready.directory)).toBe(false);
			expect(existsSync(dirname(ready.scratch))).toBe(false);
		} finally {
			child.kill("SIGKILL");
			await child.exited;
			await output;
			await recoverTestDatabases(root);
			remove(root);
		}
	}, 20000);

test("scratch recovery removes only marked directories with dead owners", async () => {
	const root = make("scratch-recovery");
	const child = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" });
	await child.exited;
	try {
		for (const prefix of ["mainworthy-check-", "mainworthy-e2e-"] as const) {
			const dead = join(root, `${prefix}${child.pid}-dead`);
			const live = join(root, `${prefix}${process.pid}-live`);
			const unknown = join(root, `${prefix}${child.pid}-unknown`);
			for (const directory of [dead, live, unknown]) mkdirSync(directory);
			markOwned(dead, [child.pid]);
			markOwned(live, [child.pid, process.pid]);
			const copy = `${dead}-copy`,
				alias = `${dead}-link`;
			cpSync(dead, copy, { recursive: true });
			symlinkSync(dead, alias);
			sweepOwned(root, prefix);
			expect(existsSync(dead)).toBe(false);
			expect(existsSync(live)).toBe(true);
			expect(existsSync(unknown)).toBe(true);
			expect(existsSync(copy)).toBe(true);
			expect(lstatSync(alias).isSymbolicLink()).toBe(true);
		}
	} finally {
		remove(root);
	}
});

for (const kind of ["fifo", "symlink", "unreadable", "oversized", "foreign"] as const)
	test(`scratch recovery skips ${kind} markers`, async () => {
		const root = make("scratch-invalid");
		const owner = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" });
		await owner.exited;
		const directory = join(root, "mainworthy-check-invalid");
		mkdirSync(directory);
		markOwned(directory, [owner.pid]);
		const marker = join(directory, ".mw-scratch");
		const ownerFile = `${marker}-owner`;
		try {
			if (kind === "fifo") {
				unlinkSync(marker);
				expect(Bun.spawnSync(["mkfifo", marker]).exitCode).toBe(0);
			} else if (kind === "symlink") {
				const target = join(root, "target");
				writeFileSync(target, readFileSync(marker));
				unlinkSync(marker);
				symlinkSync(target, marker);
			} else if (kind === "unreadable") chmodSync(ownerFile, 0);
			else if (kind === "oversized") writeFileSync(marker, `${directory}\n${" ".repeat(8192)}`);
			else {
				const metadata = readFileSync(ownerFile, "utf8");
				writeFileSync(ownerFile, ["foreign", ...metadata.split("\n").slice(1)].join("\n"));
			}
			const child = Bun.spawn(
				[
					process.execPath,
					"-e",
					`import {sweepOwned} from ${JSON.stringify(join(process.cwd(), "scripts/work/scratch.ts"))}; sweepOwned(${JSON.stringify(root)}, "mainworthy-check-");`,
				],
				{ stdout: "pipe", stderr: "pipe", timeout: 1500 },
			);
			const rc = await child.exited;
			expect(rc, await new Response(child.stderr).text()).toBe(0);
			expect(existsSync(directory)).toBe(true);
		} finally {
			if (existsSync(ownerFile)) chmodSync(ownerFile, 0o600);
			remove(root);
		}
	});

test("the fixture parent does not signal a recycled leader identity", async () => {
	const { startServer } = await import("./e2e/support.ts");
	const { processTable } = await import("../scripts/work/processes.ts");
	const server = await startServer({ source: true });
	const victim = Bun.spawn([process.execPath, "-e", 'process.stdin.on("data",()=>process.stdout.write("alive"))'], {
		detached: true,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "ignore",
	});
	const supervisor = (await processTable()).find(
		(proc) =>
			proc.command.startsWith(process.execPath) &&
			proc.command.includes("test/e2e/supervise.ts") &&
			proc.command.includes(`mainworthy-e2e-${process.pid}-`),
	);
	const data = /"data":"([^"\n]+)"/.exec(supervisor?.command ?? "")?.[1];
	if (!supervisor || !data) throw new Error("missing own fixture supervisor");
	try {
		const fixture = Number(readFileSync(join(data, "fixture-pid"), "utf8"));
		process.kill(-fixture, "SIGKILL");
		writeFileSync(join(data, "fixture-pid"), String(victim.pid));
		writeFileSync(join(data, "fixture-stamp"), "a different process start");
		process.kill(supervisor.pid, "SIGKILL");
		await expect(server.stop()).rejects.toThrow();
		victim.stdin.write("ping");
		const reply = await victim.stdout.getReader().read();
		expect(new TextDecoder().decode(reply.value)).toBe("alive");
	} finally {
		victim.kill();
		await victim.exited;
		await server.stop().catch(() => {});
	}
});

test("the fixture parent removes data after a killed supervisor exits", async () => {
	const { startServer } = await import("./e2e/support.ts");
	const { processTable } = await import("../scripts/work/processes.ts");
	const server = await startServer({ source: true });
	const procs = await processTable();
	const supervisor = procs.find(
		(proc) =>
			proc.command.startsWith(process.execPath) &&
			proc.command.includes("test/e2e/supervise.ts") &&
			proc.command.includes(`mainworthy-e2e-${process.pid}-`),
	);
	const data = /"data":"([^"\n]+)"/.exec(supervisor?.command ?? "")?.[1];
	if (!supervisor || !data) throw new Error("missing own fixture supervisor");
	try {
		const fixture = Number(readFileSync(join(data, "fixture-pid"), "utf8"));
		process.kill(-fixture, "SIGKILL");
		process.kill(supervisor.pid, "SIGKILL");
		await expect(server.stop()).rejects.toThrow();
		expect(existsSync(data)).toBe(false);
	} finally {
		await server.stop().catch(() => {});
		await import("node:fs/promises").then((fs) => fs.rm(data, { recursive: true, force: true }));
	}
});

test("a fixture is told from a recycled pid by its start in kernel ticks, read past any name", () => {
	const fields = (name: string) =>
		`4242 (${name}) S 1 4242 4242 0 -1 4194560 120 0 0 0 1 0 0 0 20 0 1 0 98765432 1 2 3`;
	for (const name of ["bun", "a b", "x) S 1 (y", "))", "("]) expect(startTicks(fields(name))).toBe("98765432");
	expect(startTicks("4242 (bun) S")).toBeNull();
	// On Linux the identity has the kernel's tick resolution, not `ps`'s second, and it is stable for one process.
	const own = processIdentity(process.pid);
	if (process.platform === "linux") expect(own).toMatch(/^ticks:\d+$/);
	expect(processIdentity(process.pid)).toBe(own);
	// No process, or no `/proc` to say when it started: no identity, so nothing is signalled by a pid alone.
	expect(processIdentity(2 ** 30)).toBeNull();
});
