import { Database, type WriteDb } from "../src/server/kernel/db.ts";
import { testDatabase } from "./db.ts";

/** A test owns this writer lease until disposal; transactions remain explicit. */
export async function writerDatabase(): Promise<WriteDb & AsyncDisposable> {
	const fixture = await testDatabase();
	const database = await Database.open({ url: fixture.url });
	const done = Promise.withResolvers<void>();
	const ready = Promise.withResolvers<WriteDb>();
	const holding = database.write(async (db) => {
		ready.resolve(db);
		await done.promise;
	});
	void holding.catch(ready.reject);
	const db = await ready.promise;
	return Object.assign(db, {
		async [Symbol.asyncDispose]() {
			done.resolve();
			try {
				await holding;
			} finally {
				await database.close();
				await fixture.close();
			}
		},
	});
}
