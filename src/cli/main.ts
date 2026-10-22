#!/usr/bin/env bun
import ui from "../web/index.html";
import { runCli } from "./dispatch.ts";
import { printError } from "./errors.ts";
import { verifyLockdown } from "./lockdown.ts";
import { installOutputHandlers } from "./output.ts";

installOutputHandlers();
try {
	verifyLockdown();
	process.exitCode = await runCli(Bun.argv.slice(2), ui);
} catch (error) {
	printError(error);
	process.exit(4);
}
