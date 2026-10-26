import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { type Instance, start } from "../src/app/start.ts";
import { runCli } from "../src/cli/dispatch.ts";
import { inThisProcess } from "../src/cli/test-support.ts";
import { ReportInput } from "../src/core/ops.ts";
import { defaultConfig } from "../src/server/kernel/app.ts";
import { BLOB_GRACE_MS } from "../src/server/kernel/blob-objects.ts";
import { findProject, makeCtx, stampSeq } from "../src/server/kernel/ctx.ts";
import { sql } from "../src/server/kernel/db.ts";
import { OPS } from "../src/server/ops/index.ts";
import { invoke } from "../src/server/ops/registry.ts";
import { acceptReport } from "../src/server/ops/writes.ts";
import { exportArchive, importArchive, linesOf } from "../src/server/transfer/transfer.ts";
import { archiveRoutes } from "../src/surfaces/archive.ts";
import { type TestDatabase, testDatabase } from "./db.ts";
import { type Harness, harness } from "./helpers.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5RkAAAAASUVORK5CYII=";
const file = { name: "screenshot.png", data: PNG, at: "s1" };
const metadata = z.object({
	id: z.number(),
	result: z.number(),
	name: z.string(),
	hash: z.string(),
	size: z.number(),
	type: z.string(),
	at: z.string().nullable(),
});
const listed = z.object({ kind: z.literal("list"), items: z.array(metadata) });
const downloaded = z.object({ kind: z.literal("file"), attachment: metadata, data: z.string() });
const rigs: Harness[] = [];
const dirs: string[] = [];
const instances: Instance[] = [];
const databases: TestDatabase[] = [];
afterEach(async () => {
	for (const instance of instances.splice(0)) await instance.stop();
	for (const h of rigs.splice(0)) await h.close();
	for (const database of databases.splice(0)) await database.close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function rig() {
	const h = await harness();
	rigs.push(h);
	return h;
}
async function report(h: Harness, attachments: unknown[] = [file]) {
	return h.call<{ results: number[]; fresh: boolean }>("report", {
		target: { session: "attachments" },
		results: [{ test: { key: "screenshot" }, outcome: "fail", attachments }],
	});
}

test("report preserves attachment bytes and retry identity", async () => {
	const h = await rig();
	const sent = await report(h);
	const result = sent.results[0];
	const list = listed.parse(await h.call("attachment", { result }));
	expect(list.items).toHaveLength(1);
	const item = list.items[0];
	expect(item).toMatchObject({
		result,
		name: file.name,
		size: Buffer.from(PNG, "base64").length,
		type: "image/png",
		at: "s1",
	});
	expect(item?.hash).toBe(createHash("sha256").update(Buffer.from(PNG, "base64")).digest("hex"));
	expect(downloaded.parse(await h.call("attachment", { result, id: item?.id })).data).toBe(PNG);
	expect(await report(h)).toMatchObject({ results: sent.results, fresh: false });
	expect(listed.parse(await h.call("attachment", { result })).items).toHaveLength(1);
});

test("attach appends to the producer's result and requires read permission for downloads", async () => {
	const h = await rig();
	const result = (await report(h, [])).results[0];
	const attached = metadata.parse(await h.call("attach", { result, attachment: file, cmd: "attach-once" }));
	expect(metadata.parse(await h.call("attach", { result, attachment: file, cmd: "attach-once" }))).toEqual(attached);
	const other = await h.actor("other", "human", ["record", "read"]);
	expect(await h.raw("attach", { result, attachment: file }, other)).toMatchObject({
		ok: false,
		error: { code: "forbidden" },
	});
	await h.call("admin", { do: "project.create", key: "another", preset: "loose" });
	expect(
		await invoke(h.app, OPS, {
			op: "attachment",
			project: "another",
			input: { result, id: attached.id },
			actor: async () => h.owner,
		}),
	).toMatchObject({ ok: false, error: { code: "not_found" } });
	const recorder = await h.actor("recorder", "ci", ["record"]);
	expect(await h.raw("attachment", { result, id: attached.id }, recorder)).toMatchObject({
		ok: false,
		error: { code: "forbidden" },
	});
	expect(await h.raw("attachment", { result: 999999, id: attached.id })).toMatchObject({
		ok: false,
		error: { code: "not_found" },
	});
	const html = metadata.parse(
		await h.call("attach", {
			result,
			attachment: { name: "page.html", data: Buffer.from("<script>window.executed=true</script>").toString("base64") },
		}),
	);
	expect(html.type).toBe("application/octet-stream");
	const byOther = await h.call<{ results: number[] }>(
		"report",
		{ target: { session: "other" }, results: [{ test: { key: "other" }, outcome: "fail", attachments: [file] }] },
		other,
	);
	await h.call("admin", { do: "actor.forget", name: "other" });
	const retained = listed.parse(await h.call("attachment", { result: byOther.results[0] })).items[0];
	expect(retained?.name).toBe(file.name);
	expect(downloaded.parse(await h.call("attachment", { result: byOther.results[0], id: retained?.id })).data).toBe(PNG);
});

test("invalid data and file/report/result limits refuse the whole request", async () => {
	const h = await rig();
	for (const bad of [
		{ ...file, data: "%%%" },
		{ ...file, data: "Zh==" },
		{ ...file, name: "../secret" },
		{ ...file, name: "a\nb" },
		...Array.from("\u0080\u0085\u009f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069", (control) => ({
			...file,
			name: `photo${control}gnp.exe`,
		})),
		{ ...file, data: Buffer.alloc(4 * 1024 ** 2 + 1).toString("base64") },
	]) {
		expect(
			await h.raw("report", {
				target: { session: "bad" },
				results: [{ test: { key: "bad" }, outcome: "pass", attachments: [bad] }],
			}),
		).toMatchObject({ ok: false, error: { code: "invalid" } });
	}
	const big = { name: "big.bin", data: Buffer.alloc(4 * 1024 ** 2).toString("base64") };
	expect(
		await h.raw("report", {
			target: { session: "too-big" },
			results: [{ test: { key: "big" }, outcome: "pass", attachments: Array(5).fill(big) }],
		}),
	).toMatchObject({ ok: false, error: { code: "invalid" } });
	expect(
		await h.raw("report", {
			target: { session: "too-many" },
			results: Array.from({ length: 6 }, (_, i) => ({
				test: { key: `too-many-${i}` },
				outcome: "pass",
				attachments: Array(20).fill(file),
			})),
		}),
	).toMatchObject({ ok: false, error: { code: "invalid" } });
	expect((await h.call<{ items: unknown[] }>("find", { in: "tests", text: "bad" })).items.length).toBe(0);
	const result = (await report(h, Array(20).fill(file))).results[0];
	expect(await h.raw("attach", { result, attachment: file })).toMatchObject({ ok: false, error: { code: "invalid" } });
});

test("one-project archives carry only that project's attachment metadata and bytes", async () => {
	const h = await rig();
	const result = (await report(h)).results[0];
	await h.call("admin", { do: "project.create", key: "another", preset: "loose" });
	const privateData = Buffer.from("another project's private evidence").toString("base64");
	const other = await invoke(h.app, OPS, {
		op: "report",
		project: "another",
		actor: async () => h.owner,
		input: {
			target: { session: "other" },
			results: [{ test: { key: "other" }, outcome: "pass", attachments: [{ name: "private.txt", data: privateData }] }],
		},
	});
	expect(other.ok).toBe(true);
	for (const project of ["scratch", "another"]) {
		const chunks: string[] = [];
		const counts = await h.app.database.read(
			async (db) => await exportArchive(db, (chunk) => chunks.push(chunk), { project, blobs: h.app.blobs }),
		);
		const archive = chunks.join("");
		expect(counts.tables.attachments).toBe(1);
		expect(archive).toContain(project === "scratch" ? PNG : privateData);
		expect(archive).not.toContain(project === "scratch" ? privateData : PNG);
		expect(archive).toContain(project === "scratch" ? "screenshot.png" : "private.txt");
		const destination = await rig();
		await destination.app.database.write(
			async (db) =>
				await db.transaction(async () => {
					await db.run(sql("DELETE FROM policies"));
					await db.run(sql("DELETE FROM folders"));
					await db.run(sql("DELETE FROM projects"));
				}),
		);
		await destination.app.database.write(
			async (db) =>
				await db.transaction(async () => await importArchive(db, linesOf(archive), { blobs: destination.app.blobs })),
		);
		expect(
			await destination.app.database.read(
				async (db) => await db.all(sql<[], Record<string, unknown>>("SELECT key FROM projects")),
			),
		).toEqual([{ key: project }]);
		if (project === "scratch") {
			const item = listed.parse(await destination.call("attachment", { result })).items[0];
			expect(downloaded.parse(await destination.call("attachment", { result, id: item?.id })).data).toBe(PNG);
		}
	}
});

test("archives carry attachment content and validate its hash before restoring", async () => {
	const h = await rig();
	const result = (await report(h)).results[0];
	const chunks: string[] = [];
	await h.app.database.read(
		async (db) => await exportArchive(db, (chunk) => chunks.push(chunk), { blobs: h.app.blobs }),
	);
	const archive = chunks.join("");
	expect(archive).toContain(PNG);
	const destination = await harness();
	rigs.push(destination);
	// An archive restores only into an empty instance.
	await destination.app.database.write(
		async (db) =>
			await db.transaction(async () => {
				await db.run(sql("DELETE FROM policies"));
				await db.run(sql("DELETE FROM folders"));
				await db.run(sql("DELETE FROM projects"));
			}),
	);
	await destination.app.database.write(
		async (db) =>
			await db.transaction(async () => await importArchive(db, linesOf(archive), { blobs: destination.app.blobs })),
	);
	expect(listed.parse(await destination.call("attachment", { result })).items).toHaveLength(1);
	const item = listed.parse(await destination.call("attachment", { result })).items[0];
	expect(downloaded.parse(await destination.call("attachment", { result, id: item?.id })).data).toBe(PNG);
	const corrupt = archive
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
	const attachment = corrupt.find((entry) => entry.t === "attachments");
	attachment.blob = Buffer.from("changed").toString("base64");
	const bad = await harness();
	rigs.push(bad);
	await bad.app.database.write(
		async (db) =>
			await db.transaction(async () => {
				await db.run(sql("DELETE FROM policies"));
				await db.run(sql("DELETE FROM folders"));
				await db.run(sql("DELETE FROM projects"));
			}),
	);
	await expect(
		bad.app.database.write(
			async (db) =>
				await db.transaction(
					async () =>
						await importArchive(db, linesOf(corrupt.map((entry) => JSON.stringify(entry)).join("\n")), {
							blobs: bad.app.blobs,
						}),
				),
		),
	).rejects.toThrow(/attachment/);
	if (item) await h.app.blobs.remove(item.hash);
	expect(await h.raw("attachment", { result, id: item?.id })).toMatchObject({
		ok: false,
		error: { code: "not_found" },
	});
	await expect(
		h.app.database.read(async (db) => await exportArchive(db, () => {}, { blobs: h.app.blobs })),
	).rejects.toThrow(/missing or damaged/);
});

test("disk storage survives restart, deduplicates content, and real HTTP replies are JSON", async () => {
	const dir = mkdtempSync(join(tmpdir(), "mainworthy-attachments-"));
	dirs.push(dir);
	const database = await testDatabase();
	databases.push(database);
	const config = defaultConfig({
		MAINWORTHY_DATA: dir,
		MAINWORTHY_OWNER: "robin",
		MAINWORTHY_PORT: "0",
		MAINWORTHY_DATABASE_URL: database.url,
	});
	let instance = await start(config, (app, owner) => ({ ui: null, routes: archiveRoutes(app, owner) }), {});
	instances.push(instance);
	const call = async (op: string, input: unknown) => {
		const response = await fetch(`${instance.url}/api/p/scratch/${op}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(input),
		});
		expect(response.headers.get("content-type")).toStartWith("application/json");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		const reply = z.object({ ok: z.literal(true), result: z.unknown() }).parse(await response.json());
		return reply.result;
	};
	const sent = z.object({ results: z.array(z.number()) }).parse(
		await call("report", {
			target: { session: "disk" },
			results: [{ test: { key: "disk" }, outcome: "fail", attachments: [file, { ...file, name: "second.png" }] }],
		}),
	);
	const result = sent.results[0];
	const item = listed.parse(await call("attachment", { result })).items[0];
	if (!item) throw new Error("No attachment");
	expect(readdirSync(join(dir, "blobs"))).toHaveLength(1);
	expect(readFileSync(join(dir, "blobs", item.hash))).toEqual(Buffer.from(PNG, "base64"));
	await instance.stop();
	instances.pop();
	instance = await start(config, (app, owner) => ({ ui: null, routes: archiveRoutes(app, owner) }), {});
	instances.push(instance);
	expect(downloaded.parse(await call("attachment", { result, id: item.id })).data).toBe(PNG);
	writeFileSync(join(dir, "cli.png"), Buffer.from(PNG, "base64"));
	writeFileSync(join(dir, "video.webm"), Buffer.alloc(6 * 1024 ** 2));
	writeFileSync(join(dir, "trace.zip"), "trace bytes");
	writeFileSync(
		join(dir, "playwright.xml"),
		'<testsuites><testsuite name="chromium"><testcase name="login fails" classname="login.spec.ts"><failure message="timeout"/><system-out><![CDATA[[[ATTACHMENT|video.webm]]\n[[ATTACHMENT|trace.zip]]\n[[ATTACHMENT|cli.png]]]]></system-out></testcase><testcase name="login passes" classname="login.spec.ts"/></testsuite></testsuites>',
	);
	for (const withFiles of [true, false]) {
		const argv = [
			"report",
			join(dir, "playwright.xml"),
			...(withFiles ? ["--attachments", dir] : []),
			"--session",
			`cli-attachments-${withFiles}`,
			"--url",
			instance.url,
			"--project",
			"scratch",
			"--json",
		];
		const env = { ...process.env, MAINWORTHY_TOKEN: "", MAINWORTHY_URL: instance.url };
		const result = withFiles
			? await (async () => {
					const cli = Bun.spawn([process.execPath, "src/cli/main.ts", ...argv], {
						env,
						stdout: "pipe",
						stderr: "pipe",
					});
					const [stdout, stderr, code] = await Promise.all([
						new Response(cli.stdout).text(),
						new Response(cli.stderr).text(),
						cli.exited,
					]);
					return { stdout, stderr, code };
				})()
			: await inThisProcess("report without attachments", async () => await runCli(argv, null, env), {
					environment: env,
					cwd: process.cwd(),
					input: "",
				});
		const { stdout: output, stderr: error } = result;
		expect(result.code, error).toBe(0);
		const uploaded = z
			.object({
				results: z.array(z.number()).length(2),
				counts: z.object({ total: z.number(), pass: z.number(), fail: z.number() }),
				skippedAttachments: z.number(),
			})
			.parse(JSON.parse(output));
		expect(uploaded.counts).toMatchObject({ total: 2, pass: 1, fail: 1 });
		expect(uploaded.skippedAttachments).toBe(withFiles ? 1 : 3);
		expect(error.trim().split("\n")).toHaveLength(1);
		expect(error).toContain(withFiles ? "video.webm" : "--attachments");
		const files = listed.parse(await call("attachment", { result: uploaded.results[0] }));
		expect(files.items.map((item) => item.name)).toEqual(withFiles ? ["trace.zip", "cli.png"] : []);
		if (withFiles)
			expect(
				downloaded.parse(await call("attachment", { result: uploaded.results[0], id: files.items[1]?.id })).data,
			).toBe(PNG);
	}
	const exported = await fetch(`${instance.url}/api/export?project=scratch`);
	expect(exported.status).toBe(200);
	const archive = await exported.text();
	expect(archive).toContain(PNG);
	const destination = mkdtempSync(join(tmpdir(), "mainworthy-attachment-import-"));
	dirs.push(destination);
	const importedDatabase = await testDatabase();
	databases.push(importedDatabase);
	const restored = await start(
		{ ...config, dataDir: destination, databaseUrl: importedDatabase.url },
		(app, owner) => ({ ui: null, routes: archiveRoutes(app, owner) }),
		{},
	);
	instances.push(restored);
	const imported = await fetch(`${restored.url}/api/import`, { method: "POST", body: archive });
	expect(imported.status, await imported.clone().text()).toBe(200);
	const content = await fetch(`${restored.url}/api/p/scratch/attachment`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ result, id: item.id }),
	});
	const reply = z.object({ ok: z.literal(true), result: downloaded }).parse(await content.json());
	expect(reply.result.data).toBe(PNG);
});

test("startup queues age-bounded pruning and accepted attachment recovery without blocking HTTP", async () => {
	let now = Date.now();
	const dir = mkdtempSync(join(tmpdir(), "mainworthy-attachment-recovery-"));
	dirs.push(dir);
	const database = await testDatabase();
	databases.push(database);
	const config = defaultConfig({
		MAINWORTHY_DATA: dir,
		MAINWORTHY_OWNER: "robin",
		MAINWORTHY_PORT: "0",
		MAINWORTHY_DATABASE_URL: database.url,
		MAINWORTHY_JOB_RUNNER: "0",
	});
	let instance = await start(config, () => ({ ui: null }), { now: () => now });
	instances.push(instance);
	const orphan = await instance.app.blobs.put(Buffer.from("orphan"));
	await instance.app.database.write(
		async (db) =>
			await db.transaction(async () => {
				const project = await findProject(db, "scratch");
				if (!project) throw new Error("No project");
				const ctx = makeCtx(instance.app, db, project, instance.owner, true);
				await acceptReport(
					ctx,
					ReportInput.parse({
						target: { session: "interrupted" },
						results: [{ test: { key: "recovered" }, outcome: "fail", attachments: [file] }],
					}),
				);
				await stampSeq(ctx);
			}),
	);
	await instance.stop();
	instances.pop();
	now += BLOB_GRACE_MS + 1;
	instance = await start(config, () => ({ ui: null }), { now: () => now });
	instances.push(instance);
	expect((await fetch(`${instance.url}/health`)).status).toBe(200);
	expect(await instance.app.blobs.get(orphan)).not.toBeNull();
	await instance.minute();
	expect(await instance.app.blobs.get(orphan)).toBeNull();
	expect(readdirSync(join(dir, "blobs"))).toHaveLength(1);
	const response = await fetch(`${instance.url}/api/p/scratch/get`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ refs: ["T-1"] }),
	});
	const recovered = z
		.object({ ok: z.literal(true), result: z.array(z.object({ last: z.array(z.object({ id: z.number() })) })) })
		.parse(await response.json());
	const result = recovered.result[0]?.last[0]?.id;
	expect(result).toBeGreaterThan(0);
	const list = await fetch(`${instance.url}/api/p/scratch/attachment`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ result }),
	});
	expect(z.object({ ok: z.literal(true), result: listed }).parse(await list.json()).result.items[0]?.name).toBe(
		file.name,
	);
});
