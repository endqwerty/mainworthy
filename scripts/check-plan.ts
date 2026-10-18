// What the check runs and when its duration warrants a warning. One place, read by `scripts/check.ts`, `scripts/ci-gate.ts`,
// the browser tests' set-up and `test/check.test.ts`.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { Glob } from "bun";
import type { ResultIn } from "../src/core/ops.ts";

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
	"test/demo-removal-budget.test.ts",
	"test/archive-latency.test.ts",
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
 * less two, up to eight (`src/server/readers.ts`), and the browser tests start several hundred servers. Each
 * thread loads the whole operation registry, which is about 110 ms of CPU, and a server that gets as far as a page
 * has used about 540 ms in all: on the 16-thread desktop the eight threads were 38% of the CPU time of the longest
 * browser file (121 CPU-seconds; 76 with two), and each thread of the two that are left is 0.11 s of a server's 0.54
 * (measured 2026-10-13, 255 servers in the parallel phase). One is still a pool, so a read still leaves the
 * server's thread. The tests about the pool itself name their own count.
 */
export const testReaders = (): string => "1";

/** Whole-suite durations only warn, by the owner's decision 0097; issue #77 tracks a future timing gate. */
export const CHECK_WARNING_SECONDS = 130;

/** The shards the workflow splits the parallel phase into; `.github/workflows/check.yml` lists as many. */
export const CI_SHARDS = 6;

/** The existing CI warning threshold. Elapsed time does not change the gate's verdict (decision 0097). */
export const CI_SHARD_WARNING_SECONDS = 180;

export const seconds = (value: number): string => `${value.toFixed(1)} s`;

export type Phase = "parallel" | "quiet";

/** Build once for any phase that may run a browser test. Bun chooses a shard's files. */
export function needsBrowserFixture(phases: readonly Phase[], shard?: string, files?: readonly string[]): boolean {
	return phases.some((phase) => {
		const selected = phaseFiles(phase, shard, files);
		return selected === null || selected.some((file) => file.startsWith("test/e2e/"));
	});
}

/** Production's compile flags, with the test fixture and the same embedded worker paths. */
export function fixtureBuildArgs(outfile: string): string[] {
	return [
		"build",
		"--compile",
		"--minify",
		"--sourcemap",
		// The fixture is outside src, but workers resolve server/ and cli/ from the executable's root.
		"--root=src",
		"--banner",
		"/*! Mainworthy, Apache-2.0. Software from others is in this file; its licences and notices: /docs/licence */",
		"test/e2e/serve.ts",
		"src/server/read-worker.ts",
		"src/cli/demo-worker.ts",
		"--outfile",
		outfile,
	];
}

export type TestOptions = {
	/** `i/n`: the parallel phase runs only that share of its files. */
	shard?: string | undefined;
	/** Only these of the phase's files (`scripts/ci-scope.ts` chooses them for a change). */
	files?: readonly string[] | undefined;
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
		...(options.files
			? (phaseFiles(phase, undefined, options.files) ?? []).map((file) => `./${file}`)
			: phase === "quiet"
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

/** Where a Linux system keeps a Chromium. The browser tests take the first that is there. */
const SYSTEM_CHROMIUM = ["/usr/bin/chromium", "/usr/bin/google-chrome", "/usr/bin/chromium-browser"];
/**
 * Where macOS keeps one. Named in the message and not started unasked: with the browser tests the suite took
 * 148 s on the 10-thread Mac and 30 s without (2026-10-13), and a Mac's Chrome is the browser its person uses.
 */
const MAC_CHROMIUM = [
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Chromium.app/Contents/MacOS/Chromium",
];

/**
 * The Chromium the browser tests start: the one `MAINWORTHY_CHROMIUM` names, else the system's. With none, the
 * tests are skipped and `skipped` says what to set, in one line: each browser test file prints it, and the check
 * says it again at its end, where a run of nothing but skipped tests would otherwise read as a pass of them.
 */
export function findChromium(
	env: Readonly<Record<string, string | undefined>> = process.env,
	exists: (path: string) => boolean = existsSync,
): { path: string } | { path: null; skipped: string } {
	const named = env.MAINWORTHY_CHROMIUM;
	const path = [named, ...SYSTEM_CHROMIUM].find((candidate) => candidate && exists(candidate));
	if (path) return { path };
	const system = `no Chromium at ${SYSTEM_CHROMIUM.slice(0, -1).join(", ")} or ${SYSTEM_CHROMIUM.at(-1)}`;
	const here = MAC_CHROMIUM.find(exists);
	return {
		path: null,
		skipped: [
			named ? `MAINWORTHY_CHROMIUM names ${named}, which is not there, and there is ${system}.` : `There is ${system}.`,
			"Set MAINWORTHY_CHROMIUM to a Chromium or Chrome binary to run the browser tests.",
			...(here ? [`This machine has one: MAINWORTHY_CHROMIUM="${here}"`] : []),
		].join(" "),
	};
}

/** A test that failed, as the end of a run lists it. */
export type FailedTest = { file: string; name: string; why: string; at: string | null };

/**
 * The failed tests of a JUnit report, as `parseJUnit` read it: each with the first line of what it said and the
 * place it said it. A run prints a failure where it happens, between the output of the files beside it, and Bun
 * does not repeat it at the end: on 2026-10-13 five failures of `bun run test` were on lines 23 to 149 of 244.
 */
export function failedTests(results: readonly ResultIn[]): FailedTest[] {
	return results
		.filter((result) => result.outcome === "fail" || result.outcome === "error")
		.map((result) => ({
			file: ("file" in result.test ? result.test.file : undefined) ?? "a suite that names no file",
			name: ("name" in result.test ? result.test.name : undefined) ?? "a test with no name",
			why:
				result.failure?.message
					.split("\n")
					.find((line) => line.trim() !== "")
					?.trim() ?? "no message",
			at: /\bat (?:.*\()?([^\s()]+:\d+:\d+)\)?/.exec(result.failure?.detail ?? "")?.[1] ?? null,
		}));
}

/** The test files of a phase, of `only` when given, or null for a shard, whose share of them Bun chooses. */
export function phaseFiles(phase: Phase, shard?: string | undefined, only?: readonly string[]): string[] | null {
	if (only) return [...only].filter((file) => QUIET.includes(file) === (phase === "quiet")).sort();
	if (phase === "quiet") return QUIET;
	if (shard) return null;
	const files = [...new Glob("{src,test}/**/*.test.{ts,tsx}").scanSync(".")];
	return files.filter((file) => !QUIET.includes(file)).sort();
}

/** What a test phase that did not exit 0 left behind. */
export type PhaseReport = {
	name: string;
	/** The tests its report says failed; null when the runner left no report. */
	failed: readonly FailedTest[] | null;
	/** The phase's files that the report has no test of; null where its files are not known (`phaseFiles`). */
	silent: readonly string[] | null;
};

/** Reads a phase's report: what failed in it, and which of the phase's `files` it does not mention. */
export function phaseReport(
	name: string,
	results: readonly ResultIn[] | null,
	files: readonly string[] | null,
): PhaseReport {
	if (results === null) return { name, failed: null, silent: null };
	const reported = new Set(results.map((result) => ("file" in result.test ? result.test.file : undefined)));
	return { name, failed: failedTests(results), silent: files?.filter((file) => !reported.has(file)) ?? null };
}

/** How many file names a list at the end of a run holds before it says how many more there are. */
const LISTED = 10;

/** What the end of a run says about the test phases that did not exit 0. */
export function failureLines(parts: readonly PhaseReport[]): string[] {
	const lines: string[] = [];
	const failed = parts.flatMap((part) => part.failed ?? []);
	if (failed.length > 0) {
		lines.push(`${failed.length} ${failed.length === 1 ? "test" : "tests"} failed:`);
		for (const test of failed)
			lines.push(`  ${test.file}: ${test.name}`, `      ${test.why}${test.at ? ` (${test.at})` : ""}`);
		lines.push("Each is above with its whole error, under its file's name. One file alone: `bun test <file>`.");
	}
	// A file that does not load is in no report: Bun counts it as an error, not as a test, and names it once, above.
	const silent = parts.flatMap((part) => part.silent ?? []);
	if (silent.length > 0) {
		const one = silent.length === 1;
		lines.push(
			`${silent.length} test ${one ? "file" : "files"} gave no result, so no test of ${one ? "it" : "them"} ran:`,
			...silent.slice(0, LISTED).map((file) => `  ${file}`),
			...(silent.length > LISTED ? [`  and ${silent.length - LISTED} more`] : []),
			`${one ? "It" : "Each"} did not load, or the runner stopped in it: the error is above, under the file's name.`,
		);
	}
	for (const part of parts)
		if (part.failed === null)
			lines.push(
				`${part.name} left no report of its tests: the runner stopped before its end. Its last lines say why.`,
			);
		else if (part.failed.length === 0 && (part.silent ?? []).length === 0)
			lines.push(
				`${part.name} failed and no test in it did: something failed outside a test. Look above for "error:".`,
			);
	return lines;
}
