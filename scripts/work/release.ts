// Gives back the disk a worktree used: the installed packages, a dev server's data and the test results. It runs
// when a T3 Code thread settles (`t3.json`) and as the last command of a task. It refuses while a server or a test
// run still works from this checkout: another agent's children share it, and a release under them removes the
// packages they are running from.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { runningIn } from "./processes.ts";

/** What a checkout makes and can make again (`.casebook` is the data directory an older checkout wrote). */
export const RELEASED = ["node_modules", ".mainworthy", ".casebook", "test-results"] as const;

export async function release(root: string, self = process.pid): Promise<string> {
	const busy = await runningIn(root, self);
	if (busy.length > 0)
		throw new Error(
			`not released: ${busy.length} server or test process(es) still run from ${root} (pid ${busy.map((p) => p.pid).join(" ")}). ` +
				"Stop your own with `bun scripts/work.ts stop-server`, and wait for the others' with `bun scripts/work.ts wait-tests`.",
		);
	for (const name of RELEASED) rmSync(join(root, name), { recursive: true, force: true });
	return `released ${RELEASED.join(", ")} in ${root}`;
}
