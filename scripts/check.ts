// The check: the type-check, the lint and the tests side by side, the test files in parallel workers, then the
// tests that measure time on a machine that runs nothing else. Prints the wall time of each part and warns
// about slow runs (`scripts/check-plan.ts`); elapsed time alone does not fail the check.
//
//   bun scripts/check.ts                      everything (`bun run check`)
//   bun scripts/check.ts test                 the tests only, output as it comes (`bun run test`)
//   bun scripts/check.ts test --shard=2/6     one share of the parallel phase
//   bun scripts/check.ts test --only=quiet    one phase: parallel or quiet
//   bun scripts/check.ts test --workers=4     that many workers in the parallel phase
//   bun scripts/check.ts test --update-timings     record scripts/test-timings.json: every file alone, six minutes
//   bun scripts/check.ts test --only=parallel --shard=2/6 --junit=test-results/tests-2.xml     a CI shard
//   bun scripts/check.ts test --only=parallel test/docs.test.ts test/architecture.test.ts     those files of a phase,
//                                             as CI runs the ones a change needs (`scripts/ci-scope.ts`)
//
// One file is `bun test <file>`; this is for the whole suite.
//
// It ends with what a reader needs and the output above it does not put in one place: each test that failed, and
// whether the browser tests ran. On a machine that cannot run the tests it says why and runs nothing
// (`scripts/preflight.ts`).
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { BrowserServer } from "playwright-core";
import {
	CHECK_WARNING_SECONDS,
	chromiumLaunchOptions,
	failureLines,
	findChromium,
	fixtureBuildArgs,
	needsBrowserFixture,
	type Outcome,
	outcomePath,
	type Phase,
	parallelWorkers,
	parseCheckArgs,
	phaseFiles,
	phaseReport,
	quietWorkers,
	seconds,
	slowest,
	TIMINGS,
	testArgs,
	testReaders,
	writeTimings,
} from "./check-plan.ts";
import { requireReady } from "./preflight.ts";

requireReady("check");

const { testsOnly, junit, shard, chosen, record, workers, phases, flags } = (() => {
	try {
		return parseCheckArgs(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exit(4);
	}
})();
const everyFile = phases.length === 2;
// Warn about the whole suite with its own number of workers.
const whole = everyFile && workers === undefined;

const scratch = mkdtempSync(join(tmpdir(), "mainworthy-check-"));
const timings = join(scratch, "timings.json");
if (existsSync(TIMINGS)) copyFileSync(TIMINGS, timings);
const children = new Set<Bun.Subprocess>();
const browsers = new Set<BrowserServer>();
let browserFailed = false;
async function closeBrowsers(): Promise<void> {
	await Promise.all(
		[...browsers].map(async (browser) => {
			browsers.delete(browser);
			const force = setTimeout(() => void browser.kill(), 5_000);
			try {
				await browser.close();
			} catch (error) {
				browserFailed = true;
				console.error("check: shared Chromium shutdown failed", error);
				await browser.kill();
			} finally {
				clearTimeout(force);
			}
		}),
	);
}
let leaving: Promise<never> | undefined;
const leave = (code: number): Promise<never> => {
	leaving ??= (async () => {
		for (const child of children) child.kill("SIGTERM");
		await closeBrowsers();
		await Promise.all(
			[...children].map(async (child) => {
				const force = setTimeout(() => child.kill("SIGKILL"), 2_000);
				await child.exited;
				clearTimeout(force);
			}),
		);
		rmSync(scratch, { recursive: true, force: true });
		process.exit(code || (browserFailed ? 1 : 0));
	})();
	return leaving;
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] satisfies NodeJS.Signals[])
	process.on(signal, () => {
		void leave(130);
	});
for (const event of ["uncaughtException", "unhandledRejection"] as const)
	process.on(event, (error) => {
		console.error("check:", error);
		void leave(1);
	});

type Part = { name: string; exit: number; seconds: number; log: string | null };
type TestPart = Part & { phase: Phase; report: string };

/** Runs one command. Captured, its output goes to a file of its own; otherwise straight to the terminal. */
async function run(
	name: string,
	command: string[],
	capture: boolean,
	env: Record<string, string | undefined> = {},
): Promise<Part> {
	const log = capture ? join(scratch, `${name.replace(/\W+/g, "-")}.log`) : null;
	const out = log === null ? "inherit" : openSync(log, "w");
	const started = performance.now();
	const child = Bun.spawn(command, {
		stdin: "ignore",
		stdout: out,
		stderr: out,
		env: { ...process.env, MAINWORTHY_READERS: process.env.MAINWORTHY_READERS ?? testReaders(), ...env },
	});
	children.add(child);
	const exit = await child.exited;
	children.delete(child);
	if (typeof out === "number") closeSync(out);
	const took = (performance.now() - started) / 1000;
	console.log(`${name.padEnd(16)} ${seconds(took).padStart(8)}  ${exit === 0 ? "ok" : `FAILED (exit ${exit})`}`);
	return { name, exit, seconds: took, log };
}

async function tests(capture: boolean, fixture: string | undefined): Promise<TestPart[]> {
	const parts: TestPart[] = [];
	for (const phase of phases) {
		if (junit) mkdirSync(dirname(junit), { recursive: true }); // Bun does not create the report's directory.
		// Every phase writes a report, asked for or not: the failed tests are listed from it at the end. One left by
		// an earlier run goes first, so that a runner that stops before it writes leaves none.
		const report = junit ?? join(scratch, `${phase}.xml`);
		rmSync(report, { force: true });
		const phaseWorkers = phase === "parallel" || record ? workers : undefined;
		const args = testArgs(phase, {
			shard,
			files: chosen,
			workers: phaseWorkers,
			junit: report,
			timings,
			failuresOnly: capture,
		});
		if (!capture) console.log(`\n$ bun ${args.join(" ")}`);
		try {
			const chromium = findChromium();
			const selected = phaseFiles(phase, shard, chosen);
			const slots = phaseWorkers ?? (phase === "parallel" ? parallelWorkers() : quietWorkers());
			if (fixture && chromium.path && !process.env.MAINWORTHY_E2E_CPU_THROTTLE) {
				const { chromium: launcher } = await import("playwright-core");
				for (let slot = 1; slot <= Math.min(slots, selected?.length ?? slots); slot++) {
					const browser = await launcher.launchServer({
						...chromiumLaunchOptions(chromium.path),
						host: "127.0.0.1",
						timeout: 15_000,
						handleSIGINT: false,
						handleSIGTERM: false,
						handleSIGHUP: false,
					});
					browsers.add(browser);
					browser.on("close", () => {
						if (!browsers.has(browser) || leaving) return;
						browserFailed = true;
						const child = browser.process();
						console.error(
							`check: shared Chromium slot ${slot} exited unexpectedly (exit ${child.exitCode}, signal ${child.signalCode})`,
						);
					});
				}
				console.log(`check: ${browsers.size} shared Chromium slots (${phase})`);
			}
			parts.push({
				...(await run(`tests: ${phase}`, [process.execPath, ...args], capture, {
					MAINWORTHY_E2E_SERVER: fixture,
					MAINWORTHY_E2E_BROWSER_ENDPOINTS: [...browsers].map((browser) => browser.wsEndpoint()).join("\n"),
				})),
				phase,
				report,
			});
		} finally {
			await closeBrowsers();
		}
	}
	return parts;
}

// A test run beside this one makes both slower and some tests fail for reasons outside the code.
if (whole && (await (await import("./work/processes.ts")).otherTestRuns()))
	console.log("NOTE: another test run is going on this machine. Wait for it with `bun scripts/work.ts wait-tests`.\n");
const started = performance.now();
const fixture = needsBrowserFixture(phases, shard, chosen) ? join(scratch, "browser-fixture") : undefined;
if (fixture) {
	const build = await run("browser fixture", [process.execPath, ...fixtureBuildArgs(fixture)], false, {
		NODE_ENV: "production",
	});
	if (build.exit !== 0) {
		console.error("check: browser fixture build failed; no tests ran");
		await leave(build.exit);
	}
}
const [testParts, ...staticParts] = await Promise.all([
	tests(!testsOnly, fixture),
	...(testsOnly
		? []
		: [
				run("typecheck", [process.execPath, "run", "typecheck"], true),
				run("lint", [process.execPath, "run", "lint"], true),
			]),
]);
const total = (performance.now() - started) / 1000;
const testSeconds = testParts.reduce((sum, part) => sum + part.seconds, 0);
const parts = [...staticParts, ...testParts];
const failed = parts.filter((part) => part.exit !== 0);

// What failed, whole and one part after another, at the end of the run where it is read.
for (const part of parts) {
	if (part.log === null) continue;
	const text = readFileSync(part.log, "utf8").trimEnd();
	if (part.exit !== 0) console.log(`\n──── ${part.name}: FAILED (exit ${part.exit}) ────\n${text}`);
	else if (part.name.startsWith("tests")) console.log(`${part.name}: ${text.split("\n").at(-1)?.trim() ?? ""}`);
}

if (junit) {
	const outcome: Outcome = { exit: testParts[0]?.exit ?? 1, seconds: testSeconds };
	await Bun.write(outcomePath(junit), `${JSON.stringify(outcome)}\n`);
}
const measured: unknown = existsSync(timings) ? JSON.parse(readFileSync(timings, "utf8")) : null;
if (record) {
	if (everyFile && !flags.has("workers") && failed.length === 0) {
		// Bun keeps the durations it read for files this run did not have: leave out the ones that are gone.
		const files = Object.fromEntries(
			slowest(measured, Number.POSITIVE_INFINITY)
				.filter((entry) => existsSync(entry.file))
				.map((entry) => [entry.file, entry.seconds * 1000]),
		);
		writeTimings(TIMINGS, files);
		console.log(`\n${TIMINGS} holds this run's durations.`);
	} else console.log(`\n${TIMINGS} is unchanged: it is recorded from a run of every file, one at a time, that passed.`);
}

console.log("");
// A machine with no browser passes with every browser test skipped: say so where it is read.
const chromium = findChromium();
if (chromium.path === null) console.log(`NOTE: the browser tests did not run. ${chromium.skipped}\n`);
if (testParts.length > 1) console.log(`${"tests".padEnd(16)} ${seconds(testSeconds).padStart(8)}`);
console.log(`${"total".padEnd(16)} ${seconds(total).padStart(8)}`);
const slow = slowest(measured, 5).filter((entry) => existsSync(entry.file));
if (everyFile && slow.length > 0)
	console.log(`slowest files: ${slow.map((entry) => `${entry.file} ${entry.seconds.toFixed(0)} s`).join(", ")}`);

const code = failed[0]?.exit ?? 0;
if (failed.length > 0) console.log(`\nFAILED: ${failed.map((part) => part.name).join(", ")}`);
const failedPhases = testParts.filter((part) => part.exit !== 0);
if (failedPhases.length > 0) {
	// Read with Mainworthy's own reader, as the gate job reads a shard's report. Loaded here, after the run: it is
	// the one import of this script that needs the packages installed.
	const { parseJUnit } = await import("../src/surfaces/formats/junit.ts");
	const reports = failedPhases.map((part) =>
		phaseReport(
			part.name,
			existsSync(part.report) ? parseJUnit(readFileSync(part.report, "utf8")).results : null,
			phaseFiles(part.phase, shard, chosen),
		),
	);
	console.log(`\n${failureLines(reports).join("\n")}`);
}
if (whole && testSeconds > CHECK_WARNING_SECONDS)
	console.log(
		`\nWARNING: the tests took ${seconds(testSeconds)}, above ${CHECK_WARNING_SECONDS} s. Duration is advisory (decision 0097; issue #77).`,
	);

await leave(code);
