// Brings an audit of a Bun release into `licences/bun-<version>/`, where `scripts/licences.ts` reads it.
//
//   bun scripts/licences-import-bun.ts <audit directory> <bun version>
//
// The audit is research, not a build step: which libraries, crates, ports and packages a Bun release links into
// its Linux binary, each with its licence files exactly as its project publishes them at the pinned revision
// (`licences/README.md` says how one is made). It is a directory with `manifest.json` and the files under
// `texts/`. This keeps what the notices need from it: every component that is or may be linked, with its licence
// files. A component that publishes no licence file keeps its licence where it states one: the comment at the
// head of a source file, or the licence section of its README, copied line for line. A text that is the same as
// one already kept is not kept twice; the component points at the first.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Component } from "./licences.ts";

const Audited = z.object({
	name: z.string(),
	kind: z.enum(["c-library", "webkit", "derived", "toolchain", "vendored", "polyfill", "rust-crate"]),
	version: z.string().nullable(),
	commit: z.string().nullable(),
	source: z.string(),
	license: z.string(),
	relyOn: z.string(),
	linked: z.enum(["yes", "no", "uncertain"]),
	why: z.string(),
	texts: z.array(z.string()),
});
type Audited = z.infer<typeof Audited>;

/** The groups of the notices, in the order they are printed, with what each holds. */
const GROUPS: { kind: Audited["kind"]; title: string; ships: string }[] = [
	{
		kind: "vendored",
		title: "Bun, and code it carries in its own source",
		ships: "The Bun runtime itself, and libraries Bun keeps in its own repository.",
	},
	{
		kind: "c-library",
		title: "Libraries Bun builds and links",
		ships: "C and C++ libraries Bun builds from a pinned revision and links into its binary.",
	},
	{
		kind: "webkit",
		title: "WebKit, JavaScriptCore and ICU",
		ships: "The JavaScript engine and the Unicode library, from Bun's fork of WebKit, linked statically.",
	},
	{
		kind: "rust-crate",
		title: "Rust crates",
		ships: "Crates in Bun's runtime that are linked on Linux (x86-64 and arm64), from its Cargo.lock.",
	},
	{
		kind: "derived",
		title: "Code ported or copied into Bun",
		ships: "Code in Bun's source that came from another project, under that project's licence.",
	},
	{
		kind: "polyfill",
		title: "Packages Bun embeds for its Node.js fallbacks",
		ships: "npm packages inside the binary, which Bun's bundler uses when browser code imports a Node.js module.",
	},
	{
		kind: "toolchain",
		title: "Runtime libraries of the compilers",
		ships: "Parts of the C++ and Rust runtimes that the compilers link into Bun's binary.",
	},
];

const STATES_LICENCE = /copyright|licen[cs]e|permission is hereby|public domain|blessing/i;

const LICENCE_NAME = /(^|\/)(licen[cs]es?|copying|notice|copyright|unlicense|readme\.ijg|ofl)([^/]*$|\/)/i;
/**
 * A licence file by its name or folder, or a plain text whose first page speaks of a licence: one fetched on its
 * own, such as the canonical MPL text for a crate that ships none.
 */
const isLicenceFile = (auditDir: string, path: string): boolean => {
	const file = path.split("/").at(-1) ?? "";
	if (LICENCE_NAME.test(path)) return true;
	if (!/^[^.]+$|\.txt$/i.test(file) || /readme/i.test(file)) return false;
	return STATES_LICENCE.test(readFileSync(join(auditDir, "texts", path), "utf8").slice(0, 3000));
};

/** The first comment of a source file that states a copyright or licence, line for line. */
export function headerComment(source: string): string | null {
	const block = /\/\*[\s\S]*?\*\//g;
	const lines = /(?:^[ \t]*(?:\/\/|#)[^\n]*\n)+/gm;
	const found = [...source.matchAll(block), ...source.matchAll(lines)]
		.filter((match) => STATES_LICENCE.test(match[0]))
		.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
	return found[0]?.[0].trim() ?? null;
}

/** The section of a README under a heading that names the licence, line for line. */
export function readmeLicence(readme: string): string | null {
	const lines = readme.split("\n");
	const start = lines.findIndex((line) => /^#{1,6}\s.*licen[cs]e/i.test(line));
	if (start < 0) return null;
	const level = /^#+/.exec(lines[start] ?? "")?.[0].length ?? 1;
	const end = lines.findIndex((line, i) => i > start && new RegExp(`^#{1,${level}}\\s`).test(line));
	return lines
		.slice(start, end < 0 ? undefined : end)
		.join("\n")
		.trim();
}

const normal = (text: string): string => text.replace(/\s+/g, " ").trim();

function run(auditDir: string, version: string): void {
	const root = new URL("../licences/", import.meta.url).pathname;
	const out = join(root, `bun-${version}`);
	rmSync(out, { recursive: true, force: true });
	const audited = z.array(Audited).parse(JSON.parse(readFileSync(join(auditDir, "manifest.json"), "utf8")));
	const kept = new Map<string, string>();
	/** Keeps a text once, under the path it had in the audit; returns that path relative to `licences/`. */
	const keep = (path: string, text: string): string => {
		const earlier = kept.get(normal(text));
		if (earlier) return earlier;
		const relative = join(`bun-${version}`, "texts", path);
		mkdirSync(dirname(join(root, relative)), { recursive: true });
		writeFileSync(join(root, relative), text);
		kept.set(normal(text), relative);
		return relative;
	};
	const component = (c: Audited): Component => {
		const read = (path: string): string => readFileSync(join(auditDir, "texts", path), "utf8");
		// A licence is a few pages; a file of a megabyte is data that states its licence in its first lines.
		const whole = (path: string): boolean =>
			isLicenceFile(auditDir, path) && statSync(join(auditDir, "texts", path)).size < 200_000;
		let texts = c.texts.filter(whole).map((path) => keep(path, read(path)));
		if (texts.length === 0)
			texts = c.texts.flatMap((path) => {
				const excerpt = /readme/i.test(path) ? readmeLicence(read(path)) : headerComment(read(path));
				return excerpt ? [keep(`${path}.licence.txt`, `${excerpt}\n`)] : [];
			});
		texts = [...new Set(texts)];
		const unstated =
			c.kind === "polyfill"
				? "Bun's own file, which loads the package of the same name in this list. It states no licence of its own."
				: `Its source states no licence, and the audit could not establish the original's: ${c.why}`;
		const notes = [
			c.linked === "uncertain" ? `Possibly linked: ${c.why}` : null,
			texts.length === 0 ? unstated : null,
			c.relyOn !== c.license ? `Declared as ${c.license}; these notices comply with ${c.relyOn}.` : null,
		].filter((note) => note !== null);
		return {
			name: c.name,
			version: c.version ?? c.commit ?? "unversioned",
			licence: c.relyOn,
			relyOn: licenceIds(c.relyOn),
			source: c.source,
			texts,
			...(notes.length > 0 ? { note: notes.join(" ") } : {}),
		};
	};
	const shipped = audited.filter((c) => c.linked !== "no");
	const groups = GROUPS.map((group) => ({
		title: `Bun ${version}: ${group.title}`,
		ships: group.ships,
		components: shipped
			.filter((c) => c.kind === group.kind)
			.sort((a, b) => (a.name === "Bun" ? -1 : b.name === "Bun" ? 1 : a.name.localeCompare(b.name)))
			.map(component),
	}));
	writeFileSync(join(out, "components.json"), `${JSON.stringify({ groups }, null, "\t")}\n`);
	// The decision for every part the audit looked at, linked or not, so a review can question an exclusion.
	const cell = (text: string | null): string => (text ?? "").replace(/[\t\n]/g, " ");
	const decisions = [...audited]
		.sort((a, b) => a.linked.localeCompare(b.linked) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
		.map((c) => [c.linked, c.kind, c.name, c.version ?? c.commit, c.license, c.relyOn, c.why].map(cell).join("\t"));
	const head = ["linked", "kind", "name", "version", "declared", "relied on", "why"].join("\t");
	writeFileSync(join(out, "audit.tsv"), `${[head, ...decisions].join("\n")}\n`);
	console.info(`kept ${shipped.length} of ${audited.length} components and ${kept.size} texts in ${out}`);
}

/** The licences an SPDX expression relies on: `(MIT AND Zlib)` is MIT and Zlib; a `WITH` stays with its licence. */
export const licenceIds = (expression: string): string[] =>
	expression
		.replace(/[()]/g, " ")
		.split(/\s+AND\s+/)
		.map((id) => id.trim())
		.filter((id) => id !== "");

if (import.meta.main) {
	const [auditDir, version] = process.argv.slice(2);
	if (!auditDir || !version) {
		console.error("usage: bun scripts/licences-import-bun.ts <audit directory> <bun version>");
		process.exit(2);
	}
	run(auditDir, version);
}
