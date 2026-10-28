import { createHash, randomUUID } from "node:crypto";
import type { App } from "../kernel/app.ts";
import { Busy, type ReadDb, sql, type WriteDb } from "../kernel/db.ts";

const ownerKey = (owner: string): string => createHash("sha256").update(owner).digest("hex");
const Q = {
	retention: sql<{ now: number }>("DELETE FROM identity_ceremonies WHERE deadline <= $now"),
	ensure: sql<{ generation: string }>(
		"INSERT INTO identity_ceremony_epoch (singleton, generation) VALUES (true, $generation) ON CONFLICT DO NOTHING",
	),
	epoch: sql<readonly [], { generation: string }>("SELECT generation FROM identity_ceremony_epoch WHERE singleton"),
	lockEpoch: sql<readonly [], { generation: string }>(
		"SELECT generation FROM identity_ceremony_epoch WHERE singleton FOR SHARE",
	),
	invalidate: sql<{ generation: string }>(
		"UPDATE identity_ceremony_epoch SET generation = $generation WHERE singleton",
	),
	clear: sql("DELETE FROM identity_ceremonies"),
	lockKind: sql<{ kind: string }>("SELECT pg_advisory_xact_lock(hashtextextended($kind, 602384))"),
	expire: sql<{ kind: string; now: number }>("DELETE FROM identity_ceremonies WHERE kind = $kind AND deadline <= $now"),
	// The newest an owner began stay: equal deadlines (one millisecond) fall back to the inserting transaction, since
	// each ceremony is written in its own.
	trimOwner: sql<{ kind: string; owner: string; keep: number }>(
		`DELETE FROM identity_ceremonies WHERE kind = $kind AND owner = $owner AND key NOT IN
		 (SELECT key FROM identity_ceremonies WHERE kind = $kind AND owner = $owner
		  ORDER BY deadline DESC, xmin::text::bigint DESC LIMIT $keep)`,
	),
	count: sql<{ kind: string }, { count: number }>(
		"SELECT count(*)::integer AS count FROM identity_ceremonies WHERE kind = $kind",
	),
	put: sql<{ kind: string; key: string; owner: string; deadline: number; generation: string; payload: string }>(
		"INSERT INTO identity_ceremonies (kind, key, owner, deadline, generation, payload) VALUES ($kind, $key, $owner, $deadline, $generation, $payload)",
	),
	get: sql<{ kind: string; key: string; now: number }, { payload: string; generation: string }>(
		"SELECT c.payload, c.generation FROM identity_ceremonies c JOIN identity_ceremony_epoch e ON c.generation = e.generation WHERE c.kind = $kind AND c.key = $key AND c.deadline > $now",
	),
	take: sql<{ kind: string; key: string; now: number }>(
		"DELETE FROM identity_ceremonies WHERE kind = $kind AND key = $key AND deadline > $now AND generation = (SELECT generation FROM identity_ceremony_epoch WHERE singleton)",
	),
};

/** Import and a resulting domain write cannot pass each other's generation check. */
export async function ceremonyGeneration(db: ReadDb): Promise<string | null> {
	return (await db.get(Q.epoch))?.generation ?? null;
}
export async function holdCeremonyGeneration(db: WriteDb, generation: string): Promise<boolean> {
	return (await db.get(Q.lockEpoch))?.generation === generation;
}
export async function clearCeremonies(db: WriteDb): Promise<void> {
	await db.run(Q.invalidate, { generation: randomUUID() });
	await db.run(Q.clear);
}
export async function ceremonyWrite<T>(
	app: App,
	db: WriteDb | undefined,
	work: (db: WriteDb) => Promise<T>,
): Promise<T> {
	return db ? await work(db) : await app.database.admission((lease) => lease.transaction(work));
}

/** Ends every ceremony under way, as an import does: what was begun before it finishes nowhere. */
export async function clearChallenges(app: App, db?: WriteDb): Promise<void> {
	await ceremonyWrite(app, db, clearCeremonies);
}

/** Each domain parses its payload; lifecycle, capacity and atomic consumption are shared. */
export class Ceremonies<T extends { readonly deadline: number }> {
	constructor(
		readonly kind: string,
		private readonly parse: (value: unknown) => T,
	) {}

	/**
	 * Stores a ceremony under `owner`. With `ownerLimit`, the owner's oldest ceremonies of this kind end first so that
	 * it holds at most that many places in the shared capacity, this one included.
	 */
	async put(db: WriteDb, key: string, value: T, owner: string, now: number, ownerLimit?: number): Promise<void> {
		await db.run(Q.ensure, { generation: randomUUID() });
		const epoch = await db.one(Q.lockEpoch);
		await db.all(Q.lockKind, { kind: this.kind });
		if (ownerLimit !== undefined)
			await db.run(Q.trimOwner, { kind: this.kind, owner: ownerKey(owner), keep: ownerLimit - 1 });
		await db.run(Q.expire, { kind: this.kind, now });
		if ((await db.one(Q.count, { kind: this.kind })).count >= 10_000) throw new Busy();
		await db.run(Q.put, {
			kind: this.kind,
			key,
			owner: ownerKey(owner),
			deadline: value.deadline,
			generation: epoch.generation,
			payload: JSON.stringify(value),
		});
	}
	async get(db: ReadDb, key: string, now: number): Promise<(T & { generation: string }) | null> {
		const row = await db.get(Q.get, { kind: this.kind, key, now });
		return row ? { ...this.parse(JSON.parse(row.payload)), generation: row.generation } : null;
	}
	async take(db: WriteDb, key: string, now: number): Promise<boolean> {
		const generation = await ceremonyGeneration(db);
		if (generation === null || !(await holdCeremonyGeneration(db, generation))) return false;
		return (await db.run(Q.take, { kind: this.kind, key, now })).changes === 1;
	}
}

export async function sweepCeremonies(db: WriteDb, now: number): Promise<void> {
	await db.run(Q.retention, { now });
}
