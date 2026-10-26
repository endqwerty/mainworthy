// The Cloudflare Worker on mainworthy.com/*: the proxy in front of the Cloud Run service (docs/deploy.md, "The
// cutover"). The Free plan cannot rewrite the Host header in an Origin Rule, so this forwards each request to the
// service's own address (env.ORIGIN). It overwrites the two headers the app believes only from here: the proof
// (env.PROXY_SECRET) and the visitor's address. Both values are Worker secrets, never in this repository.
export default {
	fetch: (request, env) => fetch(forward(request, env)),
};

export function forward(request, env) {
	const incoming = new URL(request.url);
	const origin = new URL(env.ORIGIN);
	const headers = new Headers(request.headers);
	headers.set("x-mainworthy-proxy", env.PROXY_SECRET);
	headers.set("x-mainworthy-client", request.headers.get("cf-connecting-ip") ?? "");
	// The app compares a browser's Origin with the host it is reached at, which here is the service's own. A page of
	// mainworthy.com is a page of the service; any other site's Origin passes unchanged, and the app refuses it.
	if (headers.get("origin") === incoming.origin) headers.set("origin", origin.origin);
	return new Request(new URL(incoming.pathname + incoming.search, origin), {
		method: request.method,
		headers,
		body: request.body,
		redirect: "manual",
	});
}
