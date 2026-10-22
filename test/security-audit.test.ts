// The Daybreak security audit's script (`docs/security-audit.md`): what it refuses before Codex starts, the copy it
// runs, the brief it writes and the sandbox it asks for. A test here is a way the audit could read the wrong thing or
// run where it should not: a pull request someone else wrote, a commit nobody signed, a head that is not on the base
// it lands on, a copy of the script the pull request changed.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AUDIT_FILES,
	brief,
	type Commit,
	codexArgs,
	makeScratch,
	type Pull,
	refusals,
	selfCheck,
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

const facts = (over: { pull?: Partial<Pull>; commits?: Commit[]; headOnBase?: boolean } = {}) => ({
	pull: pull(over.pull),
	commits: over.commits ?? [commit()],
	owner: "robin",
	headOnBase: over.headOnBase ?? true,
	base: BASE,
});

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

test("a copy run from a file must be the one on origin/main", () => {
	expect(selfCheck("/w/scripts/security-audit.ts", "same", "same")).toBeNull();
	expect(selfCheck("/w/scripts/security-audit.ts", "mine", "main's")).toContain("differs from origin/main's");
	expect(selfCheck("/w/scripts/security-audit.ts", "mine", null)).toContain("origin/main has no");
});

test("a copy read from standard input is the one the command took from origin/main", () => {
	expect(selfCheck("/w/[stdin]", "anything", null)).toBeNull();
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
