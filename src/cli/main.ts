#!/usr/bin/env bun
import ui from "../web/index.html";
import { runCli } from "./dispatch.ts";
import { printError } from "./errors.ts";

try {
	process.exitCode = await runCli(Bun.argv.slice(2), ui);
} catch (error) {
	printError(error);
	process.exitCode = 4;
}
