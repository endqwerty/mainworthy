import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Attachment } from "../../core/attachments.ts";

export const blobHash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export type BlobStore = {
	put: (bytes: Uint8Array) => string;
	get: (hash: string) => Uint8Array | null;
	prune: (keep: ReadonlySet<string>) => void;
};
const validHash = (hash: string) => /^[a-f0-9]{64}$/.test(hash);
export function diskBlobs(dataDir: string): BlobStore {
	const directory = join(dataDir, "blobs");
	return {
		put(bytes) {
			const hash = blobHash(bytes);
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			const path = join(directory, hash);
			if (existsSync(path) && blobHash(readFileSync(path)) === hash) return hash;
			const temporary = join(directory, `.pending-${randomUUID()}`);
			try {
				writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
				renameSync(temporary, path);
			} finally {
				rmSync(temporary, { force: true });
			}
			return hash;
		},
		get(hash) {
			if (!validHash(hash)) return null;
			try {
				const bytes = readFileSync(join(directory, hash));
				return blobHash(bytes) === hash ? bytes : null;
			} catch (error) {
				if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
				throw error;
			}
		},
		prune(keep) {
			if (!existsSync(directory)) return;
			for (const name of readdirSync(directory))
				if ((validHash(name) && !keep.has(name)) || name.startsWith(".pending-"))
					rmSync(join(directory, name), { force: true });
		},
	};
}
export function memoryBlobs(): BlobStore {
	const values = new Map<string, Uint8Array>();
	return {
		put(bytes) {
			const hash = blobHash(bytes);
			values.set(hash, bytes.slice());
			return hash;
		},
		get(hash) {
			return values.get(hash)?.slice() ?? null;
		},
		prune(keep) {
			for (const hash of values.keys()) if (!keep.has(hash)) values.delete(hash);
		},
	};
}
/** Only raster formats get an inline image type; HTML, SVG and every other file download as bytes. */
export function attachmentType(bytes: Uint8Array): Attachment["type"] {
	const starts = (...signature: number[]) => signature.every((value, index) => bytes[index] === value);
	if (starts(137, 80, 78, 71, 13, 10, 26, 10)) return "image/png";
	if (starts(255, 216, 255)) return "image/jpeg";
	const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
	if (["GIF87a", "GIF89a"].includes(ascii(0, 6))) return "image/gif";
	if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
	return "application/octet-stream";
}
