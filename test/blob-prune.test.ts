import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type App, openApp } from "../src/server/kernel/app.ts";
import { BLOB_GRACE_MS, trackedBlobs } from "../src/server/kernel/blob-objects.ts";
import { blobHash, diskBlobs } from "../src/server/kernel/blobs.ts";
import { runPeriodicJob } from "../src/server/kernel/jobs.ts";
import { pruneBlobs } from "../src/server/ops/blob-prune.ts";
import { type Harness, harness } from "./helpers.ts";

let h: Harness;
let peer: App;
let directory: string;
const stores: (() => Promise<void>)[] = [];
afterEach(async () => {
	await peer?.close();
	for (const close of stores.splice(0)) await close();
	await h?.close();
	if (directory) await rm(directory, { recursive: true, force: true });
});
async function setup() {
	h = await harness();
	directory = await mkdtemp(join(tmpdir(), "mainworthy-prune-"));
	const raw = diskBlobs(directory);
	const tracked = trackedBlobs(h.app.config.databaseUrl, raw, h.app.now);
	stores.push(tracked.close);
	h.app.blobs = tracked.store;
	peer = await openApp({ ...h.app.config, dataDir: directory }, { now: h.app.now });
	return raw;
}
const prune = () =>
	runPeriodicJob(peer, "blob-prune", async (claim) => {
		await pruneBlobs(peer, claim);
		return 0;
	});
for (const reused of [false, true])
	test(`a prune beside an upload ${reused ? "reusing old bytes" : "putting new bytes"} preserves the attachment`, async () => {
		const raw = await setup();
		const bytes = Buffer.from("attachment under upload");
		const hash = blobHash(bytes);
		if (reused) {
			await h.app.blobs.put(bytes);
			h.advance(BLOB_GRACE_MS + 1);
		}
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const delayed = trackedBlobs(
			h.app.config.databaseUrl,
			{
				...raw,
				async put(value) {
					entered.resolve();
					await release.promise;
					return raw.put(value);
				},
			},
			h.app.now,
		);
		stores.push(delayed.close);
		h.app.blobs = delayed.store;
		const report = h.call("report", {
			target: { session: "upload" },
			results: [
				{ test: { key: "one" }, outcome: "pass", attachments: [{ name: "log.txt", data: bytes.toString("base64") }] },
			],
		});
		try {
			await entered.promise;
			await prune();
			if (reused) expect(await raw.get(hash)).toEqual(bytes);
			release.resolve();
			await report;
			expect(await peer.blobs.get(hash)).toEqual(bytes);
			expect(await h.app.database.read((db) => db.allDynamic("SELECT hash FROM attachments"))).toEqual([{ hash }]);
		} finally {
			release.resolve();
			await report;
		}
	});
test("an upload waiting for a prune rewrites the deleted object after acquiring its row", async () => {
	const raw = await setup();
	const bytes = Buffer.from("old orphan reused during delete");
	const hash = await h.app.blobs.put(bytes);
	h.advance(BLOB_GRACE_MS + 1);
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	peer.blobs = {
		...peer.blobs,
		async remove(value) {
			entered.resolve();
			await release.promise;
			await raw.remove(value);
		},
	};
	const pruning = prune();
	let uploading: Promise<string> | undefined;
	try {
		await entered.promise;
		uploading = h.app.blobs.put(bytes);
		release.resolve();
		await pruning;
		expect(await uploading).toBe(hash);
		expect(await raw.get(hash)).toEqual(bytes);
		expect(await h.app.database.read((db) => db.allDynamic("SELECT hash,put_at FROM blob_objects"))).toEqual([
			{ hash, put_at: h.app.now() },
		]);
	} finally {
		release.resolve();
		await pruning;
		await uploading;
	}
});
test("pruning removes only old unreferenced objects and old pending files", async () => {
	const raw = await setup();
	const orphan = await h.app.blobs.put(Buffer.from("old orphan"));
	const bytes = Buffer.from("retained evidence");
	await h.call("report", {
		target: { session: "kept" },
		results: [
			{ test: { key: "one" }, outcome: "pass", attachments: [{ name: "log.txt", data: bytes.toString("base64") }] },
		],
	});
	h.advance(BLOB_GRACE_MS + 1);
	const recent = await h.app.blobs.put(Buffer.from("recent upload"));
	const old = join(directory, "blobs/.pending-old");
	const current = join(directory, "blobs/.pending-current");
	await writeFile(old, "interrupted");
	await writeFile(current, "live");
	const at = new Date(Date.now() - BLOB_GRACE_MS - 1000);
	await utimes(old, at, at);
	await prune();
	expect(await raw.get(orphan)).toBeNull();
	expect(await raw.get(recent)).not.toBeNull();
	expect(await raw.get(blobHash(bytes))).toEqual(bytes);
	expect(await readdir(join(directory, "blobs"))).toContain(".pending-current");
	expect(await readdir(join(directory, "blobs"))).not.toContain(".pending-old");
});

test("referenced objects do not starve an orphan beyond the first prune slice", async () => {
	await setup();
	await h.call("report", {
		target: { session: "many" },
		results: Array.from({ length: 100 }, (_, i) => ({
			test: { key: `test-${i}` },
			outcome: "pass",
			attachments: [{ name: "log.txt", data: Buffer.from(`retained ${i}`).toString("base64") }],
		})),
	});
	h.advance(1);
	const orphan = await h.app.blobs.put(Buffer.from("orphan after the first hundred"));
	h.advance(BLOB_GRACE_MS + 1);
	await prune();
	expect(await h.app.blobs.get(orphan)).not.toBeNull();
	await prune();
	expect(await h.app.blobs.get(orphan)).toBeNull();
});

test("startup enrolls pre-upgrade files once and prunes only the orphan after a full grace", async () => {
	const raw = await setup();
	const orphan = await raw.put(Buffer.from("orphan from before upgrade"));
	const kept = Buffer.from("referenced before upgrade");
	h.app.blobs = raw;
	await h.call("report", {
		target: { session: "before-upgrade" },
		results: [
			{ test: { key: "one" }, outcome: "pass", attachments: [{ name: "log.txt", data: kept.toString("base64") }] },
		],
	});
	await writeFile(join(directory, "blobs/not-an-object"), "ignored");
	await mkdir(join(directory, "blobs", "a".repeat(64)));
	await symlink(join(directory, "blobs", orphan), join(directory, "blobs", "b".repeat(64)));
	expect(await h.app.database.read((db) => db.allDynamic("SELECT hash FROM blob_objects"))).toEqual([]);
	h.advance(2 * BLOB_GRACE_MS);
	const enrolledAt = h.app.now();
	await peer.close();
	peer = await openApp({ ...h.app.config, dataDir: directory }, { now: h.app.now });
	await prune();
	expect(await raw.get(orphan)).not.toBeNull();
	h.advance(BLOB_GRACE_MS);
	await prune();
	expect(await raw.get(orphan)).not.toBeNull();
	await peer.close();
	peer = await openApp({ ...h.app.config, dataDir: directory }, { now: h.app.now });
	h.advance(1);
	await prune();
	expect(await raw.get(orphan)).toBeNull();
	expect(await raw.get(blobHash(kept))).toEqual(kept);
	expect(await h.app.database.read((db) => db.allDynamic("SELECT hash,put_at FROM blob_objects"))).toEqual([
		{ hash: blobHash(kept), put_at: enrolledAt },
	]);
});
