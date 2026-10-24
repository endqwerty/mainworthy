// What the check runs and when its duration warrants a warning. One place, read by `scripts/check.ts`, `scripts/ci-gate.ts`,
// the browser tests' set-up and `test/check.test.ts`.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism, loadavg } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Glob } from "bun";
import type { LaunchOptions } from "playwright-core";
import type { ResultIn } from "../src/core/ops.ts";

/** Static checks shared by the local runner and the CI static job. */
export const STATIC_CHECKS = [
	{ name: "typecheck", args: ["run", "typecheck"] },
	{ name: "lint", args: ["run", "lint"] },
	{ name: "async-port", args: ["scripts/async-port.ts", "--check"] },
] as const;

/** Per-file weights in milliseconds. Shards are balanced by them; the slowest files start first. */
export const TIMINGS = "scripts/test-timings.json";

const TIMINGS_VERSION = 1;

// Loaded before preflight: this boundary cannot depend on an installed package.
export function readTimings(value: unknown): Record<string, number> {
	if (
		typeof value !== "object" ||
		value === null ||
		!("version" in value) ||
		value.version !== TIMINGS_VERSION ||
		!("files" in value) ||
		typeof value.files !== "object" ||
		value.files === null ||
		Array.isArray(value.files)
	)
		throw new Error("Expected version-1 test timings with a files object");
	const files: Record<string, number> = {};
	for (const [file, ms] of Object.entries(value.files)) {
		if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) throw new Error(`Invalid test timing for ${file}`);
		files[file] = ms;
	}
	return files;
}

/** Both local recording and CI import write the format Bun reads, in descending order with integer milliseconds. */
export function writeTimings(path: string, durations: Readonly<Record<string, number>>): void {
	const files = Object.fromEntries(
		Object.entries(readTimings({ version: TIMINGS_VERSION, files: durations }))
			.sort(([a, msA], [b, msB]) => msB - msA || a.localeCompare(b))
			.map(([file, ms]) => [file, Math.round(ms)]),
	);
	writeFileSync(path, `${JSON.stringify({ version: TIMINGS_VERSION, files }, null, 2)}\n`);
}

/** Elapsed-time assertions run serially on a dedicated CI runner or explicitly on an idle local machine. */
export const PERFORMANCE = [
	"test/demo-removal-budget.test.ts",
	"test/archive-latency.test.ts",
	"test/report-latency.test.ts",
	"test/policy-latency.test.ts",
	"test/e2e/latency-10000.test.ts",
	"test/e2e/latency-2000.test.ts",
	"test/budgets-performance.test.ts",
	"src/surfaces/formats/junit-performance.test.ts",
	"src/core/signature-performance.test.ts",
];

/**
 * How many workers the parallel phase has: half the threads the machine has free, so a check alone keeps its speed
 * and several worktrees checking at once share the machine without a lock. Never more than half the threads (a
 * browser test is a test process, a server and a browser; on the 16-thread desktop, 2026-10-12: 6 workers 79 s,
 * 8 workers 70 s, 16 workers 81 s with tests running out of time), and never fewer than two, which four
 * concurrent checks passed with (#902). The load average trails new work by about a minute.
 */
export const parallelWorkers = (cores = availableParallelism(), load = loadavg()[0] ?? 0): number => {
	const most = Math.max(1, Math.floor(cores / 2));
	return Math.min(most, Math.max(Math.min(2, most), Math.floor((cores - load) / 2)));
};

/** Whole-suite durations only warn, by the owner's decision 0097; issue #77 tracks a future timing gate. */
export const CHECK_WARNING_SECONDS = 130;

/** The shards the workflow splits the parallel phase into; `.github/workflows/check.yml` lists as many. */
export const CI_SHARDS = 6;

/** The existing CI warning threshold. Elapsed time does not change the gate's verdict (decision 0097). */
export const CI_SHARD_WARNING_SECONDS = 180;

export const seconds = (value: number): string => `${value.toFixed(1)} s`;

export type Phase = "parallel" | "performance";

export function chromiumLaunchOptions(executablePath: string, args: string[] = []): LaunchOptions {
	return {
		executablePath,
		headless: true,
		args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", ...args],
	};
}

/** Each Bun worker borrows one runner-owned browser; lifecycle and launch-option tests keep their own. */
export function sharedBrowserEndpoint(
	file: string,
	env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
	const endpoints = env.MAINWORTHY_E2E_BROWSER_ENDPOINTS;
	if (!endpoints || env.MAINWORTHY_E2E_CPU_THROTTLE || /(^|\/)test\/e2e\/(browser|followups)\.test\.ts$/.test(file))
		return undefined;
	const worker = Number(env.BUN_TEST_WORKER_ID ?? "1");
	const endpoint = Number.isInteger(worker) && worker > 0 ? endpoints.split("\n")[worker - 1] : undefined;
	if (!endpoint) throw new Error(`No shared Chromium endpoint for Bun worker ${env.BUN_TEST_WORKER_ID ?? "1"}`);
	return endpoint;
}

/** Build once for any phase that may run a browser test. Bun chooses a shard's files. */
export function needsBrowserFixture(phases: readonly Phase[], shard?: string, files?: readonly string[]): boolean {
	return phases.some((phase) => {
		const selected = phaseFiles(phase, shard, files);
		return selected === null || selected.some((file) => file.startsWith("test/e2e/"));
	});
}

/** Production's compile flags with the test fixture. */
export function fixtureBuildArgs(outfile: string, root = process.cwd()): string[] {
	const output = resolve(outfile);
	return [
		"build",
		// Bun writes its temporary .bun-build file in cwd, even with an absolute outfile.
		"--cwd",
		dirname(output),
		"--compile",
		"--minify",
		"--sourcemap",
		// The fixture is outside src; keep the same source root as the production build.
		`--root=${resolve(root, "src")}`,
		"--banner",
		"/*! Mainworthy, Apache-2.0. Software from others is in this file; its licences and notices: /docs/licence */",
		resolve(root, "test/e2e/serve.ts"),
		"--outfile",
		output,
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
	const workers = phase === "performance" ? 1 : (options.workers ?? parallelWorkers());
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
			: phase === "performance"
				? PERFORMANCE.map((file) => `./${file}`)
				: [
						...PERFORMANCE.map((file) => `--path-ignore-patterns=${file}`),
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
export function slowest(
	timings: unknown,
	count: number,
	selected?: readonly string[],
): { file: string; seconds: number }[] {
	if (typeof timings !== "object" || timings === null || !("files" in timings)) return [];
	const files = timings.files;
	if (typeof files !== "object" || files === null) return [];
	return Object.entries(files)
		.filter(([file]) => selected === undefined || selected.includes(file))
		.filter((entry): entry is [string, number] => typeof entry[1] === "number")
		.sort((a, b) => b[1] - a[1])
		.slice(0, count)
		.map(([file, ms]) => ({ file, seconds: ms / 1000 }));
}

/**
 * The Chromium playwright-core is built for: its headless shell, which `bun run browser` installs. Under load
 * the full Chromium builds crashed, the system's and Playwright's, and the headless shell did not (decision 0114,
 * issue #469). playwright-core names the path only in its registry, which it does not type; `test/check.test.ts`
 * holds it to the revision in `browsers.json`, so an upgrade that moves it says so.
 */
export function playwrightChromium(): string | null {
	const { registry } = require("playwright-core/lib/coreBundle") as {
		registry?: { registry?: { findExecutable?: (name: string) => { executablePath: () => string | undefined } } };
	};
	return registry?.registry?.findExecutable?.("chromium-headless-shell").executablePath() ?? null;
}

/**
 * The Chromium the browser tests start: the one `MAINWORTHY_CHROMIUM` names, else Playwright's. With none, the
 * tests are skipped and `skipped` says what to do, in one line: each browser test file prints it, and the check
 * says it again at its end, where a run of nothing but skipped tests would otherwise read as a pass of them.
 */
export function findChromium(
	env: Readonly<Record<string, string | undefined>> = process.env,
	exists: (path: string) => boolean = existsSync,
	playwright: string | null = playwrightChromium(),
): { path: string } | { path: null; skipped: string } {
	const named = env.MAINWORTHY_CHROMIUM;
	const path = [named, playwright].find((candidate) => candidate && exists(candidate));
	if (path) return { path };
	return {
		path: null,
		skipped: [
			...(named ? [`MAINWORTHY_CHROMIUM names ${named}, which is not there.`] : []),
			`Playwright's Chromium is not installed${playwright ? ` at ${playwright}` : ""}: run \`bun run browser\` to run the browser tests.`,
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
	if (only) return [...only].filter((file) => PERFORMANCE.includes(file) === (phase === "performance")).sort();
	if (phase === "performance") return PERFORMANCE;
	if (shard) return null;
	const files = [...new Glob("{src,test}/**/*.test.{ts,tsx}").scanSync(".")];
	return files.filter((file) => !PERFORMANCE.includes(file)).sort();
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

/** Parse and validate the check command before it starts any work. */
export function parseCheckArgs(argv: string[]) {
	const testsOnly = argv[0] === "test";
	const flags = new Map<string, string>();
	const files: string[] = [];
	for (const arg of argv.slice(testsOnly ? 1 : 0)) {
		if (testsOnly && !arg.startsWith("-")) {
			files.push(arg.replace(/^\.\//, ""));
			continue;
		}
		const match = /^--(shard|only|junit|workers)=(.+)$/.exec(arg) ?? /^--(update-timings)()$/.exec(arg);
		if (!match?.[1] || (!testsOnly && !["update-timings", "workers"].includes(match[1]))) {
			throw new Error(
				`check: unknown argument ${arg}. One file is \`bun test <file>\`; scripts/check.ts lists the rest.`,
			);
		}
		flags.set(match[1], match[2] ?? "");
	}
	const only = flags.get("only");
	if (only !== undefined && only !== "parallel" && only !== "performance") {
		throw new Error("check: --only is parallel or performance");
	}
	const junit = flags.get("junit");
	if (junit !== undefined && (only === undefined || !junit.endsWith(".xml"))) {
		throw new Error("check: --junit names an .xml file and needs --only, one report for each phase");
	}
	const shard = flags.get("shard");
	// A phase given no file would run every file: each named file is a test of this checkout and of the phase named.
	const notTests = files.filter((file) => !/^(src|test)\/.+\.test\.tsx?$/.test(file) || !existsSync(file));
	const otherPhase = files.filter((file) => PERFORMANCE.includes(file) !== (only === "performance"));
	if (
		notTests.length > 0 ||
		(files.length > 0 && (only === undefined || shard !== undefined)) ||
		otherPhase.length > 0
	) {
		throw new Error(
			notTests.length > 0
				? `check: not a test file of this checkout: ${notTests.join(", ")}`
				: otherPhase.length > 0
					? `check: not a file of the ${only} phase (PERFORMANCE in scripts/check-plan.ts): ${otherPhase.join(", ")}`
					: "check: test files are named with --only and without --shard, one phase at a time",
		);
	}
	const chosen = files.length > 0 ? files : undefined;
	// Local recording measures every file alone. CI imports can refresh the same weights from JUnit reports.
	const record = flags.has("update-timings");
	const workers = flags.has("workers") ? Number(flags.get("workers")) : record ? 1 : undefined;
	if (workers !== undefined && !(Number.isInteger(workers) && workers > 0)) {
		throw new Error("check: --workers is a positive number");
	}
	if (only === "performance" && workers !== undefined && workers !== 1)
		throw new Error("check: performance runs with one worker");
	const phases: Phase[] = only ? [only] : record && shard === undefined ? ["parallel", "performance"] : ["parallel"];
	return { testsOnly, junit, shard, chosen, record, workers, phases, flags };
}
