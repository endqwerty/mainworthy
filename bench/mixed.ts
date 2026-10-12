import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { Agent, request } from "node:http";
import { loadavg } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { start } from "../src/server/start.ts";
import { BUDGETS, CaseView, ensure, itemAt, Proposal, Receipt } from "./contracts.ts";
import {
	ciActor,
	config,
	type Dataset,
	type DatasetInstance,
	ingestInput,
	openDataset,
	verifyReport,
} from "./dataset.ts";
import { Envelope, type Measurement, type Sample, summarise } from "./measure.ts";
import { readRequests } from "./workloads.ts";

type Interval = { start: number; end: number; ms: number };
type ReadSample = Sample & Interval & { op: string; duringIngest: boolean };
export type MixedReport = {
	measurements: Measurement[];
	readsPerSecond: number;
	completedReads: number;
	seconds: number;
	longestReadDuringIngest: number;
	longestReadOp: string;
	ingestTransactions: { rows: number; p50: number; p95: number; max: number; count: number };
	acceptTransactions: { p50: number; p95: number; max: number; count: number };
	readBytes: number;
	requestBytes: number;
	loadStart: number[];
	loadEnd: number[];
	windows: { seconds: number; reads: number; readP95: number; ingestCount: number; load: number[] }[];
	errors: string[];
};

type HttpResult = { result: unknown; bytes: number };

/** Each client owns one persistent HTTP/1.1 connection; errors and unsuccessful replies are never fast successes. */
export function post(agent: Agent, url: string, op: string, body: string, secret?: string): Promise<HttpResult> {
	return new Promise((resolve, reject) => {
		const req = request(
			`${url}/api/p/benchmark/${op}`,
			{
				agent,
				method: "POST",
				headers: {
					"content-type": "application/json",
					"content-length": String(Buffer.byteLength(body)),
					...(secret ? { authorization: `Bearer ${secret}` } : {}),
				},
			},
			(res) => {
				res.setEncoding("utf8");
				const parts: string[] = [];
				res.on("data", (chunk: unknown) => {
					if (typeof chunk === "string") parts.push(chunk);
				});
				res.on("error", reject);
				res.on("end", () => {
					try {
						const text = parts.join("");
						const envelope = Envelope.parse(JSON.parse(text));
						if (!envelope.ok)
							throw new Error(`HTTP ${res.statusCode}: ${envelope.error.code}: ${envelope.error.message}`);
						ensure(res.statusCode === 200, `HTTP ${res.statusCode} was not successful`);
						resolve({ result: envelope.result, bytes: Buffer.byteLength(text) });
					} catch (error) {
						reject(error);
					}
				});
			},
		);
		req.on("error", reject);
		req.setTimeout(30_000, () => req.destroy(new Error("HTTP benchmark request timed out")));
		req.end(body);
	});
}

function measured(
	name: string,
	budget: number,
	samples: Sample[],
	correctness: string,
	criterion: "p95" | "max" = "p95",
): Measurement {
	const summary = summarise(samples);
	return {
		...summary,
		name,
		budget,
		criterion,
		pass: summary.errors === 0 && summary[criterion] < budget,
		checked: summary.n - summary.errors,
		correctness,
		samples,
		warmupErrors: [],
		errorMessages: samples.flatMap((sample) => (sample.error === null ? [] : [sample.error])),
	};
}

/** Measures sixteen real HTTP readers with an ingest client and a save client, using fresh clones for repeated windows. */
export async function mixedLoad(
	dataset: Dataset,
	options: { milliseconds: number; repeats: number; log?: (message: string) => void },
): Promise<MixedReport> {
	const log = options.log ?? console.log;
	const reads: ReadSample[] = [];
	const ingests: Sample[] = [];
	const saves: Sample[] = [];
	const transactions: Sample[] = [];
	const accepts: Sample[] = [];
	const windows: MixedReport["windows"] = [];
	const errors: string[] = [];
	let seconds = 0;
	let readBytes = 0;
	let requestBytes = 0;
	const loadStart = loadavg();
	for (let round = 0; round < options.repeats; round++) {
		log(
			`Mixed HTTP window ${round + 1}/${options.repeats}: 16 readers + ingest + save, ${options.milliseconds / 1_000} s`,
		);
		const dir = join(dataset.dir, `http-${randomUUID()}`);
		const clone = openDataset(dataset, dir);
		clone.app.close();
		const server = start(config(dir), () => ({ ui: null }));
		const ci = ciActor(server.app);
		const instance: DatasetInstance = {
			...clone,
			app: server.app,
			owner: server.owner,
			ci: ci.actor,
			ciSecret: ci.secret,
		};
		const agents = Array.from({ length: 18 }, () => new Agent({ keepAlive: true, maxSockets: 1 }));
		const ingestAgent = itemAt(agents, 16);
		const saveAgent = itemAt(agents, 17);
		const writeWindows: Interval[] = [];
		const serverIngests: Interval[] = [];
		const serverAccepts: Interval[] = [];
		let lastTransaction: Interval = { start: 0, end: 0, ms: 0 };
		let transactionStart = 0;
		const originalBegin = server.app.db.begin.bind(server.app.db);
		const originalCommit = server.app.db.commit.bind(server.app.db);
		server.app.db.begin = () => {
			transactionStart = performance.now();
			originalBegin();
		};
		server.app.db.commit = () => {
			originalCommit();
			const end = performance.now();
			lastTransaction = { start: transactionStart, end, ms: end - transactionStart };
		};
		const unsubscribe = server.app.subscribe((event) => {
			if (event.op !== "report") return;
			const batch = z
				.object({ state: z.enum(["accepted", "processed"]) })
				.parse(server.app.db.raw.query("SELECT state FROM batches ORDER BY id DESC LIMIT 1").get());
			if (batch.state === "accepted") serverAccepts.push(lastTransaction);
			else serverIngests.push(lastTransaction);
		});
		const stamp = itemAt(dataset.metadata.cases, dataset.metadata.cases.length - 1);
		let version = stamp.version;
		let saveSerial = 0;
		let ingestSerial = 0;
		const save = async (): Promise<void> => {
			const pre = `Customer setup during mixed authoring ${++saveSerial}.`;
			const reply = await post(
				saveAgent,
				server.url,
				"propose",
				JSON.stringify({ edits: [{ op: "edit", case: stamp.ref, base: version, body: { pre } }] }),
			);
			const proposal = Proposal.parse(reply.result);
			const adopted = itemAt(proposal.cases, 0);
			ensure(
				proposal.status === "adopted" && proposal.proposal !== null && adopted.version === version + 1,
				"HTTP save must adopt a new version",
			);
			version = adopted.version;
		};
		try {
			for (let client = 0; client < 16; client++) {
				const read = readRequests(instance, client);
				read.check((await post(itemAt(agents, client), server.url, read.op, JSON.stringify(read.input))).result);
			}
			const warmInput = ingestInput(dataset.metadata, `mixed-warm-${round}`);
			verifyReport(
				server.app,
				Receipt.parse((await post(ingestAgent, server.url, "report", JSON.stringify(warmInput), ci.secret)).result),
				10_000,
			);
			await save();
			serverIngests.length = 0;
			serverAccepts.length = 0;
			const start = performance.now();
			const deadline = start + options.milliseconds;
			const firstRead = reads.length;
			const firstIngest = ingests.length;
			const runAttempt = async (samples: Sample[], work: () => Promise<void>): Promise<void> => {
				const started = performance.now();
				let error: string | null = null;
				try {
					await work();
				} catch (cause) {
					error = cause instanceof Error ? cause.message : String(cause);
					errors.push(error);
				}
				samples.push({ ms: performance.now() - started, round, error });
			};
			const reading = Array.from({ length: 16 }, (_, client) =>
				(async () => {
					let index = client;
					const agent = itemAt(agents, client);
					do {
						const read = readRequests(instance, index++);
						const body = JSON.stringify(read.input);
						const started = performance.now();
						let error: string | null = null;
						try {
							const reply = await post(agent, server.url, read.op, body);
							readBytes += reply.bytes;
							requestBytes += Buffer.byteLength(body);
							read.check(reply.result);
						} catch (cause) {
							error = cause instanceof Error ? cause.message : String(cause);
							errors.push(error);
						}
						const end = performance.now();
						reads.push({ start: started, end, ms: end - started, op: read.op, duringIngest: false, round, error });
					} while (performance.now() < deadline);
				})(),
			);
			const ingesting = (async () => {
				do {
					const input = ingestInput(dataset.metadata, `mixed-${round}-${++ingestSerial}`);
					const body = JSON.stringify(input);
					await runAttempt(ingests, async () => {
						const started = performance.now();
						const reply = await post(ingestAgent, server.url, "report", body, ci.secret);
						const end = performance.now();
						writeWindows.push({ start: started, end, ms: end - started });
						requestBytes += Buffer.byteLength(body);
						verifyReport(server.app, Receipt.parse(reply.result), 10_000);
					});
				} while (performance.now() < deadline);
			})();
			const saving = (async () => {
				do {
					await runAttempt(saves, save);
				} while (performance.now() < deadline);
			})();
			await Promise.all([...reading, ingesting, saving]);
			const elapsed = (performance.now() - start) / 1_000;
			seconds += elapsed;
			for (const read of reads.slice(firstRead))
				read.duringIngest = writeWindows.some((write) => write.start < read.end && write.end > read.start);
			transactions.push(...serverIngests.map((txn) => ({ ms: txn.ms, error: null, round })));
			accepts.push(...serverAccepts.map((txn) => ({ ms: txn.ms, error: null, round })));
			const roundReads = reads.slice(firstRead);
			const summary = summarise(roundReads);
			windows.push({
				seconds: elapsed,
				reads: roundReads.length,
				readP95: summary.p95,
				ingestCount: ingests.length - firstIngest,
				load: loadavg(),
			});
			// The final save must be readable, not merely acknowledged over HTTP.
			const saved = itemAt(
				z
					.array(CaseView)
					.parse((await post(saveAgent, server.url, "get", JSON.stringify({ refs: [stamp.ref] }))).result),
				0,
			);
			ensure(
				saved.version === version && saved.pre === `Customer setup during mixed authoring ${saveSerial}.`,
				"mixed saved content must persist",
			);
			log(
				`  ${roundReads.length} reads, ${(roundReads.length / elapsed).toFixed(1)} reads/s, read p95 ${summary.p95.toFixed(2)} ms, ${ingests.length - firstIngest} ingests`,
			);
		} finally {
			unsubscribe();
			server.app.db.begin = originalBegin;
			server.app.db.commit = originalCommit;
			for (const agent of agents) agent.destroy();
			await server.stop();
			rmSync(dir, { recursive: true, force: true });
		}
	}
	const stalled = reads.filter((read) => read.duringIngest).sort((a, b) => b.ms - a.ms)[0];
	const transactionSummary = summarise(transactions);
	const acceptSummary = summarise(accepts);
	return {
		measurements: [
			measured(
				"mixed HTTP reads",
				BUDGETS.mixed,
				reads,
				"Every HTTP status/envelope and read result checked; 16 keep-alive clients completed real reads during two writers.",
			),
			measured(
				"mixed HTTP ingest",
				BUDGETS.ingest,
				ingests,
				"Every HTTP report fresh, successful, and all 10,000 results persisted.",
				"max",
			),
			measured(
				"mixed HTTP save",
				BUDGETS.save,
				saves,
				"Every HTTP save adopted a new version; final saved document read back.",
			),
		],
		readsPerSecond: reads.length / seconds,
		completedReads: reads.length,
		seconds,
		longestReadDuringIngest: stalled?.ms ?? 0,
		longestReadOp: stalled?.op ?? "none",
		ingestTransactions: {
			rows: 10_000,
			p50: transactionSummary.p50,
			p95: transactionSummary.p95,
			max: transactionSummary.max,
			count: transactionSummary.n,
		},
		acceptTransactions: {
			p50: acceptSummary.p50,
			p95: acceptSummary.p95,
			max: acceptSummary.max,
			count: acceptSummary.n,
		},
		readBytes,
		requestBytes,
		loadStart,
		loadEnd: loadavg(),
		windows,
		errors,
	};
}
