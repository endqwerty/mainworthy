import { z } from "zod";
import { EXIT_CODE, Verdict } from "../core/runs.ts";
import { OP_LIST } from "../server/ops/index.ts";
import type { AnyOp } from "../server/ops/registry.ts";
import { type Args, type Flag, type FlagKind, GLOBAL_FLAGS, JSON_FLAG } from "./args.ts";
import type { Client } from "./client.ts";
import { CliError } from "./errors.ts";
import { line, printJson } from "./output.ts";

const SchemaNode = z.looseObject({
	type: z.union([z.string(), z.array(z.string())]).optional(),
	description: z.string().optional(),
	properties: z.record(z.string(), z.unknown()).optional(),
	items: z.unknown().optional(),
	required: z.array(z.string()).optional(),
	anyOf: z.array(z.unknown()).optional(),
	oneOf: z.array(z.unknown()).optional(),
	allOf: z.array(z.unknown()).optional(),
});

function kindOf(raw: unknown): FlagKind {
	const schema = SchemaNode.parse(raw);
	const type = Array.isArray(schema.type) ? schema.type.filter((value) => value !== "null").at(0) : schema.type;
	if (type === "string") return "string";
	if (type === "number" || type === "integer") return "number";
	if (type === "boolean") return "boolean";
	if (type === "array" && SchemaNode.safeParse(schema.items).data?.type === "string") return "strings";
	const branches = schema.anyOf ?? schema.oneOf ?? [];
	if (branches.length > 0) {
		const kinds = new Set(branches.map(kindOf));
		if (kinds.size === 1) return kinds.values().next().value ?? "json";
	}
	return "json";
}

/** Collects root properties across unions, so decide/admin alternatives get the same generated help as objects. */
export function operationFlags(op: AnyOp): Flag[] {
	const flags = new Map<string, Flag>();
	function collect(raw: unknown): void {
		const schema = SchemaNode.parse(raw);
		for (const [name, property] of Object.entries(schema.properties ?? {})) {
			const node = SchemaNode.parse(property);
			const kind = kindOf(property);
			const previous = flags.get(name);
			flags.set(name, {
				name,
				kind: previous && previous.kind !== kind ? "json" : kind,
				description: node.description ?? previous?.description ?? "",
			});
		}
		for (const branch of [...(schema.anyOf ?? []), ...(schema.oneOf ?? []), ...(schema.allOf ?? [])]) collect(branch);
	}
	collect(z.toJSONSchema(op.input, { io: "input", unrepresentable: "any" }));
	return [...flags.values()];
}

export type GeneratedCommand = { name: string; summary: string; op: AnyOp; flags: Flag[] };

/** Every operation becomes a CLI command here, with no operation-specific mapping or dispatch code. */
export const GENERATED_COMMANDS: ReadonlyMap<string, GeneratedCommand> = new Map(
	OP_LIST.map((op) => [op.name, { name: op.name, summary: op.summary, op, flags: operationFlags(op) }]),
);

export function printFlags(flags: readonly Flag[]): void {
	for (const flag of flags) {
		const shape =
			flag.kind === "boolean"
				? "[true|false]"
				: flag.kind === "json"
					? "<input JSON>"
					: flag.kind === "strings"
						? "<a,b,...>"
						: `<${flag.kind}>`;
		line(
			`  --${flag.name} ${shape}${flag.description ? `  ${flag.description}` : ""}${flag.kind === "json" && flag.name !== "json" ? " (use --json for this nested input)" : ""}`,
		);
	}
}

export function generatedHelp(command: GeneratedCommand): void {
	line(`casebook ${command.name}: ${command.summary}`);
	line(`usage: casebook ${command.name} --json '<input JSON>' | --flag value ...`);
	printFlags([
		...command.flags,
		JSON_FLAG,
		...GLOBAL_FLAGS.filter((flag) => !command.flags.some((input) => input.name === flag.name)),
	]);
}

function jsonInput(text: string): unknown {
	try {
		const value: unknown = JSON.parse(text);
		return value;
	} catch {
		throw new CliError("invalid", "--json needs valid JSON input");
	}
}

/** Validates generated input with the operation's own schema, then forwards it through HTTP and prints its result. */
export async function runGenerated(command: GeneratedCommand, args: Args, client: Client): Promise<number> {
	if (args.positionals.length > 0)
		throw new CliError("invalid", `${command.name} accepts flags or --json input; use --help`);
	let input: unknown;
	const json = args.value("json");
	if (json !== undefined) {
		if (json === "true") throw new CliError("invalid", `${command.name} needs --json '<input JSON>'`);
		input = jsonInput(json);
	} else {
		const fields: Record<string, unknown> = {};
		for (const flag of command.flags) {
			if (!args.has(flag.name)) continue;
			switch (flag.kind) {
				case "string":
					fields[flag.name] = args.value(flag.name);
					break;
				case "number":
					fields[flag.name] = args.number(flag.name);
					break;
				case "boolean":
					fields[flag.name] = args.bool(flag.name);
					break;
				case "strings":
					fields[flag.name] = args.strings(flag.name);
					break;
				case "json":
					throw new CliError("invalid", `--${flag.name} is nested; supply it through --json '<input JSON>'`);
				default: {
					const exhaustive: never = flag.kind;
					return exhaustive;
				}
			}
		}
		input = fields;
	}
	const parsed = command.op.input.safeParse(input);
	if (!parsed.success)
		throw new CliError(
			"invalid",
			parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; "),
		);
	const validated: unknown = parsed.data;
	const result = await client.operation(command.name, validated);
	const rows = z.array(z.unknown()).safeParse(result);
	if (rows.success) {
		for (const item of rows.data) {
			const refusal = z
				.object({ status: z.enum(["forbidden", "invalid", "conflict"]), needs: z.string().nullable().optional() })
				.safeParse(item);
			if (refusal.success)
				throw new CliError(refusal.data.status, refusal.data.needs ?? "the operation refused the requested change");
		}
	}
	printJson(result, args.bool("compact"));
	const gate = z
		.object({ verdict: Verdict, tally: z.record(z.string(), z.number()), open: z.array(z.string()) })
		.safeParse(result);
	return gate.success ? EXIT_CODE[gate.data.verdict] : 0;
}
