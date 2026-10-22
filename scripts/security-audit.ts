// The Daybreak security audit that every merge into `main` passes last (`docs/security-audit.md`). It refuses a pull
// request the owner did not open and sign, or whose head is not on the base it lands on; then it exports the head,
// writes the brief and runs Daybreak Blue in Codex's read-only sandbox. Run origin/main's copy, never the branch's,
// so a pull request cannot change the audit that reads it:
//
//   git fetch -q origin main && git show origin/main:scripts/security-audit.ts | bun run - <number> [--context <file>]
//
// It imports nothing from the repository for the same reason: read from standard input, a relative import would load
// the branch's file. `makeScratch` is a copy of `scripts/work/scratch.ts`'s `make`, and a test holds the two together.
import { spawnSync } from "node:child_process";
import {
	closeSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const MODEL = "gpt-daybreak-blue-latest";
/** The `reviewer` row of `homelab route models --profile deep`. */
export const EFFORT = "high";

/** The files that say what the audit is; a change to one is called out in the brief. */
export const AUDIT_FILES = [
	"scripts/security-audit.ts",
	"docs/security-audit.md",
	"AGENTS.md",
	"docs/landing-a-stack.md",
	"docs/development/ci-and-delivery.md",
];

export type Pull = {
	number: number;
	state: string;
	author: string;
	crossRepository: boolean;
	head: string;
	baseBranch: string;
};

/** A commit as GitHub reports it: `author` and `committer` are accounts, null when no account has the address. */
export type Commit = { sha: string; author: string | null; committer: string | null; verified: boolean };

type Facts = { pull: Pull; commits: Commit[]; owner: string; headOnBase: boolean; base: string };

const short = (sha: string): string => sha.slice(0, 8);

/** Why the pull request may not be audited; empty when it may. */
export function refusals({ pull, commits, owner, headOnBase, base }: Facts): string[] {
	const why: string[] = [];
	const name = `pull request #${pull.number}`;
	if (pull.state !== "OPEN") why.push(`${name} is ${pull.state}, not open`);
	if (pull.author !== owner) why.push(`${name} was opened by ${pull.author}, not ${owner}`);
	if (pull.crossRepository) why.push(`${name} comes from another repository`);
	if (commits.length === 0) why.push(`${name} has no commits`);
	for (const c of commits) {
		const account = (login: string | null) => login ?? "an address no GitHub account has";
		if (c.author !== owner) why.push(`commit ${short(c.sha)} was written by ${account(c.author)}, not ${owner}`);
		if (c.committer !== owner)
			why.push(`commit ${short(c.sha)} was committed by ${account(c.committer)}, not ${owner}`);
		if (!c.verified) why.push(`commit ${short(c.sha)} has no signature GitHub verifies`);
	}
	if (!headOnBase)
		why.push(
			`head ${short(pull.head)} is not on ${pull.baseBranch} (${short(base)}): rebase it, so the audit reads the tree that lands`,
		);
	return why;
}

/** Why this copy of the script may not run, or null. Read from standard input, it is the copy the command chose. */
export function selfCheck(path: string, own: string, main: string | null): string | null {
	if (path.endsWith("[stdin]")) return null;
	const run = "git fetch -q origin main && git show origin/main:scripts/security-audit.ts | bun run - <number>";
	if (main === null) return `origin/main has no scripts/security-audit.ts to run; run it as: ${run}`;
	if (own !== main) return `this copy differs from origin/main's, so the change may have edited it; run: ${run}`;
	return null;
}

type BriefFacts = {
	pull: Pull;
	head: string;
	base: string;
	tree: string;
	diff: string;
	changed: string[];
	context: string | null;
};

/** What Daybreak is asked: the head on its base, what to read and what to look at. */
export function brief({ pull, head, base, tree, diff, changed, context }: BriefFacts): string {
	const itself = changed.filter((file) => AUDIT_FILES.includes(file));
	return [
		"This is the security audit the mainworthy repository requires before any merge into main. You run in a",
		"read-only sandbox: do not try to write files. Your final message is saved as the findings.",
		"",
		`Read only ${tree} (a git archive export of the head) and ${diff}. Read nothing else on this machine.`,
		"",
		`Repository: mainworthy, public on GitHub. Pull request #${pull.number}.`,
		`Head: ${head}. Base: ${base} (${pull.baseBranch}). The head is on the base, so this is the tree that lands.`,
		"",
		...(itself.length > 0
			? [
					`This change edits the audit itself: ${itself.join(", ")}. Say so first, and judge whether the edit`,
					"weakens the audit or the rules around it.",
					"",
				]
			: []),
		"Look at the diff and what it reaches:",
		"- who a request is: admit, sessions and tokens in src/server/identity/, and the secret hashes UNEXPORTED keeps",
		"  out of an export (src/server/transfer/);",
		"- the HTTP and browser boundary: src/surfaces/http.ts (sameOrigin, the cookie attributes), src/surfaces/signin.ts",
		"  (the sign-in, passkey, OIDC and password routes, which are not operations, and their body limit),",
		"  src/surfaces/headers.ts and with-headers.ts (the content security policy), and what src/web renders;",
		"- the Witness writers, SQL and migrations, and the input an operation takes;",
		"- file paths, the CLI and MCP surfaces, .github/workflows/, dependencies (bun.lock), and anything a public",
		"  repository must not hold (credentials, private addresses, machine names, the owner's name).",
		"",
		...(context === null ? [] : ["Earlier rounds and their answers:", context.trim(), ""]),
		"For each issue give the file and line, a concrete case that goes wrong, the severity (high, medium, low) and",
		'a fix. For each earlier issue, say "addressed" or "not addressed" and why. If there is nothing new, say',
		'"No new issues". Name the head you read.',
	].join("\n");
}

/** `codex exec`'s arguments; it runs from the export with standard input closed. */
export const codexArgs = (findings: string, text: string): string[] => [
	"exec",
	"-m",
	MODEL,
	"-c",
	`model_reasoning_effort=${EFFORT}`,
	"--sandbox",
	"read-only",
	"--skip-git-repo-check",
	"-o",
	findings,
	text,
];

/** A new `<root>/mw-<name>-XXXXXX` with `scripts/work/scratch.ts`'s marker, so `scratch rm` deletes it. */
export function makeScratch(name: string, root = join(homedir(), ".cache")): string {
	mkdirSync(root, { recursive: true });
	const directory = realpathSync(mkdtempSync(join(root, `mw-${name}-`)));
	writeFileSync(join(directory, ".mw-scratch"), `${directory}\n`);
	return directory;
}

const run = (command: string, args: string[]): { ok: boolean; out: string; err: string } => {
	const r = spawnSync(command, args, { encoding: "utf8", maxBuffer: 1 << 28 });
	return { ok: r.status === 0, out: r.stdout ?? "", err: r.stderr ?? "" };
};

const must = (command: string, args: string[]): string => {
	const r = run(command, args);
	if (!r.ok) throw new Error(`${command} ${args.join(" ")} failed: ${r.err.trim()}`);
	return r.out;
};

// A function, not an arrow: read from standard input, the file is parsed as TSX, where `<T>(` opens a tag.
function json<T>(command: string, args: string[]): T {
	return JSON.parse(must(command, args)) as T;
}

function main(argv: string[]): number {
	const number = Number(argv[0]);
	const at = argv.indexOf("--context");
	const contextFile = at === -1 ? null : argv[at + 1];
	if (!Number.isInteger(number) || number < 1 || (at !== -1 && !contextFile)) {
		console.error("usage: security-audit <pull request number> [--context <file of earlier rounds>]");
		return 2;
	}
	const shown = run("git", ["show", "origin/main:scripts/security-audit.ts"]);
	const own = import.meta.path.endsWith("[stdin]") ? "" : readFileSync(import.meta.path, "utf8");
	const copy = selfCheck(import.meta.path, own, shown.ok ? shown.out : null);
	if (copy !== null) {
		console.error(copy);
		return 2;
	}
	const repo = json<{ nameWithOwner: string; owner: { login: string } }>("gh", [
		"repo",
		"view",
		"--json",
		"nameWithOwner,owner",
	]);
	const view = json<{
		number: number;
		state: string;
		author: { login: string };
		isCrossRepository: boolean;
		headRefOid: string;
		baseRefName: string;
	}>("gh", ["pr", "view", String(number), "--json", "number,state,author,isCrossRepository,headRefOid,baseRefName"]);
	const pull: Pull = {
		number: view.number,
		state: view.state,
		author: view.author.login,
		crossRepository: view.isCrossRepository,
		head: view.headRefOid,
		baseBranch: view.baseRefName,
	};
	const pages = json<
		{
			sha: string;
			author: { login: string } | null;
			committer: { login: string } | null;
			commit: { verification: { verified: boolean } };
		}[][]
	>("gh", ["api", "--paginate", "--slurp", `repos/${repo.nameWithOwner}/pulls/${number}/commits?per_page=100`]);
	const commits: Commit[] = pages.flat().map((c) => ({
		sha: c.sha,
		author: c.author?.login ?? null,
		committer: c.committer?.login ?? null,
		verified: c.commit.verification.verified,
	}));
	must("git", ["fetch", "-q", "origin", pull.baseBranch, pull.head]);
	const base = must("git", ["ls-remote", "origin", `refs/heads/${pull.baseBranch}`]).split(/\s/)[0] ?? "";
	if (!/^[0-9a-f]{40}$/.test(base)) throw new Error(`no ${pull.baseBranch} on origin`);
	const headOnBase = run("git", ["merge-base", "--is-ancestor", base, pull.head]).ok;
	const why = refusals({ pull, commits, owner: repo.owner.login, headOnBase, base });
	if (why.length > 0) {
		for (const line of why) console.error(line);
		return 2;
	}

	const directory = makeScratch(`audit-${number}`);
	const tree = join(directory, "tree");
	mkdirSync(tree);
	const archive = join(directory, "head.tar");
	must("git", ["archive", "--output", archive, pull.head]);
	must("tar", ["-x", "-f", archive, "-C", tree]);
	const diff = join(directory, "change.diff");
	writeFileSync(diff, must("git", ["diff", base, pull.head]));
	if (statSync(diff).size === 0) throw new Error(`head ${short(pull.head)} changes nothing on ${short(base)}`);
	const changed = must("git", ["diff", "--name-only", base, pull.head]).split("\n").filter(Boolean);
	const context = contextFile ? readFileSync(contextFile, "utf8") : null;
	const text = brief({ pull, head: pull.head, base, tree, diff, changed, context });
	writeFileSync(join(directory, "brief.md"), text);
	const findings = join(directory, "findings.md");
	console.log(`auditing ${pull.head} on ${base} (pull request #${number} by ${pull.author})`);
	const itself = changed.filter((file) => AUDIT_FILES.includes(file));
	if (itself.length > 0) console.log(`this change edits the audit itself: ${itself.join(", ")}`);
	console.log(`scratch: ${directory}`);

	const log = openSync(join(directory, "log.txt"), "w");
	const codex = spawnSync("codex", codexArgs(findings, text), { cwd: tree, stdio: ["ignore", log, log] });
	closeSync(log);
	console.log(`findings: ${findings}`);
	return codex.status ?? 1;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
