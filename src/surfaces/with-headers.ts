// Puts the policy of `headers.ts` on replies and a span around each. The HTTP surface passes its whole route table
// through here, so a route that is added later carries the headers and is traced without knowing of either.
import type { Span } from "@opentelemetry/api";
import { markFailed, withSpan } from "../server/kernel/telemetry.ts";
import { type Content, type RequestFacts, securityHeaders } from "./headers.ts";

/** A request the listener received, or null where Bun gives none (its error handler). */
const factsOf = (req: Request | null): RequestFacts =>
	req ? { url: req.url, forwardedProto: req.headers.get("x-forwarded-proto") } : { url: "", forwardedProto: null };

/**
 * The reply with the policy's headers. They replace what the route wrote under the same names, so no route can
 * loosen the policy by accident. Without a request nothing says how the browser arrived, and the reply goes
 * without `Strict-Transport-Security`, which a browser that has seen it once keeps for a year anyway.
 */
export function withHeaders(req: Request | null, reply: Response, content: Content = { kind: "other" }): Response {
	for (const [name, value] of Object.entries(securityHeaders(factsOf(req), content))) reply.headers.set(name, value);
	return reply;
}

/**
 * The reply of a route that writes the policy of its own pages (the documentation site). Its
 * `Content-Security-Policy` and its `Referrer-Policy` are kept, the framing header follows that policy, and the
 * rest is set as for every reply. A reply of such a route that carries no policy (a redirect, a refusal) gets
 * the one for "everything else".
 */
export function withHeadersKeepingPolicy(req: Request | null, reply: Response): Response {
	const policy = reply.headers.get("content-security-policy");
	const referrer = reply.headers.get("referrer-policy");
	withHeaders(req, reply, policy === null ? { kind: "other" } : { kind: "own", policy });
	if (policy !== null && referrer !== null) reply.headers.set("referrer-policy", referrer);
	return reply;
}

type Handler = (req: Request, server: unknown) => Response | Promise<Response>;
const isHandler = (value: unknown): value is Handler => typeof value === "function";

const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "CONNECT", "TRACE"]);
const answered = (span: Span, reply: Response): Response => {
	span.setAttribute("http.response.status_code", reply.status);
	if (reply.status >= 500) markFailed(span, String(reply.status));
	return reply;
};

/**
 * A handler whose reply carries the headers, in a span named by the route's pattern and never by the path asked,
 * which names a project. One that answers at once still answers at once.
 */
const wrapped =
	(
		route: string,
		handler: Handler,
		put: (req: Request, reply: Response) => Response = withHeaders,
		before?: (req: Request) => Response | null,
	): Handler =>
	(req, server) => {
		const method = METHODS.has(req.method) ? req.method : "_OTHER";
		return withSpan(
			`${method === "_OTHER" ? "HTTP" : method} ${route}`,
			{ "http.request.method": method, "http.route": route },
			(span) => {
				const refused = before?.(req);
				if (refused) return answered(span, refused);
				const reply = handler(req, server);
				return reply instanceof Promise
					? reply.then((settled) => answered(span, put(req, settled)))
					: answered(span, put(req, reply));
			},
			"root",
			"server",
		);
	};

/** The routes that answer without a session, each reply with the headers and with the policy its route wrote. */
export function keepingPolicyOnEvery(
	routes: Readonly<Record<string, (req: Request) => Response | Promise<Response>>>,
	before?: (req: Request) => Response | null,
): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(routes).map(([path, handler]) => [path, wrapped(path, handler, withHeadersKeepingPolicy, before)]),
	);
}

/**
 * A route table in which every handler's reply carries the headers. A route is a handler, or a handler for each
 * method. Bun also accepts a fixed reply, a file or an HTML import as a route and sends those itself, where no
 * header can be added: one of those is refused here, when the server starts, and not found missing its headers
 * later.
 */
export function withHeadersOnEvery(
	routes: Readonly<Record<string, unknown>>,
	before?: (req: Request) => Response | null,
): Record<string, unknown> {
	const handlerOf = (path: string, value: unknown, method?: string): Handler => {
		if (isHandler(value)) return wrapped(path, value, withHeaders, before);
		throw new Error(
			`the route ${method ? `${method} ` : ""}${path} is not a handler, so its replies could not carry the headers`,
		);
	};
	const route = (path: string, value: unknown): unknown => {
		if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype)
			return handlerOf(path, value);
		return Object.fromEntries(
			Object.entries(value).map(([method, handler]) => [method, handlerOf(path, handler, method)]),
		);
	};
	return Object.fromEntries(Object.entries(routes).map(([path, value]) => [path, route(path, value)]));
}
