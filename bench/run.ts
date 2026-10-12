import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { cpus, loadavg, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { BUDGETS, ensure } from "./contracts.ts";
import { buildDataset, openDataset, Parameters } from "./dataset.ts";
import { type Measurement, measure, summarise, table, type Workload } from "./measure.ts";
import { mixedLoad } from "./mixed.ts";
import { profile } from "./profile.ts";
import {
	assertProducer,
	bulkWorkload,
	executeWorkload,
	ingestWorkload,
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
	return {
		quick,
		parameters,
		json: values.json,
		dir: resolve(
			".casebook",
			"bench",
			`dataset-${parameters.cases}-${parameters.tests}-${parameters.results}-${parameters.seed}-${parameters.openQuestions}`,
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
	const iterations = cli.quick ? 25 : 100;
	const run = async (workload: Workload) => {
		console.log(`Measuring ${workload.name}: ${workload.iterations} iterations in five blocks…`);
		const row = await measure(workload);
		rows.push(row);
		loads.push({ after: row.name, load: loadavg() });
		if (!cli.quick && row.budget !== null && row[row.criterion] >= row.budget / 2) {
			console.log(`  ${row.name} is within 2× its budget or misses it; repeating five complete runs.`);
			const repeated: Measurement[] = [];
			for (let round = 0; round < 5; round++) repeated.push(await measure(workload));
			repetitions.push({ name: row.name, results: repeated });
		}
		return row;
	};
	try {
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
	const mixed = await mixedLoad(dataset, { milliseconds: 15_000, repeats: cli.quick ? 1 : 5 });
	rows.push(...mixed.measurements);
	console.log(table(rows));
	console.log(
		`Mixed: ${mixed.readsPerSecond.toFixed(1)} reads/s; longest read during a 10,000-result ingest ${mixed.longestReadDuringIngest.toFixed(2)} ms (${mixed.longestReadOp}).`,
	);
	console.log(
		`Report apply transactions: p50 ${mixed.ingestTransactions.p50.toFixed(2)} ms, p95 ${mixed.ingestTransactions.p95.toFixed(2)} ms, max ${mixed.ingestTransactions.max.toFixed(2)} ms, including reads between apply slices. Acceptance transaction p95 ${mixed.acceptTransactions.p95.toFixed(2)} ms.`,
	);
	console.log(
		"Direct invoke drains acceptance and apply commits synchronously, then reads the gate. HTTP uses the product's invokeAsync and serves reads between apply slices; all SQL still runs on one JS thread.",
	);
	const profiling = openDataset(dataset, join(cli.dir, `profile-${randomUUID()}`));
	try {
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
				`Diagnostic ${result.name}: ${result.cpuMs.toFixed(1)} CPU ms / ${result.wallMs.toFixed(1)} wall ms; top SQL ${hottest?.ms.toFixed(1) ?? "0"} ms in ${hottest?.calls ?? 0} calls; ${hottest?.plan.join("; ") ?? "no SELECT plan"}`,
			);
		}
	} finally {
		profiling.close();
	}
	const failed = rows.filter((row) => !row.pass);
	const near = rows.filter((row) => row.budget !== null && row[row.criterion] >= row.budget / 2);
	const durationSeconds = (performance.now() - started) / 1_000;
	const report = {
		createdAt: new Date().toISOString(),
		quick: cli.quick,
		machine: hardware,
		dataset: {
			parameters: dataset.metadata.parameters,
			counts: dataset.metadata.counts,
			reused: dataset.reused,
			queueLimited: dataset.metadata.queueLimited,
			phases: dataset.metadata.phases,
		},
		rows,
		repetitions,
		mixed,
		diagnostic,
		loads,
		loadEnd: loadavg(),
		durationSeconds,
		limits: [
			"SQLite pragmas are unchanged production values; baseline is closed before cloning.",
			"All correctness and persisted-count assertions are outside isolated operation timers.",
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
			.join(" / ")}; ${failed.length} misses; ${near.length} workloads at or above half their budget.`,
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
