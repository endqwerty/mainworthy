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
import { Envelope, type Measurement, type Sample, type Summary, summarise } from "./measure.ts";
import { prepareRecentChanges, readRequests } from "./workloads.ts";

type Interval = { start: number; end: number; ms: number };
type ReadSample = Sample & Interval & { name: string; duringIngest: boolean };
export type MixedReport = {
	measurements: Measurement[];
	readsPerSecond: number;
	completedReads: number;
	seconds: number;
	longestReadDuringIngest: number;
	longestReadOp: string;
	ingestTransactions: Summary & { rows: number };
	acceptTransactions: Summary;
	control: Summary & { readsPerSecond: number; seconds: number; longestRead: number };
	byOperation: { name: string; control: Summary; mixed: Summary }[];
	validationMs: number;
	readBytes: number;
	requestBytes: number;
	loadStart: number[];
	loadEnd: number[];
	windows: {
		seconds: number;
		reads: number;
		readP95: number;
		ingestCount: number;
		controlSeconds: number;
		controlP95: number;
		load: number[];
	}[];
	errors: string[];
};
type HttpResult = { result: unknown; bytes: number; finishedAt: number };

/** One persistent HTTP/1.1 client; the timestamp is complete response bytes, before JSON and correctness checks. */
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
					const finishedAt = performance.now();
					try {
						const text = parts.join("");
						const envelope = Envelope.parse(JSON.parse(text));
						if (!envelope.ok)
							throw new Error(`HTTP ${res.statusCode}: ${envelope.error.code}: ${envelope.error.message}`);
						ensure(res.statusCode === 200, `HTTP ${res.statusCode} was not successful`);
						resolve({ result: envelope.result, bytes: Buffer.byteLength(text), finishedAt });
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
	budget: number | null,
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
		pass: summary.errors === 0 && (budget === null || summary[criterion] < budget),
		checked: summary.n - summary.errors,
		correctness,
		samples,
		warmupErrors: [],
		errorMessages: samples.flatMap((sample) => (sample.error === null ? [] : [sample.error])),
	};
}

/** Sixteen keep-alive HTTP readers with a readers-only control, then ingest and save writers on the real server. */
export async function mixedLoad(
	dataset: Dataset,
	options: { milliseconds: number; repeats: number; log?: (message: string) => void },
): Promise<MixedReport> {
	const log = options.log ?? console.log;
	const reads: ReadSample[] = [],
		control: ReadSample[] = [],
		ingests: Sample[] = [],
		saves: Sample[] = [],
		transactions: Sample[] = [],
		accepts: Sample[] = [];
	const windows: MixedReport["windows"] = [],
		errors: string[] = [];
	let seconds = 0,
		controlSeconds = 0,
		readBytes = 0,
		requestBytes = 0,
		validationMs = 0;
	const loadStart = loadavg();
	for (let round = 0; round < options.repeats; round++) {
		log(
			`HTTP window ${round + 1}/${options.repeats}: readers-only control 5 s, then 16 readers + ingest + save ${options.milliseconds / 1_000} s`,
		);
		const dir = join(dataset.dir, `http-${randomUUID()}`);
		const clone = openDataset(dataset, dir);
		try {
			prepareRecentChanges(clone);
		} catch (error) {
			clone.close();
			throw error;
		}
		clone.app.close();
		const server = start(config(dir), () => ({ ui: null }));
		const agents = Array.from({ length: 18 }, () => new Agent({ keepAlive: true, maxSockets: 1 }));
		const originalBegin = server.app.db.begin.bind(server.app.db),
			originalCommit = server.app.db.commit.bind(server.app.db);
		let unsubscribe = () => {};
		try {
			const ci = ciActor(server.app);
			const instance: DatasetInstance = {
				...clone,
				app: server.app,
				owner: server.owner,
				ci: ci.actor,
				ciSecret: ci.secret,
			};
			const ingestAgent = itemAt(agents, 16),
				saveAgent = itemAt(agents, 17);
			const writeWindows: Interval[] = [],
				serverIngests: Interval[] = [],
				serverAccepts: Interval[] = [];
			let transactionStart = 0;
			let lastTransaction: Interval = { start: 0, end: 0, ms: 0 };
			server.app.db.begin = () => {
				transactionStart = performance.now();
				originalBegin();
			};
			server.app.db.commit = () => {
				originalCommit();
				const end = performance.now();
				lastTransaction = { start: transactionStart, end, ms: end - transactionStart };
			};
			unsubscribe = server.app.subscribe((event) => {
				if (event.op !== "report") return;
				const batch = z
					.object({ state: z.enum(["accepted", "processed"]) })
					.parse(server.app.db.raw.query("SELECT state FROM batches ORDER BY id DESC LIMIT 1").get());
				(batch.state === "accepted" ? serverAccepts : serverIngests).push(lastTransaction);
			});
			const stamp = itemAt(dataset.metadata.cases, dataset.metadata.cases.length - 1);
			let version = stamp.version,
				saveSerial = 0,
				ingestSerial = 0;
			const save = async (): Promise<number> => {
				const pre = `Customer account setup during mixed authoring ${++saveSerial}.`;
				const reply = await post(
					saveAgent,
					server.url,
					"propose",
					JSON.stringify({ edits: [{ op: "edit", case: stamp.ref, base: version, body: { pre } }] }),
				);
				const proposal = Proposal.parse(reply.result),
					adopted = itemAt(proposal.cases, 0);
				ensure(
					proposal.status === "adopted" && proposal.proposal !== null && adopted.version === version + 1,
					"HTTP save must adopt a new version",
				);
				version = adopted.version;
				return reply.finishedAt;
			};
			for (let client = 0; client < 16; client++) {
				const read = readRequests(instance, client);
				read.check((await post(itemAt(agents, client), server.url, read.op, JSON.stringify(read.input))).result);
			}
			verifyReport(
				server.app,
				Receipt.parse(
					(
						await post(
							ingestAgent,
							server.url,
							"report",
							JSON.stringify(ingestInput(dataset.metadata, `mixed-warm-${round}`)),
							ci.secret,
						)
					).result,
				),
				10_000,
			);
			await save();
			const readFor = async (milliseconds: number, target: ReadSample[]): Promise<number> => {
				const start = performance.now(),
					deadline = start + milliseconds;
				await Promise.all(
					Array.from({ length: 16 }, (_, client) =>
						(async () => {
							let index = client;
							do {
								const read = readRequests(instance, index++),
									body = JSON.stringify(read.input),
									started = performance.now();
								let error: string | null = null,
									end = started;
								try {
									const reply = await post(itemAt(agents, client), server.url, read.op, body);
									end = reply.finishedAt;
									readBytes += reply.bytes;
									requestBytes += Buffer.byteLength(body);
									const checkStart = performance.now();
									read.check(reply.result);
									validationMs += performance.now() - checkStart;
								} catch (cause) {
									end = performance.now();
									error = cause instanceof Error ? cause.message : String(cause);
									errors.push(error);
								}
								target.push({
									start: started,
									end,
									ms: end - started,
									name: read.name,
									duringIngest: false,
									round,
									error,
								});
							} while (performance.now() < deadline);
						})(),
					),
				);
				return (performance.now() - start) / 1_000;
			};
			const firstControl = control.length;
			const controlElapsed = await readFor(5_000, control);
			controlSeconds += controlElapsed;
			serverIngests.length = 0;
			serverAccepts.length = 0;
			const start = performance.now(),
				deadline = start + options.milliseconds;
			const firstRead = reads.length,
				firstIngest = ingests.length;
			const runAttempt = async (samples: Sample[], work: () => Promise<number>): Promise<void> => {
				const started = performance.now();
				let error: string | null = null,
					end = started;
				try {
					end = await work();
				} catch (cause) {
					end = performance.now();
					error = cause instanceof Error ? cause.message : String(cause);
					errors.push(error);
				}
				samples.push({ ms: end - started, round, error });
			};
			const reading = readFor(options.milliseconds, reads);
			const ingesting = (async () => {
				do {
					const body = JSON.stringify(ingestInput(dataset.metadata, `mixed-${round}-${++ingestSerial}`));
					await runAttempt(ingests, async () => {
						const started = performance.now(),
							reply = await post(ingestAgent, server.url, "report", body, ci.secret);
						writeWindows.push({ start: started, end: reply.finishedAt, ms: reply.finishedAt - started });
						requestBytes += Buffer.byteLength(body);
						verifyReport(server.app, Receipt.parse(reply.result), 10_000);
						return reply.finishedAt;
					});
				} while (performance.now() < deadline);
			})();
			const saving = (async () => {
				do {
					await runAttempt(saves, save);
				} while (performance.now() < deadline);
			})();
			await Promise.all([reading, ingesting, saving]);
			const elapsed = (performance.now() - start) / 1_000;
			seconds += elapsed;
			for (const read of reads.slice(firstRead))
				read.duringIngest = writeWindows.some((write) => write.start < read.end && write.end > read.start);
			transactions.push(...serverIngests.map((txn) => ({ ms: txn.ms, error: null, round })));
			accepts.push(...serverAccepts.map((txn) => ({ ms: txn.ms, error: null, round })));
			const summary = summarise(reads.slice(firstRead)),
				controlSummary = summarise(control.slice(firstControl));
			windows.push({
				seconds: elapsed,
				reads: reads.length - firstRead,
				readP95: summary.p95,
				ingestCount: ingests.length - firstIngest,
				controlSeconds: controlElapsed,
				controlP95: controlSummary.p95,
				load: loadavg(),
			});
			const saved = itemAt(
				z
					.array(CaseView)
					.parse((await post(saveAgent, server.url, "get", JSON.stringify({ refs: [stamp.ref] }))).result),
				0,
			);
			ensure(
				saved.version === version && saved.pre === `Customer account setup during mixed authoring ${saveSerial}.`,
				"mixed saved content must persist",
			);
			log(
				`  control p95 ${controlSummary.p95.toFixed(2)} ms; mix p95 ${summary.p95.toFixed(2)} ms, ${((reads.length - firstRead) / elapsed).toFixed(1)} reads/s, ${ingests.length - firstIngest} ingests`,
			);
		} finally {
			unsubscribe();
			server.app.db.begin = originalBegin;
			server.app.db.commit = originalCommit;
			for (const agent of agents) agent.destroy();
			await server.app.gate.run(() => undefined);
			await server.stop();
			rmSync(dir, { recursive: true, force: true });
		}
	}
	const stalled = reads.filter((read) => read.duringIngest).sort((a, b) => b.ms - a.ms)[0],
		controlSummary = summarise(control);
	return {
		measurements: [
			measured("control HTTP reads", null, control, "Same sixteen clients and read mix, with no writers."),
			measured(
				"mixed HTTP reads",
				BUDGETS.mixed,
				reads,
				"Every response and read checked; timings stop at complete bytes before assertions.",
			),
			measured(
				"mixed HTTP ingest",
				BUDGETS.ingest,
				ingests,
				"Every report fresh and all 10k results persisted; acceptance plus apply is stricter than C7 acceptance alone.",
				"max",
			),
			measured("mixed HTTP save", BUDGETS.save, saves, "Every save adopts a new version; final content read back."),
		],
		readsPerSecond: reads.length / seconds,
		completedReads: reads.length,
		seconds,
		longestReadDuringIngest: stalled?.ms ?? 0,
		longestReadOp: stalled?.name ?? "none",
		ingestTransactions: { ...summarise(transactions), rows: 10_000 },
		acceptTransactions: summarise(accepts),
		control: {
			...controlSummary,
			readsPerSecond: control.length / controlSeconds,
			seconds: controlSeconds,
			longestRead: controlSummary.max,
		},
		byOperation: Array.from(new Set(reads.map((read) => read.name)), (name) => ({
			name,
			control: summarise(control.filter((read) => read.name === name)),
			mixed: summarise(reads.filter((read) => read.name === name)),
		})),
		validationMs,
		readBytes,
		requestBytes,
		loadStart,
		loadEnd: loadavg(),
		windows,
		errors,
	};
}
