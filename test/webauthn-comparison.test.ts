// The passkey verifier (`src/server/identity/webauthn.ts`, decision 0017) beside `@simplewebauthn/server`, fed the
// same answers (#419). The library is a dev dependency and nothing in `src/` imports it, so it never ships.
//
// Each case below is one answer, built once and handed to both: ours gets what the page sends (the authenticator
// data, the key as SPKI and its algorithm), the library gets the standard JSON with a `none` attestation object
// wrapped around the same authenticator data and the key in COSE form. The library is told what ours always
// asks: user presence and verification, one origin, one RP ID and the three algorithms ours offers.
//
// Where the two part, the case says why. Ours refusing what the library accepts is a stricter rule ours keeps on
// purpose. Ours accepting what the library refuses is a defect, with one exception: a difference in a part ours
// never reads (the attestation object, the CBOR copy of the key inside registration data, extension data and
// token binding), each named at the top of `webauthn.ts`. Those cases are marked `unread`, and no other may be.
import { describe, expect, test } from "bun:test";
import { createHash, createPublicKey, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type AuthenticationResponseJSON,
	type RegistrationResponseJSON,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { decodeAttestationObject, isoBase64URL, isoCBOR, parseAuthenticatorData } from "@simplewebauthn/server/helpers";
import {
	ALGORITHMS,
	type Challenge,
	type Expected,
	newChallenge,
	type Refusal,
	type StoredPasskey,
	verifyAssertion,
	verifyRegistration,
} from "../src/server/identity/webauthn.ts";

const ORIGIN = "https://mainworthy.com";
const RP_ID = "mainworthy.com";
const CHALLENGE = newChallenge();
const EXPECTED: Expected = { challenge: CHALLENGE, origin: ORIGIN, rpId: RP_ID };
const UP = 0x01;
const UV = 0x04;
const BE = 0x08;
const BS = 0x10;
const AT = 0x40;
const ED = 0x80;

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const sha256 = (bytes: Uint8Array): Buffer => createHash("sha256").update(bytes).digest();
/** A COSE key, or any CBOR map with numbers for labels, as the library's decoder reads it. */
const coseMap = (bytes: Uint8Array): Map<number, unknown> => isoCBOR.decodeFirst(Uint8Array.from(bytes));
const cbor = (value: unknown): Buffer => Buffer.from(isoCBOR.encode(value as Parameters<typeof isoCBOR.encode>[0]));

/** A key an authenticator holds: the public half in both forms, and a way to sign. */
type Key = {
	readonly algorithm: number;
	readonly spki: Buffer;
	readonly cose: Buffer;
	readonly sign: (message: Buffer) => Buffer;
	/** ES256 only: the signature as the two numbers r and s, for building other spellings of it. */
	readonly signRS?: (message: Buffer) => { r: bigint; s: bigint };
};

/** The key in COSE form, as an authenticator writes it into its data and as the library stores it. */
function coseOf(algorithm: number, key: KeyObject): Buffer {
	const jwk = key.export({ format: "jwk" });
	const part = (value: string | undefined): Uint8Array => new Uint8Array(Buffer.from(value ?? "", "base64url"));
	if (jwk.kty === "EC") {
		const crv = jwk.crv === "P-256" ? 1 : jwk.crv === "P-384" ? 2 : 3;
		return cbor(
			new Map<number, number | Uint8Array>([
				[1, 2],
				[3, algorithm],
				[-1, crv],
				[-2, part(jwk.x)],
				[-3, part(jwk.y)],
			]),
		);
	}
	if (jwk.kty === "OKP") {
		return cbor(
			new Map<number, number | Uint8Array>([
				[1, 1],
				[3, algorithm],
				[-1, 6],
				[-2, part(jwk.x)],
			]),
		);
	}
	return cbor(
		new Map<number, number | Uint8Array>([
			[1, 3],
			[3, algorithm],
			[-1, part(jwk.n)],
			[-2, part(jwk.e)],
		]),
	);
}

const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const bigOf = (bytes: Uint8Array): bigint => BigInt(`0x${Buffer.from(bytes).toString("hex") || "0"}`);
/** An ASN.1 DER sequence of two integers, the form an authenticator sends an ECDSA signature in. */
function der(r: bigint, s: bigint): Buffer {
	const integer = (value: bigint): Buffer => {
		let hex = value.toString(16);
		if (hex.length % 2) hex = `0${hex}`;
		let bytes = Buffer.from(hex, "hex");
		if ((bytes[0] ?? 0) & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
		return Buffer.concat([Buffer.from([0x02, bytes.length]), bytes]);
	};
	const body = Buffer.concat([integer(r), integer(s)]);
	return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

function key(kind: "ES256" | "EdDSA" | "RS256" | "RS256-1024" | "ES384" | "PS256"): Key {
	if (kind === "ES256" || kind === "ES384") {
		const pair = generateKeyPairSync("ec", { namedCurve: kind === "ES256" ? "prime256v1" : "secp384r1" });
		const algorithm = kind === "ES256" ? -7 : -35;
		const hash = kind === "ES256" ? "sha256" : "sha384";
		const signRS = (message: Buffer) => {
			const raw = sign(hash, message, { key: pair.privateKey, dsaEncoding: "ieee-p1363" });
			const half = raw.length / 2;
			return { r: bigOf(raw.subarray(0, half)), s: bigOf(raw.subarray(half)) };
		};
		return {
			algorithm,
			spki: pair.publicKey.export({ format: "der", type: "spki" }),
			cose: coseOf(algorithm, pair.publicKey),
			sign: (message) => {
				const { r, s } = signRS(message);
				return der(r, s);
			},
			signRS,
		};
	}
	if (kind === "EdDSA") {
		const pair = generateKeyPairSync("ed25519");
		return {
			algorithm: -8,
			spki: pair.publicKey.export({ format: "der", type: "spki" }),
			cose: coseOf(-8, pair.publicKey),
			sign: (message) => sign(null, message, pair.privateKey),
		};
	}
	const pair = generateKeyPairSync("rsa", { modulusLength: kind === "RS256-1024" ? 1024 : 2048 });
	const algorithm = kind === "PS256" ? -37 : -257;
	return {
		algorithm,
		spki: pair.publicKey.export({ format: "der", type: "spki" }),
		cose: coseOf(algorithm, pair.publicKey),
		sign: (message) => sign("sha256", message, pair.privateKey),
	};
}
const ES256 = key("ES256");
const EDDSA = key("EdDSA");
const RS256 = key("RS256");
const OTHER = key("ES256");

const clientData = (type: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
	type,
	challenge: CHALLENGE,
	origin: ORIGIN,
	crossOrigin: false,
	...extra,
});
const clientDataBytes = (value: Record<string, unknown> | Buffer): Buffer =>
	Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));

function fixed(rpId: string, flags: number, signCount: number): Buffer {
	const out = Buffer.alloc(37);
	sha256(Buffer.from(rpId)).copy(out, 0);
	out.writeUInt8(flags, 32);
	out.writeUInt32BE(signCount, 33);
	return out;
}

/** What the library's verifier says of an answer: it throws or says unverified for every refusal. */
type LibraryVerdict = "accepted" | "refused";
async function libraryVerdict(run: () => Promise<{ verified: boolean }>): Promise<LibraryVerdict> {
	try {
		return (await run()).verified ? "accepted" : "refused";
	} catch {
		return "refused";
	}
}
const oursVerdict = (verdict: { ok: true } | { ok: false; reason: Refusal }): "accepted" | Refusal =>
	verdict.ok ? "accepted" : verdict.reason;

// ---------------------------------------------------------------------------------------------------------------
// Registration

/** Everything a registration is made of. A case changes one part. */
type Registration = {
	clientData: Record<string, unknown> | Buffer;
	rpId: string;
	flags: number;
	signCount: number;
	/** The credential id inside the authenticator data, and the one sent beside it. */
	idInside: Buffer;
	id: string;
	/** The key's copy inside the authenticator data. */
	cose: Buffer;
	/** Bytes after the key's copy: extension data when the flags say so. */
	after: Buffer;
	/** The authenticator data as sent, when it is not the one built from the parts. */
	authData: (built: Buffer) => Buffer;
	/** The attestation object around the authenticator data, for the library. */
	attestation: (authData: Buffer) => unknown;
	/** What ours is sent as the key and its algorithm. */
	spki: Buffer;
	algorithm: number;
};

const ID = Buffer.alloc(32, 7);
const noneAttestation = (authData: Buffer): Map<string, unknown> =>
	new Map<string, unknown>([
		["fmt", "none"],
		["attStmt", new Map()],
		["authData", new Uint8Array(authData)],
	]);

function registration(key: Key, change: (parts: Registration) => void = () => {}): Registration {
	const parts: Registration = {
		clientData: clientData("webauthn.create"),
		rpId: RP_ID,
		flags: UP | UV | AT,
		signCount: 0,
		idInside: ID,
		id: b64(ID),
		cose: key.cose,
		after: Buffer.alloc(0),
		authData: (built) => built,
		attestation: noneAttestation,
		spki: key.spki,
		algorithm: key.algorithm,
	};
	change(parts);
	return parts;
}

function registrationAuthData(parts: Registration): Buffer {
	const length = Buffer.alloc(2);
	length.writeUInt16BE(parts.idInside.length);
	const built = Buffer.concat([
		fixed(parts.rpId, parts.flags, parts.signCount),
		Buffer.alloc(16),
		length,
		parts.idInside,
		parts.cose,
		parts.after,
	]);
	return parts.authData(built);
}

async function bothRegister(parts: Registration) {
	const authData = registrationAuthData(parts);
	const clientDataJSON = b64(clientDataBytes(parts.clientData));
	const ours = verifyRegistration(
		{
			id: parts.id,
			clientDataJSON,
			authenticatorData: b64(authData),
			publicKey: b64(parts.spki),
			publicKeyAlgorithm: parts.algorithm,
			transports: ["internal"],
		},
		EXPECTED,
	);
	const response: RegistrationResponseJSON = {
		id: parts.id,
		rawId: parts.id,
		type: "public-key",
		response: { clientDataJSON, attestationObject: b64(cbor(parts.attestation(authData))), transports: ["internal"] },
		clientExtensionResults: {},
	};
	const library = await libraryVerdict(() =>
		verifyRegistrationResponse({
			response,
			expectedChallenge: CHALLENGE,
			expectedOrigin: ORIGIN,
			expectedRPID: RP_ID,
			requireUserPresence: true,
			requireUserVerification: true,
			supportedAlgorithmIDs: [...ALGORITHMS],
		}),
	);
	return { ours: oursVerdict(ours), library };
}

// ---------------------------------------------------------------------------------------------------------------
// Sign-in

type Assertion = {
	/** The key that signs, and the one stored for the credential. */
	signer: Key;
	stored: Key;
	clientData: Record<string, unknown> | Buffer;
	rpId: string;
	flags: number;
	signCount: number;
	storedCount: number;
	/** Bytes after the fixed part: extension data when the flags say so. */
	after: Buffer;
	/** The authenticator data as sent, changed after it was signed. */
	afterSigning: (signed: Buffer) => Buffer;
	/** The signature as sent. */
	signature: (key: Key, message: Buffer) => Buffer;
	id: string;
	storedId: string;
	userHandle: string | null;
	/** The stored key, when it is not the stored key's own: SPKI for ours, COSE for the library. */
	storedSpki: Buffer | null;
	storedCose: Buffer | null;
};

function assertion(key: Key, change: (parts: Assertion) => void = () => {}): Assertion {
	const parts: Assertion = {
		signer: key,
		stored: key,
		clientData: clientData("webauthn.get"),
		rpId: RP_ID,
		flags: UP | UV,
		signCount: 8,
		storedCount: 7,
		after: Buffer.alloc(0),
		afterSigning: (signed) => signed,
		signature: (signer, message) => signer.sign(message),
		id: b64(ID),
		storedId: b64(ID),
		userHandle: b64(Buffer.alloc(16, 1)),
		storedSpki: null,
		storedCose: null,
	};
	change(parts);
	return parts;
}

/** What the authenticator signs: its data, then the SHA-256 of the client data. */
const signedPart = (parts: Assertion): Buffer =>
	Buffer.concat([fixed(parts.rpId, parts.flags, parts.signCount), parts.after]);
const messageOf = (parts: Assertion): Buffer =>
	Buffer.concat([signedPart(parts), sha256(clientDataBytes(parts.clientData))]);

async function bothSignIn(parts: Assertion) {
	const clientBytes = clientDataBytes(parts.clientData);
	const signed = signedPart(parts);
	const signature = parts.signature(parts.signer, messageOf(parts));
	const authData = parts.afterSigning(signed);
	const clientDataJSON = b64(clientBytes);
	const stored: StoredPasskey = {
		credentialId: parts.storedId,
		publicKey: b64(parts.storedSpki ?? parts.stored.spki),
		algorithm: parts.stored.algorithm as StoredPasskey["algorithm"],
		signCount: parts.storedCount,
	};
	const ours = verifyAssertion(
		{
			id: parts.id,
			clientDataJSON,
			authenticatorData: b64(authData),
			signature: b64(signature),
			userHandle: parts.userHandle,
		},
		stored,
		EXPECTED,
	);
	const response: AuthenticationResponseJSON = {
		id: parts.id,
		rawId: parts.id,
		type: "public-key",
		response: {
			clientDataJSON,
			authenticatorData: b64(authData),
			signature: b64(signature),
			...(parts.userHandle === null ? {} : { userHandle: parts.userHandle }),
		},
		clientExtensionResults: {},
	};
	const library = await libraryVerdict(() =>
		verifyAuthenticationResponse({
			response,
			expectedChallenge: CHALLENGE,
			expectedOrigin: ORIGIN,
			expectedRPID: RP_ID,
			requireUserVerification: true,
			credential: {
				id: parts.storedId,
				publicKey: new Uint8Array(parts.storedCose ?? parts.stored.cose),
				counter: parts.storedCount,
			},
		}),
	);
	return { ours: oursVerdict(ours), library };
}

// ---------------------------------------------------------------------------------------------------------------
// The cases

type Outcome = { readonly ours: "accepted" | Refusal; readonly library: LibraryVerdict };
type Case = {
	readonly name: string;
	readonly run: () => Promise<Outcome>;
	readonly expect: Outcome;
	/** Why the two part, where they do. */
	readonly because?: string;
	/** Ours accepts what the library refuses, and the difference is in bytes ours never reads. */
	readonly unread?: true;
};

const reg = (name: string, parts: Registration, expect: Outcome, notes: Partial<Case> = {}): Case => ({
	name: `registration: ${name}`,
	run: () => bothRegister(parts),
	expect,
	...notes,
});
const get = (name: string, parts: Assertion, expect: Outcome, notes: Partial<Case> = {}): Case => ({
	name: `sign-in: ${name}`,
	run: () => bothSignIn(parts),
	expect,
	...notes,
});
const BOTH_ACCEPT: Outcome = { ours: "accepted", library: "accepted" };
const refusedBy = (ours: Refusal, library: LibraryVerdict = "refused"): Outcome => ({ ours, library });
const UNREAD_CBOR = "ours does not read the CBOR copy of the key: it verifies with the SPKI sent beside it";
const UNREAD_EXTENSIONS = "extension data is not used, and at sign-in the key signed it";
const UNREAD_ATTESTATION = "ours is sent the authenticator data alone and never sees the attestation object";
const UNREAD_TOKEN_BINDING = "token binding is not read: no browser implements it";

/** An RS256 sign-in whose signature starts with a zero byte, sent with that byte dropped. */
function rsaSignatureOneByteShort(): Assertion {
	for (let signCount = 8; signCount < 10_000; signCount++) {
		const parts = assertion(RS256, (p) => {
			p.signCount = signCount;
		});
		if (RS256.sign(messageOf(parts))[0] === 0) {
			parts.signature = (signer, message) => signer.sign(message).subarray(1);
			return parts;
		}
	}
	throw new Error("no RS256 signature starting with zero");
}

const truncatedCose = (built: Buffer): Buffer => built.subarray(0, built.length - 10);

const CASES: Case[] = [
	// Answers both accept.
	reg("ES256", registration(ES256), BOTH_ACCEPT),
	reg("EdDSA", registration(EDDSA), BOTH_ACCEPT),
	reg("RS256", registration(RS256), BOTH_ACCEPT),
	reg(
		"backed up and eligible",
		registration(ES256, (p) => {
			p.flags |= BE | BS;
		}),
		BOTH_ACCEPT,
	),
	reg(
		"a well-formed extension",
		registration(ES256, (p) => {
			p.flags |= ED;
			p.after = cbor(new Map([["credProtect", 2]]));
		}),
		BOTH_ACCEPT,
	),
	reg(
		"the key's copy inside is another key than the SPKI beside it",
		registration(ES256, (p) => {
			p.cose = OTHER.cose;
		}),
		BOTH_ACCEPT,
	),
	get("ES256", assertion(ES256), BOTH_ACCEPT),
	get("EdDSA", assertion(EDDSA), BOTH_ACCEPT),
	get("RS256", assertion(RS256), BOTH_ACCEPT),
	get(
		"a counter of zero against a stored zero",
		assertion(ES256, (p) => {
			p.signCount = 0;
			p.storedCount = 0;
		}),
		BOTH_ACCEPT,
	),
	get(
		"the high-S twin of an ES256 signature",
		assertion(ES256, (p) => {
			p.signature = (signer, message) => {
				const signRS = signer.signRS;
				if (!signRS) throw new Error("ES256 only");
				const { r, s } = signRS(message);
				return der(r, P256_N - s);
			};
		}),
		BOTH_ACCEPT,
	),
	get(
		"a well-formed extension, signed",
		assertion(ES256, (p) => {
			p.flags |= ED;
			p.after = cbor(new Map([["credProtect", 2]]));
		}),
		BOTH_ACCEPT,
	),
	get(
		"no user handle",
		assertion(ES256, (p) => {
			p.userHandle = null;
		}),
		BOTH_ACCEPT,
	),

	// Wrong origin, ceremony, challenge or relying party.
	reg(
		"another origin",
		registration(ES256, (p) => {
			p.clientData = clientData("webauthn.create", { origin: "https://evil.example" });
		}),
		refusedBy("origin"),
	),
	reg(
		"a look-alike origin",
		registration(ES256, (p) => {
			p.clientData = clientData("webauthn.create", { origin: "https://mainworthy.com.example" });
		}),
		refusedBy("origin"),
	),
	reg(
		"the origin with a port",
		registration(ES256, (p) => {
			p.clientData = clientData("webauthn.create", { origin: "https://mainworthy.com:8443" });
		}),
		refusedBy("origin"),
	),
	reg(
		"the origin over http",
		registration(ES256, (p) => {
			p.clientData = clientData("webauthn.create", { origin: "http://mainworthy.com" });
		}),
		refusedBy("origin"),
	),
	reg(
		"a sign-in offered as a registration",
		registration(ES256, (p) => {
			p.clientData = clientData("webauthn.get");
		}),
		refusedBy("type"),
	),
	reg(
		"another challenge",
		registration(ES256, (p) => {
			p.clientData = clientData("webauthn.create", { challenge: newChallenge() });
		}),
		refusedBy("challenge"),
	),
	reg(
		"another RP ID hash",
		registration(ES256, (p) => {
			p.rpId = "evil.example";
		}),
		refusedBy("rp-id"),
	),
	reg(
		"a parent domain's RP ID hash",
		registration(ES256, (p) => {
			p.rpId = "com";
		}),
		refusedBy("rp-id"),
	),
	get(
		"another origin",
		assertion(ES256, (p) => {
			p.clientData = clientData("webauthn.get", { origin: "https://evil.example" });
		}),
		refusedBy("origin"),
	),
	get(
		"a registration offered as a sign-in",
		assertion(ES256, (p) => {
			p.clientData = clientData("webauthn.create");
		}),
		refusedBy("type"),
	),
	get(
		"another challenge",
		assertion(ES256, (p) => {
			p.clientData = clientData("webauthn.get", { challenge: newChallenge() });
		}),
		refusedBy("challenge"),
	),
	get(
		"another RP ID hash",
		assertion(ES256, (p) => {
			p.rpId = "evil.example";
		}),
		refusedBy("rp-id"),
	),
	get(
		"a top origin without crossOrigin",
		assertion(ES256, (p) => {
			p.clientData = clientData("webauthn.get", { topOrigin: "https://evil.example" });
		}),
		refusedBy("cross-origin"),
	),
	get(
		"crossOrigin with a top origin",
		assertion(ES256, (p) => {
			p.clientData = clientData("webauthn.get", { crossOrigin: true, topOrigin: "https://evil.example" });
		}),
		refusedBy("cross-origin"),
	),

	// Presence, verification and backup flags.
	reg(
		"nobody present",
		registration(ES256, (p) => {
			p.flags = UV | AT;
		}),
		refusedBy("user-not-present"),
	),
	reg(
		"present but not verified",
		registration(ES256, (p) => {
			p.flags = UP | AT;
		}),
		refusedBy("user-not-verified"),
	),
	reg(
		"backed up but not eligible",
		registration(ES256, (p) => {
			p.flags |= BS;
		}),
		refusedBy("backup-flags"),
	),
	reg(
		"no credential data",
		registration(ES256, (p) => {
			p.flags = UP | UV;
		}),
		refusedBy("no-credential-data"),
	),
	get(
		"nobody present",
		assertion(ES256, (p) => {
			p.flags = UV;
		}),
		refusedBy("user-not-present"),
	),
	get(
		"present but not verified",
		assertion(ES256, (p) => {
			p.flags = UP;
		}),
		refusedBy("user-not-verified"),
	),
	get(
		"backed up but not eligible",
		assertion(ES256, (p) => {
			p.flags |= BS;
		}),
		refusedBy("backup-flags"),
	),

	// The counter.
	get(
		"a counter going backwards",
		assertion(ES256, (p) => {
			p.signCount = 5;
			p.storedCount = 10;
		}),
		refusedBy("possibly-cloned"),
	),
	get(
		"a counter that stayed put",
		assertion(ES256, (p) => {
			p.signCount = 10;
			p.storedCount = 10;
		}),
		refusedBy("possibly-cloned"),
	),
	get(
		"a counter of zero against a stored count",
		assertion(ES256, (p) => {
			p.signCount = 0;
			p.storedCount = 3;
		}),
		refusedBy("possibly-cloned"),
	),

	// Signatures.
	get(
		"signed by another key",
		assertion(ES256, (p) => {
			p.signer = OTHER;
		}),
		refusedBy("signature"),
	),
	get(
		"the counter changed after signing",
		assertion(ES256, (p) => {
			p.afterSigning = (signed) => {
				const out = Buffer.from(signed);
				out.writeUInt32BE(1000, 33);
				return out;
			};
		}),
		refusedBy("signature"),
	),
	get(
		"the flags changed after signing",
		assertion(ES256, (p) => {
			p.afterSigning = (signed) => {
				const out = Buffer.from(signed);
				out.writeUInt8(UP | UV | BE, 32);
				return out;
			};
		}),
		refusedBy("signature"),
	),
	get(
		"an ES256 signature as bare r and s",
		assertion(ES256, (p) => {
			p.signature = (signer, message) => {
				const signRS = signer.signRS;
				if (!signRS) throw new Error("ES256 only");
				const { r, s } = signRS(message);
				return Buffer.from(`${r.toString(16).padStart(64, "0")}${s.toString(16).padStart(64, "0")}`, "hex");
			};
		}),
		refusedBy("signature"),
	),
	get(
		"an ES256 signature with a byte after it",
		assertion(ES256, (p) => {
			p.signature = (signer, message) => Buffer.concat([signer.sign(message), Buffer.from([0])]);
		}),
		{ ours: "signature", library: "accepted" },
		{
			because:
				"a DER signature has one spelling, and `node:crypto` refuses a trailing byte; the library's parser skips it",
		},
	),
	get(
		"an EdDSA signature over another message",
		assertion(EDDSA, (p) => {
			p.signature = (signer, message) => signer.sign(Buffer.concat([message, Buffer.from([0])]));
		}),
		refusedBy("signature"),
	),

	// Algorithms and keys.
	reg("ES384, not offered", registration(key("ES384")), refusedBy("algorithm")),
	reg("PS256, not offered", registration(key("PS256")), refusedBy("algorithm")),
	reg(
		"an RS256 key of 1024 bits",
		registration(key("RS256-1024")),
		{ ours: "key-too-weak", library: "accepted" },
		{ because: "ours refuses an RSA modulus under 2048 bits; the library takes any size" },
	),
	reg(
		"the SPKI is not a key",
		registration(ES256, (p) => {
			p.spki = Buffer.from("not a key");
		}),
		{ ours: "key", library: "accepted" },
		{ because: "ours stores the SPKI the page sends and checks it; the library never sees it" },
	),
	get(
		"the stored key is not a key",
		assertion(ES256, (p) => {
			p.storedSpki = Buffer.from("not a key");
			p.storedCose = Buffer.from([0xa1, 0x01]);
		}),
		refusedBy("key"),
	),
	get(
		"the stored key is of another algorithm than the one stored beside it",
		assertion(ES256, (p) => {
			p.stored = { ...ES256, algorithm: -8 };
			p.storedCose = coseOf(-8, createPublicKey({ key: ES256.spki, format: "der", type: "spki" }));
		}),
		refusedBy("key-mismatch"),
	),

	// Malformed and truncated authenticator data, and the CBOR inside it.
	reg(
		"authenticator data shorter than its fixed part",
		registration(ES256, (p) => {
			p.authData = (built) => built.subarray(0, 36);
		}),
		refusedBy("authenticator-data"),
	),
	reg(
		"cut inside the credential id",
		registration(ES256, (p) => {
			p.authData = (built) => built.subarray(0, 37 + 18 + 10);
		}),
		refusedBy("authenticator-data"),
	),
	reg(
		"cut right after the credential id",
		registration(ES256, (p) => {
			p.authData = (built) => built.subarray(0, 37 + 18 + 32);
		}),
		refusedBy("authenticator-data"),
	),
	reg(
		"cut inside the key's copy",
		registration(ES256, (p) => {
			p.authData = truncatedCose;
		}),
		{ ours: "accepted", library: "refused" },
		{ because: UNREAD_CBOR, unread: true },
	),
	reg(
		"the key's copy is not CBOR",
		registration(ES256, (p) => {
			p.cose = Buffer.from([0xff, 0xff, 0xff]);
		}),
		{ ours: "accepted", library: "refused" },
		{ because: UNREAD_CBOR, unread: true },
	),
	reg(
		"the key's copy has no algorithm",
		registration(ES256, (p) => {
			const map = coseMap(ES256.cose);
			map.delete(3);
			p.cose = cbor(map);
		}),
		{ ours: "accepted", library: "refused" },
		{ because: UNREAD_CBOR, unread: true },
	),
	reg(
		"bytes after the key's copy with no extension flag",
		registration(ES256, (p) => {
			p.after = Buffer.from([1, 2, 3]);
		}),
		{ ours: "accepted", library: "refused" },
		{ because: UNREAD_CBOR, unread: true },
	),
	reg(
		"the extension flag with no extension data",
		registration(ES256, (p) => {
			p.flags |= ED;
		}),
		{ ours: "accepted", library: "refused" },
		{ because: UNREAD_EXTENSIONS, unread: true },
	),
	reg(
		"extension data that is not CBOR",
		registration(ES256, (p) => {
			p.flags |= ED;
			p.after = Buffer.from([0xff]);
		}),
		{ ours: "accepted", library: "refused" },
		{ because: UNREAD_EXTENSIONS, unread: true },
	),
	reg(
		"the credential id sent beside is not the one inside",
		registration(ES256, (p) => {
			p.id = b64(Buffer.alloc(32, 8));
		}),
		{ ours: "credential-id", library: "accepted" },
		{ because: "ours holds the two ids to each other; the library stores the id inside and ignores the one beside" },
	),
	reg(
		"a credential id of length zero",
		registration(ES256, (p) => {
			p.idInside = Buffer.alloc(0);
		}),
		{ ours: "authenticator-data", library: "accepted" },
		{ because: "a credential id is at least one byte; the library takes an empty one and returns it as the id" },
	),
	get(
		"authenticator data shorter than its fixed part",
		assertion(ES256, (p) => {
			p.afterSigning = (signed) => signed.subarray(0, 36);
		}),
		refusedBy("authenticator-data"),
	),
	get(
		"credential data in a sign-in",
		assertion(ES256, (p) => {
			p.flags |= AT;
		}),
		refusedBy("authenticator-data"),
	),
	get(
		"the extension flag with no extension data",
		assertion(ES256, (p) => {
			p.flags |= ED;
		}),
		refusedBy("authenticator-data"),
	),
	get(
		"bytes after the fixed part with no extension flag",
		assertion(ES256, (p) => {
			p.after = Buffer.from([0xa0]);
		}),
		refusedBy("authenticator-data"),
	),
	get(
		"extension data that is not CBOR, signed",
		assertion(ES256, (p) => {
			p.flags |= ED;
			p.after = Buffer.from([0xff]);
		}),
		{ ours: "accepted", library: "refused" },
		{ because: UNREAD_EXTENSIONS, unread: true },
	),
	get(
		"bytes after the extension data, signed",
		assertion(ES256, (p) => {
			p.flags |= ED;
			p.after = Buffer.concat([cbor(new Map([["credProtect", 2]])), Buffer.from([0])]);
		}),
		{ ours: "accepted", library: "refused" },
		{ because: UNREAD_EXTENSIONS, unread: true },
	),

	// The attestation object, which only the library is sent.
	reg(
		"an attestation object with an extra member",
		registration(ES256, (p) => {
			p.attestation = (authData) => noneAttestation(authData).set("extra", "member");
		}),
		BOTH_ACCEPT,
	),
	reg(
		"a none attestation with a statement",
		registration(ES256, (p) => {
			p.attestation = (authData) => noneAttestation(authData).set("attStmt", new Map([["sig", new Uint8Array(8)]]));
		}),
		{ ours: "accepted", library: "refused" },
		{ because: UNREAD_ATTESTATION, unread: true },
	),
	reg(
		"a packed attestation with an empty statement",
		registration(ES256, (p) => {
			p.attestation = (authData) => noneAttestation(authData).set("fmt", "packed");
		}),
		{ ours: "accepted", library: "refused" },
		{ because: UNREAD_ATTESTATION, unread: true },
	),

	// Client data.
	reg(
		"client data that is not JSON",
		registration(ES256, (p) => {
			p.clientData = Buffer.from("{not json");
		}),
		refusedBy("client-data"),
	),
	reg(
		"crossOrigin at registration",
		registration(ES256, (p) => {
			p.clientData = clientData("webauthn.create", { crossOrigin: true });
		}),
		{ ours: "cross-origin", library: "accepted" },
		{ because: "ours refuses a page in another site's frame at both ceremonies; the library reads it only at sign-in" },
	),
	reg(
		"a top origin at registration",
		registration(ES256, (p) => {
			p.clientData = clientData("webauthn.create", { topOrigin: "https://evil.example" });
		}),
		{ ours: "cross-origin", library: "accepted" },
		{ because: "ours refuses a page in another site's frame at both ceremonies; the library reads it only at sign-in" },
	),
	get(
		"crossOrigin without a top origin",
		assertion(ES256, (p) => {
			p.clientData = clientData("webauthn.get", { crossOrigin: true });
		}),
		{ ours: "cross-origin", library: "accepted" },
		{ because: "this product is never framed, so ours refuses any frame; the library lets Safari's omit topOrigin" },
	),
	get(
		"client data that is not UTF-8",
		assertion(ES256, (p) => {
			const json = Buffer.from(JSON.stringify(clientData("webauthn.get", { note: "x" })));
			const at = json.indexOf("x");
			json[at] = 0xff;
			p.clientData = json;
		}),
		{ ours: "client-data", library: "accepted" },
		{ because: "ours decodes UTF-8 strictly; the library replaces a bad byte and reads on" },
	),
	get(
		"client data with a byte-order mark",
		assertion(ES256, (p) => {
			p.clientData = Buffer.concat([
				Buffer.from([0xef, 0xbb, 0xbf]),
				Buffer.from(JSON.stringify(clientData("webauthn.get"))),
			]);
		}),
		BOTH_ACCEPT,
	),
	get(
		"client data larger than any browser sends",
		assertion(ES256, (p) => {
			p.clientData = clientData("webauthn.get", { padding: "x".repeat(5000) });
		}),
		{ ours: "too-large", library: "accepted" },
		{ because: "ours bounds every field before decoding it" },
	),

	// More of the edges the library is known for.
	reg(
		"a token binding with a status no browser writes",
		registration(ES256, (p) => {
			p.clientData = clientData("webauthn.create", { tokenBinding: { status: "bogus" } });
		}),
		{ ours: "accepted", library: "refused" },
		{ because: UNREAD_TOKEN_BINDING, unread: true },
	),
	get(
		"a token binding with a status no browser writes",
		assertion(ES256, (p) => {
			p.clientData = clientData("webauthn.get", { tokenBinding: "bogus" });
		}),
		{ ours: "accepted", library: "refused" },
		{ because: UNREAD_TOKEN_BINDING, unread: true },
	),
	get(
		"a token binding that is present",
		assertion(ES256, (p) => {
			p.clientData = clientData("webauthn.get", { tokenBinding: { status: "present", id: "AAAA" } });
		}),
		BOTH_ACCEPT,
	),
	get(
		"well-formed credential data in a sign-in",
		assertion(ES256, (p) => {
			const length = Buffer.alloc(2);
			length.writeUInt16BE(ID.length);
			p.flags |= AT;
			p.after = Buffer.concat([Buffer.alloc(16), length, ID, ES256.cose]);
		}),
		{ ours: "authenticator-data", library: "accepted" },
		{ because: "a sign-in carries no credential data, so ours refuses data that says it does" },
	),
	get(
		"an ES256 signature with a long-form length",
		assertion(ES256, (p) => {
			p.signature = (signer, message) => {
				const short = signer.sign(message);
				return Buffer.concat([Buffer.from([0x30, 0x81, short[1] ?? 0]), short.subarray(2)]);
			};
		}),
		{ ours: "signature", library: "accepted" },
		{
			because:
				"a DER signature has one spelling, and `node:crypto` refuses a long-form length; the library's parser takes it",
		},
	),
	get("an RS256 signature one byte short", rsaSignatureOneByteShort(), refusedBy("signature")),
	get(
		"an RS256 signature with a zero byte before it",
		assertion(RS256, (p) => {
			p.signature = (signer, message) => Buffer.concat([Buffer.from([0]), signer.sign(message)]);
		}),
		refusedBy("signature"),
	),
	get(
		"an empty user handle",
		assertion(ES256, (p) => {
			p.userHandle = "";
		}),
		{ ours: "input", library: "accepted" },
		{ because: "a user handle is null or 1 to 64 bytes; ours refuses the empty string the library reads as none" },
	),
	get(
		"a user handle longer than 64 bytes",
		assertion(ES256, (p) => {
			p.userHandle = b64(Buffer.alloc(65, 1));
		}),
		{ ours: "too-large", library: "accepted" },
		{ because: "a user handle is at most 64 bytes, and ours hands it back to the caller" },
	),
	get(
		"an Ed25519 key of small order, and a signature that holds for any message",
		assertion(EDDSA, (p) => {
			const identity = Buffer.concat([Buffer.from([1]), Buffer.alloc(31)]);
			p.stored = {
				algorithm: -8,
				spki: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), identity]),
				cose: cbor(
					new Map<number, number | Uint8Array>([
						[1, 1],
						[3, -8],
						[-1, 6],
						[-2, new Uint8Array(identity)],
					]),
				),
				sign: () => Buffer.alloc(0),
			};
			p.signature = () => Buffer.concat([identity, Buffer.alloc(32)]);
		}),
		// Both accept: neither the library nor `node:crypto` refuses a key of small order. Only the person who
		// registers a key can choose it, and a made-up key exposes nobody but them (the top of `webauthn.ts`).
		BOTH_ACCEPT,
	),

	// Ids and encodings.
	get(
		"a credential id other than the stored one",
		assertion(ES256, (p) => {
			p.id = b64(Buffer.alloc(32, 8));
		}),
		{ ours: "credential-id", library: "accepted" },
		{ because: "ours holds the answer's id to the stored row's; the library leaves that to the caller" },
	),
	get(
		"a user handle that is not base64url",
		assertion(ES256, (p) => {
			p.userHandle = "not base64url!";
		}),
		{ ours: "encoding", library: "accepted" },
		{ because: "ours hands the handle back to the caller, so it checks its form; the library passes it through" },
	),
	get(
		"padded base64",
		assertion(ES256, (p) => {
			p.userHandle = `${b64(Buffer.alloc(16, 1))}==`;
		}),
		{ ours: "encoding", library: "accepted" },
		{
			because: "ours takes one spelling of each value, which a browser's toJSON writes; the library also takes padding",
		},
	),
];

// ---------------------------------------------------------------------------------------------------------------
// The library's own published vectors (`packages/server/src/*/verify*Response.test.ts` at v14.0.3, MIT), real
// answers from real authenticators. Ours is sent what a browser would hand the page for the same answer: the key
// as SPKI, made from the COSE copy in the authenticator data, and each value in the one base64url spelling a
// browser's toJSON writes for its bytes (`canonical`). One vector is also sent as recorded.

function spkiOfCose(cose: Uint8Array): Buffer {
	const map = coseMap(cose);
	const part = (label: number): string => b64(map.get(label) as Uint8Array);
	const kty = map.get(1);
	const jwk =
		kty === 2
			? { kty: "EC", crv: "P-256", x: part(-2), y: part(-3) }
			: kty === 1
				? { kty: "OKP", crv: "Ed25519", x: part(-2) }
				: { kty: "RSA", n: part(-1), e: part(-2) };
	return createPublicKey({ key: jwk, format: "jwk" }).export({ format: "der", type: "spki" });
}
const algorithmOfCose = (cose: Uint8Array): number => coseMap(cose).get(3) as number;

type RegistrationVector = {
	readonly name: string;
	readonly response: RegistrationResponseJSON;
	readonly challenge: string;
	readonly origin: string;
	readonly rpId: string;
};
async function bothRegisterVector(vector: RegistrationVector): Promise<Outcome> {
	const attestation = decodeAttestationObject(isoBase64URL.toBuffer(vector.response.response.attestationObject));
	const authData = attestation.get("authData");
	const parsed = parseAuthenticatorData(authData);
	const cose = parsed.credentialPublicKey ?? new Uint8Array();
	const algorithm = algorithmOfCose(cose);
	const ours = verifyRegistration(
		{
			id: vector.response.id,
			clientDataJSON: canonical(vector.response.response.clientDataJSON),
			authenticatorData: b64(authData),
			// A browser hands out no SPKI for an algorithm it does not know; the COSE bytes stand in for it.
			publicKey: ALGORITHMS.some((known) => known === algorithm) ? b64(spkiOfCose(cose)) : b64(cose),
			publicKeyAlgorithm: algorithm,
			transports: [],
		},
		{ challenge: vector.challenge as Challenge, origin: vector.origin, rpId: vector.rpId },
	);
	const library = await libraryVerdict(() =>
		verifyRegistrationResponse({
			response: vector.response,
			expectedChallenge: vector.challenge,
			expectedOrigin: vector.origin,
			expectedRPID: vector.rpId,
			requireUserPresence: true,
			requireUserVerification: true,
			supportedAlgorithmIDs: [...ALGORITHMS],
		}),
	);
	return { ours: oursVerdict(ours), library };
}

type AssertionVector = {
	readonly name: string;
	readonly response: AuthenticationResponseJSON;
	readonly challenge: string;
	readonly origin: string;
	readonly rpId: string;
	readonly cose: string;
	readonly counter: number;
};
/** As a browser's toJSON writes the same bytes: no padding and no loose bits, so a signature still holds. */
const canonical = (text: string): string => b64(Buffer.from(text, "base64url"));
async function bothSignInVector(vector: AssertionVector, spell: (text: string) => string): Promise<Outcome> {
	const cose = isoBase64URL.toBuffer(vector.cose);
	const sent = vector.response.response;
	const ours = verifyAssertion(
		{
			id: vector.response.id,
			clientDataJSON: spell(sent.clientDataJSON),
			authenticatorData: spell(sent.authenticatorData),
			signature: spell(sent.signature),
			userHandle: sent.userHandle === undefined ? null : spell(sent.userHandle),
		},
		{
			credentialId: vector.response.id,
			publicKey: b64(spkiOfCose(cose)),
			algorithm: algorithmOfCose(cose) as StoredPasskey["algorithm"],
			signCount: vector.counter,
		},
		{ challenge: vector.challenge as Challenge, origin: vector.origin, rpId: vector.rpId },
	);
	const library = await libraryVerdict(() =>
		verifyAuthenticationResponse({
			response: vector.response,
			expectedChallenge: vector.challenge,
			expectedOrigin: vector.origin,
			expectedRPID: vector.rpId,
			requireUserVerification: true,
			credential: { id: vector.response.id, publicKey: cose, counter: vector.counter },
		}),
	);
	return { ours: oursVerdict(ours), library };
}

const DONTNEEDA = { origin: "https://dev.dontneeda.pw", rpId: "dev.dontneeda.pw" };
const LOCALHOST = { origin: "http://localhost:8000", rpId: "localhost" };
const ANDROID = {
	origin: "android:apk-key-hash:gx7sq_pxhxhrIQdLyfG0pxKwiJ7hOk2DJQ4xvKd438Q",
	rpId: "try-webauthn.appspot.com",
};
const credential = (id: string, response: RegistrationResponseJSON["response"]): RegistrationResponseJSON => ({
	id,
	rawId: id,
	type: "public-key",
	response,
	clientExtensionResults: {},
});

const REGISTRATION_VECTORS: (RegistrationVector & { expect: Outcome; because?: string })[] = [
	{
		name: "none attestation, ES256, Firefox on Android",
		...DONTNEEDA,
		challenge: isoBase64URL.fromUTF8String("hEccPWuziP00H0p5gxh2_u5_PC4NeYgd"),
		response: credential("AdKXJEch1aV5Wo7bj7qLHskVY4OoNaj9qu8TPdJ7kSAgUeRxWNngXlcNIGt4gexZGKVGcqZpqqWordXb_he1izY", {
			attestationObject:
				"o2NmbXRkbm9uZWdhdHRTdG10oGhhdXRoRGF0YVjFPdxHEOnAiLIp26idVjIguzn3Ipr_RlsKZWsa-5qK-KBFAAAAAAAAAAAAAAAAAAAAAAAAAAAAQQHSlyRHIdWleVqO24-6ix7JFWODqDWo_arvEz3Se5EgIFHkcVjZ4F5XDSBreIHsWRilRnKmaaqlqK3V2_4XtYs2pQECAyYgASFYID5PQTZQQg6haZFQWFzqfAOyQ_ENsMH8xxQ4GRiNPsqrIlggU8IVUOV8qpgk_Jh-OTaLuZL52KdX1fTht07X4DiQPow",
			clientDataJSON:
				"eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIiwiY2hhbGxlbmdlIjoiYUVWalkxQlhkWHBwVURBd1NEQndOV2Q0YURKZmRUVmZVRU0wVG1WWloyUSIsIm9yaWdpbiI6Imh0dHBzOlwvXC9kZXYuZG9udG5lZWRhLnB3IiwiYW5kcm9pZFBhY2thZ2VOYW1lIjoib3JnLm1vemlsbGEuZmlyZWZveCJ9",
			transports: [],
		}),
		expect: BOTH_ACCEPT,
	},
	{
		name: "none attestation, RS256",
		...DONTNEEDA,
		challenge: "pYZ3VX2yb8dS9yplNxJChiXhPGBk8gZzTAyJ2iU5x1k",
		response: credential("kGXv4RJWLeXRw8Yf3T22K3Gq_GGeDv9OKYmAHLm0Ylo", {
			attestationObject:
				"o2NmbXRkbm9uZWdhdHRTdG10oGhhdXRoRGF0YVkBZz3cRxDpwIiyKduonVYyILs59yKa_0ZbCmVrGvuaivigRQAAAABgKLAXsdRMArSzr82vyWuyACCQZe_hElYt5dHDxh_dPbYrcar8YZ4O_04piYAcubRiWqQBAwM5AQAgWQEA8X6V649G2vwB99CSf_luwR0jj7oDg_GhA3TQSnNYIwfQJldxT5dmi9H8IjjCrTP28iNuKl29hc3Mowux1FZB0bc5AEJ2oV3JCOMGP9NZKGmOosF7iBN2GtGY7Nomcs-ruBv2mxp1nTm6mv5B8XNwh0e18uTA5AJCsl-k6lNLYB2XBIQ3fy2-TjSQ8IOMLypWQbWWBJXzLmepaJ6EWe6kf_NaxpA2chWsaekZcr8xG6OIo3iGh0Mpags_qBZtN4n2TDn0R2LheLk4yQ0R_oOAVtX963Yuw0x5NYSZyMNSMi_1RSEPTYn5AILmIzQskglDaWJYtnjKz4QLuXWCRRYyDSFDAQAB",
			clientDataJSON:
				"eyJjaGFsbGVuZ2UiOiJwWVozVlgyeWI4ZFM5eXBsTnhKQ2hpWGhQR0JrOGdaelRBeUoyaVU1eDFrIiwiY2xpZW50RXh0ZW5zaW9ucyI6e30sImhhc2hBbGdvcml0aG0iOiJTSEEtMjU2Iiwib3JpZ2luIjoiaHR0cHM6Ly9kZXYuZG9udG5lZWRhLnB3IiwidHlwZSI6IndlYmF1dGhuLmNyZWF0ZSJ9",
			transports: [],
		}),
		expect: BOTH_ACCEPT,
	},
	{
		name: "none attestation with extension output, ES256, an Android app",
		...ANDROID,
		challenge: "Arkrl_Fx_MvcJ_eIqCTQ7-tbESISR14-pyPRh0K-1A8",
		response: credential("E_Pko4wN1BXE23S0ftN3eQ", {
			attestationObject:
				"o2NmbXRkbm9uZWdhdHRTdG10oGhhdXRoRGF0YVkBag11_MVj_ad52y40PupImIh1i3hUnUk6T9vqHNlqoxzExQAAAAAAAAAAAAAAAAAAAAAAAAAAABAT8-SjjA3UFcTbdLR-03d5pQECAyYgASFYIJIkX8fs9wjKUv5HWBUop--6ig4Szsxj8gBgJJmaX-_5IlggJ5XVdjUfCMlVlUZuHJRxCLFLzZCeK8Fg3l6OLfAIHnKhbGRldmljZVB1YktleaVjZHBrWE2lAQIDJiABIVggmRqr7Z3kJxqe3q2IBvncltbczQxHYlOlUQSJ7IN5vlsiWCCglzz97bt54n_vTudIFnP7MxJQTdylQ0z9I0MdatKe2mNzaWdYRzBFAiEA77OAdL0VuMgs8J-H-8b7PHFp6k8YBrfpCTc3QwI0W3oCICtxEwQHMaDnJ9M41IVChjzmWICqeeXqdArIzNlDR5iOZW5vbmNlQGVzY29wZUEAZmFhZ3VpZFAAAAAAAAAAAAAAAAAAAAAA",
			clientDataJSON:
				"eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIiwiY2hhbGxlbmdlIjoiQXJrcmxfRnhfTXZjSl9lSXFDVFE3LXRiRVNJU1IxNC1weVBSaDBLLTFBOCIsIm9yaWdpbiI6ImFuZHJvaWQ6YXBrLWtleS1oYXNoOmd4N3NxX3B4aHhocklRZEx5ZkcwcHhLd2lKN2hPazJESlE0eHZLZDQzOFEiLCJhbmRyb2lkUGFja2FnZU5hbWUiOiJjb20uZmlkby5leGFtcGxlLmZpZG8yYXBpZXhhbXBsZSJ9",
			transports: [],
		}),
		expect: BOTH_ACCEPT,
	},
	{
		name: "packed self-attestation, ES256, on localhost",
		...LOCALHOST,
		challenge:
			"eyJhY3R1YWxDaGFsbGVuZ2UiOiJ4UnNZZENRdjVXWk9xbXhSZWlabDZDOXE1U2ZyWm5lNGxOU3I5UVZ0UGlnIiwiYXJiaXRyYXJ5RGF0YSI6ImFyYml0cmFyeURhdGFGb3JTaWduaW5nIn0",
		response: credential(
			"AUywDsPYEOoucI3-o-jB1J6Kt6QAxLMa1WwFKj1bNi4pAakWAsZX-pJ4gAeDmocL7SXnl8vzUfLkfrOGIVmds1RhjU1DYIWlxcGhAA",
			{
				attestationObject:
					"o2NmbXRmcGFja2VkZ2F0dFN0bXSiY2FsZyZjc2lnWEcwRQIhAPgoy3sxIeUvN9Mo8twyIQb9hXDHxQ2urIaEq14u6vNHAiB8ltlCippsMIIsh6AqMoZlUH_BH0bXT1xsN2zKoCEy72hhdXRoRGF0YVjQSZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2NFYfWYqK3OAAI1vMYKZIsLJfHwVQMATAFMsA7D2BDqLnCN_qPowdSeirekAMSzGtVsBSo9WzYuKQGpFgLGV_qSeIAHg5qHC-0l55fL81Hy5H6zhiFZnbNUYY1NQ2CFpcXBoQClAQIDJiABIVggPzMMB0nPKu9zvu6tvvyaP7MlGKJi4zazYQw5kyCjGykiWCCyHxcnMCwcj4llYwRY-MedgOCQzcz_TgKeabY4yFQyrA",
				clientDataJSON:
					"eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIiwiY2hhbGxlbmdlIjoiZXlKaFkzUjFZV3hEYUdGc2JHVnVaMlVpT2lKNFVuTlpaRU5SZGpWWFdrOXhiWGhTWldsYWJEWkRPWEUxVTJaeVdtNWxOR3hPVTNJNVVWWjBVR2xuSWl3aVlYSmlhWFJ5WVhKNVJHRjBZU0k2SW1GeVltbDBjbUZ5ZVVSaGRHRkdiM0pUYVdkdWFXNW5JbjAiLCJvcmlnaW4iOiJodHRwOi8vbG9jYWxob3N0OjgwMDAiLCJjcm9zc09yaWdpbiI6ZmFsc2V9",
				transports: ["internal"],
			},
		),
		expect: BOTH_ACCEPT,
	},
];

const LOCALHOST_ASSERTION: AssertionVector = {
	name: "ES256, present and verified, on localhost",
	...LOCALHOST,
	challenge:
		"eyJhY3R1YWxDaGFsbGVuZ2UiOiJLM1F4T2puVkpMaUdsblZFcDV2YTVRSmVNVldOZl83UFlndXRnYkF0QVVBIiwiYXJiaXRyYXJ5RGF0YSI6InNpZ25NZVBsZWFzZSJ9",
	cose: "pQECAyYgASFYILTrxTUQv3X4DRM6L_pk65FSMebenhCx3RMsTKoBm-AxIlggEf3qk5552QLNSh1T1oQs7_2C2qysDwN4r4fCp52Hsqs",
	counter: 0,
	response: {
		id: "AaIBxnYfL2pDWJmIii6CYgHBruhVvFGHheWamphVioG_TnEXxKA9MW4FWnJh21zsbmRpRJso9i2JmAtWOtXfVd4oXTgYVusXwhWWsA",
		rawId: "AaIBxnYfL2pDWJmIii6CYgHBruhVvFGHheWamphVioG_TnEXxKA9MW4FWnJh21zsbmRpRJso9i2JmAtWOtXfVd4oXTgYVusXwhWWsA",
		type: "public-key",
		clientExtensionResults: {},
		response: {
			authenticatorData: "SZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2MFYftypQ",
			clientDataJSON:
				"eyJ0eXBlIjoid2ViYXV0aG4uZ2V0IiwiY2hhbGxlbmdlIjoiZXlKaFkzUjFZV3hEYUdGc2JHVnVaMlVpT2lKTE0xRjRUMnB1VmtwTWFVZHNibFpGY0RWMllUVlJTbVZOVmxkT1psODNVRmxuZFhSbllrRjBRVlZCSWl3aVlYSmlhWFJ5WVhKNVJHRjBZU0k2SW5OcFoyNU5aVkJzWldGelpTSjkiLCJvcmlnaW4iOiJodHRwOi8vbG9jYWxob3N0OjgwMDAiLCJjcm9zc09yaWdpbiI6ZmFsc2V9",
			signature: "MEUCIByFAVGfkoKPEzynp-37BX_HOXSaC6-58-ELjB7BG9opAiEAyD_1mN9YAPrphcwpzK3ym2Xx8EjAapgQ326mKgQ1pW0",
			userHandle: "internalUserId",
		},
	},
};

const ANDROID_ASSERTION: AssertionVector = {
	// The library's test of this answer checks its extension output and not its signature, which this stored key
	// did not make.
	name: "ES256 with extension output, an Android app, against a key that did not sign it",
	...ANDROID,
	challenge: "iZsVCztrDW7D2U_GHCIlYKLwV2bCsBTRqVQUnJXn9Tk",
	cose: "pQECAyYgASFYILTrxTUQv3X4DRM6L_pk65FSMebenhCx3RMsTKoBm-AxIlggEf3qk5552QLNSh1T1oQs7_2C2qysDwN4r4fCp52Hsqs",
	counter: 0,
	response: {
		id: "E_Pko4wN1BXE23S0ftN3eQ",
		rawId: "E_Pko4wN1BXE23S0ftN3eQ",
		type: "public-key",
		clientExtensionResults: {},
		response: {
			clientDataJSON:
				"eyJ0eXBlIjoid2ViYXV0aG4uZ2V0IiwiY2hhbGxlbmdlIjoiaVpzVkN6dHJEVzdEMlVfR0hDSWxZS0x3VjJiQ3NCVFJxVlFVbkpYbjlUayIsIm9yaWdpbiI6ImFuZHJvaWQ6YXBrLWtleS1oYXNoOmd4N3NxX3B4aHhocklRZEx5ZkcwcHhLd2lKN2hPazJESlE0eHZLZDQzOFEiLCJhbmRyb2lkUGFja2FnZU5hbWUiOiJjb20uZmlkby5leGFtcGxlLmZpZG8yYXBpZXhhbXBsZSJ9",
			authenticatorData:
				"DXX8xWP9p3nbLjQ-6kiYiHWLeFSdSTpP2-oc2WqjHMSFAAAAAKFsZGV2aWNlUHViS2V5pWNkcGtYTaUBAgMmIAEhWCCZGqvtneQnGp7erYgG-dyW1tzNDEdiU6VRBInsg3m-WyJYIKCXPP3tu3nif-9O50gWc_szElBN3KVDTP0jQx1q0p7aY3NpZ1hHMEUCIElSbNKK72tOYhp9WTbStQSVL8CuIxOk8DV6r_-uqWR0AiEAnVE6yu-wsyx2Wq5v66jClGhe_2P_HL8R7PIQevT-uPhlbm9uY2VAZXNjb3BlQQBmYWFndWlkULk_2WHy5kYvsSKCACJH3ng",
			signature: "MEYCIQDlRuxY7cYre0sb3T6TovQdfYIUb72cRZYOQv_zS9wN_wIhAOvN-fwjtyIhWRceqJV4SX74-z6oALERbC7ohk8EdVPO",
			userHandle: "b2FPajFxcmM4MWo3QkFFel9RN2lEakh5RVNlU2RLNDF0Sl92eHpQYWV5UQ==",
		},
	},
};
const DONTNEEDA_ASSERTION: AssertionVector = {
	name: "ES256, present but not verified",
	...DONTNEEDA,
	challenge: isoBase64URL.fromUTF8String("totallyUniqueValueEveryTime"),
	cose: "pQECAyYgASFYIIheFp-u6GvFT2LNGovf3ZrT0iFVBsA_76rRysxRG9A1Ilgg8WGeA6hPmnab0HAViUYVRkwTNcN77QBf_RR0dv3lIvQ",
	counter: 143,
	response: {
		id: "KEbWNCc7NgaYnUyrNeFGX9_3Y-8oJ3KwzjnaiD1d1LVTxR7v3CaKfCz2Vy_g_MHSh7yJ8yL0Pxg6jo_o0hYiew",
		rawId: "KEbWNCc7NgaYnUyrNeFGX9_3Y-8oJ3KwzjnaiD1d1LVTxR7v3CaKfCz2Vy_g_MHSh7yJ8yL0Pxg6jo_o0hYiew",
		type: "public-key",
		clientExtensionResults: {},
		response: {
			authenticatorData: "PdxHEOnAiLIp26idVjIguzn3Ipr_RlsKZWsa-5qK-KABAAAAkA==",
			clientDataJSON:
				"eyJjaGFsbGVuZ2UiOiJkRzkwWVd4c2VWVnVhWEYxWlZaaGJIVmxSWFpsY25sVWFXMWwiLCJjbGllbnRFeHRlbnNpb25zIjp7fSwiaGFzaEFsZ29yaXRobSI6IlNIQS0yNTYiLCJvcmlnaW4iOiJodHRwczovL2Rldi5kb250bmVlZGEucHciLCJ0eXBlIjoid2ViYXV0aG4uZ2V0In0=",
			signature: "MEUCIQDYXBOpCWSWq2Ll4558GJKD2RoWg958lvJSB_GdeokxogIgWuEVQ7ee6AswQY0OsuQ6y8Ks6jhd45bDx92wjXKs900=",
		},
	},
};

const VECTOR_CASES: Case[] = [
	...REGISTRATION_VECTORS.map((vector) => ({
		name: `vector, registration: ${vector.name}`,
		run: () => bothRegisterVector(vector),
		expect: vector.expect,
	})),
	{
		name: `vector, sign-in: ${LOCALHOST_ASSERTION.name}`,
		run: () => bothSignInVector(LOCALHOST_ASSERTION, canonical),
		expect: BOTH_ACCEPT,
	},
	{
		name: `vector, sign-in: ${LOCALHOST_ASSERTION.name}, its user handle spelled as recorded`,
		run: () => bothSignInVector(LOCALHOST_ASSERTION, (text) => text),
		expect: { ours: "encoding", library: "accepted" },
		because: "`internalUserId` has loose bits in its last character, so it is not the one spelling of its bytes",
	},
	{
		name: `vector, sign-in: ${ANDROID_ASSERTION.name}`,
		run: () => bothSignInVector(ANDROID_ASSERTION, canonical),
		expect: refusedBy("signature"),
	},
	{
		name: `vector, sign-in: ${DONTNEEDA_ASSERTION.name}`,
		run: () => bothSignInVector(DONTNEEDA_ASSERTION, canonical),
		expect: refusedBy("user-not-verified"),
	},
];

describe("ours and @simplewebauthn/server, fed the same answers", () => {
	for (const each of [...CASES, ...VECTOR_CASES]) {
		test(each.name, async () => {
			const outcome = await each.run();
			const agree = (outcome.ours === "accepted") === (outcome.library === "accepted");
			expect({ ...outcome, agree }).toEqual({ ...each.expect, agree });
			if (agree) {
				expect(each.because).toBeUndefined();
				return;
			}
			// They part: the case says why, and ours accepting what the library refuses is allowed only for bytes
			// ours never reads.
			expect(each.because).toBeString();
			expect(each.unread === true).toBe(outcome.ours === "accepted");
		});
	}
});

test("nothing under src/ imports the library, so it never ships", () => {
	const files = readdirSync("src", { recursive: true, encoding: "utf8" }).filter((file) => /\.tsx?$/.test(file));
	const importers = files.filter((file) => readFileSync(join("src", file), "utf8").includes("@simplewebauthn"));
	expect(importers).toEqual([]);
});
