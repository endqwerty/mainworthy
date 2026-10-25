import { attachmentReferenced } from "../evidence/attachments.ts";
import type { App } from "../kernel/app.ts";
import { BLOB_GRACE_MS, blobCandidates, checkedBlob, forgetBlob, lockBlob } from "../kernel/blob-objects.ts";
import { fenceJob, type JobClaim } from "../kernel/jobs.ts";

/** A put commits its age before bytes. A prune holds that same row through object deletion. */
export async function pruneBlobs(app: App, claim: JobClaim): Promise<void> {
	const before = app.now() - BLOB_GRACE_MS;
	for (const { hash } of await app.database.read((db) => blobCandidates(db, before))) {
		await app.database.write((db) =>
			db.transaction(async () => {
				const object = await lockBlob(db, hash);
				if (!object || object.put_at >= before) return;
				await fenceJob(db, claim, app.now());
				if (await attachmentReferenced(db, hash)) {
					await checkedBlob(db, hash, app.now());
					return;
				}
				await app.blobs.remove(hash);
				await forgetBlob(db, hash);
			}),
		);
	}
	// Temporary files take the filesystem's wall clock, independently of demo evidence times.
	await app.blobs.prunePending(Date.now() - BLOB_GRACE_MS);
}
