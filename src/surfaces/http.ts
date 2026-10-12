// The HTTP surface. It has no logic of its own: every route is the registry's `invoke` behind authentication, plus
// the session, the change stream and the generated API description. Nothing here knows what an operation does.
import { z } from "zod";
import { authenticate, noteTokenUse } from "../server/identity/identity.ts";
import type { App, ChangeEvent } from "../server/kernel/app.ts";
import type { Actor } from "../server/kernel/ctx.ts";
import { HTTP_STATUS } from "../server/kernel/errors.ts";
import { listProjects } from "../server/ops/admin.ts";
import { OP_LIST, OPS } from "../server/ops/index.ts";
import { invokeAsync, type Reply } from "../server/ops/registry.ts";

export const VERSION = "0.1.0";
const COOKIE = "casebook_session";

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
	});

const replyResponse = (reply: Reply): Response => jsonResponse(reply, reply.ok ? 200 : HTTP_STATUS[reply.error.code]);

function cookieOf(req: Request, name: string): string | null {
	for (const part of (req.headers.get("cookie") ?? "").split(";")) {
		const [key, ...rest] = part.trim().split("=");
		if (key === name) return decodeURIComponent(rest.join("="));
	}
	return null;
}

/** A browser's Origin must be this server. No Origin (a non-browser client) passes; an unparseable one does not. */
function sameOrigin(req: Request): boolean {
	const origin = req.headers.get("origin");
	if (origin === null) return true;
	try {
		return new URL(origin).host === req.headers.get("host");
	} catch {
		return false;
	}
}

const isLoopbackHost = (host: string | null): boolean => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host ?? "");

export type Session = {
	via: "token" | "cookie" | "local";
	secret: string | null;
	actor: (project: number) => Actor | null;
};

/**
 * Who is calling. A bearer token, else the session cookie, else (in local mode only) the owner of this machine.
 *
 * Local mode trusts the loopback interface, so it must make sure the request really is local and same-origin:
 * the Host header must be a loopback name (a page on another site cannot reach us through DNS rebinding) and a
 * browser's Origin, when present, must be this server (another site cannot post on the owner's behalf). The same
 * Origin rule protects the cookie in server mode.
 */
export function sessionOf(app: App, req: Request, owner: Actor): Session | null {
	const header = req.headers.get("authorization");
	if (header?.toLowerCase().startsWith("bearer ")) {
		const secret = header.slice(7).trim();
		return authenticate(app, secret, 0)
			? { via: "token", secret, actor: (project) => authenticate(app, secret, project) }
			: null;
	}
	const host = req.headers.get("host");
	if (!sameOrigin(req)) return null;
	const cookie = cookieOf(req, COOKIE);
	if (cookie && authenticate(app, cookie, 0))
		return { via: "cookie", secret: cookie, actor: (project) => authenticate(app, cookie, project) };
	if (app.config.mode === "local" && isLoopbackHost(host)) return { via: "local", secret: null, actor: () => owner };
	return null;
}

const unauthenticated = (): Response =>
	jsonResponse({ ok: false, error: { code: "unauthenticated", message: "a token is required" } }, 401);

/** The largest body an operation accepts. A 100,000-result report is about 30 MB. */
export const OP_BODY_LIMIT = 64 * 1024 * 1024;
/**
 * The server-wide ceiling. It is sized for the one route that streams (the archive import, which never holds the
 * body in memory); every other route reads its body through `readJson`, which enforces its own much smaller limit.
 */
export const STREAM_BODY_LIMIT = 8 * 1024 ** 3;

class BodyTooLarge extends Error {}

/**
 * Reads a JSON body of at most `limit` bytes. The length is checked while reading, not only from the header, so a
 * client cannot make the server hold more than the limit by omitting or understating Content-Length.
 */
async function readJson(req: Request, limit = OP_BODY_LIMIT): Promise<unknown> {
	if (Number(req.headers.get("content-length") ?? 0) > limit) throw new BodyTooLarge();
	const reader = req.body?.getReader();
	if (!reader) return {};
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > limit) {
			await reader.cancel();
			throw new BodyTooLarge();
		}
		chunks.push(value);
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

/** One operation over HTTP: `POST /api/p/<project>/<op>` or `POST /api/<op>` with the input as the JSON body. */
export async function handleOp(
	app: App,
	owner: Actor,
	req: Request,
	project: string | null,
	op: string,
): Promise<Response> {
	const session = sessionOf(app, req, owner);
	if (!session) return unauthenticated();
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
			projects: app.reader.snapshot(() => listProjects(app.reader)),
		},
	});
}

async function login(app: App, req: Request): Promise<Response> {
	if (!sameOrigin(req)) return unauthenticated();
	// A sign-in body is a token and nothing else: a few kilobytes at most, read before anyone is authenticated.
	const body = z.object({ token: z.string().min(8) }).safeParse(await readJson(req, 4096).catch(() => null));
	if (!body.success || !authenticate(app, body.data.token, 0)) return unauthenticated();
	const secure = req.headers.get("x-forwarded-proto") === "https" || new URL(req.url).protocol === "https:";
	const cookie = `${COOKIE}=${encodeURIComponent(body.data.token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${secure ? "; Secure" : ""}`;
	return jsonResponse({ ok: true, result: { signedIn: true } }, 200, { "set-cookie": cookie });
}

/** The change stream for one project. Correctness never depends on it: a client that misses an event refetches. */
function events(app: App, req: Request, project: string): Response {
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
			unsubscribe = app.subscribe((event: ChangeEvent) => {
				if (event.project === project) send(`data: ${JSON.stringify(event)}\n\n`);
			});
			beat = setInterval(() => send(": keep-alive\n\n"), 20_000);
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
				"x-casebook-needs": op.needs,
				"x-casebook-agent-tool": op.mcp !== null,
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
			title: "Casebook",
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
};

export function serve(app: App, owner: Actor, extra: Extra = { ui: null }) {
	const guarded = (handler: (req: Request, session: Session) => Response | Promise<Response>) => (req: Request) => {
		const session = sessionOf(app, req, owner);
		return session ? handler(req, session) : unauthenticated();
	};
	const routes: Record<string, unknown> = {
		"/healthz": () => jsonResponse({ ok: true, version: VERSION }),
		"/api/openapi.json": () => jsonResponse(openApi()),
		"/api/session": { GET: guarded((_req, session) => sessionInfo(app, session)) },
		"/api/login": { POST: (req: Request) => login(app, req) },
		"/api/logout": {
			POST: () =>
				jsonResponse({ ok: true, result: {} }, 200, {
					"set-cookie": `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
				}),
		},
		"/api/p/:project/events": {
			GET: guarded((req) => events(app, req, (req as Request & { params: { project: string } }).params.project)),
		},
		"/api/p/:project/:op": {
			POST: (req: Request & { params: { project: string; op: string } }) =>
				handleOp(app, owner, req, req.params.project, req.params.op),
		},
		"/api/:op": { POST: (req: Request & { params: { op: string } }) => handleOp(app, owner, req, null, req.params.op) },
	};
	for (const [path, handler] of Object.entries(extra.routes ?? {})) routes[path] = guarded(handler);
	if (extra.ui) routes["/*"] = extra.ui;
	return Bun.serve({
		hostname: app.config.host,
		port: app.config.port,
		idleTimeout: 0,
		maxRequestBodySize: STREAM_BODY_LIMIT,
		// biome-ignore lint/suspicious/noExplicitAny: Bun's route table type is a mapped type over literal paths; these are built at run time.
		routes: routes as any,
		fetch: () => jsonResponse({ ok: false, error: { code: "not_found", message: "no such route" } }, 404),
		error(error) {
			console.error("[casebook] request failed:", error);
			return jsonResponse({ ok: false, error: { code: "internal", message: "internal error" } }, 500);
		},
	});
}
