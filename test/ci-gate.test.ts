// The last job of the check workflow (`scripts/ci-gate.ts`), run as the workflow runs it against a real
// Mainworthy: the result is Mainworthy's gate, and a report that is missing or says less than happened is not a pass.
import { expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { runCiGate } from "../scripts/ci-gate.ts";
import { chooseInstance, contractDifferences, deploymentFetch, type Probe, startOwn } from "../scripts/ci-instance.ts";
import { Client } from "../src/cli/client.ts";
import { runCli } from "../src/cli/dispatch.ts";
import { inThisProcess, type Running, withInstance } from "../src/cli/test-support.ts";
import { API_VERSION } from "../src/core/version.ts";
import { sql } from "../src/server/kernel/db.ts";
import { openApi } from "../src/surfaces/http.ts";

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
	/**
	 * The attempt of the run this report is from. With it the files are where the workflow's download puts them,
	 * in the directory of that attempt's artifact; without it they are in the directory the job is given.
	 */
	attempt?: number;
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

/**
 * A checkout with those test files, the shards' artifacts as downloaded, and the gate job's last step. The job
 * is pointed at the instance of the test unless `configure` says where else, or nowhere.
 */
async function gate(
	shards: Shard[],
	options: {
		inProcess?: boolean;
		request?: ReturnType<typeof deploymentFetch>;
		repository?: string[];
		missing?: string[];
		/** Shards whose report is there and cannot be read (a directory of that name). */
		unreadable?: string[];
		mode?: "local" | "server";
		/** A signal for the job, sent as soon as its output holds `after`. */
		signal?: { send: "SIGINT" | "SIGTERM"; after: string };
		/** Routes of the instance of the test that answer in place of its own. */
		routes?: NonNullable<Parameters<typeof withInstance>[1]>["routes"];
		configure?: (running: Running) => Promise<Record<string, string>>;
		/** The test files the change needed (`--files`), where the shards were not given every file. */
		files?: string[];
	} = {},
) {
	return await withInstance(
		async (running) => {
			const { instance } = running;
			const configured = (await options.configure?.(running)) ?? {};
			const root = await mkdtemp(join(tmpdir(), "mainworthy-ci-gate-"));
			try {
				const sources = options.repository ?? shards.flatMap((shard) => Object.keys(shard.files));
				for (const file of sources) {
					await mkdir(join(root, dirname(file)), { recursive: true });
					await writeFile(join(root, file), "");
				}
				await mkdir(join(root, "test-results"));
				await mkdir(join(root, "tmp"));
				for (const shard of shards) {
					if (options.missing?.includes(shard.name)) continue;
					const failed = Object.values(shard.files).some((failure) => failure !== null);
					const outcome = { exit: shard.exit ?? (failed ? 1 : 0), seconds: shard.seconds ?? 60 };
					const directory =
						shard.attempt === undefined
							? join(root, "test-results")
							: join(root, "test-results", `results-${shard.name}-attempt-${shard.attempt}`);
					await mkdir(directory, { recursive: true });
					if (options.unreadable?.includes(shard.name)) await mkdir(join(directory, `${shard.name}.xml`));
					else await writeFile(join(directory, `${shard.name}.xml`), shard.xml ?? junit(shard.files));
					await writeFile(join(directory, `${shard.name}.json`), JSON.stringify(outcome));
				}
				const argv = [
					"test-results",
					...new Set(shards.map((shard) => shard.name)),
					...(options.files ? [`--files=${options.files.join(",")}`] : []),
				];
				const env = {
					PATH: process.env.PATH ?? "",
					HOME: root,
					MAINWORTHY_TEST_PG: process.env.MAINWORTHY_TEST_PG ?? "",
					// What the job leaves in the temporary directory is this test's to count.
					TMPDIR: join(root, "tmp"),
					MAINWORTHY_URL: instance.url,
					MAINWORTHY_TOKEN: "",
					MAINWORTHY_PROJECT: "",
					GITHUB_ACTIONS: "true",
					GITHUB_EVENT_NAME: "pull_request",
					GITHUB_REF: "refs/pull/77/merge",
					GITHUB_HEAD_REF: "dx/fast-check",
					GITHUB_SHA: "c0ffee0123456789012345678901234567890123",
					GITHUB_REPOSITORY: "endqwerty/mainworthy",
					GITHUB_RUN_ID: "1",
					GITHUB_RUN_ATTEMPT: "1",
					GITHUB_JOB: "gate",
					GITHUB_STEP_SUMMARY: join(root, "summary.md"),
					...configured,
				};
				if (options.inProcess) {
					const printed = spyOn(console, "log").mockImplementation((text: unknown) => {
						process.stdout.write(`${String(text)}\n`);
					});
					let result: Awaited<ReturnType<typeof inThisProcess>>;
					try {
						result = await inThisProcess("ci-gate", async () => await runCiGate(argv, env, options.request), {
							environment: env,
							cwd: root,
							input: "",
						});
					} finally {
						printed.mockRestore();
					}
					return {
						code: result.code,
						output: result.stdout + result.stderr,
						summary: await readFile(join(root, "summary.md"), "utf8").catch(() => ""),
						left: [...(await readdir(join(root, "tmp"))), ...(await stillRunning(result.stdout))],
						batches: (
							await instance.app.database.read(
								async (db) => await db.get(sql<readonly [], { n: number }>("SELECT count(*) AS n FROM batches")),
							)
						)?.n,
						batchJobs: await instance.app.database.read(
							async (db) =>
								await db.all(
									sql<readonly [], { job: string; shard: number | null; n: number }>(
										"SELECT job, shard, count(*) AS n FROM batches GROUP BY job, shard ORDER BY job, shard",
									),
								),
						),
					};
				}
				const child = Bun.spawn([process.execPath, resolve("scripts/ci-gate.ts"), ...argv], {
					cwd: root,
					env,
					stdout: "pipe",
					stderr: "pipe",
				});
				const printed = async (): Promise<string> => {
					let text = "";
					let signalled = false;
					const decoder = new TextDecoder();
					for await (const chunk of child.stdout) {
						text += decoder.decode(chunk, { stream: true });
						if (options.signal && !signalled && text.includes(options.signal.after)) {
							signalled = true;
							child.kill(options.signal.send);
						}
					}
					return text;
				};
				const [stdout, stderr, code] = await Promise.all([printed(), new Response(child.stderr).text(), child.exited]);
				return {
					code,
					output: stdout + stderr,
					summary: await readFile(join(root, "summary.md"), "utf8").catch(() => ""),
					/** What the job left behind: files in its temporary directory, and its own Mainworthy if that still runs. */
					left: [...(await readdir(join(root, "tmp"))), ...(await stillRunning(stdout))],
					/** How many reports the instance of the test holds. */
					batches: (
						await instance.app.database.read(
							async (db) => await db.get(sql<readonly [], { n: number }>("SELECT count(*) AS n FROM batches")),
						)
					)?.n,
				};
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
		{ ...(options.mode ? { mode: options.mode } : {}), ...(options.routes ? { routes: options.routes } : {}) },
	);
}

const green: Shard[] = [
	{ name: "tests-1", files: { "test/a.test.ts": null, "src/b.test.ts": null } },
	{ name: "tests-2", files: { "test/c.test.ts": null } },
	{ name: "performance", files: { "test/budgets.test.ts": null } },
];
const withFailure = (message: string): Shard[] =>
	green.map((shard) => (shard.name === "tests-2" ? { ...shard, files: { "test/c.test.ts": message } } : shard));

test("CI awaits the retry pause before sending another request", async () => {
	const paused = Promise.withResolvers<void>();
	const resume = Promise.withResolvers<void>();
	let calls = 0;
	const request = deploymentFetch(
		{
			fetch: async () => new Response("", { status: ++calls === 1 ? 503 : 200 }),
			attempts: 12,
			pauseMs: 0,
			timeoutMs: 10_000,
		},
		async () => {
			paused.resolve();
			await resume.promise;
		},
	);
	const response = request("https://mainworthy.example/health");
	try {
		expect(await Promise.race([paused.promise.then(() => "paused"), response.then(() => "completed")])).toBe("paused");
		await Bun.sleep(0);
		expect(calls).toBe(1);
	} finally {
		resume.resolve();
		await response;
	}
	expect(calls).toBe(2);
});

test("the gate waits for a deployment after choosing the instance", async () => {
	const paused = Promise.withResolvers<void>();
	const resume = Promise.withResolvers<void>();
	const health: number[] = [];
	const requests: { path: string; status: number }[] = [];
	let batches: () => Promise<number> = async () => 0;
	const running = gate(green, {
		inProcess: true,
		configure: async ({ instance }) => {
			batches = async () =>
				(
					await instance.app.database.read(
						async (db) => await db.get(sql<readonly [], { n: number }>("SELECT count(*) AS n FROM batches")),
					)
				)?.n ?? 0;
			return {};
		},
		request: deploymentFetch(
			{
				fetch: async (url, init) => {
					const response = await fetch(url, init);
					requests.push({ path: new URL(url).pathname, status: response.status });
					return response;
				},
				attempts: 12,
				pauseMs: 0,
				timeoutMs: 10_000,
			},
			async () => {
				paused.resolve();
				await resume.promise;
			},
		),
		routes: {
			"/health": () => {
				const status = health.length === 1 ? 503 : 200;
				health.push(status);
				return status === 503
					? new Response("deploying", { status: 503 })
					: Response.json({ ok: true, apiVersion: API_VERSION });
			},
		},
	});
	try {
		expect(await Promise.race([paused.promise.then(() => "paused"), running.then(() => "completed")])).toBe("paused");
		await Bun.sleep(0);
		expect(health).toEqual([200, 503]);
		expect(requests).toEqual([{ path: "/health", status: 503 }]);
		expect(await batches()).toBe(0);
	} finally {
		resume.resolve();
		await running;
	}
	const result = await running;
	expect(health.slice(0, 3)).toEqual([200, 503, 200]);
	expect(requests.filter((request) => request.path.endsWith("/report"))).toEqual(
		green.map(() => ({ path: "/api/p/scratch/report", status: 200 })),
	);
	expect([result.code, result.batches]).toEqual([0, 3]);
	expect(result.batchJobs).toEqual([
		{ job: "performance", shard: null, n: 1 },
		{ job: "tests", shard: 1, n: 1 },
		{ job: "tests", shard: 2, n: 1 },
	]);
	expect(result.output).toContain("Reported to the deployed Mainworthy");
	expect(result.output).toContain("mainworthy gate    passed");
}, 20_000);

test("the production deployment transport keeps twelve attempts, ten-second pauses and ten-second timeouts", async () => {
	const pauses: number[] = [];
	const timeouts: number[] = [];
	const timeout = AbortSignal.timeout;
	const clock = spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
		timeouts.push(ms);
		return timeout(ms);
	});
	const transport = spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(async () => new Response("", { status: 503 }), { preconnect: fetch.preconnect }),
	);
	try {
		const request = deploymentFetch(undefined, async (ms) => {
			pauses.push(ms);
		});
		expect((await request("https://mainworthy.example/health")).status).toBe(503);
		expect(transport).toHaveBeenCalledTimes(12);
		expect(pauses).toEqual(Array(11).fill(10_000));
		expect(timeouts).toEqual(Array(12).fill(10_000));
	} finally {
		transport.mockRestore();
		clock.mockRestore();
	}
});

test("CI retries health, report and gate outages, exhausts its attempts and returns definite refusals immediately", async () => {
	let replies: number[] = [];
	const received: { path: string; body: string }[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			received.push({ path: new URL(req.url).pathname, body: await req.text() });
			return Response.json(
				{ ok: true, apiVersion: API_VERSION, accepted: "same report" },
				{ status: replies.shift() ?? 200 },
			);
		},
	});
	try {
		for (const path of ["/health", "/api/p/scratch/report", "/api/p/scratch/gate"]) {
			const send = async (statuses: number[], retry = true) => {
				replies = [...statuses];
				received.length = 0;
				const options = { url: server.url.origin, project: "scratch", token: undefined };
				const client = new Client({
					...options,
					...(retry ? { request: deploymentFetch({ fetch, attempts: 3, pauseMs: 0, timeoutMs: 1000 }) } : {}),
				});
				// For an operation outage, its compatibility check succeeds before the outage begins.
				if (path !== "/health") replies.unshift(200);
				try {
					const response = await client.request(path === "/health" ? "/api/session" : path, {
						method: "POST",
						body: '{"results":[{"test":{"key":"one"},"outcome":"pass"}]}',
					});
					return response.status;
				} catch (error) {
					if (error instanceof Error) return error.message;
					throw error;
				}
			};
			for (const status of [502, 503, 504]) {
				expect(await send([status, 200])).toBe(200);
				expect(received.filter((req) => req.path === path)).toEqual(
					Array(2).fill({
						path,
						body: path === "/health" ? "" : '{"results":[{"test":{"key":"one"},"outcome":"pass"}]}',
					}),
				);
			}
			const outage = await send([503, 503, 503, 200]);
			expect(outage).toBe(path === "/health" ? `the server answered 503 to /health at ${server.url.origin}` : 503);
			expect(received.filter((req) => req.path === path)).toHaveLength(3);
			for (const status of [400, 401, 403, 404, 429, 500]) {
				const refused = await send([status, 200]);
				expect(refused).toBe(
					path === "/health" ? `the server answered ${status} to /health at ${server.url.origin}` : status,
				);
				expect(received.filter((req) => req.path === path)).toHaveLength(1);
			}
			const interactive = await send([503, 200], false);
			expect(interactive).toBe(path === "/health" ? `the server answered 503 to /health at ${server.url.origin}` : 503);
			expect(received.filter((req) => req.path === path)).toHaveLength(1);
		}
	} finally {
		await server.stop(true);
	}
});

test("CI retries live upgrading health without sending credentials or declaring readiness", async () => {
	for (const finishes of [true, false]) {
		let calls = 0;
		const transport = deploymentFetch({
			attempts: 3,
			pauseMs: 0,
			timeoutMs: 1000,
			fetch: async (_url, init) => {
				expect(new Headers(init?.headers).get("authorization")).toBeNull();
				return Response.json(
					++calls === 2 && finishes
						? { ok: true, apiVersion: API_VERSION }
						: { ok: false, state: "upgrading", apiVersion: API_VERSION },
				);
			},
		});
		const reply = await transport("https://mainworthy.example/health");
		expect(calls).toBe(finishes ? 2 : 3);
		expect(await reply.json()).toMatchObject(finishes ? { ok: true } : { ok: false, state: "upgrading" });
	}
});

test("CI recovers a connection failure and a lost report reply without recording results twice", async () => {
	await withInstance(async ({ instance }) => {
		let connections = 0;
		const bodies: string[] = [];
		const request = deploymentFetch({
			attempts: 3,
			pauseMs: 0,
			timeoutMs: 1000,
			fetch: async (url, init) => {
				if (++connections === 1) throw new Error("connection refused during deploy");
				const response = await fetch(url, init);
				if (url.endsWith("/report")) {
					bodies.push(String(init?.body));
					if (bodies.length === 1) {
						await response.arrayBuffer();
						return new Response(
							new ReadableStream({ start: (controller) => controller.error(new Error("reply lost")) }),
						);
					}
				}
				return response;
			},
		});
		const client = new Client({ url: instance.url, project: "scratch", token: undefined, request });
		const receipt = await client.call("report", {
			target: { commit: "c0ffee0123456789012345678901234567890123" },
			job: "tests",
			results: [{ test: { key: "one" }, outcome: "pass" }],
		});
		// The generated command id replays the original reply, including its original fresh flag.
		expect([receipt.fresh, receipt.counts.total, bodies.length]).toEqual([true, 1, 2]);
		expect(bodies[1]).toBe(bodies[0]);
		expect(
			await instance.app.database.read(
				async (db) => await db.get(sql<readonly [], { n: number }>("SELECT count(*) AS n FROM batches")),
			),
		).toEqual({ n: 1 });
		expect(
			await instance.app.database.read(
				async (db) => await db.get(sql<readonly [], { n: number }>("SELECT count(*) AS n FROM results")),
			),
		).toEqual({ n: 1 });
		expect((await client.call("gate", { commit: "c0ffee0123456789012345678901234567890123" })).verdict).toBe("passed");
	});
});

test("CI stops retrying unreachable requests and shares its deadline across commands", async () => {
	let unreachableCalls = 0;
	const unreachable = deploymentFetch({
		attempts: 3,
		pauseMs: 0,
		timeoutMs: 1000,
		fetch: async () => {
			unreachableCalls++;
			throw new Error("still unreachable");
		},
	});
	await expect(unreachable("https://mainworthy.example/health")).rejects.toThrow("still unreachable");
	expect(unreachableCalls).toBe(3);
	let calls = 0;
	const expired = deploymentFetch({
		attempts: 3,
		pauseMs: 0,
		timeoutMs: 1,
		fetch: async () => {
			calls++;
			await Bun.sleep(10);
			return new Response("still deploying", { status: 503 });
		},
	});
	expect((await expired("https://mainworthy.example/health")).status).toBe(503);
	expect((await expired("https://mainworthy.example/api/p/scratch/gate")).status).toBe(503);
	expect(calls).toBe(2);
});

// Which Mainworthy the job reports to is `scripts/ci-instance.ts`. The first three tests are each on one of its
// three ways through; the others use the instance of the test with no token, as a job on one machine does.

/** Run one executable smoke, then the remaining report variants in this process. */
function gateVariants(): typeof gate {
	let first = true;
	return async (shards, options = {}) => {
		const inProcess = !first;
		first = false;
		return await gate(shards, { ...options, inProcess });
	};
}

/** The Mainworthy the job said it started, if its process is still there a moment after the job ended. */
async function stillRunning(output: string): Promise<string[]> {
	const pid = Number(/^Started a Mainworthy for this job: \S+ \(process (\d+)\)$/m.exec(output)?.[1]);
	if (!pid) return [];
	for (let waited = 0; waited < 2000; waited += 50) {
		try {
			process.kill(pid, 0);
		} catch {
			return [];
		}
		await Bun.sleep(50);
	}
	return [`process ${pid}`];
}

/** The pipeline's own token on the instance of the test, as an operator issues it. */
async function pipelineToken({ client }: Running): Promise<string> {
	const made = await client.call("admin", {
		do: "token.create",
		actor: "github-actions",
		kind: "ci",
		project: "scratch",
	});
	return z.object({ token: z.string() }).parse(made).token;
}

test("every shard passed: each is reported as a shard of the job tests to the deployed instance, and the gate passes", async () => {
	// A deployed instance asks for a token. This one records on `scratch` and reads its gate. No project is named
	// to the job, and the token sees a second one it may read and not record on: the job reports to the one
	// project it may record on.
	const result = await gate(green, {
		mode: "server",
		configure: async (running) => {
			const token = await pipelineToken(running);
			await running.client.call("admin", { do: "project.create", key: "other" });
			await running.client.call("admin", { do: "grant.set", actor: "github-actions", project: "other", can: ["read"] });
			return { MAINWORTHY_TOKEN: token };
		},
	});
	expect(result.output).toMatch(
		/^::notice::Reported to the deployed Mainworthy: http:\/\/127\.0\.0\.1:\d+, project scratch\.$/m,
	);
	expect(result.summary).toBe(`${/Reported to the deployed Mainworthy: .*\./.exec(result.output)?.[0]}\n`);
	expect(result.output).toContain("$ mainworthy report test-results/tests-1.xml --job tests --shard 1/2");
	expect(result.output).toContain("job tests  shard 2/2");
	expect(result.output).toContain("job performance");
	expect(result.output).toMatch(/mainworthy gate\s+passed/);
	expect(result.output).not.toContain("::error::");
	expect([result.code, result.batches]).toEqual([0, 3]);
}, 20_000);

test("a failing test in one shard ends in a blocked gate, also in the Mainworthy the job starts itself", async () => {
	// The instance named is another version: it does not describe `report` and `gate` as this checkout does. The
	// job starts its own and says so. That one knows no earlier decision, so the failure blocks.
	const result = await gate(withFailure("expected 1, got 2"), {
		routes: { "/api/openapi.json": () => Response.json({ ...openApi(), paths: {} }) },
		configure: async () => ({ MAINWORTHY_TOKEN: "cb_secret-of-the-deployed-one", MAINWORTHY_PROJECT: "mainworthy" }),
	});
	expect(result.output).toMatch(
		/^::warning::Reported to a Mainworthy started for this job: \S+ describes report and gate differently from this checkout \(another version\); the decisions kept at \S+ do not count in this run\.$/m,
	);
	expect(result.summary).toContain("Reported to a Mainworthy started for this job");
	// Nothing reached the instance that was not chosen, and its token went nowhere: the job's own Mainworthy would
	// have refused a token it does not know, and has no project of that name.
	expect(result.batches).toBe(0);
	expect(result.output).not.toContain("cb_secret-of-the-deployed-one");
	expect(result.output).toMatch(/mainworthy gate\s+blocked/);
	expect(result.output).toContain("needs an answer");
	expect(result.output).toContain("The gate did not pass (exit 2).");
	expect(result.code).toBe(2);
}, 20_000);

test("a shard that left no report fails the job, and the gate waits for that shard", async () => {
	// With no instance named the job starts its own, and that is a notice, not a warning.
	const result = await gate(green, { missing: ["tests-2"], configure: async () => ({ MAINWORTHY_URL: "" }) });
	expect(result.output).toMatch(
		/^::notice::Reported to a Mainworthy started for this job: MAINWORTHY_URL is not set\.$/m,
	);
	expect(result.output).not.toContain("::warning::");
	expect(result.batches).toBe(0);
	// Its own Mainworthy is stopped and its data removed when the job ends.
	expect(result.output).toMatch(/^Started a Mainworthy for this job: http:\/\/127\.0\.0\.1:\d+ \(process \d+\)$/m);
	expect(result.left).toEqual([]);
	expect(result.output).toContain("job tests  shard 1/2");
	expect(result.output).toMatch(/mainworthy gate\s+pending: waiting for shard 2 of 2 of job tests/);
	expect(result.output).toContain("::error::tests-2: no report (test-results/tests-2.xml is missing or empty)");
	expect(result.output).toContain("::error::in no shard's report: test/c.test.ts");
	// The gate itself knows a shard is missing, and its exit code (3, pending) is the job's.
	expect(result.code).toBe(3);
}, 20_000);

// Issue #124. A run that was run again holds one artifact of a shard for each attempt the shard ran in. The
// workflow names each for its attempt and downloads each into its own directory.
test("a shard that ran again is read from its newest attempt, and the others from the attempt they ran in", async () => {
	const result = await gate(
		[
			...green.filter((shard) => shard.name !== "tests-2").map((shard) => ({ ...shard, attempt: 1 })),
			// The newer one is written first: which file was written last decides nothing.
			{ name: "tests-2", files: { "test/c.test.ts": null }, attempt: 2, seconds: 61 },
			{ name: "tests-2", files: { "test/c.test.ts": "expected 1, got 2" }, attempt: 1, seconds: 118 },
		],
		{ configure: async () => ({ MAINWORTHY_URL: "" }) },
	);
	expect(result.output).toContain(
		"$ mainworthy report test-results/results-tests-2-attempt-2/tests-2.xml --job tests --shard 2/2",
	);
	expect(result.output).toContain(
		"$ mainworthy report test-results/results-tests-1-attempt-1/tests-1.xml --job tests --shard 1/2",
	);
	// The table says which attempt each row is from, and the row is that attempt's.
	expect(result.output).toMatch(/^tests-1 +1 +4 +0 +0 +60\.0 s$/m);
	expect(result.output).toMatch(/^tests-2 +2 +2 +0 +0 +61\.0 s$/m);
	expect(result.output).toMatch(/mainworthy gate\s+passed/);
	expect(result.output).not.toContain("::error::");
	expect(result.code).toBe(0);
}, 20_000);

test("the newest attempt of a shard is its report also when it failed, or left an artifact with no report in it", async () => {
	const check = gateVariants();
	const failedAgain = await check(
		[
			...green.filter((shard) => shard.name !== "tests-2").map((shard) => ({ ...shard, attempt: 1 })),
			{ name: "tests-2", files: { "test/c.test.ts": null }, attempt: 1 },
			{ name: "tests-2", files: { "test/c.test.ts": "expected 1, got 2" }, attempt: 2 },
		],
		{ configure: async () => ({ MAINWORTHY_URL: "" }) },
	);
	expect(failedAgain.output).toMatch(/mainworthy gate\s+blocked/);
	expect(failedAgain.code).toBe(2);
	// An older attempt that passed does not stand in for a newer one that says nothing.
	const empty = await check(
		[
			...green.filter((shard) => shard.name !== "tests-2").map((shard) => ({ ...shard, attempt: 1 })),
			{ name: "tests-2", files: { "test/c.test.ts": null }, attempt: 1 },
			{ name: "tests-2", files: {}, xml: "", attempt: 2 },
		],
		{ configure: async () => ({ MAINWORTHY_URL: "" }) },
	);
	expect(empty.output).toMatch(/^Started a Mainworthy for this job: /m);
	expect(empty.left).toEqual([]);
	expect(empty.output).toContain(
		"::error::tests-2: no report (test-results/results-tests-2-attempt-2/tests-2.xml is missing or empty)",
	);
	// The newest attempt is the shard's report, and it holds none: shard 2 is not reported, and the gate waits for it.
	expect(empty.output).toMatch(/mainworthy gate\s+pending: waiting for shard 2 of 2 of job tests/);
	expect(empty.code).toBe(3);
}, 40_000);

test("a test file whose tests were all skipped fails the job, though the gate passes on the others", async () => {
	// A runner with no browser skips every browser test, exits 0 and writes a complete report.
	const result = await gate(
		green.map((shard) =>
			shard.name === "tests-2" ? { ...shard, files: { "test/c.test.ts": SKIPPED }, exit: 0 } : shard,
		),
	);
	expect(result.output).toMatch(/mainworthy gate\s+passed/);
	expect(result.output).toContain("::error::tests-2: every test of test/c.test.ts was skipped");
	expect(result.code).toBe(1);
}, 20_000);

test("a test file whose name the reader cuts short fails the job, so a skipped file cannot be counted with one that ran", async () => {
	const check = gateVariants();
	// Issue #82. The reader keeps the first 500 characters of a file's name, and the two names below share them:
	// counted by that name they are one file with two tests and one skip, and the skipped file goes unreported.
	const deep = `test/${Array.from({ length: 5 }, () => "a".repeat(99)).join("/")}`;
	const [ran, skipped] = [`${deep}/pass.test.ts`, `${deep}/skip.test.ts`];
	expect([ran.length, skipped.length, ran.slice(0, 500) === skipped.slice(0, 500)]).toEqual([517, 517, true]);
	const result = await check(
		green.map((shard) =>
			shard.name === "tests-2" ? { ...shard, files: { [ran]: null, [skipped]: SKIPPED }, exit: 0 } : shard,
		),
	);
	expect(result.output).toMatch(/mainworthy gate\s+passed/);
	expect(result.output).toContain(
		`::error::tests-2: a test file's name is 500 characters or longer, and a report keeps the first 500 (${ran.slice(0, 80)}...)`,
	);
	expect(result.code).toBe(1);
	// A name one character short of the limit is whole, and is counted as itself.
	const whole = `test/${"b".repeat(99)}/${"c".repeat(99)}/${"d".repeat(99)}/${"e".repeat(99)}/${"f".repeat(86)}.test.ts`;
	expect(whole.length).toBe(499);
	const fits = await check(
		green.map((shard) => (shard.name === "tests-2" ? { ...shard, files: { [whole]: null }, exit: 0 } : shard)),
	);
	expect(fits.output).not.toContain("::error::");
	expect(fits.code).toBe(0);
}, 40_000);

test("a test that takes its file from its suite is counted for that file", async () => {
	const check = gateVariants();
	// Other producers of JUnit put the file on the suite only. Bun puts it on every test.
	const inherited = junit({ "test/c.test.ts": null }).replace(/(<testcase\b[^>]*?) file="[^"]+"/g, "$1");
	expect(inherited).not.toMatch(/<testcase\b[^>]* file=/);
	const withReport = (xml: string): Shard[] =>
		green.map((shard) => (shard.name === "tests-2" ? { ...shard, xml, exit: 0 } : shard));
	const ran = await check(withReport(inherited));
	expect(ran.output).not.toContain("::error::");
	expect(ran.code).toBe(0);
	const skipped = inherited.replace(/<testcase\b([^>]*?)\s*\/>/g, "<testcase$1>\n      <skipped />\n    </testcase>");
	const none = await check(withReport(skipped));
	expect(none.output).toContain("::error::tests-2: every test of test/c.test.ts was skipped");
	expect(none.code).toBe(1);
}, 40_000);

test("text inside a test's output is not counted as a test or as a skip", async () => {
	const check = gateVariants();
	const withReport = (xml: string): Shard[] =>
		green.map((shard) => (shard.name === "tests-2" ? { ...shard, xml, exit: 0 } : shard));
	const report = (body: string) =>
		`<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test" tests="1" failures="0" skipped="0" time="0.1">\n  <testsuite name="test/c.test.ts" file="test/c.test.ts" tests="1" failures="0" skipped="0" time="0.1" hostname="runner">\n${body}\n  </testsuite>\n</testsuites>\n`;
	// A file whose one test was skipped, with a passing test's markup quoted in its output: still not tested.
	const fake = await check(
		withReport(
			report(
				'    <testcase name="skips" file="test/c.test.ts"><skipped /></testcase>\n    <system-out><![CDATA[<testcase name="example" />]]></system-out>',
			),
		),
	);
	expect(fake.output).toContain("::error::tests-2: every test of test/c.test.ts was skipped");
	expect(fake.code).toBe(1);
	// A test that passed, with the word for a skip quoted in its output: tested.
	const quoted = await check(
		withReport(report('    <testcase name="passes"><system-out><![CDATA[<skipped />]]></system-out></testcase>')),
	);
	expect(quoted.output).not.toContain("::error::");
	expect(quoted.code).toBe(0);
}, 40_000);

test("tests that exited with a failure the report does not show fail the job", async () => {
	// A test file that does not load is an error for Bun and is absent from its JUnit file.
	const result = await gate(green.map((shard) => (shard.name === "tests-1" ? { ...shard, exit: 1 } : shard)));
	expect(result.output).toMatch(/mainworthy gate\s+passed/);
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

// Decision 0090: a change that needs only some test files runs those, and the gate expects those in a report.
test("given the files the change needed, the job expects those in a report and no other", async () => {
	const check = gateVariants();
	const chosen: Shard[] = [
		{ name: "tests", files: { "test/architecture.test.ts": null, "test/licences.test.ts": null } },
	];
	const repository = ["test/architecture.test.ts", "test/licences.test.ts", "test/e2e/browser.test.ts"];
	const narrowed = await check(chosen, { repository, files: ["test/architecture.test.ts", "test/licences.test.ts"] });
	expect(narrowed.output).not.toContain("in no shard's report");
	expect(narrowed.code).toBe(0);
	const short = await check(chosen, { repository, files: ["test/architecture.test.ts", "test/docs.test.ts"] });
	expect(short.output).toContain("::error::in no shard's report: test/docs.test.ts");
	expect(short.code).toBe(1);
}, 20_000);

test("a slow shard only warns, and a slow failed test still blocks", async () => {
	const check = gateVariants();
	const taking = (shards: Shard[], seconds: number): Shard[] =>
		shards.map((shard) => (shard.name === "performance" ? { ...shard, seconds } : shard));
	for (const seconds of [181, 241]) {
		const result = await check(taking(green, seconds));
		expect(result.output).toContain(`::warning::the slowest shard's tests took ${seconds.toFixed(1)} s`);
		expect(result.code).toBe(0);
	}
	const failed = await check(taking(withFailure("one is two"), 241));
	expect(failed.output).toContain("::warning::the slowest shard's tests took 241.0 s");
	expect(failed.code).toBe(2);
}, 30_000);

test("a job that breaks off leaves no Mainworthy running and nothing in the temporary directory", async () => {
	// A report that cannot be read is an error nobody planned for: the job stops there, and still cleans up.
	const result = await gate(green, { unreadable: ["tests-2"], configure: async () => ({ MAINWORTHY_URL: "" }) });
	expect(result.output).toMatch(/^Started a Mainworthy for this job: /m);
	expect(result.output).toContain("EISDIR");
	expect(result.code).not.toBe(0);
	expect(result.left).toEqual([]);
}, 20_000);

test("a refused report keeps its command diagnostic and exit 4 while the gate still runs", async () => {
	const result = await gate(green, {
		routes: {
			"/api/p/scratch/report": () =>
				Response.json({ ok: false, error: { code: "forbidden", message: "report refused" } }, { status: 403 }),
		},
	});
	expect(result.output.match(/forbidden: report refused/g)).toHaveLength(3);
	for (const shard of green) expect(result.output).toContain(`::error::${shard.name}: mainworthy report exited 4`);
	expect(result.output).toContain("$ mainworthy gate");
	expect(result.output).toContain("The gate did not pass (exit 3).");
	expect([result.code, result.batches, result.left]).toEqual([3, 0, []]);
}, 20_000);

test("an explicit command client environment leaves the ambient environment unchanged", async () => {
	await withInstance(async ({ instance, client }) => {
		await client.call("admin", { do: "project.create", key: "configured" });
		await client.with({ project: "configured" }).call("report", {
			target: { commit: "c0ffee0123456789012345678901234567890123" },
			results: [{ test: { key: "client-environment" }, outcome: "pass" }],
		});
		const before = { ...process.env };
		const code = await runCli(["gate", "--commit", "c0ffee0123456789012345678901234567890123"], undefined, {
			MAINWORTHY_URL: instance.url,
			MAINWORTHY_PROJECT: "configured",
		});
		expect(code).toBe(0);
		expect({ ...process.env }).toEqual(before);
	});
});

test.each(["http://127.0.0.1:7357", "startup refused"])(
	"stopping waits for the server's last directory write before removing its data (%s)",
	async (message) => {
		const root = await mkdtemp(join(tmpdir(), "mainworthy-ci-stop-"));
		const cli = join(root, "serve.ts");
		try {
			await writeFile(
				cli,
				`import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const data = process.env.MAINWORTHY_DATA;
writeFileSync(join(import.meta.dir, "data"), data);
console.log(${JSON.stringify(message)});
while (!existsSync(join(import.meta.dir, "finish"))) await Bun.sleep(1);
mkdirSync(data, { recursive: true });
writeFileSync(join(data, "last-write"), "finished");
`,
			);
			const spawned = spyOn(Bun, "spawn");
			const own = startOwn(cli);
			const ready = own.ready.catch((error: unknown) => error);
			const deadline = Date.now() + 4000;
			while (spawned.mock.results.length === 0 && Date.now() < deadline) await Bun.sleep(1);
			const result = spawned.mock.results[0];
			spawned.mockRestore();
			if (result?.type !== "return") throw new Error("the server was not spawned");
			const child = result.value;
			// Hold the requested kill until the real child completes an in-flight directory write.
			const killing = Promise.withResolvers<void>();
			const kill = spyOn(child, "kill").mockImplementation(() => killing.resolve());
			try {
				await Promise.race([ready, killing.promise]);
				const data = await readFile(join(root, "data"), "utf8");
				const stopped = Promise.all([own.stop(), own.stop()]);
				expect(existsSync(data)).toBe(true);
				await writeFile(join(root, "finish"), "");
				await child.exited;
				await stopped;
				expect(existsSync(data)).toBe(false);
				if (message === "startup refused") expect(await ready).toBeInstanceOf(Error);
			} finally {
				kill.mockRestore();
				child.kill("SIGKILL");
				await child.exited;
				await own.stop();
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);

test("a job that is told to stop does so before its next command, exits as stopped, and leaves nothing", async () => {
	// Told while its own Mainworthy is starting, and told once that one runs. A Mainworthy left behind would hold the
	// job's output open, and this test would not end.
	for (const [send, after, exit] of [
		["SIGTERM", "::notice::Reported to a Mainworthy started for this job", 143],
		["SIGINT", "Started a Mainworthy for this job: ", 130],
	] as const) {
		const result = await gate(green, { signal: { send, after }, configure: async () => ({ MAINWORTHY_URL: "" }) });
		// It does not go on to the gate and exit with the verdict of a run that was called off.
		expect(result.output).not.toContain("$ mainworthy gate");
		expect([send, result.code, result.left]).toEqual([send, exit, []]);
	}
}, 20_000);

// ── Which Mainworthy the job reports to: what is wrong with a deployed one, and what follows ─────────────────

test("a credential the instance refuses fails the job, and nothing is reported anywhere", async () => {
	const wrong = await gate(green, {
		mode: "server",
		configure: async () => ({ MAINWORTHY_TOKEN: "cb_not-a-token-of-this-instance" }),
	});
	expect(wrong.output).toMatch(
		/^::error::Nothing was reported: \S+ refuses MAINWORTHY_TOKEN \(revoked or mistyped\)\.$/m,
	);
	expect(wrong.output).not.toContain("$ mainworthy report");
	expect([wrong.code, wrong.batches]).toEqual([4, 0]);
}, 20_000);

test("choosing the instance: each thing that can be wrong with a deployed one, and what follows", async () => {
	const session = (projects: { key: string; can: string[] }[]) => Response.json({ ok: true, result: { projects } });
	const recorder = () => session([{ key: "mainworthy", can: ["record"] }]);
	type Answers = Record<string, () => Response>;
	const asked: string[] = [];
	const probe = (answers: Answers): Probe => ({
		attempts: 3,
		pauseMs: 0,
		timeoutMs: 1000,
		fetch: async (url) => {
			const path = new URL(url).pathname;
			asked.push(path);
			const answer = answers[path];
			if (!answer) throw new Error("connection refused");
			return answer();
		},
	});
	const healthy: Answers = {
		"/health": () => Response.json({ ok: true, apiVersion: API_VERSION }),
		"/api/openapi.json": () => Response.json(openApi()),
		"/api/session": recorder,
	};
	const env = {
		MAINWORTHY_URL: "https://mainworthy.example/",
		MAINWORTHY_TOKEN: "cb_x",
		MAINWORTHY_PROJECT: "mainworthy",
	};
	const choose = async (answers: Answers, changed: Partial<typeof env> = {}) => {
		const choice = await chooseInstance({ ...env, ...changed }, probe(answers));
		return `${choice.use}${choice.use === "own" && choice.warn ? " (warning)" : ""}: ${choice.why}`;
	};

	expect(await choose(healthy)).toBe("deployed: https://mainworthy.example, project mainworthy");
	let upgradeTries = 0;
	expect(
		await choose({
			...healthy,
			"/health": () =>
				Response.json(
					++upgradeTries < 2
						? { ok: false, state: "upgrading", apiVersion: API_VERSION }
						: { ok: true, apiVersion: API_VERSION },
				),
		}),
	).toStartWith("deployed:");
	expect(upgradeTries).toBe(2);
	for (const apiVersion of [undefined, 0, API_VERSION + 1, "1", null]) {
		asked.length = 0;
		expect(await choose({ ...healthy, "/health": () => Response.json({ ok: true, apiVersion }) })).toStartWith(
			`own (warning): https://mainworthy.example does not support CLI API ${API_VERSION}`,
		);
		expect(asked).toEqual(["/health"]);
	}
	expect(await choose(healthy, { MAINWORTHY_URL: "" })).toBe("own: MAINWORTHY_URL is not set");

	// Unreachable: asked three times, then the job's own.
	asked.length = 0;
	expect(await choose({})).toStartWith(
		"own (warning): https://mainworthy.example cannot be reached (connection refused)",
	);
	expect(asked).toEqual(["/health", "/health", "/health"]);
	expect(await choose({ ...healthy, "/health": () => new Response("", { status: 502 }) })).toStartWith(
		"own (warning): https://mainworthy.example cannot be reached (it answered 502)",
	);
	// A runner that has just joined the network: the first try fails and the second answers.
	let tries = 0;
	const slow = () => {
		if (++tries === 1) throw new Error("no route yet");
		return Response.json({ ok: true, apiVersion: API_VERSION });
	};
	expect(await choose({ ...healthy, "/health": slow })).toStartWith("deployed:");

	// Another version: it describes report or gate differently, or does not describe them.
	const other = structuredClone(openApi()) as { paths: Record<string, Record<string, unknown>> };
	(other.paths["/api/p/{project}/report"] ?? {}).post = { "x-mainworthy-needs": "produce" };
	expect(await choose({ ...healthy, "/api/openapi.json": () => Response.json(other) })).toStartWith(
		"own (warning): https://mainworthy.example describes report differently from this checkout",
	);
	expect(await choose({ ...healthy, "/api/openapi.json": () => new Response("not json") })).toStartWith(
		"own (warning): https://mainworthy.example describes report and gate differently",
	);
	expect(contractDifferences(openApi())).toEqual([]);
	expect(contractDifferences({ paths: {} })).toEqual(["report", "gate"]);

	// The credential: refused, or good and not for this project. Neither is a reason to look elsewhere.
	const refused = { ...healthy, "/api/session": () => new Response("{}", { status: 401 }) };
	expect(await choose(refused)).toBe("none: https://mainworthy.example refuses MAINWORTHY_TOKEN (revoked or mistyped)");
	expect(await choose(refused, { MAINWORTHY_TOKEN: "" })).toBe(
		"none: https://mainworthy.example refuses a job with no MAINWORTHY_TOKEN",
	);
	// A token that failed too often is told to wait (429). That is a refusal too, and no reason to start the
	// job's own instance: a pipeline's token is one the instance generated, and a right one passes a block.
	const waiting = {
		...healthy,
		"/api/session": () => new Response("{}", { status: 429, headers: { "retry-after": "8" } }),
	};
	expect(await choose(waiting)).toBe(
		"none: https://mainworthy.example tells MAINWORTHY_TOKEN to wait after too many failed attempts (429): it is revoked or mistyped, or not a token the instance generated",
	);
	const reader = {
		...healthy,
		"/api/session": () =>
			session([
				{ key: "mainworthy", can: ["read"] },
				{ key: "web", can: ["record"] },
			]),
	};
	expect(await choose(reader)).toBe(
		"none: the token may not record results on project mainworthy at https://mainworthy.example (it may on: web)",
	);
	// With no project named, the CLI takes the only one: so there must be exactly one to record on.
	expect(await choose(healthy, { MAINWORTHY_PROJECT: "" })).toBe(
		"deployed: https://mainworthy.example, project mainworthy",
	);
	// Other projects it may read do not make that a choice: the job is told which one, and tells the CLI.
	const mixed = {
		...healthy,
		"/api/session": () =>
			session([
				{ key: "docs", can: ["read"] },
				{ key: "web", can: ["record"] },
			]),
	};
	const taken = await chooseInstance({ ...env, MAINWORTHY_PROJECT: "" }, probe(mixed));
	expect(taken).toMatchObject({ use: "deployed", project: "web" });
	const two = {
		...healthy,
		"/api/session": () =>
			session([
				{ key: "a", can: ["record"] },
				{ key: "b", can: ["read", "record"] },
			]),
	};
	expect(await choose(two, { MAINWORTHY_PROJECT: "" })).toBe(
		"none: MAINWORTHY_PROJECT is not set and the token may record on 2 projects at https://mainworthy.example (a, b)",
	);
	// An instance that answers and cannot say who is calling is not this change's fault.
	expect(await choose({ ...healthy, "/api/session": () => new Response("", { status: 503 }) })).toStartWith(
		"own (warning): https://mainworthy.example did not say who this job is",
	);
});

test("the change workflow refuses unknown operations and incompatible servers, and accepts only a missing change", async () => {
	const workflow = z
		.object({ jobs: z.object({ tell: z.object({ steps: z.array(z.object({ run: z.string().optional() })) }) }) })
		.parse(Bun.YAML.parse(await Bun.file(".github/workflows/change.yml").text()));
	const script = workflow.jobs.tell.steps.find((step) => step.run)?.run;
	if (!script) throw new Error("change workflow has no request step");
	const directory = await mkdtemp(join(tmpdir(), "mainworthy-change-workflow-"));
	try {
		for (const [apiVersion, status, body, expected] of [
			[API_VERSION, 200, { ok: true, result: { change: "pr:482", state: "merged" } }, 0],
			[API_VERSION, 404, { ok: false, error: { code: "not_found", message: "change pr:482 not found" } }, 0],
			[API_VERSION, 404, { ok: false, error: { code: "not_found", message: "no operation named change" } }, 1],
			[API_VERSION, 404, { ok: false, error: { code: "not_found", message: "project missing not found" } }, 1],
			[API_VERSION, 200, { ok: false, error: { code: "invalid", message: "refused" } }, 1],
			[API_VERSION + 1, 200, { ok: true, result: {} }, 1],
			[API_VERSION - 1, 200, { ok: true, result: {} }, 1],
			[undefined, 404, { ok: false, error: { code: "not_found", message: "no operation named change" } }, 1],
			[undefined, 200, { ok: true, result: { change: "pr:482", state: "merged" } }, 0],
			[undefined, 404, { ok: false, error: { code: "not_found", message: "change pr:482 not found" } }, 0],
			[null, 200, { ok: true, result: {} }, 1],
		] as const) {
			const received: { path: string; apiVersion: string | null }[] = [];
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch(req) {
					const path = new URL(req.url).pathname;
					received.push({ path, apiVersion: req.headers.get("x-mainworthy-api-version") });
					return path === "/health"
						? Response.json({ ok: true, version: "0.1.0", commit: "before-versions", apiVersion })
						: Response.json(body, { status });
				},
			});
			try {
				const child = Bun.spawn(["bash", "-e", "-o", "pipefail", "-c", script], {
					cwd: directory,
					env: {
						PATH: process.env.PATH ?? "",
						MAINWORTHY_URL: `http://127.0.0.1:${server.port}`,
						MAINWORTHY_PROJECT: "scratch",
						MAINWORTHY_TOKEN: "test-token",
						PULL: "482",
						STATE: "merged",
					},
					stdout: "pipe",
					stderr: "pipe",
				});
				const [code, stdout, stderr] = await Promise.all([
					child.exited,
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
				]);
				expect([apiVersion, status, code, stderr]).toEqual([apiVersion, status, expected, ""]);
				const healthRequest = { path: "/health", apiVersion: null };
				if (apiVersion !== API_VERSION && apiVersion !== undefined) expect(received).toEqual([healthRequest]);
				else {
					expect(received).toEqual([
						healthRequest,
						{ path: "/api/p/scratch/change", apiVersion: apiVersion === undefined ? null : String(API_VERSION) },
					]);
					if (apiVersion === undefined) expect(stdout).toContain("::warning::");
				}
				if (expected !== 0) expect(stdout).toContain("::error::");
			} finally {
				await server.stop(true);
			}
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("the change workflow retries deployment outages and replays GitHub head and landing metadata", async () => {
	const workflow = z
		.object({
			on: z.object({
				workflow_dispatch: z.object({ inputs: z.object({ state: z.object({ required: z.boolean() }) }) }),
			}),
			jobs: z.object({
				tell: z.object({
					permissions: z.object({ "pull-requests": z.literal("read") }).optional(),
					steps: z.array(z.object({ run: z.string().optional() })),
				}),
			}),
		})
		.parse(Bun.YAML.parse(await Bun.file(".github/workflows/change.yml").text()));
	const script = workflow.jobs.tell.steps.find((step) => step.run)?.run;
	if (!script) throw new Error("change workflow has no request step");
	const directory = await mkdtemp(join(tmpdir(), "mainworthy-change-replay-"));
	try {
		await writeFile(join(directory, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		await writeFile(join(directory, "gh"), '#!/bin/sh\nprintf "%s\\n" "$*" > gh-args\ncat "$PULL_FIXTURE"\n', {
			mode: 0o755,
		});
		const realCurl = Bun.which("curl");
		if (!realCurl) throw new Error("curl is required to run the change workflow");
		await writeFile(
			join(directory, "curl"),
			`#!/bin/sh
n=$(cat curl-calls)
n=$((n + 1))
printf '%s' "$n" > curl-calls
case ",$CURL_FAIL_AT," in *",$n,"*) printf '000'; exit 7 ;; esac
exec "$REAL_CURL" "$@"
`,
			{ mode: 0o755 },
		);
		const commit = "14926b3300000000000000000000000000000000";
		// A rebase merge: the pull request's head is not the commit that landed.
		const head = "d6e2cd8400000000000000000000000000000000";
		await writeFile(
			join(directory, "github.json"),
			JSON.stringify({
				state: "closed",
				merged: true,
				merge_commit_sha: commit,
				head: { sha: head },
				base: { ref: "main" },
			}),
		);
		const run = async (
			health: [number, ...number[]],
			report: [number, ...number[]],
			env: Record<string, string> = {},
		) => {
			await writeFile(join(directory, "curl-calls"), "0");
			const received: { path: string; payload: unknown }[] = [];
			let healthCalls = 0;
			let reportCalls = 0;
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				async fetch(req) {
					const path = new URL(req.url).pathname;
					received.push({ path, payload: path === "/health" ? null : await req.json() });
					const statuses = path === "/health" ? health : report;
					const call = path === "/health" ? healthCalls++ : reportCalls++;
					if (path === "/health" && healthCalls <= Number(env.HEALTH_UPGRADES ?? 0))
						return Response.json({ ok: false, state: "upgrading", apiVersion: API_VERSION });
					return Response.json(
						{ ok: true, apiVersion: API_VERSION },
						{ status: statuses[Math.min(call, statuses.length - 1)] ?? statuses[0] },
					);
				},
			});
			try {
				const child = Bun.spawn(["bash", "-e", "-o", "pipefail", "-c", script], {
					cwd: directory,
					env: {
						PATH: `${directory}:${process.env.PATH}`,
						MAINWORTHY_URL: server.url.origin,
						MAINWORTHY_PROJECT: "scratch",
						MAINWORTHY_TOKEN: "test-token",
						PULL: "482",
						STATE: "merged",
						HEAD_COMMIT: head,
						MERGED_COMMIT: commit,
						BASE_BRANCH: "main",
						EVENT_NAME: "pull_request",
						GITHUB_REPOSITORY: "example/mainworthy",
						PULL_FIXTURE: join(directory, "github.json"),
						REAL_CURL: realCurl,
						...env,
					},
					stdout: "pipe",
					stderr: "pipe",
				});
				const [code, stdout, stderr] = await Promise.all([
					child.exited,
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
				]);
				return { code, output: stdout + stderr, received, healthCalls, reportCalls };
			} finally {
				await server.stop(true);
			}
		};
		const recovered = await run([502, 503, 504, 200], [502, 503, 504, 200]);
		expect([recovered.code, recovered.healthCalls, recovered.reportCalls]).toEqual([0, 4, 4]);
		const upgraded = await run([200], [200], { HEALTH_UPGRADES: "2" });
		expect([upgraded.code, upgraded.healthCalls, upgraded.reportCalls]).toEqual([0, 3, 1]);
		expect(workflow.on.workflow_dispatch.inputs.state.required).toBe(false);
		expect(workflow.jobs.tell.permissions).toEqual({ "pull-requests": "read" });
		expect(recovered.received.filter((req) => req.payload).map((req) => req.payload)).toEqual(
			Array(4).fill({ change: "pr:482", state: "merged", head, landing: { commit, branch: "main" } }),
		);
		for (const status of [400, 401, 403, 404, 429, 500]) {
			const refused = await run([200], [status, 200]);
			expect([status, refused.code, refused.reportCalls]).toEqual([status, 1, 1]);
		}
		for (const health of [true, false]) {
			const outage = await run(health ? [503] : [200], [503]);
			expect([outage.code, outage.healthCalls, outage.reportCalls]).toEqual(health ? [1, 12, 0] : [1, 1, 12]);
			expect(outage.output).toContain("replay this event with workflow_dispatch");
		}
		const connectionRecovered = await run([200], [200], { CURL_FAIL_AT: "1,3" });
		expect([connectionRecovered.code, connectionRecovered.healthCalls, connectionRecovered.reportCalls]).toEqual([
			0, 1, 1,
		]);
		expect(await readFile(join(directory, "curl-calls"), "utf8")).toBe("4");
		await rm(join(directory, "reply.json"), { force: true });
		const reportUnreachable = await run([200], [200], { CURL_FAIL_AT: "2,3,4,5,6,7,8,9,10,11,12,13" });
		expect([reportUnreachable.code, reportUnreachable.reportCalls]).toEqual([1, 0]);
		expect(reportUnreachable.output).toContain("Mainworthy answered 000. Fix the cause, then replay");
		const unreachable = await run([200], [200], { MAINWORTHY_URL: "http://127.0.0.1:0" });
		expect([unreachable.code, unreachable.received]).toEqual([1, []]);
		expect(unreachable.output).toContain("replay this event with workflow_dispatch");
		for (const [override, expected] of [
			["", "merged"],
			["closed", "closed"],
			["open", "open"],
		]) {
			const replay = await run([200], [200], {
				EVENT_NAME: "workflow_dispatch",
				STATE: override ?? "",
				HEAD_COMMIT: "",
				MERGED_COMMIT: "",
				BASE_BRANCH: "",
			});
			expect(replay.code, replay.output).toBe(0);
			expect(replay.received[1]?.payload).toEqual({
				change: "pr:482",
				state: expected,
				head,
				...(expected === "merged" ? { landing: { commit, branch: "main" } } : {}),
			});
			expect(await readFile(join(directory, "gh-args"), "utf8")).toBe("api repos/example/mainworthy/pulls/482\n");
		}
		for (const [state, branch] of [
			["open", "main"],
			["closed", "main"],
			["merged", "feature"],
		]) {
			await writeFile(
				join(directory, "github.json"),
				JSON.stringify({
					state: state === "merged" ? "closed" : state,
					merged: state === "merged",
					merge_commit_sha: state === "merged" ? commit : null,
					head: { sha: head },
					base: { ref: branch },
				}),
			);
			const replay = await run([200], [200], {
				EVENT_NAME: "workflow_dispatch",
				STATE: "",
				HEAD_COMMIT: "",
				MERGED_COMMIT: "",
				BASE_BRANCH: "",
			});
			expect(replay.code, replay.output).toBe(0);
			expect(replay.received[1]?.payload).toEqual({ change: "pr:482", state, head });
		}
		await writeFile(
			join(directory, "github.json"),
			JSON.stringify({ state: "closed", merged: false, merge_commit_sha: commit, base: { ref: "main" } }),
		);
		const override = await run([200], [200], {
			EVENT_NAME: "workflow_dispatch",
			STATE: "merged",
			HEAD_COMMIT: "",
			MERGED_COMMIT: "",
			BASE_BRANCH: "",
		});
		expect(override.code, override.output).toBe(0);
		expect(override.received[1]?.payload).toEqual({ change: "pr:482", state: "merged" });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}, 20_000);

test("CLI case reports retain generated command ids when the transport loses an applied reply", async () => {
	await withInstance(async ({ client, instance }) => {
		await client.call("propose", { edits: [{ op: "create", body: { title: "CLI report retry" } }] });
		const bodies: { cmd?: string | undefined }[] = [];
		let loseReply = true;
		const retrying = new Client({
			...client.options,
			request: deploymentFetch({
				attempts: 2,
				pauseMs: 0,
				timeoutMs: 1000,
				fetch: async (url, init) => {
					const response = await fetch(url, init);
					if (new URL(url).pathname.endsWith("/report")) {
						bodies.push(z.object({ cmd: z.string().optional() }).parse(JSON.parse(String(init?.body))));
						if (loseReply) {
							loseReply = false;
							await response.arrayBuffer();
							throw new Error("connection lost after report committed");
						}
					}
					return response;
				},
			}),
		});
		const input = { target: { session: "CLI retry" }, results: [{ test: { case: "C-1" }, outcome: "pass" as const }] };
		const first = await retrying.call("report", input);
		expect(first.results).toHaveLength(1);
		expect(await instance.app.database.read((db) => db.allDynamic("SELECT count(*) AS n FROM results"))).toEqual([
			{ n: 1 },
		]);
		expect(bodies).toHaveLength(2);
		expect(bodies[0]?.cmd).toEqual(expect.any(String));
		expect(bodies[0]?.cmd).toBe(bodies[1]?.cmd);
		await retrying.call("report", input);
		expect(bodies[2]?.cmd).not.toBe(bodies[0]?.cmd);
		await retrying.call("report", { ...input, cmd: "explicit-cli-report" });
		await retrying.call("report", { ...input, cmd: "explicit-cli-report" });
		expect(bodies.slice(3).map((body) => body.cmd)).toEqual(["explicit-cli-report", "explicit-cli-report"]);
		expect(await instance.app.database.read((db) => db.allDynamic("SELECT count(*) AS n FROM results"))).toEqual([
			{ n: 3 },
		]);
	});
});
