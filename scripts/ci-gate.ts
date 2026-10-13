// The last job of the check workflow: every shard's results go to one Casebook, and Casebook's gate is the
// job's result. Casebook knows only what it was told, so this also refuses what a gate cannot see: a shard that
// left no report, a shard whose tests exited with a failure its report does not show, a test file that is in no
// shard's report (it did not load, or no shard was given it), and a test file whose tests were all skipped (a
// runner with no browser skips every browser test, exits 0 and writes a complete report).
//
//   bun scripts/ci-gate.ts <directory> <shard>...        from the repository's root
//
// For each shard the directory holds `<shard>.xml` (JUnit) and `<shard>.json` (what `scripts/check.ts test
// --junit` wrote beside it). Each file is reported under the shard's name as its job, with the two commands a
// pipeline would run: `casebook report` and `casebook gate`.
//
// Which Casebook: the one CASEBOOK_URL names when it can be used, else one started here for this run
// (`scripts/ci-instance.ts`). The run's summary says which, also when the gate passes.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import { parseJUnit } from "../src/surfaces/formats/junit.ts";
import { CI_SHARD_LIMITS, type Outcome, over, readOutcome, seconds } from "./check-plan.ts";
import { chooseInstance, describeChoice, type Environment, type Own, startOwn } from "./ci-instance.ts";

const [directory, ...shards] = process.argv.slice(2);
if (!directory || shards.length === 0) {
	console.error("usage: bun scripts/ci-gate.ts <directory> <shard>...");
	process.exit(4);
}

const CLI = join(import.meta.dir, "../src/cli/main.ts");
// The job's own Casebook, once there is one. It is stopped on every way out of this script: its end, an error, a
// signal. The signals are listened for before anything is started, so there is no moment at which a Casebook
// runs and nobody would stop it. Every command below blocks until it is done, so a signal waits; `heard` lets a
// waiting one in, before the next command.
let own: Own | null = null;
let ownEnv: Environment = {};
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

const cli = (argv: string[]): number => {
	console.log(`\n$ casebook ${argv.join(" ")}`);
	return Bun.spawnSync([process.execPath, CLI, ...argv], {
		env: {
			...process.env,
			// The project the choice settled on, also when none was named: the CLI is not left to pick one.
			...(choice.use === "deployed" ? { CASEBOOK_PROJECT: choice.project } : {}),
			...ownEnv,
		},
		stdio: ["ignore", "inherit", "inherit"],
	}).exitCode;
};

const problems: string[] = [];
const rows: { shard: string; outcome: Outcome | null; tests: number; failed: number }[] = [];
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
		const file = join(directory, `${shard}.xml`);
		const outcome = readOutcome(join(directory, `${shard}.json`));
		const text = existsSync(file) ? readFileSync(file, "utf8") : "";
		if (text.trim() === "" || outcome === null) {
			const what = text.trim() === "" ? `${file} is missing or empty` : "its outcome file is missing";
			problems.push(`${shard}: no report (${what})`);
			rows.push({ shard, outcome, tests: 0, failed: 0 });
			continue;
		}
		const results = parseJUnit(text, { file }).results;
		const failed = results.filter((result) => result.outcome === "fail" || result.outcome === "error").length;
		rows.push({ shard, outcome, tests: results.length, failed });
		for (const suite of text.matchAll(/<testsuite\b[^>]*\bfile="([^"]+)"/g)) reported.add(suite[1] ?? "");
		// A skipped test proves nothing, and one skipped test beside others that ran is somebody's decision. A file
		// in which nothing ran is a file that was not tested.
		// Counted from the results as Casebook's own reader understands the report, so the job and the gate read one
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
		for (const [name, count] of ran)
			if (count.skipped === count.tests)
				problems.push(`${shard}: every test of ${name || "a suite that names no file"} was skipped (${count.tests})`);
		if (results.length === 0) problems.push(`${shard}: its report holds no test`);
		if (outcome.exit !== 0 && failed === 0)
			problems.push(`${shard}: the tests exited ${outcome.exit} and the report shows no failure`);
		const exit = cli(["report", file, "--job", shard]);
		if (exit !== 0) problems.push(`${shard}: casebook report exited ${exit}`);
	}

	await heard();
	gate = cli(["gate"]);
	await heard();
} finally {
	own?.stop();
}

const unreported = [...new Glob("{src,test}/**/*.test.{ts,tsx}").scanSync(".")]
	.filter((file) => !reported.has(file))
	.sort();
if (unreported.length > 0) problems.push(`in no shard's report: ${unreported.join(", ")}`);

console.log("\nShard            tests  failed  exit      wall");
for (const row of rows) {
	const cells = [row.tests, row.failed, row.outcome?.exit ?? "-", row.outcome ? seconds(row.outcome.seconds) : "-"];
	console.log(
		`${row.shard.padEnd(16)} ${String(cells[0]).padStart(5)}  ${String(cells[1]).padStart(6)}  ${String(cells[2]).padStart(4)}  ${String(cells[3]).padStart(8)}`,
	);
}
const longest = Math.max(0, ...rows.map((row) => row.outcome?.seconds ?? 0));
const budget = over(longest, CI_SHARD_LIMITS);
const slow = `the slowest shard's tests took ${seconds(longest)}`;
if (budget === "fail") problems.push(`${slow}, over the limit of ${CI_SHARD_LIMITS.fail} s (scripts/check-plan.ts)`);
if (budget === "warn")
	console.log(`::warning::${slow}, over the budget of ${CI_SHARD_LIMITS.warn} s (scripts/check-plan.ts)`);

for (const problem of problems) console.log(`::error::${problem}`);
console.log(`\n${chosen}`);
if (gate !== 0) console.log(`The gate did not pass (exit ${gate}).`);
else if (problems.length > 0) console.log("The gate passed on what it was told, and that was not everything.");
process.exit(gate !== 0 ? gate : problems.length > 0 ? 1 : 0);
