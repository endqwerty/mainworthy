// What a machine must have before a test can say anything about the code: a Bun new enough, and the packages
// installed. Without them the suite fails in hundreds of lines that name neither. On 2026-10-13, on a Mac whose
// first `bun` was 1.3.11, `bun run test` ended in a segmentation fault of the test runner, "database disk image
// is malformed" and a missed budget, and every browser test of a single file failed with `"/api/login" cannot be
// parsed as a URL`; in a worktree with nothing installed it printed "Cannot find package" 750 lines long.
// `scripts/check.ts` asks before it starts anything, and `test/preflight.ts` asks for a `bun test <file>`.
//
// This file imports nothing that is installed: it has to run where nothing is.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { binaries, POSTGRES_MISSING } from "./pg.ts";

/** The oldest Bun the project runs on. AGENTS.md names it, and the workflow and the Dockerfile install it. */
export const OLDEST_BUN = "1.4.0";

const dependencies = (root: string): string[] => {
	const manifest: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	if (typeof manifest !== "object" || manifest === null) return [];
	return (["dependencies", "devDependencies"] as const).flatMap((group) => {
		const named: unknown = Reflect.get(manifest, group);
		return typeof named === "object" && named !== null ? Object.keys(named) : [];
	});
};

/** Why the tests cannot run here, each with what to do about it. Empty on a machine that is ready. */
export function unready({
	version = Bun.version,
	bun = process.execPath,
	root = join(import.meta.dir, ".."),
}: {
	version?: string;
	bun?: string;
	root?: string;
} = {}): string[] {
	const problems: string[] = [];
	if (!Bun.semver.satisfies(version, `>=${OLDEST_BUN}`))
		problems.push(
			`this is Bun ${version} (${bun}) and Mainworthy needs Bun ${OLDEST_BUN} or newer. Put a newer one first on PATH (\`which -a bun\` lists the ones this machine has) or run \`bun upgrade\`.`,
		);
	const missing = dependencies(root).filter((name) => !existsSync(join(root, "node_modules", name, "package.json")));
	if (missing.length > 0)
		problems.push(
			`${missing.length} of the packages package.json names are not installed (${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ", ..." : ""}). Run \`bun install --frozen-lockfile\`${problems.length > 0 ? ", with the newer Bun" : ""}.`,
		);
	if (!process.env.MAINWORTHY_TEST_PG && !binaries()) problems.push(POSTGRES_MISSING);
	return problems;
}

/** Says why the tests cannot run and ends the process, or returns. `who` starts each line: the command that asked. */
export function requireReady(who: string): void {
	const problems = unready();
	if (problems.length === 0) return;
	for (const problem of problems) console.error(`${who}: ${problem}`);
	if (problems.length !== 1 || problems[0] !== POSTGRES_MISSING)
		console.error(`${who}: nothing was run. This is about the machine, not the code.`);
	process.exit(4);
}
