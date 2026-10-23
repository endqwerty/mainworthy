import { expect, test } from "bun:test";
import { z } from "zod";
import { Proofs } from "../core/replies.ts";
import { withInstance } from "./test-support.ts";

test("MCP connection errors omit credentials from the configured server URL", async () => {
	await withInstance(async ({ cli }) => {
		const messages = [
			{
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "cli-test", version: "1" } },
			},
			{ jsonrpc: "2.0", method: "notifications/initialized" },
			{
				jsonrpc: "2.0",
				id: 2,
				method: "tools/call",
				params: { name: "find", arguments: { project: "scratch", in: "cases" } },
			},
		];
		const result = await cli(["mcp"], {
			env: { MAINWORTHY_URL: "http://robin:synthetic-url-password@127.0.0.1:1" },
			input: `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
		});
		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).not.toContain("synthetic-url-password");
		expect(result.stdout).not.toContain("robin");
		expect(result.stdout).toContain("cannot connect to http://127.0.0.1:1; start the server with mainworthy serve");
	});
});

test.each(["2025-11-25", "2026-07-28"])(
	"MCP %s stdio writes only protocol messages and forwards an operation to HTTP after stdin ends",
	async (version) => {
		await withInstance(async ({ cli, client }) => {
			await client.call("propose", { edits: [{ op: "create", outline: "From MCP\nAn action > Expected" }] });
			const run = await client.call("plan", { name: "Proof", select: {} });
			await client.call("report", { run: run.run, results: [{ test: { case: "C-1" }, outcome: "pass" }] });
			await client.call("propose", {
				edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "From MCP, edited" } }],
			});
			const [document] = await client.call("get", { refs: ["C-1"] });
			const proof = Proofs.parse(document?.proof);
			const meta =
				version === "2026-07-28"
					? {
							_meta: {
								"io.modelcontextprotocol/protocolVersion": version,
								"io.modelcontextprotocol/clientInfo": { name: "cli-test", version: "1" },
								"io.modelcontextprotocol/clientCapabilities": {},
							},
						}
					: {};
			const messages = [
				version === "2026-07-28"
					? {
							jsonrpc: "2.0",
							id: 1,
							method: "server/discover",
							params: meta,
						}
					: {
							jsonrpc: "2.0",
							id: 1,
							method: "initialize",
							params: { protocolVersion: version, capabilities: {}, clientInfo: { name: "cli-test", version: "1" } },
						},
				...(version === "2025-11-25" ? [{ jsonrpc: "2.0", method: "notifications/initialized" }] : []),
				{
					jsonrpc: "2.0",
					id: 2,
					method: "tools/call",
					params: { name: "find", arguments: { project: "scratch", in: "cases" }, ...meta },
				},
			];
			const result = await cli(["mcp"], {
				input: `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
			});
			expect(result.code).toBe(0);
			expect(result.stderr).toBe("");
			const protocol = z.object({ jsonrpc: z.literal("2.0"), id: z.number(), result: z.unknown() });
			const replies = result.stdout
				.trim()
				.split("\n")
				.map((text) => {
					const parsed: unknown = JSON.parse(text);
					return protocol.parse(parsed);
				});
			expect(replies).toHaveLength(2);
			const operation = replies.find((reply) => reply.id === 2);
			const body = z
				.object({
					structuredContent: z.object({
						result: z.object({ items: z.array(z.object({ ref: z.string(), proof: Proofs })) }),
					}),
					content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
				})
				.parse(operation?.result);
			expect(body.structuredContent.result.items[0]?.ref).toBe("C-1");
			expect(body.structuredContent.result.items[0]?.proof).toEqual(proof);
			expect(proof.human).toMatchObject({ id: expect.any(Number), version: 1, current: false, method: "human" });
			const text = z
				.object({ result: z.object({ items: z.array(z.object({ proof: Proofs })) }) })
				.parse(JSON.parse(body.content[0]?.text ?? "null"));
			expect(text.result.items[0]?.proof).toEqual(proof);
		});
	},
);
