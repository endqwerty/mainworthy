import { afterEach, expect, test } from "bun:test";
import { admit, bootstrap, createToken, hashToken, signInWithToken } from "../src/server/identity/identity.ts";
import { findSession } from "../src/server/identity/sessions.ts";
import { noteUse } from "../src/server/identity/uses.ts";
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

test("asking the limiter repeatedly changes no allowance on either App", async () => {
	const { h, peer } = await pair();
	const { limiterOf } = await import("../src/server/identity/attempts.ts");
	const keys = ["addr:203.0.113.99", "account:repeated-check"];
	for (let i = 0; i < 301; i++) expect((await limiterOf(h.app).check(keys, h.app.now())).kind).toBe("free");
	expect((await limiterOf(peer).check(keys, h.app.now())).kind).toBe("free");
	for (let i = 0; i < 5; i++) expect((await limiterOf(peer).failed(keys, h.app.now())).kind).toBe("free");
	for (const app of [h.app, peer])
		expect(await limiterOf(app).check(keys, app.now())).toMatchObject({ kind: "blocked", retryAfterSeconds: 1 });
});

test("valid env-token admission agrees across Apps after 300 requests from one public address", async () => {
	const { h, peer } = await pair();
	const secret = "fixture-owner-token-0123456789abcdef";
	h.app.config.ownerToken = secret;
	await bootstrap(h.app);
	const facts = { bearer: secret, cookie: null, sameOrigin: false, localOwner: null, address: "203.0.113.99" };
	for (let i = 0; i < 300; i++) expect((await admit(h.app, facts)).kind).toBe("admitted");
	expect((await admit(peer, facts)).kind).toBe("admitted");
	expect((await admit(h.app, facts)).kind).toBe("admitted");
});

test.each(["failures", "starts"])(
	"shared %s capacity remains bounded when another App locks every eviction candidate",
	async (kind) => {
		const { h, peer } = await pair();
		const { limiterOf, takeStart } = await import("../src/server/identity/attempts.ts");
		const table = kind === "failures" ? "identity_limits" : "identity_starts";
		await peer.database.write((db) =>
			db.transaction(() =>
				db.runDynamic(
					kind === "failures"
						? `INSERT INTO identity_limits (key,entry,expires_at,version) SELECT 'fixture-' || n,'{"kind":"counting","lastFailure":0,"recent":[]}',1,1 FROM generate_series(1,10000) n`
						: "INSERT INTO identity_starts (key,since,count) SELECT 'fixture-' || n,0,1 FROM generate_series(1,10000) n",
				),
			),
		);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const held = peer.database.write((db) =>
			db.transaction(async () => {
				await db.allDynamic(`SELECT key FROM ${table} FOR UPDATE`);
				entered.resolve();
				await release.promise;
			}),
		);
		await entered.promise;
		const attempt = () =>
			kind === "failures"
				? limiterOf(h.app).failed(["prefix:new-source"], h.app.now())
				: takeStart(h.app, "192.0.2.100");
		try {
			await expect(attempt()).rejects.toBeInstanceOf(Busy);
			expect(
				await h.app.database.read((db) => db.allDynamic(`SELECT count(*)::integer AS count FROM ${table}`)),
			).toEqual([{ count: 10_000 }]);
		} finally {
			release.resolve();
			await held;
		}
		expect(await attempt()).toEqual({ kind: "free" });
	},
);

test("a request writes a token use visible to another App, throttled by its stored minute", async () => {
	const { h, peer } = await pair();
	const made = await createToken(h.app, { actor: "reader", kind: "agent", can: ["read"], project: 0, label: "shared" });
	const facts = { bearer: made.secret, cookie: null, sameOrigin: false, localOwner: null, address: "192.0.2.10" };
	expect((await admit(h.app, facts)).kind).toBe("admitted");
	const row = async () =>
		peer.database.read((db) =>
			db.allDynamic<{ last_used_at: number; last_used_addr: string }>(
				"SELECT last_used_at,last_used_addr FROM tokens WHERE id = $1",
				[made.id],
			),
		);
	expect((await row())[0]).toEqual({ last_used_at: h.app.now(), last_used_addr: "192.0.2.10" });
	const first = h.app.now();
	h.advance(30_000);
	expect((await admit(peer, { ...facts, address: "192.0.2.11" })).kind).toBe("admitted");
	expect((await row())[0]?.last_used_at).toBe(first);
	h.advance(30_001);
	expect((await admit(peer, { ...facts, address: "192.0.2.11" })).kind).toBe("admitted");
	expect((await row())[0]).toEqual({ last_used_at: h.app.now(), last_used_addr: "192.0.2.11" });
});

test("a session used on one App remains active on another from its stored use", async () => {
	const { h, peer } = await pair();
	const token = await createToken(h.app, {
		actor: "reader",
		kind: "human",
		can: ["read"],
		project: 0,
		label: "shared",
	});
	const opening = await signInWithToken(h.app, token.secret, { userAgent: null, address: null });
	if (opening.kind !== "opening") throw new Error("no session");
	const signed = await opening.signedIn;
	if (!signed) throw new Error("no session");
	h.advance(13 * 86_400_000);
	expect(
		(await admit(h.app, { bearer: null, cookie: signed.cookie, sameOrigin: true, localOwner: null, address: null }))
			.kind,
	).toBe("admitted");
	h.advance(13 * 86_400_000);
	expect(await findSession(peer, hashToken(signed.cookie))).not.toBeNull();
});

test("a delayed use cannot write an address back onto a revoked token", async () => {
	const { h, peer } = await pair();
	const token = await createToken(h.app, {
		actor: "reader",
		kind: "agent",
		can: ["read"],
		project: 0,
		label: "shared",
	});
	await h.call("admin", { do: "token.revoke", id: token.id });
	await noteUse(peer, "token", token.id, h.app.now(), "192.0.2.10", hashToken(token.secret));
	expect(
		await h.app.database.read((db) =>
			db.allDynamic("SELECT last_used_at,last_used_addr FROM tokens WHERE id = $1", [token.id]),
		),
	).toEqual([{ last_used_at: null, last_used_addr: null }]);
});

test("failed token prefixes share one allowance across Apps and addresses", async () => {
	const { h, peer } = await pair();
	const facts = { cookie: null, sameOrigin: false, localOwner: null, address: "192.0.2.10" };
	for (let i = 0; i < 5; i++)
		expect((await admit(h.app, { ...facts, bearer: `cb_sharedxx${i}` })).kind).toBe("refused");
	expect(await admit(peer, { ...facts, address: "192.0.2.11", bearer: "cb_sharedxxother" })).toEqual({
		kind: "limited",
		retryAfter: 1,
	});
	h.advance(1_000);
	expect((await admit(peer, { ...facts, bearer: "cb_sharedxxnext" })).kind).toBe("refused");
	expect(await admit(h.app, { ...facts, bearer: "cb_sharedxxagain" })).toEqual({ kind: "limited", retryAfter: 2 });
});

test("anonymous starts on different Apps spend the same fixed window", async () => {
	const { h, peer } = await pair();
	const { takeStart } = await import("../src/server/identity/attempts.ts");
	for (let i = 0; i < 300; i++) expect((await takeStart(i % 2 ? h.app : peer, "192.0.2.10")).kind).toBe("free");
	expect(await takeStart(peer, "192.0.2.10")).toEqual({ kind: "blocked", retryAfterSeconds: 60 });
	h.advance(60_000);
	expect((await takeStart(h.app, "192.0.2.10")).kind).toBe("free");
});

test("concurrent wrong tokens on two Apps admit exactly five failures before the shared block", async () => {
	const { h, peer } = await pair();
	const replies = await Promise.all(
		Array.from({ length: 30 }, (_, i) =>
			admit(i % 2 ? peer : h.app, {
				bearer: `cb_parallel${i}`,
				cookie: null,
				sameOrigin: false,
				localOwner: null,
				address: "192.0.2.10",
			}),
		),
	);
	expect(replies.filter((reply) => reply.kind === "refused")).toHaveLength(5);
	expect(replies.filter((reply) => reply.kind === "limited")).toHaveLength(25);
});

test("a success observed before another App's block cannot clear that newer block", async () => {
	const { h, peer } = await pair();
	const { limiterOf } = await import("../src/server/identity/attempts.ts");
	const first = limiterOf(h.app);
	const second = limiterOf(peer);
	const before = await first.check(["account:shared"], h.app.now());
	for (let i = 0; i < 5; i++) await second.failed(["account:shared"], h.app.now());
	await first.succeeded(["account:shared"], before.version);
	expect((await second.check(["account:shared"], h.app.now())).kind).toBe("blocked");
});

test("saturated anonymous admission connections leave project writes, sign-out and revocation available", async () => {
	const { h } = await pair();
	const token = await createToken(h.app, {
		actor: "reader",
		kind: "human",
		can: ["read"],
		project: 0,
		label: "shared",
	});
	const opening = await signInWithToken(h.app, token.secret, { userAgent: null, address: null });
	if (opening.kind !== "opening") throw new Error("no session");
	const signed = await opening.signedIn;
	if (!signed) throw new Error("no session");
	const release = Promise.withResolvers<void>();
	const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
	const holds: Promise<void>[] = [];
	for (const barrier of entered)
		holds.push(
			h.app.database.admission(async () => {
				barrier.resolve();
				await release.promise;
			}),
		);
	await Promise.all(entered.map((barrier) => barrier.promise));
	const { limiterOf } = await import("../src/server/identity/attempts.ts");
	const guesses = Array.from({ length: 32 }, (_, i) => limiterOf(h.app).check([`account:flood-${i}`], h.app.now()));
	try {
		await h.call("propose", { edits: [{ op: "create", outline: "Independent writer" }] });
		const { signOut } = await import("../src/server/identity/identity.ts");
		await signOut(h.app, signed.cookie);
		await h.call("admin", { do: "token.revoke", id: token.id });
		expect(await findSession(h.app, hashToken(signed.cookie))).toBeNull();
	} finally {
		release.resolve();
		await Promise.all([...holds, ...guesses]);
	}
});

test("failed source addresses share their block even when every guessed token prefix differs", async () => {
	const { h, peer } = await pair();
	const facts = { cookie: null, sameOrigin: false, localOwner: null, address: "192.0.2.10" };
	for (let i = 0; i < 5; i++)
		expect((await admit(h.app, { ...facts, bearer: `cb_${i}different-prefix` })).kind).toBe("refused");
	expect(await admit(peer, { ...facts, bearer: "cb_unrelated-token-prefix" })).toEqual({
		kind: "limited",
		retryAfter: 1,
	});
});

test("the session idle check grants no minute of grace for an unpersisted use", async () => {
	const { h, peer } = await pair();
	h.app.config.sessionIdleMs = 120_000;
	const token = await createToken(h.app, {
		actor: "reader",
		kind: "human",
		can: ["read"],
		project: 0,
		label: "shared",
	});
	const opening = await signInWithToken(h.app, token.secret, { userAgent: null, address: null });
	if (opening.kind !== "opening") throw new Error("no session");
	const signed = await opening.signedIn;
	if (!signed) throw new Error("no session");
	h.advance(59_999);
	expect(
		(await admit(h.app, { bearer: null, cookie: signed.cookie, sameOrigin: true, localOwner: null, address: null }))
			.kind,
	).toBe("admitted");
	h.advance(60_001);
	expect(await findSession(peer, hashToken(signed.cookie))).toBeNull();
});
