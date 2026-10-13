/**
 * Mixed load against a server in another process: sixteen readers, one client sending 10,000-result reports back
 * to back, one client saving a case. The load generator shares nothing with the server but the loopback socket,
 * so the numbers are the server's own. `run.ts` uses this for its under-load rows.
 *
 * usage: bun bench/external.ts <dataset directory> [seconds=20] [reader threads=default]
 * The dataset directory is one `bun bench/run.ts` leaves under `.mainworthy/bench/` (it holds `mainworthy.db`).
 */
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";

export type UnderLoad = {
	readerThreads: number | null;
	seconds: number;
	/** Readers alone for five seconds, after a warm-up. */
	control: number[];
	reads: Record<"case" | "folder" | "history" | "gate" | "queue" | "search", number[]>;
	reports: number[];
	saves: number[];
	errors: number;
};

const Reply = z.object({ ok: z.boolean(), result: z.unknown().optional(), error: z.unknown().optional() });

/** One window of load against a fresh copy of the dataset, served by `mainworthy serve` in its own process. */
export async function underLoad(options: {
	dataset: string;
	seconds: number;
	/** Reader threads; null leaves the server's default. */
	readers: number | null;
}): Promise<UnderLoad> {
	const seconds = options.seconds;
	const dir = mkdtempSync(join(resolve(".mainworthy", "bench"), "external-"));
	cpSync(join(options.dataset, "mainworthy.db"), join(dir, "mainworthy.db"));
	const port = 7430 + Math.floor(Math.random() * 20);
	const server = Bun.spawn([process.execPath, "src/cli/main.ts", "serve"], {
		env: {
			...process.env,
			MAINWORTHY_DATA: dir,
			MAINWORTHY_PORT: String(port),
			MAINWORTHY_MODE: "local",
			...(options.readers === null ? {} : { MAINWORTHY_READERS: String(options.readers) }),
		},
		stdout: "ignore",
		stderr: "inherit",
	});
	const base = `http://127.0.0.1:${port}`;
	let errors = 0;
	const post = async (op: string, body: string): Promise<{ ms: number; result: unknown }> => {
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
	};
	const call = (op: string, input: unknown) => post(op, JSON.stringify(input));
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
		// The size of this dataset: how many cases, and the number of the newest test.
		const caseCount = z.object({ count: z.number() }).parse((await call("find", { limit: 1 })).result).count;
		const newestTest = z
			.object({ items: z.array(z.object({ ref: z.string() })) })
			.parse((await call("find", { in: "tests", limit: 1 })).result).items[0]?.ref;
		const testCount = Number(newestTest?.slice(2) ?? 1);
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
				if (kind === 0) into.case.push((await call("get", { refs: [`C-${1 + ((i * 7919) % caseCount)}`] })).ms);
				else if (kind === 1)
					into.folder.push((await call("find", { folder: folders[i % folders.length], limit: 50 })).ms);
				else if (kind === 2)
					into.history.push((await call("get", { refs: [`T-${1 + ((i * 104729) % testCount)}`] })).ms);
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

		return {
			readerThreads: options.readers,
			seconds,
			control: Object.values(control).flat(),
			reads,
			reports: ingests,
			saves,
			errors,
		};
	} finally {
		server.kill("SIGTERM");
		await server.exited;
		rmSync(dir, { recursive: true, force: true });
	}
}

export const quantile = (values: readonly number[], p: number): number => {
	const sorted = [...values].sort((a, b) => a - b);
	return Number((sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0).toFixed(1));
};

if (import.meta.main) {
	const [source, secondsText = "20", readersText] = Bun.argv.slice(2);
	if (!source) throw new Error("usage: bun bench/external.ts <dataset directory> [seconds] [reader threads]");
	const seconds = Number(secondsText);
	const load = await underLoad({
		dataset: source,
		seconds,
		readers: readersText === undefined ? null : Number(readersText),
	});
	const all = Object.values(load.reads).flat();
	console.log(
		JSON.stringify(
			{
				readerThreads: load.readerThreads ?? "default",
				readersOnly: {
					p50: quantile(load.control, 0.5),
					p95: quantile(load.control, 0.95),
					perSecond: Math.round(load.control.length / 5),
				},
				mixedReads: {
					p50: quantile(all, 0.5),
					p95: quantile(all, 0.95),
					p99: quantile(all, 0.99),
					max: quantile(all, 1),
					perSecond: Math.round(all.length / seconds),
				},
				p95ByRead: Object.fromEntries(
					Object.entries(load.reads).map(([name, values]) => [name, quantile(values, 0.95)]),
				),
				reports: { n: load.reports.length, p50: quantile(load.reports, 0.5), max: quantile(load.reports, 1) },
				saves: {
					n: load.saves.length,
					p50: quantile(load.saves, 0.5),
					p95: quantile(load.saves, 0.95),
					max: quantile(load.saves, 1),
				},
				errors: load.errors,
			},
			null,
			1,
		),
	);
}
