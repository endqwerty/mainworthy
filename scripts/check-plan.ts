// What the check runs and how long it may take. One place, read by `scripts/check.ts`, `scripts/ci-gate.ts`,
// the browser tests' set-up and `test/check.test.ts`.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";

/** Per-file durations in milliseconds, written by Bun. Shards are balanced by it; the slowest files start first. */
export const TIMINGS = "scripts/test-timings.json";

/**
 * The tests that compare a measured time with a limit. They run after the parallel phase, on a machine that
 * runs nothing else, so that what they measure is the product. Beside sixteen workers on 2026-10-12 the capture
 * latency was 143 ms at the 95th percentile against a budget of 100 (13 ms alone), the 5,000-result ingest
 * 1,178 ms against 1,000 (182 alone) and the JUnit parse 623 ms against 500.
 * A test belongs here only if it measures time: one that fails beside other tests for another reason shares
 * something it should not, and that is what to fix.
 */
export const QUIET = [
	"test/e2e/latency-10000.test.ts",
	"test/e2e/latency-2000.test.ts",
	"test/budgets.test.ts",
	"src/surfaces/formats/junit.test.ts",
	"src/core/signature.test.ts",
];

/**
 * How many of the quiet files run at once. On the 16-thread desktop the two latency files side by side measured
 * what each measures alone (95th percentiles of 11.7, 15.3, 16.2 and 16.2 ms for both sizes; alone 13.1, 15.4,
 * 16.2 and 16.2; the budget is 100), and one after the other they are 69 s of the check. Two there, one
 * anywhere smaller.
 */
export const quietWorkers = (cores = availableParallelism()): number => (cores >= 16 ? 2 : 1);

/**
 * How many workers the parallel phase has: half the threads. A browser test is a test process, a server and a
 * browser, so more workers than cores only wait for each other. The parallel phase on the 16-thread desktop,
 * 2026-10-12: 6 workers 79 s, 8 workers 70 s, 10 workers 75 s, 12 workers 81 s, 16 workers 81 s with tests
 * running out of their time.
 */
export const parallelWorkers = (cores = availableParallelism()): number => Math.max(1, Math.floor(cores / 2));

/**
 * The reader threads of a server a test starts, where MAINWORTHY_READERS does not say. A server takes the cores
 * less two, up to eight (`src/server/readers.ts`), and the browser tests start several hundred servers: on the
 * 16-thread desktop the eight threads were 38% of the CPU time of the longest browser file (121 CPU-seconds;
 * 76 with two). Two is still a pool, so a read still leaves the server's thread. A 2-core CI runner keeps the
 * one reader it always had. The tests about the pool itself name their own count.
 */
export const testReaders = (cores = availableParallelism()): string => String(Math.max(1, Math.min(2, cores - 2)));

export type Limits = { warn: number; fail: number };

/**
 * Seconds the tests of one whole `bun run check` may take (the parallel phase plus the quiet one), on the
 * 16-thread desktop. Measured there on 2026-10-12 with nothing else running, five checks in a row: 106.9, 107.1,
 * 107.2, 108.0 and 107.9 s (about 71 s and 36 s). Over `warn` the check says so; over `fail` it fails.
 *
 * The limits were 115 and 120 s, the two minutes the check was promised to stay under (issue #77). By 2026-10-13
 * the tests took 120.1 to 122.3 s with nothing else running, on `main` and on every branch, so every check ended
 * in a failure that was not its change. The owner raised them that day: the longer check is accepted for now and is
 * to be brought back down later (#77). They are the owner's to raise, nobody else's: make the check faster (AGENTS.md).
 */
export const LIMITS: Limits = { warn: 130, fail: 150 };

/** The machine the limits were measured on. On a smaller one, a run over the limit is reported and does not fail. */
export const REFERENCE_THREADS = 16;

/**
 * The limits are for a machine that runs nothing else. When other work keeps more than this many cores busy
 * (another agent's tests: on 2026-10-12 a load generator beside the check made it take 283 s), a run over the
 * limit is reported and does not fail. The desktop's own background is under one core.
 */
export const SHARED_CORES = 2;

/** The shards the workflow splits the parallel phase into; `.github/workflows/check.yml` lists as many. */
export const CI_SHARDS = 6;

/**
 * Seconds the tests of one CI shard may take. Not measured on GitHub's runner yet: the suite took 716 s there in
 * one job, which is about 125 s for each of five shards and 100 s for the quiet one. Set from the first pushed
 * runs; until then these only catch a shard that takes twice what is expected. A shard has ten minutes in all.
 *
 * Measured since (2026-10-13): with five shards the slowest, which holds most of the browser files, took 176 to
 * 215 s on `main` and 234 to 258 s once the sign-in pages' browser tests were added, so the gate passed or failed
 * by the runner it drew. Six shards bring it back under the limit. The limits are the owner's to change.
 */
export const CI_SHARD_LIMITS: Limits = { warn: 180, fail: 240 };

export function over(seconds: number, limits: Limits): "ok" | "warn" | "fail" {
	return seconds > limits.fail ? "fail" : seconds > limits.warn ? "warn" : "ok";
}

export const seconds = (value: number): string => `${value.toFixed(1)} s`;

export type Phase = "parallel" | "quiet";
export type TestOptions = {
	/** `i/n`: the parallel phase runs only that share of its files. */
	shard?: string | undefined;
	/** Workers, where the phase's own number is not wanted. */
	workers?: number | undefined;
	junit?: string | undefined;
	/** The timings file Bun reads, and writes this run's durations to. */
	timings: string;
	/** Print the tests that failed and not the hundreds that passed. */
	failuresOnly?: boolean | undefined;
};

/** The `bun test` arguments of one phase. Every test file is in exactly one of the two. */
export function testArgs(phase: Phase, options: TestOptions): string[] {
	const workers = options.workers ?? (phase === "quiet" ? quietWorkers() : parallelWorkers());
	return [
		"test",
		// Workers also when there is one: each file then has its own globals and modules, as beside the others.
		`--parallel=${workers}`,
		// When the run is stopped, the servers and browsers its tests started stop with it.
		"--no-orphans",
		`--timings=${options.timings}`,
		"--update-timings",
		...(options.junit ? ["--reporter=junit", `--reporter-outfile=${options.junit}`] : []),
		...(options.failuresOnly ? ["--only-failures"] : []),
		...(phase === "quiet"
			? QUIET.map((file) => `./${file}`)
			: [
					...QUIET.map((file) => `--path-ignore-patterns=${file}`),
					...(options.shard ? [`--shard=${options.shard}`] : []),
					"src",
					"test",
				]),
	];
}

/** What a run that wrote a JUnit file leaves beside it, for `scripts/ci-gate.ts`. */
export type Outcome = { exit: number; seconds: number };

export const outcomePath = (junit: string): string => `${junit.replace(/\.xml$/, "")}.json`;

export function readOutcome(path: string): Outcome | null {
	if (!existsSync(path)) return null;
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof value !== "object" || value === null || !("exit" in value) || !("seconds" in value)) return null;
		return typeof value.exit === "number" && typeof value.seconds === "number"
			? { exit: value.exit, seconds: value.seconds }
			: null;
	} catch {
		return null;
	}
}

/** The artifact a shard's job uploads its report in is named for the attempt of the run that made it. */
const artifactPrefix = (shard: string): string => `results-${shard}-attempt-`;

/**
 * Where a shard's report is, for `scripts/ci-gate.ts`. The gate job downloads every artifact of the run, each
 * into a directory of its own name. A run that was run again holds one artifact of a shard for every attempt the
 * shard ran in, and the newest is the shard's report: by its number, not by which file was written last (issue
 * #124). A shard that did not run again has only the artifact of the attempt it ran in. With no artifact of the
 * shard there, its files are looked for in `directory` itself.
 */
export function newestAttempt(directory: string, shard: string): { directory: string; attempt: number | null } {
	const prefix = artifactPrefix(shard);
	let newest: number | null = null;
	for (const entry of existsSync(directory) ? readdirSync(directory, { withFileTypes: true }) : []) {
		const attempt = entry.name.startsWith(prefix) ? entry.name.slice(prefix.length) : "";
		if (entry.isDirectory() && /^[1-9]\d*$/.test(attempt)) newest = Math.max(newest ?? 0, Number(attempt));
	}
	return newest === null
		? { directory, attempt: null }
		: { directory: join(directory, `${prefix}${newest}`), attempt: newest };
}

/** The slowest files of a run, from the timings Bun wrote. */
export function slowest(timings: unknown, count: number): { file: string; seconds: number }[] {
	if (typeof timings !== "object" || timings === null || !("files" in timings)) return [];
	const files = timings.files;
	if (typeof files !== "object" || files === null) return [];
	return Object.entries(files)
		.filter((entry): entry is [string, number] => typeof entry[1] === "number")
		.sort((a, b) => b[1] - a[1])
		.slice(0, count)
		.map(([file, ms]) => ({ file, seconds: ms / 1000 }));
}
