import { closeSync, openSync, readSync, writeSync } from "node:fs";
import { OpError } from "../kernel/errors.ts";
import { linesOf } from "./transfer.ts";

export function writeBytes(fd: number, bytes: Uint8Array): void {
	let offset = 0;
	while (offset < bytes.byteLength) {
		const written = writeSync(fd, bytes, offset, bytes.byteLength - offset);
		if (written === 0) throw new Error("archive spool could not be written");
		offset += written;
	}
}

/** Reads only the current archive row and one 64 KiB chunk into memory. */
export function* fileLines(path: string): Iterable<string> {
	const fd = openSync(path, "r");
	const buffer = new Uint8Array(64 * 1024);
	const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
	let pending = "";
	try {
		while (true) {
			const size = readSync(fd, buffer);
			if (size === 0) break;
			pending += decoder.decode(buffer.subarray(0, size), { stream: true });
			const end = pending.lastIndexOf("\n");
			if (end >= 0) {
				yield* linesOf(pending.slice(0, end + 1));
				pending = pending.slice(end + 1);
			}
		}
		pending += decoder.decode();
		if (pending.length > 0) yield pending;
	} catch (error) {
		if (error instanceof TypeError) throw new OpError("invalid", "the archive is not valid UTF-8");
		throw error;
	} finally {
		closeSync(fd);
	}
}
