import { afterEach, expect, test } from "bun:test";
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
const client = from("203.0.113.10");
const other = from("203.0.113.11");
const PASSWORD = "correct horse battery staple";

test.each(["passkey", "provider"])(
	"one client's IPv6 /58 spread cannot evict a pending %s ceremony",
	async (kind) => {
		const idp = await provider();
		const w = world({ oidc: idp.config(), proxied: true });
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
		expect(admitted).toBe(999);
	},
	15_000,
);

test("a start block reports attempts without claiming that authentication failed", async () => {
	const w = world({ proxied: true });
	for (let count = 0; count < 300; count++) expect((await w.post("/api/login/challenge", {}, client)).status).toBe(200);
	const blocked = await w.post("/api/login/challenge", {}, client);
	expect(blocked.body).toEqual({
		ok: false,
		error: { code: "limited", message: "too many attempts; try again in 60 seconds" },
	});
});

test("ordinary use A: five cancelled passkey prompts never block the right password", async () => {
	const w = world({ proxied: true });
	await joined(w, "robin", PASSWORD);
	for (let n = 0; n < 5; n++) expect(said(await w.post("/api/login/challenge", {}, client))).toBe("200");
	expect(said(await signIn(w, "robin", PASSWORD, client))).toBe("200");
});

test("ordinary use B: 20 office colleagues starting 45 seconds apart never wait or block a password", async () => {
	const idp = await provider();
	const w = world({ oidc: idp.config(), proxied: true });
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
	const w = world({ proxied: true });
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
	const w = world({ proxied: true });
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
		const w = world({ oidc: idp.config(), proxied: true });
		await joined(w, "robin", PASSWORD);
		const replies = [];
		for (let count = 0; count < 303; count += 32)
			replies.push(
				...(await Promise.all(
					Array.from({ length: Math.min(32, 303 - count) }, () => w.post(start.path, start.body, client)),
				)),
			);
		expect(replies.filter((reply) => reply.status === 200)).toHaveLength(300);
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
		for (let count = 0; count < 300; count++) expect(said(await w.post(start.path, start.body, client))).toBe("200");
		expect(said(await w.post(start.path, start.body, client))).toBe("429 limited, retry after 60");
	},
);

async function flood(w: World, path: string, body: Record<string, unknown>) {
	const statuses = new Set<number>();
	for (let count = 0; count < 10_000; count++) statuses.add((await w.post(path, body, client)).status);
	return statuses;
}

test("a pending provider ceremony survives another address's 10,000 begins", async () => {
	const idp = await provider();
	const w = world({ oidc: idp.config(), proxied: true });
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
	const w = world({ proxied: true });
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

test("valid invitation reloads reuse their challenge and untrusted headers do not create counts", async () => {
	const w = world({ proxied: true });
	const { code } = await invite(w, { name: "robin", project: "scratch", can: ["read"] });
	const first = must(
		await w.post<{ passkey: RegistrationOptions }>("/api/login/challenge", { invitation: code }, client),
	);
	for (let count = 0; count < 10_000; count++) {
		const next = must(
			await w.post<{ passkey: RegistrationOptions }>("/api/login/challenge", { invitation: code }, client),
		);
		expect(next.passkey.challenge).toBe(first.passkey.challenge);
	}
	expect(said(await w.post("/api/login/challenge", { invitation: code }, other))).toBe("200");
	const direct = world();
	for (let count = 0; count < 303; count++)
		expect(said(await direct.post("/api/login/challenge", {}, client))).toBe("200");
}, 15_000);
