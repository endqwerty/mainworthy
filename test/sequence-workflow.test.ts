import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { ciPolicy, readCi } from "../scripts/work/ci.ts";
import { withInstance } from "../src/cli/test-support.ts";
import { SEQUENCE_SEEDS, sequenceFailure } from "./sequence-config.ts";

const expression = (value: string) => `$${"{"}{ ${value} }}`;

function workflow() {
	const step = z.object({
		name: z.string().optional(),
		uses: z.string().optional(),
		run: z.string().optional(),
		if: z.string().optional(),
		env: z.record(z.string(), z.string()).optional(),
		"continue-on-error": z.boolean().optional(),
	});
	return z
		.object({
			on: z.object({ schedule: z.array(z.object({ cron: z.string() })), workflow_dispatch: z.null() }).strict(),
			jobs: z
				.object({ sequences: z.object({ if: z.string(), "timeout-minutes": z.number(), steps: z.array(step) }) })
				.strict(),
		})
		.parse(Bun.YAML.parse(readFileSync(".github/workflows/sequences.yml", "utf8")));
}

test("daily sequences run on main, report outside the PR gate, and retain failures without configuration", async () => {
	const daily = workflow();
	expect(daily.on.schedule).toEqual([{ cron: "17 10 * * *" }]);
	const job = daily.jobs.sequences;
	expect(job.if).toBe(expression("github.ref == 'refs/heads/main'"));
	expect(job["timeout-minutes"]).toBeGreaterThanOrEqual(20);
	const run = job.steps.find((one) => one.name === "Sequences");
	expect(run?.run).toContain("SEQUENCE_SEEDS.daily");
	// Test two configured counts so a literal cannot match both.
	for (const offset of [0, 1]) {
		const execution = Bun.spawn(
			[
				"bash",
				"-e",
				"-c",
				`
		bun() {
			if [ "$1" = -e ]; then
				configured=$(command bun "$@")
				printf '%s' "$((configured + ${offset}))";
			else printf '%s\\n' "$MAINWORTHY_SEQUENCE_SEEDS" "$@"; fi
		}
		${run?.run}
	`,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const [exit, stdout, stderr] = await Promise.all([
			execution.exited,
			new Response(execution.stdout).text(),
			new Response(execution.stderr).text(),
		]);
		expect(exit, stderr).toBe(0);
		expect(stdout.trim().split("\n")).toEqual([
			String(SEQUENCE_SEEDS.daily + offset),
			"scripts/check.ts",
			"test",
			"--only=parallel",
			"--junit=test-results/sequences.xml",
			"test/sequences-loose.test.ts",
			"test/sequences-standard.test.ts",
			"test/sequences-strict.test.ts",
			"test/sequences-extended-loose.test.ts",
			"test/sequences-extended-standard.test.ts",
			"test/sequences-extended-strict.test.ts",
		]);
	}
	expect(run?.run).toContain("--junit=test-results/sequences.xml");
	expect(run?.["continue-on-error"]).toBe(true);
	const report = job.steps.find((one) => one.name === "Report sequences to Mainworthy, then the gate");
	expect(report?.if).toBe("always()");
	expect(report?.run).toContain("bun scripts/ci-gate.ts test-results sequences");
	expect(report?.env).toMatchObject({
		MAINWORTHY_URL: expression("vars.MAINWORTHY_SEQUENCES_PROJECT != '' && vars.MAINWORTHY_URL || ''"),
		MAINWORTHY_TOKEN: expression("secrets.MAINWORTHY_SEQUENCES_TOKEN || secrets.MAINWORTHY_TOKEN"),
		MAINWORTHY_PROJECT: expression("vars.MAINWORTHY_SEQUENCES_PROJECT"),
	});
	expect(report?.env).not.toHaveProperty("MAINWORTHY_REPO");
	expect(report?.env).not.toHaveProperty("MAINWORTHY_BRANCH");
	expect(job.steps.some((one) => one.uses?.startsWith("tailscale/github-action@"))).toBe(true);
	const enforce = job.steps.find((one) => one.name === "The sequence tests passed");
	expect(enforce?.if).toBe("always()");
	expect(enforce?.run).toContain("steps.sequences.outcome");
	// The required PR gate remains owned exclusively by check.yml.
	const check = readFileSync(".github/workflows/check.yml", "utf8");
	expect(check).not.toContain("workflows/sequences.yml");
	expect(check).not.toContain("needs: sequences");
});

test("a daily failure reaches the inbox with its seed without changing the same SHA's PR gate", async () => {
	await withInstance(async ({ client, instance, run }) => {
		await ciPolicy(async (op, input) => await client.call(op as never, input as never), "scratch");
		await client.call("admin", { do: "project.create", key: "sequences" });
		const sequences = client.with({ project: "sequences" });
		const made = await client.call("admin", {
			do: "token.create",
			actor: "github-actions",
			kind: "ci",
			project: "scratch",
		});
		const token = z.object({ token: z.string() }).parse(made).token;
		await client.call("admin", { do: "grant.set", actor: "github-actions", project: "sequences", can: ["record"] });
		const commit = "c0ffee0123456789012345678901234567890123";
		const repo = "endqwerty/mainworthy";
		await client.call("report", {
			target: { commit, repo, branch: "feature", pr: 1010 },
			job: "tests",
			results: [{ test: { key: "PR smoke" }, outcome: "pass" }],
		});
		const before = await client.call("gate", { commit, repo });
		expect(before.verdict).toBe("passed");
		const directory = await mkdtemp(join(tmpdir(), "mw-sequence-report-"));
		try {
			const file = "test/sequences-strict.test.ts";
			const message = sequenceFailure(file, 37, { what: "invariant failed" });
			const escaped = message
				.replaceAll("&", "&amp;")
				.replaceAll('"', "&quot;")
				.replaceAll("<", "&lt;")
				.replaceAll("\n", "&#10;");
			await writeFile(
				join(directory, "sequences.xml"),
				`<testsuites><testsuite name="sequences" file="${file}"><testcase name="random sequence seed 37"><failure message="${escaped}">${escaped}</failure></testcase></testsuite></testsuites>`,
			);
			await writeFile(join(directory, "sequences.json"), JSON.stringify({ exit: 1, seconds: 1 }));
			const child = Bun.spawn(
				[process.execPath, resolve("scripts/ci-gate.ts"), directory, "sequences", `--files=${file}`],
				{
					env: {
						PATH: process.env.PATH ?? "",
						MAINWORTHY_URL: instance.url,
						MAINWORTHY_PROJECT: "sequences",
						MAINWORTHY_TOKEN: token,
						GITHUB_ACTIONS: "true",
						GITHUB_EVENT_NAME: "schedule",
						GITHUB_REF: "refs/heads/main",
						GITHUB_SHA: commit,
						GITHUB_REPOSITORY: repo,
						GITHUB_RUN_ID: "1010",
						GITHUB_RUN_ATTEMPT: "1",
					},
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const [code, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect(code, stdout + stderr).toBe(2);
			expect(stdout).toContain("Reported to the deployed Mainworthy");
			expect(stdout).toContain("$ mainworthy report");
			expect(stdout).toContain("$ mainworthy gate");
			expect(await client.call("gate", { commit, repo })).toEqual(before);
			expect(await client.call("gate", { commit })).toEqual(before);
			const inbox = await sequences.call("inbox", { kind: "failure" });
			expect(inbox.items).toHaveLength(1);
			expect(JSON.stringify(inbox.items)).toContain(
				`MAINWORTHY_SEQUENCE_FIRST=37 MAINWORTHY_SEQUENCE_SEEDS=1 bun test ${file}`,
			);
			const dailyGate = await sequences.call("gate", { commit });
			expect(dailyGate.verdict).toBe("blocked");
			expect(dailyGate.open).toEqual(inbox.items.map((item) => item.q));
			expect((await readCi(async (op, input) => await client.call(op as never, input as never), { commit })).exit).toBe(
				0,
			);
			const command = stdout
				.split("\n")
				.find((line) => line.startsWith("What failed, from the instance: "))
				?.split(": ")
				.slice(1)
				.join(": ");
			expect(command).toBe(`mainworthy --project sequences gate --commit ${commit}`);
			const reading = await run((command ?? "").split(" ").slice(1));
			expect(reading.code).toBe(2);
			expect(reading.stdout).toContain("1 failure unexplained");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
