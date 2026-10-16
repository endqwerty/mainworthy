// The commands of `scripts/work.ts`: each stands where AGENTS.md used to keep a recipe that an agent got wrong. A
// test here is the mistake itself, and the command must not make it: a delete by pattern, a stop that takes the
// shell that asked, a wait that never ends, a pull request that closes an issue by a stray word, a time compared
// from one run.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addArgs, BOARD, drift, editArgs, isMove } from "../scripts/work/board.ts";
import { checkSeconds, compare, judge, sameTree } from "../scripts/work/check-time.ts";
import {
	isServer,
	isTestWorker,
	lineage,
	type Proc,
	parseProcessTable,
	processTable,
	stopServers,
	waitForTests,
	within,
} from "../scripts/work/processes.ts";
import { closing, type Facts, problems } from "../scripts/work/pull-request.ts";
import { run } from "../scripts/work/run.ts";
import { MARKER, make, refusal, remove } from "../scripts/work/scratch.ts";

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
	expect(() => remove(join(root, "mw-link"), root)).toThrow("is not directly under");
	expect(existsSync(join(theirs, "report.md"))).toBe(true);
	expect(existsSync(outside)).toBe(true);
	expect(() => make("Bad Name", root)).toThrow("lower-case words");
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
	expect(within("/a/b/c", "/a/b")).toBe(true);
	expect(within("/a/bc", "/a/b")).toBe(false);
});

/** A process that does nothing for a minute, with the arguments a server or a test worker has. */
function decoy(root: string, args: string[], cwd: string): { pid: number; kill: () => void } {
	const script = join(root, `decoy-${args.join("-").replace(/\W/g, "")}.js`);
	writeFileSync(script, "setInterval(() => {}, 1000);\n");
	const child = Bun.spawn([process.execPath, script, ...args], { cwd, stdout: "ignore", stderr: "ignore" });
	children.push(child);
	return child;
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
	const server = decoy(mine, ["src/cli/main.ts", "serve"], mine);
	const theirs = decoy(other, ["src/cli/main.ts", "serve"], other);
	// The caller is itself a bun process with the words in its own command line, as a shell was under `pkill -f`.
	const caller = join(mine, "caller.ts");
	writeFileSync(
		caller,
		`import { stopServers } from ${JSON.stringify(join(import.meta.dir, "../scripts/work/processes.ts"))};
console.log(JSON.stringify({ stopped: await stopServers(${JSON.stringify(mine)}), self: process.pid }));`,
	);
	await Bun.sleep(300);
	const done = await run([process.execPath, caller, "src/cli/main.ts", "serve"], { cwd: mine });
	expect(done.status).toBe(0);
	const said: { stopped: number[]; self: number } = JSON.parse(done.out);
	expect(said.stopped).toEqual([server.pid]);
	await Bun.sleep(300);
	expect(alive(server.pid)).toBe(false);
	expect(alive(theirs.pid)).toBe(true);
	expect(await stopServers(mine)).toEqual([]);
});

test("wait-tests ends when the other test run's workers end, and does not wait for its own caller", async () => {
	const root = directory();
	const worker = decoy(root, ["--test-worker"], root);
	// Other test runs on the machine, this one's own workers included, are not what this test is about.
	const table = async (): Promise<Proc[]> => (await processTable()).filter((p) => p.pid === worker.pid);
	expect((await waitForTests(0, { pollMs: 50, table })).map((p: Proc) => p.pid)).toEqual([worker.pid]);
	setTimeout(() => worker.kill(), 400);
	expect(await waitForTests(20, { pollMs: 50, table })).toEqual([]);
	// A caller with `--test-worker` in its own command line (as the shell had `[t]est-worker` under `pgrep -f`).
	const caller = join(root, "caller.ts");
	writeFileSync(
		caller,
		`import { lineage, processTable, waitForTests } from ${JSON.stringify(join(import.meta.dir, "../scripts/work/processes.ts"))};
const own = lineage(await processTable(), process.pid);
const table = async () => (await processTable()).filter((p) => own.has(p.pid));
console.log(JSON.stringify(await waitForTests(5, { pollMs: 50, table })));`,
	);
	const started = Date.now();
	const done = await run([process.execPath, caller, "--test-worker"]);
	expect(JSON.parse(done.out)).toEqual([]);
	expect(Date.now() - started).toBeLessThan(4000);
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
	expect(problems(facts({ body: "Closes #12\n\nIssue #88, which is closed, and `fixes #3` in code.\n" }))).toEqual([]);
	expect(closing("Fixed: #7 and\nResolves #8\n```\ncloses #9\n```\n")).toEqual({ closes: [8], stray: ["Fixed: #7"] });
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
