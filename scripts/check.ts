// The check: the type-check, the lint and the tests side by side, the test files in parallel workers, then the
// tests that measure time on a machine that runs nothing else. Prints the wall time of each part and holds the
// tests to a budget (`scripts/check-plan.ts`).
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
import { availableParallelism, cpus, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	failureLines,
	findChromium,
	LIMITS,
	type Outcome,
	outcomePath,
	over,
	type Phase,
	phaseFiles,
	phaseReport,
	QUIET,
	REFERENCE_THREADS,
	SHARED_CORES,
	seconds,
	slowest,
	TIMINGS,
	testArgs,
	testReaders,
} from "./check-plan.ts";
import { requireReady } from "./preflight.ts";

requireReady("check");

const argv = process.argv.slice(2);
const testsOnly = argv[0] === "test";
const flags = new Map<string, string>();
const files: string[] = [];
for (const arg of argv.slice(testsOnly ? 1 : 0)) {
	if (testsOnly && !arg.startsWith("-")) {
		files.push(arg.replace(/^\.\//, ""));
		continue;
	}
	const match = /^--(shard|only|junit|workers)=(.+)$/.exec(arg) ?? /^--(update-timings)()$/.exec(arg);
	if (!match?.[1] || (!testsOnly && match[1] !== "update-timings")) {
		console.error(`check: unknown argument ${arg}. One file is \`bun test <file>\`; scripts/check.ts lists the rest.`);
		process.exit(4);
	}
	flags.set(match[1], match[2] ?? "");
}
const only = flags.get("only");
if (only !== undefined && only !== "parallel" && only !== "quiet") {
	console.error("check: --only is parallel or quiet");
	process.exit(4);
}
const junit = flags.get("junit");
if (junit !== undefined && (only === undefined || !junit.endsWith(".xml"))) {
	console.error("check: --junit names an .xml file and needs --only, one report for each phase");
	process.exit(4);
}
const shard = flags.get("shard");
// A phase given no file would run every file: each named file is a test of this checkout and of the phase named.
const notTests = files.filter((file) => !/^(src|test)\/.+\.test\.tsx?$/.test(file) || !existsSync(file));
const otherPhase = files.filter((file) => QUIET.includes(file) !== (only === "quiet"));
if (notTests.length > 0 || (files.length > 0 && (only === undefined || shard !== undefined)) || otherPhase.length > 0) {
	console.error(
		notTests.length > 0
			? `check: not a test file of this checkout: ${notTests.join(", ")}`
			: otherPhase.length > 0
				? `check: not a file of the ${only} phase (QUIET in scripts/check-plan.ts): ${otherPhase.join(", ")}`
				: "check: test files are named with --only and without --shard, one phase at a time",
	);
	process.exit(4);
}
const chosen = files.length > 0 ? files : undefined;
// The recorded timings are each file's time with nothing beside it, which is what a CI shard gives it.
const record = flags.has("update-timings");
const workers = flags.has("workers") ? Number(flags.get("workers")) : record ? 1 : undefined;
if (workers !== undefined && !(Number.isInteger(workers) && workers > 0)) {
	console.error("check: --workers is a positive number");
	process.exit(4);
}
const phases: Phase[] = only ? [only] : shard ? ["parallel"] : ["parallel", "quiet"];
const everyFile = phases.length === 2;
// The budget is about the whole suite with its own number of workers.
const whole = everyFile && workers === undefined;

const scratch = mkdtempSync(join(tmpdir(), "mainworthy-check-"));
const timings = join(scratch, "timings.json");
if (existsSync(TIMINGS)) copyFileSync(TIMINGS, timings);
const children = new Set<Bun.Subprocess>();
const leave = (code: number): never => {
	rmSync(scratch, { recursive: true, force: true });
	process.exit(code);
};
for (const signal of ["SIGINT", "SIGTERM"] satisfies NodeJS.Signals[])
	process.on(signal, () => {
		for (const child of children) child.kill(signal);
		leave(130);
	});

type Part = { name: string; exit: number; seconds: number; log: string | null };
type TestPart = Part & { phase: Phase; report: string };

/** Cores the whole machine keeps busy over the next `ms`, whoever by. */
async function busyCores(ms: number): Promise<number> {
	const work = (): number =>
		cpus().reduce((sum, cpu) => sum + cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq, 0);
	const before = work();
	await Bun.sleep(ms);
	return (work() - before) / ms;
}

/** Runs one command. Captured, its output goes to a file of its own; otherwise straight to the terminal. */
async function run(name: string, command: string[], capture: boolean): Promise<Part> {
	const log = capture ? join(scratch, `${name.replace(/\W+/g, "-")}.log`) : null;
	const out = log === null ? "inherit" : openSync(log, "w");
	const started = performance.now();
	const child = Bun.spawn(command, {
		stdin: "ignore",
		stdout: out,
		stderr: out,
		env: { ...process.env, MAINWORTHY_READERS: process.env.MAINWORTHY_READERS ?? testReaders() },
	});
	children.add(child);
	const exit = await child.exited;
	children.delete(child);
	if (typeof out === "number") closeSync(out);
	const took = (performance.now() - started) / 1000;
	console.log(`${name.padEnd(16)} ${seconds(took).padStart(8)}  ${exit === 0 ? "ok" : `FAILED (exit ${exit})`}`);
	return { name, exit, seconds: took, log };
}

async function tests(capture: boolean): Promise<TestPart[]> {
	const parts: TestPart[] = [];
	for (const phase of phases) {
		if (junit) mkdirSync(dirname(junit), { recursive: true }); // Bun does not create the report's directory.
		// Every phase writes a report, asked for or not: the failed tests are listed from it at the end. One left by
		// an earlier run goes first, so that a runner that stops before it writes leaves none.
		const report = junit ?? join(scratch, `${phase}.xml`);
		rmSync(report, { force: true });
		const args = testArgs(phase, {
			shard,
			files: chosen,
			workers: phase === "parallel" || record ? workers : undefined,
			junit: report,
			timings,
			failuresOnly: capture,
		});
		if (!capture) console.log(`\n$ bun ${args.join(" ")}`);
		parts.push({ ...(await run(`tests: ${phase}`, [process.execPath, ...args], capture)), phase, report });
	}
	return parts;
}

// What else the machine is doing, before anything of this run starts.
const busyBefore = whole ? await busyCores(250) : 0;
const started = performance.now();
const [testParts, ...staticParts] = await Promise.all([
	tests(!testsOnly),
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
				.map((entry) => [entry.file, Math.round(entry.seconds * 1000)]),
		);
		await Bun.write(TIMINGS, `${JSON.stringify({ version: 1, files }, null, 2)}\n`);
		console.log(`\n${TIMINGS} holds this run's durations.`);
	} else console.log(`\n${TIMINGS} is unchanged: it is recorded from a run of every file, one at a time, that passed.`);
}

console.log("");
// A machine with no browser passes with every browser test skipped: say so where it is read.
const chromium = findChromium();
if (chromium.path === null) console.log(`NOTE: the browser tests did not run. ${chromium.skipped}\n`);
if (testParts.length > 1) console.log(`${"tests".padEnd(16)} ${seconds(testSeconds).padStart(8)}`);
console.log(`${"total".padEnd(16)} ${seconds(total).padStart(8)}`);
if (whole) console.log(`other work kept ${busyBefore.toFixed(1)} cores of this machine busy when the run began`);
const slow = slowest(measured, 5).filter((entry) => existsSync(entry.file));
if (everyFile && slow.length > 0)
	console.log(`slowest files: ${slow.map((entry) => `${entry.file} ${entry.seconds.toFixed(0)} s`).join(", ")}`);

let code = failed[0]?.exit ?? 0;
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
if (whole && over(testSeconds, LIMITS) !== "ok") {
	const where = `scripts/check-plan.ts; AGENTS.md: "the check's wall time is a budget"`;
	const took = `the tests took ${seconds(testSeconds)}; the budget is ${LIMITS.warn} s and the limit ${LIMITS.fail} s`;
	// The limits are for a machine that is this run's alone. This run has ended: what is busy now is other work.
	const busy = Math.max(busyBefore, await busyCores(1000));
	const small = availableParallelism() < REFERENCE_THREADS;
	if (over(testSeconds, LIMITS) === "warn") console.log(`\nWARNING: ${took} (${where}).`);
	else if (small || busy > SHARED_CORES) {
		const why = small
			? `this machine has ${availableParallelism()} threads and the limit was measured on ${REFERENCE_THREADS}`
			: `other work keeps ${busy.toFixed(1)} cores of this machine busy`;
		console.log(`\nWARNING: ${took} (${where}). Not held to the limit: ${why}.`);
	} else {
		console.log(`\nOVER BUDGET: ${took} (${where}).`);
		code ||= 1;
	}
}
leave(code);
