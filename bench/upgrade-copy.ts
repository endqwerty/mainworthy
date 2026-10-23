// Usage: bun bench/upgrade-copy.ts /path/to/baseline/export /path/from/work-scratch-new [MiB]
import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { constants, copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { cpus, loadavg, platform, release } from "node:os";
import { join, resolve } from "node:path";
import { Db } from "../src/server/kernel/db.ts";
import { MIGRATIONS, SCHEMA_VERSION } from "../src/server/kernel/migrate.ts";

function digest(path: string): { rows: number; bytes: number; hash: string } {
	const db = new Database(path, { readonly: true });
	try {
		assert.deepEqual(db.query("PRAGMA integrity_check").all(), [{ integrity_check: "ok" }]);
		const hash = createHash("sha256");
		let rows = 0;
		let bytes = 0;
		for (const row of db
			.query<{ id: number; payload: Uint8Array }, []>("SELECT id, payload FROM bench_payload ORDER BY id")
			.iterate()) {
			assert.equal(row.id, ++rows);
			hash.update(row.payload);
			bytes += row.payload.byteLength;
		}
		assert.deepEqual(db.query("SELECT value FROM meta WHERE key = 'schema_version'").get(), {
			value: String(SCHEMA_VERSION - 1),
		});
		return { rows, bytes, hash: hash.digest("hex") };
	} finally {
		db.close();
	}
}

if (process.argv[2] === "--sample") {
	const [root, source, directory, mode, side] = process.argv.slice(3);
	assert(root && source && directory && (mode === "copy" || mode === "startup"));
	mkdirSync(directory);
	const path = join(directory, "mainworthy.db");
	copyFileSync(source, path, constants.COPYFILE_FICLONE);
	const expected = digest(source);
	const dbModule: typeof import("../src/server/kernel/db.ts") = await import(`${root}/src/server/kernel/db.ts`);
	const startup: typeof import("../src/app/start.ts") = await import(`${root}/src/app/start.ts`);
	const { defaultConfig }: typeof import("../src/server/kernel/app.ts") = await import(
		`${root}/src/server/kernel/app.ts`
	);
	const backup = `${path}.v${SCHEMA_VERSION - 1}.bak`;
	let stop = async () => {};
	let run: () => unknown | Promise<unknown>;
	if (mode === "copy") {
		const db = new dbModule.Db(path);
		stop = async () => db.close();
		run =
			side === "before"
				? () => dbModule.writePrivateDatabaseFile(backup, (output) => db.raw.query("VACUUM INTO ?").run(output))
				: () => db.copyTo(backup);
	} else {
		const config = defaultConfig({ MAINWORTHY_DATA: directory, MAINWORTHY_PORT: "0", MAINWORTHY_OWNER: "robin" });
		run = async () => {
			const instance = await (side === "before"
				? startup.start(config, () => ({ ui: null }), { readers: 0 })
				: startup.startServing(config, () => ({ ui: null }), { readers: 0 }));
			stop = () => instance.stop();
			const health = await fetch(`${instance.url}/healthz`);
			assert.equal((await health.json()).ok, true);
		};
	}
	try {
		const cpu = process.cpuUsage();
		const began = performance.now();
		await run();
		const ms = performance.now() - began;
		const used = process.cpuUsage(cpu);
		assert.deepEqual(digest(backup), expected);
		console.log(
			JSON.stringify({
				ms,
				cpuMs: (used.user + used.system) / 1000,
				backupBytes: statSync(backup).size,
				...expected,
				errors: 0,
			}),
		);
	} finally {
		await stop();
		rmSync(directory, { recursive: true, force: true });
	}
} else {
	const [baseline, scratch, size = "320"] = process.argv.slice(2);
	assert(baseline && scratch, "supply baseline export and a work scratch directory");
	const mib = Number(size);
	assert(Number.isSafeInteger(mib) && mib >= 256 && mib <= 1024);
	const source = join(scratch, "fixture.db");
	assert(!existsSync(source), "use a scratch directory without an existing fixture.db");
	const db = new Db(source);
	const sqlite = db.raw.query("SELECT sqlite_version() AS version").get();
	try {
		for (const migration of MIGRATIONS.slice(0, -1)) db.exec(migration.sql);
		db.raw.query("INSERT INTO meta VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION - 1));
		db.exec("CREATE TABLE bench_payload (id INTEGER PRIMARY KEY, payload BLOB NOT NULL)");
		const insert = db.raw.prepare("INSERT INTO bench_payload VALUES (?, ?)");
		const payload = Buffer.alloc(16 * 1024);
		for (let index = 0; index < payload.length; index++) payload[index] = index % 251;
		db.transaction(() => {
			for (let row = 1; row <= mib * 64; row++) insert.run(row, payload);
		});
	} finally {
		db.close();
	}
	console.log(
		JSON.stringify({
			claim:
				"Durable upgrade-copy and HTTP-ready startup latency on a generated, warm-cache database; no production extrapolation",
			bun: Bun.version,
			sqlite,
			platform: platform(),
			release: release(),
			cpu: cpus()[0]?.model,
			cores: cpus().length,
			load: loadavg(),
			sourceBytes: statSync(source).size,
			correctness: digest(source),
		}),
	);
	try {
		for (const mode of ["copy", "startup"]) {
			const samples: Record<"before" | "after", number[]> = { before: [], after: [] };
			for (let round = 0; round < 5; round++) {
				for (const side of ["before", "after"] as const) {
					const child: Bun.Subprocess<"ignore", "pipe", "pipe"> = Bun.spawn(
						[
							process.execPath,
							import.meta.path,
							"--sample",
							side === "before" ? resolve(baseline) : resolve(import.meta.dir, ".."),
							source,
							join(scratch, `${mode}-${round}-${side}`),
							mode,
							side,
						],
						{ stdout: "pipe", stderr: "pipe", env: { ...process.env, NODE_ENV: "production" } },
					);
					const [stdout, stderr, code]: [string, string, number] = await Promise.all([
						new Response(child.stdout).text(),
						new Response(child.stderr).text(),
						child.exited,
					]);
					assert.equal(code, 0, stderr);
					const sample: { ms: number; errors: number } = JSON.parse(stdout);
					assert.equal(sample.errors, 0);
					samples[side].push(sample.ms);
					console.log(JSON.stringify({ mode, round, side, ...sample, load: loadavg() }));
				}
			}
			for (const side of ["before", "after"] as const) {
				const sorted = samples[side].toSorted((a, b) => a - b);
				console.log(
					JSON.stringify({ mode, side, n: sorted.length, medianMs: sorted[2], minMs: sorted[0], maxMs: sorted.at(-1) }),
				);
			}
		}
	} finally {
		for (const file of [source, `${source}-wal`, `${source}-shm`]) rmSync(file, { force: true });
	}
}
