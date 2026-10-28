import { VERSION } from "../core/version.ts";
import { type Args, GLOBAL_FLAGS, hasJsonInput, parseArgs } from "./args.ts";
import type { ClientOptions } from "./client.ts";
import type { AdapterCommand } from "./commands/types.ts";
import { CliError } from "./errors.ts";
import { GENERATED_COMMANDS, generatedHelp, printFlags, runGenerated } from "./generated.ts";
import { line } from "./output.ts";

export const ADAPTER_COMMANDS: ReadonlyMap<string, () => Promise<AdapterCommand>> = new Map([
	["announce", async () => (await import("./commands/announce.ts")).announceCommand],
	["report", async () => (await import("./commands/report.ts")).reportCommand],
	["gate", async () => (await import("./commands/gate.ts")).gateCommand],
	["token", async () => (await import("./commands/token.ts")).tokenCommand],
	["invite", async () => (await import("./commands/invite.ts")).inviteCommand],
	["actor", async () => (await import("./commands/actor.ts")).actorCommand],
	["audit", async () => (await import("./commands/audit.ts")).auditCommand],
	["policy", async () => (await import("./commands/policy.ts")).policyCommand],
	["new", async () => (await import("./commands/new.ts")).newCommand],
	["seed", async () => (await import("./commands/seed.ts")).seedCommand],
	["get", async () => (await import("./commands/get.ts")).getCommand],
	["fmt", async () => (await import("./commands/fmt.ts")).fmtCommand],
	["check", async () => (await import("./commands/check.ts")).checkCommand],
	["export", async () => (await import("./commands/export.ts")).exportCommand],
	["import", async () => (await import("./commands/import.ts")).importCommand],
	["import-csv", async () => (await import("./commands/import-csv.ts")).csvImportCommand],
	["mcp", async () => (await import("./commands/mcp.ts")).mcpCommand],
	["open", async () => (await import("./commands/open.ts")).openCommand],
	["health", async () => (await import("./commands/health.ts")).healthCommand],
	["version", async () => (await import("./commands/version.ts")).versionCommand],
]);

/** The exposed names include all registry operations, even where a human adapter shares the name. */
export const COMMAND_NAMES: ReadonlySet<string> = new Set([
	...GENERATED_COMMANDS.keys(),
	...ADAPTER_COMMANDS.keys(),
	"serve",
	"help",
]);

async function printHelp(): Promise<void> {
	line(`Mainworthy ${VERSION}`);
	line("usage: mainworthy [serve] | <command> [--help]");
	line(
		"A token: prefer MAINWORTHY_TOKEN or --token-file to --token, which the process list and the shell's history show.",
	);
	for (const command of GENERATED_COMMANDS.values()) line(`  ${command.name.padEnd(12)} ${command.summary}`);
	for (const load of ADAPTER_COMMANDS.values()) {
		const command = await load();
		line(`  ${command.name.padEnd(12)} ${command.summary}`);
	}
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
export async function runCli(
	argv: readonly string[],
	ui: unknown,
	clientEnv: Record<string, string | undefined> = process.env,
	request?: ClientOptions["request"],
): Promise<number> {
	const { name, tokens } = splitCommand(argv);
	if (name === "help") {
		parseArgs(tokens);
		await printHelp();
		return 0;
	}
	if (name === "serve") {
		const args = parseArgs(tokens);
		if (args.bool("help")) {
			line("mainworthy serve: Start the server and web UI.");
			printFlags(GLOBAL_FLAGS);
		} else {
			const { serveCommand } = await import("./commands/serve.ts");
			await serveCommand(args, ui);
		}
		return 0;
	}
	const generated = GENERATED_COMMANDS.get(name);
	const adapter = await ADAPTER_COMMANDS.get(name)?.();
	if (!generated && !adapter) throw new CliError("invalid", `unknown command ${name}; use mainworthy help`);
	const flags = [...(generated?.flags ?? []), ...(adapter?.flags ?? [])];
	const args = parseArgs(tokens, flags);
	if (args.bool("help")) {
		if (generated) generatedHelp(generated);
		if (adapter) {
			line(`adapter: mainworthy ${adapter.usage}`);
			line(adapter.summary);
			printFlags(adapter.flags);
		}
		return 0;
	}
	const { Client, clientOptions } = await import("./client.ts");
	const client = new Client({
		...(name === "audit" && args.positionals[0] === "verify"
			? { url: "http://127.0.0.1:7357", token: undefined, project: undefined }
			: clientOptions(args, name === "health" || name === "fmt" || name === "version" ? "none" : "token", clientEnv)),
		...(request ? { request } : {}),
	});
	if (generated && (!adapter || hasJsonInput(tokens) || machineOnly(adapter, args)))
		return runGenerated(generated, args, client);
	if (adapter) {
		const allowed = new Set([...GLOBAL_FLAGS, { name: "json" }, ...adapter.flags].map((flag) => flag.name));
		for (const flag of args.flags.keys()) {
			if (!allowed.has(flag))
				throw new CliError("invalid", `--${flag} is an operation flag; use mainworthy ${name} --json '<input JSON>'`);
		}
		return adapter.run(args, client);
	}
	throw new CliError("invalid", `unknown command ${name}`);
}
