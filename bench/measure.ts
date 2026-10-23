import { z } from "zod";
import { ensure } from "./contracts.ts";

export type Sample = { ms: number; error: string | null; round: number };
export type Summary = {
	p50: number;
	p95: number;
	p99: number;
	max: number;
	min: number;
	errors: number;
	n: number;
	rounds: { p95: number; min: number; max: number }[];
};
export type Measurement = Summary & {
	name: string;
	budget: number | null;
	criterion: "p95" | "max";
	pass: boolean;
	correctness: string;
	checked: number;
	warmupErrors: string[];
	errorMessages: string[];
	samples: Sample[];
};

export type Workload = {
	name: string;
	budget: number | null;
	criterion?: "p95" | "max";
	iterations: number;
	warmup?: number;
	correctness: string;
	/** Builds inputs outside the timer and returns the exact operation to time. */
	prepare: (iteration: number) => () => unknown | Promise<unknown>;
	/** Checks the result and persisted state outside the timed region. */
	check: (result: unknown, iteration: number) => Promise<void | Promise<void>>;
};

/** Nearest-rank quantiles keep a long tail visible, including the sole slow sample in small runs. */
export function percentile(values: readonly number[], percentileValue: number): number {
	ensure(values.length > 0, "a quantile needs at least one sample");
	const sorted = [...values].sort((a, b) => a - b);
	const value = sorted[Math.max(0, Math.ceil(sorted.length * percentileValue) - 1)];
	ensure(value !== undefined, "quantile index must exist");
	return value;
}

/** Reports every latency, including failed attempts, and the five repeat-block ranges. */
export function summarise(samples: readonly Sample[]): Summary {
	const values = samples.map((sample) => sample.ms);
	return {
		p50: percentile(values, 0.5),
		p95: percentile(values, 0.95),
		p99: percentile(values, 0.99),
		max: Math.max(...values),
		min: Math.min(...values),
		errors: samples.filter((sample) => sample.error !== null).length,
		n: values.length,
		rounds: Array.from(new Set(samples.map((sample) => sample.round)), (round) => {
			const block = samples.filter((sample) => sample.round === round).map((sample) => sample.ms);
			return { p95: percentile(block, 0.95), min: Math.min(...block), max: Math.max(...block) };
		}),
	};
}

/** Measures completed work after warmup; an error or a failed correctness assertion fails the workload. */
export async function measure(workload: Workload): Promise<Measurement> {
	const samples: Sample[] = [];
	const warmupErrors: string[] = [];
	let checked = 0;
	const warmup = workload.warmup ?? 5;
	for (let iteration = -warmup; iteration < workload.iterations; iteration++) {
		let error: string | null = null;
		let ms = 0;
		try {
			const run = workload.prepare(iteration);
			const start = performance.now();
			let result: unknown;
			try {
				result = await run();
			} finally {
				ms = performance.now() - start;
			}
			await workload.check(result, iteration);
			if (iteration >= 0) checked++;
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
		}
		if (iteration < 0) {
			if (error !== null) warmupErrors.push(error);
		} else samples.push({ ms, error, round: Math.min(4, Math.floor((iteration * 5) / workload.iterations)) });
	}
	const summary = summarise(samples);
	const criterion = workload.criterion ?? "p95";
	return {
		...summary,
		name: workload.name,
		budget: workload.budget,
		criterion,
		pass:
			summary.errors === 0 &&
			warmupErrors.length === 0 &&
			(workload.budget === null || summary[criterion] < workload.budget),
		correctness: workload.correctness,
		checked,
		warmupErrors,
		samples,
		errorMessages: samples.flatMap((sample) => (sample.error === null ? [] : [sample.error])),
	};
}

/** Validates the HTTP envelope before the caller validates the operation-specific output. */
export const Envelope = z.discriminatedUnion("ok", [
	z.object({ ok: z.literal(true), result: z.unknown() }),
	z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) }),
]);

/** A portable plain-text table; max governs bulk and ingest, while read budgets govern p95. */
export function table(rows: readonly Measurement[]): string {
	const header = ["workload", "p50 ms", "p95 ms", "p99 ms", "max ms", "budget ms", "pass/MISS", "errors"];
	const data = rows.map((row) => [
		row.name,
		row.p50.toFixed(2),
		row.p95.toFixed(2),
		row.p99.toFixed(2),
		row.max.toFixed(2),
		row.budget === null ? "report" : `${row.criterion}<${row.budget}`,
		row.pass ? "pass" : "MISS",
		String(row.errors + row.warmupErrors.length),
	]);
	const widths = header.map((value, index) => Math.max(value.length, ...data.map((row) => row[index]?.length ?? 0)));
	const line = (row: readonly string[]) =>
		`| ${row.map((value, index) => value.padEnd(widths[index] ?? 0)).join(" | ")} |`;
	return [line(header), line(widths.map((width) => "-".repeat(width))), ...data.map(line)].join("\n");
}
