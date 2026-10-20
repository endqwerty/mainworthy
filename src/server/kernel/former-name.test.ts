import { expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, defaultConfig } from "./app.ts";
import { Db, databasePath } from "./db.ts";
import { adoptFormerInstall } from "./former-name.ts";

/**
 * A home directory as an install under the former name left it after a crash: `<home>/<dir>/casebook.db` with a
 * committed row that is still in the write-ahead log, not in the database file.
 */
function formerInstall(dir: string): { home: string; data: string } {
	const home = mkdtempSync(join(tmpdir(), "mainworthy-former-"));
	const live = join(home, "live");
	const db = new Db(join(live, "casebook.db"));
	db.exec("PRAGMA wal_autocheckpoint = 0");
	db.exec("CREATE TABLE kept (value TEXT)");
	db.exec("INSERT INTO kept VALUES ('from the log')");
	const data = join(home, dir);
	mkdirSync(data, { recursive: true });
	for (const file of readdirSync(live)) {
		const copy = join(data, file);
		cpSync(join(live, file), copy);
		chmodSync(copy, 0o644);
	}
	db.close();
	rmSync(live, { recursive: true });
	expect(existsSync(join(data, "casebook.db-wal"))).toBe(true);
	return { home, data };
}

const config = (env: Record<string, string>): Config => defaultConfig(env);
const kept = (path: string): unknown => {
	const db = new Db(path, { reader: true });
	try {
		return db.raw.query("SELECT value FROM kept").all();
	} finally {
		db.close();
	}
};

test("the default data directory and its database move to the new name, with what was only in the log", () => {
	const { home } = formerInstall(".casebook");
	try {
		const moved = adoptFormerInstall(config({ HOME: home }), { HOME: home });
		expect(moved).toEqual([
			`moved ${join(home, ".casebook")} to ${join(home, ".mainworthy")}`,
			`moved ${join(home, ".mainworthy", "casebook.db")} to ${join(home, ".mainworthy", "mainworthy.db")}`,
		]);
		expect(readdirSync(home)).toEqual([".mainworthy"]);
		expect(readdirSync(join(home, ".mainworthy"))).toEqual(["mainworthy.db"]);
		expect(statSync(databasePath(join(home, ".mainworthy"))).mode & 0o777).toBe(0o600);
		expect(kept(databasePath(join(home, ".mainworthy")))).toEqual([{ value: "from the log" }]);
		// A second start finds nothing to do.
		expect(adoptFormerInstall(config({ HOME: home }), { HOME: home })).toEqual([]);
	} finally {
		rmSync(home, { recursive: true });
	}
});

test("a data directory that was named is not moved; the database inside it is", () => {
	const { home, data } = formerInstall("data");
	try {
		const env = { HOME: home, MAINWORTHY_DATA: data };
		expect(adoptFormerInstall(config(env), env)).toEqual([
			`moved ${join(data, "casebook.db")} to ${join(data, "mainworthy.db")}`,
		]);
		expect(readdirSync(data)).toEqual(["mainworthy.db"]);
		expect(kept(databasePath(data))).toEqual([{ value: "from the log" }]);
	} finally {
		rmSync(home, { recursive: true });
	}
});

test("a database that another connection has open is left where it is, and the start is refused", () => {
	const { home, data } = formerInstall("data");
	const other = new Db(join(data, "casebook.db"));
	try {
		const env = { HOME: home, MAINWORTHY_DATA: data };
		expect(() => adoptFormerInstall(config(env), env)).toThrow(
			`${join(data, "casebook.db")} is open in another process; stop it, then start again`,
		);
		expect(existsSync(join(data, "casebook.db"))).toBe(true);
		expect(existsSync(databasePath(data))).toBe(false);
		expect(other.raw.query("SELECT value FROM kept").all()).toEqual([{ value: "from the log" }]);
	} finally {
		other.close();
		rmSync(home, { recursive: true });
	}
});

test("an open database in the default directory refuses the start before the directory moves", () => {
	const { home, data } = formerInstall(".casebook");
	const other = new Db(join(data, "casebook.db"));
	try {
		expect(() => adoptFormerInstall(config({ HOME: home }), { HOME: home })).toThrow(
			`${join(data, "casebook.db")} is open in another process; stop it, then start again`,
		);
		expect(readdirSync(home)).toEqual([".casebook"]);
		expect(existsSync(join(data, "casebook.db"))).toBe(true);
	} finally {
		other.close();
		rmSync(home, { recursive: true });
	}
});

test("where both names exist, the new one is used and the former one is reported, not touched", () => {
	const { home } = formerInstall(".casebook");
	try {
		new Db(databasePath(join(home, ".mainworthy"))).close();
		expect(adoptFormerInstall(config({ HOME: home }), { HOME: home })).toEqual([
			`${join(home, ".casebook")} is still there and is not read; ${join(home, ".mainworthy")} is in use`,
		]);
		expect(existsSync(join(home, ".casebook", "casebook.db"))).toBe(true);
	} finally {
		rmSync(home, { recursive: true });
	}
});

test("an install that never had the former name is left alone", () => {
	const home = mkdtempSync(join(tmpdir(), "mainworthy-former-"));
	try {
		expect(adoptFormerInstall(config({ HOME: home }), { HOME: home })).toEqual([]);
		expect(readdirSync(home)).toEqual([]);
	} finally {
		rmSync(home, { recursive: true });
	}
});
