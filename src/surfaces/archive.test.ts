import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { withInstance } from "../cli/test-support.ts";
import { Policy } from "../core/kinds.ts";
import type { GateStatus } from "../core/ops.ts";
import { actorByName, authenticate, revokeToken, type Session } from "../server/identity/identity.ts";
import { findProject, makeCtx, stampSeq } from "../server/kernel/ctx.ts";
import { acceptReport } from "../server/ops/writes.ts";
import { archiveRoutes } from "./archive.ts";

test("archive routes require admin for reads and writes over the real HTTP server", async () => {
	await withInstance(async ({ client, instance }) => {
		const created = await client.call("admin", {
			do: "token.create",
			actor: "pipeline",
			kind: "ci",
			can: ["read", "record"],
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

test("CLI project export replays only that project over HTTP and keeps the source intact", async () => {
	await withInstance(async (source) => {
		await source.client.call("propose", {
			edits: [{ op: "create", outline: "Other project's private case", aliases: ["C1234", "OTHER-1"] }],
		});
		await source.client.call("admin", { do: "project.create", key: "selected" });
		const selected = source.client.with({ project: "selected" });
		await selected.call("propose", {
			edits: [
				{
					op: "create",
					body: { title: "Keep this project", steps: [{ id: "s1", action: "An action", expected: "Expected" }] },
					aliases: ["C1234", "SELECTED-1"],
				},
			],
		});
		for (const [client, project, field] of [
			[source.client, "scratch", "other_only"],
			[selected, "selected", "risk"],
		] as const) {
			const policy = Policy.extend({ version: z.number() }).parse(
				await client.call("admin", { do: "policy.show", project }),
			);
			const proposed = await client.call("propose", {
				edits: [
					{
						op: "policy",
						base: policy.version,
						settings: {
							...policy.settings,
							fields: { [field]: { kind: "choice", label: field, required: true, choices: ["low", "high"] } },
						},
					},
				],
			});
			const question = (await client.call("inbox", { kind: "adopt" })).items.find((row) => row.q === proposed.question);
			if (!question) throw new Error("The field definitions need their adoption question");
			expect(
				await client.call("decide", {
					q: question.q,
					onEvidence: question.evidenceHash,
					answer: { is: "accept" },
				}),
			).toMatchObject([{ status: "decided" }]);
		}
		const policyRows = source.instance.app.reader.raw
			.query("SELECT * FROM policies WHERE project = (SELECT id FROM projects WHERE key = 'selected') ORDER BY version")
			.all();
		const aliasRows = source.instance.app.reader.raw
			.query(
				"SELECT * FROM case_aliases WHERE project = (SELECT id FROM projects WHERE key = 'selected') ORDER BY alias",
			)
			.all();
		await selected.call("report", {
			target: { commit: "projectexport1", branch: "main" },
			results: [{ test: { key: "selected-test" }, outcome: "pass", annotation: { case: "C-1" } }],
		});
		const before = await selected.call("find", {});
		const gate = await selected.call("gate", { commit: "projectexport1" });
		const file = join(source.directory, "selected.ndjson.gz");
		const exported = await source.cli(["export", "--project", "selected", "--out", file]);
		expect(exported.code).toBe(0);
		expect(exported.stderr).toBe("");
		await withInstance(async (target) => {
			const imported = await target.run(["import", file]);
			expect(imported.code).toBe(0);
			const restored = target.client.with({ project: "selected" });
			expect(await restored.call("find", {})).toEqual(before);
			expect(await restored.call("gate", { commit: "projectexport1" })).toEqual(gate);
			expect(target.instance.app.reader.raw.query("SELECT key FROM projects").all()).toEqual([{ key: "selected" }]);
			expect(target.instance.app.reader.raw.query("SELECT * FROM policies ORDER BY version").all()).toEqual(policyRows);
			expect(target.instance.app.reader.raw.query("SELECT * FROM case_aliases ORDER BY alias").all()).toEqual(
				aliasRows,
			);
			expect(
				Policy.parse(await restored.call("admin", { do: "policy.show", project: "selected" })).settings.fields,
			).toEqual({
				risk: { kind: "choice", label: "risk", required: true, choices: ["low", "high"] },
			});
			expect(await restored.call("get", { refs: ["C1234", "SELECTED-1"] })).toMatchObject([
				{ title: "Keep this project" },
				{ title: "Keep this project" },
			]);
			await expect(restored.call("get", { refs: ["OTHER-1"] })).rejects.toThrow();
			await expect(
				restored.call("propose", { edits: [{ op: "create", body: { title: "Missing risk" } }] }),
			).rejects.toThrow("risk");
			expect(
				await restored.call("propose", {
					edits: [{ op: "create", body: { title: "Valid risk", fields: { risk: "high" } } }],
				}),
			).toMatchObject({ status: "adopted" });
			for (const table of ["tokens", "sessions", "credentials", "invitations", "passkey_users"]) {
				expect(target.instance.app.reader.raw.query(`SELECT * FROM ${table}`).all()).toEqual([]);
			}
		});
		expect(await selected.call("find", {})).toEqual(before);
		expect((await source.client.call("find", {})).items[0]?.title).toBe("Other project's private case");
	});
});

test("HTTP project export rejects unknown and empty selections", async () => {
	await withInstance(async ({ client, instance }) => {
		const unknown = await client.request("/api/export?project=missing");
		expect(unknown.status).toBe(404);
		expect(await unknown.text()).toContain("project missing not found");
		const empty = await client.request("/api/export?project=");
		expect(empty.status).toBe(400);
		expect(await empty.text()).toContain("project key");
		expect(await readdir(join(instance.app.config.dataDir, "spool"))).toEqual([]);
	});
});

test("invalid import leaves bootstrap rows and the caller's token intact", async () => {
	await withInstance(
		async ({ client, instance }) => {
			const before = await client.call("admin", { do: "project.list" });
			const response = await client.request("/api/import", { method: "POST", body: '{"mainworthy":"archive"}\n' });
			expect(response.status).toBe(400);
			expect(await response.text()).toContain('"code":"invalid"');
			expect(await client.call("admin", { do: "project.list" })).toEqual(before);
			expect(instance.app.db.raw.query<{ n: number }, []>("SELECT count(*) AS n FROM actors").get()?.n).toBe(2);
		},
		{ mode: "server" },
	);
});

test("HTTP and CLI archive imports refuse invalid durations and accept their exact limit", async () => {
	await withInstance(async (source) => {
		await source.client.call("report", {
			target: { commit: "archive-duration", branch: "main" },
			results: [
				{
					test: { key: "timed-test" },
					outcome: "pass",
					durationMs: 2_592_000_000,
					tries: [{ outcome: "fail", durationMs: 2_592_000_000 }],
				},
			],
		});
		const exported = await source.client.request("/api/export");
		expect(exported.status).toBe(200);
		const text = await exported.text();
		await withInstance(async (target) => {
			const before = await target.client.call("admin", { do: "project.list" });
			for (const table of ["results", "result_tries"]) {
				for (const duration of ["-1", "2592000001", "9223372036854775807"]) {
					const lines = text.trimEnd().split("\n").slice(0, -1);
					const changed = lines.map((line) =>
						line.startsWith(`{"t":"${table}",`)
							? line.replace('"duration_ms":2592000000', `"duration_ms":${duration}`)
							: line,
					);
					const preceding = `${changed.join("\n")}\n`;
					const body = `${preceding}${JSON.stringify({ end: true, rows: changed.length - 1, sha256: createHash("sha256").update(preceding).digest("hex") })}\n`;
					const response = await target.client.request("/api/import", { method: "POST", body });
					expect(response.status).toBe(400);
					const refused = z
						.object({ ok: z.literal(false), error: z.object({ code: z.literal("invalid"), message: z.string() }) })
						.parse(await response.json());
					expect(refused.error.message).toMatch(
						new RegExp(`${table}\\.duration_ms.*row \\d+.*line \\d+.*0.*2592000000`),
					);
					const file = join(target.directory, "duration.ndjson.gz");
					await Bun.write(file, Bun.gzipSync(body));
					const run = table === "results" && duration === "-1" ? target.cli : target.run;
					const imported = await run(["import", file]);
					expect(imported.code).toBe(4);
					expect(imported.stderr).toContain(`invalid: ${refused.error.message}`);
					expect(await target.client.call("admin", { do: "project.list" })).toEqual(before);
					expect(target.instance.app.reader.raw.query("SELECT * FROM results").all()).toEqual([]);
					expect(await readdir(join(target.directory, "spool"))).toEqual([]);
				}
			}
			const file = join(target.directory, "valid.ndjson.gz");
			await Bun.write(file, Bun.gzipSync(text));
			expect(await target.run(["import", file])).toMatchObject({ code: 0, stderr: "" });
			for (const table of ["results", "result_tries"]) {
				expect(target.instance.app.reader.raw.query(`SELECT duration_ms FROM ${table}`).all()).toEqual([
					{ duration_ms: 2_592_000_000 },
				]);
			}
		});
	});
});

test("HTTP and CLI exports warn about unrestorable durations while preserving the backup", async () => {
	await withInstance(async (source) => {
		await source.client.call("report", {
			target: { commit: "historical-duration", branch: "main" },
			results: [
				{ test: { key: "timed-test" }, outcome: "pass", durationMs: 0, tries: [{ outcome: "fail", durationMs: 0 }] },
			],
		});
		source.instance.app.db.raw.exec(
			"UPDATE results SET duration_ms = -1; UPDATE result_tries SET duration_ms = 2592000001",
		);
		const exported = await source.client.request("/api/export");
		expect(exported.status).toBe(200);
		const message = exported.headers.get("x-mainworthy-archive-warning");
		expect(message).toContain("results.duration_ms");
		expect(message).toContain("result_tries.duration_ms");
		expect(message).toContain("refuse to import");
		const text = await exported.text();
		expect(text).toContain('"duration_ms":2592000001');
		expect(text).toContain('"duration_ms":-1');
		const file = join(source.directory, "historical.ndjson.gz");
		const saved = await source.cli(["export", "--out", file]);
		expect(saved.code).toBe(0);
		expect(saved.stdout).toContain("exported to");
		expect(saved.stdout).not.toContain("warning:");
		expect(saved.stderr).toContain(`warning: ${message}`);
		expect(new TextDecoder().decode(Bun.gunzipSync(await Bun.file(file).bytes()))).toContain(
			'"duration_ms":2592000001',
		);
		await withInstance(async (target) => {
			const refused = await target.client.request("/api/import", { method: "POST", body: text });
			expect(refused.status).toBe(400);
			expect(await refused.text()).toContain("invalid archive");
		});
		await source.client.call("admin", { do: "project.create", key: "healthy" });
		const scoped = await source.client.request("/api/export?project=healthy");
		expect(scoped.status).toBe(200);
		expect(scoped.headers.get("x-mainworthy-archive-warning")).toBeNull();
		await scoped.body?.cancel();
		for (const duration of [0, 2_592_000_000, null]) {
			for (const table of ["results", "result_tries"]) {
				source.instance.app.db.raw.query(`UPDATE ${table} SET duration_ms = ?`).run(duration);
			}
			const valid = await source.client.request("/api/export");
			expect(valid.headers.get("x-mainworthy-archive-warning")).toBeNull();
			await valid.body?.cancel();
		}
	});
});

test("a failed export reports the worker's validation error and the next export succeeds", async () => {
	await withInstance(async ({ client, instance }) => {
		instance.app.db.raw.exec("INSERT INTO meta (key, value) VALUES ('bad-text', CAST(X'80' AS TEXT))");
		const refused = await client.request("/api/export");
		expect(refused.status).toBe(400);
		expect(await refused.json()).toEqual({
			ok: false,
			error: { code: "invalid", message: "cannot export table meta losslessly: stored TEXT contains invalid UTF-8" },
		});
		instance.app.db.raw.exec("DELETE FROM meta WHERE key = 'bad-text'");
		const exported = await client.request("/api/export");
		expect(exported.status).toBe(200);
		expect(await exported.text()).toContain('"end":true');
	});
});

test("an export whose token is revoked while its worker runs returns no archive", async () => {
	await withInstance(
		async ({ client, instance }) => {
			const secret = z
				.object({ token: z.string() })
				.parse(await client.call("admin", { do: "token.create", actor: "robin", kind: "human" })).token;
			const token = z
				.array(z.object({ id: z.number() }))
				.parse(await client.call("admin", { do: "token.list" }))
				.at(-1);
			if (!token) throw new Error("the second owner token is missing");
			const session: Session = {
				via: "token",
				actor: async (project) => await authenticate(instance.app, secret, project),
			};
			const route = archiveRoutes(instance.app)["/api/export"];
			if (!route) throw new Error("export route is missing");
			const pending = route(new Request(`${instance.url}/api/export`), session);
			// The route has admitted the token and started the worker. Revoke before any worker reply is handled.
			await instance.app.db.transaction(async () => await revokeToken(instance.app, token.id));
			const response = await pending;
			if (response.status === 200) await response.body?.cancel();
			expect(response.status).toBe(403);
			expect(await response.json()).toMatchObject({ ok: false, error: { code: "forbidden" } });
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
		const spool = join(instance.app.config.dataDir, "spool");
		const session: Session = { via: "local", actor: async () => instance.owner };
		const route = archiveRoutes(instance.app)["/api/export"];
		if (!route) throw new Error("export route is missing");
		const response = await route(new Request(`${instance.url}/api/export?project=scratch`), session);
		if (!response.body) throw new Error("export body is missing");
		const reader = response.body.getReader();
		try {
			const first = await reader.read();
			expect(first.value?.byteLength).toBeLessThanOrEqual(64 * 1024);
			expect((await readdir(spool)).filter((name) => name.startsWith("mainworthy-archive-"))).toHaveLength(1);
		} finally {
			await reader.cancel();
			reader.releaseLock();
		}
		expect(await readdir(spool)).toEqual([]);
	});
});

test("imports spool privately on the data filesystem and remove rejected uploads", async () => {
	await withInstance(async ({ instance }) => {
		const reading = Promise.withResolvers<void>();
		let input: ReadableStreamDefaultController<Uint8Array> | undefined;
		const body = new ReadableStream<Uint8Array>(
			{
				start(controller) {
					input = controller;
					controller.enqueue(new TextEncoder().encode("not an archive"));
				},
				pull() {
					reading.resolve();
				},
			},
			// Only request another chunk once the import has opened its spool and consumed the first.
			{ highWaterMark: 0 },
		);
		const route = archiveRoutes(instance.app)["/api/import"];
		if (!route || !input) throw new Error("missing import input");
		const pending = route(new Request(`${instance.url}/api/import`, { method: "POST", body }), {
			via: "local",
			actor: async () => instance.owner,
		});
		const spool = join(instance.app.config.dataDir, "spool");
		try {
			await reading.promise;
			const entries = await readdir(spool);
			expect(entries).toHaveLength(1);
			const directory = join(spool, entries[0] ?? "missing");
			expect((await stat(directory)).mode & 0o777).toBe(0o700);
			expect((await stat(join(directory, "archive.ndjson"))).mode & 0o777).toBe(0o600);
		} finally {
			input.close();
		}
		expect((await pending).status).toBe(400);
		expect(await readdir(spool)).toEqual([]);
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
				// The upload is made with a second token of the owner's: the last one the owner holds is not revoked.
				const secret = z
					.object({ token: z.string() })
					.parse(await client.call("admin", { do: "token.create", actor: "robin", kind: "human" })).token;
				const token = z
					.array(z.object({ id: z.number() }))
					.parse(await client.call("admin", { do: "token.list" }))
					.at(-1);
				if (!token) throw new Error("the second token is missing");
				const session: Session = {
					via: "token",
					actor: async (project) => await authenticate(instance.app, secret, project),
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

test("a local import preserves the configured owner's identity for the next write", async () => {
	await withInstance(
		async (source) => {
			const archive = await source.client.request("/api/export");
			if (!archive.body) throw new Error("missing archive body");
			await withInstance(async (target) => {
				expect((await target.client.request("/api/import", { method: "POST", body: archive.body })).status).toBe(200);
				expect((await target.client.session()).actor).toBe("robin");
				await target.client.call("propose", {
					edits: [{ op: "create", outline: "After import\nAn action > Expected" }],
				});
				const actor = target.instance.app.reader.raw
					.query<{ name: string }, []>("SELECT a.name FROM cases c JOIN actors a ON a.id = c.created_by")
					.get();
				expect(actor?.name).toBe("robin");
			});
		},
		{ owner: "alice" },
	);
});

test("a report the original had accepted and not yet applied is applied by the instance that imports it", async () => {
	await withInstance(async (source) => {
		await source.client.call("propose", { edits: [{ op: "create", outline: "Imported mid-report" }] });
		// The moment between a report's two transactions, as an export taken under load catches it.
		const app = source.instance.app;
		await app.db.transaction(async () => {
			const project = await findProject(app.db, "scratch");
			const owner = project ? await actorByName(app.db, "robin", project.id) : null;
			if (!project || !owner) throw new Error("the source has no project or owner");
			const ctx = makeCtx(app, project, owner, true);
			await acceptReport(ctx, {
				target: { commit: "midreport1", branch: "main" },
				results: [
					{ test: { key: "one" }, outcome: "pass" },
					{ test: { key: "two" }, outcome: "fail", failure: { message: "expected 1 to equal 2" } },
				],
			});
			await stampSeq(ctx);
		});
		const archive = await source.client.request("/api/export");
		if (!archive.body) throw new Error("missing archive body");
		await withInstance(async (target) => {
			expect((await target.client.request("/api/import", { method: "POST", body: archive.body })).status).toBe(200);
			// No restart: the staged report is applied as part of the import, and its gate says what it showed.
			const gate = (await target.client.call("gate", { commit: "midreport1" })) as GateStatus;
			expect(gate).toMatchObject({ verdict: "blocked", tally: { pass: 1, unexplained: 1 } });
		});
	});
});

test("an archive refuses out-of-range durations in pending reports before recovery", async () => {
	await withInstance(async (source) => {
		const result = {
			test: { key: "pending-timed-test" },
			outcome: "pass" as const,
			durationMs: 2_592_000_000,
			tries: [{ outcome: "fail" as const, durationMs: 2_592_000_000 }],
		};
		const app = source.instance.app;
		await app.db.transaction(async () => {
			const project = await findProject(app.db, "scratch");
			const owner = project ? await actorByName(app.db, "robin", project.id) : null;
			if (!project || !owner) throw new Error("the source has no project or owner");
			const ctx = makeCtx(app, project, owner, true);
			await acceptReport(ctx, { target: { commit: "pending-duration", branch: "main" }, results: [result] });
			await stampSeq(ctx);
		});
		await withInstance(async (target) => {
			const before = await target.client.call("admin", { do: "project.list" });
			for (const field of ["result", "try"]) {
				for (const durationMs of [-1, 2_592_000_001]) {
					const staged = [
						{ ...result, ...(field === "result" ? { durationMs } : { tries: [{ outcome: "fail", durationMs }] }) },
					];
					app.db.raw.query("UPDATE batches SET staged = ? WHERE state = 'accepted'").run(JSON.stringify(staged));
					const archive = await source.client.request("/api/export");
					const response = await target.client.request("/api/import", { method: "POST", body: archive.body });
					expect(response.status).toBe(400);
					expect(await response.text()).toMatch(
						/batches\.staged.*row \d+.*line \d+.*pending results fail result input: 0\.(durationMs|tries\.0\.durationMs):/,
					);
					expect(await target.client.call("admin", { do: "project.list" })).toEqual(before);
				}
			}
			app.db.raw.query("UPDATE batches SET staged = ? WHERE state = 'accepted'").run(JSON.stringify([result]));
			const archive = await source.client.request("/api/export");
			expect((await target.client.request("/api/import", { method: "POST", body: archive.body })).status).toBe(200);
			for (const table of ["results", "result_tries"]) {
				expect(target.instance.app.reader.raw.query(`SELECT duration_ms FROM ${table}`).all()).toEqual([
					{ duration_ms: 2_592_000_000 },
				]);
			}
		});
	});
});
