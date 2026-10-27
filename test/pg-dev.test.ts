import { expect, test } from "bun:test";
import { devDatabaseRefusal } from "../scripts/pg.ts";
import { defaultConfig } from "../src/server/kernel/app.ts";

test("bun run dev serves the disposable checkout cluster exactly when the server would start in local mode", () => {
	const hosts = [undefined, "127.0.0.1", "localhost", "::1", "[::1]", "127.0.0.2", "0:0:0:0:0:0:0:1", "", "0.0.0.0"];
	const modes = [undefined, "local", "server", "other"];
	for (const MAINWORTHY_HOST of hosts)
		for (const MAINWORTHY_MODE of modes) {
			const env = { MAINWORTHY_HOST, MAINWORTHY_MODE };
			const local = defaultConfig(env).mode === "local";
			expect({ env, refused: devDatabaseRefusal(env) !== null }).toEqual({ env, refused: !local });
		}
	expect(devDatabaseRefusal({ MAINWORTHY_MODE: "server" })).toContain("MAINWORTHY_DATABASE_URL");
	expect(
		devDatabaseRefusal({ MAINWORTHY_MODE: "server", MAINWORTHY_DATABASE_URL: "postgres://db.example/mw" }),
	).toBeNull();
});
