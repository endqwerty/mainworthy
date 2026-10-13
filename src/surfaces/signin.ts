// The sign-in routes for people: a name and a password, a passkey, an invitation, and setting a password. They
// are exchanges of the HTTP surface and not operations (decision 0017, 4): nobody is signed in yet, a password
// is checked outside the write gate, and a password must never reach the registry, which keeps a digest of
// each request that carries a command id.
//
// `http.ts` owns the request: where it came from, its body, the cookie. It hands those in as `Tools`, so this
// file reads no header the other file reads differently. Who somebody is, is decided in the identity module;
// this file turns a body into a question for it and an answer into a reply.
//
// A refused sign-in is answered one way, whatever was wrong: 401 and one sentence. Why goes to the log as a
// code, with no name and nothing the caller typed, since a name field is where a password is typed by mistake.
import { z } from "zod";
import { type ErrorCode, HTTP_STATUS } from "../core/api.ts";
import { whyNotPassword } from "../core/people.ts";
import {
	type Accepted,
	acceptInvitation,
	changePassword,
	PASSKEYS_OFF,
	type PasswordChange,
	passkeySignInOptions,
	publicAddress,
	type Session,
	type SignedIn,
	showInvitation,
	signInMethods,
	signInWithPasskey,
	signInWithPassword,
	type WhyNot,
} from "../server/identity/identity.ts";
import type { App } from "../server/kernel/app.ts";

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
	/** The session of a request, or the reply that refuses it. */
	sessionFor: (req: Request, server: Listener) => Session | Response;
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
const WithPassword = z.strictObject({ name: z.string().min(1).max(64), password: z.string().min(1).max(512) });
const WithPasskey = z.strictObject({ passkey: z.record(z.string(), z.unknown()) });
const WithInvitation = z.strictObject({
	invitation: z.string().min(1).max(128),
	password: z.string().max(4096).optional(),
	passkey: z.record(z.string(), z.unknown()).optional(),
	label: z.string().trim().min(1).max(60).optional(),
	replace: z.boolean().optional(),
});
const Challenge = z.union([z.strictObject({}), z.strictObject({ invitation: z.string().min(1).max(128) })]);
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
		const about = {
			userAgent: req.headers.get("user-agent"),
			address: tools.address(req, server),
			// Once the proof is good the caller is vouched for, as a request with a session is: the session is
			// written at the gate, and the wait there may outlast the idle timeout.
			proven: () => server.timeout(req, 0),
		};
		const withPassword = WithPassword.safeParse(input);
		const withPasskey = WithPasskey.safeParse(input);
		const withInvitation = WithInvitation.safeParse(input);
		let entry: Accepted;
		if (withPassword.success) entry = await signInWithPassword(app, withPassword.data, about);
		else if (withPasskey.success) {
			if (!publicAddress(app.config)) return passkeysOff();
			entry = await signInWithPasskey(app, withPasskey.data.passkey, about);
		} else if (withInvitation.success) {
			const { invitation, password, passkey, label, replace } = withInvitation.data;
			// What is wrong with the request itself is said before the invitation is looked at, so it says nothing
			// about the invitation.
			if (password === undefined && passkey === undefined)
				return failed("invalid", "accepting an invitation needs a password, a passkey or both");
			const why = password === undefined ? null : whyNotPassword(password);
			if (why) return failed("invalid", why);
			if (passkey !== undefined && !publicAddress(app.config)) return passkeysOff();
			entry = await acceptInvitation(
				app,
				{ code: invitation, password, passkey, label, replace: replace ?? false, browser: tools.cookieOf(req) },
				about,
			);
		} else return refused("input");
		if (entry.ok) return tools.json({ ok: true, result: { signedIn: true } }, 200, tools.cookies(req, entry.signedIn));
		// Too many failed attempts from this address, or at this name: the wait, and nothing about which.
		if (entry.why === "limited") return tools.limited(entry.retryAfter);
		if (entry.why === "other-session") {
			return failed(
				"conflict",
				`this browser is signed in as ${entry.signedInAs}, and the invitation is for somebody else. Send replace: true to sign ${entry.signedInAs} out of this browser and accept it`,
				{ signedInAs: entry.signedInAs },
			);
		}
		return refused(entry.why, entry.credential);
	}

	/**
	 * `POST /api/login/challenge`. `{}`: the options for signing in with a passkey. `{ invitation }`: who the
	 * invitation is for, and the options for registering a passkey with it. It writes nothing, so a page that
	 * is reloaded, or a preview that fetches it, changes nothing.
	 */
	async function challenge(req: Request, server: Listener): Promise<Response> {
		if (!tools.sameOrigin(req)) return failed("unauthenticated", NOT_SIGNED_IN);
		const read = await tools.read(req, CHALLENGE_BODY_LIMIT);
		if (read instanceof Response) return read;
		const body = Challenge.safeParse(read.input);
		if (!body.success)
			return failed("invalid", "send {} to sign in with a passkey, or { invitation } to look at an invitation");
		if ("invitation" in body.data) {
			const looked = showInvitation(app, body.data.invitation, tools.address(req, server));
			if (looked.ok) return answered(looked.shown);
			return looked.why === "limited" ? tools.limited(looked.retryAfter) : failed("not_found", NO_INVITATION);
		}
		const options = passkeySignInOptions(app);
		return options ? answered({ passkey: options }) : passkeysOff();
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
	};

	/**
	 * `POST /api/account/password`: `{ current?, next }`. For a browser that is signed in, and not for a token: a
	 * token in a script should not be able to give its person a password of its choosing, and with it a way in
	 * that outlives the token.
	 */
	async function password(req: Request, server: Listener): Promise<Response> {
		const session = tools.sessionFor(req, server);
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
			who: () => session.actor(0),
			session: sessionId,
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

	return {
		signIn,
		routes: {
			"/api/login/methods": { GET: () => answered(signInMethods(app)) },
			"/api/login/challenge": { POST: (req: Request, server: Listener) => challenge(req, server) },
			"/api/account/password": { POST: (req: Request, server: Listener) => password(req, server) },
		},
	};
}
