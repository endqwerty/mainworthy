// The passkey verifier (`src/server/identity/webauthn.ts`) against a browser. Chromium makes and uses a passkey
// on a virtual authenticator, with the options the verifier's file produces, and what it returns goes through
// the verifier in this process. The unit tests beside the verifier use an authenticator written from the
// specification; this file is the proof that a real browser writes what that one does.
//
// It also settles where a passkey works on a developer's machine. The suite's servers are opened at
// `http://127.0.0.1:<port>`, and Chromium refuses a passkey there: an IP address is not a relying party id.
// The same server opened at `http://localhost:<port>` works, with `localhost` as the id.
import { expect, test } from "bun:test";
import type { Page } from "playwright-core";
import {
	type Algorithm,
	type AssertionOptions,
	AssertionResponse,
	assertionOptions,
	type Expected,
	newChallenge,
	type RegistrationOptions,
	RegistrationResponse,
	registrationOptions,
	relyingParty,
	verifyAssertion,
	verifyRegistration,
} from "../../src/server/identity/webauthn.ts";
import { browserAvailable, openPage, type PageHarness, type Server, startServer } from "./support.ts";

/** A page of a server in sign-in mode, opened under `host`, with an authenticator that confirms the person by itself. */
async function withAuthenticator(
	host: "localhost" | "app.localhost" | "127.0.0.1",
	journey: (page: Page, origin: string) => Promise<void>,
): Promise<void> {
	const started = await startServer({ mode: "server" });
	const server: Server = { ...started, url: started.url.replace("127.0.0.1", host) };
	let browser: PageHarness | null = null;
	try {
		browser = await openPage(server, { signedIn: false });
		const cdp = await browser.context.newCDPSession(browser.page);
		await cdp.send("WebAuthn.enable");
		await cdp.send("WebAuthn.addVirtualAuthenticator", {
			options: {
				protocol: "ctap2",
				transport: "internal",
				hasResidentKey: true,
				hasUserVerification: true,
				isUserVerified: true,
				automaticPresenceSimulation: true,
			},
		});
		await journey(browser.page, server.url);
		expect(browser.errors).toEqual([]);
	} finally {
		await browser?.close();
		await started.stop();
	}
}

/**
 * `navigator.credentials.create` in the page. The options go as JSON text, as they will from the server, and
 * the browser's own parser takes them. The answer is read with the getters the verifier's file names.
 */
async function create(page: Page, options: RegistrationOptions): Promise<unknown> {
	return page.evaluate(async (json) => {
		const encoded = (buffer: ArrayBuffer | null): string =>
			btoa(String.fromCharCode(...new Uint8Array(buffer ?? new ArrayBuffer(0))))
				.replaceAll("+", "-")
				.replaceAll("/", "_")
				.replaceAll("=", "");
		const credential = await navigator.credentials.create({
			publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(JSON.parse(json)),
		});
		if (!(credential instanceof PublicKeyCredential)) throw new Error("no public key credential");
		const response = credential.response;
		if (!(response instanceof AuthenticatorAttestationResponse)) throw new Error("not a registration");
		return {
			id: encoded(credential.rawId),
			clientDataJSON: encoded(response.clientDataJSON),
			authenticatorData: encoded(response.getAuthenticatorData()),
			publicKey: encoded(response.getPublicKey()),
			publicKeyAlgorithm: response.getPublicKeyAlgorithm(),
			transports: response.getTransports(),
			// What the browser's own JSON form holds, to compare with the fields above.
			json: credential.toJSON(),
		};
	}, JSON.stringify(options));
}

/** `navigator.credentials.get` in the page. */
async function get(page: Page, options: AssertionOptions): Promise<unknown> {
	return page.evaluate(async (json) => {
		const encoded = (buffer: ArrayBuffer): string =>
			btoa(String.fromCharCode(...new Uint8Array(buffer)))
				.replaceAll("+", "-")
				.replaceAll("/", "_")
				.replaceAll("=", "");
		const credential = await navigator.credentials.get({
			publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(JSON.parse(json)),
		});
		if (!(credential instanceof PublicKeyCredential)) throw new Error("no public key credential");
		const response = credential.response;
		if (!(response instanceof AuthenticatorAssertionResponse)) throw new Error("not a sign-in");
		return {
			id: encoded(credential.rawId),
			clientDataJSON: encoded(response.clientDataJSON),
			authenticatorData: encoded(response.authenticatorData),
			signature: encoded(response.signature),
			userHandle: response.userHandle ? encoded(response.userHandle) : null,
		};
	}, JSON.stringify(options));
}

/** The registration options of the verifier's file, for a made-up person. */
function offer(rpId: string, expected: Expected): RegistrationOptions {
	return registrationOptions({
		rpId,
		rpName: "Mainworthy",
		user: { handle: Buffer.from(crypto.randomUUID()).toString("base64url"), name: "robin", displayName: "Robin" },
		challenge: expected.challenge,
		exclude: [],
	});
}

/**
 * The same bytes with the last one flipped. In a signature that is part of a number, so the signature still
 * reads as one and fails as one; in authenticator data it is the low byte of the counter.
 */
function altered(encoded: string): string {
	const bytes = Buffer.from(encoded, "base64url");
	bytes.writeUInt8(bytes.readUInt8(bytes.length - 1) ^ 0xff, bytes.length - 1);
	return bytes.toString("base64url");
}

test.skipIf(!browserAvailable)(
	"a passkey Chromium makes and uses at localhost passes the verifier, and a changed signature, a replay and another origin do not",
	async () => {
		await withAuthenticator("localhost", async (page, origin) => {
			const party = relyingParty(origin);
			expect(party).toEqual({ id: "localhost", origin });
			if (!party) return;
			const expecting = (): Expected => ({
				challenge: newChallenge(),
				origin: party.origin,
				rpId: party.id,
			});

			const registering = expecting();
			const offered = offer(party.id, registering);
			const created = await create(page, offered);
			const registered = verifyRegistration(created, registering);
			if (!registered.ok) throw new Error(`the registration was refused: ${registered.reason}`);
			const passkey = registered.value;
			// The first algorithm offered is the one the authenticator took.
			expect(passkey.algorithm).toBe(-7);
			expect(passkey.transports).toEqual(["internal"]);
			// The key is stored byte for byte as the browser gave it, and the browser's own JSON form of the
			// credential has the same fields, so a page may send those.
			const sent = RegistrationResponse.parse(created);
			expect(passkey.publicKey).toBe(sent.publicKey);
			expect(created).toMatchObject({
				json: {
					id: sent.id,
					response: {
						clientDataJSON: sent.clientDataJSON,
						authenticatorData: sent.authenticatorData,
						publicKey: sent.publicKey,
						publicKeyAlgorithm: sent.publicKeyAlgorithm,
						transports: sent.transports,
					},
				},
			});
			// The answer to one challenge is no answer to another, and not one for the address beside it.
			expect(verifyRegistration(created, expecting())).toEqual({ ok: false, reason: "challenge" });
			expect(verifyRegistration(created, { ...registering, origin: origin.replace("localhost", "127.0.0.1") })).toEqual(
				{ ok: false, reason: "origin" },
			);
			expect(verifyRegistration(created, { ...registering, rpId: "127.0.0.1" })).toEqual({
				ok: false,
				reason: "rp-id",
			});

			// Sign-in with no name given: the browser finds the passkey by the relying party.
			const first = expecting();
			const used = await get(page, assertionOptions({ rpId: party.id, challenge: first.challenge, allow: [] }));
			const signedIn = verifyAssertion(used, passkey, first);
			if (!signedIn.ok) throw new Error(`the sign-in was refused: ${signedIn.reason}`);
			// The authenticator hands back the handle the key was filed under, for the caller to find the account by.
			expect(signedIn.value.userHandle).toBe(offered.user.id);
			expect(signedIn.value.signCount).toBeGreaterThan(passkey.signCount);

			const answer = AssertionResponse.parse(used);
			expect(verifyAssertion({ ...answer, signature: altered(answer.signature) }, passkey, first)).toEqual({
				ok: false,
				reason: "signature",
			});
			// A counter raised after signing is not what was signed.
			expect(
				verifyAssertion({ ...answer, authenticatorData: altered(answer.authenticatorData) }, passkey, first),
			).toEqual({ ok: false, reason: "signature" });
			expect(verifyAssertion(used, passkey, expecting())).toEqual({ ok: false, reason: "challenge" });
			// The registration is not a sign-in.
			expect(verifyAssertion({ ...sent, signature: answer.signature }, passkey, registering)).toEqual({
				ok: false,
				reason: "type",
			});

			// A second sign-in, named this time, counts on from the first. The first answer offered again after
			// it is behind the stored counter.
			const second = expecting();
			const again = await get(
				page,
				assertionOptions({ rpId: party.id, challenge: second.challenge, allow: [passkey] }),
			);
			const afterFirst = { ...passkey, signCount: signedIn.value.signCount };
			const signedInAgain = verifyAssertion(again, afterFirst, second);
			if (!signedInAgain.ok) throw new Error(`the second sign-in was refused: ${signedInAgain.reason}`);
			expect(signedInAgain.value.signCount).toBeGreaterThan(afterFirst.signCount);
			expect(verifyAssertion(used, { ...passkey, signCount: signedInAgain.value.signCount }, first)).toEqual({
				ok: false,
				reason: "possibly-cloned",
			});
		});
	},
	30_000,
);

// One of the two runs under a name inside `localhost`, which Chromium takes as a relying party of its own.
for (const [name, algorithm, host] of [
	["EdDSA", -8, "app.localhost"],
	["RS256", -257, "localhost"],
] satisfies [string, Algorithm, "localhost" | "app.localhost"][]) {
	test.skipIf(!browserAvailable)(
		`a passkey Chromium makes with ${name} at ${host} passes the verifier`,
		async () => {
			await withAuthenticator(host, async (page, origin) => {
				expect(relyingParty(origin)).toEqual({ id: host, origin });
				const expecting = (): Expected => ({
					challenge: newChallenge(),
					origin,
					rpId: host,
				});
				const registering = expecting();
				// The verifier's file offers ES256 first, and the authenticator takes the first it knows. Offering
				// this one alone is how the others are reached.
				const offered = offer(host, registering);
				const created = await create(page, { ...offered, pubKeyCredParams: [{ type: "public-key", alg: algorithm }] });
				const registered = verifyRegistration(created, registering);
				if (!registered.ok) throw new Error(`the registration was refused: ${registered.reason}`);
				expect(registered.value.algorithm).toBe(algorithm);

				const signing = expecting();
				const used = await get(page, assertionOptions({ rpId: host, challenge: signing.challenge, allow: [] }));
				expect(verifyAssertion(used, registered.value, signing)).toMatchObject({
					ok: true,
					value: { userHandle: offered.user.id },
				});
				const answer = AssertionResponse.parse(used);
				expect(verifyAssertion({ ...answer, signature: altered(answer.signature) }, registered.value, signing)).toEqual(
					{ ok: false, reason: "signature" },
				);
			});
		},
		30_000,
	);
}

test.skipIf(!browserAvailable)(
	"Chromium makes no passkey at an IP address, so the suite's 127.0.0.1 is no relying party",
	async () => {
		await withAuthenticator("127.0.0.1", async (page, origin) => {
			expect(relyingParty(origin)).toBeNull();
			const attempt = async (rpId: string): Promise<string> => {
				const options = offer(rpId, {
					challenge: newChallenge(),
					origin,
					rpId,
				});
				return create(page, options).then(
					() => "made",
					(error: unknown) => (error instanceof Error ? error.message : String(error)),
				);
			};
			// The page is a secure context, which is what other browser features ask of it.
			expect(await page.evaluate(() => window.isSecureContext)).toBe(true);
			expect(await attempt("127.0.0.1")).toContain("SecurityError");
			// And a page at the address may not claim the name.
			expect(await attempt("localhost")).toContain("SecurityError");
		});
	},
	30_000,
);
