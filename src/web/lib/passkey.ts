// The two passkey ceremonies as a browser runs them: making a passkey from the server's options, and signing
// in with one. The server speaks JSON, with every byte string as base64url and no padding; a browser takes and
// gives bytes. Everything that turns one into the other is here, as functions that need no browser, and the
// two functions at the end are the only ones that touch `navigator.credentials`.
//
// The conversions are written out and not left to `PublicKeyCredential.parseCreationOptionsFromJSON` and
// `toJSON()`: those arrived in browsers years after passkeys did, and one way through this file is one way to
// test. What the page does need of the browser are the getters that hand over a new key in a form the server
// reads without parsing CBOR (`getPublicKey()`, `getAuthenticatorData()`, `getPublicKeyAlgorithm()`). A browser
// that lacks them is told so in a sentence.
import { z } from "zod";

/** Bytes as base64url with no padding: what the server reads for every byte string of a passkey. */
export function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
	const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let binary = "";
	// In pieces: a key of a few hundred bytes fits one call, and an engine's limit on arguments is never met.
	for (let start = 0; start < view.length; start += 0x2000)
		binary += String.fromCharCode(...view.subarray(start, start + 0x2000));
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/**
 * The bytes of base64url text. Text that is not base64url throws: `atob` alone would take plain base64 and
 * padding too, and a value that was read wrongly is refused later with a message that says nothing.
 */
export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
	if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) throw new Error("not base64url");
	const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

const Encoded = z.string().regex(/^[A-Za-z0-9_-]*$/);
const Descriptor = z.object({
	type: z.literal("public-key"),
	id: Encoded,
	transports: z.array(z.string()).default([]),
});
const Verification = z.enum(["required", "preferred", "discouraged"]);

/** What the server answers for a new passkey: `PublicKeyCredentialCreationOptionsJSON`, as it writes it. */
export const CreationOptions = z.object({
	rp: z.object({ id: z.string(), name: z.string() }),
	user: z.object({ id: Encoded, name: z.string(), displayName: z.string() }),
	challenge: Encoded,
	pubKeyCredParams: z.array(z.object({ type: z.literal("public-key"), alg: z.number() })),
	timeout: z.number(),
	attestation: z.enum(["none", "indirect", "direct", "enterprise"]),
	authenticatorSelection: z.object({
		residentKey: Verification,
		requireResidentKey: z.boolean(),
		userVerification: Verification,
	}),
	excludeCredentials: z.array(Descriptor).default([]),
});
export type CreationOptions = z.infer<typeof CreationOptions>;

/** What the server answers for a sign-in: `PublicKeyCredentialRequestOptionsJSON`, as it writes it. */
export const RequestOptions = z.object({
	rpId: z.string(),
	challenge: Encoded,
	timeout: z.number(),
	userVerification: Verification,
	allowCredentials: z.array(Descriptor).default([]),
});
export type RequestOptions = z.infer<typeof RequestOptions>;

const TRANSPORTS = ["ble", "hybrid", "internal", "nfc", "usb"] as const satisfies readonly AuthenticatorTransport[];
const isTransport = (text: string): text is AuthenticatorTransport => TRANSPORTS.some((known) => known === text);

/** A credential the browser is told about. A transport it has no name for is a hint it cannot use, and is left out. */
const described = (entry: z.infer<typeof Descriptor>): PublicKeyCredentialDescriptor => ({
	type: entry.type,
	id: fromBase64Url(entry.id),
	transports: entry.transports.filter(isTransport),
});

/** The options `navigator.credentials.create` takes: the server's, with the challenge, the user handle and each id as bytes. */
export function creationOptions(offered: CreationOptions): PublicKeyCredentialCreationOptions {
	return {
		rp: offered.rp,
		// The handle is the server's own for this person. The authenticator files the key under it and hands it
		// back at sign-in, which is how the server knows who signs in without a name being typed.
		user: { ...offered.user, id: fromBase64Url(offered.user.id) },
		challenge: fromBase64Url(offered.challenge),
		pubKeyCredParams: offered.pubKeyCredParams,
		timeout: offered.timeout,
		attestation: offered.attestation,
		authenticatorSelection: offered.authenticatorSelection,
		excludeCredentials: offered.excludeCredentials.map(described),
	};
}

/** The options `navigator.credentials.get` takes. */
export function requestOptions(offered: RequestOptions): PublicKeyCredentialRequestOptions {
	return {
		rpId: offered.rpId,
		challenge: fromBase64Url(offered.challenge),
		timeout: offered.timeout,
		userVerification: offered.userVerification,
		allowCredentials: offered.allowCredentials.map(described),
	};
}

/** A new passkey as the server reads it (`passkey` of an invitation's acceptance and of `credential passkey.add`). */
export type Registration = {
	id: string;
	clientDataJSON: string;
	authenticatorData: string;
	publicKey: string;
	publicKeyAlgorithm: number;
	transports: string[];
};

export function registrationOf(made: {
	rawId: ArrayBuffer;
	clientDataJSON: ArrayBuffer;
	authenticatorData: ArrayBuffer;
	/** The key as SubjectPublicKeyInfo, which is what `getPublicKey()` returns and the server verifies with. */
	publicKey: ArrayBuffer;
	publicKeyAlgorithm: number;
	transports: string[];
}): Registration {
	return {
		id: toBase64Url(made.rawId),
		clientDataJSON: toBase64Url(made.clientDataJSON),
		authenticatorData: toBase64Url(made.authenticatorData),
		publicKey: toBase64Url(made.publicKey),
		publicKeyAlgorithm: made.publicKeyAlgorithm,
		transports: made.transports,
	};
}

/** A sign-in with a passkey as the server reads it (`passkey` of `POST /api/login`). */
export type Assertion = {
	id: string;
	clientDataJSON: string;
	authenticatorData: string;
	signature: string;
	/** The handle the key was filed under, which names the person. Null when the authenticator gave none. */
	userHandle: string | null;
};

export function assertionOf(given: {
	rawId: ArrayBuffer;
	clientDataJSON: ArrayBuffer;
	authenticatorData: ArrayBuffer;
	signature: ArrayBuffer;
	userHandle: ArrayBuffer | null;
}): Assertion {
	return {
		id: toBase64Url(given.rawId),
		clientDataJSON: toBase64Url(given.clientDataJSON),
		authenticatorData: toBase64Url(given.authenticatorData),
		signature: toBase64Url(given.signature),
		userHandle: given.userHandle ? toBase64Url(given.userHandle) : null,
	};
}

const NOT_HERE = "This browser could not use a passkey here.";
const TOO_OLD =
	"This browser makes a passkey but cannot hand its key to Mainworthy. Use a password, or a newer browser.";

/**
 * What to say when the browser itself refused a ceremony. None of these reach the server, so nothing was
 * changed. The browser's own text is not shown: it differs from one browser to the next and is not written
 * for the person at the keyboard.
 */
export function passkeyRefusal(error: unknown): string {
	const name = typeof error === "object" && error !== null && "name" in error ? error.name : null;
	// The person closed the browser's dialog, or let it run out. A browser does not say which.
	if (name === "NotAllowedError") return "No passkey was used: the request was cancelled or ran out of time.";
	// An authenticator that holds one of the person's passkeys already (the server names them to exclude).
	if (name === "InvalidStateError") return "This passkey is already registered.";
	// `SecurityError` is a page opened at another host name than the one the instance's passkeys belong to.
	return NOT_HERE;
}

/** A ceremony that did not finish, with the sentence to show. */
export class PasskeyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PasskeyError";
	}
}

/** Whether this browser has passkeys at all. Whether it has them at this address is found by trying. */
export const passkeysAvailable = (): boolean =>
	typeof window !== "undefined" &&
	typeof window.PublicKeyCredential === "function" &&
	typeof navigator.credentials?.create === "function";

/** Makes a passkey for the server's options and returns what the server reads of it. */
export async function makePasskey(offered: CreationOptions): Promise<Registration> {
	let credential: Credential | null;
	try {
		credential = await navigator.credentials.create({ publicKey: creationOptions(offered) });
	} catch (error) {
		throw new PasskeyError(passkeyRefusal(error));
	}
	if (!(credential instanceof PublicKeyCredential)) throw new PasskeyError(NOT_HERE);
	const response = credential.response;
	if (!(response instanceof AuthenticatorAttestationResponse)) throw new PasskeyError(NOT_HERE);
	if (
		typeof response.getPublicKey !== "function" ||
		typeof response.getAuthenticatorData !== "function" ||
		typeof response.getPublicKeyAlgorithm !== "function"
	)
		throw new PasskeyError(TOO_OLD);
	// Null for a key of a kind the browser cannot write out. The server asks only for kinds every browser can.
	const publicKey = response.getPublicKey();
	if (!publicKey) throw new PasskeyError(TOO_OLD);
	return registrationOf({
		rawId: credential.rawId,
		clientDataJSON: response.clientDataJSON,
		authenticatorData: response.getAuthenticatorData(),
		publicKey,
		publicKeyAlgorithm: response.getPublicKeyAlgorithm(),
		transports: typeof response.getTransports === "function" ? response.getTransports() : [],
	});
}

/** Signs with a passkey the browser holds for this instance and returns what the server reads of it. */
export async function presentPasskey(offered: RequestOptions): Promise<Assertion> {
	let credential: Credential | null;
	try {
		credential = await navigator.credentials.get({ publicKey: requestOptions(offered) });
	} catch (error) {
		throw new PasskeyError(passkeyRefusal(error));
	}
	if (!(credential instanceof PublicKeyCredential)) throw new PasskeyError(NOT_HERE);
	const response = credential.response;
	if (!(response instanceof AuthenticatorAssertionResponse)) throw new PasskeyError(NOT_HERE);
	return assertionOf({
		rawId: credential.rawId,
		clientDataJSON: response.clientDataJSON,
		authenticatorData: response.authenticatorData,
		signature: response.signature,
		userHandle: response.userHandle,
	});
}
