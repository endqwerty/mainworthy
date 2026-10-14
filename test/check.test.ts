// The plan of the check (`scripts/check-plan.ts`) and what the workflow says about it. The check's own wall time
// is measured by the check (`scripts/check.ts`); this keeps the plan whole and the limit where it was set.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Glob } from "bun";
import { z } from "zod";
import {
	CI_SHARD_LIMITS,
	CI_SHARDS,
	failedTests,
	failureLines,
	findChromium,
	LIMITS,
	newestAttempt,
	over,
	parallelWorkers,
	phaseFiles,
	phaseReport,
	QUIET,
	quietWorkers,
	slowest,
	testArgs,
	testReaders,
} from "../scripts/check-plan.ts";
import { OLDEST_BUN, unready } from "../scripts/preflight.ts";
import { parseJUnit, TEST_FILE_LIMIT } from "../src/surfaces/formats/junit.ts";

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

test("no test file's name comes near the length at which a report cuts it short", () => {
	// The gate job tells test files apart by the name a report keeps, and refuses a name that long (issue #82).
	// This fails here, on the machine that adds the file, long before the job would.
	const long = [...new Glob("{src,test}/**/*.test.{ts,tsx}").scanSync(".")].filter((file) => file.length > 200);
	expect(long).toEqual([]);
	expect(TEST_FILE_LIMIT).toBeGreaterThan(200);
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
	expect(testReaders()).toBe("1");
});

test("the check's budget is the one the owner set, and a warning comes first", () => {
	// Raising this number is a decision about the project, like raising a hot-path budget: AGENTS.md. The owner
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

// Issue #124. The name the workflow gives a shard's artifact and the name the gate looks for are written in two
// places: this holds them together, and holds the download to a directory for each artifact.
test("a shard's artifact is named for its attempt and downloaded into its own directory, where the gate finds the newest", () => {
	const step = z.looseObject({
		uses: z.string().optional(),
		run: z.string().optional(),
		with: z.record(z.string(), z.unknown()).optional(),
	});
	const { jobs } = z
		.object({ jobs: z.object({ tests: z.object({ steps: z.array(step) }), gate: z.object({ steps: z.array(step) }) }) })
		.parse(Bun.YAML.parse(readFileSync(".github/workflows/check.yml", "utf8")));
	const upload = jobs.tests.steps.find((one) => one.uses?.startsWith("actions/upload-artifact@"))?.with;
	const download = jobs.gate.steps.find((one) => one.uses?.startsWith("actions/download-artifact@"))?.with;
	// What GitHub replaces in the workflow's text, written so that it is not read as a placeholder of this file.
	const expression = (name: string): string => `$\{{ ${name} }}`;
	expect(upload?.name).toBe(`results-${expression("matrix.name")}-attempt-${expression("github.run_attempt")}`);
	// No `merge-multiple`: merged, two attempts of one shard are two files of one name in one directory.
	expect(download).toEqual({ pattern: "results-*", path: "test-results" });

	// A shard that ran again and left no artifact is read from its older attempt. Its job failed then, also when
	// its tests ended before they wrote a report, and the gate job's last step fails on that, with the type-check,
	// the lint and the image.
	expect(upload?.["if-no-files-found"]).toBe("error");
	const last = jobs.gate.steps.at(-1)?.run ?? "";
	for (const job of ["static", "image", "tests"])
		expect(last).toContain(`test "${expression(`needs.${job}.result`)}" = success`);

	const named = (shard: string, attempt: string): string =>
		String(upload?.name).replace(expression("matrix.name"), shard).replace(expression("github.run_attempt"), attempt);
	const root = mkdtempSync(join(tmpdir(), "mainworthy-attempts-"));
	try {
		expect(newestAttempt(root, "tests-2")).toEqual({ directory: root, attempt: null });
		expect(newestAttempt(join(root, "not-there"), "tests-2")).toEqual({
			directory: join(root, "not-there"),
			attempt: null,
		});
		for (const attempt of ["2", "9", "10"]) mkdirSync(join(root, named("tests-2", attempt)));
		// None of these is an attempt of `tests-2`: another shard's, a file, and names that are not a whole number.
		mkdirSync(join(root, named("tests-20", "30")));
		mkdirSync(join(root, named("tests", "40")));
		writeFileSync(join(root, named("tests-2", "50")), "");
		for (const attempt of ["0", "011", "12x", "-13", "1.5", ""]) mkdirSync(join(root, named("tests-2", attempt)));
		expect(newestAttempt(root, "tests-2")).toEqual({ directory: join(root, named("tests-2", "10")), attempt: 10 });
		expect(newestAttempt(root, "tests")).toEqual({ directory: join(root, named("tests", "40")), attempt: 40 });
		expect(newestAttempt(root, "quiet")).toEqual({ directory: root, attempt: null });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
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
	expect(Object.keys(workflow.jobs)).toEqual(["static", "image", "ios", "tests", "gate"]);
	expect(
		[workflow.env, ...Object.values(workflow.jobs).map((job) => job.env)].filter((env) => env !== undefined),
	).toEqual([]);
	// Only the gate job may ask GitHub who it is (to join the tailnet); the jobs that run the tests may not.
	expect(workflow.permissions).toEqual({ contents: "read" });
	expect(
		Object.entries(workflow.jobs)
			.filter(([, job]) => job.permissions)
			.map(([name, job]) => [name, job.permissions]),
	).toEqual([["gate", { contents: "read", "id-token": "write" }]]);
	// The choice of instance is the script's (scripts/ci-instance.ts): no step starts a server. (The `image` job
	// runs the container it built, to ask it for a page; nothing reports to that one.)
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

// The machine before the code: what `bun run test` said on a Mac with an older Bun first on its PATH, and in a
// worktree with nothing installed, named neither (scripts/preflight.ts).
test("a machine that cannot run the tests is told why, and what to do, before anything runs", () => {
	expect(unready()).toEqual([]);
	const old = unready({ version: "1.3.11", bun: "/home/robin/.bun/bin/bun" });
	expect(old).toHaveLength(1);
	expect(old[0]).toContain(
		`this is Bun 1.3.11 (/home/robin/.bun/bin/bun) and Mainworthy needs Bun ${OLDEST_BUN} or newer`,
	);
	expect(old[0]).toContain("which -a bun");
	expect(unready({ version: OLDEST_BUN })).toEqual([]);

	const root = mkdtempSync(join(tmpdir(), "mainworthy-preflight-"));
	try {
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ dependencies: { here: "1", gone: "1" }, devDependencies: { "@scope/gone": "1" } }),
		);
		mkdirSync(join(root, "node_modules/here"), { recursive: true });
		writeFileSync(join(root, "node_modules/here/package.json"), "{}");
		expect(unready({ root })).toEqual([
			"2 of the packages package.json names are not installed (gone, @scope/gone). Run `bun install --frozen-lockfile`.",
		]);
		// An older Bun cannot read the lockfile: the install is with the newer one.
		expect(unready({ root, version: "1.3.11" }).at(-1)).toEndWith(
			"Run `bun install --frozen-lockfile`, with the newer Bun.",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("every way to run a test asks the machine first, and the Bun asked for is one the workflow and the image install", () => {
	// `bun test <file>` loads the preload; `bun run check` and `bun run test` ask before their first import of a package.
	expect(
		z
			.object({ test: z.object({ preload: z.array(z.string()) }) })
			.parse(Bun.TOML.parse(readFileSync("bunfig.toml", "utf8"))).test.preload,
	).toEqual(["./test/preflight.ts"]);
	expect(readFileSync("test/preflight.ts", "utf8")).toContain('requireReady("bun test")');
	// What the check loads before it asks must be there on a machine with nothing installed: Node's and Bun's own
	// modules and each other. A type is not loaded. (The check reads a report with a module that needs packages,
	// and loads it after the run.)
	const loaded = (file: string): string[] =>
		[...readFileSync(file, "utf8").matchAll(/^import (?!type )[^;]*? from "([^"]+)";/gms)].map(
			(match) => match[1] ?? "",
		);
	expect(loaded("scripts/check.ts").sort()).toEqual(
		["./check-plan.ts", "./preflight.ts", "node:fs", "node:os", "node:path"].sort(),
	);
	expect(loaded("scripts/check-plan.ts").sort()).toEqual(["bun", "node:fs", "node:os", "node:path"]);
	expect(loaded("scripts/preflight.ts").sort()).toEqual(["node:fs", "node:path"]);
	expect(loaded("test/preflight.ts")).toEqual(["../scripts/preflight.ts"]);
	const check = readFileSync("scripts/check.ts", "utf8");
	expect(check.indexOf('requireReady("check")')).toBeGreaterThan(0);
	expect(check.indexOf('requireReady("check")')).toBeLessThan(check.indexOf("await import("));

	const installed = [
		...readFileSync(".github/workflows/check.yml", "utf8").matchAll(/bun-version: (\S+)/g),
		...readFileSync("Dockerfile", "utf8").matchAll(/FROM oven\/bun:(\S+)/g),
	].map((match) => match[1] ?? "");
	expect(installed.length).toBeGreaterThanOrEqual(4);
	// The image's tag names a line (`1.4`), which is its newest release.
	for (const version of installed)
		expect(
			Bun.semver.satisfies(/^\d+\.\d+$/.test(version) ? `${version}.0` : version, `>=${OLDEST_BUN}`),
			version,
		).toBe(true);
});

test("a machine with no Chromium is told what to set, and one whose MAINWORTHY_CHROMIUM names nothing is told that", () => {
	const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
	const has =
		(...paths: string[]) =>
		(path: string) =>
			paths.includes(path);
	expect(findChromium({ MAINWORTHY_CHROMIUM: "/opt/chrome" }, has("/opt/chrome", "/usr/bin/chromium"))).toEqual({
		path: "/opt/chrome",
	});
	expect(findChromium({}, has("/usr/bin/google-chrome"))).toEqual({ path: "/usr/bin/google-chrome" });
	// A name that is not there falls back to the system's, as it did.
	expect(findChromium({ MAINWORTHY_CHROMIUM: "/gone" }, has("/usr/bin/chromium"))).toEqual({
		path: "/usr/bin/chromium",
	});
	expect(findChromium({}, has())).toEqual({
		path: null,
		skipped:
			"There is no Chromium at /usr/bin/chromium, /usr/bin/google-chrome or /usr/bin/chromium-browser. Set MAINWORTHY_CHROMIUM to a Chromium or Chrome binary to run the browser tests.",
	});
	expect(findChromium({ MAINWORTHY_CHROMIUM: "/gone" }, has())).toMatchObject({
		skipped: expect.stringMatching(
			/^MAINWORTHY_CHROMIUM names \/gone, which is not there, and there is no Chromium at /,
		),
	});
	// A Mac's own Chrome is not started unasked; the line to run it with is given.
	expect(findChromium({}, has(mac))).toMatchObject({
		path: null,
		skipped: expect.stringMatching(
			/ This machine has one: MAINWORTHY_CHROMIUM="\/Applications\/Google Chrome\.app\/.*"$/,
		),
	});
});

test("the failed tests of a report are listed with what each said and where", () => {
	const report = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="3" failures="2">
  <testsuite name="test/a.test.ts" file="test/a.test.ts" tests="3" failures="2">
    <testcase name="passes" classname="" time="0.01" file="test/a.test.ts" line="2" />
    <testsuite name="a group" file="test/a.test.ts" line="3" tests="1" failures="1">
      <testcase name="fails &lt;here&gt;" classname="a group" time="0.003" file="test/a.test.ts" line="4">
        <failure type="AssertionError" message="&#10;expect(received).toBe(expected)&#10;&#10;Expected: 2&#10;">AssertionError: expect(received).toBe(expected)&#10;&#10;      at helper (test/support.ts:9:3)&#10;      at test/a.test.ts:4:49&#10;</failure>
      </testcase>
    </testsuite>
    <testcase name="times out" classname="" time="0.1" file="test/a.test.ts" line="6">
      <failure type="TimeoutError" message="test timed out" />
    </testcase>
  </testsuite>
</testsuites>`;
	const failed = failedTests(parseJUnit(report).results);
	expect(failed).toEqual([
		{ file: "test/a.test.ts", name: "fails <here>", why: "expect(received).toBe(expected)", at: "test/support.ts:9:3" },
		{ file: "test/a.test.ts", name: "times out", why: "test timed out", at: null },
	]);
	// `test/c.test.ts` is a file of the phase that the report has no test of: it did not load.
	const read = phaseReport("tests: parallel", parseJUnit(report).results, ["test/a.test.ts", "test/c.test.ts"]);
	expect(read).toEqual({ name: "tests: parallel", failed, silent: ["test/c.test.ts"] });
	expect(failureLines([read])).toEqual([
		"2 tests failed:",
		"  test/a.test.ts: fails <here>",
		"      expect(received).toBe(expected) (test/support.ts:9:3)",
		"  test/a.test.ts: times out",
		"      test timed out",
		"Each is above with its whole error, under its file's name. One file alone: `bun test <file>`.",
		"1 test file gave no result, so no test of it ran:",
		"  test/c.test.ts",
		"It did not load, or the runner stopped in it: the error is above, under the file's name.",
	]);
	const many = Array.from({ length: 12 }, (_, i) => `test/${i}.test.ts`);
	expect(failureLines([{ name: "tests: parallel", failed: [], silent: many }]).slice(-3)).toEqual([
		"  test/9.test.ts",
		"  and 2 more",
		"Each did not load, or the runner stopped in it: the error is above, under the file's name.",
	]);
	// A phase that failed with nothing to name (a shard's files are not known), and one whose runner did not
	// live to write a report.
	expect(failureLines([phaseReport("tests: parallel", [], null), phaseReport("tests: quiet", null, QUIET)])).toEqual([
		'tests: parallel failed and no test in it did: something failed outside a test. Look above for "error:".',
		"tests: quiet left no report of its tests: the runner stopped before its end. Its last lines say why.",
	]);
	// The files of a phase are the ones `bun test` is given: every test file is in one of the two, and a shard's
	// share is Bun's to choose.
	const parallel = phaseFiles("parallel") ?? [];
	expect(phaseFiles("quiet")).toEqual(QUIET);
	expect(phaseFiles("parallel", "2/6")).toBeNull();
	expect(parallel).toContain("test/check.test.ts");
	expect(parallel.filter((file) => QUIET.includes(file))).toEqual([]);
	expect(parallel.length + QUIET.length).toBe([...new Glob("{src,test}/**/*.test.{ts,tsx}").scanSync(".")].length);
});

test("a run ends with the tests that failed, and says so when a file did not load", async () => {
	const check = join(import.meta.dir, "../scripts/check.ts");
	const run = async (files: Record<string, string>): Promise<{ exit: number; end: string }> => {
		const root = mkdtempSync(join(tmpdir(), "mainworthy-check-run-"));
		try {
			mkdirSync(join(root, "test"));
			for (const [name, text] of Object.entries(files)) writeFileSync(join(root, "test", name), text);
			const child = Bun.spawn([process.execPath, check, "test", "--only=parallel"], {
				cwd: root,
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, MAINWORTHY_CHROMIUM: "" },
			});
			const [out, exit] = await Promise.all([new Response(child.stdout).text(), child.exited]);
			return { exit, end: out.slice(out.indexOf("\nFAILED: ")) };
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	};
	const passes = 'import { test } from "bun:test";\ntest("passes", () => {});\n';
	const fails = 'import { expect, test } from "bun:test";\ntest("one is two", () => {\n\texpect(1).toBe(2);\n});\n';
	const failed = await run({ "a.test.ts": passes, "b.test.ts": fails });
	expect(failed.exit).toBe(1);
	expect(failed.end).toContain(
		"\nFAILED: tests: parallel\n\n1 test failed:\n  test/b.test.ts: one is two\n      expect(received).toBe(expected) (test/b.test.ts:3:12)\n",
	);
	const unloaded = await run({ "a.test.ts": passes, "c.test.ts": `import "./not-there.ts";\n${passes}` });
	expect(unloaded.exit).toBe(1);
	expect(unloaded.end).toContain(
		"\n1 test file gave no result, so no test of it ran:\n  test/c.test.ts\nIt did not load, or the runner stopped in it",
	);
	expect(unloaded.end).not.toContain("test/a.test.ts");
});
