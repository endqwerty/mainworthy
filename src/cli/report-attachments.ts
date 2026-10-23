import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { ATTACHMENT_LIMITS, AttachmentInput, attachmentBytes } from "../core/attachments.ts";
import type { ResultIn } from "../core/ops.ts";
import { type ParsedReport, reportIdentifier } from "../surfaces/formats/native.ts";

export type AttachmentBudget = { bytes: number; files: number };
/** Optional evidence must not prevent the report's results from being uploaded. */
export function loadReportAttachments(
	parsed: ParsedReport,
	reportFile: string,
	root: string | undefined,
	budget: AttachmentBudget,
): { results: ResultIn[]; skipped: number; warnings: string[] } {
	let permitted: string | null = null;
	if (root !== undefined) {
		try {
			const canonical = realpathSync(root);
			if (statSync(canonical).isDirectory()) permitted = canonical;
		} catch {
			// Each named file below reports the unavailable directory without discarding results.
		}
	}
	let skipped = 0;
	const warnings: string[] = [];
	const skip = (path: string, reason: string) => {
		skipped++;
		warnings.push(`${reportIdentifier(reportFile)}: skipped attachment ${reportIdentifier(path)}: ${reason}`);
	};
	const results = parsed.results.map(({ attachmentPaths, attachments: inline, ...result }) => {
		const attachments: AttachmentInput[] = [];
		const accept = (file: AttachmentInput) => {
			const size = attachmentBytes(file.data);
			if (attachments.length >= ATTACHMENT_LIMITS.perResult) throw new Error("exceeds 20 files per result");
			if (budget.files >= ATTACHMENT_LIMITS.perReport) throw new Error("exceeds 100 files per report");
			if (budget.bytes + size > ATTACHMENT_LIMITS.report) throw new Error("exceeds 16 MiB per report");
			attachments.push(file);
			budget.bytes += size;
			budget.files++;
		};
		for (const file of inline ?? []) {
			try {
				accept(AttachmentInput.parse(file));
			} catch {
				skip(file.name, "invalid attachment or attachment limit exceeded");
			}
		}
		for (const path of attachmentPaths ?? []) {
			if (root === undefined) {
				skipped++;
				continue;
			}
			try {
				if (permitted === null) throw new Error(`attachment directory is unavailable: ${reportIdentifier(root)}`);
				const boundary = permitted;
				const candidates = isAbsolute(path) ? [path] : [resolve(permitted, path), resolve(dirname(reportFile), path)];
				let found: { path: string; name: string } | null = null;
				const allowed = (candidate: string) => {
					const part = relative(boundary, candidate);
					return !isAbsolute(part) && !part.split(/[\\/]/).some((entry) => entry.startsWith("."));
				};
				for (const candidate of candidates) {
					if (!allowed(candidate)) continue;
					try {
						const canonical = realpathSync(candidate);
						if (allowed(canonical)) {
							found = { path: canonical, name: basename(candidate) };
							break;
						}
					} catch {
						// Try paths relative to the XML file when the root-relative path is missing.
					}
				}
				if (found === null) throw new Error("missing, hidden, or outside the permitted directory");
				const name = AttachmentInput.shape.name.safeParse(found.name);
				if (!name.success) throw new Error("invalid file name (at most 200 characters, no paths or controls)");
				const fd = openSync(found.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
				try {
					const stat = fstatSync(fd);
					if (!stat.isFile()) throw new Error("must be a regular file");
					if (stat.size > ATTACHMENT_LIMITS.file) throw new Error("exceeds 4 MiB");
					const buffer = Buffer.alloc(stat.size + 1);
					let size = 0;
					while (size < buffer.length) {
						const read = readSync(fd, buffer, size, buffer.length - size, null);
						if (read === 0) break;
						size += read;
					}
					if (size !== stat.size) throw new Error("file changed while reading");
					accept(AttachmentInput.parse({ name: name.data, data: buffer.subarray(0, size).toString("base64") }));
				} finally {
					closeSync(fd);
				}
			} catch (error) {
				skip(path, error instanceof Error ? reportIdentifier(error.message) : "could not read file");
			}
		}
		return { ...result, ...(attachments.length ? { attachments } : {}) };
	});
	return { results, skipped, warnings };
}
