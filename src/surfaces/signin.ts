// The sign-in routes for people: the identity provider, and an invitation's page. They are exchanges of the HTTP
// surface and not operations (decision 0017, 4): nobody is signed in yet, the provider's answer comes back to a
// page and is judged outside the write gate, and an invitation's code must never reach the registry, which keeps
// a digest of each request that carries a command id. A token's sign-in is `http.ts`'s.
//
// `http.ts` owns the request: where it came from, its body, the cookie. It hands those in as `Tools`, so this
// file reads no header the other file reads differently. Who somebody is, is decided in the identity module;
// this file turns a body into a question for it and an answer into a reply.
//
// A provider's answer or an invitation code that is looked at and refused is answered one way, whatever was
// wrong: 401 and one sentence. Why goes to the log as a code. The other replies say nothing of a proof: 429 while
// the caller is limited, 400 for a request that is wrong in itself, 409 for a browser signed in as somebody else,
// and 408 for a body that took too long to arrive.
import { z } from "zod";
import { type ErrorCode, HTTP_STATUS } from "../core/api.ts";
import {
	type Accepted,
	beginOidcSignIn,
	finishOidcSignIn,
	OIDC_OFF,
	type OidcStart,
	type Session,
	type SignedIn,
	showInvitation,
	signInMethods,
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
	 * The ceremony cookie, which ties a provider's answer to the browser that began: its value on
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

/** The query the identity provider sent the browser back to `/signin/oidc` with, as the page found it. */
const WithOidc = z.strictObject({ oidc: z.string().min(1).max(4096) });
const LookAtInvitation = z.strictObject({ invitation: z.string().min(1).max(128) });
/**
 * What the page begins with the provider: a sign-in, an invitation's acceptance, linking a signed-in person, or
 * proving it is them before a sign-in change. `replace` is who the page asked about before it went on: the name
 * of the person the browser was signed in as. A yes that names nobody could end the session of somebody the page
 * never asked about, so it is not taken.
 */
const OidcBegin = z.union([
	z.strictObject({}),
	z.strictObject({ invitation: z.string().min(1).max(128), replace: z.string().min(1).max(64).optional() }),
	z.strictObject({ link: z.literal(true) }),
	z.strictObject({ proof: z.literal(true) }),
]);

/** The largest body of each route. The provider's query is the longest thing a browser sends. */
export const SIGN_IN_BODY_LIMIT = 8 * 1024;
const CHALLENGE_BODY_LIMIT = 1024;

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

	/**
	 * `POST /api/login` for a body that is not a token: `{ oidc }`, the query the provider sent the browser back
	 * with. `http.ts` has checked where the request comes from and read its body.
	 */
	async function signIn(req: Request, server: Listener, input: unknown): Promise<Response> {
		const reply = await knownRefusal(async () => await answerSignIn(req, server, input));
		// An answer from the provider ends its ceremony whatever came of it: the cookie that tied it to this browser
		// is cleared with the reply, accepted, refused or told to wait.
		if (WithOidc.safeParse(input).success)
			for (const cookie of tools.ceremony.clear(req)) reply.headers.append("set-cookie", cookie);
		return reply;
	}

	async function answerSignIn(req: Request, server: Listener, input: unknown): Promise<Response> {
		const about = {
			userAgent: req.headers.get("user-agent"),
			address: tools.address(req, server),
			// Once the proof is good the caller is vouched for, as a request with a session is: the session is
			// written at the gate, and the wait there may outlast the idle timeout.
			proven: () => server.timeout(req, 0),
		};
		const withOidc = WithOidc.safeParse(input);
		if (!withOidc.success) return refused("input");
		if (!app.config.oidc) return failed("invalid", OIDC_OFF);
		const finished = await finishOidcSignIn(
			app,
			{ query: withOidc.data.oidc, ceremony: tools.ceremony.of(req), browser: tools.cookieOf(req) },
			about,
		);
		if (finished.ok && "linked" in finished) return answered({ linked: true });
		if (finished.ok && "proven" in finished) return answered({ proven: true });
		if (!finished.ok && finished.why === "linked-already")
			return failed(
				"conflict",
				"this identity is linked already, to you or to somebody else on this instance; nothing was changed",
			);
		const entry: Accepted = finished;
		if (entry.ok) return tools.json({ ok: true, result: { signedIn: true } }, 200, tools.cookies(req, entry.signedIn));
		// Too many failed attempts from this address: the wait, and nothing about why.
		if (entry.why === "limited") return tools.limited(entry.retryAfter);
		if (entry.why === "other-session") {
			return failed(
				"conflict",
				`this browser is signed in as ${entry.signedInAs}, and the invitation is for somebody else. Begin again with replace: "${entry.signedInAs}" to sign ${entry.signedInAs} out of this browser and accept it`,
				{ signedInAs: entry.signedInAs },
			);
		}
		if (entry.why === "other-identity")
			return failed(
				"forbidden",
				"the identity provider signed in somebody other than you; sign in there as yourself and confirm again",
			);
		if (entry.why === "stale")
			return failed(
				"forbidden",
				"the identity provider did not ask you to sign in again; confirm again, signing in at the provider",
			);
		return refused(entry.why, entry.credential);
	}

	/**
	 * `POST /api/login/invitation`, `{ invitation }`: who the invitation is for, what accepting it does and when it
	 * runs out. Looking never spends it.
	 */
	async function invitation(req: Request, server: Listener): Promise<Response> {
		if (!tools.sameOrigin(req)) return failed("unauthenticated", NOT_SIGNED_IN);
		const read = await tools.read(req, CHALLENGE_BODY_LIMIT);
		if (read instanceof Response) return read;
		const body = LookAtInvitation.safeParse(read.input);
		if (!body.success) return failed("invalid", "send { invitation } with the code after the # of the link");
		const looked = await showInvitation(app, body.data.invitation, tools.address(req, server));
		if (looked.ok) return answered(looked.shown);
		return looked.why === "limited" ? tools.limited(looked.retryAfter) : failed("not_found", NO_INVITATION);
	}

	/**
	 * `POST /api/login/oidc`: where to send the browser to sign in through the provider (`{}`), to accept an
	 * invitation that way (`{ invitation, replace? }`), to link the provider to the person this browser is signed
	 * in as (`{ link: true }`), or for that person to prove it is them (`{ proof: true }`). The reply sets the
	 * ceremony cookie, which the answer must come back with.
	 */
	async function oidc(req: Request, server: Listener): Promise<Response> {
		if (!tools.sameOrigin(req)) return failed("unauthenticated", NOT_SIGNED_IN);
		const read = await tools.read(req, CHALLENGE_BODY_LIMIT);
		if (read instanceof Response) return read;
		if (!app.config.oidc) return failed("invalid", OIDC_OFF);
		const body = OidcBegin.safeParse(read.input);
		if (!body.success)
			return failed(
				"invalid",
				"send {} to sign in, { invitation } to accept an invitation, { link: true } or { proof: true }",
			);
		let start: OidcStart;
		if ("link" in body.data || "proof" in body.data) {
			const purpose = "link" in body.data ? "link" : "proof";
			const session = await tools.sessionFor(req, server);
			if (session instanceof Response) return session;
			const actor = await session.actor(0);
			const browser = tools.cookieOf(req);
			if (session.via !== "cookie" || !actor || browser === null)
				return failed(
					"forbidden",
					`an identity is ${purpose === "link" ? "linked" : "confirmed"} from a browser that is signed in, not with a token`,
				);
			start = { purpose, actor: actor.id, browser };
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
				return failed(
					"forbidden",
					"only a person with a linked identity confirms through the provider; a session opened with a token proves by signing in with the token again",
				);
			default:
				return failed("not_found", NO_INVITATION);
		}
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
			"/api/login/invitation": { POST: async (req: Request, server: Listener) => await invitation(req, server) },
			"/api/login/oidc": {
				POST: (req: Request, server: Listener) => knownRefusal(async () => await oidc(req, server)),
			},
		},
	};
}
