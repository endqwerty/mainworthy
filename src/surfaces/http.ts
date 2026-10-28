// The HTTP surface. It has no logic of its own: every route is the registry's `invoke` behind authentication, plus
// the session, the change stream and the generated API description. Nothing here knows what an operation does.
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ERROR_CODES, HTTP_STATUS } from "../core/api.ts";
import { API_VERSION, API_VERSION_HEADER, AT_HEADER, VERSION } from "../core/version.ts";
import {
	admit,
	callerProjectCapabilities,
	credentialSummary,
	type Facts,
	resolveCaller,
	type Session,
	type SignedIn,
	signInWithToken,
	signOut,
	TOKEN_MAX,
} from "../server/identity/identity.ts";
import { headerAddress } from "../server/kernel/address.ts";
import type { App, Config } from "../server/kernel/app.ts";
import { type Actor, allProjects, findProject } from "../server/kernel/ctx.ts";
import { isBusy } from "../server/kernel/db.ts";
import { INTERNAL_ERROR, noProject } from "../server/kernel/errors.ts";
import { authenticateJob } from "../server/kernel/job-auth.ts";
import { listProjects } from "../server/ops/admin.ts";
import { OP_LIST, OPS } from "../server/ops/index.ts";
import { invoke, invokeService, READ_ATTEMPTS, type Reply } from "../server/ops/registry.ts";
import { trackerForCaller } from "../server/ops/trackers.ts";
import { changeStream } from "./events.ts";
import { forwardedScheme } from "./headers.ts";
import { SIGN_IN_BODY_LIMIT, signInRoutes } from "./signin.ts";
import { type Relay, uiSurface } from "./ui.ts";
import { keepingPolicyOnEvery, withHeaders, withHeadersOnEvery } from "./with-headers.ts";

export { VERSION } from "../core/version.ts";

function incompatibleRequest(req: Request): Response | null {
	const version = req.headers.get(API_VERSION_HEADER);
	// Browser POSTs carry Origin, including on plain HTTP where fetch metadata may be absent. Clients that
	// are not browsers (the command line, scripts) send neither. Old bundles cannot opt out of these browser-controlled headers.
	const browser = req.headers.has("origin") || req.headers.has("sec-fetch-site");
	const required = browser && req.method !== "GET" && req.method !== "HEAD" && sameOrigin(req);
	return (version !== null || required) && version !== String(API_VERSION)
		? jsonResponse(
				{
					ok: false,
					error: {
						code: "conflict",
						message: browser
							? "This page needs an update. Reload before trying again."
							: `incompatible API version; server requires API ${API_VERSION}`,
					},
				},
				HTTP_STATUS.conflict,
			)
		: null;
}

/**
 * A JSON reply. `extra` may be a `Headers` object, which is how a reply carries more than one `Set-Cookie`: each
 * is a header of its own, and a record has room for one.
 */
const jsonResponse = (body: unknown, status = 200, extra: Headers | Record<string, string> = {}): Response =>
	jsonText(JSON.stringify(body), status, extra);

/** A JSON reply whose text is already serialized, such as a document built once per process. */
const jsonText = (text: string, status = 200, extra: Headers | Record<string, string> = {}): Response => {
	const headers = new Headers(extra);
	if (!headers.has("content-type")) headers.set("content-type", "application/json; charset=utf-8");
	if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
	return new Response(text, { status, headers });
};

const replyResponse = (reply: Reply): Response => jsonResponse(reply, reply.ok ? 200 : HTTP_STATUS[reply.error.code]);

/**
 * The scheme the browser used, as a URL's `protocol` writes it (`https:`). Behind a proxy that ends TLS it is
 * the one the proxy reports in `X-Forwarded-Proto`, read by `forwardedScheme`: the first of a list, since each
 * further proxy appends its own, and in lower case.
 */
function schemeOf(req: Request): string {
	const forwarded = forwardedScheme(req.headers.get("x-forwarded-proto"));
	return forwarded ? `${forwarded}:` : new URL(req.url).protocol;
}

/**
 * A request a browser makes must come from this server's own page.
 *
 * Where the browser says which site made the request (`Sec-Fetch-Site`; every current browser does, on a GET
 * too), it must be this one, or nobody's (`none`: the address bar, a bookmark). That is what stops a GET from
 * another site's page, which carries no Origin. Where an Origin is sent, it must be this server: the same scheme
 * and the same host; an unparseable one is not. A proxy that ends TLS and does not report the scheme makes an
 * https page look like another site, and is refused. A request with neither header (a script, the CLI) passes.
 */
function sameOrigin(req: Request): boolean {
	const site = req.headers.get("sec-fetch-site");
	if (site !== null && site !== "same-origin" && site !== "none") return false;
	const origin = req.headers.get("origin");
	if (origin === null) return true;
	try {
		const from = new URL(origin);
		return from.protocol === schemeOf(req) && from.host === req.headers.get("host");
	} catch {
		return false;
	}
}

/**
 * The names of this server's two cookies, as they are over plain http. Over https each carries the `__Host-`
 * prefix, which a browser accepts only with `Secure`, `Path=/` and no `Domain`: no other host of the site, and
 * no page reached over plain http, can then set or replace it. A browser refuses that prefix from plain http,
 * where an instance on a private network or a published port is still reached, so there a cookie has the bare
 * name. Everything below that names, reads, sets or expires a cookie goes by this one rule (`cookieName`,
 * `cookieOf`, `cookieHeaders`).
 */
const SESSION_COOKIE = "mainworthy_sid";
/**
 * What ties the identity provider's answer to the browser that began the ceremony. Nobody may be signed in then,
 * so the reply that begins it sets this cookie, and the answer is taken only with it (`signin.ts`).
 */
const CEREMONY_COOKIE = "mainworthy_ceremony";
/**
 * The cookie of the builds before sessions. Its value was the token itself. It signs nobody in, and a sign-in
 * and a sign-out expire it, so the token does not stay in a browser for the year that cookie was given.
 */
const FORMER_COOKIE = "mainworthy_session";
const COOKIE_ATTRIBUTES = "Path=/; HttpOnly; SameSite=Strict";
/** What a cookie's value looks like: 32 bytes in base64url. Anything else is not one of ours. */
const COOKIE_VALUE = /^[A-Za-z0-9_-]{43}$/;

const isHttps = (req: Request): boolean => schemeOf(req) === "https:";
/** The name a cookie has on the scheme of this request. */
const cookieName = (req: Request, plain: string): string => (isHttps(req) ? `__Host-${plain}` : plain);
const expiredCookie = (req: Request, name: string): string =>
	`${name}=; ${COOKIE_ATTRIBUTES}; Max-Age=0${isHttps(req) ? "; Secure" : ""}`;

/**
 * The value of the cookie a request carries under the name its scheme selects, or null. Null too when the
 * request carries two cookies of that name: a browser sends two when something planted a second one beside
 * the real one, and nothing says which is which. A value that does not look like one of ours is not looked up.
 */
function cookieOf(req: Request, plain: string): string | null {
	const name = cookieName(req, plain);
	const values: string[] = [];
	for (const part of (req.headers.get("cookie") ?? "").split(";")) {
		const at = part.indexOf("=");
		if (at !== -1 && part.slice(0, at).trim() === name) values.push(part.slice(at + 1).trim());
	}
	const [value, ...others] = values;
	return value !== undefined && others.length === 0 && COOKIE_VALUE.test(value) ? value : null;
}

/**
 * The `Set-Cookie` values that give a browser one of this server's cookies (`set`: its value, and the seconds
 * it lasts) or take it away (null), one for each header.
 *
 * The scheme the browser used decides the cookie's name and whether it says `Secure`, here and wherever the
 * cookie is read (`schemeOf`). Over https the cookie's other name is expired too: it is left over when an
 * instance moves between http and https. Over plain http the `__Host-` name cannot be expired, because a
 * browser refuses that prefix there; what ends a session or a ceremony is the server's own record, not the
 * browser's jar.
 */
function cookieHeaders(req: Request, plain: string, set: { value: string; seconds: number } | null): string[] {
	const name = cookieName(req, plain);
	const given = set
		? `${name}=${set.value}; ${COOKIE_ATTRIBUTES}; Max-Age=${set.seconds}${isHttps(req) ? "; Secure" : ""}`
		: expiredCookie(req, name);
	return isHttps(req) ? [given, expiredCookie(req, plain)] : [given];
}

const sessionCookieOf = (req: Request): string | null => cookieOf(req, SESSION_COOKIE);

/**
 * The `Set-Cookie` headers of a sign-in (`signedIn`) or of a sign-out (null), one header for each cookie: the
 * session cookie (`cookieHeaders`), and the former cookie, which every sign-in and sign-out expires.
 */
function sessionCookies(app: App, req: Request, signedIn: SignedIn | null): Headers {
	const headers = new Headers();
	const set = signedIn ? { value: signedIn.cookie, seconds: Math.ceil((signedIn.expiresAt - app.now()) / 1000) } : null;
	for (const cookie of cookieHeaders(req, SESSION_COOKIE, set)) headers.append("set-cookie", cookie);
	headers.append("set-cookie", expiredCookie(req, FORMER_COOKIE));
	return headers;
}

const isLoopbackHost = (host: string | null): boolean => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host ?? "");
/** 127.0.0.0/8 and ::1, also as an IPv4 address written the IPv6 way. An unknown address is not one. */
const isLoopbackAddress = (address: string | null): boolean =>
	/^(::1|(::ffff:)?127(\.\d{1,3}){3})$/i.test(address ?? "");
/** What a proxy or a tunnel adds to a request it passes on. One of them means the request did not start here. */
const FORWARDER_HEADERS = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-real-ip", "via", "cf-connecting-ip"];

/**
 * Whether a request started on this machine, as far as the server can see, which is all that local mode has in
 * place of a sign-in. The Host alone does not say: a proxy that does not keep the client's Host, or a forwarded
 * port, presents a loopback Host for a visitor from anywhere. So the connection itself must come from a loopback
 * address, and the request must carry no header a forwarder adds (a proxy on this machine connects from loopback
 * too). What this cannot see is a relay on this machine that passes bytes on unchanged: its requests are
 * loopback connections with no added header. `docs/deploy.md` says never to expose a local-mode port that way.
 */
function isLocal(req: Request, peer: string | null): boolean {
	return (
		isLoopbackHost(req.headers.get("host")) &&
		isLoopbackAddress(peer) &&
		!FORWARDER_HEADERS.some((header) => req.headers.has(header))
	);
}

/** What the listener knows of the connection a request arrived on, and may do to it. */
type Listener = Pick<ReturnType<typeof Bun.serve>, "requestIP" | "timeout">;

/**
 * The address a request came from, given the address its connection came from (`peer`), or null when nothing
 * says. It is what failed sign-ins are counted against.
 *
 * A peer is its own address, and whatever its headers say about where it came from is ignored: anybody can
 * write a header. The exception is a proxy the operator named (`config.proxy`), proved by its connecting address
 * or by the secret checked before any handler runs. Its own address tells no two visitors apart, so it is read from
 * the header the operator named instead. That header must hold exactly one address. When it is missing or holds
 * anything else, the proxy is not sending what the operator said it sends: the request then has no address, and
 * is not counted under the proxy's, which would be every visitor's.
 */
function addressOf(req: Request, peer: string | null, config: Config): string | null {
	const { proxy } = config;
	return proxy && (proxy.by === "secret" || proxy.peers.contains(peer))
		? headerAddress(req.headers.get(proxy.header))
		: peer;
}

/** The address a request came from (`addressOf`), with the connection's own address asked of the listener. */
export function clientAddress(req: Request, server: Pick<Listener, "requestIP">, config: Config): string | null {
	return addressOf(req, server.requestIP(req)?.address ?? null, config);
}

/**
 * What a request carries that says who it is, for `admit` to judge: a bearer token, the session cookie, whether
 * it comes from this server's own page, whether it started on this machine, and the address it came from.
 *
 * Local mode trusts the loopback interface, so the request must really be local and same-origin: it started on
 * this machine (`isLocal`; the loopback Host also means a page on another site cannot reach us through DNS
 * rebinding) and it comes from this server's own page (`sameOrigin`: another site cannot act on the owner's
 * behalf). The same-origin rule protects the cookie in server mode.
 *
 * `peer` is the address the connection came from, as the listener knows it. A caller that does not know it
 * (a request that never was on a connection) is never the local owner. The address the request is counted and
 * recorded as coming from (`addressOf`) is another thing: behind a proxy the operator named it is the address
 * the proxy reported, and it never decides whether a request is local.
 */
function factsOf(app: App, req: Request, owner: Actor, peer: string | null): Facts {
	const header = req.headers.get("authorization");
	return {
		bearer: header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : null,
		cookie: sessionCookieOf(req),
		sameOrigin: sameOrigin(req),
		localOwner: isLocal(req, peer) ? owner : null,
		address: addressOf(req, peer, app.config),
	};
}

/**
 * Who is calling: a bearer token, else the session cookie, else (in local mode only) the owner of this machine.
 * Null for a caller that is refused and for one that is told to wait; a route answers each with its own reply
 * (`sessionFor`).
 */
export async function sessionOf(
	app: App,
	req: Request,
	owner: Actor,
	peer: string | null = null,
): Promise<Session | null> {
	const admission = await admit(app, factsOf(app, req, owner, peer));
	return admission.kind === "admitted" ? admission.session : null;
}

const unauthenticated = (): Response =>
	jsonResponse({ ok: false, error: { code: "unauthenticated", message: "a token is required" } }, 401);

/**
 * The reply to a caller that reached an authentication or allocation limit: 429, with the whole seconds to wait in
 * `Retry-After` and in the sentence, which is all the CLI shows. It does not say what was counted, the address
 * or the token: the wait is all the caller can act on.
 */
const limited = (seconds: number): Response =>
	jsonResponse(
		{
			ok: false,
			error: {
				code: "limited",
				message: `too many attempts; try again in ${seconds} ${seconds === 1 ? "second" : "seconds"}`,
			},
		},
		HTTP_STATUS.limited,
		{ "retry-after": String(seconds) },
	);

/**
 * A page may say who it believes it is signed in as (`X-Mainworthy-As`, the actor's id in canonical decimal). When
 * the session has become somebody else's since the page was loaded (another tab signed in), the request is
 * refused here, in the request that would have written: text one person typed is never recorded under another
 * person's name, and a page never shows one person's view as another's. A caller that sends no header (a script,
 * the CLI, an agent) is whoever its token says.
 */
export const AS_HEADER = "x-mainworthy-as";
async function sameCaller(req: Request, session: Session): Promise<boolean> {
	const expected = req.headers.get(AS_HEADER);
	if (expected === null) return true;
	const actor = await session.actor(0);
	return actor !== null && String(actor.id) === expected;
}
const changedSession = (): Response =>
	jsonResponse(
		{
			ok: false,
			error: { code: "unauthenticated", message: "the session now belongs to another person; sign in again" },
		},
		401,
	);

/**
 * A write to a demo project may say when it happened (`AT_HEADER`). The registry decides whether the call may
 * carry one; here it is only read, and one that is not a number is refused instead of dropped.
 */
function timeOf(req: Request): number | null | undefined {
	const text = req.headers.get(AT_HEADER);
	if (text === null) return undefined;
	return /^\d{1,16}$/.test(text) ? Number(text) : null;
}

/** The largest body an operation accepts. A 100,000-result report is about 30 MB. */
export const OP_BODY_LIMIT = 64 * 1024 * 1024;
/**
 * The server-wide ceiling. It is sized for the one route that streams (the archive import, which never holds the
 * body in memory); every other route reads its body through `readJson`, which enforces its own much smaller limit.
 */
export const STREAM_BODY_LIMIT = 8 * 1024 ** 3;

/**
 * How long a client may keep the server waiting. Parameters, so a test can use a second where a server uses
 * three minutes.
 */
export type Patience = {
	/**
	 * Seconds a connection nobody has vouched for may send and receive nothing before the server closes it: one
	 * that stops in the middle of a body, one kept open after a reply that needed no session or refused one. A
	 * request that is given a session has this taken off its connection (`sessionFor`). Bun counts in steps of four
	 * seconds, so a connection is closed up to four seconds later than this. (One that never finishes its
	 * request's headers is closed by Bun itself after about ten seconds, whatever this says.)
	 */
	idleSeconds: number;
	/** Milliseconds the whole body of a sign-in may take to arrive. It is a token: one packet. */
	signInBodyMs: number;
	/** Milliseconds requests in flight have to send their replies after the listener stops accepting. */
	shutdownMs: number;
};
/**
 * Three minutes of silence, not half a minute: a proxy in front keeps idle connections to this server and reuses
 * them, and one that this server closed first can lose the request the proxy was just sending on it. By default
 * Traefik and Cloudflare's tunnel give up an idle connection after 90 seconds, nginx after 60 and Caddy after two
 * minutes, so the proxy closes first.
 */
export const PATIENCE: Patience = { idleSeconds: 180, signInBodyMs: 5000, shutdownMs: 5000 };

class BodyTooLarge extends Error {}
class BodyTooSlow extends Error {}

/**
 * Reads a JSON body of at most `limit` bytes. The length is checked while reading, not only from the header, so a
 * client cannot make the server hold more than the limit by omitting or understating Content-Length. With
 * `withinMs`, the whole body must have arrived by then: a limit on the time, where the idle timeout only limits
 * the silence between two bytes.
 */
async function readJson(req: Request, limit = OP_BODY_LIMIT, withinMs?: number): Promise<unknown> {
	if (Number(req.headers.get("content-length") ?? 0) > limit) throw new BodyTooLarge();
	const reader = req.body?.getReader();
	if (!reader) return {};
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late =
		withinMs === undefined
			? null
			: new Promise<"late">((resolve) => {
					timer = setTimeout(() => resolve("late"), withinMs);
				});
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const next = await (late !== null ? Promise.race([reader.read(), late]) : reader.read());
			if (next === "late") {
				void reader.cancel().catch(() => {});
				throw new BodyTooSlow();
			}
			if (next.done) break;
			size += next.value.byteLength;
			if (size > limit) {
				await reader.cancel();
				throw new BodyTooLarge();
			}
			chunks.push(next.value);
		}
	} finally {
		clearTimeout(timer);
	}
	const text = new TextDecoder().decode(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks));
	if (!text.trim()) return {};
	return JSON.parse(text) as unknown;
}

const tooLarge = (limit: number): Response =>
	jsonResponse(
		{
			ok: false,
			error: { code: "invalid", message: `the request body is larger than ${Math.round(limit / 1024 / 1024)} MB` },
		},
		413,
	);

/**
 * The session of a request, or the reply that refuses it: 401 for a caller that proved nothing, 429 for one that
 * failed too often and is told to wait (`limited`). Every route that takes a session takes it here, so every
 * one holds a request to the person it names (`sameCaller`), and every one is under the limit on failed
 * attempts: an operation, the change stream, and the routes of the other surfaces (`/mcp`, the archive).
 *
 * A request that is given a session has the idle timeout taken off its connection: the timeout is for a
 * connection nobody has vouched for. It counts the server's own silence too, so without this a reply that takes
 * longer than the timeout is lost: a write that waits at the gate behind a long report, a large report on a slow
 * machine, an archive being applied, a tool call. Measured on Bun 1.4.3: a request with no body whose handler
 * answered after the timeout had its connection closed and nothing sent; one with a body got its reply. The rule
 * does not rest on that difference.
 *
 * What remains is what was true before there was a timeout: a client with a session may keep an idle connection
 * open. (Bun keeps the timeout off while the connection stays idle after the reply; the next request on it is
 * under the timeout again until it is given a session in its turn.)
 */
async function sessionFor(app: App, owner: Actor, req: Request, server: Listener): Promise<Session | Response> {
	const incompatible = incompatibleRequest(req);
	if (incompatible) return incompatible;
	// The address the connection came from decides, in local mode, whether the request started on this machine,
	// and in every mode where the request is counted as coming from.
	const admission = await admit(app, factsOf(app, req, owner, server.requestIP(req)?.address ?? null), () =>
		server.timeout(req, 0),
	);
	if (admission.kind === "refused") return unauthenticated();
	if (admission.kind === "limited") return limited(admission.retryAfter);
	const { session } = admission;
	if (!(await sameCaller(req, session))) return changedSession();
	server.timeout(req, 0);
	return session;
}

/** One operation over HTTP: `POST /api/p/<project>/<op>` or `POST /api/<op>` with the input as the JSON body. */
export async function handleOp(
	app: App,
	owner: Actor,
	req: Request,
	server: Listener,
	project: string | null,
	op: string,
): Promise<Response> {
	const operation = OPS[op];
	if (operation?.effect === "service") {
		if (project !== null || !(await authenticateJob(req.headers.get("authorization"), app.config.jobCaller)))
			return unauthenticated();
		let input: unknown;
		try {
			input = await readJson(req);
		} catch {
			return jsonResponse({ ok: false, error: { code: "invalid", message: "the request body is not JSON" } }, 400);
		}
		server.timeout(req, 0);
		return replyResponse(await invokeService(app, operation, input));
	}
	const session = await sessionFor(app, owner, req, server);
	if (session instanceof Response) return session;
	const at = timeOf(req);
	if (at === null)
		return jsonResponse(
			{ ok: false, error: { code: "invalid", message: `${AT_HEADER} is a whole number of milliseconds since 1970` } },
			400,
		);
	let input: unknown;
	try {
		input = await readJson(req);
	} catch (error) {
		if (error instanceof BodyTooLarge) return tooLarge(OP_BODY_LIMIT);
		return jsonResponse({ ok: false, error: { code: "invalid", message: "the request body is not JSON" } }, 400);
	}
	return replyResponse(
		await invoke(app, OPS, {
			op,
			project,
			input,
			actor: session.actor,
			...(session.reference ? { reference: session.reference() } : {}),
			// Which of the caller's browser sessions this is, for an operation that lists or ends them.
			...(session.id ? { session: session.id } : {}),
			// Where the caller is signed in, for an operation that another request finishes (a link to the identity provider).
			...(session.context ? { context: session.context } : {}),
			...(at === undefined ? {} : { at }),
		}),
	);
}

/**
 * The projects a session holds a grant on, each with what the caller may do there. One it holds none on is not
 * named. A pipeline's project is named though it cannot read it: that is how it checks its own credential.
 * `handoff` says whether a failure there can be handed to an agent (`MAINWORTHY_HANDOFF_*`).
 */
export async function grantedProjects(app: App, session: Session) {
	for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
		const projects = await app.database.read(async (db) => {
			const rows = new Map((await allProjects(db)).map((row) => [row.key, row]));
			const reference = session.reference?.();
			const capabilities = reference
				? await callerProjectCapabilities(
						app,
						db,
						reference,
						[...rows.values()].map((row) => row.id),
					)
				: null;
			const granted = [];
			for (const project of await listProjects(db)) {
				const row = rows.get(project.key);
				if (!row) continue;
				const can = capabilities?.get(row.id) ?? (reference ? [] : ((await session.actor(row.id))?.can ?? []));
				if (can.length)
					granted.push({
						...project,
						fieldDefinitions: can.includes("read") ? project.fieldDefinitions : undefined,
						can,
						handoff: app.config.handoff?.project === project.key,
						tracker: trackerForCaller(app.config, project.key, can),
					});
			}
			return granted;
		});
		// A fresh scope checks identity and authority after the snapshot closes.
		const rechecked = await app.database.read(async (db) => {
			const rows = new Map((await allProjects(db)).map((row) => [row.key, row]));
			const reference = session.reference?.();
			const capabilities = reference
				? await callerProjectCapabilities(
						app,
						db,
						reference,
						[...rows.values()].map((row) => row.id),
					)
				: null;
			const granted = [];
			for (const project of projects) {
				const current = rows.get(project.key);
				if (!current) continue;
				if (current.identity !== project.identity) return null;
				const can = capabilities?.get(current.id) ?? (reference ? [] : ((await session.actor(current.id))?.can ?? []));
				if (can.length)
					granted.push({
						...project,
						can,
						fieldDefinitions: can.includes("read") ? project.fieldDefinitions : undefined,
					});
			}
			return granted;
		});
		if (rechecked !== null) return rechecked;
	}
	throw new Error("projects changed during all read attempts");
}

/** Who the caller is and which projects it may read. */
async function sessionInfo(app: App, session: Session): Promise<Response> {
	const actor = await session.actor(0);
	if (!actor) return unauthenticated();
	const body = {
		ok: true,
		result: {
			actor: actor.name,
			actorId: actor.id,
			kind: actor.kind,
			can: actor.can,
			mode: app.config.mode,
			via: session.via,
			// What a page needs to show a person their own sign-in: which session this is, and what they sign in with.
			session: (await session.id?.()) ?? null,
			credentials:
				actor.kind === "human"
					? await app.database.read(async (readDb) => await credentialSummary(readDb, actor.id))
					: null,
			// The owner is the person the configuration names, as `refuseToken` in `ops/admin.ts` takes it.
			owner: actor.kind === "human" && actor.name === app.config.owner,
			version: VERSION,
			projects: await grantedProjects(app, session),
		},
	};
	if (!(await session.actor(0))) return unauthenticated();
	return jsonResponse(body);
}

/**
 * Whether this session may read a project: the same rules an operation that needs `read` applies. A project the
 * caller holds no grant on is `missing`, like one that does not exist (see `execute` in the registry).
 */
async function mayRead(app: App, session: Session, key: string): Promise<"yes" | "no" | "missing" | "unauthenticated"> {
	const project = await app.database.read(async (readDb) => await findProject(readDb, key));
	const actor = await session.actor(project?.id ?? 0);
	if (!actor) return "unauthenticated";
	if (!project || actor.can.length === 0) return "missing";
	return actor.can.includes("read") ? "yes" : "no";
}

/**
 * Signs a browser in: a token goes in and a session cookie comes out. It is not an operation: nobody is signed in
 * yet, and the registry runs nothing for a caller it cannot name.
 */
async function login(
	app: App,
	req: Request,
	server: Listener,
	patience: Patience,
	/** Signs in with a body that is not a token: the identity provider's answer (`signin.ts`). */
	otherwise: (req: Request, server: Listener, input: unknown) => Promise<Response>,
): Promise<Response> {
	if (!sameOrigin(req)) return unauthenticated();
	const incompatible = incompatibleRequest(req);
	if (incompatible) return incompatible;
	// A sign-in body is a token and nothing else: a few kilobytes at most and one packet, read before anyone is
	// authenticated. So it is held to a size and to a time, and one that is still arriving after that is answered
	// and its connection closed.
	let input: unknown;
	try {
		input = await readJson(req, SIGN_IN_BODY_LIMIT, patience.signInBodyMs);
	} catch (error) {
		// A body that is too large or is not JSON is no way of signing in, and is answered as one that could be
		// read and is none: nothing was looked at that could say more.
		if (!(error instanceof BodyTooSlow)) return otherwise(req, server, undefined);
		return jsonResponse(
			{ ok: false, error: { code: "invalid", message: "the sign-in request took too long to arrive" } },
			408,
			{ connection: "close" },
		);
	}
	// A token is a string of at most `TOKEN_MAX` characters, and the schema says no more. The start holds the
	// owner's configured token to the same number (`bootstrap`), so no token that works is too long to sign in
	// with. How short the owner's may be is decided there too, not by what this route will look at.
	// A token and nothing beside it: any other body is a person signing in as themselves, or nothing at all.
	const body = z.strictObject({ token: z.string().max(TOKEN_MAX) }).safeParse(input);
	if (!body.success) return otherwise(req, server, input);
	// A token typed into the form is a token: it is counted as one sent in a header is, under the same keys.
	const opening = await signInWithToken(app, body.data.token, {
		userAgent: req.headers.get("user-agent"),
		address: clientAddress(req, server, app.config),
		proven: () => server.timeout(req, 0),
	});
	if (opening.kind === "refused") return unauthenticated();
	if (opening.kind === "limited") return limited(opening.retryAfter);
	// The token is good, so the caller is vouched for as any request with a session is (`sessionFor`): the
	// session is written at the gate, and the wait there may outlast the idle timeout.
	server.timeout(req, 0);
	const signedIn = await opening.signedIn;
	if (!signedIn) return unauthenticated();
	return jsonResponse({ ok: true, result: { signedIn: true } }, 200, sessionCookies(app, req, signedIn));
}

/**
 * Signs a browser out: ends the session its cookie names, then clears the cookie. The end is committed before
 * the reply leaves, so a copy of the cookie made earlier is refused from then on.
 *
 * It needs no session and is the same every time: with no cookie, an unknown one or one that has ended, there
 * is nothing to end, and the reply still clears. Only the cookie says which session ends. A bearer token on the
 * same request ends nothing: it is not a browser's session.
 */
async function logout(app: App, req: Request, server: Listener): Promise<Response> {
	if (!sameOrigin(req)) return unauthenticated();
	const cookie = sessionCookieOf(req);
	const ending = cookie === null ? null : await signOut(app, cookie);
	if (ending) {
		// A session that is open is being ended: its holder is vouched for while the end waits at the gate.
		server.timeout(req, 0);
		await ending;
	}
	return jsonResponse({ ok: true, result: {} }, 200, sessionCookies(app, req, null));
}

/**
 * The change stream for one project, for a session that may read it. Correctness never depends on it: a client
 * that misses an event refetches. It is silent for as long as nothing changes; like every request with a session,
 * it is not held to the idle timeout (`sessionFor`).
 */
async function events(
	app: App,
	req: Request,
	session: Session,
	project: string,
	closing: AbortSignal,
): Promise<Response> {
	const allowed = await mayRead(app, session, project);
	if (allowed === "unauthenticated") return unauthenticated();
	if (allowed === "missing") {
		const { code, message } = noProject(project);
		return jsonResponse({ ok: false, error: { code, message } }, HTTP_STATUS[code]);
	}
	if (allowed === "no") {
		return jsonResponse(
			{ ok: false, error: { code: "forbidden", message: `events need the read capability on ${project}` } },
			403,
		);
	}
	return changeStream(app, req, project, closing, async (db, id) => {
		const actor = session.reference
			? (await resolveCaller(app, db, session.reference(), id))?.actor
			: await session.actor(id);
		return actor?.can.includes("read") === true;
	});
}

let apiDocument: string | undefined;

function openApiJson(): string {
	apiDocument ??= JSON.stringify(buildOpenApi());
	return apiDocument;
}

/** An independently mutable copy of the API description, generated lazily once from the registry. */
export function openApi(): Record<string, unknown> {
	return JSON.parse(openApiJson());
}

function buildOpenApi(): Record<string, unknown> {
	const paths: Record<string, unknown> = {};
	for (const op of OP_LIST) {
		const path = op.scope === "project" ? `/api/p/{project}/${op.name}` : `/api/${op.name}`;
		paths[path] = {
			post: {
				operationId: op.name,
				summary: op.summary,
				tags: [op.effect],
				"x-mainworthy-needs": op.effect === "service" ? "job-service" : op.needs,
				...(op.effect === "service" ? { security: [{ jobIdentity: [] }] } : {}),
				"x-mainworthy-agent-tool": op.mcp !== null,
				...(op.scope === "project"
					? { parameters: [{ name: "project", in: "path", required: true, schema: { type: "string" } }] }
					: {}),
				requestBody: {
					required: true,
					content: {
						"application/json": { schema: z.toJSONSchema(op.input, { io: "input", unrepresentable: "any" }) },
					},
				},
				responses: {
					"200": {
						description: "The operation ran.",
						content: {
							"application/json": {
								schema: z.toJSONSchema(
									z.object({
										ok: z.literal(true),
										result: op.output,
										seq: z
											.number()
											.int()
											.nullable()
											.describe("The project's sequence number after a write; a cursor for `since`"),
									}),
								),
							},
						},
					},
					default: {
						description: "The operation did not run.",
						content: { "application/json": { schema: { $ref: "#/components/schemas/Failed" } } },
					},
				},
			},
		};
	}
	return {
		openapi: "3.1.0",
		info: {
			title: "Mainworthy",
			version: VERSION,
			description:
				"Every operation is a POST with a JSON body. The same operations are the CLI commands and, where marked, the MCP tools.",
		},
		paths,
		components: {
			securitySchemes: {
				token: { type: "http", scheme: "bearer" },
				jobIdentity: {
					type: "http",
					scheme: "bearer",
					bearerFormat: "JWT",
					description:
						"Google OIDC token for the configured job audience and service account; accepted only on the job service.",
				},
			},
			schemas: {
				Failed: {
					type: "object",
					required: ["ok", "error"],
					properties: {
						ok: { const: false },
						error: {
							type: "object",
							required: ["code", "message"],
							properties: {
								code: { enum: [...ERROR_CODES] },
								message: { type: "string" },
								details: { type: "object" },
							},
						},
					},
				},
			},
		},
		security: [{ token: [] }],
	};
}

export type Extra = {
	/** The web UI: an HTML import that Bun bundles, or null when the server runs without one (tests). */
	ui: unknown;
	/** Further routes owned by other surfaces (the MCP endpoint, the archive stream). */
	routes?: Record<string, (req: Request, session: Session) => Response | Promise<Response>>;
	/**
	 * Routes that answer without a session. A handler here is given the request and nothing of the instance, so
	 * it can only say what is the same for every instance of a version: the documentation (`docs/site.ts`).
	 */
	open?: Record<string, (req: Request) => Response | Promise<Response>>;
};

/** Liveness before the database is safe to use. No route here can reach application data. */
export function upgradingListener(config: Config, patience: Patience = PATIENCE) {
	return Bun.serve<Relay>({
		hostname: config.host,
		port: config.port,
		idleTimeout: patience.idleSeconds,
		maxRequestBodySize: STREAM_BODY_LIMIT,
		fetch: (req) =>
			withHeaders(
				req,
				new URL(req.url).pathname === "/health"
					? // 503: a probe that reads only the status (Cloud Run's) must not call a migrating revision ready.
						jsonResponse(
							{ ok: false, state: "upgrading", version: VERSION, apiVersion: API_VERSION, commit: config.commit },
							503,
							{ "retry-after": "5" },
						)
					: jsonResponse(
							{ ok: false, error: { code: "upgrading", message: "Mainworthy is upgrading; try again shortly." } },
							503,
							{ "retry-after": "5" },
						),
			),
	});
}

/**
 * The routes. Everything that reads or changes a project needs a session. These answer without one, on purpose:
 * `/health` (is the process up, and which version and commit: the container's health check),
 * `/api/openapi.json` (the description of the API, the same for every instance of a version), `/api/login` and
 * `/api/logout` (which open and end a browser's session and set or clear its cookie, same-origin only),
 * `/api/login/methods` and `/api/login/challenge` (what a sign-in page is told before anybody is signed in, in
 * `signin.ts`), the web UI's static files, and what the caller passes as `open` (the documentation at `/docs`,
 * which is likewise the same for every instance). An unknown path is a 404.
 *
 * A connection nobody has vouched for is closed after `patience.idleSeconds` of silence: one that asks for a
 * route that needs no session, one whose request was refused, one that stops in the middle of a sign-in. A request
 * that is given a session has the timeout taken off its connection, so its reply may take as long as the work
 * takes (`sessionFor` says why, and what remains).
 */
export function serve(
	app: App,
	owner: Actor,
	extra: Extra = { ui: null },
	patience: Patience = PATIENCE,
	listener?: ReturnType<typeof upgradingListener>,
) {
	const closing = new AbortController();
	const proof =
		app.config.proxy?.by === "secret" ? createHash("sha256").update(app.config.proxy.secret).digest() : null;
	const refuseProxy = (req: Request): Response | null => {
		if (proof === null) return null;
		const sent = createHash("sha256")
			.update(req.headers.get("x-mainworthy-proxy") ?? "")
			.digest();
		return timingSafeEqual(proof, sent)
			? null
			: withHeaders(
					null,
					jsonResponse(
						{ ok: false, error: { code: "forbidden", message: "request must come through the configured proxy" } },
						403,
					),
				);
	};
	// Every route that takes a session takes it here or in `handleOp`, and both through `sessionFor`.
	const guarded =
		(handler: (req: Request, session: Session) => Response | Promise<Response>) =>
		async (req: Request, server: Listener) => {
			const session = await sessionFor(app, owner, req, server);
			return session instanceof Response ? session : handler(req, session);
		};
	// The routes by which a person signs in as themselves are in `signin.ts`, which is lent what this file
	// knows of a request.
	const people = signInRoutes(app, {
		sameOrigin,
		read: async (req, limit) => {
			const incompatible = incompatibleRequest(req);
			if (incompatible) return incompatible;
			try {
				return { input: await readJson(req, limit, patience.signInBodyMs) };
			} catch (error) {
				return error instanceof BodyTooSlow
					? jsonResponse(
							{ ok: false, error: { code: "invalid", message: "the sign-in request took too long to arrive" } },
							408,
							{ connection: "close" },
						)
					: jsonResponse({ ok: false, error: { code: "invalid", message: "the request body is not JSON" } }, 400);
			}
		},
		json: jsonResponse,
		cookies: (req, signedIn) => sessionCookies(app, req, signedIn),
		cookieOf: sessionCookieOf,
		ceremony: {
			of: (req) => cookieOf(req, CEREMONY_COOKIE),
			set: (req, value, seconds) => cookieHeaders(req, CEREMONY_COOKIE, { value, seconds }),
			clear: (req) => cookieHeaders(req, CEREMONY_COOKIE, null),
		},
		sessionFor: async (req, server) => await sessionFor(app, owner, req, server),
		address: (req, server) => clientAddress(req, server, app.config),
		limited,
	});
	const health = () => jsonResponse({ ok: true, version: VERSION, apiVersion: API_VERSION, commit: app.config.commit });
	const routes: Record<string, unknown> = {
		"/api/openapi.json": () => jsonText(openApiJson()),
		"/api/session": { GET: guarded(async (_req, session) => await sessionInfo(app, session)) },
		"/api/login": {
			POST: async (req: Request, server: Listener) => await login(app, req, server, patience, people.signIn),
		},
		...people.routes,
		"/api/logout": { POST: async (req: Request, server: Listener) => await logout(app, req, server) },
		"/api/p/:project/events": {
			GET: guarded(
				async (req, session) =>
					await events(
						app,
						req,
						session,
						(req as Request & { params: { project: string } }).params.project,
						closing.signal,
					),
			),
		},
		"/api/p/:project/:op": {
			POST: async (req: Request & { params: { project: string; op: string } }, server: Listener) =>
				await handleOp(app, owner, req, server, req.params.project, req.params.op),
		},
		"/api/:op": {
			POST: async (req: Request & { params: { op: string } }, server: Listener) =>
				await handleOp(app, owner, req, server, null, req.params.op),
		},
	};
	for (const [path, handler] of Object.entries(extra.routes ?? {})) routes[path] = guarded(handler);
	// Every reply carries the headers of `headers.ts`: the routes above through `withHeadersOnEvery`, the two
	// replies below directly, and the web UI's files in `ui.ts`, where the page gets the policy it runs under.
	// A route that answers without a session (`open`: the documentation) writes the policy of its own pages,
	// which differ from the app's (a page of the documentation frames its diagrams), and keeps it.
	const ui = extra.ui ? uiSurface(extra.ui, sameOrigin) : null;
	const settings = {
		hostname: app.config.host,
		port: app.config.port,
		idleTimeout: patience.idleSeconds,
		maxRequestBodySize: STREAM_BODY_LIMIT,
		...(ui?.websocket ? { websocket: ui.websocket } : {}),
		routes: {
			// Exempt by the route Bun matched on the raw path, never by the request's URL, which Bun hands over normalised
			// (`/%2e/health` arrives as `/health`): the startup probe, and Cloud Scheduler's call, which proves itself
			// with a Google token (`authenticateJob`). Any other method on these paths falls to the guarded fallback.
			// First, so a test's own `/health` (extra routes) still replaces it.
			...withHeadersOnEvery({
				// Bun answers HEAD from the GET route; only the probe's GET is exempt. Not `/health`: Cloud Run's front end
				// answers that path itself with Google's 404, so nothing outside could read it.
				"/health": { GET: (req: Request) => (req.method === "GET" ? health() : (refuseProxy(req) ?? health())) },
				"/api/job": { POST: (req: Request, server: Listener) => handleOp(app, owner, req, server, null, "job") },
			}),
			...withHeadersOnEvery(routes, refuseProxy),
			...keepingPolicyOnEvery(extra.open ?? {}, refuseProxy),
			...(ui ? { "/*": (req: Request, server: Bun.Server<Relay>) => refuseProxy(req) ?? ui.route(req, server) } : {}),
			// biome-ignore lint/suspicious/noExplicitAny: Bun's route table type is a mapped type over literal paths; these are built at run time.
		} as any,
		fetch: (req: Request) =>
			refuseProxy(req) ??
			withHeaders(req, jsonResponse({ ok: false, error: { code: "not_found", message: "no such route" } }, 404)),
		error(error: Error) {
			if (isBusy(error))
				return withHeaders(
					null,
					jsonResponse(
						{
							ok: false,
							error: { code: "busy", message: "the writer is busy; retry the same request with the same command id" },
						},
						503,
					),
				);
			console.error("[mainworthy] request failed:", error);
			return withHeaders(null, jsonResponse({ ok: false, error: { code: "internal", message: INTERNAL_ERROR } }, 500));
		},
	};
	const server = listener ?? Bun.serve(settings);
	if (listener) listener.reload(settings);
	let stopping: Promise<void> | null = null;
	return {
		port: server.port,
		stop(closeActiveConnections = false): Promise<void> {
			if (stopping) {
				if (closeActiveConnections) void server.stop(true);
				return stopping;
			}
			// Stop accepting before closing the endless streams. Ordinary replies have a bounded wait to finish.
			const drained = server.stop(closeActiveConnections);
			closing.abort();
			const deadline = setTimeout(() => void server.stop(true), patience.shutdownMs);
			stopping = drained.finally(() => clearTimeout(deadline));
			return stopping;
		},
	};
}
