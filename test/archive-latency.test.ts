import { expect, test } from "bun:test";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import { withInstance } from "../src/cli/test-support.ts";
import { ciReport } from "./helpers.ts";

async function whilePolling(url: string, transfer: () => Promise<void>): Promise<number> {
	const worker = new Worker(new URL("./archive-poll.ts", import.meta.url), { workerData: { url } });
	try {
		await new Promise<void>((resolve, reject) => {
			worker.once("message", () => resolve());
			worker.once("error", reject);
		});
		const result = new Promise<unknown>((resolve, reject) => {
			worker.once("message", resolve);
			worker.once("error", reject);
		});
		try {
			await transfer();
		} finally {
			worker.postMessage("stop");
		}
		const samples = z.object({ longest: z.number(), samples: z.number(), errors: z.number() }).parse(await result);
		expect(samples.errors).toBe(0);
		expect(samples.samples).toBeGreaterThan(1);
		return samples.longest;
	} finally {
		await worker.terminate();
	}
}

const LIMIT_MS = 50;

/**
 * A transfer that runs on the HTTP thread holds every request for the whole transfer, every time: 264 ms for an export
 * and 3.4 s for an import of these rows (issue #65). A runner can also stop the thread for a moment by itself: once,
 * an import waited 182 ms where 30 is the most otherwise seen (issue #745). So a wait over the limit is judged on a
 * second run of the same transfer.
 */
async function judged(run: () => Promise<number>): Promise<number> {
	const first = await run();
	if (first < LIMIT_MS) return first;
	console.log(`longest /healthz wait ${first.toFixed(1)} ms; the transfer runs again`);
	return run();
}

test("HTTP archives leave the server answering other requests", async () => {
	await withInstance(async (source) => {
		await source.client.call("report", ciReport({ commit: "archive-latency", n: 1 }));
		const db = source.instance.app.db;
		// One real report supplies all references. Duplicate its result, without building a large request body.
		const columns = db.raw
			.query<{ name: string }, []>("PRAGMA table_info(results)")
			.all()
			.map((row) => row.name);
		db.transaction(() =>
			db.raw.exec(`
			WITH RECURSIVE n(i) AS (SELECT 2 UNION ALL SELECT i+1 FROM n WHERE i < 20000)
			INSERT INTO results SELECT ${columns.map((column) => (column === "id" ? "n.i" : `r."${column}"`)).join(",")}
			FROM results r CROSS JOIN n WHERE r.id = 1
		`),
		);
		let archive: Blob = new Blob();
		const exported = await judged(() =>
			whilePolling(source.instance.url, async () => {
				const response = await source.client.request("/api/export");
				expect(response.status).toBe(200);
				archive = await response.blob();
			}),
		);
		// An import needs an instance with nothing in it, so each run of it has its own.
		const imported = await judged(() =>
			withInstance(async (target) => {
				const longest = await whilePolling(target.instance.url, async () => {
					const response = await target.client.request("/api/import", { method: "POST", body: archive });
					expect(response.status).toBe(200);
					expect(await response.json()).toMatchObject({ ok: true, result: { tables: { results: 20_000 } } });
				});
				expect(target.instance.app.reader.raw.query("SELECT count(*) AS n FROM results").get()).toEqual({ n: 20_000 });
				return longest;
			}),
		);
		console.log(
			`20,000 results: longest /healthz wait export ${exported.toFixed(1)} ms, import ${imported.toFixed(1)} ms; 0 request failures`,
		);
		expect(exported).toBeLessThan(LIMIT_MS);
		expect(imported).toBeLessThan(LIMIT_MS);
	});
}, 30_000);
