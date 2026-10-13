// The passkey verifier against an authenticator written here from the specification: keys from `node:crypto`,
// authenticator data put together byte by byte, and one thing wrong at a time. That a browser writes what this
// authenticator does is shown in `test/e2e/passkey-verifier.test.ts`.
import { describe, expect, test } from "bun:test";
import { createHash, createPublicKey, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";
import fc from "fast-check";
import {
	ALGORITHMS,
	type Algorithm,
	type AssertionResponse,
	assertionOptions,
	CEREMONY_MS,
	type Challenge,
	type Expected,
	newChallenge,
	type Passkey,
	type Refusal,
	type RegistrationResponse,
	registrationOptions,
	relyingParty,
	type StoredPasskey,
	verifyAssertion,
	verifyRegistration,
} from "./webauthn.ts";

const ORIGIN = "https://mainworthy.com";
const RP_ID = "mainworthy.com";
const UP = 0x01;
const UV = 0x04;
const BE = 0x08;
const BS = 0x10;
const AT = 0x40;
const ED = 0x80;

const encoded = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const sha256 = (bytes: Uint8Array): Buffer => createHash("sha256").update(bytes).digest();
const spkiOf = (key: KeyObject): Buffer => key.export({ format: "der", type: "spki" });
const refusal = (reason: Refusal) => ({ ok: false, reason }) as const;

/** The key in COSE form, as an authenticator writes it into its data. The verifier never reads it. */
function coseOf(algorithm: Algorithm, key: KeyObject): Buffer {
	const jwk = key.export({ format: "jwk" });
	const part = (value: string | undefined): Buffer => Buffer.from(value ?? "", "base64url");
	switch (algorithm) {
		case -7:
			// {1: 2, 3: -7, -1: 1, -2: x, -3: y}
			return Buffer.concat([
				Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
				part(jwk.x),
				Buffer.from([0x22, 0x58, 0x20]),
				part(jwk.y),
			]);
		case -8:
			// {1: 1, 3: -8, -1: 6, -2: x}
			return Buffer.concat([Buffer.from([0xa4, 0x01, 0x01, 0x03, 0x27, 0x20, 0x06, 0x21, 0x58, 0x20]), part(jwk.x)]);
		case -257: {
			// {1: 3, 3: -257, -1: n, -2: e}
			const n = part(jwk.n);
			const e = part(jwk.e);
			return Buffer.concat([
				Buffer.from([0xa4, 0x01, 0x03, 0x03, 0x39, 0x01, 0x00, 0x20, 0x59, n.length >> 8, n.length & 0xff]),
				n,
				Buffer.from([0x21, 0x40 + e.length]),
				e,
			]);
		}
	}
}

/** An authenticator holding one key. */
type Device = {
	readonly algorithm: Algorithm;
	readonly id: Buffer;
	/** What the key is filed under: the handle of the account, given at registration. */
	readonly handle: Buffer;
	readonly spki: Buffer;
	readonly cose: Buffer;
	readonly sign: (message: Buffer) => Buffer;
};
function device(algorithm: Algorithm, rsaBits = 2048): Device {
	const pair =
		algorithm === -7
			? generateKeyPairSync("ec", { namedCurve: "prime256v1" })
			: algorithm === -8
				? generateKeyPairSync("ed25519")
				: generateKeyPairSync("rsa", { modulusLength: rsaBits });
	return {
		algorithm,
		id: randomBytes(32),
		handle: randomBytes(16),
		spki: spkiOf(pair.publicKey),
		cose: coseOf(algorithm, pair.publicKey),
		// ECDSA comes out as ASN.1 DER, which is what an authenticator sends. Ed25519 names no digest.
		sign: (message) => sign(algorithm === -8 ? null : "sha256", message, pair.privateKey),
	};
}
const NAMES: Record<Algorithm, string> = { [-7]: "ES256", [-8]: "EdDSA", [-257]: "RS256" };
const DEVICES: Record<Algorithm, Device> = { [-7]: device(-7), [-8]: device(-8), [-257]: device(-257) };
const es256 = DEVICES[-7];

/** Authenticator data: SHA-256 of the RP ID, the flags, the counter, then what the flags announce. */
function authenticatorData(parts: {
	rpId: string;
	flags: number;
	signCount: number;
	credential?: { id: Buffer; cose: Buffer };
	extensions?: Buffer;
}): Buffer {
	const fixed = Buffer.alloc(37);
	sha256(Buffer.from(parts.rpId)).copy(fixed, 0);
	fixed.writeUInt8(parts.flags, 32);
	fixed.writeUInt32BE(parts.signCount, 33);
	const out: Buffer[] = [fixed];
	if (parts.credential) {
		const length = Buffer.alloc(2);
		length.writeUInt16BE(parts.credential.id.length);
		// Sixteen zero bytes: the model of an authenticator that does not say what it is.
		out.push(Buffer.alloc(16), length, parts.credential.id, parts.credential.cose);
	}
	if (parts.extensions) out.push(parts.extensions);
	return Buffer.concat(out);
}

/** Everything a registration is made of. A test changes one part. */
type Registration = {
	clientData: Buffer | Record<string, unknown>;
	rpId: string;
	flags: number;
	signCount: number;
	/** The id inside the authenticator data, */
	idInside: Buffer;
	/** and the one sent beside it. */
	id: string;
	cose: Buffer;
	extensions: Buffer | undefined;
	/** The bytes sent as authenticator data, when they are not the ones put together from the parts. */
	sentData: ((built: Buffer) => Buffer) | undefined;
	publicKey: string;
	publicKeyAlgorithm: number;
	transports: string[];
	expected: Expected;
};
function registration(
	from: Device,
	change: (parts: Registration) => void = () => {},
): [RegistrationResponse, Expected] {
	const challenge = newChallenge();
	const parts: Registration = {
		clientData: { type: "webauthn.create", challenge, origin: ORIGIN, crossOrigin: false },
		rpId: RP_ID,
		flags: UP | UV | AT,
		signCount: 0,
		idInside: from.id,
		id: encoded(from.id),
		cose: from.cose,
		extensions: undefined,
		sentData: undefined,
		publicKey: encoded(from.spki),
		publicKeyAlgorithm: from.algorithm,
		transports: ["internal", "hybrid"],
		expected: { challenge, origin: ORIGIN, rpId: RP_ID },
	};
	change(parts);
	const data = authenticatorData({
		rpId: parts.rpId,
		flags: parts.flags,
		signCount: parts.signCount,
		credential: { id: parts.idInside, cose: parts.cose },
		...(parts.extensions ? { extensions: parts.extensions } : {}),
	});
	return [
		{
			id: parts.id,
			clientDataJSON: encoded(
				Buffer.isBuffer(parts.clientData) ? parts.clientData : Buffer.from(JSON.stringify(parts.clientData)),
			),
			authenticatorData: encoded(parts.sentData?.(data) ?? data),
			publicKey: parts.publicKey,
			publicKeyAlgorithm: parts.publicKeyAlgorithm,
			transports: parts.transports,
		},
		parts.expected,
	];
}
function registered(from: Device): Passkey {
	const verdict = verifyRegistration(...registration(from));
	if (!verdict.ok) throw new Error(`a correct registration was refused: ${verdict.reason}`);
	return verdict.value;
}

/** Everything a sign-in is made of. */
type SignIn = {
	clientData: Buffer | Record<string, unknown>;
	rpId: string;
	flags: number;
	signCount: number;
	extensions: Buffer | undefined;
	/** The bytes sent as authenticator data, when they are not the ones that were signed. */
	sentData: ((signed: Buffer) => Buffer) | undefined;
	id: string;
	/** What `response.userHandle` gave the page: text, null, or with undefined no member at all. */
	userHandle: string | null | undefined;
	signer: Device;
	/** What the authenticator signs, when it is not the data and the hash of the client data. */
	message: ((data: Buffer, clientData: Buffer) => Buffer) | undefined;
	signature: ((signature: Buffer) => Buffer) | undefined;
	stored: StoredPasskey;
	expected: Expected;
};
function signIn(
	from: Device,
	change: (parts: SignIn) => void = () => {},
): [AssertionResponse, StoredPasskey, Expected] {
	const challenge = newChallenge();
	const parts: SignIn = {
		clientData: { type: "webauthn.get", challenge, origin: ORIGIN, crossOrigin: false },
		rpId: RP_ID,
		flags: UP | UV,
		signCount: 1,
		extensions: undefined,
		sentData: undefined,
		id: encoded(from.id),
		userHandle: encoded(from.handle),
		signer: from,
		message: undefined,
		signature: undefined,
		stored: registered(from),
		expected: { challenge, origin: ORIGIN, rpId: RP_ID },
	};
	change(parts);
	const clientData = Buffer.isBuffer(parts.clientData)
		? parts.clientData
		: Buffer.from(JSON.stringify(parts.clientData));
	const data = authenticatorData({
		rpId: parts.rpId,
		flags: parts.flags,
		signCount: parts.signCount,
		...(parts.extensions ? { extensions: parts.extensions } : {}),
	});
	const message = parts.message?.(data, clientData) ?? Buffer.concat([data, sha256(clientData)]);
	const signature = parts.signer.sign(message);
	return [
		{
			id: parts.id,
			clientDataJSON: encoded(clientData),
			authenticatorData: encoded(parts.sentData?.(data) ?? data),
			signature: encoded(parts.signature?.(signature) ?? signature),
			...(parts.userHandle === undefined ? {} : { userHandle: parts.userHandle }),
		},
		parts.stored,
		parts.expected,
	];
}

/** The hash of the RP ID is the first 32 bytes of the data. */
function lastHashByteChanged(data: Buffer): Buffer {
	const changed = Buffer.from(data);
	changed.writeUInt8(changed.readUInt8(31) ^ 1, 31);
	return changed;
}

/** One part of `clientDataJSON` replaced. A value of undefined leaves the member out. */
const client =
	(member: string, value: unknown) =>
	(parts: Registration | SignIn): void => {
		if (!Buffer.isBuffer(parts.clientData)) parts.clientData = { ...parts.clientData, [member]: value };
	};

/** Several changes to one answer. */
const each =
	(...changes: ((parts: Registration | SignIn) => void)[]) =>
	(parts: Registration | SignIn): void => {
		for (const change of changes) change(parts);
	};

/** The byte-order mark of UTF-8. */
const MARK = Buffer.from([0xef, 0xbb, 0xbf]);

describe("a correct passkey", () => {
	for (const algorithm of ALGORITHMS) {
		const from = DEVICES[algorithm];
		test(`${NAMES[algorithm]}: the registration is accepted and says what to store`, () => {
			expect(verifyRegistration(...registration(from, (parts) => (parts.signCount = 7)))).toEqual({
				ok: true,
				value: {
					credentialId: encoded(from.id),
					publicKey: encoded(from.spki),
					algorithm,
					signCount: 7,
					backupEligible: false,
					backedUp: false,
					transports: ["internal", "hybrid"],
				},
			});
		});
		test(`${NAMES[algorithm]}: the sign-in is accepted and says what it showed`, () => {
			expect(verifyAssertion(...signIn(from, (parts) => (parts.signCount = 41)))).toEqual({
				ok: true,
				value: { signCount: 41, backupEligible: false, backedUp: false, userHandle: encoded(from.handle) },
			});
		});
	}

	test("the backup flags are read from both ceremonies", () => {
		expect(verifyRegistration(...registration(es256, (parts) => (parts.flags |= BE)))).toMatchObject({
			value: { backupEligible: true, backedUp: false },
		});
		expect(verifyRegistration(...registration(es256, (parts) => (parts.flags |= BE | BS)))).toMatchObject({
			value: { backupEligible: true, backedUp: true },
		});
		expect(verifyAssertion(...signIn(es256, (parts) => (parts.flags |= BE | BS)))).toMatchObject({
			value: { backupEligible: true, backedUp: true },
		});
	});

	test("a person who was not verified is never accepted, whatever the caller passes", () => {
		// The first shape of `Expected` had a switch for this. A caller that still passes it gets no exception.
		const asking = (parts: Registration | SignIn): void => {
			parts.flags &= ~UV;
			const old = { ...parts.expected, requireUserVerification: false };
			parts.expected = old;
		};
		expect(verifyRegistration(...registration(es256, asking))).toEqual(refusal("user-not-verified"));
		expect(verifyAssertion(...signIn(es256, asking))).toEqual(refusal("user-not-verified"));
	});

	test("members a browser adds to the client data are ignored, and `crossOrigin` may be absent", () => {
		// Chromium adds this one to some answers, so that nobody compares the text with a template.
		const extra = client("other_keys_can_be_added_here", "do not compare clientDataJSON against a template");
		expect(verifyRegistration(...registration(es256, extra))).toMatchObject({ ok: true });
		expect(verifyAssertion(...signIn(es256, extra))).toMatchObject({ ok: true });
		expect(verifyRegistration(...registration(es256, client("crossOrigin", undefined)))).toMatchObject({ ok: true });
		expect(verifyAssertion(...signIn(es256, client("crossOrigin", undefined)))).toMatchObject({ ok: true });
	});

	test("extension data may follow, and at sign-in the signature covers it", () => {
		const extended = (parts: Registration | SignIn): void => {
			parts.flags |= ED;
			parts.extensions = Buffer.from([0xa1, 0x61, 0x78, 0xf5]);
		};
		expect(verifyRegistration(...registration(es256, extended))).toMatchObject({ ok: true });
		expect(verifyAssertion(...signIn(es256, extended))).toMatchObject({ ok: true });
	});

	test("the key is stored as the library writes it, whatever spelling was sent", () => {
		// The same point in compressed form: one byte for the sign of y in place of y.
		const y = es256.spki.subarray(59);
		const compressed = Buffer.concat([
			Buffer.from("3039301306072a8648ce3d020106082a8648ce3d030107032200", "hex"),
			Buffer.from([2 + ((y[31] ?? 0) & 1)]),
			es256.spki.subarray(27, 59),
		]);
		for (const spelling of [compressed, Buffer.concat([es256.spki, Buffer.from([0])])]) {
			const verdict = verifyRegistration(...registration(es256, (parts) => (parts.publicKey = encoded(spelling))));
			expect(verdict).toMatchObject({ ok: true, value: { publicKey: encoded(es256.spki) } });
		}
	});

	test("an RSA key of up to 8192 bits fits the limit on the key, and a longer one does not", () => {
		// A registration needs no private key, so the modulus is any odd number of the length.
		const rsa = (bits: number): string => {
			const modulus = randomBytes(bits / 8);
			modulus.writeUInt8(modulus.readUInt8(0) | 0x80, 0);
			modulus.writeUInt8(modulus.readUInt8(modulus.length - 1) | 1, modulus.length - 1);
			const key = createPublicKey({ key: { kty: "RSA", n: encoded(modulus), e: "AQAB" }, format: "jwk" });
			expect(key.asymmetricKeyDetails?.modulusLength).toBe(bits);
			return encoded(spkiOf(key));
		};
		const claimed = (publicKey: string) => (parts: Registration) => {
			parts.publicKey = publicKey;
			parts.publicKeyAlgorithm = -257;
		};
		for (const bits of [2048, 3072, 4096, 8192])
			expect(verifyRegistration(...registration(es256, claimed(rsa(bits))))).toMatchObject({ ok: true });
		expect(verifyRegistration(...registration(es256, claimed(rsa(8192 + 512))))).toEqual(refusal("too-large"));
	});
});

describe("a registration with one thing wrong is refused, and says which", () => {
	const cases: [string, (parts: Registration) => void, Refusal][] = [
		["the answer to a sign-in", client("type", "webauthn.get"), "type"],
		["a type no ceremony has", client("type", "webauthn.create "), "type"],
		["another challenge", client("challenge", newChallenge()), "challenge"],
		["no challenge", client("challenge", ""), "challenge"],
		[
			"the challenge cut short",
			(parts) => client("challenge", parts.expected.challenge.slice(0, 42))(parts),
			"challenge",
		],
		[
			"the challenge with more after it",
			(parts) => client("challenge", `${parts.expected.challenge}A`)(parts),
			"challenge",
		],
		["an origin that ends like ours", client("origin", "https://evil-mainworthy.com"), "origin"],
		["an origin that ends with ours", client("origin", "https://example.org/https://mainworthy.com"), "origin"],
		["an origin that begins with ours", client("origin", "https://mainworthy.com.example.org"), "origin"],
		["a host under ours", client("origin", "https://www.mainworthy.com"), "origin"],
		["another port", client("origin", "https://mainworthy.com:8443"), "origin"],
		["the default port written out", client("origin", "https://mainworthy.com:443"), "origin"],
		["plain http", client("origin", "http://mainworthy.com"), "origin"],
		["a trailing slash", client("origin", "https://mainworthy.com/"), "origin"],
		["other letter case", client("origin", "https://Mainworthy.com"), "origin"],
		["a page inside another site's frame", client("crossOrigin", true), "cross-origin"],
		["a top origin beside `crossOrigin: false`", client("topOrigin", "https://example.org"), "cross-origin"],
		[
			"a top origin with no `crossOrigin`",
			each(client("topOrigin", "https://example.org"), client("crossOrigin", undefined)),
			"cross-origin",
		],
		["a top origin that is no origin", client("topOrigin", 7), "cross-origin"],
		["a top origin that is nothing", client("topOrigin", null), "cross-origin"],
		["our own origin as the top origin", client("topOrigin", ORIGIN), "cross-origin"],
		["another relying party", (parts) => (parts.rpId = "example.org"), "rp-id"],
		["a relying party that ends like ours", (parts) => (parts.rpId = "evil-mainworthy.com"), "rp-id"],
		["a relying party whose hash differs in its last byte", (parts) => (parts.sentData = lastHashByteChanged), "rp-id"],
		["nobody present", (parts) => (parts.flags &= ~UP), "user-not-present"],
		["a person who was not verified", (parts) => (parts.flags &= ~UV), "user-not-verified"],
		["backed up but not eligible for backup", (parts) => (parts.flags |= BS), "backup-flags"],
		["no credential data announced", (parts) => (parts.flags &= ~AT), "no-credential-data"],
		["another credential id beside the data", (parts) => (parts.id = encoded(randomBytes(32))), "credential-id"],
		["the credential id cut short", (parts) => (parts.id = encoded(parts.idInside.subarray(0, 31))), "credential-id"],
		["an empty credential id inside the data", (parts) => (parts.idInside = Buffer.alloc(0)), "authenticator-data"],
		["a credential id longer than any", (parts) => (parts.idInside = Buffer.alloc(1024, 7)), "authenticator-data"],
		["no key after the credential id", (parts) => (parts.cose = Buffer.alloc(0)), "authenticator-data"],
		["ES384, which is not offered", (parts) => (parts.publicKeyAlgorithm = -35), "algorithm"],
		["PS256, which is not offered", (parts) => (parts.publicKeyAlgorithm = -37), "algorithm"],
		["RS1, signed with SHA-1", (parts) => (parts.publicKeyAlgorithm = -65535), "algorithm"],
		["no algorithm", (parts) => (parts.publicKeyAlgorithm = 0), "algorithm"],
		["a key that is not a key", (parts) => (parts.publicKey = encoded(randomBytes(91))), "key"],
		[
			"a point that is not on the curve",
			(parts) => {
				const moved = Buffer.from(es256.spki);
				moved.writeUInt8(moved.readUInt8(90) ^ 1, 90);
				parts.publicKey = encoded(moved);
			},
			"key",
		],
		[
			"a private key",
			(parts) => {
				const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
				parts.publicKey = encoded(privateKey.export({ format: "der", type: "pkcs8" }));
			},
			"key",
		],
		[
			"an RSA key of 1024 bits",
			(parts) => {
				parts.publicKey = encoded(device(-257, 1024).spki);
				parts.publicKeyAlgorithm = -257;
			},
			"key-too-weak",
		],
		[
			"an RSA key of 2047 bits",
			(parts) => {
				// The library makes keys in steps of 128 bits, so this is the modulus of a 2048-bit key with its
				// top bit cleared. Nobody holds a private key for it, and a registration needs none.
				const jwk = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ format: "jwk" });
				const modulus = Buffer.from(jwk.n ?? "", "base64url");
				modulus.writeUInt8((modulus.readUInt8(0) & 0x7f) | 0x40, 0);
				const shorter = createPublicKey({ key: { ...jwk, n: encoded(modulus) }, format: "jwk" });
				expect(shorter.asymmetricKeyDetails?.modulusLength).toBe(2047);
				parts.publicKey = encoded(spkiOf(shorter));
				parts.publicKeyAlgorithm = -257;
			},
			"key-too-weak",
		],
		[
			"a P-384 key claimed as ES256",
			(parts) => {
				parts.publicKey = encoded(spkiOf(generateKeyPairSync("ec", { namedCurve: "secp384r1" }).publicKey));
			},
			"key-mismatch",
		],
		["an RSA key claimed as ES256", (parts) => (parts.publicKey = encoded(DEVICES[-257].spki)), "key-mismatch"],
		["an Ed25519 key claimed as ES256", (parts) => (parts.publicKey = encoded(DEVICES[-8].spki)), "key-mismatch"],
		["a P-256 key claimed as RS256", (parts) => (parts.publicKeyAlgorithm = -257), "key-mismatch"],
		["a P-256 key claimed as EdDSA", (parts) => (parts.publicKeyAlgorithm = -8), "key-mismatch"],
		[
			"an X25519 key, which cannot sign, claimed as EdDSA",
			(parts) => {
				parts.publicKey = encoded(spkiOf(generateKeyPairSync("x25519").publicKey));
				parts.publicKeyAlgorithm = -8;
			},
			"key-mismatch",
		],
	];
	for (const [name, change, reason] of cases)
		test(name, () => expect(verifyRegistration(...registration(es256, change))).toEqual(refusal(reason)));

	test("an RSA key whose public exponent is 0, 1 or 2 is refused", () => {
		// Under an exponent of 1 a signature is its own message, so anybody can write one. The library refuses
		// such a key when it reads it, and this holds it to that across upgrades. The SPKI of a 2048-bit key
		// ends with its exponent, 65537 in three bytes: another is written in its place, and the three lengths
		// around it are corrected.
		const spki = DEVICES[-257].spki;
		const withExponent = (...exponent: number[]): string => {
			const out = Buffer.concat([spki.subarray(0, spki.length - 5), Buffer.from([0x02, exponent.length, ...exponent])]);
			for (const at of [2, 21, 26]) out.writeUInt16BE(out.readUInt16BE(at) + exponent.length - 3, at);
			return encoded(out);
		};
		expect(withExponent(1, 0, 1)).toBe(encoded(spki));
		const claimed = (publicKey: string) => (parts: Registration) => {
			parts.publicKey = publicKey;
			parts.publicKeyAlgorithm = -257;
		};
		for (const exponent of [0, 1, 2])
			expect(verifyRegistration(...registration(es256, claimed(withExponent(exponent))))).toEqual(refusal("key"));
		// An exponent of 3 is a key like another: what makes the signature safe is the strict padding check.
		expect(verifyRegistration(...registration(es256, claimed(withExponent(3))))).toMatchObject({ ok: true });
		// And in a stored row, the key is refused before any signature is looked at.
		const stored = (parts: SignIn): void => {
			parts.stored = { ...parts.stored, publicKey: withExponent(1) };
		};
		expect(verifyAssertion(...signIn(DEVICES[-257], stored))).toEqual(refusal("key"));
	});

	test("authenticator data cut anywhere before the key", () => {
		// 37 fixed bytes, 16 of model, 2 of length and the id. What follows is the key's CBOR copy, which is not
		// read, so a cut inside it is not seen: with attestation "none" nothing vouches for that copy anyway.
		const upToKey = 37 + 16 + 2 + es256.id.length;
		for (let cut = 1; cut <= upToKey; cut++)
			expect(
				verifyRegistration(...registration(es256, (parts) => (parts.sentData = (data) => data.subarray(0, cut)))),
			).toEqual(refusal("authenticator-data"));
		expect(
			verifyRegistration(...registration(es256, (parts) => (parts.sentData = (data) => data.subarray(0, upToKey + 1)))),
		).toMatchObject({
			ok: true,
		});
	});
});

describe("a sign-in with one thing wrong is refused, and says which", () => {
	const other = device(-7);
	/** The same signature with s replaced by n - s, which ECDSA accepts as well. */
	const twin = (der: Buffer): Buffer => {
		const n = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
		const rLength = der.readUInt8(3);
		const s = BigInt(`0x${der.subarray(6 + rLength).toString("hex")}`);
		let bytes = Buffer.from((n - s).toString(16).padStart(64, "0"), "hex");
		while (bytes.length > 1 && bytes.readUInt8(0) === 0 && bytes.readUInt8(1) < 0x80) bytes = bytes.subarray(1);
		if (bytes.readUInt8(0) >= 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
		const r = der.subarray(2, 4 + rLength);
		return Buffer.concat([
			Buffer.from([0x30, r.length + 2 + bytes.length]),
			r,
			Buffer.from([0x02, bytes.length]),
			bytes,
		]);
	};
	const cases: [string, (parts: SignIn) => void, Refusal][] = [
		["the answer to a registration", client("type", "webauthn.create"), "type"],
		["another challenge", client("challenge", newChallenge()), "challenge"],
		["no challenge", client("challenge", ""), "challenge"],
		["an origin that ends like ours", client("origin", "https://evil-mainworthy.com"), "origin"],
		["an origin that begins with ours", client("origin", "https://mainworthy.com.example.org"), "origin"],
		["another port", client("origin", "https://mainworthy.com:8443"), "origin"],
		["plain http", client("origin", "http://mainworthy.com"), "origin"],
		["a page inside another site's frame", client("crossOrigin", true), "cross-origin"],
		["a top origin beside `crossOrigin: false`", client("topOrigin", "https://example.org"), "cross-origin"],
		[
			"a top origin with no `crossOrigin`",
			each(client("topOrigin", "https://example.org"), client("crossOrigin", undefined)),
			"cross-origin",
		],
		["a top origin that is no origin", client("topOrigin", 7), "cross-origin"],
		["a top origin that is nothing", client("topOrigin", null), "cross-origin"],
		["our own origin as the top origin", client("topOrigin", ORIGIN), "cross-origin"],
		["another relying party", (parts) => (parts.rpId = "example.org"), "rp-id"],
		["a relying party whose hash differs in its last byte", (parts) => (parts.sentData = lastHashByteChanged), "rp-id"],
		["nobody present", (parts) => (parts.flags &= ~UP), "user-not-present"],
		["a person who was not verified", (parts) => (parts.flags &= ~UV), "user-not-verified"],
		["backed up but not eligible for backup", (parts) => (parts.flags |= BS), "backup-flags"],
		["a credential id that is not the stored one", (parts) => (parts.id = encoded(other.id)), "credential-id"],
		["credential data announced", (parts) => (parts.flags |= AT), "authenticator-data"],
		["extension data announced and absent", (parts) => (parts.flags |= ED), "authenticator-data"],
		[
			"bytes after the data that nothing announces",
			(parts) => (parts.extensions = Buffer.from([0xa0])),
			"authenticator-data",
		],
		["a signature by another key", (parts) => (parts.signer = other), "signature"],
		[
			"a signature over another sign-in's client data",
			(parts) => {
				const earlier = JSON.stringify({ type: "webauthn.get", challenge: newChallenge(), origin: ORIGIN });
				parts.message = (data) => Buffer.concat([data, sha256(Buffer.from(earlier))]);
			},
			"signature",
		],
		[
			"a signature over the client data itself, not its hash",
			(parts) => (parts.message = (data, clientData) => Buffer.concat([data, clientData])),
			"signature",
		],
		[
			"a counter raised after signing",
			(parts) =>
				(parts.sentData = (signed) => {
					const raised = Buffer.from(signed);
					raised.writeUInt32BE(1000, 33);
					return raised;
				}),
			"signature",
		],
		[
			"the verified flag set after signing",
			(parts) => {
				parts.flags &= ~UV;
				parts.sentData = (signed) => {
					const set = Buffer.from(signed);
					set.writeUInt8(set.readUInt8(32) | UV, 32);
					return set;
				};
			},
			"signature",
		],
		["an empty-looking signature", (parts) => (parts.signature = () => Buffer.from([0x30, 0x00])), "signature"],
		[
			"a signature of two zeros",
			(parts) => (parts.signature = () => Buffer.from("3006020100020100", "hex")),
			"signature",
		],
		[
			"a signature with a byte after it",
			(parts) => (parts.signature = (der) => Buffer.concat([der, Buffer.from([0])])),
			"signature",
		],
		[
			"a signature whose length is written the long way",
			(parts) =>
				(parts.signature = (der) => Buffer.concat([Buffer.from([0x30, 0x81, der.readUInt8(1)]), der.subarray(2)])),
			"signature",
		],
		[
			"r and s bare, as WebCrypto writes them",
			(parts) =>
				(parts.signature = (der) => {
					const rLength = der.readUInt8(3);
					const bare = (number: Buffer): Buffer => Buffer.concat([Buffer.alloc(32), number]).subarray(number.length);
					return Buffer.concat([bare(der.subarray(4, 4 + rLength)), bare(der.subarray(6 + rLength))]);
				}),
			"signature",
		],
		["a stored key that is not a key", (parts) => (parts.stored = { ...parts.stored, publicKey: "AAAA" }), "key"],
		["a stored key that is not base64url", (parts) => (parts.stored = { ...parts.stored, publicKey: "+/+/" }), "key"],
		[
			"a stored key of another algorithm than the stored one",
			(parts) => (parts.stored = { ...parts.stored, algorithm: -257 }),
			"key-mismatch",
		],
		["a counter that stands still", (parts) => (parts.stored = { ...parts.stored, signCount: 1 }), "possibly-cloned"],
		["a counter that goes back", (parts) => (parts.stored = { ...parts.stored, signCount: 2 }), "possibly-cloned"],
		[
			"a counter back at zero",
			(parts) => {
				parts.signCount = 0;
				parts.stored = { ...parts.stored, signCount: 2 };
			},
			"possibly-cloned",
		],
	];
	for (const [name, change, reason] of cases)
		test(name, () => expect(verifyAssertion(...signIn(es256, change))).toEqual(refusal(reason)));

	for (const algorithm of [-8, -257] satisfies Algorithm[]) {
		const from = DEVICES[algorithm];
		test(`${NAMES[algorithm]}: a signature by another key, over other data, or changed`, () => {
			expect(verifyAssertion(...signIn(from, (parts) => (parts.signer = device(algorithm))))).toEqual(
				refusal("signature"),
			);
			expect(verifyAssertion(...signIn(from, (parts) => (parts.message = (data) => data)))).toEqual(
				refusal("signature"),
			);
			const changed = (signature: Buffer): Buffer => {
				const copy = Buffer.from(signature);
				copy.writeUInt8(copy.readUInt8(copy.length - 1) ^ 1, copy.length - 1);
				return copy;
			};
			expect(verifyAssertion(...signIn(from, (parts) => (parts.signature = changed)))).toEqual(refusal("signature"));
		});
	}

	test("RS256 takes PKCS #1 v1.5 only: a PSS signature by the right key is refused", () => {
		const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
		const from: Device = {
			algorithm: -257,
			id: randomBytes(32),
			handle: randomBytes(16),
			spki: spkiOf(pair.publicKey),
			cose: coseOf(-257, pair.publicKey),
			sign: (message) => sign("sha256", message, { key: pair.privateKey, padding: 6 }),
		};
		expect(verifyAssertion(...signIn(from))).toEqual(refusal("signature"));
	});

	test("authenticator data cut short", () => {
		for (let cut = 1; cut < 37; cut++)
			expect(verifyAssertion(...signIn(es256, (parts) => (parts.sentData = (data) => data.subarray(0, cut))))).toEqual(
				refusal("authenticator-data"),
			);
	});

	test("the counter is judged only after the signature, so a made-up answer cannot name a clone", () => {
		expect(
			verifyAssertion(
				...signIn(es256, (parts) => {
					parts.signer = other;
					parts.stored = { ...parts.stored, signCount: 99 };
				}),
			),
		).toEqual(refusal("signature"));
	});

	test("the counter may stay at zero, and otherwise has to grow", () => {
		const counts = (stored: number, sent: number) =>
			verifyAssertion(
				...signIn(es256, (parts) => {
					parts.signCount = sent;
					parts.stored = { ...parts.stored, signCount: stored };
				}),
			).ok;
		expect(counts(0, 0)).toBe(true);
		expect(counts(0, 1)).toBe(true);
		expect(counts(5, 6)).toBe(true);
		expect(counts(5, 0xffffffff)).toBe(true);
		expect(counts(0xffffffff, 0xffffffff)).toBe(false);
		expect(counts(1, 0)).toBe(false);
	});

	test("known and left alone: the twin of an ECDSA signature, with n - s for s, verifies too", () => {
		// Nothing uses a signature as an identity, and the caller spends the challenge on the first answer.
		expect(verifyAssertion(...signIn(es256, (parts) => (parts.signature = twin)))).toMatchObject({ ok: true });
	});
});

describe("the user handle a sign-in carries", () => {
	const handled = (userHandle: unknown) => {
		const [answer, stored, expected] = signIn(es256);
		return verifyAssertion({ ...answer, userHandle }, stored, expected);
	};

	test("is handed back as it was sent, for the caller to compare with the account", () => {
		const own = encoded(es256.handle);
		expect(handled(own)).toMatchObject({ ok: true, value: { userHandle: own } });
		// The key does not sign the handle, so another account's verifies too. What it means is the caller's to say.
		const other = encoded(randomBytes(16));
		expect(handled(other)).toMatchObject({ ok: true, value: { userHandle: other } });
	});

	test("is null when the authenticator gave none, whether null was sent or nothing", () => {
		expect(handled(null)).toMatchObject({ ok: true, value: { userHandle: null } });
		expect(handled(undefined)).toMatchObject({ ok: true, value: { userHandle: null } });
		const [absent, stored, expected] = signIn(es256, (parts) => (parts.userHandle = undefined));
		expect("userHandle" in absent).toBe(false);
		expect(verifyAssertion(absent, stored, expected)).toMatchObject({ ok: true, value: { userHandle: null } });
	});

	test("is at most 64 bytes", () => {
		for (const length of [1, 64]) expect(handled(encoded(Buffer.alloc(length, 1)))).toMatchObject({ ok: true });
		for (const length of [65, 100_000]) expect(handled(encoded(Buffer.alloc(length, 1)))).toEqual(refusal("too-large"));
	});

	test("is base64url in its one spelling", () => {
		for (const spoiled of ["+/+/", "QUJD=", "QUJ", "QR", "robin smith", "robin@example.org"])
			expect(handled(spoiled)).toEqual(refusal("encoding"));
	});

	test("is text or nothing, and never empty text", () => {
		for (const value of [42, 0, "", {}, [], true, false]) expect(handled(value)).toEqual(refusal("input"));
	});
});

/** A sign-in that sends `sent` as its client data, with a signature made over `signed` in its place. */
function signedOver(sent: Buffer, signed: Buffer, challenge: Challenge) {
	return verifyAssertion(
		...signIn(es256, (parts) => {
			parts.clientData = sent;
			parts.expected = { ...parts.expected, challenge };
			parts.message = (data) => Buffer.concat([data, sha256(signed)]);
		}),
	);
}

describe("input that is not what a page sends", () => {
	const [goodRegistration, registering] = registration(es256);
	const [goodSignIn, stored, signing] = signIn(es256);

	test("the two starting answers are accepted, so each refusal below has one cause", () => {
		expect(verifyRegistration(goodRegistration, registering).ok).toBe(true);
		expect(verifyAssertion(goodSignIn, stored, signing).ok).toBe(true);
	});

	test("anything but an object with every field, each of its type", () => {
		for (const input of [null, undefined, 7, "passkey", [], [goodRegistration], {}]) {
			expect(verifyRegistration(input, registering)).toEqual(refusal("input"));
			expect(verifyAssertion(input, stored, signing)).toEqual(refusal("input"));
		}
		for (const field of Object.keys(goodRegistration)) {
			for (const value of [undefined, null, 7.5, {}, [1], "", true]) {
				// A list is what transports are, and the test after this one is about what may be in it.
				if (field === "transports" && Array.isArray(value)) continue;
				expect(verifyRegistration({ ...goodRegistration, [field]: value }, registering)).toEqual(refusal("input"));
			}
		}
		for (const field of Object.keys(goodSignIn))
			for (const value of [undefined, null, 7, {}, [], "", true]) {
				// A sign-in may come with no user handle.
				if (field === "userHandle" && (value === undefined || value === null)) continue;
				expect(verifyAssertion({ ...goodSignIn, [field]: value }, stored, signing)).toEqual(refusal("input"));
			}
	});

	test("transports that are not a few short words", () => {
		for (const transports of [["USB"], ["usb "], [""], ["a".repeat(33)], [7], Array(9).fill("usb"), ["<script>"]])
			expect(verifyRegistration({ ...goodRegistration, transports }, registering)).toEqual(refusal("input"));
		expect(verifyRegistration({ ...goodRegistration, transports: [] }, registering)).toMatchObject({ ok: true });
		expect(verifyRegistration({ ...goodRegistration, transports: ["smart-card"] }, registering)).toMatchObject({
			ok: true,
		});
	});

	test("a field that is not base64url, or is a second spelling of its bytes", () => {
		// Standard base64, padding, white space, a length no encoding has, and loose bits in the last character.
		const spoil: ((text: string) => string)[] = [
			(text) => `+/${text.slice(2)}`,
			(text) => `${text}=`,
			(text) => `${text} `,
			(text) => `${text}\n`,
			(text) => `${text.slice(0, text.length - (text.length % 4))}A`,
			() => "QUJ",
			() => "QR",
			() => "é".repeat(8),
		];
		for (const spoiled of spoil) {
			for (const field of ["id", "clientDataJSON", "authenticatorData", "publicKey"] as const)
				expect(
					verifyRegistration({ ...goodRegistration, [field]: spoiled(goodRegistration[field]) }, registering),
				).toEqual(refusal("encoding"));
			for (const field of ["id", "clientDataJSON", "authenticatorData", "signature"] as const)
				expect(verifyAssertion({ ...goodSignIn, [field]: spoiled(goodSignIn[field]) }, stored, signing)).toEqual(
					refusal("encoding"),
				);
		}
	});

	test("a field one byte longer than its limit, and one far longer", () => {
		const limits = { id: 1023, clientDataJSON: 4096, authenticatorData: 4096, publicKey: 1100, signature: 1024 };
		for (const extra of [1, 1_000_000]) {
			const over = (field: keyof typeof limits): string => encoded(Buffer.alloc(limits[field] + extra, 1));
			for (const field of ["id", "clientDataJSON", "authenticatorData", "publicKey"] as const)
				expect(verifyRegistration({ ...goodRegistration, [field]: over(field) }, registering)).toEqual(
					refusal("too-large"),
				);
			for (const field of ["id", "clientDataJSON", "authenticatorData", "signature"] as const)
				expect(verifyAssertion({ ...goodSignIn, [field]: over(field) }, stored, signing)).toEqual(refusal("too-large"));
		}
	});

	test("a field exactly at its limit is read, and refused for what it holds", () => {
		expect(verifyRegistration({ ...goodRegistration, id: encoded(Buffer.alloc(1023, 1)) }, registering)).toEqual(
			refusal("credential-id"),
		);
		expect(
			verifyRegistration({ ...goodRegistration, clientDataJSON: encoded(Buffer.alloc(4096, 0x20)) }, registering),
		).toEqual(refusal("client-data"));
		expect(
			verifyRegistration({ ...goodRegistration, authenticatorData: encoded(Buffer.alloc(4096, 1)) }, registering),
		).toEqual(refusal("rp-id"));
		expect(verifyRegistration({ ...goodRegistration, publicKey: encoded(Buffer.alloc(1100, 1)) }, registering)).toEqual(
			refusal("key"),
		);
		expect(verifyAssertion({ ...goodSignIn, signature: encoded(Buffer.alloc(1024, 1)) }, stored, signing)).toEqual(
			refusal("signature"),
		);
	});

	test("client data that is not JSON, not an object, or not the object a browser writes", () => {
		const challenge = newChallenge();
		for (const type of ["webauthn.create", "webauthn.get"]) {
			const whole = `{"type":"${type}","challenge":"${challenge}","origin":"${ORIGIN}"}`;
			const judged = (clientData: Buffer) => {
				const change = (parts: Registration | SignIn): void => {
					parts.clientData = clientData;
					parts.expected = { ...parts.expected, challenge };
				};
				return type === "webauthn.create"
					? verifyRegistration(...registration(es256, change))
					: verifyAssertion(...signIn(es256, change));
			};
			// The text every one below departs from is accepted.
			expect(judged(Buffer.from(whole)).ok).toBe(true);
			const texts = [
				" ",
				"{",
				type,
				"null",
				"true",
				"7",
				`"${type}"`,
				"[]",
				`[${whole}]`,
				"{}",
				`{"type":"${type}","challenge":"${challenge}"}`,
				`{"type":"${type}","origin":"${ORIGIN}"}`,
				`{"challenge":"${challenge}","origin":"${ORIGIN}"}`,
				`{"type":"${type}","challenge":"${challenge}","origin":["${ORIGIN}"]}`,
				`{"type":"${type}","challenge":7,"origin":"${ORIGIN}"}`,
				`{"type":["${type}"],"challenge":"${challenge}","origin":"${ORIGIN}"}`,
				`{"type":"${type}","challenge":"${challenge}","origin":"${ORIGIN}","crossOrigin":"false"}`,
				`{"type":"${type}","challenge":"${challenge}","origin":"${ORIGIN}","crossOrigin":null}`,
				`${whole} trailing`,
				`${whole}${whole}`,
			];
			const open = Buffer.from(`${whole.slice(0, -1)},"more":"`);
			const bytes = [
				...texts.map((text) => Buffer.from(text)),
				// Not UTF-8: a byte that continues nothing, at the end and inside a member that would be ignored; a
				// surrogate written as three bytes; and the whole text in UTF-16.
				Buffer.concat([Buffer.from(whole.slice(0, 20)), Buffer.from([0x80])]),
				Buffer.concat([open, Buffer.from([0x80]), Buffer.from('"}')]),
				Buffer.concat([open, Buffer.from([0xed, 0xa0, 0x80]), Buffer.from('"}')]),
				Buffer.from(whole, "utf16le"),
				// One byte-order mark is stripped. A second one is text, and no JSON begins with it.
				Buffer.concat([MARK, MARK, Buffer.from(whole)]),
			];
			// The member the bad bytes sit in is itself allowed.
			expect(judged(Buffer.concat([open, Buffer.from('é"}')])).ok).toBe(true);
			for (const clientData of bytes) expect(judged(clientData)).toEqual(refusal("client-data"));
		}
	});

	test("a byte-order mark before the client data is stripped, and what was signed is the bytes with it", () => {
		const challenge = newChallenge();
		const marked = (type: string): Buffer =>
			Buffer.concat([MARK, Buffer.from(`{"type":"${type}","challenge":"${challenge}","origin":"${ORIGIN}"}`)]);
		expect(
			verifyRegistration(
				...registration(es256, (parts) => {
					parts.clientData = marked("webauthn.create");
					parts.expected = { ...parts.expected, challenge };
				}),
			),
		).toMatchObject({ ok: true });
		const sent = marked("webauthn.get");
		expect(signedOver(sent, sent, challenge)).toMatchObject({ ok: true });
		// The text with the mark taken off is what the verifier reads. It is not what the key signed.
		expect(signedOver(sent, sent.subarray(MARK.length), challenge)).toEqual(refusal("signature"));
		expect(signedOver(sent.subarray(MARK.length), sent, challenge)).toEqual(refusal("signature"));
	});

	test("the signature is over the client data as it was sent, not as it reads or would be written again", () => {
		const challenge = newChallenge();
		// The members in another order, with spaces and a member the verifier ignores.
		const sent = Buffer.from(
			`{ "origin": "${ORIGIN}", "more": { "a": [1, 2] }, "challenge": "${challenge}", "type": "webauthn.get" } `,
		);
		const again = Buffer.from(JSON.stringify(JSON.parse(sent.toString())));
		expect(again.equals(sent)).toBe(false);
		expect(signedOver(sent, sent, challenge)).toMatchObject({ ok: true });
		expect(signedOver(again, again, challenge)).toMatchObject({ ok: true });
		expect(signedOver(sent, again, challenge)).toEqual(refusal("signature"));
		expect(signedOver(again, sent, challenge)).toEqual(refusal("signature"));
	});

	test("an expected challenge that is too short to be one matches nothing, not even itself", () => {
		for (const short of ["", "abc", "A".repeat(21)]) {
			const expected = { ...registering, challenge: short as Challenge };
			expect(
				verifyRegistration(
					...registration(es256, (parts) => {
						client("challenge", short)(parts);
						parts.expected = expected;
					}),
				),
			).toEqual(refusal("challenge"));
		}
	});
});

describe("whatever arrives, the verifier answers and does not throw", () => {
	const bytes = (maxLength: number) => fc.uint8Array({ maxLength }).map(encoded);
	const expected: Expected = { challenge: newChallenge(), origin: ORIGIN, rpId: RP_ID };
	const passkey = registered(es256);

	test("random bytes in every field are never a registration", () => {
		fc.assert(
			fc.property(
				fc.record({
					id: bytes(64),
					clientDataJSON: bytes(300),
					authenticatorData: bytes(300),
					publicKey: bytes(300),
					publicKeyAlgorithm: fc.oneof(fc.constantFrom(...ALGORITHMS), fc.integer()),
					transports: fc.array(fc.constantFrom("usb", "nfc", "ble", "hybrid", "internal"), { maxLength: 5 }),
				}),
				(input) => {
					expect(verifyRegistration(input, expected).ok).toBe(false);
				},
			),
			{ numRuns: 500 },
		);
	});

	test("random bytes in every field are never a sign-in", () => {
		fc.assert(
			fc.property(
				fc.record({
					id: bytes(64),
					clientDataJSON: bytes(300),
					authenticatorData: bytes(300),
					signature: bytes(300),
					userHandle: fc.option(bytes(80), { nil: null }),
				}),
				fc.constantFrom(...ALGORITHMS),
				(input, algorithm) => {
					const stored = registered(DEVICES[algorithm]);
					expect(verifyAssertion(input, stored, expected).ok).toBe(false);
					// And with the right credential id, so the check of it does not end the run early.
					expect(verifyAssertion({ ...input, id: stored.credentialId }, stored, expected).ok).toBe(false);
				},
			),
			{ numRuns: 500 },
		);
	});

	test("random values of any kind in any field are refused", () => {
		const field = fc.oneof(fc.anything(), fc.string(), bytes(100));
		fc.assert(
			fc.property(
				fc.oneof(
					fc.anything(),
					fc.record(
						{
							id: field,
							clientDataJSON: field,
							authenticatorData: field,
							publicKey: field,
							publicKeyAlgorithm: field,
							transports: field,
							signature: field,
							userHandle: field,
						},
						{ requiredKeys: [] },
					),
				),
				(input) => {
					expect(verifyRegistration(input, expected).ok).toBe(false);
					expect(verifyAssertion(input, passkey, expected).ok).toBe(false);
				},
			),
			{ numRuns: 500 },
		);
	});

	test("random authenticator data behind correct client data never throws, and no random signature verifies", () => {
		// The client data is right and the fixed part of the data is ours, so the run reaches the code that
		// measures and slices what follows, and the code that verifies.
		const clientDataOf = (type: string): string =>
			encoded(Buffer.from(JSON.stringify({ type, challenge: expected.challenge, origin: ORIGIN })));
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 255 }),
				fc.uint8Array({ maxLength: 120 }),
				fc.uint8Array({ minLength: 1, maxLength: 40 }),
				fc.uint8Array({ minLength: 1, maxLength: 300 }),
				fc.constantFrom(...ALGORITHMS),
				(flags, rest, id, signature, algorithm) => {
					const data = encoded(Buffer.concat([authenticatorData({ rpId: RP_ID, flags, signCount: 3 }), rest]));
					const from = DEVICES[algorithm];
					const made = verifyRegistration(
						{
							id: encoded(id),
							clientDataJSON: clientDataOf("webauthn.create"),
							authenticatorData: data,
							publicKey: encoded(from.spki),
							publicKeyAlgorithm: algorithm,
							transports: [],
						},
						expected,
					);
					// Nothing signs a registration, so random data that happens to be laid out like one is one.
					// What is accepted is at least what was sent.
					if (made.ok) expect(made.value.credentialId).toBe(encoded(id));
					const stored = registered(from);
					const used = verifyAssertion(
						{
							id: stored.credentialId,
							clientDataJSON: clientDataOf("webauthn.get"),
							authenticatorData: data,
							signature: encoded(signature),
						},
						stored,
						expected,
					);
					expect(used.ok).toBe(false);
				},
			),
			{ numRuns: 1000 },
		);
	});

	test("one bit changed anywhere in a correct sign-in is refused", () => {
		const answers = ALGORITHMS.map((algorithm) => signIn(DEVICES[algorithm]));
		fc.assert(
			fc.property(
				fc.constantFrom(...answers),
				fc.constantFrom("id", "clientDataJSON", "authenticatorData", "signature" as const),
				fc.nat(),
				fc.integer({ min: 0, max: 7 }),
				([answer, stored, expecting], field, at, bit) => {
					const changed = Buffer.from(answer[field], "base64url");
					const index = at % changed.length;
					changed.writeUInt8(changed.readUInt8(index) ^ (1 << bit), index);
					expect(verifyAssertion({ ...answer, [field]: encoded(changed) }, stored, expecting).ok).toBe(false);
				},
			),
			{ numRuns: 1000 },
		);
	});
});

describe("what the page is told to ask for", () => {
	test("a challenge is 32 random bytes in base64url, and no two are alike", () => {
		const made = Array.from({ length: 200 }, newChallenge);
		for (const challenge of made) {
			expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
			expect(Buffer.from(challenge, "base64url")).toHaveLength(32);
		}
		expect(new Set(made).size).toBe(200);
	});

	test("registration asks for a key kept on the authenticator, a verified person and no attestation", () => {
		const challenge = newChallenge();
		const options = registrationOptions({
			rpId: RP_ID,
			rpName: "Mainworthy",
			user: { handle: "cm9iaW4", name: "robin", displayName: "Robin" },
			challenge,
			exclude: [{ credentialId: "AQID", transports: ["usb"] }],
		});
		expect(options).toEqual({
			rp: { id: RP_ID, name: "Mainworthy" },
			user: { id: "cm9iaW4", name: "robin", displayName: "Robin" },
			challenge,
			pubKeyCredParams: [
				{ type: "public-key", alg: -7 },
				{ type: "public-key", alg: -8 },
				{ type: "public-key", alg: -257 },
			],
			timeout: CEREMONY_MS,
			attestation: "none",
			authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
			excludeCredentials: [{ type: "public-key", id: "AQID", transports: ["usb"] }],
		});
		// Nothing in it is lost on the way to the page.
		expect(JSON.parse(JSON.stringify(options))).toEqual(options);
	});

	test("the handle a key is filed under is base64url of 1 to 64 bytes, or no options are made", () => {
		const withHandle = (handle: string) =>
			registrationOptions({
				rpId: RP_ID,
				rpName: "Mainworthy",
				user: { handle, name: "robin", displayName: "Robin" },
				challenge: newChallenge(),
				exclude: [],
			});
		for (const handle of ["AQ", encoded(Buffer.alloc(64, 1))]) expect(withHandle(handle).user.id).toBe(handle);
		for (const handle of ["", encoded(Buffer.alloc(65, 1)), "robin", "robin@example.org", "+/+/", "QUJD="])
			expect(() => withHandle(handle)).toThrow("user handle");
	});

	test("sign-in asks for a verified person, and names passkeys only when it is given them", () => {
		const challenge = newChallenge();
		expect(assertionOptions({ rpId: RP_ID, challenge, allow: [] })).toEqual({
			rpId: RP_ID,
			challenge,
			timeout: CEREMONY_MS,
			userVerification: "required",
			allowCredentials: [],
		});
		expect(assertionOptions({ rpId: RP_ID, challenge, allow: [registered(es256)] }).allowCredentials).toEqual([
			{ type: "public-key", id: encoded(es256.id), transports: ["internal", "hybrid"] },
		]);
	});

	test("every algorithm that is offered is one a registration is accepted with, and the reverse", () => {
		const offered = registrationOptions({
			rpId: RP_ID,
			rpName: "Mainworthy",
			user: { handle: "cm9iaW4", name: "robin", displayName: "Robin" },
			challenge: newChallenge(),
			exclude: [],
		}).pubKeyCredParams.map((param) => param.alg);
		for (const algorithm of offered) expect(verifyRegistration(...registration(DEVICES[algorithm])).ok).toBe(true);
		expect(offered).toEqual([...ALGORITHMS]);
	});

	test("the relying party is the host of an https address, or of localhost", () => {
		expect(relyingParty("https://mainworthy.com")).toEqual({ id: "mainworthy.com", origin: "https://mainworthy.com" });
		expect(relyingParty("https://Mainworthy.com:443/p/scratch?x=1")).toEqual({
			id: "mainworthy.com",
			origin: "https://mainworthy.com",
		});
		expect(relyingParty("https://tests.example.org:8443/")).toEqual({
			id: "tests.example.org",
			origin: "https://tests.example.org:8443",
		});
		expect(relyingParty("http://localhost:7357")).toEqual({ id: "localhost", origin: "http://localhost:7357" });
		expect(relyingParty("http://app.localhost:7357")).toEqual({
			id: "app.localhost",
			origin: "http://app.localhost:7357",
		});
	});

	test("there is no relying party at an IP address, on plain http elsewhere, or at no address", () => {
		for (const address of [
			"http://127.0.0.1:7357",
			"https://127.0.0.1",
			"http://2130706433:7357",
			"https://192.168.1.20:7357",
			"http://[::1]:7357",
			"https://[2001:db8::1]",
			"http://mainworthy.com",
			"http://notlocalhost:7357",
			"http://localhost.example.org",
			"ftp://localhost",
			"file:///home/robin/index.html",
			"mainworthy.com",
			"",
		])
			expect(relyingParty(address)).toBeNull();
	});
});
