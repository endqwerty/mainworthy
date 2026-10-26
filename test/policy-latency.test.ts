import { expect, test } from "bun:test";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import { budget } from "../scripts/budget.ts";
import { withInstance } from "../src/cli/test-support.ts";
import { sql } from "../src/server/kernel/db.ts";
import { seedPolicyChanges } from "./policy-fixture.ts";

const CHANGE_RUNS = 6000;
const LIMIT_MS = 750;

async function adoptWhilePolling(): Promise<number> {
	return await withInstance(async ({ instance, client }) => {
		await client.call("admin", { do: "project.create", key: "policy-latency", preset: "standard", unlinked: "ask" });
		const project = client.with({ project: "policy-latency" });
		await seedPolicyChanges(instance, CHANGE_RUNS);
		const proposal = await project.call("propose", { edits: [{ op: "policy", preset: "loose" }] });
		expect(proposal.status).toBe("open");
		if (!proposal.question) throw new Error("policy proposal has no question");
		const [question] = await project.call("get", { refs: [proposal.question] });
		const evidence = z.object({ evidenceHash: z.string() }).parse(question);
		const worker = new Worker(new URL("./archive-poll.ts", import.meta.url), { workerData: { url: instance.url } });
		try {
			await new Promise<void>((resolve, reject) => {
				worker.once("message", () => resolve());
				worker.once("error", reject);
			});
			const polled = new Promise<unknown>((resolve, reject) => {
				worker.once("message", resolve);
				worker.once("error", reject);
			});
			const states = new Set<string>();
			const snapshot = async () => {
				const state = await instance.app.database.read(
					async (db) =>
						await db.get(
							sql<readonly [], { version: number; open: number }>(
								"SELECT (SELECT max(version) FROM policies WHERE project = (SELECT id FROM projects WHERE key = 'policy-latency')) version, (SELECT count(*) FROM questions WHERE project = (SELECT id FROM projects WHERE key = 'policy-latency') AND kind = 'map' AND state = 'open') open",
							),
						),
				);
				states.add(JSON.stringify(state));
			};
			await snapshot();
			const polling: Promise<void>[] = [];
			const watching = setInterval(() => {
				polling.push(snapshot());
			}, 5);
			try {
				expect(
					await project.call("decide", {
						q: proposal.question,
						onEvidence: evidence.evidenceHash,
						answer: { is: "accept" },
						reason: "Adopt the loose policy",
					}),
				).toMatchObject([{ status: "decided" }]);
			} finally {
				clearInterval(watching);
				await Promise.all(polling);
				worker.postMessage("stop");
			}
			await snapshot();
			expect([...states].map((state) => JSON.parse(state))).toEqual([
				{ version: 1, open: 1 },
				{ version: 2, open: 0 },
			]);
			const samples = z.object({ longest: z.number(), samples: z.number(), errors: z.number() }).parse(await polled);
			expect(samples.errors).toBe(0);
			expect(samples.samples).toBeGreaterThan(1);
			expect(await client.call("admin", { do: "policy.show", project: "policy-latency" })).toMatchObject({
				version: 2,
				preset: "loose",
			});
			expect(await project.call("gate", { change: `pr:${CHANGE_RUNS}` })).toMatchObject({
				verdict: "blocked",
				tally: { pass: 9, unexplained: 1 },
			});
			return samples.longest;
		} finally {
			await worker.terminate();
		}
	});
}

test("HTTP policy adoption across change runs leaves health requests answering", async () => {
	const longest = await adoptWhilePolling();
	console.log(`Policy adoption across ${CHANGE_RUNS} changes: longest /health wait ${longest.toFixed(1)} ms`);
	budget(`policy adoption across ${CHANGE_RUNS} changes: longest /health wait`, longest, LIMIT_MS, "ms");
}, 180_000);
