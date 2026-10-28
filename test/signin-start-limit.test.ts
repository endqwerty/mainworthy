// The begins of a sign-in through the provider are limited by where they come from: each address, and each IPv6
// network it is part of, gets 300 a minute, counted on this App and in the database every instance shares. A
// begin that was refused, or never made a ceremony, costs nothing; a ceremony of an invitation, of linking or of
// proof is never an anonymous begin; and a pending ceremony survives a flood of other people's begins.
import { afterEach, expect, spyOn, test } from "bun:test";
import { localStarts } from "../src/server/identity/attempts.ts";
import { startAddressKey } from "../src/server/identity/limiter.ts";
import { provider } from "./oidc-support.ts";
import {
	authorize,
	begin,
	cleanUp,
	finish,
	from,
	invite,
	jar,
	joined,
	prove,
	type Sent,
	said,
	sha256,
	subjectOf,
	TOKEN,
	type World,
	world,
} from "./people-support.ts";

afterEach(async () => {
	await cleanUp();
});

const starts = [{ name: "provider", path: "/api/login/oidc", body: {} }];
const CLIENT = "203.0.113.10";
const client = from(CLIENT);
const other = from("203.0.113.11");

/** Signs in through the provider as `name`, every request from where `headers` say. */
async function signInFrom(w: World, name: string, headers: Sent) {
	const begun = await begin(w, {}, headers);
	const query = await authorize(w, begun, { subject: subjectOf(name) });
	return finish(w, query, { ...headers, ...jar(begun.ceremony) });
}

/** A ceremony begun from `other` and answered at the provider: what finishes it, and nothing sent yet. */
async function pending(w: World, body: Record<string, unknown>, name: string) {
	const begun = await begin(w, body, other);
	const query = await authorize(w, begun, { subject: subjectOf(name) });
	return () => finish(w, query, { ...other, ...jar(begun.ceremony) });
}

/** The token's sign-in from `headers`: the way in that a start block leaves open. */
const tokenFrom = (w: World, headers: Sent) => w.post("/api/login", { token: TOKEN }, headers);

test("begins on an instance with no provider do not charge a source that later has one", async () => {
	const w = await world({ idp: null, proxied: true });
	await used(w, CLIENT, 299);
	for (let count = 0; count < 3; count++) expect((await w.post("/api/login/oidc", {}, client)).status).toBe(400);
	expect(await stored(w, CLIENT)).toBe(299);
	w.instance.app.config.oidc = (await provider()).config();
	expect(said(await w.post("/api/login/oidc", {}, client))).toBe("200");
	expect(said(await w.post("/api/login/oidc", {}, client))).toBe("429 limited, retry after 60");
});

test("unreachable providers do not charge starts, and invitations, linking and proof bypass anonymous limits", async () => {
	const stopped = await provider();
	stopped.stop();
	const w = await world({ idp: stopped, proxied: true });
	await used(w, CLIENT, 299);
	const warning = spyOn(console, "warn").mockImplementation(() => {});
	try {
		for (let count = 0; count < 3; count++) expect((await w.post("/api/login/oidc", {}, client)).status).toBe(409);
	} finally {
		warning.mockRestore();
	}
	expect(await stored(w, CLIENT)).toBe(299);
	const live = await provider();
	w.idp = live;
	w.instance.app.config.oidc = live.config();
	expect(said(await w.post("/api/login/oidc", {}, client))).toBe("200");
	const cookie = await joined(w, "robin");
	expect((await w.post("/api/login/oidc", {}, client)).status).toBe(429);
	expect(said(await w.post("/api/login/oidc", { proof: true }, { ...client, ...jar(cookie) }))).toBe("200");
	expect(said(await prove(w, cookie, "robin"))).toBe("200");
	expect(said(await w.post("/api/login/oidc", { link: true }, { ...client, ...jar(cookie) }))).toBe("200");
	const { code } = await invite(w, { name: "sam" });
	expect(said(await w.post("/api/login/oidc", { invitation: code }, client))).toBe("200");
});

test("G3: a subscriber's /58 burst cannot refuse unrelated starts", async () => {
	const w = await world({ proxied: true });
	const { code } = await invite(w, { name: "robin" });
	const subscriber = (net: number) => from(`2001:db8:0:${net.toString(16)}::1`);
	// The subscriber's first 290 begins this minute and everyone else's ceremonies leave 20 of the 10,000
	// provider slots, so a burst that each /64 could take 300 of would fill them and refuse the next person.
	expect(said(await w.post("/api/login/oidc", {}, subscriber(0)))).toBe("200");
	await padded(w, "oidc", 9_980);
	await used(w, "2001:db8:0:0::1", 289);
	const burst = await Promise.all(
		Array.from({ length: 34 }, (_, net) => w.post("/api/login/oidc", {}, subscriber(net))),
	);
	expect(burst.filter((reply) => reply.status === 200)).toHaveLength(10);
	expect(burst.filter((reply) => reply.status !== 200).map(said)).toEqual(
		Array(24).fill("429 limited, retry after 60"),
	);
	for (const start of starts) expect(said(await w.post(start.path, start.body, other))).toBe("200");
	expect(said(await w.post("/api/login/oidc", { invitation: code }, other))).toBe("200");
});

test("G4: four /64s refilling every minute cannot deny another person's starts for ten minutes", async () => {
	const w = await world({ proxied: true });
	const subscriber = (net: number) => from(`2001:db8:0:${net}::1`);
	const owner = sha256(startAddressKey("2001:db8:0:0::1") ?? "");
	const held: number[] = [];
	const outcomes: string[] = [];
	for (let minute = 0; minute < 10; minute++) {
		// One begin opens the /56's window and makes a real ceremony. Copies of that ceremony and the window's count
		// stand for the other 299 begins it is allowed this minute, which the fixed-window tests admit one by one.
		expect(said(await w.post("/api/login/oidc", {}, subscriber(minute % 4)))).toBe("200");
		await w.instance.app.database.write((db) =>
			db.transaction(() =>
				db.runDynamic(
					`INSERT INTO identity_ceremonies (kind,key,owner,deadline,generation,payload)
SELECT kind,key || '-' || n,owner,deadline,generation,payload
FROM (SELECT * FROM identity_ceremonies WHERE owner = $1 ORDER BY deadline DESC LIMIT 1) newest
CROSS JOIN generate_series(1,299) n`,
					[owner],
				),
			),
		);
		await used(w, "2001:db8:0:0::1", 299);
		const refused = await Promise.all([0, 1, 2, 3].map((net) => w.post("/api/login/oidc", {}, subscriber(net))));
		expect(refused.map(said)).toEqual(Array(4).fill("429 limited, retry after 60"));
		for (const start of starts) outcomes.push(said(await w.post(start.path, start.body, other)));
		held.push(
			(
				await w.rows<{ count: number }>(
					`SELECT count(*)::integer AS count FROM identity_ceremonies WHERE owner = '${owner}'`,
				)
			)[0]?.count ?? 0,
		);
		w.clock.advance(60_000);
	}
	// A ceremony's slot is free again after five minutes, so the subscriber's share of the 10,000 levels off.
	expect(held).toEqual([300, 600, 900, 1200, 1500, 1500, 1500, 1500, 1500, 1500]);
	expect(outcomes).toEqual(Array(10 * starts.length).fill("200"));
});

test("G1: the shared provider cap refuses new ceremonies and preserves pending ones", async () => {
	const w = await world({ proxied: true });
	const { code } = await invite(w, { name: "robin" });
	const complete = await pending(w, { invitation: code }, "robin");
	// Fill existing pending state directly; HTTP contenders exercise the exact admission boundary.
	await w.instance.app.database.write((db) =>
		db.transaction(() =>
			db.runDynamic(
				`INSERT INTO identity_ceremonies (kind,key,owner,deadline,generation,payload)
SELECT kind,'fixture-' || n,owner,deadline,generation,payload
FROM identity_ceremonies CROSS JOIN generate_series(1,9998) n`,
			),
		),
	);
	const replies = await Promise.all(
		Array.from({ length: 30 }, (_, prefix) =>
			w.post("/api/login/oidc", {}, from(`2001:db8:${prefix.toString(16)}::1`)),
		),
	);
	expect(replies.filter((reply) => reply.status === 200)).toHaveLength(1);
	expect(replies.filter((reply) => reply.status === 503)).toHaveLength(29);
	for (const start of starts) expect(said(await w.post(start.path, start.body, other))).toBe("503 busy");
	w.clock.advance(10_000);
	expect(said(await complete())).toBe("200");
	expect(said(await w.post("/api/login/oidc", {}, other))).toBe("200");
}, 20_000);

test("one client's IPv6 /58 spread cannot evict a pending provider ceremony", async () => {
	const w = await world({ proxied: true });
	const { code } = await invite(w, { name: "robin" });
	const complete = await pending(w, { invitation: code }, "robin");
	// The /56 has 10 begins left this minute; one from each of 34 /64s in it share them.
	await used(w, "2001:db8:0:1::1", 290);
	const replies = await Promise.all(
		Array.from({ length: 34 }, (_, net) =>
			w.post("/api/login/oidc", {}, from(`2001:db8:0:${(net + 1).toString(16)}::1`)),
		),
	);
	expect(said(await complete())).toBe("200");
	expect(replies.filter((reply) => reply.status === 200)).toHaveLength(10);
	expect(replies.filter((reply) => reply.status !== 200).map(said)).toEqual(
		Array(24).fill("429 limited, retry after 60"),
	);
});

test("a start block reports attempts without claiming that authentication failed", async () => {
	const w = await world({ proxied: true });
	await used(w, CLIENT, 299);
	expect(said(await w.post("/api/login/oidc", {}, client))).toBe("200");
	const blocked = await w.post("/api/login/oidc", {}, client);
	expect(blocked.body).toEqual({
		ok: false,
		error: { code: "limited", message: "too many attempts; try again in 60 seconds" },
	});
	// The App's own ceiling refused it before the shared count, which would have stored 301, was touched.
	expect(await stored(w, CLIENT)).toBe(300);
});

test("begins another instance admitted count against the same source here", async () => {
	const w = await world({ proxied: true });
	await usedElsewhere(w, CLIENT, 300);
	expect(said(await w.post("/api/login/oidc", {}, client))).toBe("429 limited, retry after 60");
	expect(said(await w.post("/api/login/oidc", {}, other))).toBe("200");
});

test("one source cannot exhaust another source's allowance, including unknown peers, nor stop a token", async () => {
	const w = await world({ proxied: true });
	await used(w, CLIENT, 300);
	for (const start of starts) {
		expect(said(await w.post(start.path, start.body, client))).toBe("429 limited, retry after 60");
		expect(said(await w.post(start.path, start.body, other))).toBe("200");
		expect(said(await w.post(start.path, start.body))).toBe("200");
	}
	expect(said(await tokenFrom(w, client))).toBe("200");
	w.clock.advance(30_000);
	expect(said(await w.post("/api/login/oidc", {}, client))).toBe("429 limited, retry after 30");
	w.clock.advance(30_000);
	expect(said(await w.post("/api/login/oidc", {}, client))).toBe("200");
});

test("provider discovery cannot extend an admitted ceremony beyond its original lifetime", async () => {
	const idp = await provider();
	let arrived = () => {};
	const discovery = new Promise<void>((resolve) => {
		arrived = resolve;
	});
	let release = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const proxy: ReturnType<typeof Bun.serve> = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(): Promise<Response> {
			arrived();
			await held;
			const metadata = await fetch(`${idp.issuer}/.well-known/openid-configuration`);
			return new Response((await metadata.text()).replaceAll(idp.issuer, `http://127.0.0.1:${proxy.port}`), {
				headers: { "content-type": "application/json" },
			});
		},
	});
	try {
		const w = await world({ idp, oidc: { issuer: `http://127.0.0.1:${proxy.port}` }, proxied: true });
		const waiting = w.post("/api/login/oidc", {}, client);
		await discovery;
		w.clock.advance(300_000);
		release();
		const expired = await waiting;
		expect(expired.status).toBe(409);
		expect(expired.setCookies).toEqual([]);
		expect((await w.post("/api/login/oidc", {}, client)).status).toBe(200);
	} finally {
		release();
		await proxy.stop(true);
	}
});

test("ordinary use A: five abandoned begins never block a sign-in through the provider", async () => {
	const w = await world({ proxied: true });
	await joined(w, "robin");
	for (let n = 0; n < 5; n++) expect(said(await w.post("/api/login/oidc", {}, client))).toBe("200");
	expect(said(await signInFrom(w, "robin", client))).toBe("200");
});

test("ordinary use B: 20 office colleagues starting 45 seconds apart never wait or block a sign-in", async () => {
	const w = await world({ proxied: true });
	await joined(w, "robin");
	const waits: number[] = [];
	for (let person = 0; person < 20; person++) {
		let reply = await w.post("/api/login/oidc", {}, client);
		let waited = 0;
		while (reply.status === 429) {
			const seconds = Number(reply.retryAfter);
			expect(seconds).toBeGreaterThan(0);
			waited += seconds;
			w.clock.advance(seconds * 1000);
			reply = await w.post("/api/login/oidc", {}, client);
		}
		expect(said(reply)).toBe("200");
		waits.push(waited);
		w.clock.advance(45_000);
	}
	expect(waits).toEqual(Array(20).fill(0));
	expect(said(await signInFrom(w, "robin", client))).toBe("200");
});

test("an invitation's page and its acceptance stay reachable during an anonymous-start block", async () => {
	const w = await world({ proxied: true });
	const { code } = await invite(w, { name: "robin" });
	await used(w, CLIENT, 300);
	expect((await w.post("/api/login/oidc", {}, client)).status).toBe(429);
	expect(said(await w.post("/api/login/invitation", { invitation: code }, client))).toBe("200");
	const begun = await begin(w, { invitation: code }, client);
	const query = await authorize(w, begun, { subject: subjectOf("robin") });
	expect(said(await finish(w, query, { ...client, ...jar(begun.ceremony) }))).toBe("200");
});

test("begins share a fixed allocation window independent of failed authentication", async () => {
	for (const start of starts) {
		const w = await world({ proxied: true });
		await used(w, CLIENT, 290);
		const replies = await Promise.all(Array.from({ length: 13 }, () => w.post(start.path, start.body, client)));
		expect(replies.filter((reply) => reply.status === 200)).toHaveLength(10);
		const blocked = replies.filter((reply) => reply.status !== 200);
		expect(blocked.map(said)).toEqual(Array(3).fill("429 limited, retry after 60"));
		expect(blocked.every((reply) => reply.setCookies.length === 0)).toBe(true);
		w.clock.advance(30_000);
		for (const alternate of starts)
			expect(said(await w.post(alternate.path, alternate.body, client))).toBe("429 limited, retry after 30");
		expect(said(await w.get("/api/session", { ...client, authorization: "Bearer not-a-token" }))).toBe(
			"401 unauthenticated",
		);
		expect(said(await tokenFrom(w, client))).toBe("200");
		expect(said(await w.post(start.path, start.body, client))).toBe("429 limited, retry after 30");
		expect(said(await w.post(start.path, start.body, other))).toBe("200");
		w.clock.advance(30_000);
		expect(said(await w.post(start.path, start.body, client))).toBe("200");
		// A new window starts from this one begin, so all 300 of it are left to give.
		expect(await stored(w, CLIENT)).toBe(1);
		await used(w, CLIENT, 298);
		expect(said(await w.post(start.path, start.body, client))).toBe("200");
		expect(said(await w.post(start.path, start.body, client))).toBe("429 limited, retry after 60");
	}
});

/**
 * Adds `count` begins to `address`'s start window now, in both places a real begin is counted: the App's own
 * ceiling and the shared count, each opening a new window as `takeStart` would. As G1 fills the ceremonies
 * directly, what a test gives this way costs no requests, and real begins then cross the window's boundary.
 */
async function used(w: World, address: string, count: number): Promise<void> {
	const ceiling = localStarts(w.instance.app);
	for (let n = 0; n < count; n++) ceiling(sha256(startAddressKey(address) ?? ""), w.clock.now());
	await usedElsewhere(w, address, count);
}

/** Adds `count` begins to the shared count alone, as another instance admitting them would. */
async function usedElsewhere(w: World, address: string, count: number): Promise<void> {
	const key = sha256(startAddressKey(address) ?? "");
	const now = w.clock.now();
	await w.instance.app.database.write((db) =>
		db.transaction(() =>
			db.runDynamic(
				`INSERT INTO identity_starts (key,since,count) VALUES ($1,$2,$3) ON CONFLICT(key) DO UPDATE SET
 since = CASE WHEN $2 >= identity_starts.since AND $2 < identity_starts.since + 60000 THEN identity_starts.since ELSE $2 END,
 count = CASE WHEN $2 >= identity_starts.since AND $2 < identity_starts.since + 60000 THEN identity_starts.count + $3 ELSE $3 END`,
				[key, now, count],
			),
		),
	);
}

/** The count the shared accounting holds for `address`'s window, or null when it holds none. */
async function stored(w: World, address: string): Promise<number | null> {
	const rows = await w.rows<{ count: number }>(
		`SELECT count::integer AS count FROM identity_starts WHERE key = '${sha256(startAddressKey(address) ?? "")}'`,
	);
	return rows[0]?.count ?? null;
}

/**
 * Fills the ceremonies of `kind` up to `total` with copies of one already held, as G1 fills the cap directly: the
 * other people's ceremonies a flood meets, without the requests that made them.
 */
async function padded(w: World, kind: string, total: number): Promise<void> {
	await w.instance.app.database.write((db) =>
		db.transaction(() =>
			db.runDynamic(
				`INSERT INTO identity_ceremonies (kind,key,owner,deadline,generation,payload)
SELECT kind,'fixture-' || n,'unrelated-owner',deadline,generation,payload
FROM (SELECT * FROM identity_ceremonies WHERE kind = $1 LIMIT 1) one
CROSS JOIN generate_series(1,$2 - (SELECT count(*) FROM identity_ceremonies WHERE kind = $1)) n`,
				[kind, total],
			),
		),
	);
}

/**
 * `client`'s flood of begins near a full cap: the end of its window and 32 more at once, with 20 ceremony slots
 * left. Without its 300 a minute, the flood would take all 20 and be refused as busy.
 */
async function flood(w: World, kind: string, path: string, body: Record<string, unknown>) {
	await padded(w, kind, 9_980);
	await used(w, CLIENT, 290);
	const replies = await Promise.all(Array.from({ length: 32 }, () => w.post(path, body, client)));
	return new Set(replies.map((reply) => reply.status));
}

test("a pending provider ceremony survives another address's flood of begins", async () => {
	const w = await world({ proxied: true });
	const { code } = await invite(w, { name: "robin", project: "scratch", can: ["read"] });
	const complete = await pending(w, { invitation: code }, "robin");
	const statuses = await flood(w, "oidc", "/api/login/oidc", {});
	expect(said(await complete())).toBe("200");
	expect(statuses).toEqual(new Set([200, 429]));
});

test("an invitation's page needs no ceremony slot or start allowance, and untrusted headers create no counts", async () => {
	const w = await world({ proxied: true });
	const { code } = await invite(w, { name: "robin", project: "scratch", can: ["read"] });
	expect(said(await w.post("/api/login/oidc", {}, other))).toBe("200");
	await padded(w, "oidc", 10_000);
	// Past the anonymous start allowance while no ceremony slot remains to hide an allocation.
	await used(w, CLIENT, 300);
	const replies = await Promise.all(
		Array.from({ length: 32 }, () => w.post("/api/login/invitation", { invitation: code }, client)),
	);
	expect(replies.map(said)).toEqual(Array(32).fill("200"));
	expect(await w.rows("SELECT count(*)::integer AS count FROM identity_ceremonies")).toEqual([{ count: 10_000 }]);
	// Without a named proxy the header is a stranger's claim: every begin is the server's own peer, never counted.
	const direct = await world();
	for (let count = 0; count < 3; count++) expect(said(await direct.post("/api/login/oidc", {}, client))).toBe("200");
	expect(await direct.rows("SELECT count(*)::integer AS count FROM identity_starts")).toEqual([{ count: 0 }]);
});
