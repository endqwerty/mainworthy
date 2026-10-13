// The interactive diagrams in `docs/diagrams/`: each is one self-contained HTML page that archify builds from the
// candidate of the same name in `docs/diagrams/src/`. The pages are committed, because the server carries them
// and archify is not a dependency of this repository.
//
//   bun scripts/diagrams.ts build <archify directory> [name...]   build the named diagrams (all without a name)
//   bun scripts/diagrams.ts stamp                                  record the pages as they are now
//
// `build` runs archify's `finalize` (validate against the files the candidate cites, render, check in a browser),
// then stamps. The stamp, `docs/diagrams/src/built.json`, holds the hash of each candidate and of its page;
// `test/docs.test.ts` fails when a candidate was edited and its page was not built again, or a page was edited
// by hand.
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const ROOT = new URL("../", import.meta.url).pathname;
const PAGES = join(ROOT, "docs/diagrams");
const SOURCES = join(PAGES, "src");
export const STAMP = join(SOURCES, "built.json");

const Candidate = z.looseObject({
	diagram_type: z.enum(["architecture", "workflow", "sequence", "dataflow", "lifecycle"]),
	meta: z.looseObject({ output: z.string() }),
});
export const Stamp = z.record(z.string(), z.object({ candidate: z.string(), page: z.string() }));
export type Stamp = z.infer<typeof Stamp>;

const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

/** The diagrams that have a candidate. */
export const diagramNames = (): string[] =>
	readdirSync(SOURCES)
		.filter((file) => file.endsWith(".json") && file !== "built.json")
		.map((file) => file.slice(0, -".json".length))
		.sort();

export const candidatePath = (name: string): string => join(SOURCES, `${name}.json`);
export const pagePath = (name: string): string => join(PAGES, `${name}.html`);

/** What the stamp would say of the files as they are now. A candidate with no page yet has no entry. */
export function currentStamp(): Stamp {
	return Object.fromEntries(
		diagramNames()
			.filter((name) => existsSync(pagePath(name)))
			.map((name) => [name, { candidate: sha256(candidatePath(name)), page: sha256(pagePath(name)) }]),
	);
}

async function build(archify: string, names: string[]): Promise<void> {
	for (const name of names) {
		const candidate = Candidate.parse(JSON.parse(readFileSync(candidatePath(name), "utf8")));
		if (candidate.meta.output !== `docs/diagrams/${name}.html`)
			throw new Error(`${name}: meta.output must be docs/diagrams/${name}.html`);
		// The receipts archify writes beside a page go to a directory of their own, which is removed.
		const evidence = mkdtempSync(join(tmpdir(), "mainworthy-diagram-"));
		try {
			const run = Bun.spawnSync(
				[
					"node",
					join(archify, "bin/archify.mjs"),
					"finalize",
					candidate.diagram_type,
					`docs/diagrams/src/${name}.json`,
					`docs/diagrams/${name}.html`,
					"--repo-root",
					".",
					"--quality",
					"showcase",
					"--out-dir",
					evidence,
					"--json",
				],
				{ cwd: ROOT, stdout: "pipe", stderr: "inherit" },
			);
			const receipt = z
				.looseObject({ status: z.string(), gates: z.record(z.string(), z.string()).optional() })
				.safeParse(JSON.parse(run.stdout.toString() || "null"));
			const gates = receipt.success ? JSON.stringify(receipt.data.gates ?? {}) : "no receipt";
			if (run.exitCode !== 0 || !receipt.success || receipt.data.status !== "pass")
				throw new Error(`${name}: archify finalize did not pass (${gates}); run it by hand to read why`);
			console.info(`${name}: built, ${gates}`);
		} finally {
			rmSync(evidence, { recursive: true, force: true });
			// And the ones it writes beside the page whatever it is told.
			for (const receipt of ["delivery", "finalize", "finalize-summary", "browser-check"])
				rmSync(join(PAGES, `${name}.${receipt}.json`), { force: true });
		}
	}
}

if (import.meta.main) {
	const [command, ...rest] = Bun.argv.slice(2);
	if (command === "build") {
		const [archify, ...names] = rest;
		if (!archify) throw new Error("usage: bun scripts/diagrams.ts build <archify directory> [name...]");
		await build(archify, names.length > 0 ? names : diagramNames());
	} else if (command !== "stamp") {
		throw new Error("usage: bun scripts/diagrams.ts build <archify directory> [name...] | stamp");
	}
	await Bun.write(STAMP, `${JSON.stringify(currentStamp(), null, "\t")}\n`);
	console.info(`stamped ${diagramNames().length} diagrams in docs/diagrams/src/built.json`);
}
