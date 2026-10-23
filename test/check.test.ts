// The plan of the check (`scripts/check-plan.ts`) and what the workflow says about it. The check's own wall time
// is measured by the check (`scripts/check.ts`); this keeps the plan whole.
import { expect, test } from "bun:test";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Glob } from "bun";
import { z } from "zod";
import {
	CI_SHARDS,
	chromiumLaunchOptions,
	failedTests,
	failureLines,
	findChromium,
	fixtureBuildArgs,
	needsBrowserFixture,
	newestAttempt,
	parallelWorkers,
	parseCheckArgs,
	phaseFiles,
	phaseReport,
	playwrightChromium,
	QUIET,
	quietWorkers,
	sharedBrowserEndpoint,
	slowest,
	testArgs,
	testReaders,
} from "../scripts/check-plan.ts";
import { matrix, outputs } from "../scripts/ci-scope.ts";
import { OLDEST_BUN, unready } from "../scripts/preflight.ts";
import { parseJUnit, TEST_FILE_LIMIT } from "../src/surfaces/formats/junit.ts";

test("browser slots follow Bun's worker index and preserve local browser ownership", () => {
	const env = { MAINWORTHY_E2E_BROWSER_ENDPOINTS: "ws://127.0.0.1:1/a\nws://127.0.0.1:2/b", BUN_TEST_WORKER_ID: "2" };
	expect(sharedBrowserEndpoint("/repo/test/e2e/phone.test.ts", env)).toBe("ws://127.0.0.1:2/b");
	expect(sharedBrowserEndpoint("test/e2e/headers.test.ts", env)).toBe("ws://127.0.0.1:2/b");
	expect(sharedBrowserEndpoint("test/e2e/phone.test.ts", { ...env, BUN_TEST_WORKER_ID: undefined })).toBe(
		"ws://127.0.0.1:1/a",
	);
	for (const file of ["browser", "followups"])
		expect(sharedBrowserEndpoint(`/repo/test/e2e/${file}.test.ts`, env)).toBeUndefined();
	expect(sharedBrowserEndpoint("test/e2e/phone.test.ts", {})).toBeUndefined();
	expect(sharedBrowserEndpoint("test/e2e/phone.test.ts", { ...env, MAINWORTHY_E2E_CPU_THROTTLE: "4" })).toBeUndefined();
	for (const worker of ["0", "-1", "3", "1.5", "NaN"])
		expect(() => sharedBrowserEndpoint("test/e2e/phone.test.ts", { ...env, BUN_TEST_WORKER_ID: worker })).toThrow(
			"No shared Chromium endpoint for Bun worker",
		);
});

test("owned and shared Chromium launches use the same flags, with explicit flags added for owned launches", () => {
	expect(chromiumLaunchOptions("/chrome")).toEqual({
		executablePath: "/chrome",
		headless: true,
		args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
	});
	expect(chromiumLaunchOptions("/chrome", ["--host-resolver-rules=MAP mainworthy.test 127.0.0.1"]).args).toEqual([
		"--no-sandbox",
		"--disable-dev-shm-usage",
		"--disable-gpu",
		"--host-resolver-rules=MAP mainworthy.test 127.0.0.1",
	]);
});

test.skipIf(findChromium().path === null)(
	"two isolated files borrow one browser, disconnect after each file, and leave no page or storage behind",
	async () => {
		const path = findChromium().path;
		if (!path) throw new Error("Chromium disappeared");
		const { chromium } = await import("playwright-core");
		const browser = await chromium.launchServer(chromiumLaunchOptions(path));
		const root = mkdtempSync(join(tmpdir(), "mainworthy-browser-files-"));
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response('<div id="probe">ready</div>', { headers: { "content-type": "text/html" } }),
		});
		try {
			const setup = `import { expect, test } from "bun:test";
import { openPage } from ${JSON.stringify(join(process.cwd(), "test/e2e/support.ts"))};
const server = { url: ${JSON.stringify(server.url.origin)} };
async function expectRunnerBrowser(context) {
 const cdp = await context.browser().newBrowserCDPSession();
 const {processInfo} = await cdp.send("SystemInfo.getProcessInfo");
 expect(processInfo.find(process => process.type === "browser")?.id).toBe(${browser.process().pid});
 await cdp.detach();
}
`;
			writeFileSync(
				join(root, "first.test.ts"),
				`${setup}
test("first file leaves a page and storage for its disconnect to clean", async () => {
 const {page, context} = await openPage(server, { signedIn: false, path: "/?first-file", ready: "#probe" });
 await expectRunnerBrowser(context);
 await page.evaluate(() => localStorage.setItem("left-behind", "first"));
 await context.addCookies([{name: "left-behind", value: "first", url: server.url}]);
 expect((await context.cookies()).map(cookie => cookie.name)).toEqual(["left-behind"]);
 expect(await page.evaluate(() => localStorage.getItem("left-behind"))).toBe("first");
});`,
			);
			writeFileSync(
				join(root, "second.test.ts"),
				`${setup}
test("second file has fresh storage and the first file's page is gone", async () => {
 const {page, context, close} = await openPage(server, { signedIn: false, path: "/?second-file", ready: "#probe" });
 try {
  await expectRunnerBrowser(context);
  expect(await page.evaluate(() => localStorage.getItem("left-behind"))).toBeNull();
  expect(await context.cookies()).toEqual([]);
  const cdp = await context.browser().newBrowserCDPSession();
  const {targetInfos} = await cdp.send("Target.getTargets");
  expect(targetInfos.filter(t => t.type === "page").map(t => t.url)).toEqual([server.url + "/?second-file"]);
 } finally { await close(); }
});`,
			);
			const child = Bun.spawn(
				[
					process.execPath,
					"test",
					"--parallel=1",
					"--no-orphans",
					join(root, "first.test.ts"),
					join(root, "second.test.ts"),
				],
				{
					env: {
						...process.env,
						MAINWORTHY_E2E_BROWSER_ENDPOINTS: browser.wsEndpoint(),
						MAINWORTHY_E2E_CPU_THROTTLE: "",
						BUN_TEST_WORKER_ID: "1",
					},
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const [out, err, exit] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect({ exit, output: (out + err).match(/2 pass\s+0 fail/)?.[0].replace(/\s+/g, " ") }, out + err).toEqual({
				exit: 0,
				output: "2 pass 0 fail",
			});
			expect(browser.process().exitCode).toBeNull();
		} finally {
			await browser.close();
			await server.stop(true);
			rmSync(root, { recursive: true, force: true });
		}
	},
	30_000,
);

test.skipIf(findChromium().path === null || process.platform === "win32")(
	"a file waits for slow Chromium teardown after its assertions pass",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "mainworthy-browser-teardown-"));
		const fixture = join(root, "teardown.test.ts");
		writeFileSync(
			fixture,
			`import { expect, test } from "bun:test";
import { openPage } from ${JSON.stringify(join(process.cwd(), "test/e2e/support.ts"))};
test("the page is ready before teardown", async () => {
 const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
  fetch: () => new Response('<div id="probe">ready</div>', { headers: { "content-type": "text/html" } }) });
 try {
  const {page, context, close} = await openPage({ url: server.url.origin }, { signedIn: false, path: "/", ready: "#probe" });
  expect(await page.locator("#probe").textContent()).toBe("ready");
  const browser = context.browser();
  const cdp = await browser.newBrowserCDPSession();
  const {processInfo} = await cdp.send("SystemInfo.getProcessInfo");
  const pid = processInfo.find(process => process.type === "browser").id;
  await cdp.detach();
  await close();
  browser.on("disconnected", () => console.log("CHROMIUM_CLOSED"));
  process.kill(pid, "SIGSTOP");
  process.send({ pid });
 } finally { await server.stop(true); }
}, 30_000);`,
		);
		let paused: number | undefined;
		let resume: ReturnType<typeof setTimeout> | undefined;
		const child = Bun.spawn([process.execPath, "test", "--no-orphans", fixture], {
			env: { ...process.env, MAINWORTHY_E2E_BROWSER_ENDPOINTS: "", MAINWORTHY_E2E_CPU_THROTTLE: "" },
			stdout: "pipe",
			stderr: "pipe",
			ipc(message) {
				const { pid } = z.object({ pid: z.number().int().positive() }).parse(message);
				paused = pid;
				// Only teardown waits for Chromium: the page assertion has already passed.
				resume = setTimeout(() => process.kill(pid, "SIGCONT"), 6_000);
			},
		});
		try {
			const [out, err, exit] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect({ exit, output: (out + err).match(/1 pass\s+0 fail/)?.[0].replace(/\s+/g, " ") }, out + err).toEqual({
				exit: 0,
				output: "1 pass 0 fail",
			});
			expect(out).toContain("CHROMIUM_CLOSED");
		} finally {
			clearTimeout(resume);
			if (paused) {
				try {
					process.kill(paused, "SIGCONT");
				} catch {}
			}
			child.kill();
			await child.exited;
			rmSync(root, { recursive: true, force: true });
		}
	},
	60_000,
);

test("the browser fixture uses the production compiler flags and worker layout", () => {
	const args = fixtureBuildArgs("/scratch/fixture", "/repo");
	const production = z
		.object({ scripts: z.object({ build: z.string() }) })
		.parse(JSON.parse(readFileSync("package.json", "utf8"))).scripts.build;
	const productionArgs = args
		.filter((arg, i) => arg !== "--cwd" && args[i - 1] !== "--cwd")
		.filter((arg) => arg !== "--root=/repo/src")
		.map((arg) => arg.replace(/^\/repo\//, ""))
		.map((arg, i, all) => {
			if (all[i - 1] === "--banner") return `'${arg}'`;
			if (arg === "test/e2e/serve.ts") return "src/cli/main.ts";
			return arg === "/scratch/fixture" ? "dist/mainworthy" : arg;
		});
	expect(`NODE_ENV=production bun ${productionArgs.join(" ")}`).toBe(production);
	expect(args.slice(0, 3)).toEqual(["build", "--cwd", "/scratch"]);
	expect(args).toContain("/repo/test/e2e/serve.ts");
	expect(args).toContain("--root=/repo/src");
	expect(args.slice(-2)).toEqual(["--outfile", "/scratch/fixture"]);
});

test("a browser phase builds once, including quiet and shards, but named server tests need no fixture", () => {
	expect(needsBrowserFixture(["parallel", "quiet"])).toBe(true);
	expect(needsBrowserFixture(["quiet"])).toBe(true);
	expect(needsBrowserFixture(["parallel"], "2/6")).toBe(true);
	expect(needsBrowserFixture(["parallel"], undefined, ["test/e2e/phone.test.ts"])).toBe(true);
	expect(needsBrowserFixture(["parallel"], undefined, ["test/check.test.ts"])).toBe(false);
});

test("a broken browser fixture build fails the check before any test runs, even with an inherited executable", async () => {
	const root = mkdtempSync(join(tmpdir(), "mainworthy-broken-fixture-"));
	try {
		for (const dir of ["scripts/work", "test/e2e", "src/server/ops", "src/cli"])
			mkdirSync(join(root, dir), { recursive: true });
		for (const file of ["check.ts", "check-plan.ts", "preflight.ts", "work/processes.ts", "work/run.ts"])
			copyFileSync(`scripts/${file}`, join(root, "scripts", file));
		writeFileSync(join(root, "package.json"), "{}");
		writeFileSync(join(root, "test/e2e/serve.ts"), "const broken = ;");
		for (const worker of ["src/server/ops/read-worker.ts", "src/cli/demo-worker.ts"])
			writeFileSync(join(root, worker), "export {};");
		writeFileSync(join(root, "test/e2e/broken.test.ts"), 'throw new Error("TEST_MUST_NOT_RUN");');
		const child = Bun.spawn(
			[process.execPath, "scripts/check.ts", "test", "--only=parallel", "test/e2e/broken.test.ts"],
			{ cwd: root, env: { ...process.env, MAINWORTHY_E2E_SERVER: "/do-not-reuse" }, stdout: "pipe", stderr: "pipe" },
		);
		const [out, err, exit] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(exit).toBe(1);
		expect(out + err).toContain("check: browser fixture build failed; no tests ran");
		expect(out + err).toContain("test/e2e/serve.ts");
		expect(out + err).not.toContain("TEST_MUST_NOT_RUN");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("check waits beyond four seconds for a registry entry to disappear while its child stays alive", async () => {
	const root = mkdtempSync(join(tmpdir(), "mainworthy-slow-unregister-"));
	const ready = join(root, "registry");
	const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
		detached: true,
	});
	mkdirSync(join(root, "test"));
	writeFileSync(
		join(root, "test/probe.test.ts"),
		`
		import { test } from "bun:test";
		import { registerOwnedChild } from ${JSON.stringify(join(process.cwd(), "scripts/work/processes.ts"))};
		test("cleanup continues after this test", async () => {
			await registerOwnedChild(${child.pid});
			await Bun.write(${JSON.stringify(ready)}, process.env.MAINWORTHY_TEST_CHILDREN);
		});
	`,
	);
	const check = Bun.spawn(
		[
			process.execPath,
			join(process.cwd(), "scripts/check.ts"),
			"test",
			"--only=parallel",
			"--workers=1",
			"test/probe.test.ts",
		],
		{ cwd: root, stdout: "pipe", stderr: "pipe" },
	);
	const output = Promise.all([new Response(check.stdout).text(), new Response(check.stderr).text()]);
	try {
		const readyBy = Date.now() + 10_000;
		while (!existsSync(ready) && check.exitCode === null && Date.now() < readyBy) await Bun.sleep(25);
		expect(existsSync(ready)).toBe(true);
		// Directory cleanup can legitimately take longer than the old four-second drain deadline.
		await Bun.sleep(5_000);
		const registry = readFileSync(ready, "utf8");
		if (existsSync(registry)) {
			for (const name of readdirSync(registry)) {
				if (name.startsWith(`${child.pid}-`) && name.endsWith(".child")) rmSync(join(registry, name));
			}
		}
		const code = await check.exited;
		const [out, err] = await output;
		expect(code, out + err).toBe(0);
		expect(out).toContain("check: 0 owned children still alive");
		expect(child.exitCode).toBeNull();
	} finally {
		check.kill("SIGKILL");
		child.kill("SIGKILL");
		await Promise.all([check.exited, child.exited, output]);
		rmSync(root, { recursive: true, force: true });
	}
}, 40_000);

test("every test file is in exactly one phase: the quiet files, and everything but them", () => {
	expect(phaseFiles("quiet")).toContain("test/policy-latency.test.ts");
	expect(phaseFiles("parallel")).not.toContain("test/policy-latency.test.ts");
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

test("the workflow runs the shards the scope names and its gate reads every one of them", () => {
	const workflow = readFileSync(".github/workflows/check.yml", "utf8");
	const shards = Array.from({ length: CI_SHARDS }, (_, i) => `tests-${i + 1}`);
	expect(matrix("all")).toEqual([
		...shards.map((name, i) => ({ name, phase: `--only=parallel --shard=${i + 1}/${CI_SHARDS}`, files: "" })),
		{ name: "quiet", phase: "--only=quiet", files: "" },
	]);
	const all = Object.fromEntries(
		outputs({ why: "", jobs: { static: true, image: true, ios: true }, tests: "all" }).map((line) =>
			line.split(/=(.*)/s),
		),
	);
	expect(all.shards).toBe(`${shards.join(" ")} quiet`);
	expect(all.files).toBe("");
	// The tests job takes its runners, and the gate its shard names and files, from the scope job's outputs.
	// What GitHub replaces in the workflow's text, written so that it is not read as a placeholder of this file.
	const expression = (name: string): string => `$\{{ ${name} }}`;
	expect(workflow).toContain(`matrix: ${expression("fromJSON(needs.scope.outputs.matrix)")}`);
	expect(workflow).toContain(`SHARDS: ${expression("needs.scope.outputs.shards")}`);
	expect(workflow).toContain(`FILES: ${expression("needs.scope.outputs.files")}`);
	expect(workflow).toContain(`run: bun scripts/ci-gate.ts test-results $SHARDS $\{FILES:+"--files=$FILES"}\n`);
	expect(workflow).toContain(`FILES: ${expression("matrix.files")}`);
	expect(workflow).toContain(
		`run: bun scripts/check.ts test ${expression("matrix.phase")} --junit=test-results/${expression("matrix.name")}.xml $FILES\n`,
	);
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
	for (const job of ["scope", "static", "image", "ios", "tests"])
		expect(last).toContain(`test "${expression(`needs.${job}.result`)}" = success`);
	// A job the scope skipped passes only when the scope said it was not needed.
	for (const job of ["static", "image", "ios"]) {
		expect(last).toContain(
			`test "${expression(`needs.${job}.result`)}" = success || test "${expression(`needs.scope.outputs.${job}`)}:${expression(`needs.${job}.result`)}" = false:skipped\n`,
		);
		expect(readFileSync(".github/workflows/check.yml", "utf8")).toContain(
			`if: ${expression(`needs.scope.outputs.${job} == 'true'`)}`,
		);
	}

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
	// The gate is the job to require on the branch, so every job reaches it and a failed description blocks a merge.
	expect(readFileSync(".github/workflows/check.yml", "utf8")).toContain(
		"needs: [scope, static, tests, image, ios, description]",
	);
	// No secret in an environment every step of a job or of the workflow would share.
	expect(Object.keys(workflow.jobs)).toEqual(["scope", "static", "image", "ios", "description", "tests", "gate"]);
	expect(
		[workflow.env, ...Object.values(workflow.jobs).map((job) => job.env)].filter((env) => env !== undefined),
	).toEqual([]);
	// Only the gate job may ask GitHub who it is (to join the tailnet); the jobs that run the tests may not. The
	// description job reads the pull request and its issues, and writes nothing.
	expect(workflow.permissions).toEqual({ contents: "read" });
	expect(
		Object.entries(workflow.jobs)
			.filter(([, job]) => job.permissions)
			.map(([name, job]) => [name, job.permissions]),
	).toEqual([
		["description", { contents: "read", issues: "read", "pull-requests": "read" }],
		["gate", { contents: "read", "id-token": "write" }],
	]);
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
	const child = Bun.spawn([process.execPath, "scripts/check.ts", "--bogus"], { stdout: "pipe", stderr: "pipe" });
	expect(await new Response(child.stderr).text()).toContain("check: unknown argument --bogus");
	expect(await child.exited).toBe(4);
	for (const [argv, message] of [
		[["test", "test/suite.test.ts"], "check: test files are named with --only and without --shard"],
		[["test", "--junit=a.xml"], "check: --junit names an .xml file and needs --only"],
		[["test", "--only=fast"], "check: --only is parallel or quiet"],
	] satisfies [string[], string][])
		expect(() => parseCheckArgs(argv)).toThrow(message);
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

test("the deployment pins every base and Compose image by digest", () => {
	const bases = [...readFileSync("Dockerfile", "utf8").matchAll(/^\s*FROM\s+(.+)$/gim)];
	expect(bases.length).toBeGreaterThan(0);
	for (const base of bases)
		expect(base[1], "a base image keeps its tag and pins its digest").toMatch(
			/^\S+:\S+@sha256:[a-f0-9]{64}(?:\s+AS\s+\S+)?$/i,
		);
	const files = [...new Glob("*compose*.{yaml,yml}").scanSync(".")];
	expect(files.length).toBeGreaterThan(0);
	for (const file of files) {
		const compose = z
			.object({ services: z.record(z.string(), z.object({ image: z.string().optional() })) })
			.parse(Bun.YAML.parse(readFileSync(file, "utf8")));
		for (const [service, { image }] of Object.entries(compose.services))
			if (image !== undefined)
				expect(image, `${file}: ${service} pins its image digest`).toMatch(/^\S+@sha256:[a-f0-9]{64}$/);
	}
});

test("the image fetches Debian snapshots over HTTPS with a pinned CA bundle", () => {
	const runtime =
		readFileSync("Dockerfile", "utf8")
			.split(/^FROM /m)
			.at(-1) ?? "";
	const sources = [...runtime.matchAll(/https?:\/\/snapshot\.debian\.org\/\S+/g)].map((match) => match[0]);
	expect(sources.length).toBe(3);
	for (const source of sources)
		expect(source, "snapshot metadata needs authenticated transport").toStartWith("https://");
	const caBundle = runtime.indexOf(
		"COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt",
	);
	expect(caBundle, "the digest-pinned build image supplies the trust roots").toBeGreaterThanOrEqual(0);
	expect(caBundle).toBeLessThan(runtime.indexOf("apt-get update"));
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
		["./check-plan.ts", "./preflight.ts", "./work/processes.ts", "node:fs", "node:os", "node:path"].sort(),
	);
	expect(loaded("scripts/work/processes.ts").sort()).toEqual(["./run.ts", "node:fs", "node:fs/promises", "node:path"]);
	expect(loaded("scripts/work/run.ts")).toEqual([]);
	expect(loaded("scripts/check-plan.ts").sort()).toEqual(["bun", "node:fs", "node:os", "node:path"]);
	expect(loaded("scripts/preflight.ts").sort()).toEqual(["node:fs", "node:path"]);
	expect(loaded("test/preflight.ts")).toEqual(["../scripts/preflight.ts"]);
	const check = readFileSync("scripts/check.ts", "utf8");
	expect(check.indexOf('requireReady("check")')).toBeGreaterThan(0);
	expect(check.indexOf('requireReady("check")')).toBeLessThan(check.indexOf("await import("));

	const installed = [
		...readFileSync(".github/workflows/check.yml", "utf8").matchAll(/bun-version: (\S+)/g),
		...readFileSync("Dockerfile", "utf8").matchAll(/FROM oven\/bun:([^\s@]+)/g),
	].map((match) => match[1] ?? "");
	expect(installed.length).toBeGreaterThanOrEqual(4);
	// The image's tag names a line (`1.4`), which is its newest release.
	for (const version of installed)
		expect(
			Bun.semver.satisfies(/^\d+\.\d+$/.test(version) ? `${version}.0` : version, `>=${OLDEST_BUN}`),
			version,
		).toBe(true);
});

test("the browser tests start Playwright's Chromium or the one MAINWORTHY_CHROMIUM names, never the system's", () => {
	const shell = "/cache/ms-playwright/chromium_headless_shell-1/chrome-headless-shell";
	const has =
		(...paths: string[]) =>
		(path: string) =>
			paths.includes(path);
	expect(findChromium({ MAINWORTHY_CHROMIUM: "/opt/chrome" }, has("/opt/chrome", shell), shell)).toEqual({
		path: "/opt/chrome",
	});
	expect(findChromium({}, has(shell, "/usr/bin/chromium"), shell)).toEqual({ path: shell });
	// A name that is not there falls back to Playwright's.
	expect(findChromium({ MAINWORTHY_CHROMIUM: "/gone" }, has(shell), shell)).toEqual({ path: shell });
	expect(findChromium({}, has("/usr/bin/chromium", "/usr/bin/google-chrome"), shell)).toEqual({
		path: null,
		skipped: `Playwright's Chromium is not installed at ${shell}: run \`bun run browser\` to run the browser tests.`,
	});
	expect(findChromium({ MAINWORTHY_CHROMIUM: "/gone" }, has(), null)).toEqual({
		path: null,
		skipped:
			"MAINWORTHY_CHROMIUM names /gone, which is not there. Playwright's Chromium is not installed: run `bun run browser` to run the browser tests.",
	});
});

test("Playwright's Chromium is the headless shell of the revision playwright-core was released with", () => {
	const manifest = JSON.parse(readFileSync("node_modules/playwright-core/browsers.json", "utf8")) as {
		browsers: { name: string; revision: string }[];
	};
	const revision = manifest.browsers.find((browser) => browser.name === "chromium-headless-shell")?.revision;
	expect(playwrightChromium()).toContain(`/chromium_headless_shell-${revision}/`);
	expect(playwrightChromium()).toMatch(/chrome-headless-shell(\.exe)?$/);
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
