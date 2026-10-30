export type FakeServer = {
	/** The address to give the client: an origin on this machine and a path no other process knows. */
	url: string;
	stop: () => Promise<void>;
};

/**
 * A server a test stands in for, on a port of this machine, that answers only under an unguessable path. Any process
 * on the machine may request a port that opens: T3 Code sends `GET /` to each new one on localhost within about a
 * second, and a test that counted that request failed by chance (#1099). `fetch` gets the path after `url`'s.
 */
export function fakeServer(fetch: (request: Request, path: string) => Response | Promise<Response>): FakeServer {
	const base = `/${crypto.randomUUID()}`;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const { pathname } = new URL(request.url);
			if (pathname !== base && !pathname.startsWith(`${base}/`)) return new Response(null, { status: 404 });
			return fetch(request, pathname.slice(base.length) || "/");
		},
	});
	return { url: `http://127.0.0.1:${server.port}${base}`, stop: () => server.stop(true) };
}
