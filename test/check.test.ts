// The plan of the check (`scripts/check-plan.ts`) and what the workflow says about it. The check's own wall time
// is measured by the check (`scripts/check.ts`); this keeps the plan whole and the limit where it was set.
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import {
	CI_SHARD_LIMITS,
	CI_SHARDS,
	LIMITS,
	over,
	parallelWorkers,
	QUIET,
	quietWorkers,
	slowest,
	testArgs,
	testReaders,
} from "../scripts/check-plan.ts";

test("every test file is in exactly one phase: the quiet files, and everything but them", () => {
	for (const file of QUIET) expect(existsSync(file), `${file} is listed as quiet and is not there`).toBe(true);
	const quiet = testArgs("quiet", { timings: "t.json" });
	const parallel = testArgs("parallel", { timings: "t.json" });
	expect(quiet.filter((arg) => arg.startsWith("./"))).toEqual(QUIET.map((file) => `./${file}`));
	expect(quiet).not.toContain("src");
	expect(parallel.filter((arg) => arg.startsWith("--path-ignore-patterns="))).toEqual(
		QUIET.map((file) => `--path-ignore-patterns=${file}`),
	);
	expect(parallel.slice(-2)).toEqual(["src", "test"]);
});

test("a shard is a share of the parallel phase, with its report beside it", () => {
	const args = testArgs("parallel", { timings: "t.json", shard: "2/5", junit: "test-results/tests-2.xml" });
	expect(args).toContain("--shard=2/5");
	expect(args).toContain("--reporter=junit");
	expect(args).toContain("--reporter-outfile=test-results/tests-2.xml");
	expect(testArgs("quiet", { timings: "t.json", shard: "2/5" })).not.toContain("--shard=2/5");
});

test("the workers fit the machine: the quiet phase is alone on a small one", () => {
	expect(quietWorkers(2)).toBe(1);
	expect(quietWorkers(16)).toBeLessThanOrEqual(2);
	expect(parallelWorkers(2)).toBeGreaterThanOrEqual(1);
	expect(testArgs("quiet", { timings: "t.json" })).toContain(`--parallel=${quietWorkers()}`);
	expect(testArgs("parallel", { timings: "t.json", workers: 3 })).toContain("--parallel=3");
	expect([testReaders(2), testReaders(4), testReaders(16)]).toEqual(["1", "2", "2"]);
});

test("the check's budget is the one Daniel set, and a warning comes first", () => {
	// Raising this number is a decision about the project, like raising a hot-path budget: AGENTS.md. Daniel
	// raised it from 120 s on 2026-10-13 (scripts/check-plan.ts says why); two minutes is still the aim (#77).
	expect(LIMITS.fail).toBeLessThanOrEqual(150);
	expect(LIMITS.warn).toBeLessThan(LIMITS.fail);
	expect(CI_SHARD_LIMITS.fail).toBeLessThanOrEqual(240);
	expect(CI_SHARD_LIMITS.warn).toBeLessThan(CI_SHARD_LIMITS.fail);
	expect([over(LIMITS.warn, LIMITS), over(LIMITS.warn + 0.1, LIMITS), over(LIMITS.fail + 0.1, LIMITS)]).toEqual([
		"ok",
		"warn",
		"fail",
	]);
});

test("the workflow runs every shard of the plan and its gate reads every one of them", () => {
	const workflow = readFileSync(".github/workflows/check.yml", "utf8");
	const shards = Array.from({ length: CI_SHARDS }, (_, i) => `tests-${i + 1}`);
	for (const [i, name] of shards.entries())
		expect(workflow).toContain(`{ name: ${name}, phase: "--only=parallel --shard=${i + 1}/${CI_SHARDS}" }`);
	expect(workflow).toContain('{ name: quiet, phase: "--only=quiet" }');
	expect([...workflow.matchAll(/- \{ name: /g)]).toHaveLength(CI_SHARDS + 1);
	expect(workflow).toContain(`run: bun scripts/ci-gate.ts test-results ${shards.join(" ")} quiet\n`);
});

test("the workflow gives the pipeline's token to the one step that reports, and that step chooses the Mainworthy", () => {
	const Step = z.object({ name: z.string().optional(), env: z.record(z.string(), z.string()).optional() });
	const Job = z.object({
		permissions: z.record(z.string(), z.string()).optional(),
		env: z.unknown().optional(),
		steps: z.array(Step),
	});
	const workflow = z
		.object({
			permissions: z.record(z.string(), z.string()),
			env: z.unknown().optional(),
			jobs: z.record(z.string(), Job),
		})
		.parse(Bun.YAML.parse(readFileSync(".github/workflows/check.yml", "utf8")));
	const holders = Object.entries(workflow.jobs).flatMap(([job, { steps }]) =>
		steps.filter((step) => JSON.stringify(step.env ?? {}).includes("secrets.")).map((step) => `${job}: ${step.name}`),
	);
	expect(holders).toEqual(["gate: Report every shard to Mainworthy, then the gate"]);
	// No secret in an environment every step of a job or of the workflow would share.
	expect([workflow.env, ...Object.values(workflow.jobs).map((job) => job.env)]).toEqual([
		undefined,
		undefined,
		undefined,
		undefined,
	]);
	// Only the gate job may ask GitHub who it is (to join the tailnet); the jobs that run the tests may not.
	expect(workflow.permissions).toEqual({ contents: "read" });
	expect(
		Object.entries(workflow.jobs)
			.filter(([, job]) => job.permissions)
			.map(([name, job]) => [name, job.permissions]),
	).toEqual([["gate", { contents: "read", "id-token": "write" }]]);
	// The choice of instance is the script's (scripts/ci-instance.ts): no step starts a server.
	expect(readFileSync(".github/workflows/check.yml", "utf8")).not.toContain("serve");
});

test("the slowest files are read from the timings Bun writes", () => {
	expect(slowest({ version: 1, files: { "a.test.ts": 1500, "b.test.ts": 62000, "c.test.ts": 20 } }, 2)).toEqual([
		{ file: "b.test.ts", seconds: 62 },
		{ file: "a.test.ts", seconds: 1.5 },
	]);
	expect(slowest(null, 2)).toEqual([]);
});

test("the check refuses an argument it does not know, so a mistyped one does not run everything", async () => {
	for (const argv of [
		["--bogus"],
		["test", "test/suite.test.ts"],
		["test", "--junit=a.xml"],
		["test", "--only=fast"],
	]) {
		const child = Bun.spawn([process.execPath, "scripts/check.ts", ...argv], { stdout: "pipe", stderr: "pipe" });
		expect(await new Response(child.stderr).text()).toContain("check: ");
		expect(await child.exited).toBe(4);
	}
});
