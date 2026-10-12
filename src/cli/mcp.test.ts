import { expect, test } from "bun:test";
import { z } from "zod";
import { withInstance } from "./test-support.ts";

test("MCP stdio writes only protocol messages and forwards an operation to HTTP", async () => {
	await withInstance(async ({ cli, client }) => {
		await client.call("propose", { edits: [{ op: "create", outline: "From MCP\nAn action > Expected" }] });
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
		const result = await cli(["mcp"], { input: `${messages.map((message) => JSON.stringify(message)).join("\n")}\n` });
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
			.object({ structuredContent: z.object({ result: z.object({ items: z.array(z.object({ ref: z.string() })) }) }) })
			.parse(operation?.result);
		expect(body.structuredContent.result.items[0]?.ref).toBe("C-1");
	});
});
