// The last job of the check workflow (`scripts/ci-gate.ts`), run as the workflow runs it against a real
// Casebook: the result is Casebook's gate, and a report that is missing or says less than happened is not a pass.
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { CI_SHARD_LIMITS } from "../scripts/check-plan.ts";
import { chooseInstance, contractDifferences, type Probe } from "../scripts/ci-instance.ts";
import { type Running, withInstance } from "../src/cli/test-support.ts";
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
		repository?: string[];
		missing?: string[];
		/** Shards whose report is there and cannot be read (a directory of that name). */
		unreadable?: string[];
		mode?: "local" | "server";
		/** Sent to the job as soon as it says it has started its own Casebook. */
		signal?: "SIGINT" | "SIGTERM";
		/** Routes of the instance of the test that answer in place of its own. */
		routes?: NonNullable<Parameters<typeof withInstance>[1]>["routes"];
		configure?: (running: Running) => Promise<Record<string, string>>;
	} = {},
) {
	return withInstance(
		async (running) => {
			const { instance } = running;
			const configured = (await options.configure?.(running)) ?? {};
			const root = await mkdtemp(join(tmpdir(), "casebook-ci-gate-"));
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
					if (options.unreadable?.includes(shard.name)) await mkdir(join(root, "test-results", `${shard.name}.xml`));
					else await writeFile(join(root, "test-results", `${shard.name}.xml`), shard.xml ?? junit(shard.files));
					await writeFile(join(root, "test-results", `${shard.name}.json`), JSON.stringify(outcome));
				}
				const child = Bun.spawn(
					[process.execPath, resolve("scripts/ci-gate.ts"), "test-results", ...shards.map((shard) => shard.name)],
					{
						cwd: root,
						env: {
							PATH: process.env.PATH ?? "",
							HOME: root,
							// What the job leaves in the temporary directory is this test's to count.
							TMPDIR: join(root, "tmp"),
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
							GITHUB_STEP_SUMMARY: join(root, "summary.md"),
							...configured,
						},
						stdout: "pipe",
						stderr: "pipe",
					},
				);
				const printed = async (): Promise<string> => {
					let text = "";
					let signalled = false;
					const decoder = new TextDecoder();
					for await (const chunk of child.stdout) {
						text += decoder.decode(chunk, { stream: true });
						if (options.signal && !signalled && text.includes("Started a Casebook for this job")) {
							signalled = true;
							child.kill(options.signal);
						}
					}
					return text;
				};
				const [stdout, stderr, code] = await Promise.all([printed(), new Response(child.stderr).text(), child.exited]);
				return {
					code,
					output: stdout + stderr,
					summary: await readFile(join(root, "summary.md"), "utf8").catch(() => ""),
					/** What the job left behind: files in its temporary directory, and its own Casebook if that still runs. */
					left: [...(await readdir(join(root, "tmp"))), ...(await stillRunning(stdout))],
					/** How many reports the instance of the test holds. */
					batches: instance.app.db.raw.query<{ n: number }, []>("SELECT count(*) AS n FROM batches").get()?.n,
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
	{ name: "quiet", files: { "test/budgets.test.ts": null } },
];
const withFailure = (message: string): Shard[] =>
	green.map((shard) => (shard.name === "tests-2" ? { ...shard, files: { "test/c.test.ts": message } } : shard));

// Which Casebook the job reports to is `scripts/ci-instance.ts`. The first three tests are each on one of its
// three ways through; the others use the instance of the test with no token, as a job on one machine does.

/** The Casebook the job said it started, if its process is still there a moment after the job ended. */
async function stillRunning(output: string): Promise<string[]> {
	const pid = Number(/^Started a Casebook for this job: \S+ \(process (\d+)\)$/m.exec(output)?.[1]);
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

test("every shard passed: each is reported under its own job to the deployed instance, and the gate passes", async () => {
	// A deployed instance asks for a token. This one records on `scratch` and reads its gate. No project is named
	// to the job, and the token sees a second one it may read and not record on: the job reports to the one
	// project it may record on.
	const result = await gate(green, {
		mode: "server",
		configure: async (running) => {
			const token = await pipelineToken(running);
			await running.client.call("admin", { do: "project.create", key: "other" });
			await running.client.call("admin", { do: "grant.set", actor: "github-actions", project: "other", can: ["read"] });
			return { CASEBOOK_TOKEN: token };
		},
	});
	expect(result.output).toMatch(
		/^::notice::Reported to the deployed Casebook: http:\/\/127\.0\.0\.1:\d+, project scratch\.$/m,
	);
	expect(result.summary).toBe(`${/Reported to the deployed Casebook: .*\./.exec(result.output)?.[0]}\n`);
	expect(result.output).toContain("$ casebook report test-results/tests-1.xml --job tests-1");
	expect(result.output).toContain("job tests-2");
	expect(result.output).toContain("job quiet");
	expect(result.output).toMatch(/casebook gate\s+passed/);
	expect(result.output).not.toContain("::error::");
	expect([result.code, result.batches]).toEqual([0, 3]);
}, 20_000);

test("a failing test in one shard ends in a blocked gate, also in the Casebook the job starts itself", async () => {
	// The instance named is another version: it does not describe `report` and `gate` as this checkout does. The
	// job starts its own and says so. That one knows no earlier decision, so the failure blocks.
	const result = await gate(withFailure("expected 1, got 2"), {
		routes: { "/api/openapi.json": () => Response.json({ ...openApi(), paths: {} }) },
		configure: async () => ({ CASEBOOK_TOKEN: "cb_secret-of-the-deployed-one", CASEBOOK_PROJECT: "casebook" }),
	});
	expect(result.output).toMatch(
		/^::warning::Reported to a Casebook started for this job: \S+ describes report and gate differently from this checkout \(another version\); the decisions kept at \S+ do not count in this run\.$/m,
	);
	expect(result.summary).toContain("Reported to a Casebook started for this job");
	// Nothing reached the instance that was not chosen, and its token went nowhere: the job's own Casebook would
	// have refused a token it does not know, and has no project of that name.
	expect(result.batches).toBe(0);
	expect(result.output).not.toContain("cb_secret-of-the-deployed-one");
	expect(result.output).toMatch(/casebook gate\s+blocked/);
	expect(result.output).toContain("needs an answer");
	expect(result.output).toContain("The gate did not pass (exit 2).");
	expect(result.code).toBe(2);
}, 20_000);

test("a shard that left no report fails the job, though the gate passes on the others", async () => {
	// With no instance named the job starts its own, and that is a notice, not a warning.
	const result = await gate(green, { missing: ["tests-2"], configure: async () => ({ CASEBOOK_URL: "" }) });
	expect(result.output).toMatch(/^::notice::Reported to a Casebook started for this job: CASEBOOK_URL is not set\.$/m);
	expect(result.output).not.toContain("::warning::");
	expect(result.batches).toBe(0);
	// Its own Casebook is stopped and its data removed when the job ends.
	expect(result.output).toMatch(/^Started a Casebook for this job: http:\/\/127\.0\.0\.1:\d+ \(process \d+\)$/m);
	expect(result.left).toEqual([]);
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

test("a job that breaks off leaves no Casebook running and nothing in the temporary directory", async () => {
	// A report that cannot be read is an error nobody planned for: the job stops there, and still cleans up.
	const result = await gate(green, { unreadable: ["tests-2"], configure: async () => ({ CASEBOOK_URL: "" }) });
	expect(result.output).toMatch(/^Started a Casebook for this job: /m);
	expect(result.output).toContain("EISDIR");
	expect(result.code).not.toBe(0);
	expect(result.left).toEqual([]);
}, 20_000);

test("a job that is told to stop does so before its next command, exits as stopped, and leaves nothing", async () => {
	for (const [signal, exit] of [
		["SIGTERM", 143],
		["SIGINT", 130],
	] as const) {
		const result = await gate(green, { signal, configure: async () => ({ CASEBOOK_URL: "" }) });
		// It does not go on to the gate and exit with the verdict of a run that was called off.
		expect(result.output).not.toContain("$ casebook gate");
		expect([signal, result.code, result.left]).toEqual([signal, exit, []]);
	}
}, 20_000);

// ── Which Casebook the job reports to: what is wrong with a deployed one, and what follows ─────────────────

test("a credential the instance refuses fails the job, and nothing is reported anywhere", async () => {
	const wrong = await gate(green, {
		mode: "server",
		configure: async () => ({ CASEBOOK_TOKEN: "cb_not-a-token-of-this-instance" }),
	});
	expect(wrong.output).toMatch(
		/^::error::Nothing was reported: \S+ refuses CASEBOOK_TOKEN \(revoked or mistyped\)\.$/m,
	);
	expect(wrong.output).not.toContain("$ casebook report");
	expect([wrong.code, wrong.batches]).toEqual([4, 0]);
}, 20_000);

test("choosing the instance: each thing that can be wrong with a deployed one, and what follows", async () => {
	const session = (projects: { key: string; can: string[] }[]) => Response.json({ ok: true, result: { projects } });
	const recorder = () => session([{ key: "casebook", can: ["record"] }]);
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
		"/healthz": () => Response.json({ ok: true }),
		"/api/openapi.json": () => Response.json(openApi()),
		"/api/session": recorder,
	};
	const env = { CASEBOOK_URL: "https://casebook.example/", CASEBOOK_TOKEN: "cb_x", CASEBOOK_PROJECT: "casebook" };
	const choose = async (answers: Answers, changed: Partial<typeof env> = {}) => {
		const choice = await chooseInstance({ ...env, ...changed }, probe(answers));
		return `${choice.use}${choice.use === "own" && choice.warn ? " (warning)" : ""}: ${choice.why}`;
	};

	expect(await choose(healthy)).toBe("deployed: https://casebook.example, project casebook");
	expect(await choose(healthy, { CASEBOOK_URL: "" })).toBe("own: CASEBOOK_URL is not set");

	// Unreachable: asked three times, then the job's own.
	asked.length = 0;
	expect(await choose({})).toStartWith(
		"own (warning): https://casebook.example cannot be reached (connection refused)",
	);
	expect(asked).toEqual(["/healthz", "/healthz", "/healthz"]);
	expect(await choose({ ...healthy, "/healthz": () => new Response("", { status: 502 }) })).toStartWith(
		"own (warning): https://casebook.example cannot be reached (it answered 502)",
	);
	// A runner that has just joined the network: the first try fails and the second answers.
	let tries = 0;
	const slow = () => {
		if (++tries === 1) throw new Error("no route yet");
		return Response.json({ ok: true });
	};
	expect(await choose({ ...healthy, "/healthz": slow })).toStartWith("deployed:");

	// Another version: it describes report or gate differently, or does not describe them.
	const other = structuredClone(openApi()) as { paths: Record<string, Record<string, unknown>> };
	(other.paths["/api/p/{project}/report"] ?? {}).post = { "x-casebook-needs": "produce" };
	expect(await choose({ ...healthy, "/api/openapi.json": () => Response.json(other) })).toStartWith(
		"own (warning): https://casebook.example describes report differently from this checkout",
	);
	expect(await choose({ ...healthy, "/api/openapi.json": () => new Response("not json") })).toStartWith(
		"own (warning): https://casebook.example describes report and gate differently",
	);
	expect(contractDifferences(openApi())).toEqual([]);
	expect(contractDifferences({ paths: {} })).toEqual(["report", "gate"]);

	// The credential: refused, or good and not for this project. Neither is a reason to look elsewhere.
	const refused = { ...healthy, "/api/session": () => new Response("{}", { status: 401 }) };
	expect(await choose(refused)).toBe("none: https://casebook.example refuses CASEBOOK_TOKEN (revoked or mistyped)");
	expect(await choose(refused, { CASEBOOK_TOKEN: "" })).toBe(
		"none: https://casebook.example refuses a job with no CASEBOOK_TOKEN",
	);
	const reader = {
		...healthy,
		"/api/session": () =>
			session([
				{ key: "casebook", can: ["read"] },
				{ key: "web", can: ["record"] },
			]),
	};
	expect(await choose(reader)).toBe(
		"none: the token may not record results on project casebook at https://casebook.example (it may on: web)",
	);
	// With no project named, the CLI takes the only one: so there must be exactly one to record on.
	expect(await choose(healthy, { CASEBOOK_PROJECT: "" })).toBe("deployed: https://casebook.example, project casebook");
	// Other projects it may read do not make that a choice: the job is told which one, and tells the CLI.
	const mixed = {
		...healthy,
		"/api/session": () =>
			session([
				{ key: "docs", can: ["read"] },
				{ key: "web", can: ["record"] },
			]),
	};
	const taken = await chooseInstance({ ...env, CASEBOOK_PROJECT: "" }, probe(mixed));
	expect(taken).toMatchObject({ use: "deployed", project: "web" });
	const two = {
		...healthy,
		"/api/session": () =>
			session([
				{ key: "a", can: ["record"] },
				{ key: "b", can: ["read", "record"] },
			]),
	};
	expect(await choose(two, { CASEBOOK_PROJECT: "" })).toBe(
		"none: CASEBOOK_PROJECT is not set and the token may record on 2 projects at https://casebook.example (a, b)",
	);
	// An instance that answers and cannot say who is calling is not this change's fault.
	expect(await choose({ ...healthy, "/api/session": () => new Response("", { status: 503 }) })).toStartWith(
		"own (warning): https://casebook.example did not say who this job is",
	);
});
