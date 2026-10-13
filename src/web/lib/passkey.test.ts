// The parts of a passkey ceremony that need no browser: bytes to and from the text the server speaks, the
// server's options turned into what `navigator.credentials` takes, and what a browser's answer becomes on the
// wire. The ceremonies themselves run in Chromium (`test/e2e/people-passkey.test.ts`).
import { expect, test } from "bun:test";
import {
	assertionOf,
	CreationOptions,
	creationOptions,
	fromBase64Url,
	passkeyRefusal,
	RequestOptions,
	registrationOf,
	requestOptions,
	toBase64Url,
} from "./passkey.ts";

const bytes = (...values: number[]): ArrayBuffer => new Uint8Array(values).buffer;
/** The bytes a browser would read from an option, whichever form it was given in. */
const read = (source: BufferSource | undefined): number[] =>
	source === undefined
		? []
		: source instanceof ArrayBuffer
			? [...new Uint8Array(source)]
			: [...new Uint8Array(source.buffer, source.byteOffset, source.byteLength)];

test("bytes become base64url with no padding, and come back the same", () => {
	// 0xfb 0xff is `+/8=` in plain base64: both characters that differ, and the padding that is dropped.
	expect(toBase64Url(bytes(0xfb, 0xff))).toBe("-_8");
	expect(toBase64Url(bytes())).toBe("");
	expect(toBase64Url(new Uint8Array([1, 2, 3]))).toBe("AQID");
	expect([...fromBase64Url("-_8")]).toEqual([0xfb, 0xff]);
	expect([...fromBase64Url("")]).toEqual([]);
	for (const length of [1, 2, 3, 4, 31, 32, 33, 64, 300]) {
		const original = Uint8Array.from({ length }, (_, index) => (index * 37 + length) % 256);
		const text = toBase64Url(original);
		expect(text).toMatch(/^[A-Za-z0-9_-]*$/);
		expect([...fromBase64Url(text)]).toEqual([...original]);
	}
});

test("a long value is encoded without handing every byte to one call", () => {
	// An RSA key is a few hundred bytes; a spread of 100,000 arguments is where some engines give up.
	const long = new Uint8Array(100_000).fill(0xaa);
	expect(fromBase64Url(toBase64Url(long)).length).toBe(100_000);
});

test("text that is not base64url is refused, not read as something else", () => {
	for (const wrong of ["+/8=", "AQID=", "AQ ID", "A", "AQID\n", "é"]) expect(() => fromBase64Url(wrong)).toThrow();
});

const offered = {
	rp: { id: "mainworthy.example", name: "Mainworthy" },
	user: { id: "AQIDBA", name: "robin", displayName: "robin" },
	challenge: "-_8",
	pubKeyCredParams: [
		{ type: "public-key", alg: -7 },
		{ type: "public-key", alg: -257 },
	],
	timeout: 300_000,
	attestation: "none",
	authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
	excludeCredentials: [{ type: "public-key", id: "AQID", transports: ["internal", "hybrid"] }],
};

test("the server's options for a new passkey become what the browser takes, with every id as bytes", () => {
	const options = creationOptions(CreationOptions.parse(offered));
	expect(options.rp).toEqual({ id: "mainworthy.example", name: "Mainworthy" });
	// The user handle is the server's, as bytes: the authenticator files the key under it.
	expect(read(options.user.id)).toEqual([1, 2, 3, 4]);
	expect(options.user.name).toBe("robin");
	expect(read(options.challenge)).toEqual([0xfb, 0xff]);
	expect(options.pubKeyCredParams).toEqual([
		{ type: "public-key", alg: -7 },
		{ type: "public-key", alg: -257 },
	]);
	expect(options.timeout).toBe(300_000);
	expect(options.attestation).toBe("none");
	expect(options.authenticatorSelection).toEqual({
		residentKey: "required",
		requireResidentKey: true,
		userVerification: "required",
	});
	expect(options.excludeCredentials?.map((entry) => read(entry.id))).toEqual([[1, 2, 3]]);
	expect(options.excludeCredentials?.[0]?.transports).toEqual(["internal", "hybrid"]);
});

test("the server's options for a sign-in become what the browser takes", () => {
	const options = requestOptions(
		RequestOptions.parse({
			rpId: "mainworthy.example",
			challenge: "AQID",
			timeout: 300_000,
			userVerification: "required",
			allowCredentials: [],
		}),
	);
	expect(options.rpId).toBe("mainworthy.example");
	expect(read(options.challenge)).toEqual([1, 2, 3]);
	expect(options.userVerification).toBe("required");
	expect(options.allowCredentials).toEqual([]);
});

test("options that are not the server's shape are refused before a browser sees them", () => {
	expect(CreationOptions.safeParse({ ...offered, challenge: 7 }).success).toBe(false);
	expect(CreationOptions.safeParse({ ...offered, user: { name: "robin" } }).success).toBe(false);
	expect(RequestOptions.safeParse({ challenge: "AQID" }).success).toBe(false);
});

test("a new passkey goes to the server as the six members it reads, each byte string as base64url", () => {
	expect(
		registrationOf({
			rawId: bytes(1, 2, 3),
			clientDataJSON: bytes(0xfb, 0xff),
			authenticatorData: bytes(4, 5),
			publicKey: bytes(6),
			publicKeyAlgorithm: -7,
			transports: ["internal"],
		}),
	).toEqual({
		id: "AQID",
		clientDataJSON: "-_8",
		authenticatorData: "BAU",
		publicKey: "Bg",
		publicKeyAlgorithm: -7,
		transports: ["internal"],
	});
});

test("a sign-in goes to the server with the user handle, or null when the authenticator gave none", () => {
	const answer = {
		rawId: bytes(1, 2, 3),
		clientDataJSON: bytes(0xfb, 0xff),
		authenticatorData: bytes(4, 5),
		signature: bytes(7, 8, 9),
	};
	expect(assertionOf({ ...answer, userHandle: bytes(1, 2, 3, 4) })).toEqual({
		id: "AQID",
		clientDataJSON: "-_8",
		authenticatorData: "BAU",
		signature: "BwgJ",
		userHandle: "AQIDBA",
	});
	expect(assertionOf({ ...answer, userHandle: null }).userHandle).toBeNull();
});

test("what a browser refuses is said in a sentence, by the name of the refusal", () => {
	const named = (name: string) => Object.assign(new Error("the browser's own words"), { name });
	expect(passkeyRefusal(named("NotAllowedError"))).toContain("cancelled");
	expect(passkeyRefusal(named("SecurityError"))).toBe("This browser could not use a passkey here.");
	expect(passkeyRefusal(named("InvalidStateError"))).toBe("This passkey is already registered.");
	// Anything else, and anything that is no error at all, gets the general sentence and never the raw text.
	expect(passkeyRefusal(named("UnknownError"))).toBe("This browser could not use a passkey here.");
	expect(passkeyRefusal("nonsense")).toBe("This browser could not use a passkey here.");
});
