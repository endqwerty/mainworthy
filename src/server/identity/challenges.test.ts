// The challenges of passkey ceremonies: found by what they were issued for and inside their time, spent once,
// bounded in number, and gone after an import. The clock is the test's own.
import { afterEach, expect, test } from "bun:test";
import { type App, openApp, SESSION_LIFETIMES } from "../kernel/app.ts";
import { Ceremonies } from "./ceremonies.ts";
import { CONTEXT, clearChallenges, findChallenge, issueChallenge, spendChallenge } from "./challenges.ts";
import { CEREMONY_MS, challengeOf } from "./webauthn.ts";

test("full ceremony memory expires entries first, then reclaims the largest source while admitting newcomers", () => {
	const store = new Ceremonies<{ deadline: number }>();
	store.put("victim", { deadline: 100 }, "small", 0);
	for (let n = 0; n < 6000; n++) store.put(`large-${n}`, { deadline: 100 }, "large", 0);
	for (let n = 0; n < 3999; n++) store.put(`medium-${n}`, { deadline: 100 }, "medium", 0);
	store.put("newcomer", { deadline: 100 }, "new", 0);
	expect(store.get("victim")).toBeDefined();
	expect(store.get("large-0")).toBeUndefined();
	expect(store.get("medium-0")).toBeDefined();
	expect(store.get("newcomer")).toBeDefined();
	expect([...store.values()]).toHaveLength(10_000);
	store.delete("large-1");
	store.put("replacement", { deadline: 200 }, "new", 0);
	expect(store.get("large-2")).toBeDefined();
	store.put("after-expiry", { deadline: 300 }, "last", 100);
	expect([...store.values()]).toHaveLength(2);
	expect(store.get("replacement")).toBeDefined();
});

test("a largest incoming source reclaims its own oldest entry on ties, and replacements do not double-count", () => {
	const store = new Ceremonies<{ deadline: number }>();
	for (let n = 0; n < 5000; n++) {
		store.put(`a-${n}`, { deadline: 100 }, "a", 0);
		store.put(`b-${n}`, { deadline: 100 }, "b", 0);
	}
	store.put("new-b", { deadline: 100 }, "b", 0);
	expect(store.get("a-0")).toBeDefined();
	expect(store.get("b-0")).toBeUndefined();
	store.put("a-0", { deadline: 200 }, "a", 0);
	expect(store.get("a-1")).toBeDefined();
	expect(store.get("b-1")).toBeDefined();
	expect([...store.values()]).toHaveLength(10_000);
});

const PARTY = { id: "mainworthy.example", origin: "https://mainworthy.example" };
/** A sign-in begun in some browser: the hash of its ceremony cookie stands in for it. */
const SIGN_IN = { purpose: "sign-in", context: CONTEXT.browser("c".repeat(64)) } as const;
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const apps: App[] = [];
afterEach(() => {
	for (const app of apps.splice(0)) app.close();
});

function instance(): { app: App; advance: (ms: number) => void } {
	let now = 1_800_000_000_000;
	const app = openApp(
		{
			dataDir: ":memory:",
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

test("a challenge is found for the purpose it was issued for, with the relying party it was issued under, until its time runs out", () => {
	const { app, advance } = instance();
	const signIn = issueChallenge(app, SIGN_IN, PARTY);
	const begun = { purpose: "register", userHandle: "aGFuZGxl", context: CONTEXT.session("5".repeat(64)) } as const;
	const register = issueChallenge(app, begun, PARTY);
	expect(signIn).toMatch(/^[A-Za-z0-9_-]{43}$/);
	expect(signIn).not.toBe(register);
	expect(findChallenge(app, signIn, "sign-in")).toEqual({
		ceremony: SIGN_IN,
		expected: { challenge: signIn, origin: "https://mainworthy.example", rpId: "mainworthy.example" },
	});
	// What is found says where the ceremony began, for the caller to compare with where the answer comes from.
	expect(findChallenge(app, register, "register")?.ceremony).toEqual(begun);
	// Neither answers the other ceremony, and a text the server never issued answers none.
	expect(findChallenge(app, signIn, "register")).toBeNull();
	expect(findChallenge(app, register, "sign-in")).toBeNull();
	// Its last character changed: to `A`, unless it is `A`, which one challenge in 16 ends in (the last of the 43
	// characters carries four bits of the 32 bytes).
	expect(findChallenge(app, `${signIn.slice(0, -1)}${signIn.endsWith("A") ? "B" : "A"}`, "sign-in")).toBeNull();
	// Or to the next character of the alphabet, which decodes to the same bytes (only the top four bits of the last
	// character count, and the server writes the other two as zeros). A challenge is found by the exact text it
	// was issued as, the text a browser sends back, so the same bytes spelled otherwise are not it.
	const next = BASE64URL[(BASE64URL.indexOf(signIn.slice(-1)) + 1) % 64];
	const spelledOtherwise = `${signIn.slice(0, -1)}${next}`;
	expect(Buffer.from(spelledOtherwise, "base64url").equals(Buffer.from(signIn, "base64url"))).toBe(true);
	expect(findChallenge(app, spelledOtherwise, "sign-in")).toBeNull();
	expect(findChallenge(app, "", "sign-in")).toBeNull();
	// Finding does not spend. One millisecond before the end it is there, at the end it is not.
	advance(CEREMONY_MS - 1);
	expect(findChallenge(app, signIn, "sign-in")).not.toBeNull();
	advance(1);
	expect(findChallenge(app, signIn, "sign-in")).toBeNull();
	expect(findChallenge(app, register, "register")).toBeNull();
});

test("a spent challenge answers nothing again, and another instance's challenge is not this one's", () => {
	const { app } = instance();
	const other = instance().app;
	const challenge = issueChallenge(app, SIGN_IN, PARTY);
	expect(findChallenge(other, challenge, "sign-in")).toBeNull();
	spendChallenge(other, challenge);
	expect(findChallenge(app, challenge, "sign-in")).not.toBeNull();
	spendChallenge(app, challenge);
	expect(findChallenge(app, challenge, "sign-in")).toBeNull();
	spendChallenge(app, challenge);
	// Clearing ends every ceremony of the instance it is asked of, and of no other.
	const kept = issueChallenge(other, SIGN_IN, PARTY);
	const gone = [issueChallenge(app, SIGN_IN, PARTY), issueChallenge(app, SIGN_IN, PARTY)];
	clearChallenges(app);
	expect(gone.map((one) => findChallenge(app, one, "sign-in"))).toEqual([null, null]);
	expect(findChallenge(other, kept, "sign-in")).not.toBeNull();
});

test("the challenges under way are bounded: past ten thousand the ones whose time ran out go first, then the oldest", () => {
	const { app, advance } = instance();
	const first = issueChallenge(app, SIGN_IN, PARTY);
	const second = issueChallenge(app, SIGN_IN, PARTY);
	for (let i = 2; i < 10_000; i++) issueChallenge(app, SIGN_IN, PARTY);
	expect([first, second].map((one) => findChallenge(app, one, "sign-in") !== null)).toEqual([true, true]);
	// The ten-thousand-and-first pushes the oldest out, and only that one.
	const next = issueChallenge(app, SIGN_IN, PARTY);
	expect([first, second, next].map((one) => findChallenge(app, one, "sign-in") !== null)).toEqual([false, true, true]);
	// When time has run out for all of them, one new challenge clears the lot and stands alone.
	advance(CEREMONY_MS);
	const fresh = issueChallenge(app, SIGN_IN, PARTY);
	advance(CEREMONY_MS - 1);
	expect(findChallenge(app, fresh, "sign-in")).not.toBeNull();
	// Ten thousand more fit beside it before it is the oldest.
	for (let i = 1; i < 10_000; i++) issueChallenge(app, SIGN_IN, PARTY);
	expect(findChallenge(app, fresh, "sign-in")).not.toBeNull();
	issueChallenge(app, SIGN_IN, PARTY);
	expect(findChallenge(app, fresh, "sign-in")).toBeNull();
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
