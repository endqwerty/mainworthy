#!/usr/bin/env bun
import ui from "../web/index.html";
import { bunTooOld } from "./bun-version.ts";
import { runCli } from "./dispatch.ts";
import { printError } from "./errors.ts";
import { verifyLockdown } from "./lockdown.ts";
import { installOutputHandlers } from "./output.ts";

installOutputHandlers();
try {
	const old = bunTooOld(Bun.version, process.execPath);
	if (old) throw new Error(old);
	verifyLockdown();
	process.exitCode = await runCli(Bun.argv.slice(2), ui);
} catch (error) {
	printError(error);
	process.exit(4);
}
