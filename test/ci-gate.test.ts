// The last job of the check workflow (`scripts/ci-gate.ts`), run as the workflow runs it against a real
// Casebook: the result is Casebook's gate, and a report that is missing or says less than happened is not a pass.
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CI_SHARD_LIMITS } from "../scripts/check-plan.ts";
import { withInstance } from "../src/cli/test-support.ts";

/** A file whose tests did not run at all, as on a runner with no browser. */
const SKIPPED = Symbol("every test skipped");
type Shard = {
	name: string;
	/** The test files of the shard, and the failure message of the test in each that failed. */
	files: Record<string, string | null | typeof SKIPPED>;
	exit?: number;
	seconds?: number;
	/** The report's text, where a test wants one that `files` cannot describe. */
	xml?: string;
};

/** A report as Bun writes it. */
function junit(files: Shard["files"]): string {
	const suites = Object.entries(files).map(([file, failure]) => {
		if (failure === SKIPPED)
			return `  <testsuite name="${file}" file="${file}" tests="2" assertions="0" failures="0" skipped="2" time="0" hostname="runner">
    <testcase name="works" classname="" time="0" file="${file}" line="3" assertions="0">
      <skipped />
    </testcase>
    <testsuite name="group" file="${file}" line="4" tests="1" assertions="0" failures="0" skipped="1" time="0" hostname="runner">
      <testcase name="works again" classname="group" time="0" file="${file}" line="5" assertions="0">
        <skipped />
      </testcase>
    </testsuite>
  </testsuite>`;
		const failed =
			failure === null
				? " />"
				: `>\n      <failure type="AssertionError" message="${failure}">AssertionError: ${failure}</failure>\n    </testcase>`;
		return `  <testsuite name="${file}" file="${file}" tests="2" assertions="2" failures="${failure === null ? 0 : 1}" skipped="0" time="0.2" hostname="runner">
    <testcase name="works" classname="" time="0.1" file="${file}" line="3" assertions="1" />
    <testcase name="works again" classname="" time="0.1" file="${file}" line="4" assertions="1"${failed}
  </testsuite>`;
	});
	return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test" tests="${suites.length * 2}" failures="0" skipped="0" time="0.4">\n${suites.join("\n")}\n</testsuites>\n`;
}

/** A checkout with those test files, the shards' artifacts as downloaded, and the gate job's last step. */
async function gate(shards: Shard[], options: { repository?: string[]; missing?: string[] } = {}) {
	return withInstance(async ({ instance }) => {
		const root = await mkdtemp(join(tmpdir(), "casebook-ci-gate-"));
		try {
			const sources = options.repository ?? shards.flatMap((shard) => Object.keys(shard.files));
			for (const file of sources) {
				await mkdir(join(root, dirname(file)), { recursive: true });
				await writeFile(join(root, file), "");
			}
			await mkdir(join(root, "test-results"));
			for (const shard of shards) {
				if (options.missing?.includes(shard.name)) continue;
				const failed = Object.values(shard.files).some((failure) => failure !== null);
				const outcome = { exit: shard.exit ?? (failed ? 1 : 0), seconds: shard.seconds ?? 60 };
				await writeFile(join(root, "test-results", `${shard.name}.xml`), shard.xml ?? junit(shard.files));
				await writeFile(join(root, "test-results", `${shard.name}.json`), JSON.stringify(outcome));
			}
			const child = Bun.spawn(
				[process.execPath, resolve("scripts/ci-gate.ts"), "test-results", ...shards.map((shard) => shard.name)],
				{
					cwd: root,
					env: {
						PATH: process.env.PATH ?? "",
						HOME: root,
						CASEBOOK_URL: instance.url,
						CASEBOOK_TOKEN: "",
						CASEBOOK_PROJECT: "",
						GITHUB_ACTIONS: "true",
						GITHUB_EVENT_NAME: "pull_request",
						GITHUB_REF: "refs/pull/77/merge",
						GITHUB_HEAD_REF: "dx/fast-check",
						GITHUB_SHA: "c0ffee0123456789012345678901234567890123",
						GITHUB_REPOSITORY: "endqwerty/casebook",
						GITHUB_RUN_ID: "1",
						GITHUB_RUN_ATTEMPT: "1",
						GITHUB_JOB: "gate",
					},
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			return { code, output: stdout + stderr };
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
}

const green: Shard[] = [
	{ name: "tests-1", files: { "test/a.test.ts": null, "src/b.test.ts": null } },
	{ name: "tests-2", files: { "test/c.test.ts": null } },
	{ name: "quiet", files: { "test/budgets.test.ts": null } },
];
const withFailure = (message: string): Shard[] =>
	green.map((shard) => (shard.name === "tests-2" ? { ...shard, files: { "test/c.test.ts": message } } : shard));

test("every shard passed: each is reported under its own job and the gate passes", async () => {
	const result = await gate(green);
	expect(result.output).toContain("$ casebook report test-results/tests-1.xml --job tests-1");
	expect(result.output).toContain("job tests-2");
	expect(result.output).toContain("job quiet");
	expect(result.output).toMatch(/casebook gate\s+passed/);
	expect(result.output).not.toContain("::error::");
	expect(result.code).toBe(0);
}, 20_000);

test("a failing test in one shard ends in a blocked gate", async () => {
	const result = await gate(withFailure("expected 1, got 2"));
	expect(result.output).toMatch(/casebook gate\s+blocked/);
	expect(result.output).toContain("needs an answer");
	expect(result.output).toContain("The gate did not pass (exit 2).");
	expect(result.code).toBe(2);
}, 20_000);

test("a shard that left no report fails the job, though the gate passes on the others", async () => {
	const result = await gate(green, { missing: ["tests-2"] });
	expect(result.output).toContain("job tests-1");
	expect(result.output).toMatch(/casebook gate\s+passed/);
	expect(result.output).toContain("::error::tests-2: no report (test-results/tests-2.xml is missing or empty)");
	expect(result.output).toContain("::error::in no shard's report: test/c.test.ts");
	expect(result.code).toBe(1);
}, 20_000);

test("a test file whose tests were all skipped fails the job, though the gate passes on the others", async () => {
	// A runner with no browser skips every browser test, exits 0 and writes a complete report.
	const result = await gate(
		green.map((shard) =>
			shard.name === "tests-2" ? { ...shard, files: { "test/c.test.ts": SKIPPED }, exit: 0 } : shard,
		),
	);
	expect(result.output).toMatch(/casebook gate\s+passed/);
	expect(result.output).toContain("::error::tests-2: every test of test/c.test.ts was skipped");
	expect(result.code).toBe(1);
}, 20_000);

test("a test that takes its file from its suite is counted for that file", async () => {
	// Other producers of JUnit put the file on the suite only. Bun puts it on every test.
	const inherited = junit({ "test/c.test.ts": null }).replace(/(<testcase\b[^>]*?) file="[^"]+"/g, "$1");
	expect(inherited).not.toMatch(/<testcase\b[^>]* file=/);
	const withReport = (xml: string): Shard[] =>
		green.map((shard) => (shard.name === "tests-2" ? { ...shard, xml, exit: 0 } : shard));
	const ran = await gate(withReport(inherited));
	expect(ran.output).not.toContain("::error::");
	expect(ran.code).toBe(0);
	const skipped = inherited.replace(/<testcase\b([^>]*?)\s*\/>/g, "<testcase$1>\n      <skipped />\n    </testcase>");
	const none = await gate(withReport(skipped));
	expect(none.output).toContain("::error::tests-2: every test of test/c.test.ts was skipped");
	expect(none.code).toBe(1);
}, 40_000);

test("text inside a test's output is not counted as a test or as a skip", async () => {
	const withReport = (xml: string): Shard[] =>
		green.map((shard) => (shard.name === "tests-2" ? { ...shard, xml, exit: 0 } : shard));
	const report = (body: string) =>
		`<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test" tests="1" failures="0" skipped="0" time="0.1">\n  <testsuite name="test/c.test.ts" file="test/c.test.ts" tests="1" failures="0" skipped="0" time="0.1" hostname="runner">\n${body}\n  </testsuite>\n</testsuites>\n`;
	// A file whose one test was skipped, with a passing test's markup quoted in its output: still not tested.
	const fake = await gate(
		withReport(
			report(
				'    <testcase name="skips" file="test/c.test.ts"><skipped /></testcase>\n    <system-out><![CDATA[<testcase name="example" />]]></system-out>',
			),
		),
	);
	expect(fake.output).toContain("::error::tests-2: every test of test/c.test.ts was skipped");
	expect(fake.code).toBe(1);
	// A test that passed, with the word for a skip quoted in its output: tested.
	const quoted = await gate(
		withReport(report('    <testcase name="passes"><system-out><![CDATA[<skipped />]]></system-out></testcase>')),
	);
	expect(quoted.output).not.toContain("::error::");
	expect(quoted.code).toBe(0);
}, 40_000);

test("tests that exited with a failure the report does not show fail the job", async () => {
	// A test file that does not load is an error for Bun and is absent from its JUnit file.
	const result = await gate(green.map((shard) => (shard.name === "tests-1" ? { ...shard, exit: 1 } : shard)));
	expect(result.output).toMatch(/casebook gate\s+passed/);
	expect(result.output).toContain("::error::tests-1: the tests exited 1 and the report shows no failure");
	expect(result.code).toBe(1);
}, 20_000);

test("a test file that is in no shard's report fails the job", async () => {
	const repository = [
		...green.flatMap((shard) => Object.keys(shard.files)),
		"test/e2e/forgotten.test.ts",
		"test/helpers.ts",
	];
	const result = await gate(green, { repository });
	expect(result.output).toContain("::error::in no shard's report: test/e2e/forgotten.test.ts");
	expect(result.output).not.toContain("helpers.ts");
	expect(result.code).toBe(1);
}, 20_000);

test("a slow shard is a warning above the budget and a failure above the limit", async () => {
	const taking = (seconds: number): Shard[] =>
		green.map((shard) => (shard.name === "quiet" ? { ...shard, seconds } : shard));
	const warned = await gate(taking(CI_SHARD_LIMITS.warn + 1));
	expect(warned.output).toContain(
		`::warning::the slowest shard's tests took ${(CI_SHARD_LIMITS.warn + 1).toFixed(1)} s`,
	);
	expect(warned.code).toBe(0);
	const failed = await gate(taking(CI_SHARD_LIMITS.fail + 1));
	expect(failed.output).toContain(`::error::the slowest shard's tests took ${(CI_SHARD_LIMITS.fail + 1).toFixed(1)} s`);
	expect(failed.code).toBe(1);
}, 30_000);
