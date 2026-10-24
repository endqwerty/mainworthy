// Loaded before every test file (`bunfig.toml`), so that `bun test <file>` on a machine that cannot run the
// tests says why in one line. `bun run check` and `bun run test` have asked already, before they start a worker.
import { requireReady } from "../scripts/preflight.ts";

requireReady("bun test");

import { cluster } from "../scripts/pg.ts";

try {
	process.env.MAINWORTHY_TEST_PG ??= (await cluster()).adminUrl;
} catch (error) {
	console.error(`bun test: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(4);
}

import { registerOwnedChild } from "../scripts/work/processes.ts";

await registerOwnedChild(process.pid);
