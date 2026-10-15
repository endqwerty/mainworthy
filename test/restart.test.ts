// A real server process, killed for real in the middle of a report, and started again on the same data.
// What must hold (commitment C5): a report that was accepted is never lost and never applied twice, and the gate
// does not show a verdict from before the report while it is half applied.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Envelope } from "../src/core/api.ts";
import type { GateStatus, ReportReceipt } from "../src/core/ops.ts";
import { defaultConfig } from "../src/server/kernel/app.ts";
import { start } from "../src/server/start.ts";

const ENTRY = resolve(import.meta.dir, "../src/cli/main.ts");
const dirs: string[] = [];
const children: ReturnType<typeof Bun.spawn>[] = [];
afterEach(async () => {
	for (const child of children.splice(0)) {
		child.kill("SIGKILL");
		await child.exited;
	}
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function serve(dataDir: string): Promise<{ url: string; child: ReturnType<typeof Bun.spawn> }> {
	const child = Bun.spawn([process.execPath, ENTRY, "serve"], {
		env: {
			PATH: process.env.PATH ?? "",
			HOME: dataDir,
			USER: "robin",
			MAINWORTHY_DATA: dataDir,
			MAINWORTHY_PORT: "0",
			MAINWORTHY_MODE: "local",
			MAINWORTHY_READERS: "2",
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
			return { url, child };
		}
		const chunk = await reader.read();
		if (chunk.done) throw new Error(`the server stopped before it printed its address: ${printed}`);
		printed += decoder.decode(chunk.value, { stream: true });
	}
}

test("another server process is refused and a killed server leaves no stale lock", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "mainworthy-lock-process-"));
	dirs.push(dataDir);
	const first = await serve(dataDir);
	const started = performance.now();
	const duplicate = Bun.spawn([process.execPath, ENTRY, "serve"], {
		env: {
			PATH: process.env.PATH ?? "",
			MAINWORTHY_DATA: dataDir,
			MAINWORTHY_PORT: "0",
			MAINWORTHY_OWNER: "robin",
			MAINWORTHY_MODE: "local",
			MAINWORTHY_READERS: "0",
			MAINWORTHY_LOCK_WAIT_SECONDS: "0.15",
		},
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
	});
	children.push(duplicate);
	const [code, stderr] = await Promise.all([duplicate.exited, new Response(duplicate.stderr).text()]);
	expect(code).toBe(4);
	expect(performance.now() - started).toBeGreaterThanOrEqual(150);
	expect(stderr.split("waiting for another server on the data directory")).toHaveLength(2);
	expect(stderr).toContain("another server is already using this data directory");
	expect((await fetch(`${first.url}/healthz`)).status).toBe(200);
	first.child.kill("SIGKILL");
	await first.child.exited;
	const restarted = await serve(dataDir);
	expect((await fetch(`${restarted.url}/healthz`)).status).toBe(200);
});

test("an invalid public address is refused before waiting for another server's data directory", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "mainworthy-lock-config-"));
	dirs.push(dataDir);
	const first = await serve(dataDir);
	const refused = Bun.spawn([process.execPath, ENTRY, "serve"], {
		env: {
			PATH: process.env.PATH ?? "",
			MAINWORTHY_DATA: dataDir,
			MAINWORTHY_PORT: "0",
			MAINWORTHY_OWNER: "robin",
			MAINWORTHY_MODE: "local",
			MAINWORTHY_READERS: "0",
			MAINWORTHY_PUBLIC_URL: "http://192.0.2.1:7357",
			MAINWORTHY_LOCK_WAIT_SECONDS: "0.15",
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
	expect((await fetch(`${first.url}/healthz`)).status).toBe(200);
});

test("a replacement server waits for a stopping server to release the data directory", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "mainworthy-lock-handoff-"));
	dirs.push(dataDir);
	const first = start(
		defaultConfig({ MAINWORTHY_DATA: dataDir, MAINWORTHY_PORT: "0", MAINWORTHY_OWNER: "robin" }),
		() => ({ ui: null }),
		{ readers: 0 },
	);
	let release = () => {};
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	const held = first.app.gate.run(() => pending);
	const stopping = first.stop();
	const replacement = Bun.spawn([process.execPath, ENTRY, "serve"], {
		env: {
			PATH: process.env.PATH ?? "",
			MAINWORTHY_DATA: dataDir,
			MAINWORTHY_PORT: "0",
			MAINWORTHY_OWNER: "robin",
			MAINWORTHY_MODE: "local",
			MAINWORTHY_READERS: "0",
			MAINWORTHY_LOCK_WAIT_SECONDS: "0.5",
		},
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
	});
	children.push(replacement);
	let stderr = "";
	try {
		const reader = replacement.stderr.getReader();
		try {
			while (!stderr.includes("waiting for another server on the data directory")) {
				const chunk = await reader.read();
				if (chunk.done) break;
				stderr += new TextDecoder().decode(chunk.value);
			}
		} finally {
			reader.releaseLock();
		}
		expect(stderr).toContain("waiting for another server on the data directory");
	} finally {
		release();
		await held;
		await stopping;
	}
	const reader = replacement.stdout.getReader();
	let stdout = "";
	let url: string | undefined;
	try {
		while (!url) {
			const chunk = await reader.read();
			if (chunk.done) throw new Error(`replacement failed: ${stdout} ${stderr}`);
			stdout += new TextDecoder().decode(chunk.value);
			url = /http:\/\/127\.0\.0\.1:\d+/.exec(stdout)?.[0];
		}
	} finally {
		reader.releaseLock();
	}
	expect((await fetch(`${url}/healthz`)).status).toBe(200);
	replacement.kill("SIGTERM");
	expect(await replacement.exited).toBe(0);
	for await (const chunk of replacement.stderr) stderr += new TextDecoder().decode(chunk);
	expect(stderr.split("waiting for another server on the data directory")).toHaveLength(2);
});

async function call<T>(url: string, op: string, input: unknown): Promise<T> {
	const response = await fetch(`${url}/api/p/scratch/${op}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: typeof input === "string" ? input : JSON.stringify(input),
	});
	const reply = (await response.json()) as Envelope<T>;
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

	const first = await serve(dataDir);
	const upload = call<ReportReceipt>(first.url, "report", report).catch(() => null);
	// The moment the gate says the report is in and not yet applied, the process is killed.
	let seen: GateStatus | null = null;
	for (let i = 0; i < 5000 && !seen; i++) {
		const gate = await call<GateStatus>(first.url, "gate", { commit: "c0ffee1234" });
		if (gate.reason.includes("accepted and not yet applied")) seen = gate;
		else await Bun.sleep(2);
	}
	expect(seen).toMatchObject({ verdict: "pending" });
	first.child.kill("SIGKILL");
	await first.child.exited;
	expect(await upload).toBeNull();

	const second = await serve(dataDir);
	let gate = await call<GateStatus>(second.url, "gate", { commit: "c0ffee1234" });
	for (let i = 0; i < 600 && gate.verdict === "pending"; i++) {
		await Bun.sleep(50);
		gate = await call<GateStatus>(second.url, "gate", { commit: "c0ffee1234" });
	}
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
	// The pipeline's retry of the same report is recognised and adds nothing.
	const retried = await call<ReportReceipt>(second.url, "report", report);
	expect(retried).toMatchObject({ fresh: false, counts: { total, fail: failing } });
	expect((await call<GateStatus>(second.url, "gate", { commit: "c0ffee1234" })).tally).toEqual(gate.tally);
}, 120_000);
