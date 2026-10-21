import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start } from "../src/app/start.ts";
import { defaultConfig } from "../src/server/kernel/app.ts";
import { createPrivateDatabaseFile, Db, databasePath } from "../src/server/kernel/db.ts";
import { migrate, openDatabase, SCHEMA_VERSION, schemaVersion } from "../src/server/kernel/migrate.ts";

const mode = (path: string): number => statSync(path).mode & 0o777;
const databaseFiles = (path: string): string[] => [path, `${path}-wal`, `${path}-shm`];

test("an instance in an existing readable directory keeps its database private", async () => {
	const directory = mkdtempSync(join(tmpdir(), "mainworthy-private-instance-"));
	chmodSync(directory, 0o755);
	const sentinel = join(directory, "unrelated.txt");
	writeFileSync(sentinel, "operator data", { mode: 0o644 });
	const instance = start(
		defaultConfig({ MAINWORTHY_DATA: directory, MAINWORTHY_PORT: "0", MAINWORTHY_OWNER: "robin" }),
		() => ({ ui: null }),
		{ readers: 1 },
	);
	try {
		const response = await fetch(`${instance.url}/api/session`);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ ok: true, result: { actor: "robin" } });
		expect(databaseFiles(databasePath(directory)).map(mode)).toEqual([0o600, 0o600, 0o600]);
		expect(mode(directory)).toBe(0o755);
		expect(mode(sentinel)).toBe(0o644);
		expect(readFileSync(sentinel, "utf8")).toBe("operator data");
	} finally {
		await instance.stop();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("reopening a permissive database and its live sidecars preserves rows and makes them private", () => {
	const directory = mkdtempSync(join(tmpdir(), "mainworthy-private-reopen-"));
	const path = databasePath(directory);
	const old = new Database(path, { create: true });
	try {
		old.exec("PRAGMA journal_mode = WAL; CREATE TABLE preserved (value TEXT); INSERT INTO preserved VALUES ('kept')");
		for (const file of databaseFiles(path)) chmodSync(file, 0o644);
		const db = new Db(path);
		try {
			expect(databaseFiles(path).map(mode)).toEqual([0o600, 0o600, 0o600]);
			expect(db.raw.query("SELECT value FROM preserved").all()).toEqual([{ value: "kept" }]);
			const reader = new Db(path, { reader: true });
			try {
				expect(reader.raw.query("SELECT value FROM preserved").all()).toEqual([{ value: "kept" }]);
				expect(() => reader.exec("DELETE FROM preserved")).toThrow("readonly");
			} finally {
				reader.close();
			}
		} finally {
			db.close();
		}
	} finally {
		old.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("an existing database must belong to the server operating-system user", () => {
	const directory = mkdtempSync(join(tmpdir(), "mainworthy-private-owner-"));
	const path = databasePath(directory);
	writeFileSync(path, "", { mode: 0o644 });
	const effectiveUid = spyOn(process, "geteuid").mockReturnValue(statSync(path).uid + 1);
	try {
		expect(() => new Db(path)).toThrow("a database must be owned by the server user");
		expect(mode(path)).toBe(0o644);
	} finally {
		effectiveUid.mockRestore();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("an upgrade copy is private before its first database bytes are written", () => {
	const directory = mkdtempSync(join(tmpdir(), "mainworthy-private-copy-"));
	const path = join(directory, "copy.db.tmp");
	try {
		const result = createPrivateDatabaseFile(path, (privatePath) => {
			expect(privatePath).toBe(path);
			expect(statSync(privatePath).isFile()).toBe(true);
			expect(mode(privatePath)).toBe(0o600);
			writeFileSync(privatePath, "database bytes");
			return "written";
		});
		expect(result).toBe("written");
		expect(readFileSync(path, "utf8")).toBe("database bytes");
		expect(() => createPrivateDatabaseFile(path, () => undefined)).toThrow();
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("a retained copy is hardened even when the live database cannot open", () => {
	const directory = mkdtempSync(join(tmpdir(), "mainworthy-private-corrupt-"));
	const path = databasePath(directory);
	const retained = `${path}.v1.bak`;
	writeFileSync(path, "not a database", { mode: 0o644 });
	writeFileSync(retained, "sensitive backup bytes", { mode: 0o644 });
	try {
		expect(() => openDatabase(path)).toThrow("not a database");
		expect(mode(path)).toBe(0o600);
		expect(mode(retained)).toBe(0o600);
		expect(readFileSync(retained, "utf8")).toBe("sensitive backup bytes");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("a retained copy is hardened before a refused live database path", () => {
	const directory = mkdtempSync(join(tmpdir(), "mainworthy-private-refused-"));
	const path = databasePath(directory);
	const target = join(directory, "target.db");
	const retained = `${path}.v1.bak`;
	writeFileSync(target, "target bytes", { mode: 0o644 });
	symlinkSync(target, path);
	writeFileSync(retained, "sensitive backup bytes", { mode: 0o644 });
	try {
		expect(() => new Db(path)).toThrow();
		expect(mode(retained)).toBe(0o600);
		expect(readFileSync(retained, "utf8")).toBe("sensitive backup bytes");
		expect(mode(target)).toBe(0o644);
		expect(readFileSync(target, "utf8")).toBe("target bytes");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("an upgrade refuses a retained-copy symlink without changing the database or its target", () => {
	const directory = mkdtempSync(join(tmpdir(), "mainworthy-private-backup-link-"));
	const path = databasePath(directory);
	const fixture = Bun.gunzipSync(readFileSync(join(import.meta.dir, "fixtures/sessions/instance-v1.db.gz")));
	const backup = `${path}.v1.bak`;
	const target = join(directory, "operator-file");
	writeFileSync(path, fixture, { mode: 0o600 });
	writeFileSync(target, "do not touch", { mode: 0o644 });
	symlinkSync(target, backup);
	let opened: Db | undefined;
	try {
		expect(() => {
			opened = openDatabase(path);
		}).toThrow();
		const unchanged = new Database(path, { readonly: true });
		try {
			expect(unchanged.query("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "1" });
		} finally {
			unchanged.close();
		}
		expect(lstatSync(backup).isSymbolicLink()).toBe(true);
		expect(readFileSync(target, "utf8")).toBe("do not touch");
		expect(mode(target)).toBe(0o644);
	} finally {
		opened?.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("upgrade copies are private and retained copies are hardened without changing their bytes", () => {
	const directory = mkdtempSync(join(tmpdir(), "mainworthy-private-upgrade-"));
	const path = databasePath(directory);
	const fixture = Bun.gunzipSync(readFileSync(join(import.meta.dir, "fixtures/sessions/instance-v1.db.gz")));
	writeFileSync(path, fixture, { mode: 0o644 });
	const retained = `${path}.v${SCHEMA_VERSION + 1}.bak`;
	writeFileSync(retained, fixture, { mode: 0o644 });
	try {
		const db = new Db(path);
		const originalQuery = db.raw.query.bind(db.raw);
		const temporary: string[] = [];
		const query = spyOn(db.raw, "query").mockImplementation(((sql: string) => {
			const statement = originalQuery(sql);
			if (sql !== "VACUUM INTO ?") return statement;
			return new Proxy(statement, {
				get(target, property, receiver) {
					if (property !== "run") return Reflect.get(target, property, receiver);
					return (destination: string) => {
						temporary.push(destination);
						expect(statSync(destination).isFile()).toBe(true);
						expect(mode(destination)).toBe(0o600);
						return target.run(destination);
					};
				},
			});
		}) as typeof db.raw.query);
		try {
			migrate(db, path);
			expect(temporary).toHaveLength(1);
			expect(temporary[0]?.startsWith(`${path}.v1.bak.`)).toBe(true);
			expect(temporary[0]?.endsWith(".tmp")).toBe(true);
			expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
			expect(mode(`${path}.v1.bak`)).toBe(0o600);
			expect(mode(retained)).toBe(0o600);
			expect(readFileSync(retained)).toEqual(Buffer.from(fixture));
			const backup = new Database(`${path}.v1.bak`, { readonly: true });
			try {
				expect(backup.query("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "1" });
			} finally {
				backup.close();
			}
		} finally {
			query.mockRestore();
			db.close();
		}
		chmodSync(retained, 0o644);
		const reopened = openDatabase(path);
		try {
			expect(schemaVersion(reopened)).toBe(SCHEMA_VERSION);
			expect(mode(retained)).toBe(0o600);
			expect(readFileSync(retained)).toEqual(Buffer.from(fixture));
		} finally {
			reopened.close();
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("a connection opened while another process holds the database waits for it rather than failing (#689)", async () => {
	const directory = mkdtempSync(join(tmpdir(), "mainworthy-busy-open-"));
	const path = databasePath(directory);
	new Db(path).close();
	// Another process takes the database for itself and lets it go 300 ms later, as a connection recovering the
	// log does. The checkpoint thread opened its connection in such a moment and died.
	const holder = Bun.spawn(
		[
			process.execPath,
			"-e",
			`const { Database } = require("bun:sqlite");
			const db = new Database(${JSON.stringify(path)});
			db.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE held (x); COMMIT; BEGIN EXCLUSIVE");
			console.log("held");
			await Bun.sleep(300);
			db.exec("COMMIT");
			db.close();`,
		],
		{ stdout: "pipe" },
	);
	try {
		const said = await holder.stdout.getReader().read();
		expect(new TextDecoder().decode(said.value)).toBe("held\n");
		const db = new Db(path);
		try {
			expect(db.raw.query("SELECT name FROM sqlite_master WHERE name = 'held'").get()).toEqual({ name: "held" });
		} finally {
			db.close();
		}
		expect(await holder.exited).toBe(0);
	} finally {
		holder.kill();
		rmSync(directory, { recursive: true, force: true });
	}
});
