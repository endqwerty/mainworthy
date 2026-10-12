import { type Args, GLOBAL_FLAGS, hasJsonInput, parseArgs } from "./args.ts";
import { Client, clientOptions } from "./client.ts";
import { checkCommand } from "./commands/check.ts";
import { exportCommand } from "./commands/export.ts";
import { fmtCommand } from "./commands/fmt.ts";
import { gateCommand } from "./commands/gate.ts";
import { getCommand } from "./commands/get.ts";
import { healthCommand } from "./commands/health.ts";
import { importCommand } from "./commands/import.ts";
import { mcpCommand } from "./commands/mcp.ts";
import { newCommand } from "./commands/new.ts";
import { openCommand } from "./commands/open.ts";
import { policyCommand } from "./commands/policy.ts";
import { reportCommand } from "./commands/report.ts";
import { serveCommand } from "./commands/serve.ts";
import { tokenCommand } from "./commands/token.ts";
import type { AdapterCommand } from "./commands/types.ts";
import { CliError } from "./errors.ts";
import { GENERATED_COMMANDS, generatedHelp, printFlags, runGenerated } from "./generated.ts";
import { line } from "./output.ts";

export const ADAPTER_COMMANDS: ReadonlyMap<string, AdapterCommand> = new Map(
	[
		reportCommand,
		gateCommand,
		tokenCommand,
		policyCommand,
		newCommand,
		getCommand,
		fmtCommand,
		checkCommand,
		exportCommand,
		importCommand,
		mcpCommand,
		openCommand,
		healthCommand,
	].map((command) => [command.name, command]),
);

/** The exposed names include all registry operations, even where a human adapter shares the name. */
export const COMMAND_NAMES: ReadonlySet<string> = new Set([
	...GENERATED_COMMANDS.keys(),
	...ADAPTER_COMMANDS.keys(),
	"serve",
	"help",
]);

function printHelp(): void {
	line("Casebook 0.1.0");
	line("usage: casebook [serve] | <command> [--help]");
	for (const command of GENERATED_COMMANDS.values()) line(`  ${command.name.padEnd(12)} ${command.summary}`);
	for (const command of ADAPTER_COMMANDS.values()) line(`  ${command.name.padEnd(12)} ${command.summary}`);
	line("  serve        Start the server and web UI. Also the default with no arguments.");
	line("  help         List every operation and adapter.");
}

function splitCommand(argv: readonly string[]): { name: string; tokens: string[] } {
	const prefix: string[] = [];
	let index = 0;
	while (index < argv.length) {
		const token = argv[index];
		if (!token?.startsWith("--")) break;
		const name = token.slice(2).split("=")[0];
		const flag = GLOBAL_FLAGS.find((flag) => flag.name === name);
		if (!flag) break;
		prefix.push(token);
		index++;
		if (!token.includes("=") && (flag.kind !== "boolean" || argv[index] === "true" || argv[index] === "false")) {
			const value = argv[index];
			if (value !== undefined) {
				prefix.push(value);
				index++;
			}
		}
	}
	return {
		name: argv[index] ?? (prefix.includes("--help") ? "help" : "serve"),
		tokens: [...prefix, ...argv.slice(index + 1)],
	};
}

function machineOnly(adapter: AdapterCommand, args: Args): boolean {
	return adapter.name === "get" && args.positionals.length === 0 && args.has("refs");
}

/** Dispatches the registry-generated operation form or the small human adapter. Only serve opens local data. */
export async function runCli(argv: readonly string[], ui: unknown): Promise<number> {
	const { name, tokens } = splitCommand(argv);
	if (name === "help") {
		parseArgs(tokens);
		printHelp();
		return 0;
	}
	if (name === "serve") {
		const args = parseArgs(tokens);
		if (args.bool("help")) {
			line("casebook serve: Start the server and web UI.");
			printFlags(GLOBAL_FLAGS);
		} else serveCommand(args, ui);
		return 0;
	}
	const generated = GENERATED_COMMANDS.get(name);
	const adapter = ADAPTER_COMMANDS.get(name);
	if (!generated && !adapter) throw new CliError("invalid", `unknown command ${name}; use casebook help`);
	const flags = [...(generated?.flags ?? []), ...(adapter?.flags ?? [])];
	const args = parseArgs(tokens, flags);
	if (args.bool("help")) {
		if (generated) generatedHelp(generated);
		if (adapter) {
			line(`adapter: casebook ${adapter.usage}`);
			line(adapter.summary);
			printFlags(adapter.flags);
		}
		return 0;
	}
	const client = new Client(clientOptions(args));
	if (generated && (!adapter || hasJsonInput(tokens) || machineOnly(adapter, args)))
		return runGenerated(generated, args, client);
	if (adapter) {
		const allowed = new Set([...GLOBAL_FLAGS, { name: "json" }, ...adapter.flags].map((flag) => flag.name));
		for (const flag of args.flags.keys()) {
			if (!allowed.has(flag))
				throw new CliError("invalid", `--${flag} is an operation flag; use casebook ${name} --json '<input JSON>'`);
		}
		return adapter.run(args, client);
	}
	throw new CliError("invalid", `unknown command ${name}`);
}
