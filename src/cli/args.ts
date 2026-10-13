import { CliError } from "./errors.ts";

export type FlagKind = "string" | "number" | "boolean" | "strings" | "json";
export type Flag = { name: string; kind: FlagKind; description: string; required?: boolean };

export const GLOBAL_FLAGS: readonly Flag[] = [
	{ name: "url", kind: "string", description: "Server URL. Defaults to MAINWORTHY_URL or http://127.0.0.1:7357." },
	{ name: "token", kind: "string", description: "Bearer token. Defaults to MAINWORTHY_TOKEN." },
	{ name: "project", kind: "string", description: "Project key. Defaults to MAINWORTHY_PROJECT or the only project." },
	{ name: "compact", kind: "boolean", description: "Print JSON on one line." },
	{ name: "help", kind: "boolean", description: "Show command help." },
];
export const JSON_FLAG: Flag = {
	name: "json",
	kind: "json",
	description: "JSON input for an operation, or JSON output for an adapter.",
};

/** Parsed flags retain repetitions so array inputs can use commas, repeated flags, or both. */
export class Args {
	constructor(
		readonly positionals: string[],
		readonly flags: ReadonlyMap<string, string[]>,
	) {}

	value(name: string): string | undefined {
		return this.flags.get(name)?.at(-1);
	}
	values(name: string): string[] {
		return this.flags.get(name) ?? [];
	}
	has(name: string): boolean {
		return this.flags.has(name);
	}
	bool(name: string): boolean {
		return this.value(name) === "true";
	}
	number(name: string): number | undefined {
		const value = this.value(name);
		if (value === undefined) return undefined;
		if (value.trim() === "" || !Number.isFinite(Number(value)))
			throw new CliError("invalid", `--${name} needs a number`);
		return Number(value);
	}
	strings(name: string): string[] {
		return this.values(name).flatMap((value) => value.split(",").filter((item) => item !== ""));
	}
}

/** Parses only declared flags. `--` ends flag parsing; unknown flags and missing values are errors. */
export function parseArgs(tokens: readonly string[], flags: readonly Flag[] = []): Args {
	const definitions = new Map([...GLOBAL_FLAGS, JSON_FLAG, ...flags].map((flag) => [flag.name, flag]));
	const values = new Map<string, string[]>();
	const positionals: string[] = [];
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (token === undefined) continue;
		if (token === "--") {
			positionals.push(...tokens.slice(index + 1));
			break;
		}
		if (!token.startsWith("--")) {
			positionals.push(token);
			continue;
		}
		const equal = token.indexOf("=");
		const name = token.slice(2, equal < 0 ? undefined : equal);
		const definition = definitions.get(name);
		if (!definition) throw new CliError("invalid", `unknown flag --${name}; use --help`);
		let value = equal < 0 ? undefined : token.slice(equal + 1);
		const next = tokens[index + 1];
		if (value === undefined) {
			if (definition.kind === "boolean") {
				if (next === "true" || next === "false") {
					value = next;
					index++;
				} else value = "true";
			} else if (definition.kind === "json") {
				if (next !== undefined && /^[{[]/.test(next.trimStart())) {
					value = next;
					index++;
				} else value = "true";
			} else {
				if (next === undefined || next.startsWith("--")) throw new CliError("invalid", `--${name} needs a value`);
				value = next;
				index++;
			}
		}
		if (definition.kind === "boolean" && value !== "true" && value !== "false") {
			throw new CliError("invalid", `--${name} needs true or false`);
		}
		const previous = values.get(name) ?? [];
		if (previous.length > 0 && definition.kind !== "strings")
			throw new CliError("invalid", `--${name} may be given only once`);
		values.set(name, [...previous, value]);
	}
	return new Args(positionals, values);
}

/** Machine input is explicit so a bare adapter `--json` remains an output option. */
export function hasJsonInput(tokens: readonly string[]): boolean {
	return tokens.some(
		(token, index) =>
			token.startsWith("--json=") || (token === "--json" && /^[{[]/.test((tokens[index + 1] ?? "").trimStart())),
	);
}

export function assertPositionals(args: Args, min: number, max: number, usage: string): void {
	if (args.positionals.length < min || args.positionals.length > max)
		throw new CliError("invalid", `usage: mainworthy ${usage}`);
}
