import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { z } from "zod";

export type SourceFile = { file: string; text: string };
export const date = z.iso.date();
export const references = {
	issue: z
		.string()
		.regex(/^https:\/\/github\.com\/endqwerty\/mainworthy\/issues\/[1-9]\d*$/)
		.optional(),
	pr: z
		.union([z.literal("pending"), z.string().regex(/^https:\/\/github\.com\/endqwerty\/mainworthy\/pull\/[1-9]\d*$/)])
		.optional(),
};
export const hasReference = (value: { issue?: string | undefined; pr?: string | undefined }): boolean =>
	!!(value.issue || value.pr);

/** This small metadata format accepts one plain scalar per line, with no duplicate keys. */
export function metadata(lines: string): Record<string, string> {
	const values: Record<string, string> = {};
	for (const line of lines.split("\n")) {
		const match = /^([a-z]+): (\S.*)$/.exec(line);
		const key = match?.[1];
		const value = match?.[2];
		if (!key || !value || Object.hasOwn(values, key)) throw new Error(`malformed or duplicate metadata: ${line}`);
		values[key] = value.trim();
	}
	return values;
}

/** Check rendered links, including reference-style links, against the repository without network access. */
export function checkLinks(file: string, text: string): void {
	const html = Bun.markdown.html(text, { headings: { ids: true } });
	const links = [...html.matchAll(/(?:href|src)="([^"]*)"/g)].map((match) => match[1] ?? "");
	for (const match of text.matchAll(/\[[^\]\n]+\]\[([^\]\n]*)\]/g)) {
		const label = match[1] || match[0].slice(1).split("]")[0] || "";
		if (!new RegExp(`^ {0,3}\\[${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]:`, "im").test(text))
			throw new Error(`${file}: undefined link reference ${label}`);
	}
	for (const encoded of links) {
		const link = encoded.replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&#39;", "'");
		if (link.startsWith("https://")) {
			const url = new URL(link);
			if (!url.hostname || url.username || url.password) throw new Error(`${file}: bad link ${link}`);
			continue;
		}
		if (!link || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(link)) throw new Error(`${file}: bad link ${link}`);
		const [path = "", anchor] = link.split("#");
		const target = path ? resolve(dirname(file), decodeURIComponent(path)) : resolve(file);
		if (relative(process.cwd(), target).startsWith(".."))
			throw new Error(`${file}: link leaves the repository ${link}`);
		if (!existsSync(target)) throw new Error(`${file}: missing file for link ${link}`);
		if (anchor !== undefined && (target.endsWith(".md") || !path)) {
			const targetHtml = Bun.markdown.html(readFileSync(target, "utf8"), { headings: { ids: true } });
			if (!targetHtml.includes(`id="${decodeURIComponent(anchor)}"`))
				throw new Error(`${file}: missing heading ${link}`);
		}
	}
}
