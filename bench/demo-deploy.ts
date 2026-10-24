// Rehearse #903 on clones of one populated fixture. Source-export the baseline before changing code.
// MAINWORTHY_READERS=1 bun bench/demo-deploy.ts <work.ts-scratch-dir> <baseline-source-dir> <baseline|new> <run>
// Alternate baseline/new at least five times. Data stays in scratch for inspection and work.ts cleanup.
import { copyFileSync, cpSync, existsSync, mkdirSync, statSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { Config } from "../src/server/kernel/app.ts";

const root = resolve(z.string().min(1).parse(Bun.argv[2]));
const baseline = resolve(z.string().min(1).parse(Bun.argv[3]));
const side = z.enum(["baseline", "new"]).parse(Bun.argv[4]);
const run = z.coerce.number().int().positive().parse(Bun.argv[5]);
const token = "synthetic-demo-bound-owner-token-903";
async function modules(source: string) {
	const startup: typeof import("../src/app/start.ts") = await import(join(source, "src/app/start.ts"));
	const demo: typeof import("../src/cli/demo.ts") = await import(join(source, "src/cli/demo.ts"));
	const seeding: typeof import("../src/cli/seed.ts") = await import(join(source, "src/cli/seed.ts"));
	const client: typeof import("../src/cli/client.ts") = await import(join(source, "src/cli/client.ts"));
	const database: typeof import("../src/server/kernel/db.ts") = await import(join(source, "src/server/kernel/db.ts"));
	return { ...startup, ...demo, ...seeding, ...client, ...database };
}
const config = (dataDir: string): Config => ({
	dataDir,
	host: "127.0.0.1",
	port: 0,
	mode: "server",
	owner: "benchmark-owner",
	ownerToken: token,
	commit: null,
	sessionIdleMs: 14 * 86_400_000,
	sessionMaxMs: 90 * 86_400_000,
	proxy: null,
});
const old = await modules(baseline);
const fixture = join(root, "fixture");
mkdirSync(root, { recursive: true, mode: 0o700 });
if (!existsSync(join(fixture, "mainworthy.db"))) {
	const initial = old.start(config(fixture), () => ({ ui: null }));
	try {
		const client = new old.Client({ url: initial.url, token, project: "populated" });
		for (const project of ["populated", "demo"])
			await old.seed(client, { project, cases: 2000, days: 14, unlinkedFiles: 60 });
	} finally {
		await initial.stop();
	}
	const db = new old.Db(join(fixture, "mainworthy.db"));
	try {
		// Append historical detail to real seed results, retaining actual project/test/batch/actor foreign keys.
		db.transaction(() =>
			db.exec(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<220000),
   sample AS(SELECT project,test,batch,target,actor FROM results WHERE project=(SELECT id FROM projects WHERE key='populated') LIMIT 1)
   INSERT INTO results(project,test,seq,ord,batch,target,method,actor,basis,outcome,at,detail)
   SELECT sample.project,sample.test,1,n.i,sample.batch,sample.target,'auto',sample.actor,'unresolved','pass',1,printf('%04096d',n.i) FROM n CROSS JOIN sample`),
		);
		db.checkpoint();
		if (db.raw.query("PRAGMA foreign_key_check").get()) throw new Error("fixture has invalid foreign keys");
	} finally {
		db.close();
	}
}
const fixtureBytes = statSync(join(fixture, "mainworthy.db")).size;
if (fixtureBytes < 880_000_000) throw new Error("fixture is smaller than the incident database");
console.log(JSON.stringify({ side, run, fixtureBytes, cores: cpus().length, load: loadavg() }));
const target = join(root, side);
mkdirSync(target, { recursive: true });
if (!existsSync(join(target, "mainworthy.db")))
	copyFileSync(join(fixture, "mainworthy.db"), join(target, "mainworthy.db"));
if (!existsSync(join(target, "blobs"))) cpSync(join(fixture, "blobs"), join(target, "blobs"), { recursive: true });
const m = await modules(side === "baseline" ? baseline : resolve("."));
const instance = m.start(config(target), () => ({ ui: null }));
instance.app.config.commit = run.toString(16).padStart(40, "0");
const client = new m.Client({ url: instance.url, token, project: "scratch" });
const retained = () =>
	instance.app.db.raw
		.query(
			"SELECT count(*) AS n,sum(id) AS ids FROM results WHERE project=(SELECT id FROM projects WHERE key='populated')",
		)
		.get();
// Warm the ordinary request paths equally on both sides before attributing a delay to demo work.
const warming = performance.now();
await client.call("find", { limit: 1 });
await client.call("propose", { edits: [{ op: "create", body: { title: `Warm-up ${side} ${run}` } }] });
const login = await fetch(`${instance.url}/api/login`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ token }),
});
if (
	login.status !== 200 ||
	!z.object({ ok: z.boolean() }).parse(await login.json()).ok ||
	!login.headers.getSetCookie().length
)
	throw new Error("warm-up login failed");
console.log(JSON.stringify({ side, run, warmupMs: performance.now() - warming }));
const before = retained();
const holds: { phase: string; op: string | null; ms: number }[] = [];
const swaps: number[] = [];
const slices: number[] = [];
const probes: { kind: string; ms: number }[] = [];
const errors: string[] = [];
let phase = "seed";
let operation: string | null = null;
let writes = 0;
instance.app.subscribe((event) => {
	operation = event.op;
});
const gate = instance.app.gate.run.bind(instance.app.gate);
instance.app.gate.run = <T>(fn: () => T | Promise<T>) =>
	gate(async () => {
		const began = performance.now();
		operation = null;
		try {
			return await fn();
		} finally {
			holds.push({ phase, op: operation, ms: performance.now() - began });
		}
	});
const timed = async (kind: string, fn: () => Promise<void>) => {
	const began = performance.now();
	try {
		await fn();
	} catch (error) {
		errors.push(`${kind}: ${String(error)}`);
	}
	probes.push({ kind, ms: performance.now() - began });
};
async function foreground(work: Promise<unknown>) {
	let finished = false;
	void work.then(
		() => {
			finished = true;
		},
		() => {
			finished = true;
		},
	);
	while (!finished) {
		await Promise.all([
			timed("read", async () => {
				await client.call("find", { limit: 1 });
			}),
			timed("write", async () => {
				const reply = await client.call("propose", {
					edits: [{ op: "create", body: { title: `Bound probe ${side} ${run} ${writes}` } }],
				});
				if (reply.status !== "adopted") throw new Error("write was not adopted");
				writes++;
			}),
			timed("sign-in", async () => {
				const response = await fetch(`${instance.url}/api/login`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ token }),
				});
				const body = z.object({ ok: z.boolean() }).parse(await response.json());
				if (response.status !== 200 || !body.ok || response.headers.getSetCookie().length === 0)
					throw new Error(`sign-in failed: ${response.status}`);
			}),
		]);
		await Bun.sleep(20);
	}
	return await work;
}
try {
	const began = performance.now();
	const refreshing = m.refreshDemo(instance, "demo", undefined, { held: (_kind, ms) => swaps.push(ms) });
	await foreground(refreshing);
	const result = await refreshing;
	if (side === "new") {
		phase = "drain";
		await foreground(
			m.drainRetiredDemos(instance, {
				onSlice: (slice) => {
					slices.push(slice.ms);
				},
			}),
		);
	}
	const totalMs = performance.now() - began;
	const summary = ["read", "write", "sign-in"].map((kind) => {
		const times = probes
			.filter((p) => p.kind === kind)
			.map((p) => p.ms)
			.sort((a, b) => a - b);
		return { kind, count: times.length, min: times[0], median: times[Math.floor(times.length / 2)], max: times.at(-1) };
	});
	const retired = instance.app.db.raw.query("SELECT count(*) AS n FROM projects WHERE key LIKE '~demo-%'").get();
	const violations = instance.app.db.raw.query("PRAGMA foreign_key_check").all();
	const unchanged = JSON.stringify(before) === JSON.stringify(retained());
	console.log(
		JSON.stringify({
			side,
			run,
			totalMs,
			cases: result.cases.length,
			summary,
			errors,
			maxGateMs: Math.max(0, ...holds.map((h) => h.ms)),
			maxSwapMs: Math.max(0, ...swaps),
			maxSliceMs: Math.max(0, ...slices),
			slices: slices.length,
			retired,
			retainedUnchanged: unchanged,
			foreignKeyViolations: violations.length,
			slowest: [...holds].sort((a, b) => b.ms - a.ms).slice(0, 12),
		}),
	);
	if (errors.length || result.cases.length !== 2000 || !unchanged || violations.length)
		throw new Error("incorrect rehearsal output");
	if (
		side === "new" &&
		(probes.some((p) => p.ms > 500) || swaps.some((ms) => ms > 500) || slices.some((ms) => ms > 500))
	)
		throw new Error("500 ms acceptance bound exceeded");
} finally {
	instance.app.gate.run = gate;
	await instance.stop();
}
