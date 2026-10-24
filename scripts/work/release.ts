// Gives back the disk a worktree used: the installed packages, a dev server's data and the test results. It runs
// when a T3 Code thread settles (`t3.json`) and as the last command of a task. It refuses while a server, a test run
// or any other Bun process works from this checkout: another agent's children share it, and a release under them
// removes the packages they are running from. Only Bun counts: the project runs on Bun alone, and the Node helpers
// an agent keeps in its checkout use none of its packages and would block every release.
import { realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { removeCluster } from "../pg.ts";
import { runningIn } from "./processes.ts";

/** What a checkout makes and can make again (`.casebook` is the data directory an older checkout wrote). */
export const RELEASED = ["node_modules", ".mainworthy", ".casebook", "test-results"] as const;

export async function release(root: string, self = process.pid): Promise<string> {
	const busy = await runningIn(root, self);
	if (busy.length > 0)
		throw new Error(
			`not released: ${busy.length} bun process(es) still run from ${root} (pid ${busy.map((p) => p.pid).join(" ")}). ` +
				"Stop your own server with `bun scripts/work.ts stop-server`, and let the processes using this checkout finish before releasing it.",
		);
	if (realpathSync(root) === realpathSync(resolve(import.meta.dir, "../.."))) {
		await (await import("./test-databases.ts")).recoverTestDatabases(root);
		await removeCluster();
	}
	for (const name of RELEASED) rmSync(join(root, name), { recursive: true, force: true });
	return `released ${RELEASED.join(", ")} in ${root}`;
}
