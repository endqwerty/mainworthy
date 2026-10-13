// The HTTP surface. It has no logic of its own: every route is the registry's `invoke` behind authentication, plus
// the session, the change stream and the generated API description. Nothing here knows what an operation does.
import { z } from "zod";
import { authenticate, noteTokenUse } from "../server/identity/identity.ts";
import type { App, ChangeEvent } from "../server/kernel/app.ts";
import { type Actor, findProject } from "../server/kernel/ctx.ts";
import { HTTP_STATUS, INTERNAL_ERROR, noProject } from "../server/kernel/errors.ts";
import { listProjects } from "../server/ops/admin.ts";
import { OP_LIST, OPS } from "../server/ops/index.ts";
import { invokeAsync, type Reply } from "../server/ops/registry.ts";
import { forwardedScheme } from "./headers.ts";
import { uiSurface } from "./ui.ts";
import { keepingPolicyOnEvery, withHeaders, withHeadersOnEvery } from "./with-headers.ts";

export const VERSION = "0.1.0";
const COOKIE = "mainworthy_session";

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
	});

const replyResponse = (reply: Reply): Response => jsonResponse(reply, reply.ok ? 200 : HTTP_STATUS[reply.error.code]);

/** The value of a cookie, or null when the request has none of that name or its value cannot be decoded. */
function cookieOf(req: Request, name: string): string | null {
	for (const part of (req.headers.get("cookie") ?? "").split(";")) {
		const [key, ...rest] = part.trim().split("=");
		if (key !== name) continue;
		try {
			return decodeURIComponent(rest.join("="));
		} catch {
			// Anybody can send `%` as a cookie. It is no session, and it is not worth a line in the log either.
			return null;
		}
	}
	return null;
}

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

export type Session = {
	via: "token" | "cookie" | "local";
	secret: string | null;
	actor: (project: number) => Actor | null;
};

/**
 * Who is calling. A bearer token, else the session cookie, else (in local mode only) the owner of this machine.
 *
 * Local mode trusts the loopback interface, so it must make sure the request really is local and same-origin:
 * it started on this machine (`isLocal`; the loopback Host also means a page on another site cannot reach us
 * through DNS rebinding) and it comes from this server's own page (`sameOrigin`: another site cannot act on the
 * owner's behalf). The same-origin rule protects the cookie in server mode.
 *
 * `peer` is the address the connection came from, as the listener knows it. A caller that does not know it
 * (a request that never was on a connection) is never the local owner.
 */
export function sessionOf(app: App, req: Request, owner: Actor, peer: string | null = null): Session | null {
	const header = req.headers.get("authorization");
	if (header?.toLowerCase().startsWith("bearer ")) {
		const secret = header.slice(7).trim();
		return authenticate(app, secret, 0)
			? { via: "token", secret, actor: (project) => authenticate(app, secret, project) }
			: null;
	}
	if (!sameOrigin(req)) return null;
	const cookie = cookieOf(req, COOKIE);
	if (cookie && authenticate(app, cookie, 0))
		return { via: "cookie", secret: cookie, actor: (project) => authenticate(app, cookie, project) };
	if (app.config.mode === "local" && isLocal(req, peer)) return { via: "local", secret: null, actor: () => owner };
	return null;
}

const unauthenticated = (): Response =>
	jsonResponse({ ok: false, error: { code: "unauthenticated", message: "a token is required" } }, 401);

/**
 * A page may say who it believes it is signed in as (`X-Mainworthy-As`, the actor's name, percent-encoded). When
 * the session has become somebody else's since the page was loaded (another tab signed in), the request is
 * refused here, in the request that would have written: text one person typed is never recorded under another
 * person's name, and a page never shows one person's view as another's. A caller that sends no name (a script,
 * the CLI, an agent) is whoever its token says.
 */
export const AS_HEADER = "x-mainworthy-as";
function sameCaller(req: Request, session: Session): boolean {
	const named = req.headers.get(AS_HEADER);
	if (named === null) return true;
	let name: string;
	try {
		name = decodeURIComponent(named);
	} catch {
		return false;
	}
	return session.actor(0)?.name === name;
}
const changedSession = (): Response =>
	jsonResponse(
		{
			ok: false,
			error: { code: "unauthenticated", message: "the session now belongs to another person; sign in again" },
		},
		401,
	);

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
	 * request that is given a session has this taken off its connection (`admit`). Bun counts in steps of four
	 * seconds, so a connection is closed up to four seconds later than this. (One that never finishes its
	 * request's headers is closed by Bun itself after about ten seconds, whatever this says.)
	 */
	idleSeconds: number;
	/** Milliseconds the whole body of a sign-in may take to arrive. It is a token: one packet. */
	signInBodyMs: number;
};
/**
 * Three minutes of silence, not half a minute: a proxy in front keeps idle connections to this server and reuses
 * them, and one that this server closed first can lose the request the proxy was just sending on it. By default
 * Traefik and Cloudflare's tunnel give up an idle connection after 90 seconds, nginx after 60 and Caddy after two
 * minutes, so the proxy closes first.
 */
export const PATIENCE: Patience = { idleSeconds: 180, signInBodyMs: 5000 };

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
			const next = await (late ? Promise.race([reader.read(), late]) : reader.read());
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

/** What the listener knows of the connection a request arrived on, and may do to it. */
type Listener = Pick<ReturnType<typeof Bun.serve>, "requestIP" | "timeout">;

/**
 * The session of a request, or the reply that refuses it. Every route that takes a session takes it here, so
 * every one holds a request to the person it names (`sameCaller`).
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
function admit(app: App, owner: Actor, req: Request, server: Listener): Session | Response {
	// The address the connection came from decides, in local mode, whether the request started on this machine.
	const session = sessionOf(app, req, owner, server.requestIP(req)?.address ?? null);
	if (!session) return unauthenticated();
	if (!sameCaller(req, session)) return changedSession();
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
	const session = admit(app, owner, req, server);
	if (session instanceof Response) return session;
	let input: unknown;
	try {
		input = await readJson(req);
	} catch (error) {
		if (error instanceof BodyTooLarge) return tooLarge(OP_BODY_LIMIT);
		return jsonResponse({ ok: false, error: { code: "invalid", message: "the request body is not JSON" } }, 400);
	}
	const reply = await invokeAsync(app, OPS, { op, project, input, actor: session.actor });
	if (session.secret && reply.ok && OPS[op]?.effect === "write") {
		const secret = session.secret;
		void app.gate.run(() => noteTokenUse(app, secret));
	}
	return replyResponse(reply);
}

/**
 * The projects a session holds a grant on, each with what the caller may do there. One it holds none on is not
 * named. A pipeline's project is named though it cannot read it: that is how it checks its own credential.
 */
export function grantedProjects(app: App, session: Session) {
	return app.reader.snapshot(() =>
		listProjects(app.reader).flatMap((project) => {
			const id = findProject(app.reader, project.key)?.id;
			const can = id === undefined ? [] : (session.actor(id)?.can ?? []);
			return can.length > 0 ? [{ ...project, can }] : [];
		}),
	);
}

/** Who the caller is and which projects it may read. */
function sessionInfo(app: App, session: Session): Response {
	const actor = session.actor(0);
	if (!actor) return unauthenticated();
	return jsonResponse({
		ok: true,
		result: {
			actor: actor.name,
			kind: actor.kind,
			can: actor.can,
			mode: app.config.mode,
			via: session.via,
			version: VERSION,
			projects: grantedProjects(app, session),
		},
	});
}

/**
 * Whether this session may read a project: the same rules an operation that needs `read` applies. A project the
 * caller holds no grant on is `missing`, like one that does not exist (see `execute` in the registry).
 */
function mayRead(app: App, session: Session, key: string): "yes" | "no" | "missing" {
	const project = findProject(app.reader, key);
	const can = project ? (session.actor(project.id)?.can ?? []) : [];
	if (can.length === 0) return "missing";
	return can.includes("read") ? "yes" : "no";
}

async function login(app: App, req: Request, patience: Patience): Promise<Response> {
	if (!sameOrigin(req)) return unauthenticated();
	// A sign-in body is a token and nothing else: a few kilobytes at most and one packet, read before anyone is
	// authenticated. So it is held to a size and to a time, and one that is still arriving after that is answered
	// and its connection closed.
	let input: unknown;
	try {
		input = await readJson(req, 4096, patience.signInBodyMs);
	} catch (error) {
		if (!(error instanceof BodyTooSlow)) return unauthenticated();
		return jsonResponse(
			{ ok: false, error: { code: "invalid", message: "the sign-in request took too long to arrive" } },
			408,
			{ connection: "close" },
		);
	}
	const body = z.object({ token: z.string().min(8) }).safeParse(input);
	if (!body.success || !authenticate(app, body.data.token, 0)) return unauthenticated();
	const secure = schemeOf(req) === "https:";
	const cookie = `${COOKIE}=${encodeURIComponent(body.data.token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${secure ? "; Secure" : ""}`;
	return jsonResponse({ ok: true, result: { signedIn: true } }, 200, { "set-cookie": cookie });
}

/**
 * The change stream for one project, for a session that may read it. Correctness never depends on it: a client
 * that misses an event refetches. It is silent for as long as nothing changes; like every request with a session,
 * it is not held to the idle timeout (`admit`).
 */
function events(app: App, req: Request, session: Session, project: string): Response {
	const allowed = mayRead(app, session, project);
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
	const encoder = new TextEncoder();
	let unsubscribe = (): void => {};
	let beat: ReturnType<typeof setInterval> | undefined;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const send = (text: string) => {
				try {
					controller.enqueue(encoder.encode(text));
				} catch {
					unsubscribe();
				}
			};
			send("retry: 2000\n\n");
			// Who may read is asked again before anything is sent, not only when the stream opens: a token that was
			// revoked, or an actor that was forgotten, stops receiving at the next event or heartbeat.
			const stillAllowed = (): boolean => {
				if (mayRead(app, session, project) === "yes") return true;
				unsubscribe();
				clearInterval(beat);
				try {
					controller.close();
				} catch {}
				return false;
			};
			unsubscribe = app.subscribe((event: ChangeEvent) => {
				if (event.project === project && stillAllowed()) send(`data: ${JSON.stringify(event)}\n\n`);
			});
			beat = setInterval(() => {
				if (stillAllowed()) send(": keep-alive\n\n");
			}, 20_000);
			req.signal.addEventListener("abort", () => {
				unsubscribe();
				clearInterval(beat);
			});
		},
		cancel() {
			unsubscribe();
			clearInterval(beat);
		},
	});
	return new Response(stream, {
		headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" },
	});
}

/** The API description, generated from the registry on every call. There is no hand-written copy to drift. */
export function openApi(): Record<string, unknown> {
	const paths: Record<string, unknown> = {};
	for (const op of OP_LIST) {
		const path = op.scope === "project" ? `/api/p/{project}/${op.name}` : `/api/${op.name}`;
		paths[path] = {
			post: {
				operationId: op.name,
				summary: op.summary,
				tags: [op.effect],
				"x-mainworthy-needs": op.needs,
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
						content: { "application/json": { schema: { $ref: "#/components/schemas/Ok" } } },
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
			securitySchemes: { token: { type: "http", scheme: "bearer" } },
			schemas: {
				Ok: {
					type: "object",
					required: ["ok", "result"],
					properties: {
						ok: { const: true },
						result: {},
						seq: {
							type: ["integer", "null"],
							description: "The project's sequence number after a write; a cursor for `since`.",
						},
					},
				},
				Failed: {
					type: "object",
					required: ["ok", "error"],
					properties: {
						ok: { const: false },
						error: {
							type: "object",
							required: ["code", "message"],
							properties: {
								code: { enum: Object.keys(HTTP_STATUS) },
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

/**
 * The routes. Everything that reads or changes a project needs a session. These answer without one, on purpose:
 * `/healthz` (is the process up, and which version and commit: the container's health check),
 * `/api/openapi.json` (the description of the API, the same for every instance of a version), `/api/login` and
 * `/api/logout` (which take or clear the cookie, same-origin only), the web UI's static files, and what the caller
 * passes as `open` (the documentation at `/docs`, which is likewise the same for every instance). An unknown path
 * is a 404.
 *
 * A connection nobody has vouched for is closed after `patience.idleSeconds` of silence: one that asks for a
 * route that needs no session, one whose request was refused, one that stops in the middle of a sign-in. A request
 * that is given a session has the timeout taken off its connection, so its reply may take as long as the work
 * takes (`admit` says why, and what remains).
 */
export function serve(app: App, owner: Actor, extra: Extra = { ui: null }, patience: Patience = PATIENCE) {
	// Every route that takes a session takes it here or in `handleOp`, and both through `admit`.
	const guarded =
		(handler: (req: Request, session: Session) => Response | Promise<Response>) => (req: Request, server: Listener) => {
			const session = admit(app, owner, req, server);
			return session instanceof Response ? session : handler(req, session);
		};
	const routes: Record<string, unknown> = {
		"/healthz": () => jsonResponse({ ok: true, version: VERSION, commit: app.config.commit }),
		"/api/openapi.json": () => jsonResponse(openApi()),
		"/api/session": { GET: guarded((_req, session) => sessionInfo(app, session)) },
		"/api/login": { POST: (req: Request) => login(app, req, patience) },
		"/api/logout": {
			POST: (req: Request) =>
				sameOrigin(req)
					? jsonResponse({ ok: true, result: {} }, 200, {
							"set-cookie": `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
						})
					: unauthenticated(),
		},
		"/api/p/:project/events": {
			GET: guarded((req, session) =>
				events(app, req, session, (req as Request & { params: { project: string } }).params.project),
			),
		},
		"/api/p/:project/:op": {
			POST: (req: Request & { params: { project: string; op: string } }, server: Listener) =>
				handleOp(app, owner, req, server, req.params.project, req.params.op),
		},
		"/api/:op": {
			POST: (req: Request & { params: { op: string } }, server: Listener) =>
				handleOp(app, owner, req, server, null, req.params.op),
		},
	};
	for (const [path, handler] of Object.entries(extra.routes ?? {})) routes[path] = guarded(handler);
	// Every reply carries the headers of `headers.ts`: the routes above through `withHeadersOnEvery`, the two
	// replies below directly, and the web UI's files in `ui.ts`, where the page gets the policy it runs under.
	// A route that answers without a session (`open`: the documentation) writes the policy of its own pages,
	// which differ from the app's (a page of the documentation frames its diagrams), and keeps it.
	const ui = extra.ui ? uiSurface(extra.ui, sameOrigin) : null;
	return Bun.serve({
		hostname: app.config.host,
		port: app.config.port,
		idleTimeout: patience.idleSeconds,
		maxRequestBodySize: STREAM_BODY_LIMIT,
		...(ui?.websocket ? { websocket: ui.websocket } : {}),
		routes: {
			...withHeadersOnEvery(routes),
			...keepingPolicyOnEvery(extra.open ?? {}),
			...(ui ? { "/*": ui.route } : {}),
			// biome-ignore lint/suspicious/noExplicitAny: Bun's route table type is a mapped type over literal paths; these are built at run time.
		} as any,
		fetch: (req) =>
			withHeaders(req, jsonResponse({ ok: false, error: { code: "not_found", message: "no such route" } }, 404)),
		error(error) {
			console.error("[mainworthy] request failed:", error);
			return withHeaders(null, jsonResponse({ ok: false, error: { code: "internal", message: INTERNAL_ERROR } }, 500));
		},
	});
}
