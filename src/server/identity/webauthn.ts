// Passkeys (WebAuthn): what the server checks when a browser registers a key and when it signs in with one.
// Pure: no database, no clock and no state. The caller keeps the challenge it issued and the passkey it stored.
//
// The page sends what the browser hands out, each value base64url. At registration: the credential id,
// `clientDataJSON`, the authenticator data (`getAuthenticatorData()`), the public key as SPKI DER
// (`getPublicKey()`), its COSE algorithm (`getPublicKeyAlgorithm()`) and the transports. At sign-in: the
// credential id, `clientDataJSON`, the authenticator data and the signature. So there is no CBOR here.
//
// At sign-in the signature is the proof. It covers the authenticator data and the SHA-256 of `clientDataJSON`,
// so what is read from them is what the authenticator and the browser wrote: the relying party, that a person
// was there and was verified, the counter, the kind of ceremony, the challenge and the origin of the page that
// asked. A page on another origin cannot get a signature this accepts, which is what makes a passkey hold up
// against a look-alike sign-in page.
//
// At registration nothing is signed. Attestation is "none", so no manufacturer vouches for the authenticator,
// and the authenticator data and the key beside it are the browser's word. This file does not pretend
// otherwise. It does not read the copy of the key inside the authenticator data (that copy is CBOR, and with
// no attestation it is exactly as trustworthy as the one sent beside it), and it does not learn the make of the
// authenticator. What registration checks keeps three things out: an answer made for another site or another
// ceremony, one made with nobody present, and a key that sign-in could not verify later. That is sound here
// because a person registers a key only for themselves, signed in or holding their invitation, so a key that
// was made up locks out or exposes nobody but the person who made it up.
//
// Also not checked, each for a reason:
// - Token binding: no browser implements it.
// - Extensions: none is asked for. Extension data that follows the fixed part is covered by the signature at
//   sign-in and otherwise ignored. It is not checked to be well-formed CBOR, so nothing may start using an
//   extension value without adding the processing that extension needs.
// - A page inside another site's frame is not judged, it is refused: `crossOrigin: true`, or a `topOrigin` of
//   any value, with or without `crossOrigin`. This product is never shown in a cross-origin frame, so there is
//   no top origin to compare one with.
// - What the user handle of a sign-in means. It is checked for its form and handed back, and the caller, which
//   knows the accounts, compares it. The key does not sign it.
// - That backup eligibility stays what it was for a credential: the level 3 procedure for a sign-in compares
//   it only where backup state is used in policy, and no rule of this product depends on it. So a change is
//   reported and not refused, and an authenticator that reports the flag differently one day does not lock
//   its owner out. The one impossible pair, backed up but not eligible, is refused.
// - Low-S in an ECDSA signature: a signature and its twin (r, n - s) both verify. Nothing here uses a signature
//   as an identity, and the challenge is spent by the first one.
//
// Algorithms, in the order they are offered: ES256 (-7, ECDSA on P-256 with SHA-256), EdDSA (-8, Ed25519) and
// RS256 (-257, RSA PKCS #1 v1.5 with SHA-256, a modulus of 2048 bits or more). ES256 is first because every
// authenticator has it and every platform key uses it. `node:crypto` in Bun 1.4.3 verifies all three from an
// SPKI key, in about 38 µs, 42 µs and 11 µs on the 16-thread desktop (2026-10-13, 2,000 verifications each).
//
// Both functions are synchronous and use `node:crypto`, not WebCrypto. Registration runs inside an operation,
// which is synchronous. Sign-in could await, but a verification that takes 40 µs is not worth a hop to another
// thread, and one implementation is one thing to review. It also settles the signature format: an
// authenticator sends an ES256 signature as an ASN.1 DER sequence of r and s, WebCrypto wants the two numbers
// bare, and converting would mean an ASN.1 reader in this file. `node:crypto` takes DER as it is, and its
// parser is strict: a trailing byte, a long-form length or bare r and s are all refused (tested).
import { constants, createPublicKey, type KeyObject, timingSafeEqual, verify } from "node:crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { z } from "zod";

/** COSE algorithm numbers, in the order the browser is asked to prefer them. */
export const ALGORITHMS = [-7, -8, -257] as const;
export type Algorithm = (typeof ALGORITHMS)[number];
const isAlgorithm = (value: number): value is Algorithm => ALGORITHMS.some((algorithm) => algorithm === value);

/** How long the browser waits for the person. A challenge is worth nothing after it, so it lives as long. */
export const CEREMONY_MS = 5 * 60_000;

/** A challenge this file made. The brand keeps any other string from being expected as one. */
export type Challenge = string & { readonly __brand: "Challenge" };
/** 32 random bytes, base64url. The caller keeps it until the answer arrives and accepts it once. */
export function newChallenge(): Challenge {
	return Buffer.from(randomBytes(32)).toString("base64url") as Challenge;
}
/** The specification's minimum is 16 bytes, which is 22 characters. Nothing shorter is ever matched. */
const CHALLENGE_MIN = 22;

/**
 * What an answer must have been made for, built from what the server kept when it issued the challenge and
 * never from the answer. There is no switch for user verification: both sets of options below ask for it, a
 * passkey is a way in by itself, and so an answer from a person who was not verified is always refused.
 */
export type Expected = {
	readonly challenge: Challenge;
	/** The origin of the page, as a browser writes it: scheme, host, and the port unless it is the default. */
	readonly origin: string;
	readonly rpId: string;
};

/** What is stored for a passkey. Every string is base64url, in the one form `Buffer` writes. */
export type Passkey = {
	readonly credentialId: string;
	/** SPKI DER, as `node:crypto` writes the key that was sent, so two spellings of one key are stored alike. */
	readonly publicKey: string;
	readonly algorithm: Algorithm;
	readonly signCount: number;
	/** The key may be copied to the person's other devices, */
	readonly backupEligible: boolean;
	/** and it has been. */
	readonly backedUp: boolean;
	/** How the browser reached the authenticator, handed back to it at sign-in as a hint. */
	readonly transports: readonly string[];
};
export type StoredPasskey = Pick<Passkey, "credentialId" | "publicKey" | "algorithm" | "signCount">;
/** What a sign-in showed. The caller stores the counter and the two backup flags. */
export type Assertion = Pick<Passkey, "signCount" | "backupEligible" | "backedUp"> & {
	/**
	 * The user handle the authenticator gave back, base64url, or null when it gave none. It is the handle the
	 * key was registered under only if the caller finds it to be: the key does not sign it.
	 */
	readonly userHandle: string | null;
};

/** Why an answer was refused. A closed set, so a caller logs the reason and builds no sentence from input. */
export type Refusal =
	/** Not the object the page sends: a field is missing, empty or of another type, or a transport is not a short word. */
	| "input"
	/** A field is longer than anything a browser sends. */
	| "too-large"
	/** A field is not base64url in its one spelling, which has no padding and no loose bits at its end. */
	| "encoding"
	/** `clientDataJSON` is not UTF-8, not JSON, or not an object with a type, a challenge and an origin. */
	| "client-data"
	/** The answer belongs to the other ceremony: a registration offered as a sign-in, or the reverse. */
	| "type"
	| "challenge"
	| "origin"
	/** The page says it was inside another site's frame: `crossOrigin` is true, or there is a `topOrigin`. */
	| "cross-origin"
	/** The authenticator data is cut short, or its parts do not fit its length and flags. */
	| "authenticator-data"
	| "rp-id"
	| "user-not-present"
	| "user-not-verified"
	/** Marked as backed up but not as eligible for backup, which no authenticator means. */
	| "backup-flags"
	/** A registration whose authenticator data says it carries no credential. */
	| "no-credential-data"
	/** The credential id is not the one in the authenticator data, or at sign-in not the stored one. */
	| "credential-id"
	/** An algorithm this file does not verify. */
	| "algorithm"
	/** The key is not a public key in SPKI form. */
	| "key"
	/** The key is of another algorithm or curve than the one claimed. */
	| "key-mismatch"
	/** An RSA modulus under 2048 bits. */
	| "key-too-weak"
	| "signature"
	/** The counter did not grow. Two authenticators holding one key, a copy among them, look like this. */
	| "possibly-cloned";

export type Verdict<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: Refusal };
const accepted = <T>(value: T): Verdict<T> => ({ ok: true, value });
const refused = (reason: Refusal): Verdict<never> => ({ ok: false, reason });

/**
 * The largest each field may be, in bytes. A credential id is at most 1023 bytes by the specification. The
 * others are well above what a browser sends: `clientDataJSON` is 130 to 270 bytes from Chromium and grows
 * with the origin; authenticator data with the longest id and a 4096-bit RSA key is about 1,600; the SPKI of an
 * 8192-bit RSA key is 1,062 and its signature 1,024.
 */
const MAX = {
	credentialId: 1023,
	clientData: 4096,
	authenticatorData: 4096,
	publicKey: 1100,
	signature: 1024,
	// The specification's limit on a user handle.
	userHandle: 64,
};

const Encoded = z.string().min(1);
/** What the page sends after `navigator.credentials.create`. The names are the browser's. */
export const RegistrationResponse = z.object({
	id: Encoded,
	clientDataJSON: Encoded,
	authenticatorData: Encoded,
	publicKey: Encoded,
	publicKeyAlgorithm: z.number().int(),
	transports: z.array(z.string().regex(/^[a-z0-9-]{1,32}$/)).max(8),
});
export type RegistrationResponse = z.infer<typeof RegistrationResponse>;
/**
 * What the page sends after `navigator.credentials.get`. `userHandle` is `response.userHandle`: null, or left
 * out, when the authenticator gave none.
 */
export const AssertionResponse = z.object({
	id: Encoded,
	clientDataJSON: Encoded,
	authenticatorData: Encoded,
	signature: Encoded,
	userHandle: Encoded.nullable().optional(),
});
export type AssertionResponse = z.infer<typeof AssertionResponse>;

/**
 * What a browser writes into `clientDataJSON`. It may add members, and they are ignored. `topOrigin` is read
 * with no type asked of it, because it is refused whatever it holds.
 */
const ClientData = z.object({
	type: z.string(),
	challenge: z.string(),
	origin: z.string(),
	crossOrigin: z.boolean().optional(),
	topOrigin: z.unknown().optional(),
});

/**
 * The bytes of a base64url field. `Buffer` decodes anything, skipping what it cannot read, so the test is that
 * the bytes encode back to the same text. That refuses every character outside the alphabet, padding, a length
 * no encoding has and loose bits in the last character, so one credential id has one spelling.
 */
function bytesOf(text: string, maxBytes: number): Verdict<Buffer> {
	// Four characters carry three bytes, so the text is measured before anything is decoded.
	if (text.length > Math.ceil((maxBytes * 4) / 3)) return refused("too-large");
	const bytes = Buffer.from(text, "base64url");
	return bytes.toString("base64url") === text ? accepted(bytes) : refused("encoding");
}

/** Compares in time that depends on the length alone. */
function sameText(a: string, b: string): boolean {
	const left = Buffer.from(a, "utf8");
	const right = Buffer.from(b, "utf8");
	return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * What the bytes of a `clientDataJSON` say, or null when they are not UTF-8, not JSON, or not an object with a
 * type, a challenge and an origin. The one reading of client data there is: the two checks below judge by it,
 * and the caller finds its challenge by it (`challengeOf`), so both read the same bytes the same way.
 */
function readClientData(bytes: Buffer): z.infer<typeof ClientData> | null {
	let json: unknown;
	try {
		// One leading byte-order mark is stripped, as the specification's decoding does. Only this reading
		// loses it: a sign-in's signature is checked over the bytes as they came, mark included.
		json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		return null;
	}
	const parsed = ClientData.safeParse(json);
	return parsed.success ? parsed.data : null;
}

/**
 * The challenge an answer says it answers: the `challenge` member of its `clientDataJSON`, read exactly as
 * `verifyRegistration` and `verifyAssertion` read it, or null when they would find none. It is for the caller,
 * which keeps the challenges it issued, to find its record by, and it judges nothing: the challenge it
 * returns is the answer's word, and the verifier compares it with the server's own again.
 */
export function challengeOf(answer: unknown): string | null {
	if (typeof answer !== "object" || answer === null || !("clientDataJSON" in answer)) return null;
	if (typeof answer.clientDataJSON !== "string") return null;
	const bytes = bytesOf(answer.clientDataJSON, MAX.clientData);
	return bytes.ok ? (readClientData(bytes.value)?.challenge ?? null) : null;
}

/** Why this `clientDataJSON` is not an answer to the expected ceremony, or null when it is. */
function clientDataRefusal(
	bytes: Buffer,
	type: "webauthn.create" | "webauthn.get",
	expected: Expected,
): Refusal | null {
	const data = readClientData(bytes);
	if (!data) return "client-data";
	if (data.type !== type) return "type";
	if (data.challenge.length < CHALLENGE_MIN || !sameText(data.challenge, expected.challenge)) return "challenge";
	// The whole string, never a prefix, a suffix or a parsed host: `https://mainworthy.com.example` and
	// `https://mainworthy.com:8443` are other origins.
	if (data.origin !== expected.origin) return "origin";
	// JSON has no undefined, so this is a `topOrigin` member of any value, null among them.
	if (data.crossOrigin === true || data.topOrigin !== undefined) return "cross-origin";
	return null;
}

/** The fixed part of authenticator data: the hash of the RP ID (32 bytes), the flags (1) and the counter (4). */
const FIXED = 37;
const FLAG = {
	userPresent: 0x01,
	userVerified: 0x04,
	backupEligible: 0x08,
	backedUp: 0x10,
	attested: 0x40,
	extended: 0x80,
};
type AuthenticatorData = {
	readonly backupEligible: boolean;
	readonly backedUp: boolean;
	/** Credential data follows the fixed part: the authenticator's model, the credential id and the key. */
	readonly attested: boolean;
	/** Extension data follows, after the credential data if there is any. */
	readonly extended: boolean;
	readonly signCount: number;
	readonly rest: Buffer;
};

/** Reads the fixed part and checks what both ceremonies ask of it. */
function readAuthenticatorData(bytes: Buffer, expected: Expected): Verdict<AuthenticatorData> {
	if (bytes.length < FIXED) return refused("authenticator-data");
	if (!bytes.subarray(0, 32).equals(sha256(new TextEncoder().encode(expected.rpId)))) return refused("rp-id");
	const flags = bytes.readUInt8(32);
	const has = (flag: number): boolean => (flags & flag) !== 0;
	if (!has(FLAG.userPresent)) return refused("user-not-present");
	if (!has(FLAG.userVerified)) return refused("user-not-verified");
	if (has(FLAG.backedUp) && !has(FLAG.backupEligible)) return refused("backup-flags");
	return accepted({
		backupEligible: has(FLAG.backupEligible),
		backedUp: has(FLAG.backedUp),
		attested: has(FLAG.attested),
		extended: has(FLAG.extended),
		signCount: bytes.readUInt32BE(33),
		rest: bytes.subarray(FIXED),
	});
}

/** The key, if it is a public key of exactly this algorithm. The library checks that an EC point is on its curve. */
function readKey(spki: Buffer, algorithm: Algorithm): Verdict<KeyObject> {
	let key: KeyObject;
	try {
		key = createPublicKey({ key: spki, format: "der", type: "spki" });
	} catch {
		return refused("key");
	}
	switch (algorithm) {
		case -7:
			return key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1"
				? accepted(key)
				: refused("key-mismatch");
		case -8:
			return key.asymmetricKeyType === "ed25519" ? accepted(key) : refused("key-mismatch");
		case -257:
			if (key.asymmetricKeyType !== "rsa") return refused("key-mismatch");
			return (key.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048 ? accepted(key) : refused("key-too-weak");
		default: {
			const _exhaustive: never = algorithm;
			return refused("algorithm");
		}
	}
}

/** Whether `signature` is this key's signature of `message`, in the one form each algorithm is sent in. */
function signedBy(key: KeyObject, algorithm: Algorithm, message: Buffer, signature: Buffer): boolean {
	try {
		switch (algorithm) {
			case -7:
				return verify("sha256", message, { key, dsaEncoding: "der" }, signature);
			case -8:
				// Ed25519 hashes the message itself, and the library refuses a digest named beside it.
				return verify(null, message, key, signature);
			case -257:
				return verify("sha256", message, { key, padding: constants.RSA_PKCS1_PADDING }, signature);
			default: {
				const _exhaustive: never = algorithm;
				return false;
			}
		}
	} catch {
		return false;
	}
}

// What the route and the operation that call this file must do. The two functions below judge one answer
// against what they are handed. They keep nothing, so everything that needs memory is the caller's.
//
// - The challenge. Each ceremony gets a new one, kept on the server with what it is for (a registration for
//   which account, or a sign-in, and for a sign-in that named passkeys, which ones), when it runs out
//   (`CEREMONY_MS` after it was issued), and the origin and RP ID it was issued under. `Expected` is built from
//   that record, never from the answer. The challenge is used up in the same commit that stores the passkey or
//   creates the session, so of two answers to one challenge only one succeeds. Nothing else stops a second
//   use: a counter that stays at zero does not, and neither does the twin of an ECDSA signature.
// - Where the ceremony began. The record of a challenge also says who asked for it, and an answer is taken
//   only from there: a sign-in from the browser that asked, known by a cookie set with the challenge of which
//   the record keeps the hash; a signed-in registration from the session that asked; a registration with an
//   invitation for that invitation, by the hash of its code. It is compared in the commit that uses the
//   challenge up, on every path; a sign-in and an invitation compare it when the answer arrives as well. A
//   row's number is never what is kept: an import gives it to another row. Without this, a signed answer would be good in any browser that came to hold it.
// - Registration is for one account: the one of the signed-in session that asked for the challenge, or the
//   one of the invitation, which is used up in the same commit. The answer never says which account.
// - A credential id is unique across the instance, by a constraint in the database. A second registration of
//   an id is refused, for the same account too, and a stored passkey is never replaced or moved to another
//   account.
// - At sign-in the account is the one of the stored row that the credential id finds, and the session is for
//   that account. Where the sign-in named passkeys, the credential is one of them. Where the answer carries a
//   user handle, it is that account's handle, and a sign-in that named no passkey must carry one. A handle or
//   an account name in the answer never chooses the account by itself.
// - The person is always verified. Both sets of options ask for it and both functions refuse an answer
//   without it, so there is nothing for the caller to pass and nothing to get wrong.
// - The counter is compared again, with the row as it is then, in the commit that creates the session: zero
//   against a stored zero is accepted, and otherwise the new counter is greater than the stored one. That
//   commit also stores the counter and uses up the challenge, and no session is handed out before it. So of
//   two answers that carry the same counter above zero, the second to commit is refused. Two answers to two
//   challenges from an authenticator that does not count (zero against zero) are both accepted, and that is
//   right: nothing in them says a copy exists.
// - The RP ID and the origin come from the instance's configured public address. They never come from the
//   Host header or a forwarded header, which whoever sends the request chooses.
// - The backup flags and the transports describe a passkey and decide nothing. A rule that came to depend on
//   backup eligibility would first have to compare it with the value stored at registration.
// - Extension bytes are not used.

/**
 * Checks the answer to `navigator.credentials.create` and returns the passkey to store. What the caller has
 * still to do is in the list above: the challenge, the account and a credential id that is not stored yet.
 */
export function verifyRegistration(input: unknown, expected: Expected): Verdict<Passkey> {
	const parsed = RegistrationResponse.safeParse(input);
	if (!parsed.success) return refused("input");
	const sent = parsed.data;
	const id = bytesOf(sent.id, MAX.credentialId);
	if (!id.ok) return id;
	const clientData = bytesOf(sent.clientDataJSON, MAX.clientData);
	if (!clientData.ok) return clientData;
	const authenticatorData = bytesOf(sent.authenticatorData, MAX.authenticatorData);
	if (!authenticatorData.ok) return authenticatorData;
	const publicKey = bytesOf(sent.publicKey, MAX.publicKey);
	if (!publicKey.ok) return publicKey;

	const wrong = clientDataRefusal(clientData.value, "webauthn.create", expected);
	if (wrong) return refused(wrong);
	const data = readAuthenticatorData(authenticatorData.value, expected);
	if (!data.ok) return data;
	if (!data.value.attested) return refused("no-credential-data");
	// The authenticator's model (16 bytes), the length of the credential id (2), the id, then the key as CBOR,
	// which is not read but has to be there.
	const { rest } = data.value;
	if (rest.length < 18) return refused("authenticator-data");
	const idLength = rest.readUInt16BE(16);
	if (idLength === 0 || idLength > MAX.credentialId || rest.length <= 18 + idLength)
		return refused("authenticator-data");
	if (!rest.subarray(18, 18 + idLength).equals(id.value)) return refused("credential-id");

	if (!isAlgorithm(sent.publicKeyAlgorithm)) return refused("algorithm");
	const key = readKey(publicKey.value, sent.publicKeyAlgorithm);
	if (!key.ok) return key;
	return accepted({
		credentialId: sent.id,
		publicKey: key.value.export({ format: "der", type: "spki" }).toString("base64url"),
		algorithm: sent.publicKeyAlgorithm,
		signCount: data.value.signCount,
		backupEligible: data.value.backupEligible,
		backedUp: data.value.backedUp,
		transports: sent.transports,
	});
}

/**
 * Checks the answer to `navigator.credentials.get` against the stored passkey and returns the counter and
 * flags to store, and the user handle to compare. The counter is judged as the code below says: zero against a
 * stored zero is accepted, and otherwise the new counter must be greater than the stored one. Two sign-ins with
 * one passkey can be checked at the same moment against the same stored counter, so the caller repeats that
 * comparison against the current row inside the commit that creates the session. That refuses the second of two
 * answers whose counter is the same and above zero. It does not refuse the second of two answers from an
 * authenticator that does not count: zero against zero passes both times, and each answers a challenge of its
 * own. What else the caller has to do is in the list above `verifyRegistration`: the challenge, the
 * account the stored row belongs to, the passkeys the sign-in named and the user handle.
 */
export function verifyAssertion(input: unknown, stored: StoredPasskey, expected: Expected): Verdict<Assertion> {
	const parsed = AssertionResponse.safeParse(input);
	if (!parsed.success) return refused("input");
	const sent = parsed.data;
	const id = bytesOf(sent.id, MAX.credentialId);
	if (!id.ok) return id;
	const clientData = bytesOf(sent.clientDataJSON, MAX.clientData);
	if (!clientData.ok) return clientData;
	const authenticatorData = bytesOf(sent.authenticatorData, MAX.authenticatorData);
	if (!authenticatorData.ok) return authenticatorData;
	const signature = bytesOf(sent.signature, MAX.signature);
	if (!signature.ok) return signature;
	// The handle is read for its form alone, so that what is handed back is base64url of a length a handle has.
	const userHandle = sent.userHandle ?? null;
	if (userHandle !== null) {
		const handle = bytesOf(userHandle, MAX.userHandle);
		if (!handle.ok) return handle;
	}

	// Both are in the one spelling `bytesOf` accepts, so equal text is equal bytes.
	if (sent.id !== stored.credentialId) return refused("credential-id");
	const wrong = clientDataRefusal(clientData.value, "webauthn.get", expected);
	if (wrong) return refused(wrong);
	const data = readAuthenticatorData(authenticatorData.value, expected);
	if (!data.ok) return data;
	// A sign-in carries no credential data, and only extension data may follow the fixed part.
	const followed = data.value.rest.length > 0;
	if (data.value.attested || data.value.extended !== followed) return refused("authenticator-data");

	const spki = bytesOf(stored.publicKey, MAX.publicKey);
	if (!spki.ok) return refused("key");
	// The stored algorithm and key are checked against each other again, so a row that was altered cannot
	// have a key of one kind verified as another.
	const key = readKey(spki.value, stored.algorithm);
	if (!key.ok) return key;
	const message = Buffer.concat([authenticatorData.value, sha256(clientData.value)]);
	if (!signedBy(key.value, stored.algorithm, message, signature.value)) return refused("signature");

	// After the signature, so only a counter the key signed can raise this. An authenticator that does not
	// count sends zero every time, which is allowed while the stored counter is zero too.
	const { signCount } = data.value;
	if ((stored.signCount !== 0 || signCount !== 0) && signCount <= stored.signCount) return refused("possibly-cloned");
	return accepted({
		signCount,
		backupEligible: data.value.backupEligible,
		backedUp: data.value.backedUp,
		userHandle,
	});
}

/** Where passkeys of this instance belong. */
export type RelyingParty = { readonly id: string; readonly origin: string };
/**
 * The relying party for the address people open the instance at, or null when a browser offers no passkeys
 * there. The RP ID is the host name, so a passkey made at one name does not sign in at another. A browser wants
 * https, or http on `localhost` or a name inside it, and refuses an IP address as an RP ID even on the loopback
 * (`test/e2e/passkey-verifier.test.ts` shows each in Chromium).
 *
 * The address must be the instance's own, from its configuration. This function reads whatever address it is
 * given and cannot tell whose it is: given one taken from a request's Host header or a forwarded header, it
 * makes the sender of the request the relying party.
 */
export function relyingParty(address: string): RelyingParty | null {
	let url: URL;
	try {
		url = new URL(address);
	} catch {
		return null;
	}
	const host = url.hostname;
	const local = host === "localhost" || host.endsWith(".localhost");
	if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
	// `URL` writes every IPv4 spelling as four numbers and an IPv6 address in brackets.
	if (host === "" || host.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;
	return { id: host, origin: url.origin };
}

type Descriptor = { readonly type: "public-key"; readonly id: string; readonly transports: readonly string[] };
const descriptor = (passkey: Pick<Passkey, "credentialId" | "transports">): Descriptor => ({
	type: "public-key",
	id: passkey.credentialId,
	transports: passkey.transports,
});

/**
 * What the page passes to `navigator.credentials.create`, as JSON: the shape of the specification's
 * `PublicKeyCredentialCreationOptionsJSON`, so `PublicKeyCredential.parseCreationOptionsFromJSON` takes it as
 * it is, and a page without that function turns `challenge`, `user.id` and each `excludeCredentials[].id` from
 * base64url into bytes.
 */
export type RegistrationOptions = {
	readonly rp: { readonly id: string; readonly name: string };
	readonly user: { readonly id: string; readonly name: string; readonly displayName: string };
	readonly challenge: Challenge;
	readonly pubKeyCredParams: readonly { readonly type: "public-key"; readonly alg: Algorithm }[];
	readonly timeout: number;
	readonly attestation: "none";
	readonly authenticatorSelection: {
		readonly residentKey: "required";
		readonly requireResidentKey: true;
		readonly userVerification: "required";
	};
	readonly excludeCredentials: readonly Descriptor[];
};
export function registrationOptions(input: {
	rpId: string;
	/** The instance's name, which the browser may show. */
	rpName: string;
	/**
	 * `handle` is what the authenticator files the key under and hands back at sign-in. It must be an opaque
	 * handle of the account that never changes: base64url of 1 to 64 bytes, the same for all of the account's
	 * keys, with no personal information in it (not a name, not an address, not a number that says how many
	 * accounts there are). Random bytes kept with the account do.
	 */
	user: { handle: string; name: string; displayName: string };
	challenge: Challenge;
	/** The person's passkeys so far, so one authenticator is not registered twice. */
	exclude: readonly Pick<Passkey, "credentialId" | "transports">[];
}): RegistrationOptions {
	// The handle is the server's own value and not input, so a wrong one is a fault in the caller. It is thrown
	// here, where the fault is, and not left for an authenticator to refuse.
	const handle = bytesOf(input.user.handle, MAX.userHandle);
	if (!handle.ok || handle.value.length === 0) throw new Error("a user handle is base64url of 1 to 64 bytes");
	return {
		rp: { id: input.rpId, name: input.rpName },
		user: { id: input.user.handle, name: input.user.name, displayName: input.user.displayName },
		challenge: input.challenge,
		pubKeyCredParams: ALGORITHMS.map((alg) => ({ type: "public-key", alg })),
		timeout: CEREMONY_MS,
		// No statement about the authenticator is asked for, because none would be verified.
		attestation: "none",
		// The key is kept on the authenticator with the person's handle, so sign-in needs no name typed first,
		// and the person proves it is them (a fingerprint, a face, a PIN), so the passkey is a way in by itself.
		authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
		excludeCredentials: input.exclude.map(descriptor),
	};
}

/** What the page passes to `navigator.credentials.get`: the specification's `PublicKeyCredentialRequestOptionsJSON`. */
export type AssertionOptions = {
	readonly rpId: string;
	readonly challenge: Challenge;
	readonly timeout: number;
	readonly userVerification: "required";
	readonly allowCredentials: readonly Descriptor[];
};
export function assertionOptions(input: {
	rpId: string;
	challenge: Challenge;
	/** Empty when the server does not know who is signing in: the browser then offers every passkey it has for the RP ID. */
	allow: readonly Pick<Passkey, "credentialId" | "transports">[];
}): AssertionOptions {
	return {
		rpId: input.rpId,
		challenge: input.challenge,
		timeout: CEREMONY_MS,
		userVerification: "required",
		allowCredentials: input.allow.map(descriptor),
	};
}
