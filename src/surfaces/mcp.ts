import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
	type CallToolResult,
	DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
	InitializeResultSchema,
	LATEST_PROTOCOL_VERSION,
	ListToolsRequestSchema,
	type Tool,
	type ToolAnnotations,
	ToolSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Session } from "../server/identity/identity.ts";
import type { App } from "../server/kernel/app.ts";
import { MCP_OPS, OPS } from "../server/ops/index.ts";
import { invokeAsync, type Reply } from "../server/ops/registry.ts";
import { grantedProjects, VERSION } from "./http.ts";

// SDK 1.32.1 implements MCP 2025-11-25. Structured tool results start at revision 2025-06-18.
/** The measured tools/list ceiling in o200k_base tokens. B7's draft target of 1,500 remains unmet. */
export const TOOL_TOKEN_BUDGET = 3950;

const INSTRUCTIONS =
	"Start with impact for a change, or inbox for questions. Pass hashes back with unless and onEvidence, and reuse cursors with since. Your answers may be advice; check the reply status.";
const PROJECT_DESCRIPTION = "Project key; omit only if there is one project.";
const DESCRIPTIONS = new Map([
	["The case, for example C-311.", ""],
	["The case.", ""],
	["The question, for example Q-12.", ""],
	["The version to restore.", ""],
	["Why. Shown in the case history.", ""],
	["The kind of review, for example adversarial-review.", ""],
	["The case this manual or agent result is for.", ""],
	[
		"The version this edit was made on. A stale base is merged or reported, never overwritten.",
		"Version edited; stale bases merge or conflict.",
	],
	["The folder to change. Absent when creating one.", "Omit to create a folder."],
	["The id of an earlier result of yours that this one replaces.", "Your earlier result id to replace."],
	["The commit this change is based on.", "Base commit."],
	["Paths the change touches, for impact.", "Changed paths for impact."],
	["What was tested. Required unless `run` is given.", "Required unless run is set."],
	["A planned run these results are for, for example R-4.", "Planned run, e.g. R-4."],
	[
		"Where: a case (C-311), a step (C-311#b7), a requirement (req:WEB-290) or a change (pr:482).",
		"C-311, C-311#b7, req:WEB-290 or pr:482.",
	],
	["The change reviewed, for example pr:482.", "Change key, e.g. pr:482."],
	["Cases read, each as C-311@<hash>. Recorded even with no findings.", "C-311@hash, even with no findings."],
	[
		"The evidence hash you saw. If the evidence changed since, the reply is a conflict with the new evidence.",
		"Evidence hash from inbox; changed evidence conflicts.",
	],
	[
		'The answer, for example {"is":"defect"}. The allowed answers depend on the question kind.',
		"Answer for this question kind.",
	],
	["The question whose decision to withdraw.", "Question to reopen."],
	["The cursor from the previous page.", "Page cursor."],
	["Only questions about this case, run, test or change.", "Case, run, test or change ref."],
	["Refs of cases (C-), questions (Q-), runs (R-), tests (T-) or proposals (P-).", "C-, Q-, R-, T- or P- refs."],
	[
		"For cases: any of title, pre, steps, methods, tags, covers, place, proof. Default: all.",
		"Case fields: title, pre, steps, methods, tags, covers, place, proof; default all.",
	],
	["`md` returns a case as canonical Markdown: fewer tokens than JSON.", ""],
	[
		"Ref to the hash you already hold. An unchanged case comes back as {ref, unchanged: true}.",
		"Ref to known hash; unchanged cases return {ref,unchanged:true}.",
	],
	["For one case: this version instead of the current one.", "One case's version; default current."],
	["With `folder`: include its subfolders.", "Include subfolders."],
	["For slots: the run.", "Run for slots."],
	["For tests: only those with no case.", "Tests with no case."],
	["A change key, for example pr:482.", "Change key, e.g. pr:482."],
	["Changed paths, when the change is not known to Mainworthy.", "Paths if change is unknown."],
	["A cursor from an earlier call: only what moved since.", "Change cursor; only what moved."],
	["False for fresh eyes: do not hide what was already reviewed.", "False for a fresh review."],
	["A cursor from any earlier read.", "Change cursor from an earlier read."],
	[
		"A change key, for example pr:482: the gate of its latest commit.",
		"Change key, e.g. pr:482; latest commit's gate.",
	],
]);
const Arguments = z.looseObject({ project: z.string().min(1).optional() });

type Schema = z.core.JSONSchema.JSONSchema;
type SchemaNode = z.core.JSONSchema._JSONSchema;
type ToolDefinition = Pick<Tool, "name" | "inputSchema"> & { description: string; annotations: ToolAnnotations };
type Call = (op: string, project: string | null, input: unknown) => Promise<Reply>;
type ListProjects = () => Promise<string[]>;

function objectSchema(schema: SchemaNode): Schema {
	return typeof schema === "boolean" ? (schema ? {} : { not: {} }) : schema;
}

function mapSchemas(schema: Schema, visit: (child: SchemaNode) => SchemaNode): Schema {
	const result = { ...schema };
	for (const key of ["properties", "patternProperties", "dependentSchemas"] satisfies (
		| "properties"
		| "patternProperties"
		| "dependentSchemas"
	)[]) {
		const children = schema[key];
		if (children)
			result[key] = Object.fromEntries(Object.entries(children).map(([name, child]) => [name, visit(child)]));
	}
	if (schema.$defs)
		result.$defs = Object.fromEntries(
			Object.entries(schema.$defs).map(([name, child]) => [name, objectSchema(visit(child))]),
		);
	for (const key of ["allOf", "anyOf", "oneOf"] satisfies ("allOf" | "anyOf" | "oneOf")[]) {
		const children = schema[key];
		if (children) result[key] = children.map((child) => objectSchema(visit(child)));
	}
	if (schema.items !== undefined)
		result.items = Array.isArray(schema.items) ? schema.items.map(visit) : visit(schema.items);
	for (const key of ["additionalProperties", "propertyNames", "not", "if", "then", "else"] satisfies (
		| "additionalProperties"
		| "propertyNames"
		| "not"
		| "if"
		| "then"
		| "else"
	)[]) {
		const child = schema[key];
		if (child !== undefined) result[key] = visit(child);
	}
	return result;
}

function compactSchema(schema: SchemaNode, envelope = false): SchemaNode {
	if (typeof schema === "boolean") return schema;
	const result = mapSchemas(schema, (child) => compactSchema(child));
	delete result.$schema;
	if (result.description) {
		const shorter = DESCRIPTIONS.get(result.description);
		if (shorter === "") delete result.description;
		else if (shorter !== undefined) result.description = shorter;
	}
	const values = "const" in result ? [result.const] : result.enum;
	if (
		values &&
		values.length > 0 &&
		values.every((value) =>
			result.type === "null"
				? value === null
				: result.type === "integer"
					? Number.isInteger(value)
					: typeof value === result.type,
		)
	)
		delete result.type;
	if (result.additionalProperties === true) delete result.additionalProperties;
	if (typeof result.additionalProperties === "object" && Object.keys(result.additionalProperties).length === 0)
		delete result.additionalProperties;
	if (
		typeof result.propertyNames === "object" &&
		result.propertyNames.type === "string" &&
		Object.keys(result.propertyNames).length === 1
	)
		delete result.propertyNames;
	if (result.required?.length === 0) delete result.required;
	if (envelope) {
		if (result.properties) {
			const { cmd: _cmd, ...properties } = result.properties;
			result.properties = properties;
		}
		if (result.required?.includes("cmd")) result.required = result.required.filter((name) => name !== "cmd");
		for (const key of ["allOf", "anyOf", "oneOf"] satisfies ("allOf" | "anyOf" | "oneOf")[]) {
			const choices = schema[key];
			if (choices) result[key] = choices.map((choice) => objectSchema(compactSchema(choice, true)));
		}
	}
	return result;
}

function dedupeSchema(schema: Schema): Schema {
	let result = schema;
	const definitions: Record<string, Schema> = {};
	for (;;) {
		const repeated = new Map<string, { schema: Schema; count: number }>();
		const count = (node: SchemaNode): SchemaNode => {
			if (typeof node === "boolean") return node;
			const key = JSON.stringify(node);
			if (key.length >= 70) {
				const prior = repeated.get(key);
				repeated.set(key, { schema: node, count: (prior?.count ?? 0) + 1 });
			}
			return mapSchemas(node, count);
		};
		count(result);
		const name = String(Object.keys(definitions).length);
		const reference = { $ref: `#/$defs/${name}` };
		const cost = JSON.stringify(reference).length;
		const candidates = [...repeated.entries()]
			.filter(([key, entry]) => entry.count > 1 && (entry.count - 1) * key.length > entry.count * cost + 50)
			.sort(([a, left], [b, right]) => (right.count - 1) * b.length - (left.count - 1) * a.length);
		const chosen = candidates[0];
		if (!chosen) break;
		const [key, entry] = chosen;
		const replace = (node: SchemaNode): SchemaNode => {
			if (typeof node === "boolean") return node;
			return JSON.stringify(node) === key ? reference : mapSchemas(node, replace);
		};
		result = objectSchema(replace(result));
		definitions[name] = entry.schema;
	}
	return Object.keys(definitions).length === 0 ? result : { ...result, $defs: { ...result.$defs, ...definitions } };
}

/** Lists only the registry's agent operations, with compact input schemas and truthful tool hints. */
export function mcpTools(): ToolDefinition[] {
	const tools: ToolDefinition[] = [];
	for (const op of MCP_OPS) {
		if (op.mcp === null) continue;
		const compact = compactSchema(z.toJSONSchema(op.input, { io: "input" }), true);
		if (typeof compact === "boolean") throw new Error(`${op.name} needs an object schema`);
		const deduped = dedupeSchema(compact);
		const schema = {
			...deduped,
			type: "object",
			properties: {
				...deduped.properties,
				project: { type: "string", minLength: 1, description: PROJECT_DESCRIPTION },
			},
		};
		tools.push({
			name: op.name,
			description: op.mcp,
			inputSchema: ToolSchema.shape.inputSchema.parse(schema),
			annotations: {
				title: op.name,
				destructiveHint: false,
				...(op.effect === "read" ? { readOnlyHint: true, idempotentHint: true } : {}),
				openWorldHint: false,
			},
		});
	}
	return tools;
}

function toolError(code: string, message: string): CallToolResult {
	return { isError: true, content: [{ type: "text", text: `${code}: ${message}` }] };
}

const ValidationIssue = z.object({
	path: z.array(z.union([z.string(), z.number()])),
	message: z.string(),
	errors: z.array(z.array(z.unknown())).optional(),
});

/** Names fields inside union errors. Other operation messages pass through unchanged. */
function errorMessage(error: Extract<Reply, { ok: false }>["error"]): string {
	if (error.code !== "invalid") return error.message;
	const issues = z.array(z.unknown()).safeParse(error.details?.issues);
	if (!issues.success) return error.message;
	let remaining = 12;
	const describe = (value: unknown): string | null => {
		if (remaining === 0) return null;
		const parsed = ValidationIssue.safeParse(value);
		if (!parsed.success) return null;
		const issue = parsed.data;
		const path = issue.path.join(".") || "input";
		if (issue.errors?.length) {
			const choices = issue.errors
				.map((choice) =>
					choice
						.map(describe)
						.filter((entry) => entry !== null)
						.join("; "),
				)
				.filter((choice) => choice !== "");
			if (choices.length > 0) return `${path}: ${choices.map((choice) => `[${choice}]`).join(" or ")}`;
		}
		remaining--;
		return `${path}: ${issue.message}`;
	};
	const messages = issues.data.map(describe).filter((entry) => entry !== null);
	return messages.length > 0 ? [...new Set(messages)].join("; ") : error.message;
}

class AgentServer extends McpServer {
	private protocolVersion: string;

	constructor(call: Call, listProjects: ListProjects, protocolVersion: string) {
		super({ name: "mainworthy", version: VERSION }, { instructions: INSTRUCTIONS });
		this.protocolVersion = protocolVersion;
		const tools = mcpTools();
		for (const tool of tools) {
			this.registerTool(
				tool.name,
				{ description: tool.description, annotations: tool.annotations, inputSchema: Arguments },
				async (args) => {
					const { project, ...input } = args;
					let selected = project;
					if (selected === undefined) {
						const projects = await listProjects();
						if (projects.length !== 1)
							return toolError("invalid", "project: required unless the instance has exactly one project");
						selected = projects[0];
					}
					const reply = await call(tool.name, selected ?? null, input);
					if (!reply.ok) return toolError(reply.error.code, errorMessage(reply.error));
					const result = { result: reply.result ?? null, seq: reply.seq };
					return {
						content: [{ type: "text", text: JSON.stringify(result) }],
						...(this.protocolVersion >= "2025-06-18" ? { structuredContent: result } : {}),
					};
				},
			);
		}
		// McpServer owns tools/call. Its custom-handler API lets tools/list use the measured schemas.
		this.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
		this.server.registerCapabilities({ tools: { listChanged: false } });
	}

	override async connect(transport: Transport): Promise<void> {
		const send = transport.send.bind(transport);
		transport.send = async (message, options) => {
			if ("result" in message) {
				const initialized = InitializeResultSchema.safeParse(message.result);
				if (initialized.success) this.protocolVersion = initialized.data.protocolVersion;
			}
			await send(message, options);
		};
		await super.connect(transport);
	}
}

/** Creates the shared server; the caller supplies operation calls and the instance's current project keys. */
export function mcpServer(
	call: Call,
	listProjects: ListProjects,
	protocolVersion = LATEST_PROTOCOL_VERSION,
): McpServer {
	return new AgentServer(call, listProjects, protocolVersion);
}

/** Handles /mcp behind HTTP authentication. Each request owns its server, transport, and actor. */
export function mcpRoute(app: App): (req: Request, session: Session) => Promise<Response> {
	return async (req, session) => {
		if (req.method !== "POST") {
			return new Response(null, { status: 405, headers: { allow: "POST" } });
		}
		const server = mcpServer(
			(op, project, input) => invokeAsync(app, OPS, { op, project, input, actor: session.actor }),
			async () => grantedProjects(app, session).map((row) => row.key),
			req.headers.get("mcp-protocol-version") ?? DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
		);
		const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
		try {
			await server.connect(transport);
			return await transport.handleRequest(req);
		} finally {
			await server.close();
		}
	};
}

/** Starts stdio without opening a database. The CLI forwards calls and project reads to the running instance. */
export async function runStdio(call: Call, listProjects: ListProjects): Promise<void> {
	await mcpServer(call, listProjects).connect(new StdioServerTransport());
}
