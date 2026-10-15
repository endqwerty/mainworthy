/**
 * Mixed load against a server in another process: sixteen readers, one client sending 10,000-result reports back
 * to back (or one creating and adopting bulk edits), one client saving a case. The load generator shares nothing with the server but the loopback socket,
 * so the numbers are the server's own. `run.ts` uses this for its under-load rows.
 *
 * usage: bun bench/external.ts <dataset directory> [seconds=20] [reader threads=default] [reports|bulk] [bulk cases=5000]
 * The dataset directory is one `bun bench/run.ts` leaves under `.mainworthy/bench/` (it holds `mainworthy.db`).
 */
import { cpSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

export type UnderLoad = {
	readerThreads: number | null;
	seconds: number;
	/** Readers alone for five seconds, after a warm-up. */
	control: number[];
	reads: Record<"case" | "folder" | "history" | "gate" | "queue" | "search", number[]>;
	reports: number[];
	saves: number[];
	bulk: { create: number[]; propose: number[]; adopt: number[]; cases: number };
	errors: number;
};

const Reply = z.object({ ok: z.boolean(), result: z.unknown().optional(), error: z.unknown().optional() });

/** One window of load against a fresh copy of the dataset, served by `mainworthy serve` in its own process. */
export async function underLoad(options: {
	dataset: string;
	seconds: number;
	/** Reader threads; null leaves the server's default. */
	readers: number | null;
	/** Bulk creates, proposed edits and their acceptance, instead of reports. */
	workload?: "reports" | "bulk";
	bulkCases?: number;
}): Promise<UnderLoad> {
	const seconds = options.seconds;
	const workload = options.workload ?? "reports";
	const bulkCases = options.bulkCases ?? 5000;
	if (
		!Number.isFinite(seconds) ||
		seconds <= 0 ||
		!Number.isSafeInteger(bulkCases) ||
		bulkCases < 1 ||
		bulkCases > 5000
	)
		throw new Error("seconds must be positive and bulk cases must be an integer from 1 to 5000");
	const dir = mkdtempSync(join(dirname(realpathSync(options.dataset)), "external-"));
	cpSync(join(options.dataset, "mainworthy.db"), join(dir, "mainworthy.db"));
	const server = Bun.spawn([process.execPath, "src/cli/main.ts", "serve"], {
		env: {
			...process.env,
			MAINWORTHY_DATA: dir,
			MAINWORTHY_PORT: "0",
			MAINWORTHY_MODE: "local",
			NODE_ENV: "production",
			...(options.readers === null ? {} : { MAINWORTHY_READERS: String(options.readers) }),
		},
		stdout: "pipe",
		stderr: "inherit",
	});
	let base = "";
	let errors = 0;
	const post = async (op: string, body: string, token?: string): Promise<{ ms: number; result: unknown }> => {
		const started = performance.now();
		const response = await fetch(`${base}/api/${op === "admin" ? "admin" : `p/benchmark/${op}`}`, {
			method: "POST",
			headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
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
	const call = (op: string, input: unknown, token?: string) => post(op, JSON.stringify(input), token);
	try {
		const output = server.stdout.getReader();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				(async () => {
					const decoder = new TextDecoder();
					let printed = "";
					while (!base) {
						const chunk = await output.read();
						if (chunk.done) throw new Error("the benchmark server stopped before listening");
						printed += decoder.decode(chunk.value, { stream: true });
						base = /http:\/\/127\.0\.0\.1:\d+/.exec(printed)?.[0] ?? "";
					}
				})(),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error("the benchmark server did not listen within 20 seconds")), 20_000);
				}),
			]);
		} finally {
			clearTimeout(timer);
			output.releaseLock();
		}
		const folders = z
			.object({ items: z.array(z.object({ id: z.number(), cases: z.number() })) })
			.parse((await call("find", { in: "folders" })).result)
			.items.filter((folder) => folder.cases > 0)
			.map((folder) => folder.id);
		// The size of this dataset: how many cases, and the number of the newest test.
		const caseCount = z.object({ count: z.number() }).parse((await call("find", { limit: 1 })).result).count;
		const bulkToken =
			workload === "bulk"
				? z.object({ token: z.string() }).parse(
						(
							await call("admin", {
								do: "token.create",
								actor: "bulk-benchmark",
								kind: "agent",
								can: ["read", "produce"],
								project: "benchmark",
							})
						).result,
					).token
				: undefined;
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
		const bulk: UnderLoad["bulk"] = { create: [], propose: [], adopt: [], cases: 0 };
		const committed: { folder: string; refs: string[] }[] = [];
		const Head = z.array(z.object({ version: z.number() }));
		const saveBase = Head.parse((await call("get", { refs: ["C-7"], fields: ["title"] })).result)[0]?.version;
		if (saveBase === undefined) throw new Error("the save workload needs C-7");
		let saveHead = saveBase;
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
			for (let i = 0; performance.now() < until; i++) {
				const saved = await call("propose", {
					edits: [{ op: "edit", case: "C-7", base: saveHead, body: { title: `mixed ${Date.now()} ${i}` } }],
				});
				const reply = z
					.object({ status: z.string(), cases: z.array(z.object({ ref: z.string(), version: z.number() })) })
					.parse(saved.result);
				if (
					reply.status !== "adopted" ||
					reply.cases.length !== 1 ||
					reply.cases[0]?.ref !== "C-7" ||
					reply.cases[0]?.version !== saveHead + 1
				)
					throw new Error("a save was not adopted as the next version");
				saveHead = reply.cases[0].version;
				saves.push(saved.ms);
				await Bun.sleep(200);
			}
		};
		const bulkEditor = async (): Promise<void> => {
			const Proposal = z.object({
				status: z.string(),
				question: z.string().nullable(),
				cases: z.array(z.object({ ref: z.string(), version: z.number() })),
			});
			const Decisions = z.array(
				z.object({
					status: z.string(),
					effects: z.object({ cases: z.array(z.object({ ref: z.string(), version: z.number() })) }),
				}),
			);
			for (let batch = 1; performance.now() < until; batch++) {
				const folder = `Bulk ${batch}`;
				const created = await call("propose", {
					edits: Array.from({ length: bulkCases }, (_, i) => ({
						op: "create",
						folder,
						body: { title: `Bulk ${batch} case ${i}`, steps: [{ id: "s1", action: "Check", expected: "Pass" }] },
					})),
				});
				const first = Proposal.parse(created.result);
				if (
					first.status !== "adopted" ||
					first.cases.length !== bulkCases ||
					new Set(first.cases.map((row) => row.ref)).size !== bulkCases ||
					first.cases.some((row) => row.version !== 1)
				)
					throw new Error("bulk creates were not adopted in full");
				bulk.create.push(created.ms);
				const proposed = await call(
					"propose",
					{
						edits: first.cases.map((row) => ({
							op: "edit",
							case: row.ref,
							base: row.version,
							body: { title: `Updated ${row.ref}` },
						})),
					},
					bulkToken,
				);
				const pending = Proposal.parse(proposed.result);
				if (pending.status !== "open" || !pending.question || pending.cases.length !== 0)
					throw new Error("bulk edits did not wait for acceptance; use the standard preset dataset");
				bulk.propose.push(proposed.ms);
				const question = z
					.array(z.object({ evidenceHash: z.string(), state: z.literal("open") }))
					.parse((await call("get", { refs: [pending.question] })).result)[0];
				const accepted = await call("decide", {
					q: pending.question,
					onEvidence: question?.evidenceHash,
					answer: { is: "accept" },
				});
				const decision = Decisions.parse(accepted.result)[0];
				if (
					decision?.status !== "decided" ||
					decision.effects.cases.length !== bulkCases ||
					decision.effects.cases.some((row, i) => row.ref !== first.cases[i]?.ref || row.version !== 2)
				)
					throw new Error("bulk edits were not adopted in full");
				bulk.adopt.push(accepted.ms);
				committed.push({ folder, refs: first.cases.map((row) => row.ref) });
				bulk.cases += bulkCases;
			}
		};
		await Promise.all([
			...Array.from({ length: 16 }, (_, seed) => reader(seed, reads)),
			workload === "bulk" ? bulkEditor() : ingester(),
			saver(),
		]);

		if (saves.length === 0) throw new Error("the load window recorded no save acknowledgements");
		if (Head.parse((await call("get", { refs: ["C-7"], fields: ["title"] })).result)[0]?.version !== saveHead)
			throw new Error("the acknowledged save version was not committed");
		for (const { folder, refs: allRefs } of committed) {
			// After the load window: confirm the persisted list and every edited version, not just the acknowledgement.
			if (z.object({ count: z.number() }).parse((await call("find", { folder, limit: 1 })).result).count !== bulkCases)
				throw new Error("bulk cases were not committed");
			for (let offset = 0; offset < allRefs.length; offset += 100) {
				const refs = allRefs.slice(offset, offset + 100);
				const rows = z
					.array(z.object({ ref: z.string(), version: z.number(), title: z.string() }))
					.parse((await call("get", { refs, fields: ["title"] })).result);
				if (
					rows.length !== refs.length ||
					rows.some((row, i) => row.ref !== refs[i] || row.version !== 2 || row.title !== `Updated ${row.ref}`)
				)
					throw new Error("the committed bulk versions differ from the accepted edits");
			}
		}

		return {
			readerThreads: options.readers,
			seconds,
			control: Object.values(control).flat(),
			reads,
			reports: ingests,
			saves,
			bulk,
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
	const [source, secondsText = "20", readersText, workload = "reports", bulkCases = "5000"] = Bun.argv.slice(2);
	if (!source)
		throw new Error(
			"usage: bun bench/external.ts <dataset directory> [seconds] [reader threads] [reports|bulk] [bulk cases]",
		);
	const seconds = Number(secondsText);
	if (workload !== "reports" && workload !== "bulk") throw new Error("workload must be reports or bulk");
	const load = await underLoad({
		dataset: source,
		seconds,
		readers: readersText === undefined ? null : Number(readersText),
		workload,
		bulkCases: Number(bulkCases),
	});
	const all = Object.values(load.reads).flat();
	console.log(
		JSON.stringify(
			{
				readerThreads: load.readerThreads ?? "default",
				workload,
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
				bulk: {
					cases: load.bulk.cases,
					...Object.fromEntries(
						(["create", "propose", "adopt"] as const).map((kind) => [
							kind,
							{ n: load.bulk[kind].length, p50: quantile(load.bulk[kind], 0.5), p95: quantile(load.bulk[kind], 0.95) },
						]),
					),
				},
				errors: load.errors,
			},
			null,
			1,
		),
	);
}
