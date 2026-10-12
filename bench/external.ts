/**
 * Mixed load against a server in another process: sixteen readers, one client sending 10,000-result reports back
 * to back, one client saving a case. The load generator shares nothing with the server but the loopback socket,
 * so the numbers are the server's own (run.ts keeps its clients in the server's process, which is right for the
 * budget tests and inflates read latency under load).
 *
 * usage: bun bench/external.ts <dataset directory> [seconds=20] [reader threads=4]
 * The dataset directory is one `bun bench/run.ts` leaves under `.casebook/bench/` (it holds `casebook.db`).
 */
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";

const [source, secondsText = "20", readersText = "4"] = Bun.argv.slice(2);
if (!source) throw new Error("usage: bun bench/external.ts <dataset directory> [seconds] [reader threads]");
const seconds = Number(secondsText);
const dir = mkdtempSync(join(resolve(".casebook", "bench"), "external-"));
cpSync(join(source, "casebook.db"), join(dir, "casebook.db"));
const port = 7430 + Math.floor(Math.random() * 20);
const server = Bun.spawn([process.execPath, "src/cli/main.ts", "serve"], {
	env: {
		...process.env,
		CASEBOOK_DATA: dir,
		CASEBOOK_PORT: String(port),
		CASEBOOK_MODE: "local",
		CASEBOOK_READERS: readersText,
	},
	stdout: "ignore",
	stderr: "inherit",
});
const base = `http://127.0.0.1:${port}`;
const Reply = z.object({ ok: z.boolean(), result: z.unknown().optional(), error: z.unknown().optional() });

let errors = 0;
async function post(op: string, body: string): Promise<{ ms: number; result: unknown }> {
	const started = performance.now();
	const response = await fetch(`${base}/api/p/benchmark/${op}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body,
	});
	const reply = Reply.parse(await response.json());
	const ms = performance.now() - started;
	if (!response.ok || !reply.ok) {
		errors++;
		throw new Error(`${op}: ${JSON.stringify(reply.error)}`);
	}
	return { ms, result: reply.result };
}
const call = (op: string, input: unknown) => post(op, JSON.stringify(input));
const quantile = (values: number[], p: number): number => {
	const sorted = [...values].sort((a, b) => a - b);
	return Number((sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0).toFixed(1));
};

try {
	for (let i = 0; i < 200; i++) {
		try {
			if ((await fetch(`${base}/healthz`)).ok) break;
		} catch {}
		await Bun.sleep(100);
	}
	const folders = z
		.object({ items: z.array(z.object({ id: z.number(), cases: z.number() })) })
		.parse((await call("find", { in: "folders" })).result)
		.items.filter((folder) => folder.cases > 0)
		.map((folder) => folder.id);
	const run =
		z
			.object({ items: z.array(z.object({ ref: z.string() })) })
			.parse((await call("find", { in: "runs", limit: 1 })).result).items[0]?.ref ?? "R-1";
	const words = ["coupon", "checkout total", "password", "ship"];
	type Samples = Record<"case" | "folder" | "history" | "gate" | "queue" | "search", number[]>;
	const empty = (): Samples => ({ case: [], folder: [], history: [], gate: [], queue: [], search: [] });
	let until = 0;
	const reader = async (seed: number, into: Samples): Promise<void> => {
		let i = seed * 1000;
		while (performance.now() < until) {
			i++;
			const kind = i % 6;
			if (kind === 0) into.case.push((await call("get", { refs: [`C-${1 + ((i * 7919) % 100000)}`] })).ms);
			else if (kind === 1)
				into.folder.push((await call("find", { folder: folders[i % folders.length], limit: 50 })).ms);
			else if (kind === 2) into.history.push((await call("get", { refs: [`T-${1 + ((i * 104729) % 20000)}`] })).ms);
			else if (kind === 3) into.gate.push((await call("gate", { run })).ms);
			else if (kind === 4) into.queue.push((await call("inbox", { limit: 50 })).ms);
			else into.search.push((await call("find", { text: words[i % words.length], limit: 20 })).ms);
		}
	};

	// Warm the caches, then five seconds of readers alone as the control.
	until = performance.now() + 2000;
	await Promise.all(Array.from({ length: 16 }, (_, seed) => reader(seed, empty())));
	const control = empty();
	until = performance.now() + 5000;
	await Promise.all(Array.from({ length: 16 }, (_, seed) => reader(seed, control)));

	const reads = empty();
	const ingests: number[] = [];
	const saves: number[] = [];
	until = performance.now() + seconds * 1000;
	const ingester = async (): Promise<void> => {
		for (let batch = 1; performance.now() < until; batch++) {
			const commit = `ext${Date.now().toString(16)}${batch}`.padEnd(14, "0");
			const results = Array.from({ length: 10_000 }, (_, i) => ({
				test: { key: `mix/f${i % 200}.spec.ts::t${i}`, file: `mix/f${i % 200}.spec.ts` },
				outcome: i % 50 === 0 ? "fail" : "pass",
				...(i % 50 === 0 ? { failure: { message: `expected ${i % 20} to equal 7` } } : {}),
			}));
			const receipt = await post(
				"report",
				JSON.stringify({ target: { commit, branch: "main", repo: "a/b" }, job: "mix", results }),
			);
			const applied = z.object({ fresh: z.boolean(), counts: z.object({ total: z.number() }) }).parse(receipt.result);
			if (!applied.fresh || applied.counts.total !== 10_000) throw new Error("a report was not applied in full");
			ingests.push(receipt.ms);
		}
	};
	const saver = async (): Promise<void> => {
		const Head = z.array(z.object({ version: z.number() }));
		let head = Head.parse((await call("get", { refs: ["C-7"], fields: ["title"] })).result)[0]?.version ?? 1;
		for (let i = 0; performance.now() < until; i++) {
			const saved = await call("propose", {
				edits: [{ op: "edit", case: "C-7", base: head, body: { title: `mixed ${Date.now()} ${i}` } }],
			});
			const reply = z
				.object({ status: z.string(), cases: z.array(z.object({ version: z.number() })) })
				.parse(saved.result);
			if (reply.status !== "adopted") throw new Error("a save was not adopted");
			head = reply.cases[0]?.version ?? head;
			saves.push(saved.ms);
			await Bun.sleep(200);
		}
	};
	await Promise.all([...Array.from({ length: 16 }, (_, seed) => reader(seed, reads)), ingester(), saver()]);

	const all = Object.values(reads).flat();
	const alone = Object.values(control).flat();
	console.log(
		JSON.stringify(
			{
				readerThreads: Number(readersText),
				readersOnly: { p50: quantile(alone, 0.5), p95: quantile(alone, 0.95), perSecond: Math.round(alone.length / 5) },
				mixedReads: {
					p50: quantile(all, 0.5),
					p95: quantile(all, 0.95),
					p99: quantile(all, 0.99),
					max: quantile(all, 1),
					perSecond: Math.round(all.length / seconds),
				},
				p95ByRead: Object.fromEntries(Object.entries(reads).map(([name, values]) => [name, quantile(values, 0.95)])),
				reports: { n: ingests.length, p50: quantile(ingests, 0.5), max: quantile(ingests, 1) },
				saves: { n: saves.length, p50: quantile(saves, 0.5), p95: quantile(saves, 0.95), max: quantile(saves, 1) },
				errors,
			},
			null,
			1,
		),
	);
} finally {
	server.kill("SIGTERM");
	await server.exited;
	rmSync(dir, { recursive: true, force: true });
}
