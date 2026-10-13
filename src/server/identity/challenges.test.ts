// The challenges of passkey ceremonies: found by what they were issued for and inside their time, spent once,
// bounded in number, and gone after an import. The clock is the test's own.
import { afterEach, expect, test } from "bun:test";
import { type App, openApp, SESSION_LIFETIMES } from "../kernel/app.ts";
import { challengeOf, clearChallenges, findChallenge, issueChallenge, spendChallenge } from "./challenges.ts";
import { CEREMONY_MS } from "./webauthn.ts";

const PARTY = { id: "mainworthy.example", origin: "https://mainworthy.example" };
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
	const signIn = issueChallenge(app, { purpose: "sign-in" }, PARTY);
	const register = issueChallenge(app, { purpose: "register", userHandle: "aGFuZGxl" }, PARTY);
	expect(signIn).toMatch(/^[A-Za-z0-9_-]{43}$/);
	expect(signIn).not.toBe(register);
	expect(findChallenge(app, signIn, "sign-in")).toEqual({
		ceremony: { purpose: "sign-in" },
		expected: { challenge: signIn, origin: "https://mainworthy.example", rpId: "mainworthy.example" },
	});
	expect(findChallenge(app, register, "register")?.ceremony).toEqual({ purpose: "register", userHandle: "aGFuZGxl" });
	// Neither answers the other ceremony, and a text the server never issued answers none.
	expect(findChallenge(app, signIn, "register")).toBeNull();
	expect(findChallenge(app, register, "sign-in")).toBeNull();
	expect(findChallenge(app, `${signIn.slice(0, -1)}A`, "sign-in")).toBeNull();
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
	const challenge = issueChallenge(app, { purpose: "sign-in" }, PARTY);
	expect(findChallenge(other, challenge, "sign-in")).toBeNull();
	spendChallenge(other, challenge);
	expect(findChallenge(app, challenge, "sign-in")).not.toBeNull();
	spendChallenge(app, challenge);
	expect(findChallenge(app, challenge, "sign-in")).toBeNull();
	spendChallenge(app, challenge);
	// Clearing ends every ceremony of the instance it is asked of, and of no other.
	const kept = issueChallenge(other, { purpose: "sign-in" }, PARTY);
	const gone = [issueChallenge(app, { purpose: "sign-in" }, PARTY), issueChallenge(app, { purpose: "sign-in" }, PARTY)];
	clearChallenges(app);
	expect(gone.map((one) => findChallenge(app, one, "sign-in"))).toEqual([null, null]);
	expect(findChallenge(other, kept, "sign-in")).not.toBeNull();
});

test("the challenges under way are bounded: past ten thousand the ones whose time ran out go first, then the oldest", () => {
	const { app, advance } = instance();
	const first = issueChallenge(app, { purpose: "sign-in" }, PARTY);
	const second = issueChallenge(app, { purpose: "sign-in" }, PARTY);
	for (let i = 2; i < 10_000; i++) issueChallenge(app, { purpose: "sign-in" }, PARTY);
	expect([first, second].map((one) => findChallenge(app, one, "sign-in") !== null)).toEqual([true, true]);
	// The ten-thousand-and-first pushes the oldest out, and only that one.
	const next = issueChallenge(app, { purpose: "sign-in" }, PARTY);
	expect([first, second, next].map((one) => findChallenge(app, one, "sign-in") !== null)).toEqual([false, true, true]);
	// When time has run out for all of them, one new challenge clears the lot and stands alone.
	advance(CEREMONY_MS);
	const fresh = issueChallenge(app, { purpose: "sign-in" }, PARTY);
	advance(CEREMONY_MS - 1);
	expect(findChallenge(app, fresh, "sign-in")).not.toBeNull();
	// Ten thousand more fit beside it before it is the oldest.
	for (let i = 1; i < 10_000; i++) issueChallenge(app, { purpose: "sign-in" }, PARTY);
	expect(findChallenge(app, fresh, "sign-in")).not.toBeNull();
	issueChallenge(app, { purpose: "sign-in" }, PARTY);
	expect(findChallenge(app, fresh, "sign-in")).toBeNull();
});

test("the challenge an answer names is read from its client data, and anything else names none", () => {
	const encoded = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
	expect(challengeOf({ clientDataJSON: encoded({ type: "webauthn.get", challenge: "abc", origin: "x" }) })).toBe("abc");
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
		{ clientDataJSON: encoded({ challenge: "x".repeat(9000) }) },
	])
		expect(challengeOf(answer)).toBeNull();
});
