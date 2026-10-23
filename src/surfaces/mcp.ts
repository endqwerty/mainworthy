import { PassThrough } from "node:stream";
import { ToolSchema } from "@modelcontextprotocol/core";
import {
	type CallToolResult,
	createMcpHandler,
	DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
	isLegacyRequest,
	LATEST_PROTOCOL_VERSION,
	McpServer,
	ProtocolErrorCode,
	type Tool,
	type ToolAnnotations,
	type Transport,
	WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import type { Session } from "../server/identity/identity.ts";
import type { App } from "../server/kernel/app.ts";
import { MCP_OPS, OPS } from "../server/ops/index.ts";
import { invoke, type Reply } from "../server/ops/registry.ts";
import { grantedProjects, VERSION } from "./http.ts";

/** The tools/list size agents should expect, in o200k_base tokens: a guideline, not a gate (decision 0118). */
export const TOOL_TOKEN_GUIDELINE = { total: 5000, perTool: 1500 };

const INSTRUCTIONS =
	"Start with impact for a change or inbox for questions, and omit project only when the instance has exactly one project. Pass etag back with unless and hashes with onEvidence, and page impact's next as cursor before saving its final cursor for since. Your answers may be advice; check the reply status, and with admin, read base for policy clauses or settings through CLI policy show --json or HTTP admin policy.show.";
const DESCRIPTIONS = new Map([
	["Exact commit from impact's change.head; required for review reuse.", ""],
	["Current code host head.", ""],
	["C-, Q-, R-, T-, P-, commit:hash or change:key.", ""],
	["For commit refs: disambiguate repositories.", ""],
	["Slot id from find slots. Omit to take the next free unfinished slot.", ""],
	["Lease length in seconds, from 30 to 86400. Default: 900.", ""],
	[
		"The model that produced this report's results. Agent tokens only; 1 to 120 characters after trimming.",
		"Agent model.",
	],
	["The case, for example C-311.", ""],
	["The version this edit was made on. A stale base is merged or reported, never overwritten.", ""],
	["Required with clauses or settings.", ""],
	["The case.", ""],
	["The version to restore.", ""],
	["The folder to change. Absent when creating one.", ""],
	["Why. Shown in the case history.", ""],
	["What was tested. Required unless `run` is given.", ""],
	["The commit this change is based on.", ""],
	["Paths the change touches, for impact.", ""],
	["A planned run these results are for, for example R-4.", ""],
	["The case this manual or agent result is for.", ""],
	["The id of an earlier result of yours that this one replaces.", ""],
	["The kind of review, for example adversarial-review.", ""],
	["The change reviewed, for example pr:482.", ""],
	["Cases read, each as C-311@<hash>. Recorded even with no findings.", ""],
	["Where: a case (C-311), a step (C-311#b7), a requirement (req:WEB-290) or a change (pr:482).", ""],
	["The question, for example Q-12.", ""],
	["The evidence hash you saw. If the evidence changed since, the reply is a conflict with the new evidence.", ""],
	['The answer, for example {"is":"defect"}. The allowed answers depend on the question kind.', ""],
	["The question whose decision to withdraw.", ""],
	["Only questions about this case, run, test or change.", ""],
	["The cursor from the previous page.", ""],
	["For one proposal: the cursor from its previous page of edits. Restart without it after a project change.", ""],
	["Refs of cases (C-), questions (Q-), runs (R-), tests (T-) or proposals (P-).", ""],
	["For cases: any of title, pre, steps, methods, tags, covers, place, proof. Default: all.", ""],
	["`md` returns a case as canonical Markdown: fewer tokens than JSON.", ""],
	["Ref to the etag from get for the same as/fields. Unchanged: {ref, unchanged: true, etag}.", ""],
	["For one case: this version instead of the current one.", ""],
	["With `folder`: include its subfolders.", ""],
	["For slots: the run.", ""],
	["For tests: only those with no case.", ""],
	["A change key, for example pr:482.", ""],
	["Changed paths, when the change is not known to Mainworthy.", ""],
	["A cursor from an earlier call: only what moved since.", ""],
	["False for fresh eyes: do not hide what was already reviewed.", ""],
	["A cursor from any earlier read.", ""],
	["A change key, for example pr:482: the gate of its latest commit.", ""],
]);
const Arguments = z.looseObject({ project: z.string().min(1).optional() });

type Schema = z.core.JSONSchema.JSONSchema;
type SchemaNode = z.core.JSONSchema._JSONSchema;
type ToolDefinition = Pick<Tool, "name" | "inputSchema" | "outputSchema"> & {
	description: string;
	annotations: ToolAnnotations;
};
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

/** Keys that describe a schema without changing what it accepts. */
const ANNOTATIONS = new Set(["description", "default", "title", "examples"]);

/**
 * A union whose hidden choices leave one is that choice, under the union's own annotations. Only a union that
 * carries nothing but annotations is replaced: a keyword beside it (additionalProperties, if, properties...) could
 * apply to the choice differently once merged. Any other union keeps its one choice, which says the same thing.
 */
function collapseHiddenUnion(schema: Exclude<SchemaNode, boolean>): SchemaNode | undefined {
	for (const key of ["anyOf", "oneOf"] satisfies ("anyOf" | "oneOf")[]) {
		const choices = schema[key];
		if (!choices) continue;
		const kept = choices.filter((child) => child["x-mcp-hidden"] !== true);
		const only = kept[0];
		if (kept.length !== 1 || kept.length === choices.length || only === undefined || typeof only === "boolean")
			continue;
		const { [key]: _, ...parent } = schema;
		if (Object.keys(parent).some((name) => !ANNOTATIONS.has(name))) continue;
		const merged: Exclude<SchemaNode, boolean> = { ...parent, ...only };
		for (const name of ANNOTATIONS) if (name in parent) Object.assign(merged, { [name]: parent[name] });
		return merged;
	}
	return undefined;
}

/** A keyword that can name a place in the document; a union could be that place. */
const REFERENCE = /"\$(ref|dynamicRef|recursiveRef|id|anchor|dynamicAnchor|recursiveAnchor)"/;

/**
 * `collapse` is decided once for the whole document: a reference anywhere in it could point into a union by path or
 * by anchor, so a document with one keeps every union as it is, hidden choices included, since removing one would
 * also move the index of the choices after it.
 */
export function compactSchema(
	schema: SchemaNode,
	envelope = false,
	collapse = !REFERENCE.test(JSON.stringify(schema)),
): SchemaNode {
	if (typeof schema === "boolean") return schema;
	const collapsed = collapse ? collapseHiddenUnion(schema) : undefined;
	if (collapsed !== undefined) return compactSchema(collapsed, envelope, collapse);
	const visible = { ...schema };
	if (schema.properties)
		visible.properties = Object.fromEntries(
			Object.entries(schema.properties).filter(
				([name, child]) =>
					typeof child === "boolean" || child["x-mcp-hidden"] !== true || schema.required?.includes(name),
			),
		);
	for (const key of ["anyOf", "oneOf"] satisfies ("anyOf" | "oneOf")[]) {
		const choices = schema[key];
		if (choices && collapse) visible[key] = choices.filter((child) => child["x-mcp-hidden"] !== true);
	}
	const result = mapSchemas(visible, (child) => compactSchema(child, false, collapse));
	delete result["x-mcp-hidden"];
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
			const choices = visible[key];
			if (choices) result[key] = choices.map((choice) => objectSchema(compactSchema(choice, true, collapse)));
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
			if (key.length >= 40) {
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
			.filter(([key, entry]) => entry.count > 1 && (entry.count - 1) * key.length > entry.count * cost + 10)
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

let toolDefinitions: ToolDefinition[] | undefined;

function freezeDefinition(value: unknown): void {
	if (typeof value !== "object" || value === null) return;
	for (const child of Object.values(value)) freezeDefinition(child);
	Object.freeze(value);
}

/** Lists only the registry's agent operations, as an independently mutable copy. */
export function mcpTools(): ToolDefinition[] {
	return structuredClone(registryTools());
}

function registryTools(): ToolDefinition[] {
	if (toolDefinitions) return toolDefinitions;
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
				project: { type: "string", minLength: 1 },
			},
		};
		const output = z.toJSONSchema(op.output);
		const result = {
			...(output.type ? { type: output.type } : {}),
			...(output.required ? { required: output.required } : {}),
		};

		tools.push({
			name: op.name,
			description: op.mcp,
			inputSchema: ToolSchema.shape.inputSchema.parse(schema),
			outputSchema: {
				type: "object",
				properties: { result, seq: { type: ["integer", "null"] } },
				required: ["result", "seq"],
			},
			annotations: {
				destructiveHint: false,
				...(op.effect === "read" ? { readOnlyHint: true, idempotentHint: true } : {}),
				openWorldHint: false,
			},
		});
	}
	freezeDefinition(tools);
	toolDefinitions = tools;
	return toolDefinitions;
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
	constructor(call: Call, listProjects: ListProjects, protocolVersion: string) {
		super({ name: "mainworthy", version: VERSION }, { instructions: INSTRUCTIONS });
		const tools = registryTools();
		const supportsStructured = () => (this.server.getNegotiatedProtocolVersion() ?? protocolVersion) >= "2025-06-18";
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
						...(supportsStructured() ? { structuredContent: result } : {}),
					};
				},
			);
		}
		// McpServer owns tools/call. Its custom-handler API lets tools/list use the measured schemas.
		this.server.setRequestHandler("tools/list", () => ({
			tools: supportsStructured() ? tools : tools.map(({ outputSchema: _output, ...tool }) => tool),
		}));
		this.server.registerCapabilities({ tools: { listChanged: false } });
	}

	override async connect(transport: Transport): Promise<void> {
		const send = transport.send.bind(transport);
		transport.send = async (message, options) => {
			// SDK v2 moved unknown tools out of its tool-error handler. Keep Mainworthy's tool reply contract.
			if (
				"error" in message &&
				message.id !== undefined &&
				message.error.code === ProtocolErrorCode.InvalidParams &&
				/^Tool .+ (?:not found|disabled)$/.test(message.error.message)
			) {
				await send(
					{
						jsonrpc: "2.0",
						id: message.id,
						result: {
							...toolError("invalid", message.error.message),
							...(this.server.getNegotiatedProtocolVersion() === "2026-07-28" ? { resultType: "complete" } : {}),
						},
					},
					options,
				);
				return;
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
		const buildServer = () =>
			mcpServer(
				async (op, project, input) =>
					await invoke(app, OPS, {
						op,
						project,
						input,
						actor: session.actor,
						...(session.reference ? { reference: session.reference() } : {}),
					}),
				async () => grantedProjects(app, session).map((row) => row.key),
				req.headers.get("mcp-protocol-version") ?? DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
			);
		if (!(await isLegacyRequest(req))) {
			const handler = createMcpHandler(buildServer, { legacy: "reject" });
			try {
				return await handler.fetch(req);
			} finally {
				await handler.close();
			}
		}
		const server = buildServer();
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
	// Keep replies to accepted requests when a piped client closes stdin after its last message.
	const input = new PassThrough();
	const wire = new StdioServerTransport(input);
	const pending = new Set<string | number>();
	let ended = false;
	const finish = () => {
		if (ended && pending.size === 0) input.end();
	};
	const onEnd = () => {
		ended = true;
		finish();
	};
	const transport: Transport = {
		async start() {
			wire.onmessage = (message) => {
				if ("method" in message && "id" in message) pending.add(message.id);
				transport.onmessage?.(message);
			};
			wire.onerror = (error) => transport.onerror?.(error);
			wire.onclose = () => transport.onclose?.();
			await wire.start();
			process.stdin.once("end", onEnd);
			process.stdin.pipe(input, { end: false });
		},
		async send(message) {
			await wire.send(message);
			if (("result" in message || "error" in message) && message.id !== undefined) pending.delete(message.id);
			finish();
		},
		async close() {
			process.stdin.unpipe(input);
			process.stdin.off("end", onEnd);
			await wire.close();
		},
	};
	serveStdio(() => mcpServer(call, listProjects), { legacy: "serve", transport });
}
