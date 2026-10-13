// Loaded before every test file (`bunfig.toml`), so that `bun test <file>` on a machine that cannot run the
// tests says why in one line. `bun run check` and `bun run test` have asked already, before they start a worker.
import { requireReady } from "../scripts/preflight.ts";

requireReady("bun test");
