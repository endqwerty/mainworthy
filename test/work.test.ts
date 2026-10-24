// The commands of `scripts/work.ts`: each stands where AGENTS.md used to keep a recipe that an agent got wrong. A
// test here is the mistake itself, and the command must not make it: a delete by pattern, a stop that takes the
// shell that asked, a wait that never ends, a pull request that closes an issue by a stray word, a time compared
// from one run.
import { afterEach, expect, test } from "bun:test";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { binaries } from "../scripts/pg.ts";
import { addArgs, BOARD, drift, editArgs, isMove } from "../scripts/work/board.ts";
import { checkSeconds, compare, judge, sameTree } from "../scripts/work/check-time.ts";
import { type Call, ciPolicy, readCi } from "../scripts/work/ci.ts";
import {
	directoriesFromLsof,
	isServer,
	isTestWorker,
	lineage,
	parseProcessTable,
	stopServers,
	within,
} from "../scripts/work/processes.ts";
import { closing, type Facts, gather, problems } from "../scripts/work/pull-request.ts";
import { RELEASED, release } from "../scripts/work/release.ts";
import { run } from "../scripts/work/run.ts";
import { MARKER, make, refusal, remove } from "../scripts/work/scratch.ts";
import { syncBranch } from "../scripts/work/sync-branch.ts";
import { timingsFromReports } from "../scripts/work/timings-from-ci.ts";
import type { Policy } from "../src/core/kinds.ts";
import type { GateStatus, InboxReply } from "../src/core/ops.ts";
import { ciReport, harness } from "./helpers.ts";

const made: string[] = [];
const directory = (): string => {
	const path = realpathSync(mkdtempSync(join(tmpdir(), "mw-work-test-")));
	made.push(path);
	return path;
};
const children: { kill: () => void }[] = [];
afterEach(() => {
	for (const child of children.splice(0)) child.kill();
	for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
});

const PROCS = `
    1     0 /sbin/launchd
  100     1 /bin/zsh -l
  200   100 bun run check
  300   200 bun scripts/check.ts
  400   300 /opt/homebrew/bin/bun test --test-worker --isolate --timeout=5000
  500     1 bun --watch src/cli/main.ts serve
  600   100 sh -c pkill -f 'main.ts serve'
`;

test("CI timings use each file's suite duration, the newest attempt, and preserve absent files", () => {
	const root = directory();
	mkdirSync(join(root, "scripts"));
	const timings = join(root, "scripts/test-timings.json");
	writeFileSync(
		timings,
		JSON.stringify({
			version: 1,
			files: {
				"test/a.test.ts": 1000,
				"test/b.test.ts": 3000,
				"test/absent.test.ts": 7000,
			},
		}),
	);
	const reports = join(root, "reports");
	const report = (shard: string, attempt: number, xml: string, exit = 0): void => {
		const target = join(reports, `results-${shard}-attempt-${attempt}`);
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, `${shard}.xml`), xml);
		writeFileSync(join(target, `${shard}.json`), JSON.stringify({ exit, seconds: 10 }));
	};
	report("tests-1", 1, '<testsuites><testsuite file="test/a.test.ts" time="999"/></testsuites>');
	report(
		"tests-1",
		2,
		`<testsuites time="100">
		<testsuite file="test/a.test.ts" time="8" failures="0">
			<testsuite name="describe" file="test/a.test.ts" time="99"/>
			<testcase file="test/a.test.ts" time="99"/>
		</testsuite>
		<testsuite file="test/b.test.ts" time="4.0004"/>
	</testsuites>`,
	);
	// Ratios 1000/8000 and 3000/4000.4: median scale, then rounded to Bun's integer milliseconds.
	const result = timingsFromReports(root, reports);
	expect(result.files).toBe(2);
	expect(JSON.parse(readFileSync(timings, "utf8"))).toEqual({
		version: 1,
		files: {
			"test/absent.test.ts": 7000,
			"test/a.test.ts": 3500,
			"test/b.test.ts": 1750,
		},
	});
	const saved = readFileSync(timings, "utf8");
	for (const xml of [
		'<testsuites><testsuite file="test/a.test.ts" time="NaN"/></testsuites>',
		'<testsuites><testsuite file="test/a.test.ts" time="-1"/></testsuites>',
		'<testsuites><testsuite file="test/a.test.ts" time="1e999"/></testsuites>',
		'<testsuites><testsuite file="test/a.test.ts"/></testsuites>',
		'<testsuites><testsuite file="test/../a.test.ts" time="1"/></testsuites>',
		'<testsuites><testsuite file="test/a.test.ts" time="1"/><testsuite file="test/a.test.ts" time="1"/></testsuites>',
		"<testsuites/>",
		'<testsuites><testsuite file="test/a.test.ts" time="1">',
	]) {
		report("tests-1", 3, xml);
		expect(() => timingsFromReports(root, reports)).toThrow();
		expect(readFileSync(timings, "utf8")).toBe(saved);
	}
	report("tests-1", 3, '<testsuites><testsuite file="test/a.test.ts" time="1"/></testsuites>', 1);
	expect(() => timingsFromReports(root, reports)).toThrow("did not pass");
	expect(readFileSync(timings, "utf8")).toBe(saved);
	// A newest attempt with no XML must not fall back to the old passing artifact.
	mkdirSync(join(reports, "results-tests-1-attempt-4"));
	expect(() => timingsFromReports(root, reports)).toThrow();
	expect(readFileSync(timings, "utf8")).toBe(saved);
});

test("CI timings accept scoped and performance reports, new files, XML entities and zero durations", () => {
	const root = directory();
	mkdirSync(join(root, "scripts"));
	const timings = join(root, "scripts/test-timings.json");
	writeFileSync(timings, JSON.stringify({ version: 1, files: { "test/absent.test.ts": 7000 } }));
	const reports = join(root, "reports");
	for (const [shard, suite] of [
		["tests", '<testsuite file="test/a&amp;b.test.ts" time="1.25"/>'],
		["performance", '<testsuite file="src/core/a.test.ts" time="0"/>'],
	]) {
		const target = join(reports, `results-${shard}-attempt-1`);
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, `${shard}.xml`), `<testsuites>${suite}</testsuites>`);
		writeFileSync(join(target, `${shard}.json`), JSON.stringify({ exit: 0, seconds: 2 }));
	}
	expect(timingsFromReports(root, reports)).toEqual({ files: 2, scale: 1 });
	expect(JSON.parse(readFileSync(timings, "utf8"))).toEqual({
		version: 1,
		files: {
			"test/absent.test.ts": 7000,
			"test/a&b.test.ts": 1250,
			"src/core/a.test.ts": 0,
		},
	});
	const saved = readFileSync(timings, "utf8");
	writeFileSync(
		join(reports, "results-performance-attempt-1/performance.xml"),
		'<testsuites><testsuite file="test/a&amp;b.test.ts" time="1"/></testsuites>',
	);
	expect(() => timingsFromReports(root, reports)).toThrow("Duplicate JUnit file across shards");
	expect(readFileSync(timings, "utf8")).toBe(saved);
});

test("repeating a CI timing refresh does not drift by a millisecond through rescaling", () => {
	const root = directory();
	mkdirSync(join(root, "scripts"));
	const timings = join(root, "scripts/test-timings.json");
	writeFileSync(
		timings,
		JSON.stringify({
			version: 1,
			files: {
				"test/a.test.ts": 132664,
				"test/b.test.ts": 88181,
				"test/c.test.ts": 4676,
			},
		}),
	);
	const reports = join(root, "results-tests-attempt-1");
	mkdirSync(reports);
	writeFileSync(join(reports, "tests.json"), '{"exit":0,"seconds":200}');
	writeFileSync(
		join(reports, "tests.xml"),
		`<testsuites>
		<testsuite file="test/a.test.ts" time="37.122"/>
		<testsuite file="test/b.test.ts" time="178.943"/>
		<testsuite file="test/c.test.ts" time="107.132"/>
	</testsuites>`,
	);
	timingsFromReports(root, root);
	expect(JSON.parse(readFileSync(timings, "utf8"))).toEqual({
		version: 1,
		files: {
			"test/b.test.ts": 88181,
			"test/c.test.ts": 52793,
			"test/a.test.ts": 18293,
		},
	});
	const saved = readFileSync(timings, "utf8");
	timingsFromReports(root, root);
	expect(readFileSync(timings, "utf8")).toBe(saved);
});

test("a scratch directory is made under the root and deleted by the same command", () => {
	const root = directory();
	const scratch = make("review", root);
	expect(scratch.startsWith(join(root, "mw-review-"))).toBe(true);
	expect(existsSync(join(scratch, MARKER))).toBe(true);
	expect(refusal(scratch, root)).toBeNull();
	remove(scratch, root);
	expect(existsSync(scratch)).toBe(false);
});

test("a delete refuses a pattern, a directory nobody made with `scratch new` and a way out of the root", () => {
	const root = directory();
	const made1 = make("other", root);
	const theirs = join(root, "mw-verify-1a2b3c");
	mkdirSync(theirs);
	writeFileSync(join(theirs, "report.md"), "an earlier verifier's findings");
	// The mistake of 2026-10-16: `rm -rf ~/.cache/mw-verify-*` took the reports of other verifiers.
	expect(() => remove(join(root, "mw-verify-*"), root)).toThrow("is a pattern");
	expect(() => remove(theirs, root)).toThrow("was not made by `scratch new`");
	expect(() => remove(root, root)).toThrow("is not directly under");
	const outside = directory();
	writeFileSync(join(outside, MARKER), "");
	expect(() => remove(outside, root)).toThrow("is not directly under");
	symlinkSync(outside, join(root, "mw-link"));
	expect(() => remove(join(root, "mw-link"), root)).toThrow("is a link");
	// A directory copied with its marker, and a link to a directory that is a scratch directory.
	const copy = join(root, "mw-copy-1a2b3c");
	cpSync(made1, copy, { recursive: true });
	expect(() => remove(copy, root)).toThrow("was not made by `scratch new`");
	symlinkSync(made1, join(root, "mw-alias"));
	expect(() => remove(join(root, "mw-alias"), root)).toThrow("is a link");
	expect(existsSync(copy) && existsSync(made1)).toBe(true);
	expect(existsSync(join(theirs, "report.md"))).toBe(true);
	expect(existsSync(outside)).toBe(true);
	expect(() => make("Bad Name", root)).toThrow("lower-case words");
	// `alias/` and `alias/.` are the link's target to the file system.
	expect(() => remove(`${join(root, "mw-alias")}/`, root)).toThrow("is a link");
	expect(() => remove(`${join(root, "mw-alias")}/.`, root)).toThrow("is a link");
	expect(existsSync(made1)).toBe(true);
});

test("the process table is read, and a caller's lineage is every process above it", () => {
	const procs = parseProcessTable(PROCS);
	expect(procs).toHaveLength(7);
	expect(procs[3]).toEqual({ pid: 300, ppid: 200, command: "bun scripts/check.ts" });
	expect([...lineage(procs, 300)].sort()).toEqual([1, 100, 200, 300]);
	expect(lineage(procs, 999)).toEqual(new Set([999]));
});

test("a server is `bun src/cli/main.ts serve`, not a shell that has those words in its command line", () => {
	const procs = parseProcessTable(PROCS);
	expect(procs.filter((p) => isServer(p.command)).map((p) => p.pid)).toEqual([500]);
	expect(isServer("bun start")).toBe(false);
	expect(isServer("bun src/cli/main.ts report --run 3")).toBe(false);
	expect(procs.filter((p) => isTestWorker(p.command)).map((p) => p.pid)).toEqual([400]);
	// The performance phase of the check runs `bun test --parallel=1`, which starts no worker.
	expect(isTestWorker("/opt/homebrew/bin/bun test --parallel=1 --no-orphans ./test/budgets.test.ts")).toBe(true);
	expect(["bun run test", "bun scripts/check.ts test", "bun test/e2e/serve.ts"].map(isTestWorker)).toEqual([
		false,
		false,
		false,
	]);
	expect(within("/a/b/c", "/a/b")).toBe(true);
	expect(within("/a/bc", "/a/b")).toBe(false);
});

/** A process that does nothing for a minute, with the arguments a server or a test worker has. */
async function decoy(root: string, args: string[], cwd: string) {
	const script = join(root, `decoy-${args.join("-").replace(/\W/g, "")}.js`);
	writeFileSync(
		script,
		'console.log("ready"); process.stdin.on("data", () => console.log("pong")); setInterval(() => {}, 1000);\n',
	);
	const child = Bun.spawn([process.execPath, script, ...args], {
		cwd,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "ignore",
	});
	children.push(child);
	const reader = child.stdout.getReader();
	const answer = async () => {
		const read = await reader.read();
		if (read.done) throw new Error("decoy ended before replying");
		return new TextDecoder().decode(read.value).trim();
	};
	expect(await answer()).toBe("ready");
	return {
		pid: child.pid,
		kill: () => child.kill(),
		exited: child.exited,
		ping: async () => {
			child.stdin.write("ping\n");
			child.stdin.flush();
			return answer();
		},
	};
}

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

test("stop-server stops the servers that run from this checkout, not another one's, and not the one that asked", async () => {
	const mine = directory();
	const other = directory();
	const server = await decoy(mine, ["src/cli/main.ts", "serve"], mine);
	const theirs = await decoy(other, ["src/cli/main.ts", "serve"], other);
	// The caller is itself a bun process with the words in its own command line, as a shell was under `pkill -f`.
	const caller = join(mine, "caller.ts");
	writeFileSync(
		caller,
		`import { stopServers } from ${JSON.stringify(join(import.meta.dir, "../scripts/work/processes.ts"))};
console.log(JSON.stringify({ stopped: await stopServers(${JSON.stringify(mine)}), self: process.pid }));`,
	);
	const done = await run([process.execPath, caller, "src/cli/main.ts", "serve"], { cwd: mine });
	expect(done.status).toBe(0);
	const said: { stopped: number[]; self: number } = JSON.parse(done.out);
	expect(said.stopped).toEqual([server.pid]);
	await server.exited;
	expect(alive(server.pid)).toBe(false);
	expect(alive(theirs.pid)).toBe(true);
	expect(await theirs.ping()).toBe("pong");
	expect(await stopServers(mine)).toEqual([]);
});

test("the board's ids are written once, and a move uses them", () => {
	expect(addArgs("https://github.com/endqwerty/mainworthy/pull/9")).toEqual([
		"project",
		"item-add",
		"2",
		"--owner",
		"endqwerty",
		"--url",
		"https://github.com/endqwerty/mainworthy/pull/9",
		"--format",
		"json",
		"--jq",
		".id",
	]);
	expect(editArgs("PVTI_x", "start")).toEqual([
		"project",
		"item-edit",
		"--id",
		"PVTI_x",
		"--project-id",
		"PVT_kwHOAArmbc4Bm7Xt",
		"--field-id",
		"PVTSSF_lAHOAArmbc4Bm7XtzhliU7A",
		"--single-select-option-id",
		"47fc9ee4",
	]);
	expect(editArgs("PVTI_x", "done").at(-1)).toBe("98236657");
	expect(isMove("todo") && !isMove("toString")).toBe(true);
});

test("`board check` names the id that no longer fits the board", () => {
	const field = (inProgress: string) => ({
		id: BOARD.statusField,
		options: [
			{ id: "f75ad846", name: "Todo" },
			{ id: inProgress, name: "In Progress" },
			{ id: "98236657", name: "Done" },
		],
	});
	expect(drift(BOARD.projectId, [field("47fc9ee4")])).toEqual([]);
	expect(drift(BOARD.projectId, [field("deadbeef")])).toEqual([
		'"In Progress" (start) is option deadbeef on the board, not 47fc9ee4',
	]);
	expect(drift("PVT_other", [])).toHaveLength(2);
});

const facts = (over: Partial<Facts> = {}): Facts => ({
	pull: { url: "https://github.com/endqwerty/mainworthy/pull/832", draft: false },
	addedFragments: [],
	body: "## Why\n\nCloses #12\n",
	base: "main",
	milestone: "M3",
	linked: [12],
	issueMilestones: new Map([[12, "M3"]]),
	...over,
});

test("a closing word is allowed on a line of its own, and nowhere else", () => {
	expect(problems(facts())).toEqual([]);
	// Pull request #172: "the closed #88" linked issue #88, which nobody meant.
	const stray = problems(facts({ body: "Closes #12\n\nThe closed #88 is why.\n", linked: [12, 88] }));
	expect(stray[0]).toContain('"closed #88" makes GitHub close that issue');
	expect(stray[1]).toBe("GitHub links #12, #88; the description closes #12.");
	expect(problems(facts({ body: `Closes #12\n\nIssue #88, which is closed, and \`fixes #3\` in code.\n` }))).toEqual(
		[],
	);
	expect(closing("Fixed: #7 and\nResolves #8\n```\ncloses #9\n```\n")).toEqual({ closes: [8], stray: ["Fixed: #7"] });
	// Fenced code in tildes is code too; an indented line is read, and is not a line of its own.
	expect(closing("~~~text\nCloses #12\n~~~\n")).toEqual({ closes: [], stray: [] });
	expect(closing("    Closes #12\n").closes).toEqual([]);
});

test("the description needs no Principles line; one is prose", () => {
	// Issue #904: the line checked spelling, not judgment, and nobody asked for the gate.
	expect(problems(facts({ body: "## Why\n\nCloses #12\n" }))).toEqual([]);
	expect(problems(facts({ body: "## Why\n\nCloses #12\n\nPrinciples: good design\n" }))).toEqual([]);
});

test("the milestone of the pull request is the milestone of its issue; in a stack nothing is linked yet", () => {
	expect(problems(facts({ milestone: null }))).toEqual(['The pull request has no milestone; its issue has "M3".']);
	expect(problems(facts({ milestone: "M1" }))[0]).toContain('milestone "M1"; its issue has "M3"');
	expect(problems(facts({ body: "Part of #12\n", linked: [], milestone: "M1" }))).toHaveLength(1);
	expect(problems(facts({ body: "No issue: the owner asked in a thread.\n", linked: [], milestone: null }))).toEqual(
		[],
	);
	expect(problems(facts({ base: "feature/below", linked: [] }))).toEqual([]);
});

test("added fragments name their own PR and pending is allowed only in a draft", () => {
	const file = ".changes/example-change.md";
	const own = "https://github.com/endqwerty/mainworthy/pull/832";
	const reference = (pr: string) => `---\nid: example\npr: ${pr}\n---\n\nA change.\n`;
	for (const text of [
		reference("pending"),
		reference("https://github.com/endqwerty/mainworthy/pull/831"),
		`---\nid: example\n---\n\npr: ${own}`,
		reference(own).replace(`pr: ${own}`, `pr: ${own}\npr: ${own}`),
	]) {
		const found = problems(facts({ addedFragments: [{ file, text }] }));
		expect(found.join("\n")).toContain(file);
		expect(found.join("\n")).toContain(own);
	}
	expect(problems(facts({ addedFragments: [{ file, text: reference(own) }] }))).toEqual([]);
	expect(
		problems(facts({ pull: { url: own, draft: true }, addedFragments: [{ file, text: reference("pending") }] })),
	).toEqual([]);
	expect(
		problems(
			facts({
				pull: { url: own, draft: true },
				addedFragments: [{ file, text: reference("https://github.com/endqwerty/mainworthy/pull/831") }],
			}),
		),
	).not.toEqual([]);
});

test("PR facts read added fragments at the immutable PR head", async () => {
	const head = "a".repeat(40);
	const calls: string[][] = [];
	const source = "---\nid: example\npr: pending\n---\n\nA fact.\n";
	const got = await gather(832, async (args) => {
		calls.push(args);
		if (args[0] === "pr")
			return JSON.stringify({
				body: "",
				baseRefName: "main",
				milestone: null,
				closingIssuesReferences: [],
				isDraft: true,
				headRefOid: head,
			});
		if (args[0] === "api" && args[1] === "repos/endqwerty/mainworthy/pulls/832") return "2";
		if (args[1]?.endsWith("/pulls/832/files"))
			return JSON.stringify([
				[{ status: "modified", filename: "src/example.ts" }],
				[{ status: "added", filename: ".changes/example-change.md" }],
			]);
		if (args[1] === `repos/endqwerty/mainworthy/contents/.changes/example-change.md?ref=${head}`) return source;
		throw new Error(`unexpected GitHub read: ${args.join(" ")}`);
	});
	expect(got.pull).toEqual({ url: "https://github.com/endqwerty/mainworthy/pull/832", draft: true });
	expect(got.addedFragments).toEqual([{ file: ".changes/example-change.md", text: source }]);
	expect(calls.find((args) => args[1]?.endsWith("/files"))?.join(" ")).toContain("--paginate");
	expect(calls.find((args) => args[1]?.endsWith("/files"))?.join(" ")).toContain("--slurp");
});

for (const change of [
	{ status: "modified", filename: ".changes/existing-fact.md" },
	{ status: "renamed", filename: ".changes/new-name.md", previous_filename: ".changes/existing-fact.md" },
	{ status: "removed", filename: ".changes/existing-fact.md" },
	{ status: "renamed", filename: "docs/moved-fact.md", previous_filename: ".changes/existing-fact.md" },
	{ status: "renamed", filename: ".changes/imported-fact.md", previous_filename: "docs/existing-fact.md" },
]) {
	test(`retained fragments refuse ${change.status}: ${change.filename}`, async () => {
		const reads: string[] = [];
		const gh = async (args: string[]): Promise<string> => {
			if (args[0] === "pr")
				return JSON.stringify({
					body: "",
					baseRefName: "main",
					milestone: null,
					closingIssuesReferences: [],
					isDraft: false,
					headRefOid: "a".repeat(40),
				});
			if (args[0] === "api" && args[1] === "repos/endqwerty/mainworthy/pulls/832") return "2";
			if (args[1]?.endsWith("/files")) {
				if (args.includes("--jq")) return ""; // The old added-only API query hides this change.
				return JSON.stringify([[{ status: "modified", filename: "src/unrelated.ts" }], [change]]);
			}
			reads.push(args.join(" "));
			return "---\npr: https://github.com/endqwerty/mainworthy/pull/832\n---\n\nAltered old fact.\n";
		};
		await expect(gather(832, gh)).rejects.toThrow(/immutable.*add a new fragment/i);
		expect(reads).toEqual([]);
	});
}

test("PR admission refuses a truncated GitHub file list", async () => {
	let reported = 3001;
	const pages = Array.from({ length: 30 }, (_, page) =>
		Array.from({ length: 100 }, (_, index) => ({ status: "modified", filename: `src/file-${page * 100 + index}.ts` })),
	);
	const gh = async (args: string[]): Promise<string> => {
		if (args[0] === "pr")
			return JSON.stringify({
				body: "",
				baseRefName: "main",
				milestone: null,
				closingIssuesReferences: [],
				isDraft: false,
				headRefOid: "a".repeat(40),
			});
		if (args[0] === "api" && args[1] === "repos/endqwerty/mainworthy/pulls/832") return JSON.stringify(reported);
		if (args[1]?.endsWith("/files")) return JSON.stringify(pages);
		throw new Error("a truncated listing must be refused before content reads");
	};
	await expect(gather(832, gh)).rejects.toThrow(/3000.*3001|incomplete.*file/i);
	reported = 3000;
	await expect(gather(832, gh)).resolves.toMatchObject({ addedFragments: [] });
});

for (const change of [
	{ status: "added", filename: "docs/decisions/0037-new-record.md" },
	{ status: "renamed", filename: "docs/decisions/0037-new-record.md", previous_filename: "docs/draft.md" },
]) {
	test(`new numbered decisions are refused even in historical gaps (${change.status})`, async () => {
		const gh = async (args: string[]): Promise<string> => {
			if (args[0] === "pr")
				return JSON.stringify({
					body: "",
					baseRefName: "main",
					milestone: null,
					closingIssuesReferences: [],
					isDraft: false,
					headRefOid: "a".repeat(40),
				});
			if (args[1]?.endsWith("/files")) return JSON.stringify([[change]]);
			if (args[1] === "repos/endqwerty/mainworthy/pulls/832") return "1";
			throw new Error("no content read is needed for a new decision filename");
		};
		await expect(gather(832, gh)).rejects.toThrow(/new decisions.*dated/i);
	});
}

test("CI checks changed changelog provenance and assembly", () => {
	const workflow = Bun.YAML.parse(readFileSync(".github/workflows/check.yml", "utf8"));
	expect(workflow).toMatchObject({
		jobs: {
			tests: {
				steps: expect.arrayContaining([
					expect.objectContaining({
						name: "A changed changelog is canonical",
						if: expect.stringContaining("matrix.name == 'tests' || matrix.name == 'tests-1'"),
						run: expect.stringContaining('--check --complete --base="$BASE"'),
						env: { BASE: expect.stringContaining("github.event.pull_request.base.sha || github.event.before") },
					}),
				]),
			},
		},
	});
});

test("the check's time is read from its report and judged against the spread between runs of one revision", () => {
	expect(checkSeconds("typecheck 9.1 s ok\ntests   121.4 s\ntotal   130.0 s\n")).toBe(121.4);
	expect(checkSeconds("total 52.0 s\n")).toBe(52);
	expect(checkSeconds("nothing")).toBeNull();
	// #167: the spread between runs of one revision was 0.9 s in one hour and 3.6 s in the next.
	expect(judge([140.1, 141.0], [141.2, 141.9]).slower).toBe(true);
	expect(judge([140.1, 143.7], [142.0, 143.0]).slower).toBe(false);
});

async function repository(): Promise<string> {
	const repo = directory();
	const git = (...args: string[]) =>
		run(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: repo });
	await git("init", "-q", "-b", "main");
	writeFileSync(join(repo, "a.txt"), "one\n");
	await git("add", ".");
	await git("commit", "-q", "-m", "one");
	await git("commit", "-q", "--allow-empty", "-m", "rebased: the same tree");
	writeFileSync(join(repo, "a.txt"), "two\n");
	await git("commit", "-q", "-am", "two");
	return repo;
}

test("a revision with the tree that was verified needs no timing; two that differ are timed alternately", async () => {
	const repo = await repository();
	expect(await sameTree("HEAD~2", "HEAD~1", repo)).toBe(true);
	expect(await sameTree("HEAD~1", "HEAD", repo)).toBe(false);
	const said: string[] = [];
	const options = {
		rounds: 2,
		install: false,
		repo,
		busy: async () => false,
		command: ["sh", "-c", "echo 'tests 1.5 s'"],
	};
	expect(await compare("HEAD~2", "HEAD~1", options, (l) => said.push(l))).toContain("same tree");
	expect(said).toEqual([]);
	const timed = await compare("HEAD~1", "HEAD", options, (l) => said.push(l));
	expect(timed).toContain("base: 1.5, 1.5 s");
	expect(timed).toContain("not slower than the spread");
	expect(said.map((l) => l.replace(/ on .*/, ""))).toEqual(Array(4).fill("running sh -c echo 'tests 1.5 s'"));
	await expect(compare("HEAD~1", "HEAD", { ...options, busy: async () => true }, () => {})).rejects.toThrow(
		"another test run",
	);
});

test("a PostgreSQL startup lock disappearing while it is inspected is retried", async () => {
	const root = directory();
	mkdirSync(join(root, "scripts/work"), { recursive: true });
	for (const file of ["pg.ts", "work/scratch.ts"]) cpSync(join("scripts", file), join(root, "scripts", file));
	const script = join(root, "race.test.ts");
	writeFileSync(
		script,
		`
 import {expect,mock,test} from "bun:test";
 import * as fs from "node:fs";
 const actual = {...fs};
 let first = true;
 mock.module("node:fs",()=>({...actual,mkdirSync(path,...options) {
  if (String(path).endsWith(".lock") && first) {
   first = false;
   throw Object.assign(new Error("another process held the lock, then released it"),{code:"EEXIST"});
  }
  return actual.mkdirSync(path,...options);
 }}));
 const {stopCluster} = await import("./scripts/pg.ts");
 test("retry the released lock",async()=>expect(await stopCluster()).toBe("checkout PostgreSQL is stopped"));
 `,
	);
	const answer = await run([process.execPath, "test", script], { cwd: root });
	expect(answer.status, answer.err + answer.out).toBe(0);
	expect(answer.err).toContain("1 pass");
});

test("stop-server stops only its checkout cluster, and release deletes it before installed packages", async () => {
	const root = directory();
	mkdirSync(join(root, "scripts/work"), { recursive: true });
	for (const file of [
		"pg.ts",
		"work/processes.ts",
		"work/release.ts",
		"work/run.ts",
		"work/scratch.ts",
		"work/test-databases.ts",
	])
		cpSync(join("scripts", file), join(root, "scripts", file));
	mkdirSync(join(root, "src/server/kernel"), { recursive: true });
	cpSync("src/server/kernel/db.ts", join(root, "src/server/kernel/db.ts"));
	mkdirSync(join(root, "node_modules"));
	const script = join(root, "probe.ts");
	writeFileSync(
		script,
		`
 import { existsSync,writeFileSync } from "node:fs";
 import {databaseAdmin} from "./src/server/kernel/db.ts";
 import {beginDatabaseRun,recordDatabase,databaseCreated} from "./scripts/work/test-databases.ts";
 import { cluster, clusterStatus, removeCluster } from "./scripts/pg.ts";
 import { stopServers } from "./scripts/work/processes.ts";
 import { release } from "./scripts/work/release.ts";
 const root = ${JSON.stringify(root)};
 const started = await cluster();
 const leftover = async () => {
  const current = await cluster();
  const name = "mw_test_"+process.pid+"_"+crypto.randomUUID().replaceAll("-", "");
  const run = beginDatabaseRun(root);
  const record = recordDatabase(run.directory,{name,adminUrl:current.adminUrl,owned:current.owned});
  await databaseAdmin(current.adminUrl,async admin => await admin.exec('CREATE DATABASE "'+name+'" TEMPLATE template0'));
  databaseCreated(record);
  writeFileSync(run.directory+"/owner.json",JSON.stringify({pid:process.pid,stamp:"an earlier process with this pid"}));
  return {name,directory:run.directory};
 };
 const beforeStop = await leftover();
 try {
  if (!started.owned) {
   await stopServers(root);
   if (existsSync(beforeStop.directory)) throw new Error("stop-server left an ended manifest");
   const beforeRelease = await leftover();
   await release(root);
   if (existsSync(beforeRelease.directory)) throw new Error("release left an ended manifest");
   if ((await clusterStatus())?.adminUrl !== started.adminUrl) throw new Error("external PostgreSQL changed");
   const sql = new Bun.SQL(started.adminUrl);
   try { await sql.unsafe("SELECT 1"); } finally { await sql.close(); }
   if (existsSync(root + "/node_modules")) throw new Error("release left installed packages");
   console.log("external PostgreSQL left running while packages were removed");
  } else {
  if (!started.directory) throw new Error("owned cluster has no directory");
  await stopServers(root);
  if (await clusterStatus() !== null) throw new Error("stop-server left PostgreSQL running");
  if (existsSync(beforeStop.directory)) throw new Error("stop-server left an ended manifest");
  if (!existsSync(root + "/node_modules")) throw new Error("stop-server removed installed packages");
  const restarted = await cluster();
  if (restarted.directory !== started.directory) throw new Error("restart changed cluster");
  const remaining = await databaseAdmin(restarted.adminUrl, async admin => await admin.all("SELECT datname FROM pg_database WHERE datname = $1::text",[beforeStop.name]));
  if (remaining.length) throw new Error("stop-server left the recorded database");
  const beforeRelease = await leftover();
  await release(root);
  if (existsSync(beforeRelease.directory)) throw new Error("release left an ended manifest");
  if (await clusterStatus() !== null || existsSync(started.directory)) throw new Error("release left cluster data");
  if (existsSync(root + "/node_modules")) throw new Error("release left installed packages");
  console.log("checkout cluster stopped, restarted, then removed with packages");
 }
 } finally { await removeCluster(); }
 `,
	);
	const child = Bun.spawn([process.execPath, script], {
		cwd: root,
		env: { ...process.env, MAINWORTHY_TEST_PG: binaries() ? "" : process.env.MAINWORTHY_TEST_PG },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, rc] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect({ rc, err }).toEqual({ rc: 0, err: "" });
	expect(out).toContain(
		binaries()
			? "checkout cluster stopped, restarted, then removed with packages"
			: "external PostgreSQL left running while packages were removed",
	);
});

test("release gives the disk back, and refuses while a server or a test run works from the checkout", async () => {
	const root = directory();
	for (const name of RELEASED) mkdirSync(join(root, name, "inner"), { recursive: true });
	mkdirSync(join(root, "src"));
	const server = await decoy(root, ["src/cli/main.ts", "serve"], root);
	// 2026-10-12: two children released the worktree under a lead and a builder that were still running.
	await expect(release(root)).rejects.toThrow(`pid ${server.pid}`);
	expect(existsSync(join(root, "node_modules", "inner"))).toBe(true);
	server.kill();
	await server.exited;
	// A single test file, or any other bun program, is not a server and not a test worker, and is as much in use.
	const single = await decoy(root, ["running.test.ts"], root);
	await expect(release(root)).rejects.toThrow(`pid ${single.pid}`);
	expect(existsSync(join(root, "node_modules", "inner"))).toBe(true);
	single.kill();
	await single.exited;
	// The Node helper an agent keeps in the checkout does not use its packages, and does not block the release.
	const node = Bun.which("node");
	if (node) {
		const script = join(root, "helper.js");
		writeFileSync(script, 'console.log("ready"); setInterval(() => {}, 1000);\n');
		const helper = Bun.spawn([node, script], { cwd: root, stdout: "pipe", stderr: "ignore" });
		children.push(helper);
		const reader = helper.stdout.getReader();
		expect(new TextDecoder().decode((await reader.read()).value).trim()).toBe("ready");
		reader.releaseLock();
	}
	expect(await release(root)).toContain("released node_modules");
	expect(RELEASED.filter((name) => existsSync(join(root, name)))).toEqual([]);
	expect(existsSync(join(root, "src"))).toBe(true);
});

async function clonePair(): Promise<{
	origin: string;
	clone: string;
	git: (cwd: string, ...args: string[]) => Promise<string>;
}> {
	const origin = directory();
	const clone = directory();
	const git = async (cwd: string, ...args: string[]): Promise<string> => {
		const done = await run(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd });
		if (done.status !== 0) throw new Error(`git ${args.join(" ")}: ${done.err}`);
		return done.out.trim();
	};
	await git(origin, "init", "-q", "--bare", "-b", "main");
	await git(clone, "clone", "-q", origin, ".");
	writeFileSync(join(clone, "a.txt"), "base\n");
	await git(clone, "add", ".");
	await git(clone, "commit", "-q", "-m", "base");
	await git(clone, "push", "-q", "origin", "main");
	await git(clone, "checkout", "-q", "-b", "t3/thread");
	return { origin, clone, git };
}

test("sync-branch moves a branch whose commits were merged by rebase, and refuses one with work that was not", async () => {
	const { clone, git } = await clonePair();
	writeFileSync(join(clone, "b.txt"), "change\n");
	await git(clone, "add", ".");
	await git(clone, "commit", "-q", "-m", "the thread's change");
	await git(clone, "push", "-q", "origin", "t3/thread");
	// Not merged yet: a reset would lose the commit.
	const mine = await git(clone, "rev-parse", "HEAD");
	await expect(syncBranch(clone)).rejects.toThrow("1 commit(s) of t3/thread are not on origin/main");
	expect(await git(clone, "rev-parse", "HEAD")).toBe(mine);
	// The owner merges by rebase: main gets the same change under another id.
	await git(clone, "checkout", "-q", "main");
	await git(clone, "cherry-pick", mine);
	await git(clone, "commit", "-q", "--amend", "-m", "the thread's change, rebased");
	await git(clone, "push", "-q", "origin", "main");
	await git(clone, "checkout", "-q", "t3/thread");
	writeFileSync(join(clone, "dirty.txt"), "not committed\n");
	await expect(syncBranch(clone)).rejects.toThrow("uncommitted changes");
	rmSync(join(clone, "dirty.txt"));
	expect(await syncBranch(clone)).toBe("t3/thread is at origin/main and pushed");
	expect(await git(clone, "rev-list", "--count", "origin/main..HEAD")).toBe("0");
	expect(await git(clone, "rev-parse", "HEAD")).toBe(await git(clone, "rev-parse", "origin/main"));
	await git(clone, "checkout", "-q", "main");
	await expect(syncBranch(clone)).rejects.toThrow("main is not a thread's branch");
});

test("sync-branch keeps a merge commit that main does not hold", async () => {
	const { clone, git } = await clonePair();
	const commit = async (file: string, message: string) => {
		writeFileSync(join(clone, file), `${message}\n`);
		await git(clone, "add", ".");
		await git(clone, "commit", "-q", "-m", message);
		return git(clone, "rev-parse", "HEAD");
	};
	await git(clone, "checkout", "-q", "main");
	await commit("x.txt", "x");
	await git(clone, "push", "-q", "origin", "main");
	await git(clone, "checkout", "-q", "-b", "side", "main");
	const side = await commit("s.txt", "s1");
	await git(clone, "checkout", "-q", "-B", "t3/thread", "main");
	const mine = await commit("t.txt", "t1");
	await git(clone, "merge", "-q", "--no-ff", "-m", "merge side", "side");
	// The owner's rebase merge: the thread's ordinary commits land under new ids, with one more change after them.
	await git(clone, "checkout", "-q", "-B", "landed", "main");
	await git(clone, "cherry-pick", side, mine);
	await commit("extra.txt", "extra");
	await git(clone, "push", "-q", "origin", "landed:main");
	await git(clone, "checkout", "-q", "t3/thread");
	await git(clone, "fetch", "-q", "origin");
	// Every ordinary commit of the thread is on main under another id; its merge commit is not, and the trees differ.
	// (Whether `git cherry` lists a merge commit differs between versions of git: the answer must not depend on it.)
	const head = await git(clone, "rev-parse", "HEAD");
	await expect(syncBranch(clone, false)).rejects.toThrow("merge commit(s) that origin/main does not hold");
	expect(await git(clone, "rev-parse", "HEAD")).toBe(head);
	// A branch that holds the same tree as main loses nothing.
	await commit("extra.txt", "extra");
	expect(await syncBranch(clone, false)).toBe("t3/thread is at origin/main");
});

test("check-time stops at a command that failed, and at no rounds", async () => {
	const repo = await repository();
	const options = {
		rounds: 1,
		install: false,
		repo,
		busy: async () => false,
		command: ["sh", "-c", "echo 'tests 1.0 s'; echo broke >&2; exit 1"],
	};
	await expect(compare("HEAD~1", "HEAD", options, () => {})).rejects.toThrow("failed (exit 1)");
	const over = {
		...options,
		command: ["sh", "-c", "echo 'tests 160.0 s'; echo 'OVER BUDGET: the tests took 160 s'; exit 1"],
	};
	expect(await compare("HEAD~1", "HEAD", over, () => {})).toContain("base: 160.0 s");
	await expect(compare("HEAD~1", "HEAD", { ...options, rounds: 0 }, () => {})).rejects.toThrow("at least 1");
});

test("a process listing that did not work is an error, so that a release does not go by an empty answer", async () => {
	await expect(directoriesFromLsof(["sh", "-c", "echo 'no lsof' >&2; exit 1"])).rejects.toThrow("could not be read");
	const some = await directoriesFromLsof(["sh", "-c", "printf 'p42\\nn/a/b\\n'; exit 1"]);
	expect(some.get(42)).toBe("/a/b");
});

test("the retired suite waiter is rejected without starting a wait", async () => {
	const done = await run([process.execPath, join(import.meta.dir, "../scripts/work.ts"), "wait-tests"]);
	expect(done.status).toBe(4);
	expect(done.err).toContain("usage:");
	expect(done.err).not.toContain("wait-tests");
});

test("a code fence the description ends inside is code to its end", () => {
	expect(closing("~~~text\nCloses #12\n")).toEqual({ closes: [], stray: [] });
	expect(closing("Closes #5\n```\nCloses #12\n")).toEqual({ closes: [5], stray: [] });
});

test("under the CI policy a failure needs a fix, asks nobody, and is over when a commit passes the test", async () => {
	const h = await harness({ preset: "standard", unlinked: "create" });
	try {
		const call: Call = async (op, input) => await h.call(op, input);
		const gate = async (commit: string) => await h.call<GateStatus>("gate", { commit });
		const open = async () => (await h.call<InboxReply>("inbox", { kind: "failure" })).items.map((item) => item.q);
		const change = async (commit: string, fail: Record<number, string> = {}, attempt = 1) =>
			await h.call("report", ciReport({ commit, branch: "feature", pr: 69, base: "main0001", n: 2, fail, attempt }));
		await h.call("report", ciReport({ commit: "main0001", n: 2 }));

		// A question asked before the switch is answered by the new rule.
		await change("change01", { 1: "Expected: 9\nReceived: 8" });
		expect(await open()).toHaveLength(1);
		expect((await gate("change01")).verdict).toBe("blocked");
		expect(await ciPolicy(call, "scratch")).toMatch(
			/^project scratch: every CI failure is answered "needs a fix" by rule \(Q-\d+ accepted\)$/,
		);
		expect(await ciPolicy(call, "scratch")).toBe(
			'project scratch: every CI failure is already answered "needs a fix" by rule',
		);
		const policy = await h.call<Policy>("admin", { do: "policy.show", project: "scratch" });
		expect(policy.settings.unlinked).toBe("create");
		expect(policy.clauses.find((clause) => clause.when.includes("hint:disputed"))?.ask.who).toBe("member");
		expect(await open()).toEqual([]);
		expect(await gate("change01")).toMatchObject({
			verdict: "failed",
			open: [],
			tally: { attributed: 1, unexplained: 0 },
		});

		const read = await readCi(call, { change: "pr:69" });
		expect(read.exit).toBe(1);
		expect(read.text).toContain("needs a fix (1):\n");
		expect(read.text).toContain("tests/checkout.spec.ts: test 1\n    Expected: 9\n    Received: 8\n");

		// A retry of the shard that passes is the commit's newest word.
		await change("change01", {}, 2);
		expect(await gate("change01")).toMatchObject({ verdict: "passed", open: [] });

		// A new failure on a later commit, then a commit that fixes it.
		await change("change02", { 0: "boom" });
		expect(await gate("change02")).toMatchObject({ verdict: "failed", open: [] });
		expect(await open()).toEqual([]);
		await change("change03");
		expect(await readCi(call, { change: "pr:69" })).toEqual({
			exit: 0,
			text: expect.stringContaining("Nothing to do."),
		});

		// The test the retry passed fails again: the session is told it flipped lately, so it re-runs before fixing.
		await change("change04", { 1: "Expected: 9\nReceived: 8" });
		const flaky = await readCi(call, { change: "pr:69" });
		expect(flaky.exit).toBe(1);
		expect(flaky.text).toContain("tests/checkout.spec.ts: test 1 (flipped 1 time in the last 14 days)\n");
		expect(flaky.text).toContain("1 of these flipped between passing and failing in the last 14 days");
		expect(flaky.text).toContain("the gate passes once no other failure is left");
		await change("change05");

		// A failure on main is the same, and every failing test is listed, past a page of them.
		const many = Object.fromEntries(Array.from({ length: 503 }, (_, i) => [i, `boom ${i}`]));
		await h.call("report", ciReport({ commit: "main0002", n: 503, fail: many }));
		expect(await gate("main0002")).toMatchObject({ verdict: "failed", open: [] });
		expect(await open()).toEqual([]);
		const all = await readCi(call, { commit: "main0002" });
		expect(all.text).toContain("needs a fix (503):");
		expect(all.text).toContain("tests/checkout.spec.ts: test 502\n    boom 502\n");

		// Once main passes, the commit that failed has no answer left and nobody is asked about it (decision 0102).
		await h.call("report", ciReport({ commit: "main0003", n: 503 }));
		const old = await readCi(call, { commit: "main0002" });
		expect(old.exit).toBe(2);
		expect(old.text).toContain("Nobody is asked: a later commit passed these tests");
		expect(old.text).not.toContain("ci-policy");
	} finally {
		await h.close();
	}
});

test("ci waits for a pending gate and says when a person is asked", async () => {
	const h = await harness({ preset: "standard" });
	try {
		const call: Call = async (op, input) => await h.call(op, input);
		const pending = await readCi(call, { commit: "nothing0" }, { wait: 0 });
		expect(pending.exit).toBe(3);
		expect(pending.text).toContain("--wait=<seconds>");

		await h.call("report", ciReport({ commit: "main0001", n: 2, fail: { 0: "boom" } }));
		let slept = 0;
		const blocked = await readCi(call, { commit: "main0001" }, { wait: 60, sleep: async () => void slept++ });
		expect(slept).toBe(0);
		expect(blocked.exit).toBe(2);
		expect(blocked.text).toContain("not explained yet (1):");
		expect(blocked.text).toContain("bun scripts/work.ts ci-policy");
	} finally {
		await h.close();
	}
});

test("marking a PR ready reruns its fragment-reference check", () => {
	const workflow = Bun.YAML.parse(readFileSync(".github/workflows/check.yml", "utf8"));
	expect(workflow).toMatchObject({
		on: { pull_request: { types: expect.arrayContaining(["opened", "synchronize", "reopened", "ready_for_review"]) } },
	});
});
