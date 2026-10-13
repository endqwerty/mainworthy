import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { harness } from "../../test/helpers.ts";
import { type App, type Config, openApp } from "./kernel/app.ts";
import { Readers, readerCount } from "./readers.ts";

const apps: App[] = [];
const pools: Readers[] = [];
const dirs: string[] = [];
const probes: Worker[] = [];
afterEach(async () => {
	for (const pool of pools.splice(0)) await pool.stop();
	for (const worker of probes.splice(0)) await worker.terminate();
	for (const app of apps.splice(0)) app.close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function config(): Config {
	const dataDir = mkdtempSync(join(tmpdir(), "mainworthy-reader-"));
	dirs.push(dataDir);
	return { dataDir, host: "127.0.0.1", port: 0, mode: "local", owner: "robin", ownerToken: null };
}

function workerUrl(source: string): string {
	const dir = mkdtempSync(join(tmpdir(), "mainworthy-probe-worker-"));
	dirs.push(dir);
	const path = join(dir, "worker.ts");
	writeFileSync(path, source);
	return path;
}

describe("reader threads", () => {
	test("the default leaves cores for writing and checkpoints, is capped at eight, and zero disables readers", () => {
		expect(readerCount({}, 1)).toBe(1);
		expect(readerCount({}, 2)).toBe(1);
		expect(readerCount({}, 4)).toBe(2);
		expect(readerCount({}, 8)).toBe(6);
		expect(readerCount({}, 16)).toBe(8);
		expect(readerCount({ MAINWORTHY_READERS: "0" }, 16)).toBe(0);
		expect(readerCount({ MAINWORTHY_READERS: "2" }, 16)).toBe(2);
		for (const value of ["", "-1", "1.5", "2x", "Infinity", "9007199254740992"])
			expect(() => readerCount({ MAINWORTHY_READERS: value })).toThrow("MAINWORTHY_READERS");
	});

	test("memory apps keep reads inline", () => {
		const h = harness();
		try {
			expect(h.app.readers).toBeNull();
			expect(h.call("find")).toMatchObject({ items: [] });
		} finally {
			h.close();
		}
	});

	test("the worker connection refuses writes and opening it does not migrate a database", () => {
		const settings = config();
		const writer = openApp(settings);
		apps.push(writer);
		const reader = openApp(settings, { reader: true });
		apps.push(reader);
		expect(reader.reader).toBe(reader.db);
		expect(() => reader.db.exec("CREATE TABLE reader_must_not_write (value INTEGER)")).toThrow("readonly");
		expect(() => openApp(config(), { reader: true })).toThrow();
	});

	test("a real worker's database connection refuses an attempted schema write", async () => {
		const settings = config();
		apps.push(openApp(settings));
		const source = workerUrl(`
			import { parentPort, workerData } from "node:worker_threads";
			import { openApp } from ${JSON.stringify(new URL("./kernel/app.ts", import.meta.url).href)};
			const app = openApp(workerData, { reader: true });
			try {
				app.db.exec("CREATE TABLE reader_must_not_write (value INTEGER)");
				parentPort.postMessage("a write was allowed");
			} catch (error) {
				parentPort.postMessage(error.message);
			} finally {
				app.close();
				parentPort.close();
			}
		`);
		const worker = new Worker(source, { workerData: settings });
		probes.push(worker);
		const result = await new Promise<unknown>((resolve, reject) => {
			worker.once("message", resolve);
			worker.once("error", reject);
		});
		expect(result).toBe("attempt to write a readonly database");
	});

	test("a worker error replays all pending requests once, logs once, and replaces the thread", async () => {
		const settings = config();
		apps.push(openApp(settings));
		let first = true;
		const crash = workerUrl(
			'import { parentPort } from "node:worker_threads"; parentPort.on("message", () => { throw new Error("reader crashed"); });',
		);
		const pool = new Readers({
			dataDir: settings.dataDir,
			count: 1,
			spawn(url, dataDir) {
				if (first) {
					first = false;
					return new Worker(crash);
				}
				return new Worker(url, { workerData: { dataDir } });
			},
		});
		pools.push(pool);
		const log = spyOn(console, "error").mockImplementation(() => {});
		try {
			let retried = 0;
			const requests = Array.from({ length: 32 }, () =>
				pool.run({ op: "find", project: "scratch", input: {}, actor: null }, () => {
					retried++;
					return { ok: true, result: "replayed", seq: null };
				}),
			);
			expect((await Promise.all(requests)).every((reply) => reply.ok && reply.result === "replayed")).toBe(true);
			expect(retried).toBe(32);
			await pool.ready();
			expect(pool.threads).toHaveLength(1);
			expect(log).toHaveBeenCalledTimes(1);
			const reply = await pool.run({ op: "find", project: "missing", input: {}, actor: null }, () => {
				throw new Error("the replacement must answer");
			});
			expect(reply).toMatchObject({ ok: false, error: { code: "not_found" } });
			expect(pool.completed).toBe(1);
		} finally {
			log.mockRestore();
		}
	});

	test("stop resolves pending work inline, awaits thread exits, and is idempotent", async () => {
		const settings = config();
		apps.push(openApp(settings));
		const silent = workerUrl('import { parentPort } from "node:worker_threads"; parentPort.on("message", () => {});');
		const pool = new Readers({ dataDir: settings.dataDir, count: 2, spawn: () => new Worker(silent) });
		pools.push(pool);
		const threads = pool.threads;
		const exits = threads.map((worker) => new Promise<void>((resolve) => worker.once("exit", () => resolve())));
		const requests = Array.from({ length: 12 }, () =>
			pool.run({ op: "find", project: "scratch", input: {}, actor: null }, () => ({
				ok: true,
				result: "shutdown fallback",
				seq: null,
			})),
		);
		await pool.stop();
		await Promise.all(exits);
		expect((await Promise.all(requests)).every((reply) => reply.ok && reply.result === "shutdown fallback")).toBe(true);
		expect(pool.threads).toHaveLength(0);
		await pool.stop();
	});
});
