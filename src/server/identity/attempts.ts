// Shared admission accounting uses its own small pool, never a domain writer connection.
import { createHash } from "node:crypto";
import { z } from "zod";
import type { App } from "../kernel/app.ts";
import { Busy, sql } from "../kernel/db.ts";
import {
	afterFailure,
	blockLeft,
	createStartLimiter,
	type Entry,
	forgottenAt,
	type LimiterAnswer,
	startAddressKey,
} from "./limiter.ts";

const Stored = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("counting"), lastFailure: z.number(), recent: z.array(z.number()) }),
	z.object({
		kind: z.literal("tripped"),
		lastFailure: z.number(),
		blockMs: z.number(),
		until: z.number(),
		blockVersion: z.number(),
	}),
]);
const databaseKey = (key: string): string => createHash("sha256").update(key).digest("hex");
const Q = {
	version: sql<readonly [], { version: number }>("SELECT nextval('identity_limit_version') AS version"),
	entries: sql<{ keys: readonly string[] }, { key: string; entry: string; version: number }>(
		"SELECT key,entry,version FROM identity_limits WHERE key = ANY($keys::text[])",
	),
	lock: sql<{ key: string }>("SELECT pg_advisory_xact_lock(hashtextextended($key, 827))"),
	capacity: sql("SELECT pg_advisory_xact_lock(827001)"),
	room: sql(`DELETE FROM identity_limits WHERE key IN (
 SELECT key FROM identity_limits ORDER BY expires_at LIMIT greatest(0, (SELECT count(*) FROM identity_limits) - 9999) FOR UPDATE SKIP LOCKED)`),
	put: sql<{
		key: string;
		entry: string;
		expires: number;
		version: number;
	}>(`INSERT INTO identity_limits (key,entry,expires_at,version) VALUES ($key,$entry,$expires,$version)
 ON CONFLICT(key) DO UPDATE SET entry = excluded.entry, expires_at = excluded.expires_at, version = excluded.version`),
	clear: sql<{ keys: readonly string[]; version: number }>(
		"DELETE FROM identity_limits WHERE key = ANY($keys::text[]) AND version <= $version",
	),
	size: sql<readonly [], { size: number }>("SELECT count(*) AS size FROM identity_limits"),
	startSize: sql<readonly [], { size: number }>("SELECT count(*) AS size FROM identity_starts"),
	advanceStart: sql<{ key: string; now: number }, { since: number; count: number }>(
		`UPDATE identity_starts SET
 since = CASE WHEN $now >= since AND $now < since + 60000 THEN since ELSE $now END,
 count = CASE WHEN $now >= since AND $now < since + 60000 THEN least(count + 1,301) ELSE 1 END
 WHERE key = $key RETURNING since,count`,
	),
	start: sql<
		{ key: string; now: number },
		{ since: number; count: number }
	>(`INSERT INTO identity_starts (key,since,count) VALUES ($key,$now,1)
 ON CONFLICT(key) DO UPDATE SET since = CASE WHEN $now >= identity_starts.since AND $now < identity_starts.since + 60000 THEN identity_starts.since ELSE $now END,
 count = CASE WHEN $now >= identity_starts.since AND $now < identity_starts.since + 60000 THEN least(identity_starts.count + 1,301) ELSE 1 END RETURNING since,count`),
	startRoom: sql(`DELETE FROM identity_starts WHERE key IN (
 SELECT key FROM identity_starts ORDER BY since LIMIT greatest(0, (SELECT count(*) FROM identity_starts) - 9999) FOR UPDATE SKIP LOCKED)`),
};
const proofStarts = new WeakMap<App, ReturnType<typeof createStartLimiter>>();
const starts = new WeakMap<App, ReturnType<typeof createStartLimiter>>();
function localStarts(app: App) {
	let limiter = starts.get(app);
	if (!limiter) {
		limiter = createStartLimiter();
		starts.set(app, limiter);
	}
	return limiter;
}

/** The local ceiling rejects floods cheaply; PostgreSQL supplies the allowance shared by all instances. */
export async function takeStart(app: App, address: string | null): Promise<LimiterAnswer> {
	const source = startAddressKey(address);
	const key = source === null ? null : databaseKey(source);
	const now = app.now();
	const local = localStarts(app)(key, now);
	if (local.kind === "blocked" || key === null) return local;
	return await app.database.admission((db) =>
		db.transaction(async () => {
			await db.run(Q.lock, { key: `start:${key}` });
			let row = await db.get(Q.advanceStart, { key, now });
			if (!row) {
				await db.run(Q.capacity);
				await db.run(Q.startRoom);
				if ((await db.one(Q.startSize)).size >= 10_000) throw new Busy();
				row = await db.one(Q.start, { key, now });
			}
			return row.count <= 300
				? { kind: "free" }
				: { kind: "blocked", retryAfterSeconds: Math.ceil((row.since + 60_000 - now) / 1000) };
		}),
	);
}

export type SharedLimiter = {
	check(keys: readonly string[], now: number): Promise<LimiterAnswer & { version: number }>;
	failed(keys: readonly string[], now: number): Promise<LimiterAnswer>;
	succeeded(keys: readonly string[], observedVersion?: number): Promise<void>;
	snapshot(): Promise<number>;
	size(): Promise<number>;
};
const limiters = new WeakMap<App, SharedLimiter>();
export function limiterOf(app: App): SharedLimiter {
	const held = limiters.get(app);
	if (held) return held;
	const limiter: SharedLimiter = {
		async snapshot() {
			return await app.database.admission(async (db) => (await db.one(Q.version)).version);
		},
		async check(keys, now) {
			let local = proofStarts.get(app);
			if (!local) {
				local = createStartLimiter();
				proofStarts.set(app, local);
			}
			const ceiling = local(keys.find((key) => key.startsWith("addr:")) ?? null, now);
			if (ceiling.kind === "blocked") return { ...ceiling, version: 0 };
			return await app.database.admission(async (db) => {
				const version = (await db.one(Q.version)).version;
				const rows = await db.all(Q.entries, { keys: keys.map(databaseKey) });
				const left = Math.max(0, ...rows.map((row) => blockLeft(Stored.parse(JSON.parse(row.entry)), now)));
				return left === 0
					? { kind: "free", version }
					: { kind: "blocked", retryAfterSeconds: Math.ceil(left / 1000), version };
			});
		},
		async failed(keys, now) {
			if (!keys.length) return { kind: "free" };
			return await app.database.admission((db) =>
				db.transaction(async () => {
					const unique = [...new Set(keys.map(databaseKey))].sort();
					for (const key of unique) await db.run(Q.lock, { key: `failure:${key}` });
					const rows = new Map((await db.all(Q.entries, { keys: unique })).map((row) => [row.key, row]));
					const left = Math.max(
						0,
						...[...rows.values()].map((row) => blockLeft(Stored.parse(JSON.parse(row.entry)), now)),
					);
					if (left > 0) return { kind: "blocked", retryAfterSeconds: Math.ceil(left / 1000) };
					const version = (await db.one(Q.version)).version;
					for (const key of unique) {
						const row = rows.get(key);
						let entry: Entry | undefined = row ? Stored.parse(JSON.parse(row.entry)) : undefined;
						if (entry && forgottenAt(entry) <= now) entry = undefined;
						if (!row) {
							await db.run(Q.capacity);
							await db.run(Q.room);
							if ((await db.one(Q.size)).size >= 10_000) throw new Busy();
						}
						const next = afterFailure(entry, now, version);
						await db.run(Q.put, { key, entry: JSON.stringify(next), expires: forgottenAt(next), version });
					}
					return { kind: "free" };
				}),
			);
		},
		async succeeded(keys, observedVersion) {
			if (!keys.length) return;
			const version = observedVersion ?? (await limiter.snapshot());
			await app.database.admission((db) =>
				db.transaction(async () => {
					for (const key of [...new Set(keys.map(databaseKey))].sort()) await db.run(Q.lock, { key: `failure:${key}` });
					await db.run(Q.clear, { keys: keys.map(databaseKey), version });
				}),
			);
		},
		async size() {
			return await app.database.admission(async (db) => (await db.one(Q.size)).size);
		},
	};
	limiters.set(app, limiter);
	return limiter;
}
