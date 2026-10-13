import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileStream } from "./archive-stream.ts";
import { withInstance } from "./test-support.ts";

test("a failed download preserves an existing archive", async () => {
	await withInstance(async ({ directory }) => {
		const file = join(directory, "backup.mainworthy");
		await writeFile(file, "previous backup");
		let chunks = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (chunks++ === 0) controller.enqueue(new TextEncoder().encode("partial"));
				else controller.error(new Error("connection reset mid-download"));
			},
		});
		await expect(writeFileStream(file, stream)).rejects.toThrow("connection reset");
		expect(await readFile(file, "utf8")).toBe("previous backup");
	});
});
