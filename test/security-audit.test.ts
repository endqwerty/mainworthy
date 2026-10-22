// The Daybreak security audit's script (`docs/security-audit.md`): what it refuses before Codex starts, the copy it
// runs, the brief it writes and the sandbox it asks for. A test here is a way the audit could read the wrong thing or
// run where it should not: a pull request someone else wrote, a commit nobody signed, a head that is not on the base
// it lands on, a copy of the script the pull request changed.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AUDIT_FILES,
	brief,
	type Commit,
	codexArgs,
	type Entry,
	exportProblems,
	fromStdin,
	GITHUB_COMMIT_LIMIT,
	launchProblem,
	makeScratch,
	type Pull,
	parseTree,
	refusals,
	selfCheck,
	unwritable,
} from "../scripts/security-audit.ts";
import { remove } from "../scripts/work/scratch.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

const pull = (over: Partial<Pull> = {}): Pull => ({
	number: 739,
	state: "OPEN",
	author: "robin",
	crossRepository: false,
	head: HEAD,
	baseBranch: "main",
	...over,
});

const commit = (over: Partial<Commit> = {}): Commit => ({
	sha: "c".repeat(40),
	author: "robin",
	committer: "robin",
	verified: true,
	...over,
});

const facts = (over: { pull?: Partial<Pull>; commits?: Commit[]; local?: string[]; headOnBase?: boolean } = {}) => {
	const commits = over.commits ?? [commit()];
	return {
		pull: pull(over.pull),
		commits,
		local: over.local ?? commits.map((c) => c.sha),
		owner: "robin",
		headOnBase: over.headOnBase ?? true,
		base: BASE,
	};
};

test("an open pull request the owner wrote and signed, on its base, is audited", () => {
	expect(refusals(facts())).toEqual([]);
});

test("a pull request someone else opened is refused", () => {
	expect(refusals(facts({ pull: { author: "sam" } })).join("\n")).toContain("opened by sam, not robin");
});

test("a pull request from a fork is refused", () => {
	expect(refusals(facts({ pull: { crossRepository: true } })).join("\n")).toContain("from another repository");
});

test("a closed pull request is refused", () => {
	expect(refusals(facts({ pull: { state: "MERGED" } })).join("\n")).toContain("is MERGED");
});

test("a commit nobody signed is refused, and named", () => {
	const unsigned = commit({ sha: `d${"0".repeat(39)}`, verified: false });
	const why = refusals(facts({ commits: [commit(), unsigned] })).join("\n");
	expect(why).toContain("d0000000");
	expect(why).toContain("no signature GitHub verifies");
});

test("a commit another person wrote or committed is refused", () => {
	expect(refusals(facts({ commits: [commit({ author: "sam" })] })).join("\n")).toContain("written by sam");
	expect(refusals(facts({ commits: [commit({ committer: "web-flow" })] })).join("\n")).toContain(
		"committed by web-flow",
	);
	expect(refusals(facts({ commits: [commit({ author: null })] })).join("\n")).toContain(
		"written by an address no GitHub account has",
	);
});

test("a pull request with no commits is refused", () => {
	expect(refusals(facts({ commits: [] })).join("\n")).toContain("has no commits");
});

test("a head that is not on the base it lands on is refused", () => {
	const why = refusals(facts({ headOnBase: false })).join("\n");
	expect(why).toContain(`not on main (${BASE.slice(0, 8)})`);
	expect(why).toContain("rebase");
});

test("GitHub's commits must be exactly the range the export holds", () => {
	const late = `e${"0".repeat(39)}`;
	const why = refusals(facts({ commits: [commit()], local: [commit().sha, late] })).join("\n");
	expect(why).toContain("not listed: e0000000");
	expect(why).toContain("may have changed while it was read");
	const gone = refusals(facts({ commits: [commit(), commit({ sha: late })], local: [commit().sha] })).join("\n");
	expect(gone).toContain("not in the range: e0000000");
});

test("a pull request with as many commits as GitHub lists is refused, since the list may be cut short", () => {
	const many = Array.from({ length: GITHUB_COMMIT_LIMIT }, (_, i) => commit({ sha: i.toString(16).padStart(40, "0") }));
	expect(refusals(facts({ commits: many })).join("\n")).toContain(`GitHub lists at most ${GITHUB_COMMIT_LIMIT}`);
	expect(refusals(facts({ commits: many.slice(1) }))).toEqual([]);
});

test("a copy run from a file must be the one on origin/main", () => {
	expect(selfCheck(false, "same", "same")).toBeNull();
	expect(selfCheck(false, "mine", "main's")).toContain("differs from origin/main's");
	expect(selfCheck(false, "mine", null)).toContain("origin/main has no");
});

test("a copy read from standard input is the one the command took from origin/main, and a file is not", () => {
	expect(selfCheck(true, "", null)).toBeNull();
	expect(fromStdin("/[stdin]", false)).toBe(true);
	expect(fromStdin("/w/scripts/audit[stdin]", true)).toBe(false);
	expect(fromStdin("/w/[stdin]", true)).toBe(false);
	expect(fromStdin("/w/scripts/security-audit.ts", true)).toBe(false);
});

test("bun run in the checkout, where its bunfig.toml and .env load first, is refused", () => {
	expect(launchProblem("/w", "/w")).toContain("bun ran in the checkout");
	expect(launchProblem("/w/scripts", "/w")).toContain("bun ran in the checkout");
	expect(launchProblem("/", "/w")).toBeNull();
	expect(launchProblem("/work", "/w")).toBeNull();
});

const entry = (path: string, sha = "1".repeat(40), mode = "100644"): Entry => ({ mode, sha, path });

test("the export must be the head's tree, file for file and byte for byte", () => {
	const head = [entry("a.ts"), entry("src/b.ts", "2".repeat(40))];
	const same = new Map([
		["a.ts", "1".repeat(40)],
		["src/b.ts", "2".repeat(40)],
	]);
	expect(exportProblems(head, same, [])).toEqual([]);
	expect(exportProblems(head, new Map([["a.ts", "1".repeat(40)]]), []).join("\n")).toContain(
		"src/b.ts is in the head but not in the export",
	);
	const changed = new Map([...same, ["src/b.ts", "3".repeat(40)]]);
	expect(exportProblems(head, changed, []).join("\n")).toContain("src/b.ts in the export is not the head's");
	expect(exportProblems(head, new Map([...same, ["c.ts", "4".repeat(40)]]), []).join("\n")).toContain(
		"c.ts is in the export but not in the head",
	);
	expect(exportProblems(head, same, ["d"]).join("\n")).toContain("d in the export is not a plain file");
	expect(exportProblems([entry("l", "5".repeat(40), "120000")], new Map(), []).join("\n")).toContain("is a link");
});

test("an entry that is not a plain file inside the export is not written", () => {
	expect(unwritable(entry("src/a.ts"))).toBeNull();
	expect(unwritable(entry("run.sh", "1".repeat(40), "100755"))).toBeNull();
	expect(unwritable(entry("l", "1".repeat(40), "120000"))).toContain("is a link");
	expect(unwritable(entry("m", "1".repeat(40), "160000"))).toContain("is a submodule");
	for (const path of ["../x", "a/../../x", "/etc/x", "a/.git/hooks/x", "a//b", "./a"])
		expect(unwritable(entry(path))).toContain("is not a path inside the export");
});

test("ls-tree's output is read with paths that hold spaces and tabs", () => {
	const out = `100644 blob ${"1".repeat(40)}\ta b.ts\u0000100755 blob ${"2".repeat(40)}\tc\td.sh\u0000`;
	expect(parseTree(out)).toEqual([entry("a b.ts"), entry("c\td.sh", "2".repeat(40), "100755")]);
});

test("the documented launcher loads no start-up file of the checkout before the script refuses", () => {
	const repo = realpathSync(mkdtempSync(join(tmpdir(), "mw-audit-launch-")));
	roots.push(repo);
	const canary = join(repo, "canary");
	writeFileSync(join(repo, "preload.ts"), `require("node:fs").writeFileSync(${JSON.stringify(canary)}, "ran");\n`);
	writeFileSync(join(repo, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
	writeFileSync(join(repo, ".env"), "MW_AUDIT_CANARY=loaded\n");
	const launch = (cwd: string) =>
		spawnSync("bun", ["run", "-", "abc", "--repo", repo], {
			cwd,
			input: readFileSync("scripts/security-audit.ts"),
			encoding: "utf8",
		});
	const r = launch("/");
	expect(r.stderr).toContain("usage: security-audit");
	expect(r.status).toBe(2);
	expect(existsSync(canary)).toBe(false);
	// The same command in the checkout runs its preload: the canary above would have seen it.
	launch(repo);
	expect(readFileSync(canary, "utf8")).toBe("ran");
});

const briefFor = (changed: string[], context: string | null = null) =>
	brief({ pull: pull(), head: HEAD, base: BASE, tree: "/s/tree", diff: "/s/change.diff", changed, context });

test("the brief names the head, the base, what to read and what to look at", () => {
	const text = briefFor(["src/surfaces/http.ts"]);
	for (const part of [HEAD, BASE, "/s/tree", "/s/change.diff", "Read nothing else", "sameOrigin", "signin.ts"])
		expect(text).toContain(part);
	expect(text).not.toContain("edits the audit itself");
});

test("a change to the audit's own files is called out first", () => {
	for (const file of AUDIT_FILES) expect(briefFor([file])).toContain(`edits the audit itself: ${file}`);
});

test("earlier rounds go into the brief", () => {
	expect(briefFor(["a.ts"], "Round 1 found X; fixed in Y.")).toContain("Round 1 found X; fixed in Y.");
});

test("Codex runs Daybreak Blue in the read-only sandbox and writes its last message to the findings", () => {
	const args = codexArgs("/s/findings.md", "the brief");
	expect(args.slice(0, 2)).toEqual(["exec", "-m"]);
	expect(args).toContain("gpt-daybreak-blue-latest");
	expect(args.join(" ")).toContain("--sandbox read-only");
	expect(args.join(" ")).toContain("model_reasoning_effort=high");
	expect(args.join(" ")).toContain("-o /s/findings.md");
	expect(args.at(-1)).toBe("the brief");
	expect(args.join(" ")).not.toContain("danger");
});

test("the audit's scratch directory is one `scratch rm` deletes", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "mw-audit-root-")));
	roots.push(root);
	const directory = makeScratch("audit-739", root);
	expect(directory.startsWith(join(root, "mw-audit-739-"))).toBe(true);
	remove(directory, root);
	expect(existsSync(directory)).toBe(false);
});
