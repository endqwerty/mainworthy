// The sign-in routes for people: a name and a password, a passkey, the identity provider, an invitation, and
// setting a password. They
// are exchanges of the HTTP surface and not operations (decision 0017, 4): nobody is signed in yet, a password
// is checked outside the write gate, and a password must never reach the registry, which keeps a digest of
// each request that carries a command id.
//
// `http.ts` owns the request: where it came from, its body, the cookie. It hands those in as `Tools`, so this
// file reads no header the other file reads differently. Who somebody is, is decided in the identity module;
// this file turns a body into a question for it and an answer into a reply.
//
// A name, a password, a passkey's answer or an invitation code that is looked at and refused is answered one
// way, whatever was wrong: 401 and one sentence. Why goes to the log as a code, with no name and nothing the
// caller typed, since a name field is where a password is typed by mistake. The other replies say nothing of
// a proof: 429 while the caller is limited, 400 for a request that is wrong in itself (a password's length, a
// passkey where there are none), 409 for a browser signed in as somebody else, and 408 for a body that took
// too long to arrive.
import { z } from "zod";
import { type ErrorCode, HTTP_STATUS } from "../core/api.ts";
import { EmailAddress, whyNotPassword } from "../core/people.ts";
import {
	type Accepted,
	acceptInvitation,
	beginCredentialProof,
	beginNativeOidc,
	beginOidcSignIn,
	changePassword,
	exchangeNativeOidc,
	finishNativeOidc,
	finishOidcSignIn,
	NATIVE_OIDC_CALLBACK,
	OIDC_OFF,
	type OidcStart,
	PASSKEYS_OFF,
	type PasswordChange,
	passkeySignInOptions,
	proveCredential,
	publicAddress,
	RECENT_PROOF_MESSAGE,
	requestReset,
	resetPassword,
	resolveCaller,
	type Session,
	type SignedIn,
	showInvitation,
	signInMethods,
	signInWithPasskey,
	signInWithPassword,
	signInWithTotp,
	verifyEmail,
	type WhyNot,
} from "../server/identity/identity.ts";
import type { App } from "../server/kernel/app.ts";
import { OpError } from "../server/kernel/errors.ts";

/** What the listener knows of the connection a request arrived on, and may do to it: as `http.ts` has it. */
type Listener = Pick<ReturnType<typeof Bun.serve>, "requestIP" | "timeout">;

/** What `http.ts` lends: everything about a request that it already knows how to read or write. */
export type Tools = {
	/** Whether the request comes from this server's own page, or from no page at all. */
	sameOrigin: (req: Request) => boolean;
	/**
	 * The JSON body, of at most `limit` bytes and arrived within the time a sign-in is given; or the reply
	 * that says it was not.
	 */
	read: (req: Request, limit: number) => Promise<{ input: unknown } | Response>;
	json: (body: unknown, status?: number, extra?: Headers) => Response;
	/** The `Set-Cookie` headers that hand a browser its new session. */
	cookies: (req: Request, signedIn: SignedIn) => Headers;
	/** The value of the session cookie the request carries, or null. */
	cookieOf: (req: Request) => string | null;
	/**
	 * The ceremony cookie, which ties a passkey sign-in to the browser that asked for its challenge: its value on
	 * a request (null for none, and for two), and the `Set-Cookie` values that set it for some seconds or clear
	 * it. Its name and attributes follow the session cookie's rules, which `http.ts` holds once.
	 */
	ceremony: {
		of: (req: Request) => string | null;
		set: (req: Request, value: string, seconds: number) => string[];
		clear: (req: Request) => string[];
	};
	/** The session of a request, or the reply that refuses it. */
	sessionFor: (req: Request, server: Listener) => Promise<Session | Response>;
	/** The address a request came from, as failed attempts are counted and a session records it; null when nothing says. */
	address: (req: Request, server: Listener) => string | null;
	/** The reply to a caller that failed too often: 429, with the seconds to wait. */
	limited: (seconds: number) => Response;
};

/** The one thing a refused sign-in is told. */
const NOT_SIGNED_IN = "that did not sign you in";
/** The one thing the page of an invitation is told when the code accepts nothing, whatever the reason. */
const NO_INVITATION =
	"this invitation does not work: it was used, it was withdrawn, it has run out, or the link is incomplete. Ask whoever sent it for a new one";

// A body is one way of signing in and nothing beside it, so each shape refuses a member it does not name: a
// request that carries two proofs is not judged by the one that happens to be read first.
const WithPassword = z.strictObject({ name: z.string().min(1).max(254), password: z.string().min(1).max(512) });
const WithTotp = z.strictObject({ challenge: z.string().min(1).max(128), code: z.string().min(1).max(128) });
const RecentProof = z.union([
	z.strictObject({ begin: z.literal(true) }),
	z.strictObject({ password: z.string().min(1).max(512) }),
	z.strictObject({ passkey: z.unknown().refine((value) => value !== undefined) }),
	z.strictObject({ code: z.string().min(1).max(128) }),
]);
const ResetRequest = z.strictObject({ resetRequest: EmailAddress });
const EmailVerification = z.strictObject({ emailVerification: z.string().min(1).max(128) });
const ResetPassword = z.strictObject({ reset: z.string().min(1).max(128), password: z.string().max(4096) });
const WithPasskey = z.strictObject({ passkey: z.record(z.string(), z.unknown()) });
/** The query the identity provider sent the browser back to `/signin/oidc` with, as the page found it. */
const WithOidc = z.strictObject({ oidc: z.string().min(1).max(4096) });
const NativeRequest = z.strictObject({
	challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
	state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
	callback: z.literal(NATIVE_OIDC_CALLBACK),
	instance: z.string().max(256),
});
const WithNativeOidc = z.strictObject({
	nativeOidc: z.strictObject({
		code: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
		verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
		callback: z.literal(NATIVE_OIDC_CALLBACK),
		instance: z.string().max(256),
	}),
});
const WithInvitation = z.strictObject({
	invitation: z.string().min(1).max(128),
	password: z.string().max(4096).optional(),
	passkey: z.record(z.string(), z.unknown()).optional(),
	label: z.string().trim().min(1).max(60).optional(),
	// Judged where the body is, so that a bare yes is told what to send and is not answered as a wrong proof.
	replace: z.unknown().optional(),
});
/**
 * Who the page asked about before it went on: the name of the person the browser was signed in as. A yes that
 * names nobody could end the session of somebody the page never asked about, so it is not taken.
 */
const Replace = z.string().min(1).max(64);
const Challenge = z.union([
	z.strictObject({}),
	z.strictObject({ native: z.literal(true) }),
	z.strictObject({ invitation: z.string().min(1).max(128) }),
]);
/** What the page begins with the provider: a sign-in, an invitation's acceptance, or linking a signed-in person. */
const OidcBegin = z.union([
	z.strictObject({}),
	z.strictObject({ invitation: z.string().min(1).max(128), replace: z.string().min(1).max(64).optional() }),
	z.strictObject({ link: z.literal(true) }),
]);
const NewPassword = z.strictObject({ current: z.string().min(1).max(512).optional(), next: z.string().max(4096) });

/** The largest body of each route. A passkey's answer with an RSA key is the longest thing a browser sends. */
export const SIGN_IN_BODY_LIMIT = 16 * 1024;
const CHALLENGE_BODY_LIMIT = 1024;
const PASSWORD_BODY_LIMIT = 16 * 1024;

export function signInRoutes(app: App, tools: Tools) {
	const failed = (code: ErrorCode, message: string, details?: Record<string, unknown>): Response =>
		tools.json({ ok: false, error: details ? { code, message, details } : { code, message } }, HTTP_STATUS[code]);
	const answered = (result: unknown): Response => tools.json({ ok: true, result });
	/** The one reply of a refused sign-in. The reason is written to the log and to nothing the caller sees. */
	const refused = (why: WhyNot, credential?: number): Response => {
		console.warn(
			`[mainworthy] sign-in refused: ${why}${credential === undefined ? "" : ` (credential ${credential})`}`,
		);
		return failed("unauthenticated", NOT_SIGNED_IN);
	};
	const passkeysOff = (): Response => failed("invalid", PASSKEYS_OFF);

	/**
	 * `POST /api/login` for a body that is not a token: `{ name, password }`, `{ passkey }`, or
	 * `{ invitation, password?, passkey?, label?, replace? }`. `http.ts` has checked where the request comes
	 * from and read its body.
	 */
	async function signIn(req: Request, server: Listener, input: unknown): Promise<Response> {
		const reply = await knownRefusal(async () => await answerSignIn(req, server, input));
		// A sign-in with a passkey ends its ceremony whatever came of it: the cookie that tied the challenge to
		// this browser is cleared with the reply, accepted, refused or told to wait.
		if (
			WithPasskey.safeParse(input).success ||
			WithOidc.safeParse(input).success ||
			(WithTotp.safeParse(input).success && reply.ok && reply.headers.has("set-cookie"))
		)
			for (const cookie of tools.ceremony.clear(req)) reply.headers.append("set-cookie", cookie);
		return reply;
	}

	async function answerSignIn(req: Request, server: Listener, input: unknown): Promise<Response> {
		const resetRequest = ResetRequest.safeParse(input);
		const verification = EmailVerification.safeParse(input);
		const reset = ResetPassword.safeParse(input);
		if (resetRequest.success || verification.success || reset.success) {
			if (!app.config.mail) return failed("invalid", "mail is off on this instance");
			if (resetRequest.success) {
				const limited = await requestReset(app, resetRequest.data.resetRequest, tools.address(req, server));
				return limited ? tools.limited(limited.retryAfter) : answered({ requested: true });
			}
			if (verification.success)
				return (await verifyEmail(app, verification.data.emailVerification, () => server.timeout(req, 0)))
					? answered({ verified: true })
					: failed("invalid", "this verification link does not work; ask for another");
			if (reset.success) {
				const why = whyNotPassword(reset.data.password);
				if (why) return failed("invalid", why);
				const changed = await resetPassword(app, {
					code: reset.data.reset,
					password: reset.data.password,
					address: tools.address(req, server),
					proven: () => server.timeout(req, 0),
				});
				if (typeof changed === "object") return tools.limited(changed.retryAfter);
				if (changed === "changed") return answered({ changed: true });
				return failed(
					changed === "busy" ? "conflict" : "invalid",
					changed === "busy"
						? "the server is busy; try again in a moment"
						: "this reset link does not work; ask for another",
				);
			}
		}
		const about = {
			userAgent: req.headers.get("user-agent"),
			address: tools.address(req, server),
			// Once the proof is good the caller is vouched for, as a request with a session is: the session is
			// written at the gate, and the wait there may outlast the idle timeout.
			proven: () => server.timeout(req, 0),
		};
		const withPassword = WithPassword.safeParse(input);
		const withPasskey = WithPasskey.safeParse(input);
		const withTotp = WithTotp.safeParse(input);
		const withInvitation = WithInvitation.safeParse(input);
		const withOidc = WithOidc.safeParse(input);
		const native = WithNativeOidc.safeParse(input);
		let entry: Accepted;
		if (native.success) {
			entry = await exchangeNativeOidc(app, native.data.nativeOidc, about);
		} else if (withOidc.success) {
			if (!app.config.oidc) return failed("invalid", OIDC_OFF);
			const finished = await finishOidcSignIn(
				app,
				{ query: withOidc.data.oidc, ceremony: tools.ceremony.of(req), browser: tools.cookieOf(req) },
				about,
			);
			if (finished.ok && "linked" in finished) return answered({ linked: true });
			if (!finished.ok && finished.why === "linked-already")
				return failed(
					"conflict",
					"this identity is linked already, to you or to somebody else on this instance; nothing was changed",
				);
			entry = finished;
		} else if (withPassword.success) {
			const password = await signInWithPassword(app, withPassword.data, about);
			if (password.ok && "secondFactor" in password) {
				const headers = new Headers();
				for (const cookie of tools.ceremony.set(
					req,
					password.ceremony,
					Math.max(1, Math.ceil((password.secondFactor.expiresAt - app.now()) / 1000)),
				))
					headers.append("set-cookie", cookie);
				return tools.json({ ok: true, result: { signedIn: false, secondFactor: password.secondFactor } }, 200, headers);
			}
			entry = password;
		} else if (withTotp.success)
			entry = await signInWithTotp(app, { ...withTotp.data, ceremony: tools.ceremony.of(req) }, about);
		else if (withPasskey.success) {
			if (!publicAddress(app.config)) return passkeysOff();
			entry = await signInWithPasskey(
				app,
				{ answer: withPasskey.data.passkey, ceremony: tools.ceremony.of(req) },
				about,
			);
		} else if (withInvitation.success) {
			const { invitation, password, passkey, label } = withInvitation.data;
			const replace = withInvitation.data.replace === undefined ? null : Replace.safeParse(withInvitation.data.replace);
			// What is wrong with the request itself is said before the invitation is looked at, so it says nothing
			// about the invitation.
			if (password === undefined && passkey === undefined)
				return failed("invalid", "accepting an invitation needs a password, a passkey or both");
			const why = password === undefined ? null : whyNotPassword(password);
			if (why) return failed("invalid", why);
			if (replace && !replace.success)
				return failed(
					"invalid",
					"replace: the name of the person this browser is signed in as, the one the page asked about",
				);
			if (passkey !== undefined && !publicAddress(app.config)) return passkeysOff();
			entry = await acceptInvitation(
				app,
				{ code: invitation, password, passkey, label, replace: replace?.data ?? null, browser: tools.cookieOf(req) },
				about,
			);
		} else return refused("input");
		if (entry.ok) return tools.json({ ok: true, result: { signedIn: true } }, 200, tools.cookies(req, entry.signedIn));
		// Too many failed attempts from this address, or at this name: the wait, and nothing about which.
		if (entry.why === "limited") return tools.limited(entry.retryAfter);
		if (entry.why === "second-factor-required")
			return failed(
				"forbidden",
				"this instance requires a second factor for admins. Sign in with a passkey, or use an existing session to enrol an authenticator in Settings, Your sign-in. The owner can bootstrap enrolment by signing in with the owner token",
			);
		if (entry.why === "other-session") {
			return failed(
				"conflict",
				`this browser is signed in as ${entry.signedInAs}, and the invitation is for somebody else. Send replace: "${entry.signedInAs}" to sign ${entry.signedInAs} out of this browser and accept it`,
				{ signedInAs: entry.signedInAs },
			);
		}
		return refused(entry.why, entry.credential);
	}

	/**
	 * `POST /api/login/challenge`. `{}`: web passkey options. `{ native: true }`: native assertion options.
	 * `{ invitation }`: who the invitation is for, and the options for registering a passkey with it.
	 * An admitted anonymous start stores a challenge through the independent admission pool;
	 * a working invitation reuses its challenge, with a successor near expiry for an ongoing prompt.
	 */
	async function challenge(req: Request, server: Listener): Promise<Response> {
		if (!tools.sameOrigin(req)) return failed("unauthenticated", NOT_SIGNED_IN);
		const read = await tools.read(req, CHALLENGE_BODY_LIMIT);
		if (read instanceof Response) return read;
		const body = Challenge.safeParse(read.input);
		if (!body.success)
			return failed(
				"invalid",
				"send {} for a web passkey, { native: true } for a native passkey, or { invitation } to look at an invitation",
			);
		if ("invitation" in body.data) {
			const looked = await showInvitation(app, body.data.invitation, tools.address(req, server));
			if (looked.ok) return answered(looked.shown);
			return looked.why === "limited" ? tools.limited(looked.retryAfter) : failed("not_found", NO_INVITATION);
		}
		const begun = await passkeySignInOptions(app, tools.address(req, server), "native" in body.data ? "native" : "web");
		if (!begun)
			return "native" in body.data
				? failed("invalid", "native passkey sign-in needs an HTTPS public address and an associated app domain", {
						passkey: "native-unavailable",
					})
				: passkeysOff();
		if ("why" in begun) return tools.limited(begun.retryAfter);
		// The browser that asked is handed a cookie it cannot read, for as long as the challenge lasts. Only that
		// browser can answer: the challenge keeps the cookie's hash, and the answer is taken with the cookie.
		const headers = new Headers();
		for (const cookie of tools.ceremony.set(req, begun.ceremony, Math.ceil(begun.lastsMs / 1000)))
			headers.append("set-cookie", cookie);
		return tools.json({ ok: true, result: { passkey: begun.options } }, 200, headers);
	}

	/**
	 * `POST /api/login/oidc`: where to send the browser to sign in through the provider (`{}`), to accept an
	 * invitation that way (`{ invitation, replace? }`), or to link the provider to the person this browser is
	 * signed in as (`{ link: true }`). The reply sets the ceremony cookie, which the answer must come back with.
	 */
	async function oidc(req: Request, server: Listener): Promise<Response> {
		if (!tools.sameOrigin(req)) return failed("unauthenticated", NOT_SIGNED_IN);
		const read = await tools.read(req, CHALLENGE_BODY_LIMIT);
		if (read instanceof Response) return read;
		if (!app.config.oidc) return failed("invalid", OIDC_OFF);
		const body = OidcBegin.safeParse(read.input);
		if (!body.success)
			return failed("invalid", "send {} to sign in, { invitation } to accept an invitation, or { link: true }");
		let start: OidcStart;
		if ("link" in body.data) {
			const session = await tools.sessionFor(req, server);
			if (session instanceof Response) return session;
			const actor = await session.actor(0);
			const browser = tools.cookieOf(req);
			if (session.via !== "cookie" || !actor || browser === null)
				return failed("forbidden", "an identity is linked from a browser that is signed in, not with a token");
			start = { purpose: "link", actor: actor.id, browser };
		} else if ("invitation" in body.data)
			start = {
				purpose: "join",
				code: body.data.invitation,
				replace: body.data.replace ?? null,
				browser: tools.cookieOf(req),
			};
		else start = { purpose: "sign-in" };
		const begun = await beginOidcSignIn(app, start, tools.address(req, server));
		if (begun.ok) {
			const headers = new Headers();
			for (const cookie of tools.ceremony.set(req, begun.ceremony, Math.ceil(begun.lastsMs / 1000)))
				headers.append("set-cookie", cookie);
			return tools.json({ ok: true, result: { url: begun.url } }, 200, headers);
		}
		switch (begun.why) {
			case "limited":
				return tools.limited(begun.retryAfter);
			case "other-session":
				return failed(
					"conflict",
					`this browser is signed in as ${begun.signedInAs}, and the invitation is for somebody else. Send replace: "${begun.signedInAs}" to sign ${begun.signedInAs} out of this browser and accept it`,
					{ signedInAs: begun.signedInAs },
				);
			case "unreachable":
				return failed("conflict", "the identity provider did not answer; try again in a moment");
			case "not-a-person":
				return failed("forbidden", "only a person links an identity");
			default:
				return failed("not_found", NO_INVITATION);
		}
	}

	const CHANGE_REFUSED: Record<
		Exclude<Extract<PasswordChange, { ok: false }>["why"], "limited">,
		[ErrorCode, string]
	> = {
		"not-signed-in": ["unauthenticated", "sign in again; the session ended before the password was changed"],
		"not-a-person": ["forbidden", "only a person has a password"],
		"current-required": ["invalid", "current: the current password is required to change it"],
		"wrong-current": ["forbidden", "the current password is not right; nothing was changed"],
		"changed-meanwhile": ["conflict", "the password was changed meanwhile, from another session; nothing was changed"],
		busy: ["conflict", "the server is busy checking passwords; nothing was changed, try again in a moment"],
		"recent-proof": ["recent_proof_required", RECENT_PROOF_MESSAGE],
	};

	/**
	 * `POST /api/account/password`: `{ current?, next }`. For a browser that is signed in, and not for a token: a
	 * token in a script should not be able to give its person a password of its choosing, and with it a way in
	 * that outlives the token.
	 */
	async function password(req: Request, server: Listener): Promise<Response> {
		const session = await tools.sessionFor(req, server);
		if (session instanceof Response) return session;
		const sessionId = session.id;
		if (session.via !== "cookie" || !sessionId)
			return failed("forbidden", "a password is set from a browser that is signed in, not with a token");
		const read = await tools.read(req, PASSWORD_BODY_LIMIT);
		if (read instanceof Response) return read;
		const body = NewPassword.safeParse(read.input);
		if (!body.success) return failed("invalid", "send { current, next }: the current password and the new one");
		const why = whyNotPassword(body.data.next);
		if (why) return failed("invalid", `next: ${why}`);
		const changed = await changePassword(app, {
			who: async (db) => {
				const reference = session.reference?.();
				return db && reference ? ((await resolveCaller(app, db, reference, 0))?.actor ?? null) : await session.actor(0);
			},
			session: async (db) => {
				const reference = session.reference?.();
				return reference ? ((await resolveCaller(app, db, reference, 0))?.session ?? null) : await sessionId();
			},
			context: async (db) => {
				const reference = session.reference?.();
				return reference
					? ((await resolveCaller(app, db, reference, 0))?.context ?? null)
					: ((await session.context?.()) ?? null);
			},
			current: body.data.current,
			next: body.data.next,
			address: tools.address(req, server),
		});
		if (changed.ok) return answered({ changed: true, sessionsEnded: changed.sessionsEnded });
		if (changed.why === "limited") return tools.limited(changed.retryAfter);
		if (changed.why === "wrong-current") console.warn("[mainworthy] password change refused: wrong-password");
		const [code, message] = CHANGE_REFUSED[changed.why];
		return failed(code, message);
	}

	async function recentProof(req: Request, server: Listener): Promise<Response> {
		const session = await tools.sessionFor(req, server);
		if (session instanceof Response) return session;
		if (session.via !== "cookie") return failed("forbidden", "confirm a credential from a session that is signed in");
		const read = await tools.read(req, SIGN_IN_BODY_LIMIT);
		if (read instanceof Response) return read;
		const body = RecentProof.safeParse(read.input);
		if (!body.success) return failed("invalid", "send one password, passkey assertion or authenticator code");
		const actor = await session.actor(0);
		const context = (await session.context?.()) ?? null;
		if (!actor || context === null) return failed("unauthenticated", "sign in again; this session ended");
		if (actor.kind !== "human") return failed("forbidden", "only a person confirms a sign-in credential");
		const input = { actor: actor.id, context };
		if ("begin" in body.data) {
			const passkey = await app.database.read(async (db) => await beginCredentialProof(app, db, input));
			return answered({ passkey });
		}
		const result = await proveCredential(app, { ...input, proof: body.data, address: tools.address(req, server) });
		if (result.ok) return answered({ proved: true });
		if (result.why === "limited") return tools.limited(result.retryAfter);
		return failed("forbidden", "that credential proof was not accepted; nothing was changed");
	}

	async function nativeOidc(req: Request, server: Listener): Promise<Response> {
		if (!app.config.oidc) return failed("invalid", OIDC_OFF);
		if (!tools.sameOrigin(req)) return failed("unauthenticated", NOT_SIGNED_IN);
		const read = await tools.read(req, CHALLENGE_BODY_LIMIT);
		if (read instanceof Response) return read;
		const parsed = NativeRequest.safeParse(read.input);
		if (!parsed.success) return failed("invalid", "send the native sign-in challenge, state, callback and instance");
		const url = await beginNativeOidc(app, parsed.data, tools.address(req, server));
		if (url !== null && typeof url !== "string") return tools.limited(url.retryAfter);
		return url
			? answered({ url })
			: failed("invalid", "provider sign-in could not start; use this instance's public address and try again");
	}
	async function nativeCallback(req: Request, server: Listener): Promise<Response> {
		if (!app.config.oidc) return failed("invalid", OIDC_OFF);
		const query = new URL(req.url).search;
		if (query.length > 4096) return refused("input");
		const back = await finishNativeOidc(app, query, tools.address(req, server));
		if (back && typeof back !== "string") return tools.limited(back.retryAfter);
		return back
			? new Response(null, {
					status: 302,
					headers: { location: back, "cache-control": "no-store", "referrer-policy": "no-referrer" },
				})
			: refused("provider");
	}

	async function knownRefusal(work: () => Promise<Response>): Promise<Response> {
		try {
			return await work();
		} catch (error) {
			if (error instanceof OpError) return failed(error.code, error.message, error.details);
			throw error;
		}
	}

	return {
		signIn,
		routes: {
			"/api/login/methods": { GET: () => answered(signInMethods(app)) },
			"/api/login/challenge": { POST: async (req: Request, server: Listener) => await challenge(req, server) },
			"/api/login/oidc/native": { POST: (req: Request, server: Listener) => nativeOidc(req, server) },
			"/api/login/oidc/native/callback": {
				GET: async (req: Request, server: Listener) => await nativeCallback(req, server),
			},
			"/api/login/oidc": {
				POST: (req: Request, server: Listener) => knownRefusal(async () => await oidc(req, server)),
			},
			"/api/account/password": { POST: async (req: Request, server: Listener) => await password(req, server) },
			"/api/account/proof": {
				POST: (req: Request, server: Listener) => knownRefusal(async () => await recentProof(req, server)),
			},
		},
	};
}
