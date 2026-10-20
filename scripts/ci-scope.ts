// What the check workflow runs for a change: the first job of `.github/workflows/check.yml` asks this, and the
// other jobs run, or are skipped, on its answer (decision 0090).
//
//   bun scripts/ci-scope.ts --base=<rev>     what CI would run for the files that differ between <rev> and HEAD
//   bun scripts/ci-scope.ts                  the same against where HEAD left origin/main
//
// Each job names the files it reads, and runs when one of them changed. The tests run whole, except when every
// changed file is one that no code of the product, the tests or the scripts reads (prose, the iPhone app, another
// workflow): then the tests that read every file of the tree run, with each test file that names the changed file.
// A change this cannot read, or one to what decides what runs, runs everything.
//
// Bun's own `bun test --changed` follows imports, and finds no test for a change to `src/web`: the browser tests
// reach the web UI through a server they start. Hence paths, held to the Dockerfile and the configuration by
// `test/ci-scope.test.ts`.
import { appendFileSync, readFileSync } from "node:fs";
import { Glob } from "bun";
import { CI_SHARDS, QUIET } from "./check-plan.ts";

/** Patterns, and patterns a file must not match. */
type Paths = { include: readonly string[]; exclude?: readonly string[] };

const matches = (paths: Paths, file: string): boolean =>
	paths.include.some((pattern) => new Glob(pattern).match(file)) &&
	!(paths.exclude ?? []).some((pattern) => new Glob(pattern).match(file));

/** What decides what runs. A change to one of these runs every job, whatever else it changes. */
export const CI: Paths = {
	include: [
		".github/workflows/check.yml",
		"scripts/ci-scope.ts",
		"scripts/check-plan.ts",
		"scripts/check.ts",
		"scripts/ci-gate.ts",
	],
};

/**
 * What the type-check and the lint read: tsconfig.json's `include`, biome.json's `files`, `.gitignore` (biome.json's
 * `vcs.useIgnoreFile`), and the packages with what installs them.
 */
export const STATIC: Paths = {
	include: ["src/**", "test/**", "bench/**", "scripts/**", "*.json", ".gitignore", "bun.lock", "bunfig.toml"],
};

/** What the image is built from: the Dockerfile's COPY lines, and the two files that decide what they copy. */
export const IMAGE: Paths = {
	include: [
		"Dockerfile",
		".dockerignore",
		"package.json",
		"bun.lock",
		"tsconfig.json",
		"biome.json",
		"src/**",
		"skill/**",
		"docs/guide/**",
		"docs/diagrams/**",
		"docs/ui/screenshots/**",
		"LICENSE",
		"NOTICE",
		"THIRD-PARTY-NOTICES.md",
		"licences/archify/**",
	],
};

/**
 * What the iPhone app's job runs: the app, the scripts that write its Swift and start its server, and the server
 * with what Bun reads to load them (the packages, `tsconfig.json`'s paths, `bunfig.toml`). Not the web UI, which
 * the server serves to a browser and the app never reads.
 */
export const IOS: Paths = {
	include: [
		"ios/**",
		"scripts/ios.ts",
		"scripts/ios/**",
		"test/oidc-support.ts",
		"src/**",
		"package.json",
		"bun.lock",
		"tsconfig.json",
		"bunfig.toml",
	],
	exclude: ["src/web/**"],
};

/**
 * Files that no code of the product, of the tests or of the scripts reads, so a test that reads one names it in
 * its text. What `/docs` serves is not among them: the server imports it. Neither are the repository's diagrams,
 * which `scripts/diagrams.ts` stamps and `test/docs.test.ts` checks through it.
 */
export const NAMED: Paths = {
	include: ["docs/**", "*.md", ".github/**", "ios/**"],
	exclude: [
		"docs/guide/**",
		"docs/diagrams/**",
		"docs/development/diagrams/**",
		"docs/ui/screenshots/**",
		"THIRD-PARTY-NOTICES.md",
		".github/workflows/check.yml",
	],
};

/**
 * The tests that read every file of the tree, or every entry at its top: one looks for the former name, one for the
 * owner's, and one gives each top-level entry its jobs (a new file there fails it until it is placed).
 */
export const TREE = ["test/architecture.test.ts", "test/ci-scope.test.ts", "test/licences.test.ts"];

export type Job = "static" | "image" | "ios";
export type Plan = {
	/** Why, in one line, for the run's summary. */
	why: string;
	jobs: Record<Job, boolean>;
	/** Every test file, or these. */
	tests: "all" | string[];
};

export type TestFile = { file: string; text: string };

/** Every test file of the checkout, with its text. */
export function testFiles(root = "."): TestFile[] {
	return [...new Glob("{src,test}/**/*.test.{ts,tsx}").scanSync(root)]
		.sort()
		.map((file) => ({ file, text: readFileSync(`${root}/${file}`, "utf8") }));
}

/**
 * The test files that name `changed`, or a directory it is in (`docs/`, `ios/App/`), from the repository's root:
 * `ios/README.md` and the address `/docs/guide` do not name `README.md` and `docs/`; `../../ios/` names `ios/`.
 */
export function readers(changed: string, tests: readonly TestFile[]): string[] {
	const parts = changed.split("/");
	const names = [changed, ...parts.slice(0, -1).map((_, i) => `${parts.slice(0, i + 1).join("/")}/`)];
	const named = new RegExp(
		`(?:^|[^\\w./-]|\\.\\./)(?:${names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
	);
	return tests.filter((test) => named.test(test.text)).map((test) => test.file);
}

const everything = (why: string): Plan => ({ why, jobs: { static: true, image: true, ios: true }, tests: "all" });

/** What runs for a change: the files it adds, changes or deletes, or null when they could not be read. */
export function plan(changed: readonly string[] | null, tests: readonly TestFile[]): Plan {
	if (changed === null) return everything("the changed files could not be read, so everything runs");
	if (changed.length === 0) return everything("no file changed, so everything runs");
	const ci = changed.filter((file) => matches(CI, file));
	if (ci.length > 0) return everything(`${ci[0]} decides what runs, so everything runs`);
	const jobs = {
		static: changed.some((file) => matches(STATIC, file)),
		image: changed.some((file) => matches(IMAGE, file)),
		ios: changed.some((file) => matches(IOS, file)),
	};
	const code = changed.find((file) => !matches(NAMED, file));
	if (code !== undefined) return { why: `${code} is read by code, so every test runs`, jobs, tests: "all" };
	const named = new Set([...TREE, ...changed.flatMap((file) => readers(file, tests))]);
	return {
		why: "every changed file is one only tests that name it read",
		jobs,
		tests: tests.map((test) => test.file).filter((file) => named.has(file)),
	};
}

/** One runner of the tests job: its name is the report's and the gate's, `files` empty for every file. */
export type Entry = { name: string; phase: string; files: string };

/** The tests job's runners: the shards and the quiet tests, or the chosen files in one runner for each phase. */
export function matrix(tests: Plan["tests"]): Entry[] {
	if (tests === "all")
		return [
			...Array.from({ length: CI_SHARDS }, (_, i) => ({
				name: `tests-${i + 1}`,
				phase: `--only=parallel --shard=${i + 1}/${CI_SHARDS}`,
				files: "",
			})),
			{ name: "quiet", phase: "--only=quiet", files: "" },
		];
	const quiet = tests.filter((file) => QUIET.includes(file));
	const parallel = tests.filter((file) => !QUIET.includes(file));
	return [
		...(parallel.length > 0 ? [{ name: "tests", phase: "--only=parallel", files: parallel.join(" ") }] : []),
		...(quiet.length > 0 ? [{ name: "quiet", phase: "--only=quiet", files: quiet.join(" ") }] : []),
	];
}

/** The files that differ between `base` and HEAD, a rename as the two files it is; null when git cannot say. */
export function changedFiles(base: string, cwd = "."): string[] | null {
	const run = Bun.spawnSync(["git", "diff", "--name-only", "--no-renames", "-z", base, "HEAD"], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (run.exitCode !== 0) return null;
	return run.stdout.toString().split("\0").filter(Boolean);
}

/**
 * What the workflow reads, as `key=value` lines for GITHUB_OUTPUT. A test file's name goes into a command line,
 * so a plan that names one with anything but letters, digits and `._/-` is not narrowed.
 */
export function outputs(chosen: Plan): string[] {
	const safe = chosen.tests === "all" || chosen.tests.every((file) => /^[\w./-]+$/.test(file));
	const final = safe ? chosen : { ...chosen, tests: "all" as const };
	const entries = matrix(final.tests);
	return [
		...(["static", "image", "ios"] as const).map((job) => `${job}=${final.jobs[job]}`),
		`matrix=${JSON.stringify({ include: entries })}`,
		`shards=${entries.map((entry) => entry.name).join(" ")}`,
		`files=${final.tests === "all" ? "" : final.tests.join(",")}`,
	];
}

/** The plan in words, for the terminal and the run's summary page. */
export function describe(chosen: Plan): string[] {
	const jobs = (["static", "image", "ios"] as const).map((job) => `${job} ${chosen.jobs[job] ? "runs" : "skipped"}`);
	const tests = chosen.tests === "all" ? "every test file" : chosen.tests.join(", ");
	return [`CI scope: ${chosen.why}.`, `Jobs: ${jobs.join(", ")}.`, `Tests: ${tests}.`];
}

if (import.meta.main) {
	const arg = process.argv.slice(2).find((one) => one.startsWith("--base="));
	const unknown = process.argv.slice(2).filter((one) => !one.startsWith("--base="));
	if (unknown.length > 0) {
		console.error("usage: bun scripts/ci-scope.ts [--base=<rev>]");
		process.exit(4);
	}
	let base = arg?.slice("--base=".length);
	if (base === undefined) {
		const fork = Bun.spawnSync(["git", "merge-base", "origin/main", "HEAD"], { stdout: "pipe", stderr: "pipe" });
		base = fork.exitCode === 0 ? fork.stdout.toString().trim() : "origin/main";
	}
	const chosen = plan(changedFiles(base), testFiles());
	const words = describe(chosen);
	console.log(words.join("\n"));
	if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${outputs(chosen).join("\n")}\n`);
	if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${words.join("\n\n")}\n`);
}
