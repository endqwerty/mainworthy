// After the check workflow failed, the jobs a test failing by chance could have failed run once more, one after the
// other (`.github/workflows/rerun.yml`, decision 0128). Mainworthy is told the retry as the next attempt of the same
// commit: a test that passes then has flipped, which its results and its page show as flaky, and the gate counts the
// retry. A test that fails again is a failure to fix.
//
//   bun scripts/ci-rerun.ts <run id> [--dry-run]        with GH_TOKEN and GH_REPO as `gh` reads them
//
// What runs again: each test shard whose report holds a failing test, and any other job that failed apart from the
// ones that fail the same way every time (`STEADY`). Nothing runs again when one of those failed, because the run
// cannot pass then, or when more than `MOST` jobs would: that many is a broken commit, and a retry would only put off
// saying so. The gate runs again after each job by itself, because it needs them. When only the gate failed, with no
// failing test, the gate runs again alone: what it reads (the deployed Mainworthy, the artifacts) may have been out
// of reach. Only a run's first attempt is run again: a run that ran again, by this or by a person, is left as it is.
//
// One job at a time, because GitHub runs a job again only in a run that has finished, and a shard's job passes when
// its tests fail (the gate judges them), so "re-run failed jobs" would run the gate alone. `--dry-run` says what it
// would run again and runs nothing.
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJUnit } from "../src/surfaces/formats/junit.ts";
import { newestAttempt } from "./check-plan.ts";

/** Jobs that fail the same way every time they run on a commit: the scope, the type-check and lint, the description. */
export const STEADY: ReadonlySet<string> = new Set(["scope", "static", "description"]);
/** The most jobs run again: a third of the test shards. More failing than that is not a test failing by chance. */
export const MOST = 3;
/** How long one job's retry may take, the gate after it included, before the rest are left. */
const WAIT_MS = 45 * 60_000;

export type Shard = { name: string; failed: number };
export type Job = { id: number; name: string; conclusion: string | null };

/** Which jobs of a failed first attempt run again, and why, in a sentence for the run's summary. */
export function chooseRerun(shards: readonly Shard[], jobs: readonly Job[]): { rerun: string[]; why: string } {
	const tests = shards.filter((shard) => shard.failed > 0).map((shard) => shard.name);
	const others = jobs
		.filter(
			(job) =>
				job.conclusion === "failure" && !STEADY.has(job.name) && job.name !== "gate" && !tests.includes(job.name),
		)
		.map((job) => job.name)
		.sort();
	const rerun = [...new Set([...tests, ...others])];
	const steady = jobs.filter((job) => job.conclusion === "failure" && STEADY.has(job.name));
	// The run cannot pass then, whatever a retry shows, and the commit that fixes it tests the rest again.
	if (steady.length > 0)
		return {
			rerun: [],
			why: `nothing runs again: ${steady.map((job) => job.name).join(", ")} failed, which fails the same way every time`,
		};
	if (rerun.length === 0)
		return jobs.some((job) => job.name === "gate" && job.conclusion === "failure")
			? {
					rerun: ["gate"],
					why: "only the gate failed, with no failing test: running it again once, in case what it reads was out of reach",
				}
			: { rerun, why: "nothing runs again: no job failed" };
	if (rerun.length > MOST)
		return {
			rerun: [],
			why: `nothing runs again: ${rerun.length} jobs failed (${rerun.join(", ")}), more than ${MOST}, which is more than a test failing by chance`,
		};
	return { rerun, why: `running again once, one after the other: ${rerun.join(", ")}` };
}

/** Each shard's report among a run's downloaded artifacts, as the gate reads them, with how many of its tests failed. */
export function readShards(directory: string): Shard[] {
	const names = new Set<string>();
	for (const entry of existsSync(directory) ? readdirSync(directory) : []) {
		const match = /^results-(.+)-attempt-[1-9]\d*$/.exec(entry);
		if (match?.[1]) names.add(match[1]);
	}
	return [...names].sort().map((name) => {
		const file = join(newestAttempt(directory, name).directory, `${name}.xml`);
		const text = existsSync(file) ? readFileSync(file, "utf8") : "";
		const results = text.trim() === "" ? [] : parseJUnit(text, { file }).results;
		return { name, failed: results.filter((r) => r.outcome === "fail" || r.outcome === "error").length };
	});
}

/** `gh` with these arguments, its standard output; it throws when `gh` fails. */
export type Gh = (args: string[]) => Promise<string>;
type Run = { run_attempt: number; status: string; conclusion: string | null };

export async function rerunFailed(
	runId: string,
	options: { gh: Gh; dryRun?: boolean; sleep?: (ms: number) => Promise<void>; now?: () => number; pollMs?: number },
): Promise<{ lines: string[]; exit: number }> {
	const { gh } = options;
	const sleep = options.sleep ?? Bun.sleep;
	const now = options.now ?? Date.now;
	const run = async (): Promise<Run> =>
		JSON.parse(await gh(["api", `repos/{owner}/{repo}/actions/runs/${runId}`])) as Run;
	const jobs = async (): Promise<Job[]> =>
		(
			JSON.parse(await gh(["api", `repos/{owner}/{repo}/actions/runs/${runId}/jobs?per_page=100`])) as {
				jobs: Job[];
			}
		).jobs;

	const first = await run();
	if (first.run_attempt !== 1 && !options.dryRun)
		return {
			lines: [`run ${runId} is at attempt ${first.run_attempt}: it ran again already, so it is left as it is`],
			exit: 0,
		};

	const directory = await mkdtemp(join(tmpdir(), "ci-rerun-"));
	let chosen: { rerun: string[]; why: string };
	try {
		// A run whose shards all failed before they uploaded a report has none, and `gh run download` fails on that:
		// its jobs still say what failed. So the artifacts are listed first, and downloaded only when there are some.
		const { artifacts } = JSON.parse(
			await gh(["api", `repos/{owner}/{repo}/actions/runs/${runId}/artifacts?per_page=100`]),
		) as { artifacts: { name: string; expired: boolean }[] };
		if (artifacts.some((artifact) => artifact.name.startsWith("results-") && !artifact.expired))
			await gh(["run", "download", runId, "--pattern", "results-*", "--dir", directory]);
		chosen = chooseRerun(readShards(directory), await jobs());
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
	const lines = [`run ${runId}: ${chosen.why}`];
	if (options.dryRun || chosen.rerun.length === 0) return { lines, exit: 0 };

	let attempt = first.run_attempt;
	for (const name of chosen.rerun) {
		const job = (await jobs()).find((entry) => entry.name === name);
		if (!job) {
			lines.push(`${name}: no such job in the run's latest attempt, so it did not run again`);
			continue;
		}
		await gh(["api", "--method", "POST", `repos/{owner}/{repo}/actions/jobs/${job.id}/rerun`]);
		const deadline = now() + WAIT_MS;
		let latest = await run();
		while (!(latest.run_attempt > attempt && latest.status === "completed")) {
			if (now() >= deadline) {
				lines.push(`${name}: its retry did not finish in ${WAIT_MS / 60_000} minutes, so the rest did not run again`);
				return { lines, exit: 1 };
			}
			await sleep(options.pollMs ?? 20_000);
			latest = await run();
		}
		attempt = latest.run_attempt;
		lines.push(`${name}: ran again as attempt ${attempt}; the run is now ${latest.conclusion ?? "unknown"}`);
	}
	return { lines, exit: 0 };
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const runId = args.find((arg) => !arg.startsWith("--"));
	if (!runId || !/^\d+$/.test(runId) || args.some((arg) => arg.startsWith("--") && arg !== "--dry-run")) {
		console.error("usage: bun scripts/ci-rerun.ts <run id> [--dry-run]");
		process.exit(4);
	}
	const gh: Gh = async (argv) => {
		const done = Bun.spawnSync(["gh", ...argv], { stdout: "pipe", stderr: "pipe" });
		if (done.exitCode !== 0) throw new Error(`gh ${argv.join(" ")}: ${done.stderr.toString().trim()}`);
		return done.stdout.toString();
	};
	const { lines, exit } = await rerunFailed(runId, { gh, dryRun: args.includes("--dry-run") });
	for (const line of lines) console.log(line);
	if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n\n")}\n`);
	process.exit(exit);
}
