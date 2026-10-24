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
import { budget } from "../scripts/budget.ts";
import {
	CI_SHARDS,
	chromiumLaunchOptions,
	failedTests,
	failureLines,
	findChromium,
	fixtureBuildArgs,
	needsBrowserFixture,
	newestAttempt,
	PERFORMANCE,
	parallelWorkers,
	parseCheckArgs,
	phaseFiles,
	phaseReport,
	playwrightChromium,
	readOutcome,
	STATIC_CHECKS,
	sharedBrowserEndpoint,
	slowest,
	testArgs,
} from "../scripts/check-plan.ts";
import {
	ChromiumDiagnosticOutput,
	type ChromiumSlot,
	chromiumDiagnosticPaths,
	StderrTail,
} from "../scripts/chromium-diagnostics.ts";
import { matrix, outputs } from "../scripts/ci-scope.ts";
import { OLDEST_BUN, unready } from "../scripts/preflight.ts";
import { make, remove } from "../scripts/work/scratch.ts";
import type { ResultIn } from "../src/core/ops.ts";
import { parseJUnit, TEST_FILE_LIMIT } from "../src/surfaces/formats/junit.ts";

test("database process lifecycle tests run serially outside the parallel shards", () => {
	expect(PERFORMANCE).toContain("test/check-process.test.ts");
	expect(phaseFiles("performance")).toContain("test/check-process.test.ts");
	expect(phaseFiles("parallel")).not.toContain("test/check-process.test.ts");
});

test("the local static plan includes async-port and each stage runs in CI", () => {
	expect(STATIC_CHECKS.map((check) => check.name)).toEqual(["typecheck", "lint", "async-port"]);
	const workflow = z
		.object({ jobs: z.object({ static: z.object({ steps: z.array(z.object({ run: z.string().optional() })) }) }) })
		.parse(Bun.YAML.parse(readFileSync(".github/workflows/check.yml", "utf8")));
	const commands = workflow.jobs.static.steps.map((step) => step.run);
	for (const stage of STATIC_CHECKS) expect(commands).toContain(`bun ${stage.args.join(" ")}`);
});

test("Chromium stderr tails retain at most 200 lines and 64 KiB, including partial and Unicode lines", () => {
	const tail = new StderrTail();
	tail.append(Array.from({ length: 250 }, (_, i) => `line ${i}\n`).join(""));
	expect(tail.text().split("\n").filter(Boolean)).toHaveLength(200);
	expect(tail.text()).toStartWith("line 50\n");
	tail.append("partial");
	tail.append(" line\n");
	expect(tail.text()).toEndWith("partial line\n");
	expect(tail.text().split("\n").filter(Boolean)).toHaveLength(200);
	tail.append("界".repeat(100_000));
	expect(Buffer.byteLength(tail.text())).toBeLessThanOrEqual(64 * 1024);
	expect(tail.text()).not.toContain("�");
	expect(tail.text()).toEndWith("界".repeat(100));
	tail.append("\nlast\n");
	expect(tail.text()).toEndWith("\nlast\n");
});

test("Chromium crash diagnostics coalesce each test, filter console output and secrets, and stay silent normally", () => {
	const tail = new StderrTail();
	tail.append(
		'FATAL: heap exhausted token=private-token password="private password" Authorization: Bearer private-bearer https://robin:private-pass@example.com\n',
	);
	tail.append('[123:INFO:CONSOLE:7] "session=abc123 /invite/zzsecret"\n');
	const slots = new Map([[2, { pid: 1234, stderr: tail, unexpectedExit: null }]]);
	const output = new ChromiumDiagnosticOutput(slots);
	const state = { slot: 2, file: "test/e2e/probe.test.ts", test: 1, contexts: 2, pages: 3, stderr: tail.text() };
	output.record({ ...state, kind: "crash", at: "2026-10-23T06:00:00.000Z" });
	output.record({ ...state, kind: "disconnected", at: "2026-10-23T06:00:01.000Z" });
	output.record({ ...state, kind: "state", contexts: 0, pages: 0 });
	const diagnostic = output.finish();
	expect(diagnostic.match(/check: Chromium diagnostic/g)).toHaveLength(1);
	for (const text of [
		"slot: 2",
		"browser PID: 1234",
		"test/e2e/probe.test.ts",
		"live contexts: 2",
		"live pages: 3",
		"2026-10-23T06:00:00.000Z",
		"2026-10-23T06:00:01.000Z",
		"FATAL: heap exhausted",
	])
		expect(diagnostic).toContain(text);
	for (const secret of [
		"private-token",
		"private password",
		"private-bearer",
		"private-pass",
		"INFO:CONSOLE",
		"abc123",
		"zzsecret",
	])
		expect(diagnostic).not.toContain(secret);
	expect(output.finish()).toBe("");
	const normal = new ChromiumDiagnosticOutput(slots);
	normal.record({ ...state, kind: "state" });
	expect(normal.finish()).toBe("");
	const disconnected = new ChromiumDiagnosticOutput(slots);
	disconnected.record({ ...state, kind: "disconnected", at: "2026-10-23T06:00:01.000Z" });
	expect(disconnected.finish()).toContain("browser disconnected: 2026-10-23T06:00:01.000Z");
});

test("Target closed failures join side-channel records by file and executed test, excluding skipped tests", () => {
	const slots = new Map([
		[1, { pid: 123, stderr: new StderrTail(), unexpectedExit: null }],
		[2, { pid: 456, stderr: new StderrTail(), unexpectedExit: null }],
	]);
	const output = new ChromiumDiagnosticOutput(slots);
	const state = { slot: 1, file: "test/e2e/one.test.ts", test: 1, contexts: 0, pages: 0, stderr: "slot one\n" };
	output.record({ ...state, kind: "state" });
	output.record({ ...state, test: 2, stderr: "later test\n", kind: "state" });
	output.record({
		...state,
		slot: 2,
		file: "test/e2e/two.test.ts",
		stderr: "slot two\n",
		kind: "disconnected",
		at: "2026-10-23T06:00:02.000Z",
	});
	const failed = (file: string, key: string): ResultIn => ({
		test: { key, file },
		outcome: "error",
		failure: { message: "locator.fill: Target page, context or browser has been closed" },
	});
	const results: ResultIn[] = [
		{ test: { file: state.file, key: "skipped" }, outcome: "skip" },
		failed(state.file, "first"),
		failed("test/e2e/two.test.ts", "other worker"),
		failed(state.file, "second"),
	];
	const text = output.finish(results);
	expect(text.match(/check: Chromium diagnostic/g)).toHaveLength(3);
	for (const part of [
		"crash event: not observed",
		"browser PID: 456",
		"slot two",
		"slot one",
		"executed test in file: 2",
		"live contexts: 0",
		"live pages: 0",
		"2026-10-23T06:00:02.000Z",
	])
		expect(text).toContain(part);
});

test("runner-owned exits report the current bounded tail when the worker disconnect record is missing", () => {
	const tail = new StderrTail();
	const slot: ChromiumSlot = { pid: 789, stderr: tail, unexpectedExit: null };
	const slots = new Map([[3, slot]]);
	const output = new ChromiumDiagnosticOutput(slots);
	output.record({
		slot: 3,
		file: "test/e2e/browser-exit.test.ts",
		test: 1,
		contexts: 2,
		pages: 3,
		kind: "state",
		stderr: "stale worker snapshot\n",
	});
	tail.append(`${"x".repeat(100_000)}\nFATAL: browser process SIGTRAP\n`);
	slot.unexpectedExit = { at: "2026-10-23T08:00:00.000Z", code: null, signal: "SIGTRAP" };
	const text = output.finish();
	expect(text.match(/check: Chromium diagnostic/g)).toHaveLength(1);
	for (const part of [
		"slot: 3",
		"browser PID: 789",
		"test/e2e/browser-exit.test.ts",
		"live contexts: 2",
		"live pages: 3",
		"SIGTRAP",
		"2026-10-23T08:00:00.000Z",
		"FATAL: browser process SIGTRAP",
	])
		expect(text).toContain(part);
	expect(text).not.toContain("stale worker snapshot");
	expect(output.finish()).toBe("");
	expect(
		Buffer.byteLength(text.split("Chromium stderr tail (last 200 lines / 64 KiB):\n")[1] ?? ""),
	).toBeLessThanOrEqual(64 * 1024);
	const noWorker = new ChromiumDiagnosticOutput(slots).finish();
	expect(noWorker.match(/check: Chromium diagnostic/g)).toHaveLength(1);
	expect(noWorker).toContain("test file: not recorded");
	expect(noWorker).toContain("FATAL: browser process SIGTRAP");
});

test("Browser closed and has-been-closed failures report once without requiring a crash event", () => {
	const slots = new Map([[1, { pid: 123, stderr: new StderrTail(), unexpectedExit: null }]]);
	const file = "test/e2e/closed-browser.test.ts";
	for (const message of [
		"evaluate: send: Browser closed",
		"newPage: send: Browser closed",
		"click: send: Browser closed",
		"context has been closed",
		"has been closed",
	]) {
		const output = new ChromiumDiagnosticOutput(slots);
		output.record({ slot: 1, file, test: 1, contexts: 0, pages: 0, kind: "state", stderr: "browser tail\n" });
		const text = output.finish([{ test: { key: "failure", file }, outcome: "error", failure: { message } }]);
		expect(text.match(/check: Chromium diagnostic/g), message).toHaveLength(1);
		expect(text).toContain("browser tail");
	}
	const unrelated = new ChromiumDiagnosticOutput(slots);
	unrelated.record({ slot: 1, file, test: 1, contexts: 0, pages: 0, kind: "state", stderr: "browser tail\n" });
	expect(
		unrelated.finish([
			{ test: { key: "unrelated", file }, outcome: "error", failure: { message: "the case was closed" } },
		]),
	).toBe("");
});

test("unchanged stderr snapshots carry forward across tests within a slot", () => {
	const file = "test/e2e/unchanged-stderr.test.ts";
	const output = new ChromiumDiagnosticOutput(
		new Map([[1, { pid: 123, stderr: new StderrTail(), unexpectedExit: null }]]),
	);
	output.record({ slot: 1, file, test: 1, contexts: 1, pages: 1, kind: "state", stderr: "unchanged slot stderr\n" });
	output.record({ slot: 1, file, test: 2, contexts: 0, pages: 0, kind: "state", stderr: null });
	const text = output.finish([
		{ test: { key: "first", file }, outcome: "pass" },
		{ test: { key: "second", file }, outcome: "error", failure: { message: "Target page has been closed" } },
	]);
	expect(text.match(/check: Chromium diagnostic/g)).toHaveLength(1);
	expect(text).toContain("executed test in file: 2");
	expect(text).toContain("unchanged slot stderr");
});

test("Chromium side-channel reading ignores damaged records and preserves bounded snapshots", () => {
	const root = mkdtempSync(join(tmpdir(), "mainworthy-diagnostic-records-"));
	try {
		const tail = new StderrTail();
		tail.append("original crash\n");
		const state = {
			slot: 1,
			file: "test/e2e/probe.test.ts",
			test: 1,
			contexts: 1,
			pages: 1,
			kind: "crash",
			at: "2026-10-23T06:00:00.000Z",
			stderr: tail.text(),
		};
		writeFileSync(
			chromiumDiagnosticPaths(root, 1).records,
			`null\n{"slot":"wrong"}\n${JSON.stringify(state)}\n{unfinished`,
		);
		tail.append("later unrelated output\n".repeat(250));
		const output = new ChromiumDiagnosticOutput(new Map([[1, { pid: 123, stderr: tail, unexpectedExit: null }]]));
		output.read(root);
		const text = output.finish();
		expect(text.match(/check: Chromium diagnostic/g)).toHaveLength(1);
		expect(text).toContain("original crash");
		expect(text).not.toContain("later unrelated output");
		const large = new StderrTail();
		large.append("token=x ".repeat(20_000));
		const bounded = new ChromiumDiagnosticOutput(new Map([[1, { pid: 123, stderr: large, unexpectedExit: null }]]));
		bounded.record({ ...state, kind: "crash", stderr: large.text() });
		const printed = bounded.finish().split("Chromium stderr tail (last 200 lines / 64 KiB):\n")[1] ?? "";
		expect(Buffer.byteLength(printed)).toBeLessThanOrEqual(64 * 1024);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a non-browser support import stays silent under diagnostics and an installed late-output guard", async () => {
	const root = mkdtempSync(join(tmpdir(), "mainworthy-diagnostic-import-"));
	const directory = join(root, "diagnostics");
	mkdirSync(directory);
	try {
		const file = join(root, "port-only.test.ts");
		writeFileSync(
			file,
			`import {afterAll,expect,test} from "bun:test";
import {startServer} from ${JSON.stringify(join(process.cwd(), "test/e2e/support.ts"))};
const original=process.stderr.write;
const late=[];
afterAll(()=>{process.stderr.write=original;});
test("installs a command's late-output guard",()=>{
 expect(typeof startServer).toBe("function");
 process.stderr.write=(chunk)=>{late.push(String(chunk));return true;};
});
test("does not capture diagnostic output from a port-only import",()=>{
 process.stderr.write=original;
 expect(late).toEqual([]);
});`,
		);
		const child = Bun.spawn([process.execPath, "test", "--parallel=1", file], {
			env: { ...process.env, MAINWORTHY_E2E_DIAGNOSTICS: "1", MAINWORTHY_E2E_DIAGNOSTICS_DIRECTORY: directory },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exit] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect({ exit, diagnosticOutput: (stdout + stderr).includes("MAINWORTHY_CHROMIUM") }, stdout + stderr).toEqual({
			exit: 0,
			diagnosticOutput: false,
		});
		expect(readdirSync(directory)).toEqual([]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

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
		writeFileSync(chromiumDiagnosticPaths(root, 1).stderr, `unchanged 25 KB stderr ${"x".repeat(25_000)}`);
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
});
test("a second test reuses unchanged stderr",()=>{});`,
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
						MAINWORTHY_E2E_DIAGNOSTICS: "1",
						MAINWORTHY_E2E_DIAGNOSTICS_DIRECTORY: root,
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
			expect({ exit, output: (out + err).match(/3 pass\s+0 fail/)?.[0].replace(/\s+/g, " ") }, out + err).toEqual({
				exit: 0,
				output: "3 pass 0 fail",
			});
			expect(out + err).not.toContain("MAINWORTHY_CHROMIUM ");
			const lines = (out + err).split("\n").filter((line) => line.trim());
			for (const [index, line] of lines.entries()) {
				if (!/\.test\.ts:$/.test(line)) continue;
				expect(lines[index + 1]).toBeDefined();
				expect(lines[index + 1]).not.toMatch(/\.test\.ts:$/);
			}
			expect(existsSync(chromiumDiagnosticPaths(root, 1).records)).toBe(true);
			const records = readFileSync(chromiumDiagnosticPaths(root, 1).records, "utf8")
				.trim()
				.split("\n")
				.map((line) => z.object({ stderr: z.string().nullable() }).parse(JSON.parse(line)));
			const snapshots = records.filter((record) => record.stderr !== null);
			expect(snapshots).toHaveLength(2); // One unchanged payload per isolated file, rather than per test.
			expect(snapshots.map((record) => record.stderr?.length)).toEqual([25_023, 25_023]);
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

test("the browser fixture uses the production compiler flags and source root", () => {
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

test("a browser phase builds once, including performance and shards, but named server tests need no fixture", () => {
	expect(needsBrowserFixture(["parallel", "performance"])).toBe(true);
	expect(needsBrowserFixture(["performance"])).toBe(true);
	expect(needsBrowserFixture(["parallel"], "2/6")).toBe(true);
	expect(needsBrowserFixture(["parallel"], undefined, ["test/e2e/phone.test.ts"])).toBe(true);
	expect(needsBrowserFixture(["parallel"], undefined, ["test/check.test.ts"])).toBe(false);
});

test("a broken browser fixture build fails the check before any test runs, even with an inherited executable", async () => {
	const root = mkdtempSync(join(tmpdir(), "mainworthy-broken-fixture-"));
	try {
		for (const dir of ["scripts/work", "test/e2e", "src/server/ops", "src/cli"])
			mkdirSync(join(root, dir), { recursive: true });
		for (const file of [
			"budget.ts",
			"check.ts",
			"check-plan.ts",
			"chromium-diagnostics.ts",
			"preflight.ts",
			"pg.ts",
			"work/scratch.ts",
			"work/test-databases.ts",
			"work/processes.ts",
			"work/run.ts",
		])
			copyFileSync(`scripts/${file}`, join(root, "scripts", file));
		writeFileSync(join(root, "package.json"), "{}");
		writeFileSync(join(root, "test/e2e/serve.ts"), "const broken = ;");
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

test("the default check runs functional files with a bounded per-run worker count", () => {
	expect(parseCheckArgs([]).phases).toEqual(["parallel"]);
	expect(parseCheckArgs(["test"]).phases).toEqual(["parallel"]);
	expect(parseCheckArgs(["--workers=3"]).workers).toBe(3);
	expect(parseCheckArgs(["test", "--update-timings"]).phases).toEqual(["parallel", "performance"]);
	expect(parseCheckArgs(["test", "--update-timings"]).workers).toBe(1);
	// Half the free threads, at most half of all of them and at least two (#902).
	expect(parallelWorkers(16, 0)).toBe(8);
	expect(parallelWorkers(16, 6)).toBe(5);
	expect(parallelWorkers(10, 40)).toBe(2);
	expect(parallelWorkers(64, 0)).toBe(32);
	expect(parallelWorkers(2, 0)).toBe(1);
	expect(parallelWorkers(1, 5)).toBe(1);
	for (const workers of ["0", "-1", "2.5", "NaN", "Infinity"])
		expect(() => parseCheckArgs([`--workers=${workers}`])).toThrow("positive number");
});

test("every test file is in exactly one phase: the performance files, and everything but them", () => {
	expect(phaseFiles("performance")).toContain("test/policy-latency.test.ts");
	expect(phaseFiles("parallel")).not.toContain("test/policy-latency.test.ts");
	for (const file of PERFORMANCE)
		expect(existsSync(file), `${file} is listed as performance and is not there`).toBe(true);
	const performance = testArgs("performance", { timings: "t.json" });
	const parallel = testArgs("parallel", { timings: "t.json" });
	expect(performance.filter((arg) => arg.startsWith("./"))).toEqual(PERFORMANCE.map((file) => `./${file}`));
	expect(performance).not.toContain("src");
	expect(parallel.filter((arg) => arg.startsWith("--path-ignore-patterns="))).toEqual(
		PERFORMANCE.map((file) => `--path-ignore-patterns=${file}`),
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
	expect(testArgs("performance", { timings: "t.json", shard: "2/5" })).not.toContain("--shard=2/5");
});

test("the workers fit the machine: the performance phase is alone on a small one", () => {
	expect(testArgs("performance", { timings: "t.json" })).toContain("--parallel=1");
	expect(() => parseCheckArgs(["test", "--only=performance", "--workers=2"])).toThrow("one worker");
	expect(parallelWorkers(2)).toBeGreaterThanOrEqual(1);
	expect(testArgs("performance", { timings: "t.json", workers: 8 })).toContain("--parallel=1");
	expect(testArgs("parallel", { timings: "t.json", workers: 3 })).toContain("--parallel=3");
});

test("CI functional runners leave a CPU for PostgreSQL", () => {
	for (const entries of [matrix("all"), matrix(["test/docs.test.ts", "test/policy-latency.test.ts"])]) {
		for (const entry of entries) {
			if (entry.name === "performance") {
				expect(entry.phase).toBe("--only=performance");
				continue;
			}
			const options = parseCheckArgs(["test", ...entry.phase.split(" ")]);
			expect(options.workers).toBe(1);
			expect(testArgs("parallel", { timings: "t.json", workers: options.workers, shard: options.shard })).toContain(
				"--parallel=1",
			);
		}
	}
});

test("the workflow runs the shards the scope names and its gate reads every one of them", () => {
	expect(CI_SHARDS).toBe(14);
	const workflow = readFileSync(".github/workflows/check.yml", "utf8");
	const shards = Array.from({ length: CI_SHARDS }, (_, i) => `tests-${i + 1}`);
	expect(matrix("all")).toEqual([
		...shards.map((name, i) => ({
			name,
			phase: `--only=parallel --workers=1 --shard=${i + 1}/${CI_SHARDS}`,
			files: "",
		})),
		{ name: "performance", phase: "--only=performance", files: "" },
	]);
	const all = Object.fromEntries(
		outputs({ why: "", jobs: { static: true, image: true, ios: true }, tests: "all" }).map((line) =>
			line.split(/=(.*)/s),
		),
	);
	expect(all.shards).toBe(`${shards.join(" ")} performance`);
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
			`if: ${expression(
				job === "image"
					? "(github.event_name == 'push' && github.ref == 'refs/heads/main') || needs.scope.outputs.image == 'true'"
					: `needs.scope.outputs.${job} == 'true'`,
			)}`,
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
		expect(newestAttempt(root, "performance")).toEqual({ directory: root, attempt: null });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the workflow gives the pipeline's token to the one step that reports, and that step chooses the Mainworthy", () => {
	const Step = z.object({
		name: z.string().optional(),
		env: z.record(z.string(), z.string()).optional(),
		run: z.string().optional(),
	});
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
	expect(Object.keys(workflow.jobs)).toEqual([
		"scope",
		"static",
		"image",
		"ios",
		"description",
		"tests",
		"gate",
		"publish",
	]);
	expect(
		[workflow.env, ...Object.values(workflow.jobs).map((job) => job.env)]
			.filter((env) => env !== undefined)
			.map((env) => {
				const entries = z.record(z.string(), z.string()).parse(env);
				if (entries.MAINWORTHY_TEST_PG !== undefined)
					expect(entries.MAINWORTHY_TEST_PG).toBe("postgres://postgres@127.0.0.1:5432/postgres");
				return Object.fromEntries(Object.entries(entries).filter(([key]) => key !== "MAINWORTHY_TEST_PG"));
			})
			.filter((env) => Object.keys(env).length > 0),
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
		["publish", { contents: "read", packages: "write" }],
	]);
	// The choice of instance is the script's (scripts/ci-instance.ts): no step starts a server. (The `image` job
	// runs the container it built, to ask it for a page; nothing reports to that one.)
	expect(
		Object.values(workflow.jobs)
			.flatMap((job) => job.steps.map((step) => step.run ?? ""))
			.join("\n"),
	).not.toMatch(/(?:^|\s)serve(?:\s|$)/);
});

// Issue #856. GitHub skips a job whose condition has no status function when any job before it, however far back,
// was skipped. A job after one that may be skipped therefore says, with a status function, what it waits for.
test("a job after one that may be skipped names its own condition for running", () => {
	const job = z.object({ needs: z.array(z.string()).or(z.string()).optional(), if: z.string().optional() });
	const { jobs } = z
		.object({ jobs: z.record(z.string(), job) })
		.parse(Bun.YAML.parse(readFileSync(".github/workflows/check.yml", "utf8")));
	const needs = (name: string): string[] => [jobs[name]?.needs ?? []].flat();
	const before = (name: string): string[] => needs(name).flatMap((one) => [one, ...before(one)]);
	const unguarded = Object.keys(jobs).filter(
		(name) =>
			before(name).some((one) => jobs[one]?.if !== undefined) &&
			!/\b(always|cancelled|failure|success)\(\)/.test(jobs[name]?.if ?? ""),
	);
	expect(unguarded).toEqual([]);
});

test("only main publishes the image that passed the smoke test, after the gate", () => {
	const step = z.object({
		uses: z.string().optional(),
		run: z.string().optional(),
		if: z.string().optional(),
		with: z.record(z.string(), z.unknown()).optional(),
	});
	const job = z.object({
		needs: z.array(z.string()).or(z.string()).optional(),
		if: z.string().optional(),
		permissions: z.record(z.string(), z.string()).optional(),
		steps: z.array(step),
	});
	const workflow = z
		.object({ permissions: z.record(z.string(), z.string()), jobs: z.record(z.string(), job) })
		.parse(Bun.YAML.parse(readFileSync(".github/workflows/check.yml", "utf8")));
	const { image, publish, gate } = z.object({ image: job, publish: job, gate: job }).parse(workflow.jobs);
	const expression = (name: string): string => `$\{{ ${name} }}`;
	const main = "github.event_name == 'push' && github.ref == 'refs/heads/main'";
	// Issue #856. Without a status function GitHub adds `success()`, which is false when any job the publish
	// follows, through the gate too, was skipped: `description` always is on a push, so the publish never ran.
	expect(publish.if).toBe(
		expression(`!cancelled() && needs.gate.result == 'success' && needs.image.result == 'success' && ${main}`),
	);
	expect(publish.needs).toEqual(["gate", "image"]);
	expect(gate.needs).not.toContain("publish");
	// Even a prose-only main commit needs its own embedded revision and image tag.
	expect(image.if).toBe(expression(`(${main}) || needs.scope.outputs.image == 'true'`));
	expect(workflow.permissions).toEqual({ contents: "read" });
	expect(
		Object.entries(workflow.jobs)
			.filter(([, one]) => one.permissions?.packages === "write")
			.map(([name]) => name),
	).toEqual(["publish"]);
	expect(publish.permissions).toEqual({ contents: "read", packages: "write" });
	const builds = Object.values(workflow.jobs).flatMap((one) =>
		one.steps.filter((one) => one.uses?.startsWith("docker/build-push-action@")),
	);
	expect(builds).toHaveLength(1);
	expect(builds[0]?.with).toMatchObject({
		context: ".",
		load: true,
		push: false,
		tags: "mainworthy:check",
		"build-args": `MAINWORTHY_COMMIT=${expression("github.sha")}\n`,
		"cache-from": "type=gha",
		"cache-to": "type=gha,mode=max",
	});
	expect(builds[0]?.with?.labels).toBe(
		`org.opencontainers.image.source=${expression("github.server_url")}/${expression("github.repository")}\n` +
			`org.opencontainers.image.revision=${expression("github.sha")}\n` +
			`org.opencontainers.image.created=${expression("steps.created.outputs.time")}\n`,
	);
	const smokeIndex = image.steps.findIndex((one) => one.run?.includes("docker run"));
	const smoke = image.steps[smokeIndex]?.run ?? "";
	expect(smoke).toContain("mainworthy:check");
	expect(smoke).toContain(".ok == true and .commit == $commit");
	const saveIndex = image.steps.findIndex((one) => one.run?.includes("docker save"));
	expect(saveIndex).toBeGreaterThan(smokeIndex);
	expect(image.steps[saveIndex]?.if).toBe(expression(main));
	expect(image.steps[saveIndex]?.run).toContain("mainworthy:check");
	const upload = image.steps.find((one) => one.uses?.startsWith("actions/upload-artifact@"));
	const download = publish.steps.find((one) => one.uses?.startsWith("actions/download-artifact@"));
	expect(upload?.if).toBe(expression(main));
	expect(upload?.with?.name).toBe("mainworthy-image");
	expect(upload?.with?.overwrite).toBe(true);
	expect(download?.with?.name).toBe(upload?.with?.name);
	expect(image.steps[saveIndex]?.run).toContain(String(upload?.with?.path));
	const login = publish.steps.find((one) => one.uses?.startsWith("docker/login-action@"));
	expect(login?.with).toEqual({
		registry: "ghcr.io",
		username: expression("github.actor"),
		password: expression("github.token"),
	});
	expect(image.steps.some((one) => one.uses?.startsWith("docker/login-action@"))).toBe(false);
	const push = publish.steps.map((one) => one.run ?? "").join("\n");
	expect(push).toContain("docker load --input");
	expect(push).not.toMatch(/\bdocker (?:build(?:\s|$)|buildx build(?:\s|$))/);
	expect(push).toContain('--tag "$image:$GITHUB_SHA" "$image@$digest"');
	expect(push).toContain('--tag "$image:main" "$image@$digest"');
	expect(push).toContain('if [ "$tip" = "$GITHUB_SHA" ]; then');
	expect(readFileSync("compose.coolify.yaml", "utf8")).toContain("    build: .\n");
	expect(readFileSync("Dockerfile", "utf8")).toContain("ENV MAINWORTHY_COMMIT=$MAINWORTHY_COMMIT");
});

test("every workflow pins every action to a full commit with a release version comment", () => {
	const job = z.object({
		uses: z.string().optional(),
		steps: z.array(z.object({ uses: z.string().optional() })).default([]),
	});
	for (const file of new Glob(".github/workflows/*.{yml,yaml}").scanSync(".")) {
		const source = readFileSync(file, "utf8");
		const { jobs } = z.object({ jobs: z.record(z.string(), job) }).parse(Bun.YAML.parse(source));
		const actions = Object.values(jobs)
			.flatMap((job) => [job.uses, ...job.steps.map((step) => step.uses)])
			.filter((uses) => uses !== undefined);
		const lines = [...source.matchAll(/^[\t ]*(?:-[\t ]+)?uses:[\t ]*(.+)$/gm)];
		expect(lines.length, `${file}: every action has its own annotated uses line`).toBe(actions.length);
		for (const uses of actions) expect(uses, file).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
		for (const line of lines) expect(line[1], file).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
	}
});

test("image publication derives creation time from the commit", () => {
	const workflow = readFileSync(".github/workflows/check.yml", "utf8");
	const actionJob = z.object({ steps: z.array(z.object({ uses: z.string().optional(), run: z.string().optional() })) });
	const { jobs } = z
		.object({ jobs: z.object({ image: actionJob, publish: actionJob }) })
		.parse(Bun.YAML.parse(workflow));
	const created = jobs.image.steps.find((step) => step.run?.includes("time="))?.run ?? "";
	expect(created).toContain("git log -1 --format=%cI");
	expect(created).not.toContain("date ");
});

for (const mode of ["missing", "same", "different", "unreadable", "bad-digest", "stage-fails", "stale-main"]) {
	test(`image publication preserves commit tags when the registry is ${mode}`, () => {
		const { jobs } = z
			.object({ jobs: z.object({ publish: z.object({ steps: z.array(z.object({ run: z.string().optional() })) }) }) })
			.parse(Bun.YAML.parse(readFileSync(".github/workflows/check.yml", "utf8")));
		const script = jobs.publish.steps.find((step) => step.run?.includes("docker load"))?.run;
		expect(script).toBeDefined();
		if (!script) throw new Error("publish has no executable step");
		const root = make("publish-contract");
		const sha = "0123456789012345678901234567890123456789";
		const image = "ghcr.io/endqwerty/mainworthy";
		const digest = `sha256:${"a".repeat(64)}`;
		try {
			writeFileSync(
				join(root, "docker"),
				`#!/bin/bash
set -eu
printf '%s\\n' "$*" >> "$COMMAND_LOG"
if [ "$1" = push ] && [ "$MODE" = stage-fails ]; then exit 1; fi
if [ "$1 $\{2:-} $\{3:-}" = 'buildx imagetools inspect' ]; then
  case "$4" in
    *:build-*)
      if [ "$MODE" = bad-digest ]; then echo invalid; else echo "$CANDIDATE_DIGEST"; fi ;;
    *)
      case "$MODE" in
        same) echo "$CANDIDATE_DIGEST" ;;
        different) echo 'sha256:${"b".repeat(64)}' ;;
        unreadable) echo 'unauthorized: authentication required' >&2; exit 1 ;;
        *) echo "ERROR: $4: not found" >&2; exit 1 ;;
      esac ;;
  esac
fi
`,
				{ mode: 0o755 },
			);
			writeFileSync(
				join(root, "gh"),
				`#!/bin/bash
if [ "$MODE" = stale-main ]; then echo '${"f".repeat(40)}'; else echo "$GITHUB_SHA"; fi
`,
				{ mode: 0o755 },
			);
			const result = Bun.spawnSync(["/bin/bash", "-euo", "pipefail", "-c", script], {
				env: {
					...process.env,
					PATH: `${root}:${process.env.PATH}`,
					MODE: mode,
					CANDIDATE_DIGEST: digest,
					COMMAND_LOG: join(root, "commands"),
					RUNNER_TEMP: root,
					GITHUB_SHA: sha,
					GITHUB_REPOSITORY: "endqwerty/mainworthy",
					GITHUB_RUN_ID: "100",
					GITHUB_RUN_ATTEMPT: "2",
					GITHUB_STEP_SUMMARY: join(root, "summary"),
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const log = readFileSync(join(root, "commands"), "utf8");
			const output = result.stdout.toString() + result.stderr.toString();
			const commitWrites = log
				.split("\n")
				.filter(
					(line) =>
						line === `push ${image}:${sha}` ||
						(line.startsWith("buildx imagetools create ") && line.includes(`--tag ${image}:${sha} `)),
				);
			if (["different", "unreadable", "bad-digest", "stage-fails"].includes(mode)) {
				expect(result.exitCode).not.toBe(0);
				expect(commitWrites).toEqual([]);
				expect(log).not.toContain(`${image}:main`);
				if (mode === "different") expect(output).toContain("Refusing to overwrite");
			} else {
				expect(result.exitCode, output).toBe(0);
				expect(commitWrites).toHaveLength(mode === "same" ? 0 : 1);
				expect(readFileSync(join(root, "summary"), "utf8")).toContain(`${image}@${digest}`);
				if (mode === "stale-main") expect(log).not.toContain(`${image}:main`);
				else expect(log).toContain(`--tag ${image}:main ${image}@${digest}`);
			}
		} finally {
			remove(root);
		}
	});
}

test("the slowest files are read from the timings Bun writes", () => {
	expect(slowest({ version: 1, files: { "a.test.ts": 1500, "b.test.ts": 62000, "c.test.ts": 20 } }, 2)).toEqual([
		{ file: "b.test.ts", seconds: 62 },
		{ file: "a.test.ts", seconds: 1.5 },
	]);
	expect(slowest(null, 2)).toEqual([]);
	expect(
		slowest({ files: { "functional.test.ts": 10, "performance.test.ts": 5000 } }, 1, ["functional.test.ts"]),
	).toEqual([{ file: "functional.test.ts", seconds: 0.01 }]);
});

test("the check refuses an argument it does not know, so a mistyped one does not run everything", async () => {
	const child = Bun.spawn([process.execPath, "scripts/check.ts", "--bogus"], { stdout: "pipe", stderr: "pipe" });
	expect(await new Response(child.stderr).text()).toContain("check: unknown argument --bogus");
	expect(await child.exited).toBe(4);
	for (const [argv, message] of [
		[["test", "test/suite.test.ts"], "check: test files are named with --only and without --shard"],
		[["test", "--junit=a.xml"], "check: --junit names an .xml file and needs --only"],
		[["test", "--only=fast"], "check: --only is parallel or performance"],
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

test("CI installs PostgreSQL snapshot tools before running the test matrix", () => {
	const workflow = z
		.object({
			jobs: z.object({
				tests: z.object({
					steps: z.array(
						z.object({
							run: z.string().optional(),
							name: z.string().optional(),
						}),
					),
				}),
			}),
		})
		.parse(Bun.YAML.parse(readFileSync(".github/workflows/check.yml", "utf8")));
	const steps = workflow.jobs.tests.steps;
	const tools = steps.findIndex(
		(step) => step.run?.includes("pg_dump --version") && step.run.includes("pg_restore --version"),
	);
	expect(tools, "a service container does not install snapshot clients on the runner").toBeGreaterThanOrEqual(0);
	expect(tools).toBeLessThan(steps.findIndex((step) => step.name === "Tests"));
});

test("CI functional PostgreSQL skips durability while the performance job keeps it", async () => {
	const Step = z.object({
		name: z.string().optional(),
		run: z.string().optional(),
		env: z.record(z.string(), z.string()).optional(),
	});
	const Job = z.object({ services: z.unknown().optional(), steps: z.array(Step) });
	const workflow = z
		.object({ jobs: z.object({ tests: Job, gate: Job }) })
		.parse(Bun.YAML.parse(readFileSync(".github/workflows/check.yml", "utf8")));
	const starts = [workflow.jobs.tests, workflow.jobs.gate].map((job) => {
		const step = job.steps.find((one) => one.run?.includes("bash scripts/ci-postgres.sh"));
		expect(step, "the throwaway database starts with the selected CI durability mode").toBeDefined();
		return step;
	});
	const expression = (name: string): string => `$\{{ ${name} }}`;
	expect(starts[0]?.env).toEqual({ TEST_PHASE: expression("matrix.phase") });
	expect(starts[1]?.env).toEqual({ TEST_PHASE: "--only=parallel" });
	const root = make("ci-postgres-args");
	const argsFile = join(root, "args");
	writeFileSync(
		join(root, "docker"),
		`#!/bin/sh
printf '%s\n' "$@" >> "$DOCKER_ARGS"
if [ "$1" = exec ] && [ "$3" = psql ]; then
 mode=$(sed -n 's/^fsync=//p' "$DOCKER_ARGS")
 if [ -n "$DOCKER_SETTINGS" ]; then
 printf '%s\\n' "$DOCKER_SETTINGS"
 else
 printf '%s,%s,%s\n' "$mode" "$mode" "$mode"
 fi
fi
`,
		{ mode: 0o755 },
	);
	try {
		const entries = [...matrix("all"), ...matrix(["test/check.test.ts"])];
		for (const [index, job] of [workflow.jobs.tests, workflow.jobs.gate].entries()) {
			expect(job.services).toBeUndefined();
			const step = starts[index];
			if (!step?.run) throw new Error("missing PostgreSQL startup");
			expect(job.steps.indexOf(step)).toBeLessThan(
				job.steps.findIndex(
					(one) => one.name === (index === 0 ? "Tests" : "Report every shard to Mainworthy, then the gate"),
				),
			);
			for (const entry of index === 0 ? entries : [{ phase: "--only=parallel", name: "gate" }]) {
				writeFileSync(argsFile, "");
				const child = Bun.spawn(["bash", "-e", "-c", step.run], {
					env: {
						...process.env,
						PATH: `${root}:${process.env.PATH}`,
						TEST_PHASE: entry.phase,
						DOCKER_ARGS: argsFile,
						DOCKER_SETTINGS: "",
					},
					stdout: "pipe",
					stderr: "pipe",
				});
				const [out, err, rc] = await Promise.all([
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
					child.exited,
				]);
				expect(rc, out + err).toBe(0);
				const args = readFileSync(argsFile, "utf8").trim().split("\n");
				const mode = entry.name === "performance" ? "on" : "off";
				for (const key of ["fsync", "synchronous_commit", "full_page_writes"])
					expect(args, entry.name).toContain(`${key}=${mode}`);
				expect(args).toContain("--shm-size=256m");
				expect(args).toContain("127.0.0.1:5432:5432");
				for (const command of ["pg_isready", "psql"])
					for (const [position, arg] of args.entries())
						if (arg === command) expect(args.slice(position + 1, position + 3)).toEqual(["-h", "127.0.0.1"]);
				expect(args).toContain("postgres:18@sha256:edb0c08dc33befd0262ab3b5cf1c4f3f8cfd8b09e88c05b45adee29d6761ddb6");
				const image = args.indexOf(
					"postgres:18@sha256:edb0c08dc33befd0262ab3b5cf1c4f3f8cfd8b09e88c05b45adee29d6761ddb6",
				);
				expect(args.slice(image + 1, image + 8)).toEqual([
					"postgres",
					"-c",
					`fsync=${mode}`,
					"-c",
					`synchronous_commit=${mode}`,
					"-c",
					`full_page_writes=${mode}`,
				]);
			}
		}
		const functional = starts[0]?.run;
		if (!functional) throw new Error("missing functional PostgreSQL startup");
		for (const settings of ["on,off,off", "off,on,off", "off,off,on"]) {
			writeFileSync(argsFile, "");
			const child = Bun.spawn(["bash", "-e", "-c", functional], {
				env: {
					...process.env,
					PATH: `${root}:${process.env.PATH}`,
					TEST_PHASE: "--only=parallel",
					DOCKER_ARGS: argsFile,
					DOCKER_SETTINGS: settings,
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const [out, err, rc] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect(out + err).toContain(`PostgreSQL durability: ${settings}`);
			expect(rc, "a server that ignored any setting must stop the job before tests").not.toBe(0);
		}
	} finally {
		remove(root);
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
		[
			"./budget.ts",
			"./check-plan.ts",
			"./chromium-diagnostics.ts",
			"./preflight.ts",
			"./work/processes.ts",
			"node:fs",
			"node:os",
			"node:path",
		].sort(),
	);
	expect(loaded("scripts/work/processes.ts").sort()).toEqual([
		"../pg.ts",
		"./run.ts",
		"./test-databases.ts",
		"node:fs",
		"node:fs/promises",
		"node:path",
	]);
	expect(loaded("scripts/work/run.ts")).toEqual([]);
	expect(loaded("scripts/check-plan.ts").sort()).toEqual(["bun", "node:fs", "node:os", "node:path"]);
	expect(loaded("scripts/chromium-diagnostics.ts").sort()).toEqual(["node:fs", "node:path"]);
	expect(loaded("scripts/preflight.ts").sort()).toEqual(["./pg.ts", "node:fs", "node:path"]);
	expect(loaded("test/preflight.ts").sort()).toEqual([
		"../scripts/pg.ts",
		"../scripts/preflight.ts",
		"../scripts/work/processes.ts",
		"bun:test",
	]);
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
	expect(
		failureLines([phaseReport("tests: parallel", [], null), phaseReport("tests: performance", null, PERFORMANCE)]),
	).toEqual([
		'tests: parallel failed and no test in it did: something failed outside a test. Look above for "error:".',
		"tests: performance left no report of its tests: the runner stopped before its end. Its last lines say why.",
	]);
	// The files of a phase are the ones `bun test` is given: every test file is in one of the two, and a shard's
	// share is Bun's to choose.
	const parallel = phaseFiles("parallel") ?? [];
	expect(phaseFiles("performance")).toEqual(PERFORMANCE);
	expect(phaseFiles("parallel", "2/6")).toBeNull();
	expect(parallel).toContain("test/check.test.ts");
	expect(parallel.filter((file) => PERFORMANCE.includes(file))).toEqual([]);
	expect(parallel.length + PERFORMANCE.length).toBe(
		[...new Glob("{src,test}/**/*.test.{ts,tsx}").scanSync(".")].length,
	);
});

async function budgetRun(phase: "parallel" | "performance", body: string) {
	const root = mkdtempSync(join(tmpdir(), "mainworthy-budget-run-"));
	const summary = join(root, "summary.md");
	const report = join(root, "results.xml");
	const files =
		phase === "performance"
			? ["test/budgets-performance.test.ts", "test/demo-removal-budget.test.ts"]
			: ["test/budget-warning.test.ts", "test/other-budget-warning.test.ts"];
	try {
		mkdirSync(join(root, "test"));
		for (const file of files)
			writeFileSync(
				join(root, file),
				`import { test } from "bun:test";
import { budget } from ${JSON.stringify(join(import.meta.dir, "../scripts/budget.ts"))};
test("a real workload", () => { ${body} });\n`,
			);
		const child = Bun.spawn(
			[
				process.execPath,
				join(import.meta.dir, "../scripts/check.ts"),
				"test",
				`--only=${phase}`,
				`--junit=${report}`,
				...files,
			],
			{
				cwd: root,
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, GITHUB_STEP_SUMMARY: summary, MAINWORTHY_CHROMIUM: "" },
			},
		);
		const [out, err, exit] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return {
			out,
			err,
			exit,
			outcome: readOutcome(join(root, "results.json")),
			results: existsSync(report) ? parseJUnit(readFileSync(report, "utf8")).results : [],
			summary: existsSync(summary) ? readFileSync(summary, "utf8") : "",
		};
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test("budget misses warn in local and CI summaries without failing either phase", async () => {
	for (const phase of ["parallel", "performance"] as const) {
		const result = await budgetRun(
			phase,
			'budget("synthetic latency", 125, 100, "ms"); budget("synthetic size", 321, 300, "tokens"); budget("at baseline", 100, 100, "ms");',
		);
		expect(result.exit, result.out + result.err).toBe(0);
		expect(result.outcome?.exit).toBe(0);
		expect(result.results.map((row) => row.outcome)).toEqual(["pass", "pass"]);
		expect(result.out).toContain("Budget warnings:\n");
		const warning = "WARNING: synthetic latency: 125 ms exceeds baseline 100 ms.";
		expect(result.out).toContain(warning);
		expect(result.summary).toContain(warning);
		expect(result.summary).toContain("321 tokens exceeds baseline 300 tokens");
		expect(result.summary).not.toContain("at baseline");
		expect(result.summary.match(/WARNING: synthetic latency:/g)).toHaveLength(2);
	}
}, 30_000);

test("workload errors still fail after an advisory miss in either phase", async () => {
	for (const phase of ["parallel", "performance"] as const) {
		const result = await budgetRun(
			phase,
			'budget("synthetic latency", 125, 100, "ms"); throw new Error("workload failed");',
		);
		expect(result.exit).toBe(1);
		expect(result.outcome?.exit).toBe(1);
		expect(result.out + result.err).toContain("workload failed");
		expect(result.summary).toContain("125 ms exceeds baseline 100 ms");
	}
	expect(() => budget("invalid measurement", Number.NaN, 100, "ms")).toThrow("must be finite");
}, 30_000);

test("a budget warns above its baseline and fails above ten times it", () => {
	// The owner, 2026-10-24: ten times is a jump to fail and review; meaning to is changing the baseline.
	expect(() => budget("a measurement", 1000, 100, "ms")).not.toThrow();
	expect(() => budget("a measurement", 1001, 100, "ms")).toThrow("more than 10 times its baseline");
	expect(() => budget("a zero baseline", 10, 0, "reads")).not.toThrow();
	expect(() => budget("a zero baseline", 11, 0, "reads")).toThrow("more than 10 times its baseline");
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
