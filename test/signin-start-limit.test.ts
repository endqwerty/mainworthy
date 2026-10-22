import { afterEach, expect, test } from "bun:test";
import type { AssertionOptions, RegistrationOptions } from "../src/server/identity/webauthn.ts";
import { provider, stopProviders } from "./oidc-support.ts";
import { authenticator, cleanUp, from, invite, must, PUBLIC, said, type World, world } from "./people-support.ts";

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
