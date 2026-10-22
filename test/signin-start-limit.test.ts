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

test.each(starts)("$name begins consume the shared address limit before concurrent allocations", async (start) => {
	const idp = await provider();
	const w = world({ oidc: idp.config(), proxied: true });
	const replies = await Promise.all(Array.from({ length: 8 }, () => w.post(start.path, start.body, client)));
	expect(replies.filter((reply) => reply.status === 200)).toHaveLength(5);
	const blocked = replies.filter((reply) => reply.status !== 200);
	expect(blocked.map(said)).toEqual(Array(3).fill("429 limited, retry after 1"));
	expect(blocked.every((reply) => reply.setCookies.length === 0)).toBe(true);
	for (const alternate of starts)
		expect(said(await w.post(alternate.path, alternate.body, client))).toBe("429 limited, retry after 1");
	expect(said(await w.get("/api/session", { ...client, authorization: "Bearer not-a-token" }))).toBe(
		"429 limited, retry after 1",
	);
	expect(said(await w.post(start.path, start.body, other))).toBe("200");
	w.clock.advance(1000);
	expect(said(await w.post(start.path, start.body, client))).toBe("200");
	expect(said(await w.post(start.path, start.body, client))).toBe("429 limited, retry after 2");
});

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

test("invitation challenges cannot bypass the start limit and untrusted address headers do not create counts", async () => {
	const w = world({ proxied: true });
	const { code } = await invite(w, { name: "robin", project: "scratch", can: ["read"] });
	for (let count = 0; count < 5; count++)
		expect(said(await w.post("/api/login/challenge", { invitation: code }, client))).toBe("200");
	expect(said(await w.post("/api/login/challenge", { invitation: code }, client))).toBe("429 limited, retry after 1");
	expect(said(await w.post("/api/login/challenge", { invitation: code }, other))).toBe("200");
	const direct = world();
	for (let count = 0; count < 8; count++)
		expect(said(await direct.post("/api/login/challenge", {}, client))).toBe("200");
});
