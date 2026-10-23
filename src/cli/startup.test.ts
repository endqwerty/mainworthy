import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import { type Instance, prepareStartup, start, startServing } from "../app/start.ts";
import { API_VERSION, VERSION } from "../core/version.ts";
import { defaultConfig } from "../server/kernel/app.ts";
import { Db, databasePath } from "../server/kernel/db.ts";
import { lockInstance } from "../server/kernel/instance-lock.ts";
import { openDatabase, SCHEMA_VERSION } from "../server/kernel/migrate.ts";
import { contentSecurityPolicy } from "../surfaces/headers.ts";
import { PATIENCE } from "../surfaces/http.ts";
import { Client } from "./client.ts";
import { runCli } from "./dispatch.ts";
import { verifyLockdownStatus } from "./lockdown.ts";
import { CLI_ENTRY, COMMIT, inThisProcess, withInstance } from "./test-support.ts";

/**
 * What a start in server mode says when the environment names no proxy: one line on stderr, once. A start in
 * local mode does not say it, and neither does one with the two variables set (`BEHIND_PROXY`).
 */
const NO_PROXY_NAMED =
	"mainworthy: MAINWORTHY_TRUSTED_PROXY and MAINWORTHY_CLIENT_ADDRESS_HEADER are not set: a failed sign-in from a loopback or private address, which behind a proxy is every visitor's, is not counted against that address, only against the first 8 characters of the token it tried. docs/deploy.md says how to set the two.\n";
/** The two variables, for a start that is about something else and should have nothing to say about the limit. */
const BEHIND_PROXY = { MAINWORTHY_TRUSTED_PROXY: "10.0.0.1", MAINWORTHY_CLIENT_ADDRESS_HEADER: "x-real-ip" };

test.each([
	{ kind: "start", source: "option" },
	{ kind: "start", source: "environment" },
	{ kind: "startServing", source: "option" },
	{ kind: "startServing", source: "environment" },
	{ kind: "start", source: "port" },
	{ kind: "startServing", source: "port" },
])("$kind refuses invalid $source configuration before touching an old database", async ({ kind, source }) => {
	const directory = await mkdtemp(join(tmpdir(), "mainworthy-readers-before-upgrade-"));
	const path = databasePath(directory);
	const fixture = Bun.gunzipSync(
		readFileSync(new URL("../../test/fixtures/sessions/instance-v1.db.gz", import.meta.url)),
	);
	writeFileSync(path, fixture);
	const config = defaultConfig({ MAINWORTHY_DATA: directory, MAINWORTHY_PORT: source === "port" ? "-1" : "0" });
	const previous = process.env.MAINWORTHY_READERS;
	if (source === "environment") process.env.MAINWORTHY_READERS = "9";
	const options = source === "option" ? { readers: 9 } : {};
	const expected = source === "port" ? undefined : "MAINWORTHY_READERS";
	try {
		if (kind === "start") expect(async () => await start(config, () => ({ ui: null }), options)).toThrow(expected);
		else await expect(await startServing(config, () => ({ ui: null }), options)).rejects.toThrow(expected);
		expect(readFileSync(path).equals(Buffer.from(fixture))).toBe(true);
		expect(readdirSync(directory)).toEqual(["mainworthy.db"]);
	} finally {
		if (previous === undefined) delete process.env.MAINWORTHY_READERS;
		else process.env.MAINWORTHY_READERS = previous;
		await rm(directory, { recursive: true, force: true });
	}
});

test("a progressing copy outlives the idle deadline, publishes a complete backup, and removes its workspace", async () => {
	const directory = await mkdtemp(join(tmpdir(), "mainworthy-progressing-copy-"));
	const path = databasePath(directory);
	writeFileSync(
		path,
		Bun.gunzipSync(readFileSync(new URL("../../test/fixtures/sessions/instance-v1.db.gz", import.meta.url))),
	);
	let owned = "";
	const config = defaultConfig({ MAINWORTHY_DATA: directory, MAINWORTHY_PORT: "0", MAINWORTHY_OWNER: "robin" });
	// Keep application import/bootstrap time outside this fixture's short copy inactivity allowance.
	const prepared = await prepareStartup(config, {}, () => {});
	try {
		const instance = await startServing(config, () => ({ ui: null }), {
			readers: 0,
			startupIdleMs: 500,
			spawn: (_url, data) => {
				owned = data.workspace;
				return new Worker(new URL("../../test/startup-progress-worker.ts", import.meta.url), {
					workerData: { ...data, mode: "progress", prepared },
				});
			},
		});
		try {
			expect((await (await fetch(`${instance.url}/healthz`)).json()).ok).toBe(true);
			expect(existsSync(owned)).toBe(false);
			const copy = new Db(`${path}.v${SCHEMA_VERSION}.bak`, { reader: true });
			try {
				expect(copy.raw.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
				expect(copy.raw.query("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
					value: String(SCHEMA_VERSION),
				});
			} finally {
				copy.close();
			}
		} finally {
			await instance.stop();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test.each(["failure", "stall"])("startup cleans only its own partial copy after worker %s", async (mode) => {
	const directory = await mkdtemp(join(tmpdir(), "mainworthy-owned-copy-"));
	const path = databasePath(directory);
	const saved = `${path}.v1.bak.mainworthy-copy-Ab12Cd`;
	await mkdir(saved);
	writeFileSync(join(saved, "operator-saved"), "keep");
	let owned = "";
	try {
		await expect(
			await startServing(defaultConfig({ MAINWORTHY_DATA: directory, MAINWORTHY_PORT: "0" }), () => ({ ui: null }), {
				readers: 0,
				startupIdleMs: 250,
				spawn: (_url, data) => {
					owned = data.workspace;
					return new Worker(new URL("../../test/startup-progress-worker.ts", import.meta.url), {
						workerData: { ...data, mode },
					});
				},
			}),
		).rejects.toThrow(mode === "failure" ? "injected startup failure" : "idle deadline");
		expect(existsSync(owned)).toBe(false);
		expect(readFileSync(join(saved, "operator-saved"), "utf8")).toBe("keep");
		lockInstance(directory)();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("startup cancellation removes its partial copy after the worker stops", async () => {
	const directory = await mkdtemp(join(tmpdir(), "mainworthy-aborted-copy-"));
	const controller = new AbortController();
	let owned = "";
	const starting = await startServing(
		defaultConfig({ MAINWORTHY_DATA: directory, MAINWORTHY_PORT: "0" }),
		() => ({ ui: null }),
		{
			readers: 0,
			signal: controller.signal,
			spawn: (_url, data) => {
				owned = data.workspace;
				return new Worker(new URL("../../test/startup-progress-worker.ts", import.meta.url), {
					workerData: { ...data, mode: "stall" },
				});
			},
		},
	);
	void starting.catch(() => {});
	try {
		const deadline = performance.now() + 3000;
		while (!existsSync(join(owned, "mainworthy.db.v1.bak")) && performance.now() < deadline) await Bun.sleep(10);
		expect(existsSync(join(owned, "mainworthy.db.v1.bak"))).toBe(true);
		controller.abort(new Error("test startup cancellation"));
		await expect(starting).rejects.toThrow("test startup cancellation");
		expect(existsSync(owned)).toBe(false);
		lockInstance(directory)();
	} finally {
		controller.abort();
		await starting.catch(() => {});
		await rm(directory, { recursive: true, force: true });
	}
});

test("a failing listening callback closes liveness and releases the instance lock", async () => {
	const directory = await mkdtemp(join(tmpdir(), "mainworthy-listening-failed-"));
	let url = "";
	let opened: Instance | undefined;
	try {
		const starting = startServing(
			defaultConfig({ MAINWORTHY_DATA: directory, MAINWORTHY_PORT: "0" }),
			() => ({ ui: null }),
			{
				readers: 0,
				onListening: (bound) => {
					url = bound;
					throw new Error("listening callback failed");
				},
			},
		);
		await expect(
			starting.then((instance) => {
				opened = instance;
			}),
		).rejects.toThrow("listening callback failed");
		expect(Number(new URL(url).port)).toBeGreaterThan(0);
		await expect(fetch(`${url}/healthz`)).rejects.toThrow();
		lockInstance(directory)();
	} finally {
		await opened?.stop();
		await rm(directory, { recursive: true, force: true });
	}
});

test("health keeps answering upgrading during synchronously blocked assertion recovery", async () => {
	const directory = await mkdtemp(join(tmpdir(), "mainworthy-recovery-health-"));
	let url = "";
	const pause = new SharedArrayBuffer(4);
	const state = new Int32Array(pause);
	const starting = startServing(
		defaultConfig({ MAINWORTHY_DATA: directory, MAINWORTHY_PORT: "0", MAINWORTHY_OWNER: "robin" }),
