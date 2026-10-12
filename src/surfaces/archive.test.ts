import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { z } from "zod";
import { withInstance } from "../cli/test-support.ts";
import { authenticate } from "../server/identity/identity.ts";
import { archiveRoutes } from "./archive.ts";
import type { Session } from "./http.ts";

test("archive routes require admin for reads and writes over the real HTTP server", async () => {
	await withInstance(async ({ client, instance }) => {
		const created = await client.call("admin", {
			do: "token.create",
			actor: "pipeline",
			kind: "ci",
			can: ["read", "produce"],
		});
		const parsed = z.object({ token: z.string() }).parse(created);
		for (const { path, method } of [
			{ path: "export", method: "GET" },
			{ path: "import", method: "POST" },
		]) {
			const response = await fetch(`${instance.url}/api/${path}`, {
				method,
				headers: { authorization: `Bearer ${parsed.token}` },
			});
			expect(response.status).toBe(403);
			expect(await response.text()).toContain('"code":"forbidden"');
		}
	});
});

test("HTTP export is NDJSON, import accepts stream chunks and warns about session replacement", async () => {
	await withInstance(async (source) => {
		await source.client.call("propose", {
			edits: [{ op: "create", outline: "Coupon applies\nApply SAVE10 > Total is 90.00" }],
		});
		const exported = await source.client.request("/api/export");
		expect(exported.headers.get("content-type")).toBe("application/x-ndjson");
		if (!exported.body) throw new Error("export is missing its stream");
		await withInstance(async (target) => {
			const imported = await target.client.request("/api/import", { method: "POST", body: exported.body });
			expect(imported.status).toBe(200);
			expect(await imported.text()).toContain("previous session may no longer exist");
			expect((await target.client.call("find", {})).items).toEqual((await source.client.call("find", {})).items);
		});
	});
});

test("invalid import leaves bootstrap rows and the caller's token intact", async () => {
	await withInstance(
		async ({ client, instance }) => {
			const before = await client.call("admin", { do: "project.list" });
			const response = await client.request("/api/import", { method: "POST", body: '{"casebook":"archive"}\n' });
			expect(response.status).toBe(400);
			expect(await response.text()).toContain('"code":"invalid"');
			expect(await client.call("admin", { do: "project.list" })).toEqual(before);
			expect(instance.app.db.raw.query<{ n: number }, []>("SELECT count(*) AS n FROM actors").get()?.n).toBe(2);
		},
		{ mode: "server" },
	);
});

test("import refuses an instance with user data", async () => {
	await withInstance(async ({ client }) => {
		await client.call("propose", { edits: [{ op: "create", outline: "Keep this case\nAn action > Expected" }] });
		const before = await client.call("find", {});
		const response = await client.request("/api/import", { method: "POST", body: "not an archive\n" });
		expect(response.status).toBe(409);
		expect(await response.text()).toContain('"code":"conflict"');
		expect(await client.call("find", {})).toEqual(before);
	});
});

test("export pulls fixed chunks and cancels without leaving its spool on disk", async () => {
	await withInstance(async ({ instance, client }) => {
		await client.call("propose", {
			edits: [
				{
					op: "create",
					body: { title: "A large canonical row", pre: "x".repeat(160_000), steps: [], methods: ["human"] },
				},
			],
		});
		const before = new Set(await readdir(tmpdir()));
		const session: Session = { via: "local", secret: null, actor: () => instance.owner };
		const route = archiveRoutes(instance.app)["/api/export"];
		if (!route) throw new Error("export route is missing");
		const response = await route(new Request(`${instance.url}/api/export`), session);
		if (!response.body) throw new Error("export body is missing");
		const reader = response.body.getReader();
		const first = await reader.read();
		expect(first.value?.byteLength).toBeLessThanOrEqual(64 * 1024);
		await reader.cancel();
		reader.releaseLock();
		const after = (await readdir(tmpdir())).filter((name) => name.startsWith("casebook-archive-") && !before.has(name));
		expect(after).toEqual([]);
	});
});

test("a token revoked while the body is uploading cannot complete the import", async () => {
	await withInstance(async (source) => {
		await source.client.call("propose", {
			edits: [{ op: "create", outline: "Do not import this with a revoked token\nAn action > Expected" }],
		});
		const archive = await (await source.client.request("/api/export")).text();
		await withInstance(
			async ({ instance, client }) => {
				const secret = instance.generatedToken;
				if (!secret) throw new Error("the server did not create its owner token");
				const token = z.array(z.object({ id: z.number() })).parse(await client.call("admin", { do: "token.list" }))[0];
				if (!token) throw new Error("the server's token is missing");
				const session: Session = {
					via: "token",
					secret,
					actor: (project) => authenticate(instance.app, secret, project),
				};
				let input: ReadableStreamDefaultController<Uint8Array> | undefined;
				const body = new ReadableStream<Uint8Array>({
					start(controller) {
						input = controller;
						controller.enqueue(new TextEncoder().encode(archive.slice(0, 10)));
					},
				});
				const route = archiveRoutes(instance.app)["/api/import"];
				if (!route || !input) throw new Error("the import input is missing");
				const pending = route(new Request(`${instance.url}/api/import`, { method: "POST", body }), session);
				await client.call("admin", { do: "token.revoke", id: token.id });
				input.enqueue(new TextEncoder().encode(archive.slice(10)));
				input.close();
				const response = await pending;
				expect(response.status).toBe(403);
				expect(await response.text()).toContain('"code":"forbidden"');
				expect(instance.app.reader.raw.query<{ key: string }, []>("SELECT key FROM projects").get()?.key).toBe(
					"scratch",
				);
				expect(instance.app.reader.raw.query<{ n: number }, []>("SELECT count(*) AS n FROM cases").get()?.n).toBe(0);
			},
			{ mode: "server" },
		);
	});
});
