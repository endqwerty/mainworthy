// Authors add independent .changes/*.md files. Only the release owner writes the aggregate.
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
	const files =
		sources ??
		readdirSync(".changes")
			.filter((file) => file.endsWith(".md"))
			.map((file) => ({
				file,
				text: readFileSync(join(".changes", file), "utf8"),
			}));
	const ids = new Set<string>();
	return files
		.map(({ file, text }) => {
			const match = /^---\n([\s\S]+?)\n---\n+([\s\S]*)$/.exec(text);
			if (!match) throw new Error(`${file}: expected metadata between --- lines and an entry`);
			const parsed = schema.parse(metadata(match[1] ?? ""));
			if (!new RegExp(`^${parsed.id}-[a-z0-9]+(?:-[a-z0-9]+)*\\.md$`).test(file))
				throw new Error(`${file}: filename must be ${parsed.id}-<slug>.md`);
			if (ids.has(parsed.id)) throw new Error(`${file}: duplicate fragment id ${parsed.id}`);
			ids.add(parsed.id);
			const body = (match[2] ?? "").trim();
			if (!body || /<!--\s*(?:change:|changes:)|^#/m.test(body))
				throw new Error(`${file}: expected entry text without headings or assembly markers`);
			checkLinks(join(".changes", file), body);
			return { ...parsed, text: body };
		})
		.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
}

function rootLinks(text: string): string {
	return text.replace(/(\]\(\s*<?|^ {0,3}\[[^\]]+\]:\s*<?)([^\s)>]+)/gm, (_all, prefix: string, target: string) => {
		if (/^[a-z][a-z\d+.-]*:/i.test(target)) return `${prefix}${target}`;
		const [path = "", anchor] = target.split("#");
		const rootPath = relative(process.cwd(), resolve(".changes", decodeURIComponent(path)));
		return `${prefix}${encodeURI(rootPath)}${anchor === undefined ? "" : `#${anchor}`}`;
	});
}

/** Replace only our generated section. Everything below it remains byte for byte historical. */
export function assemble(changelog: string, entries: readonly Fragment[]): string {
	if (!changelog.startsWith(TITLE)) throw new Error("CHANGELOG.md must start with # Changelog and a blank line");
	let history = changelog.slice(TITLE.length);
	if (history.startsWith(`${START}\n`)) {
		const end = history.indexOf(`${END}\n\n`);
		if (end < 0) throw new Error("CHANGELOG.md has an unfinished changes section");
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
			const [first = "", ...rest] = rootLinks(entry.text).split("\n");
			const tail = rest.length ? `\n${rest.map((line) => `  ${line}`).join("\n")}` : "";
			return `- ${entry.date}: **${entry.category}:** ${first}${refs.length ? ` (${refs.join(", ")})` : ""} <!-- change:${entry.id} -->${tail}`;
		});
	return `${TITLE}${START}\n${lines.join("\n")}\n${END}\n\n${history}`;
}

if (import.meta.main) {
	try {
		const args = process.argv.slice(2);
		if (args.length > 1 || (args.length === 1 && !["--check", "--write"].includes(args[0] ?? "")))
			throw new Error("usage: bun scripts/changelog.ts [--check | --write]");
		const entries = fragments();
		const output = assemble(readFileSync("CHANGELOG.md", "utf8"), entries);
		if (args[0] === "--write") {
			const temporary = join(".changes", `.changelog-${randomUUID()}.tmp`);
			try {
				writeFileSync(temporary, output, { flag: "wx" });
				renameSync(temporary, "CHANGELOG.md");
			} finally {
				rmSync(temporary, { force: true });
			}
			console.log(`Assembled ${entries.length} changelog fragments.`);
		} else if (args[0] === "--check") console.log(`Validated ${entries.length} changelog fragments.`);
		else process.stdout.write(output);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
