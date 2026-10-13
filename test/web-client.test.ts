// What the web client knows of the server without importing it (`src/web` imports only `src/core`, which
// `test/architecture.test.ts` holds): which operations are the instance's, and so where each one is sent. The
// list is in the core, and here it is compared with the registry, so the two cannot drift apart unnoticed.
import { expect, test } from "bun:test";
import { INSTANCE_OPS } from "../src/core/api.ts";
import { OP_LIST } from "../src/server/ops/index.ts";
import { call } from "../src/web/lib/api.ts";

test("the client's list of instance operations is the registry's, so each is sent to the path that serves it", () => {
	const registered: string[] = OP_LIST.filter((op) => op.scope === "instance").map((op) => op.name);
	expect<string[]>([...INSTANCE_OPS].sort()).toEqual(registered.sort());
});

test("call sends an instance operation to /api/<op> and a project's operation to /api/p/<project>/<op>", async () => {
	// A listener that answers with the path it was asked for, in the envelope an operation replies with.
	const echo = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (req) => Response.json({ ok: true, result: new URL(req.url).pathname, seq: null }),
	});
	try {
		const options = { url: `http://127.0.0.1:${echo.port}`, project: "web", token: "not-read-by-the-echo" };
		expect<unknown>(await call("session", { do: "list" }, options)).toBe("/api/session");
		expect<unknown>(await call("credential", { do: "list" }, options)).toBe("/api/credential");
		expect<unknown>(await call("invitation", { do: "list" }, options)).toBe("/api/invitation");
		expect<unknown>(await call("admin", { do: "token.list" }, options)).toBe("/api/admin");
		expect<unknown>(await call("inbox", {}, options)).toBe("/api/p/web/inbox");
	} finally {
		await echo.stop(true);
	}
});
