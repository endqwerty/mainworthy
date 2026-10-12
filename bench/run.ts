import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { cpus, loadavg, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { BUDGETS, ensure } from "./contracts.ts";
import { buildDataset, fingerprints, openDataset, Parameters } from "./dataset.ts";
import { quantile, type UnderLoad, underLoad } from "./external.ts";
import { type Measurement, measure, percentile, type Sample, summarise, table, type Workload } from "./measure.ts";
import { profile } from "./profile.ts";
import {
	assertProducer,
	bulkWorkload,
	executeWorkload,
	ingestWorkload,
	prepareRecentChanges,
	readWorkloads,
	saveWorkload,
} from "./workloads.ts";

/** Validates CLI parameters and keeps the full and quick immutable baselines in distinct directories. */
export function options(args: string[]) {
	const { values } = parseArgs({
		args,
		strict: true,
		allowPositionals: false,
		options: {
			quick: { type: "boolean", default: false },
			cases: { type: "string" },
			tests: { type: "string" },
			results: { type: "string" },
			json: { type: "string" },
		},
	});
	const quick = values.quick ?? false;
	const parameters = Parameters.parse({
		cases: Number(values.cases ?? (quick ? "5000" : "100000")),
		tests: Number(values.tests ?? (quick ? "2000" : "20000")),
		results: Number(values.results ?? (quick ? "50000" : "1000000")),
		openQuestions: quick ? 2_000 : 50_000,
		queueTimeMs: quick ? 5_000 : 180_000,
	});
	const revision = fingerprints();
	return {
		quick,
		parameters,
		json: values.json,
		dir: resolve(
			".casebook",
			"bench",
			`dataset-${parameters.cases}-${parameters.tests}-${parameters.results}-${parameters.seed}-${parameters.openQuestions}-${revision.generator.slice(0, 12)}-${revision.migrations.slice(0, 12)}`,
		),
	};
}

/** Captures hardware, filesystem, runtime and competing process names without logging command lines or secrets. */
export function machine(dir: string) {
	const cores = cpus();
	const command = (file: string, args: string[]) => {
		try {
			return execFileSync(file, args, { encoding: "utf8" }).trim();
		} catch {
			return "unavailable";
		}
	};
	return {
		cpu: cores[0]?.model ?? "unknown",
		cores: cores.length,
		memoryGiB: totalmem() / 1_073_741_824,
		filesystem: command("df", ["-PT", dir]),
		load: loadavg(),
		bun: Bun.version,
		platform: process.platform,
		arch: process.arch,
		competingProcesses: command("ps", ["-eo", "comm,%cpu,%mem", "--sort=-%cpu"]).split("\n").slice(0, 12),
	};
}

async function junitWorkload(dir: string, iterations: number): Promise<Workload | null> {
	if (!existsSync(resolve("src/surfaces/formats/junit.ts"))) return null;
	const { parseJUnit } = await import("../src/surfaces/formats/junit.ts");
	const path = join(dir, "junit-10000.xml");
	const xml = `<?xml version="1.0"?><testsuite name="customer journeys" tests="10000">${Array.from({ length: 10_000 }, (_, index) => `<testcase name="customer journey ${index}" classname="checkout" file="tests/checkout.spec.ts" time="0.021">${index < 200 ? '<failure message="checkout assertion failed">Expected a consistent basket</failure>' : index < 300 ? "<skipped/>" : ""}</testcase>`).join("")}</testsuite>`;
	writeFileSync(path, xml);
	return {
		name: "JUnit parse (10000)",
		budget: null,
		iterations,
		correctness:
			"Read the complete 10k testcase XML file and parse 9,700 passes, 200 failures, 100 skips, zero warnings.",
		prepare: () => async () => parseJUnit(await Bun.file(path).text(), { file: path }),
		check(value) {
			const parsed = z
				.object({ results: z.array(z.object({ outcome: z.string() })), warnings: z.array(z.string()) })
				.parse(value);
			ensure(
				parsed.results.length === 10_000 &&
					parsed.warnings.length === 0 &&
					parsed.results.filter((row) => row.outcome === "fail").length === 200 &&
					parsed.results.filter((row) => row.outcome === "skip").length === 100,
				"JUnit parser must read and parse every testcase without warnings",
			);
		},
	};
}

/** Runs B6's real-code benchmark; numeric misses or correctness errors produce a nonzero exit code. */
export async function runBenchmark(args = Bun.argv.slice(2)): Promise<number> {
	const cli = options(args);
	const started = performance.now();
	mkdirSync(cli.dir, { recursive: true });
	const hardware = machine(cli.dir);
	console.log(
		`Machine: ${hardware.cpu}; ${hardware.cores} logical cores; ${hardware.memoryGiB.toFixed(1)} GiB; Bun ${hardware.bun}`,
	);
	console.log(
		`Filesystem: ${hardware.filesystem}\nLoad at start: ${hardware.load.map((value) => value.toFixed(2)).join(" / ")}`,
	);
	const dataset = buildDataset({ dir: cli.dir, parameters: cli.parameters });
	const instance = openDataset(dataset, join(cli.dir, `isolated-${randomUUID()}`));
	const rows: Measurement[] = [];
	const repetitions: { name: string; results: Measurement[] }[] = [];
	const loads: { after: string; load: number[] }[] = [];
	const diagnostic: Awaited<ReturnType<typeof profile>>[] = [];
	const iterations = cli.quick ? 25 : 50;
	const repeatWorkload = (peer: typeof instance, name: string): Workload => {
		const read = readWorkloads(peer, iterations).find((workload) => workload.name === name);
		if (read) return read;
		if (name === "case save") return saveWorkload(peer, iterations);
		if (name === "bulk move (1000)") return bulkWorkload(peer);
		if (name === "ingest (10000)") return ingestWorkload(peer).workload;
		if (name === "execute run") return executeWorkload(peer, cli.quick ? 50 : 200);
		throw new Error(`No fresh repeat factory for ${name}`);
	};
	const run = async (workload: Workload) => {
		console.log(`Measuring ${workload.name}: ${workload.iterations} iterations in five blocks…`);
		const row = await measure(workload);
		rows.push(row);
		loads.push({ after: row.name, load: loadavg() });
		if (
			!cli.quick &&
			row.budget !== null &&
			row[row.criterion] >= row.budget / 2 &&
			row[row.criterion] <= row.budget * 2
		) {
			console.log(`  ${row.name} is within 2× its budget; repeating five complete runs on fresh clones.`);
			const repeated: Measurement[] = [];
			for (let round = 0; round < 5; round++) {
				const peer = openDataset(dataset, join(cli.dir, `repeat-${randomUUID()}`));
				try {
					prepareRecentChanges(peer);
					repeated.push(await measure(repeatWorkload(peer, row.name)));
				} finally {
					peer.close();
				}
			}
			repetitions.push({ name: row.name, results: repeated });
			const values = [row, ...repeated].map((result) => result[result.criterion]);
			console.log(
				`  ${row.criterion} median ${percentile(values, 0.5).toFixed(2)} ms, range ${Math.min(...values).toFixed(2)} to ${Math.max(...values).toFixed(2)} ms; any trial miss fails the command.`,
			);
		}
		return row;
	};
	try {
		prepareRecentChanges(instance);
		assertProducer(instance.ci);
		for (const workload of readWorkloads(instance, iterations)) await run(workload);
		await run(saveWorkload(instance, iterations));
		await run(bulkWorkload(instance));
		const ingest = ingestWorkload(instance);
		await run(ingest.workload);
		const visibleSamples = ingest.visibility.map((ms, index) => ({ ms, error: null, round: index % 5 }));
		const visible = summarise(visibleSamples);
		rows.push({
			...visible,
			name: "ingest gate visible",
			budget: BUDGETS.visible,
			criterion: "max",
			pass: visible.max < BUDGETS.visible && rows.every((row) => row.name !== "ingest (10000)" || row.errors === 0),
			correctness: "Gate read after synchronous invoke completes acceptance and apply, timed from report start.",
			checked: visible.n,
			samples: visibleSamples,
			warmupErrors: [],
			errorMessages: [],
		});
		const junit = await junitWorkload(instance.dir, cli.quick ? 10 : 25);
		if (junit) await run(junit);
		else console.log("JUnit parsing skipped: src/surfaces/formats/junit.ts is absent.");
		await run(executeWorkload(instance, cli.quick ? 50 : 200));
	} finally {
		instance.close();
	}
	// Under load: the server runs as its own process, with its reader threads, and is driven from this one, so
	// the numbers are the server's own and not those of a thread shared with the load generator.
	const windows = cli.quick ? 1 : 3;
	const underLoads: UnderLoad[] = [];
	for (let round = 0; round < windows; round++) {
		console.log(
			`Under load ${round + 1}/${windows}: readers alone 5 s, then 16 readers + back-to-back reports + saves 15 s (server in its own process)`,
		);
		underLoads.push(await underLoad({ dataset: dataset.dir, seconds: 15, readers: null }));
	}
	const sampled = (pick: (load: UnderLoad) => readonly number[]): Sample[] =>
		underLoads.flatMap((load, round) => pick(load).map((ms) => ({ ms, error: null, round })));
	const underRow = (
		name: string,
		samples: Sample[],
		budget: number | null,
		criterion: "p95" | "max",
		correctness: string,
	): Measurement => {
		const summary = summarise(samples);
		return {
			...summary,
			name,
			budget,
			criterion,
			pass: budget === null || summary[criterion] < budget,
			correctness,
			checked: summary.n,
			warmupErrors: [],
			errorMessages: [],
			samples,
		};
	};
	const requestErrors = underLoads.reduce((n, load) => n + load.errors, 0);
	if (requestErrors > 0) throw new Error(`${requestErrors} requests failed under load`);
	rows.push(
		underRow(
			"reads under load",
			sampled((load) => Object.values(load.reads).flat()),
			BUDGETS.mixed,
			"p95",
			"Case, folder page, test history, gate, queue and search over HTTP while reports and saves arrive.",
		),
		underRow(
			"report under load",
			sampled((load) => load.reports),
			BUDGETS.ingest,
			"max",
			"A 10,000-result report over HTTP, back to back, applied in full each time.",
		),
		underRow(
			"save under load",
			sampled((load) => load.saves),
			null,
			"p95",
			"A case edit adopted while reports arrive. No budget: one writer, so a save waits behind a report (issue #60).",
		),
	);
	console.log(table(rows));
	const alone = underLoads.flatMap((load) => load.control);
	const reads = underLoads.flatMap((load) => Object.values(load.reads).flat());
	console.log(
		`Under load: ${Math.round(reads.length / (windows * 15))} reads/s (readers alone: p95 ${quantile(alone, 0.95)} ms, ${Math.round(alone.length / (windows * 5))} reads/s). Slowest read ${quantile(reads, 1)} ms.`,
	);
	for (const name of ["case", "folder", "history", "gate", "queue", "search"] as const) {
		const values = underLoads.flatMap((load) => load.reads[name]);
		console.log(`  ${name}: p95 ${quantile(values, 0.95)} ms, n=${values.length}`);
	}
	const profiling = openDataset(dataset, join(cli.dir, `profile-${randomUUID()}`));
	try {
		prepareRecentChanges(profiling);
		const workloads = [
			...readWorkloads(profiling, 5),
			saveWorkload(profiling, 5),
			bulkWorkload(profiling),
			ingestWorkload(profiling, { prefix: "profile", iterations: 5 }).workload,
			executeWorkload(profiling, 5),
		];
		for (const workload of workloads) {
			const result = await profile(profiling.app, workload);
			diagnostic.push(result);
			const hottest = result.queries[0];
			console.log(
				`Diagnostic ${result.name}: ${result.cpuMs.toFixed(1)} CPU ms / ${result.wallMs.toFixed(1)} wall ms, ${result.fileInputs} file inputs, ${result.majorFaults} major faults; top SQL ${hottest?.ms.toFixed(1) ?? "0"} ms in ${hottest?.calls ?? 0} calls; ${hottest?.plan.join("; ") ?? "no SELECT plan"}`,
			);
		}
	} finally {
		profiling.close();
	}
	const failed = rows.filter((row) => !row.pass);
	const repeatFailures = repetitions.reduce((n, repeated) => n + repeated.results.filter((row) => !row.pass).length, 0);
	const near = rows.filter((row) => row.budget !== null && row[row.criterion] >= row.budget / 2);
	const durationSeconds = (performance.now() - started) / 1_000;
	const report = {
		createdAt: new Date().toISOString(),
		quick: cli.quick,
		machine: hardware,
		dataset: {
			fingerprints: dataset.metadata.fingerprints,
			parameters: dataset.metadata.parameters,
			counts: dataset.metadata.counts,
			reused: dataset.reused,
			queueLimited: dataset.metadata.queueLimited,
			phases: dataset.metadata.phases,
		},
		rows,
		repetitions,
		underLoad: underLoads.map((load) => ({
			readerThreads: load.readerThreads ?? "default",
			seconds: load.seconds,
			reads: Object.values(load.reads).flat().length,
			reports: load.reports.length,
			saves: load.saves.length,
			errors: load.errors,
		})),
		diagnostic,
		loads,
		loadEnd: loadavg(),
		durationSeconds,
		limits: [
			"SQLite pragmas are unchanged production values; baseline is closed before cloning.",
			"All correctness and persisted-count assertions are outside isolated operation timers.",
			"Twenty untimed recent edits on each clone exercise real diffs; small/quick cursors precede those edits and full cursors are 300 commands back.",
			"HTTP load generator shares the server process and thread; synchronous SQL and read work delay server work and client callbacks. The current product yields between report apply slices.",
			...(cli.quick
				? ["Quick HTTP mix is one 15-second window; use the default run for five independent windows."]
				: []),
			...(dataset.metadata.queueLimited
				? [`Queue claim limited to the ${dataset.metadata.counts.open} open questions actually built.`]
				: []),
		],
	};
	if (cli.json) {
		mkdirSync(dirname(resolve(cli.json)), { recursive: true });
		writeFileSync(cli.json, JSON.stringify(report, null, 2));
		console.log(`Report: ${resolve(cli.json)}`);
	}
	console.log(
		`Elapsed: ${durationSeconds.toFixed(2)} s; load at end ${loadavg()
			.map((value) => value.toFixed(2))
			.join(
				" / ",
			)}; ${failed.length} primary misses and ${repeatFailures} repeat misses; ${near.length} workloads at or above half their budget.`,
	);
	for (const row of failed)
		for (const error of [...row.warmupErrors, ...row.errorMessages].slice(0, 3)) console.error(`${row.name}: ${error}`);
	return failed.length > 0 || repetitions.some((repeat) => repeat.results.some((row) => !row.pass)) ? 1 : 0;
}

if (import.meta.main) {
	try {
		process.exitCode = await runBenchmark();
	} catch (error) {
		console.error(error instanceof Error ? error.stack : error);
		process.exitCode = 1;
	}
}
