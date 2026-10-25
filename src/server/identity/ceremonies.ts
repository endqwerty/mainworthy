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
	lockOwner: sql<{ kind: string; owner: string }>(
		"SELECT pg_advisory_xact_lock(hashtextextended($kind || $owner, 602385))",
	),
	lockKind: sql<{ kind: string }>("SELECT pg_advisory_xact_lock(hashtextextended($kind, 602384))"),
	expire: sql<{ kind: string; now: number }>("DELETE FROM identity_ceremonies WHERE kind = $kind AND deadline <= $now"),
	count: sql<{ kind: string }, { count: number }>(
		"SELECT count(*)::integer AS count FROM identity_ceremonies WHERE kind = $kind",
	),
	put: sql<{ kind: string; key: string; owner: string; deadline: number; generation: string; payload: string }>(
		"INSERT INTO identity_ceremonies (kind, key, owner, deadline, generation, payload) VALUES ($kind, $key, $owner, $deadline, $generation, $payload)",
	),
	get: sql<{ kind: string; key: string; now: number }, { payload: string; generation: string }>(
		"SELECT c.payload, c.generation FROM identity_ceremonies c JOIN identity_ceremony_epoch e ON c.generation = e.generation WHERE c.kind = $kind AND c.key = $key AND c.deadline > $now",
	),
	owner: sql<{ kind: string; owner: string; now: number }, { payload: string }>(
		"SELECT c.payload FROM identity_ceremonies c JOIN identity_ceremony_epoch e ON c.generation = e.generation WHERE c.kind = $kind AND c.owner = $owner AND c.deadline > $now ORDER BY c.deadline DESC",
	),
	take: sql<{ kind: string; key: string; now: number }>(
		"DELETE FROM identity_ceremonies WHERE kind = $kind AND key = $key AND deadline > $now AND generation = (SELECT generation FROM identity_ceremony_epoch WHERE singleton)",
	),
	dropOwner: sql<{ kind: string; owner: string }>(
		"DELETE FROM identity_ceremonies WHERE kind = $kind AND owner = $owner",
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

/** Each domain parses its payload; lifecycle, capacity and atomic consumption are shared. */
export class Ceremonies<T extends { readonly deadline: number }> {
	constructor(
		readonly kind: string,
		private readonly parse: (value: unknown) => T,
	) {}

	/** Reuse and issuance for one owner share a transaction, including the initial concurrent lookup. */
	async forOwner<R>(db: WriteDb, owner: string, work: () => Promise<R>): Promise<R> {
		await db.all(Q.lockOwner, { kind: this.kind, owner: ownerKey(owner) });
		return await work();
	}

	async put(db: WriteDb, key: string, value: T, owner: string, now: number, replaceOwner = false): Promise<void> {
		await db.run(Q.ensure, { generation: randomUUID() });
		const epoch = await db.one(Q.lockEpoch);
		await db.all(Q.lockKind, { kind: this.kind });
		if (replaceOwner) await this.clearOwner(db, owner);
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
	async owned(db: ReadDb, owner: string, now: number): Promise<T[]> {
		return (await db.all(Q.owner, { kind: this.kind, owner: ownerKey(owner), now })).map((row) =>
			this.parse(JSON.parse(row.payload)),
		);
	}
	async take(db: WriteDb, key: string, now: number): Promise<boolean> {
		const generation = await ceremonyGeneration(db);
		if (generation === null || !(await holdCeremonyGeneration(db, generation))) return false;
		return (await db.run(Q.take, { kind: this.kind, key, now })).changes === 1;
	}
	async clearOwner(db: WriteDb, owner: string): Promise<void> {
		await db.run(Q.dropOwner, { kind: this.kind, owner: ownerKey(owner) });
	}
}

export async function sweepCeremonies(db: WriteDb, now: number): Promise<void> {
	await db.run(Q.retention, { now });
}
