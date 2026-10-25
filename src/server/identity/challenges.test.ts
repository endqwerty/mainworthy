// The challenges of passkey ceremonies: found by what they were issued for and inside their time, spent once,
// bounded in number, and gone after an import. The clock is the test's own.
import { afterEach, expect, test } from "bun:test";
import { testDatabase } from "../../../test/db.ts";
import { type App, openApp, SESSION_LIFETIMES } from "../kernel/app.ts";
import { clearChallenges, findChallenge, issueChallenge, spendChallenge } from "./challenges.ts";
import { CONTEXT } from "./contexts.ts";
import { CEREMONY_MS, challengeOf } from "./webauthn.ts";

const PARTY = { id: "mainworthy.example", origin: "https://mainworthy.example" };
/** A sign-in begun in some browser: the hash of its ceremony cookie stands in for it. */
const SIGN_IN = { purpose: "sign-in", context: CONTEXT.browser("c".repeat(64)) } as const;
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const apps: App[] = [];
const fixtures: Awaited<ReturnType<typeof testDatabase>>[] = [];
afterEach(async () => {
	for (const app of apps.splice(0)) await app.close();
	for (const f of fixtures.splice(0)) await f.close();
});

async function instance(): Promise<{ app: App; advance: (ms: number) => void }> {
	let now = 1_800_000_000_000;
	const fixture = await testDatabase();
	fixtures.push(fixture);
	const app = await openApp(
		{
			dataDir: ":memory:",
			databaseUrl: fixture.url,
			host: "127.0.0.1",
			port: 0,
			mode: "local",
			owner: "robin",
			ownerToken: null,
			commit: null,
			...SESSION_LIFETIMES,
			proxy: null,
		},
		{ memory: true, now: () => now },
	);
	apps.push(app);
	return {
		app,
		advance: (ms) => {
			now += ms;
		},
	};
}

test("a challenge is found for the purpose it was issued for, with the relying party it was issued under, until its time runs out", async () => {
	const { app, advance } = await instance();
	const signIn = await issueChallenge(app, SIGN_IN, PARTY);
	const begun = { purpose: "register", userHandle: "aGFuZGxl", context: CONTEXT.session("5".repeat(64)) } as const;
	const register = await issueChallenge(app, begun, PARTY);
	expect(signIn).toMatch(/^[A-Za-z0-9_-]{43}$/);
	expect(signIn).not.toBe(register);
	expect(await findChallenge(app, signIn, "sign-in")).toEqual({
		ceremony: SIGN_IN,
		expected: { challenge: signIn, origin: "https://mainworthy.example", rpId: "mainworthy.example" },
	});
	// What is found says where the ceremony began, for the caller to compare with where the answer comes from.
	expect((await findChallenge(app, register, "register"))?.ceremony).toEqual(begun);
	// Neither answers the other ceremony, and a text the server never issued answers none.
	expect(await findChallenge(app, signIn, "register")).toBeNull();
	expect(await findChallenge(app, register, "sign-in")).toBeNull();
	// Its last character changed: to `A`, unless it is `A`, which one challenge in 16 ends in (the last of the 43
	// characters carries four bits of the 32 bytes).
	expect(await findChallenge(app, `${signIn.slice(0, -1)}${signIn.endsWith("A") ? "B" : "A"}`, "sign-in")).toBeNull();
	// Or to the next character of the alphabet, which decodes to the same bytes (only the top four bits of the last
	// character count, and the server writes the other two as zeros). A challenge is found by the exact text it
	// was issued as, the text a browser sends back, so the same bytes spelled otherwise are not it.
	const next = BASE64URL[(BASE64URL.indexOf(signIn.slice(-1)) + 1) % 64];
	const spelledOtherwise = `${signIn.slice(0, -1)}${next}`;
	expect(Buffer.from(spelledOtherwise, "base64url").equals(Buffer.from(signIn, "base64url"))).toBe(true);
	expect(await findChallenge(app, spelledOtherwise, "sign-in")).toBeNull();
	expect(await findChallenge(app, "", "sign-in")).toBeNull();
	// Finding does not spend. One millisecond before the end it is there, at the end it is not.
	advance(CEREMONY_MS - 1);
	expect(await findChallenge(app, signIn, "sign-in")).not.toBeNull();
	advance(1);
	expect(await findChallenge(app, signIn, "sign-in")).toBeNull();
	expect(await findChallenge(app, register, "register")).toBeNull();
});

test("a spent challenge answers nothing again; independent databases remain separate", async () => {
	const { app } = await instance();
	const other = (await instance()).app;
	const challenge = await issueChallenge(app, SIGN_IN, PARTY);
	expect(await findChallenge(other, challenge, "sign-in")).toBeNull();
	expect(await other.database.write((db) => db.transaction(() => spendChallenge(other, challenge, db)))).toBe(false);
	expect(await findChallenge(app, challenge, "sign-in")).not.toBeNull();
	expect(await app.database.write((db) => db.transaction(() => spendChallenge(app, challenge, db)))).toBe(true);
	expect(await findChallenge(app, challenge, "sign-in")).toBeNull();
	expect(await app.database.write((db) => db.transaction(() => spendChallenge(app, challenge, db)))).toBe(false);
	const kept = await issueChallenge(other, SIGN_IN, PARTY);
	const gone = await issueChallenge(app, SIGN_IN, PARTY);
	await clearChallenges(app);
	expect(await findChallenge(app, gone, "sign-in")).toBeNull();
	expect(await findChallenge(other, kept, "sign-in")).not.toBeNull();
});

test("the challenge an answer names is read from its client data, and anything else names none", () => {
	const encoded = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
	const data = { type: "webauthn.get", challenge: "abc", origin: "x" };
	expect(challengeOf({ clientDataJSON: encoded(data) })).toBe("abc");
	// One leading byte-order mark is dropped, as the verifier drops it when it reads the same bytes.
	const marked = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(data))]);
	expect(challengeOf({ clientDataJSON: marked.toString("base64url") })).toBe("abc");
	for (const answer of [
		null,
		"text",
		7,
		[],
		{},
		{ clientDataJSON: 7 },
		{ clientDataJSON: "" },
		{ clientDataJSON: "not base64url json" },
		{ clientDataJSON: encoded("a string") },
		{ clientDataJSON: encoded(null) },
		{ clientDataJSON: encoded({ type: "webauthn.get" }) },
		{ clientDataJSON: encoded({ challenge: 7 }) },
		{ clientDataJSON: encoded({ challenge: "abc" }) },
		{ clientDataJSON: encoded({ ...data, challenge: "x".repeat(9000) }) },
		// Not UTF-8, and base64 with padding, which is not the one spelling the verifier takes.
		{ clientDataJSON: Buffer.from([0xff, 0xfe, 0x7b, 0x7d]).toString("base64url") },
		{ clientDataJSON: `${encoded(data)}=` },
	])
		expect(challengeOf(answer)).toBeNull();
});
