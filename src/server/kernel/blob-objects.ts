import type { BlobStore } from "./blobs.ts";
import { blobHash } from "./blobs.ts";
import { Database, LOCK_WAIT_MS, type ReadDb, sql, type WriteDb } from "./db.ts";

// Twice the measured transaction bound. An upload may not retain an uncommitted attachment beyond that bound.
export const BLOB_GRACE_MS = 2 * LOCK_WAIT_MS;
const Q = {
	enroll: sql<{ hashes: string[]; at: number }>(`INSERT INTO blob_objects(hash,put_at)
 SELECT unnest($hashes::text[]),$at ORDER BY 1 ON CONFLICT(hash) DO NOTHING`),
	put: sql<{ hash: string; at: number }>(`INSERT INTO blob_objects(hash,put_at) VALUES($hash,$at)
 ON CONFLICT(hash) DO UPDATE SET put_at=GREATEST(blob_objects.put_at,excluded.put_at)`),
	candidates: sql<{ before: number }, { hash: string }>(
		"SELECT hash FROM blob_objects WHERE put_at < $before ORDER BY checked_at,put_at,hash LIMIT 100",
	),
	lock: sql<{ hash: string }, { hash: string; put_at: number }>(
		"SELECT hash,put_at FROM blob_objects WHERE hash=$hash FOR UPDATE",
	),
	checked: sql<{ hash: string; now: number }>("UPDATE blob_objects SET checked_at=$now WHERE hash=$hash"),
	remove: sql<{ hash: string }>("DELETE FROM blob_objects WHERE hash=$hash"),
};
export const blobCandidates = (db: ReadDb, before: number): Promise<{ hash: string }[]> =>
	db.all(Q.candidates, { before });
export const lockBlob = (db: WriteDb, hash: string): Promise<{ hash: string; put_at: number } | null> =>
	db.get(Q.lock, { hash });
export const checkedBlob = (db: WriteDb, hash: string, now: number): Promise<unknown> =>
	db.run(Q.checked, { hash, now });
export const forgetBlob = (db: WriteDb, hash: string): Promise<unknown> => db.run(Q.remove, { hash });

/** Startup gives untracked files a full grace period, without renewing previously enrolled objects. */
export async function enrollBlobs(database: Database, hashes: string[], at: number): Promise<void> {
	if (hashes.length === 0) return;
	await database.write((db) => db.transaction(() => db.run(Q.enroll, { hashes, at })));
}

/** A put commits its age before touching bytes, including when it reuses an existing object. */
export function trackedBlobs(
	url: string,
	store: BlobStore,
	now: () => number,
): { store: BlobStore; close: () => Promise<void> } {
	// This pool cannot wait behind the domain writer that is awaiting the put's independent commit.
	let metadata: Promise<Database> | null = null;
	return {
		store: {
			...store,
			async put(bytes) {
				metadata ??= Database.open({ url, readPool: 1, writePool: 1 });
				const pending = metadata;
				let database: Database;
				try {
					database = await pending;
				} catch (error) {
					if (metadata === pending) metadata = null;
					throw error;
				}
				await database.write((db) => db.transaction(() => db.run(Q.put, { hash: blobHash(bytes), at: now() })));
				return store.put(bytes);
			},
		},
		async close() {
			if (metadata) {
				const database = await metadata.catch(() => null);
				await database?.close();
			}
		},
	};
}
