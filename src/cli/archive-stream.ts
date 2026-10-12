import { open, rm } from "node:fs/promises";

/** Writes with backpressure and a fixed-size stream buffer; even a large archive is never read in full. */
export async function writeFileStream(file: string, stream: ReadableStream<Uint8Array>): Promise<void> {
	const handle = await open(file, "w", 0o600);
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
	} catch (error) {
		await rm(file, { force: true });
		throw error;
	} finally {
		await handle.close();
	}
}
