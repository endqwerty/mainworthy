// What `.github/workflows/rerun.yml` runs again after the check failed (`scripts/ci-rerun.ts`, decision 0127): the
// jobs a test failing by chance could have failed, once, one after the other.
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { chooseRerun, type Gh, type Job, MOST, rerunFailed } from "../scripts/ci-rerun.ts";

const job = (name: string, conclusion = "success", id = name.length): Job => ({ id, name, conclusion });
const passing = ["scope", "static", "image", "ios", "tests-1", "tests-2", "tests-3", "quiet"].map((name) => job(name));
const shard = (name: string, failed = 0) => ({ name, failed });

test("a shard whose test failed runs again, and so does another job that can fail by chance", () => {
	const jobs = [...passing.filter((j) => j.name !== "ios"), job("ios", "failure"), job("gate", "failure")];
	expect(chooseRerun([shard("tests-1"), shard("tests-3", 1), shard("quiet")], jobs)).toEqual({
		rerun: ["tests-3", "ios"],
		why: "running again once, one after the other: tests-3, ios",
	});
});

test("nothing runs again when a job that fails the same way every time failed", () => {
	for (const steady of ["static", "description", "scope"]) {
		const jobs = [...passing.filter((j) => j.name !== steady), job(steady, "failure"), job("gate", "failure")];
		expect(chooseRerun([shard("tests-1", 2)], jobs)).toEqual({
			rerun: [],
			why: `nothing runs again: ${steady} failed, which fails the same way every time`,
		});
	}
});

test("nothing runs again when more jobs failed than a test failing by chance explains", () => {
	const shards = Array.from({ length: MOST + 1 }, (_, i) => shard(`tests-${i + 1}`, 1));
	expect(chooseRerun(shards, [...passing, job("gate", "failure")])).toEqual({
		rerun: [],
		why: "nothing runs again: 4 jobs failed (tests-1, tests-2, tests-3, tests-4), more than 3, which is more than a test failing by chance",
	});
	expect(chooseRerun(shards.slice(0, MOST), [...passing, job("gate", "failure")]).rerun).toHaveLength(MOST);
});

test("the gate alone runs again when it alone failed, with no failing test", () => {
	expect(chooseRerun([shard("tests-1")], [...passing, job("gate", "failure")]).rerun).toEqual(["gate"]);
	expect(chooseRerun([shard("tests-1")], [...passing, job("gate")])).toEqual({
		rerun: [],
		why: "nothing runs again: no job failed",
	});
});

/** A report in the artifact a shard uploads, as `gh run download` puts it. */
function artifact(directory: string, name: string, failing: string[], attempt = 1) {
	const at = join(directory, `results-${name}-attempt-${attempt}`);
	mkdirSync(at, { recursive: true });
	const cases = ["passes", ...failing]
		.map(
			(test) =>
				`<testcase name="${test}" classname="" file="test/a.test.ts">${test === "passes" ? "" : `<failure message="boom" />`}</testcase>`,
		)
		.join("");
	writeFileSync(
		join(at, `${name}.xml`),
		`<?xml version="1.0"?><testsuites><testsuite name="test/a.test.ts" file="test/a.test.ts">${cases}</testsuite></testsuites>`,
	);
}

/**
 * A run as GitHub keeps it, through the `gh` commands the script sends: each job run again finishes after two looks,
 * as a new attempt in which the gate passes.
 */
function github(failing: Record<string, string[]>, start = 1) {
	const calls: string[] = [];
	let attempt = start;
	let looks = 0;
	let running = false;
	const jobs = () => [
		...passing.map((j, i) => ({ ...j, id: attempt * 100 + i })),
		{ id: attempt * 100 + 99, name: "gate", conclusion: attempt === start ? "failure" : "success" },
	];
	const gh: Gh = async (args) => {
		const [command, ...rest] = args;
		calls.push(args.join(" "));
		if (command === "run" && rest[0] === "download") {
			const directory = rest[rest.indexOf("--dir") + 1] ?? "";
			for (const name of ["tests-1", "tests-2", "tests-3", "quiet"]) artifact(directory, name, failing[name] ?? []);
			return "";
		}
		const path = args.at(-1) ?? "";
		if (path.endsWith("/rerun")) {
			running = true;
			looks = 0;
			return "";
		}
		if (path.includes("/jobs?")) return JSON.stringify({ jobs: jobs() });
		if (path.includes("/artifacts?"))
			return JSON.stringify({
				artifacts: ["tests-1", "tests-2", "tests-3", "quiet"].map((name) => ({
					name: `results-${name}-attempt-1`,
					expired: false,
				})),
			});
		if (running && ++looks >= 2) {
			running = false;
			attempt += 1;
		}
		return JSON.stringify({
			run_attempt: attempt,
			status: running ? "in_progress" : "completed",
			conclusion: running ? null : attempt === start ? "failure" : "success",
		});
	};
	return { gh, calls };
}

test("each chosen job runs again only once the one before it finished", async () => {
	const { gh, calls } = github({ "tests-1": ["flaky one"], quiet: ["slow one", "slower one"] });
	const slept: number[] = [];
	const done = await rerunFailed("42", { gh, sleep: async (ms) => void slept.push(ms), pollMs: 5 });
	expect(done).toEqual({
		exit: 0,
		lines: [
			"run 42: running again once, one after the other: quiet, tests-1",
			"quiet: ran again as attempt 2; the run is now success",
			"tests-1: ran again as attempt 3; the run is now success",
		],
	});
	// The job of the latest attempt is the one run again, by its id in that attempt.
	expect(calls.filter((call) => call.includes("/rerun"))).toEqual([
		"api --method POST repos/{owner}/{repo}/actions/jobs/107/rerun",
		"api --method POST repos/{owner}/{repo}/actions/jobs/204/rerun",
	]);
	expect(slept.length).toBeGreaterThan(0);
});

test("a run that ran again already is left, and a dry run says what it would run and runs nothing", async () => {
	const again = github({ "tests-2": ["x"] }, 2);
	expect(await rerunFailed("42", { gh: again.gh })).toEqual({
		exit: 0,
		lines: ["run 42 is at attempt 2: it ran again already, so it is left as it is"],
	});
	expect(again.calls.some((call) => call.includes("download") || call.includes("/rerun"))).toBe(false);

	const dry = github({ "tests-2": ["x"] });
	expect(await rerunFailed("42", { gh: dry.gh, dryRun: true })).toEqual({
		exit: 0,
		lines: ["run 42: running again once, one after the other: tests-2"],
	});
	expect(dry.calls.some((call) => call.includes("/rerun"))).toBe(false);
});

test("a run that uploaded no report is chosen from its jobs, and another failed download is an error", async () => {
	const jobs = [job("scope"), job("static"), job("tests", "failure", 7), job("gate", "failure", 9)];
	const read =
		(artifacts: string[], download: () => never): Gh =>
		async (args) => {
			if (args[0] === "run") return download();
			const path = args.at(-1) ?? "";
			if (path.includes("/jobs?")) return JSON.stringify({ jobs });
			if (path.includes("/artifacts?"))
				return JSON.stringify({ artifacts: artifacts.map((name) => ({ name, expired: false })) });
			return JSON.stringify({ run_attempt: 1, status: "completed", conclusion: "failure" });
		};
	// What `gh` says then, with no artifact at all and with others but no report; neither is asked.
	const none = read(["image-logs"], () => {
		throw new Error("gh run download 42: no valid artifacts found to download");
	});
	expect(await rerunFailed("42", { gh: none, dryRun: true })).toEqual({
		exit: 0,
		lines: ["run 42: running again once, one after the other: tests"],
	});
	const broken = read(["results-tests-attempt-1"], () => {
		throw new Error("gh run download 42: HTTP 502");
	});
	expect(rerunFailed("42", { gh: broken, dryRun: true })).rejects.toThrow("HTTP 502");
});

test("a retry that does not finish in time leaves the rest and fails the job", async () => {
	const { gh } = github({ "tests-1": ["a"], "tests-2": ["b"] });
	let clock = 0;
	const stuck: Gh = async (args) => {
		const out = await gh(args);
		return (args.at(-1) ?? "").endsWith("/runs/42") && clock > 0
			? JSON.stringify({ run_attempt: 1, status: "in_progress", conclusion: null })
			: out;
	};
	const done = await rerunFailed("42", {
		gh: stuck,
		sleep: async () => {
			clock += 60_000;
		},
		now: () => clock,
	});
	expect(done.exit).toBe(1);
	expect(done.lines.at(-1)).toBe("tests-1: its retry did not finish in 45 minutes, so the rest did not run again");
});

test("the workflow runs the script after the check failed, on its first attempt, for this repository's branches", () => {
	const text = readFileSync(".github/workflows/rerun.yml", "utf8");
	const workflow = z
		.object({
			on: z.object({ workflow_run: z.object({ workflows: z.array(z.string()), types: z.array(z.string()) }) }),
			permissions: z.record(z.string(), z.string()),
			jobs: z.object({
				rerun: z.object({
					if: z.string(),
					steps: z.array(z.object({ run: z.string().optional(), with: z.record(z.string(), z.unknown()).optional() })),
				}),
			}),
		})
		.parse(Bun.YAML.parse(text));
	const check = z
		.object({ name: z.string() })
		.parse(Bun.YAML.parse(readFileSync(".github/workflows/check.yml", "utf8")));
	expect(workflow.on.workflow_run).toEqual({ workflows: [check.name], types: ["completed"] });
	expect(workflow.permissions).toEqual({ contents: "read", actions: "write" });
	const condition = workflow.jobs.rerun.if;
	expect(condition).toContain("github.event.workflow_run.conclusion == 'failure'");
	expect(condition).toContain("github.event.workflow_run.run_attempt == 1");
	expect(condition).toContain("github.event.workflow_run.head_repository.full_name == github.repository");
	expect(workflow.jobs.rerun.steps.at(-1)?.run).toBe(
		`bun scripts/ci-rerun.ts ${"${{"} github.event.workflow_run.id }}`,
	);
	// The same Bun as the check.
	const versions = (file: string) => [...readFileSync(file, "utf8").matchAll(/bun-version: (\S+)/g)].map((m) => m[1]);
	expect(new Set(versions(".github/workflows/rerun.yml"))).toEqual(new Set(versions(".github/workflows/check.yml")));
});
