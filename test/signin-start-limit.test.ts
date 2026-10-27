import { afterEach, expect, spyOn, test } from "bun:test";
import { startAddressKey } from "../src/server/identity/limiter.ts";
import type { AssertionOptions, RegistrationOptions } from "../src/server/identity/webauthn.ts";
import { provider, stopProviders } from "./oidc-support.ts";
import {
	authenticator,
	cleanUp,
	from,
	invite,
	joined,
	must,
	PUBLIC,
	said,
	sha256,
	signIn,
	type World,
	world,
} from "./people-support.ts";

afterEach(async () => {
	stopProviders();
	await cleanUp();
});

const starts = [
	{ name: "web OIDC", path: "/api/login/oidc", body: {} },
	{
		name: "native OIDC",
		path: "/api/login/oidc/native",
		body: {
			challenge: "a".repeat(43),
			state: "b".repeat(43),
			callback: "com.mainworthy.app://signin/oidc",
			instance: PUBLIC,
		},
	},
	{ name: "web passkey", path: "/api/login/challenge", body: {} },
	{ name: "native passkey", path: "/api/login/challenge", body: { native: true } },
];
const CLIENT = "203.0.113.10";
const client = from(CLIENT);
const other = from("203.0.113.11");
const PASSWORD = "correct horse battery staple";

test("unavailable passkey options do not charge a source that later has working options", async () => {
	for (const native of [false, true]) {
		const w = await world({ proxied: true, publicUrl: native ? "http://localhost" : null });
		const body = native ? { native: true } : {};
		for (let count = 0; count < 301; count++)
			expect((await w.post("/api/login/challenge", body, client)).status).toBe(400);
		w.instance.app.config.publicUrl = PUBLIC;
		expect(said(await w.post("/api/login/challenge", body, client))).toBe("200");
	}
});

test("unreachable providers do not charge starts, and proven linking and invitations bypass anonymous limits", async () => {
	const stopped = await provider();
	stopped.stop();
	const w = await world({ oidc: stopped.config(), proxied: true });
	const warning = spyOn(console, "warn").mockImplementation(() => {});
	try {
		for (let count = 0; count < 301; count++) expect((await w.post("/api/login/oidc", {}, client)).status).toBe(409);
	} finally {
		warning.mockRestore();
	}
	const live = await provider();
	w.instance.app.config.oidc = live.config();
	expect(said(await w.post("/api/login/oidc", {}, client))).toBe("200");
	const cookie = await joined(w, "robin", PASSWORD);
	for (let count = 0; count < 299; count++) await w.post("/api/login/challenge", {}, client);
	expect((await w.post("/api/login/oidc", {}, client)).status).toBe(429);
	expect(said(await w.post("/api/login/oidc", { link: true }, { ...client, cookie }))).toBe("200");
	const { code } = await invite(w, { name: "sam" });
	expect(said(await w.post("/api/login/oidc", { invitation: code }, client))).toBe("200");
});

test("G3: a subscriber's /58 burst cannot refuse unrelated starts in any protocol", async () => {
	const idp = await provider();
	const w = await world({ oidc: idp.config(), proxied: true });
	const { code } = await invite(w, { name: "robin" });
	for (let net = 0; net < 34; net++)
		for (let count = 0; count < 300; count += 30)
			await Promise.all(
				Array.from({ length: 30 }, () =>
					w.post("/api/login/challenge", { native: true }, from(`2001:db8:0:${net.toString(16)}::1`)),
				),
			);
	for (const start of starts) expect(said(await w.post(start.path, start.body, other))).toBe("200");
	expect(said(await w.post("/api/login/oidc", { invitation: code }, other))).toBe("200");
}, 30_000);

test("G4: four /64s refilling every minute cannot deny another person's starts for ten minutes", async () => {
	const idp = await provider();
	const w = await world({ oidc: idp.config(), proxied: true });
	const subscriber = (net: number) => from(`2001:db8:0:${net}::1`);
	const owner = sha256(startAddressKey("2001:db8:0:0::1") ?? "");
	const held: number[] = [];
	const outcomes: string[] = [];
	for (let minute = 0; minute < 10; minute++) {
		// One begin opens the /56's window and makes a real ceremony. Copies of that ceremony and the window's count
		// stand for the other 299 begins it is allowed this minute, which the fixed-window tests admit one by one.
		expect(said(await w.post("/api/login/challenge", { native: true }, subscriber(minute % 4)))).toBe("200");
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
		await used(w, "2001:db8:0:0::1", 300);
		const refused = await Promise.all(
			[0, 1, 2, 3].map((net) => w.post("/api/login/challenge", { native: true }, subscriber(net))),
		);
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

test.each(["passkey", "provider"])(
	"G1: the shared %s cap refuses new ceremonies and preserves pending proofs",
	async (kind) => {
		const idp = await provider();
		const w = await world({ oidc: idp.config(), proxied: true });
		const { code } = await invite(w, { name: "robin" });
		const complete = await (async () => {
			if (kind === "passkey") {
				const device = authenticator();
				const registration = must(
					await w.post<{ passkey: RegistrationOptions }>("/api/login/challenge", { invitation: code }, other),
				);
				await w.post("/api/login", { invitation: code, passkey: device.register(registration.passkey) }, other);
				const pending = await w.post<{ passkey: AssertionOptions }>("/api/login/challenge", {}, other);
				return () =>
					w.post("/api/login", { passkey: device.assert(must(pending).passkey) }, { ...other, cookie: pending.cookie });
			}
			const pending = await w.post<{ url: string }>("/api/login/oidc", { invitation: code }, other);
			idp.next({ subject: "sub-robin" });
			const authorized = await fetch(must(pending).url, { redirect: "manual" });
			const query = new URL(authorized.headers.get("location") ?? "").search;
			await authorized.text();
			return () => w.post("/api/login", { oidc: query }, { ...other, cookie: pending.cookie });
		})();
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
				w.post(
					kind === "passkey" ? "/api/login/challenge" : "/api/login/oidc",
					kind === "passkey" ? { native: true } : {},
					from(`2001:db8:${prefix.toString(16)}::1`),
				),
			),
		);
		expect(replies.filter((reply) => reply.status === 200)).toHaveLength(1);
		expect(replies.filter((reply) => reply.status === 503)).toHaveLength(29);
		for (const start of starts) {
			const full = kind === "passkey" ? start.path.includes("challenge") : start.path.includes("oidc");
			expect(said(await w.post(start.path, start.body, other))).toBe(full ? "503 busy" : "200");
		}
		w.clock.advance(10_000);
		expect(said(await complete())).toBe("200");
		expect(said(await w.post(kind === "passkey" ? "/api/login/challenge" : "/api/login/oidc", {}, other))).toBe("200");
	},
	20_000,
);

test.each(["passkey", "provider"])(
	"one client's IPv6 /58 spread cannot evict a pending %s ceremony",
	async (kind) => {
		const idp = await provider();
		const w = await world({ oidc: idp.config(), proxied: true });
		const { code } = await invite(w, { name: "robin" });
		const complete = await (async () => {
			if (kind === "passkey") {
				const device = authenticator();
				const registration = must(
					await w.post<{ passkey: RegistrationOptions }>("/api/login/challenge", { invitation: code }, other),
				);
				expect(
					said(await w.post("/api/login", { invitation: code, passkey: device.register(registration.passkey) }, other)),
				).toBe("200");
				const pending = await w.post<{ passkey: AssertionOptions }>("/api/login/challenge", {}, other);
				return () =>
					w.post("/api/login", { passkey: device.assert(must(pending).passkey) }, { ...other, cookie: pending.cookie });
			}
			const pending = await w.post<{ url: string }>("/api/login/oidc", { invitation: code }, other);
			idp.next({ subject: "sub-robin" });
			const authorized = await fetch(must(pending).url, { redirect: "manual" });
			const query = new URL(authorized.headers.get("location") ?? "").search;
			await authorized.text();
			return () => w.post("/api/login", { oidc: query }, { ...other, cookie: pending.cookie });
		})();
		let admitted = 0;
		for (let net = 0; net < 34; net++) {
			const address = from(`2001:db8:0:${(net + 1).toString(16)}::1`);
			for (let count = 0; count < 300; count += 30) {
				const replies = await Promise.all(
					Array.from({ length: 30 }, () =>
						w.post(
							kind === "passkey" ? "/api/login/challenge" : "/api/login/oidc",
							kind === "passkey" ? { native: true } : {},
							address,
						),
					),
				);
				admitted += replies.filter((reply) => reply.status === 200).length;
			}
		}
		expect(said(await complete())).toBe("200");
		expect(admitted).toBe(300);
	},
	15_000,
);

test("a start block reports attempts without claiming that authentication failed", async () => {
	const w = await world({ proxied: true });
	for (let count = 0; count < 300; count++) expect((await w.post("/api/login/challenge", {}, client)).status).toBe(200);
	const blocked = await w.post("/api/login/challenge", {}, client);
	expect(blocked.body).toEqual({
		ok: false,
		error: { code: "limited", message: "too many attempts; try again in 60 seconds" },
	});
	// The App's own ceiling refused it before the shared count, which would have stored 301, was touched.
	expect(await stored(w, CLIENT)).toBe(300);
});

test("one source cannot exhaust another source's allowance, including unknown peers", async () => {
	const idp = await provider();
	const w = await world({ oidc: idp.config(), proxied: true });
	await joined(w, "robin", PASSWORD);
	for (let count = 0; count < 300; count++) expect((await w.post("/api/login/challenge", {}, client)).status).toBe(200);
	for (const start of starts) {
		expect(said(await w.post(start.path, start.body, client))).toBe("429 limited, retry after 60");
		expect(said(await w.post(start.path, start.body, other))).toBe("200");
		expect(said(await w.post(start.path, start.body))).toBe("200");
	}
	expect(said(await signIn(w, "robin", PASSWORD, client))).toBe("200");
	w.clock.advance(30_000);
	expect(said(await w.post("/api/login/challenge", {}, client))).toBe("429 limited, retry after 30");
	w.clock.advance(30_000);
	expect(said(await w.post("/api/login/challenge", {}, client))).toBe("200");
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
		const w = await world({ oidc: idp.config({ issuer: `http://127.0.0.1:${proxy.port}` }), proxied: true });
		const pending = w.post("/api/login/oidc", {}, client);
		await discovery;
		w.clock.advance(300_000);
		release();
		const expired = await pending;
		expect(expired.status).toBe(409);
		expect(expired.setCookies).toEqual([]);
		expect((await w.post("/api/login/oidc", {}, client)).status).toBe(200);
	} finally {
		release();
		await proxy.stop(true);
	}
});

test("ordinary use A: five cancelled passkey prompts never block the right password", async () => {
	const w = await world({ proxied: true });
	await joined(w, "robin", PASSWORD);
	for (let n = 0; n < 5; n++) expect(said(await w.post("/api/login/challenge", {}, client))).toBe("200");
	expect(said(await signIn(w, "robin", PASSWORD, client))).toBe("200");
});

test("ordinary use B: 20 office colleagues starting 45 seconds apart never wait or block a password", async () => {
	const idp = await provider();
	const w = await world({ oidc: idp.config(), proxied: true });
	await joined(w, "robin", PASSWORD);
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
	expect(said(await signIn(w, "robin", PASSWORD, client))).toBe("200");
});

test("invitation page stays reachable with password and passkey acceptance during an anonymous-start block", async () => {
	const w = await world({ proxied: true });
	const passwordInvite = await invite(w, { name: "robin" });
	const passkeyInvite = await invite(w, { name: "sam" });
	await flood(w, "/api/login/challenge", {});
	expect((await w.post("/api/login/challenge", {}, client)).status).toBe(429);
	const passwordPage = await w.post("/api/login/challenge", { invitation: passwordInvite.code }, client);
	expect(said(passwordPage)).toBe("200");
	expect(said(await w.post("/api/login", { invitation: passwordInvite.code, password: PASSWORD }, client))).toBe("200");
	const passkeyPage = await w.post<{ passkey: RegistrationOptions }>(
		"/api/login/challenge",
		{ invitation: passkeyInvite.code },
		client,
	);
	expect(said(passkeyPage)).toBe("200");
	expect(
		said(
			await w.post(
				"/api/login",
				{ invitation: passkeyInvite.code, passkey: authenticator().register(must(passkeyPage).passkey) },
				client,
			),
		),
	).toBe("200");
}, 15_000);

test("invitation reuse reports remaining lifetime and a successor preserves each tab's original deadline", async () => {
	const w = await world({ proxied: true });
	const { code } = await invite(w, { name: "robin" });
	const page = async () =>
		must(await w.post<{ passkey: RegistrationOptions }>("/api/login/challenge", { invitation: code }, client)).passkey;
	const first = await page();
	w.clock.advance(180_000);
	const reused = await page();
	expect(reused.challenge).toBe(first.challenge);
	expect(reused.timeout).toBe(120_000);
	w.clock.advance(60_000);
	const successor = await page();
	expect(successor.challenge).not.toBe(first.challenge);
	expect(successor.timeout).toBe(300_000);
	expect(said(await w.post("/api/login", { invitation: code, passkey: authenticator().register(first) }, client))).toBe(
		"200",
	);

	const second = await invite(w, { name: "sam" });
	const offer = async () =>
		must(await w.post<{ passkey: RegistrationOptions }>("/api/login/challenge", { invitation: second.code }, client))
			.passkey;
	const expired = await offer();
	w.clock.advance(240_000);
	const fresh = await offer();
	w.clock.advance(60_000);
	expect(
		said(await w.post("/api/login", { invitation: second.code, passkey: authenticator().register(expired) }, client)),
	).toBe("401 unauthenticated");
	expect(
		said(await w.post("/api/login", { invitation: second.code, passkey: authenticator().register(fresh) }, client)),
	).toBe("200");
});

test.each(starts)(
	"$name begins share a fixed allocation window independent of failed authentication",
	async (start) => {
		const idp = await provider();
		const w = await world({ oidc: idp.config(), proxied: true });
		await joined(w, "robin", PASSWORD);
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
		expect(said(await signIn(w, "robin", PASSWORD, client))).toBe("200");
		expect(said(await w.post(start.path, start.body, client))).toBe("429 limited, retry after 30");
		expect(said(await w.post(start.path, start.body, other))).toBe("200");
		w.clock.advance(30_000);
		expect(said(await w.post(start.path, start.body, client))).toBe("200");
		// A new window starts from this one begin, so all 300 of it are left to give.
		expect(await stored(w, CLIENT)).toBe(1);
		await used(w, CLIENT, 299);
		expect(said(await w.post(start.path, start.body, client))).toBe("200");
		expect(said(await w.post(start.path, start.body, client))).toBe("429 limited, retry after 60");
	},
);

/**
 * Sets the count of `address`'s start window, opening it now when it has none, as G1 fills the ceremonies
 * directly: what a test gives this way costs no requests, and real begins then cross the window's boundary.
 */
async function used(w: World, address: string, count: number): Promise<void> {
	await w.instance.app.database.write((db) =>
		db.transaction(() =>
			db.runDynamic(
				"INSERT INTO identity_starts (key,since,count) VALUES ($1,$2,$3) ON CONFLICT(key) DO UPDATE SET count = excluded.count",
				[sha256(startAddressKey(address) ?? ""), w.clock.now(), count],
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

async function flood(w: World, path: string, body: Record<string, unknown>) {
	const statuses = new Set<number>();
	for (let count = 0; count < 10_000; count += 32) {
		const replies = await Promise.all(
			Array.from({ length: Math.min(32, 10_000 - count) }, () => w.post(path, body, client)),
		);
		for (const reply of replies) statuses.add(reply.status);
	}
	return statuses;
}

test("a pending provider ceremony survives another address's 10,000 begins", async () => {
	const idp = await provider();
	const w = await world({ oidc: idp.config(), proxied: true });
	const { code } = await invite(w, { name: "robin", project: "scratch", can: ["read"] });
	const pending = await w.post<{ url: string }>("/api/login/oidc", { invitation: code }, other);
	idp.next({ subject: "sub-robin" });
	const authorized = await fetch(must(pending).url, { redirect: "manual" });
	const query = new URL(authorized.headers.get("location") ?? "").search;
	await authorized.text();
	const statuses = await flood(w, "/api/login/oidc", {});
	expect(said(await w.post("/api/login", { oidc: query }, { ...other, cookie: pending.cookie }))).toBe("200");
	expect(statuses).toEqual(new Set([200, 429]));
}, 15_000);

test("a pending passkey challenge survives another address's 10,000 challenges", async () => {
	const w = await world({ proxied: true });
	const { code } = await invite(w, { name: "robin", project: "scratch", can: ["read"] });
	const device = authenticator();
	const registration = must(
		await w.post<{ passkey: RegistrationOptions }>("/api/login/challenge", { invitation: code }, other),
	);
	expect(
		said(await w.post("/api/login", { invitation: code, passkey: device.register(registration.passkey) }, other)),
	).toBe("200");
	const pending = await w.post<{ passkey: AssertionOptions }>("/api/login/challenge", {}, other);
	const statuses = await flood(w, "/api/login/challenge", { native: true });
	expect(
		said(
			await w.post(
				"/api/login",
				{ passkey: device.assert(must(pending).passkey) },
				{ ...other, cookie: pending.cookie },
			),
		),
	).toBe("200");
	expect(statuses).toEqual(new Set([200, 429]));
}, 15_000);

test("valid invitation reloads reuse their challenge at full capacity and untrusted headers do not create counts", async () => {
	const w = await world({ proxied: true });
	const { code } = await invite(w, { name: "robin", project: "scratch", can: ["read"] });
	const first = must(
		await w.post<{ passkey: RegistrationOptions }>("/api/login/challenge", { invitation: code }, client),
	);
	await w.instance.app.database.write((db) =>
		db.transaction(() =>
			db.runDynamic(`INSERT INTO identity_ceremonies (kind,key,owner,deadline,generation,payload)
SELECT kind,'fixture-' || n,'unrelated-owner',deadline,generation,payload
FROM identity_ceremonies CROSS JOIN generate_series(1,9999) n`),
		),
	);
	// Exceed the anonymous start allowance while no ceremony slot remains to hide an allocation.
	for (let count = 0; count < 301; count += 32) {
		const replies = await Promise.all(
			Array.from({ length: Math.min(32, 301 - count) }, () =>
				w.post<{ passkey: RegistrationOptions }>("/api/login/challenge", { invitation: code }, client),
			),
		);
		for (const reply of replies) expect(must(reply).passkey.challenge).toBe(first.passkey.challenge);
	}
	expect(await w.rows("SELECT count(*)::integer AS count FROM identity_ceremonies")).toEqual([{ count: 10_000 }]);
	expect(said(await w.post("/api/login/challenge", { invitation: code }, other))).toBe("200");
	const direct = await world();
	for (let count = 0; count < 303; count++)
		expect(said(await direct.post("/api/login/challenge", {}, client))).toBe("200");
}, 15_000);
