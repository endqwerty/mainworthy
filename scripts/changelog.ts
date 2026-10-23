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

/** Replace only our generated section. Everything below it remains byte for byte historical. */
export function assemble(changelog: string, entries: readonly Fragment[]): string {
	if (!changelog.startsWith(TITLE)) throw new Error("CHANGELOG.md must start with # Changelog and a blank line");
	let history = changelog.slice(TITLE.length);
	if (history.startsWith(`${START}\n`)) {
		const end = history.indexOf(`${END}\n\n`);
		if (end < 0) throw new Error("CHANGELOG.md has an unfinished changes section");
		const section = history.slice(START.length + 1, end).replace(/\n$/, "");
		const ids = new Set(entries.map((entry) => entry.id));
		const seen = new Set<string>();
		for (const line of section ? section.split("\n") : []) {
			const markers = [...line.matchAll(/<!-- change:([a-z0-9-]+) -->/g)];
			const id = markers[0]?.[1];
			if (markers.length !== 1 || id === undefined || !ids.has(id) || seen.has(id))
				throw new Error(
					"CHANGELOG.md contains an unowned generated line; move the entry into a .changes/ fragment before assembling",
				);
			seen.add(id);
		}
		history = history.slice(end + END.length + 2);
	}
	if (history.includes(START) || history.includes(END)) throw new Error("CHANGELOG.md has misplaced changes markers");
	if (entries.length === 0) return `${TITLE}${history}`;
	const lines = [...entries]
		.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id))
		.map((entry) => {
			const refs = [
				entry.issue && `[issue](${entry.issue})`,
				entry.pr && entry.pr !== "pending" && `[PR](${entry.pr})`,
			].filter(Boolean);
			const text = rootLinks(entry.text).replace(/\n/g, " ");
			return `- ${entry.date}: **${entry.category}:** ${text}${refs.length ? ` (${refs.join(", ")})` : ""} <!-- change:${entry.id} -->`;
		});
	return `${TITLE}${START}\n${lines.join("\n")}\n${END}\n\n${history}`;
}

if (import.meta.main) {
	try {
		const args = process.argv.slice(2);
		if (args.length > 1 || (args.length === 1 && !["--check", "--write"].includes(args[0] ?? "")))
			throw new Error("usage: bun scripts/changelog.ts [--check | --write]");
		const entries = fragments();
		const changelog = readFileSync("CHANGELOG.md", "utf8");
		const output = assemble(changelog, entries);
		if (args[0] === "--write") {
			const temporary = `.changelog-${randomUUID()}.tmp`;
			try {
				writeFileSync(temporary, output, { flag: "wx" });
				renameSync(temporary, "CHANGELOG.md");
			} finally {
				rmSync(temporary, { force: true });
			}
			console.log(`Assembled ${entries.length} changelog fragments.`);
		} else if (args[0] === "--check") {
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
