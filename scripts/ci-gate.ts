// The last job of the check workflow: every shard's results go to one Mainworthy, and Mainworthy's gate is the
// job's result. Mainworthy knows only what it was told, so this also refuses what a gate cannot see: a shard that
// left no report, a shard whose tests exited with a failure its report does not show, a test file that is in no
// shard's report (it did not load, or no shard was given it), a test file whose tests were all skipped (a
// runner with no browser skips every browser test, exits 0 and writes a complete report), and a test file whose
// name is too long for a report to keep whole, because its tests cannot be told from another file's.
//
//   bun scripts/ci-gate.ts <directory> <shard>... [--files=<file>,<file>...]        from the repository's root
//
// `--files` names the test files the shards were given, when a change needed only those (`scripts/ci-scope.ts`);
// without it every test file of the checkout is expected in a report.
//
// For each shard there are two files: `<shard>.xml` (JUnit) and `<shard>.json` (what `scripts/check.ts test
// --junit` wrote beside it). In the workflow they are in the directory of the shard's artifact, one for each
// attempt of the run the shard ran in, and the newest attempt is read (`newestAttempt` in
// `scripts/check-plan.ts`); otherwise they are in the directory itself. Each report goes in under the shard's
// name as its job, or as a shard of the job `tests` for the parallel tests' shards, with the two commands a
// pipeline would run: `mainworthy report` and `mainworthy gate`.
//
// Which Mainworthy: the one MAINWORTHY_URL names when it can be used, else one started here for this run
// (`scripts/ci-instance.ts`). The run's summary says which, also when the gate passes.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import { runCli } from "../src/cli/dispatch.ts";
import { printError } from "../src/cli/errors.ts";
import { installOutputHandlers } from "../src/cli/output.ts";
import { parseJUnit, TEST_FILE_LIMIT } from "../src/surfaces/formats/junit.ts";
import { CI_SHARD_WARNING_SECONDS, newestAttempt, type Outcome, readOutcome, seconds } from "./check-plan.ts";
import {
	chooseInstance,
	deploymentFetch,
	describeChoice,
	type Environment,
	type Own,
	startOwn,
} from "./ci-instance.ts";

installOutputHandlers();

const filesFlag = process.argv.slice(2).find((arg) => arg.startsWith("--files="));
const [directory, ...shards] = process.argv.slice(2).filter((arg) => arg !== filesFlag);
const expected = filesFlag?.slice("--files=".length).split(",").filter(Boolean);
if (!directory || shards.length === 0 || shards.some((shard) => shard.startsWith("-")) || expected?.length === 0) {
	console.error("usage: bun scripts/ci-gate.ts <directory> <shard>... [--files=<file>,<file>...]");
	process.exit(4);
}

const CLI = join(import.meta.dir, "../src/cli/main.ts");
// How many shards the parallel tests ran in.
const parallel = shards.filter((shard) => /^tests-\d+$/.test(shard)).length;
// The job's own Mainworthy, once there is one. It is stopped on every way out of this script: its end, an error, a
// signal. The signals are listened for before anything is started, so there is no moment at which a Mainworthy
// runs and nobody would stop it. `heard` lets a waiting signal in before the next command, also while startup
// or report parsing has been synchronous.
let own: Own | null = null;
let ownEnv: Environment = {};
process.on("exit", () => own?.stop());
for (const signal of ["SIGINT", "SIGTERM"] as const)
	process.on(signal, () => {
		own?.stop();
		process.exit(signal === "SIGINT" ? 130 : 143);
	});
const heard = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const choice = await chooseInstance(process.env);
const chosen = describeChoice(choice);
// GitHub puts a line that starts with ::notice::, ::warning:: or ::error:: on the run's summary page.
console.log(
	`::${choice.use === "none" ? "error" : choice.use === "own" && choice.warn ? "warning" : "notice"}::${chosen}`,
);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${chosen}\n`);
if (choice.use === "none") process.exit(4);

const request = deploymentFetch();
const cli = async (argv: string[]): Promise<number> => {
	console.log(`\n$ mainworthy ${argv.join(" ")}`);
	try {
		return await runCli(
			argv,
			undefined,
			{
				...process.env,
				// The project the choice settled on, also when none was named: the CLI is not left to pick one.
				...(choice.use === "deployed" ? { MAINWORTHY_PROJECT: choice.project } : {}),
				...ownEnv,
			},
			request,
		);
	} catch (error) {
		printError(error);
		return 4;
	}
};

const problems: string[] = [];
const rows: { shard: string; attempt: number | null; outcome: Outcome | null; tests: number; failed: number }[] = [];
const reported = new Set<string>();
let gate: number;
try {
	if (choice.use === "own") {
		// Held from the same turn it is spawned in: a signal that comes while it starts finds it here.
		own = startOwn(CLI);
		ownEnv = await own.ready;
	}
	for (const shard of shards) {
		await heard();
		const from = newestAttempt(directory, shard);
		const file = join(from.directory, `${shard}.xml`);
		const outcome = readOutcome(join(from.directory, `${shard}.json`));
		const text = existsSync(file) ? readFileSync(file, "utf8") : "";
		if (text.trim() === "" || outcome === null) {
			const what = text.trim() === "" ? `${file} is missing or empty` : "its outcome file is missing";
			problems.push(`${shard}: no report (${what})`);
			rows.push({ shard, attempt: from.attempt, outcome, tests: 0, failed: 0 });
			continue;
		}
		const results = parseJUnit(text, { file }).results;
		const failed = results.filter((result) => result.outcome === "fail" || result.outcome === "error").length;
		rows.push({ shard, attempt: from.attempt, outcome, tests: results.length, failed });
		for (const suite of text.matchAll(/<testsuite\b[^>]*\bfile="([^"]+)"/g)) reported.add(suite[1] ?? "");
		// A skipped test proves nothing, and one skipped test beside others that ran is somebody's decision. A file
		// in which nothing ran is a file that was not tested.
		// Counted from the results as Mainworthy's own reader understands the report, so the job and the gate read one
		// report one way: text inside a test's output is not a test, and a test takes its suite's file when it
		// names none.
		const ran = new Map<string, { tests: number; skipped: number }>();
		for (const result of results) {
			const name = ("file" in result.test ? result.test.file : undefined) ?? "";
			const count = ran.get(name) ?? { tests: 0, skipped: 0 };
			count.tests++;
			if (result.outcome === "skip") count.skipped++;
			ran.set(name, count);
		}
		for (const [name, count] of ran) {
			if (count.skipped === count.tests)
				problems.push(`${shard}: every test of ${name || "a suite that names no file"} was skipped (${count.tests})`);
			// The reader cut this name short, or may have. Two files whose names begin alike are then one entry
			// here, and a file in which nothing ran is counted with one that ran (issue #82). Refused, not guessed.
			if (name.length >= TEST_FILE_LIMIT)
				problems.push(
					`${shard}: a test file's name is ${TEST_FILE_LIMIT} characters or longer, and a report keeps the first ${TEST_FILE_LIMIT} (${name.slice(0, 80)}...)`,
				);
		}
		if (results.length === 0) problems.push(`${shard}: its report holds no test`);
		if (outcome.exit !== 0 && failed === 0)
			problems.push(`${shard}: the tests exited ${outcome.exit} and the report shows no failure`);
		// The parallel tests run as shards of one job, `tests-1` to `tests-<n>`: each is reported as that shard of `tests`,
		// so the gate of the commit waits for all of them (decision 0092). A runner of chosen files is the whole job.
		const index = /^tests-(\d+)$/.exec(shard)?.[1];
		const exit = await cli([
			"report",
			file,
			...(index ? ["--job", "tests", "--shard", `${index}/${parallel}`] : ["--job", shard]),
		]);
		if (exit !== 0) problems.push(`${shard}: mainworthy report exited ${exit}`);
	}

	await heard();
	gate = await cli(["gate"]);
	await heard();
} finally {
	own?.stop();
}

const unreported = (expected ?? [...new Glob("{src,test}/**/*.test.{ts,tsx}").scanSync(".")])
	.filter((file) => !reported.has(file))
	.sort();
if (unreported.length > 0) problems.push(`in no shard's report: ${unreported.join(", ")}`);

// The attempt is the one of the run whose report the row is: a shard that did not run again keeps its own.
console.log("\nShard            attempt  tests  failed  exit      wall");
for (const row of rows) {
	const cells = [row.tests, row.failed, row.outcome?.exit ?? "-", row.outcome ? seconds(row.outcome.seconds) : "-"];
	console.log(
		`${row.shard.padEnd(16)} ${String(row.attempt ?? "-").padStart(7)}  ${String(cells[0]).padStart(5)}  ${String(cells[1]).padStart(6)}  ${String(cells[2]).padStart(4)}  ${String(cells[3]).padStart(8)}`,
	);
}
const longest = Math.max(0, ...rows.map((row) => row.outcome?.seconds ?? 0));
if (longest > CI_SHARD_WARNING_SECONDS)
	console.log(
		`::warning::the slowest shard's tests took ${seconds(longest)}, above ${CI_SHARD_WARNING_SECONDS} s. Duration is advisory (decision 0097; issue #77).`,
	);

for (const problem of problems) console.log(`::error::${problem}`);
console.log(`\n${chosen}`);
if (gate !== 0) {
	console.log(`The gate did not pass (exit ${gate}).`);
	// The session that pushed the commit fixes it; this is how it reads what failed (scripts/work/ci.ts).
	const pr = /^refs\/pull\/(\d+)\//.exec(process.env.GITHUB_REF ?? "")?.[1];
	if (choice.use === "deployed")
		console.log(`What failed, from the instance: bun scripts/work.ts ci ${pr ?? process.env.GITHUB_SHA ?? ""}`.trim());
} else if (problems.length > 0) console.log("The gate passed on what it was told, and that was not everything.");
process.exit(gate !== 0 ? gate : problems.length > 0 ? 1 : 0);
