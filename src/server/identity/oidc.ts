// OpenID Connect: what this server asks an identity provider, and what it checks in the answer. The protocol is
// `openid-client`'s (decision 0093): this file keeps the ceremonies under way and hands the library what it needs,
// and the library checks the answer. Who the identity is to this instance is decided in `people.ts`.
//
// A ceremony is the authorization code flow with PKCE, a state and a nonce. The state finds the ceremony when the
// browser comes back, and the ceremony cookie (the passkeys' one) ties it to the browser that began it, so an
// answer carried to another browser is refused. A ceremony is spent the moment it is found, before the code is
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
import type { Configuration } from "openid-client";
import type { App } from "../kernel/app.ts";
import { CEREMONY_MS } from "./webauthn.ts";

/** Who the provider says signed in. `email` and `name` describe the identity on a screen and decide nothing. */
export type Identity = { issuer: string; subject: string; email: string | null; name: string | null };

/** What a ceremony was begun for. Each finishes only as what it was begun for. */
export type OidcPurpose =
	| { readonly purpose: "sign-in" }
	/** An invitation, by the hash of its code, and the person the page said may be signed out of the browser. */
	| { readonly purpose: "join"; readonly invitation: string; readonly replace: string | null }
	/** A signed-in person adding the identity, from the session by the hash of its cookie. */
	| { readonly purpose: "link"; readonly actor: number; readonly session: string };

type Kept = {
	readonly purpose: OidcPurpose;
	/** The hash of the ceremony cookie handed to the browser that began. */
	readonly browser: string;
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

/** As many as the passkeys' map keeps, for the same reason: anybody can begin one without signing in. */
const MOST = 10_000;
const ceremonies = new WeakMap<App, Map<string, Kept>>();
type Library = typeof import("openid-client");
type Held = { client: Library; configuration: Configuration };
const configurations = new WeakMap<App, Promise<Held>>();
/** How many times the ceremonies were cleared: a finish already past the map compares it when the provider answers. */
const generations = new WeakMap<App, number>();

/** The provider's configuration, discovered once; a failed discovery is tried again by the next ceremony. */
function configurationOf(app: App): Promise<Held> {
	const held = configurations.get(app);
	if (held) return held;
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

function keptOf(app: App): Map<string, Kept> {
	let kept = ceremonies.get(app);
	if (!kept) {
		kept = new Map();
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
	input: { purpose: OidcPurpose; browser: string; redirect: string },
): Promise<string | null> {
	let held: Held;
	try {
		held = await configurationOf(app);
	} catch (error) {
		console.warn(`[mainworthy] the identity provider could not be reached: ${(error as Error).message}`);
		return null;
	}
	const { client, configuration } = held;
	const verifier = client.randomPKCECodeVerifier();
	const state = client.randomState();
	const nonce = client.randomNonce();
	const kept = keptOf(app);
	const now = app.now();
	if (kept.size >= MOST) {
		for (const [key, entry] of kept) if (now >= entry.deadline) kept.delete(key);
		for (const key of kept.keys()) {
			if (kept.size < MOST) break;
			kept.delete(key);
		}
	}
	kept.set(state, { purpose: input.purpose, browser: input.browser, nonce, verifier, deadline: now + CEREMONY_MS });
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
	input: { query: string; browser: string | null; redirect: string },
): Promise<{ ok: true; purpose: OidcPurpose; identity: Identity } | { ok: false; why: OidcRefusal }> {
	const params = new URLSearchParams(input.query);
	const state = params.get("state");
	const kept = state === null ? undefined : ceremonies.get(app)?.get(state);
	if (state === null || !kept || app.now() >= kept.deadline) return { ok: false, why: "challenge" };
	if (input.browser === null || kept.browser !== input.browser) return { ok: false, why: "context" };
	ceremonies.get(app)?.delete(state);
	const generation = generations.get(app) ?? 0;
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
		if (!claims) return { ok: false, why: "provider" };
		const text = (value: unknown): string | null =>
			typeof value === "string" && value.length > 0 && value.length <= 256 ? value : null;
		return {
			ok: true,
			purpose: kept.purpose,
			identity: {
				issuer: claims.iss,
				subject: claims.sub,
				email: claims.email_verified === true ? text(claims.email) : null,
				name: text(claims.name) ?? text(claims.preferred_username),
			},
		};
	} catch (error) {
		console.warn(`[mainworthy] the identity provider's answer was not taken: ${(error as Error).message}`);
		return { ok: false, why: "provider" };
	}
}

/** Ends every ceremony under way: an import replaced every person a ceremony could name. */
export function clearOidc(app: App): void {
	ceremonies.delete(app);
	generations.set(app, (generations.get(app) ?? 0) + 1);
}
