// An OpenID provider for the tests, written from the specification: discovery, a key set, an authorization
// endpoint that answers at once for whoever the test says is signing in, and a token endpoint that checks the
// client's secret, the code and its PKCE verifier before it hands out an ID token. A test can twist the next
// token (another key, another audience, an old one) to see the server refuse it.
import { createHash, randomBytes } from "node:crypto";
import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import type { OidcConfig } from "../src/server/kernel/app.ts";

export const CLIENT_ID = "mainworthy-test";
export const CLIENT_SECRET = "client-secret-0123456789";

/** Who the provider says is signing in, and what it does wrong this time. */
export type Next = {
	subject: string;
	email?: string;
	name?: string;
	/**
	 * When the person last signed in at the provider, in seconds since 1970: the ID token's `auth_time`. Absent, the
	 * provider says "now" when asked to sign the person in again (`max_age=0`), as a provider that supports it does;
	 * null leaves the claim out, as a provider that does not support it does.
	 */
	authTime?: number | null;
	/** What to change in the ID token, or in the reply, for this one sign-in. */
	twist?: {
		key?: "other";
		audience?: string;
		issuer?: string;
		nonce?: string;
		/** Seconds from now the token runs out; negative for a token that ran out already. */
		expiresIn?: number;
		/** The authorization endpoint answers with this error instead of a code. */
		error?: string;
		/** The token endpoint waits for this before it answers: a slow provider. */
		held?: () => Promise<void>;
	};
};

export type Provider = {
	issuer: string;
	config: (more?: Partial<OidcConfig>) => OidcConfig;
	/** Who signs in at the next authorization request. */
	next: (who: Next) => void;
	/** Every authorization request's parameters, in order. */
	asked: URLSearchParams[];
	/** How many codes the token endpoint has exchanged. */
	exchanged: () => number;
	/** How far the server's clock runs ahead of this process's, so that "now" at the provider is the server's now. */
	ahead: (ms: number) => void;
	stop: () => void;
};

const providers: Provider[] = [];
export function stopProviders(): void {
	for (const provider of providers.splice(0)) provider.stop();
}

export async function provider(defaultIdentity?: Next): Promise<Provider> {
	const { publicKey, privateKey } = await generateKeyPair("ES256");
	const other = (await generateKeyPair("ES256")).privateKey;
	const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256", use: "sig" };
	let who: Next | null = null;
	let exchanged = 0;
	let aheadMs = 0;
	const asked: URLSearchParams[] = [];
	const codes = new Map<string, { next: Next; nonce: string; challenge: string; redirect: string }>();
	const server: ReturnType<typeof Bun.serve> = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req): Promise<Response> {
			const url = new URL(req.url);
			const issuer = `http://127.0.0.1:${server.port}`;
			if (url.pathname === "/.well-known/openid-configuration")
				return Response.json({
					issuer,
					authorization_endpoint: `${issuer}/authorize`,
					token_endpoint: `${issuer}/token`,
					jwks_uri: `${issuer}/jwks`,
					response_types_supported: ["code"],
					subject_types_supported: ["public"],
					id_token_signing_alg_values_supported: ["ES256"],
					code_challenge_methods_supported: ["S256"],
					token_endpoint_auth_methods_supported: ["client_secret_basic"],
				});
			if (url.pathname === "/jwks") return Response.json({ keys: [jwk] });
			if (url.pathname === "/authorize") {
				asked.push(url.searchParams);
				const redirect = url.searchParams.get("redirect_uri") ?? "";
				const state = url.searchParams.get("state") ?? "";
				const next = who ?? defaultIdentity;
				who = null;
				const back = new URL(redirect);
				if (!next) return new Response("nobody is signing in", { status: 400 });
				if (next.twist?.error) {
					back.searchParams.set("error", next.twist.error);
				} else {
					const code = randomBytes(16).toString("base64url");
					const fresh =
						next.authTime === undefined && url.searchParams.get("max_age") === "0"
							? { ...next, authTime: Math.floor((Date.now() + aheadMs) / 1000) }
							: next;
					codes.set(code, {
						next: fresh,
						nonce: url.searchParams.get("nonce") ?? "",
						challenge: url.searchParams.get("code_challenge") ?? "",
						redirect,
					});
					back.searchParams.set("code", code);
				}
				back.searchParams.set("state", state);
				return new Response(null, { status: 302, headers: { location: back.href } });
			}
			if (url.pathname === "/token" && req.method === "POST") {
				// RFC 6749, 2.3.1: the id and the secret are form-encoded, then joined with a colon, then base64.
				const basic = /^Basic (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
				const [id, secret] = Buffer.from(basic, "base64")
					.toString()
					.split(":")
					.map((part) => decodeURIComponent(part.replaceAll("+", " ")));
				if (id !== CLIENT_ID || secret !== CLIENT_SECRET)
					return Response.json({ error: "invalid_client" }, { status: 401 });
				const body = new URLSearchParams(await req.text());
				const found = codes.get(body.get("code") ?? "");
				codes.delete(body.get("code") ?? "");
				const verifier = body.get("code_verifier") ?? "";
				if (
					!found ||
					body.get("redirect_uri") !== found.redirect ||
					createHash("sha256").update(verifier).digest("base64url") !== found.challenge
				)
					return Response.json({ error: "invalid_grant" }, { status: 400 });
				await found.next.twist?.held?.();
				exchanged++;
				const { next, nonce } = found;
				const twist = next.twist ?? {};
				const at = Math.floor(Date.now() / 1000);
				const claims: Record<string, unknown> = { nonce: twist.nonce ?? nonce };
				if (next.email !== undefined) Object.assign(claims, { email: next.email, email_verified: true });
				if (next.name !== undefined) claims.name = next.name;
				if (next.authTime !== undefined && next.authTime !== null) claims.auth_time = next.authTime;
				const idToken = await new SignJWT(claims)
					.setProtectedHeader({ alg: "ES256", kid: "k1" })
					.setIssuer(twist.issuer ?? issuer)
					.setAudience(twist.audience ?? CLIENT_ID)
					.setSubject(next.subject)
					.setIssuedAt(at - 5)
					.setExpirationTime(at + (twist.expiresIn ?? 300))
					.sign(twist.key === "other" ? other : privateKey);
				return Response.json({ access_token: "unused", token_type: "Bearer", id_token: idToken });
			}
			return new Response("not found", { status: 404 });
		},
	});
	const issuer = `http://127.0.0.1:${server.port}`;
	const made: Provider = {
		issuer,
		config: (more = {}) => ({
			issuer,
			clientId: CLIENT_ID,
			clientSecret: CLIENT_SECRET,
			name: "Example ID",
			...more,
		}),
		next: (next) => {
			who = next;
		},
		asked,
		ahead: (ms) => {
			aheadMs = ms;
		},
		exchanged: () => exchanged,
		stop: () => void server.stop(true),
	};
	providers.push(made);
	return made;
}
