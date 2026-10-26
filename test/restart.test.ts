// A real server process, killed for real in the middle of a report, and started again on the same data.
// What must hold (commitment C5): a report that was accepted is never lost and never applied twice, and the gate
// does not show a verdict from before the report while it is half applied.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Envelope } from "../src/core/api.ts";
import type { CommandFate, GateStatus, ReportReceipt } from "../src/core/ops.ts";

const ENTRY = resolve(import.meta.dir, "../src/cli/main.ts");

import { type TestDatabase, testDatabase } from "./db.ts";

const databases = new Map<string, TestDatabase>();
async function databaseFor(dir: string): Promise<string> {
	let db = databases.get(dir);
	if (!db) {
		db = await testDatabase();
		databases.set(dir, db);
	}
	return db.url;
}
const dirs: string[] = [];
const children: ReturnType<typeof Bun.spawn>[] = [];
afterEach(async () => {
	for (const child of children.splice(0)) {
		child.kill("SIGKILL");
		await child.exited;
	}
	for (const db of databases.values()) await db.close();
	databases.clear();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function serve(dataDir: string, holdAcceptance = false) {
	let entry = ENTRY;
	if (holdAcceptance) {
		entry = join(dataDir, "held-server.ts");
		writeFileSync(
			entry,
			`
import { start } from ${JSON.stringify(resolve(import.meta.dir, "../src/app/start.ts"))};
import { defaultConfig } from ${JSON.stringify(resolve(import.meta.dir, "../src/server/kernel/app.ts"))};
import { reportOp } from ${JSON.stringify(resolve(import.meta.dir, "../src/server/ops/writes.ts"))};
const steps = reportOp.steps;
reportOp.steps = async function* (ctx, input) {
 const running = steps(ctx, input);
 const accepted = await running.next();
 if (accepted.done) return accepted.value;
 yield accepted.value;
 console.log("accepted-and-held");
 for (;;) yield;
};
const instance = await start(defaultConfig(process.env), () => ({ ui: null }));
console.log(instance.url);
`,
		);
	}
	const child = Bun.spawn([process.execPath, entry, "serve"], {
		env: {
			PATH: process.env.PATH ?? "",
			MAINWORTHY_DATABASE_URL: await databaseFor(dataDir),
			HOME: dataDir,
			USER: "robin",
			MAINWORTHY_DATA: dataDir,
			MAINWORTHY_PORT: "0",
			MAINWORTHY_MODE: "local",
		},
		stdout: "pipe",
		stderr: "ignore",
		stdin: "ignore",
	});
	children.push(child);
	const reader = child.stdout.getReader();
	const decoder = new TextDecoder();
	let printed = "";
	for (;;) {
		const url = /http:\/\/127\.0\.0\.1:\d+/.exec(printed)?.[0];
		if (url) {
			reader.releaseLock();
			const accepted = async () => {
				const reader = child.stdout.getReader();
				try {
					let state = printed;
					while (!state.includes("accepted-and-held")) {
						const chunk = await reader.read();
						if (chunk.done) throw new Error("server ended before accepting report");
						state += decoder.decode(chunk.value, { stream: true });
					}
				} finally {
					reader.releaseLock();
				}
			};
			return { url, child, accepted };
		}
		const chunk = await reader.read();
		if (chunk.done) throw new Error(`the server stopped before it printed its address: ${printed}`);
		printed += decoder.decode(chunk.value, { stream: true });
	}
}

test("an invalid public address is refused before waiting for another server's data directory", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "mainworthy-lock-config-"));
	dirs.push(dataDir);
	const first = await serve(dataDir);
	const refused = Bun.spawn([process.execPath, ENTRY, "serve"], {
		env: {
			PATH: process.env.PATH ?? "",
			MAINWORTHY_DATABASE_URL: await databaseFor(dataDir),
			MAINWORTHY_DATA: dataDir,
			MAINWORTHY_PORT: "0",
			MAINWORTHY_OWNER: "robin",
			MAINWORTHY_MODE: "local",
			MAINWORTHY_PUBLIC_URL: "http://192.0.2.1:7357",
		},
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
	});
	children.push(refused);
	const [code, stdout, stderr] = await Promise.all([
		refused.exited,
		new Response(refused.stdout).text(),
		new Response(refused.stderr).text(),
	]);
	expect(code).toBe(4);
	expect(stdout).toBe("");
	expect(stderr).toContain("MAINWORTHY_PUBLIC_URL is not an address this instance can use for passkeys");
	expect(stderr).not.toContain("waiting for another server");
	expect((await fetch(`${first.url}/health`)).status).toBe(200);
});

async function send<T>(url: string, op: string, input: unknown): Promise<Envelope<T>> {
	const response = await fetch(`${url}/api/p/scratch/${op}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: typeof input === "string" ? input : JSON.stringify(input),
	});
	return (await response.json()) as Envelope<T>;
}

async function call<T>(url: string, op: string, input: unknown): Promise<T> {
	const reply = await send<T>(url, op, input);
	if (!reply.ok) throw new Error(`${op}: ${JSON.stringify(reply.error)}`);
	return reply.result;
}

test("a report accepted when the server is killed is applied in full when it starts again, and only once", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "mainworthy-restart-"));
	dirs.push(dataDir);
	const total = 40_000;
	const failing = total / 100;
	const report = JSON.stringify({
		cmd: "upload-0001",
		target: { commit: "c0ffee1234", branch: "main" },
		job: "unit",
		results: Array.from({ length: total }, (_, i) => ({
			test: { key: `suite/f${i % 400}.spec.ts::t${i}`, file: `suite/f${i % 400}.spec.ts` },
			outcome: i % 100 === 0 ? "fail" : "pass",
			...(i % 100 === 0 ? { failure: { message: "expected 1 to equal 2" } } : {}),
		})),
	});

	const first = await serve(dataDir, true);
	const upload = call<ReportReceipt>(first.url, "report", report).catch(() => null);
	await first.accepted();
	expect(await call<GateStatus>(first.url, "gate", { commit: "c0ffee1234" })).toMatchObject({
		verdict: "pending",
		reason: "pending: 1 report accepted and not yet applied",
	});
	first.child.kill("SIGKILL");
	await first.child.exited;
	expect(await upload).toBeNull();

	const second = await serve(dataDir);
	let recovered = await call<CommandFate>(second.url, "command", { cmd: "upload-0001" });
	while (recovered.state === "begun") {
		const waiting = await call<GateStatus>(second.url, "gate", { commit: "c0ffee1234" });
		expect(["pending", "blocked"]).toContain(waiting.verdict);
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
		recovered = await call<CommandFate>(second.url, "command", { cmd: "upload-0001" });
	}
	expect(recovered).toMatchObject({ state: "done", op: "report" });
	const gate = await call<GateStatus>(second.url, "gate", { commit: "c0ffee1234" });
	// Every result is there, none twice.
	expect(gate.verdict).toBe("blocked");
	expect(gate.tally).toMatchObject({ pass: total - failing, unexplained: failing, missing: 0 });
	// The id it was sent under names that report, although the server died before it could answer: other content
	// under the same id is refused, not recorded as a second report.
	const other = await fetch(`${second.url}/api/p/scratch/report`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			cmd: "upload-0001",
			target: { commit: "c0ffee1234", branch: "main" },
			job: "unit",
			results: [{ test: { key: "another" }, outcome: "fail", failure: { message: "not the same request" } }],
		}),
	});
	expect((await other.json()) as Envelope<unknown>).toMatchObject({ ok: false, error: { code: "conflict" } });
	expect((await call<GateStatus>(second.url, "gate", { commit: "c0ffee1234" })).tally).toEqual(gate.tally);
	// Recovery finished the command the dead process never answered: its reply is the receipt of the applied report.
	const fate = await call<CommandFate>(second.url, "command", { cmd: "upload-0001" });
	expect(fate).toMatchObject({ state: "done", op: "report", reply: { fresh: true, counts: { total, fail: failing } } });
	// The pipeline's retry of the same report under the same id gets that saved reply and adds nothing: no new
	// sequence number, no second report.
	const retried = await send<ReportReceipt>(second.url, "report", report);
	if (!retried.ok || fate.state !== "done") throw new Error("the retry was refused");
	expect(retried.result).toEqual(fate.reply as ReportReceipt);
	expect(retried.seq).toBe(fate.seq);
	const after = await send<GateStatus>(second.url, "gate", { commit: "c0ffee1234" });
	if (!after.ok) throw new Error("the gate was refused");
	expect(after.seq).toBe(fate.seq);
	expect(after.result.tally).toEqual(gate.tally);
}, 120_000);
