import { expect, test } from "bun:test";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import { budget } from "../scripts/budget.ts";
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

test("HTTP archives leave the server answering other requests", async () => {
	await withInstance(async (source) => {
		await source.client.call("report", ciReport({ commit: "archive-latency", n: 1 }));
		await source.instance.app.database.write((db) =>
			db.transaction(async () => {
				const columns =
					(await db.catalog()).find((table) => table.name === "results")?.columns.map((column) => column.name) ?? [];
				await db.runDynamic(
					`INSERT INTO results (${columns.map((column) => `"${column}"`).join(",")}) SELECT ${columns.map((column) => (column === "id" ? "n.i" : `r."${column}"`)).join(",")} FROM results r CROSS JOIN generate_series(2, 20000) n(i) WHERE r.id = 1`,
				);
			}),
		);
		let archive: Blob = new Blob();
		const exported = await whilePolling(source.instance.url, async () => {
			const response = await source.client.request("/api/export");
			expect(response.status).toBe(200);
			archive = await response.blob();
		});
		const imported = await withInstance(async (target) => {
			const longest = await whilePolling(target.instance.url, async () => {
				const response = await target.client.request("/api/import", { method: "POST", body: archive });
				expect(response.status).toBe(200);
				expect(await response.json()).toMatchObject({ ok: true, result: { tables: { results: 20_000 } } });
			});
			expect(
				(
					await target.instance.app.database.read((db) =>
						db.allDynamic<Record<string, unknown>>("SELECT count(*) AS n FROM results", []),
					)
				)[0] ?? null,
			).toEqual({ n: 20_000 });
			return longest;
		});

		console.log(
			`20,000 results: longest /healthz wait export ${exported.toFixed(1)} ms, import ${imported.toFixed(1)} ms; 0 request failures`,
		);
		budget("archive export: longest /healthz wait", exported, LIMIT_MS, "ms");
		budget("archive import: longest /healthz wait", imported, LIMIT_MS, "ms");
	});
}, 30_000);
