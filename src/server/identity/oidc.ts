// OpenID Connect: what this server asks an identity provider, and what it checks in the answer. The protocol is
// `openid-client`'s (decision 0093): this file keeps the ceremonies under way and hands the library what it needs,
// and the library checks the answer. Who the identity is to this instance is decided in `people.ts`.
//
// A ceremony is the authorization code flow with PKCE, a state and a nonce. The state finds the ceremony when the
// browser comes back, and the ceremony cookie binds it to the browser that began. A ceremony is spent the moment it
// is found, before the code is exchanged, so of two answers to one the second finds nothing. A ceremony of proof
// asks the provider to sign the person in again (`max_age=0`) and to say when it did (`auth_time`, asked for as an
// essential claim); `people.ts` takes the proof only when it says, and recently.
//
// The ID token is checked by the library: issuer, audience, nonce, its times, and its signature against the
// provider's published keys. The signature check is switched on here (`enableNonRepudiationChecks`): the library
// otherwise trusts the TLS connection to the token endpoint for it, which the specification allows, and a token
// signed with another key was accepted that way when this was built (2026-10-17).
//
// Ceremonies and their import generation live in PostgreSQL, shared by every instance.
//
// The library is loaded the first time a ceremony needs it. An instance without a provider never loads it, and
// neither does a command or a test that starts a server: loading it cost 5 ms a process (15 ms cold), which made
// the check 2 s slower when every server loaded it (2026-10-17).
import type { Configuration } from "openid-client";
import { z } from "zod";
import type { App } from "../kernel/app.ts";
import { takeStart } from "./attempts.ts";
import { Ceremonies, ceremonyGeneration, ceremonyWrite } from "./ceremonies.ts";
import { type LimiterAnswer, startAddressKey } from "./limiter.ts";

/** How long a ceremony waits for the browser to come back from the provider. */
/**
 * How many ceremonies one person (a link or proof, whatever session began it) or one invitation (an acceptance) may
 * have under way at once: enough for two tabs or two people at the same moment, too few to fill the instance's.
 */
const OWNER_CEREMONIES = 3;
export const CEREMONY_MS = 5 * 60_000;

/**
 * Who the provider says signed in. `email` and `name` describe the identity on a screen and decide nothing.
 * `authTime` is when the person last signed in at the provider, in milliseconds, when its ID token says.
 */
export type Identity = {
	issuer: string;
	subject: string;
	email: string | null;
	name: string | null;
	authTime: number | null;
};

/** What a ceremony was begun for. Each finishes only as what it was begun for. */
export type OidcPurpose =
	| { readonly purpose: "sign-in" }
	/** An invitation, by the hash of its code, and the person the page said may be signed out of the browser. */
	| { readonly purpose: "join"; readonly invitation: string; readonly replace: number | null }
	/**
	 * A signed-in person adding the identity, or proving it is them before a sign-in change, from the session by
	 * the hash of its cookie.
	 */
	| { readonly purpose: "link" | "proof"; readonly actor: number; readonly session: string };

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

const Purpose = z.discriminatedUnion("purpose", [
	z.object({ purpose: z.literal("sign-in") }),
	z.object({ purpose: z.literal("join"), invitation: z.string(), replace: z.number().int().nullable() }),
	z.object({ purpose: z.literal("link"), actor: z.number().int(), session: z.string() }),
	z.object({ purpose: z.literal("proof"), actor: z.number().int(), session: z.string() }),
]);
const KeptValue = z.object({
	purpose: Purpose,
	browser: z.string().nullable(),
	nonce: z.string(),
	verifier: z.string(),
	deadline: z.number(),
});
const ceremonies = new Ceremonies("oidc", (value): Kept => KeptValue.parse(value));
type Library = typeof import("openid-client");
type Held = { client: Library; configuration: Configuration };
const configurations = new WeakMap<App, Promise<Held>>();

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
		purpose.purpose === "link" || purpose.purpose === "proof"
			? `actor ${purpose.actor}`
			: purpose.purpose === "join"
				? `invitation ${purpose.invitation}`
				: (startAddressKey(input.address) ?? "unknown");
	if (purpose.purpose === "sign-in") {
		const quota = await takeStart(app, input.address);
		if (quota.kind === "blocked") return quota;
	}
	const { client, configuration } = held;
	const verifier = client.randomPKCECodeVerifier();
	const state = client.randomState();
	const nonce = client.randomNonce();
	const now = app.now();
	await ceremonyWrite(app, undefined, (db) =>
		ceremonies.put(
			db,
			state,
			{ purpose: input.purpose, browser: input.browser, nonce, verifier, deadline },
			owner,
			now,
			// A person's links and proofs, from however many sessions, and an invitation's acceptances each hold a few
			// places; each ceremony still finishes only in the session that began it. Only an anonymous sign-in, which the
			// start limiter counts, has no owner limit.
			purpose.purpose === "sign-in" ? undefined : OWNER_CEREMONIES,
		),
	);
	return client.buildAuthorizationUrl(configuration, {
		redirect_uri: input.redirect,
		scope: "openid email profile",
		code_challenge: await client.calculatePKCECodeChallenge(verifier),
		code_challenge_method: "S256",
		state,
		nonce,
		...(purpose.purpose === "proof"
			? { max_age: "0", claims: JSON.stringify({ id_token: { auth_time: { essential: true } } }) }
			: {}),
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
): Promise<
	| { ok: true; purpose: OidcPurpose; identity: Identity; generation: string; begun: number }
	| { ok: false; why: OidcRefusal }
> {
	const params = new URLSearchParams(input.query);
	const state = params.get("state");
	if (state === null) return { ok: false, why: "challenge" };
	const accepted = await ceremonyWrite(app, undefined, async (db) => {
		const kept = await ceremonies.get(db, state, app.now());
		if (!kept) return { ok: false, why: "challenge" } as const;
		if (input.browser === null || kept.browser !== input.browser) return { ok: false, why: "context" } as const;
		if (!(await ceremonies.take(db, state, app.now()))) return { ok: false, why: "challenge" } as const;
		return { ok: true, kept } as const;
	});
	if (!accepted.ok) return accepted;
	const kept = accepted.kept;
	const generation = kept.generation;
	const refused = (): { ok: false; why: OidcRefusal } => ({ ok: false, why: "provider" });
	try {
		const { client, configuration } = await configurationOf(app);
		const tokens = await client.authorizationCodeGrant(configuration, new URL(`${input.redirect}?${params}`), {
			pkceCodeVerifier: kept.verifier,
			expectedState: state,
			expectedNonce: kept.nonce,
			idTokenExpected: true,
		});
		// An import while the code was exchanged ended this ceremony too, though its row was already consumed.
		if ((await app.database.admissionRead(ceremonyGeneration)) !== generation) return { ok: false, why: "challenge" };
		const claims = tokens.claims();
		if (!claims) return refused();
		const text = (value: unknown): string | null =>
			typeof value === "string" && value.length > 0 && value.length <= 256 ? value : null;
		return {
			ok: true,
			purpose: kept.purpose,
			generation,
			begun: kept.deadline - CEREMONY_MS,
			identity: {
				issuer: claims.iss,
				subject: claims.sub,
				email: claims.email_verified === true ? text(claims.email) : null,
				name: text(claims.name) ?? text(claims.preferred_username),
				authTime: typeof claims.auth_time === "number" ? claims.auth_time * 1000 : null,
			},
		};
	} catch (error) {
		console.warn(`[mainworthy] the identity provider's answer was not taken: ${(error as Error).message}`);
		return refused();
	}
}
