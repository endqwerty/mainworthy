// Loaded before every test file (`bunfig.toml`), so that `bun test <file>` on a machine that cannot run the
// tests says why in one line. `bun run check` and `bun run test` have asked already, before they start a worker.
import { setDefaultTimeout } from "bun:test";
import { requireReady } from "../scripts/preflight.ts";

requireReady("bun test");

import { cluster } from "../scripts/pg.ts";

try {
	process.env.MAINWORTHY_TEST_PG ??= (await cluster()).adminUrl;
} catch (error) {
	console.error(`bun test: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(4);
}

// One deadline for a test that hangs, not a claim about its speed: timing claims are budgets in the performance phase.
// On PostgreSQL a CI worker takes 4 to 6 s over a test that takes 1 s here, past Bun's default 5 s.
setDefaultTimeout(20_000);

import { registerOwnedChild } from "../scripts/work/processes.ts";

await registerOwnedChild(process.pid);
