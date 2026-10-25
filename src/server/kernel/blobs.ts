import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Attachment } from "../../core/attachments.ts";

export const blobHash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export type BlobStore = {
	put: (bytes: Uint8Array) => Promise<string>;
	get: (hash: string) => Promise<Uint8Array | null>;
	remove: (hash: string) => Promise<void>;
	prunePending: (before: number) => Promise<void>;
};
const validHash = (hash: string) => /^[a-f0-9]{64}$/.test(hash);
const missing = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";
export function diskBlobs(dataDir: string): BlobStore {
	const directory = join(dataDir, "blobs");
	const get = async (hash: string): Promise<Uint8Array | null> => {
		if (!validHash(hash)) return null;
		try {
			const bytes = await readFile(join(directory, hash));
			return blobHash(bytes) === hash ? bytes : null;
		} catch (error) {
			if (missing(error)) return null;
			throw error;
		}
	};
	return {
		async put(bytes) {
			const hash = blobHash(bytes);
			await mkdir(directory, { recursive: true, mode: 0o700 });
			if (await get(hash)) return hash;
			const temporary = join(directory, `.pending-${randomUUID()}`);
			try {
				await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
				await rename(temporary, join(directory, hash));
			} finally {
				await rm(temporary, { force: true });
			}
			return hash;
		},
		get,
		async remove(hash) {
			if (validHash(hash)) await rm(join(directory, hash), { force: true });
		},
		async prunePending(before) {
			let names: string[];
			try {
				names = await readdir(directory);
			} catch (error) {
				if (missing(error)) return;
				throw error;
			}
			for (const name of names)
				if (name.startsWith(".pending-")) {
					const path = join(directory, name);
					try {
						if ((await stat(path)).mtimeMs < before) await rm(path, { force: true });
					} catch (error) {
						if (!missing(error)) throw error;
					}
				}
		},
	};
}
export function memoryBlobs(): BlobStore {
	const values = new Map<string, Uint8Array>();
	return {
		async put(bytes) {
			const hash = blobHash(bytes);
			values.set(hash, bytes.slice());
			return hash;
		},
		async get(hash) {
			return values.get(hash)?.slice() ?? null;
		},
		async remove(hash) {
			values.delete(hash);
		},
		async prunePending() {},
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
