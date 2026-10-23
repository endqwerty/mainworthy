// Authors add independent .changes/*.md files. Only the coordinator writes the aggregate.
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { z } from "zod";
import { checkLinks, date, hasReference, metadata, references, type SourceFile } from "./record-files.ts";

const schema = z
	.strictObject({
		id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
		category: z.enum(["Fixed", "Changed", "Breaks", "Security", "Added"]),
		date,
		...references,
	})
	.refine(hasReference, "an issue or PR reference is required");
type Fragment = z.infer<typeof schema> & { text: string };
const START = "<!-- changes:start -->";
const END = "<!-- changes:end -->";
const TITLE = "# Changelog\n\n";
const RESTORE =
	"Do not hand-edit CHANGELOG.md; restore CHANGELOG.md from main and add a .changes/ fragment for the entry.";

export function fragments(sources?: readonly SourceFile[]): Fragment[] {
	let files = sources;
	if (files === undefined) {
		const directory = readdirSync(".changes", { withFileTypes: true });
		const invalid = directory.filter((entry) => !entry.isFile() || !entry.name.endsWith(".md"));
		if (invalid.length)
			throw new Error(
				`.changes/ accepts only .md fragment files: ${invalid
					.map((entry) => entry.name)
					.sort()
					.join(", ")}`,
			);
		files = directory.map((entry) => ({ file: entry.name, text: readFileSync(join(".changes", entry.name), "utf8") }));
	}
	const ids = new Set<string>();
	return files
		.map(({ file, text }) => {
			if (text.includes("\r")) throw new Error(`${file}: CRLF line endings are not supported; use LF`);
			const match = /^---\n([\s\S]+?)\n---\n+([\s\S]*)$/.exec(text);
			if (!match) throw new Error(`${file}: expected metadata between --- lines and an entry`);
			const parsed = schema.parse(metadata(match[1] ?? ""));
			if (!new RegExp(`^${parsed.id}-[a-z0-9]+(?:-[a-z0-9]+)*\\.md$`).test(file))
				throw new Error(`${file}: filename must be ${parsed.id}-<slug>.md`);
			if (ids.has(parsed.id)) throw new Error(`${file}: duplicate fragment id ${parsed.id}`);
			ids.add(parsed.id);
			const body = (match[2] ?? "").trim();
			if (/^ {0,3}\[(?:\\.|[^\]\\])+\]:/m.test(body))
				throw new Error(`${file}: reference definitions are not supported; use inline links`);
			const html = Bun.markdown.html(body);
			if (/<h[1-6](?:\s|>)/.test(html)) throw new Error(`${file}: headings are not supported in an entry`);
			if (!/^<p>(?:(?!<\/p>)[\s\S])*<\/p>\n?$/.test(html) || /<!--\s*(?:change:|changes:)/.test(body))
				throw new Error(`${file}: expected one paragraph without assembly markers`);
			checkLinks(join(".changes", file), body);
			return { ...parsed, text: body };
		})
		.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
}

function rootLinks(text: string): string {
	return text.replace(
		/\\.|(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)|(\]\(\s*<?)([^\s)>]+)/g,
		(all, code: string | undefined, prefix: string | undefined, target: string | undefined) => {
			if (code || prefix === undefined || target === undefined || /^[a-z][a-z\d+.-]*:/i.test(target)) return all;
			const [path = "", anchor] = target.split("#");
			const rootPath = relative(process.cwd(), resolve(".changes", decodeURIComponent(path)));
			return `${prefix}${encodeURI(rootPath)}${anchor === undefined ? "" : `#${anchor}`}`;
		},
	);
}

function generatedLine(entry: Fragment): string {
	const refs = [
		entry.issue && `[issue](${entry.issue})`,
		entry.pr && entry.pr !== "pending" && `[PR](${entry.pr})`,
	].filter(Boolean);
	const text = rootLinks(entry.text).replace(/\n/g, " ");
	return `- ${entry.date}: **${entry.category}:** ${text}${refs.length ? ` (${refs.join(", ")})` : ""} <!-- change:${entry.id} -->`;
}

function changelogParts(changelog: string): { history: string; lines: string[] } {
	if (!changelog.startsWith(TITLE))
		throw new Error(`CHANGELOG.md must start with # Changelog and a blank line. ${RESTORE}`);
	let history = changelog.slice(TITLE.length);
	let lines: string[] = [];
	if (history.startsWith(`${START}\n`)) {
		const end = history.indexOf(`${END}\n\n`);
		if (end < 0) throw new Error(`CHANGELOG.md has an unfinished changes section. ${RESTORE}`);
		const section = history.slice(START.length + 1, end).replace(/\n$/, "");
		lines = section ? section.split("\n") : [];
		history = history.slice(end + END.length + 2);
	}
	if (history.includes(START) || history.includes(END))
		throw new Error(`CHANGELOG.md has misplaced changes markers. ${RESTORE}`);
	return { history: `${TITLE}${history}`, lines };
}

/** Regenerate the owned section, preserving the exact outside text and checking its base when supplied. */
export function assemble(changelog: string, entries: readonly Fragment[], options: { base?: string } = {}): string {
	const current = changelogParts(changelog);
	const base = options.base === undefined ? null : changelogParts(options.base);
	if (base !== null && current.history !== base.history)
		throw new Error(`CHANGELOG.md history differs from its base. ${RESTORE}`);
	const lines = new Map(
		[...entries]
			.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id))
			.map((entry) => [entry.id, generatedLine(entry)]),
	);
	const seen = new Set<string>();
	for (const line of current.lines) {
		const markers = [...line.matchAll(/<!-- change:([a-z0-9-]+) -->/g)];
		const id = markers[0]?.[1];
		if (markers.length !== 1 || id === undefined || !lines.has(id) || seen.has(id))
			throw new Error(`CHANGELOG.md contains an unowned generated line. ${RESTORE}`);
		if (line !== lines.get(id))
			throw new Error(`CHANGELOG.md entry ${id} differs from its canonical fragment. ${RESTORE}`);
		seen.add(id);
	}
	if (base !== null) {
		const retained = new Set(current.lines);
		if (base.lines.some((line) => !retained.has(line)))
			throw new Error(`CHANGELOG.md removes a previously assembled entry. ${RESTORE}`);
	}
	if (entries.length === 0) return current.history;
	return `${TITLE}${START}\n${[...lines.values()].join("\n")}\n${END}\n\n${current.history.slice(TITLE.length)}`;
}

function baseChangelog(revision: string): string {
	const run = Bun.spawnSync(["git", "show", "--end-of-options", `${revision}:CHANGELOG.md`], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (run.exitCode !== 0)
		throw new Error(`Cannot read CHANGELOG.md from base ${revision}: ${run.stderr.toString().trim()}`);
	return run.stdout.toString();
}

if (import.meta.main) {
	try {
		const args = process.argv.slice(2);
		const bases = args.filter((arg) => arg.startsWith("--base="));
		const modes = args.filter((arg) => !arg.startsWith("--base="));
		if (
			bases.length > 1 ||
			bases[0] === "--base=" ||
			!["", "--check", "--write", "--check --complete", "--complete --check"].includes(modes.join(" "))
		)
			throw new Error("usage: bun scripts/changelog.ts [--check [--complete] | --write] [--base=<revision>]");
		const entries = fragments();
		const changelog = readFileSync("CHANGELOG.md", "utf8");
		const revision = bases[0]?.slice("--base=".length);
		const output = assemble(changelog, entries, revision === undefined ? {} : { base: baseChangelog(revision) });
		if (args.includes("--complete") && output !== changelog)
			throw new Error(
				"CHANGELOG.md is not fully assembled; the coordinator should re-run bun scripts/changelog.ts --write --base=origin/main on an up-to-date branch.",
			);
		if (args.includes("--write")) {
			const temporary = `.changelog-${randomUUID()}.tmp`;
			try {
				writeFileSync(temporary, output, { flag: "wx" });
				renameSync(temporary, "CHANGELOG.md");
			} finally {
				rmSync(temporary, { force: true });
			}
			console.log(`Assembled ${entries.length} changelog fragments.`);
		} else if (args.includes("--check")) {
			const section = changelog.startsWith(`${TITLE}${START}\n`)
				? changelog.slice(TITLE.length + START.length + 1, changelog.indexOf(END))
				: "";
			const assembled = new Set([...section.matchAll(/<!-- change:([a-z0-9-]+) -->/g)].map((match) => match[1]));
			const pending = entries.filter((entry) => !assembled.has(entry.id)).length;
			console.log(
				`Validated ${entries.length} changelog fragments. ${pending} fragment${pending === 1 ? "" : "s"} not yet assembled.`,
			);
		} else process.stdout.write(output);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
