import { spawn } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { registerOwnedChild } from "../../scripts/work/processes.ts";
import { markOwned } from "../../scripts/work/scratch.ts";
import { processIdentity } from "../../scripts/work/test-databases.ts";
import { drainDatabaseDrops, testDatabase } from "../db.ts";

const config = z
	.object({ command: z.array(z.string()).min(1), data: z.string() })
	.parse(JSON.parse(process.argv[2] ?? "null"));
markOwned(config.data);
const database = await testDatabase();
const unregister = await registerOwnedChild(process.pid);
// detached creates a new session/process group on macOS as well as Linux. Explicit stdio keeps the
// worker's lifetime pipe out of the fixture; it receives a new pipe with this supervisor as sole writer.
const child = spawn(config.command[0] ?? "", config.command.slice(1), {
	detached: true,
	stdio: ["pipe", "pipe", "inherit"],
	env: { ...process.env, MAINWORTHY_DATABASE_URL: database.url, MAINWORTHY_TEST_LIFETIME: crypto.randomUUID() },
});
const exited = new Promise<number>((resolve) => {
	child.once("exit", (code) => resolve(code ?? 1));
	child.once("error", (error) => {
		console.error("test fixture spawn:", error);
		resolve(1);
	});
});
const pid = child.pid;
const unregisterFixture = pid === undefined ? async () => {} : await registerOwnedChild(pid);
if (pid !== undefined) {
	markOwned(config.data, [process.pid, pid]);
	await writeFile(join(config.data, "fixture-pid"), String(pid));
	await writeFile(join(config.data, "fixture-stamp"), processIdentity(pid) ?? "");
}
// A fixture can publish its URL immediately; readiness must include its completed PID metadata.
child.stdout?.pipe(process.stdout);
const signal = (name: NodeJS.Signals) => {
	if (pid === undefined) return;
	try {
		process.kill(-pid, name);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
	}
};
let stopping: Promise<void> | undefined;
const shutdown = () =>
	(stopping ??= (async () => {
		child.stdin?.end();
		signal("SIGTERM");
		const force = setTimeout(() => signal("SIGKILL"), 1_500);
		await exited;
		clearTimeout(force);
		// The leader can exit before its descendants. Kill only its private group before releasing resources.
		signal("SIGKILL");
		await unregisterFixture();
		await rm(config.data, { recursive: true, force: true });
		await database.close();
		if (!process.env.MAINWORTHY_TEST_DATABASES) await drainDatabaseDrops();
		await unregister();
		process.exit(0);
	})());
for (const name of ["SIGTERM", "SIGINT", "SIGHUP"] satisfies NodeJS.Signals[]) process.on(name, shutdown);
process.stdin.on("end", shutdown);
process.stdin.on("error", shutdown);
process.stdin.resume();
void exited.then(shutdown);
