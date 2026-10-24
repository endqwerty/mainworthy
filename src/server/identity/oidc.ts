// OpenID Connect: what this server asks an identity provider, and what it checks in the answer. The protocol is
// `openid-client`'s (decision 0093): this file keeps the ceremonies under way and hands the library what it needs,
// and the library checks the answer. Who the identity is to this instance is decided in `people.ts`.
//
// A ceremony is the authorization code flow with PKCE, a state and a nonce. The state finds the ceremony when the
// browser comes back. Web ceremonies use the passkeys' ceremony cookie to bind the browser. Native ceremonies
// bind a separate verifier and fixed app callback (decision 0121). A ceremony is spent the moment it is found, before the code is
// exchanged, so of two answers to one the second finds nothing.
//
// The ID token is checked by the library: issuer, audience, nonce, its times, and its signature against the
// provider's published keys. The signature check is switched on here (`enableNonRepudiationChecks`): the library
// otherwise trusts the TLS connection to the token endpoint for it, which the specification allows, and a token
// signed with another key was accepted that way when this was built (2026-10-17).
//
// Ceremonies live in memory, as passkey challenges do: a restart ends them, and the person starts again.
//
// The library is loaded the first time a ceremony needs it. An instance without a provider never loads it, and
// neither does a command or a test that starts a server: loading it cost 5 ms a process (15 ms cold), which made
// the check 2 s slower when every server loaded it (2026-10-17).
import { createHash, randomBytes } from "node:crypto";
import type { Configuration } from "openid-client";
import type { App } from "../kernel/app.ts";
import { takeStart } from "./attempts.ts";
import { Ceremonies } from "./ceremonies.ts";
import { type LimiterAnswer, startAddressKey } from "./limiter.ts";
import { CEREMONY_MS } from "./webauthn.ts";

/** Who the provider says signed in. `email` and `name` describe the identity on a screen and decide nothing. */
export type Identity = { issuer: string; subject: string; email: string | null; name: string | null };

/** What a ceremony was begun for. Each finishes only as what it was begun for. */
export type OidcPurpose =
	| { readonly purpose: "sign-in" }
	| ({ readonly purpose: "native" } & NativeOidcRequest)
	/** An invitation, by the hash of its code, and the person the page said may be signed out of the browser. */
	| { readonly purpose: "join"; readonly invitation: string; readonly replace: string | null }
	/** A signed-in person adding the identity, from the session by the hash of its cookie. */
	| { readonly purpose: "link"; readonly actor: number; readonly session: string };

type Kept = {
	readonly purpose: OidcPurpose;
	/** The hash of the ceremony cookie handed to the browser that began. */
	readonly browser: string | null;
	readonly nonce: string;
	readonly verifier: string;
	readonly deadline: number;
};

/** Why a provider's answer was not taken. The caller logs it; the person is told one thing. */
export type OidcRefusal =
	/** No ceremony of this server by that state, inside its time and not yet spent. */
	| "challenge"
	/** The answer came back to a browser other than the one that began. */
	| "context"
	/** The provider said no, could not be reached, or its answer did not hold up. */
	| "provider";

const ceremonies = new WeakMap<App, Ceremonies<Kept>>();
type Library = typeof import("openid-client");
type Held = { client: Library; configuration: Configuration };
const configurations = new WeakMap<App, Promise<Held>>();
/** How many times the ceremonies were cleared: a finish already past the map compares it when the provider answers. */
const generations = new WeakMap<App, number>();

/** The provider's configuration, discovered once; a failed discovery is tried again by the next ceremony. */
function configurationOf(app: App): Promise<Held> {
	const held = configurations.get(app);
	if (held !== undefined) return held;
	const oidc = app.config.oidc;
	if (!oidc) return Promise.reject(new Error("no identity provider"));
	const issuer = new URL(oidc.issuer);
	// Plain http is let through for a provider on this machine only, which the configuration already holds to.
	const found = import("openid-client").then(async (client) => {
		const insecure = issuer.protocol === "http:" ? { execute: [client.allowInsecureRequests] } : undefined;
		const discovered = await client.discovery(issuer, oidc.clientId, oidc.clientSecret, undefined, insecure);
		// The client's secret goes the way the provider takes it: in the Authorization header, which is what a
		// provider that names no way takes (RFC 8414), or in the body when that is the only way it names.
		const metadata = discovered.serverMetadata();
		const ways = metadata.token_endpoint_auth_methods_supported;
		const auth =
			!ways || ways.includes("client_secret_basic")
				? client.ClientSecretBasic(oidc.clientSecret)
				: client.ClientSecretPost(oidc.clientSecret);
		const configuration = new client.Configuration(metadata, oidc.clientId, oidc.clientSecret, auth);
		if (insecure) client.allowInsecureRequests(configuration);
		client.enableNonRepudiationChecks(configuration);
		return { client, configuration };
	});
	configurations.set(app, found);
	found.catch(() => {
		if (configurations.get(app) === found) configurations.delete(app);
	});
	return found;
}

function keptOf(app: App): Ceremonies<Kept> {
	let kept = ceremonies.get(app);
	if (!kept) {
		kept = new Ceremonies();
		ceremonies.set(app, kept);
	}
	return kept;
}

/**
 * Begins a ceremony: the address to send the browser to. `browser` is the hash of the ceremony cookie the reply
 * will set, and `redirect` the page the provider sends the browser back to. Null when the provider cannot be
 * reached.
 */
export async function beginOidc(
	app: App,
	input: { purpose: OidcPurpose; browser: string | null; redirect: string; address: string | null },
): Promise<string | Extract<LimiterAnswer, { kind: "blocked" }> | null> {
	const deadline = app.now() + CEREMONY_MS;
	let held: Held;
	try {
		held = await configurationOf(app);
	} catch (error) {
		console.warn(`[mainworthy] the identity provider could not be reached: ${(error as Error).message}`);
		return null;
	}
	if (app.now() >= deadline) return null;
	const purpose = input.purpose;
	const owner =
		purpose.purpose === "link"
			? `session ${purpose.session}`
			: purpose.purpose === "join"
				? `invitation ${purpose.invitation}`
				: (startAddressKey(input.address) ?? "unknown");
	if (purpose.purpose === "sign-in" || purpose.purpose === "native") {
		const quota = takeStart(app, input.address);
		if (quota.kind === "blocked") return quota;
	}
	const { client, configuration } = held;
	const verifier = client.randomPKCECodeVerifier();
	const state = client.randomState();
	const nonce = client.randomNonce();
	const kept = keptOf(app);
	const now = app.now();
	kept.put(state, { purpose: input.purpose, browser: input.browser, nonce, verifier, deadline }, owner, now);
	return client.buildAuthorizationUrl(configuration, {
		redirect_uri: input.redirect,
		scope: "openid email profile",
		code_challenge: await client.calculatePKCECodeChallenge(verifier),
		code_challenge_method: "S256",
		state,
		nonce,
	}).href;
}

/**
 * Finishes a ceremony with the query the provider sent the browser back with. `browser` is the hash of the
 * ceremony cookie the request carried, or null. The ceremony is spent once it is found for this browser,
 * whatever the provider's answer turns out to be.
 */
export async function finishOidc(
	app: App,
	input: { query: string; browser: string | null; redirect: string; native?: true },
): Promise<
	| { ok: true; purpose: OidcPurpose; identity: Identity; generation: number }
	| { ok: false; why: OidcRefusal; native?: NativeOidcRequest }
> {
	const params = new URLSearchParams(input.query);
	const state = params.get("state");
	const kept = state === null ? undefined : ceremonies.get(app)?.get(state);
	if (state === null || !kept || app.now() >= kept.deadline) return { ok: false, why: "challenge" };
	if ((kept.purpose.purpose === "native") !== (input.native === true)) return { ok: false, why: "context" };
	if (kept.purpose.purpose !== "native" && (input.browser === null || kept.browser !== input.browser))
		return { ok: false, why: "context" };
	ceremonies.get(app)?.delete(state);
	const generation = generations.get(app) ?? 0;
	const refused = (): { ok: false; why: OidcRefusal; native?: NativeOidcRequest } => ({
		ok: false,
		why: "provider",
		...(kept.purpose.purpose === "native" ? { native: kept.purpose } : {}),
	});
	try {
		const { client, configuration } = await configurationOf(app);
		const tokens = await client.authorizationCodeGrant(configuration, new URL(`${input.redirect}?${params}`), {
			pkceCodeVerifier: kept.verifier,
			expectedState: state,
			expectedNonce: kept.nonce,
			idTokenExpected: true,
		});
		// An import while the code was exchanged ended this ceremony too, though it was no longer in the map.
		if ((generations.get(app) ?? 0) !== generation) return { ok: false, why: "challenge" };
		const claims = tokens.claims();
		if (!claims) return refused();
		const text = (value: unknown): string | null =>
			typeof value === "string" && value.length > 0 && value.length <= 256 ? value : null;
		return {
			ok: true,
			purpose: kept.purpose,
			generation,
			identity: {
				issuer: claims.iss,
				subject: claims.sub,
				email: claims.email_verified === true ? text(claims.email) : null,
				name: text(claims.name) ?? text(claims.preferred_username),
			},
		};
	} catch (error) {
		console.warn(`[mainworthy] the identity provider's answer was not taken: ${(error as Error).message}`);
		return refused();
	}
}

/** Ends every ceremony under way: an import replaced every person a ceremony could name. */
export function clearOidc(app: App): void {
	ceremonies.delete(app);
	handoffs.delete(app);
	generations.set(app, (generations.get(app) ?? 0) + 1);
}

export const NATIVE_OIDC_CALLBACK = "com.mainworthy.app://signin/oidc";
export type NativeOidcRequest = { challenge: string; state: string; callback: string; instance: string };
export type NativeOidcExchange = { code: string; verifier: string; callback: string; instance: string };
type Handoff = NativeOidcRequest & { identity: Identity; credential: number; actor: number; deadline: number };
const handoffs = new WeakMap<App, Ceremonies<Handoff>>();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** A short-lived proof, never a session, carried through the native callback. */
export function issueNativeOidc(app: App, input: Omit<Handoff, "deadline">, generation: number): string | null {
	if ((generations.get(app) ?? 0) !== generation) return null;
	let kept = handoffs.get(app);
	if (!kept) {
		kept = new Ceremonies();
		handoffs.set(app, kept);
	}
	const code = randomBytes(32).toString("base64url");
	kept.put(hash(code), { ...input, deadline: app.now() + 60_000 }, `credential ${input.credential}`, app.now());
	const back = new URL(input.callback);
	back.searchParams.set("code", code);
	back.searchParams.set("state", input.state);
	return back.href;
}

/** Checks the proof before the request is allowed to wait for the write gate without an idle timeout. */
export function findNativeOidc(app: App, input: NativeOidcExchange): Handoff | null {
	const key = hash(input.code);
	const kept = handoffs.get(app)?.get(key);
	if (
		!kept ||
		app.now() >= kept.deadline ||
		kept.instance !== input.instance ||
		kept.callback !== input.callback ||
		createHash("sha256").update(input.verifier).digest("base64url") !== kept.challenge
	)
		return null;
	return kept;
}

/** Consumes inside the session write's gate, so import and concurrent exchanges cannot change the recipient. */
export function takeNativeOidc(app: App, input: NativeOidcExchange): Handoff | null {
	const kept = findNativeOidc(app, input);
	if (kept) handoffs.get(app)?.delete(hash(input.code));
	return kept;
}
