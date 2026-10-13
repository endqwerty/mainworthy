// Puts the policy of `headers.ts` on replies. The HTTP surface passes its whole route table through here, so a
// route that is added later carries the headers without knowing of them.
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

/** A handler whose reply carries the headers. One that answers at once still answers at once. */
const wrapped =
	(handler: Handler, put: (req: Request, reply: Response) => Response = withHeaders): Handler =>
	(req, server) => {
		const reply = handler(req, server);
		return reply instanceof Promise ? reply.then((settled) => put(req, settled)) : put(req, reply);
	};

/** The routes that answer without a session, each reply with the headers and with the policy its route wrote. */
export function keepingPolicyOnEvery(
	routes: Readonly<Record<string, (req: Request) => Response | Promise<Response>>>,
): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(routes).map(([path, handler]) => [path, wrapped(handler, withHeadersKeepingPolicy)]),
	);
}

/**
 * A route table in which every handler's reply carries the headers. A route is a handler, or a handler for each
 * method. Bun also accepts a fixed reply, a file or an HTML import as a route and sends those itself, where no
 * header can be added: one of those is refused here, when the server starts, and not found missing its headers
 * later.
 */
export function withHeadersOnEvery(routes: Readonly<Record<string, unknown>>): Record<string, unknown> {
	const handlerOf = (path: string, value: unknown): Handler => {
		if (isHandler(value)) return wrapped(value);
		throw new Error(`the route ${path} is not a handler, so its replies could not carry the headers`);
	};
	const route = (path: string, value: unknown): unknown => {
		if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype)
			return handlerOf(path, value);
		return Object.fromEntries(
			Object.entries(value).map(([method, handler]) => [method, handlerOf(`${method} ${path}`, handler)]),
		);
	};
	return Object.fromEntries(Object.entries(routes).map(([path, value]) => [path, route(path, value)]));
}
