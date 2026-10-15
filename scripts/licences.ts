// The licences of what Mainworthy ships that others wrote, gathered into `THIRD-PARTY-NOTICES.md`.
//
//   bun scripts/licences.ts              write THIRD-PARTY-NOTICES.md again, after a dependency or `licences/` changed
//   bun scripts/licences.ts --check-bun  say when this Bun is not the one the notices list (`bun run build` runs it first)
//
// Three sources. The npm packages are the ones the build bundles into the executable (and so into the web app),
// found by bundling the build's entry points and reading which files went in: a package that is installed and not
// imported is not shipped and not listed. Their texts are the licence files in each package. The rest is in
// `licences/`: what the documentation's diagrams embed, and the Bun runtime that `bun build --compile` puts
// into the executable, with every library it links (`licences/README.md` says how that list was made).
//
// `test/licences.test.ts` fails when the committed file is not what this prints, and when a licence is not one
// `LICENCES` names.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const ROOT = new URL("../", import.meta.url).pathname;
export const NOTICES = join(ROOT, "THIRD-PARTY-NOTICES.md");
const VENDORED = join(ROOT, "licences");

/** What `bun run build` compiles (package.json); the test holds the two to each other. */
export const ENTRYPOINTS = ["src/cli/main.ts", "src/server/read-worker.ts"];

/**
 * Every licence a shipped component relies on, with what it asks of us. A component under a licence that is not
 * here fails the test: whether Mainworthy may ship it is the owner's decision, made before it is added here. The
 * ones below the first group came with Bun (decision 0025 says what each means for Mainworthy).
 */
export const LICENCES: Readonly<Record<string, string>> = {
	MIT: "keep the notice",
	ISC: "keep the notice",
	"BSD-2-Clause": "keep the notice",
	"BSD-3-Clause": "keep the notice; do not use the authors' names to promote Mainworthy",
	"Apache-2.0": "keep the notice and any NOTICE file; say what was changed",
	"CC0-1.0": "nothing: a public domain dedication",
	"OFL-1.1": "keep the licence with the font; do not sell the font on its own",
	"CC-BY-4.0": "credit the source, link the licence and say what was changed (the privacy policy does, at its end)",

	"Apache-2.0 WITH LLVM-exception": "nothing in a binary: the exception waives the notice",
	Zlib: "keep the notice in source; say when the source was changed",
	Unlicense: "nothing: a public domain dedication",
	"LicenseRef-Public-Domain": "nothing: SQLite is in the public domain",
	FSFAP: "keep the notice",
	IJG: "say in the documentation that the software is based in part on the work of the Independent JPEG Group",
	"Unicode-3.0": "keep the notice",
	ICU: "keep the notice",
	"LicenseRef-ICU-Third-Party": "keep the notices of the third-party data ICU carries",
	"Artistic-2.0": "pass the package on unchanged with its licence (domain-browser, which Bun embeds)",
	"MPL-2.0": "keep the notice; say where the source of the covered files is",
	"LGPL-2.0-or-later": "keep the notice; say where the library's source is; let the user relink it",
	"LGPL-2.1-or-later": "keep the notice; say where the library's source is; let the user relink it",
	"LGPL-2.1-or-later WITH LicenseRef-glibc-startup-linking-exception": "nothing: the exception covers linking",
	"GPL-3.0-or-later WITH GCC-exception-3.1": "nothing: the runtime library exception covers a compiled program",
	"GPL-2.0-or-later WITH LicenseRef-TCC-unlimited-linking":
		"keep the notice: TinyCC's runtime source, which Bun embeds, under its linking exception",
	NOASSERTION: "keep Bun's notice: a port in Bun's source whose upstream licence the audit could not pin",
};

/** A component that is not an npm package, as `licences/` records it. */
export const Component = z.object({
	name: z.string(),
	version: z.string(),
	/** The licence as the component declares it, an SPDX expression. */
	licence: z.string(),
	/** The licence this file complies with when the component offers a choice. */
	relyOn: z.array(z.string()).min(1),
	source: z.url(),
	/** Paths under `licences/`, each a licence file exactly as the component publishes it. */
	texts: z.array(z.string()),
	note: z.string().optional(),
});
export type Component = z.infer<typeof Component>;

export const Group = z.object({
	title: z.string(),
	/** What ships this group, in a sentence. */
	ships: z.string(),
	components: z.array(Component),
});
export const Vendored = z.object({
	groups: z.array(Group),
	/** The Bun release whose libraries are in `licences/bun-<version>/`, the one the executable is built with. */
	bun: z.string(),
});

export type Package = { name: string; version: string; licence: string; dir: string; texts: string[] };

const LICENCE_FILE = /^(licen[cs]e|copying|notice)([.-].*)?$/i;

/** The npm packages the build bundles, each once, from the files the bundler read. */
export async function bundledPackages(): Promise<Package[]> {
	const built = await Bun.build({
		entrypoints: ENTRYPOINTS.map((path) => join(ROOT, path)),
		target: "bun",
		metafile: true,
		throw: true,
	});
	const inputs = Object.keys(built.metafile?.inputs ?? {});
	if (inputs.length === 0) throw new Error("the bundler reported no inputs: the list of packages would be empty");
	const dirs = new Set<string>();
	for (const input of inputs) {
		const at = input.lastIndexOf("node_modules/");
		if (at < 0) continue;
		const [scope, name] = input.slice(at + "node_modules/".length).split("/");
		dirs.add(input.slice(0, at + "node_modules/".length) + (scope?.startsWith("@") ? `${scope}/${name}` : scope));
	}
	const packages = [...dirs].map((relative): Package => {
		const dir = join(ROOT, relative);
		const manifest = z
			.object({ name: z.string(), version: z.string(), license: z.string() })
			.parse(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")));
		let texts = readdirSync(dir)
			.filter((file) => LICENCE_FILE.test(file))
			.sort();
		const saved = join(VENDORED, "npm", `${manifest.name}@${manifest.version}`);
		const textDir = texts.length === 0 && existsSync(saved) ? saved : dir;
		if (textDir !== dir)
			texts = readdirSync(textDir)
				.filter((file) => LICENCE_FILE.test(file))
				.sort();
		if (texts.length === 0) throw new Error(`${manifest.name} ships no licence file: find its text before shipping it`);
		return { name: manifest.name, version: manifest.version, licence: manifest.license, dir: textDir, texts };
	});
	return packages.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(join(VENDORED, path), "utf8"));

/** What `licences/` holds: its own groups, then those of the Bun release it names. */
export function readVendored(): z.infer<typeof Vendored> {
	const own = Vendored.parse(readJson("components.json"));
	const bun = z.object({ groups: z.array(Group) }).parse(readJson(`bun-${own.bun}/components.json`));
	return { bun: own.bun, groups: [...own.groups, ...bun.groups] };
}

/** A fence longer than any run of backticks in the text, so a licence that quotes code cannot close it. */
function fenced(text: string): string {
	const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
	const fence = "`".repeat(longest + 1);
	return `${fence}text\n${text.replace(/\s+$/, "")}\n${fence}`;
}

/** Writes each text once; a component whose text is byte for byte an earlier one's points at it. */
function texts(): (heading: string, files: { name: string; text: string }[]) => string[] {
	const seen = new Map<string, string>();
	return (heading, files) =>
		files.map(({ name, text }) => {
			const earlier = seen.get(text);
			if (earlier) return `\`${name}\`: the same text as ${earlier}.`;
			seen.set(text, `\`${name}\` of ${heading}`);
			return `\`${name}\`:\n\n${fenced(text)}`;
		});
}

const cell = (text: string): string => text.replaceAll("|", "\\|");

export async function notices(): Promise<string> {
	const packages = await bundledPackages();
	const vendored = readVendored();
	const write = texts();
	const out: string[] = [
		"# Third-party notices",
		"",
		"Mainworthy is licensed under the Apache License 2.0 ([LICENSE](LICENSE)); its copyright notice is in",
		"[NOTICE](NOTICE). It contains software that others wrote, under their own licences, and those licences ask",
		"that their text travels with it. This file is that text, for everything Mainworthy ships. The iPhone app",
		"contains none of it: only its own code and Apple's frameworks.",
		"",
		"`bun scripts/licences.ts` writes this file from the packages the build bundles and from `licences/`. Do not",
		"edit it by hand.",
		"",
		"## npm packages",
		"",
		"Bundled into the executable. The web UI a browser loads is built from some of them.",
		"",
		"| Package | Version | Licence |",
		"| --- | --- | --- |",
		...packages.map((p) => `| ${cell(p.name)} | ${p.version} | ${cell(p.licence)} |`),
		"",
	];
	for (const p of packages) {
		const heading = `${p.name} ${p.version}`;
		out.push(`### ${heading}`, "", `${p.licence}. <https://www.npmjs.com/package/${p.name}/v/${p.version}>`, "");
		const files = p.texts.map((name) => ({ name, text: readFileSync(join(p.dir, name), "utf8") }));
		for (const block of write(heading, files)) out.push(block, "");
	}
	for (const group of vendored.groups) {
		out.push(
			`## ${group.title}`,
			"",
			group.ships,
			"",
			"| Component | Version | Licence |",
			"| --- | --- | --- |",
			...group.components.map((c) => `| ${cell(c.name)} | ${cell(c.version)} | ${cell(c.licence)} |`),
			"",
		);
		for (const c of group.components) {
			const heading = `${c.name} ${c.version}`;
			out.push(`### ${heading}`, "", `${c.licence}. <${c.source}>`, "");
			if (c.note) out.push(c.note, "");
			const files = c.texts.map((path) => ({
				name: path.split("/").at(-1) ?? path,
				text: readFileSync(join(VENDORED, path), "utf8"),
			}));
			for (const block of write(heading, files)) out.push(block, "");
		}
	}
	return `${out.join("\n").replace(/\n+$/, "")}\n`;
}

/** Every licence a shipped component relies on that `LICENCES` does not name, as `name: licence`. */
export async function unapproved(): Promise<string[]> {
	const packages = await bundledPackages();
	const found = [
		...packages.map((p) => ({ name: p.name, relyOn: [p.licence] })),
		...readVendored().groups.flatMap((g) => g.components),
	];
	return found.flatMap((c) => c.relyOn.filter((id) => !(id in LICENCES)).map((id) => `${c.name}: ${id}`));
}

/** Every path a component names under `licences/` that is not there. */
export const missingTexts = (): string[] =>
	readVendored()
		.groups.flatMap((g) => g.components.flatMap((c) => c.texts))
		.filter((path) => !existsSync(join(VENDORED, path)));

/**
 * What to tell whoever builds the executable with a Bun other than the one `licences/` lists, or null. The
 * executable carries the Bun that built it, so its notices would describe another runtime. It is said and not
 * refused: a person who builds from the source for themselves gives no copy away (the image is pinned and tested).
 */
export function bunMismatch(version: string = Bun.version): string | null {
	const audited = readVendored().bun;
	if (version === audited) return null;
	return `licences: this is Bun ${version}, and THIRD-PARTY-NOTICES.md lists the libraries of Bun ${audited}. The executable carries this Bun, so before you give a copy to anyone, build it with Bun ${audited} (licences/README.md).`;
}

if (import.meta.main && process.argv.includes("--check-bun")) {
	const why = bunMismatch();
	if (why) console.warn(why);
} else if (import.meta.main) {
	const text = await notices();
	if (text !== (existsSync(NOTICES) ? readFileSync(NOTICES, "utf8") : "")) {
		await Bun.write(NOTICES, text);
		console.info("wrote THIRD-PARTY-NOTICES.md");
	}
}
