import { mkdtemp, open, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { CliError } from "./errors.ts";

/** Writes with backpressure and a fixed-size stream buffer; even a large archive is never read in full. */
export async function writeFileStream(file: string, stream: ReadableStream<Uint8Array>): Promise<void> {
	const directory = await mkdtemp(join(dirname(resolve(file)), ".casebook-export-"));
	const path = join(directory, "archive");
	try {
		const handle = await open(path, "wx", 0o600);
		try {
			await stream.pipeTo(
				new WritableStream<Uint8Array>({
					async write(chunk) {
						let offset = 0;
						while (offset < chunk.byteLength) {
							const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
							if (bytesWritten === 0) throw new Error("the archive file could not be written");
							offset += bytesWritten;
						}
					},
				}),
			);
		} finally {
			await handle.close();
		}
		await rename(path, file);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

/** Tracks source/decompression failures without teeing or buffering an upload, so they are not called network failures. */
export function guardedInput(
	stream: ReadableStream<Uint8Array>,
	message: string,
): { body: ReadableStream<Uint8Array>; failure: () => CliError | null } {
	const reader = stream.getReader();
	let failure: CliError | null = null;
	let released = false;
	const release = (): void => {
		if (!released) {
			released = true;
			reader.releaseLock();
		}
	};
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const next = await reader.read();
				if (next.done) {
					release();
					controller.close();
				} else controller.enqueue(next.value);
			} catch {
				failure = new CliError("invalid", message);
				release();
				controller.error(failure);
			}
		},
		async cancel(reason) {
			try {
				await reader.cancel(reason);
			} finally {
				release();
			}
		},
	});
	return { body, failure: () => failure };
}
