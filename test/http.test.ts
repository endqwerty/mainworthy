// The HTTP surface on a real listener: who gets in, in each mode, and that every operation is there.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Envelope, SessionInfo } from "../src/core/api.ts";
import type { Config } from "../src/server/kernel/app.ts";
import { OP_LIST } from "../src/server/ops/index.ts";
import { type Instance, start } from "../src/server/start.ts";

const dirs: string[] = [];
const running: Instance[] = [];
afterEach(async () => {
	for (const instance of running.splice(0)) await instance.stop();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function boot(mode: Config["mode"], ownerToken: string | null = null): Instance {
	const dataDir = mkdtempSync(join(tmpdir(), "casebook-http-"));
	dirs.push(dataDir);
	const instance = start({ dataDir, host: "127.0.0.1", port: 0, mode, owner: "daniel", ownerToken }, () => ({
		ui: null,
	}));
	running.push(instance);
	return instance;
}

async function post<T>(
	instance: Instance,
	path: string,
	body: unknown,
	headers: Record<string, string> = {},
): Promise<{ status: number; body: Envelope<T>; cookie: string | null }> {
	const response = await fetch(`${instance.url}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
	return {
		status: response.status,
		body: (await response.json()) as Envelope<T>,
		cookie: response.headers.get("set-cookie"),
	};
}
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe("local mode", () => {
	test("the browser on this machine is the owner with no step, and a first project exists", async () => {
		const instance = boot("local");
		const session = (await (await fetch(`${instance.url}/api/session`)).json()) as Envelope<SessionInfo>;
		expect(session.ok && session.result).toMatchObject({ actor: "daniel", kind: "human", mode: "local", via: "local" });
		expect(session.ok && session.result.projects.map((p) => p.key)).toEqual(["scratch"]);
		const created = await post(instance, "/api/p/scratch/propose", {
			edits: [{ op: "create", outline: "First case" }],
		});
		expect(created.body).toMatchObject({ ok: true, result: { status: "adopted" }, seq: 2 });
	});

	test("a page on another site cannot act as the owner: a foreign Origin or Host is refused", async () => {
		const instance = boot("local");
		const body = { edits: [{ op: "create", outline: "Planted" }] };
		expect((await post(instance, "/api/p/scratch/propose", body, { origin: "http://evil.example" })).status).toBe(401);
		expect((await post(instance, "/api/p/scratch/propose", body, { origin: "null" })).status).toBe(401);
		expect((await post(instance, "/api/p/scratch/propose", body, { host: "evil.example" })).status).toBe(401);
		const found = await post<{ items: unknown[] }>(instance, "/api/p/scratch/find", {});
		expect(found.body.ok && found.body.result.items).toEqual([]);
	});
});

describe("server mode", () => {
	test("nothing works without a token; the owner token signs in; a wrong one does not", async () => {
		const instance = boot("server", "owner-secret-0123456789");
		expect((await fetch(`${instance.url}/api/session`)).status).toBe(401);
		expect((await post(instance, "/api/p/scratch/find", {})).status).toBe(401);
		expect((await post(instance, "/api/p/scratch/find", {}, bearer("wrong-token-0123456789"))).status).toBe(401);
		expect((await post(instance, "/api/p/scratch/find", {}, bearer("owner-secret-0123456789"))).status).toBe(200);

		expect((await post(instance, "/api/login", { token: "wrong-token-0123456789" })).status).toBe(401);
		const login = await post(instance, "/api/login", { token: "owner-secret-0123456789" });
		expect(login.status).toBe(200);
		expect(login.cookie).toContain("HttpOnly");
		expect(login.cookie).toContain("SameSite=Strict");
		const cookie = (login.cookie ?? "").split(";")[0] ?? "";
		const session = (await (
			await fetch(`${instance.url}/api/session`, { headers: { cookie } })
		).json()) as Envelope<SessionInfo>;
		expect(session.ok && session.result).toMatchObject({ actor: "daniel", via: "cookie", mode: "server" });
		// the cookie does not travel with a request another site makes
		expect((await post(instance, "/api/p/scratch/find", {}, { cookie, origin: "http://evil.example" })).status).toBe(
			401,
		);
	});

	test("with no token configured, one is generated on first start and only then", async () => {
		const instance = boot("server");
		expect(instance.generatedToken).toMatch(/^cb_[0-9A-Za-z]{32}$/);
		expect((await post(instance, "/api/p/scratch/find", {}, bearer(instance.generatedToken ?? ""))).status).toBe(200);
	});

	test("a token carries its actor's capabilities and nothing more", async () => {
		const instance = boot("server", "owner-secret-0123456789");
		const owner = bearer("owner-secret-0123456789");
		await post(instance, "/api/admin", { do: "project.create", key: "other" }, owner);
		const made = await post<{ token: string }>(
			instance,
			"/api/admin",
			{ do: "token.create", actor: "github-actions", kind: "ci", can: ["read", "produce"], project: "scratch" },
			owner,
		);
		const ci = bearer(made.body.ok ? made.body.result.token : "");
		const report = {
			target: { commit: "abc1234", branch: "main" },
			results: [{ test: { key: "a::b" }, outcome: "pass" }],
		};
		expect((await post(instance, "/api/p/scratch/report", report, ci)).status).toBe(200);
		expect((await post(instance, "/api/p/other/report", report, ci)).body).toMatchObject({
			ok: false,
			error: { code: "forbidden" },
		});
		expect((await post(instance, "/api/p/scratch/plan", { name: "x", select: {} }, ci)).body).toMatchObject({
			ok: false,
			error: { code: "forbidden" },
		});
		expect((await post(instance, "/api/admin", { do: "token.list" }, ci)).body).toMatchObject({
			ok: false,
			error: { code: "forbidden" },
		});

		const listed = await post<{ id: number; actor: string }[]>(instance, "/api/admin", { do: "token.list" }, owner);
		const id = listed.body.ok ? listed.body.result.find((t) => t.actor === "github-actions")?.id : undefined;
		await post(instance, "/api/admin", { do: "token.revoke", id }, owner);
		expect((await post(instance, "/api/p/scratch/report", report, ci)).status).toBe(401);
	});
});

describe("the surface", () => {
	test("every operation in the registry is a route and is in the generated API description", async () => {
		const instance = boot("local");
		const api = (await (await fetch(`${instance.url}/api/openapi.json`)).json()) as {
			paths: Record<string, { post: { operationId: string; requestBody: unknown } }>;
		};
		expect(
			Object.values(api.paths)
				.map((path) => path.post.operationId)
				.sort(),
		).toEqual(OP_LIST.map((op) => op.name).sort());
		for (const op of OP_LIST) {
			const path = op.scope === "project" ? `/api/p/scratch/${op.name}` : `/api/${op.name}`;
			const reply = await post(instance, path, { definitely: "not valid input for anything", refs: 7 });
			expect([200, 400]).toContain(reply.status); // reached the operation: it ran or refused the input; never 404
		}
		expect((await post(instance, "/api/p/scratch/nope", {})).body).toMatchObject({
			ok: false,
			error: { code: "not_found" },
		});
		expect((await post(instance, "/api/p/missing/find", {})).body).toMatchObject({
			ok: false,
			error: { code: "not_found" },
		});
	});

	test("a body that is not JSON and an input that is not valid are refused with the field named", async () => {
		const instance = boot("local");
		const raw = await fetch(`${instance.url}/api/p/scratch/propose`, { method: "POST", body: "{not json" });
		expect(raw.status).toBe(400);
		const invalid = await post(instance, "/api/p/scratch/propose", { edits: [{ op: "edit", case: "C-1" }] });
		expect(invalid.body).toMatchObject({ ok: false, error: { code: "invalid" } });
		expect(invalid.body.ok === false && invalid.body.error.message).toContain("base");
	});

	test("a committed write is pushed on the project's change stream", async () => {
		const instance = boot("local");
		const response = await fetch(`${instance.url}/api/p/scratch/events`);
		const reader = response.body?.getReader();
		if (!reader) throw new Error("no stream");
		await post(instance, "/api/p/scratch/propose", { edits: [{ op: "create", outline: "Streamed" }] });
		const decoder = new TextDecoder();
		let text = "";
		while (!text.includes("data:")) {
			const { value, done } = await reader.read();
			if (done) break;
			text += decoder.decode(value);
		}
		await reader.cancel();
		const event = JSON.parse(text.slice(text.indexOf("data:") + 5).split("\n")[0] ?? "{}") as {
			op: string;
			touched: string[];
			seq: number;
		};
		expect(event).toMatchObject({ op: "propose", seq: 2 });
		expect(event.touched).toContain("C-1");
	});
});

describe("a large report on a live server", () => {
	test("C5 and E2: from the moment it is accepted the gate reads pending, reads are answered while it is applied, and no stale green is served", async () => {
		const instance = boot("local");
		const results = (n: number, failing: boolean) =>
			Array.from({ length: n }, (_, i) => ({
				test: { key: `tests/f${i % 40}.spec.ts::test ${i}`, file: `tests/f${i % 40}.spec.ts` },
				outcome: failing && i % 500 === 0 ? "fail" : "pass",
				...(failing && i % 500 === 0 ? { failure: { message: "expected 1, got 2" } } : {}),
			}));
		const target = { commit: "feedc0de1", branch: "main" };
		await post(instance, "/api/p/scratch/report", { target, results: results(4000, false) });
		const gate = async () => {
			const reply = await post<{ verdict: string; stale: boolean }>(instance, "/api/p/scratch/gate", {
				commit: "feedc0de1",
			});
			if (!reply.body.ok) throw new Error("the gate read failed during the report");
			return reply.body.result;
		};
		expect((await gate()).verdict).toBe("passed");

		// The same commit, attempt 2, now with failures: applied in slices on the server.
		const upload = post<{ gate: { verdict: string } }>(instance, "/api/p/scratch/report", {
			target,
			attempt: 2,
			results: results(4000, true),
		});
		const seen: string[] = [];
		let reads = 0;
		let done = false;
		void upload.then(() => {
			done = true;
		});
		while (!done) {
			seen.push((await gate()).verdict);
			reads++;
		}
		const receipt = await upload;
		expect(receipt.body.ok && receipt.body.result.gate.verdict).toBe("blocked");
		expect(reads).toBeGreaterThan(3); // reads were answered while the report was being applied
		const firstPending = seen.indexOf("pending");
		expect(firstPending).toBeGreaterThanOrEqual(0);
		// once the upload was accepted, the old green never came back
		expect(seen.slice(firstPending).includes("passed")).toBe(false);
		expect((await gate()).verdict).toBe("blocked");
	});

	test("writes that arrive during a large report wait their turn and all land", async () => {
		const instance = boot("local");
		const big = Array.from({ length: 6000 }, (_, i) => ({ test: { key: `tests/a.spec.ts::t${i}` }, outcome: "pass" }));
		const upload = post(instance, "/api/p/scratch/report", {
			target: { commit: "0123abcd9", branch: "main" },
			results: big,
		});
		const saves = Array.from({ length: 5 }, (_, i) =>
			post<{ status: string }>(instance, "/api/p/scratch/propose", {
				edits: [{ op: "create", outline: `Saved during ingest ${i}` }],
			}),
		);
		const [uploaded, ...saved] = await Promise.all([upload, ...saves]);
		expect(uploaded.body.ok).toBe(true);
		expect(saved.map((s) => s.body.ok && s.body.result.status)).toEqual(Array(5).fill("adopted"));
		const found = await post<{ count: number }>(instance, "/api/p/scratch/find", {});
		expect(found.body.ok && found.body.result.count).toBe(5);
		const seqs = [uploaded, ...saved].map((r) => (r.body.ok ? r.body.seq : null));
		expect(new Set(seqs).size).toBe(6); // every command has its own place on the clock
	});
});

describe("request size", () => {
	test("an operation body over the limit is refused without being held in memory; sign-in takes a few kilobytes at most", async () => {
		const instance = boot("server", "owner-secret-0123456789");
		const headers = { "content-type": "application/json", authorization: "Bearer owner-secret-0123456789" };
		// 65 MB with an honest Content-Length
		const big = new Uint8Array(65 * 1024 * 1024).fill(32);
		const declared = await fetch(`${instance.url}/api/p/scratch/find`, { method: "POST", headers, body: big });
		expect(declared.status).toBe(413);
		// the same size streamed with no Content-Length: counted while reading
		let sent = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (sent >= 65) return controller.close();
				sent++;
				controller.enqueue(new Uint8Array(1024 * 1024).fill(32));
			},
		});
		const streamed = await fetch(`${instance.url}/api/p/scratch/find`, { method: "POST", headers, body: stream }).then(
			(response) => response.status,
			() => 413, // the server may close the connection before the client finishes sending
		);
		expect(streamed).toBe(413);
		const login = await fetch(`${instance.url}/api/login`, {
			method: "POST",
			body: JSON.stringify({ token: "x".repeat(10_000) }),
		});
		expect(login.status).toBe(401);
		// an ordinary request still works afterwards
		expect(
			(await post(instance, "/api/p/scratch/find", {}, { authorization: "Bearer owner-secret-0123456789" })).status,
		).toBe(200);
	});
});
