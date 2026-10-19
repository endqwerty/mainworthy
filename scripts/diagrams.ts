// The interactive diagrams: each is one self-contained HTML page that archify builds from the candidate of the
// same name. There are two sets of them.
//
// - Served, in `docs/diagrams/`: the server carries them and the user guide (`docs/guide/`) shows them. Their
//   candidates are in `docs/diagrams/src/`.
// - Repository, in `docs/development/diagrams/`: for the pages read on GitHub (`docs/development/`,
//   `docs/features-and-flows.md`). No instance serves them. Each candidate sits beside its page.
//
// The pages are committed, because archify is not a dependency of this repository. Installed as a skill, it is
// at `~/.claude/skills/archify`.
//
//   bun scripts/diagrams.ts build <archify directory> [name...]   build the named diagrams (all without a name)
//   bun scripts/diagrams.ts picture [name...]                       draw the repository diagrams' PNGs again
//   bun scripts/diagrams.ts stamp                                  record the pages as they are now
//
// `build` runs archify's `finalize` (validate against the files the candidate cites, render, check in a browser),
// then stamps. Each set's stamp, `built.json` in its candidates' directory, holds the hash of each candidate and
// of its page; `test/docs.test.ts` fails when a candidate was edited and its page was not built again, or a page
// was edited by hand. GitHub shows an HTML file as text, so `build` also draws a repository diagram as
// `<name>.png` beside its page, which the Markdown shows and links to the page. It takes the Chromium the browser
// tests take (`MAINWORTHY_CHROMIUM`, else the system's).
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { z } from "zod";
import { chromiumLaunchOptions, findChromium } from "./check-plan.ts";

const ROOT = new URL("../", import.meta.url).pathname;

/** Where a set's pages and candidates are, relative to the repository. */
export type DiagramSet = { name: string; pages: string; sources: string };
export const SERVED: DiagramSet = { name: "served", pages: "docs/diagrams", sources: "docs/diagrams/src" };
export const REPOSITORY: DiagramSet = {
	name: "repository",
	pages: "docs/development/diagrams",
	sources: "docs/development/diagrams",
};
export const SETS: readonly DiagramSet[] = [SERVED, REPOSITORY];

const Candidate = z.looseObject({
	diagram_type: z.enum(["architecture", "workflow", "sequence", "dataflow", "lifecycle"]),
	meta: z.looseObject({ output: z.string() }),
});
export const Stamp = z.record(z.string(), z.object({ candidate: z.string(), page: z.string() }));
export type Stamp = z.infer<typeof Stamp>;

const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

export const stampPath = (set: DiagramSet): string => join(ROOT, set.sources, "built.json");

/** The diagrams of a set that have a candidate. A name has no dot, so a receipt archify leaves is not one. */
export const diagramNames = (set: DiagramSet = SERVED): string[] =>
	readdirSync(join(ROOT, set.sources))
		.filter((file) => file.endsWith(".json") && file !== "built.json")
		.map((file) => file.slice(0, -".json".length))
		.filter((name) => !name.includes("."))
		.sort();

export const candidatePath = (name: string, set: DiagramSet = SERVED): string =>
	join(ROOT, set.sources, `${name}.json`);
export const pagePath = (name: string, set: DiagramSet = SERVED): string => join(ROOT, set.pages, `${name}.html`);

/** What a set's stamp would say of the files as they are now. A candidate with no page yet has no entry. */
export function currentStamp(set: DiagramSet = SERVED): Stamp {
	return Object.fromEntries(
		diagramNames(set)
			.filter((name) => existsSync(pagePath(name, set)))
			.map((name) => [name, { candidate: sha256(candidatePath(name, set)), page: sha256(pagePath(name, set)) }]),
	);
}

/** The set a diagram belongs to. A name is in one set only, so `build <name>` means one diagram. */
function setOf(name: string): DiagramSet {
	const sets = SETS.filter((set) => diagramNames(set).includes(name));
	if (sets.length !== 1)
		throw new Error(sets.length === 0 ? `${name}: no candidate` : `${name}: a candidate in more than one set`);
	return sets[0] as DiagramSet;
}

/** The whole diagram of a repository page, in the light theme, without the viewer's controls around it. */
async function picture(names: string[]): Promise<void> {
	if (names.length === 0) return;
	const found = findChromium();
	if (found.path === null) throw new Error(`no picture drawn. ${found.skipped}`);
	const browser = await chromium.launch(chromiumLaunchOptions(found.path));
	try {
		for (const name of names) {
			const page = await browser.newPage({
				viewport: { width: 1600, height: 1200 },
				deviceScaleFactor: 2,
				colorScheme: "light",
			});
			await page.goto(pathToFileURL(pagePath(name, REPOSITORY)).href);
			// The viewer's controls float over the diagram. It marks them as what a printout leaves out.
			await page.addStyleTag({ content: ".no-print { display: none !important; }" });
			await page
				.locator('svg[role="img"]')
				.first()
				.screenshot({ path: join(ROOT, REPOSITORY.pages, `${name}.png`) });
			await page.close();
			console.info(`${name}: drew ${REPOSITORY.pages}/${name}.png`);
		}
	} finally {
		await browser.close();
	}
}

async function build(archify: string, names: string[]): Promise<void> {
	for (const name of names) {
		const set = setOf(name);
		const source = `${set.sources}/${name}.json`;
		const page = `${set.pages}/${name}.html`;
		const candidate = Candidate.parse(JSON.parse(readFileSync(candidatePath(name, set), "utf8")));
		if (candidate.meta.output !== page) throw new Error(`${name}: meta.output must be ${page}`);
		// The receipts archify writes beside a page go to a directory of their own, which is removed.
		const evidence = mkdtempSync(join(tmpdir(), "mainworthy-diagram-"));
		try {
			const run = Bun.spawnSync(
				[
					"node",
					join(archify, "bin/archify.mjs"),
					"finalize",
					candidate.diagram_type,
					source,
					page,
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
			for (const receipt of ["delivery", "delivery-pending", "finalize", "finalize-summary", "browser-check"])
				rmSync(join(ROOT, set.pages, `${name}.${receipt}.json`), { force: true });
		}
	}
}

if (import.meta.main) {
	const [command, ...rest] = Bun.argv.slice(2);
	if (command === "build") {
		const [archify, ...names] = rest;
		if (!archify) throw new Error("usage: bun scripts/diagrams.ts build <archify directory> [name...]");
		const built = names.length > 0 ? names : SETS.flatMap((set) => diagramNames(set));
		await build(archify, built);
		await picture(built.filter((name) => setOf(name) === REPOSITORY));
	} else if (command === "picture") {
		const drawn = diagramNames(REPOSITORY);
		await picture(rest.length > 0 ? rest.filter((name) => drawn.includes(name)) : drawn);
	} else if (command !== "stamp") {
		throw new Error("usage: bun scripts/diagrams.ts build <archify directory> [name...] | picture [name...] | stamp");
	}
	for (const set of SETS) {
		await Bun.write(stampPath(set), `${JSON.stringify(currentStamp(set), null, "\t")}\n`);
		console.info(`stamped ${diagramNames(set).length} ${set.name} diagrams in ${set.sources}/built.json`);
	}
}
