// The store of ceremonies under way is PostgreSQL's, shared by every instance on the database: one begun on one
// App is found, spent or cleared on another. The provider's ceremony (`oidc.ts`) keeps its rows here.
import { afterEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { Ceremonies, ceremonyWrite, clearChallenges } from "../src/server/identity/ceremonies.ts";
import { type App, openApp } from "../src/server/kernel/app.ts";
import { Busy } from "../src/server/kernel/db.ts";
import { type Harness, harness } from "./helpers.ts";

const opened: { h: Harness; peer: App }[] = [];
afterEach(async () => {
	for (const { h, peer } of opened.splice(0)) {
		await peer.close();
		await h.close();
	}
});
async function pair() {
	const h = await harness();
	const peer = await openApp(h.app.config, { memory: true, now: h.app.now });
	opened.push({ h, peer });
	return { h, peer };
}

type Kept = { purpose: string; deadline: number };
const store = (kind: string) =>
	new Ceremonies(kind, (value): Kept => {
		const kept = value as Kept;
		return { purpose: kept.purpose, deadline: kept.deadline };
	});
const oidc = store("oidc");
const LASTS = 300_000;

/** Begins a ceremony on `app`, owned by `owner`, and returns its key. */
async function put(app: App, owner = "addr:192.0.2.10", kept = oidc): Promise<string> {
	const key = randomBytes(16).toString("base64url");
	const now = app.now();
	await ceremonyWrite(app, undefined, (db) =>
		kept.put(db, key, { purpose: "sign-in", deadline: now + LASTS }, owner, now),
	);
	return key;
}
const find = (app: App, key: string, kept = oidc) => app.database.read((db) => kept.get(db, key, app.now()));
const take = (app: App, key: string) => app.database.write((db) => db.transaction(() => oidc.take(db, key, app.now())));

test("a ceremony begun on one App is found on the other, and its owner is kept only as a digest", async () => {
	const { h, peer } = await pair();
	const key = await put(h.app);
	expect(await find(peer, key)).toMatchObject({ purpose: "sign-in", deadline: h.app.now() + LASTS });
	const rows = await peer.database.read((db) =>
		db.allDynamic<{ owner: string }>("SELECT owner FROM identity_ceremonies"),
	);
	expect(rows[0]?.owner).toMatch(/^[a-f0-9]{64}$/);
	expect(JSON.stringify(rows)).not.toContain("192.0.2.10");
});

test("clearing ceremonies on one App ends one begun on the other", async () => {
	const { h, peer } = await pair();
	const key = await put(h.app);
	await clearChallenges(peer);
	expect(await find(h.app, key)).toBeNull();
	expect(await take(h.app, key)).toBe(false);
});

test("of two Apps spending one ceremony one succeeds, and a rolled-back spend leaves it to spend", async () => {
	const { h, peer } = await pair();
	const key = await put(h.app);
	await expect(
		h.app.database.write((db) =>
			db.transaction(async () => {
				expect(await oidc.take(db, key, h.app.now())).toBe(true);
				throw new Error("undo domain write");
			}),
		),
	).rejects.toThrow("undo domain write");
	expect(await find(peer, key)).not.toBeNull();
	const spent = await Promise.all([h.app, peer].map((app) => take(app, key)));
	expect(spent.sort()).toEqual([false, true]);
	expect(await find(h.app, key)).toBeNull();
});

test("a full kind refuses newcomers without evicting pending ceremonies or spending another kind's space; expiry frees it", async () => {
	const { h, peer } = await pair();
	const first = await put(h.app);
	await h.app.database.write((db) =>
		db.transaction(() =>
			db.runDynamic(
				`
		INSERT INTO identity_ceremonies (kind, key, owner, deadline, generation, payload)
		SELECT kind, 'fixture-' || n, owner, deadline, generation, payload
		FROM identity_ceremonies CROSS JOIN generate_series(1, 9998) n WHERE key = $1`,
				[first],
			),
		),
	);
	const admitted = await Promise.allSettled([h.app, peer].map((app) => put(app)));
	expect(admitted.filter((result) => result.status === "fulfilled")).toHaveLength(1);
	const refused = admitted.find((result) => result.status === "rejected");
	expect(refused?.status === "rejected" && refused.reason instanceof Busy).toBe(true);
	expect(await find(peer, first)).not.toBeNull();
	const other = store("other");
	const elsewhere = await put(peer, "session:other", other);
	expect(await find(h.app, elsewhere, other)).not.toBeNull();
	h.advance(LASTS);
	const fresh = await put(peer);
	expect(await find(h.app, fresh)).not.toBeNull();
	expect(await find(h.app, first)).toBeNull();
});
