import { expect, test } from "bun:test";
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import {
	CallToolResultSchema,
	InitializeResultSchema,
	ListToolsResultSchema,
	ToolSchema,
} from "@modelcontextprotocol/core";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { encode } from "gpt-tokenizer/encoding/o200k_base";
import { z } from "zod";
import { generateToolReference } from "../../scripts/gen-skill.ts";
import { harness } from "../../test/helpers.ts";
import type { Ask } from "../core/kinds.ts";
import { FindInput, type InboxReply, ProposeInput } from "../core/ops.ts";
import { PRESETS } from "../core/presets.ts";
import { REPLIES } from "../core/replies.ts";
import { actorByName, createToken, listTokens } from "../server/identity/identity.ts";
import { MCP_OPS, OPS } from "../server/ops/index.ts";
import { invoke, invokeAsync } from "../server/ops/registry.ts";
import { serve, sessionOf, VERSION } from "./http.ts";
import { compactSchema, mcpRoute, mcpServer, mcpTools, TOOL_TOKEN_BUDGET } from "./mcp.ts";

const tokens = (value: unknown): number => encode(JSON.stringify(value)).length;
const TOKEN_COUNTS: Record<string, number> = {
	propose: 1388,
	report: 710,
	claim: 390,
	decide: 318,
	inbox: 166,
	get: 193,
	find: 263,
	impact: 200,
	since: 158,
	gate: 160,
};

function resultOf<S extends z.ZodType>(reply: unknown, schema: S): z.output<S> {
	const result = CallToolResultSchema.parse(reply);
	expect(result.isError).not.toBe(true);
	const text = result.content[0];
	if (text?.type !== "text") throw new Error("The tool did not return text");
	const envelope = z.object({ result: z.unknown(), seq: z.number().nullable() }).parse(JSON.parse(text.text));
	expect(text.text).toBe(JSON.stringify(envelope));
	expect(result.structuredContent).toEqual(envelope);
	return schema.parse(envelope.result);
}

test("tools/list names every proposal and decision reply status", () => {
	const tools = mcpTools();
	for (const [name, statuses] of [
		["propose", REPLIES.propose.shape.status.options],
		["decide", REPLIES.decide.element.shape.status.options],
	] as const) {
		const tool = tools.find((entry) => entry.name === name);
		if (!tool) throw new Error(name);
		for (const status of statuses) expect(tool.description).toContain(status);
	}
});

test("tools/list explains proposal statuses and how to identify reported tests", () => {
	const tools = mcpTools();
	expect(tools.find((tool) => tool.name === "propose")?.description).toBe(
		"Propose cases at their base version. Status: adopted=current, open=needs acceptance, conflict=resolve, rejected.",
	);
	expect(tools.find((tool) => tool.name === "report")?.description).toBe(
		"Record test results in one batch. Give `target` (the commit tested) or `run` (a planned run). Each result names a test by `key` or a case by ref.",
	);
});

test("tools come from the registry and stay within their measured token limits", () => {
	const tools = mcpTools();
	expect(tools.map((tool) => tool.name)).toEqual(MCP_OPS.map((op) => op.name));
	expect(tools.length).toBeLessThanOrEqual(10);
	const total = tokens({ tools });
	expect(total, "Full tools/list token budget").toBeLessThanOrEqual(TOOL_TOKEN_BUDGET);
	expect(TOOL_TOKEN_BUDGET).toBe(Math.ceil(total / 50) * 50);
	for (const tool of tools) {
		const expected = TOKEN_COUNTS[tool.name];
		if (expected === undefined) throw new Error(`No token count recorded for ${tool.name}`);
		expect(tokens(tool), `${tool.name} tokens; update the measured table after reviewing the change`).toBe(expected);
		const op = MCP_OPS.find((entry) => entry.name === tool.name);
		if (!op) throw new Error(`No operation found for ${tool.name}`);
		if (op.mcp === null) throw new Error(`No tool description for ${tool.name}`);
		expect(tool.description).toBe(op.mcp);
		expect(tool.annotations.readOnlyHint ?? false).toBe(op.effect === "read");
		expect(tool.annotations.destructiveHint).toBe(false);
		expect(tool.annotations.openWorldHint).toBe(false);
		if (op.effect === "read") expect(tool.annotations.idempotentHint).toBe(true);
		expect(JSON.stringify(tool.inputSchema)).not.toContain('"cmd"');
		expect(JSON.stringify(tool.inputSchema)).not.toContain('"$schema"');
		expect(JSON.stringify(tool.inputSchema)).not.toContain('"x-mcp-hidden"');
		expect(tool.inputSchema.properties?.project).toMatchObject({ type: "string", minLength: 1 });
	}
	console.log(`tool definitions: ${total} tokens; budget ${TOOL_TOKEN_BUDGET}; o200k_base`);
	console.table(tools.map((tool) => ({ tool: tool.name, tokens: tokens(tool) })));
});

test("report tools omit the CI-only nothing-required declaration", () => {
	const tool = mcpTools().find((entry) => entry.name === "report");
	if (!tool) throw new Error("report");
	expect(Object.keys(tool.inputSchema.properties ?? {})).toContain("results");
	expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain("nothingRequired");
});

test("propose keeps role selectors out of MCP's listing while core accepts them", () => {
	const tool = mcpTools().find((entry) => entry.name === "propose");
	if (!tool) throw new Error("propose");
	const { properties, required, ...base } = tool.inputSchema;
	const schema: Record<string, unknown> = {
		...base,
		...(properties ? { properties } : {}),
		...(required ? { required } : {}),
	};
	const validate = new AjvJsonSchemaValidator().getValidator(schema);
	const input = (who: Ask["who"]): ProposeInput => ({
		edits: [
			{
				op: "policy",
				base: 1,
				clauses: [
					{
						id: "signoff-role",
						kind: "signoff",
						when: ["always"],
						ask: { who, agents: "none", notProducer: true, reason: "required" },
						blocks: "release",
					},
				],
			},
		],
	});
	const role = input("role:approver");
	expect(ProposeInput.parse(role)).toEqual(role);
	for (const who of ["rule", "member", "admin", "author"] satisfies Ask["who"][])
		expect(validate(input(who)).valid).toBe(true);
	expect(validate(role).valid).toBe(false);
	expect(JSON.stringify(tool.inputSchema)).not.toContain("role:");
});

test("a union left with one choice after hiding is that choice, still compacted", () => {
	const node = (schema: unknown) => compactSchema(schema as Parameters<typeof compactSchema>[0]);
	const hidden = { "x-mcp-hidden": true };
	// A hidden field inside the remaining choice stays hidden.
	expect(
		node({
			description: "Where",
			anyOf: [
				{ type: "object", properties: { a: { type: "integer" }, b: { type: "integer", ...hidden } } },
				{ type: "null", ...hidden },
			],
		}),
	).toEqual(node({ description: "Where", type: "object", properties: { a: { type: "integer" } } }));
	// A hidden choice of a union inside the remaining choice is dropped too.
	expect(
		node({
			anyOf: [
				{ anyOf: [{ type: "integer" }, { type: "number", ...hidden }, { type: "boolean" }] },
				{ type: "null", ...hidden },
			],
		}),
	).toEqual(node({ anyOf: [{ type: "integer" }, { type: "boolean" }] }));
	// A keyword beside the union could apply to the merged choice differently, so the union stays.
	for (const beside of [{ additionalProperties: false }, { if: { type: "integer" } }]) {
		const choice = { type: "object", properties: { q: { type: "integer" } }, required: ["q"] };
		expect(node({ ...beside, anyOf: [choice, { type: "null", ...hidden }] })).toMatchObject({
			...beside,
			anyOf: [{ required: ["q"] }],
		});
	}
	// A reference from outside the union that points into it stays valid: a document with a reference keeps its unions.
	const outside = node({
		$defs: {
			a: {
				anyOf: [
					{ $defs: { s: { type: "string" } }, type: "string" },
					{ type: "null", ...hidden },
				],
			},
		},
		$ref: "#/$defs/a/anyOf/0/$defs/s",
	});
	expect(outside).toMatchObject({ $defs: { a: { anyOf: [{ $defs: { s: { type: "string" } } }, { type: "null" }] } } });
	// So does a dynamic reference, and an anchor a reference could name.
	for (const reference of [{ $dynamicRef: "#/$defs/a/anyOf/0" }, { $anchor: "here" }]) {
		const kept = node({ $defs: { a: { anyOf: [{ type: "string" }, { type: "null", ...hidden }] } }, ...reference });
		expect(kept).toMatchObject({ $defs: { a: { anyOf: [{ type: "string" }, { type: "null" }] } } });
	}
	// A hidden choice before a referenced one stays too, so the reference does not move to another choice.
	const shifted = node({
		$defs: { a: { anyOf: [{ type: "null", ...hidden }, { type: "string" }, { type: "integer" }] } },
		$ref: "#/$defs/a/anyOf/1",
	});
	expect(shifted).toMatchObject({
		$defs: { a: { anyOf: [{ type: "null" }, { type: "string" }, { type: "integer" }] } },
	});
	// A reference that points through the union stays valid because the union stays.
	const pointed = { $defs: { s: { type: "string" } }, $ref: "#/anyOf/0/$defs/s" };
	expect(node({ anyOf: [pointed, { type: "null", ...hidden }] })).toMatchObject({
		anyOf: [{ $ref: "#/anyOf/0/$defs/s" }, { type: "null" }],
	});
	// A choice that shares a structural key with its union stays a union.
	expect(
		node({
			type: "object",
			properties: { p: { type: "integer" } },
			required: ["p"],
			anyOf: [
				{ type: "object", properties: { q: { type: "integer" } }, required: ["q"] },
				{ type: "null", ...hidden },
			],
		}),
	).toMatchObject({ properties: { p: {} }, required: ["p"], anyOf: [{ required: ["q"] }] });
});

test("find lists deployments for CLI and HTTP but keeps MCP's earlier choices", () => {
	const tool = mcpTools().find((entry) => entry.name === "find");
	const choice = (tool?.inputSchema.properties as Record<string, { enum?: string[]; anyOf?: unknown }>)?.in;
	expect(choice?.anyOf).toBeUndefined();
	expect(choice?.enum).toContain("changes");
	expect(choice?.enum).not.toContain("deployments");
	expect(FindInput.parse({ in: "deployments" }).in).toBe("deployments");
});

test("report tools offer code targets and planned runs without direct build targets", () => {
	const tool = mcpTools().find((entry) => entry.name === "report");
	if (!tool) throw new Error("report");
	const { properties, required, ...base } = tool.inputSchema;
	const schema: Record<string, unknown> = {
		...base,
		...(properties ? { properties } : {}),
		...(required ? { required } : {}),
	};
	const validate = new AjvJsonSchemaValidator().getValidator(schema);
	const results = [{ test: { case: "C-1" }, outcome: "pass" }];
	expect(validate({ target: { build: "rc3", env: "staging" }, results }).valid).toBe(false);
	expect(validate({ target: { commit: "abcdef1" }, results }).valid).toBe(true);
	expect(validate({ run: "R-1", results }).valid).toBe(true);
});

test("quarantine edits stay available in the registry and out of MCP discovery", () => {
	const tool = mcpTools().find((tool) => tool.name === "propose");
	const op = MCP_OPS.find((op) => op.name === "propose");
	if (!tool || !op) throw new Error("missing propose");
	const input = {
		edits: [{ op: "quarantine", test: "T-1", base: null, exit: { kind: "person" } }],
		reason: "Unreliable checkout",
	};
	expect(op.input.safeParse(input).success).toBe(true);
	expect(JSON.stringify(tool.inputSchema)).not.toContain('"quarantine"');
	const { properties, required, ...base } = tool.inputSchema;
	const schema: Record<string, unknown> = {
		...base,
		...(properties ? { properties } : {}),
		...(required ? { required } : {}),
	};
	const validator = new AjvJsonSchemaValidator().getValidator(schema);
	expect(validator(input).valid).toBe(false);
});

test("schema trims preserve the registry's constraints and union choices", () => {
	const validator = new AjvJsonSchemaValidator();
	const compile = (schema: ReturnType<typeof mcpTools>[number]["inputSchema"]) => {
		const { properties, required, ...base } = schema;
		const jsonSchema: Record<string, unknown> = {
			...base,
			...(properties ? { properties } : {}),
			...(required ? { required } : {}),
		};
		return validator.getValidator(jsonSchema);
	};
	const samples: Record<string, unknown[]> = {
		propose: [
			{},
			{ edits: [] },
			{ edits: [{ op: "create", outline: "A case\n  Click > A value" }] },
			{ edits: [{ op: "edit", case: "C-1", base: 1 }] },
			{ edits: [{ op: "edit", case: "C-1", base: 1.5 }] },
			{ edits: [{ op: "policy", base: 1, preset: "strict" }] },
			{ edits: [{ op: "policy", base: 0, preset: "strict" }] },
			{ edits: [{ op: "policy", base: 1.5, preset: "strict" }] },
			{ edits: [{ op: "state", cases: ["C-1"], to: "archived" }] },
			{ edits: [{ op: "restore", case: "C-1", to: 2 }] },
			{ edits: [{ op: "create", body: { steps: [{ id: "!", action: "", expected: null }] } }] },
		],
		decide: [
			{},
			{ q: "Q-1", onEvidence: "hash", answer: { is: "defect" } },
			{ q: "Q-1", answer: { is: "defect" } },
			{ all: [{ q: "Q-1", onEvidence: "hash", answer: { is: "defect" } }] },
			{ all: [] },
			{ undo: "Q-1" },
		],
		report: [
			{ results: [] },
			{ target: { commit: "abc" }, results: [{ test: { case: "C-1" }, outcome: "fail" }] },
			{ target: { commit: "abcdef1" }, results: [{ test: { case: "C-1" }, outcome: "fail" }] },
			{ run: "R-1", results: [{ test: { key: "test" }, outcome: "wrong" }] },
		],
		get: [{ refs: [] }, { refs: ["C-1"], as: "md" }, { refs: [1] }, { refs: ["C-1"], unless: { "C-1": "hash" } }],
		claim: [
			{},
			{ lens: "adversarial-review" },
			{ lens: "", findings: [] },
			{ lens: "review", findings: [{ on: "C-1", category: "cannot-fail", note: "Allows a wrong total" }] },
			{ lens: "review", findings: [{ on: "C-1", category: "wrong", note: "A note" }] },
		],
		inbox: [{}, { kind: "failure" }, { kind: "defect" }, { state: "wrong" }, { limit: 0 }, { limit: 501 }],
		find: [{}, { folder: 4, deep: true }, { in: "tests", unlinked: true }, { in: "wrong" }, { unlinked: "true" }],
		impact: [{}, { files: ["checkout.ts"] }, { files: [4] }, { ledger: false }, { ledger: "false" }, { since: 2 }],
		since: [{}, { cursor: "s:1" }, { cursor: 3 }, { cursor: "s:1", limit: 0 }, { cursor: "s:1", limit: 501 }],
		gate: [{}, { commit: "9f3c2ab" }, { run: "R-1" }, { commit: 4 }, { env: false }],
	};
	for (const tool of mcpTools()) {
		const op = MCP_OPS.find((entry) => entry.name === tool.name);
		if (!op) throw new Error(`Missing operation ${tool.name}`);
		const { $schema: _dialect, ...originalSchema } = z.toJSONSchema(op.input, { io: "input" });
		const original = compile(ToolSchema.shape.inputSchema.parse({ ...originalSchema, type: "object" }));
		const compact = compile(tool.inputSchema);
		const inputs = samples[tool.name];
		if (!inputs) throw new Error(`No schema samples for ${tool.name}`);
		for (const input of inputs) {
			expect(compact(input).valid, `${tool.name}: ${JSON.stringify(input)}`).toBe(original(input).valid);
		}
	}
});

test("compact output schemas describe structured results from the registry", () => {
	const validator = new AjvJsonSchemaValidator();
	const compile = (schema: NonNullable<ReturnType<typeof mcpTools>[number]["outputSchema"]>) => {
		const { properties, required, ...base } = schema;
		const jsonSchema: Record<string, unknown> = {
			...base,
			...(properties ? { properties } : {}),
			...(required ? { required } : {}),
		};
		return validator.getValidator(jsonSchema);
	};
	for (const tool of mcpTools()) {
		if (!tool.outputSchema) throw new Error(`${tool.name}: missing output schema`);
		const validate = compile(tool.outputSchema);
		expect(validate({ seq: 1 }).valid, `${tool.name}: missing result`).toBe(false);
		expect(validate({ result: null, seq: 1 }).valid, `${tool.name}: wrong result type`).toBe(false);
		expect(validate({ result: {}, seq: "one" }).valid, `${tool.name}: wrong sequence`).toBe(false);
	}
	const gate = mcpTools().find((tool) => tool.name === "gate");
	if (!gate?.outputSchema) throw new Error("No gate output");
	const validate = compile(gate.outputSchema);
	expect(validate({ result: {}, seq: 1 }).valid).toBe(false);
	expect(
		validate({
			result: { run: null, verdict: "pending", reason: "No run", tally: {}, open: [], url: null, stale: false },
			seq: 1,
		}).valid,
	).toBe(true);
});

test("MCP role approval follows the current grant and requires a reason", async () => {
	const h = harness();
	const actor = h.actor("role-reviewer", "human", ["read", "produce", "answer"]);
	const server = mcpServer(
		async (op, project, input) =>
			invoke(h.app, OPS, { op, project, input, actor: (id) => actorByName(h.app.db, actor.name, id) }),
		async () => ["scratch"],
	);
	const client = new Client({ name: "role-client", version: "1" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	try {
		await server.connect(serverTransport);
		await client.connect(clientTransport);
		h.call("admin", { do: "grant.set", actor: actor.name, can: ["read", "produce", "answer"], roles: ["approver"] });
		const proposed = resultOf(
			await client.callTool({
				name: "propose",
				arguments: {
					edits: [
						{
							op: "policy",
							base: h.call<{ version: number }>("admin", { do: "policy.show", project: "scratch" }).version,
							clauses: PRESETS.strict.clauses.map((clause) =>
								clause.id === "adopt-any"
									? { ...clause, ask: { who: "role:approver", agents: "none", notProducer: true, reason: "required" } }
									: clause,
							),
						},
					],
				},
			}),
			REPLIES.propose,
		);
		expect(proposed.status).toBe("open");
		const policy = h.call<InboxReply>("inbox", { kind: "adopt" }).items[0];
		if (!policy) throw new Error("no policy question");
		h.call("decide", { q: policy.q, onEvidence: policy.evidenceHash, answer: { is: "accept" } });
		h.call("admin", { do: "grant.set", actor: actor.name, can: ["read", "produce", "answer"], roles: [] });
		h.call("propose", { edits: [{ op: "create", outline: "MCP reviewed case" }] });
		const question = h.call<InboxReply>("inbox", { kind: "adopt" }).items[0];
		if (!question) throw new Error("no case question");
		const decide = (reason: string) =>
			client.callTool({
				name: "decide",
				arguments: { q: question.q, onEvidence: question.evidenceHash, answer: { is: "accept" }, reason },
			});
		expect(resultOf(await decide("reviewed"), z.array(z.object({ status: z.string() })))).toEqual([
			{ status: "forbidden" },
		]);
		h.call("admin", { do: "grant.set", actor: actor.name, can: ["read", "produce", "answer"], roles: ["approver"] });
		expect(resultOf(await decide(" "), z.array(z.object({ status: z.string() })))).toEqual([{ status: "invalid" }]);
		expect(resultOf(await decide("independent review"), z.array(z.object({ status: z.string() })))).toEqual([
			{ status: "decided" },
		]);
		expect(h.call<{ title: string }[]>("get", { refs: ["C-1"] })[0]?.title).toBe("MCP reviewed case");
	} finally {
		await client.close();
		await server.close();
		h.close();
	}
});

test.each(["2025-11-25", "2026-07-28"])(
	"an agent completes a %s session, with hashes, advice, and compact reads",
	async (version) => {
		const h = harness();
		const actor = h.actor("reviewer", "agent", ["read", "produce"]);
		const client = new Client(
			{ name: "reference-agent", version: "1" },
			{
				versionNegotiation: { mode: version === "2026-07-28" ? { pin: version } : "legacy" },
			},
		);
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const wire: string[] = [];
		for (const transport of [clientTransport, serverTransport]) {
			const send = transport.send.bind(transport);
			transport.send = async (message, options) => {
				wire.push(JSON.stringify(message));
				await send(message, options);
			};
		}
		const server = serveStdio(
			() =>
				mcpServer(
					async (op, project, input) => invoke(h.app, OPS, { op, project, input, actor: () => actor }),
					async () => ["scratch"],
				),
			{ transport: serverTransport, legacy: "serve" },
		);
		try {
			await client.connect(clientTransport);
			const definitions = await client.listTools();
			expect(client.getNegotiatedProtocolVersion()).toBe(version);
			if (version === "2025-11-25") {
				expect(definitions).toEqual({ tools: mcpTools() });
			} else {
				const listed = {
					tools: mcpTools(),
					ttlMs: 0,
					cacheScope: "private",
					_meta: { "io.modelcontextprotocol/serverInfo": { name: "mainworthy", version: VERSION } },
				};
				// The client's listTools schema strips resultType; check the full envelope on the wire too.
				expect(definitions).toEqual(listed);
				expect(wire.map((message) => JSON.parse(message))).toContainEqual({
					jsonrpc: "2.0",
					id: expect.any(Number),
					result: { ...listed, resultType: "complete" },
				});
			}
			const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
			const initial = resultOf(
				await call("impact", { files: ["tests/checkout.spec.ts"] }),
				z.object({ cursor: z.string() }),
			);
			const proposed = resultOf(
				await call("propose", {
					edits: [
						{
							op: "create",
							body: {
								title: "Coupon total",
								steps: [{ id: "b7", action: "Apply SAVE10 to a $100 cart", expected: "Total shows $90.00" }],
							},
						},
					],
				}),
				z.object({
					status: z.literal("adopted"),
					cases: z.array(z.object({ ref: z.string(), version: z.number(), hash: z.string() })).min(1),
				}),
			);
			const created = proposed.cases[0];
			if (!created) throw new Error("No case was created");
			// The pull request's pipeline has reported its head: that is what makes `pr:482` exist. (What an agent
			// says about where a commit is counts for nothing until a pipeline or a person has reported the commit.)
			h.call(
				"report",
				{
					target: { commit: "9f3c2ab", pr: 482, branch: "coupon-total", files: ["tests/checkout.spec.ts"] },
					results: [{ test: { key: "tests/other.spec.ts::smoke" }, outcome: "pass" }],
				},
				h.actor("pipeline", "ci", ["read", "record"]),
			);
			const reported = resultOf(
				await call("report", {
					target: { commit: "9f3c2ab", pr: 482, files: ["tests/checkout.spec.ts"] },
					results: [
						{
							test: { case: created.ref },
							annotation: { case: created.ref, version: created.version },
							outcome: "fail",
							failure: { message: "Expected $90.00, got $100.00" },
						},
					],
				}),
				z.object({
					counts: z.object({ fail: z.literal(1) }),
					basis: z.object({ exact: z.literal(1) }),
					questions: z.array(z.object({ q: z.string() })),
				}),
			);
			expect(reported.questions.length).toBeGreaterThan(0);
			const inbox = resultOf(
				await call("inbox", { kind: "failure" }),
				z.object({
					items: z.array(z.object({ q: z.string(), evidenceHash: z.string(), you: z.literal("advice") })).min(1),
				}),
			);
			const question = inbox.items[0];
			if (!question) throw new Error("No failure question was raised");
			resultOf(
				await call("decide", {
					q: question.q,
					onEvidence: question.evidenceHash,
					answer: { is: "defect" },
					reason: "The total is wrong.",
				}),
				z.array(z.object({ status: z.literal("advised") })).length(1),
			);
			const impact = resultOf(
				await call("impact", { change: "pr:482", files: ["tests/checkout.spec.ts"] }),
				z.object({ cases: z.array(z.object({ id: z.string(), hash: z.string() })), cursor: z.string() }),
			);
			expect(impact.cases).toContainEqual({ id: created.ref, hash: created.hash });
			const got = resultOf(
				await call("get", { refs: [created.ref], as: "md" }),
				z.array(z.object({ ref: z.string(), hash: z.string(), md: z.string() })),
			);
			expect(got[0]?.md).toContain("> Total shows $90.00");
			const unchanged = resultOf(
				await call("get", { refs: [created.ref], as: "md", unless: { [created.ref]: created.hash } }),
				z.array(z.object({ ref: z.string(), unchanged: z.literal(true), hash: z.string() })),
			);
			expect(unchanged).toEqual([{ ref: created.ref, unchanged: true, hash: created.hash }]);
			resultOf(
				await call("claim", {
					lens: "adversarial-review",
					about: "pr:482",
					reviewed: [`${created.ref}@${created.hash}`],
					findings: [],
				}),
				z.object({ reviewed: z.literal(1) }),
			);
			const changed = resultOf(
				await call("since", { cursor: initial.cursor }),
				z.object({ changed: z.array(z.object({ ref: z.string() })), cursor: z.string() }),
			);
			expect(changed.changed).toContainEqual({ ref: created.ref });
			resultOf(
				await call("since", { cursor: changed.cursor }),
				z.object({ changed: z.array(z.unknown()).length(0), settled: z.array(z.unknown()).length(0) }),
			);
			const gate = resultOf(
				await call("gate", { commit: "9f3c2ab" }),
				z.object({ verdict: z.enum(["passed", "failed", "blocked", "pending"]), open: z.array(z.string()) }),
			);
			// What an agent reports is put to a person as a question, and never moves a commit's gate (decision 0009):
			// the gate reads what the pipeline reported, a pass, whatever the agent found.
			expect(gate.verdict).toBe("passed");
			expect(gate.open).toEqual([]);
			console.log(
				`${version} tokens served: ${wire.reduce((sum, message) => sum + encode(message).length, 0)}; ${wire.length} messages; definitions once; o200k_base`,
			);
		} finally {
			await client.close();
			await server.close();
			h.close();
		}
	},
);

test("tool errors name bad fields and require a project when the choice is ambiguous", async () => {
	const h = harness();
	h.call("admin", { do: "project.create", key: "other" });
	const server = mcpServer(
		async (op, project, input) => invoke(h.app, OPS, { op, project, input, actor: () => h.owner }),
		async () => ["scratch", "other"],
	);
	const client = new Client({ name: "bad-input", version: "1" });
	const [left, right] = InMemoryTransport.createLinkedPair();
	try {
		await server.connect(right);
		await client.connect(left);
		const bad = CallToolResultSchema.parse(
			await client.callTool({ name: "get", arguments: { project: "scratch", refs: [4] } }),
		);
		expect(bad.isError).toBe(true);
		expect(bad.content).toEqual([{ type: "text", text: expect.stringMatching(/invalid: refs\.0:/) }]);
		for (const sample of [
			{ input: { q: "Q-1", answer: { is: "defect" } }, field: "onEvidence" },
			{ input: { all: [{ q: "Q-1" }] }, field: "all.0.onEvidence" },
			{ input: { undo: 5 }, field: "undo" },
		]) {
			const invalid = CallToolResultSchema.parse(
				await client.callTool({ name: "decide", arguments: { project: "scratch", ...sample.input } }),
			);
			expect(invalid.isError).toBe(true);
			expect(invalid.content).toEqual([{ type: "text", text: expect.stringContaining(sample.field) }]);
		}
		const ambiguous = CallToolResultSchema.parse(await client.callTool({ name: "inbox", arguments: {} }));
		expect(ambiguous.isError).toBe(true);
		expect(ambiguous.content).toEqual([{ type: "text", text: expect.stringContaining("project:") }]);
		resultOf(
			await client.callTool({ name: "inbox", arguments: { project: "other" } }),
			z.object({ items: z.array(z.unknown()).length(0) }),
		);
		const hidden = CallToolResultSchema.parse(
			await client.callTool({ name: "admin", arguments: { do: "project.list" } }),
		);
		expect(hidden.isError).toBe(true);
		const args = {
			project: "scratch",
			cmd: "programmatic-retry",
			edits: [{ op: "create", outline: "One retry case" }],
		};
		const first = resultOf(
			await client.callTool({ name: "propose", arguments: args }),
			z.object({ cases: z.array(z.object({ ref: z.string() })) }),
		);
		const retry = resultOf(
			await client.callTool({ name: "propose", arguments: args }),
			z.object({ cases: z.array(z.object({ ref: z.string() })) }),
		);
		expect(retry).toEqual(first);
		const found = resultOf(
			await client.callTool({ name: "find", arguments: { project: "scratch" } }),
			z.object({ count: z.literal(1) }),
		);
		expect(found.count).toBe(1);
	} finally {
		await client.close();
		await server.close();
		h.close();
	}
});

test("authenticated stateless HTTP answers initialize and tools/list and keeps the caller's permissions", async () => {
	const h = harness();
	const { secret } = createToken(h.app, {
		actor: "http-reader",
		kind: "agent",
		can: ["read"],
		project: 0,
		label: "MCP test",
	});
	const route = mcpRoute(h.app);
	const post = async (body: unknown, version = "2025-11-25"): Promise<Response> => {
		const req = new Request("http://127.0.0.1/mcp", {
			method: "POST",
			headers: {
				host: "127.0.0.1",
				authorization: `Bearer ${secret}`,
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				"mcp-protocol-version": version,
			},
			body: JSON.stringify(body),
		});
		const session = sessionOf(h.app, req, h.owner);
		if (!session) throw new Error("The request did not authenticate");
		return route(req, session);
	};
	try {
		const initialized = await post({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-11-25",
				capabilities: {},
				clientInfo: { name: "http-agent", version: "1" },
			},
		});
		expect(initialized.status).toBe(200);
		expect(initialized.headers.get("mcp-session-id")).toBeNull();
		const init = z.object({ result: InitializeResultSchema }).parse(await initialized.json()).result;
		expect(init.protocolVersion).toBe("2025-11-25");
		expect(init.instructions).toContain("onEvidence");
		// Tool schemas call `project` optional; the rule for omitting it is said once, here.
		expect(init.instructions).toContain("omit project only when the instance has exactly one project");
		expect(init.instructions).toContain(
			"read base for policy clauses or settings through CLI policy show --json or HTTP admin policy.show",
		);
		expect(init.instructions?.split(/[.!?](?:\s|$)/).filter(Boolean).length).toBeLessThanOrEqual(3);
		const listed = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
		expect(listed.status).toBe(200);
		expect(z.object({ result: ListToolsResultSchema }).parse(await listed.json()).result).toEqual({
			tools: mcpTools(),
		});
		const forbidden = await post({
			jsonrpc: "2.0",
			id: 3,
			method: "tools/call",
			params: { name: "propose", arguments: { edits: [{ op: "create", outline: "Not allowed" }] } },
		});
		const refused = z.object({ result: CallToolResultSchema }).parse(await forbidden.json()).result;
		expect(refused.isError).toBe(true);
		expect(refused.content).toEqual([{ type: "text", text: expect.stringContaining("forbidden:") }]);
		const legacy = await post(
			{ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "inbox", arguments: {} } },
			"2025-03-26",
		);
		const old = z.object({ result: CallToolResultSchema }).parse(await legacy.json()).result;
		expect(old.isError).not.toBe(true);
		expect(old.structuredContent).toBeUndefined();
	} finally {
		h.close();
	}
});

test.each(["2025-03-26", "2025-11-25", "2026-07-28"])(
	"a v2 HTTP client negotiates %s and discovers and calls the same tools",
	async (version) => {
		const h = harness();
		const http = serve(h.app, h.owner, { ui: null, routes: { "/mcp": mcpRoute(h.app) } });
		const { secret } = createToken(h.app, {
			actor: "v2-reader",
			kind: "agent",
			can: ["read"],
			project: 0,
			label: "MCP v2 test",
		});
		const client = new Client(
			{ name: "v2-http-agent", version: "1" },
			{
				versionNegotiation: { mode: version === "2026-07-28" ? { pin: version } : "legacy" },
				supportedProtocolVersions: [version],
			},
		);
		const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.port}/mcp`), {
			requestInit: { headers: { authorization: `Bearer ${secret}` } },
		});
		try {
			const unauthorized = await fetch(`http://127.0.0.1:${http.port}/mcp`, {
				method: "POST",
				headers: { authorization: "Bearer invalid-token", "content-type": "application/json" },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
			});
			expect(unauthorized.status).toBe(401);
			await unauthorized.body?.cancel();
			await client.connect(transport);
			expect(client.getNegotiatedProtocolVersion()).toBe(version);
			const listed = await client.listTools();
			const inbox = await client.callTool({ name: "inbox", arguments: {} });
			if (version === "2025-03-26") {
				expect(listed).toEqual({ tools: mcpTools().map(({ outputSchema: _output, ...tool }) => tool) });
				const envelope = { result: { counts: { open: 0 }, items: [], cursor: null }, seq: 1 };
				expect(inbox).toEqual({ content: [{ type: "text", text: JSON.stringify(envelope) }] });
			} else {
				expect(listed.tools).toEqual(mcpTools());
				resultOf(inbox, z.object({ items: z.array(z.unknown()).length(0) }));
			}
			const refused = CallToolResultSchema.parse(
				await client.callTool({ name: "propose", arguments: { edits: [{ op: "create", outline: "Not allowed" }] } }),
			);
			expect(refused.isError).toBe(true);
			expect(refused.content).toEqual([{ type: "text", text: expect.stringContaining("forbidden:") }]);
			const unknown = CallToolResultSchema.parse(await client.callTool({ name: "admin", arguments: {} }));
			expect(unknown.isError).toBe(true);
			expect(unknown.content).toEqual([{ type: "text", text: "invalid: Tool admin not found" }]);
		} finally {
			await client.close();
			await http.stop(true);
			h.close();
		}
	},
);

test("an HTTP tool write waits for an applying report and records token use", async () => {
	const h = harness();
	const { secret } = createToken(h.app, {
		actor: "queue-writer",
		kind: "agent",
		can: ["read", "produce"],
		project: 0,
		label: "MCP queue test",
	});
	let onAccepted = (): void => {};
	const accepted = new Promise<void>((resolve) => {
		onAccepted = resolve;
	});
	const unsubscribe = h.app.subscribe((event) => {
		if (event.op === "report") onAccepted();
	});
	const pendingReport = invokeAsync(h.app, OPS, {
		op: "report",
		project: "scratch",
		actor: () => h.owner,
		input: { target: { commit: "9f3c2ab" }, results: [{ test: { key: "queue::smoke" }, outcome: "pass" }] },
	});
	try {
		await accepted;
		expect(h.app.db.inTransaction).toBe(true);
		const req = new Request("http://127.0.0.1/mcp", {
			method: "POST",
			headers: {
				host: "127.0.0.1",
				authorization: `Bearer ${secret}`,
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				"mcp-protocol-version": "2025-11-25",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "propose", arguments: { edits: [{ op: "create", outline: "Queued case" }] } },
			}),
		});
		const session = sessionOf(h.app, req, h.owner);
		if (!session) throw new Error("The queued request did not authenticate");
		const response = await mcpRoute(h.app)(req, session);
		const tool = z.object({ result: CallToolResultSchema }).parse(await response.json()).result;
		expect(tool.isError, JSON.stringify(tool.content)).not.toBe(true);
		resultOf(tool, z.object({ status: z.literal("adopted") }));
		expect((await pendingReport).ok).toBe(true);
		await h.app.gate.run(() => undefined);
		expect(listTokens(h.app).find((token) => token.actor === "queue-writer")?.last_used_at).toBe(h.app.now());
	} finally {
		unsubscribe();
		await pendingReport;
		h.close();
	}
});

test.each(["2025-03-26", "2025-11-25", "2026-07-28"])(
	"stdio %s forwards calls to the running HTTP instance without owning its database",
	async (version) => {
		const h = harness();
		const http = serve(h.app, h.owner);
		const { secret } = createToken(h.app, {
			actor: "stdio-reader",
			kind: "agent",
			can: ["read"],
			project: 0,
			label: "MCP test",
		});
		const source = `
		import { z } from "zod";
		import { runStdio } from ${JSON.stringify(new URL("./mcp.ts", import.meta.url).pathname)};
		const url = process.env.MAINWORTHY_MCP_TEST_URL;
		const headers = { authorization: "Bearer " + process.env.MAINWORTHY_MCP_TEST_TOKEN, "content-type": "application/json" };
		const Reply = z.discriminatedUnion("ok", [
			z.object({ ok: z.literal(true), result: z.unknown(), seq: z.number().nullable() }),
			z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) })
		]);
		await runStdio(async (op, project, input) => {
			const response = await fetch(url + "/api/p/" + encodeURIComponent(project) + "/" + op, { method: "POST", headers, body: JSON.stringify(input) });
			return Reply.parse(await response.json());
		}, async () => {
			const response = await fetch(url + "/api/session", { headers });
			const session = z.object({ ok: z.literal(true), result: z.object({ projects: z.array(z.object({ key: z.string() })) }) }).parse(await response.json());
			return session.result.projects.map(project => project.key);
		});
	`;
		const transport = new StdioClientTransport({
			command: process.execPath,
			args: ["-e", source],
			env: { MAINWORTHY_MCP_TEST_URL: `http://127.0.0.1:${http.port}`, MAINWORTHY_MCP_TEST_TOKEN: secret },
		});
		const client = new Client(
			{ name: "stdio-client", version: "1" },
			{
				versionNegotiation: { mode: version === "2026-07-28" ? { pin: version } : "legacy" },
				supportedProtocolVersions: [version],
			},
		);
		try {
			await client.connect(transport);
			expect(client.getNegotiatedProtocolVersion()).toBe(version);
			const listed = await client.listTools();
			const inbox = await client.callTool({ name: "inbox", arguments: {} });
			if (version === "2025-03-26") {
				expect(listed).toEqual({ tools: mcpTools().map(({ outputSchema: _output, ...tool }) => tool) });
				const envelope = { result: { counts: { open: 0 }, items: [], cursor: null }, seq: 1 };
				expect(inbox).toEqual({ content: [{ type: "text", text: JSON.stringify(envelope) }] });
			} else {
				expect(listed.tools).toEqual(mcpTools());
				resultOf(inbox, z.object({ items: z.array(z.unknown()).length(0) }));
			}
			const refused = CallToolResultSchema.parse(
				await client.callTool({ name: "propose", arguments: { edits: [{ op: "create", outline: "Not allowed" }] } }),
			);
			expect(refused.isError).toBe(true);
			expect(refused.content).toEqual([{ type: "text", text: expect.stringContaining("forbidden:") }]);
			const unknown = CallToolResultSchema.parse(await client.callTool({ name: "admin", arguments: {} }));
			expect(unknown.isError).toBe(true);
			expect(unknown.content).toEqual([{ type: "text", text: "invalid: Tool admin not found" }]);
		} finally {
			await client.close();
			await http.stop(true);
			h.close();
		}
	},
);

test("the shipped skill stays short and its tool reference matches the registry", async () => {
	const skill = await Bun.file(new URL("../../skill/mainworthy/SKILL.md", import.meta.url)).text();
	expect(skill).toStartWith("---\nname: mainworthy\ndescription:");
	const body = skill.replace(/^---\n[\s\S]*?\n---\n/, "");
	expect(encode(body).length, "Skill body token budget").toBeLessThanOrEqual(400);
	expect(encode(skill).length, "Whole SKILL.md token budget").toBeLessThanOrEqual(400);
	const committed = await Bun.file(new URL("../../skill/mainworthy/references/tools.md", import.meta.url)).text();
	expect(committed, "Run bun scripts/gen-skill.ts after a registry change").toBe(generateToolReference());
});
