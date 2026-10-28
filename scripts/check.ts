// The check: the type-check, the lint and functional tests side by side, with bounded test workers.
// Performance tests run only when explicitly selected on an idle machine. Prints the wall time of each part and warns
// about slow runs (`scripts/check-plan.ts`); elapsed time alone does not fail the check.
//
//   bun scripts/check.ts                      functional tests without Chromium (`bun run check`)
//   bun scripts/check.ts --browser            include Chromium tests
//   bun scripts/check.ts test                 the tests only, output as it comes (`bun run test`)
//   bun scripts/check.ts test --shard=2/6     one share of the parallel phase
//   bun scripts/check.ts test --only=performance    one phase: parallel or performance
//   bun scripts/check.ts --workers=4          that many workers for this check run
//   bun scripts/check.ts test --update-timings     record scripts/test-timings.json: every file alone
//   bun scripts/check.ts test --only=parallel --shard=2/6 --junit=test-results/tests-2.xml     a CI shard
//   bun scripts/check.ts test --only=parallel test/docs.test.ts test/architecture.test.ts     those files of a phase,
//                                             as CI runs the ones a change needs (`scripts/ci-scope.ts`)
//
// One file is `bun test <file>`; this is for the whole suite.
//
// It ends with what a reader needs and the output above it does not put in one place: each test that failed, and
// whether the browser tests ran. On a machine that cannot run the tests it says why and runs nothing
// (`scripts/preflight.ts`).
import {
	appendFileSync,
	closeSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { BrowserServer } from "playwright-core";
import { budgetWarnings } from "./budget.ts";
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
	STATIC_CHECKS,
	seconds,
	slowest,
	TIMINGS,
	testArgs,
	writeTimings,
} from "./check-plan.ts";
import {
	ChromiumDiagnosticOutput,
	type ChromiumSlot,
	chromiumDiagnosticPaths,
	StderrTail,
} from "./chromium-diagnostics.ts";
import { requireReady } from "./preflight.ts";
import { ownedChildren, registerOwnedChild } from "./work/processes.ts";
import { markOwned, sweepOwned } from "./work/scratch.ts";

requireReady("check");

const { testsOnly, junit, shard, chosen, record, workers, phases, flags, browser } = (() => {
	try {
		return parseCheckArgs(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exit(4);
	}
})();
const everyFile = phases.includes("parallel") && shard === undefined && chosen === undefined;
// Warn about the whole suite with its own number of workers.
const whole = everyFile && workers === undefined;

const started = performance.now();
sweepOwned(tmpdir(), "mainworthy-check-");
const scratch = mkdtempSync(join(tmpdir(), "mainworthy-check-"));
markOwned(scratch);
process.once("exit", () => rmSync(scratch, { recursive: true, force: true }));
const databaseRuns = await import("./work/test-databases.ts");
const recoveredDatabases = await databaseRuns.recoverTestDatabases(process.cwd());
if (recoveredDatabases) console.log(`check: recovered ${recoveredDatabases} recorded test databases from an ended run`);
const databaseRun = databaseRuns.beginDatabaseRun(process.cwd());
const ownership = databaseRun.children;
const databaseReaper = databaseRuns.reapReleasedDatabases(databaseRun.directory);
const budgetReports = join(scratch, "budget-warnings");
mkdirSync(budgetReports);
let testOutcome: Outcome | undefined;
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
		// A registration remains until its supervisor has removed the data directory.
		// Leave room for that I/O on a shared machine after the 1.5-second forced-shutdown deadline.
		const deadline = Date.now() + 15_000;
		let leaked = await ownedChildren(ownership);
		while (leaked.length > 0 && Date.now() < deadline) {
			await Bun.sleep(50);
			leaked = await ownedChildren(ownership);
		}
		console.log(
			`check: ${leaked.length} owned ${leaked.length === 1 ? "child" : "children"} still alive${leaked.length ? ` (pids: ${leaked.join(", ")})` : ""}`,
		);
		let exit = code || (browserFailed || leaked.length > 0 ? 1 : 0);
		rmSync(scratch, { recursive: true, force: true });
		let reaped = 0;
		try {
			reaped = await databaseReaper.stop();
		} catch (error) {
			exit = 1;
			console.error("check: released database cleanup failed", error);
		}
		if (leaked.length === 0) {
			try {
				const peak = databaseRuns.peakDatabases(databaseRun.directory);
				const before = everyFile ? await databaseRuns.clusterDiskBytes() : null;
				const started = performance.now();
				const count = reaped + (await databaseRuns.drainRecordedDatabases(databaseRun.directory));
				const after = everyFile ? await databaseRuns.clusterDiskBytes() : null;
				console.log(
					`check: ${count} test databases removed; peak live ${peak}; final cleanup ${((performance.now() - started) / 1000).toFixed(1)} s (${reaped} removed during tests)`,
				);
				if (before !== null && after !== null)
					console.log(
						`check: PostgreSQL disk ${(before / 1024 / 1024).toFixed(1)} MiB before cleanup, ${(after / 1024 / 1024).toFixed(1)} MiB after cleanup`,
					);
				rmSync(databaseRun.directory, { recursive: true });
			} catch (error) {
				exit = 1;
				console.error(`check: database cleanup failed; records kept at ${databaseRun.directory}`, error);
			}
		} else console.error(`check: database cleanup waits for owned children; records kept at ${databaseRun.directory}`);
		console.log(`${"total".padEnd(16)} ${seconds((performance.now() - started) / 1000).padStart(8)}`);
		if (junit && testOutcome) await Bun.write(outcomePath(junit), `${JSON.stringify({ ...testOutcome, exit })}\n`);
		process.exit(exit);
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
		env: {
			...process.env,
			MAINWORTHY_TEST_CHILDREN: ownership,
			MAINWORTHY_BUDGET_REPORTS: budgetReports,
			MAINWORTHY_TEST_DATABASES: databaseRun.directory,
			...env,
		},
	});
	children.add(child);
	const unregister = await registerOwnedChild(child.pid, ownership);
	const exit = await child.exited;
	await unregister();
	children.delete(child);
	if (typeof out === "number") closeSync(out);
	const took = (performance.now() - started) / 1000;
	console.log(`${name.padEnd(16)} ${seconds(took).padStart(8)}  ${exit === 0 ? "ok" : `FAILED (exit ${exit})`}`);
	return { name, exit, seconds: took, log };
}

async function tests(capture: boolean, fixture: string | undefined): Promise<TestPart[]> {
	const parts: TestPart[] = [];
	// Sized once, so the browser slots and the test workers agree.
	const defaultWorkers = parallelWorkers();
	for (const phase of phases) {
		if (junit) mkdirSync(dirname(junit), { recursive: true }); // Bun does not create the report's directory.
		// Every phase writes a report, asked for or not: the failed tests are listed from it at the end. One left by
		// an earlier run goes first, so that a runner that stops before it writes leaves none.
		const report = junit ?? join(scratch, `${phase}.xml`);
		rmSync(report, { force: true });
		// The performance phase runs one file at a time, so it gets one browser slot whatever `--workers` says.
		const phaseWorkers = phase === "parallel" ? (workers ?? defaultWorkers) : 1;
		const args = testArgs(phase, {
			shard,
			files: chosen,
			browser,
			workers: phaseWorkers,
			junit: report,
			timings,
			failuresOnly: capture,
		});
		if (!capture) console.log(`\n$ bun ${args.join(" ")}`);
		try {
			const diagnosticSlots = new Map<number, ChromiumSlot>();
			const browserClosures: Promise<void>[] = [];
			const diagnosticDirectory = join(scratch, `${phase}-chromium`);
			mkdirSync(diagnosticDirectory);
			const browserPhase = needsBrowserFixture([phase], shard, chosen, browser);
			const chromium = browserPhase ? findChromium() : null;
			const selected = phaseFiles(phase, shard, chosen, browser);
			const slots = phaseWorkers ?? 1;
			if (browserPhase && fixture && chromium?.path && !process.env.MAINWORTHY_E2E_CPU_THROTTLE) {
				const { chromium: launcher } = await import("playwright-core");
				for (let slot = 1; slot <= Math.min(slots, selected?.length ?? slots); slot++) {
					const browser = await launcher.launchServer({
						...chromiumLaunchOptions(chromium.path, ["--enable-logging=stderr", "--log-level=1"]),
						host: "127.0.0.1",
						timeout: 15_000,
						handleSIGINT: false,
						handleSIGTERM: false,
						handleSIGHUP: false,
					});
					browsers.add(browser);
					browserClosures.push(new Promise<void>((resolve) => browser.process().once("close", () => resolve())));
					const stderr = new StderrTail();
					const diagnosticSlot: ChromiumSlot = { pid: browser.process().pid, stderr, unexpectedExit: null };
					diagnosticSlots.set(slot, diagnosticSlot);
					browser.process().on("exit", (code, signal) => {
						// A fatal exit can arrive after phase cleanup began; expected graceful/forced stops are excluded.
						if (
							leaving !== undefined ||
							(!browsers.has(browser) && (code === 0 || signal === "SIGTERM" || signal === "SIGKILL"))
						)
							return;
						diagnosticSlot.unexpectedExit = { at: new Date().toISOString(), code, signal };
					});
					browser
						.process()
						.stderr?.setEncoding("utf8")
						.on("data", (chunk: string) => {
							if (leaving !== undefined) return;
							stderr.append(chunk);
							const path = chromiumDiagnosticPaths(diagnosticDirectory, slot).stderr;
							writeFileSync(`${path}.next`, stderr.text());
							renameSync(`${path}.next`, path);
						});
					browser.on("close", () => {
						if (!browsers.has(browser) || leaving !== undefined) return;
						browserFailed = true;
						const child = browser.process();
						diagnosticSlot.unexpectedExit ??= {
							at: new Date().toISOString(),
							code: child.exitCode,
							signal: child.signalCode,
						};
						console.error(
							`check: shared Chromium slot ${slot} exited unexpectedly (exit ${child.exitCode}, signal ${child.signalCode})`,
						);
					});
				}
				console.log(`check: ${browsers.size} shared Chromium slots (${phase})`);
			}

			const part = await run(`tests: ${phase}`, [process.execPath, ...args], capture, {
				MAINWORTHY_E2E_SERVER: fixture,
				MAINWORTHY_E2E_BROWSER_ENDPOINTS: [...browsers].map((browser) => browser.wsEndpoint()).join("\n"),
				MAINWORTHY_E2E_DIAGNOSTICS: diagnosticSlots.size > 0 ? "1" : "",
				MAINWORTHY_E2E_DIAGNOSTICS_DIRECTORY: diagnosticSlots.size > 0 ? diagnosticDirectory : "",
			});
			// Finish process exit/stderr delivery before publication, including a crash racing worker teardown.
			await closeBrowsers();
			await Promise.all(browserClosures);
			if (diagnosticSlots.size > 0) {
				const diagnostics = new ChromiumDiagnosticOutput(diagnosticSlots);
				diagnostics.read(diagnosticDirectory);
				const { parseJUnit } = await import("../src/surfaces/formats/junit.ts");
				const output = diagnostics.finish(existsSync(report) ? parseJUnit(readFileSync(report, "utf8")).results : []);
				if (output) {
					if (part.log === null || part.exit === 0) process.stderr.write(output);
					else appendFileSync(part.log, output);
				}
			}
			parts.push({ ...part, phase, report });
		} finally {
			await closeBrowsers();
		}
	}
	return parts;
}

const fixture = needsBrowserFixture(phases, shard, chosen, browser) ? join(scratch, "browser-fixture") : undefined;
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
	...(testsOnly ? [] : STATIC_CHECKS.map((check) => run(check.name, [process.execPath, ...check.args], true))),
]);
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
	testOutcome = { exit: testParts[0]?.exit ?? 1, seconds: testSeconds };
}
const measured: unknown = existsSync(timings) ? JSON.parse(readFileSync(timings, "utf8")) : null;
if (record) {
	if (everyFile && phases.length === 2 && !flags.has("workers") && failed.length === 0) {
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
if (!needsBrowserFixture(phases, shard, chosen, browser))
	console.log(
		"NOTE: browser tests did not run. PR CI runs them; include them locally with `bun run check --browser`.\n",
	);
else {
	const chromium = findChromium();
	if (chromium.path === null) console.log(`NOTE: the browser tests did not run. ${chromium.skipped}\n`);
}
if (testParts.length > 1) console.log(`${"tests".padEnd(16)} ${seconds(testSeconds).padStart(8)}`);
const slow = slowest(
	measured,
	5,
	phases.flatMap((phase) => phaseFiles(phase, shard, chosen, browser) ?? []),
).filter((entry) => existsSync(entry.file));
if (everyFile && slow.length > 0)
	console.log(`slowest files: ${slow.map((entry) => `${entry.file} ${entry.seconds.toFixed(0)} s`).join(", ")}`);

const warnings = budgetWarnings(budgetReports);
if (warnings) {
	console.log(`\nBudget warnings:\n${warnings}`);
	if (process.env.GITHUB_STEP_SUMMARY)
		appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n## Budget warnings\n\n\`\`\`text\n${warnings}\n\`\`\`\n`);
}

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
			phaseFiles(part.phase, shard, chosen, browser),
		),
	);
	console.log(`\n${failureLines(reports).join("\n")}`);
}
if (whole && testSeconds > CHECK_WARNING_SECONDS)
	console.log(
		`\nWARNING: the tests took ${seconds(testSeconds)}, above ${CHECK_WARNING_SECONDS} s. Duration is advisory (decision 0097; issue #77).`,
	);

await leave(code);
