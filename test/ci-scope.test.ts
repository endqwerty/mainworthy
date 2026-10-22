// What the check workflow runs for a change (`scripts/ci-scope.ts`, decision 0090). A job that is skipped when it
// was needed lets a change land untested, so the paths each job reads are held here to the files that decide them.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Glob } from "bun";
import { parseCheckArgs, QUIET, testArgs } from "../scripts/check-plan.ts";
import {
	changedFiles,
	IMAGE,
	IOS,
	matrix,
	NAMED,
	outputs,
	plan,
	readers,
	STATIC,
	type TestFile,
	TREE,
	testFiles,
} from "../scripts/ci-scope.ts";
import { MARKER } from "../scripts/work/scratch.ts";

const tests = testFiles();
const covers = (paths: { include: readonly string[]; exclude?: readonly string[] }, file: string): boolean =>
	paths.include.some((pattern) => new Glob(pattern).match(file)) &&
	!(paths.exclude ?? []).some((pattern) => new Glob(pattern).match(file));

test("a change to prose runs no job but the tests, and of them only the ones that read it", () => {
	const chosen = plan(["AGENTS.md", "docs/decisions/0015-the-project-is-called-mainworthy.md"], tests);
	expect(chosen.jobs).toEqual({ static: false, image: false, ios: false });
	expect(chosen.tests).not.toBe("all");
	for (const file of TREE) expect(chosen.tests).toContain(file);
	expect(chosen.tests).not.toContain("test/e2e/queue-and-runs.test.ts");
	// README.md is read by no test but the ones that read every file; `ios/README.md` does not name it.
	expect(plan(["README.md"], tests).tests).toEqual(TREE);
	// A new file at the top is one the list of top-level entries below does not have yet (the verifier's finding of
	// 2026-10-16): that test runs for it.
	expect(plan(["CONTRIBUTING.md"], tests).tests).toContain("test/ci-scope.test.ts");
});

test("a change to the iPhone app runs its job and the tests that read the app, and not the image", () => {
	const chosen = plan(["ios/App/Info.plist"], tests);
	expect(chosen.jobs).toEqual({ static: false, image: false, ios: true });
	// The licences test reads Info.plist; the conflict test imports a fixture of the app's tests as `../../ios/`.
	expect(chosen.tests).toEqual([
		"test/architecture.test.ts",
		"test/ci-scope.test.ts",
		"test/e2e/conflict.test.ts",
		"test/ios-contract.test.ts",
		"test/licences.test.ts",
	]);
});

test("a change to the web UI runs every test, the type-check and the image, and not the iPhone app", () => {
	expect(plan(["src/web/app.tsx", "src/web/phone.css"], tests)).toMatchObject({
		jobs: { static: true, image: true, ios: false },
		tests: "all",
	});
	expect(plan(["src/server/runs/runs.ts"], tests)).toMatchObject({
		jobs: { static: true, image: true, ios: true },
		tests: "all",
	});
	// The scripts are not in the image; the ones that start the iPhone app's server are the app's job.
	expect(plan(["scripts/ios/contract.ts"], tests).jobs).toEqual({ static: true, image: false, ios: true });
	expect(plan(["scripts/gen-docs.ts"], tests).jobs).toEqual({ static: true, image: false, ios: false });
});

test("the pages /docs serves are read by the server: a change to one runs every test and the image", () => {
	for (const file of ["docs/guide/keyboard.md", "docs/diagrams/overview.html", "THIRD-PARTY-NOTICES.md"])
		expect(plan([file], tests), file).toMatchObject({ jobs: { image: true, ios: false }, tests: "all" });
});

test("prose beside code runs what the code needs", () => {
	expect(plan(["CHANGELOG.md", "src/core/runs.ts"], tests)).toMatchObject({ tests: "all", jobs: { ios: true } });
});

test("everything runs when the change cannot be read, is empty, or changes what decides what runs", () => {
	const everything = { jobs: { static: true, image: true, ios: true }, tests: "all" };
	expect(plan(null, tests)).toMatchObject(everything);
	expect(plan([], tests)).toMatchObject(everything);
	for (const file of [".github/workflows/check.yml", "scripts/ci-scope.ts", "scripts/check-plan.ts"])
		expect(plan(["docs/roadmap.md", file], tests), file).toMatchObject(everything);
});

test("a test names what it reads from the repository's root, or through ../", () => {
	const files: TestFile[] = [
		{ file: "test/a.test.ts", text: 'readFileSync("ios/README.md")' },
		{ file: "test/b.test.ts", text: 'fetch(url + "/docs/guide")' },
		{ file: "test/c.test.ts", text: 'import table from "../../ios/Kit/Tests/x.json";' },
		{ file: "test/d.test.ts", text: 'new Glob("docs/**/*.md")' },
		{ file: "test/e.test.ts", text: 'readFileSync("README.md")' },
	];
	expect(readers("README.md", files)).toEqual(["test/e.test.ts"]);
	expect(readers("ios/Kit/Tests/x.json", files)).toEqual(["test/a.test.ts", "test/c.test.ts"]);
	expect(readers("docs/roadmap.md", files)).toEqual(["test/d.test.ts"]);
});

test("a rename is the file it was and the file it is", () => {
	const root = mkdtempSync(join(tmpdir(), "mainworthy-scope-"));
	try {
		const git = (...args: string[]) => {
			const run = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
			expect(run.exitCode, run.stderr.toString()).toBe(0);
		};
		git("init", "--quiet");
		git("config", "user.email", "robin@example.com");
		git("config", "user.name", "robin");
		writeFileSync(join(root, "notes.ts"), "export const notes = 'a long enough text that git sees a rename';\n");
		git("add", ".");
		git("commit", "--quiet", "-m", "one");
		git("mv", "notes.ts", "notes.md");
		git("commit", "--quiet", "-m", "two");
		expect(changedFiles("HEAD^1", root)?.sort()).toEqual(["notes.md", "notes.ts"]);
		// A base git does not know, as after a force push: null, and everything runs.
		expect(changedFiles("0000000000000000000000000000000000000000", root)).toBeNull();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the image job runs for every file the Dockerfile copies", () => {
	const sources = [...readFileSync("Dockerfile", "utf8").matchAll(/^COPY (?!--from)(.+) \S+$/gm)].flatMap((line) =>
		(line[1] ?? "").split(/\s+/),
	);
	expect(sources.length).toBeGreaterThan(5);
	for (const source of sources)
		expect(covers(IMAGE, source) || covers(IMAGE, `${source}/a-file`), `${source} in IMAGE`).toBe(true);
});

test("the static job runs for every file the type-check and the lint read", () => {
	const tsconfig = JSON.parse(readFileSync("tsconfig.json", "utf8")) as { include: string[] };
	for (const directory of tsconfig.include) expect(covers(STATIC, `${directory}/a.ts`), directory).toBe(true);
	const biome = JSON.parse(readFileSync("biome.json", "utf8")) as {
		files: { includes: string[] };
		vcs?: { useIgnoreFile?: boolean };
	};
	for (const pattern of biome.files.includes.filter((one) => !one.startsWith("!")))
		expect(covers(STATIC, pattern.replace("**", "a/b.ts")), pattern).toBe(true);
	// A pattern biome cannot parse in `.gitignore` fails the lint (the verifier's finding of 2026-10-16).
	if (biome.vcs?.useIgnoreFile) expect(covers(STATIC, ".gitignore")).toBe(true);
	for (const file of ["tsconfig.json", "biome.json", "package.json", "bun.lock"])
		expect(covers(STATIC, file), file).toBe(true);
});

/**
 * The entries at the top of the repository: those of the files git lists, or, in an export with no git, those of the
 * tree without what a checkout makes and git ignores, and without the marker `scratch new` writes into an export.
 */
function topEntries(listed: string, tree: () => string[]): string[] {
	if (listed)
		return [
			...new Set(
				listed
					.split("\n")
					.filter(Boolean)
					.map((file) => file.split("/")[0] ?? ""),
			),
		];
	const made = ["node_modules", ".mainworthy", "test-results", "dist", ".git", MARKER];
	return tree().filter((name) => !made.includes(name));
}

test("an export's top entries leave out what a checkout or a scratch export makes", () => {
	expect(topEntries("", () => [".mw-scratch", "node_modules", "src", "README.md"])).toEqual(["src", "README.md"]);
	expect(topEntries("src/a.ts\nsrc/b.ts\nREADME.md\n", () => [".mw-scratch"])).toEqual(["src", "README.md"]);
});

// Each entry at the top of the repository, and the jobs a change to it runs. A new one is decided here, in review:
// a configuration file a job reads goes into that job's paths in scripts/ci-scope.ts. Every one of these runs every
// test, except the files that only the tests naming them read.
test("every entry at the top of the repository has the jobs it needs", () => {
	const entries = topEntries(Bun.spawnSync(["git", "ls-files"], { stdout: "pipe" }).stdout.toString(), () =>
		readdirSync("."),
	);
	const jobs = (entry: string): string => {
		const file = existsSync(entry) && statSync(entry).isDirectory() ? `${entry}/a-file.ts` : entry;
		const chosen = plan([file], tests);
		const names = (["static", "image", "ios"] as const).filter((job) => chosen.jobs[job]);
		return [...names, chosen.tests === "all" ? "tests" : "named tests"].join(" ");
	};
	expect(Object.fromEntries(entries.sort().map((entry) => [entry, jobs(entry)]))).toEqual({
		".dockerignore": "image tests",
		".github": "named tests",
		".gitignore": "static tests",
		"AGENTS.md": "named tests",
		"CHANGELOG.md": "named tests",
		Dockerfile: "image tests",
		LICENSE: "image tests",
		NOTICE: "image tests",
		"README.md": "named tests",
		"THIRD-PARTY-NOTICES.md": "image tests",
		bench: "static tests",
		"biome.json": "static image tests",
		"bun.lock": "static image ios tests",
		"bunfig.toml": "static ios tests",
		"compose.coolify.yaml": "tests",
		"compose.yaml": "tests",
		docs: "named tests",
		ios: "ios named tests",
		licences: "tests",
		"package.json": "static image ios tests",
		scripts: "static tests",
		skill: "image tests",
		src: "static image ios tests",
		"t3.json": "static tests",
		test: "static tests",
		"tsconfig.json": "static image ios tests",
	});
});

test("the iPhone app's job runs for every module its script loads, and none of them is the web UI's", () => {
	const transpiler = new Bun.Transpiler({ loader: "ts" });
	const seen = new Set<string>();
	const visit = (file: string): void => {
		if (seen.has(file)) return;
		seen.add(file);
		for (const { path } of transpiler.scanImports(readFileSync(file, "utf8"))) {
			if (!path.startsWith(".")) continue;
			const next = join(file, "..", path);
			if (/\.tsx?$/.test(next) && existsSync(next)) visit(next);
		}
	};
	visit("scripts/ios.ts");
	expect(seen.size).toBeGreaterThan(20);
	expect([...seen].filter((file) => !covers(IOS, file))).toEqual([]);
});

// The narrowed tests rest on this: a file of NAMED is read by no code but a test, and a test that reads one names
// it. A module that names one in its code is listed here with what it does with it.
test("no module outside the tests reads a file that only the tests naming it are run for", () => {
	const expected: Record<string, string> = {
		"scripts/ios/swift.ts": "writes the app's generated Swift; test/ios-contract.test.ts compares it and names ios/",
		"scripts/security-audit.ts": "names the audit's own files to call out a change to them, and reads none of them",
		"src/server/identity/identity.ts": "a message that points to docs/deploy.md",
	};
	const found: string[] = [];
	for (const file of new Glob("{src,scripts,bench}/**/*.{ts,tsx}").scanSync(".")) {
		if (/\.test\.tsx?$/.test(file)) continue;
		const code = readFileSync(file, "utf8")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/^\s*\/\/.*$/gm, "");
		const named = [...code.matchAll(/(?:^|[^\w./-]|\.\.\/)((?:\.github|docs|ios)\/[\w./-]*\w|[\w-]+\.md)\b/g)]
			.map((match) => match[1] ?? "")
			.filter((path) => existsSync(path))
			.filter((path) => (/\.\w+$/.test(path) ? covers(NAMED, path) : covers(NAMED, `${path}/a-file`)));
		if (named.length > 0) found.push(file);
	}
	expect(found.sort()).toEqual(Object.keys(expected).sort());
});

test("the chosen files go to one runner for each phase, and a file name that is not plain is not narrowed", () => {
	const quiet = QUIET[0] ?? "";
	expect(matrix(["test/a.test.ts", quiet, "test/b.test.ts"])).toEqual([
		{ name: "tests", phase: "--only=parallel", files: "test/a.test.ts test/b.test.ts" },
		{ name: "quiet", phase: "--only=quiet", files: quiet },
	]);
	const read = (lines: string[]) => Object.fromEntries(lines.map((line) => line.split(/=(.*)/s)));
	const jobs = { static: false, image: false, ios: true };
	expect(read(outputs({ why: "", jobs, tests: ["test/a.test.ts", "test/b.test.ts"] }))).toEqual({
		static: "false",
		image: "false",
		ios: "true",
		matrix: JSON.stringify({ include: matrix(["test/a.test.ts", "test/b.test.ts"]) }),
		shards: "tests",
		files: "test/a.test.ts,test/b.test.ts",
	});
	const odd = read(outputs({ why: "", jobs, tests: ["test/$(touch x).test.ts"] }));
	expect(odd.files).toBe("");
	expect(odd.shards).toBe(
		matrix("all")
			.map((entry) => entry.name)
			.join(" "),
	);
});

test("a phase given files runs those and no other", () => {
	const quiet = QUIET[0] ?? "";
	const parallel = testArgs("parallel", { timings: "t.json", files: ["test/docs.test.ts", quiet] });
	expect(parallel.filter((arg) => !arg.startsWith("-"))).toEqual(["test", "./test/docs.test.ts"]);
	const only = testArgs("quiet", { timings: "t.json", files: ["test/docs.test.ts", quiet] });
	expect(only.filter((arg) => !arg.startsWith("-"))).toEqual(["test", `./${quiet}`]);
});

test("the check refuses files it would not run as named, before it runs anything", () => {
	const refused = (args: string[]) => {
		const run = Bun.spawnSync([process.execPath, "scripts/check.ts", "test", ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
		return { exit: run.exitCode, said: run.stderr.toString() };
	};
	// Each of these, run, would be every file of a phase or none: a quiet phase given no quiet file has no path.
	expect(refused(["--only=quiet", "test/docs.test.ts"])).toEqual({
		exit: 4,
		said: "check: not a file of the quiet phase (QUIET in scripts/check-plan.ts): test/docs.test.ts\n",
	});
	expect(() => parseCheckArgs(["test", "test/docs.test.ts"])).toThrow(
		"test files are named with --only and without --shard",
	);
	expect(() => parseCheckArgs(["test", "--only=parallel", "--shard=1/6", "test/docs.test.ts"])).toThrow(
		"test files are named with --only and without --shard",
	);
	expect(() => parseCheckArgs(["test", "--only=parallel", "docs/roadmap.md"])).toThrow(
		"not a test file of this checkout",
	);
});
