// Generate the index instead of making every decision author edit a shared list.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { checkLinks, date, hasReference, metadata, references, type SourceFile } from "./record-files.ts";

const schema = z
	.strictObject({
		date,
		status: z.enum(["proposed", "accepted", "superseded", "rejected", "deprecated"]),
		...references,
	})
	.refine(hasReference, "an issue or PR reference is required");
type Decision = { file: string; id: string; title: string; date: string | null };

export function decisions(sources?: readonly SourceFile[]): Decision[] {
	const files =
		sources ??
		readdirSync("docs/decisions")
			.filter((file) => file.endsWith(".md"))
			.map((file) => ({
				file,
				text: readFileSync(join("docs/decisions", file), "utf8"),
			}));
	const ids = new Set<string>();
	return files
		.map(({ file, text }) => {
			const dated = /^(\d{4}-\d{2}-\d{2})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.exec(file);
			const numbered = /^(0\d{3})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.exec(file);
			if (numbered && (Number(numbered[1]) < 1 || Number(numbered[1]) > 155))
				throw new Error(`${file}: new decisions must use dated filenames; historical numbers end at 0155`);
			if (dated) date.parse(dated[1]);
			if (!dated && !numbered) throw new Error(`${file}: expected a dated or historical numbered decision filename`);
			const id = dated ? file.slice(0, -3) : (numbered?.[1] ?? "");
			if (ids.has(id)) throw new Error(`${file}: duplicate decision id ${id}`);
			ids.add(id);
			const heading = /^# ([^\n]+)\n?/.exec(text)?.[1]?.trim();
			if (!heading) throw new Error(`${file}: expected a title`);
			const headingNumber = /^(\d+)[.:] /.exec(heading)?.[1];
			let when: string | null;
			if (dated) {
				if (headingNumber) throw new Error(`${file}: a dated decision title has no number`);
				const header = text.split(/^## /m)[0] ?? "";
				const lines = [...header.matchAll(/^- (Date|Status|Issue|PR): (.*)$/gm)].map(
					(match) => `${match[1]?.toLowerCase()}: ${match[2]}`,
				);
				const parsed = schema.parse(metadata(lines.join("\n")));
				if (parsed.date !== dated[1]) throw new Error(`${file}: metadata date must match the filename`);
				when = parsed.date;
			} else {
				if (headingNumber && headingNumber !== id)
					throw new Error(`${file}: heading number ${headingNumber} differs from ${id}`);
				// Historical records have several metadata styles and some have no date or status. Preserve them.
				when = /\b20\d{2}-\d{2}-\d{2}\b/.exec(text.split(/^## /m)[0] ?? "")?.[0] ?? null;
				if (when) date.parse(when);
			}
			checkLinks(join("docs/decisions", file), text);
			return { file, id, title: heading.replace(/^\d+[.:] /, ""), date: when };
		})
		.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "") || a.id.localeCompare(b.id));
}

if (import.meta.main) {
	try {
		if (process.argv.length > 2) throw new Error("usage: bun scripts/decisions.ts");
		for (const record of decisions())
			console.log(`- ${record.date ?? "Undated"}: [${record.title}](docs/decisions/${record.file})`);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
