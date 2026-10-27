import { expect, test } from "bun:test";
import { devDatabaseRefusal } from "../scripts/pg.ts";

test("bun run dev keeps the disposable checkout cluster to loopback local mode", () => {
	expect(devDatabaseRefusal({})).toBeNull();
	expect(devDatabaseRefusal({ MAINWORTHY_HOST: "127.0.0.1" })).toBeNull();
	expect(devDatabaseRefusal({ MAINWORTHY_HOST: "::1" })).toBeNull();
	expect(devDatabaseRefusal({ MAINWORTHY_HOST: "localhost", MAINWORTHY_MODE: "local" })).toBeNull();
	for (const env of [{ MAINWORTHY_MODE: "server" }, { MAINWORTHY_HOST: "0.0.0.0" }, { MAINWORTHY_HOST: "192.0.2.10" }])
		expect(devDatabaseRefusal(env)).toContain("MAINWORTHY_DATABASE_URL");
	expect(
		devDatabaseRefusal({ MAINWORTHY_MODE: "server", MAINWORTHY_DATABASE_URL: "postgres://db.example/mw" }),
	).toBeNull();
});
